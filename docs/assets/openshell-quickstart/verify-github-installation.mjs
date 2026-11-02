import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { request } from "node:https";
import { createGitHubKeyOwner } from "/app/apps/controller/src/drivers/repo/github/credentials/material.ts";
import { createSystemClock } from "/app/apps/controller/src/drivers/repo/credentials/clock.ts";
import {
  validateGitHubRepositoryRegistry,
  resolveGitHubRepositoryBinding,
  resolveSelectedRepositoryGrant,
} from "/app/apps/controller/src/drivers/repo/github/credentials/registry.ts";
import {
  prepareProviderScope,
  providerRequestOptions,
} from "/app/apps/controller/src/drivers/repo/github/credentials/provider-transport/request-options.ts";

const connection = {
  lookup: [],
  tcpConnected: false,
  tlsConnected: false,
  requestEndCalled: false,
};

async function verify() {
  const [namespaceId, repositoryRef, issuerCaPath] = process.argv.slice(2);
  assert.ok(namespaceId && repositoryRef);
  const registry = validateGitHubRepositoryRegistry(
    JSON.parse(readFileSync("/etc/openclaw/repository-registry/registry.json", "utf8")),
  );
  const binding = resolveGitHubRepositoryBinding(registry, {
    namespaceId,
    repositoryRef,
    profile: "github-repository",
  });
  // This formatter context is not an Agent revision or a persisted admission.
  const grant = resolveSelectedRepositoryGrant(
    registry,
    namespaceId,
    "installation-read-preflight",
    [binding],
  );
  const scope = prepareProviderScope("https://api.github.com", grant);
  const ca = issuerCaPath ? readFileSync(issuerCaPath) : undefined;
  const bytes = readFileSync("/etc/openclaw/prepared-repository/private-key.pem");
  let privateKey;
  try {
    privateKey = createPrivateKey(bytes);
  } finally {
    bytes.fill(0);
  }
  const owner = createGitHubKeyOwner({
    privateKey,
    appId: registry.appId,
    clock: createSystemClock(),
  });
  try {
    return await owner.withJwt(async (jwt, assertCurrent) => {
      const prepared = providerRequestOptions(scope, "issue", jwt, ca);
      // Reuse issuer TLS and headers, but never send its POST path or body.
      const path = `/app/installations/${registry.githubInstallationId}`;
      const options = {
        ...prepared.options,
        method: "GET",
        path,
        headers: { ...prepared.options.headers, "content-length": 0 },
      };
      assert.equal(options.method, "GET");
      assert.equal(options.path, path);
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      assertCurrent();
      return await new Promise((resolve, reject) => {
        const req = request(options, (res) => {
          const tlsVerified = res.socket.authorized === true;
          const chunks = [];
          let length = 0;
          res.on("data", (chunk) => {
            length += chunk.length;
            if (length > 65536) {
              req.destroy(new Error("response-limit"));
            } else {
              chunks.push(chunk);
            }
          });
          res.on("error", reject);
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            let packet;
            try {
              packet = JSON.parse(body.toString("utf8"));
            } catch {
              packet = undefined;
            } finally {
              body.fill(0);
              for (const chunk of chunks) {
                chunk.fill(0);
              }
            }
            const appMatches = String(packet?.app_id) === registry.appId;
            const installationMatches = String(packet?.id) === registry.githubInstallationId;
            resolve({
              method: "GET",
              installationAccessTokenMintRequested: false,
              connection,
              statusCode: res.statusCode,
              tlsVerified,
              appMatches,
              installationMatches,
              success: res.statusCode === 200 && tlsVerified && appMatches && installationMatches,
            });
          });
        });
        const timer = setTimeout(() => req.destroy(new Error("request-timeout")), 10000);
        req.on("close", () => clearTimeout(timer));
        req.on("error", (error) => {
          connection.errors = [error, ...(Array.isArray(error.errors) ? error.errors : [])]
            .slice(0, 4)
            .map((failure) => ({
              code: /^[A-Z0-9_]{1,64}$/.test(failure?.code ?? "") ? failure.code : "request_error",
              address: isIP(failure?.address ?? "") ? failure.address : undefined,
              port:
                Number.isInteger(failure?.port) && failure.port > 0 && failure.port < 65536
                  ? failure.port
                  : undefined,
            }));
          reject(error);
        });
        req.once("socket", (socket) => {
          socket.on("lookup", (_error, address) => {
            const family = typeof address === "string" ? isIP(address) : 0;
            if (family && connection.lookup.length < 4) {
              connection.lookup.push({ address, family });
            }
          });
          socket.once("connect", () => {
            connection.tcpConnected = true;
            if (isIP(socket.remoteAddress ?? "")) {
              connection.peerAddress = socket.remoteAddress;
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
              req.destroy(error);
            }
          };
          if (socket.connecting) {
            socket.once("secureConnect", send);
          } else {
            send();
          }
        });
      });
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
  // Do not export the JWT, key, response body, headers or arbitrary error text.
  const code = /^[A-Z0-9_]{1,64}$/.test(error?.code ?? "") ? error.code : "preflight_failed";
  console.log(JSON.stringify({ success: false, errorClass: code, connection }));
  process.exitCode = 1;
}
