import type {
  AgentDeploymentDiagnostics,
  AgentRuntimeHarnessStatus,
  RuntimeDiagnosticCheck,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "./errors.ts";
import { recognizedRuntimeDiagnosticValues } from "./runtime-failure-cause.ts";

const RUNTIME_DIAGNOSTIC_IDENTIFIER = /^[A-Za-z0-9._~:@-]{1,64}$/u;
const RUNTIME_DIAGNOSTIC_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/u;
const MAX_DIAGNOSTIC_CHECKS = 32;

function validRuntimeDiagnosticIdentifier(value: unknown): value is string {
  return typeof value === "string" && RUNTIME_DIAGNOSTIC_IDENTIFIER.test(value);
}

function validRuntimeDiagnosticTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !RUNTIME_DIAGNOSTIC_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validRuntimeDiagnosticCheck(value: RuntimeDiagnosticCheck): RuntimeDiagnosticCheck {
  const state = value?.state;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !validRuntimeDiagnosticIdentifier(value.component) ||
    !validRuntimeDiagnosticIdentifier(value.check) ||
    (state !== "succeeded" && state !== "failed" && state !== "unknown") ||
    (value.checkedAt !== null && !validRuntimeDiagnosticTimestamp(value.checkedAt)) ||
    (value.code !== undefined && !validRuntimeDiagnosticIdentifier(value.code))
  ) {
    throw new DependencyUnavailableError(
      "The selected compute Driver returned invalid runtime diagnostic evidence.",
    );
  }
  // Compute reads these from the runtime, so a value outside the runtime's vocabulary is
  // returned as UNRECOGNIZED rather than as served (finding 1673).
  return recognizedRuntimeDiagnosticValues({
    component: value.component,
    check: value.check,
    state,
    checkedAt: value.checkedAt,
    ...(value.code === undefined ? {} : { code: value.code }),
  });
}

export function deploymentDiagnostics(
  diagnostics: AgentDeploymentDiagnostics,
  revisionId: string,
): Readonly<AgentDeploymentDiagnostics> {
  if (
    typeof diagnostics !== "object" ||
    diagnostics === null ||
    Array.isArray(diagnostics) ||
    diagnostics.revisionId !== revisionId ||
    !validRuntimeDiagnosticTimestamp(diagnostics.observedAt) ||
    !Array.isArray(diagnostics.checks) ||
    diagnostics.checks.length > MAX_DIAGNOSTIC_CHECKS
  ) {
    throw new DependencyUnavailableError(
      "The selected compute Driver returned invalid runtime diagnostics.",
    );
  }
  return Object.freeze({
    revisionId: diagnostics.revisionId,
    observedAt: diagnostics.observedAt,
    checks: Object.freeze(diagnostics.checks.map((check) => validRuntimeDiagnosticCheck(check))),
  });
}

export function withHarnessDiagnostic(
  diagnostics: Readonly<AgentDeploymentDiagnostics>,
  observed: AgentRuntimeHarnessStatus,
  checkedAt: string,
): Readonly<AgentDeploymentDiagnostics> {
  // A Harness process that exited has failed even while its provider restarts it.
  const state =
    observed.state === "running"
      ? "succeeded"
      : observed.state === "lost" || observed.code === "HARNESS_RESTARTING"
        ? "failed"
        : "unknown";
  const code = observed.code ?? (observed.state === "starting" ? "STARTING" : undefined);
  const harnessCheck: RuntimeDiagnosticCheck = Object.freeze({
    component: "agent",
    check: "sandbox",
    state,
    checkedAt,
    ...(code === undefined ? {} : { code }),
  });
  // A lost Sandbox explains every other agent check, so it leads and the cap never drops it.
  return Object.freeze({
    ...diagnostics,
    checks: Object.freeze([harnessCheck, ...diagnostics.checks].slice(0, MAX_DIAGNOSTIC_CHECKS)),
  });
}
