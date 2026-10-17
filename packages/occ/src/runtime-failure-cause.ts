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
} from "@openclaw-enterprise/contracts";
import type { RuntimeFailureCause } from "@openclaw-enterprise/contracts";

// The closed vocabulary of a model-probe failure cause. Each kind admits only
// these detail tokens (WRAPPER_ERROR none), so a cause can never carry native
// output, a provider response or a credential across the runtime boundary.
const RUNTIME_FAILURE_CAUSE_DETAILS: Readonly<
  Record<RuntimeFailureCause["kind"], RegExp | undefined>
> = Object.freeze({
  PROCESS_EXIT:
    /^(?:exit-[1-9][0-9]{0,2}|signal-SIG[A-Z0-9]{1,10}|error-E[A-Z0-9]{1,15}|UNRECOGNIZED)$/u,
  PROBE_STATUS:
    /^(?:format|rate_limit|billing|unknown|no_model|other|turn-failed|error-event|tool-event|unexpected-event|no-reply)$/u,
  INVALID_OUTPUT: /^(?:json|shape)$/u,
  WRAPPER_ERROR: undefined,
});

// A PROCESS_EXIT token of the right shape names a status, signal or system error code
// from the contract's lists; any other is recorded as UNRECOGNIZED (finding 1673).
const PROCESS_EXIT_DETAILS: ReadonlySet<string> = new Set([
  ...Array.from({ length: PROCESS_EXIT_MAX_STATUS }, (_, index) => `exit-${index + 1}`),
  ...PROCESS_EXIT_SIGNALS.map((signal) => `signal-${signal}`),
  ...PROCESS_EXIT_ERROR_CODES.map((code) => `error-${code}`),
  UNRECOGNIZED_RUNTIME_VALUE,
]);

// The startup probe retries a transient failure once; when the second attempt
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
  return Object.freeze({
    kind: kind as RuntimeFailureCause["kind"],
    detail:
      kind !== "PROCESS_EXIT" || PROCESS_EXIT_DETAILS.has(token)
        ? detail
        : UNRECOGNIZED_RUNTIME_VALUE + (retried ? RETRIED_DETAIL_SUFFIX : ""),
  });
}

const RUNTIME_COMPONENT_SET: ReadonlySet<string> = new Set(RUNTIME_COMPONENTS);
// Runtime entrypoints hold a failure under these checks and codes, and Kubernetes Compute
// builds workspace-setup / WORKSPACE_SETUP_FAILED itself from Pod status (finding 1675).
const RUNTIME_FAILURE_CHECK_SET: ReadonlySet<string> = new Set([
  ...RUNTIME_FAILURE_CHECKS,
  WORKSPACE_SETUP_CHECK,
]);
const RUNTIME_FAILURE_CODE_SET: ReadonlySet<string> = new Set([
  ...RUNTIME_DIAGNOSTIC_CODES,
  WORKSPACE_SETUP_FAILED,
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
export function recognizedRuntimeFailureValues<
  T extends { readonly component: string; readonly check: string; readonly code: string },
>(evidence: T): T {
  return {
    ...evidence,
    component: recognized(evidence.component, RUNTIME_COMPONENT_SET),
    check: recognized(evidence.check, RUNTIME_FAILURE_CHECK_SET),
    code: recognized(evidence.code, RUNTIME_FAILURE_CODE_SET),
  };
}

/**
 * A runtime diagnostic check with each component, check and code outside the vocabulary
 * replaced by UNRECOGNIZED (finding 1673).
 */
export function recognizedRuntimeDiagnosticValues<
  T extends { readonly component: string; readonly check: string; readonly code?: string },
>(diagnostic: T): T {
  return {
    ...diagnostic,
    component: recognized(diagnostic.component, RUNTIME_COMPONENT_SET),
    check: recognized(diagnostic.check, RUNTIME_DIAGNOSTIC_CHECK_SET),
    ...(diagnostic.code === undefined
      ? {}
      : { code: recognized(diagnostic.code, RUNTIME_DIAGNOSTIC_CODE_SET) }),
  };
}
