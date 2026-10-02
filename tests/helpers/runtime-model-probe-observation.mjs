import { modelProbeTimeoutDiagnostic } from "./runtime-model-probe-diagnostic.mjs";

const observed = (events, key, value) =>
  events.some((event) => event.event === "observe" && event.key === key && event.value === value);

export function modelProbeSettled({ events }) {
  return (
    events.some(
      (event) =>
        event.event === "observe" &&
        event.key === "runtimeFailure" &&
        event.value !== null &&
        event.value !== undefined,
    ) ||
    (observed(events, "ready", true) && observed(events, "plugin", "ready"))
  );
}

export function modelProbeDiagnostic(snapshot, stress, reason) {
  const probe = snapshot.probe ?? {};
  return {
    ...modelProbeTimeoutDiagnostic(snapshot, {
      submitted: stress?.requested ?? 0,
      settled: stress?.settled ?? 0,
      failed: stress?.rejected ?? 0,
    }),
    reason,
    running: snapshot.running,
    pluginReadyObserved: observed(snapshot.events, "plugin", "ready"),
    probeStage: snapshot.probeStage ?? "not-observed",
    capMs: probe.capMs,
    elapsedMs: probe.elapsedMs,
    cpuWaitMs: probe.cpuWaitMs,
    loadClientsStarted: stress?.started ?? 0,
  };
}

// The marker proves the owned Node process reached its busy loop, not merely
// that a Docker exec request was submitted. Keep no child output or error text.
export function trackProbeCpuHog(operation, stress) {
  stress.requested++;
  let pending = "";
  let started = false;
  operation.child.stdout.on("data", (chunk) => {
    pending = (pending + String(chunk)).slice(-64);
    if (!started && pending.includes("openclaw-cpu-hog-started\n")) {
      started = true;
      stress.started++;
    }
  });
  return operation.then(
    () => {
      stress.settled++;
    },
    () => {
      stress.settled++;
      stress.rejected++;
    },
  );
}
