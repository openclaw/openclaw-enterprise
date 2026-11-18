import { createHash, randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import type { createFastifyApp } from "../../apps/controller/src/index.ts";
import { asRecord, cookieHeaderFromSetCookie } from "../../packages/utils/src/index.ts";
import { idTokenSigner, rsaSigningKey } from "./id-token.mjs";

type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  hd?: string;
};

export type GoogleAuthorization = {
  subject: string;
  claims?: Record<string, unknown>;
  key?: "published" | "foreign";
};

type GoogleGrant = Required<GoogleAuthorization> & {
  request: Record<string, string>;
};

/** Signed Google token fixture. Only upstream HTTP is simulated. */
export function fakeGoogle(
  t: Pick<TestContext, "mock">,
  { clientId, clientSecret, hd }: GoogleCredentials,
) {
  const published = rsaSigningKey("fixture-google-kid");
  const signToken = idTokenSigner(published);
  // An unpublished key: its token's header still names the published kid, so it does not verify.
  const foreign = rsaSigningKey(published.kid);
  const codes = new Map<string, GoogleGrant>();
  const authorizations: Record<string, string>[] = [];
  const tokens: Record<string, string>[] = [];
  const fixture = {
    mode: "up" as "up" | "error",
    requests: 0,
    authorizations,
    tokens,
    discovery: Object.freeze({
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "email", "profile"],
      code_challenge_methods_supported: ["plain", "S256"],
    }),
    jwks: Object.freeze({ keys: [published.jwk] }),
    authorize(url: string | URL, { subject, claims = {}, key = "published" }: GoogleAuthorization) {
      const parameters = new URL(url).searchParams;
      const code = `fixture-google-code-${randomBytes(12).toString("base64url")}`;
      const request = Object.fromEntries(parameters);
      fixture.authorizations.push(request);
      codes.set(code, { request, subject, claims, key });
      return code;
    },
  };
  function idToken({ request, subject, claims, key }: GoogleGrant) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: "https://accounts.google.com",
      azp: clientId,
      aud: clientId,
      sub: subject,
      email: `${subject}@${hd ?? "gmail.com"}`,
      email_verified: true,
      ...(hd === undefined ? {} : { hd }),
      nonce: request.nonce,
      iat: now - 5,
      exp: now + 3600,
      ...claims,
    };
    return signToken(payload, key === "foreign" ? { key: foreign.privateKey } : {});
  }
  const json = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  async function answer(request: Request): Promise<Response> {
    fixture.requests += 1;
    if (fixture.mode === "error") {
      return json(503, {});
    }
    const url = new URL(request.url);
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/oauth2/v3/certs") {
      return request.method === "GET" ? json(200, fixture.jwks) : json(405, {});
    }
    if (url.origin !== "https://oauth2.googleapis.com" || url.pathname !== "/token") {
      return json(404, {});
    }
    const form = new URLSearchParams(await request.text());
    const basic = /^Basic (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const [basicId, basicSecret] =
      basic === undefined
        ? []
        : Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent);
    const code = form.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code);
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    fixture.tokens.push(Object.fromEntries(form));
    if (
      request.method !== "POST" ||
      form.get("grant_type") !== "authorization_code" ||
      (form.get("client_id") ?? basicId) !== clientId ||
      (form.get("client_secret") ?? basicSecret) !== clientSecret ||
      grant === undefined ||
      grant.request.client_id !== clientId ||
      grant.request.code_challenge_method !== "S256" ||
      grant.request.code_challenge !== challenge ||
      form.get("redirect_uri") !== grant.request.redirect_uri
    ) {
      return json(400, { error: "invalid_grant" });
    }
    return json(200, {
      access_token: `ya29.fixture-${randomBytes(12).toString("base64url")}`,
      expires_in: 3599,
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
      token_type: "Bearer",
      id_token: idToken(grant),
    });
  }
  const originalFetch = globalThis.fetch;
  const fetchGoogle: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.origin === "https://oauth2.googleapis.com" ||
      url.origin === "https://www.googleapis.com"
    ) {
      return answer(new Request(input, init));
    }
    return originalFetch(input, init);
  };
  t.mock.method(globalThis, "fetch", fetchGoogle);
  return fixture;
}

/** Starts Google sign-in, visits the fake Google and completes the callback, from one address. */
export async function googleSignIn(
  app: Pick<ReturnType<typeof createFastifyApp>, "inject">,
  origin: string,
  google: Pick<ReturnType<typeof fakeGoogle>, "authorize">,
  authorization: GoogleAuthorization,
  remoteAddress = "192.0.2.60",
) {
  const start = await app.inject({
    method: "POST",
    url: "/api/auth/providers/google/start",
    remoteAddress,
    headers: { origin },
  });
  if (start.statusCode !== 200) {
    throw new Error(`Google start failed with ${start.statusCode}`);
  }
  let body: unknown;
  try {
    body = start.json<unknown>();
  } catch {
    throw new Error("Google start returned invalid JSON");
  }
  const data = asRecord(asRecord(body)?.data);
  const { url, attemptId } = data ?? {};
  if (typeof attemptId !== "string" || attemptId.length === 0 || typeof url !== "string") {
    throw new Error("Google start returned an invalid authorization URL or attempt ID");
  }
  const state = URL.parse(url)?.searchParams.get("state");
  if (!state) {
    throw new Error("Google start returned no state in the authorization URL");
  }
  const code = google.authorize(url, authorization);
  const bindingCookie = cookieHeaderFromSetCookie(start.headers["set-cookie"]);
  const callback = await app.inject({
    url: `/api/auth/providers/google/callback?state=${state}&code=${code}`,
    remoteAddress,
    headers: { cookie: bindingCookie },
  });
  return { start, callback, attemptId, url, state, bindingCookie };
}
