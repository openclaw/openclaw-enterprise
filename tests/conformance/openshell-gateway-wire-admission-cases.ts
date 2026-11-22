import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import test from "node:test";
import { createRequire } from "node:module";
import {
  OpenShellAdmissionLimitError,
  OpenShellRequestReplayRefusedError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  SandboxRevisionUnsupportedError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

export function registerAdmissionCases(): void {
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  // An independent encoder for google.rpc.Status details, as tonic-types writes them.
  type StatusEncoder = { encode(message: object): { finish(): Uint8Array } };
  type StatusSchema = {
    lookupType(name: string): StatusEncoder & { fromObject(value: object): object };
  };
  const requireProtobuf: (name: "protobufjs") => {
    parse(schema: string, options: { keepCase: boolean }): { root: StatusSchema };
  } = createRequire(require.resolve("@grpc/proto-loader"));
  const protobuf = requireProtobuf("protobufjs");
  const rpcStatus = protobuf.parse(
    `
  syntax = "proto3";
  package google.rpc;
  message Any { string type_url = 1; bytes value = 2; }
  message Status { int32 code = 1; string message = 2; repeated Any details = 3; }
  message ErrorInfo { string reason = 1; string domain = 2; map<string, string> metadata = 3; }
  message RetryInfo { int64 seconds = 1; }
`,
    { keepCase: true },
  ).root;

  test("OpenShell client classifies CreateSandbox refusals and UpdateConfig conflicts from ErrorInfo", async () => {
    const detail = (type: "RetryInfo" | "ErrorInfo", message: object) => ({
      type_url: `type.googleapis.com/google.rpc.${type}`,
      value: rpcStatus.lookupType(`google.rpc.${type}`).encode(message).finish(),
    });
    const failure = (
      reason: string,
      domain = "openshell.nvidia.com",
      code = grpc.status.FAILED_PRECONDITION,
    ) => {
      const metadata = new grpc.Metadata();
      const Status = rpcStatus.lookupType("google.rpc.Status");
      metadata.set(
        "grpc-status-details-bin",
        Buffer.from(
          Status.encode(
            Status.fromObject({
              code,
              message: `refused ${reason}`,
              details: [
                detail("RetryInfo", { seconds: 5 }),
                detail("ErrorInfo", { reason, domain, metadata: { recovery: "none" } }),
              ],
            }),
          ).finish(),
        ),
      );
      return { code: grpc.status.FAILED_PRECONDITION, details: `refused ${reason}`, metadata };
    };
    const labelRefusal = "external resource not admitted by required labels";
    const plainPreconditions: Record<string, string> = {
      CONFIG_DISABLED:
        "caller driver config is disabled; a gateway administrator must enable allow_driver_config",
      PLAIN: "provider 'x' not found",
      PVC_LABELS: `PersistentVolumeClaim 'fixture/private-claim': ${labelRefusal}`,
      CLASS_LABELS: `RuntimeClass 'private-class': ${labelRefusal}`,
      REFLECTED: `reflected PersistentVolumeClaim 'fixture/private-claim': ${labelRefusal}`,
    };
    const metadataRefusal =
      "create sandbox failed: gateway is forbidden from reading metadata for RuntimeClass 'private-class' (Kubernetes 403); check gateway RBAC";
    const server = new grpc.Server();
    addWireService(server, {
      CreateSandbox(call, callback) {
        assert.ok(call.request.name !== undefined);
        const [reason, domain, code] = call.request.name.split("|");
        assert.ok(reason !== undefined);
        if (reason === "CLASS_METADATA") {
          callback({ code: grpc.status.INTERNAL, details: metadataRefusal });
          return;
        }
        const details = plainPreconditions[reason];
        callback(
          details !== undefined
            ? { code: grpc.status.FAILED_PRECONDITION, details }
            : failure(reason, domain || undefined, code === undefined ? undefined : Number(code)),
        );
      },
      UpdateConfig(call, callback) {
        const requestId = call.request.request_id;
        assert.ok(typeof requestId === "string");
        const [reason, domain] = requestId.split("|");
        assert.ok(reason !== undefined);
        if (reason === "PLAIN") {
          callback({ code: grpc.status.ABORTED, details: "private provider error" });
          return;
        }
        callback({
          ...failure(reason, domain || undefined, grpc.status.ABORTED),
          code: grpc.status.ABORTED,
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    const create = (name: string) =>
      client.createSandbox(
        {
          name,
          workspace: "tenant-workspace",
          requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
          labels: {},
          annotations: {},
          spec: {},
          serviceExposures: [],
        },
        AbortSignal.timeout(2_000),
      );
    try {
      for (const reason of [
        "REQUEST_OUTCOME_UNCERTAIN",
        "REQUEST_ID_PAYLOAD_MISMATCH",
        "REQUEST_REPLAY_UNAVAILABLE",
      ]) {
        await assert.rejects(create(reason), (error) => {
          assert.ok(error instanceof OpenShellRequestReplayRefusedError);
          assert.equal(error.reason, reason);
          assert.match(error.message, new RegExp(`refused ${reason}`));
          return true;
        });
      }
      // Only OpenShell's own replay reasons are refusals; anything else is the handler's error.
      const ordinaryRefusals: [string, string][] = [
        ["REQUEST_OUTCOME_UNCERTAIN|example.com", "UNKNOWN"],
        // The details envelope must carry the same status code.
        [`REQUEST_OUTCOME_UNCERTAIN||${grpc.status.ABORTED}`, "UNKNOWN"],
        ["SANDBOX_INVALID", "UNKNOWN"],
        ["CONFIG_DISABLED", "CALLER_DRIVER_CONFIG_DISABLED"],
        ["PLAIN", "UNKNOWN"],
        ["PVC_LABELS", "PVC_ADMISSION_LABELS"],
        ["CLASS_LABELS", "CLASS_ADMISSION_LABELS"],
        ["REFLECTED", "UNKNOWN"],
      ];
      for (const [name, validationCategory] of ordinaryRefusals) {
        await assert.rejects(create(name), (error) => {
          assert.ok(!(error instanceof OpenShellRequestReplayRefusedError));
          assert.ok(error instanceof DependencyUnavailableError);
          assert.equal(error.message, "OpenShell CreateSandbox failed with gRPC status 9.");
          assert.deepEqual(error.requestDiagnostic, {
            method: "CreateSandbox",
            grpcStatus: grpc.status.FAILED_PRECONDITION,
            validationCategory,
          });
          return true;
        });
      }
      await assert.rejects(create("CLASS_METADATA"), (error) => {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.equal(error.message, "OpenShell CreateSandbox failed with gRPC status 13.");
        assert.deepEqual(error.requestDiagnostic, {
          method: "CreateSandbox",
          grpcStatus: grpc.status.INTERNAL,
          validationCategory: "RESOURCE_METADATA_FORBIDDEN",
        });
        return true;
      });
      const update = (requestId: string) =>
        client.updatePolicy(
          {
            workspace: "tenant-workspace",
            sandbox: "sandbox",
            policy: {},
            expectedResourceVersion: "1",
            requestId,
          },
          AbortSignal.timeout(2_000),
        );
      await assert.rejects(update("RESOURCE_VERSION_CONFLICT"), (error) => {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.equal(
          error.message,
          "OpenShell UpdateConfig failed with gRPC status 10 (reason RESOURCE_VERSION_CONFLICT).",
        );
        return true;
      });
      for (const requestId of ["RESOURCE_VERSION_CONFLICT|example.com", "OTHER", "PLAIN"]) {
        await assert.rejects(update(requestId), (error) => {
          assert.ok(error instanceof DependencyUnavailableError);
          assert.equal(
            error.message,
            "OpenShell UpdateConfig failed with gRPC status 10 (reason UNKNOWN).",
          );
          return true;
        });
      }
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  test("OpenShell client holds only the durable admission limit as a transient dependency", async () => {
    // The pinned gateway's exact refusal once a caller holds 1000 durable admissions.
    const limit =
      "caller has reached the durable mutation admission limit; unresolved requests require reconciliation";
    const refuse = (details: string | undefined) => {
      assert.ok(details !== undefined);
      return { code: grpc.status.RESOURCE_EXHAUSTED, details };
    };
    const server = new grpc.Server();
    addWireService(server, {
      CreateSandbox: (call, callback) => callback(refuse(call.request.name)),
      CreateProvider: (call, callback) => callback(refuse(call.request.provider?.metadata?.name)),
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    const create = (name: string) =>
      client.createSandbox(
        {
          name,
          workspace: "tenant-workspace",
          requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
          labels: {},
          annotations: {},
          spec: {},
          serviceExposures: [],
        },
        AbortSignal.timeout(2_000),
      );
    try {
      // The limit clears only as completed admissions age out (24 h) or an operator
      // reconciles unresolved ones, so the worker must hold the revision pending until the
      // deployment deadline instead of spending its attempt budget on quick retries.
      for (const refused of [
        create(limit),
        client.createProvider(
          {
            name: limit,
            type: "openai",
            workspace: "tenant-workspace",
            labels: {},
            credentials: {},
          },
          AbortSignal.timeout(2_000),
        ),
      ]) {
        await assert.rejects(refused, (error) => {
          assert.ok(error instanceof OpenShellAdmissionLimitError, String(error));
          assert.ok(error instanceof TransientDependencyError);
          assert.equal(error.dependency, "sandbox_admission");
          assert.equal(error.code, "SANDBOX_ADMISSION_LIMIT_REACHED");
          assert.match(
            error.message,
            /limit of durable request admissions.*mutation_admission_limit_per_caller.*then redeploy/,
          );
          assert.equal(asRecord(error.cause)?.code, grpc.status.RESOURCE_EXHAUSTED);
          return true;
        });
      }
      // OpenShell's other RESOURCE_EXHAUSTED refusals stay the raw gRPC error, which the
      // worker classifies as an ordinary retryable failure.
      for (const details of [
        "gRPC rate limit exceeded",
        "mutation admission workers are busy; no work was started by this call",
      ]) {
        await assert.rejects(create(details), (error) => {
          assert.ok(!(error instanceof TransientDependencyError), String(error));
          assert.equal(asRecord(error)?.code, grpc.status.RESOURCE_EXHAUSTED);
          assert.equal(asRecord(error)?.details, details);
          return true;
        });
      }
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  test("OpenShell client fails a Harness Pod label refusal permanently", async () => {
    const server = new grpc.Server();
    addWireService(server, {
      // The pinned gateway's Kubernetes driver refuses template label keys missing from its
      // allowed_pod_labels with INVALID_ARGUMENT, naming the sorted keys.
      CreateSandbox(call, callback) {
        assert.ok(call.request.name !== undefined);
        callback({ code: grpc.status.INVALID_ARGUMENT, details: call.request.name });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    const create = (details: string) =>
      client.createSandbox(
        {
          name: details,
          workspace: "tenant-workspace",
          requestId: "0b3a6f52-6c8e-4d55-9a3c-4b8f2a1d7e90",
          labels: {},
          annotations: {},
          spec: {},
          serviceExposures: [],
        },
        AbortSignal.timeout(2_000),
      );
    try {
      // The gateway configuration refuses the same keys on every create, so the worker must fail
      // the deployment at once with a named code instead of retrying it as an outage.
      await assert.rejects(
        create(
          "pod labels not permitted by the gateway's allowed_pod_labels: app.kubernetes.io/managed-by, openclaw.dev/agent",
        ),
        (error) => {
          assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
          assert.ok(!(error instanceof DependencyUnavailableError));
          assert.equal(error.code, "SANDBOX_POD_LABELS_NOT_PERMITTED");
          assert.match(
            error.message,
            /Harness Pod labels app\.kubernetes\.io\/managed-by, openclaw\.dev\/agent; add them to the gateway's Kubernetes driver allowed_pod_labels/,
          );
          return true;
        },
      );
      // Other create-time validation stays an ordinary retryable gateway failure.
      await assert.rejects(create("driver_config.kubernetes: unknown field `env`"), (error) => {
        assert.ok(!(error instanceof SandboxRevisionUnsupportedError), String(error));
        assert.ok(error instanceof DependencyUnavailableError);
        assert.match(error.message, /CreateSandbox failed with gRPC status 3/);
        return true;
      });
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });
}
