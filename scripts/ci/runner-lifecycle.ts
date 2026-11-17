import { fork } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditManifest,
  fileConcurrency,
  isObject,
  issue,
  logIssues,
  selectLane,
  sourceEvidence,
  type loadRunnerManifest,
} from "./runner-inputs.ts";
import { cleanupAllowanceMs, laneDeadlineMs } from "./runner-preparation.ts";
import { forwardedSignals } from "./runner-process.ts";

type Phase = "prepare" | "run" | "cleanup";
type PhaseStatus = "not-run" | "passed" | "failed" | "timed-out";

export type PhaseRequest = {
  phase: Phase;
  root: string;
  lane: string;
  statePath: string;
  resultsPath: string;
  manifestPath: string;
  file?: string | undefined;
  testName?: string | undefined;
};

type PhaseResult = {
  exitCode: number;
  uncertain: boolean;
  error?: unknown;
};

type PhaseOutcome = {
  status: PhaseStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminal: boolean;
  reason?: "deadline-exhausted" | "spawn-failed";
  error?: unknown;
  startedAt?: string;
  endedAt?: string;
};

type RunSummary = Record<string, unknown> & { issues: unknown[] };

function lifecycleGroupsTerminal(groups: ReadonlySet<number>) {
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/u.test(name)) {
        continue;
      }
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        ) {
          continue;
        }
        return false;
      }
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      if (fields.length < 20) {
        return false;
      }
      if (groups.has(Number(fields[2])) && fields[0] !== "Z" && fields[0] !== "X") {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function lifecyclePhase(
  request: PhaseRequest,
  timeoutMs: number,
  entryURL: URL,
): Promise<PhaseOutcome> {
  const startedAt = new Date().toISOString();
  const empty: PhaseOutcome = {
    status: "not-run",
    exitCode: null,
    signal: null,
    terminal: true,
    startedAt,
  };
  if (timeoutMs <= 0) {
    return { ...empty, reason: "deadline-exhausted", endedAt: new Date().toISOString() };
  }
  const groups = new Set<number>();
  const received: { result?: PhaseResult } = {};
  let invalid = false;
  let timedOut = false;
  let child: ReturnType<typeof fork>;
  try {
    child = fork(fileURLToPath(entryURL), ["__lifecycle-phase"], {
      cwd: request.root,
      env: { ...process.env, OPENCLAW_CI_COMPLETE_PHASE: "1" },
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch {
    return {
      ...empty,
      status: "failed",
      exitCode: 1,
      reason: "spawn-failed",
      endedAt: new Date().toISOString(),
    };
  }
  const pid = child.pid;
  if (pid !== undefined) {
    groups.add(pid);
  }
  let timer: NodeJS.Timeout | undefined;
  let abandonTimer: NodeJS.Timeout | undefined;
  const signal = await new Promise<NodeJS.Signals | null>((settle) => {
    const stop = () => {
      if (pid !== undefined && pid > 1 && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            invalid = true;
          }
        }
      }
      // Even SIGKILL can wait on uninterruptible kernel work. A missing exit is
      // unconfirmed termination, never permission to race resource cleanup.
      abandonTimer ??= setTimeout(() => {
        invalid = true;
        if (child.connected) {
          child.disconnect();
        }
        child.unref();
        settle(null);
      }, 5_000);
    };
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.on("message", (message: unknown) => {
      if (
        !received.result &&
        isObject(message) &&
        message.type === "ci-lifecycle-group" &&
        typeof message.id === "number" &&
        Number.isInteger(message.id) &&
        message.id > 1
      ) {
        groups.add(message.id);
      } else if (
        !received.result &&
        isObject(message) &&
        message.type === "ci-lifecycle-result" &&
        typeof message.exitCode === "number" &&
        Number.isInteger(message.exitCode) &&
        message.exitCode >= 0 &&
        typeof message.uncertain === "boolean"
      ) {
        received.result = {
          exitCode: message.exitCode,
          uncertain: message.uncertain,
          error: message.error,
        };
        child.send({ type: "ci-lifecycle-ack" }, (error) => {
          if (error) {
            invalid = true;
            stop();
          }
        });
      } else {
        invalid = true;
        stop();
      }
    });
    child.on("error", () => {
      invalid = true;
      if (pid) {
        stop();
      } else {
        settle(null);
      }
    });
    child.once("exit", (_code, signal) => settle(signal));
    child.send(request, (error) => {
      if (error) {
        invalid = true;
        stop();
      }
    });
  });
  clearTimeout(timer);
  clearTimeout(abandonTimer);
  // Never signal reported nested IDs: their leaders may already have exited.
  // Read-only checks also include descendants which outlived their parent.
  const drainDeadline = Date.now() + 5_000;
  let groupsTerminal = lifecycleGroupsTerminal(groups);
  while (!groupsTerminal && Date.now() < drainDeadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    groupsTerminal = lifecycleGroupsTerminal(groups);
  }
  const result = received.result;
  const terminal =
    result !== undefined && !invalid && !timedOut && !result.uncertain && groupsTerminal;
  let status: PhaseStatus = terminal && result.exitCode === 0 ? "passed" : "failed";
  if (timedOut) {
    status = "timed-out";
  }
  return {
    status,
    exitCode: result?.exitCode ?? null,
    signal: result ? null : signal,
    terminal,
    ...(result?.error ? { error: result.error } : {}),
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

function isRunEvidence(
  value: unknown,
  lane: string,
  sourceSha: string | null,
  testName: string | undefined,
): value is RunSummary {
  return (
    isObject(value) &&
    value.command === "run" &&
    value.lane === lane &&
    value.sourceSha === sourceSha &&
    value.testName === testName &&
    Array.isArray(value.issues)
  );
}

export async function runCompleteLifecycle(
  entryURL: URL,
  root: string,
  manifest: ReturnType<typeof loadRunnerManifest>,
  manifestPath: string,
  lane: string,
  attempt: string,
  file: string | undefined,
  testName: string | undefined,
): Promise<number> {
  if (process.platform !== "linux") {
    throw new Error("Complete lifecycle mode requires Linux process-group verification.");
  }
  const source = sourceEvidence(root);
  const selection = selectLane(manifest, lane, file, testName);
  const audit = await auditManifest(root, manifest);
  if (selection.lane) {
    fileConcurrency(selection.lane, selection.issues);
  }
  if (selection.issues.length || audit.issues.length || source.issues.length) {
    logIssues([...selection.issues, ...audit.issues, ...source.issues]);
    return 1;
  }
  // One atomic directory claim owns every path used by this invocation. Its
  // existing parent must not permit another user to replace the claimed directory.
  let parent: string;
  try {
    parent = realpathSync(dirname(attempt));
    const owner = statSync(parent);
    if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o022) !== 0) {
      throw new Error("Uncontrolled parent");
    }
  } catch {
    throw new Error(
      "Complete lifecycle requires an existing runner-owned parent without group or other write access.",
    );
  }
  attempt = join(parent, basename(attempt));
  try {
    await mkdir(attempt, { mode: 0o700 });
  } catch {
    throw new Error("Complete lifecycle requires a fresh attempt directory.");
  }
  const identity = await lstat(attempt);
  if (
    !identity.isDirectory() ||
    identity.uid !== process.getuid?.() ||
    (identity.mode & 0o777) !== 0o700
  ) {
    throw new Error("Attempt directory ownership is invalid; reconciliation is required.");
  }
  const assertAttemptOwned = async () => {
    try {
      const current = await lstat(attempt);
      if (current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) {
        return;
      }
    } catch {
      // A missing or replaced owner directory is not authority over another path.
    }
    throw new Error("Attempt directory changed; reconciliation is required.");
  };
  const statePath = join(attempt, "state.json");
  const resultsPath = join(attempt, "result.json");
  const startedAt = new Date().toISOString();
  const deadline = laneDeadlineMs() ?? Date.now() + 30 * 60_000;
  const phases: Record<Phase, PhaseOutcome> = {
    prepare: { status: "not-run", exitCode: null, signal: null, terminal: false },
    run: { status: "not-run", exitCode: null, signal: null, terminal: false },
    cleanup: { status: "not-run", exitCode: null, signal: null, terminal: false },
  };
  let interrupted: (typeof forwardedSignals)[number] | null = null;
  let activeDeadline = deadline;
  let finalizing = false;
  const interrupt = (signal: (typeof forwardedSignals)[number]) => {
    if (!finalizing && interrupted === null) {
      interrupted = signal;
      process.stderr.write(
        `run-tests: ${signal} received; cancellation pending, waiting up to ${Math.max(0, Math.ceil((activeDeadline - Date.now()) / 1000))}s for the current phase before owned cleanup.\n`,
      );
    }
  };
  for (const signal of forwardedSignals) {
    process.on(signal, interrupt);
  }
  const phaseRequest = {
    root,
    lane,
    statePath,
    resultsPath: join(attempt, "run.json"),
    manifestPath,
    file,
    testName,
  };
  try {
    if (!interrupted) {
      await assertAttemptOwned();
      if (!interrupted) {
        phases.prepare = await lifecyclePhase(
          { ...phaseRequest, phase: "prepare" },
          deadline - Date.now(),
          entryURL,
        );
      }
    }
    if (!interrupted && phases.prepare.status === "passed") {
      await assertAttemptOwned();
      if (!interrupted) {
        phases.run = await lifecyclePhase(
          { ...phaseRequest, phase: "run" },
          deadline - Date.now(),
          entryURL,
        );
      }
    }
    const previous = phases.run.status === "not-run" ? phases.prepare : phases.run;
    if (previous.terminal) {
      await assertAttemptOwned();
      activeDeadline = Date.now() + cleanupAllowanceMs();
      phases.cleanup = await lifecyclePhase(
        { ...phaseRequest, phase: "cleanup" },
        cleanupAllowanceMs(),
        entryURL,
      );
    }
    let summary: RunSummary = {
      version: 1,
      command: "run",
      sourceSha: source.sha,
      lane,
      scope: file === undefined ? "full" : "focused",
      ...(testName === undefined ? {} : { testName }),
      startedAt,
      counts: { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 },
      files: [],
      issues: [],
    };
    if (phases.run.terminal) {
      try {
        const candidate: unknown = JSON.parse(await readFile(phaseRequest.resultsPath, "utf8"));
        if (!isRunEvidence(candidate, lane, source.sha, testName)) {
          throw new Error("Invalid run evidence");
        }
        summary = candidate;
      } catch {
        phases.run.status = "failed";
        phases.run.exitCode = 1;
      }
    }
    finalizing = true;
    const uncertain = Object.values(phases).some(
      (phase) => phase.status !== "not-run" && !phase.terminal,
    );
    const passed =
      !interrupted &&
      Object.values(phases).every((phase) => phase.status === "passed") &&
      summary.status === "passed";
    let exitCode = passed ? 0 : 1;
    if (interrupted) {
      exitCode = 128 + osConstants.signals[interrupted];
    }
    let status = passed ? "passed" : "failed";
    if (uncertain) {
      status = "reconciliation-required";
    }
    const lifecycle = {
      status,
      interrupted,
      phases,
    };
    if (!passed) {
      summary.issues.push(
        issue(
          "lifecycle-incomplete",
          uncertain
            ? "Phase termination is unconfirmed; retain state for reconciliation."
            : "Complete lifecycle did not pass.",
        ),
      );
    }
    await assertAttemptOwned();
    await writeFile(
      resultsPath,
      `${JSON.stringify({ ...summary, status: passed ? "passed" : "failed", exitCode, endedAt: new Date().toISOString(), lifecycle }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return exitCode;
  } finally {
    for (const signal of forwardedSignals) {
      process.removeListener(signal, interrupt);
    }
  }
}
