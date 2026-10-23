import {
  PROCESS_EXIT_ERROR_CODES,
  PROCESS_EXIT_MAX_STATUS,
  PROCESS_EXIT_SIGNALS,
  RUNTIME_COMPONENTS,
  RUNTIME_DIAGNOSTIC_CHECKS,
  RUNTIME_DIAGNOSTIC_CODES,
  RUNTIME_FAILURE_CHECKS,
  UNRECOGNIZED_RUNTIME_VALUE,
  WORKSPACE_SETUP_CHECK,
  WORKSPACE_SETUP_FAILED,
  WORKSPACE_SETUP_REFUSED,
} from "@openclaw-enterprise/contracts";
import type {
  RuntimeDiagnosticCheck,
  RuntimeFailureCause,
  RuntimeFailureEvidence,
} from "@openclaw-enterprise/contracts";

// The closed vocabulary of a model-probe failure cause. Each kind admits only
// these detail tokens (WRAPPER_ERROR none), so a cause can never carry native
// output, a provider response or a credential across the runtime boundary.
const RUNTIME_FAILURE_CAUSE_DETAILS: Readonly<
  Record<RuntimeFailureCause["kind"], RegExp | undefined>
> = Object.freeze({
  // UNRECOGNIZED keeps its shape so the rows #2763 recorded still read (finding 1706).
  PROCESS_EXIT:
    /^(?:exit-[1-9][0-9]{0,2}|signal-SIG[A-Z0-9]{1,10}|error-E[A-Z0-9]{1,15}|UNRECOGNIZED)$/u,
  PROBE_STATUS:
    /^(?:format|rate_limit|billing|unknown|no_model|other|turn-failed|error-event|tool-event|unexpected-event|no-reply)$/u,
  INVALID_OUTPUT: /^(?:json|shape)$/u,
  WRAPPER_ERROR: undefined,
});

// A PROCESS_EXIT token of the right shape names a status, signal or system error code
// from the contract's lists; any other is recorded without its detail (finding 1673).
// UNRECOGNIZED, which #2763 wrote, is not a known detail either: stored rows read without it,
// and a runtime serving it records nothing a pre-#2763 controller refuses (finding 1706).
const PROCESS_EXIT_DETAILS: ReadonlySet<string> = new Set([
  ...Array.from({ length: PROCESS_EXIT_MAX_STATUS }, (_, index) => `exit-${index + 1}`),
  ...PROCESS_EXIT_SIGNALS.map((signal) => `signal-${signal}`),
  ...PROCESS_EXIT_ERROR_CODES.map((code) => `error-${code}`),
]);

// The startup probe retries a timeout or reliability failure once; when the second attempt
// fails too, its detail token carries this suffix.
const RETRIED_DETAIL_SUFFIX = "-attempt2";

/** Returns the cause when it is in the closed vocabulary, otherwise undefined. */
export function runtimeFailureCause(value: unknown): RuntimeFailureCause | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { kind, detail, ...rest } = value as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    typeof kind !== "string" ||
    !Object.hasOwn(RUNTIME_FAILURE_CAUSE_DETAILS, kind)
  ) {
    return undefined;
  }
  const details = RUNTIME_FAILURE_CAUSE_DETAILS[kind as RuntimeFailureCause["kind"]];
  if (detail === undefined) {
    return Object.freeze({ kind: kind as RuntimeFailureCause["kind"] });
  }
  if (typeof detail !== "string") {
    return undefined;
  }
  const retried = detail.endsWith(RETRIED_DETAIL_SUFFIX);
  const token = retried ? detail.slice(0, -RETRIED_DETAIL_SUFFIX.length) : detail;
  if (details === undefined || !details.test(token)) {
    return undefined;
  }
  if (kind === "PROCESS_EXIT" && !PROCESS_EXIT_DETAILS.has(token)) {
    // Omitted, not replaced: a controller from before #2763 reads a cause without a
    // detail but rejects UNRECOGNIZED, so a rollback or rolling upgrade still reads the row.
    return Object.freeze({ kind });
  }
  return Object.freeze({ kind: kind as RuntimeFailureCause["kind"], detail });
}

const RUNTIME_COMPONENT_SET: ReadonlySet<string> = new Set(RUNTIME_COMPONENTS);
// Runtime entrypoints hold a failure under these checks and codes, and Kubernetes Compute
// builds the workspace-setup record itself from Pod status (findings 1675, 1677).
const RUNTIME_FAILURE_CHECK_SET: ReadonlySet<string> = new Set([
  ...RUNTIME_FAILURE_CHECKS,
  WORKSPACE_SETUP_CHECK,
]);
const RUNTIME_FAILURE_CODE_SET: ReadonlySet<string> = new Set([
  ...RUNTIME_DIAGNOSTIC_CODES,
  WORKSPACE_SETUP_FAILED,
  WORKSPACE_SETUP_REFUSED,
]);
// A diagnostics read reports a held startup failure first, then the runtime's own checks.
const RUNTIME_DIAGNOSTIC_CHECK_SET: ReadonlySet<string> = new Set([
  ...RUNTIME_FAILURE_CHECKS,
  ...RUNTIME_DIAGNOSTIC_CHECKS,
]);
const RUNTIME_DIAGNOSTIC_CODE_SET: ReadonlySet<string> = new Set(RUNTIME_DIAGNOSTIC_CODES);

function recognized(value: string, known: ReadonlySet<string>): string {
  return known.has(value) ? value : UNRECOGNIZED_RUNTIME_VALUE;
}

/**
 * Runtime failure evidence with each component, check and code outside the vocabulary
 * replaced by UNRECOGNIZED (finding 1660).
 */
export function recognizedRuntimeFailureValues(
  evidence: Readonly<RuntimeFailureEvidence>,
): RuntimeFailureEvidence {
  return Object.freeze({
    ...evidence,
    component: recognized(evidence.component, RUNTIME_COMPONENT_SET),
    check: recognized(evidence.check, RUNTIME_FAILURE_CHECK_SET),
    code: recognized(evidence.code, RUNTIME_FAILURE_CODE_SET),
  });
}

/**
 * A runtime diagnostic check with each component, check and code outside the vocabulary
 * replaced by UNRECOGNIZED (finding 1673).
 */
export function recognizedRuntimeDiagnosticValues(
  diagnostic: Readonly<RuntimeDiagnosticCheck>,
): RuntimeDiagnosticCheck {
  return Object.freeze({
    ...diagnostic,
    component: recognized(diagnostic.component, RUNTIME_COMPONENT_SET),
    check: recognized(diagnostic.check, RUNTIME_DIAGNOSTIC_CHECK_SET),
    ...(diagnostic.code === undefined
      ? {}
      : { code: recognized(diagnostic.code, RUNTIME_DIAGNOSTIC_CODE_SET) }),
  });
}
