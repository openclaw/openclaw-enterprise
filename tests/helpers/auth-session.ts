import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { ControllerAuthOptions } from "../../apps/controller/src/auth/index.ts";
import type { ControllerApp, createFastifyApp } from "../../apps/controller/src/index.ts";
import { cookieHeaderFromSetCookie } from "../../packages/utils/src/index.ts";
import { createControllerAuth } from "./password-hasher.ts";

export { cookieHeaderFromSetCookie };

export const betterAuthSignInPath = "/api/auth/sign-in/email";

export type CookieHeaders = {
  getSetCookie?: () => string[];
  raw?: () => Record<string, string[]>;
  get?: (name: string) => string | null;
};
export type SignInResponse = {
  headers?: CookieHeaders;
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};
export type SignInCredentials = { email: string; password: string };
export type SignInSession = { cookie: string; origin: string; setCookie: string[] };
export type SignInOptions = SignInCredentials & {
  origin?: string | undefined;
  path?: string;
  rememberMe?: boolean | undefined;
  headers?: Record<string, string>;
};
export type SessionHeaderInput = string | { cookie: string; origin?: string | undefined };
export type SessionHeaders = { cookie: string; origin?: string };

type FetchSignIn<ResponseType extends SignInResponse> = (
  input: Request,
  init?: RequestInit,
) => Promise<ResponseType>;
type TestAuthPrincipalOptions = {
  installationId?: string;
  mode?: ControllerAuthOptions["mode"];
  baseURL?: string;
  email?: string;
  password?: string;
  name?: string;
  secret?: string;
  agentDomain?: string;
};
type SignInApp =
  ControllerApp | ({ fetch?: undefined } & Pick<ReturnType<typeof createFastifyApp>, "inject">);

export function setCookieHeaders(response: { headers?: CookieHeaders }): string[] {
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

export function signInWithEmailPassword(
  options: SignInOptions & { fetch?: undefined },
): Promise<SignInSession & { response: Response }>;
export function signInWithEmailPassword<ResponseType extends SignInResponse>(
  options: SignInOptions & { fetch: FetchSignIn<ResponseType> },
): Promise<SignInSession & { response: ResponseType }>;
export async function signInWithEmailPassword({
  fetch: fetchRequest = globalThis.fetch,
  origin = "https://console.oce.localhost",
  path = betterAuthSignInPath,
  email,
  password,
  rememberMe,
  headers = {},
}: SignInOptions & { fetch?: FetchSignIn<SignInResponse> | undefined }) {
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

export function authenticatedHeaders(
  session: SessionHeaderInput,
  headers?: undefined,
): SessionHeaders;
export function authenticatedHeaders<
  ExtraHeaders extends Record<string, string | number> & { origin?: string },
>(
  session: SessionHeaderInput,
  headers: ExtraHeaders,
): Omit<ExtraHeaders, "cookie" | "origin"> & SessionHeaders;
export function authenticatedHeaders(session: SessionHeaderInput, headers: object = {}) {
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

export async function createTestAuthPrincipal({
  installationId = `ins_${randomUUID()}`,
  mode = "development",
  baseURL = "https://console.oce.localhost",
  email = `admin-${randomUUID()}@example.com`,
  password = `generated-password-${randomUUID()}`,
  name = "Test Administrator",
  secret = `test-auth-secret-${randomUUID()}-${randomUUID()}`,
  agentDomain = "agents.oce.localhost",
}: TestAuthPrincipalOptions = {}) {
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

export async function signInToControllerApp(
  app: SignInApp,
  credentials: SignInCredentials,
  { origin }: { origin?: string | undefined } = {},
): Promise<SignInSession & { response: Response }> {
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
