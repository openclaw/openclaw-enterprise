import type { AttemptContext, Clock } from "../../credentials/backend-contracts.ts";
import { sendProviderRequest } from "./provider-transport/request.ts";
import {
  prepareProviderScope,
  type ProviderIssuanceScope,
} from "./provider-transport/request-options.ts";

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
  issue(
    authorization: string,
    attempt: ProviderAttempt,
    onDispatch: () => void,
    assertMaterialCurrent: () => void,
    observeResponse: (response: ProviderResponse) => void,
  ): Promise<ProviderResponse>;
  revoke(
    authorization: string,
    attempt: ProviderAttempt,
    onDispatch: () => void,
  ): Promise<ProviderResponse>;
}

/** This capability can only mint its original scope or revoke the presented token. */
export function createProviderTransport(
  origin: string,
  ca: Uint8Array | undefined,
  clock: Clock,
  scope: ProviderIssuanceScope,
): ProviderTransport {
  const prepared = prepareProviderScope(origin, scope);
  const trustedCa = ca === undefined ? undefined : Buffer.from(ca);
  return Object.freeze<ProviderTransport>({
    issue(authorization, attempt, onDispatch, assertMaterialCurrent, observeResponse) {
      return sendProviderRequest({
        endpoint: prepared,
        ca: trustedCa,
        clock,
        operation: "issue",
        authorization,
        attempt,
        onDispatch,
        assertMaterialCurrent,
        observeResponse,
      });
    },
    revoke(authorization, attempt, onDispatch) {
      return sendProviderRequest({
        endpoint: prepared,
        ca: trustedCa,
        clock,
        operation: "revoke",
        authorization,
        attempt,
        onDispatch,
        assertMaterialCurrent: () => {},
        observeResponse: () => {},
      });
    },
  });
}
