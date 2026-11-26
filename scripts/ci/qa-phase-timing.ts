import { appendFileSync } from "node:fs";

type Stamp = bigint | null;
type StepOutcome = "success" | "failure" | "skipped" | "cancelled" | "missing";
type Phase<Outcome> = { elapsedMs: number | null; outcome: Outcome };

function elapsed(start: Stamp, stop: Stamp): number | null {
  return start === null || stop === null ? null : Number((stop - start) / 1_000_000n);
}

function measuredPhase(start: Stamp, stop: Stamp): Phase<"measured" | "missing"> {
  const elapsedMs = elapsed(start, stop);
  return { elapsedMs, outcome: elapsedMs === null ? "missing" : "measured" };
}

function stepPhase(start: Stamp, stop: Stamp, outcome: string | undefined): Phase<StepOutcome> {
  switch (outcome) {
    case "success":
    case "failure":
    case "cancelled":
      return { elapsedMs: elapsed(start, stop), outcome };
    case "skipped":
      return { elapsedMs: null, outcome };
    default:
      return { elapsedMs: null, outcome: "missing" };
  }
}

function identity(value: string | undefined, pattern: RegExp): string | null {
  return value !== undefined && pattern.test(value) ? value : null;
}

function summarize(env: NodeJS.ProcessEnv, end: bigint): void {
  let previous: Stamp = null;
  function checkpoint(value: string | undefined): Stamp {
    if (value === undefined || !/^[0-9]{1,20}$/.test(value)) {
      return null;
    }
    const stamp = BigInt(value);
    if (stamp > end || (previous !== null && stamp < previous)) {
      return null;
    }
    previous = stamp;
    return stamp;
  }

  const entry = checkpoint(env.QA_ENTRY_NS);
  const run = checkpoint(env.QA_RUN_NS);
  const cleanup = checkpoint(env.QA_CLEANUP_NS);
  const cleanupEnd = checkpoint(env.QA_CLEANUP_END_NS);
  const phases = {
    setup: measuredPhase(entry, run),
    run: stepPhase(run, cleanup, env.QA_RUN_OUTCOME),
    cleanup: stepPhase(cleanup, cleanupEnd, env.QA_CLEANUP_OUTCOME),
    retention: measuredPhase(cleanupEnd, end),
  };
  const elapsedMs = elapsed(entry, end);
  const measuredMs = Object.values(phases).reduce((sum, phase) => sum + (phase.elapsedMs ?? 0), 0);
  const selection = env.QA_SELECTION;
  const receipt = {
    runId: identity(env.GITHUB_RUN_ID, /^[0-9]+$/),
    attempt: identity(env.GITHUB_RUN_ATTEMPT, /^[0-9]+$/),
    sha: identity(env.GITHUB_SHA, /^[0-9a-f]{40}$/),
    job: identity(env.GITHUB_JOB, /^[A-Za-z_][A-Za-z0-9_-]*$/),
    lane: "qa-matrix" as const,
    selection: selection === "full" || selection === "focused" ? selection : null,
    elapsedMs,
    residualMs: elapsedMs === null ? null : elapsedMs - measuredMs,
    phases,
  };

  const summary = env.GITHUB_STEP_SUMMARY;
  if (!summary) {
    process.exitCode = 1;
    return;
  }
  appendFileSync(
    summary,
    "### QA phase timing\n\n```json\n" + JSON.stringify(receipt, null, 2) + "\n```\n",
  );
}

const command = process.argv[2];
const now = process.hrtime.bigint();
if (command === "summarize") {
  summarize(process.env, now);
} else if (command === "entry" || command === "mark") {
  const key = command === "entry" ? "qa-start-ns" : "ns";
  process.stdout.write(`${key}=${now}\n`);
} else {
  process.exitCode = 1;
}
