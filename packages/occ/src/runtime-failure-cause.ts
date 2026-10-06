import type { RuntimeFailureCause } from "@openclaw-enterprise/contracts";

// The closed vocabulary of a model-probe failure cause. Each kind admits only
// these detail tokens (WRAPPER_ERROR none), so a cause can never carry native
// output, a provider response or a credential across the runtime boundary.
const RUNTIME_FAILURE_CAUSE_DETAILS: Readonly<
  Record<RuntimeFailureCause["kind"], RegExp | undefined>
> = Object.freeze({
  PROCESS_EXIT: /^(?:exit-[1-9][0-9]{0,2}|signal-SIG[A-Z0-9]{1,10}|error-E[A-Z0-9]{1,15})$/u,
  PROBE_STATUS:
    /^(?:format|rate_limit|billing|unknown|no_model|other|turn-failed|error-event|tool-event|unexpected-event|no-reply)$/u,
  INVALID_OUTPUT: /^(?:json|shape)$/u,
  WRAPPER_ERROR: undefined,
});

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
  if (details === undefined || typeof detail !== "string" || !details.test(detail)) {
    return undefined;
  }
  return Object.freeze({ kind: kind as RuntimeFailureCause["kind"], detail });
}
