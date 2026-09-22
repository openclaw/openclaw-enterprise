import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

test("OpenShell client serializes v0.1 workspace scopes and network enums", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.0-pre.5-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const createRequests = [];
  const deleteRequests = [];
  const server = new grpc.Server();

  // Decode with the independently pinned upstream fixture so a production proto
  // field or enum renumbering cannot make both ends agree on an incompatible wire shape.
  server.addService(OpenShell.service, {
    CreateSandbox(call, callback) {
      createRequests.push(call.request);
      callback(null, {
        sandbox: {
          metadata: {
            id: "sandbox-id",
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
            labels: call.request.labels,
          },
        },
      });
    },
    DeleteSandbox(call, callback) {
      deleteRequests.push(call.request);
      callback(null, { deleted: true });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });

  try {
    const request = {
      name: "sandbox-wire",
      workspace: "tenant-workspace",
      labels: { owner: "openclaw" },
      annotations: {},
      spec: {
        policy: {
          network_policies: {
            model: {
              name: "model",
              binaries: [{ path: "/app/bin/model-client" }],
              endpoints: [
                {
                  host: "api.openai.com",
                  ports: [443],
                  tls: "NETWORK_TLS_MODE_SKIP",
                  enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
                  access: "NETWORK_ACCESS_PRESET_FULL",
                },
              ],
            },
          },
        },
      },
    };
    const created = await client.createSandbox(request, AbortSignal.timeout(2_000));
    await client.deleteSandbox(
      { name: request.name, workspace: request.workspace },
      AbortSignal.timeout(2_000),
    );

    assert.equal(created.workspace, "tenant-workspace");
    assert.deepEqual(createRequests[0].workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.deepEqual(deleteRequests[0].workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.deepEqual(createRequests[0].spec.policy.network_policies.model.endpoints[0], {
      host: "api.openai.com",
      ports: [443],
      tls: "NETWORK_TLS_MODE_SKIP",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_FULL",
    });
    assert.deepEqual(createRequests[0].spec.policy.network_policies.model.binaries, [
      { path: "/app/bin/model-client" },
    ]);
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});
