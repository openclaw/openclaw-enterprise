import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import { APIError, betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { splitSetCookieHeader } from "better-auth/cookies";
import { hashPassword } from "better-auth/crypto";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { apiKey } from "@better-auth/api-key";
import type { ApiKey } from "@better-auth/api-key/types";
import { parse as parseDomain } from "tldts";
import type { ServicePrincipal } from "@openclaw-enterprise/contracts";
import {
  NativeIAMDriver,
  createAuthPrincipalSeed,
  type AuthPrincipalSeed,
  type AuthPrincipalSeedOptions,
} from "@openclaw-enterprise/iam";
import {
  PostgresCliSessions,
  PostgresHumanAuthentication,
  PostgresPlatformState,
  ScopeViolationError,
  type HumanAuthenticationActivation,
  type HumanAuthenticationActivationHooks,
  type HumanAuthenticationActor,
  type HumanAuthenticationRecovery,
  type HumanAuthenticationAccount,
  createPostgresAuthBinding,
  type SchemaAuthPoolV1,
  type SchemaAuthAdapterOptionsV1,
  type PreparedPasswordAccount,
} from "@openclaw-enterprise/occ";
import type { IAMDriver } from "@openclaw-enterprise/contracts";
import {
  createHumanLogin,
  githubLoginConfiguration,
  githubProviderId,
  googleProviderId,
  type GitHubLoginConfiguration,
  CALLBACK_DENIALS,
  PASSWORD_DENIAL_AUDIT_UNAVAILABLE,
} from "./github.ts";
import type { ExternalProviderName } from "./github.ts";
import { googleLoginConfiguration, type GoogleSignInConfiguration } from "./google.ts";
import { oidcLoginConfiguration, oidcProviderId, type OidcSignInConfiguration } from "./oidc.ts";
import { sessionBindingKey, sessionKeyHeader, sessionKeyMatches } from "./session-binding.ts";
import {
  DEFAULT_CLI_SESSION_SETTINGS,
  cliSessionHeader,
  createCliSignIn,
  type CliSessionSettings,
  type CliSessionStore,
  type CliSignIn,
} from "./cli-sign-in.ts";
import { resolveClientAddress, type ClientAddressConfiguration } from "./client-address.ts";
import {
  SignInRateLimited,
  keyedAdmission,
  admissionKey,
  passwordFailureAdmission,
  passwordFailureBudget,
  type PasswordSignInAdmission,
  type PasswordSlowLaneOptions,
} from "./admission.ts";
import {
  issueKnownDevice,
  knownDeviceFromCookieHeader,
  knownDeviceSetCookie,
  verifyKnownDevice,
  type KnownDeviceAccountState,
} from "./known-device.ts";

export { githubLoginConfiguration, type GitHubLoginConfiguration } from "./github.ts";
export {
  googleLoginConfiguration,
  type GoogleLoginConfiguration,
  type GoogleSignInConfiguration,
} from "./google.ts";
export {
  oidcLoginConfiguration,
  type OidcLoginConfiguration,
  type OidcSignInConfiguration,
} from "./oidc.ts";

/**
 * Who may sign in with a password in the guarded profile: every enrolled account
 * (`all`, the default) or only the recovery account (`recovery-only`).
 */
export type PasswordSignInPolicy = "all" | "recovery-only";

/** The slow-lane floors a composition may shorten or observe (see `passwordSlowLaneFloors`). */
export type PasswordSlowLaneFloors = Pick<
  PasswordSlowLaneOptions,
  "floorMs" | "maxFloorMs" | "waitFloor"
>;

export interface HumanLoginConfiguration {
  readonly github?: GitHubLoginConfiguration;
  readonly google?: GoogleSignInConfiguration;
  readonly oidc?: OidcSignInConfiguration;
  /** Set only for `recovery-only`; absent means every enrolled account keeps its password. */
  readonly passwordSignIn?: "recovery-only";
}

/** Parses OCC_AUTH_PASSWORD_SIGN_IN; empty or unset keeps the default, `all`. */
export function passwordSignInPolicy(
  environment: Readonly<Record<string, string | undefined>>,
): PasswordSignInPolicy {
  const value = environment.OCC_AUTH_PASSWORD_SIGN_IN?.trim() ?? "";
  if (value === "" || value === "all") {
    return "all";
  }
  if (value === "recovery-only") {
    return value;
  }
  throw new Error("OCC_AUTH_PASSWORD_SIGN_IN must be all or recovery-only.");
}

/**
 * Parses every external sign-in provider. The recovery user ID (still named
 * OCC_AUTH_GITHUB_RECOVERY_USER_ID) seeds the guarded profile, so it is required exactly
 * when at least one provider is configured. Recovery-only password sign-in needs a
 * provider: without one it would leave only the recovery account able to sign in.
 */
export function humanLoginConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): HumanLoginConfiguration {
  const github = githubLoginConfiguration(environment);
  const google = googleLoginConfiguration(environment);
  const oidc = oidcLoginConfiguration(environment);
  const recoveryUserId = environment.OCC_AUTH_GITHUB_RECOVERY_USER_ID;
  const passwordSignIn = passwordSignInPolicy(environment);
  if (github === undefined && google === undefined && oidc === undefined) {
    if (recoveryUserId !== undefined) {
      throw new Error(
        "External sign-in requires client ID, client secret and recovery user ID for GitHub, Google or OIDC.",
      );
    }
    if (passwordSignIn !== "all") {
      throw new Error(
        "OCC_AUTH_PASSWORD_SIGN_IN=recovery-only requires GitHub, Google or OIDC sign-in.",
      );
    }
    return {};
  }
  const recoveryMissing = recoveryUserId === undefined || recoveryUserId.trim().length === 0;
  if (google !== undefined && recoveryMissing) {
    throw new Error("Google sign-in requires client ID, client secret and recovery user ID.");
  }
  if (oidc !== undefined && recoveryMissing) {
    throw new Error("OIDC sign-in requires its provider settings and a recovery user ID.");
  }
  return {
    ...(github === undefined ? {} : { github }),
    ...(google === undefined ? {} : { google: { ...google, recoveryUserId: recoveryUserId! } }),
    ...(oidc === undefined ? {} : { oidc: { ...oidc, recoveryUserId: recoveryUserId! } }),
    ...(passwordSignIn === "all" ? {} : { passwordSignIn }),
  };
}
export {
  clientAddressConfiguration,
  resolveClientAddress,
  type ClientAddressConfiguration,
} from "./client-address.ts";
import type {
  AdmissionHeaders,
  AdmissionRequest,
  AdmissionVerifier,
  AdmittedCaller,
  AdmittedSession,
} from "../admission/admission-verifier.ts";
import { AdmissionFailure, UNTRUSTED_ORIGIN_MESSAGE } from "../admission/admission-verifier.ts";
import { betterAuthIssuer, validHttpBaseURL } from "./configuration.ts";

export { betterAuthIssuer, OCC_BETTER_AUTH_ISSUER_PREFIX } from "./configuration.ts";
export {
  CLI_SESSION_HEADER,
  cliSessionSettings,
  DEFAULT_CLI_SESSION_SETTINGS,
  type CliSessionSettings,
  type CliSignIn,
} from "./cli-sign-in.ts";

export const OCC_AUTH_COOKIE_PREFIX = "openclaw_occ";
const LOCAL_PASSWORD_MIN_LENGTH = 12;
const LOCAL_PASSWORD_MAX_LENGTH = 128;
export const OCC_SHARED_AUTH_COOKIE_PREFIX = "openclaw_occ_shared";
export const OCC_SERVICE_KEY_HEADER = "x-api-key";
const SERVICE_KEY_CONFIG = "occ-service";
const SAFE_COOKIE_DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
type ControllerPlugins = (
  ReturnType<typeof apiKey> | ReturnType<typeof createHumanLogin>["plugin"]
)[];
type ControllerBetterAuth = Auth<BetterAuthOptions & { plugins: ControllerPlugins }>;

export interface ServiceKey {
  readonly id: string;
  readonly servicePrincipalId: string;
  readonly namespaceId?: string;
  readonly name: string;
  readonly expiresAt: string;
}

export interface ControllerAuthOptions {
  readonly mode: "development" | "production";
  readonly installationId: string;
  readonly baseURL: string;
  readonly secret: string;
  readonly database?: BetterAuthOptions["database"];
  readonly memoryDatabase?: MemoryDB;
  readonly secureCookies?: boolean;
  readonly sharedCookieDomain?: string;
  readonly humanLogin?: ReturnType<typeof createHumanLogin>;
  /** Trusted proxies whose client-address header keys sign-in admission. */
  readonly clientAddress?: ClientAddressConfiguration;
  /**
   * Whether a user administers the Installation. Once the shared budget is spent, only
   * administrators' passwords (and, with an external provider, the recovery account's) are
   * still checked (slowly). Without it no administrator is.
   */
  readonly passwordAdministrator?: (userId: string) => Promise<boolean>;
  /** Replaces the in-memory failure-counting password admission (both profiles). */
  readonly passwordAdmission?: PasswordSignInAdmission;
  /**
   * Replaces the default admission's slow-lane floors; budgets and slots stay
   * `passwordFailureBudget`. The server leaves it unset; tests shorten the floor cap so
   * paced refusals do not wait the full eight seconds, and observe when floors start.
   */
  readonly passwordSlowLaneFloors?: PasswordSlowLaneFloors;
  /**
   * The password-only profile's known-device account state (see known-device.ts). Without
   * it, and without an external provider, entries are bound to the user and a hash of its
   * stored password hash, read through Better Auth.
   */
  readonly knownDeviceState?: KnownDeviceAccountState;
  /**
   * Password-only profile: audits each password sign-in Better Auth accepted (with the
   * account) or refused (without it). The guarded profile audits in State itself.
   */
  readonly passwordSignInAudit?: {
    accepted(userId: string): Promise<void>;
    refused(): Promise<void>;
  };
  /** Receives runtime operational events, such as a sign-in lane entering the slow lane. */
  readonly onOperationalEvent?: (event: Readonly<Record<string, unknown>>) => void;
  /** RFC-0019 CLI sign-in; absent means `occ login` is unavailable (404). */
  readonly cliSessions?: {
    readonly store: CliSessionStore;
    readonly settings: CliSessionSettings;
  };
}

/**
 * The logged form of a limited sign-in lane's key: keyed by the auth secret, so a log
 * reader cannot test candidate emails or addresses against it, and truncated. Stable for
 * one secret, so repeated reports about one target correlate.
 */
export function signInLimitKeyHash(secret: string, key: string): string {
  return createHmac("sha256", secret).update(`sign-in-limited\0${key}`).digest("hex").slice(0, 16);
}

export interface PostgresControllerAuthOptions extends Omit<
  ControllerAuthOptions,
  "database" | "memoryDatabase"
> {
  readonly pool: SchemaAuthPoolV1;
  readonly state?: PostgresPlatformState;
  readonly iamDriver?: IAMDriver;
  readonly github?: GitHubLoginConfiguration;
  readonly google?: GoogleSignInConfiguration;
  readonly oidc?: OidcSignInConfiguration;
  /** Guarded profile only: `recovery-only` admits only the recovery account's password. */
  readonly passwordSignIn?: "recovery-only";
  /** Receives nonfatal startup conditions as structured log events. */
  readonly onWarning?: (event: { readonly event: string; readonly message: string }) => void;
  /** Counts an external sign-in callback that matched no pending attempt (not audited). */
  readonly onUnmatchedCallback?: (provider: ExternalProviderName) => void;
  /** `auth.cliSessions`; defaults to enabled with an eight-hour cap (RFC-0019). */
  readonly cliSessionSettings?: CliSessionSettings;
}

export interface AuthenticatedAccount {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export type AuthenticatedSession = AdmittedSession;

/** A validated, hashed account that has not been written yet. */
export type PreparedAuthAccount = PreparedPasswordAccount;

export interface ProvisionAuthAccountInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

export {
  AuthAccountRoleInvalidError,
  AuthAccountRoleNotFoundError,
  type AuthPrincipalSeed,
  type AuthPrincipalSeedOptions,
} from "@openclaw-enterprise/iam";

export interface ControllerAuth {
  readonly auth: ControllerBetterAuth;
  readonly issuer: string;
  readonly sessionCookieName: string;
  readonly sharedCookieDomain?: string;
  readonly admissionVerifier: ControllerAdmissionVerifier;
  readonly githubEnabled: boolean;
  /** Provider-instance key for GitHub identities; set only while GitHub sign-in is configured. */
  readonly githubProviderId?: string;
  /** Users this startup's activation left unenrolled (no Principal or not exactly one password). */
  readonly activationSkipped?: readonly string[];
  /** Who may sign in with a password: `recovery-only` only in the guarded profile. */
  readonly passwordSignIn: PasswordSignInPolicy;
  /**
   * Recovery-only password sign-in: enabled accounts, other than the recovery account, with
   * no identity for a configured provider. They cannot sign in until one is attached.
   */
  readonly withoutExternalIdentity?: readonly string[];
  githubStart(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  githubCallback(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  githubResult(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  readonly googleEnabled: boolean;
  /** Provider-instance key for Google identities; set only while Google sign-in is configured. */
  readonly googleProviderId?: string;
  googleStart(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  googleCallback(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  googleResult(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  readonly oidcEnabled: boolean;
  /** Provider-instance key for OIDC identities; set only while OIDC sign-in is configured. */
  readonly oidcProviderId?: string;
  /** What the Console needs to offer OIDC sign-in; set only while it is configured. */
  readonly oidcSignIn?: { readonly label: string; readonly authorizationUrl: string };
  oidcStart(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  oidcCallback(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  oidcResult(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  readAccount?(
    userId: string,
    actor: HumanAuthenticationActor,
  ): Promise<HumanAuthenticationAccount>;
  attachGitHub?(
    userId: string,
    subject: string,
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<unknown>;
  attachGoogle?(
    userId: string,
    subject: string,
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<unknown>;
  attachOidc?(
    userId: string,
    subject: string,
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<unknown>;
  changeAccount?(
    userId: string,
    operation: "disable" | "enable" | "revoke",
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<void>;
  readRecovery?(actor: HumanAuthenticationActor): Promise<HumanAuthenticationRecovery>;
  replaceRecovery?(
    userId: string,
    principalId: string,
    expectedCurrentUserId: string,
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<HumanAuthenticationRecovery & { changed: boolean }>;
  enrolAccount?(
    userId: string,
    actor: HumanAuthenticationActor,
  ): Promise<{ principalId: string; version: number; created: boolean }>;
  detachMethod?(
    userId: string,
    methodId: string,
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<{ methodId: string; providerId: string }>;
  /** "guarded" once State-owned human sign-in admission is active. */
  readonly humanProfile: "password" | "guarded";
  prepareAccount(input: ProvisionAuthAccountInput): Promise<PreparedAuthAccount>;
  writePreparedAccount(prepared: PreparedAuthAccount): Promise<AuthenticatedAccount>;
  createAccount(input: ProvisionAuthAccountInput): Promise<AuthenticatedAccount>;
  deleteAccount(account: Pick<AuthenticatedAccount, "id">): Promise<void>;
  principalSeed(
    account: Pick<AuthenticatedAccount, "id">,
    options: AuthPrincipalSeedOptions,
  ): AuthPrincipalSeed;
  signInEmail(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  signOut(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  session(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  resolveSession(request: FastifyRequest): Promise<AuthenticatedSession | undefined>;
  createServiceKey(input: {
    readonly principal: ServicePrincipal;
    readonly name: string;
    readonly expiresIn?: number;
  }): Promise<ServiceKey & { readonly key: string }>;
  getServiceKey(id: string): Promise<ServiceKey | undefined>;
  revokeServiceKey(key: ServiceKey): Promise<void>;
  /** RFC-0019 `occ login` routes; absent when this composition has no CLI session store. */
  readonly cliSignIn?: CliSignIn;
}

export function normalizeSharedCookieDomain(domain: string | undefined): string | undefined {
  const trimmed = domain?.trim().replace(/^\./, "").replace(/\.$/, "");
  if (!isNonEmptyString(trimmed)) {
    return undefined;
  }
  const normalized = domainToASCII(trimmed).toLowerCase();
  if (!SAFE_COOKIE_DOMAIN.test(normalized)) {
    throw new Error("OCC_AUTH_COOKIE_DOMAIN must be a DNS parent domain.");
  }
  const parsed = parseDomain(normalized, { allowPrivateDomains: true, validateHostname: true });
  if (parsed.isIp || parsed.domain === null || parsed.publicSuffix === normalized) {
    throw new Error("OCC_AUTH_COOKIE_DOMAIN must not be a public suffix.");
  }
  return normalized;
}

export function hostnameMatchesSharedCookieDomain(hostname: string, domain: string): boolean {
  const normalizedHost = domainToASCII(hostname.trim().replace(/\.$/, "")).toLowerCase();
  return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
}

function authHeaders(headers: AdmissionHeaders | FastifyRequest["headers"] | undefined): Headers {
  if (headers instanceof Headers) {
    return new Headers(headers);
  }
  const prepared = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      prepared.set(name, value);
      continue;
    }
    for (const entry of value) {
      prepared.append(name, entry);
    }
  }
  return prepared;
}

function sessionHeaders(
  headers: AdmissionHeaders | FastifyRequest["headers"],
  cookieName: string,
): Headers {
  const prepared = authHeaders(headers);
  const count = (prepared.get("cookie") ?? "")
    .split(";")
    .filter((cookie) => cookie.slice(0, cookie.indexOf("=")).trim() === cookieName).length;
  if (count > 1) {
    throw new AdmissionFailure(401, "UNAUTHENTICATED", "The session cookie is ambiguous.");
  }
  return prepared;
}

function sessionCookieNames(prefix: string): readonly string[] {
  return [`${prefix}.session_token`, `__Secure-${prefix}.session_token`];
}

function activeSessionCookieName(
  prefix: string,
  secureOrigin: boolean,
  humanLogin: boolean,
): string {
  const name = `${prefix}.session_token`;
  if (!secureOrigin) {
    return name;
  }
  return `${humanLogin ? "__Host-" : "__Secure-"}${name}`;
}

function hostOnlySessionCookieClearance(enabled: boolean, activePrefix: string): readonly string[] {
  if (!enabled) {
    return [];
  }
  const names = new Set([
    ...sessionCookieNames(OCC_AUTH_COOKIE_PREFIX),
    ...sessionCookieNames(activePrefix),
  ]);
  return [...names].map((name) => {
    const secure = name.startsWith("__Secure-") ? "; Secure" : "";
    return `${name}=; Max-Age=0; Path=/; HttpOnly${secure}; SameSite=Lax`;
  });
}

function setAuthHeaders(
  reply: FastifyReply,
  headers?: Headers | null,
  additionalCookies: readonly string[] = [],
): void {
  if (!headers) {
    if (additionalCookies.length > 0) {
      reply.header("set-cookie", [...additionalCookies]);
    }
    return;
  }
  const cookies: string[] = [...additionalCookies];
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      cookies.push(...splitSetCookieHeader(value));
      return;
    }
    reply.header(name, value);
  });
  if (cookies.length > 0) {
    reply.header("set-cookie", cookies);
  }
}

function authFailure(error: unknown): { readonly status: number; readonly code: string } {
  if (error instanceof AdmissionFailure) {
    return { status: error.status, code: error.code };
  }
  if (error instanceof APIError || (typeof error === "object" && error !== null)) {
    const candidate = error as Record<string, unknown>;
    const status =
      error instanceof APIError ? error.statusCode : (candidate.statusCode ?? candidate.status);
    if (
      typeof status === "number" &&
      Number.isSafeInteger(status) &&
      status >= 400 &&
      status < 500
    ) {
      return {
        status,
        code:
          status === 401
            ? "UNAUTHENTICATED"
            : status === 409
              ? "RESOURCE_CONFLICT"
              : status === 429
                ? "RATE_LIMITED"
                : "FORBIDDEN",
      };
    }
    if (error instanceof APIError) {
      return { status: 401, code: "UNAUTHENTICATED" };
    }
  }
  return { status: 503, code: "DEPENDENCY_UNAVAILABLE" };
}

/**
 * A rejected password whose denial audit could not be written. The response is 503 (audit
 * outages fail closed), yet admission still counts it as a credential failure.
 */
class DenialAuditUnavailable extends Error {
  constructor(cause: unknown) {
    super("The sign-in denial could not be audited.", { cause });
    this.name = "DenialAuditUnavailable";
  }
}

// The Console reason for each GitHub allowlist refusal (RFC-0061) and for an attached identity
// whose account is disabled. No other value reaches the redirect.
const callbackReasons: Readonly<Record<(typeof CALLBACK_DENIALS)[number], string>> = {
  MEMBERSHIP_REQUIRED: "membership",
  MEMBERSHIP_UNAVAILABLE: "membership-unavailable",
  ACCOUNT_DISABLED: "account-disabled",
};

/** An audited callback refusal whose Console reason the callback redirect carries. */
class CallbackRefusal extends AdmissionFailure {
  readonly consoleReason: string;
  constructor(consoleReason: string) {
    super(401, "UNAUTHENTICATED", "Authentication was not accepted.");
    this.consoleReason = consoleReason;
  }
}

async function callbackRefusal(response: Response): Promise<CallbackRefusal | undefined> {
  try {
    const body = (await response.json()) as { readonly code?: unknown } | null;
    const code = CALLBACK_DENIALS.find((denial) => denial === body?.code);
    return code === undefined ? undefined : new CallbackRefusal(callbackReasons[code]);
  } catch {
    return undefined;
  }
}

async function deniedWithoutAudit(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { readonly code?: unknown } | null;
    return body?.code === PASSWORD_DENIAL_AUDIT_UNAVAILABLE;
  } catch {
    return false;
  }
}

// Credential rejections spend the password budget; dependency failures do not, except a
// rejection whose denial audit failed.
function countsAsSignInFailure(error: unknown): boolean {
  if (error instanceof DenialAuditUnavailable) {
    return true;
  }
  const { status } = authFailure(error);
  return status >= 400 && status < 500;
}

function authBody(request: FastifyRequest): Record<string, unknown> {
  return typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>)
    : {};
}

function ensureEmailPassword(input: Record<string, unknown>): { email: string; password: string } {
  const { email, password } = input;
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    throw new AdmissionFailure(401, "UNAUTHENTICATED", "Email and password are required.");
  }
  return { email, password };
}

function untrustedOrigin(): AdmissionFailure {
  return new AdmissionFailure(
    403,
    "FORBIDDEN",
    "The browser origin is not trusted.",
    "untrusted_origin",
  );
}

function requireTrustedBrowserOrigin(request: FastifyRequest, expectedOrigin: string): void {
  const origin = request.headers.origin;
  if (Array.isArray(origin)) {
    throw untrustedOrigin();
  }
  if (origin !== undefined) {
    if (origin !== expectedOrigin) {
      throw untrustedOrigin();
    }
    return;
  }

  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw untrustedOrigin();
  }
}

/**
 * Applies the optional x-occ-session-key header to a resolved cookie session.
 * Absent keeps the cookie-only contract; a malformed, duplicated or foreign key
 * rejects instead of acting on whichever session the shared cookie now carries.
 */
function requireSessionKey(headers: Headers, secret: string, sessionId: string | undefined): void {
  const key = sessionKeyHeader(headers);
  if (key === undefined) {
    return;
  }
  if (key === null || (sessionId !== undefined && !sessionKeyMatches(secret, sessionId, key))) {
    throw new AdmissionFailure(401, "UNAUTHENTICATED", "The session key does not match.");
  }
}

function responseSessionId(response: unknown): string | undefined {
  const session =
    typeof response === "object" && response !== null
      ? (response as { readonly session?: unknown }).session
      : undefined;
  const id =
    typeof session === "object" && session !== null
      ? (session as Record<string, unknown>).id
      : undefined;
  return isNonEmptyString(id) ? id : undefined;
}

function requireSessionMutationOrigin(headers: Headers, expectedOrigin: string): void {
  const fetchSite = headers.get("sec-fetch-site");
  if (
    headers.get("origin") !== expectedOrigin ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    throw untrustedOrigin();
  }
}

function preparedId(
  context: { generateId(options: { model: "user" | "account" }): string | false },
  model: "user" | "account",
): string {
  const generated = context.generateId({ model });
  return typeof generated === "string" && generated.length > 0 ? generated : randomUUID();
}

function accountName(input: ProvisionAuthAccountInput): string {
  return input.name?.trim() || input.email.trim();
}

function safeSessionResponse(
  response: unknown,
  secret: string,
): {
  readonly authenticated: true;
  readonly sessionKey: string;
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
} | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const { session, user } = response as { readonly session?: unknown; readonly user?: unknown };
  if (
    typeof session !== "object" ||
    session === null ||
    typeof user !== "object" ||
    user === null
  ) {
    return null;
  }
  const { id: sessionKey } = session as Record<string, unknown>;
  const { id, email, name } = user as Record<string, unknown>;
  if (
    !isNonEmptyString(sessionKey) ||
    !isNonEmptyString(id) ||
    !isNonEmptyString(email) ||
    !isNonEmptyString(name)
  ) {
    return null;
  }
  return {
    authenticated: true,
    sessionKey: sessionBindingKey(secret, sessionKey),
    user: { id, email, name },
  };
}

function safeAuthenticatedSession(response: unknown): AuthenticatedSession | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const { session, user } = response as { readonly session?: unknown; readonly user?: unknown };
  if (
    typeof session !== "object" ||
    session === null ||
    typeof user !== "object" ||
    user === null
  ) {
    return undefined;
  }
  const { id, expiresAt } = session as Record<string, unknown>;
  const { id: userId } = user as Record<string, unknown>;
  if (!isNonEmptyString(id) || !isNonEmptyString(userId)) {
    return undefined;
  }
  const expiry =
    expiresAt instanceof Date
      ? expiresAt
      : typeof expiresAt === "string"
        ? new Date(expiresAt)
        : undefined;
  if (expiry === undefined || Number.isNaN(expiry.getTime())) {
    return undefined;
  }
  return { id, userId, expiresAt: expiry.toISOString() };
}

async function sendAuthEndpoint(
  request: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<{
    readonly response?: unknown;
    readonly headers?: Headers | null;
    readonly status?: number;
  } | null>,
  data: (response: unknown) => unknown,
  failureMessage: string,
  additionalCookies: readonly string[] = [],
): Promise<void> {
  try {
    const result = await run();
    setAuthHeaders(reply, result?.headers, additionalCookies);
    reply.status(result?.status ?? 200).send({
      data: data(result?.response ?? null),
      meta: { requestId: request.id },
    });
  } catch (error) {
    const failure = authFailure(error);
    if (error instanceof SignInRateLimited) {
      reply.header("retry-after", String(error.retryAfterSeconds));
    }
    reply.status(failure.status).send({
      error: {
        code: failure.code,
        // Every caller checks the Origin before it reads any credential, so naming the refused
        // Origin reveals nothing about the session or password; keep it that way, because the
        // endpoint's own message would misdirect a CLI user.
        message:
          error instanceof AdmissionFailure && error.reason === "untrusted_origin"
            ? UNTRUSTED_ORIGIN_MESSAGE
            : failureMessage,
      },
      meta: { requestId: request.id },
    });
  }
}

async function createOccAuthDatabase(
  pool: SchemaAuthPoolV1,
): Promise<NonNullable<BetterAuthOptions["database"]>> {
  const { database, schema } = await createPostgresAuthBinding(pool);
  const { drizzleAdapter } = await import("better-auth/adapters/drizzle");
  return drizzleAdapter(database, {
    provider: "pg",
    schema,
    camelCase: true,
    transaction: true,
  } satisfies SchemaAuthAdapterOptionsV1);
}

export class ControllerAdmissionVerifier implements AdmissionVerifier {
  readonly #auth: ControllerBetterAuth;
  readonly #installationId: string;
  readonly #issuer: string;
  readonly #sessionCookieName: string;
  readonly #secret: string;
  readonly #browserOrigin: string;
  readonly #cliSignIn: CliSignIn | undefined;

  constructor(
    auth: ControllerBetterAuth,
    installationId: string,
    cookieName: string,
    secret: string,
    browserOrigin: string,
    cliSignIn?: CliSignIn,
  ) {
    this.#auth = auth;
    this.#cliSignIn = cliSignIn;
    this.#secret = secret;
    this.#sessionCookieName = cookieName;
    this.#browserOrigin = browserOrigin;
    this.#installationId = installationId;
    this.#issuer = betterAuthIssuer(installationId);
  }

  async verifyControllerRequest(request: AdmissionRequest): Promise<AdmittedCaller> {
    const headers = authHeaders(request.headers);
    if (
      request.authorizationHeader === undefined &&
      !headers.has(OCC_SERVICE_KEY_HEADER) &&
      cliSessionHeader(headers) === undefined &&
      headers.has("cookie") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())
    ) {
      requireSessionMutationOrigin(headers, this.#browserOrigin);
    }
    return this.verify(request);
  }

  async verify(request: AdmissionRequest): Promise<AdmittedCaller> {
    if (request.authorizationHeader !== undefined) {
      throw new AdmissionFailure(
        401,
        "UNAUTHENTICATED",
        "Controller API bearer authentication is disabled.",
      );
    }
    if (request.requestedScope.installationId !== this.#installationId) {
      throw new AdmissionFailure(403, "FORBIDDEN", "The admitted Installation does not match.");
    }

    const headers = authHeaders(request.headers);
    // An explicit CLI session, like a key, never falls back to the cookie; both together are
    // ambiguous and refused.
    const cliToken = cliSessionHeader(headers);
    if (cliToken !== undefined) {
      if (headers.has(OCC_SERVICE_KEY_HEADER)) {
        throw new AdmissionFailure(
          401,
          "UNAUTHENTICATED",
          "Send either a service API key or a CLI session, not both.",
        );
      }
      const session =
        cliToken === null || this.#cliSignIn === undefined
          ? undefined
          : await this.#cliSignIn.verify(cliToken);
      if (session === undefined) {
        throw new AdmissionFailure(401, "UNAUTHENTICATED", "A valid CLI session is required.");
      }
      return {
        externalIdentity: { issuer: this.#issuer, subject: session.userId },
        // A Namespace pin scopes the session the way a Namespace service key is scoped.
        admittedScope: {
          installationId: this.#installationId,
          ...(session.namespaceId === undefined ? {} : { namespaceId: session.namespaceId }),
        },
        decisionId: `adm_${randomUUID()}`,
        method: "cli_session",
        cliSession: {
          id: session.id,
          userId: session.userId,
          parentSessionId: session.parentSessionId,
          expiresAt: session.expiresAt.toISOString(),
          ...(session.namespaceId === undefined ? {} : { namespaceId: session.namespaceId }),
        },
      };
    }
    // An explicitly supplied key never falls back to a potentially more privileged cookie.
    if (headers.has(OCC_SERVICE_KEY_HEADER)) {
      const result = await this.#auth.api.verifyApiKey({
        body: { key: headers.get(OCC_SERVICE_KEY_HEADER)!, configId: SERVICE_KEY_CONFIG },
      });
      if (!result.valid || !result.key) {
        throw new AdmissionFailure(401, "UNAUTHENTICATED", "A valid service API key is required.");
      }
      const key = serviceKeyDetails(result.key, this.#installationId);
      if (!key) {
        throw new AdmissionFailure(401, "UNAUTHENTICATED", "A valid service API key is required.");
      }
      return {
        externalIdentity: {
          issuer: `${this.#issuer}:service-key`,
          subject: key.servicePrincipalId,
        },
        admittedScope: {
          installationId: this.#installationId,
          ...(key.namespaceId === undefined ? {} : { namespaceId: key.namespaceId }),
        },
        decisionId: `adm_${randomUUID()}`,
        method: "api_key",
      };
    }

    const session = await this.#auth.api.getSession({
      headers: sessionHeaders(headers, this.#sessionCookieName),
      query: { disableCookieCache: true, disableRefresh: true },
      asResponse: false,
      returnHeaders: true,
    });
    const response = session && "response" in session ? session.response : session;
    const authenticatedSession = safeAuthenticatedSession(response);
    if (authenticatedSession === undefined) {
      throw new AdmissionFailure(401, "UNAUTHENTICATED", "A valid controller session is required.");
    }
    requireSessionKey(headers, this.#secret, authenticatedSession.id);

    return {
      externalIdentity: { issuer: this.#issuer, subject: authenticatedSession.userId },
      admittedScope: {
        installationId: this.#installationId,
        ...(request.requestedScope.namespaceId === undefined
          ? {}
          : { namespaceId: request.requestedScope.namespaceId }),
      },
      decisionId: `adm_${randomUUID()}`,
      method: "session" as const,
      session: authenticatedSession,
    };
  }
}

function serviceKeyDetails(
  key: Pick<ApiKey, "id" | "configId" | "referenceId" | "metadata" | "name" | "expiresAt">,
  installationId: string,
): ServiceKey | undefined {
  const metadata = key.metadata as Record<string, unknown> | null;
  if (
    key.configId !== SERVICE_KEY_CONFIG ||
    !isNonEmptyString(key.referenceId) ||
    metadata?.installationId !== installationId ||
    (metadata.namespaceId !== undefined && !isNonEmptyString(metadata.namespaceId)) ||
    !isNonEmptyString(key.name) ||
    !key.expiresAt
  ) {
    return undefined;
  }
  return {
    id: key.id,
    servicePrincipalId: key.referenceId,
    ...(metadata.namespaceId === undefined ? {} : { namespaceId: metadata.namespaceId as string }),
    name: key.name,
    expiresAt: new Date(key.expiresAt).toISOString(),
  };
}

export function createControllerAuth(options: ControllerAuthOptions): ControllerAuth {
  if (options.mode !== "development" && options.mode !== "production") {
    throw new Error("Controller auth requires an explicit runtime mode.");
  }
  if (!isNonEmptyString(options.secret) || options.secret.length < 32) {
    throw new Error("OCC_AUTH_SECRET must contain at least 256 bits of secret material.");
  }
  if (!validHttpBaseURL(options.baseURL)) {
    throw new Error("OCC_AUTH_BASE_URL must be an absolute HTTP origin URL.");
  }

  const expectedBrowserOrigin = new URL(options.baseURL).origin;
  const sharedCookieDomain = normalizeSharedCookieDomain(options.sharedCookieDomain);
  if (
    sharedCookieDomain !== undefined &&
    !hostnameMatchesSharedCookieDomain(new URL(expectedBrowserOrigin).hostname, sharedCookieDomain)
  ) {
    throw new Error("OCC_AUTH_COOKIE_DOMAIN must contain the OCC_AUTH_BASE_URL host.");
  }
  if (
    sharedCookieDomain !== undefined &&
    (new URL(options.baseURL).protocol !== "https:" || options.secureCookies === false)
  ) {
    throw new Error("OCC_AUTH_COOKIE_DOMAIN requires secure HTTPS session cookies.");
  }
  const humanLogin = options.humanLogin;
  const secureOrigin = new URL(options.baseURL).protocol === "https:";
  const hostBoundSession = humanLogin !== undefined && secureOrigin;
  const cookiePrefix =
    sharedCookieDomain === undefined ? OCC_AUTH_COOKIE_PREFIX : OCC_SHARED_AUTH_COOKIE_PREFIX;
  const sessionCookieName = activeSessionCookieName(
    cookiePrefix,
    secureOrigin,
    humanLogin !== undefined,
  );
  const hostOnlySessionCookieCleanup = hostOnlySessionCookieClearance(
    sharedCookieDomain !== undefined,
    cookiePrefix,
  );
  const issuer = betterAuthIssuer(options.installationId);
  if (humanLogin !== undefined && typeof options.database !== "function") {
    throw new Error("The human authentication profile requires its guarded State adapter.");
  }
  const auth = betterAuth<BetterAuthOptions & { plugins: ControllerPlugins }>({
    appName: "OpenClaw Control Plane",
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: options.secret,
    database:
      (humanLogin && typeof options.database === "function"
        ? humanLogin.database(options.database)
        : options.database) ??
      memoryAdapter(
        options.memoryDatabase ?? {
          user: [],
          session: [],
          account: [],
          verification: [],
          apikey: [],
        },
      ),
    ...(humanLogin === undefined
      ? {
          // Credential refusals are Better Auth warnings with no request or account; the
          // sign-in audit records them instead. Errors still reach the console.
          logger: { level: "error" },
        }
      : {
          session: {
            expiresIn: 8 * 60 * 60,
            disableSessionRefresh: true,
            cookieCache: { enabled: false },
          },
          logger: { disabled: true },
          onAPIError: {
            onError(error) {
              // Better Call logs unclassified exceptions even when the auth logger is disabled.
              throw error instanceof APIError
                ? error
                : APIError.fromStatus("SERVICE_UNAVAILABLE", {
                    message: "Authentication dependency unavailable.",
                  });
            },
          },
        }),
    plugins: [
      ...(humanLogin === undefined ? [] : [humanLogin.plugin]),
      apiKey({
        configId: SERVICE_KEY_CONFIG,
        defaultPrefix: "occ_",
        enableMetadata: true,
        enableSessionForAPIKeys: false,
        requireName: true,
        rateLimit: { enabled: false },
        keyExpiration: { defaultExpiresIn: 30 * 24 * 60 * 60 },
      }),
    ],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: LOCAL_PASSWORD_MIN_LENGTH,
      maxPasswordLength: LOCAL_PASSWORD_MAX_LENGTH,
    },
    trustedOrigins: [options.baseURL],
    rateLimit: { enabled: humanLogin === undefined },
    advanced: {
      ...(humanLogin === undefined ? {} : { ipAddress: { ipAddressHeaders: ["x-occ-client-ip"] } }),
      cookiePrefix,
      ...(hostBoundSession
        ? {
            // Better Auth otherwise prepends __Secure- even to an explicit __Host- name.
            useSecureCookies: false,
            cookies: { session_token: { name: sessionCookieName } },
          }
        : {}),
      ...(sharedCookieDomain === undefined
        ? {}
        : { crossSubDomainCookies: { enabled: true, domain: sharedCookieDomain } }),
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure:
          hostBoundSession ||
          sharedCookieDomain !== undefined ||
          (options.secureCookies ?? options.mode === "production"),
      },
    },
  });
  const api = auth.api;
  // The known-device cookie is host-only (__Host-) whenever the origin is HTTPS. With an
  // external provider its name follows the curated endpoints that issue it.
  const knownDeviceSecure =
    humanLogin?.knownDeviceSecure ?? (secureOrigin && options.secureCookies !== false);
  // What a known-device entry is bound to: with an external provider, the guarded account
  // state (versions and enabled state); otherwise the composition's password state.
  const knownDeviceState: KnownDeviceAccountState =
    humanLogin?.knownDeviceState ??
    options.knownDeviceState ??
    (async (email) => {
      const found = await (
        await auth.$context
      ).internalAdapter.findUserByEmail(email, { includeAccounts: true });
      const credentials = (found?.accounts ?? []).filter(
        (account) =>
          account.providerId === "credential" &&
          typeof account.password === "string" &&
          account.password.length > 0,
      );
      if (found === null || credentials.length !== 1) {
        return undefined;
      }
      const passwordHash = createHash("sha256").update(credentials[0]!.password!).digest("hex");
      return `adapter\0${found.user.id}\0${credentials[0]!.id}\0${passwordHash}`;
    });
  // Bound fresh proof reads before account access. Signed keys constrain resources only;
  // a refused or failed proof retains those constraints on the ordinary shared lane.
  const knownDeviceReads = keyedAdmission(
    { perMinute: 30, concurrent: 2 },
    { perMinute: 600, concurrent: passwordFailureBudget.slow.evaluating },
  );
  // Failure-counting admission for password sign-in in both profiles, keyed on email (or a
  // known device) and, behind a trusted proxy, client address. Reserved accounts are slowed,
  // never refused (see admission.ts).
  const passwordAdmission =
    options.passwordAdmission ??
    passwordFailureAdmission({
      ...passwordFailureBudget,
      ...(options.passwordSlowLaneFloors === undefined
        ? {}
        : { slow: { ...passwordFailureBudget.slow, ...options.passwordSlowLaneFloors } }),
      countsAsFailure: countsAsSignInFailure,
      ...(options.onOperationalEvent === undefined
        ? {}
        : {
            onLimited: ({ lane, key }) =>
              options.onOperationalEvent!({
                event: "authentication.sign-in-limited",
                lane,
                ...(key === undefined ? {} : { keyHash: signInLimitKeyHash(options.secret, key) }),
              }),
          }),
      // Timing differences here are hidden by the slow lane's floor. Lookup failures
      // propagate, so an outage is 503 rather than a refusal.
      async isReserved(email) {
        if (humanLogin !== undefined) {
          // The recovery account is the documented way in when a provider is down, so
          // strangers spending its email can slow it but never refuse it.
          if (humanLogin.isRecoveryEmail(email)) {
            return true;
          }
          // Recovery-only: every other password is refused unread, reserved or not.
          if (humanLogin.passwordSignIn === "recovery-only") {
            return false;
          }
        }
        if (options.passwordAdministrator === undefined) {
          return false;
        }
        const found = await (await auth.$context).internalAdapter.findUserByEmail(email);
        return found !== null && (await options.passwordAdministrator(found.user.id));
      },
    });

  /** Validates and hashes a new password account without writing it. */
  async function prepareAccount(input: ProvisionAuthAccountInput): Promise<PreparedAuthAccount> {
    const email = input.email.trim().toLowerCase();
    const password = input.password;
    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      throw new Error("Account creation requires email and password.");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw APIError.from("BAD_REQUEST", {
        code: "INVALID_EMAIL",
        message: "Email must be a valid address.",
      });
    }
    const context = await auth.$context;
    if (password.length < context.password.config.minPasswordLength) {
      throw APIError.from("BAD_REQUEST", {
        code: "PASSWORD_TOO_SHORT",
        message: "Password is too short.",
      });
    }
    if (password.length > context.password.config.maxPasswordLength) {
      throw APIError.from("BAD_REQUEST", {
        code: "PASSWORD_TOO_LONG",
        message: "Password is too long.",
      });
    }
    const existing = await context.internalAdapter.findUserByEmail(email);
    if (existing?.user) {
      await context.password.hash(password);
      throw APIError.fromStatus("CONFLICT", {
        code: "USER_ALREADY_EXISTS",
        message: "The requested account already exists.",
      });
    }
    return Object.freeze({
      id: preparedId(context, "user"),
      email,
      name: accountName({ ...input, email }),
      passwordHash: await context.password.hash(password),
      credentialId: preparedId(context, "account"),
    });
  }

  /** Writes a prepared account through Better Auth, for compositions without original State. */
  async function writePreparedAccount(
    prepared: PreparedAuthAccount,
  ): Promise<AuthenticatedAccount> {
    const context = await auth.$context;
    const created = await context.adapter.create<
      Record<string, unknown>,
      { id: string; email: string; name: string }
    >({
      model: "user",
      data: {
        id: prepared.id,
        email: prepared.email,
        name: prepared.name,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
    try {
      await context.adapter.create({
        model: "account",
        data: {
          id: prepared.credentialId,
          userId: prepared.id,
          providerId: "credential",
          accountId: prepared.id,
          password: prepared.passwordHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        forceAllowId: true,
      });
    } catch (error) {
      await context.internalAdapter.deleteUser(prepared.id).catch(() => {});
      throw error;
    }
    return Object.freeze({ id: created.id, email: created.email, name: created.name });
  }

  async function createAccount(input: ProvisionAuthAccountInput): Promise<AuthenticatedAccount> {
    const prepared = await prepareAccount(input);
    const context = await auth.$context;
    const created = await context.internalAdapter.createUser(
      { email: prepared.email, name: prepared.name, emailVerified: true },
      { method: "admin" },
    );
    try {
      await context.internalAdapter.linkAccount({
        userId: created.id,
        providerId: "credential",
        accountId: created.id,
        password: prepared.passwordHash,
      });
    } catch (error) {
      await context.internalAdapter.deleteUser(created.id).catch(() => {});
      throw error;
    }
    return Object.freeze({
      id: created.id,
      email: created.email,
      name: created.name,
    });
  }

  async function deleteAccount(account: Pick<AuthenticatedAccount, "id">): Promise<void> {
    const context = await auth.$context;
    await context.internalAdapter.deleteUser(account.id);
  }

  function clientAddressOf(request: FastifyRequest): string {
    return resolveClientAddress(
      options.clientAddress,
      request.ip,
      options.clientAddress === undefined
        ? undefined
        : request.headers[options.clientAddress.header],
    );
  }

  async function runPrivateEndpoint(
    request: FastifyRequest,
    path: string,
    body?: Record<string, unknown>,
  ) {
    const url = new URL(`/auth${path}`, options.baseURL);
    if (request.method === "GET") {
      url.search = new URL(request.url, options.baseURL).search;
    }
    const headers = authHeaders(request.headers);
    headers.set("host", new URL(options.baseURL).host);
    // Sign-in admission keys on this value; Better Auth reads only this address header.
    headers.set("x-occ-client-ip", clientAddressOf(request));
    // Password sign-in keeps the established browser/CLI origin contract; sign-out already
    // required the exact browser Origin before reaching this point.
    if (!headers.has("origin") && path === "/oce/password") {
      headers.set("origin", expectedBrowserOrigin);
    }
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await auth.handler(
      new Request(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    if (!response.ok) {
      if (response.status === 429) {
        throw APIError.fromStatus("TOO_MANY_REQUESTS", {
          message: "Authentication rate limit exceeded.",
        });
      }
      if (response.status >= 500) {
        const failure = new Error("Authentication dependency unavailable.");
        // The curated password endpoint marks a rejection whose denial audit failed; the
        // response stays 503, but the guess spends budget as in the password-only profile.
        if (path === "/oce/password" && (await deniedWithoutAudit(response))) {
          throw new DenialAuditUnavailable(failure);
        }
        throw failure;
      }
      const refusal = path.endsWith("/callback") ? await callbackRefusal(response) : undefined;
      throw (
        refusal ?? new AdmissionFailure(401, "UNAUTHENTICATED", "Authentication was not accepted.")
      );
    }
    return { response: await response.json(), headers: response.headers, status: response.status };
  }

  // Browser endpoints for one external provider; its absence is a 403 (start/result) or
  // the console error redirect (callback), as before.
  function externalProviderRoutes(name: "github" | "google" | "oidc", label: string) {
    const configured =
      name === "github"
        ? humanLogin?.githubProviderId !== undefined
        : name === "google"
          ? humanLogin?.googleProviderId !== undefined
          : humanLogin?.oidcProviderId !== undefined;
    return {
      async start(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        await sendAuthEndpoint(
          request,
          reply,
          () => {
            if (!configured) {
              throw new AdmissionFailure(403, "FORBIDDEN", `${label} sign-in is unavailable.`);
            }
            // Sets the browser-binding cookie, so it takes the same exact-Origin and
            // Sec-Fetch-Site guard as sign-out and the result exchange.
            requireSessionMutationOrigin(authHeaders(request.headers), expectedBrowserOrigin);
            return runPrivateEndpoint(request, `/oce/providers/${name}/start`);
          },
          (value) => value,
          `${label} sign-in could not be started.`,
        );
      },
      async callback(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        reply.header("cache-control", "no-store");
        reply.header("referrer-policy", "no-referrer");
        try {
          if (!configured) {
            throw new Error(`${label} sign-in unavailable.`);
          }
          const result = await runPrivateEndpoint(request, `/oce/providers/${name}/callback`);
          setAuthHeaders(reply, result.headers);
          reply.redirect("/console/");
        } catch (error) {
          reply.redirect(
            error instanceof CallbackRefusal
              ? `/console/?authError=${name}&authReason=${error.consoleReason}`
              : `/console/?authError=${name}`,
          );
        }
      },
      async result(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        reply.header("cache-control", "no-store");
        await sendAuthEndpoint(
          request,
          reply,
          () => {
            if (!configured) {
              throw new AdmissionFailure(403, "FORBIDDEN", `${label} sign-in is unavailable.`);
            }
            // Reads the session cookie, so it takes the same exact-Origin guard as sign-out.
            requireSessionMutationOrigin(authHeaders(request.headers), expectedBrowserOrigin);
            return runPrivateEndpoint(request, `/oce/providers/${name}/result`, authBody(request));
          },
          (value) => {
            const sessionKey = (value as { readonly sessionKey?: unknown } | null)?.sessionKey;
            return { sessionKey: isNonEmptyString(sessionKey) ? sessionKey : null };
          },
          `${label} sign-in could not be confirmed.`,
        );
      },
    };
  }
  const githubRoutes = externalProviderRoutes("github", "GitHub");
  const googleRoutes = externalProviderRoutes("google", "Google");
  const oidcRoutes = externalProviderRoutes("oidc", "OIDC");

  async function signInEmail(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      async () => {
        // Better Auth server API calls skip origin middleware without a Request context.
        requireTrustedBrowserOrigin(request, expectedBrowserOrigin);
        const input = authBody(request);
        const body = ensureEmailPassword(input);
        // Read from the validated input, not the credential pair, so the admission key
        // is plainly derived from the email alone.
        const email = String(input.email).trim().toLowerCase();
        const deviceCookie = knownDeviceFromCookieHeader(request.headers.cookie, knownDeviceSecure);
        // The account's state is read only for an entry issued for this email, so a
        // forged or foreign cookie reads nothing; a stale entry just means no exemption.
        let deviceConstraints: readonly string[] = [];
        const device = await verifyKnownDevice(
          options.secret,
          email,
          deviceCookie,
          Date.now(),
          knownDeviceState,
          (keys, read) => {
            deviceConstraints = keys;
            return knownDeviceReads.admit(
              keys.map((key) => admissionKey("device", key)),
              async () => {
                const state = await read();
                // A completed fresh read can establish a stale/disabled entry. Only
                // an unavailable proof retains constraints; it never grants an exemption.
                deviceConstraints = [];
                return state;
              },
            );
          },
        );
        // The address lane needs a trusted proxy: without one, browsers behind the ingress
        // share its address, so only the email (or known-device) lane applies.
        const attempt = {
          ...(options.clientAddress === undefined
            ? {}
            : { clientAddress: clientAddressOf(request) }),
          email,
          ...(device === undefined ? { deviceConstraints } : { knownDevice: device.deviceKey }),
        };
        if (humanLogin) {
          // The curated endpoint checks the password, issues the session and marks the
          // browser as a known device; only credential rejections spend budget.
          return passwordAdmission.admit(attempt, () =>
            runPrivateEndpoint(request, "/oce/password", body),
          );
        }
        return passwordAdmission.admit(attempt, async () => {
          const audit = options.passwordSignInAudit;
          // The entry is bound to the account's state read before the password check: a
          // password reset or account recreation that commits during the sign-in then bumps
          // the state past it and revokes the entry, instead of the old password's sign-in
          // being bound to the new state. A failed read only skips the marking.
          const accountState = await knownDeviceState(email).catch(() => undefined);
          let result;
          try {
            result = await api.signInEmail({
              body: { ...body, rememberMe: true },
              headers: authHeaders(request.headers),
              asResponse: false,
              returnHeaders: true,
              returnStatus: true,
            });
          } catch (error) {
            if (audit !== undefined && countsAsSignInFailure(error)) {
              try {
                await audit.refused();
              } catch (auditError) {
                // Denial audits fail closed (503), but the wrong password still spends budget.
                throw new DenialAuditUnavailable(auditError);
              }
            }
            throw error;
          }
          if (audit !== undefined) {
            try {
              await audit.accepted(result.response.user.id);
            } catch (error) {
              // No unaudited session is handed out.
              const context = await auth.$context;
              await context.internalAdapter.deleteSession(result.response.token).catch(() => {});
              throw error;
            }
          }
          // Only a successful sign-in marks the browser as a known device for this email.
          // Rejections throw; a success leaves the status unset (200).
          if ((result.status ?? 200) === 200 && accountState !== undefined) {
            result.headers.append(
              "set-cookie",
              knownDeviceSetCookie(
                knownDeviceSecure,
                issueKnownDevice(options.secret, email, accountState, Date.now(), deviceCookie),
              ),
            );
          }
          return result;
        });
      },
      (response) => {
        const sessionKey = (response as { readonly sessionKey?: unknown } | null)?.sessionKey;
        return isNonEmptyString(sessionKey)
          ? { authenticated: true, sessionKey }
          : { authenticated: true };
      },
      "The caller did not provide valid authentication credentials.",
      hostOnlySessionCookieCleanup,
    );
  }

  async function signOut(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      async () => {
        // Better Auth server API calls skip origin middleware without a Request context.
        requireSessionMutationOrigin(authHeaders(request.headers), expectedBrowserOrigin);
        const headers = sessionHeaders(request.headers, sessionCookieName);
        if (sessionKeyHeader(headers) !== undefined) {
          // A pinned tab ends only its own session; a cookie replaced by another
          // sign-in is neither revoked nor cleared.
          const current = responseSessionId(
            await api.getSession({
              headers,
              query: { disableCookieCache: true, disableRefresh: true },
              asResponse: false,
              returnHeaders: false,
              returnStatus: false,
            }),
          );
          if (current === undefined) {
            throw new AdmissionFailure(401, "UNAUTHENTICATED", "The session key does not match.");
          }
          requireSessionKey(headers, options.secret, current);
        }
        if (humanLogin) {
          return runPrivateEndpoint(request, "/oce/sign-out");
        }
        return api.signOut({
          headers,
          asResponse: false,
          returnHeaders: true,
          returnStatus: true,
        });
      },
      (response) => response,
      "The controller session could not be revoked.",
      hostOnlySessionCookieCleanup,
    );
  }

  async function session(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      async () => {
        const headers = sessionHeaders(request.headers, sessionCookieName);
        requireSessionKey(headers, options.secret, undefined);
        const result = await api.getSession({
          headers,
          query: { disableCookieCache: true, disableRefresh: true },
          asResponse: false,
          returnHeaders: true,
          returnStatus: true,
        });
        requireSessionKey(headers, options.secret, responseSessionId(result?.response));
        return result;
      },
      (response) => safeSessionResponse(response, options.secret),
      "The controller session could not be resolved.",
    );
  }

  async function resolveSession(
    request: FastifyRequest,
  ): Promise<AuthenticatedSession | undefined> {
    const headers = sessionHeaders(request.headers, sessionCookieName);
    requireSessionKey(headers, options.secret, undefined);
    const session = safeAuthenticatedSession(
      await api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
        asResponse: false,
        returnHeaders: false,
        returnStatus: false,
      }),
    );
    if (session !== undefined) {
      requireSessionKey(headers, options.secret, session.id);
    }
    return session;
  }

  /**
   * The browser session behind a CLI-login approval or a console list/revoke: the configured
   * Origin (for state changes), the tab's x-occ-session-key (mandatory here, optional
   * elsewhere) and a session cookie that key belongs to.
   */
  async function browserSession(
    request: FastifyRequest,
    requireOrigin: boolean,
  ): Promise<AuthenticatedSession> {
    const headers = authHeaders(request.headers);
    if (requireOrigin) {
      requireSessionMutationOrigin(headers, expectedBrowserOrigin);
    } else if (headers.get("sec-fetch-site") === "cross-site") {
      throw untrustedOrigin();
    }
    if (sessionKeyHeader(headers) === undefined) {
      throw new AdmissionFailure(401, "UNAUTHENTICATED", "The tab's session key is required.");
    }
    const current = await resolveSession(request);
    if (current === undefined) {
      throw new AdmissionFailure(401, "UNAUTHENTICATED", "A valid controller session is required.");
    }
    return current;
  }
  const cliSignIn =
    options.cliSessions === undefined
      ? undefined
      : createCliSignIn({
          store: options.cliSessions.store,
          settings: options.cliSessions.settings,
          clientAddressOf,
          browserSession,
        });

  return {
    auth,
    issuer,
    sessionCookieName,
    ...(sharedCookieDomain === undefined ? {} : { sharedCookieDomain }),
    ...(cliSignIn === undefined ? {} : { cliSignIn }),
    admissionVerifier: new ControllerAdmissionVerifier(
      auth,
      options.installationId,
      sessionCookieName,
      options.secret,
      expectedBrowserOrigin,
      cliSignIn,
    ),
    prepareAccount,
    writePreparedAccount,
    createAccount,
    deleteAccount,
    principalSeed: (
      account: Pick<AuthenticatedAccount, "id">,
      seedOptions: AuthPrincipalSeedOptions,
    ) =>
      createAuthPrincipalSeed(
        options.installationId,
        betterAuthIssuer(options.installationId),
        account,
        seedOptions,
      ),
    githubEnabled: humanLogin?.githubProviderId !== undefined,
    humanProfile: humanLogin === undefined ? "password" : "guarded",
    passwordSignIn: humanLogin?.passwordSignIn ?? "all",
    githubStart: githubRoutes.start,
    githubCallback: githubRoutes.callback,
    githubResult: githubRoutes.result,
    googleEnabled: humanLogin?.googleProviderId !== undefined,
    googleStart: googleRoutes.start,
    googleCallback: googleRoutes.callback,
    googleResult: googleRoutes.result,
    oidcEnabled: humanLogin?.oidcProviderId !== undefined,
    ...(humanLogin?.oidcSignIn === undefined ? {} : { oidcSignIn: humanLogin.oidcSignIn }),
    oidcStart: oidcRoutes.start,
    oidcCallback: oidcRoutes.callback,
    oidcResult: oidcRoutes.result,
    signInEmail,
    signOut,
    session,
    resolveSession,
    async createServiceKey({ principal, name, expiresIn }) {
      // The server-only userId parameter is the plugin's referenceId; no human
      // account or session is created for this existing IAM automation identity.
      const created = await api.createApiKey({
        body: {
          configId: SERVICE_KEY_CONFIG,
          userId: principal.id,
          name,
          ...(expiresIn === undefined ? {} : { expiresIn }),
          metadata: {
            installationId: options.installationId,
            ...(principal.namespaceId === undefined ? {} : { namespaceId: principal.namespaceId }),
          },
        },
      });
      return { ...serviceKeyDetails(created, options.installationId)!, key: created.key };
    },
    async getServiceKey(id) {
      const context = await auth.$context;
      const key = await context.adapter.findOne<ApiKey>({
        model: "apikey",
        where: [{ field: "id", value: id }],
      });
      return key ? serviceKeyDetails(key, options.installationId) : undefined;
    },
    async revokeServiceKey(key) {
      // Better Auth recommends direct storage deletion for server-managed
      // revocation. Deletion also prevents a concurrent verification update
      // from restoring a previously read enabled=true value.
      const context = await auth.$context;
      await context.adapter.delete({
        model: "apikey",
        where: [
          { field: "id", value: key.id },
          { field: "configId", value: SERVICE_KEY_CONFIG },
          { field: "referenceId", value: key.servicePrincipalId },
        ],
      });
    },
  };
}

/**
 * Startup and stopped maintenance share this one-way activation path. External sign-in
 * requires the native IAM Driver, so both authorize through it. The configured recovery
 * user id only seeds the first activation: once a designation exists (possibly moved by an
 * online replacement) it is kept, and `seedIgnored` reports a differing seed. Every call
 * re-checks the actual holder. Refused preconditions throw ScopeViolationError.
 */
export async function activateRecoveryAccount(
  persistence: PostgresHumanAuthentication,
  iamDriver: NativeIAMDriver,
  installationId: string,
  seedRecoveryUserId: string,
  hooks?: HumanAuthenticationActivationHooks,
): Promise<HumanAuthenticationActivation & { recoveryUserId: string; seedIgnored: boolean }> {
  const existing = await persistence.recoveryDesignation();
  const seedIgnored = existing !== undefined && existing.userId !== seedRecoveryUserId;
  const recoveryUserId = seedIgnored ? existing.userId : seedRecoveryUserId;
  // Its Principal must still administer the Installation; activateRecovery re-checks
  // enrolment, enabled state and the password.
  const principal = await iamDriver.lookupIdentity({
    issuer: betterAuthIssuer(installationId),
    subject: recoveryUserId,
  });
  if (!principal || principal.kind !== "principal") {
    throw new ScopeViolationError("Recovery Principal is unavailable.");
  }
  const decision = await iamDriver.authorize({
    principalId: principal.id,
    action: "administer",
    resource: { kind: "installation", id: installationId },
  });
  if (!decision.allowed || decision.driverId !== iamDriver.id) {
    throw new ScopeViolationError("Recovery account must administer the Installation.");
  }
  const activation = await persistence.activateRecovery(recoveryUserId, principal.id, hooks);
  return { ...activation, recoveryUserId, seedIgnored };
}

/** Whether a Better Auth user's Principal holds Installation `administer`. */
async function administersInstallation(
  iamDriver: IAMDriver,
  installationId: string,
  userId: string,
): Promise<boolean> {
  const principal = await iamDriver.lookupIdentity({
    issuer: betterAuthIssuer(installationId),
    subject: userId,
  });
  if (!principal || principal.kind !== "principal") {
    return false;
  }
  const decision = await iamDriver.authorize({
    principalId: principal.id,
    action: "administer",
    resource: { kind: "installation", id: installationId },
  });
  return decision.allowed;
}

/**
 * The password-only profile's known-device account state: the user, its one password method
 * and that method's authentication version. Undefined without exactly one password.
 */
async function passwordKnownDeviceState(
  pool: SchemaAuthPoolV1,
  email: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{
    user_id: string;
    method_id: string;
    authentication_version: number;
  }>(
    `SELECT u.id AS user_id, m.id AS method_id, m.authentication_version
     FROM occ."user" u
     JOIN occ.account m ON m.user_id = u.id AND m.provider_id = 'credential'
       AND m.password IS NOT NULL AND m.password <> ''
     WHERE u.email = $1`,
    [email],
  );
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    return undefined;
  }
  return `password\0${row.user_id}\0${row.method_id}\0${row.authentication_version}`;
}

/** Hash a local password exactly as the controller's password sign-in verifies it. */
export async function hashLocalPassword(password: string): Promise<string> {
  if (password.length < LOCAL_PASSWORD_MIN_LENGTH || password.length > LOCAL_PASSWORD_MAX_LENGTH) {
    throw new Error(
      `Passwords must contain ${LOCAL_PASSWORD_MIN_LENGTH} to ${LOCAL_PASSWORD_MAX_LENGTH} characters.`,
    );
  }
  return hashPassword(password);
}

export async function createPostgresControllerAuth(
  options: PostgresControllerAuthOptions,
): Promise<ControllerAuth> {
  const {
    pool,
    state,
    iamDriver,
    github,
    google,
    oidc,
    passwordSignIn,
    onWarning,
    onUnmatchedCallback,
    cliSessionSettings: cliSettings = DEFAULT_CLI_SESSION_SETTINGS,
    ...controllerOptions
  } = options;
  // Sessions from an external provider instance outside this set (removed, or a changed
  // issuer or client ID) stop authenticating; password sessions are unaffected.
  const externalProviderIds = [
    ...(github === undefined ? [] : [githubProviderId(github)]),
    ...(google === undefined ? [] : [googleProviderId(google)]),
    ...(oidc === undefined ? [] : [oidcProviderId(oidc)]),
  ];
  const persistence =
    state === undefined
      ? undefined
      : new PostgresHumanAuthentication(
          state,
          options.installationId,
          betterAuthIssuer(options.installationId),
          { externalProviderIds },
        );
  // Any external provider activates the guarded profile; all share its recovery user.
  const recoveryUserId = github?.recoveryUserId ?? google?.recoveryUserId ?? oidc?.recoveryUserId;
  const guarded = recoveryUserId !== undefined;
  const providerLabel = github !== undefined ? "GitHub" : google !== undefined ? "Google" : "OIDC";
  if (!guarded && passwordSignIn !== undefined) {
    throw new Error("Recovery-only password sign-in requires GitHub, Google or OIDC sign-in.");
  }
  if (!guarded && persistence && (await persistence.recoveryDesignation())) {
    throw new Error(
      "An activated human authentication profile requires a configured external sign-in provider.",
    );
  }
  if (guarded) {
    if (
      [github, google, oidc].some(
        (provider) => provider !== undefined && provider.recoveryUserId !== recoveryUserId,
      )
    ) {
      throw new Error("GitHub, Google and OIDC sign-in require the same recovery user ID.");
    }
    if (!persistence || !(iamDriver instanceof NativeIAMDriver)) {
      throw new Error(
        `${providerLabel} sign-in requires original PostgreSQL State and the native IAM Driver.`,
      );
    }
    if (options.sharedCookieDomain !== undefined) {
      throw new Error(
        `${providerLabel} sign-in supports host-only cookies without shared native administration.`,
      );
    }
    if (options.mode === "production" && new URL(options.baseURL).protocol !== "https:") {
      throw new Error(`Production ${providerLabel} sign-in requires HTTPS.`);
    }
  }
  const humanLogin = !guarded
    ? undefined
    : createHumanLogin(
        persistence!,
        {
          recoveryUserId,
          ...(github === undefined ? {} : { github }),
          ...(google === undefined ? {} : { google }),
          ...(oidc === undefined ? {} : { oidc }),
          ...(passwordSignIn === undefined ? {} : { passwordSignIn }),
        },
        options.baseURL,
        {
          trustedClientAddress: controllerOptions.clientAddress !== undefined,
          ...(controllerOptions.onOperationalEvent === undefined
            ? {}
            : { onOperationalEvent: controllerOptions.onOperationalEvent }),
          ...(onUnmatchedCallback === undefined ? {} : { onUnmatchedCallback }),
        },
      );
  // RFC-0019 CLI sessions share the original State transaction and audit writer.
  const cliSessionStore = new PostgresCliSessions(
    state ??
      new PostgresPlatformState(
        pool as unknown as ConstructorParameters<typeof PostgresPlatformState>[0],
      ),
    options.installationId,
    betterAuthIssuer(options.installationId),
    {
      guarded,
      externalProviderIds,
      parentSessionKey: (sessionId) => sessionBindingKey(options.secret, sessionId),
    },
  );
  const auth = createControllerAuth({
    ...controllerOptions,
    cliSessions: { store: cliSessionStore, settings: cliSettings },
    ...(humanLogin === undefined ? {} : { humanLogin }),
    // Password-only: bind known-device entries to the password method's authentication
    // version, which the database bumps on every password change. The guarded profile's
    // state (bound to the enabled state, not the account version) comes from humanLogin.
    knownDeviceState: (email: string) => passwordKnownDeviceState(pool, email),
    ...(iamDriver === undefined
      ? {}
      : {
          passwordAdministrator: (userId: string) =>
            administersInstallation(iamDriver, options.installationId, userId),
        }),
    ...(humanLogin !== undefined || persistence === undefined
      ? {}
      : {
          passwordSignInAudit: {
            accepted: (userId: string) => persistence.recordPasswordLogin(userId),
            refused: () => persistence.recordDenied("INVALID_CREDENTIALS"),
          },
        }),
    database: await createOccAuthDatabase(pool),
  });
  // Finish static auth initialization before the one-way activation transaction.
  await auth.auth.$context;
  let activationSkipped: readonly string[] = [];
  let withoutExternalIdentity: readonly string[] = [];
  if (guarded) {
    const activation = await activateRecoveryAccount(
      persistence!,
      // Checked above: external sign-in requires the native IAM Driver.
      iamDriver as NativeIAMDriver,
      options.installationId,
      recoveryUserId,
    );
    if (activation.seedIgnored) {
      onWarning?.({
        event: "authentication.recovery-seed-warning",
        message:
          "OCC_AUTH_GITHUB_RECOVERY_USER_ID differs from the recorded recovery designation, which is kept.",
      });
    }
    activationSkipped = activation.skipped;
    const designation = await persistence!.recoveryDesignation();
    if (!designation) {
      throw new Error("Recovery designation is unavailable.");
    }
    // The recovery account's password lane stays admitted under sign-in floods. It follows the
    // stored designation, never the environment seed, which may name a replaced holder.
    humanLogin!.designateRecovery(designation.email);
    if (passwordSignIn === "recovery-only") {
      withoutExternalIdentity = await persistence!.accountsWithoutExternalIdentity(
        [
          humanLogin!.githubProviderId,
          humanLogin!.googleProviderId,
          humanLogin!.oidcProviderId,
        ].filter((providerId): providerId is string => providerId !== undefined),
      );
    }
  }
  return {
    ...auth,
    ...(activationSkipped.length === 0 ? {} : { activationSkipped }),
    ...(withoutExternalIdentity.length === 0 ? {} : { withoutExternalIdentity }),
    ...(humanLogin === undefined
      ? {}
      : {
          ...(humanLogin.githubProviderId === undefined
            ? {}
            : { githubProviderId: humanLogin.githubProviderId }),
          ...(humanLogin.googleProviderId === undefined
            ? {}
            : { googleProviderId: humanLogin.googleProviderId }),
          ...(humanLogin.oidcProviderId === undefined
            ? {}
            : { oidcProviderId: humanLogin.oidcProviderId }),
          readAccount: (userId: string, actor: HumanAuthenticationActor) =>
            persistence!.readAccount(userId, actor),
          ...(humanLogin.githubProviderId === undefined
            ? {}
            : {
                attachGitHub: (
                  userId: string,
                  subject: string,
                  actor: HumanAuthenticationActor,
                  expectedVersion: number,
                ) =>
                  persistence!.attachExternal(
                    userId,
                    humanLogin.githubProviderId!,
                    subject,
                    actor,
                    expectedVersion,
                  ),
              }),
          ...(humanLogin.googleProviderId === undefined
            ? {}
            : {
                attachGoogle: (
                  userId: string,
                  subject: string,
                  actor: HumanAuthenticationActor,
                  expectedVersion: number,
                ) =>
                  persistence!.attachExternal(
                    userId,
                    humanLogin.googleProviderId!,
                    subject,
                    actor,
                    expectedVersion,
                  ),
              }),
          ...(humanLogin.oidcProviderId === undefined
            ? {}
            : {
                attachOidc: (
                  userId: string,
                  subject: string,
                  actor: HumanAuthenticationActor,
                  expectedVersion: number,
                ) =>
                  persistence!.attachExternal(
                    userId,
                    humanLogin.oidcProviderId!,
                    subject,
                    actor,
                    expectedVersion,
                  ),
              }),
          changeAccount: (
            userId: string,
            operation: "disable" | "enable" | "revoke",
            actor: HumanAuthenticationActor,
            expectedVersion: number,
          ) => persistence!.changeAccount(userId, operation, actor, expectedVersion),
          readRecovery: (actor: HumanAuthenticationActor) => persistence!.readRecovery(actor),
          replaceRecovery: async (
            userId: string,
            principalId: string,
            expectedCurrentUserId: string,
            actor: HumanAuthenticationActor,
            expectedVersion: number,
          ) => {
            const { email, ...replaced } = await persistence!.replaceRecovery(
              userId,
              principalId,
              expectedCurrentUserId,
              actor,
              expectedVersion,
            );
            // Move the reserved password lane to the committed holder's email. The email comes
            // from the replacing transaction, so no later read can fail and leave the old holder
            // on the lane.
            humanLogin.designateRecovery(email);
            return replaced;
          },
          enrolAccount: (userId: string, actor: HumanAuthenticationActor) =>
            persistence!.enrolAccount(userId, actor),
          detachMethod: (
            userId: string,
            methodId: string,
            actor: HumanAuthenticationActor,
            expectedVersion: number,
          ) => persistence!.detachExternal(userId, methodId, actor, expectedVersion),
        }),
  };
}
