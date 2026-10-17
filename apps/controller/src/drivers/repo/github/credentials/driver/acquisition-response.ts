import { parseJsonMembers } from "../../../credentials/json-members.ts";
import type {
  AcquireOutcome,
  AttemptContext,
  Clock,
  CredentialRef,
  DriverCustody,
  OriginalOutcome,
} from "../../../credentials/backend-contracts.ts";
import type { ProviderResponse } from "../provider-transport.ts";
import type { GitHubDriverState } from "./state.ts";
import { providerClockSkewMs, tokenLifetimeMs } from "./lifetime.ts";
import { isGitHubWireCredential } from "../wire-credential.ts";

type AcquisitionObservation = Readonly<{
  packet: Record<string, unknown> | undefined;
  credential: CredentialRef | undefined;
  observedWallMs: number;
}>;

type ResponseObservationDependencies = Readonly<{
  state: GitHubDriverState;
  custody: DriverCustody;
  clock: Clock;
  attempt: AttemptContext;
  response: ProviderResponse;
}>;

type AcquisitionPolicy = Readonly<{
  repositoryId: string;
  repository: string;
  permissions: Readonly<Record<string, string>>;
  minimumValidityMs: number;
}>;

type OutcomePayload<T> = T extends OriginalOutcome ? Omit<T, keyof OriginalOutcome> : never;
type AcquisitionDecision = OutcomePayload<AcquireOutcome>;

/** Custody identification is independent of evidence that permits using the token. */
export function parseInstallationTokenResponse(body: Buffer): Readonly<{
  token: string | undefined;
  packet: Record<string, unknown> | undefined;
}> {
  try {
    let ambiguous = false;
    let ambiguousToken = false;
    const parsed = parseJsonMembers(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      (name, depth) => {
        ambiguous = true;
        if (depth === 1 && name === "token") {
          ambiguousToken = true;
        }
      },
    );
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const packet = parsed as Record<string, unknown>;
      return {
        token:
          !ambiguousToken && typeof packet.token === "string" && packet.token.length > 0
            ? packet.token
            : undefined,
        packet: ambiguous ? undefined : packet,
      };
    }
  } catch {
    // Malformed bytes or grammar identify neither a credential nor scope evidence.
  }
  return { token: undefined, packet: undefined };
}

export function observeAcquisitionResponse({
  state,
  custody,
  clock,
  attempt,
  response,
}: ResponseObservationDependencies): AcquisitionObservation {
  const { packet, token } = parseInstallationTokenResponse(response.body);
  let credential: CredentialRef | undefined;
  const observedWallMs = clock.wallNow();
  const expiry = typeof packet?.expires_at === "string" ? Date.parse(packet.expires_at) : NaN;
  if (token !== undefined) {
    const bytes = Buffer.from(token);
    try {
      // Capture in the response callback, before timeout or close can discard its body.
      credential = custody.capture(attempt, bytes, {
        observedWallMs,
        // Custody may release material at this bound. Provider wall time
        // is only an authentication limit, not proof of remote expiry.
        expiresAtWallMs: observedWallMs + tokenLifetimeMs,
      });
      state.credentials.set(credential, {
        expiresAt: Number.isFinite(expiry) ? expiry - providerClockSkewMs : undefined,
        observedWall: observedWallMs,
        observedMono: clock.monotonicNow(),
        accepted: false,
      });
    } finally {
      bytes.fill(0);
    }
  }
  return { packet, credential, observedWallMs };
}

export function classifyAcquisitionResponse(
  status: number,
  observation: AcquisitionObservation | undefined,
  policy: AcquisitionPolicy,
): AcquisitionDecision {
  const { packet, credential, observedWallMs = NaN } = observation ?? {};
  const decision = validateInstallationTokenResponse(
    status,
    packet,
    credential,
    observedWallMs,
    policy,
  );
  if (decision.kind !== "validated") {
    return decision;
  }
  return {
    kind: "acquired",
    credential: decision.credential,
    observedWallMs,
    expiresAtWallMs: decision.usableUntil,
  };
}

/** Validate after capture so even a rejected grant retains a cleanup owner. */
export function validateInstallationTokenResponse<Credential>(
  status: number,
  packet: Record<string, unknown> | undefined,
  credential: Credential | undefined,
  observedWallMs: number,
  { repositoryId, repository, permissions, minimumValidityMs }: AcquisitionPolicy,
):
  | Readonly<{
      kind: "validated";
      credential: Credential;
      providerExpiresAt: number;
      usableUntil: number;
    }>
  | Exclude<AcquisitionDecision, { kind: "acquired" }> {
  if ([401, 403, 404, 422].includes(status)) {
    return { kind: "reauthorization-required", code: "authority-unavailable" };
  }
  if (status !== 201 || credential === undefined) {
    return { kind: "uncertain" };
  }
  const expiry = typeof packet?.expires_at === "string" ? Date.parse(packet.expires_at) : NaN;
  const token = packet?.token;
  if (!isGitHubWireCredential(token)) {
    return { kind: "uncertain" };
  }
  const returned = packet?.permissions;
  const repositories = packet?.repositories;
  const validScope =
    returned &&
    typeof returned === "object" &&
    !Array.isArray(returned) &&
    Object.keys(returned).length === Object.keys(permissions).length &&
    Object.entries(permissions).every(
      ([name, value]) => (returned as Record<string, unknown>)[name] === value,
    ) &&
    (!Object.hasOwn(packet ?? {}, "repository_selection") ||
      packet?.repository_selection === "selected") &&
    Array.isArray(repositories) &&
    repositories.length === 1 &&
    repositories[0]?.id === Number(repositoryId) &&
    typeof repositories[0]?.full_name === "string" &&
    repositories[0].full_name.toLowerCase() === repository.toLowerCase();
  if (!validScope) {
    return { kind: "rejected", code: "scope-mismatch" };
  }
  if (
    typeof packet?.expires_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(packet.expires_at) ||
    !Number.isFinite(observedWallMs) ||
    !Number.isFinite(expiry) ||
    expiry <= observedWallMs + providerClockSkewMs ||
    expiry > observedWallMs + tokenLifetimeMs + providerClockSkewMs
  ) {
    return { kind: "rejected", code: "invalid-response" };
  }
  if (expiry - observedWallMs - providerClockSkewMs < minimumValidityMs) {
    return { kind: "rejected", code: "insufficient-validity" };
  }
  return {
    kind: "validated",
    credential,
    providerExpiresAt: expiry,
    usableUntil: expiry - providerClockSkewMs,
  };
}
