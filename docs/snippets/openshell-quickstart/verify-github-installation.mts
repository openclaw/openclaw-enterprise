import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { TLSSocket } from "node:tls";
import { createGitHubKeyOwner } from "/app/apps/controller/src/drivers/repo/github/access/material.ts";
import { createSystemClock } from "/app/apps/controller/src/drivers/repo/access/clock.ts";
import {
  validateGitHubRepositoryRegistry,
  resolveGitHubRepositoryBinding,
  requireGitHubApp,
  resolveSelectedRepositoryGrant,
} from "/app/apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  prepareProviderScope,
  providerRequestOptions,
} from "/app/apps/controller/src/drivers/repo/github/access/provider-transport/request-options.ts";

interface Failure {
  code: string;
  address: string | undefined;
  port: number | undefined;
}

interface Connection {
  lookup: { address: string; family: number }[];
  tcpConnected: boolean;
  tlsConnected: boolean;
  requestEndCalled: boolean;
  peerAddress?: string;
  errors?: Failure[];
}

interface InstallationReply {
  statusCode: number | undefined;
  tlsVerified: boolean;
  appMatches: boolean;
  installationMatches: boolean;
  success: boolean;
}

const connection: Connection = {
  lookup: [],
  tcpConnected: false,
  tlsConnected: false,
  requestEndCalled: false,
};

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const { code } = error;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

function connectionFailure(failure: unknown): Failure {
  const address =
    failure !== null && typeof failure === "object" && "address" in failure
      ? failure.address
      : undefined;
  const port =
    failure !== null && typeof failure === "object" && "port" in failure ? failure.port : undefined;
  return {
    code: errorCode(failure) ?? "request_error",
    address: typeof address === "string" && isIP(address) ? address : undefined,
    port:
      typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
        ? port
        : undefined,
  };
}

function matchesId(value: unknown, expected: string): boolean {
  return (
    (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) &&
    String(value) === expected
  );
}

function installationGet(
  options: RequestOptions,
  expected: ReturnType<typeof requireGitHubApp>,
  assertCurrent: () => void,
): Promise<InstallationReply> {
  return new Promise((resolve, reject: (reason: unknown) => void) => {
    const chunks: Buffer[] = [];
    const clearResponse = () => {
      for (const chunk of chunks) {
        chunk.fill(0);
      }
      chunks.length = 0;
    };
    const req = request(options, (res) => {
      const tlsVerified = res.socket instanceof TLSSocket && res.socket.authorized === true;
      let length = 0;
      res.on("data", (chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) {
          req.destroy(new Error("invalid-response-chunk"));
          return;
        }
        length += chunk.length;
        if (length > 65536) {
          chunk.fill(0);
          req.destroy(new Error("response-limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        let packet: unknown;
        try {
          packet = JSON.parse(body.toString("utf8"));
        } catch {
          packet = undefined;
        } finally {
          body.fill(0);
          clearResponse();
        }
        const appMatches =
          packet !== null &&
          typeof packet === "object" &&
          "app_id" in packet &&
          matchesId(packet.app_id, expected.appId);
        const installationMatches =
          packet !== null &&
          typeof packet === "object" &&
          "id" in packet &&
          matchesId(packet.id, expected.installationId);
        resolve({
          statusCode: res.statusCode,
          tlsVerified,
          appMatches,
          installationMatches,
          success: res.statusCode === 200 && tlsVerified && appMatches && installationMatches,
        });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("request-timeout")), 10_000);
    req.on("close", () => {
      clearTimeout(timer);
      clearResponse();
    });
    req.on("error", (error) => {
      const causes: readonly unknown[] =
        "errors" in error && Array.isArray(error.errors) ? error.errors : [];
      connection.errors = [error, ...causes.slice(0, 3)].map(connectionFailure);
      reject(error);
    });
    req.once("socket", (socket) => {
      if (!(socket instanceof TLSSocket)) {
        req.destroy(new Error("expected-tls"));
        return;
      }
      socket.on("lookup", (_error: unknown, address: unknown) => {
        if (typeof address === "string" && connection.lookup.length < 4) {
          const family = isIP(address);
          if (family) {
            connection.lookup.push({ address, family });
          }
        }
      });
      socket.once("connect", () => {
        connection.tcpConnected = true;
        const { remoteAddress } = socket;
        if (remoteAddress && isIP(remoteAddress)) {
          connection.peerAddress = remoteAddress;
        }
      });
      const send = () => {
        try {
          connection.tlsConnected = socket.authorized === true;
          assert.equal(socket.authorized, true);
          assertCurrent();
          connection.requestEndCalled = true;
          req.end();
        } catch (error) {
          req.destroy(error instanceof Error ? error : new Error("request-failed"));
        }
      };
      if (socket.connecting) {
        socket.once("secureConnect", send);
      } else {
        send();
      }
    });
  });
}

async function verify() {
  const [namespaceId, repositoryRef, issuerCaPath] = process.argv.slice(2);
  assert.ok(namespaceId && repositoryRef);
  const registryJson: unknown = JSON.parse(
    readFileSync("/etc/openclaw/repository-registry/registry.json", "utf8"),
  );
  const registry = validateGitHubRepositoryRegistry(registryJson);
  const app = requireGitHubApp(registry);
  const binding = resolveGitHubRepositoryBinding(registry, {
    namespaceId,
    repositoryRef,
    profile: "github-repository",
  });
  // This formatter context does not create an Agent revision or persist an admission.
  const grant = resolveSelectedRepositoryGrant(
    registry,
    namespaceId,
    "installation-read-preflight",
    [binding],
  );
  if ("credentialSource" in grant) {
    throw new Error("This check reads through the GitHub App; the registration names a Source.");
  }
  const scope = prepareProviderScope("https://api.github.com", grant);
  const ca = issuerCaPath ? readFileSync(issuerCaPath) : undefined;
  const bytes = readFileSync("/etc/openclaw/prepared-repository/private-key.pem");
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(bytes);
  } finally {
    bytes.fill(0);
  }
  const owner = createGitHubKeyOwner({
    privateKey,
    appId: app.appId,
    clock: createSystemClock(),
  });
  try {
    return await owner.withJwt(async (jwt, assertCurrent) => {
      const prepared = providerRequestOptions(scope, "issue", jwt, ca);
      // Reuse the issuer's TLS options and authorization headers for a bodyless read.
      const path = `/app/installations/${app.installationId}`;
      const options: RequestOptions = {
        ...prepared.options,
        method: "GET",
        path,
        headers: { ...prepared.options.headers, "content-length": 0 },
      };
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      assertCurrent();
      const reply = await installationGet(options, app, assertCurrent);
      return {
        method: "GET",
        installationAccessTokenMintRequested: false,
        connection,
        ...reply,
      };
    });
  } finally {
    owner.close();
  }
}

try {
  const result = await verify();
  console.log(JSON.stringify(result));
  process.exitCode = result.success ? 0 : 1;
} catch (error) {
  // Export only sanitized connection diagnostics.
  console.log(
    JSON.stringify({
      success: false,
      errorClass: errorCode(error) ?? "preflight_failed",
      connection,
    }),
  );
  process.exitCode = 1;
}
