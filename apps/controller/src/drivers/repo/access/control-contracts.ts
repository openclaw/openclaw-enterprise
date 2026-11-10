import type {
  RepositoryCredentialSessionInput,
  RepositoryCredentialBoundSessionInput,
  RepositoryCredentialSessionResult,
  SessionStatus,
} from "./service-contracts.ts";

export type ControlRequest =
  | Readonly<{
      method: "POST";
      path: "/v1/sessions";
      body: RepositoryCredentialSessionInput | RepositoryCredentialBoundSessionInput;
    }>
  | Readonly<{ method: "GET"; path: `/v1/sessions/${string}` }>
  | Readonly<{ method: "POST"; path: `/v1/sessions/${string}/close` }>;
export type ControlErrorCode =
  "invalid-request" | "not-found" | "admission-missing" | "unavailable" | "overloaded";
export type ControlResponse =
  RepositoryCredentialSessionResult | SessionStatus | Readonly<{ error: ControlErrorCode }>;
