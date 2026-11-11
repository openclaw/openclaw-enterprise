import { createHash, randomBytes } from "node:crypto";
import { idTokenSigner, rsaSigningKey } from "./id-token.mjs";

/**
 * A local stand-in for one OIDC issuer's token and JWKS URLs. Only fetches to the issuer's origin are answered here. It plays the IdP the
 * way fakeGoogle plays Google: `authorize(url, options)` captures the authorization
 * request and returns a one-use code for `subject` (`codeLength` pads it, as Entra's long
 * codes do); /token checks the client credentials (post or basic, per `tokenAuth`), code,
 * redirect URI and S256 verifier, then returns an RS256 ID token for `issuer.issuer`
 * echoing the nonce. Per-code `claims` override ID-token claims; `key: "foreign"` signs
 * with an unpublished key. `rotate()` replaces the published key. `issuer` may be
 * reassigned to model an issuer change, and `tokenAuth`
 * to switch the credential method. Modes: "up", "error" (503), and "hang" (until cancellation). It proves OCE
 * against its own reading of OIDC, not any IdP's behaviour.
 */
export function createOidcProvider({
  clientId,
  clientSecret,
  issuer,
  tokenAuth = "client_secret_post",
  recordHistory = true,
}) {
  let generation = 0;
  let key = rsaSigningKey(`fixture-oidc-kid-${generation}`);
  const foreign = rsaSigningKey("fixture-oidc-foreign");
  const codes = new Map();
  const pendingRequests = new Set();
  const fixture = {
    mode: "up",
    requests: 0,
    issuer,
    tokenAuth,
    authorizations: /** @type {Record<string, string>[]} */ ([]),
    tokens: [],
    get jwks() {
      return { keys: [key.jwk] };
    },
    rotate() {
      generation += 1;
      key = rsaSigningKey(`fixture-oidc-kid-${generation}`);
    },
    authorize(url, { subject, claims = {}, key: signer = "published", codeLength = 0 }) {
      const request = Object.fromEntries(new URL(url).searchParams);
      if (recordHistory) {
        fixture.authorizations.push(request);
      }
      const prefix = `fixture-oidc-code-${randomBytes(12).toString("base64url")}`;
      const code = prefix.padEnd(codeLength, "c");
      codes.set(code, { request, subject, claims, signer, key });
      return code;
    },
  };
  function idToken({ request, subject, claims, signer, key: issuedWith }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: fixture.issuer.issuer,
      aud: clientId,
      sub: subject,
      nonce: request.nonce,
      iat: now - 5,
      exp: now + 3600,
      ...claims,
    };
    return idTokenSigner(signer === "foreign" ? foreign : issuedWith)(payload);
  }
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  async function answer(request) {
    fixture.requests += 1;
    if (fixture.mode === "hang") {
      const { signal } = request;
      signal.throwIfAborted();
      // Keep the Request and its dependent signal alive until cancellation reaches it.
      pendingRequests.add(request);
      try {
        return await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        pendingRequests.delete(request);
      }
    }
    if (fixture.mode === "error") {
      return json(503, {});
    }
    const url = new URL(request.url).href;
    if (url === fixture.issuer.jwksUrl) {
      return request.method === "GET" ? json(200, fixture.jwks) : json(405, {});
    }
    if (url !== fixture.issuer.tokenUrl) {
      return json(404, {});
    }
    const form = new URLSearchParams(await request.text());
    const basic = /^Basic (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const [basicId, basicSecret] =
      basic === undefined
        ? []
        : Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent);
    const credentials =
      fixture.tokenAuth === "client_secret_basic"
        ? !form.has("client_secret") && basicId === clientId && basicSecret === clientSecret
        : basic === undefined &&
          form.get("client_id") === clientId &&
          form.get("client_secret") === clientSecret;
    const grant = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier");
    const challenge =
      verifier !== null && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
        ? createHash("sha256").update(verifier).digest("base64url")
        : undefined;
    if (recordHistory) {
      fixture.tokens.push(Object.fromEntries(form));
    }
    if (
      request.method !== "POST" ||
      form.get("grant_type") !== "authorization_code" ||
      !credentials ||
      grant === undefined ||
      grant.request.client_id !== clientId ||
      !grant.request.scope.split(" ").includes("openid") ||
      grant.request.code_challenge_method !== "S256" ||
      challenge === undefined ||
      grant.request.code_challenge !== challenge ||
      form.get("redirect_uri") !== grant.request.redirect_uri
    ) {
      return json(400, { error: "invalid_grant" });
    }
    return json(200, {
      access_token: `fixture-oidc-access-${randomBytes(12).toString("base64url")}`,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken(grant),
    });
  }
  fixture.answer = answer;
  return fixture;
}
