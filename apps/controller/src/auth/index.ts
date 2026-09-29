import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
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
  PostgresHumanAuthentication,
  ScopeViolationError,
  type HumanAuthenticationActivation,
  type HumanAuthenticationActivationHooks,
  type HumanAuthenticationActor,
  type HumanAuthenticationRecovery,
  type HumanAuthenticationAccount,
  type PostgresPool,
  type PostgresPlatformState,
  type PreparedPasswordAccount,
} from "@openclaw-enterprise/occ";
import type { IAMDriver } from "@openclaw-enterprise/contracts";
import {
  createHumanLogin,
  githubLoginConfiguration,
  type GitHubLoginConfiguration,
} from "./github.ts";
import { googleLoginConfiguration, type GoogleSignInConfiguration } from "./google.ts";
import { sessionBindingKey, sessionKeyHeader, sessionKeyMatches } from "./session-binding.ts";
import { resolveClientAddress, type ClientAddressConfiguration } from "./client-address.ts";
import {
  SignInRateLimited,
  passwordFailureAdmission,
  passwordFailureBudget,
  type PasswordSignInAdmission,
} from "./admission.ts";

export { githubLoginConfiguration, type GitHubLoginConfiguration } from "./github.ts";
export {
  googleLoginConfiguration,
  type GoogleLoginConfiguration,
  type GoogleSignInConfiguration,
} from "./google.ts";

export interface HumanLoginConfiguration {
  readonly github?: GitHubLoginConfiguration;
  readonly google?: GoogleSignInConfiguration;
}

/**
 * Parses every external sign-in provider. The recovery user ID (still named
 * OCC_AUTH_GITHUB_RECOVERY_USER_ID) seeds the guarded profile, so it is required exactly
 * when at least one provider is configured.
 */
export function humanLoginConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): HumanLoginConfiguration {
  const github = githubLoginConfiguration(environment);
  const google = googleLoginConfiguration(environment);
  const recoveryUserId = environment.OCC_AUTH_GITHUB_RECOVERY_USER_ID;
  if (github === undefined && google === undefined) {
    if (recoveryUserId !== undefined) {
      throw new Error(
        "External sign-in requires client ID, client secret and recovery user ID for GitHub or Google.",
      );
    }
    return {};
  }
  if (
    google !== undefined &&
    (recoveryUserId === undefined || recoveryUserId.trim().length === 0)
  ) {
    throw new Error("Google sign-in requires client ID, client secret and recovery user ID.");
  }
  return {
    ...(github === undefined ? {} : { github }),
    ...(google === undefined ? {} : { google: { ...google, recoveryUserId: recoveryUserId! } }),
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
import { AdmissionFailure } from "../admission/admission-verifier.ts";

export const OCC_BETTER_AUTH_ISSUER_PREFIX = "occ:installation:";
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
   * Password-only profile: whether a user administers the Installation. Once the shared
   * budget is spent, only administrators' passwords are still checked (slowly). Without it
   * no account is.
   */
  readonly passwordAdministrator?: (userId: string) => Promise<boolean>;
  /** Password-only profile: replaces the in-memory failure-counting admission. */
  readonly passwordAdmission?: PasswordSignInAdmission;
}

export interface PostgresControllerAuthOptions extends Omit<
  ControllerAuthOptions,
  "database" | "memoryDatabase"
> {
  readonly pool: PostgresPool;
  readonly state?: PostgresPlatformState;
  readonly iamDriver?: IAMDriver;
  readonly github?: GitHubLoginConfiguration;
  readonly google?: GoogleSignInConfiguration;
  /** Receives nonfatal startup conditions as structured log events. */
  readonly onWarning?: (event: { readonly event: string; readonly message: string }) => void;
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
  githubStart(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  githubCallback(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  githubResult(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  readonly googleEnabled: boolean;
  /** Provider-instance key for Google identities; set only while Google sign-in is configured. */
  readonly googleProviderId?: string;
  googleStart(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  googleCallback(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  googleResult(request: FastifyRequest, reply: FastifyReply): Promise<void>;
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
}

function validHttpBaseURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === "/" &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

export function betterAuthIssuer(installationId: string): string {
  if (!isNonEmptyString(installationId)) {
    throw new Error("Better Auth issuer requires an Installation.");
  }
  return `${OCC_BETTER_AUTH_ISSUER_PREFIX}${installationId}:better-auth`;
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

// Credential rejections spend the password budget; dependency failures do not.
function countsAsSignInFailure(error: unknown): boolean {
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

function requireTrustedBrowserOrigin(request: FastifyRequest, expectedOrigin: string): void {
  const origin = request.headers.origin;
  if (Array.isArray(origin)) {
    throw new AdmissionFailure(403, "FORBIDDEN", "The browser origin is not trusted.");
  }
  if (origin !== undefined) {
    if (origin !== expectedOrigin) {
      throw new AdmissionFailure(403, "FORBIDDEN", "The browser origin is not trusted.");
    }
    return;
  }

  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new AdmissionFailure(403, "FORBIDDEN", "The browser origin is not trusted.");
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
    throw new AdmissionFailure(403, "FORBIDDEN", "The browser origin is not trusted.");
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
      error: { code: failure.code, message: failureMessage },
      meta: { requestId: request.id },
    });
  }
}

const requireOccDependency = createRequire(
  new URL("../../../../packages/occ/package.json", import.meta.url),
);

async function createOccAuthDatabase(
  pool: PostgresPool,
): Promise<NonNullable<BetterAuthOptions["database"]>> {
  const { drizzle } = (await import(requireOccDependency.resolve("drizzle-orm/node-postgres"))) as {
    drizzle: (pool: unknown, config: { readonly schema: unknown }) => unknown;
  };
  const { drizzleAdapter } = (await import("better-auth/adapters/drizzle")) as unknown as {
    drizzleAdapter: (
      database: unknown,
      options: {
        readonly provider: "pg";
        readonly schema: unknown;
        readonly camelCase: true;
        readonly transaction: true;
      },
    ) => NonNullable<BetterAuthOptions["database"]>;
  };
  const occPostgresSchema = await import(
    new URL("../../../../packages/occ/src/state/postgres-schema.ts", import.meta.url).href
  );
  return drizzleAdapter(drizzle(pool, { schema: occPostgresSchema }), {
    provider: "pg",
    schema: occPostgresSchema,
    camelCase: true,
    transaction: true,
  });
}

export class ControllerAdmissionVerifier implements AdmissionVerifier {
  readonly #auth: ControllerBetterAuth;
  readonly #installationId: string;
  readonly #issuer: string;
  readonly #sessionCookieName: string;
  readonly #secret: string;
  readonly #browserOrigin: string;

  constructor(
    auth: ControllerBetterAuth,
    installationId: string,
    cookieName: string,
    secret: string,
    browserOrigin: string,
  ) {
    this.#auth = auth;
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
    appName: "OpenClaw Enterprise Controller",
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
      ? {}
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
  // Password-only profile: failure-counting admission keyed on email and, behind a trusted
  // proxy, client address; administrators are slowed, never refused (see admission.ts).
  const passwordAdmission =
    humanLogin !== undefined
      ? undefined
      : (options.passwordAdmission ??
        passwordFailureAdmission({
          ...passwordFailureBudget,
          countsAsFailure: countsAsSignInFailure,
          // Timing differences here are hidden by the slow lane's floor. Lookup failures
          // propagate, so an outage is 503 rather than a refusal.
          async isReserved(email) {
            if (options.passwordAdministrator === undefined) {
              return false;
            }
            const found = await (await auth.$context).internalAdapter.findUserByEmail(email);
            return found !== null && (await options.passwordAdministrator(found.user.id));
          },
        }));

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
        throw new Error("Authentication dependency unavailable.");
      }
      throw new AdmissionFailure(401, "UNAUTHENTICATED", "Authentication was not accepted.");
    }
    return { response: await response.json(), headers: response.headers, status: response.status };
  }

  // Browser endpoints for one external provider; its absence is a 403 (start/result) or
  // the console error redirect (callback), as before.
  function externalProviderRoutes(name: "github" | "google", label: string) {
    const configured =
      name === "github"
        ? humanLogin?.githubProviderId !== undefined
        : humanLogin?.googleProviderId !== undefined;
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
        } catch {
          reply.redirect(`/console/?authError=${name}`);
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

  async function signInEmail(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      () => {
        // Better Auth server API calls skip origin middleware without a Request context.
        requireTrustedBrowserOrigin(request, expectedBrowserOrigin);
        const input = authBody(request);
        const body = ensureEmailPassword(input);
        if (humanLogin) {
          return runPrivateEndpoint(request, "/oce/password", body);
        }
        // The address lane needs a trusted proxy: without one, browsers behind the ingress
        // share its address, so only the email lane applies.
        const attempt = {
          ...(options.clientAddress === undefined
            ? {}
            : { clientAddress: clientAddressOf(request) }),
          // Read from the validated input, not the credential pair, so the admission key
          // is plainly derived from the email alone.
          email: String(input.email).trim().toLowerCase(),
        };
        return passwordAdmission!.admit(attempt, () =>
          api.signInEmail({
            body: { ...body, rememberMe: true },
            headers: authHeaders(request.headers),
            asResponse: false,
            returnHeaders: true,
            returnStatus: true,
          }),
        );
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

  return {
    auth,
    issuer,
    sessionCookieName,
    ...(sharedCookieDomain === undefined ? {} : { sharedCookieDomain }),
    admissionVerifier: new ControllerAdmissionVerifier(
      auth,
      options.installationId,
      sessionCookieName,
      options.secret,
      expectedBrowserOrigin,
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
    githubStart: githubRoutes.start,
    githubCallback: githubRoutes.callback,
    githubResult: githubRoutes.result,
    googleEnabled: humanLogin?.googleProviderId !== undefined,
    googleStart: googleRoutes.start,
    googleCallback: googleRoutes.callback,
    googleResult: googleRoutes.result,
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
  const { pool, state, iamDriver, github, google, onWarning, ...controllerOptions } = options;
  const persistence =
    state === undefined
      ? undefined
      : new PostgresHumanAuthentication(
          state,
          options.installationId,
          betterAuthIssuer(options.installationId),
        );
  // Either external provider activates the guarded profile; both share its recovery user.
  const recoveryUserId = github?.recoveryUserId ?? google?.recoveryUserId;
  const guarded = recoveryUserId !== undefined;
  const providerLabel = github === undefined ? "Google" : "GitHub";
  if (!guarded && persistence && (await persistence.recoveryDesignation())) {
    throw new Error(
      "An activated human authentication profile requires a configured external sign-in provider.",
    );
  }
  if (guarded) {
    if (
      github !== undefined &&
      google !== undefined &&
      github.recoveryUserId !== google.recoveryUserId
    ) {
      throw new Error("GitHub and Google sign-in require the same recovery user ID.");
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
        },
        options.baseURL,
      );
  const auth = createControllerAuth({
    ...controllerOptions,
    ...(humanLogin === undefined ? {} : { humanLogin }),
    ...(humanLogin !== undefined || iamDriver === undefined
      ? {}
      : {
          passwordAdministrator: (userId: string) =>
            administersInstallation(iamDriver, options.installationId, userId),
        }),
    database: await createOccAuthDatabase(pool),
  });
  // Finish static auth initialization before the one-way activation transaction.
  await auth.auth.$context;
  let activationSkipped: readonly string[] = [];
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
  }
  return {
    ...auth,
    ...(activationSkipped.length === 0 ? {} : { activationSkipped }),
    ...(humanLogin === undefined
      ? {}
      : {
          ...(humanLogin.githubProviderId === undefined
            ? {}
            : { githubProviderId: humanLogin.githubProviderId }),
          ...(humanLogin.googleProviderId === undefined
            ? {}
            : { googleProviderId: humanLogin.googleProviderId }),
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
