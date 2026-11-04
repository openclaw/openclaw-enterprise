import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { checkOpenShellGitProviders } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-installation.ts";

// Resolve the controller's dependencies; project only the dynamic gRPC surface used here.
const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
type Call = {
  request: { name: string; id: string; workspace_scope: { workspace: string } };
};
type Reply = (error: null | { code: number; message: string }, value?: object) => void;
const grpc = require("@grpc/grpc-js") as {
  Server: new () => {
    addService(
      service: unknown,
      handlers: Record<string, (call: Call, reply: Reply) => void>,
    ): void;
    bindAsync(
      address: string,
      credentials: unknown,
      callback: (error: Error | null, port: number) => void,
    ): void;
    forceShutdown(): void;
  };
  ServerCredentials: { createInsecure(): unknown };
  status: { NOT_FOUND: number };
  loadPackageDefinition(definition: unknown): {
    openshell: { v1: { OpenShell: { service: unknown } } };
  };
};
const loader = require("@grpc/proto-loader") as {
  load(path: string, options: object): Promise<unknown>;
};

test("files-only wire profiles pass Git provider verification without weakening refusals", async (t) => {
  const definition = await loader.load(
    fileURLToPath(
      new URL(
        "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
        import.meta.url,
      ),
    ),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  );
  const service = grpc.loadPackageDefinition(definition).openshell.v1.OpenShell.service;
  const id = "oce-runtime-0123456789abcdef";
  const workspace = "owned-test-workspace";
  let profileId = id;
  let profileWorkspace = workspace;
  let missing = false;
  let absent = false;
  let endpoints: { host: string; port: number }[] = [];
  let credentials: { name: string; env_vars: string[] }[] = [];
  let profileReads = 0;
  const server = new grpc.Server();
  t.after(() => server.forceShutdown());
  server.addService(service, {
    GetProvider(call, reply) {
      assert.equal(call.request.name, id);
      assert.equal(call.request.workspace_scope.workspace, workspace);
      reply(null, {
        provider: {
          metadata: { name: id, workspace, id: "test-provider-id", resource_version: "1" },
          type: id,
          profile_workspace: profileWorkspace,
        },
      });
    },
    GetProviderProfile(call, reply) {
      profileReads += 1;
      assert.equal(call.request.id, id);
      assert.equal(call.request.workspace_scope.workspace, workspace);
      if (missing) {
        reply({ code: grpc.status.NOT_FOUND, message: "missing synthetic profile" });
        return;
      }
      reply(
        null,
        absent
          ? {}
          : {
              profile: {
                id: profileId,
                endpoints,
                credentials,
                files: [{ path: "/fixture/runtime", env_var: "RUNTIME_FILE" }],
              },
            },
      );
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => {
      if (error) reject(error);
      else resolve(bound);
    });
  });
  const client = new GrpcOpenShellGatewayClient({
    endpoint: `127.0.0.1:${port}`,
    requestTimeoutMs: 2000,
  });
  t.after(() => client.close());
  const check = () => checkOpenShellGitProviders(client, workspace, [id], t.signal);
  const safe = await client.getProviderProfile(workspace, id, t.signal);
  await check();
  assert.ok(safe?.definition);
  assert.deepEqual(safe.definition.endpoints, []);
  assert.deepEqual(safe.definition.credentials, []);

  endpoints = [{ host: "models.example.org", port: 443 }];
  credentials = [{ name: "model", env_vars: ["MODEL_KEY"] }];
  const explicit = await client.getProviderProfile(workspace, id, t.signal);
  assert.ok(explicit?.definition);
  assert.deepEqual(explicit.definition.endpoints, endpoints);
  assert.deepEqual(explicit.definition.credentials, credentials);
  await check();
  for (const host of ["github.com", "api.github.com", "ssh.github.com", "*.com"]) {
    endpoints = [{ host, port: 443 }];
    await assert.rejects(check(), /overlapping/);
  }
  endpoints = [];
  credentials = [{ name: "fixture", env_vars: ["GITHUB_TOKEN"] }];
  await assert.rejects(check(), /overlapping/);
  credentials = [];
  missing = true;
  await assert.rejects(check(), /unverified/);
  missing = false;
  absent = true;
  await assert.rejects(check(), /another profile/);
  absent = false;
  profileId = "another-profile";
  await assert.rejects(check(), /another profile/);
  profileId = id;
  profileWorkspace = "another-workspace";
  const readsBefore = profileReads;
  await assert.rejects(check(), /another Workspace/);
  assert.equal(profileReads, readsBefore);
});
