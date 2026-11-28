import { randomUUID } from "node:crypto";
import { isOAuthScopeToken } from "@openclaw-enterprise/contracts";
import type {
  OAuthCredentialSource,
  OAuthConnectionAccessToken,
  OAuthConnectionGrant,
  OAuthConnectionRegistration,
  OAuthConnectionClient,
  OAuthAccountRef,
  TokenResolveOptions,
  OAuthConnectionStatus,
  PrivateSecretRef,
  PrivateSecretStore,
} from "@openclaw-enterprise/contracts";
import {
  BrowserAuthorizationError,
  CredentialDeliveryFailedError,
  ResourceStateConflictError,
  refreshPinnedOAuthGrant,
  type PlatformStateStore,
  type OAuthTokenCustody,
} from "@openclaw-enterprise/occ";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { BUILTIN_CODEX_OAUTH_PRESET } from "./codex-oauth-preset.ts";

type OAuthConnectionCustody = Pick<OAuthTokenCustody, "sourceId" | "secret">;
type OAuthCustodyRef = OAuthAccountRef & { readonly secret: PrivateSecretRef };

type OAuthGrantRefresh = (
  grant: Parameters<typeof refreshPinnedOAuthGrant>[0],
  signal: AbortSignal,
  clientSecret: string | undefined,
) => Promise<
  | Awaited<ReturnType<typeof refreshPinnedOAuthGrant>>
  | {
      readonly refreshToken: string;
      readonly grantedScopes: readonly string[];
      readonly accessToken?: never;
      readonly expiresAt?: never;
    }
>;

interface OAuthIssuerClient extends OAuthConnectionClient {
  readonly refreshGrant?: OAuthGrantRefresh;
}

type ClientRetry = "client_refused" | "client_unavailable";

type ApprovedGrant = Pick<
  OAuthConnectionGrant,
  "accessToken" | "refreshToken" | "expiresAt" | "grantedScopes"
>;

type OAuthMaterial = ApprovedGrant & {
  readonly version: string;
  readonly renewAt: string;
} & (
    | { readonly phase: "ready" }
    | { readonly phase: "access_pending" }
    | { readonly phase: ClientRetry }
    | { readonly phase: "renewing" | "renewing_unavailable"; readonly renewalDeadline: string }
  );

interface FailedRefresh {
  readonly phase: "failed";
  readonly failureCode: string;
}

// Includes both Secret Driver CAS operations and the issuer exchange. A provider HTTP deadline
// alone cannot distinguish an abandoned owner from a healthy one still committing a rotated grant.
const RENEWAL_BUDGET_MS = 5 * 60_000;

type StoredConnection = OAuthMaterial | FailedRefresh;

function material(value: string): StoredConnection {
  let data: Record<string, unknown> | undefined;
  try {
    data = asRecord(JSON.parse(value));
  } catch {
    // A JSON parser error can quote private bytes.
    throw new Error("Invalid OAuth token custody.");
  }
  if (!data) {
    throw new Error("Invalid OAuth token custody.");
  }
  if (data.phase === "failed" && isNonEmptyString(data.failureCode)) {
    return data as unknown as FailedRefresh;
  }
  if (
    ![
      "ready",
      "access_pending",
      "renewing",
      "renewing_unavailable",
      "client_refused",
      "client_unavailable",
    ].includes(String(data.phase)) ||
    !["version", "accessToken", "refreshToken", "expiresAt", "renewAt"].every((key) =>
      isNonEmptyString(data[key]),
    ) ||
    !Array.isArray(data.grantedScopes) ||
    !data.grantedScopes.every(isOAuthScopeToken) ||
    Object.hasOwn(data, "clientSecret") ||
    !Number.isFinite(Date.parse(data.expiresAt as string)) ||
    !Number.isFinite(Date.parse(data.renewAt as string)) ||
    ((data.phase === "renewing" || data.phase === "renewing_unavailable") &&
      (!isNonEmptyString(data.renewalDeadline) ||
        !Number.isFinite(Date.parse(data.renewalDeadline))))
  ) {
    throw new Error("Invalid OAuth token custody.");
  }
  return data as unknown as OAuthMaterial;
}

function ready(
  grant: ApprovedGrant,
  now = Date.now(),
  version: string = randomUUID(),
): OAuthMaterial {
  const expires = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) {
    throw new BrowserAuthorizationError("access_token_expired", "retry");
  }
  // Begin renewal a minute before expiry, or halfway through a shorter token's lifetime.
  const renewAt = expires - Math.min(60_000, Math.ceil((expires - now) / 2));
  return {
    grantedScopes: grant.grantedScopes,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
    phase: "ready",
    version,
    renewAt: new Date(renewAt).toISOString(),
  };
}

function status(current: StoredConnection): OAuthConnectionStatus {
  if (current.phase === "failed") {
    const failureCode = current.failureCode;
    const recoveryAction = [
      "grant_refused",
      "grant_scope_mismatch",
      "refresh_outcome_unknown",
    ].includes(failureCode)
      ? "reauthorize"
      : "fix_configuration";
    return { state: "failed", failureCode, recoveryAction };
  }
  if (current.phase === "renewing" || current.phase === "renewing_unavailable") {
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
  if (current.phase === "access_pending") {
    return { ...schedule, state: "pending" };
  }
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

function failure(failureCode: string): FailedRefresh {
  return {
    phase: "failed",
    failureCode,
  };
}

/** The TokenService uses one private store. Its CAS fences refresh across API replicas. */
export class OAuthGrantStore {
  private readonly secrets: PrivateSecretStore;

  private readonly refreshGrant: typeof refreshPinnedOAuthGrant;

  constructor(secrets: PrivateSecretStore, refreshGrant: typeof refreshPinnedOAuthGrant) {
    this.refreshGrant = refreshGrant;
    this.secrets = secrets;
  }

  async create(custody: OAuthConnectionCustody, grant: ApprovedGrant, signal: AbortSignal) {
    signal.throwIfAborted();
    const initial = ready(grant);
    await this.secrets.create(custody.secret, JSON.stringify(initial));
    return {
      custody,
      schedule: {
        version: initial.version,
        nextRefreshAt: initial.renewAt,
        grantedScopes: initial.grantedScopes,
      },
    };
  }

  observe(custody: OAuthConnectionCustody, signal: AbortSignal, minimumValidityMs?: number) {
    signal.throwIfAborted();
    return this.secrets.withValue(custody.secret, async (value) => {
      signal.throwIfAborted();
      const stored = material(value);
      return {
        status: status(stored),
        token:
          minimumValidityMs === undefined ? undefined : eligibleToken(stored, minimumValidityMs),
        phase: stored.phase,
        version: stored.phase !== "failed" ? stored.version : undefined,
        renewAt: stored.phase !== "failed" ? Date.parse(stored.renewAt) : undefined,
        renewalDeadline:
          stored.phase === "renewing" || stored.phase === "renewing_unavailable"
            ? Date.parse(stored.renewalDeadline)
            : undefined,
      };
    });
  }

  async renew(
    custody: OAuthConnectionCustody,
    signal: AbortSignal,
    resolveClient: () => Promise<OAuthIssuerClient>,
    scheduledVersion?: string,
  ): Promise<OAuthConnectionStatus & { readonly credentialUpdated?: true }> {
    signal.throwIfAborted();
    const previous = await this.secrets.withValue(custody.secret, async (value) => value);
    const current = material(previous);
    const observed = status(current);
    if (current.phase === "failed") {
      return observed;
    }
    if (current.phase === "renewing" || current.phase === "renewing_unavailable") {
      if (Date.now() < Date.parse(current.renewalDeadline)) {
        return observed;
      }
      // A lost issuer response may have rotated the grant. A final CAS fences the owner and
      // never replays its request. If its result already won, use that result for scheduling.
      const unknown = failure("refresh_outcome_unknown");
      const fenced = await this.secrets.compareAndSwap(
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
    let registration: OAuthConnectionRegistration;
    let refreshGrant: OAuthGrantRefresh;
    try {
      const client = await resolveClient();
      registration = client.registration;
      refreshGrant =
        client.refreshGrant ??
        ((grant, tokenSignal, secret) =>
          this.refreshGrant(grant, tokenSignal, secret, client.fetchToken));
      const { readSecret } = client;
      clientSecret =
        registration.tokenEndpointAuthMethod === "none" ? undefined : await readSecret?.(signal);
      if (registration.tokenEndpointAuthMethod !== "none" && !isNonEmptyString(clientSecret)) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
    } catch {
      // No request reached the issuer. Preserve this grant and schedule a bounded retry,
      // including when a downstream credential store or the registration itself is unavailable.
      const next = retryClient(current, "client_unavailable");
      return (await this.secrets.compareAndSwap(custody.secret, previous, JSON.stringify(next)))
        ? status(next)
        : (await this.observe(custody, signal)).status;
    }
    signal.throwIfAborted();
    const deadline = Date.now() + RENEWAL_BUDGET_MS;
    const intent = JSON.stringify({
      ...current,
      phase: current.phase === "ready" ? "renewing" : "renewing_unavailable",
      renewalDeadline: new Date(deadline).toISOString(),
    });
    if (!(await this.secrets.compareAndSwap(custody.secret, previous, intent))) {
      return { state: "pending" };
    }
    const remaining = deadline - Date.now();
    if (signal.aborted || remaining <= 0) {
      // The custody claim completed after cancellation. No issuer request was sent, so this
      // owner can restore the original grant if its intent still owns the Secret.
      await this.secrets.compareAndSwap(custody.secret, intent, previous);
      signal.throwIfAborted();
      return { state: "pending" };
    }
    let next: OAuthMaterial | FailedRefresh;
    try {
      const issued = await refreshGrant(
        {
          ...registration!,
          refreshToken: current.refreshToken,
          grantedScopes: current.grantedScopes,
        },
        AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
        clientSecret,
      );
      const grant = {
        accessToken: issued.accessToken ?? current.accessToken,
        expiresAt: issued.expiresAt ?? current.expiresAt,
        grantedScopes: issued.grantedScopes,
        refreshToken: issued.refreshToken ?? current.refreshToken,
      };
      const partial = issued.accessToken === undefined;
      const now = Date.now();
      if (partial && (current.phase !== "ready" || Date.parse(grant.expiresAt) <= now)) {
        // Keep the rotated grant for retry without delivering unavailable or expired access.
        next = {
          ...grant,
          phase: "access_pending",
          version: current.version,
          renewAt: new Date(now + 60_000).toISOString(),
        };
      } else {
        next = ready(grant, now, partial ? current.version : undefined);
      }
    } catch (error) {
      // invalid_client rejects authentication before consuming the refresh grant. Keep it
      // for another attempt with the registration's current credential.
      next =
        error instanceof BrowserAuthorizationError && error.code === "client_refused"
          ? retryClient(current, "client_refused")
          : failure(
              error instanceof BrowserAuthorizationError ? error.code : "refresh_outcome_unknown",
            );
    }
    if (Date.now() >= deadline) {
      next = failure("refresh_outcome_unknown");
    }
    // Publish the access token and any rotated refresh token together. Retirement or a new
    // owner winning this CAS prevents a late issuer response from reinstating its grant.
    if (!(await this.secrets.compareAndSwap(custody.secret, intent, JSON.stringify(next)))) {
      return { state: "pending" };
    }
    return {
      ...status(next),
      ...(next.phase === "ready" &&
        next.version !== current.version && { credentialUpdated: true }),
    };
  }

  async delete(custody: OAuthConnectionCustody, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.secrets.delete(custody.secret);
  }
}

function eligibleToken(
  stored: StoredConnection,
  minimumValidityMs: number,
): OAuthConnectionAccessToken | undefined {
  const now = Date.now();
  if (
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
export class OAuthAccountTokens {
  private readonly grants: OAuthGrantStore;
  private readonly state: PlatformStateStore;
  private readonly client: (
    ref: OAuthAccountRef,
    registrationSource?: Readonly<OAuthCredentialSource>,
  ) => Promise<OAuthConnectionClient>;
  private readonly codexRefresh: OAuthGrantRefresh | undefined;
  private readonly notifyRenewed:
    ((ref: OAuthAccountRef, version: string, signal: AbortSignal) => Promise<void>) | undefined;
  private readonly renewing = new Map<string, Promise<OAuthConnectionStatus>>();
  private readonly role: "api" | "worker";

  constructor(
    state: PlatformStateStore,
    secrets: PrivateSecretStore,
    resolveClient: (
      ref: OAuthAccountRef,
      registrationSource?: Readonly<OAuthCredentialSource>,
    ) => Promise<OAuthConnectionClient>,
    codexRefresh?: OAuthGrantRefresh,
    notifyRenewed?: (ref: OAuthAccountRef, version: string, signal: AbortSignal) => Promise<void>,
    role: "api" | "worker" = "api",
  ) {
    this.state = state;
    this.grants = new OAuthGrantStore(secrets, refreshPinnedOAuthGrant);
    this.client = resolveClient;
    this.codexRefresh = codexRefresh;
    this.notifyRenewed = notifyRenewed;
    this.role = role;
  }

  private async custody(ref: OAuthCustodyRef) {
    const custody = await this.state.read((view) =>
      view.oauthCredentials.findTokenCustody(ref.namespaceId, ref.sourceId),
    );
    return this.checkCustody(ref, custody);
  }

  private checkCustody<T extends OAuthTokenCustody>(ref: OAuthCustodyRef, custody: T | undefined) {
    if (
      custody !== undefined &&
      (custody.secret.installationId !== ref.secret.installationId ||
        custody.secret.id !== ref.secret.id)
    ) {
      throw new ResourceStateConflictError("OAuth custody does not match its Source.");
    }
    return custody;
  }

  private async resolveClient(
    ref: OAuthAccountRef,
    registrationSource?: Readonly<OAuthCredentialSource>,
  ): Promise<OAuthIssuerClient> {
    const source =
      registrationSource ??
      (await this.state.read((view) =>
        view.credentialSources.findCredentialSource(ref.namespaceId, ref.sourceId),
      ));
    if (
      source?.ownerCapability !== "token_service" ||
      source.type !== "oauth2-refresh-token" ||
      source.id !== ref.sourceId ||
      source.namespaceId !== ref.namespaceId ||
      source.consent.revocationRequestedBy !== undefined
    ) {
      throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
    }
    if (source.consent.kind === "builtin_codex") {
      if (!this.codexRefresh) {
        throw new BrowserAuthorizationError("client_unavailable", "fix_configuration");
      }
      return {
        registration: { ...BUILTIN_CODEX_OAUTH_PRESET, tokenEndpointAuthMethod: "none" },
        refreshGrant: this.codexRefresh,
      };
    }
    // Only a Source being registered can reuse the callback's pre-exchange validation.
    // Saved Sources must revalidate their issuer before each renewal.
    return this.client(ref, registrationSource);
  }

  /** Publish the ready Source and its usable private grant as one database mutation. */
  async registerSource(
    ref: OAuthCustodyRef,
    source: OAuthCredentialSource,
    grant: OAuthConnectionGrant,
    signal: AbortSignal,
  ): Promise<OAuthCredentialSource> {
    await this.resolveClient(ref, source);
    const { custody, schedule } = await this.grants.create(
      { sourceId: ref.sourceId, secret: ref.secret },
      grant,
      signal,
    );
    try {
      signal.throwIfAborted();
      return await this.state.transact(async (unit) => {
        const namespace = await unit.namespaces.lockNamespace(source.namespaceId);
        if (namespace?.status !== "ready") {
          throw new ResourceStateConflictError("The credential source Namespace is not ready.");
        }
        const created = await unit.credentialSources.createCredentialSource(source);
        if (
          created.ownerCapability !== "token_service" ||
          created.type !== "oauth2-refresh-token"
        ) {
          throw new ResourceStateConflictError("The persisted OAuth Source is invalid.");
        }
        await unit.oauthCredentials.createTokenCustody({
          ...custody,
          namespaceId: source.namespaceId,
        });
        await unit.oauthCredentials.recordTokenSchedule(source.namespaceId, source.id, {
          scheduledVersion: schedule.version,
          nextRefreshAt: schedule.nextRefreshAt,
          grantedScopes: schedule.grantedScopes,
        });
        signal.throwIfAborted();
        return created;
      });
    } catch (error) {
      // A lost commit acknowledgement cannot justify deleting custody that the database owns.
      await this.custody(ref)
        .then(async (published) => {
          if (published === undefined) {
            await this.grants.delete(custody, AbortSignal.timeout(RENEWAL_BUDGET_MS));
          }
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async status(ref: OAuthCustodyRef, signal: AbortSignal): Promise<OAuthConnectionStatus> {
    const custody = await this.custody(ref);
    return custody ? (await this.grants.observe(custody, signal)).status : { state: "pending" };
  }

  async retire(ref: OAuthCustodyRef, signal: AbortSignal) {
    const custody = await this.custody(ref);
    if (custody) {
      await this.grants.delete(custody, signal);
    }
  }

  private activeCustody(ref: OAuthCustodyRef) {
    return this.state.read(async (view) => {
      const source = await view.credentialSources.findCredentialSource(
        ref.namespaceId,
        ref.sourceId,
      );
      if (source?.ownerCapability !== "token_service" || source.state !== "ready") {
        return undefined;
      }
      if (
        source.type !== "oauth2-refresh-token" ||
        source.consent.revocationRequestedBy !== undefined
      ) {
        return undefined;
      }
      return this.checkCustody(
        ref,
        await view.oauthCredentials.findTokenCustody(ref.namespaceId, ref.sourceId),
      );
    });
  }

  private renew(ref: OAuthAccountRef, custody: OAuthConnectionCustody, expectedVersion?: string) {
    const key = `${ref.namespaceId}/${ref.sourceId}`;
    const current = this.renewing.get(key);
    if (current) {
      return current.catch((error: unknown) => {
        throw error instanceof CredentialDeliveryFailedError
          ? new CredentialDeliveryFailedError(false)
          : error;
      });
    }
    // After sending a rotating grant, this owner must finish publishing even if one waiter leaves.
    const signal = AbortSignal.timeout(RENEWAL_BUDGET_MS);
    const attempt = this.grants
      .renew(custody, signal, () => this.resolveClient(ref), expectedVersion)
      .then(async ({ credentialUpdated, ...outcome }) => {
        if (outcome.state === "pending" && !outcome.schedule) {
          return outcome;
        }
        if (
          outcome.state === "ready" &&
          outcome.schedule !== undefined &&
          outcome.schedule.version !== expectedVersion &&
          this.notifyRenewed !== undefined
        ) {
          try {
            await this.notifyRenewed(ref, outcome.schedule.version, signal);
          } catch (error) {
            // Keep the old scheduled version due for redelivery of the committed grant.
            // Mark it only after a failed push, so a manual refresh does not wake a second sender.
            await this.state
              .transact(async ({ credentialSources, oauthCredentials }) => {
                const source = await credentialSources.lockCredentialSource(
                  ref.namespaceId,
                  ref.sourceId,
                );
                const schedule = await oauthCredentials.findTokenCustody(
                  ref.namespaceId,
                  ref.sourceId,
                );
                if (
                  source?.state === "ready" &&
                  schedule?.due === false &&
                  schedule.scheduledVersion === expectedVersion
                ) {
                  await oauthCredentials.recordTokenSchedule(ref.namespaceId, ref.sourceId, "due");
                }
              })
              .catch(() => undefined);
            throw error instanceof CredentialDeliveryFailedError
              ? new CredentialDeliveryFailedError(credentialUpdated === true)
              : error;
          }
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
            await unit.oauthCredentials.recordTokenSchedule(
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

  async refresh(ref: OAuthCustodyRef, signal: AbortSignal, mode: "forced" | "due" = "forced") {
    if (this.role === "worker") {
      throw new ResourceStateConflictError("OAuth renewal requires the API process.");
    }
    const custody = await this.activeCustody(ref);
    signal.throwIfAborted();
    if (!custody || (mode === "due" && !custody.due)) {
      return undefined;
    }
    return this.renew(ref, custody, custody.scheduledVersion);
  }

  async resolve(ref: OAuthCustodyRef, options: TokenResolveOptions) {
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
        if (!active || signal.aborted || Date.now() >= Date.parse(options.deadlineAt)) {
          return undefined;
        }
        if (Date.parse(current.token.expiresAt) <= Date.now() + options.minimumValidityMs) {
          continue;
        }
        if (this.role === "api" && current.phase === "ready" && current.renewAt! <= Date.now()) {
          // A failed wake leaves the durable schedule available to API maintenance.
          void this.renew(ref, custody, current.version).catch(() => undefined);
        }
        return current.token;
      }
      if (
        this.role === "worker" ||
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
        if (outcome.state === "failed" || (outcome.state === "pending" && outcome.schedule)) {
          return undefined;
        }
      }
    }
    return undefined;
  }
}
