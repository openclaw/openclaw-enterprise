import { cookieHeaderFromSetCookie } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createControllerAuth } from "./password-hasher.mjs";

export { cookieHeaderFromSetCookie };

export const betterAuthSignInPath = "/api/auth/sign-in/email";

/**
 * @typedef {{ getSetCookie?: () => string[], raw?: () => Record<string, string[]>,
 *   get?: (name: string) => string | null }} CookieHeaders
 * @typedef {{ headers?: CookieHeaders, ok: boolean, status: number,
 *   text: () => Promise<string> }} SignInResponse
 * @typedef {{ email: string, password: string }} SignInCredentials
 * @typedef {{ cookie: string, origin: string, setCookie: string[] }} SignInSession
 */

/** @param {{ headers?: CookieHeaders }} response @returns {string[]} */
export function setCookieHeaders(response) {
  const headers = response.headers;
  if (headers === undefined) {
    return [];
  }

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  if (typeof headers.raw === "function") {
    const raw = headers.raw();
    const values = raw["set-cookie"];
    if (Array.isArray(values)) {
      return values;
    }
  }

  const single = typeof headers.get === "function" ? headers.get("set-cookie") : null;
  return single === null ? [] : [single];
}

/**
 * @typedef {SignInCredentials & {origin?: string | undefined, path?: string,
 *   rememberMe?: boolean | undefined, headers?: Record<string, string>}} SignInOptions
 */
/**
 * @overload
 * @param {SignInOptions & {fetch?: undefined}} options
 * @returns {Promise<SignInSession & {response: Response}>}
 */
/**
 * @template {SignInResponse} ResponseType
 * @overload
 * @param {SignInOptions & {fetch: (input: Request, init?: RequestInit) => Promise<ResponseType>}} options
 * @returns {Promise<SignInSession & {response: ResponseType}>}
 */
/** @param {SignInOptions & {fetch?: ((input: Request, init?: RequestInit) => Promise<SignInResponse>) | undefined}} options */
export async function signInWithEmailPassword({
  fetch: fetchRequest = globalThis.fetch,
  origin = "https://console.oce.localhost",
  path = betterAuthSignInPath,
  email,
  password,
  rememberMe,
  headers = {},
}) {
  assert.equal(typeof fetchRequest, "function", "a Fetch-compatible dispatcher is required");
  assert.equal(typeof email, "string", "email is required");
  assert.equal(typeof password, "string", "password is required");

  const body = {
    email,
    password,
    ...(rememberMe === undefined ? {} : { rememberMe }),
  };
  const response = await fetchRequest(
    new Request(new URL(path, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Better Auth email/password sign-in failed with HTTP ${response.status}${
        details.length === 0 ? "" : `: ${details}`
      }`,
    );
  }

  const setCookie = setCookieHeaders(response);
  const cookie = cookieHeaderFromSetCookie(setCookie);
  assert.ok(cookie.length > 0, "Better Auth sign-in must issue a session cookie");
  return { response, setCookie, cookie, origin: new URL(origin).origin };
}

/** @typedef {string | {cookie: string, origin?: string | undefined}} SessionHeaderInput */
/** @typedef {{cookie: string, origin?: string}} SessionHeaders */

/**
 * @overload
 * @param {SessionHeaderInput} session
 * @param {undefined} [headers]
 * @returns {SessionHeaders}
 */
/**
 * @template {Record<string, string | number> & {origin?: string}} ExtraHeaders
 * @overload
 * @param {SessionHeaderInput} session
 * @param {ExtraHeaders} headers
 * @returns {Omit<ExtraHeaders, "cookie" | "origin"> & SessionHeaders}
 */
/**
 * @param {SessionHeaderInput} session
 * @param {object} [headers]
 */
export function authenticatedHeaders(session, headers = {}) {
  const cookie = typeof session === "string" ? session : session.cookie;
  assert.equal(typeof cookie, "string", "a session cookie header is required");
  assert.ok(cookie.length > 0, "a session cookie header is required");
  return {
    ...(typeof session === "string" || session.origin === undefined
      ? {}
      : { origin: session.origin }),
    ...headers,
    cookie,
  };
}

/**
 * @param {{installationId?: string, mode?: import("../../apps/controller/src/auth/index.ts").ControllerAuthOptions["mode"],
 *   baseURL?: string, email?: string, password?: string, name?: string, secret?: string,
 *   agentDomain?: string}} [options]
 */
export async function createTestAuthPrincipal({
  installationId = `ins_${randomUUID()}`,
  mode = "development",
  baseURL = "https://console.oce.localhost",
  email = `admin-${randomUUID()}@example.com`,
  password = `generated-password-${randomUUID()}`,
  name = "Test Administrator",
  secret = `test-auth-secret-${randomUUID()}-${randomUUID()}`,
  agentDomain = "agents.oce.localhost",
} = {}) {
  const auth = createControllerAuth({
    mode,
    installationId,
    baseURL,
    agentDomain,
    secret,
  });
  const account = await auth.createAccount({ email, password, name });
  const seed = auth.principalSeed(account, { grant: "administrator" });
  return { auth, account, seed, installationId, email, password, name };
}

/**
 * @param {import("../../apps/controller/src/index.ts").ControllerApp
 *   | ({fetch?: undefined} & Pick<ReturnType<typeof import("../../apps/controller/src/index.ts").createFastifyApp>, "inject">)} app
 * @param {SignInCredentials} credentials
 * @param {{origin?: string | undefined}} [options]
 * @returns {Promise<SignInSession & { response: Response }>}
 */
export async function signInToControllerApp(app, credentials, { origin } = {}) {
  return signInWithEmailPassword({
    origin,
    fetch:
      typeof app.fetch === "function"
        ? app.fetch.bind(app)
        : async (request) => {
            const url = new URL(request.url);
            const response = await app.inject({
              method: "POST",
              url: `${url.pathname}${url.search}`,
              headers: { ...Object.fromEntries(request.headers), host: url.host },
              ...(request.body === null
                ? {}
                : { payload: Buffer.from(await request.arrayBuffer()) }),
              remoteAddress: "127.0.0.1",
            });
            const headers = new Headers();
            for (const [name, values] of Object.entries(response.headers)) {
              for (const value of Array.isArray(values) ? values : [values]) {
                if (value !== undefined) {
                  headers.append(name, String(value));
                }
              }
            }
            return new Response(
              response.statusCode === 204 ? null : new Uint8Array(response.rawPayload),
              {
                status: response.statusCode,
                headers,
              },
            );
          },
    email: credentials.email,
    password: credentials.password,
  });
}

export async function createAuthenticatedControllerRequest(
  app,
  credentials,
  requestOrigin = "https://console.oce.localhost",
) {
  const session = await signInToControllerApp(app, credentials, { origin: requestOrigin });
  return async (method, url, payload) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...authenticatedHeaders(session),
        host: new URL(requestOrigin).host,
        origin: requestOrigin,
      },
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      ...(response.body.length === 0 ? {} : response.json()),
    };
  };
}

export async function bootstrapControllerInstallation(app, credentials, name) {
  const request = await createAuthenticatedControllerRequest(app, credentials);
  const response = await request("POST", "/installation/bootstrap", { name });
  assert.equal(response.status, 201, "the isolated PostgreSQL database must bootstrap once");
}
