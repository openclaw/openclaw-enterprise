import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { link, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../scripts/ci/command-supervision.ts";
import { readDefaultCollectorImage } from "../../scripts/ci/logging.ts";
import { parseCustody } from "../../scripts/ci/logging-custody.ts";
import { ownedName, randomSuffix } from "../../scripts/ci/resource-names.ts";
import {
  cleanupLogging,
  execute,
  prepareLogging,
  selectedCollectorSmoke,
  type LoggingResource,
} from "../helpers/ci-logging.ts";
import {
  createCiLoggingCustodyRelay,
  type RelayEvent,
  type RelayPlan,
  type RelayRequest,
} from "../helpers/ci-logging-custody-relay.ts";

type Executor = NonNullable<NonNullable<Parameters<typeof prepareLogging>[0]>["execFile"]>;
type Journal = LoggingResource & {
  id: string;
  kind: string;
  owner: string;
  status: "planned" | "ready";
  createdAt: string;
  readyAt?: string;
};
type LaneState = {
  version: 1;
  repositoryRoot: string;
  lane: "logging-collector";
  prefix: string;
  statePath: string;
  createdAt: string;
  cleanupOwner: string;
  resources: Journal[];
};
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cleanupCommand = fileURLToPath(new URL("../../scripts/ci/cleanup.ts", import.meta.url));
const fullId = /^[a-f0-9]{64}$/;
const selected = { skip: !selectedCollectorSmoke, timeout: 90_000 };
const sentinelLabel = "org.openclaw.enterprise.ci.sentinel-attempt";
type SentinelIntent = {
  phase: "create-intent" | "created";
  endpoint: string;
  engineId: string;
  name: string;
  image: string;
  nonce: string;
  receiptPath: string;
  cidPath: string;
  containerId?: string;
};
type ProductRemoval = {
  phase: "remove-intent" | "response-received";
  rawTarget: string;
  containerId: string;
  statusCode?: number;
};

function id(text: string) {
  const value = text.trim();
  assert.match(value, fullId);
  return value;
}

function setupCommandStderr(error: unknown) {
  if (error instanceof AggregateError) {
    // The custody repair retains an unresolved create and wraps its command
    // failure. The baseline rethrows that command failure directly.
    assert.match(error.message, /cleanup is unresolved/);
    assert.equal(error.errors.length, 2);
    const cleanupError: unknown = error.errors[1];
    assert.ok(cleanupError instanceof Error);
    assert.equal(
      cleanupError.message,
      "OTel backend create outcome is unknown; retain its custody receipt.",
    );
    error = error.errors[0];
  }
  assert.ok(error instanceof Error);
  assert.equal(error.name, "Error");
  assert.ok("code" in error && typeof error.code === "number" && error.code !== 0);
  assert.ok("stderr" in error && typeof error.stderr === "string");
  return error.stderr;
}

async function writeFixtureReceipt(path: string, value: unknown, initial = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (initial) {
      await link(temporary, path);
    } else {
      await rename(temporary, path);
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function recoveryEvidence(resource: Journal) {
  const custody = parseCustody(
    resource.custody,
    String(resource.containerName),
    String(resource.directory),
  );
  const directory = await stat(custody.directory, { bigint: true });
  assert.ok(directory.isDirectory());
  const directoryIdentity = { device: String(directory.dev), inode: String(directory.ino) };
  assert.deepEqual(directoryIdentity, custody.directoryIdentity);
  const marker = await readFile(join(custody.directory, ".custody-owner"));
  assert.equal(marker.toString(), custody.nonce);
  const cid = await readFile(custody.cidPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  return {
    custody,
    receipt: await readFile(custody.receiptPath),
    directoryIdentity,
    marker,
    cid,
  };
}

async function assertRemovedJournal(statePath: string, resource: Journal, containerId: string) {
  const custody = parseCustody(
    resource.custody,
    String(resource.containerName),
    String(resource.directory),
  );
  await assert.rejects(stat(statePath), { code: "ENOENT" });
  await assert.rejects(stat(custody.directory), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(custody.receiptPath, "utf8")), {
    custody,
    phase: "removed",
    containerId,
    directoryRemoved: true,
  });
}

async function realFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ci-otel-custody-"));
  const server = createServer();
  let cleanupContainers = async () => {};
  let closeRelay = async () => {};
  let eventCount = 0;
  const record = (event: RelayEvent | { phase: string }) => {
    if (eventCount >= 512) {
      return;
    }
    eventCount += 1;
    const line = JSON.stringify({ sequence: eventCount, ...event });
    appendFileSync(join(root, "transport.jsonl"), `${line}\n`, { mode: 0o600, flush: true });
    t.diagnostic(line);
  };
  const work = new AbortController();
  const cleanupWork = new AbortController();
  const cleanupCliCommands = new Set<() => void>();
  const workDeadline = Date.now() + 60_000;
  const stopWork = () => {
    work.abort();
    for (const stop of cleanupCliCommands) {
      stop();
    }
  };
  const workTimer = setTimeout(stopWork, 60_000);
  t.signal.addEventListener("abort", stopWork, { once: true });
  let cleanupDeadline = 0;
  const commands = new Set<Promise<unknown>>();
  const boundedExecute: Executor = (command, args, options) => {
    const signal = cleanupDeadline ? cleanupWork.signal : work.signal;
    const deadline = cleanupDeadline || workDeadline;
    const pending = (async () => {
      signal.throwIfAborted();
      record({ phase: "command-start" });
      try {
        const executionOptions = {
          ...options,
          signal,
          timeoutMs: Math.max(
            1,
            Math.min(options?.timeoutMs ?? 15_000, 15_000, deadline - Date.now()),
          ),
        };
        const result = await execute(command, args, executionOptions);
        record({ phase: "command-end" });
        return result;
      } catch (error) {
        record({ phase: "command-failed" });
        throw error;
      }
    })();
    commands.add(pending);
    void pending.then(
      () => commands.delete(pending),
      () => commands.delete(pending),
    );
    return pending;
  };
  // Enroll before Docker discovery, relay startup, or any later setup await.
  t.after(async () => {
    record({ phase: "teardown-start" });
    stopWork();
    clearTimeout(workTimer);
    t.signal.removeEventListener("abort", stopWork);
    const teardownDeadline = Date.now() + 25_000;
    const cleanupTimer = setTimeout(() => cleanupWork.abort(), 25_000);
    const failures: unknown[] = [];
    try {
      await closeRelay();
      await Promise.allSettled(commands);
      cleanupDeadline = teardownDeadline;
      try {
        record({ phase: "cleanup-start" });
        await cleanupContainers();
        record({ phase: "cleanup-end" });
      } catch (error) {
        failures.push(error);
      }
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ).catch((error: unknown) => failures.push(error));
      }
      record({ phase: "teardown-end" });
    } finally {
      cleanupWork.abort();
      clearTimeout(cleanupTimer);
      await Promise.allSettled(commands);
    }
    if (failures.length) {
      throw new AggregateError(failures, "CI OTel fixture cleanup is unresolved.");
    }
    await rm(root, { recursive: true, force: true });
  });
  record({ phase: "discovery-start" });
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const context =
    process.env.DOCKER_CONTEXT ?? (await boundedExecute(docker, ["context", "show"])).stdout.trim();
  const endpoint =
    !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
      ? process.env.DOCKER_HOST
      : (JSON.parse(
          (
            await boundedExecute(docker, [
              "context",
              "inspect",
              context,
              "--format",
              "{{json .Endpoints.docker.Host}}",
            ])
          ).stdout,
        ) as string);
  // The response gate forwards an actual local Docker API connection. It does
  // not emulate a daemon or weaken TLS for a remote engine.
  assert.ok(
    endpoint.startsWith("unix://"),
    "custody fault cases require a local Unix Docker endpoint",
  );
  const direct = (args: string[]) => boundedExecute(docker, ["--host", endpoint, ...args]);
  const engineId = (await direct(["info", "--format", "{{.ID}}"])).stdout.trim();
  assert.ok(engineId, "Docker must report its engine identity");
  const collector =
    process.env.OCC_TEST_LOGGING_COLLECTOR_IMAGE ?? (await readDefaultCollectorImage());
  const sentinel = process.env.OCC_TEST_LOGGING_NODE_IMAGE;
  assert.ok(sentinel, "logging-collector lane must supply its pinned Node image");
  for (const image of [collector, sentinel]) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/);
    const digests: unknown = JSON.parse(
      (await direct(["image", "inspect", "--format", "{{json .RepoDigests}}", image])).stdout,
    );
    assert.ok(
      Array.isArray(digests) &&
        digests.some(
          (entry: unknown) =>
            typeof entry === "string" && entry.endsWith(image.slice(image.lastIndexOf("@"))),
        ),
      "lane preparation must preload the exact image",
    );
  }
  const owned = new Set<string>();
  const sentinelIntents = new Map<string, SentinelIntent>();
  const deletes: string[] = [];
  const productRemovals = new Map<string, ProductRemoval>();
  const productRemovalTargets = new Set<string>();
  let createForwards = 0;
  let unresolvedCreate = false;
  let unresolvedRemovalTarget = false;
  let gate:
    | { operation: "create" | "remove"; afterCommit: (objectId: string) => Promise<void> }
    | undefined;
  const socket = join(root, "docker.sock");
  const relayPlan = async (incoming: RelayRequest): Promise<RelayPlan> => {
    const url = new URL(incoming.url, "http://docker");
    const pathname = url.pathname.replace(/^\/v[0-9.]+/, "");
    const create = incoming.method === "POST" && pathname === "/containers/create";
    let removal: ProductRemoval | undefined;
    let upstreamPath = incoming.url;
    if (incoming.method === "DELETE") {
      const rawTarget = /^\/containers\/([^/]+)$/.exec(pathname)?.[1];
      deletes.push(rawTarget ?? pathname);
      try {
        assert.equal(unresolvedRemovalTarget, false, "retain the unresolved DELETE target");
        assert.ok(rawTarget, "only container DELETEs are admitted");
        const target = decodeURIComponent(rawTarget);
        assert.equal(productRemovalTargets.has(target), false, "do not replay a DELETE target");
        productRemovalTargets.add(target);
        const objectId = fullId.test(target)
          ? target
          : id((await direct(["container", "inspect", "--format", "{{.Id}}", target])).stdout);
        assert.ok(owned.has(objectId), "DELETE must resolve to a fixture-owned exact ID");
        assert.equal(productRemovals.has(objectId), false, "do not replay a product removal");
        removal = { phase: "remove-intent", rawTarget, containerId: objectId };
        productRemovals.set(objectId, removal);
        await writeFixtureReceipt(
          join(root, `product-remove-${objectId}.json`),
          { ...removal, endpoint, engineId },
          true,
        );
        // Preserve the product's request target above, but bind this fixture's
        // forwarded destructive request to the resolved object, never its name.
        upstreamPath = `${url.pathname.slice(0, -rawTarget.length)}${objectId}${url.search}`;
      } catch (error) {
        unresolvedRemovalTarget = true;
        await writeFixtureReceipt(
          join(root, `unresolved-delete-${randomUUID()}.json`),
          { phase: "unresolved-target", rawTarget: rawTarget ?? pathname, endpoint, engineId },
          true,
        );
        throw error;
      }
    }
    if (create) {
      createForwards += 1;
      unresolvedCreate = true;
    }
    if (!create && !removal) {
      return { path: upstreamPath };
    }
    return {
      path: upstreamPath,
      interceptResponse: async (status, body) => {
        let created: string | undefined;
        if (create && status === 201) {
          const payload: unknown = JSON.parse(body.toString());
          assert.ok(
            payload &&
              typeof payload === "object" &&
              "Id" in payload &&
              typeof payload.Id === "string",
          );
          created = id(payload.Id);
          owned.add(created);
        }
        if (create) {
          unresolvedCreate = false;
        }
        if (removal && status !== undefined) {
          const completed: ProductRemoval = {
            ...removal,
            phase: "response-received",
            statusCode: status,
          };
          await writeFixtureReceipt(join(root, `product-remove-${removal.containerId}.json`), {
            ...completed,
            endpoint,
            engineId,
          });
          productRemovals.set(removal.containerId, completed);
        }
        const objectId = create ? created : removal?.containerId;
        if (
          gate &&
          objectId &&
          gate.operation === (create ? "create" : "remove") &&
          (status ?? 500) >= 200 &&
          (status ?? 500) < 300
        ) {
          const selectedGate = gate;
          gate = undefined;
          await selectedGate.afterCommit(objectId);
          return "drop";
        }
        return "forward";
      },
    };
  };
  const transport = createCiLoggingCustodyRelay({
    socketPath: endpoint.slice("unix://".length),
    requestTimeoutMs: 20_000,
    plan: relayPlan,
    record,
  });
  closeRelay = transport.close;
  server.on("request", transport.handle);
  record({ phase: "relay-listen" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  const relay = `unix://${socket}`;
  assert.equal(
    (await boundedExecute(docker, ["--host", relay, "info", "--format", "{{.ID}}"])).stdout.trim(),
    engineId,
  );
  const routedExecute: Executor = (command, args, options) =>
    boundedExecute(
      command,
      command === docker && args[0] !== "--host" && args[0] !== "--context"
        ? ["--host", relay, ...args]
        : args,
      options,
    );
  const env = {
    ...process.env,
    DOCKER_CONTEXT: "",
    DOCKER_HOST: relay,
    OCC_DOCKER_BIN: docker,
    OCC_TEST_LOGGING_COLLECTOR_IMAGE: collector,
    OCC_CI_OTEL_BACKEND_BIND_ADDRESS: "127.0.0.1",
    OCC_CI_OTEL_BACKEND_HOST: "127.0.0.1",
  };
  const present = async (objectId: string) => {
    assert.match(objectId, fullId);
    const value = (
      await direct([
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `id=${objectId}`,
      ])
    ).stdout.trim();
    assert.ok(value === "" || value === objectId);
    return value === objectId;
  };
  const captureSentinel = async (intent: SentinelIntent) => {
    const received = await readFile(intent.cidPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (received === undefined) {
      return undefined;
    }
    const objectId = id(received);
    const identity: unknown = JSON.parse(
      (
        await direct([
          "container",
          "inspect",
          "--format",
          `[{{json .Id}},{{json .Config.Image}},{{json (index .Config.Labels ${JSON.stringify(sentinelLabel)})}}]`,
          objectId,
        ])
      ).stdout,
    );
    assert.deepEqual(identity, [objectId, intent.image, intent.nonce]);
    const completed: SentinelIntent = { ...intent, phase: "created", containerId: objectId };
    await writeFixtureReceipt(intent.receiptPath, completed);
    sentinelIntents.set(intent.name, completed);
    owned.add(objectId);
    return objectId;
  };
  cleanupContainers = async () => {
    assert.equal((await direct(["info", "--format", "{{.ID}}"])).stdout.trim(), engineId);
    assert.equal(
      unresolvedRemovalTarget,
      false,
      `retain fixture after an unresolved DELETE: ${root}`,
    );
    for (const intent of sentinelIntents.values()) {
      if (!intent.containerId) {
        await captureSentinel(intent);
      }
    }
    for (const objectId of owned) {
      const receiptPath = join(root, `remove-${objectId}.json`);
      if (await present(objectId)) {
        // A live object after a product DELETE may have an unknown outcome.
        // Fixture teardown must not replay that destructive operation.
        assert.equal(productRemovals.has(objectId), false, "retain unresolved product removal");
        await writeFixtureReceipt(
          receiptPath,
          { phase: "remove-intent", endpoint, engineId, containerId: objectId },
          true,
        );
        try {
          await direct(["rm", "--force", objectId]);
        } catch (error) {
          if (await present(objectId)) {
            throw error;
          }
        }
        assert.equal(await present(objectId), false, "retain unresolved fixture removal");
        await writeFixtureReceipt(receiptPath, {
          phase: "removed",
          endpoint,
          engineId,
          containerId: objectId,
        });
      }
    }
    assert.equal(unresolvedCreate, false, `retain fixture after an unknown create: ${root}`);
    assert.ok(
      [...sentinelIntents.values()].every((intent) => intent.containerId),
      `retain fixture after an unknown sentinel create: ${root}`,
    );
  };
  const sentinelAt = async (name: string, { loseResult = false } = {}) => {
    assert.equal(sentinelIntents.has(name), false, "do not replay a sentinel create");
    const nonce = randomUUID();
    const intent: SentinelIntent = {
      phase: "create-intent",
      endpoint,
      engineId,
      name,
      image: sentinel,
      nonce,
      receiptPath: join(root, `sentinel-${nonce}.json`),
      cidPath: join(root, `sentinel-${nonce}.cid`),
    };
    await assert.rejects(stat(intent.cidPath), { code: "ENOENT" });
    await writeFixtureReceipt(intent.receiptPath, intent, true);
    sentinelIntents.set(name, intent);
    assert.equal((await direct(["info", "--format", "{{.ID}}"])).stdout.trim(), engineId);
    try {
      const created = await direct([
        "create",
        "--name",
        name,
        "--cidfile",
        intent.cidPath,
        "--label",
        "org.openclaw.enterprise.ci.resource=otel-backend",
        "--label",
        `${sentinelLabel}=${nonce}`,
        "--entrypoint",
        "node",
        sentinel,
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      if (loseResult) {
        throw new Error("lost direct sentinel create result");
      }
      const objectId = await captureSentinel(intent);
      assert.equal(objectId, id(created.stdout));
      assert.ok(objectId);
      return objectId;
    } catch (error) {
      // A rejected command may already have committed. The cidfile is the
      // daemon-issued receipt; an absent file is not evidence of absence.
      if (!sentinelIntents.get(name)?.containerId) {
        await captureSentinel(intent);
      }
      throw error;
    }
  };
  const renamed = async (objectId: string) => {
    assert.match(objectId, fullId);
    await direct(["rename", objectId, `ci-otel-spare-${randomUUID()}`]);
  };
  const sibling = join(root, "sibling-marker");
  await writeFile(sibling, "unrelated directory survives\n", { mode: 0o600 });
  // Match prepare.ts's lane/resource journal, while taking custody and all
  // backend details unchanged from the real resource producer.
  const statePath = join(root, "lane-state.json");
  const state: LaneState = {
    version: 1,
    repositoryRoot,
    lane: "logging-collector",
    prefix: ownedName("openclaw-ci", "custody-test", { maxLength: 48 }),
    statePath,
    createdAt: new Date().toISOString(),
    cleanupOwner: randomUUID(),
    resources: [],
  };
  await writeFixtureReceipt(statePath, state, true);
  let resource: Journal | undefined;
  const prepare = async ({
    beforeCreate,
    execFile = routedExecute,
  }: { beforeCreate?: (entry: Journal) => Promise<void>; execFile?: Executor } = {}) => {
    record({ phase: "prepare-start" });
    const prepared = await prepareLogging({
      laneName: state.lane,
      directory: root,
      env,
      execFile,
      waitForReady: false,
      registerResource: async (kind, details) => {
        const entry: Journal = {
          id: `${kind}-${randomSuffix()}`,
          kind,
          owner: state.prefix,
          status: "planned",
          createdAt: new Date().toISOString(),
          ...details,
        };
        resource = entry;
        state.resources.push(entry);
        await writeFixtureReceipt(statePath, state);
        record({ phase: "resource-planned" });
        await writeFile(join(root, "planned.json"), `${JSON.stringify(entry)}\n`, {
          mode: 0o600,
          flush: true,
        });
        await beforeCreate?.(entry);
        return entry;
      },
    });
    assert.ok(resource);
    resource.status = "ready";
    resource.readyAt = new Date().toISOString();
    await writeFixtureReceipt(statePath, state);
    return prepared;
  };
  const cleanup = (execFile: Executor = routedExecute) => {
    record({ phase: "product-cleanup-start" });
    return cleanupLogging(resource, { env, execFile });
  };
  const cleanupCli = () => {
    const pending = (async () => {
      work.signal.throwIfAborted();
      assert.equal(process.release.name, "node");
      assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
      record({ phase: "cleanup-cli-start" });
      let stderr = "";
      let overflow = false;
      try {
        const result = await runCommand(
          process.execPath,
          [
            cleanupCommand,
            "--state",
            statePath,
            "--cleanup-owner",
            state.cleanupOwner,
            "--lane",
            state.lane,
          ],
          {
            cwd: repositoryRoot,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          },
          {
            phase: "cleanup",
            deadline: {
              timeoutMs: Math.max(1, Math.min(15_000, workDeadline - Date.now())),
              graceMs: 1_000,
            },
            activeCommands: cleanupCliCommands,
          },
          (child) => {
            child.stdout?.resume();
            child.stderr?.on("data", (chunk: Buffer | string) => {
              if (overflow) {
                return;
              }
              stderr += chunk.toString();
              if (stderr.length > 1024 * 1024) {
                overflow = true;
                stderr = stderr.slice(0, 1024 * 1024);
                for (const stop of cleanupCliCommands) {
                  stop();
                }
              }
            });
          },
        );
        // Only an observed normal exit is a cleanup result. Cancellation,
        // timeout, or a lost process remains an unresolved operation.
        work.signal.throwIfAborted();
        if (
          result.kind !== "exit" ||
          typeof result.code !== "number" ||
          result.signal !== null ||
          result.signalError ||
          overflow
        ) {
          throw new Error("CI OTel cleanup CLI did not finish with a bounded exit.");
        }
        return { code: result.code, stderr };
      } finally {
        record({ phase: "cleanup-cli-end" });
      }
    })();
    commands.add(pending);
    void pending.then(
      () => commands.delete(pending),
      () => commands.delete(pending),
    );
    return pending;
  };
  const containerAt = async (name: string) => {
    const objectId = id(
      (await direct(["container", "inspect", "--format", "{{.Id}}", name])).stdout,
    );
    return objectId;
  };
  return {
    root,
    prepare,
    cleanup,
    cleanupCli,
    statePath,
    state: () => JSON.parse(JSON.stringify(state)) as LaneState,
    execute: routedExecute,
    present,
    sentinelAt,
    sentinelReceipt: async (name: string) => {
      const intent = sentinelIntents.get(name);
      assert.ok(intent);
      return JSON.parse(await readFile(intent.receiptPath, "utf8")) as SentinelIntent;
    },
    renamed,
    containerAt,
    deletes,
    resource: () => {
      assert.ok(resource);
      return resource;
    },
    gate: (operation: "create" | "remove", afterCommit: (objectId: string) => Promise<void>) => {
      gate = { operation, afterCommit };
    },
    createForwards: () => createForwards,
    siblingSurvives: async () =>
      assert.equal(await readFile(sibling, "utf8"), "unrelated directory survives\n"),
  };
}

test(
  "real CI OTel fixture retains the exact ID after a lost direct sentinel create result",
  selected,
  async (t) => {
    const f = await realFixture(t);
    const name = `ci-otel-lost-sentinel-${randomUUID()}`;
    await assert.rejects(
      f.sentinelAt(name, { loseResult: true }),
      /lost direct sentinel create result/,
    );
    const receipt = await f.sentinelReceipt(name);
    assert.equal(receipt.phase, "created");
    assert.ok(receipt.containerId);
    assert.equal(await f.containerAt(name), receipt.containerId);
    assert.equal(id(await readFile(receipt.cidPath, "utf8")), receipt.containerId);
    assert.equal(await f.present(receipt.containerId), true);
    await assert.rejects(f.sentinelAt(name), /do not replay a sentinel create/);
    assert.deepEqual(f.deletes, []);
  },
);

test(
  "real CI OTel cleanup preserves a foreign container that wins the planned name",
  selected,
  async (t) => {
    const f = await realFixture(t);
    let foreign = "";
    await assert.rejects(
      f.prepare({
        beforeCreate: async (entry) => {
          foreign = await f.sentinelAt(String(entry.containerName));
        },
      }),
      (error: unknown) => {
        const stderr = setupCommandStderr(error);
        assert.match(foreign, fullId);
        assert.ok(
          stderr.includes(
            `Error response from daemon: Conflict. The container name "/${String(f.resource().containerName)}" is already in use by container "${foreign}"`,
          ),
          "Docker must reject the exact foreign container's occupied name",
        );
        return true;
      },
    );
    assert.equal(await f.present(foreign), true);
    assert.deepEqual(f.deletes, []);
    await f.siblingSurvives();
  },
);

test("real CI OTel cleanup removes only its recorded container", selected, async (t) => {
  const f = await realFixture(t);
  const other = await f.sentinelAt(`ci-otel-other-${randomUUID()}`);
  const prepared = await f.prepare();
  const original = await f.containerAt(prepared.artifacts.containerName);
  await f.cleanup();
  assert.equal(await f.present(original), false);
  assert.equal(await f.present(other), true);
  assert.deepEqual(f.deletes, [original]);
  await assert.rejects(stat(prepared.artifacts.directory), { code: "ENOENT" });
  await f.siblingSurvives();
});

test(
  "real CI OTel cleanup removes a renamed original and preserves its replacement",
  selected,
  async (t) => {
    const f = await realFixture(t);
    const prepared = await f.prepare();
    const original = await f.containerAt(prepared.artifacts.containerName);
    await f.renamed(original);
    const replacement = await f.sentinelAt(prepared.artifacts.containerName);
    await f.cleanup();
    assert.equal(await f.present(original), false);
    assert.equal(await f.present(replacement), true);
    await f.cleanup();
    assert.deepEqual(f.deletes, [original]);
    assert.equal(await f.present(replacement), true);
    await f.siblingSurvives();
  },
);

test(
  "real CI OTel cleanup CLI recovers a bound journal and preserves a replacement",
  selected,
  async (t) => {
    const f = await realFixture(t);
    const prepared = await f.prepare();
    const original = await f.containerAt(prepared.artifacts.containerName);
    const entry = f.resource();
    const before = await recoveryEvidence(entry);
    assert.deepEqual(JSON.parse(before.receipt.toString()), {
      custody: before.custody,
      phase: "created",
      containerId: original,
    });
    assert.ok(before.cid);
    assert.equal(id(before.cid.toString()), original);
    assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), f.state());
    await f.renamed(original);
    const replacement = await f.sentinelAt(prepared.artifacts.containerName);

    const result = await f.cleanupCli();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await f.present(original), false);
    assert.equal(await f.present(replacement), true);
    assert.deepEqual(f.deletes, [original]);
    await assertRemovedJournal(f.statePath, entry, original);
    await f.siblingSurvives();

    const repeated = await f.cleanupCli();
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.deepEqual(f.deletes, [original]);
    assert.equal(await f.present(replacement), true);
  },
);

test("real CI OTel cleanup CLI refuses a journal entry without custody", selected, async (t) => {
  const f = await realFixture(t);
  const prepared = await f.prepare();
  const original = await f.containerAt(prepared.artifacts.containerName);
  const entry = f.resource();
  const before = await recoveryEvidence(entry);
  assert.deepEqual(JSON.parse(before.receipt.toString()), {
    custody: before.custody,
    phase: "created",
    containerId: original,
  });
  assert.ok(before.cid);
  assert.equal(id(before.cid.toString()), original);
  const savedState = f.state();
  assert.equal(savedState.resources.length, 1);
  const savedEntry = savedState.resources[0];
  assert.ok(savedEntry);
  const unbound = { ...savedEntry };
  delete unbound.custody;
  const unboundState = { ...savedState, resources: [unbound] };
  await writeFixtureReceipt(f.statePath, unboundState);

  const result = await f.cleanupCli();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OTel backend has unsupported or unbound custody state\./);
  assert.equal(await f.present(original), true);
  assert.equal(f.createForwards(), 1);
  assert.deepEqual(f.deletes, []);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), unboundState);
  assert.deepEqual(await recoveryEvidence(entry), before);
  await f.siblingSurvives();

  // Restoring only the genuine field makes the same owner-bound input
  // eligible; no receipt or container identity is manufactured.
  await writeFixtureReceipt(f.statePath, savedState);
  const restored = await f.cleanupCli();
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(await f.present(original), false);
  assert.deepEqual(f.deletes, [original]);
  await assertRemovedJournal(f.statePath, entry, original);
});

test(
  "real CI OTel cleanup retains an unreceived creation and preserves a replacement",
  selected,
  async (t) => {
    const f = await realFixture(t);
    let original = "";
    let replacement = "";
    let gateFired = false;
    f.gate("create", async (objectId) => {
      original = objectId;
      assert.equal(await f.present(original), true);
      await f.renamed(original);
      replacement = await f.sentinelAt(String(f.resource().containerName));
      gateFired = true;
    });
    await assert.rejects(f.prepare(), (error: unknown) => {
      const stderr = setupCommandStderr(error);
      assert.match(stderr, /\/containers\/create(?:[?"\s])/);
      assert.match(stderr, /\b(?:unexpected )?EOF\b/);
      return true;
    });
    assert.equal(gateFired, true, "the genuine after-create response gate must complete");
    assert.equal(f.createForwards(), 1);
    assert.equal(await f.present(original), true);
    assert.equal(await f.present(replacement), true);
    assert.deepEqual(f.deletes, []);
    assert.ok((await stat(String(f.resource().directory))).isDirectory());
    await f.siblingSurvives();

    const entry = f.resource();
    const before = await recoveryEvidence(entry);
    assert.deepEqual(JSON.parse(before.receipt.toString()), {
      custody: before.custody,
      phase: "create-intent",
    });
    assert.equal(before.cid, undefined, "the lost create reply must not publish a cidfile");
    await assert.rejects(stat(before.custody.cidPath), { code: "ENOENT" });
    const result = await f.cleanupCli();
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /OTel backend create outcome is unknown; retain its custody receipt\./,
    );
    assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), f.state());
    assert.deepEqual(await recoveryEvidence(entry), before);
    assert.equal(await f.present(original), true);
    assert.equal(await f.present(replacement), true);
    assert.equal(f.createForwards(), 1);
    assert.deepEqual(f.deletes, []);
    await f.siblingSurvives();
  },
);

test(
  "real CI OTel cleanup recovers a completed create with a lost command result",
  selected,
  async (t) => {
    const f = await realFixture(t);
    let original = "";
    let replacement = "";
    const lostRunResult = new Error("lost Docker run command result");
    const execFile: Executor = async (command, args, options) => {
      const result = await f.execute(command, args, options);
      if (args.includes("run")) {
        original = id(result.stdout);
        await f.renamed(original);
        replacement = await f.sentinelAt(String(f.resource().containerName));
        throw lostRunResult;
      }
      return result;
    };
    await assert.rejects(f.prepare({ execFile }), (error: unknown) => error === lostRunResult);
    assert.equal(await f.present(original), false);
    assert.equal(await f.present(replacement), true);
    assert.deepEqual(f.deletes, [original]);
    await f.siblingSurvives();
  },
);

test(
  "real CI OTel cleanup reconciles a lost remove response without replay",
  selected,
  async (t) => {
    const f = await realFixture(t);
    const prepared = await f.prepare();
    const original = await f.containerAt(prepared.artifacts.containerName);
    let replacement = "";
    let gateFired = false;
    f.gate("remove", async (objectId) => {
      assert.equal(objectId, original);
      assert.equal(await f.present(original), false);
      replacement = await f.sentinelAt(prepared.artifacts.containerName);
      gateFired = true;
    });
    const cleanupResult = await f.cleanup().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    assert.equal(gateFired, true, "the genuine after-remove response gate must complete");
    assert.equal(await f.present(original), false);
    assert.equal(await f.present(replacement), true);
    assert.equal(cleanupResult.ok, true, "cleanup must reconcile the lost remove response");
    await f.cleanup();
    assert.deepEqual(f.deletes, [original]);
    assert.equal(await f.present(replacement), true);
    await f.siblingSurvives();
  },
);
