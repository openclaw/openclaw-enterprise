import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { github } from "better-auth/social-providers";
import { authorizationCodeRequest, getOAuth2Tokens } from "better-auth/oauth2";
import type { DBAdapter, DBAdapterInstance } from "better-auth/adapters";
import {
  LOGIN_RECEIPT_LIFETIME_SECONDS,
  isBindingValue,
  loginAttemptId,
  receiptLedger,
  sessionBindingKey,
  signLoginReceipt,
  verifyLoginReceipt,
} from "./session-binding.ts";
import {
  knownDeviceAccountState,
  type PostgresHumanAuthentication,
  type HumanAuthenticationProof,
} from "@openclaw-enterprise/occ";
import {
  exchangeGoogleSubject,
  googleAuthorizationURL,
  googleNonce,
  type GoogleLoginConfiguration,
} from "./google.ts";
import {
  exchangeOidcSubject,
  oidcAuthorizationURL,
  oidcNonce,
  oidcProviderId,
  type OidcLoginConfiguration,
} from "./oidc.ts";
import {
  ProviderUnavailableError,
  providerExchangeFailure,
  providerJSON,
  providerMembership,
  rejected,
  type MembershipEndpoint,
  type ProviderExchange,
  type ProviderFailure,
} from "./provider-transport.ts";
import { admissionKey, keyedAdmission } from "./admission.ts";
import {
  issueKnownDevice,
  knownDeviceCookieAttributes,
  knownDeviceCookieName,
  knownDeviceFromCookieHeader,
} from "./known-device.ts";

/**
 * RFC-0061: the GitHub organizations and `org/team` slugs whose active members may sign in
 * with GitHub. Lowercased, without duplicates, present only when non-empty; absent means any
 * attached GitHub identity may sign in.
 */
export interface GitHubMembershipAllowlist {
  readonly allowedOrgs?: readonly string[];
  readonly allowedTeams?: readonly string[];
}

export interface GitHubLoginConfiguration extends GitHubMembershipAllowlist {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly recoveryUserId: string;
}

// GitHub organization logins (letters, digits, hyphens; up to 39) and team slugs. Every
// entry costs one or two GitHub requests per sign-in within the shared deadline.
const organizationPattern = /^[a-z0-9][a-z0-9-]{0,38}$/;
const teamSlugPattern = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const allowlistLimit = 10;

function allowlistEntries(
  value: string | undefined,
  name: string,
  valid: (entry: string) => boolean,
  shape: string,
): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  const entries = value.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.some((entry) => !valid(entry))) {
    throw new Error(`${name} must be a comma-separated list of ${shape}.`);
  }
  return [...new Set(entries)];
}

export function githubLoginConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubLoginConfiguration | undefined {
  const clientId = environment.OCC_AUTH_GITHUB_CLIENT_ID;
  const clientSecret = environment.OCC_AUTH_GITHUB_CLIENT_SECRET;
  const recoveryUserId = environment.OCC_AUTH_GITHUB_RECOVERY_USER_ID;
  const allowedOrgs = allowlistEntries(
    environment.OCC_AUTH_GITHUB_ALLOWED_ORGS,
    "OCC_AUTH_GITHUB_ALLOWED_ORGS",
    (entry) => organizationPattern.test(entry),
    "GitHub organization logins",
  );
  const allowedTeams = allowlistEntries(
    environment.OCC_AUTH_GITHUB_ALLOWED_TEAMS,
    "OCC_AUTH_GITHUB_ALLOWED_TEAMS",
    (entry) => {
      const parts = entry.split("/");
      return (
        parts.length === 2 && organizationPattern.test(parts[0]!) && teamSlugPattern.test(parts[1]!)
      );
    },
    "org/team-slug entries",
  );
  // The recovery user ID alone may belong to another provider; see humanLoginConfiguration.
  // An allowlist without the client is a configuration error, never a silent no-op.
  if (
    clientId === undefined &&
    clientSecret === undefined &&
    allowedOrgs.length === 0 &&
    allowedTeams.length === 0
  ) {
    return undefined;
  }
  if (
    typeof clientId !== "string" ||
    clientId.trim().length === 0 ||
    typeof clientSecret !== "string" ||
    clientSecret.trim().length === 0 ||
    typeof recoveryUserId !== "string" ||
    recoveryUserId.trim().length === 0
  ) {
    throw new Error("GitHub sign-in requires client ID, client secret and recovery user ID.");
  }
  if (allowedOrgs.length + allowedTeams.length > allowlistLimit) {
    throw new Error(
      `OCC_AUTH_GITHUB_ALLOWED_ORGS and OCC_AUTH_GITHUB_ALLOWED_TEAMS list at most ${allowlistLimit} entries together.`,
    );
  }
  return {
    clientId,
    clientSecret,
    recoveryUserId,
    ...(allowedOrgs.length === 0 ? {} : { allowedOrgs }),
    ...(allowedTeams.length === 0 ? {} : { allowedTeams }),
  };
}

interface ProviderClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

type GitHubClient = ProviderClient & GitHubMembershipAllowlist;

export interface HumanLoginProviders {
  readonly recoveryUserId: string;
  readonly github?: GitHubClient;
  readonly google?: GoogleLoginConfiguration;
  readonly oidc?: OidcLoginConfiguration;
  /** `recovery-only` admits only the recovery account's password; absent admits every one. */
  readonly passwordSignIn?: "recovery-only";
}

// What one external provider contributes to the shared start/callback/result flow.
interface ExternalProvider {
  readonly providerId: string;
  readonly attemptProviderId: string;
  readonly callbackURL: string;
  authorizationURL(secret: string, state: string, codeVerifier: string): Promise<URL>;
  exchange(
    secret: string,
    code: string,
    codeVerifier: string,
    state: string,
  ): Promise<ProviderExchange>;
}

/**
 * Error code of the 503 the curated password endpoint answers when a rejected password's
 * denial audit could not be written, so the controller still counts the guess.
 */
export const PASSWORD_DENIAL_AUDIT_UNAVAILABLE = "PASSWORD_DENIAL_AUDIT_UNAVAILABLE";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function secret(): string {
  return randomBytes(32).toString("base64url");
}
const tokenEndpoint = "https://github.com/login/oauth/access_token";
const profileEndpoint = "https://api.github.com/user";

// The audited callback denials whose code the controller turns into a Console reason.
export const MEMBERSHIP_DENIALS = ["MEMBERSHIP_REQUIRED", "MEMBERSHIP_UNAVAILABLE"] as const;
type MembershipDenial = (typeof MEMBERSHIP_DENIALS)[number];
export const CALLBACK_DENIALS = [...MEMBERSHIP_DENIALS, "ACCOUNT_DISABLED"] as const;

// GitHub logins are letters, digits and hyphens; older accounts may break today's hyphen rules.
const loginPattern = /^[A-Za-z0-9-]{1,39}$/;

function organizationMembershipEndpoint(organization: string): MembershipEndpoint {
  return `https://api.github.com/user/memberships/orgs/${encodeURIComponent(organization)}` as MembershipEndpoint;
}

function teamMembershipEndpoint(
  organization: string,
  team: string,
  login: string,
): MembershipEndpoint {
  return `https://api.github.com/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}` as MembershipEndpoint;
}

function membershipFailure(error: unknown, signal: AbortSignal): ProviderFailure {
  if (error instanceof ProviderUnavailableError) {
    return error.failure;
  }
  return { step: "membership", cause: signal.aborted ? "timeout" : "network" };
}

/**
 * RFC-0061: whether the person holding `headers`' user token is an active member of a listed
 * organization or team. Organizations are read first, in order; a team is read only for an
 * active member of its organization, so a non-member's team answer never needs interpreting.
 * The first match admits, even after another lookup failed. No match with a failed lookup is
 * unavailability, never "not a member".
 */
async function githubMembership(
  allowlist: GitHubMembershipAllowlist,
  headers: Readonly<Record<string, string>>,
  login: unknown,
  signal: AbortSignal,
): Promise<{ readonly admitted: boolean; readonly failure?: ProviderFailure }> {
  const organizations = new Map<string, boolean | ProviderUnavailableError>();
  let failure: ProviderFailure | undefined;
  async function activeIn(organization: string): Promise<boolean> {
    let known = organizations.get(organization);
    if (known === undefined) {
      try {
        known = await providerMembership(
          organizationMembershipEndpoint(organization),
          { headers },
          signal,
        );
      } catch (error) {
        known = new ProviderUnavailableError(membershipFailure(error, signal));
      }
      organizations.set(organization, known);
    }
    if (known instanceof ProviderUnavailableError) {
      throw known;
    }
    return known;
  }
  // Past the shared deadline every lookup would fail at once; record the timeout and stop.
  function expired(): boolean {
    if (signal.aborted) {
      failure ??= { step: "membership", cause: "timeout" };
    }
    return signal.aborted;
  }
  for (const organization of allowlist.allowedOrgs ?? []) {
    if (expired()) {
      break;
    }
    try {
      if (await activeIn(organization)) {
        return { admitted: true };
      }
    } catch (error) {
      failure ??= membershipFailure(error, signal);
    }
  }
  for (const entry of allowlist.allowedTeams ?? []) {
    if (expired()) {
      break;
    }
    const [organization, team] = entry.split("/") as [string, string];
    try {
      if (!(await activeIn(organization))) {
        continue;
      }
      if (typeof login !== "string" || !loginPattern.test(login)) {
        throw new ProviderUnavailableError({ step: "membership", cause: "malformed_response" });
      }
      if (
        await providerMembership(
          teamMembershipEndpoint(organization, team, login),
          { headers },
          signal,
        )
      ) {
        return { admitted: true };
      }
    } catch (error) {
      failure ??= membershipFailure(error, signal);
    }
  }
  return failure === undefined ? { admitted: false } : { admitted: false, failure };
}

function hasAllowlist(config: GitHubMembershipAllowlist): boolean {
  return (config.allowedOrgs?.length ?? 0) + (config.allowedTeams?.length ?? 0) > 0;
}

async function exchangeGithubSubject(
  config: GitHubClient,
  code: string,
  codeVerifier: string,
  redirectURI: string,
  deadlineMs = 10_000,
): Promise<ProviderExchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref();
  try {
    const request = await authorizationCodeRequest({
      code,
      codeVerifier,
      redirectURI,
      options: { clientId: config.clientId, clientSecret: config.clientSecret },
      tokenEndpoint,
    });
    const data = await providerJSON(
      tokenEndpoint,
      { method: "POST", ...request },
      controller.signal,
      "token",
    );
    if ("error" in data) {
      throw rejected();
    }
    const tokens = getOAuth2Tokens(data);
    if (typeof tokens.accessToken !== "string" || !tokens.accessToken) {
      throw rejected();
    }
    const headers = {
      authorization: `Bearer ${tokens.accessToken}`,
      "User-Agent": "OpenClaw-Enterprise",
      accept: "application/vnd.github+json",
    };
    const profile = await providerJSON(profileEndpoint, { headers }, controller.signal, "profile");
    controller.signal.throwIfAborted();
    const subject = githubSubject(profile.id);
    if (!subject) {
      throw rejected();
    }
    if (hasAllowlist(config)) {
      // Before the account lookup: a refusal says nothing about which OCE accounts exist.
      const membership = await githubMembership(config, headers, profile.login, controller.signal);
      if (!membership.admitted) {
        return membership.failure === undefined
          ? { denial: "MEMBERSHIP_REQUIRED", subject }
          : { denial: "MEMBERSHIP_UNAVAILABLE", subject, failure: membership.failure };
      }
    }
    return { subject };
  } catch (error) {
    // Never expose provider response bodies, token values or request credentials.
    return providerExchangeFailure(error, controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function cookieLifetime(createdAt: Date, expiresAt: Date, startedAt: number): number {
  // Subtract the entire call's elapsed time, conservatively covering the DB round trip.
  // Neither a controller clock adjustment nor DB/controller clock skew extends the cookie.
  const remaining = Math.floor(
    (expiresAt.getTime() - createdAt.getTime() - (performance.now() - startedAt)) / 1000,
  );
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw rejected();
  }
  return remaining;
}

function githubSubject(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) ? value : undefined;
}

/** The GitHub provider instance: a new client ID is a new instance. */
export function githubProviderId(config: Pick<ProviderClient, "clientId">): string {
  return `github:${digest(config.clientId)}`;
}

/** The Google provider instance: a new client ID is a new instance. */
export function googleProviderId(config: Pick<GoogleLoginConfiguration, "clientId">): string {
  return `google:${digest(config.clientId)}`;
}

function githubProvider(
  config: GitHubClient,
  baseURL: string,
  deadlineMs: number | undefined,
): ExternalProvider {
  const providerId = githubProviderId(config);
  const callbackURL = new URL("/api/auth/providers/github/callback", baseURL).href;
  const provider = github({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    disableDefaultScope: true,
  });
  return {
    providerId,
    attemptProviderId: `${providerId}:${digest(config.clientSecret)}`,
    callbackURL,
    authorizationURL: (_secret, state, codeVerifier) =>
      provider.createAuthorizationURL({ state, codeVerifier, redirectURI: callbackURL }),
    exchange: (_secret, code, codeVerifier) =>
      exchangeGithubSubject(config, code, codeVerifier, callbackURL, deadlineMs),
  };
}

function googleProvider(
  config: GoogleLoginConfiguration,
  baseURL: string,
  deadlineMs: number | undefined,
): ExternalProvider {
  const providerId = googleProviderId(config);
  const callbackURL = new URL("/api/auth/providers/google/callback", baseURL).href;
  return {
    providerId,
    attemptProviderId: `${providerId}:${digest(config.clientSecret)}`,
    callbackURL,
    // The nonce is recomputed from the callback's one-use state, binding the ID token to it.
    authorizationURL: (secret, state, codeVerifier) =>
      googleAuthorizationURL(config, state, codeVerifier, callbackURL, googleNonce(secret, state)),
    exchange: (secret, code, codeVerifier, state) =>
      exchangeGoogleSubject(
        config,
        code,
        codeVerifier,
        callbackURL,
        googleNonce(secret, state),
        deadlineMs,
      ),
  };
}

function oidcProvider(
  config: OidcLoginConfiguration,
  baseURL: string,
  deadlineMs: number | undefined,
): ExternalProvider {
  const providerId = oidcProviderId(config);
  const callbackURL = new URL("/api/auth/providers/oidc/callback", baseURL).href;
  return {
    providerId,
    attemptProviderId: `${providerId}:${digest(config.clientSecret)}`,
    callbackURL,
    authorizationURL: (secret, state, codeVerifier) =>
      oidcAuthorizationURL(config, state, codeVerifier, callbackURL, oidcNonce(secret, state)),
    exchange: (secret, code, codeVerifier, state) =>
      exchangeOidcSubject(
        config,
        code,
        codeVerifier,
        callbackURL,
        oidcNonce(secret, state),
        deadlineMs,
      ),
  };
}

export type ExternalProviderName = "github" | "google" | "oidc";

// Authorization codes are opaque and provider-sized; Entra ID's run past 1,024 characters.
const authorizationCodeLimit = 4096;

export interface HumanLoginAdmissionOptions {
  /**
   * True when `x-occ-client-ip` was resolved through a configured trusted proxy. Without
   * one it is the socket peer, which every browser behind an ingress shares, so the external
   * lanes key on the browser's own cookies instead of the address.
   */
  readonly trustedClientAddress?: boolean;
  /**
   * Receives one operational event per sign-in the provider could not serve. The event
   * carries only the provider instance and a bounded cause, never codes, tokens or users.
   */
  readonly onOperationalEvent?: (event: Readonly<Record<string, unknown>>) => void;
  /**
   * One deadline for each provider exchange's requests and body reads (default 10 s). The
   * server leaves it unset; tests shorten it so stalled-provider cases do not wait 10 s.
   */
  readonly providerDeadlineMs?: number;
  /**
   * Counts one callback refused before it matched a pending attempt. Such a callback is
   * unauthenticated, so it writes no audit event.
   */
  readonly onUnmatchedCallback?: (provider: ExternalProviderName) => void;
}

export function createHumanLogin(
  state: PostgresHumanAuthentication,
  config: HumanLoginProviders,
  baseURL: string,
  admission: HumanLoginAdmissionOptions = {},
) {
  if (config.github === undefined && config.google === undefined && config.oidc === undefined) {
    throw new Error("Guarded human sign-in requires a configured external sign-in provider.");
  }
  const { providerDeadlineMs } = admission;
  if (
    providerDeadlineMs !== undefined &&
    (!Number.isSafeInteger(providerDeadlineMs) || providerDeadlineMs < 1)
  ) {
    throw new Error("The external sign-in provider deadline must be a positive integer.");
  }
  const proofScope = new AsyncLocalStorage<{ proof?: HumanAuthenticationProof }>();
  const githubLogin =
    config.github === undefined
      ? undefined
      : githubProvider(config.github, baseURL, providerDeadlineMs);
  const googleLogin =
    config.google === undefined
      ? undefined
      : googleProvider(config.google, baseURL, providerDeadlineMs);
  const oidcLogin =
    config.oidc === undefined ? undefined : oidcProvider(config.oidc, baseURL, providerDeadlineMs);
  const secure = new URL(baseURL).protocol === "https:";
  const bindingCookie = secure ? "__Host-occ_login_attempt" : "occ_login_attempt";
  const receiptCookie = secure ? "__Host-occ_login_receipt" : "occ_login_receipt";
  const receiptAttributes = { httpOnly: true, secure, sameSite: "strict" as const, path: "/" };
  const receipts = receiptLedger();
  const cookieAttributes = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  const knownDeviceCookie = knownDeviceCookieName(secure);

  // A successful sign-in marks this browser as a known device for the account's email,
  // bound to the account's current sign-in state, keeping the browser's entries for up to
  // two other accounts.
  function knownDeviceValue(
    headers: Headers | undefined,
    authSecret: string,
    email: string,
    accountState: string,
  ): string {
    return issueKnownDevice(
      authSecret,
      email.trim().toLowerCase(),
      accountState,
      Date.now(),
      knownDeviceFromCookieHeader(headers?.get("cookie"), secure),
    );
  }

  // The state a known-device entry is bound to; a failed read only skips the marking.
  async function knownDeviceState(email: string): Promise<string | undefined> {
    try {
      return await state.knownDeviceState(email.trim().toLowerCase());
    } catch {
      return undefined;
    }
  }

  // The audit row records that the provider failed; the operator log says how.
  function providerUnavailable(
    provider: ExternalProvider,
    name: ExternalProviderName,
    failure: ProviderFailure | undefined,
  ): void {
    try {
      admission.onOperationalEvent?.({
        event: "authentication.provider-unavailable-warning",
        provider: name,
        providerId: provider.providerId,
        cause: failure?.cause ?? "network",
        ...(failure?.step === undefined ? {} : { step: failure.step }),
        ...(failure?.status === undefined ? {} : { status: failure.status }),
        ...(failure?.code === undefined ? {} : { code: failure.code }),
      });
    } catch {
      // Logging never changes the sign-in outcome.
    }
  }

  // Denials of a matched attempt say whether the provider or the identity failed.
  async function rejectExternal(
    provider: ExternalProviderName,
    reason: "EXTERNAL_IDENTITY_REJECTED" | "PROVIDER_UNAVAILABLE",
  ): Promise<never> {
    await state.recordDenied(reason, provider);
    throw rejected();
  }

  // A GitHub allowlist refusal names the authenticated subject in the audit and its reason in
  // the response code, which the controller turns into the Console's advice.
  async function refuseMembership(
    provider: ExternalProviderName,
    reason: MembershipDenial,
    subject: string,
  ): Promise<never> {
    await state.recordDenied(reason, provider, { subject });
    throw APIError.fromStatus("UNAUTHORIZED", {
      message: "Authentication was not accepted.",
      code: reason,
    });
  }

  // The provider authenticated this identity and it is attached to a disabled account. Only
  // that person reaches this answer (the attempt is bound to their browser), so telling them
  // reveals nothing to anyone else; the response code becomes the Console's reason.
  async function refuseDisabled(provider: ExternalProviderName, userId: string): Promise<never> {
    await state.recordDenied("ACCOUNT_DISABLED", provider, { userId });
    throw APIError.fromStatus("UNAUTHORIZED", {
      message: "Authentication was not accepted.",
      code: "ACCOUNT_DISABLED",
    });
  }

  // A malformed, unknown, replayed or expired attempt proves nothing about its sender, who
  // can mint state and cookie values freely, so it is counted and not audited.
  function refuseUnmatched(provider: ExternalProviderName): never {
    try {
      admission.onUnmatchedCallback?.(provider);
    } catch {
      // Counting never changes the sign-in outcome.
    }
    throw rejected();
  }

  function database(original: DBAdapterInstance): DBAdapterInstance {
    return (options) => {
      const adapter = original(options);
      const guarded: DBAdapter = {
        ...adapter,
        async create<T extends Record<string, unknown>, R = T>(input: {
          model: string;
          data: Omit<T, "id">;
          select?: string[] | undefined;
          forceAllowId?: boolean | undefined;
        }): Promise<R> {
          if (input.model !== "session") {
            return adapter.create<T, R>(input);
          }
          const scope = proofScope.getStore();
          const proof = scope?.proof;
          if (!scope || !proof) {
            throw rejected();
          }
          delete scope.proof;
          const data = input.data as Record<string, unknown>;
          if (data.userId !== proof.userId || typeof data.token !== "string") {
            throw rejected();
          }
          const session = {
            id: typeof data.id === "string" ? data.id : randomUUID(),
            userId: proof.userId,
            token: data.token,
            ipAddress: typeof data.ipAddress === "string" ? data.ipAddress : null,
            userAgent: typeof data.userAgent === "string" ? data.userAgent : null,
          };
          // The original State unit owns this commit, including the login audit.
          return (await state.issueSession(proof, session)) as R;
        },
        async findOne<T>(input: Parameters<DBAdapter["findOne"]>[0]): Promise<T | null> {
          if (input.model !== "session") {
            return adapter.findOne<T>(input);
          }
          const token = input.where.find((where) => where.field === "token")?.value;
          if (typeof token !== "string" || input.where.length !== 1) {
            return null;
          }
          return ((await state.currentSession(token)) ?? null) as T | null;
        },
        // Sessions are read only through State.currentSession, one token at a time. Listing or
        // counting raw rows would surface sessions that State rejects (revoked, disabled, stale).
        async findMany<T>(input: Parameters<DBAdapter["findMany"]>[0]): Promise<T[]> {
          if (input.model === "session") {
            return [];
          }
          return adapter.findMany<T>(input);
        },
        async count(input) {
          if (input.model === "session") {
            return 0;
          }
          return adapter.count(input);
        },
        async consumeOne<T>(input: Parameters<DBAdapter["consumeOne"]>[0]): Promise<T | null> {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.consumeOne<T>(input);
        },
        async incrementOne<T>(input: Parameters<DBAdapter["incrementOne"]>[0]): Promise<T | null> {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.incrementOne<T>(input);
        },
        async update(input) {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.update(input);
        },
        async updateMany(input) {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.updateMany(input);
        },
        async delete(input) {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.delete(input);
        },
        async deleteMany(input) {
          if (input.model === "session") {
            throw rejected();
          }
          return adapter.deleteMany(input);
        },
        async transaction() {
          // Curated login uses State transactions; library transactions must not bypass its gate.
          throw APIError.fromStatus("SERVICE_UNAVAILABLE", {
            message: "Unsupported auth transaction.",
          });
        },
      };
      return guarded;
    };
  }

  // Password sign-in is admitted by the controller's failure-counting admission before it
  // reaches /oce/password (see index.ts), as in the password-only profile.
  //
  // External sign-in: start, callback and result each keep their own single-controller budget
  // (a bounded table of hashed keys, 30 per minute and four active per key, eight active per
  // step), so one sign-in spends one unit of each and junk requests at one step cannot starve
  // another. Every provider shares these budgets, so enabling another does not raise them.
  // Behind a trusted proxy the key is the client address. Without one the address is shared
  // by every browser behind the ingress, so it is never a key: callback and result key on the
  // browser's own attempt and receipt cookies, which a stranger cannot spend, and start (which
  // has no browser state yet) is bounded by its concurrency cap and State's pending-attempt
  // capacity instead of an Installation-wide budget.
  const externalBudget = { perMinute: 30, concurrent: 4 } as const;
  const externalGlobal = { concurrent: 8 } as const;
  const admitStart = keyedAdmission(externalBudget, externalGlobal);
  const admitCallback = keyedAdmission(externalBudget, externalGlobal);
  const admitResult = keyedAdmission(externalBudget, externalGlobal);
  const trustedClientAddress = admission.trustedClientAddress === true;
  // `browserCookie` is the attempt or receipt cookie; start has none yet.
  function externalKeys(
    headers: Headers | undefined,
    browserCookie?: () => string | null | undefined,
  ): string[] {
    if (trustedClientAddress) {
      return [admissionKey("ip", headers?.get("x-occ-client-ip"))];
    }
    return browserCookie === undefined ? [] : [admissionKey("browser", browserCookie())];
  }
  let recoveryEmail: string | undefined;
  const recoveryOnly = config.passwordSignIn === "recovery-only";
  function designateRecovery(email: string): void {
    recoveryEmail = email.trim().toLowerCase();
  }
  // Start, callback and result for one external provider. Every provider shares the
  // admission budget, the browser-bound attempt and receipt cookies, PKCE and session binding.
  function externalProviderEndpoints(name: ExternalProviderName, provider: ExternalProvider) {
    return {
      start: createAuthEndpoint(`/oce/providers/${name}/start`, { method: "POST" }, async (ctx) =>
        admitStart.admit(externalKeys(ctx.headers), async () => {
          const attemptState = secret();
          const browser = secret();
          const codeVerifier = secret();
          const startedAt = performance.now();
          const attempt = await state.createAttempt({
            stateHash: digest(attemptState),
            browserHash: digest(browser),
            providerId: provider.attemptProviderId,
            callbackURL: provider.callbackURL,
            codeVerifier,
          });
          const url = await provider.authorizationURL(
            ctx.context.secret,
            attemptState,
            codeVerifier,
          );
          const maxAge = cookieLifetime(attempt.createdAt, attempt.expiresAt, startedAt);
          ctx.setCookie(bindingCookie, browser, {
            ...cookieAttributes,
            maxAge,
          });
          return ctx.json({
            url: url.href,
            attemptId: loginAttemptId(ctx.context.secret, digest(attemptState)),
          });
        }),
      ),
      callback: createAuthEndpoint(
        `/oce/providers/${name}/callback`,
        { method: "GET", requireRequest: true },
        async (ctx) =>
          admitCallback.admit(
            externalKeys(ctx.headers, () => ctx.getCookie(bindingCookie)),
            async () => {
              const parameters = new URL(ctx.request!.url).searchParams;
              const stateValue = parameters.get("state");
              const code = parameters.get("code");
              const error = parameters.get("error");
              const browser = ctx.getCookie(bindingCookie);
              if (
                parameters.getAll("state").length !== 1 ||
                parameters.getAll("code").length > 1 ||
                parameters.getAll("error").length > 1 ||
                !stateValue ||
                !/^[A-Za-z0-9_-]{43}$/.test(stateValue) ||
                !browser ||
                !/^[A-Za-z0-9_-]{43}$/.test(browser) ||
                (!error && (!code || code.length > authorizationCodeLimit)) ||
                (error && (error.length > 200 || code))
              ) {
                return refuseUnmatched(name);
              }
              const attempt = await state.consumeAttempt({
                stateHash: digest(stateValue),
                browserHash: digest(browser),
                providerId: provider.attemptProviderId,
                callbackURL: provider.callbackURL,
              });
              if (!attempt) {
                return refuseUnmatched(name);
              }
              if (error) {
                // RFC 6749 section 4.1.2.1: the provider reports its own failure.
                if (error === "server_error" || error === "temporarily_unavailable") {
                  providerUnavailable(provider, name, {
                    step: "authorization",
                    cause: "provider_error",
                  });
                  return rejectExternal(name, "PROVIDER_UNAVAILABLE");
                }
                return rejectExternal(name, "EXTERNAL_IDENTITY_REJECTED");
              }
              ctx.setCookie(bindingCookie, "", { ...cookieAttributes, maxAge: 0 });
              const exchange = await provider.exchange(
                ctx.context.secret,
                code!,
                attempt.codeVerifier,
                stateValue,
              );
              if ("denial" in exchange) {
                if (
                  exchange.denial === "PROVIDER_UNAVAILABLE" ||
                  exchange.denial === "MEMBERSHIP_UNAVAILABLE"
                ) {
                  providerUnavailable(provider, name, exchange.failure);
                }
                if (
                  exchange.denial === "MEMBERSHIP_REQUIRED" ||
                  exchange.denial === "MEMBERSHIP_UNAVAILABLE"
                ) {
                  return refuseMembership(name, exchange.denial, exchange.subject);
                }
                return rejectExternal(name, exchange.denial);
              }
              const snapshot = await state.snapshotExternal(
                provider.providerId,
                exchange.subject,
                attempt.createdAt,
              );
              if (!snapshot) {
                return rejectExternal(name, "EXTERNAL_IDENTITY_REJECTED");
              }
              if ("disabled" in snapshot) {
                return refuseDisabled(name, snapshot.userId);
              }
              const startedAt = performance.now();
              const session = await proofScope.run({ proof: snapshot.proof }, () =>
                ctx.context.internalAdapter.createSession(snapshot.user.id, false),
              );
              if (!session) {
                throw rejected();
              }
              const maxAge = cookieLifetime(session.createdAt, session.expiresAt, startedAt);
              await setSessionCookie(ctx, { session, user: snapshot.user }, false, {
                maxAge,
              });
              // An external sign-in also marks the browser, for password fallback. An
              // account without a password has no fallback to mark.
              const deviceState = await knownDeviceState(snapshot.user.email);
              if (deviceState !== undefined) {
                ctx.setCookie(
                  knownDeviceCookie,
                  knownDeviceValue(
                    ctx.headers,
                    ctx.context.secret,
                    snapshot.user.email,
                    deviceState,
                  ),
                  knownDeviceCookieAttributes(secure),
                );
              }
              // The redirect carries no secret. The starting tab exchanges this
              // receipt for the key of exactly the session this attempt created.
              ctx.setCookie(
                receiptCookie,
                signLoginReceipt(ctx.context.secret, {
                  providerId: provider.providerId,
                  sessionId: session.id,
                  attemptId: loginAttemptId(ctx.context.secret, digest(stateValue)),
                  expiresAt: Date.now() + LOGIN_RECEIPT_LIFETIME_SECONDS * 1000,
                }),
                { ...receiptAttributes, maxAge: LOGIN_RECEIPT_LIFETIME_SECONDS },
              );
              return ctx.json({ authenticated: true });
            },
          ),
      ),
      result: createAuthEndpoint(`/oce/providers/${name}/result`, { method: "POST" }, async (ctx) =>
        admitResult.admit(
          externalKeys(ctx.headers, () => ctx.getCookie(receiptCookie)),
          async () => {
            const body = ctx.body as { attemptId?: unknown } | undefined;
            const now = Date.now();
            const receipt = verifyLoginReceipt(
              ctx.context.secret,
              ctx.getCookie(receiptCookie),
              provider.providerId,
              now,
            );
            if (
              !receipt ||
              !isBindingValue(body?.attemptId) ||
              body.attemptId !== receipt.attemptId
            ) {
              throw rejected();
            }
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            const current = token ? await state.currentSession(token) : undefined;
            // The receipt names the session its callback created. A cookie replaced by
            // another sign-in, or a revoked session, cannot adopt this attempt's key.
            if (!current || current.id !== receipt.sessionId || !receipts.consume(receipt, now)) {
              throw rejected();
            }
            ctx.setCookie(receiptCookie, "", { ...receiptAttributes, maxAge: 0 });
            // This exchange neither issues nor extends a session.
            return ctx.json({ sessionKey: sessionBindingKey(ctx.context.secret, current.id) });
          },
        ),
      ),
    };
  }
  const githubEndpoints =
    githubLogin === undefined ? undefined : externalProviderEndpoints("github", githubLogin);
  const googleEndpoints =
    googleLogin === undefined ? undefined : externalProviderEndpoints("google", googleLogin);
  const oidcEndpoints =
    oidcLogin === undefined ? undefined : externalProviderEndpoints("oidc", oidcLogin);
  // A rejected password is audited before the refusal. When the audit write fails the
  // answer is 503 (audits fail closed), marked so admission still spends the budget.
  async function refusePassword(): Promise<never> {
    try {
      await state.recordDenied("INVALID_CREDENTIALS");
    } catch {
      throw APIError.fromStatus("SERVICE_UNAVAILABLE", {
        message: "Authentication dependency unavailable.",
        code: PASSWORD_DENIAL_AUDIT_UNAVAILABLE,
      });
    }
    throw rejected();
  }
  const plugin = {
    id: "oce-human-login",
    endpoints: {
      ocePassword: createAuthEndpoint("/oce/password", { method: "POST" }, async (ctx) => {
        const body = ctx.body as { email?: unknown; password?: unknown } | undefined;
        if (
          typeof body?.email !== "string" ||
          body.email.length > 254 ||
          typeof body.password !== "string"
        ) {
          throw rejected();
        }
        // Reached only through the controller's sign-in route, which admits it first.
        const email = body.email.trim().toLowerCase();
        const password = body.password;
        if (password.length < 12 || password.length > 128) {
          throw rejected();
        }
        if (recoveryOnly && (recoveryEmail === undefined || email !== recoveryEmail)) {
          // Ordinary accounts sign in with their external identity. The refusal is the
          // bad-credential answer and reads no account, so it is the same for every
          // email other than the recovery one, whether or not an account exists.
          await ctx.context.password.hash(password);
          return refusePassword();
        }
        const snapshot = await state.snapshotPassword(email);
        if (!snapshot?.proof.passwordHash) {
          await ctx.context.password.hash(password);
          return refusePassword();
        }
        if (
          !(await ctx.context.password.verify({
            password,
            hash: snapshot.proof.passwordHash,
          }))
        ) {
          return refusePassword();
        }
        const startedAt = performance.now();
        const session = await proofScope.run({ proof: snapshot.proof }, () =>
          ctx.context.internalAdapter.createSession(snapshot.user.id, false),
        );
        if (!session) {
          throw rejected();
        }
        const maxAge = cookieLifetime(session.createdAt, session.expiresAt, startedAt);
        await setSessionCookie(ctx, { session, user: snapshot.user }, false, {
          maxAge,
        });
        // The proof's versions were rechecked when the session was issued, so the entry
        // is bound to the account state this sign-in proved.
        ctx.setCookie(
          knownDeviceCookie,
          knownDeviceValue(
            ctx.headers,
            ctx.context.secret,
            email,
            knownDeviceAccountState(snapshot.proof),
          ),
          knownDeviceCookieAttributes(secure),
        );
        return ctx.json({
          authenticated: true,
          sessionKey: sessionBindingKey(ctx.context.secret, session.id),
        });
      }),
      oceSignOut: createAuthEndpoint(
        "/oce/sign-out",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          if (token) {
            await state.revokeSession(token);
          }
          deleteSessionCookie(ctx);
          return ctx.json({ success: true });
        },
      ),
      ...(githubEndpoints === undefined
        ? {}
        : {
            oceGithubStart: githubEndpoints.start,
            oceGithubCallback: githubEndpoints.callback,
            oceGithubResult: githubEndpoints.result,
          }),
      ...(googleEndpoints === undefined
        ? {}
        : {
            oceGoogleStart: googleEndpoints.start,
            oceGoogleCallback: googleEndpoints.callback,
            oceGoogleResult: googleEndpoints.result,
          }),
      ...(oidcEndpoints === undefined
        ? {}
        : {
            oceOidcStart: oidcEndpoints.start,
            oceOidcCallback: oidcEndpoints.callback,
            oceOidcResult: oidcEndpoints.result,
          }),
    },
  } satisfies BetterAuthPlugin;
  return {
    plugin,
    database,
    ...(githubLogin === undefined ? {} : { githubProviderId: githubLogin.providerId }),
    ...(googleLogin === undefined ? {} : { googleProviderId: googleLogin.providerId }),
    ...(oidcLogin === undefined || config.oidc === undefined
      ? {}
      : {
          oidcProviderId: oidcLogin.providerId,
          oidcSignIn: {
            label: config.oidc.displayName,
            authorizationUrl: config.oidc.authorizationUrl,
          },
        }),
    designateRecovery,
    /** Whether `email` (normalized) is the recovery account's; its password stays reserved. */
    isRecoveryEmail: (email: string) => recoveryEmail !== undefined && email === recoveryEmail,
    /** Whether the known-device cookie uses its host-only (__Host-) name. */
    knownDeviceSecure: secure,
    /** The account state known-device entries are bound to (see known-device.ts). */
    knownDeviceState: (email: string) => state.knownDeviceState(email),
    passwordSignIn: recoveryOnly ? ("recovery-only" as const) : ("all" as const),
  };
}
