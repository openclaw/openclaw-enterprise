import type { TokenPreparationObservation } from "../../../../backends/token-service/preparation.ts";

export interface ProviderObservation {
  readonly stage:
    | "fence"
    | "request-created"
    | "tls-ready"
    | "request-end-called"
    | "response-started"
    | "complete"
    | "validation";
  readonly error?:
    | "connection-refused"
    | "connection-reset"
    | "dns-unavailable"
    | "tls-unavailable"
    | "request-error"
    | "request-setup"
    | "signer-fenced"
    | "admission-fenced"
    | "cancelled"
    | "deadline"
    | "response-error"
    | "response-encoding"
    | "response-limit"
    | "observer-error"
    | "validation-failed";
  readonly httpStatus?: number;
  readonly responseComplete?: boolean;
  readonly candidateIdentified?: boolean;
  readonly requestEndCalled?: boolean;
  readonly validationKind?: "validated" | "uncertain" | "reauthorization-required" | "rejected";
  readonly validationCode?:
    "authority-unavailable" | "scope-mismatch" | "invalid-response" | "insufficient-validity";
}

export type GitHubPreparationDiagnostic = Readonly<
  Omit<TokenPreparationObservation, "attemptId" | "stage" | "error"> &
    Omit<ProviderObservation, "stage" | "error"> & {
      attemptId: string;
      stage: TokenPreparationObservation["stage"] | ProviderObservation["stage"];
      firstFailureStage?: TokenPreparationObservation["stage"] | ProviderObservation["stage"];
      error?: TokenPreparationObservation["error"] | ProviderObservation["error"];
      outcome: "ready" | "committed" | "blocked" | "fenced" | "quarantined";
    }
>;

/** Fixed error classes only: messages, nested errors and provider bytes never enter reports. */
export function providerErrorClass(error: unknown): ProviderObservation["error"] {
  try {
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    switch (code) {
      case "ECONNREFUSED":
        return "connection-refused";
      case "ECONNRESET":
        return "connection-reset";
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return "dns-unavailable";
      case "CERT_HAS_EXPIRED":
      case "DEPTH_ZERO_SELF_SIGNED_CERT":
      case "SELF_SIGNED_CERT_IN_CHAIN":
      case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      case "ERR_TLS_CERT_ALTNAME_INVALID":
        return "tls-unavailable";
      default:
        return "request-error";
    }
  } catch {
    return "request-error";
  }
}

export function observeProvider(
  observe: ((observation: ProviderObservation) => void) | undefined,
  observation: ProviderObservation,
): void {
  try {
    observe?.(observation);
  } catch {
    // Diagnostics cannot change provider dispatch or custody decisions.
  }
}
