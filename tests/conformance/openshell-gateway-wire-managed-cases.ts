import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { grpc, loader, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { bindWireServer } from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellAdmissionLimitError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts";

type WorkspaceScope = { workspace?: string };
type ScopedRequest = { workspace_scope?: WorkspaceScope };
type MapUpdate = { values?: Record<string, string> };
type WorkloadRequest = ScopedRequest & {
  name?: string;
  expected_resource_version?: string;
  command?: { argv?: string[] };
  environment?: MapUpdate;
  labels?: MapUpdate;
  annotations?: MapUpdate;
};
type AttachRequest = ScopedRequest & {
  sandbox?: string;
  provider?: string;
  expected_resource_version?: string;
  request_id?: string;
};
type ExposeRequest = ScopedRequest & {
  sandbox?: string;
  name?: string;
  target_port?: number;
  authorization_mode?: number;
};
type SandboxReply = {
  sandbox: {
    metadata: {
      name: string | undefined;
      workspace: string | undefined;
      resource_version: string;
    };
  };
};
type AttachReply = {
  sandbox?: {
    metadata: { name: string; id: string; workspace: string; resource_version: string };
  };
  attached: boolean;
  receipt?: { receipt_id: string; provider: string; workspace: string; kind: number };
};
type ReceivedCall =
  | { operation: "stop" | "update" | "start"; request: WorkloadRequest }
  | { operation: "attach"; request: AttachRequest }
  | { operation: "expose"; request: ExposeRequest };

function managedServices(packages: Grpc.GrpcObject): {
  openShell: Grpc.ServiceDefinition;
  sandboxUpdates: Grpc.ServiceDefinition;
} {
  const openshell = packages.openshell;
  assert.ok(openshell && typeof openshell === "object" && !("format" in openshell));
  const v1 = openshell.v1;
  assert.ok(v1 && typeof v1 === "object" && !("format" in v1));
  const openShell = v1.OpenShell;
  const sandboxUpdates = v1.SandboxUpdates;
  assert.ok(typeof openShell === "function", "Missing OpenShell service");
  assert.ok(typeof sandboxUpdates === "function", "Missing SandboxUpdates service");
  return { openShell: openShell.service, sandboxUpdates: sandboxUpdates.service };
}

export function registerManagedWorkloadCases(): void {
  test("OpenShell managed workload RPCs use the separate update service and preserve CAS and explicit empty maps", async (t) => {
    const definition = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-managed-workspace-wire.proto"),
      {
        keepCase: true,
        longs: String,
        defaults: false,
      },
    );
    const wire = managedServices(grpc.loadPackageDefinition(definition));
    const received: ReceivedCall[] = [];
    function reply(
      operation: "stop" | "update" | "start",
    ): Grpc.handleUnaryCall<WorkloadRequest, SandboxReply> {
      return ({ request }, callback) => {
        received.push({ operation, request });
        assert.ok(request.workspace_scope);
        callback(null, {
          sandbox: {
            metadata: {
              name: request.name,
              workspace: request.workspace_scope.workspace,
              resource_version: "9007199254740994",
            },
          },
        });
      };
    }
    const server = new grpc.Server();
    const cleanup: { client?: GrpcOpenShellGatewayClient } = {};
    t.after(() => {
      try {
        cleanup.client?.close();
      } finally {
        server.forceShutdown();
      }
    });
    const handlers = {
      StopSandbox: reply("stop"),
      StartSandbox: reply("start"),
      AttachSandboxProvider(call, callback) {
        received.push({ operation: "attach", request: call.request });
        if (call.request.provider === "denied-provider") {
          callback({ code: grpc.status.PERMISSION_DENIED, details: "private-synthetic-detail" });
          return;
        }
        if (call.request.provider === "admission-limited-provider") {
          callback({
            code: grpc.status.RESOURCE_EXHAUSTED,
            details:
              "caller has reached the durable mutation admission limit; private-synthetic-detail",
          });
          return;
        }
        if (call.request.expected_resource_version !== "9007199254740994") {
          callback({ code: grpc.status.ABORTED, message: "stale resource version" });
          return;
        }
        if (call.request.provider === "legacy-provider") {
          callback(null, { attached: true });
          return;
        }
        assert.ok(
          call.request.sandbox && call.request.provider && call.request.workspace_scope?.workspace,
        );
        callback(null, {
          sandbox: {
            metadata: {
              name: call.request.sandbox,
              id: "sandbox-id",
              workspace: call.request.workspace_scope.workspace,
              resource_version: "9007199254740995",
            },
          },
          attached: true,
          receipt: {
            receipt_id: "receipt-attach",
            provider:
              call.request.provider === "invalid-receipt"
                ? "another-provider"
                : call.request.provider,
            workspace: call.request.workspace_scope.workspace,
            kind: 1,
          },
        });
      },
      ExposeService(call, callback) {
        received.push({ operation: "expose", request: call.request });
        callback(null, {});
      },
    } satisfies {
      StopSandbox: Grpc.handleUnaryCall<WorkloadRequest, SandboxReply>;
      StartSandbox: Grpc.handleUnaryCall<WorkloadRequest, SandboxReply>;
      AttachSandboxProvider: Grpc.handleUnaryCall<AttachRequest, AttachReply>;
      ExposeService: Grpc.handleUnaryCall<ExposeRequest, Record<string, never>>;
    };
    server.addService(wire.openShell, handlers);
    server.addService(wire.sandboxUpdates, { UpdateSandbox: reply("update") });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    cleanup.client = client;
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
      assert.equal("name" in request ? request.name : undefined, selector.name);
      assert.equal(request.workspace_scope?.workspace, selector.workspace);
    }
    // An absent wrapper means preserve, while a present empty wrapper means clear.
    // The independently encoded server must distinguish these update semantics.
    const update = received[1];
    assert.ok(update?.operation === "update");
    const request = update.request;
    assert.equal(request.expected_resource_version, "9007199254740993");
    assert.deepEqual(request.command?.argv, ["node", "-e", "process.exit(0)"]);
    assert.ok(request.environment);
    assert.ok(request.labels);
    assert.equal(Object.keys(request.environment.values ?? {}).length, 0);
    assert.deepEqual(request.annotations?.values, { "openclaw.dev/revision-id": "revision-b" });
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
    assert.ok(exposure?.operation === "expose");
    assert.equal(exposure.request.workspace_scope?.workspace, selector.workspace);
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
    const attached = await client.attachSandboxProvider(
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
    assert.ok(attached);
    assert.equal(attached.sandbox.id, "sandbox-id");
    assert.equal(attached.sandbox.resourceVersion, "9007199254740995");
    assert.equal(attached.receiptId, "receipt-attach");
    assert.equal(attached.attached, true);
    // Existing reconciliation can still read back membership after a successful legacy reply;
    // staged callers receive no validated attachment evidence from absent or mismatched receipts.
    for (const provider of ["legacy-provider", "invalid-receipt"]) {
      assert.equal(
        await client.attachSandboxProvider(selector.workspace, selector.name, provider, signal, {
          ...conditional,
          requestId: randomUUID(),
        }),
        undefined,
      );
    }
    await assert.rejects(
      client.attachSandboxProvider(selector.workspace, selector.name, "model-b", signal, {
        ...conditional,
        expectedResourceVersion: "1",
        requestId: randomUUID(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "grpcStatus" in error);
        assert.equal(error.grpcStatus, grpc.status.ABORTED);
        return true;
      },
    );
    await assert.rejects(
      client.attachSandboxProvider(selector.workspace, selector.name, "denied-provider", signal, {
        ...conditional,
        requestId: randomUUID(),
      }),
      (error: Error) =>
        error.message.includes("gRPC status 7") &&
        !error.message.includes("private-synthetic-detail"),
    );
    await assert.rejects(
      client.attachSandboxProvider(
        selector.workspace,
        selector.name,
        "admission-limited-provider",
        signal,
        {
          ...conditional,
          requestId: randomUUID(),
        },
      ),
      (error: Error) =>
        error instanceof OpenShellAdmissionLimitError &&
        !error.message.includes("private-synthetic-detail") &&
        !String(error.cause).includes("private-synthetic-detail"),
    );
  });
}
