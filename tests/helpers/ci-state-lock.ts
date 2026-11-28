import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, constants } from "node:fs";
import { Session, url as inspectorUrl } from "node:inspector";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { withStateLock } from "../../scripts/ci/state-lock.ts";

type Message = { type: string; [key: string]: unknown };
type Pause = {
  callFrames: Array<{ callFrameId: string; functionName: string }>;
  hitBreakpoints?: string[];
};
type Reply = { result?: Record<string, unknown>; error?: unknown };
type Event = { role: string; type: "entered" | "left" };
const sourceUrl = new URL("../../scripts/ci/state-lock.ts", import.meta.url).href;
const helperPath = fileURLToPath(import.meta.url);

async function waitUntil<T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
  deadline = Date.now() + 30_000,
  signal?: AbortSignal,
): Promise<T> {
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function marker(path: string) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags);
  try {
    const info = await handle.stat();
    if (info.isFile()) {
      return { name: "", token: await handle.readFile("utf8") };
    }
    assert(info.isDirectory());
  } finally {
    await handle.close();
  }
  const names = await readdir(path);
  assert.equal(names.length, 1);
  const name = names[0]!;
  const owner = await open(join(path, name), flags);
  try {
    assert((await owner.stat()).isFile());
    return { name, token: await owner.readFile("utf8") };
  } finally {
    await owner.close();
  }
}

// The worker uses the real public API. Only its callback is gated; debugger pauses
// schedule the real filesystem operations without replacing methods or changing locals.
async function worker(
  statePath: string,
  role: string,
  timeoutMs: number,
  inspectOwner: boolean,
  eventPath: string,
) {
  const commands: string[] = [];
  process.on("message", (value: { command: string }) => commands.push(value.command));
  const receive = (command: string) =>
    waitUntil(() => {
      const index = commands.indexOf(command);
      if (index < 0) {
        return undefined;
      }
      commands.splice(index, 1);
      return true;
    }, command);
  const send = (type: string, fields: Record<string, unknown> = {}) =>
    process.send?.({ type, ...fields });
  const record = (type: Event["type"]) =>
    appendFileSync(eventPath, `${JSON.stringify({ role, type })}\n`, { mode: 0o600 });
  send("ready", { inspectorUrl: inspectorUrl() ?? null, execArgv: process.execArgv });
  await receive("begin");
  try {
    await withStateLock(
      statePath,
      async () => {
        record("entered");
        const owner = inspectOwner ? await marker(`${statePath}.lock`) : undefined;
        const snapshot: string[] = JSON.parse(await readFile(statePath, "utf8"));
        send("entered", { owner, snapshot });
        await receive("commit");
        const next = [...snapshot, role];
        const temporary = `${statePath}.${process.pid}.next`;
        await writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
        await rename(temporary, statePath);
        record("left");
        send("left", { next });
      },
      { timeoutMs },
    );
    send("result", { outcome: "fulfilled" });
  } catch (error) {
    send("result", {
      outcome: "rejected",
      message: error instanceof Error ? error.message : String(error),
      code: typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
    });
  }
  await receive("shutdown");
  process.disconnect?.();
}

// Only inspect these owned process groups. Linux can retain dead orphan zombies;
// they cannot execute commands or keep a resource operation alive.
async function liveGroupMembers(group: number): Promise<number[]> {
  if (process.platform !== "linux") {
    try {
      process.kill(-group, 0);
      return [group];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return [];
      }
      throw error;
    }
  }
  const live: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X") {
        live.push(Number(name));
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
  }
  return live;
}

async function superviseStateLockWorker(args: string[]) {
  assert(process.send && process.connected);
  const stopGroup = () => process.kill(-process.pid, "SIGKILL");
  process.once("disconnect", stopGroup);
  process.once("exit", stopGroup);
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  const child = spawn(process.execPath, args, {
    env: { ...process.env, OPENCLAW_CI_COMPLETE_PHASE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc", 4, 5],
  });
  const send = (message: Message) => {
    if (process.connected) {
      process.send?.(message);
    }
  };
  send({ type: "state-lock-worker-started", pid: child.pid });
  child.on("message", send);
  child.once("exit", (code, signal) =>
    send({ type: "state-lock-worker-exit", status: { code, signal } }),
  );
  child.once("close", (code, signal) =>
    send({ type: "state-lock-worker-close", status: { code, signal } }),
  );
  child.once("error", (error) => {
    send({ type: "state-lock-worker-error", message: error.message });
    stopGroup();
  });
  process.on("message", (message: Record<string, unknown>) => {
    if (message.supervisor === "stop-worker") {
      child.kill("SIGKILL");
    } else if (child.connected) {
      child.send(message);
    }
  });
  // The owner acknowledges settlement by killing this still-owned group leader.
  await new Promise(() => {});
}

export class StateLockProcess {
  messages: Message[] = [];
  pauses: Pause[] = [];
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  debuggerInput: Writable;
  debuggerOutput: Readable;
  bridgeReady?: Message;
  exited = false;
  exitStatus?: { code: number | null; signal: NodeJS.Signals | null };
  closeStatus?: { code: number | null; signal: NodeJS.Signals | null };
  replies = new Map<number, (value: Reply) => void>();
  nextId = 0;
  readonly execArgv: string[];
  readonly supervised: boolean;
  readonly deadline: number | undefined;
  readonly signal: AbortSignal | undefined;
  workerPid?: number;
  workerExit?: { code: number | null; signal: NodeJS.Signals | null };
  workerClose?: { code: number | null; signal: NodeJS.Signals | null };
  readonly groups = new Set<number>();
  private stopping?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly cancel = () => {
    void this.stop().catch(() => {});
  };
  get pid() {
    return this.supervised ? this.workerPid : this.child.pid;
  }
  private wait<T>(read: () => T | undefined | Promise<T | undefined>, description: string) {
    return waitUntil(read, description, this.deadline, this.signal);
  }
  constructor(
    statePath: string,
    role: string,
    eventPath: string,
    timeoutMs = 60_000,
    inspectOwner = true,
    launch?: {
      path: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      execArgv?: string[];
      supervised?: boolean;
      deadline?: number;
      signal?: AbortSignal;
    },
  ) {
    this.execArgv = launch?.execArgv ?? ["--disable-sigusr1"];
    this.supervised = launch?.supervised === true;
    this.deadline = launch?.deadline;
    this.signal = launch?.signal;
    this.signal?.throwIfAborted();
    if (this.supervised) {
      assert.notEqual(process.platform, "win32", "Caller supervision requires POSIX groups");
    }
    const workerArgs = [
      ...this.execArgv,
      launch?.path ?? helperPath,
      ...(launch?.args ?? [
        "--state-lock-worker",
        statePath,
        role,
        String(timeoutMs),
        String(inspectOwner),
        eventPath,
      ]),
    ];
    this.child = spawn(
      process.execPath,
      this.supervised
        ? ["--disable-sigusr1", helperPath, "--state-lock-supervisor", JSON.stringify(workerArgs)]
        : workerArgs,
      {
        cwd: dirname(statePath),
        detached: this.supervised,
        env: launch?.env ?? { LANG: "C", TZ: "UTC" },
        stdio: ["ignore", "ignore", "ignore", "ipc", "pipe", "pipe"],
      },
    );
    this.closed = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitStatus = { code, signal };
        if (this.supervised) {
          this.debuggerInput.destroy();
          this.debuggerOutput.destroy();
        }
      });
      this.child.once("close", (code, signal) => {
        this.closeStatus = { code, signal };
        resolve(this.closeStatus);
      });
    });
    this.child.on("message", (message: Message) => {
      if (message.type === "state-lock-worker-started") {
        assert.equal(typeof message.pid, "number");
        this.workerPid = message.pid as number;
      } else if (message.type === "state-lock-worker-exit") {
        this.workerExit = message.status as { code: number | null; signal: NodeJS.Signals | null };
      } else if (message.type === "state-lock-worker-close") {
        this.workerClose = message.status as { code: number | null; signal: NodeJS.Signals | null };
      } else if (message.type === "ci-lifecycle-group") {
        assert(Number.isSafeInteger(message.id) && Number(message.id) > 1);
        this.groups.add(Number(message.id));
      }
      this.messages.push(message);
    });
    const pipes: readonly (Readable | Writable | null | undefined)[] = this.child.stdio;
    const input = pipes[4];
    const output = pipes[5];
    assert(input instanceof Writable && output instanceof Readable);
    this.debuggerInput = input;
    this.debuggerOutput = output;
    createInterface({ input: output }).on("line", (line: string) => {
      const reply = JSON.parse(line) as Reply & {
        id?: number;
        method?: string;
        params?: Pause;
        type?: string;
        inspectorUrl?: unknown;
      };
      if (reply.id !== undefined) {
        this.replies.get(reply.id)?.(reply);
      } else if (reply.method === "Debugger.paused" && reply.params) {
        this.pauses.push(reply.params);
      } else if (reply.type === "debugger-ready") {
        this.bridgeReady = reply as Message;
      }
    });
    this.signal?.addEventListener("abort", this.cancel, { once: true });
  }
  async connect() {
    const bridge = await this.wait(() => this.bridgeReady, "private debugger bridge");
    assert.equal(bridge.inspectorUrl, null);
    const ready = await this.message("ready");
    assert.equal(ready.inspectorUrl, null);
    assert.deepEqual(ready.execArgv, this.execArgv);
    await this.command("Debugger.enable");
  }
  async command(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.nextId;
    let reply: Reply | undefined;
    this.replies.set(id, (value) => {
      reply = value;
    });
    this.debuggerInput.write(`${JSON.stringify({ id, method, params })}\n`);
    try {
      const value = await this.wait(() => reply, method);
      assert.equal(value.error, undefined);
      return value.result ?? {};
    } finally {
      this.replies.delete(id);
    }
  }
  send(command: string) {
    this.signal?.throwIfAborted();
    this.child.send({ command });
  }
  message(type: string) {
    return this.wait(() => this.messages.find((value) => value.type === type), type);
  }
  stop() {
    return (this.stopping ??= this.stopOwned().finally(() => {
      this.signal?.removeEventListener("abort", this.cancel);
    }));
  }
  private async stopOwned() {
    if (!this.supervised) {
      if (!this.exited) {
        this.child.kill("SIGKILL");
      }
      return this.closed;
    }
    const deadline = Date.now() + 15_000;
    const group = this.child.pid;
    assert(group !== undefined && group > 1);
    this.groups.add(group);
    let failure: unknown;
    if (!this.exited) {
      // Keep the group leader alive until the real caller has reported exit/close.
      // Its IPC loss also terminates any independently supervised cleanup groups.
      if (this.child.connected) {
        this.child.send({ supervisor: "stop-worker" });
      }
      try {
        await waitUntil(() => this.workerClose, "caller close", Date.now() + 5_000);
      } catch (error) {
        failure = error;
      } finally {
        if (!this.exited) {
          process.kill(-group, "SIGKILL");
        }
      }
    }
    const exited = await waitUntil(() => this.exitStatus, "caller supervisor exit", deadline);
    // An explicitly lost IPC channel may omit ChildProcess's aggregate close
    // event. Join the actual exit and our descriptor closures independently;
    // never turn a missing caller result into a successful operation receipt.
    this.debuggerInput.destroy();
    this.debuggerOutput.destroy();
    await waitUntil(
      () => (this.debuggerInput.closed && this.debuggerOutput.closed ? true : undefined),
      "caller debugger descriptors to close",
      deadline,
    );
    await waitUntil(
      async () => {
        for (const id of this.groups) {
          if ((await liveGroupMembers(id)).length > 0) {
            return undefined;
          }
        }
        return true;
      },
      "owned command groups to stop",
      deadline,
    );
    if (failure !== undefined) {
      throw failure;
    }
    return this.workerClose ?? this.closeStatus ?? exited;
  }
  async finish(outcome = "fulfilled") {
    const result = await this.message("result");
    assert.equal(result.outcome, outcome);
    this.send("shutdown");
    if (this.supervised) {
      assert.deepEqual(await this.wait(() => this.workerClose, "caller close"), {
        code: 0,
        signal: null,
      });
      await this.stop();
    } else {
      assert.deepEqual(await this.closed, { code: 0, signal: null });
    }
    return result;
  }
  async breakpoint(statement: string, after = "", url = sourceUrl, sourceText?: string) {
    const source = sourceText ?? (await readFile(new URL(url), "utf8"));
    const start = source.indexOf(after);
    const offset = source.indexOf(statement, start);
    assert(start >= 0 && offset >= 0, `Missing debugger location: ${statement}`);
    const lineNumber = source.slice(0, offset).split("\n").length - 1;
    const reply = await this.command("Debugger.setBreakpointByUrl", { url, lineNumber });
    const locations = reply.locations as Array<{ lineNumber: number }>;
    assert(locations.length > 0 && locations.every((value) => value.lineNumber === lineNumber));
    return String(reply.breakpointId);
  }
  pause(id: string) {
    return this.wait(() => {
      const index = this.pauses.findIndex((value) => value.hitBreakpoints?.includes(id));
      return index < 0 ? undefined : this.pauses.splice(index, 1)[0];
    }, `breakpoint ${id}`);
  }
  async local(paused: Pause, name: string, expression: string) {
    const frame = paused.callFrames.find((value) => value.functionName === name);
    assert(frame);
    const value = await this.command("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId,
      expression,
      returnByValue: true,
      throwOnSideEffect: true,
    });
    assert.equal(value.exceptionDetails, undefined);
    return (value.result as { value: unknown }).value;
  }
  async resume(id: string) {
    await this.command("Debugger.removeBreakpoint", { breakpointId: id });
    await this.command("Debugger.resume");
  }
}

class Scenario {
  readonly contenders: StateLockProcess[] = [];
  readonly eventPath: string;
  readonly statePath: string;
  readonly context: TestContext;
  cleanupPromise?: Promise<void>;
  constructor(t: TestContext, statePath: string) {
    this.context = t;
    this.statePath = statePath;
    this.eventPath = `${statePath}.events`;
    t.after(() => this.cleanup());
  }
  async start(role: string, { begin = false, timeoutMs = 60_000, inspectOwner = true } = {}) {
    const contender = new StateLockProcess(
      this.statePath,
      role,
      this.eventPath,
      timeoutMs,
      inspectOwner,
    );
    this.contenders.push(contender);
    await contender.connect();
    if (begin) {
      contender.send("begin");
    }
    return contender;
  }
  async order(roles: readonly string[]) {
    const events = (await readFile(this.eventPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event)
      .filter((event) => roles.includes(event.role));
    let active = 0;
    let maximum = 0;
    for (const event of events) {
      active += event.type === "entered" ? 1 : -1;
      assert(active >= 0);
      maximum = Math.max(maximum, active);
    }
    return {
      active,
      maximum,
      completed: events.filter((event) => event.type === "left").map((event) => event.role),
    };
  }
  cleanup() {
    this.cleanupPromise ??= (async () => {
      const workers = await Promise.all(
        this.contenders.map(async (contender) => {
          const exit = await contender.stop();
          assert.throws(() => process.kill(contender.child.pid!, 0), { code: "ESRCH" });
          return { pid: contender.child.pid, ...exit, reaped: true };
        }),
      );
      await unlink(this.eventPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      this.context.diagnostic(
        `State-lock workers: ${JSON.stringify({ workers, remainingEntries: await readdir(dirname(this.statePath)) })}`,
      );
    })();
    return this.cleanupPromise;
  }
}

// Only inherited descriptors carry debugger commands. The bridge thread continues
// servicing them while the lock contender's main thread is paused.
function debuggerBridge() {
  const input = new Socket({ fd: 4, readable: true, writable: false });
  const output = new Socket({ fd: 5, readable: false, writable: true });
  const session = new Session();
  session.connectToMainThread();
  const send = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  session.on("Debugger.paused", (notification) => send(notification));
  createInterface({ input }).on("line", (line: string) => {
    const { id, method, params } = JSON.parse(line) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    session.post(method, params, (error, result) => {
      send(error ? { id, error: error.message } : { id, result });
    });
  });
  parentPort!.once("message", () => {
    input.destroy();
    session.disconnect();
    output.end();
    parentPort!.close();
  });
  send({ type: "debugger-ready", inspectorUrl: inspectorUrl() ?? null });
}

export async function runWithStateLockDebugger(operation: () => Promise<void>) {
  const bridge = new Worker(helperPath, { workerData: "state-lock-debugger", execArgv: [] });
  const bridgeExit = new Promise<number>((resolve, reject) => {
    bridge.once("error", reject);
    bridge.once("exit", resolve);
  });
  try {
    await operation();
  } finally {
    bridge.postMessage("stop");
    assert.equal(await bridgeExit, 0);
  }
}

// A separate process has no debugger descriptors. On Linux it checks only this
// owned contender's socket inodes against its network namespace's TCP listeners.
async function listeningTcpSockets(pid: number) {
  const directory = `/proc/${pid}/fd`;
  const sockets = new Set<string>();
  for (const name of await readdir(directory)) {
    try {
      const target = await readlink(join(directory, name));
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) {
        sockets.add(match[1]!);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  const listeners: string[] = [];
  for (const family of ["tcp", "tcp6"]) {
    const lines = (await readFile(`/proc/${pid}/net/${family}`, "utf8")).trim().split("\n");
    for (const line of lines.slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A" && sockets.has(fields[9]!)) {
        listeners.push(fields[1]!);
      }
    }
  }
  return listeners;
}

export async function checkStateLockDebugger(t: TestContext, root: string) {
  const statePath = join(root, "state.json");
  await writeFile(statePath, "[]");
  const scenario = new Scenario(t, statePath);
  try {
    const contender = await scenario.start("private-debugger");
    const id = await contender.breakpoint("await writeFile(join(ticketPath, owner.marker)");
    contender.send("begin");
    const paused = await contender.pause(id);
    assert.equal(
      await contender.local(paused, "acquireFileLock", "process.pid"),
      contender.child.pid,
    );
    if (process.platform === "linux") {
      const peer = spawn(
        process.execPath,
        [helperPath, "--state-lock-debugger-peer", String(contender.child.pid)],
        {
          env: { LANG: "C", TZ: "UTC" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      peer.stdout!.on("data", (data: Uint8Array) => {
        stdout += String(data);
      });
      peer.stderr!.on("data", (data: Uint8Array) => {
        stderr += String(data);
      });
      const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          peer.once("error", reject);
          peer.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      assert.deepEqual(closed, { code: 0, signal: null }, stderr);
      assert.deepEqual(JSON.parse(stdout), { pid: contender.child.pid, listeners: [] });
      t.diagnostic(`Private debugger peer: ${stdout.trim()}; peer exit ${JSON.stringify(closed)}`);
    }
    await contender.resume(id);
    await contender.message("entered");
    contender.send("commit");
    await contender.finish();
    assert.deepEqual(await scenario.order(["private-debugger"]), {
      active: 0,
      maximum: 1,
      completed: ["private-debugger"],
    });
    assert.throws(() => process.kill(contender.child.pid!, 0), { code: "ESRCH" });
  } finally {
    await scenario.cleanup();
  }
}

export async function checkStateLockRecovery(t: TestContext, root: string) {
  const statePath = join(root, "state.json");
  await writeFile(statePath, "[]");
  const source = await readFile(new URL(sourceUrl), "utf8");
  // Keep the predecessor scheduling so a tests-only patch fails on actual overlap.
  const legacy = source.includes("await link(ticketPath, path)");
  const publish = legacy ? "await writeFile(ticketPath, token" : "await mkdir(ticketPath,";
  const acquire = legacy ? "await link(ticketPath, path)" : "await rename(ticketPath, path)";
  const recover = legacy
    ? "await rename(path, aside)"
    : "await unlink(join(path, owner.marker)).catch(ignoreMissing)";
  const scenario = new Scenario(t, statePath);
  const start = (role: string) => scenario.start(role);
  try {
    const d = await start("D");
    d.send("begin");
    const dead = await d.message("entered");
    await d.stop();
    assert.throws(() => process.kill(d.child.pid!, 0), { code: "ESRCH" });
    assert.deepEqual(await marker(`${statePath}.lock`), dead.owner);

    const a = await start("A");
    const ap = await a.breakpoint(publish);
    a.send("begin");
    const al = (await a.local(await a.pause(ap), "acquireFileLock", "({ticket, token})")) as {
      ticket: string;
      token: string;
    };
    const b = await start("B");
    const bp = await b.breakpoint(publish);
    b.send("begin");
    const bl = (await b.local(
      await b.pause(bp),
      "acquireFileLock",
      "({ticket, token})",
    )) as typeof al;
    const c = await start("C");
    const ca = await c.breakpoint(acquire);
    const cr = await c.breakpoint(recover);
    c.send("begin");
    const cl = (await c.local(await c.pause(ca), "acquireFileLock", "({ticket, ahead})")) as {
      ticket: string;
      ahead: number;
    };
    assert(al.ticket < bl.ticket && bl.ticket < cl.ticket);
    assert.equal(cl.ahead, 0);
    await c.resume(ca);
    const stale = await c.local(
      await c.pause(cr),
      "removeAbandonedLock",
      legacy ? "content" : "owner.token",
    );
    assert.equal(stale, (dead.owner as { token: string }).token);
    await a.resume(ap);
    assert.deepEqual((await a.message("entered")).snapshot, []);
    const ba = await b.breakpoint(acquire);
    await b.resume(bp);
    assert.equal(await b.local(await b.pause(ba), "acquireFileLock", "ahead"), 0);
    if (legacy) {
      const displaced = await c.breakpoint("if ((await readFile(aside");
      await c.resume(cr);
      await c.pause(displaced);
      await b.resume(ba);
      await b.message("entered");
      const { active } = await scenario.order(["A", "B"]);
      assert.equal(active, 1, "overlapping outer callbacks after delayed recovery");
      throw new Error("Legacy recovery unexpectedly passed the overlap schedule");
    }
    const cd = await c.breakpoint("await delay(ahead === 0");
    await c.resume(cr);
    await c.pause(cd);
    assert.equal((await marker(`${statePath}.lock`)).token, al.token);
    await c.resume(cd);

    // C's stale recovery cannot displace A. A's delayed rmdir cannot remove B after
    // A completes its update and B atomically replaces the now-empty directory.
    const ar = await a.breakpoint("await removeEmptyLock(path)", "async function releaseFileLock");
    await b.resume(ba);
    a.send("commit");
    await a.pause(ar);
    await a.message("left");
    assert.deepEqual((await b.message("entered")).snapshot, ["A"]);
    assert.equal((await marker(`${statePath}.lock`)).token, bl.token);
    await a.resume(ar);
    await a.finish();
    assert.equal((await marker(`${statePath}.lock`)).token, bl.token);
    b.send("commit");
    await b.finish();
    assert.deepEqual((await c.message("entered")).snapshot, ["A", "B"]);
    c.send("commit");
    await c.finish();
    const { active, maximum } = await scenario.order(["A", "B", "C"]);
    assert.equal(active, 0);
    assert.equal(maximum, 1);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), ["A", "B", "C"]);
    await scenario.cleanup();
    assert.deepEqual(await readdir(root), ["state.json"]);
  } finally {
    await scenario.cleanup();
  }
}

export async function checkStateLockTicketReaping(t: TestContext, root: string) {
  const source = await readFile(new URL(sourceUrl), "utf8");
  const claimsTicket = source.includes("await rename(path, claimed)");
  const run = async (publicationWins: boolean) => {
    const directory = join(root, publicationWins ? "ticket-publisher-wins" : "ticket-reaper-wins");
    await mkdir(directory);
    const statePath = join(directory, "state.json");
    const lockPath = `${statePath}.lock`;
    await writeFile(statePath, "[]");
    const scenario = new Scenario(t, statePath);
    const start = (role: string, timeoutMs = 60_000) =>
      // Real callers do not check their marker inside the callback. Preserve that
      // behavior so publishing an empty directory cannot become a test-only refusal.
      scenario.start(role, { timeoutMs, inspectOwner: false });
    try {
      const a = await start("A", 50);
      const publication = await a.breakpoint("await rename(ticketPath, path)");
      a.send("begin");
      const ticket = (await a.local(
        await a.pause(publication),
        "acquireFileLock",
        "({ticketPath, ticket, ahead, expiry: String(expiry), token})",
      )) as {
        ticketPath: string;
        ticket: string;
        ahead: number;
        expiry: string;
        token: string;
      };
      assert.equal(ticket.ahead, 0);
      assert.equal((await marker(ticket.ticketPath)).token, ticket.token);
      const identity = await lstat(ticket.ticketPath);
      // Wait for the genuine encoded CLOCK_MONOTONIC deadline, including its grace.
      // The process stays alive at the actual publication instruction throughout.
      await waitUntil(
        () => (process.hrtime.bigint() > BigInt(ticket.expiry) ? true : undefined),
        "authentic live ticket expiry",
      );
      process.kill(a.child.pid!, 0);

      const b = await start("B");
      const boundary = publicationWins
        ? claimsTicket
          ? "await rename(path, claimed)"
          : "await unlink(join(path, marker))"
        : claimsTicket
          ? "await rmdir(claimed)"
          : "await rmdir(path).catch(ignoreMissing)";
      const reaping = await b.breakpoint(boundary, "async function removeTicket");
      b.send("begin");
      const paused = await b.pause(reaping);
      assert.equal(await b.local(paused, "removeTicket", "path"), ticket.ticketPath);
      const cleanupPath = claimsTicket
        ? ((await b.local(paused, "removeTicket", "claimed")) as string)
        : ticket.ticketPath;
      if (!publicationWins) {
        const claimedIdentity = await lstat(cleanupPath);
        assert.deepEqual([claimedIdentity.dev, claimedIdentity.ino], [identity.dev, identity.ino]);
        assert.deepEqual(await readdir(cleanupPath), []);
        if (claimsTicket) {
          await assert.rejects(lstat(ticket.ticketPath), { code: "ENOENT" });
        }
      }

      await a.resume(publication);
      const first = await waitUntil(
        () => a.messages.find((value) => value.type === "entered" || value.type === "result"),
        "publisher entry or refusal",
      );
      let aResult: Message;
      if (publicationWins) {
        assert.equal(first.type, "entered");
        assert.equal((await marker(lockPath)).token, ticket.token);
        const waiting = await b.breakpoint("await delay(ahead === 0");
        await b.resume(reaping);
        await b.pause(waiting);
        assert.equal((await marker(lockPath)).token, ticket.token);
        await b.resume(waiting);
        a.send("commit");
        aResult = await a.finish();
        assert.deepEqual((await b.message("entered")).snapshot, ["A"]);
      } else if (first.type === "entered") {
        // The predecessor publishes the emptied ticket. Let both genuine callbacks
        // finish their writes so the red control proves the lost update as well.
        const published = await lstat(lockPath);
        assert.deepEqual([published.dev, published.ino], [identity.dev, identity.ino]);
        assert.deepEqual(await readdir(lockPath), []);
        await b.resume(reaping);
        assert.deepEqual((await b.message("entered")).snapshot, []);
        a.send("commit");
        await a.message("left");
        aResult = await a.finish("rejected");
        assert.match(String(aResult.message), /was taken while this process held it/);
      } else {
        assert.equal(first.outcome, "rejected");
        assert.equal(first.code, "ENOENT");
        assert.equal(
          a.messages.some((value) => value.type === "entered"),
          false,
        );
        aResult = await a.finish("rejected");
        await b.resume(reaping);
        assert.deepEqual((await b.message("entered")).snapshot, []);
      }
      b.send("commit");
      const bResult = await b.finish();
      const { active, maximum, completed } = await scenario.order(["A", "B"]);
      assert.equal(active, 0);
      const finalState: string[] = JSON.parse(await readFile(statePath, "utf8"));
      await scenario.cleanup();
      assert.deepEqual(await readdir(directory), ["state.json"]);
      for (const contender of scenario.contenders) {
        assert.throws(() => process.kill(contender.child.pid!, 0), { code: "ESRCH" });
      }
      return {
        schedule: publicationWins ? "publisher-wins" : "reaper-wins",
        ticket: ticket.ticket,
        expiry: ticket.expiry,
        identity: { device: identity.dev, inode: identity.ino },
        aResult,
        bResult,
        maximum,
        completed,
        finalState,
        workers: scenario.contenders.map((contender) => ({
          pid: contender.child.pid,
          exited: true,
        })),
        remainingEntries: await readdir(directory),
      };
    } finally {
      await scenario.cleanup();
      await unlink(statePath);
      await rmdir(directory);
    }
  };
  const reaperWins = await run(false);
  const publisherWins = await run(true);
  t.diagnostic(`Expired live-ticket schedules: ${JSON.stringify([reaperWins, publisherWins])}`);
  for (const result of [reaperWins, publisherWins]) {
    assert.equal(result.maximum, 1, `overlapping outer callbacks when ${result.schedule}`);
    assert.deepEqual(
      result.finalState,
      result.completed,
      `lost completed update when ${result.schedule}`,
    );
  }
}

export async function checkStateLockLongBasename(t: TestContext, root: string) {
  const directory = join(root, "long-basename");
  await mkdir(directory);
  const statePath = join(directory, "s".repeat(128));
  const lockPath = `${statePath}.lock`;
  await writeFile(statePath, "[]");
  const scenario = new Scenario(t, statePath);
  try {
    const holder = await scenario.start("holder", { begin: true });
    const ownership = (await holder.message("entered")).owner;
    const waiter = await scenario.start("dead-waiter", { begin: true });
    const ticket = await waitUntil(
      async () =>
        (await readdir(directory)).find(
          (name) => name.endsWith(".ticket") && name.includes(`.${waiter.child.pid}.`),
        ),
      "long-basename waiter ticket",
    );
    assert((await lstat(join(directory, ticket))).isDirectory());
    await waiter.stop();
    assert.throws(() => process.kill(waiter.child.pid!, 0), { code: "ESRCH" });
    const successor = await scenario.start("successor", { begin: true });
    const successorTicket = await waitUntil(async () => {
      const result = successor.messages.find((message) => message.type === "result");
      assert.equal(
        result,
        undefined,
        `successor failed to reap the long ticket: ${JSON.stringify(result)}`,
      );
      const entries = await readdir(directory);
      if (entries.includes(ticket)) {
        return undefined;
      }
      return entries.find(
        (name) => name.endsWith(".ticket") && name.includes(`.${successor.child.pid}.`),
      );
    }, "long-basename dead-ticket reclamation");
    assert.equal(
      successor.messages.some((message) => message.type === "entered"),
      false,
    );
    let ran = false;
    await assert.rejects(
      withStateLock(
        statePath,
        () => {
          ran = true;
        },
        { timeoutMs: 50 },
      ),
      /Timed out after 50 ms waiting for the CI state lock/,
    );
    assert.equal(ran, false);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith(".ticket")),
      [successorTicket],
    );
    assert.deepEqual(await marker(lockPath), ownership);
    holder.send("commit");
    await holder.finish();
    assert.deepEqual((await successor.message("entered")).snapshot, ["holder"]);
    successor.send("commit");
    await successor.finish();
    assert.deepEqual(await scenario.order(["holder", "successor"]), {
      active: 0,
      maximum: 1,
      completed: ["holder", "successor"],
    });
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), ["holder", "successor"]);
    t.diagnostic(
      `Long-basename recovery: ${JSON.stringify({ stateBytes: 128, ticketBytes: Buffer.byteLength(ticket), deadWaiter: waiter.child.pid, successor: successor.child.pid, timeoutCallbackRan: ran })}`,
    );
  } finally {
    await scenario.cleanup();
  }
  assert.deepEqual(await readdir(directory), ["s".repeat(128)]);
  await unlink(statePath);
  await rmdir(directory);
}

export async function checkStateLockControls(t: TestContext, root: string) {
  // Qualify the filesystem operation on the actual test mount: a populated source
  // replaces an absent/empty destination, but never a populated destination.
  const from = join(root, "publication-source");
  const to = join(root, "publication-target");
  await mkdir(from);
  await mkdir(to);
  await writeFile(join(from, "source"), "source");
  await writeFile(join(to, "target"), "target");
  await assert.rejects(
    rename(from, to),
    (error: NodeJS.ErrnoException) => error.code === "ENOTEMPTY" || error.code === "EEXIST",
  );
  assert.equal(await readFile(join(from, "source"), "utf8"), "source");
  assert.equal(await readFile(join(to, "target"), "utf8"), "target");
  await unlink(join(to, "target"));
  await rename(from, to);
  assert.deepEqual(await readdir(to), ["source"]);
  await unlink(join(to, "source"));
  await rmdir(to);

  const statePath = join(root, "state.json");
  const lockPath = `${statePath}.lock`;
  const scenario = new Scenario(t, statePath);
  const start = (role: string, begin = true) => scenario.start(role, { begin });
  try {
    const holder = await start("holder");
    const ownership = (await holder.message("entered")).owner;
    let ran = false;
    await assert.rejects(
      withStateLock(
        statePath,
        () => {
          ran = true;
        },
        { timeoutMs: 50 },
      ),
      new RegExp(`held by pid ${holder.child.pid}, 0 waiting ahead`),
    );
    assert.equal(ran, false);
    assert.deepEqual(await marker(lockPath), ownership);

    const incomplete = await start("incomplete-ticket", false);
    const publishing = await incomplete.breakpoint(
      "await writeFile(join(ticketPath, owner.marker)",
    );
    incomplete.send("begin");
    const incompletePath = (await incomplete.local(
      await incomplete.pause(publishing),
      "acquireFileLock",
      "ticketPath",
    )) as string;
    assert.deepEqual(await readdir(incompletePath), []);
    await incomplete.stop();
    assert.throws(() => process.kill(incomplete.child.pid!, 0), { code: "ESRCH" });

    const waiter = await start("dead-waiter", false);
    // Reach the normal queue wait before killing it: otherwise this worker could
    // die midway through reclaiming the earlier incomplete ticket instead.
    const waiting = await waiter.breakpoint("await delay(ahead === 0");
    waiter.send("begin");
    await waiter.pause(waiting);
    const ticket = await waitUntil(
      async () =>
        (await readdir(root)).find(
          (name) => name.endsWith(".ticket") && name.includes(`.${waiter.child.pid}.`),
        ),
      "waiter ticket",
    );
    await waiter.stop();
    assert.throws(() => process.kill(waiter.child.pid!, 0), { code: "ESRCH" });
    await assert.rejects(
      withStateLock(
        statePath,
        () => {
          ran = true;
        },
        { timeoutMs: 50 },
      ),
      /Timed out/,
    );
    assert.equal((await readdir(root)).includes(ticket), false);
    await assert.rejects(readdir(incompletePath), { code: "ENOENT" });
    assert.equal(
      waiter.messages.some((value) => value.type === "entered"),
      false,
    );
    assert.equal(ran, false);
    assert.deepEqual(await marker(lockPath), ownership);

    // Different state paths can proceed while this holder is still active.
    const other = join(root, "other.json");
    assert.equal(await withStateLock(other, () => "independent"), "independent");
    holder.send("commit");
    await holder.finish();
    assert.equal(
      await withStateLock(statePath, () => withStateLock(statePath, async () => "nested")),
      "nested",
    );

    // Old, malformed and ambiguous ownership never authorizes reclamation.
    await writeFile(lockPath, `${waiter.child.pid} legacy\n`);
    await assert.rejects(
      withStateLock(statePath, () => {
        ran = true;
      }),
      /directory-lock protocol/,
    );
    assert.equal(await readFile(lockPath, "utf8"), `${waiter.child.pid} legacy\n`);
    await unlink(lockPath);
    await mkdir(lockPath);
    await writeFile(join(lockPath, "unrecognized"), "malformed");
    await assert.rejects(
      withStateLock(statePath, () => {
        ran = true;
      }),
      /Unrecognized CI state lock/,
    );
    assert.deepEqual(await readdir(lockPath), ["unrecognized"]);
    await unlink(join(lockPath, "unrecognized"));
    const names = [randomUUID(), randomUUID()].map(
      (generation) => `${process.pid}.${generation}.owner`,
    );
    for (const name of names) {
      await writeFile(join(lockPath, name), `${process.pid} ${name.split(".")[1]}\n`);
    }
    await assert.rejects(
      withStateLock(statePath, () => {
        ran = true;
      }),
      /Unrecognized CI state lock/,
    );
    assert.deepEqual((await readdir(lockPath)).sort(), names.sort());
    for (const name of names) {
      await unlink(join(lockPath, name));
    }
    // A process can die after unlinking its marker, leaving an empty directory.
    assert.equal(await withStateLock(statePath, () => "empty"), "empty");
    assert.equal(ran, false);

    const original = new Error("callback failure");
    await assert.rejects(
      withStateLock(statePath, async () => {
        const own = await marker(lockPath);
        await unlink(join(lockPath, own.name));
        await rmdir(lockPath);
        throw original;
      }),
      (error) => error === original,
    );
    await scenario.cleanup();
    assert.deepEqual(await readdir(root), ["state.json"]);
  } finally {
    await scenario.cleanup();
  }
}

if (!isMainThread && workerData === "state-lock-debugger") {
  debuggerBridge();
} else if (isMainThread && process.argv[1] === helperPath) {
  if (process.argv[2] === "--state-lock-supervisor") {
    const args: unknown = JSON.parse(process.argv[3]!);
    assert(Array.isArray(args) && args.every((arg) => typeof arg === "string"));
    await superviseStateLockWorker(args as string[]);
  } else if (process.argv[2] === "--state-lock-debugger-peer") {
    const pid = Number(process.argv[3]);
    assert(Number.isSafeInteger(pid) && pid > 0);
    console.log(JSON.stringify({ pid, listeners: await listeningTcpSockets(pid) }));
  } else if (process.argv[2] === "--state-lock-worker") {
    const statePath = process.argv[3];
    const role = process.argv[4];
    const eventPath = process.argv[7];
    assert(statePath && role && eventPath);
    await runWithStateLockDebugger(() =>
      worker(statePath, role, Number(process.argv[5]), process.argv[6] === "true", eventPath),
    );
  }
}
