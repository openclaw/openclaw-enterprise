import { readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { failureInputLimit, failureSecrets, redactFailureDetail } from "./failure-redaction.ts";
import { exists, isObject, issue, type selectLane } from "./runner-inputs.ts";

type RunnerLane = NonNullable<ReturnType<typeof selectLane>["lane"]>;

export type PrepareFile = (input: {
  lane: Pick<RunnerLane, "name" | "env" | "requiredEnv">;
  file: RunnerLane["files"][number];
  statePath: string;
  modelSelectors: {
    OCC_TEST_OPENSHELL_HARNESS: string | undefined;
    OCC_TEST_OPENSHELL_MODEL_BASE_URL: string | undefined;
  };
}) => unknown;

function testTimeoutMs() {
  const value = Number.parseInt(process.env.CI_RUNNER_TEST_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 60 * 60 * 1000;
}

// The run-ci-lane action sets this epoch-millisecond deadline before the job times out
// so a hung file can be stopped and recorded (finding 1209).
export function laneDeadlineMs() {
  const value = Number(process.env.CI_RUNNER_DEADLINE_MS ?? "");
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// A test process started too close to the deadline might stop before it runs (finding 1215).
export function laneDeadlinePassed() {
  const deadline = laneDeadlineMs();
  return deadline !== undefined && deadline - Date.now() < minStepMs;
}

export function laneDeadlineIssue(relativePath: string) {
  return issue(
    "lane-deadline",
    `the lane deadline passed, or was under ${minStepMs} ms away, before this file started: ${relativePath}`,
    {
      file: relativePath,
    },
  );
}

// Cleanup has an allowance after the lane deadline. If an in-process step hangs, the runner
// records the timeout and exits after writing results. The lane cleanup step handles resources
// still recorded in the lane state (finding 1210).
export function cleanupAllowanceMs() {
  const value = Number.parseInt(process.env.CI_RUNNER_CLEANUP_TIMEOUT_MS ?? "", 10);
  // A cleanup's limit includes its wait for the CI state lock, which test processes also take
  // to create their databases.
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

export function prepareLimitMs() {
  const deadline = laneDeadlineMs();
  return deadline === undefined ? undefined : deadline - Date.now();
}

// Cleanups run one at a time. All of them end by one window past the lane deadline (60 s, or
// the allowance if shorter), so the cleanups of files the deadline stopped together cannot queue
// one allowance each past the job timeout.
export function cleanupLimitMs() {
  const allowance = cleanupAllowanceMs();
  const deadline = laneDeadlineMs();
  return deadline === undefined
    ? allowance
    : Math.min(allowance, deadline + Math.min(allowance, 60_000) - Date.now());
}

// Timers can fire a few milliseconds before Date.now() reaches their end, so a remaining
// limit this short counts as none.
const minStepMs = 1_000;

export let abandonedSteps = 0;

export class StepTimeoutError extends Error {
  readonly limitMs: number;
  readonly started: boolean;

  constructor(limitMs: number, started: boolean) {
    super(started ? `step exceeded ${limitMs} ms` : "no time was left to start the step");
    this.name = "StepTimeoutError";
    this.limitMs = limitMs;
    this.started = started;
  }
}

// An unlimited step starts immediately. A bounded step needs enough time to start.
export function withinLimit<T>(step: () => T, limitMs: number | undefined): T | Promise<T> {
  if (limitMs === undefined) {
    return step();
  }
  if (limitMs < minStepMs) {
    return Promise.reject(new StepTimeoutError(0, false));
  }
  return new Promise<T>((resolvePromise, reject: (reason: unknown) => void) => {
    const timer = setTimeout(() => {
      abandonedSteps += 1;
      reject(new StepTimeoutError(limitMs, true));
    }, limitMs);
    Promise.resolve()
      .then(step)
      .then(
        (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

// The file's timeout: the per-file limit, cut to what is left before the lane deadline, but
// never under minStepMs. A file starts only with at least that much left (laneDeadlinePassed),
// so the floor only absorbs the moments between that check and the start. A file started with a
// second or two left can still be stopped during Node's startup; its timeout then says no test
// was running.
export function fileTimeout() {
  const limitMs = testTimeoutMs();
  const deadline = laneDeadlineMs();
  if (deadline === undefined || deadline - Date.now() >= limitMs) {
    return { timeoutMs: limitMs, laneDeadline: false };
  }
  const timeoutMs = Math.min(limitMs, Math.max(minStepMs, deadline - Date.now()));
  return { timeoutMs, laneDeadline: timeoutMs < limitMs };
}

function isPrepareFile(value: unknown): value is PrepareFile {
  return typeof value === "function";
}

export async function loadPrepare(root: string): Promise<PrepareFile | null> {
  const preparePath = resolve(root, "scripts/ci/prepare.mjs");
  if (!(await exists(preparePath))) {
    return null;
  }
  const module: unknown = await import(pathToFileURL(preparePath).href);
  if (!isObject(module) || !isPrepareFile(module.prepareFile)) {
    throw new Error("scripts/ci/prepare.mjs must export prepareFile");
  }
  return module.prepareFile;
}

// Preparation errors may contain command arguments, credentials and child output.
// Only this closed diagnostic contract goes to the results and the job log; the
// diagnostics report also gets the redacted message (preparationFailureText).
const preparationStages = ["database-create", "database-schema", "database-migrate"] as const;
const preparationFailures = ["spawn", "exit", "signal", "timeout", "connect", "query"] as const;

type PreparationError = {
  name: "Error";
  code?: "CI_PREPARATION_COMMAND_FAILED";
  stage?: (typeof preparationStages)[number];
  failure?: (typeof preparationFailures)[number];
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
};

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((entry) => entry === value);
}

export function sanitizePreparationError(error: unknown): PreparationError {
  const result: PreparationError = { name: "Error" };
  const source = error ?? {};
  const target: object = Object(source);
  const code: unknown = Reflect.get(target, "code", source);
  const stage: unknown = Reflect.get(target, "stage", source);
  const failure: unknown = Reflect.get(target, "failure", source);
  const exitCode: unknown = Reflect.get(target, "exitCode", source);
  const signal: unknown = Reflect.get(target, "signal", source);
  const timedOut: unknown = Reflect.get(target, "timedOut", source);
  if (
    code !== "CI_PREPARATION_COMMAND_FAILED" ||
    !includes(preparationStages, stage) ||
    !includes(preparationFailures, failure)
  ) {
    return result;
  }
  result.code = code;
  result.stage = stage;
  result.failure = failure;
  if (
    exitCode === null ||
    (typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255)
  ) {
    result.exitCode = exitCode;
  }
  if (
    signal === null ||
    (typeof signal === "string" && Object.hasOwn(osConstants.signals, signal))
  ) {
    result.signal = signal;
  }
  if (typeof timedOut === "boolean") {
    result.timedOut = timedOut;
  }
  return result;
}

// The diagnostics report's copy of a preparation error: its message and stack
// frames with the failure-detail redaction (the results keep only the closed
// contract above). A failed command's message quotes its stderr (or stdout); the
// output attached to the error is not read. The lane state's env (image
// references, database URLs) joins the job env as values to redact.
export async function preparationFailureText(
  error: unknown,
  lane: Pick<RunnerLane, "env">,
  statePath: string,
  root: string,
): Promise<{ message?: string | undefined; stack?: string | undefined }> {
  if (!(error instanceof Error)) {
    return {};
  }
  const message = typeof error.message === "string" ? error.message : "";
  const stack = typeof error.stack === "string" ? error.stack : "";
  // The stack starts with the message; keep only its frames.
  const frames = stack
    .slice(stack.includes(message) ? stack.indexOf(message) + message.length : 0)
    .split("\n")
    .filter((line) => /^\s+at\s/u.test(line))
    .map((line) => line.trim())
    .join("\n");
  let state: unknown;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    // No lane state, or not JSON.
  }
  const boxed: object | undefined = state == null ? undefined : Object(state);
  const stateField = (key: "defaults" | "env"): unknown =>
    boxed === undefined ? undefined : Reflect.get(boxed, key, state);
  return (
    redactFailureDetail(
      { message: message.slice(0, failureInputLimit), stack: frames.slice(0, failureInputLimit) },
      failureSecrets([
        process.env,
        lane.env,
        isObject(stateField("defaults")) ? stateField("defaults") : {},
        isObject(stateField("env")) ? stateField("env") : {},
      ]),
      root,
    ) ?? {}
  );
}

function assertPreparedEnv(
  value: Record<string, unknown>,
): asserts value is Record<string, string> {
  for (const [name, envValue] of Object.entries(value)) {
    if (
      name === "__proto__" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      typeof envValue !== "string"
    ) {
      throw new Error("prepareFile env must contain string env values");
    }
  }
}

export function validatePreparedEnv(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    throw new Error("prepareFile env must be an object");
  }
  assertPreparedEnv(value);
  return value;
}
