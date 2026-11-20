import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { grpc, loader } from "../helpers/openshell-grpc-sdk.ts";
import { bindWireServer } from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

export function registerManagedWorkloadCases() {
  test("OpenShell managed workload RPCs use the separate update service and preserve CAS and explicit empty maps", async (t) => {
    const definition = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-managed-workspace-wire.proto"),
      {
        keepCase: true,
        longs: String,
        defaults: false,
      },
    );
    const wire = grpc.loadPackageDefinition(definition).openshell.v1;
    const received = [];
    const reply = (operation) => (call, callback) => {
      received.push({ operation, request: call.request });
      callback(null, {
        sandbox: {
          metadata: {
            name: call.request.name,
            workspace: call.request.workspace_scope.workspace,
            resource_version: "9007199254740994",
          },
        },
      });
    };
    const server = new grpc.Server();
    server.addService(wire.OpenShell.service, {
      StopSandbox: reply("stop"),
      StartSandbox: reply("start"),
      AttachSandboxProvider(call, callback) {
        received.push({ operation: "attach", request: call.request });
        if (call.request.expected_resource_version !== "9007199254740994") {
          callback({ code: grpc.status.ABORTED, message: "stale resource version" });
          return;
        }
        callback(null, { attached: true });
      },
      ExposeService(call, callback) {
        received.push({ operation: "expose", request: call.request });
        callback(null, {});
      },
    });
    server.addService(wire.SandboxUpdates.service, { UpdateSandbox: reply("update") });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    t.after(() => {
      client.close();
      server.forceShutdown();
    });
    const selector = { name: "oc-stable", workspace: "oce-workspace" };
    const signal = AbortSignal.timeout(5000);
    await client.stopSandbox(selector, signal);
    const updated = await client.updateSandbox(
      {
        ...selector,
        expectedResourceVersion: "9007199254740993",
        requestId: "a9c1cfd2-97ea-43cb-81c9-901f6bfe136d",
        spec: {
          template: { image: "runtime@sha256:" + "a".repeat(64) },
          command: ["node", "-e", "process.exit(0)"],
          environment: {},
        },
        labels: {},
        annotations: { "openclaw.dev/revision-id": "revision-b" },
        serviceExposures: [],
      },
      signal,
    );
    await client.startSandbox(selector, signal);
    assert.equal(updated.resourceVersion, "9007199254740994");
    assert.deepEqual(
      received.map((value) => value.operation),
      ["stop", "update", "start"],
    );
    for (const { request } of received) {
      assert.equal(request.name, selector.name);
      assert.equal(request.workspace_scope.workspace, selector.workspace);
    }
    // An absent wrapper means preserve, while a present empty wrapper means clear.
    // The independently encoded server must distinguish these update semantics.
    const request = received[1].request;
    assert.equal(request.expected_resource_version, "9007199254740993");
    assert.deepEqual(request.command.argv, ["node", "-e", "process.exit(0)"]);
    assert.ok(request.environment);
    assert.ok(request.labels);
    assert.equal(Object.keys(request.environment.values ?? {}).length, 0);
    assert.deepEqual(request.annotations.values, { "openclaw.dev/revision-id": "revision-b" });
    await client.exposeService(
      {
        workspace: selector.workspace,
        sandbox: selector.name,
        service: "",
        targetPort: 8080,
        authorizationMode: "bearer_passthrough",
      },
      signal,
    );
    // Restoring the unnamed route must preserve authentication at the Harness;
    // omitted or incorrectly numbered authorization fields default to stripping it.
    const exposure = received.at(-1);
    assert.equal(exposure.operation, "expose");
    assert.equal(exposure.request.workspace_scope.workspace, selector.workspace);
    assert.equal(exposure.request.sandbox, selector.name);
    assert.equal(exposure.request.name, "");
    assert.equal(exposure.request.target_port, 8080);
    assert.equal(exposure.request.authorization_mode, 2);
    // Provider replacement uses the same lossless CAS field and exact Workspace
    // scope as workload updates. A server conflict must reach reconciliation.
    const conditional = {
      expectedResourceVersion: "9007199254740994",
      requestId: randomUUID(),
    };
    await client.attachSandboxProvider(
      selector.workspace,
      selector.name,
      "model-b",
      signal,
      conditional,
    );
    assert.deepEqual(received.at(-1), {
      operation: "attach",
      request: {
        sandbox: selector.name,
        provider: "model-b",
        expected_resource_version: conditional.expectedResourceVersion,
        workspace_scope: { workspace: selector.workspace },
        request_id: conditional.requestId,
      },
    });
    await assert.rejects(
      client.attachSandboxProvider(selector.workspace, selector.name, "model-b", signal, {
        ...conditional,
        expectedResourceVersion: "1",
        requestId: randomUUID(),
      }),
      (error) => {
        assert.equal(error.grpcStatus, grpc.status.ABORTED);
        return true;
      },
    );
  });
}
