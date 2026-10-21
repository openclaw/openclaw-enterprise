import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { Pool } from "pg";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import { startListeners } from "../../apps/controller/src/drivers/repo/credentials/server.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { createPreparedGitHubRegistryFactory } from "../../apps/controller/src/drivers/repo/github/credentials/warm-registry-factory.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { socketDirectory } from "./socket-directory.mjs";
import { serviceConfigurationData } from "../fixtures/repository-credentials/builders.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  startGitHubFixture,
  fixtureRepository,
  fixtureRepositoryId,
  fixtureAppId,
  fixtureInstallationId,
} from "../fixtures/repository-credentials/github.mjs";

export async function preparedStandingGitPeer(t: TestContext, pool: Pool, namespaceId: string) {
  const clock = createSystemClock();
  // Keep the prepared owner's real 60 s clock margin and 60 s minimum validity.
  const github: (t: TestContext, options: object) => ReturnType<typeof startGitHubFixture> =
    startGitHubFixture;
  const gh = await github(t, { clock, tokenLifetimeMs: 135_000 });
  const tls = gh.tls;
  const pushRef = "refs/heads/review";
  const backendId = "prepared-standing";
  const registrationName = "oce-prepared-git";
  const registry = validateGitHubRepositoryRegistry({
    version: 1,
    backendId,
    providerInstanceId: "fixture-provider",
    appId: fixtureAppId,
    githubInstallationId: fixtureInstallationId,
    maximumDurationSeconds: 180,
    allowStandingApprovals: true,
    repositories: [
      {
        repositoryRef: "source",
        repository: fixtureRepository,
        repositoryId: fixtureRepositoryId,
        namespaces: [
          {
            namespaceId,
            profiles: ["git-write"],
            transport: "git-only",
            allowStandingApproval: true,
            pushRefAllowlist: [pushRef],
          },
        ],
      },
    ],
  });
  const directory = await socketDirectory(t, "standing-peer-");
  const controlSocket = join(directory, "control.sock");
  const privateKeyPath = join(directory, "app.pem");
  const custodyKeyPath = join(directory, "custody");
  await writeFile(privateKeyPath, gh.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(custodyKeyPath, randomBytes(32), { mode: 0o600 });

  // Public OpenShell requires the GitHub.com authority, not an arbitrary API origin.
  // Replace only the issuer's network destination, before DNS; keep fixture TLS verification,
  // the actual issuance and retirement requests, and the production admission and scope checks.
  const issue = new URL(gh.origin);
  assert.equal(issue.hostname, "127.0.0.1");
  const request = https.request;
  const transport = t.mock.method(https, "request", (input: https.RequestOptions) => {
    assert.equal(input.hostname, "api.github.com", "the prepared issuer is the only caller");
    return request({ ...input, hostname: issue.hostname, port: issue.port });
  });
  syncBuiltinESMExports();
  t.after(() => {
    transport.mock.restore();
    syncBuiltinESMExports();
  });
  const prepared = await startPreparedGitHubGitOwner({
    registry,
    pool,
    controlSocket,
    driverId: backendId,
    implementation: "github",
    backendId,
    privateKeyPath,
    custodyKeyPath,
    ca: tls.ca,
    startWorker: false,
  });
  let calls = 0;
  const gitOrigin: (
    t: TestContext,
    options: object,
  ) => ReturnType<typeof startGitSmartHttpFixture> = startGitSmartHttpFixture;
  const origin = await gitOrigin(t, {
    repository: fixtureRepository,
    tls,
    authorize: gh.authorize,
    observeRequest: () => {
      calls++;
    },
  });
  const apiOrigin = gh.origin;
  const gatewayOrigin = "https://127.0.0.1";
  const config = validateServiceConfig(
    serviceConfigurationData({
      limits: { exchangeMs: 5000, credentialMarginMs: 1000 },
      gateway: { listen: "127.0.0.1:8443", controlSocket, publicOrigin: gatewayOrigin },
    }),
  );
  const factory = createPreparedGitHubRegistryFactory({
    registry,
    clock,
    limits: config.limits,
    gatewayOrigin,
    gitOrigin: origin.origin,
    apiOrigin,
    socketPath: join(directory, "prepared-git-use.sock"),
  });
  const service = createCredentialService({ config, factory, clock });
  const server = await startListeners({
    service,
    factory,
    clock,
    tls,
    config: { ...config, gateway: { ...config.gateway, listen: "127.0.0.1:0" } },
    upstreamCa: tls.ca,
    trustedUpstreamOrigins: factory.trustedUpstreamOrigins,
  });
  t.after(async () => {
    await server.close();
    await service.shutdown(5000);
    await prepared.close();
  });

  const oid = await origin.ref("main");
  const base = "/" + fixtureRepository + ".git/";
  const packet = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
  const body = Buffer.from(packet("want " + oid + "\n") + "0000" + packet("done\n"));
  // This peer stands in for the supervisor and sends exactly once, only after an ALLOW. No
  // redirect, ambient credential, GitHub connection, replay, or alternate object source.
  const send = (value: string | undefined, upload: boolean) =>
    new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
      const path = base + (upload ? "git-upload-pack" : "info/refs?service=git-upload-pack");
      const url = new URL(path, origin.origin);
      assert.equal(url.hostname, "127.0.0.1");
      const auth = value
        ? { authorization: "Basic " + Buffer.from("x-access-token:" + value).toString("base64") }
        : {};
      const headers = {
        ...auth,
        ...(upload && {
          "content-type": "application/x-git-upload-pack-request",
          "content-length": body.length,
        }),
      };
      const req = request(
        url,
        { method: upload ? "POST" : "GET", headers, ca: tls.ca, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res
            .on("data", (data) => chunks.push(data))
            .on("error", reject)
            .on("end", () => resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) }));
        },
      ).on("error", reject);
      req.end(upload ? body : undefined);
    });
  const input = (bindingId: string, sandboxId: string, upload: boolean) => ({
    phase: 1,
    middleware_name: registrationName,
    context: { request_id: randomUUID(), sandbox_id: sandboxId, workspace: "team-workspace" },
    config: { fields: { binding_id: { stringValue: bindingId } } },
    target: {
      scheme: "https",
      host: "github.com",
      port: 443,
      method: upload ? "POST" : "GET",
      path: base + (upload ? "git-upload-pack" : "info/refs"),
      ...(upload ? {} : { query: "service=git-upload-pack" }),
    },
    ...(upload && {
      body,
      headers: [{ name: "content-type", value: "application/x-git-upload-pack-request" }],
    }),
  });
  return {
    registry,
    prepared,
    originCalls: () => calls,
    gh,
    controlSocket,
    oid,
    send,
    input,
    registrationName,
    backendId,
  };
}
