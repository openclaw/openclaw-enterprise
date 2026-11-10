export const maxInstallationInvocations = 8;
const stages = ["workspace-helm", "gateway-helm", "gateway-pod-ready"] as const;
type InstallationStage = (typeof stages)[number];

export interface InstallationPhase {
  kind: "openshell-installation";
  stage: InstallationStage;
  invocation: number;
  outcome: "entered" | "passed" | "failed";
  offsetMs: number;
}

export function installationPhase(value: unknown): InstallationPhase | undefined {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 5) {
    return undefined;
  }
  const row = value as Partial<InstallationPhase>;
  if (
    row.kind !== "openshell-installation" ||
    !row.stage ||
    !stages.includes(row.stage) ||
    typeof row.invocation !== "number" ||
    !Number.isInteger(row.invocation) ||
    row.invocation < 1 ||
    row.invocation > maxInstallationInvocations + 1 ||
    (row.invocation === maxInstallationInvocations + 1 &&
      (row.stage !== "workspace-helm" || row.outcome !== "entered")) ||
    (row.outcome !== "entered" && row.outcome !== "passed" && row.outcome !== "failed") ||
    typeof row.offsetMs !== "number" ||
    !Number.isSafeInteger(row.offsetMs) ||
    row.offsetMs < 0
  ) {
    return undefined;
  }
  return {
    kind: row.kind,
    stage: row.stage,
    outcome: row.outcome,
    invocation: row.invocation,
    offsetMs: row.offsetMs,
  };
}

interface PhaseResult {
  invocation: number;
  stage: InstallationStage;
  enteredMs: number;
  outcome: "unknown" | "passed" | "failed";
  elapsedMs?: number;
}

export function collectInstallationPhases() {
  const phases: PhaseResult[] = [];
  let truncated = false;
  return {
    accept(row: InstallationPhase) {
      if (row.invocation === maxInstallationInvocations + 1) {
        truncated = true;
        return;
      }
      const phase = phases.find(
        (phase) => phase.invocation === row.invocation && phase.stage === row.stage,
      );
      if (!phase && row.outcome === "entered") {
        phases.push({
          invocation: row.invocation,
          stage: row.stage,
          enteredMs: row.offsetMs,
          outcome: "unknown",
        });
      } else if (
        phase?.outcome === "unknown" &&
        row.outcome !== "entered" &&
        row.offsetMs >= phase.enteredMs
      ) {
        phase.outcome = row.outcome;
        phase.elapsedMs = row.offsetMs - phase.enteredMs;
      }
    },
    result() {
      return { phases, truncated };
    },
  };
}
