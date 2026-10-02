// CI may retain only these fixed outcomes, never the probe's logs or input.
const probeCodes = new Set([
  "READY",
  "AUTHENTICATION_FAILED",
  "MODEL_PROBE_CPU_STARVED",
  "MODEL_PROBE_FAILED",
  "MODEL_PROBE_TIMEOUT",
  "UNAVAILABLE",
]);

export function modelProbeTimeoutDiagnostic(
  snapshot,
  load = { submitted: 0, settled: 0, failed: 0 },
) {
  let probe;
  for (const line of snapshot.output.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      if (entry?.event === "openclaw.model_probe") {
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
    outcome = probeCodes.has(probe.code) ? probe.code : "other";
  }
  let modelPhase = "not-observed";
  if (phase !== undefined) {
    modelPhase = ["ok", "failed"].includes(phase.outcome) ? phase.outcome : "other";
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
