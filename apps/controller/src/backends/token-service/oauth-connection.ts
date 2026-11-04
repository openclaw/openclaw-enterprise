import { randomUUID } from "node:crypto";
import { isOAuthScopeToken, PENDING_OAUTH_CONNECTION } from "@openclaw-enterprise/contracts";
import type {
  OAuthConnectionAccessToken,
  OAuthConnectionCustody,
  OAuthConnectionGrant,
  OAuthConnectionClient,
  OAuthConnectionTokenService,
  OAuthConnectionStatus,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import { BrowserAuthorizationError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { refreshPinnedOAuthGrant } from "../../drivers/credential-refresh/oauth-token-endpoint.ts";

type ClientRetry = "client_refused" | "client_unavailable" | "client_registration_mismatch";

type OAuthMaterial = OAuthConnectionGrant & {
  readonly sourceId: string;
  readonly namespaceId: string;
  readonly version: string;
  readonly renewAt: string;
} & (
    | { readonly phase: "ready" }
    | { readonly phase: ClientRetry }
    | { readonly phase: "renewing"; readonly renewalDeadline: string }
  );

interface FailedRefresh {
  readonly phase: "failed";
  readonly namespaceId: string;
  readonly sourceId: string;
  readonly failureCode: string;
}

// Includes both Secret Driver CAS operations and the issuer exchange. A provider HTTP deadline
// alone cannot distinguish an abandoned owner from a healthy one still committing a rotated grant.
const RENEWAL_BUDGET_MS = 5 * 60_000;

type StoredConnection = OAuthMaterial | FailedRefresh | undefined;

function material(value: string, custody: OAuthConnectionCustody): StoredConnection {
  if (value === PENDING_OAUTH_CONNECTION) {
    return undefined;
  }
  let data: Record<string, unknown> | undefined;
  try {
    data = asRecord(JSON.parse(value));
  } catch {
    // A JSON parser error can quote private bytes.
    throw new Error("Invalid OAuth token custody.");
  }
  if (data?.sourceId !== custody.sourceId || data.namespaceId !== custody.secret.namespaceId) {
    throw new Error("OAuth token custody belongs to another source.");
  }
  if (data.phase === "failed" && isNonEmptyString(data.failureCode)) {
    return data as unknown as FailedRefresh;
  }
  if (
    ![
      "ready",
      "renewing",
      "client_refused",
      "client_unavailable",
      "client_registration_mismatch",
    ].includes(String(data.phase)) ||
    ![
      "version",
      "issuer",
      "oauthClientId",
      "clientId",
      "tokenEndpointAuthMethod",
      "tokenUrl",
      "accessToken",
      "refreshToken",
      "expiresAt",
      "renewAt",
    ].every((key) => isNonEmptyString(data[key])) ||
    !Array.isArray(data.grantedScopes) ||
    !data.grantedScopes.every(isOAuthScopeToken) ||
    !Array.isArray(data.requestedScopes) ||
    !data.requestedScopes.every(isOAuthScopeToken) ||
    !["none", "client_secret_post", "client_secret_basic"].includes(
      String(data.tokenEndpointAuthMethod),
    ) ||
    Object.hasOwn(data, "clientSecret") ||
    !Number.isFinite(Date.parse(data.expiresAt as string)) ||
    !Number.isFinite(Date.parse(data.renewAt as string)) ||
    (data.phase === "renewing" &&
      (!isNonEmptyString(data.renewalDeadline) ||
        !Number.isFinite(Date.parse(data.renewalDeadline))))
  ) {
    throw new Error("Invalid OAuth token custody.");
  }
  return data as unknown as OAuthMaterial;
}

function ready(
  custody: OAuthConnectionCustody,
  grant: OAuthConnectionGrant,
  now = Date.now(),
): OAuthMaterial {
  const expires = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) {
    throw new BrowserAuthorizationError("access_token_expired", "retry");
  }
  // Begin renewal a minute before expiry, or halfway through a shorter token's lifetime.
  const renewAt = expires - Math.min(60_000, Math.ceil((expires - now) / 2));
  return {
    issuer: grant.issuer,
    oauthClientId: grant.oauthClientId,
    clientId: grant.clientId,
    tokenUrl: grant.tokenUrl,
    tokenEndpointAuthMethod: grant.tokenEndpointAuthMethod,
    ...(grant.resource === undefined ? {} : { resource: grant.resource }),
    requestedScopes: grant.requestedScopes,
    grantedScopes: grant.grantedScopes,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
    phase: "ready",
    sourceId: custody.sourceId,
    namespaceId: custody.secret.namespaceId,
    version: randomUUID(),
    renewAt: new Date(renewAt).toISOString(),
  };
}

function status(current: StoredConnection): OAuthConnectionStatus {
  if (!current) {
    return { state: "pending" };
  }
  if (current.phase === "failed") {
    const failureCode = current.failureCode;
    const recoveryAction = ["grant_refused", "refresh_outcome_unknown"].includes(failureCode)
      ? "reauthorize"
      : "fix_configuration";
    return { state: "failed", failureCode, recoveryAction };
  }
  if (current.phase === "renewing") {
    // Only a persisted terminal CAS can retire downstream delivery and its renewal schedule.
    return { state: "pending", expiresAt: current.expiresAt };
  }
  const schedule = {
    nextRefreshAt: current.renewAt,
    schedule: {
      version: current.version,
      nextRefreshAt: current.renewAt,
      grantedScopes: current.grantedScopes,
    },
    expiresAt: current.expiresAt,
  };
  if (current.phase !== "ready") {
    return {
      ...schedule,
      state: "failed",
      failureCode: current.phase,
      recoveryAction: current.phase === "client_unavailable" ? "retry" : "fix_configuration",
    };
  }
  return { ...schedule, state: Date.now() < Date.parse(current.expiresAt) ? "ready" : "pending" };
}

function retryClient(current: OAuthMaterial, phase: ClientRetry): OAuthMaterial {
  // A new version also fences an earlier due SQL schedule if its acknowledgement was lost.
  return {
    ...current,
    phase,
    version: randomUUID(),
    renewAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function failure(custody: OAuthConnectionCustody, failureCode: string): FailedRefresh {
  return {
    phase: "failed",
    namespaceId: custody.secret.namespaceId,
    sourceId: custody.sourceId,
    failureCode,
  };
}

/** Only the Token Service holds this private Secret. Its CAS fences refresh across API and worker replicas. */
export class OAuthConnectionTokens implements OAuthConnectionTokenService {
  private readonly secrets: SecretDriver;

  private readonly refreshGrant: typeof refreshPinnedOAuthGrant;

  constructor(secrets: SecretDriver, refreshGrant: typeof refreshPinnedOAuthGrant) {
    this.refreshGrant = refreshGrant;
    this.secrets = secrets;
  }

  private driver(custody: OAuthConnectionCustody, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      custody.secret.driverId !== this.secrets.id ||
      !this.secrets.withValue ||
      !this.secrets.compareAndSwap
    ) {
      throw new Error(
        "OAuth token custody requires its original Secret Driver with atomic updates.",
      );
    }
    return this.secrets;
  }

  async accept(
    custody: OAuthConnectionCustody,
    grant: OAuthConnectionGrant,
    signal: AbortSignal,
  ): Promise<void> {
    const driver = this.driver(custody, signal);
    if (
      !(await driver.compareAndSwap!(
        custody.secret,
        PENDING_OAUTH_CONNECTION,
        JSON.stringify(ready(custody, grant)),
      ))
    ) {
      throw new Error("The pending OAuth custody changed before the grant was committed.");
    }
  }

  async warm(
    custody: OAuthConnectionCustody,
    signal: AbortSignal,
  ): Promise<OAuthConnectionAccessToken | undefined> {
    return this.driver(custody, signal).withValue!(custody.secret, async (value) => {
      const stored = material(value, custody);
      signal.throwIfAborted();
      if (
        !stored ||
        (stored.phase !== "ready" && stored.phase !== "renewing") ||
        Date.parse(stored.expiresAt) <= Date.now() ||
        (stored.phase === "renewing" && Date.parse(stored.renewalDeadline) <= Date.now())
      ) {
        return undefined;
      }
      return {
        accessToken: stored.accessToken,
        grantedScopes: stored.grantedScopes,
        expiresAt: stored.expiresAt,
        version: stored.version,
        nextRefreshAt: stored.renewAt,
      };
    });
  }

  async status(
    custody: OAuthConnectionCustody,
    signal: AbortSignal,
  ): Promise<OAuthConnectionStatus> {
    return this.driver(custody, signal).withValue!(custody.secret, async (value) =>
      status(material(value, custody)),
    );
  }

  async renew(
    custody: OAuthConnectionCustody,
    signal: AbortSignal,
    resolveClient: () => Promise<OAuthConnectionClient>,
    scheduledVersion?: string,
  ): Promise<OAuthConnectionStatus> {
    const driver = this.driver(custody, signal);
    const previous = await driver.withValue!(custody.secret, async (value) => value);
    const current = material(previous, custody);
    const observed = status(current);
    if (!current || current.phase === "failed") {
      return observed;
    }
    if (current.phase === "renewing") {
      if (Date.now() < Date.parse(current.renewalDeadline)) {
        return observed;
      }
      // A lost issuer response may have rotated the grant. A final CAS fences the owner and
      // never replays its request. If its result already won, use that result for scheduling.
      const unknown = failure(custody, "refresh_outcome_unknown");
      const fenced = await driver.compareAndSwap!(
        custody.secret,
        previous,
        JSON.stringify(unknown),
      );
      return fenced ? status(unknown) : this.status(custody, signal);
    }
    // Recover an already renewed grant before consuming its refresh token again.
    const renewAfter =
      scheduledVersion === undefined || current.phase !== "ready"
        ? current.renewAt
        : current.expiresAt;
    if (current.version !== scheduledVersion && Date.parse(renewAfter) > Date.now()) {
      return observed;
    }
    // Authenticate the pinned registration before claiming the grant. A store failure here
    // is safe to retry because the issuer has received nothing.
    let clientSecret: string | undefined;
    try {
      const { registration, readSecret } = await resolveClient();
      if (
        current.oauthClientId !== registration.oauthClientId ||
        current.issuer !== registration.issuer ||
        current.clientId !== registration.clientId ||
        current.tokenUrl !== registration.tokenUrl ||
        current.tokenEndpointAuthMethod !== registration.tokenEndpointAuthMethod ||
        current.resource !== registration.resource
      ) {
        throw new BrowserAuthorizationError("client_registration_mismatch", "fix_configuration");
      }
      clientSecret =
        registration.tokenEndpointAuthMethod === "none" ? undefined : await readSecret?.(signal);
      if (registration.tokenEndpointAuthMethod !== "none" && !isNonEmptyString(clientSecret)) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
    } catch (error) {
      // No request reached the issuer. Preserve this grant and schedule a bounded retry,
      // including when a downstream credential store or the registration itself is unavailable.
      const phase =
        error instanceof BrowserAuthorizationError && error.code === "client_registration_mismatch"
          ? "client_registration_mismatch"
          : "client_unavailable";
      const next = retryClient(current, phase);
      return (await driver.compareAndSwap!(custody.secret, previous, JSON.stringify(next)))
        ? status(next)
        : this.status(custody, signal);
    }
    signal.throwIfAborted();
    const deadline = Date.now() + RENEWAL_BUDGET_MS;
    const intent = JSON.stringify({
      ...current,
      phase: "renewing",
      renewalDeadline: new Date(deadline).toISOString(),
    });
    if (!(await driver.compareAndSwap!(custody.secret, previous, intent))) {
      return { state: "pending" };
    }
    const remaining = deadline - Date.now();
    if (signal.aborted || remaining <= 0) {
      // The custody claim completed after cancellation. No issuer request was sent, so this
      // owner can restore the original grant if its intent still owns the Secret.
      await driver.compareAndSwap!(custody.secret, intent, previous);
      signal.throwIfAborted();
      return { state: "pending" };
    }
    let next: OAuthMaterial | FailedRefresh;
    try {
      const issued = await this.refreshGrant(
        current,
        AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
        clientSecret,
      );
      next = ready(custody, {
        ...current,
        ...issued,
        refreshToken: issued.refreshToken ?? current.refreshToken,
      });
    } catch (error) {
      // invalid_client rejects authentication before consuming the refresh grant. Keep it
      // for another attempt with the registration's current credential.
      next =
        error instanceof BrowserAuthorizationError && error.code === "client_refused"
          ? retryClient(current, "client_refused")
          : failure(
              custody,
              error instanceof BrowserAuthorizationError ? error.code : "refresh_outcome_unknown",
            );
    }
    if (Date.now() >= deadline) {
      next = failure(custody, "refresh_outcome_unknown");
    }
    // Publish the access token and any rotated refresh token together. Retirement or a new
    // owner winning this CAS prevents a late issuer response from reinstating its grant.
    if (!(await driver.compareAndSwap!(custody.secret, intent, JSON.stringify(next)))) {
      return { state: "pending" };
    }
    return status(next);
  }

  async retire(custody: OAuthConnectionCustody, signal: AbortSignal): Promise<void> {
    await this.driver(custody, signal).delete(custody.secret);
  }
}
