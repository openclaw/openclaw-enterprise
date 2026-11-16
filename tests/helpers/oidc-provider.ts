import { createHash, randomBytes, type KeyObject, type webcrypto } from "node:crypto";
import type { OidcTokenAuth } from "../../apps/controller/src/auth/oidc.ts";
import { idTokenSigner, rsaSigningKey } from "./id-token.mjs";

export interface OidcIssuerEndpoints {
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

export interface OidcProviderOptions {
  clientId: string;
  clientSecret: string;
  issuer: OidcIssuerEndpoints;
  tokenAuth?: OidcTokenAuth;
  recordHistory?: boolean;
}

type RequestFields = Record<string, string | undefined>;
type ProviderMode = "up" | "error" | "hang";

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: webcrypto.JsonWebKey & { kid: string; alg: string; use: string };
}

type GrantSigner = "published" | "foreign";

interface AuthorizationOptions {
  subject: string;
  claims?: Record<string, unknown>;
  key?: GrantSigner;
  codeLength?: number;
}

interface AuthorizationGrant {
  request: RequestFields;
  subject: string;
  claims: Record<string, unknown>;
  signer: GrantSigner;
  key: SigningKey;
}

interface OidcProvider {
  mode: ProviderMode;
  requests: number;
  issuer: OidcIssuerEndpoints;
  tokenAuth: OidcTokenAuth;
  authorizations: RequestFields[];
  tokens: RequestFields[];
  readonly jwks: { keys: SigningKey["jwk"][] };
  rotate(): void;
  authorize(url: string | URL, options: AuthorizationOptions): string;
  answer(request: Request): Promise<Response>;
}

// Shares one-use grants and signing keys between in-process sign-in and the
// disposable HTTPS issuer. Each grant retains the signing key in use when issued.
export function createOidcProvider({
  clientId,
  clientSecret,
  issuer,
  tokenAuth = "client_secret_post",
  recordHistory = true,
}: OidcProviderOptions): OidcProvider {
  let generation = 0;
  let key: SigningKey = rsaSigningKey(`fixture-oidc-kid-${generation}`);
  const foreign: SigningKey = rsaSigningKey("fixture-oidc-foreign");
  const codes = new Map<string, AuthorizationGrant>();
  const pendingRequests = new Set<Request>();
  const fixture: OidcProvider = {
    mode: "up",
    requests: 0,
    issuer,
    tokenAuth,
    authorizations: [],
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
    answer,
  };
  function idToken({ request, subject, claims, signer, key: issuedWith }: AuthorizationGrant) {
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
  const json = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  async function answer(request: Request): Promise<Response> {
    fixture.requests += 1;
    if (fixture.mode === "hang") {
      const { signal } = request;
      signal.throwIfAborted();
      // Keep the Request and its dependent signal alive until cancellation reaches it.
      pendingRequests.add(request);
      try {
        return await new Promise<never>((_, reject) => {
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
      !grant.request.scope?.split(" ").includes("openid") ||
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
  return fixture;
}
