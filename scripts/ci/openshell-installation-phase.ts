export const maxInstallationInvocations = 8;
const stages = [
  "workspace-helm",
  "gateway-helm",
  "gateway-pod-ready",
  "namespace-ready",
  "gateway-ready",
  "first-revision-activation",
] as const;
type InstallationStage = (typeof stages)[number];

export function activationRefusal(code: unknown) {
  return code === "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE" ||
    code === "RUNTIME_CODEX_REQUIREMENTS_TOO_LARGE"
    ? code
    : undefined;
}

export interface InstallationPhase {
  kind: "openshell-installation";
  stage: InstallationStage;
  invocation: number;
  outcome: "entered" | "passed" | "failed";
  offsetMs: number;
  refusal?: NonNullable<ReturnType<typeof activationRefusal>>;
}

export function installationPhase(value: unknown): InstallationPhase | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Partial<InstallationPhase>;
  const hasRefusal = Object.hasOwn(row, "refusal");
  if (
    Object.keys(row).length !== (hasRefusal ? 6 : 5) ||
    (hasRefusal &&
      (row.stage !== "first-revision-activation" ||
        row.outcome !== "failed" ||
        !activationRefusal(row.refusal))) ||
    row.kind !== "openshell-installation" ||
    !row.stage ||
    !stages.includes(row.stage) ||
    typeof row.invocation !== "number" ||
    !Number.isInteger(row.invocation) ||
    row.invocation < 1 ||
    row.invocation > maxInstallationInvocations + 1 ||
    (row.invocation === maxInstallationInvocations + 1 &&
      ((row.stage !== "workspace-helm" && row.stage !== "namespace-ready") ||
        row.outcome !== "entered")) ||
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
    ...(hasRefusal ? { refusal: row.refusal } : {}),
  };
}

interface PhaseResult {
  invocation: number;
  stage: InstallationStage;
  enteredMs: number;
  outcome: "unknown" | "passed" | "failed";
  elapsedMs?: number;
  refusal?: InstallationPhase["refusal"];
}

export function collectInstallationPhases() {
  const phases: PhaseResult[] = [];
  let truncated = false;
  const ambiguous = new Set<PhaseResult>();
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
        phase &&
        (row.stage === "first-revision-activation" ||
          row.stage === "namespace-ready" ||
          row.stage === "gateway-ready") &&
        (row.outcome === "entered" || phase.outcome !== "unknown" || row.offsetMs < phase.enteredMs)
      ) {
        ambiguous.add(phase);
        phase.outcome = "unknown";
        delete phase.elapsedMs;
        delete phase.refusal;
      } else if (
        phase &&
        !ambiguous.has(phase) &&
        phase.outcome === "unknown" &&
        row.outcome !== "entered" &&
        row.offsetMs >= phase.enteredMs
      ) {
        phase.outcome = row.outcome;
        if (row.refusal) {
          phase.refusal = row.refusal;
        }
        phase.elapsedMs = row.offsetMs - phase.enteredMs;
      }
    },
    result() {
      return { phases, truncated };
    },
  };
}
