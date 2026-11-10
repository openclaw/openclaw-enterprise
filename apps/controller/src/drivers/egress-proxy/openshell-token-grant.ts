import type {
  CredentialProxyBinding,
  CredentialProxyExchange,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { isAbsolute } from "node:path";
import { readPublicFile } from "../../composition/repository-credentials/public-file.ts";
import type { EgressAuthorityConfiguration } from "../../composition/installation-fields.ts";

export interface OpenShellTokenGrantConfiguration {
  readonly endpoint: string;
  readonly port: number;
  readonly trustDomain: string;
  readonly bundlePath: string;
}

export const tokenGrantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["endpoint", "port", "trustDomain", "bundlePath"],
  properties: {
    endpoint: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    trustDomain: { type: "string", pattern: "^[a-z0-9._-]{1,255}$" },
    bundlePath: { type: "string", minLength: 1 },
  },
};

export function validTokenGrantConfiguration(
  value: unknown,
): value is OpenShellTokenGrantConfiguration {
  const c = asRecord(value);
  if (
    !c ||
    Object.keys(c).length !== 4 ||
    typeof c.endpoint !== "string" ||
    typeof c.port !== "number" ||
    !Number.isInteger(c.port) ||
    c.port < 1 ||
    c.port > 65535 ||
    typeof c.trustDomain !== "string" ||
    !/^[a-z0-9._-]{1,255}$/.test(c.trustDomain) ||
    typeof c.bundlePath !== "string" ||
    !isAbsolute(c.bundlePath) ||
    !URL.canParse(c.endpoint)
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
// so a projected SPIRE key rotation (including key removal) applies across API replicas.
async function loadJwtAuthorities(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = await readPublicFile(file, path, 131_072, "Invalid SPIFFE trust bundle.");
    const keys = asRecord(JSON.parse(bytes.toString("utf8")))?.keys;
    if (!Array.isArray(keys)) {
      throw new Error("Invalid SPIFFE trust bundle.");
    }
    const signingKeys: JWK[] = [];
    for (const key of keys) {
      const jwk = asRecord(key);
      if (
        jwk &&
        (jwk.use === "jwt-svid" || jwk.use === "sig" || jwk.use === undefined) &&
        (jwk.kty === "EC" || jwk.kty === "RSA") &&
        typeof jwk.kid === "string" &&
        jwk.kid &&
        !("d" in jwk)
      ) {
        signingKeys.push({ ...jwk, kty: jwk.kty, use: "sig" });
      }
    }
    if (!signingKeys.length) {
      throw new Error("The SPIFFE trust bundle contains no JWT signing authority.");
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

/** Stock OpenShell redeems one request already approved over its authenticated middleware stream. */
export async function bindOpenShellTokenGrant(
  config: OpenShellTokenGrantConfiguration,
  authority: Pick<EgressAuthorityConfiguration, "host">,
  tls: { cert: Buffer; key: Buffer },
  resolve: Resolve,
): Promise<CredentialProxyBinding> {
  if (!validTokenGrantConfiguration(config)) {
    throw new Error("Invalid OpenShell token grant configuration.");
  }
  await loadJwtAuthorities(config.bundlePath);
  const path = new URL(config.endpoint).pathname;
  const prefix = `spiffe://${config.trustDomain}/openshell/sandbox/`;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== path) {
      reply(response, 404, { error: "not_found" });
      return;
    }
    const startedAt = Date.now();
    const grant = await readGrant(request);
    if (!grant) {
      reply(response, 400, { error: "invalid_request" });
      return;
    }
    const keys = await loadJwtAuthorities(config.bundlePath);
    const jwt = await jwtVerify(grant.assertion, keys, {
      algorithms: ["ES256", "ES384", "RS256", "PS256"],
      audience: config.endpoint,
      requiredClaims: ["sub", "exp"],
    }).catch(() => undefined);
    const aud = jwt?.payload.aud;
    const exactAudience =
      aud === config.endpoint ||
      (Array.isArray(aud) && aud.length === 1 && aud[0] === config.endpoint);
    const sub = jwt?.payload.sub;
    const recipientId = sub?.startsWith(prefix) && sub.slice(prefix.length);
    if (
      !jwt?.protectedHeader.kid ||
      !exactAudience ||
      !recipientId ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(recipientId)
    ) {
      reply(response, 401, { error: "invalid_client" });
      return;
    }
    const deadline = Math.min(startedAt + 30_000, Number(jwt.payload.exp) * 1_000);
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
    const token = await resolve(
      {
        recipientId,
        requestId: grant.requestId,
        bindingId: grant.bindingId,
        deadlineAt: new Date(deadline).toISOString(),
      },
      signal,
    );
    // This TTL limits redemption release; it does not describe the provider key's expiry.
    // The installed OpenShell token-grant profile must independently require cache_ttl: 0.
    const lifetime =
      token && Math.floor((Math.min(Date.parse(token.usableUntil), deadline) - Date.now()) / 1000);
    if (
      !token ||
      !lifetime ||
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
