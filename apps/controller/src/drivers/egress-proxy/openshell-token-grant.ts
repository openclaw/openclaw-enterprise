import type {
  CredentialProxyBinding,
  CredentialProxyExchange,
  RequestCredentialGrant,
} from "@openclaw-enterprise/contracts";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { isAbsolute } from "node:path";
import { readPublicFile } from "../../composition/repository-credentials/public-file.ts";
import type { EgressAuthorityConfiguration } from "../../composition/installation-fields.ts";

export type OpenShellTokenGrantConfiguration = {
  readonly endpoint: string;
  readonly port: number;
  readonly bundlePath: string;
} & (
  | { readonly assertionSource?: undefined; readonly trustDomain: string }
  | { readonly assertionSource: "openshell_gateway"; readonly issuer: string }
);

export type OpenShellGatewayTokenGrantConfiguration = Extract<
  OpenShellTokenGrantConfiguration,
  { readonly assertionSource: "openshell_gateway" }
>;

export const tokenGrantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["endpoint", "port", "bundlePath"],
  oneOf: [
    {
      required: ["trustDomain"],
      not: { anyOf: [{ required: ["issuer"] }, { required: ["assertionSource"] }] },
    },
    { required: ["assertionSource", "issuer"], not: { required: ["trustDomain"] } },
  ],
  properties: {
    endpoint: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    trustDomain: { type: "string", pattern: "^[a-z0-9._-]{1,255}$" },
    issuer: { type: "string", minLength: 1, maxLength: 512, pattern: "^[!-~]+$" },
    assertionSource: { type: "string", const: "openshell_gateway" },
    bundlePath: { type: "string", minLength: 1 },
  },
};

export function validTokenGrantConfiguration(
  value: unknown,
): value is OpenShellTokenGrantConfiguration {
  const c = asRecord(value);
  if (
    !c ||
    typeof c.endpoint !== "string" ||
    typeof c.port !== "number" ||
    !Number.isInteger(c.port) ||
    c.port < 1 ||
    c.port > 65535 ||
    typeof c.bundlePath !== "string" ||
    !isAbsolute(c.bundlePath) ||
    !URL.canParse(c.endpoint)
  ) {
    return false;
  }
  if (c.assertionSource === "openshell_gateway") {
    if (
      Object.keys(c).length !== 5 ||
      "trustDomain" in c ||
      typeof c.issuer !== "string" ||
      !/^[!-~]{1,512}$/.test(c.issuer)
    ) {
      return false;
    }
  } else if (
    Object.keys(c).length !== 4 ||
    "assertionSource" in c ||
    "issuer" in c ||
    typeof c.trustDomain !== "string" ||
    !/^[a-z0-9._-]{1,255}$/.test(c.trustDomain)
  ) {
    return false;
  }
  const url = new URL(c.endpoint);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.href === c.endpoint
  );
}

// The mounted trust bundle is selected by the operator. Read it again on each exchange
// so a projected verification key rotation applies across API replicas.
async function loadJwtAuthorities(config: OpenShellTokenGrantConfiguration) {
  const path = config.bundlePath;
  const gateway = config.assertionSource === "openshell_gateway";
  const invalidBundle = "Invalid OpenShell token grant verification bundle.";
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = await readPublicFile(file, path, 131_072, invalidBundle);
    const keys = asRecord(JSON.parse(bytes.toString("utf8")))?.keys;
    if (!Array.isArray(keys)) {
      throw new Error(invalidBundle);
    }
    const signingKeys: JWK[] = [];
    for (const key of keys) {
      const jwk = asRecord(key);
      if (!jwk || typeof jwk.kid !== "string" || !jwk.kid || "d" in jwk) {
        continue;
      }
      if (gateway) {
        if (
          jwk.kty === "OKP" &&
          jwk.crv === "Ed25519" &&
          jwk.alg === "EdDSA" &&
          jwk.use === "sig" &&
          typeof jwk.x === "string" &&
          /^[A-Za-z0-9_-]{43}$/.test(jwk.x)
        ) {
          signingKeys.push({
            kty: "OKP",
            crv: "Ed25519",
            alg: "EdDSA",
            use: "sig",
            kid: jwk.kid,
            x: jwk.x,
          });
        }
      } else if (jwk.use === "jwt-svid" && (jwk.kty === "EC" || jwk.kty === "RSA")) {
        signingKeys.push({ ...jwk, kty: jwk.kty, use: "sig" });
      }
    }
    if (
      !signingKeys.length ||
      (gateway && new Set(signingKeys.map((key) => key.kid)).size !== signingKeys.length)
    ) {
      throw new Error(invalidBundle);
    }
    return createLocalJWKSet({ keys: signingKeys });
  } finally {
    await file.close();
  }
}

async function readGrant(request: IncomingMessage) {
  if (
    request.headersDistinct["content-type"]?.length !== 1 ||
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded"
  ) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buf.byteLength;
    if (length > 24_576) {
      return undefined;
    }
    chunks.push(buf);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const assertion = form.get("client_assertion");
  const bindingId = form.get("audience");
  const requestId = request.headers["x-openshell-request-id"];
  if (
    form.size !== 4 ||
    form.get("grant_type") !== "client_credentials" ||
    form.get("client_assertion_type") !==
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
    !assertion ||
    !bindingId ||
    !/^[\x21-\x7e]{1,512}$/.test(bindingId) ||
    request.headersDistinct["x-openshell-request-id"]?.length !== 1 ||
    typeof requestId !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(requestId)
  ) {
    return undefined;
  }
  return { assertion, bindingId, requestId };
}

function reply(response: ServerResponse, status: number, body: object) {
  if (response.destroyed) {
    return;
  }
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    })
    .end(JSON.stringify(body));
}

type Resolve = NonNullable<CredentialProxyExchange["resolveRequestCredential"]>;

/** The credential's immutable identity is independent of its Gateway object name. */
export function openShellGrantCredentialIdentity(providerId: string, credentialKey: string) {
  return sha256Hex(JSON.stringify([providerId, credentialKey]));
}

interface AuthenticatedRecipient {
  readonly recipientId: string;
  readonly expiresAt: number;
  readonly clientAssertion?: NonNullable<RequestCredentialGrant["clientAssertion"]>;
}

export interface AuthenticatedOpenShellGatewayAssertion extends AuthenticatedRecipient {
  readonly providerId: string;
  readonly credentialKey: string;
  readonly clientAssertion: NonNullable<RequestCredentialGrant["clientAssertion"]>;
}

/** Verify only the assertion. The owning approval must also match the request and resource. */
export async function verifyOpenShellGatewayAssertion(
  assertion: string,
  config: OpenShellGatewayTokenGrantConfiguration,
): Promise<AuthenticatedOpenShellGatewayAssertion | undefined> {
  const keys = await loadJwtAuthorities(config);
  const jwt = await jwtVerify(assertion, keys, {
    algorithms: ["EdDSA"],
    audience: config.endpoint,
    issuer: config.issuer,
    requiredClaims: ["sub", "exp", "iat", "jti"],
  }).catch(() => undefined);
  const payload = jwt?.payload;
  if (
    !jwt?.protectedHeader.kid ||
    jwt.protectedHeader.typ !== "openshell-provider-assertion+jwt" ||
    !payload ||
    payload.aud !== config.endpoint ||
    payload.caller_kind !== "supervisor" ||
    typeof payload.sandbox_id !== "string" ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(payload.sandbox_id) ||
    payload.sub !== `openshell-sandbox:${payload.sandbox_id}` ||
    typeof payload.provider_id !== "string" ||
    !/^[!-~]{1,256}$/.test(payload.provider_id) ||
    typeof payload.credential_key !== "string" ||
    !/^[!-~]{1,256}$/.test(payload.credential_key) ||
    typeof payload.jti !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.jti) ||
    typeof payload.iat !== "number" ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat > Math.floor(Date.now() / 1000) ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 60
  ) {
    return undefined;
  }
  return {
    recipientId: payload.sandbox_id,
    expiresAt: payload.exp * 1000,
    providerId: payload.provider_id,
    credentialKey: payload.credential_key,
    clientAssertion: {
      credentialIdentity: openShellGrantCredentialIdentity(
        payload.provider_id,
        payload.credential_key,
      ),
      replayKey: sha256Hex(JSON.stringify([config.issuer, payload.jti])),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    },
  };
}

async function verifySpireAssertion(
  assertion: string,
  config: Extract<OpenShellTokenGrantConfiguration, { readonly trustDomain: string }>,
): Promise<AuthenticatedRecipient | undefined> {
  const keys = await loadJwtAuthorities(config);
  const jwt = await jwtVerify(assertion, keys, {
    algorithms: ["ES256", "ES384", "RS256", "PS256"],
    audience: config.endpoint,
    requiredClaims: ["sub", "exp"],
  }).catch(() => undefined);
  const { endpoint, trustDomain } = config;
  const aud = jwt?.payload.aud;
  const prefix = `spiffe://${trustDomain}/openshell/sandbox/`;
  const sub = jwt?.payload.sub;
  const recipientId = sub?.startsWith(prefix) && sub.slice(prefix.length);
  if (
    !jwt?.protectedHeader.kid ||
    !(aud === endpoint || (Array.isArray(aud) && aud.length === 1 && aud[0] === endpoint)) ||
    !recipientId ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(recipientId)
  ) {
    return undefined;
  }
  return { recipientId, expiresAt: Number(jwt.payload.exp) * 1000 };
}

/** Stock OpenShell redeems one request already approved over its authenticated middleware stream. */
export async function bindOpenShellTokenGrant(
  config: OpenShellTokenGrantConfiguration,
  authority: Pick<EgressAuthorityConfiguration, "host">,
  tls: { cert: Buffer; key: Buffer },
  resolve: Resolve,
  acquireAuthentication: NonNullable<CredentialProxyExchange["acquireRequestAuthentication"]>,
): Promise<CredentialProxyBinding> {
  if (!validTokenGrantConfiguration(config)) {
    throw new Error("Invalid OpenShell token grant configuration.");
  }
  await loadJwtAuthorities(config);
  const path = new URL(config.endpoint).pathname;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== path) {
      reply(response, 404, { error: "not_found" });
      return;
    }
    const release = acquireAuthentication();
    if (!release) {
      reply(response, 503, { error: "temporarily_unavailable" });
      return;
    }
    try {
      const startedAt = Date.now();
      const grant = await readGrant(request);
      if (!grant) {
        reply(response, 400, { error: "invalid_request" });
        return;
      }
      const recipient =
        config.assertionSource === "openshell_gateway"
          ? await verifyOpenShellGatewayAssertion(grant.assertion, config)
          : await verifySpireAssertion(grant.assertion, config);
      if (!recipient) {
        reply(response, 401, { error: "invalid_client" });
        return;
      }
      const { recipientId, expiresAt } = recipient;
      const deadline = Math.min(startedAt + 30_000, expiresAt);
      if (!Number.isFinite(deadline) || deadline <= Date.now() || response.destroyed) {
        reply(response, 401, { error: "invalid_client" });
        return;
      }
      const disconnected = new AbortController();
      response.once("close", () => disconnected.abort());
      const signal = AbortSignal.any([
        disconnected.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ]);
      release();
      const resolveStarted = performance.now();
      const token = await resolve(
        {
          recipientId,
          requestId: grant.requestId,
          bindingId: grant.bindingId,
          deadlineAt: new Date(deadline).toISOString(),
          ...(recipient.clientAssertion && { clientAssertion: recipient.clientAssertion }),
        },
        signal,
      );
      // This TTL limits redemption release; it does not describe the provider key's expiry.
      // The installed OpenShell token-grant profile must independently require cache_ttl: 0.
      // The database-derived budget starts at resolver invocation, before its asynchronous reads.
      const lifetime =
        token &&
        Math.floor(
          Math.min(
            token.releaseLifetimeMs - (performance.now() - resolveStarted),
            Math.min(Date.parse(token.usableUntil), deadline) - Date.now(),
          ) / 1000,
        );
      if (
        !token ||
        !Number.isFinite(token.releaseLifetimeMs) ||
        !lifetime ||
        !Number.isFinite(lifetime) ||
        !(lifetime > 0) ||
        signal.aborted ||
        response.destroyed ||
        Date.now() >= deadline
      ) {
        reply(response, 403, { error: "invalid_grant" });
        return;
      }
      reply(response, 200, {
        access_token: token.value,
        token_type: "Bearer",
        expires_in: lifetime,
      });
    } finally {
      release();
    }
  };
  const server = createServer(
    {
      ...tls,
      minVersion: "TLSv1.2",
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 30_000,
      handshakeTimeout: 5000,
    },
    (request, response) => {
      void handle(request, response).catch(() => {
        if (!response.destroyed && !response.headersSent) {
          reply(response, 503, { error: "temporarily_unavailable" });
        }
      });
    },
  );
  server.maxConnections = 1024;
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(config.port, authority.host, () => {
      server.off("error", reject);
      accept();
    });
  });
  return {
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
