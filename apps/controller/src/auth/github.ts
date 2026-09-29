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
import type {
  PostgresHumanAuthentication,
  HumanAuthenticationProof,
} from "@openclaw-enterprise/occ";
import {
  exchangeGoogleSubject,
  googleAuthorizationURL,
  googleNonce,
  type GoogleLoginConfiguration,
} from "./google.ts";
import {
  providerExchangeFailure,
  providerJSON,
  rejected,
  type ProviderExchange,
} from "./provider-transport.ts";
import { admissionKey, keyedAdmission } from "./admission.ts";

export interface GitHubLoginConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly recoveryUserId: string;
}

export function githubLoginConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubLoginConfiguration | undefined {
  const clientId = environment.OCC_AUTH_GITHUB_CLIENT_ID;
  const clientSecret = environment.OCC_AUTH_GITHUB_CLIENT_SECRET;
  const recoveryUserId = environment.OCC_AUTH_GITHUB_RECOVERY_USER_ID;
  // The recovery user ID alone may belong to another provider; see humanLoginConfiguration.
  if (clientId === undefined && clientSecret === undefined) {
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
  return { clientId, clientSecret, recoveryUserId };
}

interface ProviderClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface HumanLoginProviders {
  readonly recoveryUserId: string;
  readonly github?: ProviderClient;
  readonly google?: GoogleLoginConfiguration;
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

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function secret(): string {
  return randomBytes(32).toString("base64url");
}
const tokenEndpoint = "https://github.com/login/oauth/access_token";
const profileEndpoint = "https://api.github.com/user";

async function exchangeGithubSubject(
  config: ProviderClient,
  code: string,
  codeVerifier: string,
  redirectURI: string,
): Promise<ProviderExchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
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
    );
    if ("error" in data) {
      throw rejected();
    }
    const tokens = getOAuth2Tokens(data);
    if (typeof tokens.accessToken !== "string" || !tokens.accessToken) {
      throw rejected();
    }
    const profile = await providerJSON(
      profileEndpoint,
      {
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "User-Agent": "OpenClaw-Enterprise",
          accept: "application/vnd.github+json",
        },
      },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const subject = githubSubject(profile.id);
    if (!subject) {
      throw rejected();
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

function githubProvider(config: ProviderClient, baseURL: string): ExternalProvider {
  const providerId = `github:${digest(config.clientId)}`;
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
      exchangeGithubSubject(config, code, codeVerifier, callbackURL),
  };
}

function googleProvider(config: GoogleLoginConfiguration, baseURL: string): ExternalProvider {
  const providerId = `google:${digest(config.clientId)}`;
  const callbackURL = new URL("/api/auth/providers/google/callback", baseURL).href;
  return {
    providerId,
    attemptProviderId: `${providerId}:${digest(config.clientSecret)}`,
    callbackURL,
    // The nonce is recomputed from the callback's one-use state, binding the ID token to it.
    authorizationURL: (secret, state, codeVerifier) =>
      googleAuthorizationURL(config, state, codeVerifier, callbackURL, googleNonce(secret, state)),
    exchange: (secret, code, codeVerifier, state) =>
      exchangeGoogleSubject(config, code, codeVerifier, callbackURL, googleNonce(secret, state)),
  };
}

export function createHumanLogin(
  state: PostgresHumanAuthentication,
  config: HumanLoginProviders,
  baseURL: string,
) {
  if (config.github === undefined && config.google === undefined) {
    throw new Error("Guarded human sign-in requires a configured external sign-in provider.");
  }
  const proofScope = new AsyncLocalStorage<{ proof?: HumanAuthenticationProof }>();
  const githubLogin =
    config.github === undefined ? undefined : githubProvider(config.github, baseURL);
  const googleLogin =
    config.google === undefined ? undefined : googleProvider(config.google, baseURL);
  const secure = new URL(baseURL).protocol === "https:";
  const bindingCookie = secure ? "__Host-occ_login_attempt" : "occ_login_attempt";
  const receiptCookie = secure ? "__Host-occ_login_receipt" : "occ_login_receipt";
  const receiptAttributes = { httpOnly: true, secure, sameSite: "strict" as const, path: "/" };
  const receipts = receiptLedger();
  const cookieAttributes = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };

  // Callback denials say whether the attempt, the provider, or the identity failed.
  async function rejectExternal(
    reason: "INVALID_ATTEMPT" | "EXTERNAL_IDENTITY_REJECTED" | "PROVIDER_UNAVAILABLE",
  ): Promise<never> {
    await state.recordDenied(reason);
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

  // Single-controller admission keeps a bounded table of hashed client-address and email keys,
  // each with a one-minute budget and an active-request cap, under concurrency-only global lanes.
  // The recovery account keeps a reserved password lane during provider outage or login floods.
  const admitPassword = keyedAdmission(
    { perMinute: 10, concurrent: 2 },
    { concurrent: 4, reserved: 1 },
    { perMinute: 20, concurrent: 2 },
  );
  // Every external provider shares one budget, so enabling another does not raise it.
  const admitExternal = keyedAdmission(
    { perMinute: 30, concurrent: 4 },
    { concurrent: 8, reserved: 0 },
  );
  let recoveryEmail: string | undefined;
  function designateRecovery(email: string): void {
    recoveryEmail = email.trim().toLowerCase();
  }
  // Start, callback and result for one external provider. Every provider shares the
  // admission budget, the browser-bound attempt and receipt cookies, PKCE and session binding.
  function externalProviderEndpoints(name: "github" | "google", provider: ExternalProvider) {
    return {
      start: createAuthEndpoint(`/oce/providers/${name}/start`, { method: "POST" }, async (ctx) =>
        admitExternal.admit([admissionKey("ip", ctx.headers?.get("x-occ-client-ip"))], async () => {
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
          admitExternal.admit(
            [admissionKey("ip", ctx.headers?.get("x-occ-client-ip"))],
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
                (!error && (!code || code.length > 1024)) ||
                (error && (error.length > 200 || code))
              ) {
                return rejectExternal("INVALID_ATTEMPT");
              }
              const attempt = await state.consumeAttempt({
                stateHash: digest(stateValue),
                browserHash: digest(browser),
                providerId: provider.attemptProviderId,
                callbackURL: provider.callbackURL,
              });
              if (!attempt) {
                return rejectExternal("INVALID_ATTEMPT");
              }
              if (error) {
                // RFC 6749 section 4.1.2.1: the provider reports its own failure.
                return rejectExternal(
                  error === "server_error" || error === "temporarily_unavailable"
                    ? "PROVIDER_UNAVAILABLE"
                    : "EXTERNAL_IDENTITY_REJECTED",
                );
              }
              ctx.setCookie(bindingCookie, "", { ...cookieAttributes, maxAge: 0 });
              const exchange = await provider.exchange(
                ctx.context.secret,
                code!,
                attempt.codeVerifier,
                stateValue,
              );
              if ("denial" in exchange) {
                return rejectExternal(exchange.denial);
              }
              const snapshot = await state.snapshotExternal(
                provider.providerId,
                exchange.subject,
                attempt.createdAt,
              );
              if (!snapshot) {
                return rejectExternal("EXTERNAL_IDENTITY_REJECTED");
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
              // The redirect carries no secret. The starting tab exchanges this
              // receipt for the key of exactly the session this attempt created.
              ctx.setCookie(
                receiptCookie,
                signLoginReceipt(ctx.context.secret, {
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
        admitExternal.admit([admissionKey("ip", ctx.headers?.get("x-occ-client-ip"))], async () => {
          const body = ctx.body as { attemptId?: unknown } | undefined;
          const now = Date.now();
          const receipt = verifyLoginReceipt(ctx.context.secret, ctx.getCookie(receiptCookie), now);
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
        }),
      ),
    };
  }
  const githubEndpoints =
    githubLogin === undefined ? undefined : externalProviderEndpoints("github", githubLogin);
  const googleEndpoints =
    googleLogin === undefined ? undefined : externalProviderEndpoints("google", googleLogin);
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
        const email = body.email.trim().toLowerCase();
        const password = body.password;
        const work = async () => {
          if (password.length < 12 || password.length > 128) {
            throw rejected();
          }
          const snapshot = await state.snapshotPassword(email);
          if (!snapshot?.proof.passwordHash) {
            await ctx.context.password.hash(password);
            await state.recordDenied("INVALID_CREDENTIALS");
            throw rejected();
          }
          if (
            !(await ctx.context.password.verify({
              password,
              hash: snapshot.proof.passwordHash,
            }))
          ) {
            await state.recordDenied("INVALID_CREDENTIALS");
            throw rejected();
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
          return ctx.json({
            authenticated: true,
            sessionKey: sessionBindingKey(ctx.context.secret, session.id),
          });
        };
        return recoveryEmail !== undefined && email === recoveryEmail
          ? admitPassword.admitRecovery(work)
          : admitPassword.admit(
              [
                admissionKey("ip", ctx.headers?.get("x-occ-client-ip")),
                admissionKey("email", email),
              ],
              work,
            );
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
    },
  } satisfies BetterAuthPlugin;
  return {
    plugin,
    database,
    ...(githubLogin === undefined ? {} : { githubProviderId: githubLogin.providerId }),
    ...(googleLogin === undefined ? {} : { googleProviderId: googleLogin.providerId }),
    designateRecovery,
  };
}
