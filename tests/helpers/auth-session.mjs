import assert from "node:assert/strict";

import { authenticatedHeaders, signInToControllerApp } from "./auth-session.ts";

export {
  cookieHeaderFromSetCookie,
  betterAuthSignInPath,
  setCookieHeaders,
  signInWithEmailPassword,
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "./auth-session.ts";

/**
 * @typedef {import("./auth-session.ts").CookieHeaders} CookieHeaders
 * @typedef {import("./auth-session.ts").SignInResponse} SignInResponse
 * @typedef {import("./auth-session.ts").SignInCredentials} SignInCredentials
 * @typedef {import("./auth-session.ts").SignInSession} SignInSession
 * @typedef {import("./auth-session.ts").SignInOptions} SignInOptions
 * @typedef {import("./auth-session.ts").SessionHeaderInput} SessionHeaderInput
 * @typedef {import("./auth-session.ts").SessionHeaders} SessionHeaders
 */

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
