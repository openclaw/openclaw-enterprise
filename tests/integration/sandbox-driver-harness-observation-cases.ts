import assert from "node:assert/strict";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClient,
  type OpenShellServiceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellServiceTransportError } from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  DependencyUnavailableError,
  type TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { deferred } from "../helpers/deferred.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type StatusContext = Parameters<OpenShellSandboxDriver["harnessStatus"]>[0];
type GatewayReads = Pick<
  OpenShellGatewayClient,
  "getService" | "getServiceDocument" | "serviceWebSocketHandshake" | "serviceCodexReadinessStatus"
>;
type GatewayReadCall = {
  [Operation in keyof GatewayReads]: [Operation, ...Parameters<GatewayReads[Operation]>];
}[keyof GatewayReads];
type ServiceResponse = Omit<OpenShellServiceResponse, "sandbox">;
type ObservationGateway = Omit<ReturnType<typeof workspaceGatewayClient>, keyof GatewayReads> &
  GatewayReads;
type SandboxConfiguration = ConstructorParameters<typeof OpenShellSandboxDriver>[0];
type FixtureDependencies = {
  TransientDependencyError: typeof TransientDependencyError;
  openShellDriver: (
    client: ObservationGateway | GrpcOpenShellGatewayClient,
    configuration?: SandboxConfiguration,
  ) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (driver: OpenShellSandboxDriver) => {
    context: Omit<StatusContext, "revision" | "requirements" | "transportToken">;
    revision: SandboxFixtureRevision;
    requirements: StatusContext["requirements"];
  };
  sandboxInstallation: () => {
    drivers: {
      sandbox: { configuration: SandboxConfiguration & { gateway: { workspaceMode: string } } };
    };
  };
};

export async function verifySandboxDriverHarnessObservation({
  openShellDriver,
  runtimeSandboxFixture,
  sandboxInstallation,
  TransientDependencyError,
}: FixtureDependencies): Promise<void> {
  const bearerPassthroughService: ServiceResponse = {
    name: "",
    targetPort: 8080,
    authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
    advertisedUrl: "http://codex.example.test:8080/",
    url: "http://codex.example.test:9443/",
  };
  let service = bearerPassthroughService;
  const observed: GatewayReadCall[] = [];
  let document: Awaited<ReturnType<GatewayReads["getServiceDocument"]>> = { status: 502 };
  let handshake = false;
  const reads: GatewayReads = {
    getService: async (...args) => {
      observed.push(["getService", ...args]);
      const [, sandbox] = args;
      return { ...service, sandbox };
    },
    getServiceDocument: async (...args) => {
      observed.push(["getServiceDocument", ...args]);
      return document;
    },
    serviceWebSocketHandshake: async (...args) => {
      observed.push(["serviceWebSocketHandshake", ...args]);
      return handshake;
    },
    serviceCodexReadinessStatus: async (...args) => {
      const [, , requirePat] = args;
      assert.equal(requirePat, false);
      observed.push(["serviceCodexReadinessStatus", ...args]);
      return handshake ? "serving" : "unavailable";
    },
  };
  const gatewayClient: ObservationGateway = { ...workspaceGatewayClient(), ...reads };
  const driver = openShellDriver(gatewayClient);
  const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
  const revision = completeWorkspaceRevision(fixtureRevision, requirements);
  const statusContext = { ...context, revision, requirements, transportToken: "transport-token" };

  // Nothing listens yet: a refused handshake and OpenShell's own 502 mean starting.
  assert.deepEqual(await driver.harnessStatus(statusContext), { state: "starting" });
  const [lookup] = observed;
  assert.ok(lookup?.[0] === "getService");
  const [, , sandboxName] = lookup;
  assert.deepEqual(observed, [
    ["getService", context.namespace.name, sandboxName, "", context.signal],
    [
      "serviceCodexReadinessStatus",
      "http://codex.example.test:9443/",
      "transport-token",
      false,
      context.signal,
    ],
    [
      "getServiceDocument",
      "http://codex.example.test:9443/",
      "/openclaw/runtime/status",
      "transport-token",
      context.signal,
    ],
  ] satisfies GatewayReadCall[]);

  // A serving app-server is never sent a plain request.
  handshake = true;
  observed.length = 0;
  assert.deepEqual(await driver.harnessStatus(statusContext), { state: "serving" });
  assert.deepEqual(
    observed.map(([operation]) => operation),
    ["getService", "serviceCodexReadinessStatus"],
  );
  handshake = false;

  // A held failure answers the upgrade 503; it is returned unvalidated for Compute.
  const runtimeFailure = {
    component: "agent",
    check: "model-probe",
    checkedAt: "2026-10-08T13:00:00.000Z",
    code: "MODEL_PROBE_FAILED",
  };
  document = { status: 200, json: { runtimeFailure } };
  observed.length = 0;
  assert.deepEqual(await driver.harnessStatus(statusContext), {
    state: "failed",
    runtimeFailure,
  });
  assert.equal(observed.length, 3);
  // Only a 200 status document with a runtime failure counts; anything else is starting.
  for (const other of [
    { status: 404, json: { runtimeFailure } },
    { status: 503, json: { runtimeFailure } },
    { status: 200, json: { error: "x" } },
    { status: 200, json: ["runtimeFailure"] },
    { status: 200 },
  ]) {
    document = other;
    assert.deepEqual(await driver.harnessStatus(statusContext), { state: "starting" });
  }

  // The same exactness as harnessEndpoint: wrong port, mode, or a missing service fail closed.
  const numericBearerPassthroughService: ServiceResponse = {
    ...bearerPassthroughService,
    authorizationMode: 2,
  };
  for (const changed of [
    { targetPort: 8081 },
    { authorizationMode: "SERVICE_AUTHORIZATION_MODE_STRIP" },
  ] satisfies Partial<ServiceResponse>[]) {
    service = { ...service, ...changed };
    await assert.rejects(driver.harnessStatus(statusContext), /exact Codex bearer-passthrough/);
    service = numericBearerPassthroughService;
  }
  // A dedicated OpenClaw worker (finding 1642) is observed through the same exposure, with
  // the same exactness: wrong port or a missing service fail closed.
  const nativeContext: StatusContext = {
    ...statusContext,
    revision: {
      ...revision,
      harness: { ...revision.harness, id: "openclaw", version: "1.0.0", mode: "dedicated" },
    },
  };
  document = { status: 200, json: { runtimeFailure } };
  assert.deepEqual(await driver.harnessStatus(nativeContext), {
    state: "failed",
    runtimeFailure,
  });
  service = { ...numericBearerPassthroughService, targetPort: 8081 };
  await assert.rejects(
    driver.harnessStatus(nativeContext),
    /exact OpenClaw worker bearer-passthrough/,
  );
  service = numericBearerPassthroughService;
  gatewayClient.getService = async () => undefined;
  observed.length = 0;
  await assert.rejects(
    driver.harnessStatus(nativeContext),
    /exact OpenClaw worker bearer-passthrough/,
  );
  await assert.rejects(driver.harnessStatus(statusContext), /exact Codex bearer-passthrough/);
  assert.deepEqual(observed, []);
  gatewayClient.getService = reads.getService;
  await assert.rejects(
    driver.harnessStatus({
      ...statusContext,
      revision: {
        ...revision,
        harness: { ...revision.harness, id: "other", version: "1.0.0", mode: "dedicated" },
      },
    }),
    /only for dedicated Codex or OpenClaw revisions/,
  );
  await assert.rejects(driver.harnessEndpoint(nativeContext), /only for dedicated Codex revisions/);
  // Finding 1658: a gateway that does not answer, over its service listener or over gRPC, is
  // no evidence about the Harness. The read is a transient dependency failure the worker
  // rechecks until the deadline without spending attempts, with the transport's own reason.
  // Refusals, invalid answers and the gateway's own transient classes keep their classes.
  document = { status: 200, json: { runtimeFailure } };
  for (const [overrides, reason] of [
    [
      {
        serviceCodexReadinessStatus: async () => {
          throw new OpenShellServiceTransportError("timeout");
        },
        serviceWebSocketHandshake: async () => {
          throw new OpenShellServiceTransportError("timeout");
        },
      },
      "timeout",
    ],
    [
      {
        getServiceDocument: async () => {
          throw new OpenShellServiceTransportError("unreachable");
        },
      },
      "unreachable",
    ],
    [
      {
        getService: async () => {
          throw new DependencyUnavailableError("OpenShell GetService failed with gRPC status 14.");
        },
      },
      "unavailable",
    ],
  ] satisfies [Partial<GatewayReads>, TransientDependencyError["reason"]][]) {
    Object.assign(gatewayClient, overrides);
    try {
      for (const target of [statusContext, nativeContext]) {
        await assert.rejects(driver.harnessStatus(target), (error) => {
          assert.ok(error instanceof TransientDependencyError, String(error));
          assert.equal(error.dependency, "sandbox_gateway");
          assert.equal(error.reason, reason);
          assert.equal(error.code, "SANDBOX_GATEWAY_UNAVAILABLE");
          assert.ok(error.cause instanceof DependencyUnavailableError);
          return true;
        });
      }
    } finally {
      Object.assign(gatewayClient, reads);
    }
  }
  const transient = new TransientDependencyError("sandbox_admission", "unavailable", "limit");
  const refused = new Error("OpenShell GetService refused: PERMISSION_DENIED");
  for (const thrown of [transient, refused]) {
    gatewayClient.getService = async () => {
      throw thrown;
    };
    await assert.rejects(driver.harnessStatus(statusContext), (error) => error === thrown);
    gatewayClient.getService = reads.getService;
  }
  assert.deepEqual(await driver.harnessStatus(statusContext), {
    state: "failed",
    runtimeFailure,
  });
  // Another Sandbox Driver's revision, or a deferred managed Workspace, is refused before the
  // Harness is observed.
  observed.length = 0;
  await assert.rejects(
    driver.harnessStatus({
      ...statusContext,
      revision: { ...revision, sandboxDriverId: "other" },
    }),
    /another Sandbox Driver/,
  );
  const managedConfiguration = sandboxInstallation().drivers.sandbox.configuration;
  managedConfiguration.gateway.workspaceMode = "managed";
  const managed = openShellDriver(gatewayClient, managedConfiguration);
  await assert.rejects(
    managed.harnessStatus(statusContext),
    /managed workspace mode is not implemented; cannot observe a Harness/,
  );
  assert.deepEqual(observed, []);

  // Even an already-cancelled lookup must not initialize a cold gRPC client.
  const cold = new GrpcOpenShellGatewayClient({ endpoint: "http://127.0.0.1:1" });
  cold["createClient"] = async () => assert.fail("cancelled status initialized the client");
  const cancelled = new Error("cancel Harness observation");
  await assert.rejects(
    openShellDriver(cold).harnessStatus({
      ...statusContext,
      signal: AbortSignal.abort(cancelled),
    }),
    (error) => error === cancelled,
  );

  // Cancellation can arrive after a Gateway read completes but before its result
  // reaches the Driver. Do not accept that result or begin another read.
  for (const [operation, serving, reject] of [
    ["getService", false, false],
    ["serviceCodexReadinessStatus", true, false],
    ["serviceCodexReadinessStatus", false, false],
    ["getServiceDocument", false, false],
    ["serviceCodexReadinessStatus", false, true],
  ] as const) {
    handshake = serving;
    observed.length = 0;
    const caller = new AbortController();
    const reason = new DependencyUnavailableError("cancel Harness observation");
    const entered = deferred();
    const release = deferred();
    const intercept = <Args extends unknown[], Result>(
      original: (...args: Args) => Promise<Result>,
      replace: (method: (...args: Args) => Promise<Result>) => void,
    ) => {
      replace(async (...args) => {
        const result = await original(...args);
        entered.resolve();
        await release.promise;
        if (reject) {
          throw reason;
        }
        return result;
      });
      return () => replace(original);
    };
    const install = {
      getService: () =>
        intercept(gatewayClient.getService, (method) => {
          gatewayClient.getService = method;
        }),
      serviceCodexReadinessStatus: () =>
        intercept(gatewayClient.serviceCodexReadinessStatus, (method) => {
          gatewayClient.serviceCodexReadinessStatus = method;
        }),
      getServiceDocument: () =>
        intercept(gatewayClient.getServiceDocument, (method) => {
          gatewayClient.getServiceDocument = method;
        }),
    };
    const restore = install[operation]();
    try {
      const rejected = assert.rejects(
        driver.harnessStatus({ ...statusContext, signal: caller.signal }),
        (error) => error === reason,
      );
      await entered.promise;
      const beforeAbort: GatewayReadCall[] = [...observed];
      caller.abort(reason);
      release.resolve();
      await rejected;
      assert.deepEqual(observed, beforeAbort, `${operation} started another read`);
    } finally {
      release.resolve();
      restore();
    }
  }
}
