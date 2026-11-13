import { fork, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { stopCleanupCommands } from "./cleanup.ts";
import { installationPhase, type InstallationPhase } from "./openshell-installation-phase.ts";
import { boundedProgressLines, openShellProgress } from "./openshell-progress.mjs";
import { removeLiveK3dCase2Directories } from "./runner-case2-receipt.ts";
import { isObject } from "./runner-inputs.ts";

export type OpenShellProgress =
  | InstallationPhase
  | { kind: "openshell-stage"; stage: string; outcome: "started" | "passed" | "failed" }
  | {
      kind: "openshell-stage-failure";
      stage: string;
      category: string;
      code: string | null;
      location: "tests/helpers/openshell-sandbox-workflows.mjs";
    };

export type NodeResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  processGroupId: number | undefined;
  error?: Error & { code?: string | undefined };
};

type SupervisorResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: unknown;
};

function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && Object.hasOwn(osConstants.signals, value);
}

function supervisorResult(value: unknown): SupervisorResult | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const { code, signal, error } = value;
  if ((typeof code === "number" || code === null) && (isSignal(signal) || signal === null)) {
    return { code, signal, error };
  }
  return undefined;
}

function projectedProgress(value: unknown): OpenShellProgress | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  // The JS projector owns admission. Narrow its closed output at the log boundary.
  const { kind, stage, outcome, category, code, location } = value;
  if (kind === "openshell-installation") {
    return installationPhase(value);
  }
  if (
    kind === "openshell-stage" &&
    typeof stage === "string" &&
    (outcome === "started" || outcome === "passed" || outcome === "failed")
  ) {
    return { kind, stage, outcome };
  }
  if (
    kind === "openshell-stage-failure" &&
    typeof stage === "string" &&
    typeof category === "string" &&
    (typeof code === "string" || code === null) &&
    location === "tests/helpers/openshell-sandbox-workflows.mjs"
  ) {
    return { kind, stage, category, code, location };
  }
  return undefined;
}

const maxReporterBytes = 50 * 1024 * 1024;

// After the timeout's SIGTERM, the Node test runner reports the interrupted tests
// and the file's output tail before it exits; read them for this long.
const timeoutGraceMs = 5_000;

// Process groups of the Node test runners still running, so a signal that ends this
// runner can end them too: they run detached, out of the terminal's process group.
const liveGroups = new Set<number>();

function killGroup(pgid: number | undefined, signal: NodeJS.Signals) {
  // Membership is the real guard: only a group this runner spawned and whose
  // leader has not exited yet. Never 0 or 1, which process.kill would turn into
  // this runner's own group or every process.
  if (pgid === undefined || !liveGroups.has(pgid) || !Number.isSafeInteger(pgid) || pgid <= 1) {
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: every process in the group has already exited.
  }
}

export const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// GitHub cancels a step by signalling only its shell, which waits for this runner, and then
// kills that shell. The signals never reach this runner: it carries on as an orphan beside the
// job's always() Cleanup lane step, and the two cleanups can race. So a runner whose starting
// parent is gone is being cancelled, and a cleanup that fails then is reported as cancelled.
const startingParentPid = process.ppid;

export function jobCancelling(): boolean {
  return process.ppid !== startingParentPid;
}

function forwardSignal(signal: (typeof forwardedSignals)[number]) {
  // This runner ends at once, so nothing would follow up on a file that ignores
  // the signal, and nothing reads the runners' reports any more.
  for (const pgid of liveGroups) {
    killGroup(pgid, "SIGKILL");
  }
  removeLiveK3dCase2Directories();
  for (const other of forwardedSignals) {
    process.removeListener(other, forwardSignal);
  }
  // Listening replaced the default action; end the runner as that signal would have.
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
}

let forwarding = false;

function addLiveGroup(pgid: number) {
  if (!forwarding) {
    forwarding = true;
    for (const signal of forwardedSignals) {
      process.on(signal, forwardSignal);
    }
  }
  liveGroups.add(pgid);
  if (process.env.OPENCLAW_CI_COMPLETE_PHASE === "1" && process.send) {
    process.send({ type: "ci-lifecycle-group", id: pgid });
  }
}

// spawnSync's contract, without blocking the runner while other files run: stdout
// is kept up to maxReporterBytes (ENOBUFS past it), stdin is closed at once, and the
// timeout sends SIGTERM and reports ETIMEDOUT. Like spawnSync, stopping also closes
// the pipes (after timeoutGraceMs for a timeout), so a grandchild holding them
// cannot keep the file running. Child stderr is not retained.
//
// The Node test runner leads its own process group. The timeout's SIGTERM reaches
// only the runner, which reports the interrupted tests and exits, but can leave the
// isolated test-file child (and anything it started) running. So the whole group
// gets SIGKILL once the grace period is over, and whenever the runner exits:
// anything still in its group then has outlived its file. ENOBUFS discards the
// rest of the output, so it kills the group at once.
export function runNode(
  args: string[],
  {
    cwd,
    env,
    timeout,
    onProgress,
  }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    onProgress: (progress: OpenShellProgress) => void;
  },
): Promise<NodeResult> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let error: NodeResult["error"];
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    // The existing command owner keeps the test group alive until its result
    // drains and stops that group if the complete-mode phase loses its parent.
    const supervised = process.env.OPENCLAW_CI_COMPLETE_PHASE === "1";
    let commandResult: SupervisorResult | undefined;
    const child = supervised
      ? fork(new URL("./cleanup-command.ts", import.meta.url), [], {
          cwd,
          env,
          detached: true,
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
      : spawn(process.execPath, args, {
          cwd,
          env,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
    const pgid = child.pid;
    if (pgid !== undefined) {
      addLiveGroup(pgid);
    }
    const closePipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const stop = (code: "ETIMEDOUT" | "ENOBUFS" | "EPIPE") => {
      if (error === undefined) {
        error = Object.assign(new Error(`child ${code}`), { code });
        if (code === "ETIMEDOUT") {
          if (supervised) {
            // The anchor ignores TERM; the Node runner and its children receive it.
            killGroup(pgid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
          graceTimer = setTimeout(() => {
            killGroup(pgid, "SIGKILL");
            closePipes();
          }, timeoutGraceMs);
        } else {
          killGroup(pgid, "SIGKILL");
          closePipes();
        }
      } else if (code === "ENOBUFS") {
        closePipes();
      }
    };
    const timer = setTimeout(() => stop("ETIMEDOUT"), timeout);
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", () => {});
    }
    child.stdin?.end();
    child.stderr?.resume();
    const readProgress = boundedProgressLines((line: string) => {
      // Only this small closed record reaches the live log. Ordinary reporter
      // output still waits for final accounting and failure redaction below.
      try {
        const event: unknown = JSON.parse(line);
        if (isObject(event) && event.type === "test:progress") {
          const projected: unknown = openShellProgress(event.data);
          const progress = projectedProgress(projected);
          if (progress) {
            onProgress(progress);
          }
        }
      } catch {
        // Final parsing owns malformed reporter output and its failure result.
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (error?.code === "ENOBUFS") {
        return;
      }
      if (bytes + chunk.length > maxReporterBytes) {
        const admitted = chunk.subarray(0, maxReporterBytes - bytes);
        chunks.push(admitted);
        bytes = maxReporterBytes;
        readProgress(admitted.toString("utf8"));
        stop("ENOBUFS");
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
      readProgress(chunk.toString("utf8"));
    });
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (supervised) {
        if (commandResult) {
          ({ code: status, signal } = commandResult);
          if (commandResult.error) {
            error ??= new Error("Node command could not start.");
          }
        } else {
          error ??= new Error("Node command owner exited without a result.");
        }
      }
      resolvePromise({
        status,
        signal,
        stdout: Buffer.concat(chunks).toString("utf8"),
        processGroupId: pgid,
        ...(error ? { error } : {}),
      });
    };
    child.on("exit", () => {
      // The anchor stops its own group before exiting. Ordinary runners retain
      // their existing exit cleanup; never signal a departed anchor's numeric ID.
      if (!supervised) {
        killGroup(pgid, "SIGKILL");
      }
      if (pgid !== undefined) {
        liveGroups.delete(pgid);
      }
    });
    child.on("error", (spawnError) => {
      if (supervised && child.pid !== undefined) {
        stop("EPIPE");
        return;
      }
      error ??= spawnError;
      if (pgid !== undefined) {
        liveGroups.delete(pgid);
      }
      finish(null, null);
    });
    child.on("close", finish);
    if (supervised) {
      child.on("message", (result: unknown) => {
        commandResult = supervisorResult(result);
      });
      child.send({ command: process.execPath, args }, (sendError) => {
        if (sendError) {
          stop("EPIPE");
        }
      });
    }
  });
}

// Synchronous so an abandoned step cannot start a command between listing and killing.
function processParents() {
  const parents = new Map<number, number>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    const listed = spawnSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
      encoding: "utf8",
      timeout: 5_000,
    });
    for (const line of listed.stdout?.split("\n") ?? []) {
      const [pid = Number.NaN, ppid = Number.NaN] = line.trim().split(/\s+/).map(Number);
      // ps itself is this process's child, gone by now.
      if (pid > 0 && pid !== listed.pid) {
        parents.set(pid, ppid);
      }
    }
    return parents;
  }
  for (const entry of entries.filter((name) => /^\d+$/.test(name))) {
    try {
      // "pid (comm) state ppid ...": comm can hold spaces and parentheses.
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // The process has exited.
    }
  }
  return parents;
}

// Every process this runner started that is still running, with their descendants. Each is
// stopped (SIGSTOP) before any is killed: a stopped process starts no child, and it keeps its
// children in this tree, where a killed parent's children would move to another parent. A
// child started before its parent's stop is found by the next listing, so the listing repeats
// until it finds no process it has not stopped (finding 2182); then all of them are killed. A
// process that starts a child and exits on its own before its stop still loses that child.
export function killDescendants(): void {
  // Stop owned cleanup groups before the snapshot can kill their supervisors
  // alone. A command's already-orphaned descendants are absent from this tree.
  stopCleanupCommands();
  const stopped = new Set<number>();
  // Each pass that finds a new process is another generation started after the last listing;
  // the bound only keeps a process that forks without end from holding the runner.
  for (let pass = 0; pass < 100; pass += 1) {
    const children = new Map<number, number[]>();
    for (const [pid, ppid] of processParents()) {
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    const found: number[] = [];
    const queue = [process.pid];
    for (const parent of queue) {
      const next = children.get(parent) ?? [];
      found.push(...next.filter((pid) => !stopped.has(pid)));
      queue.push(...next);
    }
    if (found.length === 0) {
      break;
    }
    for (const pid of found) {
      // Recorded even when the stop fails, so a process that refuses it cannot keep the listing
      // going.
      stopped.add(pid);
      try {
        process.kill(pid, "SIGSTOP");
      } catch {
        // It has exited.
      }
    }
  }
  for (const pid of stopped) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has exited.
    }
  }
}
