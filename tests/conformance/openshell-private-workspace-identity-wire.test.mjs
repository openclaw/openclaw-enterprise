import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const protobuf = createRequire(require.resolve("@grpc/proto-loader"))("protobufjs");
// Independent supplier contract: both request scope and the create precondition must
// survive the production encoder. Policy process names are deliberately irrelevant.
const oracle = protobuf.parse(
  `
syntax = "proto3";
package openshell.v1;
service OpenShell {
  rpc ResolveWorkspaceWorkloadIdentity(ResolveRequest) returns (ResolveResponse);
  rpc GetWorkspace(GetWorkspaceRequest) returns (WorkspaceResponse);
  rpc GetSandbox(GetSandboxRequest) returns (SandboxResponse);
  rpc CreateSandbox(CreateRequest) returns (SandboxResponse);
}
message Scope { string workspace = 1; }
message Identity { uint32 uid = 1; uint32 gid = 2; string placement = 3; }
message ResolveRequest { Scope workspace_scope = 1; }
message ResolveResponse { Identity identity = 1; }
message Meta {
  string id = 1; string name = 2; map<string,string> labels = 4;
  map<string,string> annotations = 6; string workspace = 7;
}
message WorkspaceStatus { int32 phase = 1; }
message Workspace { Meta metadata = 1; WorkspaceStatus status = 2; }
message GetWorkspaceRequest { string name = 1; }
message WorkspaceResponse { Workspace workspace = 1; }
message Spec { Identity expected_workspace_workload_identity = 16; }
message Sandbox { Meta metadata = 1; Spec spec = 2; }
message GetSandboxRequest { string name = 1; Scope workspace_scope = 2; }
message SandboxResponse { Sandbox sandbox = 1; map<string,string> service_urls = 2; }
message CreateRequest { Spec spec = 1; string name = 2; Scope workspace_scope = 7; string request_id = 8; }
`,
  { keepCase: true },
).root;
const definition = loader.fromJSON(oracle.toJSON(), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true,
});
const OpenShell = grpc.loadPackageDefinition(definition).openshell.v1.OpenShell;

function driver(t, client) {
  const backend = createOpenShellBackend(
    {
      id: "identity-backend",
      type: "openshell",
      configuration: { endpoint: "http://127.0.0.1:9", insecureTransport: "network-policy" },
      drivers: { sandbox: "identity-sandbox", credential_gateway: "identity-credentials" },
    },
    { gatewayClient: client },
  );
  t.after(() => backend.client.close());
  return new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        userNamespaces: false,
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model",
            binaries: [{ path: "/usr/bin/node" }],
            endpoints: [{ host: "example.org", ports: [443] }],
          },
        ],
      },
    },
    { id: "identity-sandbox", backend },
  );
}

test("private workspace admission preserves distinct provider IDs and refuses unsupported or unproven owners through the real wire", async (t) => {
  const identity = { uid: 23456, gid: 34567, placement: "opaque-placement-1" };
  const namespace = { id: "namespace-1", name: "identity-workspace" };
  const workspaceLabels = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace-id": namespace.id,
  };
  let responseIdentity = identity;
  let providerWorkspaceId = "provider-workspace-1";
  let replaceWorkspace = false;
  let unsupported = false;
  let foreign = false;
  let receipt;
  const calls = [];
  const server = new grpc.Server();
  server.addService(OpenShell.service, {
    ResolveWorkspaceWorkloadIdentity(call, callback) {
      calls.push(call.request);
      if (replaceWorkspace) {
        providerWorkspaceId = "recreated-workspace";
      }
      if (unsupported) {
        return callback({ code: grpc.status.UNIMPLEMENTED, details: "unsupported" });
      }
      callback(null, { identity: responseIdentity });
    },
    GetWorkspace(call, callback) {
      callback(null, {
        workspace: {
          metadata: {
            id: providerWorkspaceId,
            name: call.request.name,
            labels: foreign ? {} : workspaceLabels,
          },
          status: { phase: 1 },
        },
      });
    },
    GetSandbox(call, callback) {
      if (!receipt) {
        return callback({ code: grpc.status.NOT_FOUND });
      }
      callback(null, {
        sandbox: {
          metadata: {
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
            annotations: {
              "openclaw.dev/namespace-id": namespace.id,
              "openclaw.dev/agent-id": "agent-1",
              "openclaw.dev/revision-id": "legacy",
            },
          },
          spec: { expected_workspace_workload_identity: receipt },
        },
      });
    },
    CreateSandbox(call, callback) {
      calls.push(call.request);
      callback(null, {
        sandbox: {
          metadata: {
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
          },
          spec: call.request.spec,
        },
        service_urls: {},
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  t.after(async () => {
    client.close();
    await new Promise((resolve) => server.tryShutdown(resolve));
  });
  const selected = driver(t, client);
  const context = {
    namespace,
    agentId: "agent-1",
    configuration: {},
    harness: { id: "codex", mode: "dedicated" },
    predecessors: [],
    signal: new AbortController().signal,
  };
  assert.deepEqual(await selected.resolvePrivateWorkspaceIdentity(context), identity);
  assert.deepEqual(calls[0], { workspace_scope: { workspace: namespace.name } });
  const created = await client.createSandbox(
    {
      name: "identity-sandbox",
      workspace: namespace.name,
      requestId: "identity-create",
      labels: {},
      annotations: {},
      serviceExposures: [],
      spec: { expected_workspace_workload_identity: identity },
    },
    context.signal,
  );
  assert.deepEqual(created.spec.expected_workspace_workload_identity, identity);
  assert.deepEqual(
    await selected.resolvePrivateWorkspaceIdentity({
      ...context,
      predecessors: [{ harness: { id: "openclaw", mode: "embedded" } }],
    }),
    identity,
  );
  const predecessor = {
    id: "previous",
    namespaceId: namespace.id,
    agentId: "agent-1",
    sandboxDriverId: selected.id,
    harness: context.harness,
    privateWorkspaceIdentity: identity,
  };
  responseIdentity = { ...identity, gid: identity.gid + 1 };
  assert.deepEqual(
    await selected.resolvePrivateWorkspaceIdentity({ ...context, predecessors: [predecessor] }),
    responseIdentity,
  );
  responseIdentity = { ...identity, uid: identity.uid + 1 };
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity({ ...context, predecessors: [predecessor] }),
    /Retained private workspace ownership/,
  );
  responseIdentity = identity;
  const legacy = { ...predecessor, id: "legacy", privateWorkspaceIdentity: undefined };
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity({ ...context, predecessors: [predecessor, legacy] }),
    /unproven/,
  );
  receipt = identity;
  assert.deepEqual(
    await selected.resolvePrivateWorkspaceIdentity({ ...context, predecessors: [legacy] }),
    identity,
  );
  receipt = { ...identity, uid: identity.uid + 1 };
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity({ ...context, predecessors: [legacy] }),
    /Retained private workspace ownership/,
  );
  responseIdentity = { ...identity, gid: 0 };
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity(context),
    /invalid workspace workload identity/,
  );
  responseIdentity = { ...identity, gid: 4294967295 };
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity(context),
    /invalid workspace workload identity/,
  );
  responseIdentity = { ...identity, placement: "another-placement" };
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity({ ...context, predecessors: [predecessor] }),
    /Retained private workspace ownership/,
  );
  responseIdentity = identity;
  replaceWorkspace = true;
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity(context),
    /Workspace changed during identity resolution/,
  );
  replaceWorkspace = false;
  providerWorkspaceId = "provider-workspace-1";
  foreign = true;
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity(context),
    /exact OCC Namespace ownership/,
  );
  foreign = false;
  unsupported = true;
  await assert.rejects(
    selected.resolvePrivateWorkspaceIdentity(context),
    /does not support workspace workload identity/,
  );
});
