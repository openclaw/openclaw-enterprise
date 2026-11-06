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
  bridge,
  INVALID_CAPABILITY,
  listen,
  PORT,
  processIdentity,
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
  if (input.projectionSocket !== undefined) {
    report("inner", "projection", "entered");
    try {
      projection = await setupCode(input.projectionSocket);
    } catch (error) {
      report("inner", "projection", safeReason(error));
      throw error;
    }
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
    report("inner", "owner", "observed");
    phase = "listener";
    report("inner", "listener", "entered");
    const native = await waitFor(() => findNative(owned, input.codexBin), abort.signal);
    report("inner", "listener", "observed");
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

function findNative(
  owner: ProcessIdentity,
  codexBin: string,
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
    if (executable !== codexBin) continue;
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
