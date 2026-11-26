import type { AttemptContext, Clock } from "../../access/backend-contracts.ts";
import { sendProviderRequest } from "./provider-transport/request.ts";
import type { ProviderObservation } from "./provider-diagnostics.ts";
import type { ProviderScope } from "./provider-transport/request-options.ts";

/** The caller owns admission and dispatch; this transport does not require a repository identity. */
export type ProviderAttempt = Pick<
  AttemptContext,
  "signal" | "deadlineMonoMs" | "assertAdmitted" | "observeDispatch"
>;

export interface ProviderResponse {
  readonly status: number;
  readonly body: Buffer;
}
export interface ProviderTransport {
  /** Borrow the body synchronously; complete only after successful request close. */
  issue(
    authorization: string,
    attempt: ProviderAttempt,
    assertMaterialCurrent: () => void,
    consumeResponse: (response: ProviderResponse) => undefined,
    observe?: (observation: ProviderObservation) => void,
  ): Promise<void>;
  /** Only a complete 204 response confirms retirement. Transport failures remain uncertain. */
  revoke(authorization: string, attempt: ProviderAttempt): Promise<boolean>;
}

/** This capability can only mint its original scope or revoke the presented token. */
export function createProviderTransport(
  ca: Uint8Array | undefined,
  clock: Clock,
  prepared: ProviderScope,
): ProviderTransport {
  const trustedCa = ca === undefined ? undefined : Buffer.from(ca);
  return Object.freeze<ProviderTransport>({
    issue(authorization, attempt, assertMaterialCurrent, consumeResponse, observe) {
      return sendProviderRequest({
        endpoint: prepared,
        ca: trustedCa,
        clock,
        operation: "issue",
        authorization,
        attempt,
        assertMaterialCurrent,
        consumeResponse,
        ...(observe ? { observe } : {}),
      });
    },
    async revoke(authorization, attempt) {
      let revoked = false;
      await sendProviderRequest({
        endpoint: prepared,
        ca: trustedCa,
        clock,
        operation: "revoke",
        authorization,
        attempt,
        assertMaterialCurrent: () => {},
        consumeResponse: (response) => {
          revoked = response.status === 204;
        },
      });
      return revoked;
    },
  });
}
