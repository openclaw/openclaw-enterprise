import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { isOpenShellLane } from "./openshell-full-integration.ts";

type Stamp = number | null;

function uptimeMs(value: string | undefined): Stamp {
  const match = /^([0-9]{1,9})\.([0-9]{2})$/.exec(value ?? "");
  return match ? Number(match[1]) * 1000 + Number(match[2]) * 10 : null;
}

function elapsed(start: Stamp, end: Stamp): number | null {
  return start === null || end === null ? null : end - start;
}

function measured(start: Stamp, end: Stamp) {
  const elapsedMs = elapsed(start, end);
  return { elapsedMs, outcome: elapsedMs === null ? "missing" : "measured" };
}

function step(start: Stamp, end: Stamp, outcome: string | undefined) {
  switch (outcome) {
    case "success":
    case "failure":
    case "cancelled":
      return { elapsedMs: elapsed(start, end), outcome };
    case "skipped":
      return { elapsedMs: null, outcome };
    default:
      return { elapsedMs: null, outcome: "missing" };
  }
}

function identity(value: string | undefined, pattern: RegExp): string | null {
  return value !== undefined && pattern.test(value) ? value : null;
}

export function phaseTiming(env: NodeJS.ProcessEnv, end: number) {
  let previous = 0;
  function checkpoint(value: string | undefined): Stamp {
    const stamp = uptimeMs(value);
    if (stamp === null || stamp > end || stamp < previous) {
      return null;
    }
    previous = stamp;
    return stamp;
  }

  const entry = checkpoint(env.OPENSHELL_ENTRY);
  const prepareStart = checkpoint(env.OPENSHELL_PREPARE_START);
  const prepareEnd = checkpoint(env.OPENSHELL_PREPARE_END);
  const runStart = checkpoint(env.OPENSHELL_RUN_START);
  const cleanupStart = checkpoint(env.OPENSHELL_CLEANUP_START);
  const cleanupEnd = checkpoint(env.OPENSHELL_CLEANUP_END);
  const phases = {
    setup: measured(entry, prepareStart),
    prepare: step(prepareStart, prepareEnd, env.OPENSHELL_PREPARE_OUTCOME),
    postPrepareSetup: measured(prepareEnd, runStart),
    run: step(runStart, cleanupStart, env.OPENSHELL_RUN_OUTCOME),
    cleanup: step(cleanupStart, cleanupEnd, env.OPENSHELL_CLEANUP_OUTCOME),
    retention: measured(cleanupEnd, end),
  };
  const elapsedMs = elapsed(entry, end);
  const measuredMs = Object.values(phases).reduce((sum, phase) => sum + (phase.elapsedMs ?? 0), 0);
  const selection = env.OPENSHELL_SELECTION;
  const lane = env.OPENSHELL_LANE;
  return {
    runId: identity(env.GITHUB_RUN_ID, /^[0-9]{1,20}$/),
    attempt: identity(env.GITHUB_RUN_ATTEMPT, /^[0-9]{1,10}$/),
    sha: identity(env.GITHUB_SHA, /^[0-9a-f]{40}$/),
    job: identity(env.GITHUB_JOB, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/),
    lane: lane !== undefined && isOpenShellLane(lane) ? lane : null,
    selection: selection === "full" || selection === "focused" ? selection : null,
    elapsedMs,
    residualMs: elapsedMs === null ? null : elapsedMs - measuredMs,
    phases,
  };
}

if (import.meta.main) {
  const uptime = readFileSync("/proc/uptime", "utf8").split(" ", 1)[0];
  const now = uptimeMs(uptime);
  const command = process.argv[2];
  if (now !== null && command === "mark") {
    process.stdout.write(`uptime=${uptime}\n`);
  } else if (now !== null && command === "summarize" && process.env.GITHUB_STEP_SUMMARY) {
    const receipt = JSON.stringify(phaseTiming(process.env, now), null, 2);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "### OpenShell phase timing\n\n```json\n" + receipt + "\n```\n",
    );
    const receiptPath = process.argv[3];
    if (receiptPath) {
      writeFileSync(receiptPath, receipt + "\n", { flag: "wx" });
    }
  } else {
    process.exitCode = 1;
  }
}
