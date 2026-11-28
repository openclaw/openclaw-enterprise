import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants, readFileSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { url as inspectorUrl } from "node:inspector";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runWithStateLockDebugger, StateLockProcess } from "./ci-state-lock.ts";

const helperPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const prepareUrl = new URL("../../scripts/ci/prepare.ts", import.meta.url).href;
const cleanupUrl = new URL("../../scripts/ci/cleanup.ts", import.meta.url).href;
const lockUrl = new URL("../../scripts/ci/state-lock.ts", import.meta.url).href;
const originalLockBlob = "c99ca330470cfb2f68b1be8c62314ad3989c0627";
const prepareEntry = "const state = await readState(resolvedStatePath);";
const cleanupEntry = "const state = await readStateIfPresent(path, authority);";

function blob(bytes: Uint8Array) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// The normal suite needs no Git history. For the explicit old-data qualification,
// the owner supplies the original source separately. Its bytes run at the canonical
// module URL, so the unchanged callers retain their genuine repositoryRoot binding.
export function stateLockProcessArgs(predecessor?: string): string[] {
  if (predecessor === undefined) {
    return ["--disable-sigusr1"];
  }
  const path = resolve(predecessor);
  assert.equal(blob(readFileSync(path)), originalLockBlob, "unexpected historical lock source");
  for (const [relative, expected] of [
    ["prepare.ts", "ddb8b0a5a53e96eb3ded7cfdad74ac1fe58dbaf6"],
    ["cleanup.ts", "3fd6d137d2fa80859fbe5268c5f774f025929c73"],
    ["prepare-inputs.ts", "f80f5df5553cc6e86a6f443794584172d67c72ce"],
    ["prepare-postgres.ts", "f4f56e5da55cf0553a084c17ef15ff64e53b94aa"],
    ["postgres-admin.ts", "3f871424179b6c6940a3315a1d215b55879af2c2"],
  ] as const) {
    assert.equal(blob(readFileSync(new URL(relative, prepareUrl))), expected);
  }
  const loader = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
const source = readFileSync(${JSON.stringify(path)});
assert.equal(createHash("sha1").update("blob " + source.length + "\\0").update(source).digest("hex"), ${JSON.stringify(originalLockBlob)});
registerHooks({ load(url, context, nextLoad) {
  return url === ${JSON.stringify(lockUrl)}
    ? { format: "module-typescript", source, shortCircuit: true }
    : nextLoad(url, context);
} });
`;
  return ["--disable-sigusr1", "--import", `data:text/javascript,${encodeURIComponent(loader)}`];
}

type Selection = { lane: string; file: string; statePath: string; template?: string };
type Work =
  | { kind: "prepare"; selection: Selection }
  | { kind: "cleanup"; statePath: string; resourceIds: string[] };
type Resource = Record<string, unknown> & {
  id: string;
  kind: string;
  name?: string;
  status: string;
  owner: string;
};
type Journal = Record<string, unknown> & { prefix: string; resources: Resource[] };
type Oracle = {
  effects(): unknown | Promise<unknown>;
  seed(databaseUrl: string): Promise<void>;
  present(databaseUrl: string, copiedFrom?: string): Promise<void>;
  absent(databaseUrl: string): Promise<void>;
};

async function journal(path: string) {
  const bytes = await readFile(path);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  assert(parsed !== null && typeof parsed === "object");
  const state = parsed as Journal;
  assert.equal(state.version, 1);
  assert.equal(state.repositoryRoot, repositoryRoot);
  assert.equal(state.statePath, path);
  assert.equal(typeof state.prefix, "string");
  assert(Array.isArray(state.resources));
  for (const resource of state.resources) {
    assert(resource !== null && typeof resource === "object");
    for (const field of ["id", "kind", "status", "owner"] as const) {
      assert.equal(typeof resource[field], "string");
    }
  }
  assert.equal(new Set(state.resources.map(({ id }) => id)).size, state.resources.length);
  return { bytes, state, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function database(state: Journal, databaseUrl: string) {
  const name = new URL(databaseUrl).pathname.slice(1);
  const found = state.resources.filter((entry) => entry.name === name);
  assert.equal(found.length, 1);
  const resource = found[0]!;
  assert.equal(resource.kind, "postgres-database");
  assert.equal(resource.owner, state.prefix);
  assert.equal(resource.status, "ready");
  assert.equal(resource.laneTemplate, undefined);
  return resource;
}

function equalResources(
  before: Journal,
  after: Journal,
  removed: string[],
  added: Resource[] = [],
) {
  assert.deepEqual(
    { ...after, resources: [] },
    { ...before, resources: [] },
    "stable journal fields changed",
  );
  assert.deepEqual(
    after.resources,
    [...before.resources.filter(({ id }) => !removed.includes(id)), ...added],
    "unexpected resource-journal mutation",
  );
}

async function owner(path: string) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags);
  try {
    const info = await handle.stat();
    if (info.isFile()) {
      return {
        device: info.dev,
        inode: info.ino,
        marker: "",
        token: await handle.readFile("utf8"),
      };
    }
    assert(info.isDirectory());
    const entries = await readdir(path);
    assert.equal(entries.length, 1);
    const marker = entries[0]!;
    const markerHandle = await open(join(path, marker), flags);
    try {
      assert((await markerHandle.stat()).isFile());
      const current = await lstat(path);
      assert.equal(current.dev, info.dev);
      assert.equal(current.ino, info.ino);
      return {
        device: info.dev,
        inode: info.ino,
        marker,
        token: await markerHandle.readFile("utf8"),
      };
    } finally {
      await markerHandle.close();
    }
  } finally {
    await handle.close();
  }
}

async function lockEntries(statePath: string) {
  const name = `${basename(statePath)}.lock`;
  return (await readdir(dirname(statePath)))
    .filter(
      (entry) => entry === name || (entry.startsWith(`.${name}.`) && entry.endsWith(".ticket")),
    )
    .sort();
}

// Arm this before the first real effect. Test cancellation may run after hooks
// while the body is pending, so cleanup joins the same settlement promise.
export class StateLockReconciliation {
  private held = false;
  private settled: Promise<void> = Promise.resolve();
  private readonly statePath: string;
  constructor(statePath: string) {
    this.statePath = statePath;
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    assert(!this.held, "State-lock reconciliation already owns an operation");
    this.held = true;
    const work = Promise.resolve().then(operation);
    this.settled = work.then(
      () => {
        this.held = false;
      },
      () => {},
    );
    return work;
  }
  async beforeCleanup() {
    await this.settled;
    assert(
      !this.held,
      `Reconcile the retained CI state-lock journal before cleanup: ${this.statePath}`,
    );
  }
}

export async function stopStateLockBeforeEffect(child: StateLockProcess) {
  await child.stop();
  assert.deepEqual(child.workerExit, { code: null, signal: "SIGKILL" }, "caller exit receipt");
  assert.deepEqual(child.workerClose, { code: null, signal: "SIGKILL" }, "caller close receipt");
  assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
  return { pid: child.pid, exit: child.workerExit, close: child.workerClose };
}

// Exercise the same stop proof used before a historical cutover. Keeping an IPC
// descriptor open makes a real worker exit observable before its close event.
export async function checkStateLockStopReceipts(t: TestContext, root: string) {
  const directory = await mkdtemp(join(root, "stop-receipts-"));
  const receipts = [];
  let complete = false;
  try {
    for (const missingClose of [false, true]) {
      const statePath = join(directory, missingClose ? "missing-close.json" : "normal.json");
      const saved = Buffer.from('["inert-operation"]\n');
      await writeFile(statePath, saved, { flag: "wx", mode: 0o600 });
      const child = new StateLockProcess(statePath, "stop-receipt", "", 60_000, false, {
        path: helperPath,
        args: ["--ci-prepare-lock-receipt-worker", String(missingClose)],
        env: { LANG: "C", TZ: "UTC", NODE_OPTIONS: "" },
        supervised: true,
        deadline: Date.now() + 15_000,
        signal: t.signal,
      });
      const guard = new StateLockReconciliation(statePath);
      let stoppedBeforeEffect = false;
      let cleanupCalls = 0;
      const work = guard.run(async () => {
        await child.connect();
        if (missingClose) {
          await child.message("descriptor-held");
          process.kill(child.pid!, "SIGKILL");
          await child.message("state-lock-worker-exit");
          assert.equal(child.workerClose, undefined);
          const supervisorExit = once(child.child, "exit", {
            signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]),
          });
          process.kill(-child.child.pid!, "SIGKILL");
          await supervisorExit;
          assert.deepEqual(child.exitStatus, { code: null, signal: "SIGKILL" });
          assert.equal(child.workerClose, undefined);
        }
        const receipt = await stopStateLockBeforeEffect(child);
        stoppedBeforeEffect = true;
        return receipt;
      });
      try {
        if (missingClose) {
          await assert.rejects(work, /caller close receipt/);
          await assert.rejects(guard.beforeCleanup(), /retained CI state-lock journal/);
          assert.equal(stoppedBeforeEffect, false);
          assert.deepEqual(await readFile(statePath), saved);
        } else {
          assert.deepEqual(await work, {
            pid: child.pid,
            exit: { code: null, signal: "SIGKILL" },
            close: { code: null, signal: "SIGKILL" },
          });
          await guard.beforeCleanup();
          cleanupCalls++;
          await unlink(statePath);
          assert.equal(stoppedBeforeEffect, true);
        }
      } finally {
        // Settlement is independent of the operation receipt and remains safe
        // to join after the worker's close message is lost.
        await child.stop();
      }
      assert.equal(cleanupCalls, missingClose ? 0 : 1);
      assert.equal(
        child.messages.some(({ type }) => type === "result"),
        false,
      );
      receipts.push({
        missingClose,
        pid: child.pid,
        supervisor: child.child.pid,
        exit: child.workerExit,
        close: child.workerClose ?? null,
        supervisorExit: child.exitStatus,
        supervisorClose: child.closeStatus,
        groups: [...child.groups],
        stoppedBeforeEffect,
        cleanupCalls,
      });
    }
    t.diagnostic(`Intentional stop receipts: ${JSON.stringify(receipts)}`);
    complete = true;
  } finally {
    if (complete) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function checkPreparedJournalStateLock(
  t: TestContext,
  {
    selection,
    env,
    oracle,
    predecessor,
    timeoutMs = 300_000,
  }: {
    selection: Selection;
    env: NodeJS.ProcessEnv;
    oracle: Oracle;
    predecessor?: string | undefined;
    timeoutMs?: number;
  },
) {
  const deadline = Date.now() + timeoutMs;
  t.signal.throwIfAborted();
  const statePath = resolve(selection.statePath);
  assert.equal(selection.statePath, statePath);
  const lockPath = `${statePath}.lock`;
  const workers: StateLockProcess[] = [];
  const stoppedBeforeEffects = new Set<StateLockProcess>();
  const currentArgs = stateLockProcessArgs();
  const producerArgs = stateLockProcessArgs(predecessor);
  let phase = "seed";
  const start = async (work: Work, execArgv = currentArgs) => {
    t.signal.throwIfAborted();
    assert(Date.now() < deadline, "Caller proof deadline expired");
    const child = new StateLockProcess(statePath, work.kind, "", 60_000, false, {
      path: helperPath,
      args: ["--ci-prepare-lock-worker", JSON.stringify(work)],
      // Keep the inherited-descriptor debugger private even when the runner has
      // unrelated Node preload or inspector options.
      env: { ...env, NODE_OPTIONS: "" },
      execArgv,
      supervised: true,
      deadline,
      signal: t.signal,
    });
    workers.push(child);
    await child.connect();
    return child;
  };
  const prepareWork = (template?: string): Work => ({
    kind: "prepare",
    selection: { ...selection, ...(template === undefined ? {} : { template }) },
  });
  const finish = async (child: StateLockProcess, outcome = "fulfilled") => {
    const result = await child.finish(outcome);
    assert.deepEqual(child.workerExit, { code: 0, signal: null });
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    return result;
  };
  const prepare = async (template?: string, execArgv = currentArgs) => {
    const child = await start(prepareWork(template), execArgv);
    child.send("begin");
    const result = await finish(child);
    assert.equal(typeof result.databaseUrl, "string");
    return result.databaseUrl as string;
  };
  const stop = async (child: StateLockProcess) => {
    const receipt = await stopStateLockBeforeEffect(child);
    stoppedBeforeEffects.add(child);
    return receipt;
  };
  const pausePrepare = async (template: string, execArgv = currentArgs) => {
    const child = await start(prepareWork(template), execArgv);
    const at = await child.breakpoint(
      prepareEntry,
      "async function prepareFileWithState",
      prepareUrl,
    );
    child.send("begin");
    await child.pause(at);
    const held = await owner(lockPath);
    assert(held.token.startsWith(`${child.pid} `));
    process.kill(child.pid!, 0);
    return { child, held, at };
  };
  const cleanup = async (resource: Resource, url: string) => {
    const before = await journal(statePath);
    const child = await start({ kind: "cleanup", statePath, resourceIds: [resource.id] });
    child.send("begin");
    assert.equal((await finish(child)).cleaned, true);
    equalResources(before.state, (await journal(statePath)).state, [resource.id]);
    await oracle.absent(url);
  };
  let settling: Promise<PromiseSettledResult<unknown>[]> | undefined;
  const settle = () => (settling ??= Promise.allSettled(workers.map((child) => child.stop())));
  const cancelled = () => {
    void settle();
  };
  t.signal.addEventListener("abort", cancelled, { once: true });
  let proofFailure: { error: unknown } | undefined;
  try {
    assert.deepEqual(await lockEntries(statePath), []);
    const template = await prepare(undefined, producerArgs);
    await oracle.seed(template);
    const target = await prepare(template, producerArgs);
    const survivor = await prepare(template, producerArgs);
    await oracle.present(target, template);
    await oracle.present(survivor, template);
    const j0 = await journal(statePath);
    const templateResource = database(j0.state, template);
    const targetResource = database(j0.state, target);
    const survivorResource = database(j0.state, survivor);

    if (predecessor !== undefined) {
      phase = "legacy-cutover";
      const legacy = await pausePrepare(template, producerArgs);
      const waiter = await start(prepareWork(template), producerArgs);
      const queued = await waiter.breakpoint(
        "await delay(ahead === 0",
        "async function acquireFileLock",
        lockUrl,
        await readFile(predecessor, "utf8"),
      );
      waiter.send("begin");
      const ticketPath = (await waiter.local(
        await waiter.pause(queued),
        "acquireFileLock",
        "ticketPath",
      )) as string;
      assert.equal(dirname(ticketPath), dirname(statePath));
      assert(basename(ticketPath).includes(`.${waiter.pid}.`));
      const ticket = await owner(ticketPath);
      assert.equal(ticket.marker, "");
      assert.equal(legacy.held.marker, "");
      const exits = [await stop(waiter), await stop(legacy.child)];
      assert.deepEqual((await journal(statePath)).bytes, j0.bytes);
      const effects = await oracle.effects();
      const refused = async () => {
        const child = await start(prepareWork(template));
        child.send("begin");
        const result = await finish(child, "rejected");
        assert.match(String(result.message), /directory-lock protocol/);
        assert.deepEqual((await journal(statePath)).bytes, j0.bytes);
        assert.deepEqual(await oracle.effects(), effects);
        assert.deepEqual(await owner(lockPath), legacy.held);
      };
      await refused();
      assert.deepEqual(await owner(ticketPath), ticket);
      await unlink(ticketPath);
      await refused();
      assert.deepEqual(await owner(lockPath), legacy.held);
      await unlink(lockPath);
      assert.deepEqual((await journal(statePath)).bytes, j0.bytes);
      assert.deepEqual(await lockEntries(statePath), []);
      t.diagnostic(
        `Quiescent journal cutover: ${JSON.stringify({ originalLockBlob, j0: j0.sha256, exits })}`,
      );
    }

    phase = "prepare-recovery";
    const beforePrepare = await journal(statePath);
    const beforeEffects = await oracle.effects();
    const abandoned = await pausePrepare(template);
    const successor = await start(prepareWork(template));
    const queued = await successor.breakpoint(
      "await delay(ahead === 0",
      "async function acquireFileLock",
    );
    const entering = await successor.breakpoint(
      prepareEntry,
      "async function prepareFileWithState",
      prepareUrl,
    );
    successor.send("begin");
    const ticketPath = (await successor.local(
      await successor.pause(queued),
      "acquireFileLock",
      "ticketPath",
    )) as string;
    assert((await lstat(ticketPath)).isDirectory());
    process.kill(abandoned.child.pid!, 0);
    assert.deepEqual((await journal(statePath)).bytes, beforePrepare.bytes);
    assert.deepEqual(await oracle.effects(), beforeEffects);
    const prepareExit = await stop(abandoned.child);
    assert.deepEqual(await owner(lockPath), abandoned.held);
    await successor.resume(queued);
    await successor.pause(entering);
    assert.notEqual((await owner(lockPath)).token, abandoned.held.token);
    await assert.rejects(lstat(join(lockPath, abandoned.held.marker)), { code: "ENOENT" });
    assert.deepEqual((await journal(statePath)).bytes, beforePrepare.bytes);
    assert.deepEqual(await oracle.effects(), beforeEffects);
    await successor.resume(entering);
    const prepared = await finish(successor);
    assert.equal(typeof prepared.databaseUrl, "string");
    const copied = prepared.databaseUrl as string;
    const j1 = await journal(statePath);
    const copiedResource = database(j1.state, copied);
    equalResources(beforePrepare.state, j1.state, [], [copiedResource]);
    await oracle.present(copied, template);
    await oracle.present(survivor, template);
    assert.deepEqual(await lockEntries(statePath), []);

    phase = "cleanup-recovery";
    const cleanupHolder = await pausePrepare(template);
    const cleaner = await start({ kind: "cleanup", statePath, resourceIds: [targetResource.id] });
    const waiting = await cleaner.breakpoint(
      "await delay(ahead === 0",
      "async function acquireFileLock",
    );
    const locked = await cleaner.breakpoint(
      cleanupEntry,
      "async function cleanupLockedResourceIds",
      cleanupUrl,
    );
    cleaner.send("begin");
    await cleaner.pause(waiting);
    // Selected database DROP happens before the journal lock. Its acknowledged
    // effect is real, but its row must survive until the locked update finishes.
    await oracle.absent(target);
    await oracle.present(survivor, template);
    assert.deepEqual((await journal(statePath)).bytes, j1.bytes);
    process.kill(cleanupHolder.child.pid!, 0);
    const cleanupExit = await stop(cleanupHolder.child);
    assert.deepEqual(await owner(lockPath), cleanupHolder.held);
    await cleaner.resume(waiting);
    await cleaner.pause(locked);
    assert.notEqual((await owner(lockPath)).token, cleanupHolder.held.token);
    assert.deepEqual((await journal(statePath)).bytes, j1.bytes);
    await cleaner.resume(locked);
    assert.equal((await finish(cleaner)).cleaned, true);
    const j2 = await journal(statePath);
    equalResources(j1.state, j2.state, [targetResource.id]);
    await oracle.absent(target);
    await oracle.present(survivor, template);
    await oracle.present(copied, template);
    assert.deepEqual(await lockEntries(statePath), []);
    t.diagnostic(
      `Real-caller lock recovery: ${JSON.stringify({ j0: j0.sha256, j1: j1.sha256, j2: j2.sha256, added: copiedResource.id, removed: targetResource.id, survivor: survivorResource.id, prepareExit, cleanupExit })}`,
    );

    phase = "selected-cleanup";
    await cleanup(copiedResource, copied);
    await cleanup(survivorResource, survivor);
    await cleanup(templateResource, template);
    equalResources(j0.state, (await journal(statePath)).state, [
      targetResource.id,
      survivorResource.id,
      templateResource.id,
    ]);
    assert.deepEqual(await lockEntries(statePath), []);
  } catch (error) {
    proofFailure = { error };
  }
  t.signal.removeEventListener("abort", cancelled);
  const settlement = await settle();
  const exits = workers.map((child, index) => ({
    pid: child.pid,
    supervisor: child.child.pid,
    supervisorExit: child.exitStatus,
    supervisorClose: child.closeStatus,
    groups: [...child.groups],
    exit: child.workerExit,
    close: child.workerClose,
    settlement: settlement[index]?.status,
    result:
      child.messages.find(({ type }) => type === "result")?.outcome ??
      (stoppedBeforeEffects.has(child) ? "stopped-before-effect" : "unknown"),
  }));
  const failures = settlement.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  // Failed or uncertain resource operations remain in the owning journal. Only
  // the normal lane owner may reconcile them; teardown never replays a request.
  try {
    t.diagnostic(
      `Preparation lock workers: ${JSON.stringify({ phase, exits, remainingLockEntries: await lockEntries(statePath) })}`,
    );
  } catch (error) {
    failures.push(error);
  }
  if (proofFailure !== undefined) {
    if (failures.length === 0) {
      throw proofFailure.error;
    }
    failures.unshift(proofFailure.error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Caller proof or command settlement failed; retain ${statePath}`,
    );
  }
}

async function callerWorker(work: Work) {
  const { prepareFile } = (await import(
    prepareUrl
  )) as typeof import("../../scripts/ci/prepare.ts");
  const { cleanupResourceIds } = (await import(
    cleanupUrl
  )) as typeof import("../../scripts/ci/cleanup.ts");
  const commands: string[] = [];
  process.on("message", (message: { command: string }) => commands.push(message.command));
  const receive = async (command: string) => {
    while (!commands.includes(command)) {
      await delay(5);
    }
    commands.splice(commands.indexOf(command), 1);
  };
  const send = (type: string, fields: Record<string, unknown> = {}) =>
    process.send?.({ type, ...fields });
  send("ready", { inspectorUrl: inspectorUrl() ?? null, execArgv: process.execArgv });
  await receive("begin");
  try {
    const result =
      work.kind === "prepare"
        ? { databaseUrl: (await prepareFile(work.selection)).env.OCC_TEST_DATABASE_URL }
        : {
            cleaned: await cleanupResourceIds(work.statePath, work.resourceIds, {
              lockTimeoutMs: 60_000,
            }),
          };
    send("result", { outcome: "fulfilled", ...result });
  } catch (error) {
    send("result", {
      outcome: "rejected",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await receive("shutdown");
  process.disconnect?.();
}

if (process.argv[1] === helperPath) {
  if (process.argv[2] === "--ci-prepare-lock-worker") {
    const work = JSON.parse(process.argv[3]!) as Work;
    await runWithStateLockDebugger(() => callerWorker(work));
  } else if (process.argv[2] === "--ci-prepare-lock-receipt-worker") {
    await runWithStateLockDebugger(async () => {
      if (process.argv[3] === "true") {
        const holder = spawn(
          process.execPath,
          ["--disable-sigusr1", helperPath, "--ci-prepare-lock-hold-ipc"],
          { stdio: ["ignore", "ignore", "ignore", 3] },
        );
        await new Promise<void>((resolve, reject) => {
          holder.once("spawn", resolve);
          holder.once("error", reject);
        });
        process.send?.({ type: "descriptor-held", pid: holder.pid });
      }
      process.send?.({
        type: "ready",
        inspectorUrl: inspectorUrl() ?? null,
        execArgv: process.execArgv,
      });
      await delay(60_000);
    });
  } else if (process.argv[2] === "--ci-prepare-lock-hold-ipc") {
    await delay(60_000);
  }
}
