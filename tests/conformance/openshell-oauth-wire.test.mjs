import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

test("OpenShell OAuth RPCs preserve workspace/key scope and source reads consume current tokens without rotating", async (t) => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-oauth-poc-wire.proto"),
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const workspace = "oauth-poc";
  const sourceId = "source-fixture";
  const provider = openShellProviderName(sourceId);
  const key = "CODEX_ACCESS_TOKEN";
  const expiry = new Date(Date.now() + 3_600_000);
  const expiryWire = { seconds: String(Math.floor(expiry.getTime() / 1000)), nanos: 0 };
  let current = "synthetic-access-first";
  let denyRead = false;
  let expireRead = false;
  let rotations = 0;
  const requests = [];
  const status = { status: "refreshed", expiration_time: expiryWire };
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    ConfigureProviderRefresh(call, callback) {
      requests.push(call.request);
      callback(null, { status: { ...status, status: "configured" } });
    },
    RotateProviderCredential(call, callback) {
      assert.equal(call.request.workspace_scope.workspace, workspace);
      assert.equal(call.request.provider, provider);
      assert.equal(call.request.credential_key, key);
      rotations++;
      callback(null, { status });
    },
    GetProviderRefreshStatus(call, callback) {
      assert.equal(call.request.credential_key, key);
      callback(null, { credentials: [status] });
    },
    GetProvider(call, callback) {
      assert.equal(call.request.workspace_scope.workspace, workspace);
      callback(null, {
        provider: {
          type: "oce-codex-oauth",
          metadata: {
            name: provider,
            resource_version: "7",
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/credential-source-id": sourceId,
            },
          },
          config: {
            "oce.codex.account": JSON.stringify({ accountId: "account-fixture", planType: "plus" }),
          },
        },
      });
    },
    ResolveProviderCredential(call, callback) {
      assert.deepEqual(call.request, {
        workspace_scope: { workspace },
        name: provider,
        credential_key: key,
      });
      if (denyRead) {
        callback({
          code: grpc.status.PERMISSION_DENIED,
          details: "synthetic-private-provider-error",
        });
      } else {
        callback(null, {
          value: current,
          expiration_time: expireRead ? { seconds: "1" } : expiryWire,
        });
      }
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  t.after(() => {
    client.close();
    server.forceShutdown();
  });
  const signal = AbortSignal.timeout(10_000);
  await client.configureProviderRefresh(
    workspace,
    provider,
    key,
    { client_id: "synthetic-client", refresh_token: "synthetic-refresh" },
    expiry.toISOString(),
    signal,
  );
  assert.equal(requests[0].strategy, "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN");
  assert.equal(requests[0].workspace_scope.workspace, workspace);
  assert.equal(requests[0].credential_key, key);
  assert.deepEqual(requests[0].secret_material_keys, ["refresh_token"]);
  assert.equal(requests[0].material.refresh_token, "synthetic-refresh");
  assert.equal(requests[0].expiration_time.seconds, String(Math.floor(expiry.getTime() / 1000)));
  await client.rotateProviderCredential(workspace, provider, key, signal);
  assert.equal(
    (await client.getProviderRefreshStatus(workspace, provider, key, signal))[0].status,
    "refreshed",
  );

  const backend = createOpenShellBackend(
    {
      id: "openshell",
      implementation: "openshell",
      configuration: { endpoint: `127.0.0.1:${port}` },
      drivers: { sandbox: "sandbox", credential_gateway: "credential-gateway-openshell" },
    },
    { gatewayClient: client },
  );
  const driver = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/codex"] },
    { backend },
  );
  const context = {
    signal,
    namespace: { id: "namespace", name: workspace },
    source: { id: sourceId, namespaceId: "namespace", driverId: driver.id, type: "codex-oauth" },
  };
  const seen = [];
  const consume = async (token) => {
    seen.push(token);
    return "catalog-result";
  };
  assert.equal(await driver.withSourceToken(context, consume), "catalog-result");
  // The fake server represents an already-published replacement. This proves a fresh RPC read,
  // not OAuth rotation; the separate real-gateway test proves refresh and committed storage.
  current = "synthetic-access-replacement";
  await driver.withSourceToken(context, consume);
  assert.deepEqual(
    seen.map(({ accessToken }) => accessToken),
    ["synthetic-access-first", "synthetic-access-replacement"],
  );
  assert.equal(seen[1].accountId, "account-fixture");
  assert.equal(rotations, 1, "warm discovery never calls the rotation RPC");
  denyRead = true;
  await assert.rejects(
    driver.withSourceToken(context, consume),
    (error) => !error.message.includes("synthetic-private-provider-error"),
  );
  denyRead = false;
  expireRead = true;
  await assert.rejects(driver.withSourceToken(context, consume), /expired/);
  assert.equal(seen.length, 2, "denied and expired values never reach plugin discovery");
});
