import type {
  AgentDeploymentDiagnostics,
  RuntimeDiagnosticCheck,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "./errors.ts";

const RUNTIME_DIAGNOSTIC_IDENTIFIER = /^[A-Za-z0-9._~:@-]{1,64}$/u;
const RUNTIME_DIAGNOSTIC_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/u;

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
  return Object.freeze({
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
    diagnostics.checks.length > 32
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
