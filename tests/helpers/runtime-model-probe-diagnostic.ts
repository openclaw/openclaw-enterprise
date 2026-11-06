// CI may retain only these fixed outcomes, never the probe's logs or input.
const probeCodes = new Set<unknown>([
  "READY",
  "AUTHENTICATION_FAILED",
  "MODEL_PROBE_CPU_STARVED",
  "MODEL_PROBE_FAILED",
  "MODEL_PROBE_TIMEOUT",
  "UNAVAILABLE",
]);

export interface ProbeEvent {
  event?: unknown;
  key?: unknown;
  value?: unknown;
  ms?: number | undefined;
}

export interface ProbePhase {
  phase?: unknown;
  outcome?: unknown;
  sinceStartMs?: unknown;
}

export interface DiagnosticSnapshot {
  output: string;
  phases: ProbePhase[];
  events: ProbeEvent[];
}

export function modelProbeTimeoutDiagnostic(
  snapshot: DiagnosticSnapshot,
  load = { submitted: 0, settled: 0, failed: 0 },
) {
  let probe;
  for (const line of snapshot.output.split(/\r?\n/)) {
    try {
      const entry: unknown = JSON.parse(line);
      if (
        entry !== null &&
        typeof entry === "object" &&
        "event" in entry &&
        entry.event === "openclaw.model_probe"
      ) {
        probe = entry;
        break;
      }
    } catch {
      // Runtime output may contain ordinary, non-JSON log lines.
    }
  }
  const phase = snapshot.phases.find((entry) => entry.phase === "model-probe");
  const events = snapshot.events;
  let outcome = "not-observed";
  if (probe !== undefined) {
    const code = "code" in probe ? probe.code : undefined;
    outcome = typeof code === "string" && probeCodes.has(code) ? code : "other";
  }
  let modelPhase = "not-observed";
  if (phase !== undefined) {
    modelPhase = phase.outcome === "ok" || phase.outcome === "failed" ? phase.outcome : "other";
  }
  return {
    kind: "runtime-model-probe",
    reason: "outer-timeout",
    probe: outcome,
    modelPhase,
    nativeSpawnPhaseObserved: snapshot.phases.some((entry) => entry.phase === "native-spawn"),
    readyObserved: events.some(
      (entry) => entry.event === "observe" && entry.key === "ready" && entry.value === true,
    ),
    failureObserved: events.some(
      (entry) => entry.event === "observe" && entry.key === "runtimeFailure" && entry.value != null,
    ),
    loadClientsSubmitted: load.submitted,
    loadClientsSettled: load.settled,
    loadClientsRejected: load.failed,
  };
}
