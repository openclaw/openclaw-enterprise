import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

test("OpenShell client serializes v0.1.0 create-time service exposure", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.0-wire.proto"),
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
        service_urls: {
          "": `http://tenant-workspace--${call.request.name}.openshell.localhost:8080/`,
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
      requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
      labels: { owner: "openclaw" },
      annotations: {},
      serviceExposures: [{ service: "", targetPort: 18_790 }],
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
    assert.deepEqual(created.serviceUrls, {
      "": `http://tenant-workspace--${request.name}.openshell.localhost:${port}/`,
    });
    assert.deepEqual(createRequests[0].workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.deepEqual(deleteRequests[0].workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.equal(createRequests[0].request_id, request.requestId);
    assert.deepEqual(createRequests[0].service_exposures, [{ service: "", target_port: 18_790 }]);
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

test("OpenShell client serializes v0.1.0 credential providers, profiles, and attachment status", async () => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.0-wire.proto"),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
  const requests = { profiles: [], providers: [], sandboxes: [], statuses: [] };
  const server = new grpc.Server();

  // The upstream oracle decodes every request, so a renumbered credential, endpoint path, or
  // provider attachment field fails here instead of silently dropping an injected credential.
  server.addService(OpenShell.service, {
    ImportProviderProfiles(call, callback) {
      requests.profiles.push(call.request);
      callback(null, {
        imported: true,
        profiles: call.request.profiles.map((item) => item.profile),
      });
    },
    CreateProvider(call, callback) {
      requests.providers.push(call.request);
      // Echo the credential so the assertion below proves the client, not this stub, redacts it.
      callback(null, { provider: call.request.provider });
    },
    CreateSandbox(call, callback) {
      requests.sandboxes.push(call.request);
      callback(null, {
        sandbox: { metadata: { name: call.request.name, labels: {} } },
        service_urls: {
          "": `http://tenant-workspace--${call.request.name}.openshell.localhost:8080/`,
        },
      });
    },
    GetSandboxProviderStatus(call, callback) {
      requests.statuses.push(call.request);
      callback(null, {
        status: {
          state: "PROVIDER_READINESS_STATE_READY",
          reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
        },
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });

  try {
    await client.importProviderProfile(
      "tenant-workspace",
      {
        id: "oce-openai",
        displayName: "OpenAI",
        category: "PROVIDER_PROFILE_CATEGORY_INFERENCE",
        credentials: [
          {
            name: "api_key",
            envVars: ["OPENAI_API_KEY"],
            required: true,
            authStyle: "bearer",
            headerName: "authorization",
          },
        ],
        endpoints: [{ host: "api.openai.com", port: 443, protocol: "rest", path: "/v1/**" }],
        binaries: ["/app/bin/codex"],
        inferenceCapable: true,
        annotations: { "openclaw.dev/profile-digest": "digest" },
      },
      AbortSignal.timeout(2_000),
    );
    const provider = await client.createProvider(
      {
        workspace: "tenant-workspace",
        name: "oce-cs-000000000000000000000000",
        type: "oce-openai",
        labels: { "openclaw.dev/credential-source-id": "cs_example" },
        credentials: { OPENAI_API_KEY: "wire-test-value" },
      },
      AbortSignal.timeout(2_000),
    );
    await client.createSandbox(
      {
        name: "sandbox-wire",
        workspace: "tenant-workspace",
        requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
        labels: {},
        annotations: {},
        serviceExposures: [],
        spec: { providers: ["oce-cs-000000000000000000000000"] },
      },
      AbortSignal.timeout(2_000),
    );
    const status = await client.getSandboxProviderStatus(
      "tenant-workspace",
      "sandbox-wire",
      "oce-cs-000000000000000000000000",
      AbortSignal.timeout(2_000),
    );

    const [profileImport] = requests.profiles;
    assert.deepEqual(profileImport.workspace_scope, {
      workspace: "tenant-workspace",
      selection: "workspace",
    });
    assert.deepEqual(profileImport.profiles[0].profile.credentials, [
      {
        name: "api_key",
        env_vars: ["OPENAI_API_KEY"],
        required: true,
        auth_style: "bearer",
        header_name: "authorization",
      },
    ]);
    assert.deepEqual(profileImport.profiles[0].profile.endpoints, [
      {
        host: "api.openai.com",
        port: 443,
        protocol: "rest",
        path: "/v1/**",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_READ_WRITE",
      },
    ]);
    assert.deepEqual(profileImport.profiles[0].profile.binaries, [{ path: "/app/bin/codex" }]);
    assert.equal(profileImport.profiles[0].profile.category, "PROVIDER_PROFILE_CATEGORY_INFERENCE");
    // Provider credentials are keyed by the environment variable the supervisor injects.
    assert.deepEqual(requests.providers[0].provider.credentials, {
      OPENAI_API_KEY: "wire-test-value",
    });
    assert.equal(requests.providers[0].provider.type, "oce-openai");
    // The profile lives in the provider's workspace, not in platform scope.
    assert.equal(requests.providers[0].provider.profile_workspace, "tenant-workspace");
    assert.equal(
      requests.providers[0].provider.metadata.labels["openclaw.dev/credential-source-id"],
      "cs_example",
    );
    // The client never copies credential material out of a gateway response.
    assert.equal(JSON.stringify(provider).includes("wire-test-value"), false);
    assert.deepEqual(requests.sandboxes[0].spec.providers, ["oce-cs-000000000000000000000000"]);
    assert.equal(requests.statuses[0].sandbox, "sandbox-wire");
    assert.equal(requests.statuses[0].provider, "oce-cs-000000000000000000000000");
    assert.deepEqual(status, {
      state: "PROVIDER_READINESS_STATE_READY",
      reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
    });
  } finally {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  }
});
