import { randomUUID } from "node:crypto";
import { isOAuthScopeToken } from "@openclaw-enterprise/contracts";
import type {
  OAuthConnectionAccessToken,
  OAuthConnectionGrant,
  OAuthConnectionRegistration,
  OAuthRefreshTokenRegistration,
  OAuthRefreshTokenIssuer,
  OAuthConnectionClient,
  OAuthAccountRef,
  TokenResolveOptions,
  OAuthConnectionStatus,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import {
  BrowserAuthorizationError,
  ResourceStateConflictError,
  refreshPinnedOAuthGrant,
  type PlatformStateStore,
  type ConnectionTokenCustody,
} from "@openclaw-enterprise/occ";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

type OAuthConnectionCustody = Pick<ConnectionTokenCustody, "sourceId" | "secret">;

const PENDING_OAUTH_CONNECTION = "pending";

type ClientRetry = "client_refused" | "client_unavailable" | "client_registration_mismatch";

type ApprovedGrant = OAuthConnectionGrant & OAuthConnectionRegistration;

type OAuthMaterial = ApprovedGrant & {
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
  grant: ApprovedGrant,
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
export class OAuthGrantStore {
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

  async reserve(ref: OAuthAccountRef): Promise<OAuthConnectionCustody> {
    const identity = {
      id: `sec_${randomUUID()}`,
      namespaceId: ref.namespaceId,
      name: "OAuth connection custody",
    };
    const backendRef = await this.secrets.create(identity, PENDING_OAUTH_CONNECTION);
    return {
      sourceId: ref.sourceId,
      secret: {
        ...identity,
        backendRef,
        driverId: this.secrets.id,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async storeInitialGrant(
    custody: OAuthConnectionCustody,
    grant: ApprovedGrant,
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

  observe(custody: OAuthConnectionCustody, signal: AbortSignal, minimumValidityMs?: number) {
    return this.driver(custody, signal).withValue!(custody.secret, async (value) => {
      signal.throwIfAborted();
      const stored = material(value, custody);
      return {
        status: status(stored),
        token:
          minimumValidityMs === undefined ? undefined : eligibleToken(stored, minimumValidityMs),
        phase: stored?.phase,
        version: stored && stored.phase !== "failed" ? stored.version : undefined,
        renewAt: stored && stored.phase !== "failed" ? Date.parse(stored.renewAt) : undefined,
        renewalDeadline:
          stored?.phase === "renewing" ? Date.parse(stored.renewalDeadline) : undefined,
      };
    });
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
      return fenced ? status(unknown) : (await this.observe(custody, signal)).status;
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
        : (await this.observe(custody, signal)).status;
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

  async delete(custody: OAuthConnectionCustody, signal: AbortSignal): Promise<void> {
    await this.driver(custody, signal).delete(custody.secret);
  }
}

function eligibleToken(
  stored: StoredConnection,
  minimumValidityMs: number,
): OAuthConnectionAccessToken | undefined {
  const now = Date.now();
  if (
    !stored ||
    (stored.phase !== "ready" && stored.phase !== "renewing") ||
    Date.parse(stored.expiresAt) <= now + minimumValidityMs ||
    (stored.phase === "renewing" && Date.parse(stored.renewalDeadline) <= now)
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
}

/** Resolves a saved account through its OCC record. Only this owner opens the private grant. */
export class OAuthAccountTokens implements OAuthRefreshTokenIssuer {
  readonly tokenKind = "oauth_refresh_token";

  private readonly grants: OAuthGrantStore;
  private readonly state: PlatformStateStore;
  private readonly client: (
    ref: OAuthAccountRef,
    approval?: OAuthRefreshTokenRegistration["approval"],
  ) => Promise<OAuthConnectionClient>;
  private readonly renewing = new Map<string, Promise<OAuthConnectionStatus>>();

  constructor(
    state: PlatformStateStore,
    secrets: SecretDriver,
    resolveClient: (
      ref: OAuthAccountRef,
      approval?: OAuthRefreshTokenRegistration["approval"],
    ) => Promise<OAuthConnectionClient>,
  ) {
    this.state = state;
    this.grants = new OAuthGrantStore(secrets, refreshPinnedOAuthGrant);
    this.client = resolveClient;
  }

  private custody(ref: OAuthAccountRef) {
    return this.state.read((view) =>
      view.savedConnections.findTokenCustody(ref.namespaceId, ref.sourceId),
    );
  }

  async register(input: OAuthRefreshTokenRegistration, signal: AbortSignal) {
    const { namespaceId, sourceId, approval, grant } = input;
    const ref: OAuthAccountRef = { kind: "oauth_refresh_token", namespaceId, sourceId };
    const { registration } = await this.client(ref, approval);
    let reserved: OAuthConnectionCustody | undefined;
    let custody: OAuthConnectionCustody;
    try {
      custody = await this.state.transact(async (unit) => {
        const source = await unit.credentialSources.lockCredentialSource(
          ref.namespaceId,
          ref.sourceId,
        );
        if (
          source?.ownerCapability !== "token_service" ||
          source.state !== "registering" ||
          (await unit.savedConnections.findTokenCustody(ref.namespaceId, ref.sourceId))
        ) {
          throw new ResourceStateConflictError(
            "A new pending account is required for token registration.",
          );
        }
        signal.throwIfAborted();
        reserved = await this.grants.reserve(ref);
        await unit.savedConnections.createTokenCustody({
          ...reserved,
          namespaceId: ref.namespaceId,
        });
        return reserved;
      });
    } catch (error) {
      // A lost COMMIT acknowledgement is ambiguous. Delete only a reservation we prove is unreferenced.
      if (reserved) {
        const candidate = reserved;
        await this.state
          .transact(async (unit) => {
            await unit.credentialSources.lockCredentialSource(ref.namespaceId, ref.sourceId);
            return unit.savedConnections.findTokenCustody(ref.namespaceId, ref.sourceId);
          })
          .then(async (published) => {
            if (published?.secret.id !== candidate.secret.id) {
              await this.grants.delete(candidate, AbortSignal.timeout(RENEWAL_BUDGET_MS));
            }
          })
          .catch(() => undefined);
      }
      throw error;
    }
    // The grant can only replace the durable reservation. If disconnect deleted it during
    // handoff, the Secret Driver's conditional write cannot recreate it.
    await this.grants.storeInitialGrant(
      custody,
      {
        ...registration,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt,
        requestedScopes: grant.requestedScopes,
        grantedScopes: grant.grantedScopes,
      },
      signal,
    );
    return ref;
  }

  async status(ref: OAuthAccountRef, signal: AbortSignal): Promise<OAuthConnectionStatus> {
    const custody = await this.custody(ref);
    return custody ? (await this.grants.observe(custody, signal)).status : { state: "pending" };
  }

  async retire(ref: OAuthAccountRef, signal: AbortSignal) {
    const custody = await this.custody(ref);
    if (custody) {
      await this.grants.delete(custody, signal);
    }
  }

  private activeCustody(ref: OAuthAccountRef) {
    return this.state.read(async (view) => {
      const source = await view.credentialSources.findCredentialSource(
        ref.namespaceId,
        ref.sourceId,
      );
      if (source?.ownerCapability !== "token_service" || source.state !== "ready") {
        return undefined;
      }
      const saved = await view.savedConnections.findSavedConnection(ref.namespaceId, ref.sourceId);
      if (!saved || saved.revocationRequestedBy !== undefined) {
        return undefined;
      }
      return view.savedConnections.findTokenCustody(ref.namespaceId, ref.sourceId);
    });
  }

  private renew(ref: OAuthAccountRef, custody: OAuthConnectionCustody, expectedVersion?: string) {
    const key = `${ref.namespaceId}/${ref.sourceId}`;
    const current = this.renewing.get(key);
    if (current) {
      return current;
    }
    // After sending a rotating grant, this owner must finish publishing even if one waiter leaves.
    const signal = AbortSignal.timeout(RENEWAL_BUDGET_MS);
    const attempt = this.grants
      .renew(custody, signal, () => this.client(ref), expectedVersion)
      .then(async (outcome) => {
        if (outcome.state === "pending") {
          return outcome;
        }
        await this.state.transact(async (unit) => {
          const source = await unit.credentialSources.lockCredentialSource(
            ref.namespaceId,
            ref.sourceId,
          );
          if (source?.state !== "ready") {
            return;
          }
          // Another replica may have advanced custody between the exchange and this schedule write.
          const actual = (await this.grants.observe(custody, signal)).status;
          if (actual.schedule || actual.state === "failed") {
            await unit.savedConnections.recordTokenSchedule(
              ref.namespaceId,
              ref.sourceId,
              actual.schedule
                ? {
                    scheduledVersion: actual.schedule.version,
                    nextRefreshAt: actual.schedule.nextRefreshAt,
                    grantedScopes: actual.schedule.grantedScopes,
                  }
                : "stopped",
            );
          }
        });
        return outcome;
      })
      .finally(() => this.renewing.delete(key));
    this.renewing.set(key, attempt);
    return attempt;
  }

  async maintain(ref: OAuthAccountRef, signal: AbortSignal) {
    const custody = await this.activeCustody(ref);
    signal.throwIfAborted();
    if (!custody) {
      return undefined;
    }
    return custody.due
      ? this.renew(ref, custody, custody.scheduledVersion)
      : (await this.grants.observe(custody, signal)).status;
  }

  async resolve(ref: OAuthAccountRef, options: TokenResolveOptions) {
    const { signal } = options;
    let firstVersion: string | undefined;
    while (!signal.aborted && Date.now() < Date.parse(options.deadlineAt)) {
      const custody = await this.activeCustody(ref);
      if (!custody || signal.aborted) {
        return undefined;
      }
      const current = await this.grants.observe(custody, signal, options.minimumValidityMs);
      if (!current.version || signal.aborted || Date.now() >= Date.parse(options.deadlineAt)) {
        return undefined;
      }
      if (current.token) {
        // Disconnect can commit while the Secret Driver reads an otherwise usable token.
        const active = await this.activeCustody(ref);
        if (
          !active ||
          active.secret.id !== custody.secret.id ||
          signal.aborted ||
          Date.now() >= Date.parse(options.deadlineAt)
        ) {
          return undefined;
        }
        if (Date.parse(current.token.expiresAt) <= Date.now() + options.minimumValidityMs) {
          continue;
        }
        if (current.phase === "ready" && current.renewAt! <= Date.now()) {
          // A failed wake leaves the durable schedule available to the worker.
          void this.renew(ref, custody, current.version).catch(() => undefined);
        }
        return current.token;
      }
      if (
        (firstVersion !== undefined && current.version !== firstVersion) ||
        (current.phase !== "ready" && current.phase !== "renewing" && current.renewAt! > Date.now())
      ) {
        return undefined;
      }
      firstVersion = current.version;
      if (current.renewalDeadline !== undefined && current.renewalDeadline > Date.now()) {
        // Another replica owns the conditional write. Observe its published result without replay.
        await delay(50, undefined, { signal });
      } else {
        const outcome = await this.renew(ref, custody, current.version);
        if (outcome.state === "failed") {
          return undefined;
        }
      }
    }
    return undefined;
  }
}
