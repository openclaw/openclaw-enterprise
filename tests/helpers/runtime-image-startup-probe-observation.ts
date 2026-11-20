import assert from "node:assert/strict";
import { imageSmokeTimeoutMultiplier } from "./image-smoke-timeout.ts";
import { failureTail } from "./runtime-image-docker.ts";
import { jsonLogEntries } from "./runtime-image-gateway-observations.ts";
import type { ProbeEvent, ProbePhase } from "./runtime-model-probe-diagnostic.ts";
import { modelProbeDiagnostic } from "./runtime-model-probe-observation.ts";

export type StartupProbeEvent = ProbeEvent & Record<string, unknown> & { ms: number };
export type StartupProbePhase = ProbePhase & Record<string, unknown>;
export type StartupProbeSnapshot = Omit<
  Parameters<typeof modelProbeDiagnostic>[0],
  "events" | "phases"
> & {
  events: StartupProbeEvent[];
  phases: StartupProbePhase[];
};

type StartupProbeRun = {
  snapshot: StartupProbeSnapshot;
  first: (
    events: StartupProbeEvent[],
    predicate: (event: StartupProbeEvent) => boolean,
  ) => StartupProbeEvent | undefined;
};

// Docker reports RFC 3339; Podman reports "YYYY-MM-DD hh:mm:ss.nnnnnnnnn +0000 UTC".
export function containerStartedAt(value: string) {
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(trimmed);
  assert.ok(match, `unrecognized container start time ${trimmed}`);
  assert.match(trimmed, /Z$|\+0000 UTC$/, "container start time must be UTC");
  return Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? "0").padEnd(3, "0").slice(0, 3)}Z`);
}

const probeEvents = new Set(["openclaw.model_probe", "codex.model_probe"]);
const providerEvents = new Set([
  "connection",
  "secure",
  "tls-error",
  "request",
  "prewarm",
  "turn-answered",
  "turn-closed",
]);

export function startupProbeObservationEvidence(snapshot: StartupProbeSnapshot) {
  const entries = jsonLogEntries(snapshot.output);
  const failures = snapshot.events.filter(
    (event) => event.event === "observe" && event.key === "runtimeFailure",
  );
  const failure = failures.at(-1);
  return {
    probe: entries
      .filter(({ event }) => typeof event === "string" && probeEvents.has(event))
      .map(
        ({
          event,
          attempt,
          code,
          elapsedMs,
          capMs,
          cpuWaitMs,
          pressureWaitMs,
          throttledWaitMs,
          cause,
        }) => ({
          event,
          attempt,
          code,
          elapsedMs,
          capMs,
          cpuWaitMs,
          pressureWaitMs,
          throttledWaitMs,
          cause,
        }),
      ),
    stages: Object.fromEntries(
      entries
        .filter(({ event }) => event === "openclaw.model_probe_stage")
        .map(({ stage, elapsedMs }) => [String(stage), elapsedMs]),
    ),
    provider: snapshot.events
      .filter(({ event }) => typeof event === "string" && providerEvents.has(event))
      .map(({ event, ms, turn, transport, path, code }) =>
        [`${event}@${ms}`, turn ? "turn" : undefined, transport, path, code]
          .filter((value) => typeof value === "string")
          .join(" "),
      ),
    runtimeFailure: failure && { value: failure.value, ms: failure.ms },
    phases: snapshot.phases.map(({ phase, outcome, sinceStartMs }) =>
      [phase, outcome, sinceStartMs].filter((value) => value !== undefined).join(" "),
    ),
  };
}

// Evidence leads the failure; CI also retains the allowlisted structured diagnostic.
export function createStartupProbeFailure(AssertionError: typeof assert.AssertionError) {
  return function startupProbeFailure(
    headline: string,
    reason: string,
    evidence: object,
    snapshot: StartupProbeSnapshot,
  ) {
    const error: assert.AssertionError & {
      openclawCiDiagnostic?: ReturnType<typeof modelProbeDiagnostic>;
    } = new AssertionError({
      message:
        `${headline}\nevidence: ${JSON.stringify(evidence)}\n${failureTail(snapshot.output)}\n` +
        JSON.stringify(snapshot.events),
    });
    // Locate the failure at the caller's throw, not inside this helper.
    Error.captureStackTrace(error, startupProbeFailure);
    error.openclawCiDiagnostic = modelProbeDiagnostic(snapshot, undefined, reason);
    return error;
  };
}

export const observedValue = (key: string, value: unknown) => (event: ProbeEvent) =>
  event.event === "observe" && event.key === key && event.value === value;
export const isModelTurn = (event: ProbeEvent & { turn?: unknown }) =>
  event.event === "request" && event.turn === true;
export const isTurnAnswer = (event: ProbeEvent) => event.event === "turn-answered";
export const isRuntimeFailure = (event: ProbeEvent) =>
  event.event === "observe" && event.key === "runtimeFailure" && event.value !== null;
export const heldFailure =
  (code: string) =>
  ({ events }: { events: readonly ProbeEvent[] }) =>
    events.some(observedValue("runtimeFailure", code));

export function phaseAt<T extends ProbePhase>(phases: readonly T[], phase: string): T | undefined {
  return phases.find((entry) => entry.phase === phase);
}

// The endpoint reads status and readiness in parallel, so wait until both have passed.
export const readyOrFailed = ({ events, phases }: StartupProbeSnapshot) =>
  events.some(isRuntimeFailure) ||
  (events.some(observedValue("ready", true)) &&
    events.some(observedValue("plugin", "ready")) &&
    phaseAt(phases, "native-spawn") !== undefined);

const heldFailureLine = /Harness model authentication probe failed\./;
export const heldAuthenticationFailure = (snapshot: StartupProbeSnapshot) =>
  heldFailure("AUTHENTICATION_FAILED")(snapshot) && heldFailureLine.test(snapshot.output);

export function startupProbeFailureDetails(run: {
  snapshot: Pick<StartupProbeSnapshot, "events" | "output">;
}) {
  const failure = run.snapshot.events.find(isRuntimeFailure)?.value;
  const detail = `${failureTail(run.snapshot.output)}\n${JSON.stringify(run.snapshot.events)}`;
  return { failure, detail };
}

// Endpoint and wrapper timestamps originate in lenient JSON records. Match JavaScript's
// relational comparison for JSON values, including absent, null, and string timestamps.
function earlierTimestamp(left: unknown, right: unknown) {
  const first = left !== null && typeof left === "object" ? String(left) : left;
  const second = right !== null && typeof right === "object" ? String(right) : right;
  return typeof first === "string" && typeof second === "string"
    ? first < second
    : Number(first) < Number(second);
}

export function observedBefore(
  events: StartupProbeEvent[],
  key: string,
  value: unknown,
  at: unknown,
) {
  return events
    .filter(
      (event) => event.event === "observe" && event.key === key && earlierTimestamp(event.at, at),
    )
    .some((event) => event.value === value);
}

export function describeStartupProbeRun(label: string, run: StartupProbeRun) {
  const { events, phases } = run.snapshot;
  const at = (predicate: (event: StartupProbeEvent) => boolean) => run.first(events, predicate)?.ms;
  return (
    `${label}: ` +
    JSON.stringify({
      modelProbeMs: phaseAt(phases, "model-probe")?.sinceStartMs,
      nativeSpawnMs: phaseAt(phases, "native-spawn")?.sinceStartMs,
      modelTurnMs: at(isModelTurn),
      turnAnsweredMs: at(isTurnAnswer),
      nativeListeningMs: at(observedValue("native", true)),
      runtimeFailureMs: at(isRuntimeFailure),
      readyMs: at(observedValue("ready", true)),
    })
  );
}

export function assertHeldFailureDeadline(ms: number) {
  // Far inside the convergence deadline that a rejected credential must cut short.
  assert.ok(ms < 120_000 * imageSmokeTimeoutMultiplier, `failure after ${ms} ms`);
}
