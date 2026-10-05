import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import pg from "pg";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  OpenShellRequestReplayRefusedError,
  OpenShellSandboxAlreadyExistsError,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  SandboxRevisionUnsupportedError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { KubernetesObjectApi } = controllerRequire("@kubernetes/client-node");

function sandboxInstallation() {
  const configuration = installation();
  configuration.backend = [
    {
      id: "openshell",
      type: "openshell",
      configuration: {
        serviceName: "openshell-gateway",
        port: 50051,
        insecureTransport: "network-policy",
      },
      drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
    },
  ];
  configuration.drivers.credential_gateway = {
    id: "openshell-credentials",
    configuration: { binaries: ["/app/bin/model-client"] },
  };
  configuration.drivers.sandbox = {
    id: "openshell-sandbox",
    configuration: {
      gateway: {
        workspaceMode: "operator",
      },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
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
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
          },
        ],
      },
    },
  };
  return configuration;
}

function backendFor(gatewayClient) {
  return {
    id: "openshell",
    drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
    client: new OpenShellGateway({ serviceName: "openshell-gateway" }, { gatewayClient }),
  };
}

function workspaceGatewayClient(seed = [], events = []) {
  const workspaces = new Map(seed.map((workspace) => [workspace.name, structuredClone(workspace)]));
  const calls = [];
  return {
    calls,
    workspaces,
    async health() {
      calls.push(["health"]);
      events.push(["gateway", "health"]);
    },
    async getWorkspace(name) {
      calls.push(["getWorkspace", name]);
      events.push(["gateway", "getWorkspace", name]);
      return workspaces.get(name);
    },
    async createWorkspace(name, labels) {
      calls.push(["createWorkspace", name, structuredClone(labels)]);
      events.push(["gateway", "createWorkspace", name]);
      const workspace = { name, labels: structuredClone(labels), phase: "WORKSPACE_PHASE_ACTIVE" };
      workspaces.set(name, workspace);
      return workspace;
    },
    async deleteWorkspace(name) {
      calls.push(["deleteWorkspace", name]);
      events.push(["gateway", "deleteWorkspace", name]);
      workspaces.delete(name);
    },
    async getSandbox() {
      return undefined;
    },
    async getServiceUrl() {
      return undefined;
    },
    async createSandbox() {
      throw new Error("Sandbox creation is outside this Namespace lifecycle scenario.");
    },
    async deleteSandbox() {},
    close() {},
  };
}

function kubernetesObjectClient(events) {
  const client = Object.create(KubernetesObjectApi.prototype);
  client.patch = async (resource) => {
    events.push([
      "kubernetes",
      "patch",
      resource.kind,
      resource.metadata.name,
      resource.metadata.namespace,
    ]);
    return resource;
  };
  client.delete = async (resource) => {
    events.push([
      "kubernetes",
      "delete",
      resource.kind,
      resource.metadata.name,
      resource.metadata.namespace,
    ]);
  };
  return client;
}

function namespaceContext(name = "oce-123456789012345") {
  return {
    namespace: {
      id: "ns_00000000-0000-4000-8000-000000000001",
      name,
      status: "ready",
      createdAt: "2026-09-23T00:00:00.000Z",
    },
    kubernetes: {},
    signal: new AbortController().signal,
  };
}

function codexRequirements(revision, environment = []) {
  return {
    loginMode: "api_key",
    image: "codex-runtime@sha256:synthetic",
    command: ["codex"],
    serviceAccountName: "agent-codex",
    serviceAccountToken: {
      audience: "openclaw-enterprise",
      expirationSeconds: 900,
      mountPath: "/var/run/secrets/openclaw-enterprise",
      path: "token",
      readOnly: true,
    },
    workspaceMounts: [
      {
        claimName: "harness-workspace-codex",
        subPath: "workspace",
        mountPath: "/home/node/workspace",
        readOnly: false,
      },
    ],
    credentialAttachments: [],
    environment: [{ name: "APP_SERVER_PORT", value: "8080" }, ...environment],
    labels: { "openclaw.dev/revision": revision.id },
  };
}

test("startup constructs the bundled OpenShell SandboxDriver before constructing Kubernetes Compute", async (t) => {
  const createdDriver = await loadInstallationFile(t, sandboxInstallation());

  assert.equal(createdDriver.installation.drivers.sandbox.id, "openshell-sandbox");
  assert.equal(createdDriver.installation.drivers.sandbox.implementation, "openshell");
  assert.ok(createdDriver.sandboxDriver instanceof OpenShellSandboxDriver);
  assert.equal(createdDriver.sandboxDriver.id, "openshell-sandbox");
  assert.deepEqual(createdDriver.sandboxDriver.facets, ["networking", "filesystem", "process"]);

  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({
      pool,
      mode: "production",
      drivers: createdDriver,
      emit: () => {},
    }),
  );
});

test("startup composes both OpenShell members from one Backend", async (t) => {
  // An explicit hard_requirement composes like the omitted default above.
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.landlockCompatibility = "hard_requirement";
  const createdDriver = await loadInstallationFile(t, configuration);

  assert.ok(createdDriver.credentialGatewayDriver instanceof OpenShellCredentialGatewayDriver);
  assert.equal(createdDriver.credentialGatewayDriver.id, "openshell-credentials");
  assert.equal(createdDriver.installation.drivers.credential_gateway.implementation, "openshell");
  assert.deepEqual(createdDriver.installation.backend[0].drivers, {
    sandbox: createdDriver.sandboxDriver.id,
    credential_gateway: createdDriver.credentialGatewayDriver.id,
  });
});

test("startup rejects an OpenShell Backend whose members are not both selected", async (t) => {
  const missingGateway = sandboxInstallation();
  delete missingGateway.drivers.credential_gateway;
  await assert.rejects(
    loadInstallationFile(t, missingGateway),
    /drivers\.credential_gateway must match the selected drivers\.credential_gateway\.id/,
  );

  const foreignSandbox = sandboxInstallation();
  foreignSandbox.backend[0].drivers.sandbox = "another-sandbox";
  await assert.rejects(
    loadInstallationFile(t, foreignSandbox),
    /drivers\.sandbox must match the selected bundled OpenShell drivers\.sandbox\.id/,
  );

  // Connection settings belong to the Backend; the Sandbox rejects them instead of ignoring them.
  const legacyEndpoint = sandboxInstallation();
  legacyEndpoint.drivers.sandbox.configuration.gateway.endpoint = "http://127.0.0.1:1";
  await assert.rejects(
    loadInstallationFile(t, legacyEndpoint),
    /OpenShell gateway option endpoint belongs to the openshell Backend/,
  );
});

test("startup requires protected OpenShell transport or an explicit NetworkPolicy boundary", async (t) => {
  const load = (configuration) => loadInstallationFile(t, configuration);
  // Credential registration sends resolved values, so plain or unauthenticated transport
  // must be declared rather than accepted by default.
  const undeclared = sandboxInstallation();
  delete undeclared.backend[0].configuration.insecureTransport;
  await assert.rejects(
    load(undeclared),
    /requires TLS with bearerTokenFile authentication, or insecureTransport: network-policy/,
  );
  // TLS alone is not enough; the gateway must also authenticate OCC.
  const tlsOnly = sandboxInstallation();
  tlsOnly.backend[0].configuration = { endpoint: "https://openshell-gateway.openshell.svc:8080" };
  await assert.rejects(load(tlsOnly), /requires TLS with bearerTokenFile authentication/);

  const protectedTransport = sandboxInstallation();
  protectedTransport.backend[0].configuration = {
    endpoint: "https://openshell-gateway.openshell.svc:8080",
    auth: { mode: "bearerTokenFile", path: "/etc/openclaw/openshell/token" },
  };
  await load(protectedTransport);
  // The declaration is only for unprotected transport, so it cannot mask a protected setup.
  protectedTransport.backend[0].configuration.insecureTransport = "network-policy";
  await assert.rejects(load(protectedTransport), /insecureTransport is only for unprotected/);

  // Every gateway call's deadline stays within the registration fence.
  const slow = sandboxInstallation();
  slow.backend[0].configuration.requestTimeoutMs = 60_000;
  await assert.rejects(load(slow), /requestTimeoutMs must be between 1000 and 30000 ms/);
});

test("OpenShell configures only the selected dedicated Harness runtime", () => {
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(workspaceGatewayClient()),
  });
  const configuration = {
    agents: { defaults: { model: "openai/gpt-5" } },
  };
  assert.deepEqual(
    driver.configureAgent(configuration, {
      id: "openclaw",
      version: "1.0.0",
      mode: "dedicated",
    }),
    configuration,
  );

  const codex = driver.configureAgent(configuration, {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  });
  assert.equal(codex.plugins.entries.codex.config.appServer.sandbox, "danger-full-access");
  assert.throws(
    () =>
      driver.configureAgent(configuration, {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
      }),
    /supports only dedicated Harness revisions/,
  );
});

test("OpenShell provisions native OpenClaw without exposing an inbound Harness service", async () => {
  const requests = [];
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    requests.push(request);
    return {
      name: request.name,
      labels: request.labels,
      serviceUrls: {},
    };
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  const revisionId = "rev_00000000-0000-4000-8000-000000000001";
  const revision = {
    id: revisionId,
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const labels = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "agent",
  };
  const command = ["/usr/bin/tini", "-s", "--", "node", "-e", "worker-entrypoint"];
  const sandbox = await driver.provisionHarness({
    ...context,
    revision,
    requirements: {
      loginMode: "api_key",
      image: "openclaw-runtime@sha256:synthetic",
      command,
      serviceAccountName: "agent-native-openclaw",
      serviceAccountToken: {
        audience: "openclaw-enterprise",
        expirationSeconds: 900,
        mountPath: "/var/run/secrets/openclaw-enterprise",
        path: "token",
        readOnly: true,
      },
      workspaceMounts: [
        {
          claimName: "harness-workspace-native-openclaw",
          subPath: "workspace",
          mountPath: "/home/node/workspace",
          readOnly: false,
        },
        {
          claimName: "harness-workspace-native-openclaw",
          subPath: "workspace-node-native-openclaw",
          mountPath: "/home/node/.openclaw-node",
          readOnly: false,
        },
      ],
      credentialAttachments: [],
      environment: [{ name: "TMPDIR", value: "/tmp/openclaw-native-worker" }],
      labels,
    },
  });

  assert.equal(sandbox.revisionId, revisionId);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].serviceExposures, []);
  assert.deepEqual(requests[0].spec.command, command);
  assert.deepEqual(requests[0].labels, labels);
  // The real Gateway receives this mode with the Sandbox request; a weaker
  // Landlock setting could let a ready Harness run without filesystem policy.
  assert.equal(requests[0].spec.policy.landlock.compatibility, "hard_requirement");
});

test("OpenShell adopts its revision's existing Sandbox instead of re-sending CreateSandbox", async () => {
  // The gateway's request_id replay refuses a changed spec and forgets a create after
  // 24 h, so a reconcile pass must find the existing Sandbox rather than create again.
  const gatewayClient = workspaceGatewayClient();
  const sandboxes = new Map();
  const services = new Map();
  const calls = [];
  let createError;
  gatewayClient.getSandbox = async ({ name, workspace }) => {
    calls.push(["getSandbox", name, workspace]);
    return sandboxes.get(name);
  };
  gatewayClient.getServiceUrl = async ({ sandbox, workspace, service }) => {
    calls.push(["getServiceUrl", sandbox, workspace, service]);
    return services.get(sandbox);
  };
  gatewayClient.createSandbox = async (request) => {
    calls.push(["createSandbox", request.name, request.requestId]);
    const sandbox = {
      name: request.name,
      labels: request.labels,
      annotations: { ...request.annotations, "openshell.io/runtime-identity": "opaque" },
      serviceUrls: { "": `http://${request.workspace}--${request.name}.openshell.test/` },
    };
    sandboxes.set(request.name, sandbox);
    services.set(request.name, sandbox.serviceUrls[""]);
    if (createError !== undefined) {
      throw createError;
    }
    return sandbox;
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000003",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000003",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const provision = (environment = [], target = revision) =>
    driver.provisionHarness({
      ...context,
      revision: target,
      requirements: codexRequirements(revision, environment),
    });

  const first = await provision();
  const name = first.resourceName;
  assert.deepEqual(
    calls.map(([call]) => call),
    ["getSandbox", "createSandbox"],
  );
  // A later pass with a different spec reads the Sandbox and its service; it never creates.
  calls.length = 0;
  const second = await provision([{ name: "TMPDIR", value: "/tmp/changed" }]);
  assert.deepEqual(second, first);
  assert.deepEqual(calls, [
    ["getSandbox", name, calls[0][2]],
    ["getServiceUrl", name, calls[0][2], ""],
  ]);

  // ALREADY_EXISTS (a create that outlived its 24 h replay record) adopts this revision's Sandbox.
  sandboxes.clear();
  services.clear();
  createError = new OpenShellSandboxAlreadyExistsError(name);
  calls.length = 0;
  assert.deepEqual(await provision(), first);
  assert.deepEqual(
    calls.map(([call]) => call),
    ["getSandbox", "createSandbox", "getSandbox", "getServiceUrl"],
  );
  createError = undefined;

  // Another revision's Sandbox, or one without its Harness service, is never adopted.
  sandboxes.set(name, {
    ...sandboxes.get(name),
    annotations: { ...sandboxes.get(name).annotations, "openclaw.dev/revision-id": "rev_other" },
  });
  await assert.rejects(provision(), /belongs to another revision; remove the stale Sandbox/);
  sandboxes.set(name, {
    ...sandboxes.get(name),
    annotations: { ...sandboxes.get(name).annotations, "openclaw.dev/revision-id": revision.id },
  });
  // A Sandbox on its way out is never adopted as this revision's Harness.
  for (const [phase, message] of [
    ["SANDBOX_PHASE_DELETING", /is being deleted; it can be created again once deletion finishes/],
    ["SANDBOX_PHASE_STOPPED", /has stopped; remove the stale Sandbox/],
    ["SANDBOX_PHASE_COMPLETED", /has stopped; remove the stale Sandbox/],
  ]) {
    sandboxes.set(name, { ...sandboxes.get(name), phase });
    await assert.rejects(provision(), message);
  }
  sandboxes.set(name, { ...sandboxes.get(name), phase: "SANDBOX_PHASE_READY" });
  services.delete(name);
  await assert.rejects(provision(), /exists without its Harness service; remove the stale Sandbox/);
});

test("OpenShell moves a revision's create to a fresh request_id after the gateway refuses the old one", async () => {
  // OpenShell admits a request_id before running CreateSandbox and leaves it unresolved
  // forever if the handler errors, so reusing the revision UUID would never provision.
  const gatewayClient = workspaceGatewayClient();
  const sandboxes = new Map();
  const admissions = new Map();
  const calls = [];
  let handlerError;
  let refuseEverything;
  let onRefusal;
  let holdHandler;
  let nextId = 0;
  const refused = (reason) => new OpenShellRequestReplayRefusedError(reason, reason);
  gatewayClient.getSandbox = async ({ name }) => {
    calls.push(["getSandbox"]);
    return sandboxes.get(name);
  };
  gatewayClient.getServiceUrl = async ({ sandbox }) => {
    calls.push(["getServiceUrl"]);
    return sandboxes.get(sandbox)?.serviceUrls[""];
  };
  gatewayClient.createSandbox = async (request) => {
    calls.push(["createSandbox", request.requestId]);
    const payload = JSON.stringify({ ...request, requestId: undefined });
    const admitted = admissions.get(request.requestId);
    let refusal;
    if (refuseEverything !== undefined) {
      refusal = refused(refuseEverything);
    } else if (admitted !== undefined) {
      if (admitted.payload !== payload) {
        refusal = refused("REQUEST_ID_PAYLOAD_MISMATCH");
      } else if (admitted.sandboxId === undefined) {
        refusal = refused("REQUEST_OUTCOME_UNCERTAIN");
      } else if (sandboxes.get(request.name)?.id !== admitted.sandboxId) {
        refusal = refused("REQUEST_REPLAY_UNAVAILABLE");
      } else {
        return sandboxes.get(request.name);
      }
    }
    if (refusal !== undefined) {
      onRefusal?.(request);
      onRefusal = undefined;
      throw refusal;
    }
    admissions.set(request.requestId, { payload });
    if (handlerError !== undefined) {
      const error = handlerError;
      handlerError = undefined;
      throw error;
    }
    if (holdHandler !== undefined) {
      const held = holdHandler;
      holdHandler = undefined;
      await held;
    }
    // OpenShell keeps Sandbox names unique per Workspace.
    if (sandboxes.has(request.name)) {
      throw new OpenShellSandboxAlreadyExistsError(request.name);
    }
    const sandbox = {
      id: `sandbox-${nextId++}`,
      name: request.name,
      labels: request.labels,
      annotations: request.annotations,
      serviceUrls: { "": `http://${request.workspace}--${request.name}.openshell.test/` },
    };
    sandboxes.set(request.name, sandbox);
    admissions.get(request.requestId).sandboxId = sandbox.id;
    return sandbox;
  };
  const driverFor = () =>
    new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: backendFor(gatewayClient),
    });
  const driver = driverFor();
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000004",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000004",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const provision = (target = driver) =>
    target.provisionHarness({
      ...context,
      revision,
      requirements: codexRequirements(revision),
    });
  const trace = () => {
    const seen = calls.map(([call, id]) => (id === undefined ? call : `${call}:${id}`));
    calls.length = 0;
    return seen;
  };
  const id0 = "00000000-0000-4000-8000-000000000004";

  // A create that errors server-side leaves its request_id unresolved.
  handlerError = new Error("provider 'model' not found");
  await assert.rejects(provision(), /provider 'model' not found/);
  assert.deepEqual(trace(), ["getSandbox", `createSandbox:${id0}`]);

  // The next pass sees the refusal and no Sandbox, then creates with the next request_id.
  const first = await provision();
  const [, refusedCreate, , freshCreate] = trace();
  assert.equal(refusedCreate, `createSandbox:${id0}`);
  const id1 = freshCreate.slice("createSandbox:".length);
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id1, id0);
  assert.equal(sandboxes.size, 1);

  // Each failing pass spends at most one new request_id.
  sandboxes.clear();
  handlerError = new Error("compute driver unavailable");
  await assert.rejects(provision(), /compute driver unavailable/);
  const failed = trace();
  assert.deepEqual(failed.slice(0, 4), [
    "getSandbox",
    `createSandbox:${id0}`,
    "getSandbox",
    `createSandbox:${id1}`,
  ]);
  assert.equal(failed.length, 6);
  const id2 = failed[5].slice("createSandbox:".length);

  // A restarted controller derives the same request_ids; a deleted Sandbox whose create
  // succeeded (REQUEST_REPLAY_UNAVAILABLE) is replaced under the next one.
  const restarted = driverFor();
  assert.deepEqual(await provision(restarted), first);
  const recreated = trace();
  assert.deepEqual(recreated, [
    "getSandbox",
    `createSandbox:${id0}`,
    "getSandbox",
    `createSandbox:${id1}`,
    "getSandbox",
    `createSandbox:${id2}`,
    "getSandbox",
    recreated[7],
  ]);
  assert.equal(sandboxes.size, 1);
  assert.equal(new Set(recreated.filter((call) => call.startsWith("createSandbox"))).size, 4);

  // The live Sandbox is adopted without any create.
  assert.deepEqual(await provision(), first);
  assert.deepEqual(trace(), ["getSandbox", "getServiceUrl"]);

  // A refused request_id whose earlier call creates the Sandbox meanwhile is adopted;
  // no further request_id is tried.
  sandboxes.clear();
  onRefusal = (request) => {
    sandboxes.set(request.name, {
      id: "sandbox-late",
      name: request.name,
      labels: request.labels,
      annotations: request.annotations,
      serviceUrls: { "": `http://${request.workspace}--${request.name}.openshell.test/` },
    });
  };
  assert.deepEqual(await provision(), first);
  assert.deepEqual(trace(), ["getSandbox", `createSandbox:${id0}`, "getSandbox", "getServiceUrl"]);

  // Two concurrent passes: the later one is refused the held request_id, advances, and
  // creates; the held create then loses the name and adopts the same Sandbox.
  sandboxes.clear();
  let release;
  holdHandler = new Promise((resolve) => {
    release = resolve;
  });
  const held = provision();
  for (let turn = 0; holdHandler !== undefined; turn++) {
    if (turn === 1000) {
      assert.fail("the first pass never reached CreateSandbox");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await provision(), first);
  release();
  assert.deepEqual(await held, first);
  assert.equal(sandboxes.size, 1);
  const creates = trace().filter((call) => call.startsWith("createSandbox"));
  // The held pass walks to request_id X; the other walks the same IDs, is refused X, and
  // creates under the next one, Y.
  const walked = (creates.length - 1) / 2;
  assert.deepEqual(creates.slice(walked, -1), creates.slice(0, walked));
  assert.equal(new Set(creates).size, walked + 1);

  // The request_ids are bounded; exhausting them never creates a Sandbox.
  sandboxes.clear();
  refuseEverything = "REQUEST_OUTCOME_UNCERTAIN";
  await assert.rejects(provision(), /refused all 16 create request IDs .*deploy a new revision/);
  const exhausted = trace().filter((call) => call.startsWith("createSandbox"));
  assert.equal(exhausted.length, 16);
  assert.equal(new Set(exhausted).size, 16);
  assert.equal(sandboxes.size, 0);
  // Every ID refused as unreplayable also points at the gateway's key material.
  refuseEverything = "REQUEST_REPLAY_UNAVAILABLE";
  await assert.rejects(provision(), /refused all 16 .*key material is readable/);
  assert.equal(sandboxes.size, 0);
});

test("OpenShell rejects Secret-backed Harness environment as a permanent revision failure", async () => {
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async () => {
    throw new Error("OpenShell must not receive a Sandbox it cannot configure.");
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000002",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000002",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const provision = (harness) =>
    driver.provisionHarness({
      ...context,
      revision: { ...revision, harness },
      requirements: codexRequirements(revision, [
        {
          name: "APP_SERVER_TOKEN",
          valueFrom: { secretKeyRef: { name: "agent-codex-token", key: "token" } },
        },
      ]),
    });

  await assert.rejects(provision(revision.harness), (error) => {
    assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
    assert.equal(error.code, "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED");
    assert.match(error.message, /secretKeyRef environment APP_SERVER_TOKEN/);
    return true;
  });
  await assert.rejects(provision({ id: "codex", version: "1.0.0", mode: "embedded" }), (error) => {
    assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
    assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
    return true;
  });
});

test("OpenShell Namespace lifecycle creates, adopts, and deletes its exact operator Workspace", async () => {
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();

  // A retry must adopt the same owned Workspace instead of creating a second boundary.
  await driver.ensureNamespace(context);
  await driver.ensureNamespace(context);
  assert.deepEqual(gatewayClient.workspaces.get(context.namespace.name), {
    name: context.namespace.name,
    labels: {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace-id": context.namespace.id,
    },
    phase: "WORKSPACE_PHASE_ACTIVE",
  });
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "createWorkspace").length,
    1,
  );

  // A lost delete response can leave an owned Workspace terminating; retry must converge.
  gatewayClient.workspaces.get(context.namespace.name).phase = "WORKSPACE_PHASE_TERMINATING";
  await driver.cleanup(context);
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), false);
  assert.deepEqual(gatewayClient.calls.at(-1), ["deleteWorkspace", context.namespace.name]);
});

test("OpenShell operator mode owns workspace chart resources around the Workspace lifecycle", async () => {
  const events = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "openshell-sandbox" },
    },
  ];
  const gatewayClient = workspaceGatewayClient([], events);
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  // The Gateway must not observe a Workspace until its operator-mode RBAC and
  // ServiceAccount resources have converged in the Compute-owned namespace.
  await driver.ensureNamespace(context);
  assert.deepEqual(events, [
    ["kubernetes", "patch", "ServiceAccount", "openshell-sandbox", context.namespace.name],
    ["gateway", "health"],
    ["gateway", "getWorkspace", context.namespace.name],
    ["gateway", "createWorkspace", context.namespace.name],
  ]);

  events.length = 0;
  await driver.cleanup(context);
  assert.deepEqual(events, [
    ["gateway", "getWorkspace", context.namespace.name],
    ["gateway", "deleteWorkspace", context.namespace.name],
    ["kubernetes", "delete", "ServiceAccount", "openshell-sandbox", context.namespace.name],
  ]);
});

test("OpenShell managed mode fails before mutating Kubernetes or the Gateway", async () => {
  const events = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.workspaceMode = "managed";
  configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "must-not-be-applied" },
    },
  ];
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  await assert.rejects(
    driver.ensureNamespace(context),
    /managed workspace mode is not implemented; cannot ensure a Namespace/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(gatewayClient.calls, []);
});

test("OpenShell Namespace cleanup refuses a same-name foreign Workspace", async () => {
  const context = namespaceContext();
  const gatewayClient = workspaceGatewayClient([
    {
      name: context.namespace.name,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace-id": "ns_foreign",
      },
      phase: "WORKSPACE_PHASE_ACTIVE",
    },
  ]);
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });

  await assert.rejects(driver.cleanup(context), /without exact OCC Namespace ownership/);
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), true);
  assert.equal(
    gatewayClient.calls.some(([operation]) => operation === "deleteWorkspace"),
    false,
  );
});

test("startup rejects invalid bundled OpenShell configuration before invoking an injected factory", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.unsupported = true;
  let invokedFactory = false;
  const options = {
    createSandboxDriver() {
      invokedFactory = true;
      throw new Error("An injected factory must not bypass provider configuration validation.");
    },
  };

  await assert.rejects(
    loadInstallationFile(t, configuration, options),
    /drivers\.sandbox\.configuration does not match its Driver configuration schema/,
  );
  assert.equal(invokedFactory, false);
  // Control: the same factory is reached once the configuration is valid.
  await assert.rejects(loadInstallationFile(t, sandboxInstallation(), options), /injected factory/);
  assert.equal(invokedFactory, true);
});

test("startup rejects OpenShell network values outside the v0.1 protocol enums", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "inspect";

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup refuses OpenShell filesystem modes that can weaken containment", async (t) => {
  for (const mode of ["best_effort", "hard-requirement"]) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.landlockCompatibility = mode;

    await assert.rejects(
      loadInstallationFile(t, configuration),
      /OpenShell policy\.landlockCompatibility must be hard_requirement or omitted/,
    );
  }
});

test("startup rejects OpenShell network policies without binary identities", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].binaries = [];

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell network policy model-egress requires at least one binary path/,
  );
});

test("startup rejects inherited OpenShell network enum property names", async (t) => {
  const cases = [
    ["tls", "toString", /TLS mode must be one of: skip, terminate/],
    ["enforcement", "constructor", /enforcement mode must be one of: enforce, audit/],
    ["access", "__proto__", /access preset must be one of: read_only, read_write, full/],
  ];

  for (const [field, value, expected] of cases) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0][field] =
      value;
    await assert.rejects(loadInstallationFile(t, configuration), expected);
  }
});

test("startup rejects the deprecated OpenShell passthrough spelling", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "passthrough";

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup rejects the removed per-Sandbox OpenShell ServiceAccount mode", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.kubernetes.serviceAccount.mode = "driverConfig";

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell serviceAccount mode must be gatewayConfigured/,
  );
});

test("startup rejects an invalid OpenShell gateway readiness wait", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.gateway.readiness = {
    serviceName: "openshell-gateway",
    podSelector: { "app.kubernetes.io/name": "openshell" },
    timeoutMs: 0,
  };

  await assert.rejects(
    loadInstallationFile(t, configuration),
    /OpenShell gateway readiness timeout must be a positive safe integer/,
  );
});

/**
 * The OpenShell Credential Gateway over a recording provider store. Each provider's labels say
 * which credential source owns it; the gateway may act only on its own source's provider.
 * Kept beside the OpenShell Sandbox cases: both members come from one OpenShell Backend.
 */
function credentialGatewayOverProviders({ keepDeleted = false } = {}) {
  const providers = new Map();
  const calls = [];
  const client = {
    async getProviderProfile() {
      return undefined;
    },
    async importProviderProfile() {},
    async updateProviderProfile() {},
    async deleteProviderProfile() {},
    async createProvider(provider) {
      calls.push(["createProvider", provider.name]);
      if (providers.has(provider.name)) {
        throw new OpenShellProviderAlreadyExistsError(provider.name);
      }
      providers.set(provider.name, { ...provider });
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async listProviders() {
      return [...providers.values()];
    },
    async updateProviderCredentials(_workspace, name, credentials) {
      calls.push(["updateProviderCredentials", name]);
      providers.set(name, { ...providers.get(name), credentials });
    },
    async deleteProvider(_workspace, name) {
      calls.push(["deleteProvider", name]);
      if (!keepDeleted) {
        providers.delete(name);
      }
    },
  };
  const driver = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/codex"] },
    {
      backend: {
        drivers: { credential_gateway: "credential-gateway-openshell" },
        client: { clientForNamespace: () => client },
      },
    },
  );
  const namespace = { id: "ns_00000000-0000-4000-8000-0000000000aa", name: "placed-tenant" };
  const signal = new AbortController().signal;
  const source = (id, namespaceId = namespace.id) => ({
    id,
    namespaceId,
    name: "openai",
    type: "openai",
    config: {},
    secrets: {},
    driverId: driver.id,
    state: "ready",
  });
  return {
    calls,
    driver,
    providers,
    source,
    context: (id) => ({ namespace, source: source(id), signal }),
    revisionContext: (sources) => ({
      namespace,
      revision: { harness: { id: "codex", mode: "dedicated" } },
      sources,
      signal,
    }),
    input: (apiKey = "synthetic-openai-key") => ({
      type: "openai",
      config: {},
      secrets: { api_key: apiKey },
    }),
  };
}

test("the OpenShell Credential Gateway acts only on its own source's provider", async () => {
  const { calls, context, driver, input, providers, revisionContext, source } =
    credentialGatewayOverProviders();
  const owner = "cs_00000000-0000-4000-8000-0000000000b1";
  const other = "cs_00000000-0000-4000-8000-0000000000b2";
  assert.deepEqual(await driver.registerSource(context(owner), input()), { state: "ready" });
  const [stored] = providers.values();
  assert.equal(stored.labels["openclaw.dev/credential-source-id"], owner);
  // Another source's provider stored under this source's name: same manager and type, other id.
  providers.set(stored.name, {
    ...stored,
    labels: { ...stored.labels, "openclaw.dev/credential-source-id": other },
  });
  calls.length = 0;
  await assert.rejects(driver.registerSource(context(owner), input()), ScopeViolationError);
  await assert.rejects(
    driver.updateSource(context(owner), input("replacement")),
    ScopeViolationError,
  );
  assert.equal((await driver.sourceStatus(context(owner))).state, "failed");
  await assert.rejects(driver.removeSource(context(owner)), ScopeViolationError);
  await assert.rejects(
    driver.attachForRevision(revisionContext([source(owner)])),
    /provider for a bound credential source is unavailable/,
  );
  // Only the replayed create reached the store, and it was refused; nothing was overwritten.
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ["createProvider"],
  );
  assert.deepEqual(providers.get(stored.name).credentials, stored.credentials);
});

test("the OpenShell Credential Gateway never attaches a source of another Namespace", async () => {
  const { context, driver, input, revisionContext, source } = credentialGatewayOverProviders();
  const owner = "cs_00000000-0000-4000-8000-0000000000c1";
  await driver.registerSource(context(owner), input());
  // The provider is genuinely owned, so only the Namespace check can refuse.
  const foreign = source(owner, "ns_00000000-0000-4000-8000-0000000000ff");
  await assert.rejects(
    driver.attachForRevision(revisionContext([foreign])),
    (error) =>
      error instanceof ScopeViolationError &&
      error.message === "The credential source is not owned by this gateway.",
  );
  assert.equal((await driver.attachForRevision(revisionContext([source(owner)]))).length, 1);
});

test("the OpenShell Credential Gateway refuses an empty secret before creating a provider", async () => {
  const { calls, context, driver, input, providers } = credentialGatewayOverProviders();
  await assert.rejects(
    driver.registerSource(context("cs_00000000-0000-4000-8000-0000000000d1"), input("")),
    ScopeViolationError,
  );
  assert.deepEqual(calls, []);
  assert.equal(providers.size, 0);
});

test("OpenShell credential source removal fails while the provider survives deletion", async () => {
  const { context, driver, input, providers } = credentialGatewayOverProviders({
    keepDeleted: true,
  });
  const owner = "cs_00000000-0000-4000-8000-0000000000e1";
  await driver.registerSource(context(owner), input());
  await assert.rejects(driver.removeSource(context(owner)), /was not deleted/);
  assert.equal(providers.size, 1);
});
