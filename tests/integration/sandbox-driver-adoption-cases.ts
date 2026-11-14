import assert from "node:assert/strict";
import {
  OpenShellSandboxAlreadyExistsError,
  type OpenShellSandboxCreateRequest,
  type OpenShellSandboxResponse,
  type OpenShellServiceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { SandboxEnvironmentVariable } from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnauthorizedError,
  SandboxRevisionUnsupportedError,
} from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  prepareGatewayReplayFixture,
  verifyConcurrentReplayAndExhaustion,
  verifyFreshRequestAfterRefusal,
  verifySandboxAdoptionRefusals,
} from "./sandbox-driver-gateway-replay-cases.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import {
  prepareNativeHeldFailure,
  verifyNativeHeldFailureWithdrawal,
} from "./sandbox-driver-native-exposure-cases.ts";
import { verifyNativeOpenClawCreateRequest } from "./sandbox-driver-native-harness-assertions.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  codexRequirements,
  dedicatedRevision,
  harnessService,
  namespaceContext,
  ownedWorkspace,
  runtimeSandboxFixture,
  sandboxRecord,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

function record(value: unknown): Record<string, unknown> {
  const object = asRecord(value);
  assert.ok(object);
  return object;
}

function structFields(value: unknown): Record<string, unknown> {
  return record(record(record(value).structValue).fields);
}

export async function verifyNativeOpenClawProvisioning(): Promise<void> {
  const requests: OpenShellSandboxCreateRequest[] = [];
  let sandboxResponse: OpenShellSandboxResponse | undefined;
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    requests.push(request);
    sandboxResponse = storedSandbox(structuredClone(request), { serviceUrls: {} });
    return sandboxResponse;
  };
  gatewayClient.getSandbox = async () => sandboxResponse;
  const base = buildSandboxInstallation().drivers.sandbox.configuration;
  const configuration: OpenShellSandboxDriverOptions = {
    ...base,
    kubernetes: {
      ...base.kubernetes,
      agentResourceOverrides: [
        {
          namespaceId: namespaceContext().namespace.id,
          agentId: "agt_00000000-0000-4000-8000-000000000003",
          requests: {},
          limits: {},
          runtimeClassName: "openshell-skipper",
        },
      ],
    },
    policy: {
      ...base.policy,
      filesystem: {
        includeWorkdir: false,
        readOnly: ["/app"],
        readWrite: ["/var/tmp/openclaw"],
      },
    },
  };
  const driver = openShellDriver(gatewayClient, configuration);
  const {
    context,
    revision: fixtureRevision,
    requirements,
    nodeSetup,
    prepared,
  } = runtimeSandboxFixture(driver, { harnessId: "openclaw" });
  const revision = completeSandboxRevision(fixtureRevision);
  const command = requirements.command;
  await driver.ensureNamespace(context);
  // A denied preparer must leave the native Sandbox absent and retryable.
  const create = context.kubernetes.create;
  context.kubernetes.create = async () => {
    throw new Error("preparation forbidden");
  };
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements }),
    /preparation forbidden/,
  );
  assert.equal(requests.length, 0);
  context.kubernetes.create = create;
  const sandbox = await driver.provisionHarness({ ...context, revision, requirements });
  await driver.provisionHarness({ ...context, revision, requirements });
  assert.equal(prepared.length, 1, "an adopted Sandbox must not recreate its PVC writer");
  const [deployment] = prepared;
  assert.ok(deployment);
  assert.equal(deployment.kind, "Deployment");
  const template = record(record(record(deployment).spec).template);
  const preparation = record(template.spec);
  assert.equal(preparation.runtimeClassName, "openshell-skipper");
  assert.equal(preparation.automountServiceAccountToken, false);
  assert.equal(record(preparation.securityContext).runAsUser, 10001);
  const containers = preparation.containers;
  assert.ok(Array.isArray(containers));
  const [container]: readonly unknown[] = containers;
  assert.deepEqual(record(record(container).securityContext).capabilities, { drop: ["ALL"] });

  assert.equal(sandbox.revisionId, revision.id);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  const runtimeProvider = verifyNativeOpenClawCreateRequest({
    request,
    expectedCommand: command,
    labels: requirements.labels,
    nodeSetup,
    gatewayClient,
  });
  await driver.cleanup({ ...context, revision });
  assert.equal(gatewayClient.providers.has(runtimeProvider), false);
  assert.equal(gatewayClient.profiles.has("oce-openclaw-runtime"), true);
  await driver.cleanup(context);
  assert.equal(gatewayClient.profiles.has("oce-openclaw-runtime"), false);
}

export async function verifyConfirmedSandboxCleanup(): Promise<void> {
  const gatewayClient = workspaceGatewayClient();
  const driver = openShellDriver(gatewayClient);
  const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
  const revision = completeSandboxRevision(fixtureRevision);
  const { name: workspace, id: namespaceId } = context.namespace;
  gatewayClient.workspaces.set(workspace, ownedWorkspace(workspace, namespaceId));
  let present: OpenShellSandboxResponse | undefined = sandboxRecord("sb-live", workspace);
  const reads: string[] = [];
  const deletions: string[] = [];
  const workspaceReads: string[] = [];
  gatewayClient.getSandbox = async (request) => {
    reads.push(request.name);
    return present;
  };
  gatewayClient.deleteSandbox = async (request) => {
    deletions.push(request.name);
  };
  const getWorkspace = gatewayClient.getWorkspace;
  gatewayClient.getWorkspace = async (name) => {
    workspaceReads.push(name);
    return getWorkspace(name);
  };
  const cleanup = () => driver.cleanup({ ...context, revision });
  // grpc-js ServiceError shape, as unary() passes PERMISSION_DENIED (7) and UNAUTHENTICATED (16).
  const refusal = (code: number, details: string) =>
    Object.assign(new Error(`${code} refused: ${details}`), { code, details });
  // UNAUTHENTICATED is transient (the worker retries it within its budget), PERMISSION_DENIED
  // is not (finding 1694); both carry the code.
  const unauthorized = (operation: () => Promise<void>, transient = false) =>
    assert.rejects(operation(), (error) => {
      assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
      assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
      assert.equal(error.transient, transient);
      assert.match(error.message, /cannot be confirmed removed/);
      return true;
    });

  // A present Sandbox is deleted by its revision-derived name; no Workspace read is needed.
  await cleanup();
  assert.equal(reads.length, 1);
  const [sandboxName] = reads;
  assert.ok(sandboxName);
  assert.match(sandboxName, /^sb-[a-f0-9]{16}$/u);
  assert.deepEqual(deletions, reads);
  assert.deepEqual(workspaceReads, []);
  // An absent one is gone once the Workspace read passes and a second read still finds none,
  // with no DeleteSandbox.
  present = undefined;
  await cleanup();
  assert.deepEqual(workspaceReads, [workspace]);
  assert.equal(reads.length, 3);
  assert.deepEqual(deletions, reads.slice(0, 1));
  // Finding 1692: GetWorkspace proves the role now, not at the first read, so a role restored
  // between them would confirm a live Sandbox gone. A Sandbox the second read finds is deleted
  // instead; a refusal on that read is the same lost identity, and nothing is recorded.
  const answers = (...values: (OpenShellSandboxResponse | Error | undefined)[]) => {
    const queue = [...values];
    gatewayClient.getSandbox = async (request) => {
      reads.push(request.name);
      const answer = queue.length === 0 ? present : queue.shift();
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    };
  };
  answers(undefined, sandboxRecord("sb-live", workspace));
  await cleanup();
  assert.deepEqual(workspaceReads, [workspace, workspace]);
  assert.equal(reads.length, 5);
  assert.deepEqual(deletions, [sandboxName, sandboxName]);
  answers(undefined, refusal(7, "sandbox"));
  await unauthorized(cleanup);
  assert.deepEqual(deletions, [sandboxName, sandboxName]);
  answers();
  // The identity is refused on the Workspace read: the Sandbox may be live and hidden.
  for (const code of [7, 16]) {
    gatewayClient.getWorkspace = async () => {
      throw refusal(code, "workspace");
    };
    await unauthorized(cleanup, code === 16);
  }
  // The identity is refused on the Sandbox read itself (an expired token fails every call).
  gatewayClient.getWorkspace = getWorkspace;
  gatewayClient.getSandbox = async () => {
    throw refusal(16, "token expired");
  };
  await unauthorized(cleanup, true);
  assert.deepEqual(workspaceReads, [workspace, workspace, workspace]);
  // OpenShell reports no Workspace: nothing proves the Sandbox gone, so cleanup fails closed.
  gatewayClient.getSandbox = async () => undefined;
  gatewayClient.getWorkspace = async () => undefined;
  await assert.rejects(cleanup(), /reports no Workspace .* cannot be confirmed removed/);
  // A gateway that does not answer keeps its class, so the worker retries the idempotent stop.
  const unanswered = new DependencyUnavailableError(
    "OpenShell GetWorkspace failed with gRPC status 14.",
  );
  gatewayClient.getWorkspace = async () => {
    throw unanswered;
  };
  await assert.rejects(cleanup(), (error) => error === unanswered);
  gatewayClient.getWorkspace = getWorkspace;
  // A Sandbox that is present but refused on the delete: the same code, nothing recorded.
  gatewayClient.getSandbox = async () => sandboxRecord("sb-live", workspace);
  gatewayClient.deleteSandbox = async () => {
    throw refusal(7, "sandbox:delete");
  };
  await unauthorized(cleanup);
  // A Sandbox removed between the read and the delete answers NOT_FOUND, which the client
  // reports unconfirmed; that failure keeps its class, and the next pass's read confirms it.
  const unconfirmed = new Error(
    "OpenShell DeleteSandbox did not find the Sandbox, so the deletion is unconfirmed.",
  );
  gatewayClient.deleteSandbox = async () => {
    throw unconfirmed;
  };
  await assert.rejects(cleanup(), (error) => error === unconfirmed);
  assert.deepEqual(deletions, [sandboxName, sandboxName]);
  // The runtime provider is removed only after the Sandbox's state is confirmed.
  assert.equal(
    gatewayClient.calls.some(([method]) => method === "deleteProvider"),
    false,
  );

  // The same refusal on CreateSandbox: OpenShell keeps PERMISSION_DENIED there, so a Sandbox
  // hidden from the identity is neither adopted nor created over, and the deployment fails with
  // the code instead of spending its attempts on a generic failure.
  gatewayClient.getSandbox = async () => undefined;
  gatewayClient.createSandbox = async () => {
    throw refusal(7, "sandbox:create");
  };
  await assert.rejects(driver.provisionHarness({ ...context, revision, requirements }), (error) => {
    assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
    assert.equal(error.transient, false);
    assert.match(error.message, /cannot be created or adopted/);
    return true;
  });
}

export async function verifyNativeHeldFailureExposure(): Promise<void> {
  let sandboxResponse: OpenShellSandboxResponse | undefined;
  let createdServiceUrl = "http://native.example.test:9443/";
  let exposedService: OpenShellServiceResponse | undefined;
  const { requests, gatewayClient, service, driver, context, revision, exposing } =
    await prepareNativeHeldFailure({
      openShellDriver,
      runtimeSandboxFixture,
      getStoredSandbox: () => sandboxResponse,
      setStoredSandbox: (value) => {
        sandboxResponse = value;
      },
      getCreatedServiceUrl: () => createdServiceUrl,
      getExposedService: () => exposedService,
    });

  const { verifyNativeExposureCredentialBoundary } =
    await import("./sandbox-driver-native-held-failure-cases.ts");
  await verifyNativeExposureCredentialBoundary({
    driver,
    context,
    revision,
    exposing,
    requests,
    unsupportedError: SandboxRevisionUnsupportedError,
  });

  const exposed = exposing([
    { name: "APP_SERVER_PORT", value: "18790" },
    { name: "APP_TOKEN_SHA", value: "b".repeat(64) },
  ]);
  // The created exposure's URL is validated on the create pass, as for Codex.
  createdServiceUrl = "ftp://native.example.test/";
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements: exposed }),
    /Harness service URL must be an HTTP origin/,
  );
  requests.length = 0;
  sandboxResponse = undefined;
  createdServiceUrl = "http://native.example.test:9443/";
  const sandbox = await driver.provisionHarness({ ...context, revision, requirements: exposed });
  assert.equal(sandbox.revisionId, revision.id);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  const environment = record(request.spec.environment);
  // The worker's transport port, not Codex's app-server port.
  assert.deepEqual(request.serviceExposures, [
    { service: "", targetPort: 18790, authorizationMode: "bearer_passthrough" },
  ]);
  assert.equal(environment.APP_SERVER_PORT, "18790");
  assert.equal(environment.APP_TOKEN_SHA, "b".repeat(64));
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  // Adoption needs the exact exposure: a lost or mismatched service fails closed,
  // like Codex, since the spec match proves the Sandbox was created with it.
  await verifyNativeHeldFailureWithdrawal({
    requests,
    gatewayClient,
    service,
    driver,
    context,
    revision,
    exposing,
    exposed,
    getExposedService: () => exposedService,
    setExposedService: (value) => {
      exposedService = value;
    },
    resetStoredSandbox: () => {
      sandboxResponse = undefined;
    },
  });
}

export async function verifyExistingSandboxAdoption(): Promise<void> {
  // The gateway's request_id replay refuses a changed spec and forgets a create after
  // 24 h, so a reconcile pass must find the existing Sandbox rather than create again.
  const gatewayClient = workspaceGatewayClient();
  const sandboxes = new Map<string, OpenShellSandboxResponse>();
  const services = new Map<string, string>();
  const calls: (
    | ["getSandbox", name: string, workspace: string]
    | ["getService", sandbox: string, workspace: string, service: string]
    | ["createSandbox", name: string, requestId: string]
  )[] = [];
  let createError: OpenShellSandboxAlreadyExistsError | undefined;
  gatewayClient.getSandbox = async ({ name, workspace }) => {
    calls.push(["getSandbox", name, workspace]);
    return sandboxes.get(name);
  };
  gatewayClient.getService = async (workspace, sandbox, service) => {
    calls.push(["getService", sandbox, workspace, service]);
    return harnessService(sandbox, service, services.get(sandbox));
  };
  gatewayClient.createSandbox = async (request) => {
    calls.push(["createSandbox", request.name, request.requestId]);
    // The gateway adds its own internal annotation, which adoption must not read as foreign.
    const annotations = {
      ...request.annotations,
      "internal.openshell.ai/runtime-identity": "opaque",
    };
    const sandbox = storedSandbox(request, { annotations });
    sandboxes.set(request.name, sandbox);
    const serviceUrl = sandbox.serviceUrls[""];
    assert.ok(serviceUrl);
    services.set(request.name, serviceUrl);
    if (createError !== undefined) {
      throw createError;
    }
    return sandbox;
  };
  const context = namespaceContext();
  const base = buildSandboxInstallation().drivers.sandbox.configuration;
  const selectedAgent = "agt_00000000-0000-4000-8000-000000000003";
  const otherNamespace = {
    namespaceId: "ns_00000000-0000-4000-8000-000000000002",
    agentId: selectedAgent,
    requests: { cpu: "4" },
    limits: { cpu: "4" },
  };
  const selected = {
    namespaceId: context.namespace.id,
    agentId: selectedAgent,
    requests: { cpu: "88", memory: "344Gi" },
    limits: { cpu: "90", memory: "352Gi" },
  };
  const options: OpenShellSandboxDriverOptions = {
    ...base,
    kubernetes: {
      ...base.kubernetes,
      agentResources: {
        requests: { cpu: "1", memory: "1Gi", "example.com/gpu": "1" },
        limits: { cpu: "2", memory: "2Gi", "example.com/gpu": "1" },
      },
      agentResourceOverrides: [otherNamespace, selected],
    },
  };
  const driver = openShellDriver(gatewayClient, options);
  const revision = dedicatedRevision(driver, context, "000000000003");
  const provision = (
    environment: readonly SandboxEnvironmentVariable[] = [],
    target = revision,
    owner = driver,
  ) =>
    owner.provisionHarness({
      ...context,
      revision: completeSandboxRevision(target),
      requirements: codexRequirements(target, environment),
    });

  const first = await provision();
  const name = first.resourceName;
  assert.deepEqual(
    calls.map(([call]) => call),
    ["getSandbox", "createSandbox"],
  );
  const templateFor = (sandbox: string) => record(sandboxes.get(sandbox)?.spec?.template);
  const resources = (template: Record<string, unknown>, section: "requests" | "limits") => {
    const driverConfig = record(record(template.driver_config).fields);
    const containers = structFields(structFields(driverConfig.kubernetes).containers);
    const agentResources = structFields(structFields(containers.agent).resources);
    return Object.fromEntries(
      Object.entries(structFields(agentResources[section])).map(([resource, entry]) => {
        const value = record(entry).stringValue;
        assert.ok(typeof value === "string", resource);
        return [resource, value];
      }),
    );
  };
  const saved = templateFor(name);
  assert.deepEqual(resources(saved, "requests"), {
    cpu: "88",
    memory: "344Gi",
    "example.com/gpu": "1",
    "ephemeral-storage": "256Mi",
  });
  assert.deepEqual(resources(saved, "limits"), {
    cpu: "90",
    memory: "352Gi",
    "example.com/gpu": "1",
    "ephemeral-storage": "1Gi",
  });
  const other = await provision([], dedicatedRevision(driver, context, "000000000004"));
  const otherTemplate = templateFor(other.resourceName);
  assert.equal(otherTemplate.runtime_class_name, "openshell-sandbox");
  assert.deepEqual(resources(otherTemplate, "requests"), {
    cpu: "1",
    memory: "1Gi",
    "example.com/gpu": "1",
    "ephemeral-storage": "256Mi",
  });
  assert.deepEqual(resources(otherTemplate, "limits"), {
    cpu: "2",
    memory: "2Gi",
    "example.com/gpu": "1",
    "ephemeral-storage": "1Gi",
  });
  // Restarting the controller with different sizing cannot adopt the stale Sandbox.
  const changedOptions: OpenShellSandboxDriverOptions = {
    ...options,
    kubernetes: {
      ...options.kubernetes,
      agentResourceOverrides: [
        otherNamespace,
        { ...selected, limits: { ...selected.limits, cpu: "89" } },
      ],
    },
  };
  const changed = openShellDriver(gatewayClient, changedOptions);
  calls.length = 0;
  await assert.rejects(
    provision([], revision, changed),
    /without exact AgentRevision ownership and content/,
  );
  assert.deepEqual(calls, [["getSandbox", name, context.namespace.name]]);

  // A later pass with a different spec rejects the stale Sandbox and never creates.
  calls.length = 0;
  await assert.rejects(
    provision([{ name: "CUSTOM_SETTING", value: "changed" }]),
    /without exact AgentRevision ownership and content/,
  );
  assert.deepEqual(calls, [["getSandbox", name, context.namespace.name]]);

  // ALREADY_EXISTS (a create that outlived its 24 h replay record) adopts this revision's Sandbox.
  sandboxes.clear();
  services.clear();
  createError = new OpenShellSandboxAlreadyExistsError(name);
  calls.length = 0;
  assert.deepEqual(await provision(), first);
  assert.deepEqual(
    calls.map(([call]) => call),
    ["getSandbox", "createSandbox", "getSandbox", "getService"],
  );
  createError = undefined;

  // The real client decodes with `oneofs: true`, which adds a virtual `_field` marker for each
  // set proto3 optional field. A gateway that reports one must still be adopted.
  const decoded = sandboxes.get(name);
  assert.ok(decoded);
  const spec = record(decoded.spec);
  sandboxes.set(name, {
    ...decoded,
    spec: {
      ...spec,
      template: { ...record(spec.template), _user_namespaces: "user_namespaces" },
    },
  });
  assert.deepEqual(await provision(), first);
  sandboxes.set(name, decoded);

  // Another revision's Sandbox, or one without its Harness service, is never adopted.
  await verifySandboxAdoptionRefusals({ sandboxes, services, name, revision, provision });
}

export async function verifySandboxRequestReplay(): Promise<void> {
  // OpenShell admits a request_id before running CreateSandbox and leaves it unresolved
  // forever if the handler errors, so reusing the revision UUID would never provision.
  const fixture = await prepareGatewayReplayFixture({
    openShellDriver,
    prepareProvision: (driver) => {
      const context = namespaceContext();
      const revision = completeSandboxRevision(dedicatedRevision(driver, context, "000000000004"));
      return (target = driver) =>
        target.provisionHarness({
          ...context,
          revision,
          requirements: codexRequirements(revision),
        });
    },
    harnessService,
    storedSandbox,
  });

  const { gatewayClient, sandboxes, provision, trace, id0, replayState } = fixture;
  const { first, id1, id2 } = await verifyFreshRequestAfterRefusal(fixture);

  // A restarted controller derives the same request_ids; a deleted Sandbox whose create
  // succeeded (REQUEST_REPLAY_UNAVAILABLE) is replaced under the next one.
  const restarted = openShellDriver(gatewayClient);
  assert.deepEqual(await provision(restarted), first);
  const recreated = trace();
  const nextCreate = recreated[7];
  assert.ok(nextCreate);
  assert.match(nextCreate, /^createSandbox:/u);
  assert.deepEqual(recreated, [
    "getSandbox",
    `createSandbox:${id0}`,
    "getSandbox",
    `createSandbox:${id1}`,
    "getSandbox",
    `createSandbox:${id2}`,
    "getSandbox",
    nextCreate,
  ]);
  assert.equal(sandboxes.size, 1);
  assert.equal(new Set(recreated.filter((call) => call.startsWith("createSandbox"))).size, 4);

  // The live Sandbox is adopted without any create.
  assert.deepEqual(await provision(), first);
  assert.deepEqual(trace(), ["getSandbox", "getService"]);

  // A refused request_id whose earlier call creates the Sandbox meanwhile is adopted;
  // no further request_id is tried.
  sandboxes.clear();
  replayState.onRefusal = (request) => {
    sandboxes.set(request.name, storedSandbox(request, { id: "sandbox-late" }));
  };
  assert.deepEqual(await provision(), first);
  assert.deepEqual(trace(), ["getSandbox", `createSandbox:${id0}`, "getSandbox", "getService"]);

  // Two concurrent passes: the later one is refused the held request_id, advances, and
  // creates; the held create then loses the name and adopts the same Sandbox.
  await verifyConcurrentReplayAndExhaustion({ sandboxes, provision, trace, first, replayState });
}
