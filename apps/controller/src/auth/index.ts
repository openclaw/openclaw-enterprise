import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import { APIError, betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { splitSetCookieHeader } from "better-auth/cookies";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { apiKey } from "@better-auth/api-key";
import type { ApiKey } from "@better-auth/api-key/types";
import { parse as parseDomain } from "tldts";
import type { ServicePrincipal } from "@openclaw-enterprise/contracts";
import { createAuthPrincipalSeed, type AuthPrincipalSeed } from "@openclaw-enterprise/iam";
import type { PostgresPool } from "@openclaw-enterprise/occ";
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
export const OCC_SHARED_AUTH_COOKIE_PREFIX = "openclaw_occ_shared";
export const OCC_SERVICE_KEY_HEADER = "x-api-key";
const SERVICE_KEY_CONFIG = "occ-service";
const SAFE_COOKIE_DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
type ControllerBetterAuth = Auth<BetterAuthOptions & { plugins: ReturnType<typeof apiKey>[] }>;

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
}

export interface PostgresControllerAuthOptions extends Omit<
  ControllerAuthOptions,
  "database" | "memoryDatabase"
> {
  readonly pool: PostgresPool;
}

export interface AuthenticatedAccount {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export type AuthenticatedSession = AdmittedSession;

export interface ProvisionAuthAccountInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

export { AuthAccountRoleNotFoundError, type AuthPrincipalSeed } from "@openclaw-enterprise/iam";

export interface AuthPrincipalSeedOptions {
  readonly roleId?: string;
}

export interface ControllerAuth {
  readonly auth: ControllerBetterAuth;
  readonly issuer: string;
  readonly sessionCookieName: string;
  readonly sharedCookieDomain?: string;
  readonly admissionVerifier: ControllerAdmissionVerifier;
  createAccount(input: ProvisionAuthAccountInput): Promise<AuthenticatedAccount>;
  deleteAccount(account: Pick<AuthenticatedAccount, "id">): Promise<void>;
  principalSeed(
    account: Pick<AuthenticatedAccount, "id">,
    options?: AuthPrincipalSeedOptions,
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
          status === 401 ? "UNAUTHENTICATED" : status === 409 ? "RESOURCE_CONFLICT" : "FORBIDDEN",
      };
    }
    if (error instanceof APIError) {
      return { status: 401, code: "UNAUTHENTICATED" };
    }
  }
  return { status: 503, code: "DEPENDENCY_UNAVAILABLE" };
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

function accountName(input: ProvisionAuthAccountInput): string {
  return input.name?.trim() || input.email.trim();
}

function safeSessionResponse(response: unknown): {
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
    sessionKey,
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

  constructor(auth: ControllerBetterAuth, installationId: string, cookieName: string) {
    this.#auth = auth;
    this.#sessionCookieName = cookieName;
    this.#installationId = installationId;
    this.#issuer = betterAuthIssuer(installationId);
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
    throw new Error("OCC_AUTH_BASE_URL must be an HTTP URL.");
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
  const cookiePrefix =
    sharedCookieDomain === undefined ? OCC_AUTH_COOKIE_PREFIX : OCC_SHARED_AUTH_COOKIE_PREFIX;
  const sessionCookieBaseName = `${cookiePrefix}.session_token`;
  const sessionCookieName =
    new URL(options.baseURL).protocol === "https:"
      ? `__Secure-${sessionCookieBaseName}`
      : sessionCookieBaseName;
  const hostOnlySessionCookieCleanup = hostOnlySessionCookieClearance(
    sharedCookieDomain !== undefined,
    cookiePrefix,
  );
  const issuer = betterAuthIssuer(options.installationId);
  const auth = betterAuth<BetterAuthOptions & { plugins: ReturnType<typeof apiKey>[] }>({
    appName: "OpenClaw Enterprise Controller",
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: options.secret,
    database:
      options.database ??
      memoryAdapter(
        options.memoryDatabase ?? {
          user: [],
          session: [],
          account: [],
          verification: [],
          apikey: [],
        },
      ),
    plugins: [
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
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    trustedOrigins: [options.baseURL],
    rateLimit: { enabled: true },
    advanced: {
      cookiePrefix,
      ...(sharedCookieDomain === undefined
        ? {}
        : { crossSubDomainCookies: { enabled: true, domain: sharedCookieDomain } }),
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure:
          sharedCookieDomain !== undefined ||
          (options.secureCookies ?? options.mode === "production"),
      },
    },
  });
  const api = auth.api;

  async function createAccount(input: ProvisionAuthAccountInput): Promise<AuthenticatedAccount> {
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
    const hash = await context.password.hash(password);
    const created = await context.internalAdapter.createUser(
      {
        email,
        name: accountName({ ...input, email }),
        emailVerified: true,
      },
      { method: "admin" },
    );
    try {
      await context.internalAdapter.linkAccount({
        userId: created.id,
        providerId: "credential",
        accountId: created.id,
        password: hash,
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

  async function signInEmail(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      () => {
        // Better Auth server API calls skip origin middleware without a Request context.
        requireTrustedBrowserOrigin(request, expectedBrowserOrigin);
        const body = ensureEmailPassword(authBody(request));
        return api.signInEmail({
          body: { ...body, rememberMe: true },
          headers: authHeaders(request.headers),
          asResponse: false,
          returnHeaders: true,
          returnStatus: true,
        });
      },
      () => ({ authenticated: true }),
      "The caller did not provide valid authentication credentials.",
      hostOnlySessionCookieCleanup,
    );
  }

  async function signOut(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      () => {
        // Better Auth server API calls skip origin middleware without a Request context.
        requireTrustedBrowserOrigin(request, expectedBrowserOrigin);
        return api.signOut({
          headers: sessionHeaders(request.headers, sessionCookieName),
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
      () =>
        api.getSession({
          headers: sessionHeaders(request.headers, sessionCookieName),
          query: { disableCookieCache: true, disableRefresh: true },
          asResponse: false,
          returnHeaders: true,
          returnStatus: true,
        }),
      safeSessionResponse,
      "The controller session could not be resolved.",
    );
  }

  async function resolveSession(
    request: FastifyRequest,
  ): Promise<AuthenticatedSession | undefined> {
    const result = await api.getSession({
      headers: sessionHeaders(request.headers, sessionCookieName),
      query: { disableCookieCache: true, disableRefresh: true },
      asResponse: false,
      returnHeaders: false,
      returnStatus: false,
    });
    return safeAuthenticatedSession(result);
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
    ),
    createAccount,
    deleteAccount,
    principalSeed: (
      account: Pick<AuthenticatedAccount, "id">,
      seedOptions?: AuthPrincipalSeedOptions,
    ) =>
      createAuthPrincipalSeed(
        options.installationId,
        betterAuthIssuer(options.installationId),
        account,
        seedOptions,
      ),
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

export async function createPostgresControllerAuth(
  options: PostgresControllerAuthOptions,
): Promise<ControllerAuth> {
  const { pool, ...controllerOptions } = options;
  return createControllerAuth({
    ...controllerOptions,
    database: await createOccAuthDatabase(pool),
  });
}
