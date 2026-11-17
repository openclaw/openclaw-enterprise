import {
  collectDiagnostics,
  drainDiagnostics,
  exitReason,
  report,
  safeReason,
} from "./diagnostics.ts";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  BOOTSTRAP_MS,
  bridge,
  ENROLLMENT_WAIT_MS,
  enrollmentBridge,
  INVALID_CAPABILITY,
  listen,
  PORT,
  processIdentity,
  RELEASE_LINE,
  sameProcess,
  tcpOwnership,
  upgradeStatus,
  waitFor,
} from "./transport.ts";
import type { ProcessIdentity } from "./transport.ts";

interface AgentInput {
  command: string[];
  workspace: string;
  codexBin: string;
  socketPath: string;
  projectionSocket?: string;
  /** Protected startup: wait here until the host verified Compute's signed release. */
  releaseSocket?: string;
  /**
   * Protected startup: the pre-ready enrollment bridge. Created before the release wait, while
   * nothing else runs in Box, so the host can pin it before it opens the gate. It forwards only
   * the two enrollment requests, only to the stock program's own listener, until Codex listens.
   */
  enrollmentSocket?: string;
  /** The host's native hook self-check: this command line must answer exactly `expected`. */
  nativeHookProbe?: { command: string; expected: string };
}

const PROBE_DEADLINE_MS = 20_000;

/**
 * Run the Gateway's native hook command through the same shell Codex uses for hooks (the first
 * `sh` on PATH: Box's alias, which decides the spawn under the run's policy), in the Codex working
 * directory, with empty input. Anything but the relay's own fail-closed answer means the hook
 * cannot run here and stock Codex would run every tool call unadmitted. Nothing is forwarded:
 * the result is one fixed reason.
 */
async function probeNativeHook(
  probe: { command: string; expected: string },
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<"observed" | "hook-denied" | "hook-failed" | "hook-response" | "deadline"> {
  if (
    typeof probe?.command !== "string" ||
    typeof probe.expected !== "string" ||
    probe.command.length > 4096 ||
    probe.expected.length > 4096
  )
    throw new Error("invalid_native_hook_probe");
  const child = spawn("sh", ["-c", probe.command], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "ignore"],
    env,
  });
  const chunks: Buffer[] = [];
  let length = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    length += chunk.length;
    if (length <= 8192) chunks.push(chunk);
  });
  child.stdin.on("error", () => {});
  child.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, PROBE_DEADLINE_MS);
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("error", () => resolve([null, null]));
      child.once("close", (exit, sig) => resolve([exit, sig]));
    });
    if (timedOut) return "deadline";
    // Strands Shell answers 126 for a refused spawn and 127 for a program it cannot find.
    if (code === 126 || code === 127) return "hook-denied";
    if (code !== 0 || signal !== null) return "hook-failed";
    return Buffer.concat(chunks).toString("utf8") === probe.expected
      ? "observed"
      : "hook-response";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait, without a deadline, for the host-owned release socket to appear and answer the
 * fixed release line. The host creates it only after it verified Compute's signed startup
 * release for this exact execution, so Codex never starts before release.
 */
async function awaitRelease(path: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const answer = await new Promise<string | undefined>((resolve) => {
      const socket = createConnection({ path });
      const chunks: Buffer[] = [];
      socket.setTimeout(2_000, () => socket.destroy());
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 64) socket.destroy();
      });
      socket.once("error", () => resolve(undefined));
      socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    if (answer === RELEASE_LINE) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// This file is launched by Box with an owner-generated, read-only input file.
// The env is what Box built for this one workload; no host environment is copied.
async function setupCode(path: string): Promise<string> {
  const socket = createConnection({ path });
  socket.setTimeout(2_000, () => socket.destroy(new Error("projection_timeout")));
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of socket) {
      if (!Buffer.isBuffer(chunk)) throw new Error("projection_encoding");
      length += chunk.length;
      if (length > 65_536) throw new Error("projection_size");
      chunks.push(chunk);
    }
    const value = Buffer.concat(chunks);
    try {
      const code = value.toString("utf8");
      if (!/^(?:oc-pair:\/\/)?[A-Za-z0-9_-]+$/i.test(code)) throw new Error("projection_encoding");
      return code;
    } finally {
      value.fill(0);
    }
  } finally {
    socket.destroy();
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function run(input: AgentInput): Promise<number> {
  const abort = new AbortController();
  const [program, ...args] = input.command;
  if (program === undefined) throw new Error("empty_command");
  const env = { ...process.env, NODE_OPTIONS: "--jitless" };
  let projection: string | undefined;
  // The stock protected program, once spawned: the only process whose listener the bridge reaches.
  let enrollmentOwner: ProcessIdentity | undefined;
  let enrollment: ReturnType<typeof enrollmentBridge> | undefined;
  if (input.enrollmentSocket !== undefined) {
    if (input.releaseSocket === undefined) throw new Error("enrollment_without_release");
    enrollment = enrollmentBridge({ host: "127.0.0.1", port: PORT }, async (socket, stopped) => {
      const owner = enrollmentOwner;
      if (owner === undefined || socket.localPort === undefined) return false;
      // The challenge listener: held by the command's own process tree, never by Codex.
      const holder = findListener(owner, (exe) => exe !== input.codexBin);
      if (holder === undefined) return false;
      const clientPort = socket.localPort;
      try {
        await waitFor(() => tcpOwnership(holder.process, PORT, clientPort), stopped, 1_000);
        return sameProcess(owner) && !abort.signal.aborted;
      } catch {
        return false;
      }
    });
    await listen(enrollment.server, input.enrollmentSocket);
    report("inner", "enrollment", "observed");
  }
  try {
    if (input.releaseSocket !== undefined) {
      report("inner", "release", "entered");
      const held = new AbortController();
      const stop = () => held.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        await awaitRelease(input.releaseSocket, held.signal);
      } catch (error) {
        report("inner", "release", "stopped");
        throw error;
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
      report("inner", "release", "observed");
    }
    if (input.projectionSocket !== undefined) {
      report("inner", "projection", "entered");
      try {
        projection = await setupCode(input.projectionSocket);
      } catch (error) {
        report("inner", "projection", safeReason(error));
        throw error;
      }
    }
    if (input.nativeHookProbe !== undefined) {
      report("inner", "native-hook", "entered");
      const outcome = await probeNativeHook(input.nativeHookProbe, input.workspace, env);
      report("inner", "native-hook", outcome);
      if (outcome !== "observed") throw new Error("native_hook_unrunnable");
    }
  } catch (error) {
    // Stopped or refused before the program ran: the bridge closes with it.
    enrollment?.close();
    throw error;
  }
  report("inner", "exec", "entered");
  const child = spawn(program, args, {
    cwd: input.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: projection === undefined ? env : { ...env, OPENCLAW_NODE_SETUP_CODE: projection },
  });
  child.stdout.resume();
  const diagnosticDone = collectDiagnostics(child.stderr, "command");
  const done = new Promise<number>((resolve) => {
    child.once("exit", (code, signal) => {
      report("command", "exit", exitReason(code, signal));
      abort.abort();
      resolve(code ?? 1);
    });
    child.once("error", (error) => {
      report("command", "exec", safeReason(error));
      abort.abort();
      resolve(1);
    });
  });
  const onStop = () => abort.abort();
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);
  let relay: ReturnType<typeof bridge> | undefined;
  let watch: NodeJS.Timeout | undefined;
  let retiredByOperator = false;
  let phase: "owner" | "listener" | "inner-socket" | "auth" = "owner";
  try {
    if (child.pid === undefined) throw new Error("command_start");
    const owned = processIdentity(child.pid);
    enrollmentOwner = owned;
    report("inner", "owner", "observed");
    phase = "listener";
    report("inner", "listener", "entered");
    // A gated run's program first waits for its own enrollment (at most 180 s), then starts Codex.
    const native = await waitFor(
      () => findListener(owned, (exe) => exe === input.codexBin),
      abort.signal,
      enrollment === undefined ? BOOTSTRAP_MS : ENROLLMENT_WAIT_MS,
    );
    report("inner", "listener", "observed");
    if (enrollment !== undefined) {
      // Codex listens: the program was released. Nothing reaches the port from outside now but
      // the native bridge below.
      enrollment.close();
      enrollmentOwner = undefined;
      report("inner", "enrollment", "closed");
    }
    const isOriginal = () =>
      sameProcess(owned) &&
      sameProcess(native.process) &&
      tcpOwnership(native.process, PORT) === native.listener;
    relay = bridge({ host: "127.0.0.1", port: PORT }, async (socket, stopped) => {
      if (socket.localPort === undefined || !isOriginal()) return false;
      const clientPort = socket.localPort;
      // Do not send even the HTTP headers until the accepted TCP socket is
      // demonstrably held by this original native process, not a new listener.
      try {
        await waitFor(
          () => {
            if (!isOriginal()) throw new Error("native_replaced");
            return tcpOwnership(native.process, PORT, clientPort);
          },
          stopped,
          1_000,
        );
        return isOriginal() && !abort.signal.aborted;
      } catch {
        return false;
      }
    });
    const internal = { path: input.socketPath };
    phase = "inner-socket";
    await listen(relay.server, input.socketPath);
    report("inner", "inner-socket", "observed");
    phase = "auth";
    watch = setInterval(() => {
      if (!isOriginal()) abort.abort();
    }, 200);
    if (
      (await upgradeStatus(internal)) !== 401 ||
      (await upgradeStatus(internal, INVALID_CAPABILITY)) !== 401 ||
      !isOriginal() ||
      abort.signal.aborted
    ) {
      throw new Error("native_auth_unconfirmed");
    }
    report("inner", "ready", "observed");
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) resolve();
      else abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    retiredByOperator = child.exitCode === null && child.signalCode === null && isOriginal();
  } catch (error) {
    report("inner", phase, safeReason(error, abort.signal.aborted ? "stopped" : "refused"));
    throw error;
  } finally {
    if (watch !== undefined) clearInterval(watch);
    enrollment?.close();
    relay?.close();
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await done;
      clearTimeout(kill);
    }
    await drainDiagnostics(diagnosticDone);
    child.stderr.destroy();
    child.stdout.destroy();
  }
  const code = await done;
  return retiredByOperator ? 0 : code || 1;
}

/** A process of `owner`'s tree whose executable `accepts` holds the listener on `PORT`. */
function findListener(
  owner: ProcessIdentity,
  accepts: (executable: string) => boolean,
): { process: ProcessIdentity; listener: string } | undefined {
  if (!sameProcess(owner)) throw new Error("command_exited");
  const processes = new Map<number, ProcessIdentity>();
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    try {
      const current = processIdentity(Number(name));
      processes.set(current.pid, current);
    } catch {
      /* The process may disappear between readdir and stat. */
    }
  }
  function descendant(process: ProcessIdentity): boolean {
    let current: ProcessIdentity | undefined = process;
    while (current !== undefined) {
      if (current.pid === owner.pid) return current.startTicks === owner.startTicks;
      if (current.ppid === current.pid || current.ppid < 1) return false;
      current = processes.get(current.ppid);
    }
    return false;
  }
  for (const current of processes.values()) {
    if (!descendant(current)) continue;
    let executable: string;
    try {
      executable = readlinkSync(join("/proc", String(current.pid), "exe"));
    } catch {
      continue;
    }
    if (!accepts(executable)) continue;
    const listener = tcpOwnership(current, PORT);
    if (listener !== undefined) return { process: current, listener };
  }
  return undefined;
}

try {
  report("inner", "input", "entered");
  const path = process.argv[2];
  if (path === undefined || process.argv.length !== 3) throw new Error("usage");
  let input: AgentInput;
  try {
    input = JSON.parse(readFileSync(path, "utf8")) as AgentInput;
  } catch (error) {
    report("inner", "input", safeReason(error));
    throw error;
  }
  process.exitCode = await run(input);
} catch {
  process.exitCode = 1;
}
