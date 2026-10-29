import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { createRequire } from "node:module";
import { join } from "node:path";
import { reservePort, reservedPortArgs } from "../helpers/available-port.mjs";
import { waitFor } from "../helpers/qa-utils.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { openAiStaticProvider } from "../../apps/controller/src/drivers/egress-proxy/openai-provider.ts";
import {
  HARNESS_EGRESS_ENROLLMENT_HELPER,
  HARNESS_EGRESS_ENROLLMENT_PATH,
} from "../../apps/controller/src/drivers/compute/harness-egress-enrollment.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
  PROTECTED_CODEX_RUNTIME_ENTRYPOINT,
  PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  nodeProgramArguments,
  withoutLineComments,
} from "../../apps/controller/src/drivers/compute/node-program.ts";
import test from "node:test";
import {
  admitLoggingConfiguration,
  preparedGitHubSourceFromRoute,
} from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  InstalledDriver,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { supervisorPeerLabels } from "../fixtures/kubernetes-provider-readiness.mjs";
import {
  tenant,
  authContext,
  digest,
  selectorMatches,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const providerUrl = "ws://tenant--sandbox.openshell.localhost:8080/";
const providerWorkspaceRoot = "/sandbox/enterprise";
const heldFailure = {
  component: "agent",
  check: "model-probe",
  checkedAt: "2026-10-08T13:00:00.000Z",
  code: "MODEL_PROBE_FAILED",
  cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
};
const { cause: _cause, ...withoutCause } = heldFailure;
const expectedRevision = ({ revision }) => ({
  namespaceId: tenant.id,
  agentId: revision.agentId,
  revisionId: revision.id,
});

// Advance only the prerequisite Gateway. Each scenario gets fresh API and Sandbox state.
async function endpointWithGateway(fixture = providerEndpointFixture(), context) {
  await fixture.prepare(undefined, context);
  fixture.setGatewayServing();
  fixture.setSetupAvailable(true);
  return fixture;
}

async function preparedEndpoint(fixture = providerEndpointFixture(), context) {
  await endpointWithGateway(fixture, context);
  fixture.observePods([fixture.pod("ready")]);
  assert.deepEqual(await fixture.prepare(undefined, context), {
    ...expectedRevision(fixture),
    ready: true,
  });
  return fixture;
}

test("provider Harness endpoint bootstraps Gateway before provisioning and requests node setup", async () => {
  const fixture = providerEndpointFixture();
  const {
    driver,
    revision,
    read,
    gatewayName,
    gatewayNamespace,
    provisions,
    endpoints,
    setupRequests,
  } = fixture;
  const expected = expectedRevision(fixture);
  // The Agent Gateway must be available to mint node setup material. Its first
  // fail-closed template cannot justify creating the provider-owned Harness.
  fixture.observePods([]);
  assert.deepEqual(await fixture.prepare(), {
    ...expected,
    ready: false,
  });
  assert.equal(provisions.length, 0);
  assert.equal(endpoints.length, 0);
  const bootstrapGateway = read("Deployment", gatewayName, gatewayNamespace);
  assert.ok(bootstrapGateway);
  assert.notEqual(
    bootstrapGateway.spec.template.spec.containers[0].env.find(
      ({ name }) => name === "APP_SERVER_URL",
    ).value,
    providerUrl,
  );

  // Once the Gateway is serving, its Agent-owned setup Secret lets Compute
  // render the final provider request and transition to the OpenShell endpoint.
  fixture.setGatewayServing();
  fixture.observePods([]);
  assert.deepEqual(await fixture.prepare(), {
    ...expected,
    ready: false,
  });
  assert.deepEqual(setupRequests, [
    {
      url: driver.getGatewayEndpoint(revision),
      // The node needs the scoped TLS route for HTTP transfers and proxy attribution.
      nodeUrl: `wss://agents.example.internal/namespaces/${revision.namespaceId}/agents/${revision.agentId}/node`,
    },
  ]);
  assert.equal(provisions.length, 1);
  assert.equal(endpoints.length, 1);
});

test("provider Harness endpoint preparation re-observes the same revision across Pod transitions", async (t) => {
  const fixture = await endpointWithGateway();
  const starting = fixture.pod("starting", "False");
  const ready = fixture.pod("ready");
  const stages = [
    { name: "starting Pod is not ready", pods: [starting], ready: false },
    { name: "ambiguous Pods are not ready", pods: [ready, starting], ready: false },
    { name: "unique ready Pod becomes ready", pods: [ready], ready: true },
    { name: "Ready back to Starting clears readiness", pods: [starting], ready: false },
  ];
  // Keep the same Driver and revision: reconciliation must neither cache a false
  // result forever nor retain true after the workload becomes unready again.
  for (const stage of stages) {
    await t.test(stage.name, async () => {
      const provisionsBefore = fixture.provisions.length;
      const endpointsBefore = fixture.endpoints.length;
      const hooksBefore = fixture.hooks.length;
      fixture.observePods(stage.pods);
      assert.deepEqual(await fixture.prepare(), {
        ...expectedRevision(fixture),
        ready: stage.ready,
      });
      assert.deepEqual(fixture.hooks.slice(hooksBefore), ["start"]);
      assert.equal(fixture.provisions.length, provisionsBefore + 1);
      assert.equal(fixture.endpoints.length, endpointsBefore + 1);
    });
  }
});

test("provider Harness endpoint writes transport and runtime requirements", async () => {
  let endpointWorkspaceRoot = providerWorkspaceRoot;
  const providerHome = "/private/provider-home";
  const providerHookDirectory = `${providerHome}/.oce-native-hooks`;
  const fixture = providerEndpointFixture({
    harnessEndpoint: async () => ({ url: providerUrl, workspaceRoot: endpointWorkspaceRoot }),
  });
  const { driver, revision, provisions } = fixture;
  // Keep the admitted private workspace intact while the separate Gateway uses
  // its own writable path. The main entry takes precedence over defaults.
  revision.configuration = admitLoggingConfiguration(
    {
      ...revision.configuration,
      agents: {
        defaults: { ...revision.configuration.agents.defaults, workspace: providerWorkspaceRoot },
        entries: { Main: { workspace: providerWorkspaceRoot } },
      },
    },
    "info",
  );
  const admittedAgents = structuredClone(revision.configuration.agents);
  fixture.sandbox.harnessHome = providerHome;
  let workspaceValidated = false;
  fixture.sandbox.validateWorkspaceSetup = (harness, configuration) => {
    assert.equal(harness.id, revision.harness.id);
    assert.equal(configuration.agents.defaults.model, "codex/gpt-5");
    workspaceValidated = true;
  };
  driver.validateWorkspaceSetup(revision.harness, revision.configuration, fixture.sandbox.id);
  assert.equal(workspaceValidated, true);
  workspaceValidated = false;
  const context = {
    ...authContext(revision),
    workspaceSetup: {
      id: "provider-workspace-setup",
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      files: { "USER.md": "private provider workspace profile" },
      completed: false,
    },
  };
  await preparedEndpoint(fixture, context);
  const { requirements } = provisions[0];
  assert.deepEqual(requirements.labels, fixture.labels);
  assert.deepEqual(
    requirements.environment.find(({ name }) => name === "APP_TOKEN_SHA"),
    {
      name: "APP_TOKEN_SHA",
      value: createHash("sha256").update("test-transport").digest("hex"),
    },
  );
  assert.equal(
    requirements.environment.some(({ name }) => name === "APP_SERVER_TOKEN"),
    false,
  );
  assert.equal(JSON.stringify(requirements).includes("test-transport"), false);
  assert.deepEqual(
    requirements.environment.find(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE"),
    {
      name: "OPENCLAW_NODE_SETUP_CODE",
      valueFrom: {
        secretKeyRef: {
          name: driver.workspaceNodeName(revision),
          key: "setupCode",
        },
      },
    },
  );
  const gatewayPod = fixture.gateway().spec.template.spec;
  const gatewayContainer = gatewayPod.containers[0];
  assert.equal(
    gatewayContainer.env.find(({ name }) => name === "APP_SERVER_URL").value,
    providerUrl,
  );
  assert.equal(
    gatewayContainer.env.find(({ name }) => name === "OPENCLAW_REMOTE_WORKSPACE_ROOT").value,
    providerWorkspaceRoot,
  );
  assert.equal(
    gatewayContainer.env.find(({ name }) => name === "OPENCLAW_WORKSPACE_DIR").value,
    "/home/node/workspace",
  );
  const gatewayDocument = () => {
    const configurationName = fixture
      .gateway()
      .spec.template.spec.volumes.find(({ name }) => name === "openclaw-configuration")
      .configMap.name;
    return JSON.parse(
      fixture.read("ConfigMap", configurationName, fixture.gatewayNamespace).data["openclaw.json"],
    );
  };
  assert.equal(gatewayDocument().agents.defaults.workspace, "/home/node/workspace");
  assert.equal(gatewayDocument().agents.entries.Main.workspace, "/home/node/workspace");
  assert.deepEqual(revision.configuration.agents, admittedAgents);
  assert.deepEqual(provisions[0].revision.configuration.agents, admittedAgents);
  const renderedHookDirectory = () =>
    gatewayDocument().plugins.entries.codex.config.appServer.nativeHookRelay.credentialDirectory;
  assert.equal(renderedHookDirectory(), providerHookDirectory);
  assert.equal(workspaceValidated, true);
  assert.deepEqual(gatewayPod.hostAliases, [
    { ip: "10.43.0.50", hostnames: ["tenant--sandbox.openshell.localhost"] },
  ]);
  assert.deepEqual(
    requirements.files.map(({ name, environmentVariable }) => ({
      name,
      environmentVariable,
    })),
    [
      {
        name: "runtime.json",
        environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
      },
      {
        name: "config.toml",
        environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
      },
    ],
  );
  assert.deepEqual(JSON.parse(requirements.files[0].content), {
    kind: "codex",
    selections: {},
  });
  await fixture.activate(undefined, context);
  assert.equal(renderedHookDirectory(), providerHookDirectory);
  // The endpoint must keep private relay material outside its file-transfer workspace.
  for (const invalidWorkspace of [
    providerHome,
    providerHookDirectory,
    `${providerHookDirectory}/files`,
    "/",
  ]) {
    endpointWorkspaceRoot = invalidWorkspace;
    for (const lifecycle of ["prepare", "activate"]) {
      await assert.rejects(
        fixture[lifecycle](undefined, context),
        /native hook credential directory/,
      );
      assert.equal(renderedHookDirectory(), providerHookDirectory);
    }
  }
  const privateSetup = {
    id: context.workspaceSetup.id,
    secretKeyRef: { name: driver.workspaceSetupSecretName(revision.agentId), key: "setup.json" },
  };
  assert.deepEqual(requirements.workspaceSetup, privateSetup);
  assert.deepEqual(fixture.endpoints.at(-1).requirements.workspaceSetup, privateSetup);
  assert.equal(
    JSON.stringify(fixture.endpoints).includes(context.workspaceSetup.files["USER.md"]),
    false,
  );
});

test("provider Harness endpoint admits only exact node and provider peers", async () => {
  const fixture = await preparedEndpoint();
  const { revision, namespace, read, writes, provisions, peerLookups, gatewayNamespace } = fixture;
  const workspaceNodePolicy = read("NetworkPolicy", "allow-node-gateway");
  assert.equal(
    selectorMatches(workspaceNodePolicy.spec.podSelector, provisions[0].requirements.labels),
    true,
    "the provider-fenced Harness must retain exact workspace-node Gateway egress",
  );
  // The supervisor's egress is OpenShell's own (egress to every destination);
  // Compute writes no supervisor-selecting policy (finding 1127).
  assert.equal(
    read("NetworkPolicy", `allow-workspace-node-gateway-${digest(revision.agentId)}`, namespace),
    undefined,
  );
  const gatewayNodePolicy = read(
    "NetworkPolicy",
    `allow-gateway-workspace-node-${digest(revision.agentId)}`,
    gatewayNamespace,
  );
  // Only this revision's own supervisor, never every supervisor in the namespace.
  assert.deepEqual(gatewayNodePolicy.spec.ingress, [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": namespace },
          },
          podSelector: { matchLabels: supervisorPeerLabels(revision.id) },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);
  // Before the Sandbox existed the policy admitted no relay at all; the policy is
  // re-applied right after provisioning, before the workspace node is awaited.
  const workspaceNodeWrites = writes.filter(
    ({ metadata }) => metadata.name === `allow-gateway-workspace-node-${digest(revision.agentId)}`,
  );
  assert.deepEqual(workspaceNodeWrites[0].spec.ingress, []);
  assert.ok(fixture.policiesAtHarnessObservation.length > 0);
  for (const policy of fixture.policiesAtHarnessObservation) {
    assert.deepEqual(
      policy.spec.ingress,
      gatewayNodePolicy.spec.ingress,
      "the exact node policy must exist before every provider Pod observation",
    );
  }
  for (const policies of fixture.provisioningPolicies) {
    assert.equal(
      policies.some(
        ({ metadata }) => metadata.name === `allow-agent-auth-${digest(revision.agentId)}`,
      ),
      false,
      "provider-fenced Harnesses receive no Compute authentication egress",
    );
    assert.equal(
      policies.some(
        ({ metadata }) => metadata.name === `allow-agent-runtime-${digest(revision.agentId)}`,
      ),
      false,
      "provider-owned transport does not grant direct ingress to the Harness",
    );
  }
  assert.ok(peerLookups.every((id) => id === revision.id));
  const agentServiceName = `agent-${digest(revision.agentId)}`;
  assert.equal(
    read("Service", agentServiceName).spec.selector["app.kubernetes.io/name"],
    `${agentServiceName}-inactive`,
  );
});

test("provider Harness malformed Pod stops preparation and cannot write activation", async () => {
  const fixture = await preparedEndpoint();
  const { hooks, writes } = fixture;
  fixture.observePods([fixture.pod("ready"), null]);
  await assert.rejects(fixture.prepare(), /invalid or incomplete/);
  assert.deepEqual(hooks.slice(-2), ["start", "stop"]);
  const writesBeforeActivation = writes.length;
  await assert.rejects(fixture.activate(), /invalid or incomplete/);
  assert.equal(writes.length, writesBeforeActivation);
});

test("provider Harness activation replaces broad legacy peers and deletes obsolete policies with UID preconditions", async () => {
  const fixture = await preparedEndpoint();
  const {
    driver,
    revision,
    namespace,
    objects,
    key,
    read,
    save,
    clients,
    endpoints,
    gatewayNamespace,
  } = fixture;
  const agentServiceName = `agent-${digest(revision.agentId)}`;
  // Finding 861, reverse switch: a plain dedicated predecessor's Harness grant is
  // not one this revision writes, so activation deletes it and keeps the pair.
  const plainRuntime = driver
    .agentNetworkPolicies(
      { ...revision, id: "plain-predecessor", sandboxDriverId: undefined },
      { name: namespace, plane: "execution" },
    )
    .map(({ resource }) => resource)
    .find(({ metadata }) => metadata.name === `allow-agent-runtime-${digest(revision.agentId)}`);
  save({ ...plainRuntime, metadata: { ...plainRuntime.metadata, uid: "plain-runtime-uid" } });
  const deletedPolicies = [];
  clients.networking.deleteNamespacedNetworkPolicy = async ({ name, namespace: target, body }) => {
    assert.equal(body.preconditions.uid, read("NetworkPolicy", name, target).metadata.uid);
    deletedPolicies.push(name);
    objects.delete(key("NetworkPolicy", name, target));
  };
  // Upgrade: an earlier controller's pair admitted every supervisor Pod in the
  // namespace. Activation replaces the ingress half and deletes the egress half.
  const legacySupervisor = { "openshell.ai/boundary-role": "supervisor" };
  const legacyIngressName = `allow-gateway-workspace-node-${digest(revision.agentId)}`;
  const legacyIngress = read("NetworkPolicy", legacyIngressName);
  save({
    ...legacyIngress,
    spec: {
      ...legacyIngress.spec,
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
              podSelector: { matchLabels: legacySupervisor },
            },
          ],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    },
  });
  const legacyEgress = driver.manifest(
    "networking.k8s.io/v1",
    "NetworkPolicy",
    `allow-workspace-node-gateway-${digest(revision.agentId)}`,
    { namespaceId: tenant.id, agentId: revision.agentId },
    { name: namespace, plane: "execution" },
  );
  save({
    ...legacyEgress,
    metadata: { ...legacyEgress.metadata, uid: "legacy-egress-uid" },
    spec: {
      podSelector: { matchLabels: legacySupervisor },
      policyTypes: ["Egress"],
      egress: [{ ports: [{ protocol: "TCP", port: 8080 }] }],
    },
  });
  fixture.observePods([fixture.pod("ready")]);
  await fixture.activate();
  assert.equal(endpoints.length, 2);
  assert.deepEqual(deletedPolicies, [legacyEgress.metadata.name, plainRuntime.metadata.name]);
  assert.equal(read("NetworkPolicy", legacyEgress.metadata.name), undefined);
  assert.deepEqual(read("NetworkPolicy", legacyIngressName).spec.ingress[0].from[0].podSelector, {
    matchLabels: supervisorPeerLabels(revision.id),
  });
  assert.equal(
    read("Service", agentServiceName).spec.selector["app.kubernetes.io/name"],
    `${agentServiceName}-inactive`,
  );
  const gatewayPolicy = read(
    "NetworkPolicy",
    `allow-gateway-agent-${digest(revision.agentId)}`,
    gatewayNamespace,
  );
  assert.deepEqual(gatewayPolicy.spec.egress, [
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "openshell-system" },
          },
          podSelector: { matchLabels: { app: "openshell-gateway" } },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);
});

const transportScenarios = [
  { name: "serving transport", answer: { state: "serving" }, outcome: { ready: true } },
  { name: "starting transport", answer: { state: "starting" }, outcome: { ready: false } },
  {
    name: "held model failure",
    answer: { state: "failed", runtimeFailure: heldFailure },
    outcome: { ready: false, runtimeFailure: heldFailure },
  },
];
const statusScenarios = [
  ...transportScenarios,
  {
    name: "redacted provider cause",
    answer: {
      state: "failed",
      runtimeFailure: { ...heldFailure, cause: { kind: "PROVIDER_TEXT", detail: "key sk-123" } },
    },
    outcome: { ready: false, runtimeFailure: withoutCause },
  },
];
for (const scenario of statusScenarios) {
  test(`provider Harness preparation observes ${scenario.name}`, async () => {
    const fixture = await endpointWithGateway();
    const { revision } = fixture;
    const observations = [];
    fixture.sandbox.harnessStatus = async (context) => {
      observations.push(context);
      return scenario.answer;
    };
    fixture.observePods([fixture.pod("ready")]);
    assert.deepEqual(await fixture.prepare(), {
      ...expectedRevision(fixture),
      ...scenario.outcome,
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].transportToken, "test-transport");
    assert.equal(observations[0].revision, revision);
    assert.deepEqual(observations[0].requirements.labels, fixture.labels);
  });
}

for (const scenario of [
  { name: "missing evidence", runtimeFailure: undefined },
  { name: "null evidence", runtimeFailure: null },
  { name: "string evidence", runtimeFailure: "MODEL_PROBE_FAILED" },
  { name: "invalid code", runtimeFailure: { ...heldFailure, code: "not a code" } },
  { name: "invalid timestamp", runtimeFailure: { ...heldFailure, checkedAt: "yesterday" } },
]) {
  test(`provider Harness rejects ${scenario.name}`, async () => {
    const fixture = await endpointWithGateway();
    fixture.observePods([fixture.pod("ready")]);
    fixture.sandbox.harnessStatus = async () => ({
      state: "failed",
      runtimeFailure: scenario.runtimeFailure,
    });
    await assert.rejects(fixture.prepare(), /Runtime failure status returned invalid data/);
    assert.deepEqual(fixture.hooks.slice(-2), ["start", "stop"]);
  });
}

test("provider Harness reads a supervisor's held failure while its workspace node is pending", async () => {
  // The Codex Harness supervisor holds a failed state migration or workspace setup before
  // Codex and the workspace node start, so the node never connects. Compute reads the hold
  // through the provider and fails the revision with it instead of waiting for the
  // deadline as WORKSPACE_NODE_PENDING (finding 2686).
  const fixture = await endpointWithGateway();
  fixture.observePods([fixture.pod("ready")]);
  fixture.driver.nodeEnrollment.isConnected = async () => false;
  const observations = [];
  let answer = { state: "serving" };
  fixture.sandbox.harnessStatus = async (context) => {
    observations.push(context);
    return answer;
  };
  // A Codex that serves while its node pairs keeps the named wait.
  assert.deepEqual(await fixture.prepare(), {
    ...expectedRevision(fixture),
    ready: false,
    pendingReason: "WORKSPACE_NODE_PENDING",
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].transportToken, "test-transport");
  for (const check of ["state-migration", "workspace-baseline"]) {
    const runtimeFailure = { ...withoutCause, check, code: "UNAVAILABLE" };
    answer = { state: "failed", runtimeFailure };
    assert.deepEqual(await fixture.prepare(), {
      ...expectedRevision(fixture),
      ready: false,
      runtimeFailure,
    });
  }
  assert.equal(observations.length, 3);
});

test("provider Harness unready Pod prevents transport status observation", async () => {
  const fixture = await endpointWithGateway();
  let observations = 0;
  fixture.sandbox.harnessStatus = async () => {
    observations++;
    return { state: "failed", runtimeFailure: heldFailure };
  };
  fixture.observePods([fixture.pod("starting", "False")]);
  assert.deepEqual(await fixture.prepare(), {
    ...expectedRevision(fixture),
    ready: false,
  });
  assert.equal(observations, 0);
});

for (const scenario of transportScenarios) {
  test(`provider Harness activation re-observes ${scenario.name}`, async () => {
    const fixture = await endpointWithGateway();
    fixture.observePods([fixture.pod("ready")]);
    const observations = [];
    let answer = { state: "serving" };
    fixture.sandbox.harnessStatus = async (context) => {
      observations.push(context);
      return answer;
    };
    assert.deepEqual(await fixture.prepare(), {
      ...expectedRevision(fixture),
      ready: true,
    });
    assert.equal(observations.length, 1);
    // The previously serving Harness can stop between preparation and activation.
    answer = scenario.answer;
    const before = fixture.writes.length;
    if (scenario.outcome.ready) {
      await fixture.activate();
      assert.ok(fixture.writes.length > before);
    } else {
      await assert.rejects(fixture.activate(), /The exact AgentRevision workload is not ready/);
      assert.equal(fixture.writes.length, before);
    }
    assert.equal(observations.length, 2);
    assert.equal(observations[1].transportToken, "test-transport");
  });
}

for (const scenario of transportScenarios) {
  test(`provider Harness ready credential attachment still requires ${scenario.name}`, async () => {
    const fixture = await endpointWithGateway();
    const { driver, revision } = fixture;
    fixture.observePods([fixture.pod("ready")]);
    const harnessObservations = [];
    fixture.sandbox.harnessStatus = async (context) => {
      harnessObservations.push(context);
      return scenario.answer;
    };
    const attachmentChecks = [];
    // The Credential Gateway Compute holds; only revisions that bind sources reach it.
    driver.credentialGatewayDriver = {
      id: "credential-gateway",
      capability: "credential_gateway",
      async attachForRevision(context) {
        return context.sources.map(({ id }) => ({ sourceId: id, ref: `ref-${id}` }));
      },
      async attachmentStatus(context) {
        attachmentChecks.push(context.sources.map(({ id }) => id));
        return context.sources.map(({ id }) => ({ sourceId: id, state: "ready" }));
      },
    };
    const toolSource = {
      id: "cs_00000000-0000-4000-8000-000000000546",
      namespaceId: tenant.id,
      name: "tool",
      type: "bearer-token",
      config: {},
      secrets: {},
      ownerCapability: "credential_gateway",
      driverId: "credential-gateway",
      state: "ready",
      createdAt: "2026-10-08T00:00:00.000Z",
    };
    const sourced = {
      ...revision,
      credentialSources: [
        {
          sourceId: toolSource.id,
          credentialGatewayId: "credential-gateway",
          sourceType: "bearer-token",
        },
      ],
    };
    const sourcedContext = { ...authContext(sourced), credentialSources: [toolSource] };
    assert.deepEqual(await fixture.prepare(sourced, sourcedContext), {
      ...expectedRevision(fixture),
      ...scenario.outcome,
    });
    assert.deepEqual(attachmentChecks, [[toolSource.id]]);
    assert.equal(harnessObservations.length, 1);
    assert.equal(harnessObservations[0].revision, sourced);
  });
}

test("provider Harness unreachable transport is a transient Sandbox provisioning failure", async () => {
  const fixture = await endpointWithGateway();
  const { driver } = fixture;
  fixture.observePods([fixture.pod("ready")]);
  // An unreachable Harness transport is no evidence about the Harness: the pass fails in the
  // Sandbox provisioning stage as a transient dependency the worker rechecks until the
  // deadline without spending attempts (finding 1658).
  const transport = new DependencyUnavailableError("OpenShell service is unreachable.");
  fixture.sandbox.harnessStatus = async () => {
    throw transport;
  };
  const unreachable = await fixture.prepare().then(
    () => assert.fail("an unreachable Harness must not prepare"),
    (error) => error,
  );
  assert.ok(unreachable instanceof TransientDependencyError, String(unreachable));
  assert.equal(unreachable.dependency, "sandbox_gateway");
  assert.equal(unreachable.cause, transport);
  assert.deepEqual(driver.describePrepareRevisionFailure(unreachable), {
    code: "SANDBOX_GATEWAY_UNAVAILABLE",
    stage: "sandbox_provision",
    errorClass: "TransientDependencyError",
    message: "The Sandbox provider did not answer the Harness status read.",
  });
});

test("provider Harness verified endpoint trust is projected before rollout and immutable", async (t) => {
  const tls = await harnessTlsFixture(t);
  const untrusted = await harnessTlsFixture(t);
  const controllerRequire = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const socketRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
  const { WebSocketServer } = socketRequire("ws");
  const server = createHttpsServer({ key: tls.key, cert: tls.cert });
  const sockets = new WebSocketServer({ server });
  t.after(() => {
    for (const client of sockets.clients) {
      client.terminate();
    }
    sockets.close();
    return new Promise((resolve) => server.close(resolve));
  });
  sockets.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer test-transport");
    socket.send("trust-ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const providerPort = server.address().port;
  let providerCaBundle = tls.caBundle;

  const providerUrl = `wss://localhost:${providerPort}/`;
  const fixture = providerEndpointFixture({
    providerNetwork: {
      namespace: "openshell-system",
      podLabels: { app: "openshell-gateway" },
      address: "10.43.0.50",
      port: providerPort,
    },
    harnessEndpoint: async () => ({
      url: providerUrl,
      workspaceRoot: providerWorkspaceRoot,
      tls: { caBundle: providerCaBundle },
    }),
  });
  const { read, writes, revision, provisions, gatewayNamespace } = fixture;
  const configMap = (name) => read("ConfigMap", name, gatewayNamespace);
  await fixture.prepare();
  const bootstrap = fixture.gateway();
  assert.equal(
    bootstrap.spec.template.spec.containers[0].env.some(
      ({ name }) => name === "NODE_EXTRA_CA_CERTS",
    ),
    false,
  );
  const configurationName = `gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const initialSnapshot = configMap(configurationName);
  fixture.setGatewayServing();
  fixture.setSetupAvailable(true);
  fixture.observePods([fixture.pod("ready")]);
  assert.equal((await fixture.prepare()).ready, true);
  const pod = fixture.gateway().spec.template.spec;
  const gatewayContainer = pod.containers[0];
  // Endpoint discovery must not rewrite the immutable configuration created for
  // bootstrap. Only this revision's Gateway receives the separate public bundle.
  assert.deepEqual(configMap(configurationName), initialSnapshot);
  const trustMount = gatewayContainer.volumeMounts.find(({ name }) => name === "harness-trust");
  assert.ok(trustMount, "the provider endpoint CA must be mounted into the Gateway");
  const trustVolume = pod.volumes.find(({ name }) => name === trustMount.name);
  assert.equal(trustMount.readOnly, true);
  assert.equal(trustVolume.configMap.optional, false);
  const trust = configMap(trustVolume.configMap.name);
  assert.equal(trust.immutable, true);
  assert.equal(trust.metadata.labels["openclaw.dev/revision"], revision.id);
  assert.deepEqual(trust.data, { "ca-bundle.pem": tls.caBundle });
  const caPaths = gatewayContainer.env.filter(({ name }) => name === "NODE_EXTRA_CA_CERTS");
  assert.deepEqual(
    caPaths.map(({ value }) => value),
    [`${trustMount.mountPath}/${trustVolume.configMap.items[0].path}`],
  );
  assert.equal(
    provisions[0].requirements.environment.some(({ name }) => name === "NODE_EXTRA_CA_CERTS"),
    false,
  );
  const trustWrite = writes.findIndex(
    ({ kind, metadata }) => kind === "ConfigMap" && metadata.name === trust.metadata.name,
  );
  const rolloutWrite = writes.findIndex(
    ({ kind, spec }) =>
      kind === "Deployment" &&
      spec.template.spec.volumes.some(({ name }) => name === "harness-trust"),
  );
  assert.ok(
    trustWrite >= 0 && trustWrite < rolloutWrite,
    "public trust exists before the Gateway rollout",
  );

  // Materialize the actual projection in a private directory. A fresh Node
  // process exercises ws's default TLS path, as the pinned Gateway client does;
  // no ca/rejectUnauthorized override or process trust mutation is supplied.
  const projectedPath = join(tls.directory, "projected-ca.pem");
  await writeFile(projectedPath, trust.data[trustVolume.configMap.items[0].key]);
  const wsProbe = `
      const WebSocket = require(${JSON.stringify(socketRequire.resolve("ws"))});
      const socket = new WebSocket(process.env.APP_SERVER_URL, {
        headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN },
        handshakeTimeout: 2000,
      });
      socket.on("message", (data) => {
        process.stdout.write(data.toString());
        socket.close();
      });
      socket.on("error", (error) => { process.stderr.write(String(error.code)); process.exitCode = 1; });
    `;
  const probe = (caPath, url = providerUrl) =>
    promisify(execFile)(process.execPath, ["-e", wsProbe], {
      env: {
        APP_SERVER_URL: url,
        APP_SERVER_TOKEN: "test-transport",
        ...(caPath === undefined ? {} : { NODE_EXTRA_CA_CERTS: caPath }),
      },
    });
  assert.deepEqual(await probe(projectedPath), { stdout: "trust-ok", stderr: "" });
  for (const caPath of [undefined, untrusted.rootCertificatePath]) {
    await assert.rejects(probe(caPath), {
      code: 1,
      stderr: /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/,
    });
  }
  await assert.rejects(probe(projectedPath, `wss://127.0.0.1:${providerPort}/`), {
    code: 1,
    stderr: "ERR_TLS_CERT_ALTNAME_INVALID",
  });

  providerCaBundle = untrusted.caBundle;
  await assert.rejects(fixture.activate(), /invalid immutable Kubernetes ConfigMap/);
  assert.deepEqual(configMap(trust.metadata.name), trust);
});

test("provider Harness protected execution is released only on current signed installation and warmth", async (t) => {
  const fixture = await preparedEndpoint();
  const { revision, provisions, objects, save, core } = fixture;
  let harnessAnswer = { state: "serving" };
  // A separately admitted protected revision waits for the installation commit.
  // These Driver dependencies expose ordering; actual authenticated release and
  // first model-request behavior are covered by the enrollment integration test.
  const protectedId = "ar_00000000-0000-4000-8000-000000000547";
  const execution = {
    installationId: "ins_00000000-0000-4000-8000-000000000001",
    namespaceId: tenant.id,
    agentId: revision.agentId,
    servicePrincipalId: revision.servicePrincipalId,
    revisionId: protectedId,
    executionId: "00000000-0000-4000-8000-000000000547",
  };
  const protectedSourceId = "cs_00000000-0000-4000-8000-000000000547";
  const sourceKey = {
    installationId: execution.installationId,
    namespaceId: tenant.id,
    source: { id: protectedSourceId, generation: 1 },
    backend: { id: "static-input", generation: 1 },
    provider: openAiStaticProvider.ref,
  };
  const source = {
    namespaceId: tenant.id,
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId: "credential-gateway",
    state: "ready",
    createdAt: tenant.createdAt,
    id: protectedSourceId,
    name: "model",
    type: "openai",
    config: openAiStaticProvider.normalizeConfig({}),
    egress: {
      key: sourceKey,
      schemaVersion: 1,
      adoption: "live",
      retention: "none",
      materialRefId: "material-model",
      secret: {
        kind: "secret",
        id: "sec_00000000-0000-4000-8000-000000000550",
        namespaceId: tenant.id,
      },
      secretDriver: { id: "secrets", generation: 1 },
      sender: { id: "supervisor", generation: 1 },
      resolver: { id: "resolver", generation: 1 },
    },
  };
  const grant = openAiStaticProvider.normalizeGrant(["gpt-5"]);
  const sandbox = {
    ...fixture.sandbox,
    capability: "sandbox",
    facets: ["networking"],
    cleanup: assert.fail,
    enrollHarness: assert.fail,
    harnessStatus: async () => harnessAnswer,
  };
  const proxy = {
    id: sandbox.id,
    implementation: sandbox.implementation,
    capability: "credential_proxy",
    sourceControl: {
      sender: source.egress.sender,
      resolver: source.egress.resolver,
      providers: [openAiStaticProvider],
      assertAvailable: assert.fail,
    },
    async configureRevision({ plan }) {
      return { plan, configuration: { middleware: "protected-attachment" } };
    },
    async wiringStatus() {
      events.push("observe");
      return observation;
    },
    async verifyInstallation() {
      events.push("verify-current");
      return current;
    },
    withdrawBinding: assert.fail,
    removeRevision: assert.fail,
  };
  const protectedDriver = new InstalledDriver(
    { id: sandbox.id, implementation: sandbox.implementation, configuration: {} },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  let preparedIssuer;
  const driver = new KubernetesComputeDriver(fixture.driver.options, {
    protectedDriver,
    preparedTokens: { issuer: () => preparedIssuer },
    nodeEnrollment: fixture.driver.nodeEnrollment,
    credentialGatewayDriver: {
      id: source.driverId,
      capability: "credential_gateway",
      listSourceTypes: async () => [openAiStaticProvider.sourceType],
    },
  });
  driver.apiClients = Promise.resolve(fixture.clients);
  const plan = {
    id: "00000000-0000-4000-8000-000000000548",
    generation: 1,
    execution,
    driver: protectedDriver.ref,
    sandboxDriverId: sandbox.id,
    egressDriverId: proxy.id,
    routes: openAiStaticProvider.routes(source, {
      binding: { id: "00000000-0000-4000-8000-000000000549", generation: 1 },
      execution,
      source: sourceKey,
      grant,
      grantHash: createHash("sha256").update(JSON.stringify(grant)).digest("hex"),
      isolationId: revision.agentId,
    }),
  };
  const protectedAuth = {
    method: "credential_source",
    sourceId: source.id,
    credentialGatewayId: source.driverId,
    sourceType: source.type,
    loginMode: "api_key",
  };
  const protectedRevision = {
    ...revision,
    id: protectedId,
    executionAdmission: { version: 3, mode: "protected" },
    revision: revision.revision + 1,
    harnessAuth: protectedAuth,
    egressPlan: plan,
    credentialSources: [
      { sourceId: source.id, credentialGatewayId: source.driverId, sourceType: source.type },
    ],
  };
  const installed = {
    plan,
    sandboxId: "installed-sandbox",
    sender: source.egress.sender,
    installedAt: "2026-10-14T00:00:00.000Z",
    enforcement: {
      instanceId: "current-instance",
      configurationId: "current-configuration",
      peerKeyId: "enrolled-exchange-key",
      authorityScope: "execution",
      policyHash: "installed-protected-policy",
    },
  };
  const events = [];
  let observation = installed;
  let current = true;
  let enrollmentRequirements;
  let releaseByCompute;
  const released = new DependencyUnavailableError("stop after authenticated enrollment boundary");
  sandbox.enrollHarness = async (context, receipt, release) => {
    releaseByCompute = release;
    assert.equal(context.transportToken, "test-transport");
    assert.equal(context.revision, protectedRevision);
    assert.equal(receipt, installed);
    enrollmentRequirements = context.requirements;
    events.push("enroll");
    throw released;
  };
  // A new revision has its own node setup; the already-ready Gateway remains the
  // predecessor. Its setup Secret is independently seeded, not made ready by writes.
  const setup = await core.readNamespacedSecret({ name: driver.workspaceNodeName(revision) });
  const seedNode = (target) =>
    save({
      ...setup,
      metadata: {
        ...setup.metadata,
        name: driver.workspaceNodeName(target),
        labels: { ...setup.metadata.labels, "openclaw.dev/revision": target.id },
      },
    });
  seedNode(protectedRevision);
  const protectedContext = {
    harnessAuth: { ...protectedAuth, source },
    credentialSources: [source],
    async recordEgressInstallation() {
      events.push("commit");
    },
    currentEgressInstallation: async () => observation,
  };
  // A source cannot claim Proxy ownership under a different admitted source key.
  const conflictingSource = structuredClone(source);
  conflictingSource.egress.key.source.generation += 1;
  await assert.rejects(
    driver.prepareRevision(protectedRevision, {
      ...protectedContext,
      harnessAuth: { ...protectedAuth, source: conflictingSource },
    }),
    /Protected Harness authentication does not match its admitted source/,
  );
  assert.deepEqual(events.splice(0), []);
  observation = undefined;
  assert.equal((await driver.prepareRevision(protectedRevision, protectedContext)).ready, false);
  assert.deepEqual(events.splice(0), ["observe"]);
  observation = installed;
  const commitFailure = new Error("installation commit failed");
  await assert.rejects(
    driver.prepareRevision(protectedRevision, {
      ...protectedContext,
      async recordEgressInstallation() {
        events.push("commit-rejected");
        throw commitFailure;
      },
    }),
    (error) => error === commitFailure,
  );
  assert.deepEqual(events.splice(0), ["observe", "verify-current", "commit-rejected"]);
  current = false;
  assert.equal((await driver.prepareRevision(protectedRevision, protectedContext)).ready, false);
  assert.deepEqual(events.splice(0), ["observe", "verify-current"]);
  current = true;
  const changedAtCommit = await driver.prepareRevision(protectedRevision, {
    ...protectedContext,
    async recordEgressInstallation() {
      events.push("commit");
      current = false;
    },
  });
  assert.equal(changedAtCommit.ready, false);
  assert.deepEqual(events.splice(0), ["observe", "verify-current", "commit", "verify-current"]);
  current = true;
  const entered = Promise.withResolvers();
  const commit = Promise.withResolvers();
  const preparing = driver.prepareRevision(protectedRevision, {
    ...protectedContext,
    async recordEgressInstallation() {
      events.push("commit-start");
      entered.resolve();
      await commit.promise;
      events.push("commit-finished");
    },
  });
  // Await both branches so an earlier preparation failure cannot leave the test hanging.
  await Promise.race([entered.promise, preparing]);
  assert.deepEqual(events, ["observe", "verify-current", "commit-start"]);
  commit.resolve();
  await assert.rejects(preparing, (error) => error === released);
  assert.deepEqual(events.splice(0), [
    "observe",
    "verify-current",
    "commit-start",
    "commit-finished",
    "verify-current",
    "enroll",
  ]);

  // Exercise the actual producer's output, not a hand-built environment that
  // can accidentally restore the revision variable removed during projection.
  const manifest = JSON.parse(
    enrollmentRequirements.files.find(
      (file) => file.environmentVariable === "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
    ).content,
  );
  const projectedEnv = ({ environment }) =>
    Object.fromEntries(
      environment.filter((entry) => "value" in entry).map(({ name, value }) => [name, value]),
    );
  for (const name of [
    "OPENCLAW_AGENT_REVISION_ID",
    "OPENCLAW_RUNTIME_STATUS_PORT",
    "OPENCLAW_RUNTIME_STATUS_CONTAINER",
    "OPENCLAW_POD_UID",
    "APP_SERVER_TOKEN",
  ]) {
    assert.equal(
      enrollmentRequirements.environment.some((entry) => entry.name === name),
      false,
    );
  }
  assert.equal(
    provisions[0].requirements.environment.some(
      (entry) => entry.name === "OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID",
    ),
    false,
    "unprotected provider Harnesses do not receive enrollment identity",
  );
  const environment = projectedEnv(enrollmentRequirements);
  const headers = { authorization: "Bearer test-transport", "content-type": "application/json" };
  async function launch(t, args, env) {
    // Each child owns a fresh port on the enrollment listener's actual bind address.
    const reservation = await reservePort({ host: "0.0.0.0" });
    t.after(reservation.release);
    const url = `http://127.0.0.1:${reservation.port}${HARNESS_EGRESS_ENROLLMENT_PATH}`;
    const release = async (body) => {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      return response.status;
    };
    // Remap only the service port; authentication and identity come from prepareRevision.
    const child = spawn(process.execPath, [...reservedPortArgs(reservation), ...args], {
      env: { ...env, APP_SERVER_PORT: String(reservation.port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    });
    const response = await waitFor(
      "enrollment challenge",
      () => {
        assert.equal(child.exitCode, null, diagnostics);
        return fetch(url, { headers }).catch(() => undefined);
      },
      2000,
      { interval: 20, describe: () => diagnostics },
    );
    assert.equal(response.status, 200, diagnostics);
    // Only the authenticated enrollment listener can answer; it now owns the port.
    await reservation.release();
    return { challenge: await response.json(), exited, url, release };
  }
  const program = `
    function isPlainObject(value) {
      return value !== null && typeof value === "object" &&
        Object.getPrototypeOf(value) === Object.prototype;
    }
    ${HARNESS_EGRESS_ENROLLMENT_HELPER}
    waitForHarnessEgressEnrollment(${JSON.stringify(manifest.egressEnrollment)})
      .then(() => process.exit(0), (error) => {
        console.error(error.message); process.exit(1);
      });
  `;
  await t.test(
    "production provider requirements open the authenticated enrollment challenge",
    async (t) => {
      const { challenge, exited, url, release } = await launch(t, ["-e", program], environment);
      assert.deepEqual(challenge.execution, plan.execution);
      assert.deepEqual(challenge.plan, { id: plan.id, generation: plan.generation });
      assert.equal((await fetch(url)).status, 401);
      const execution = { ...challenge.execution, revisionId: "wrong-revision" };
      assert.equal(await release({ ...challenge, execution }), 409);
      // A bearer holder can read the real challenge but cannot echo it to release startup.
      assert.equal(await release(challenge), 409);
      for (const substitution of [
        undefined,
        { ...installed, sandboxId: "replacement" },
        {
          ...installed,
          enforcement: { ...installed.enforcement, peerKeyId: "new-enrolled-peer" },
        },
      ]) {
        observation = substitution;
        await assert.rejects(
          releaseByCompute(challenge.startupId),
          /exact current committed installation/,
        );
      }
      observation = installed;
      current = false;
      await assert.rejects(
        releaseByCompute(challenge.startupId),
        /exact current committed installation/,
      );
      current = true;
      const stale = await releaseByCompute("another-startup");
      assert.equal(await release(stale), 409);
      const signed = await releaseByCompute(challenge.startupId);
      const signer = [...objects.values()].find((v) =>
        v.metadata?.name.startsWith("compute-release-"),
      );
      assert.ok(signer?.immutable);
      assert.equal(JSON.stringify(enrollmentRequirements).includes(signer.data.signer), false);
      for (const forged of [
        { ...signed, signature: Buffer.alloc(64).toString("base64url") },
        { ...signed, installation: { ...signed.installation, peerKeyId: "new-peer" } },
      ]) {
        assert.equal(await release(forged), 409);
      }
      assert.equal(await release(signed), 200);
      assert.deepEqual(await exited, [0, null]);
    },
  );
  for (const [name, value, extra] of [
    ["mismatched revision", "wrong-revision", {}],
    ["omitted revision", undefined, {}],
    [
      "private status identity cannot substitute",
      undefined,
      { OPENCLAW_AGENT_REVISION_ID: protectedRevision.id },
    ],
  ]) {
    await t.test(name, () => {
      const env = { ...environment, ...extra };
      delete env.OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID;
      if (value !== undefined) {
        env.OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID = value;
      }
      const result = spawnSync(process.execPath, ["-e", program], {
        env,
        encoding: "utf8",
        timeout: 3000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Protected Harness enrollment configuration is invalid/);
    });
  }
  await t.test(
    "a zero-binding execution releases only its local app server, after the exact committed deny-all",
    async (t) => {
      const id = "ar_00000000-0000-4000-8000-000000000548";
      const zeroPlan = { ...plan, execution: { ...plan.execution, revisionId: id }, routes: [] };
      const zero = {
        ...protectedRevision,
        id,
        revision: protectedRevision.revision + 1,
        harnessAuth: { method: "runtime" },
        egressPlan: zeroPlan,
        credentialSources: [],
      };
      seedNode(zero);
      const zeroInstalled = { ...installed, plan: zeroPlan };
      observation = zeroInstalled;
      let zeroRequirements;
      let authorizeZero;
      sandbox.enrollHarness = async ({ requirements }, receipt, release) => {
        assert.equal(receipt, zeroInstalled);
        zeroRequirements = requirements;
        authorizeZero = release;
        throw released;
      };
      const zeroContext = {
        harnessAuth: zero.harnessAuth,
        credentialSources: [],
        currentEgressInstallation: async () => zeroInstalled,
        recordEgressInstallation: async (receipt) => assert.equal(receipt, zeroInstalled),
      };
      await assert.rejects(
        driver.prepareRevision(zero, zeroContext),
        (error) => error === released,
      );
      const directory = await temporaryDirectory(t, "oce-compute-deny-all-");
      const calls = join(directory, "codex-calls");
      await writeFile(calls, "");
      // Stub only the CLI. Use the owning prepareRevision's actual files and environment.
      await writeFile(
        join(directory, "codex"),
        '#!/bin/sh\necho "$@" >> "$OCE_TEST_CODEX_CALLS"\n',
        { mode: 0o700 },
      );
      const env = {
        ...projectedEnv(zeroRequirements),
        PATH: directory + ":" + process.env.PATH,
        HOME: directory,
        CODEX_HOME: directory,
        OPENCLAW_WORKSPACE_DIR: directory,
        OCE_TEST_CODEX_CALLS: calls,
      };
      for (const file of zeroRequirements.files) {
        const path = join(directory, file.name);
        await writeFile(path, file.content);
        env[file.environmentVariable] = path;
      }
      const script = join(directory, "harness.cjs");
      await writeFile(script, AGENT_RUNTIME_ENTRYPOINT);
      const { challenge, exited, release } = await launch(t, [script], env);
      assert.equal(challenge.routeCount, 0);
      assert.equal(
        await readFile(calls, "utf8"),
        "",
        "protected startup ran no CLI before release",
      );
      const signed = await authorizeZero(challenge.startupId);
      assert.equal(await release(signed), 200);
      assert.deepEqual(await exited, [0, null]);
      const invocations = (await readFile(calls, "utf8")).trim().split("\n");
      assert.equal(invocations.length, 1);
      assert.match(invocations[0], /app-server/);
    },
  );
  await t.test(
    "metadata-only Compute observes exact warm preparation before release and waits for serving",
    async () => {
      const id = "ar_00000000-0000-4000-8000-000000000549";
      const execution = { ...plan.execution, revisionId: id };
      const provider = { id: "github-app-metadata", generation: 1 };
      const key = { ...sourceKey, provider };
      const grant = {
        kind: "github_repository_metadata",
        appId: "7",
        installationId: "9",
        repositoryId: "11",
        repository: "test/example",
        isolationId: execution.agentId,
        profile: "metadata-read",
      };
      const binding = { ...plan.routes[0].binding, execution, grant, source: key };
      const route = { ...plan.routes[0], method: "GET", path: "/repos/test/example", binding };
      const metadataPlan = { ...plan, execution, routes: [route] };
      const metadata = {
        ...protectedRevision,
        id,
        revision: protectedRevision.revision + 2,
        harnessAuth: { method: "runtime" },
        egressPlan: metadataPlan,
      };
      seedNode(metadata);
      const receipt = { ...installed, plan: metadataPlan };
      const sequence = [];
      let warmth;
      const lifecycle = {
        // This owner can only observe readiness. Access, issue and refresh are not wired.
        async ready(source) {
          assert.deepEqual(source.grant, grant);
          assert.deepEqual(source.key, key);
          sequence.push("observe-warmth");
          return warmth === "ignore-abort" ? new Promise(() => {}) : warmth;
        },
      };
      preparedIssuer = { ...lifecycle, sourceFromRoute: preparedGitHubSourceFromRoute };
      observation = receipt;
      let expireDuringRelease = false;
      sandbox.enrollHarness = async (context, current, release) => {
        assert.equal(current, receipt);
        assert.ok(
          context.requirements.environment.some(
            (v) => v.name === "CODEX_LOGIN_MODE" && v.value === "protected-no-inference",
          ),
        );
        if (expireDuringRelease) {
          warmth = false;
        }
        const authorization = await release("00000000-0000-4000-8000-000000000549");
        assert.equal(authorization.challenge.inference, false);
        assert.equal(authorization.challenge.routeCount, 1);
        sequence.push("signed");
      };
      const context = {
        harnessAuth: metadata.harnessAuth,
        recordEgressInstallation: async () => sequence.push("commit"),
        currentEgressInstallation: async () => receipt,
      };
      for (const cold of [false, "ignore-abort"]) {
        warmth = cold;
        assert.equal((await driver.prepareRevision(metadata, context)).ready, false, String(cold));
        assert.deepEqual(
          sequence.splice(0),
          ["observe-warmth"],
          "cold and bounded-out observations release nothing",
        );
      }
      warmth = true;
      expireDuringRelease = true;
      await assert.rejects(
        driver.prepareRevision(metadata, context),
        /exact current committed installation/,
      );
      assert.deepEqual(sequence.splice(0), ["observe-warmth", "commit", "observe-warmth"]);
      warmth = true;
      expireDuringRelease = false;
      // Independently observe the metadata revision's Ready provider Pod, not the
      // predecessor used by this fixture. Harness status still determines readiness.
      const pod = fixture.pod("metadata-revision");
      pod.metadata.labels["openclaw.dev/revision"] = id;
      pod.metadata.labels["app.kubernetes.io/name"] =
        "agent-" + digest(metadata.agentId) + "-rev-" + digest(id);
      const originalList = core.listNamespacedPod;
      core.listNamespacedPod = async (request) =>
        request.labelSelector.includes("openclaw.dev/revision=" + id)
          ? { items: [pod] }
          : originalList(request);
      for (const state of ["starting", "serving"]) {
        harnessAnswer = { state };
        const prepared = await driver.prepareRevision(metadata, context);
        assert.equal(prepared.ready, state === "serving");
        assert.deepEqual(sequence.splice(0), [
          "observe-warmth",
          "commit",
          "observe-warmth",
          "signed",
        ]);
      }
      core.listNamespacedPod = originalList;
    },
  );
  await t.test(
    "an admitted protected Codex launch renders its no-connection-retry command; a stored revision keeps its bytes",
    async () => {
      // Pin the commands the Driver renders, not only the exported entrypoints (#3310,
      // finding 2256): the Sandbox launch carries the workspace node; activation renders
      // the same Harness without it for the endpoint and status reads.
      const admission = driver.admitRevision(protectedRevision);
      assert.equal(admission, "protected-codex-no-connection-retry:v1");
      const admitted = {
        ...protectedRevision,
        compute: { ...protectedRevision.compute, admission },
      };
      // Controller-rendered programs reach `node -e` compressed behind a fixed loader.
      const program = ([loader, ...pieces]) => {
        assert.equal(loader, nodeProgramArguments("")[0]);
        return inflateRawSync(Buffer.from(pieces.join(""), "base64")).toString("utf8");
      };
      const pod = fixture.pod("protected-revision");
      pod.metadata.labels["openclaw.dev/revision"] = protectedRevision.id;
      pod.metadata.labels["app.kubernetes.io/name"] =
        "agent-" + digest(protectedRevision.agentId) + "-rev-" + digest(protectedRevision.id);
      const originalList = core.listNamespacedPod;
      const { enrollHarness, harnessEndpoint } = sandbox;
      core.listNamespacedPod = async (request) =>
        request.labelSelector.includes("openclaw.dev/revision=" + protectedRevision.id)
          ? { items: [pod] }
          : originalList(request);
      observation = installed;
      current = true;
      try {
        for (const target of [admitted, protectedRevision]) {
          const rendered = [];
          sandbox.enrollHarness = async ({ requirements }) => {
            rendered.push([requirements.command, true]);
            throw released;
          };
          sandbox.harnessEndpoint = async ({ requirements }) => {
            rendered.push([requirements.command, false]);
            throw released;
          };
          for (const lifecycle of ["prepareRevision", "activateRevision"]) {
            await assert.rejects(
              driver[lifecycle](target, protectedContext),
              (error) => error === released,
            );
          }
          assert.equal(rendered.length, 2);
          const disabled = target === admitted;
          for (const [command, node] of rendered) {
            const legacy = node ? AGENT_WITH_NODE_ENTRYPOINT : AGENT_RUNTIME_ENTRYPOINT;
            const updated = node
              ? PROTECTED_CODEX_WITH_NODE_ENTRYPOINT
              : PROTECTED_CODEX_RUNTIME_ENTRYPOINT;
            // A stored revision without the marker keeps its exact immutable command.
            assert.deepEqual(command, [
              ...RUNTIME_WRAPPER_COMMAND,
              ...nodeProgramArguments(disabled ? updated : legacy),
            ]);
            const outer = program(command.slice(RUNTIME_WRAPPER_COMMAND.length));
            const child = /\n\s+name: "Codex",\n\s+args: (.+),\n/.exec(outer);
            assert.equal(child !== null, node);
            const codex = node ? program(JSON.parse(child[1]).slice(1)) : outer;
            assert.equal(
              codex,
              withoutLineComments(
                disabled ? PROTECTED_CODEX_RUNTIME_ENTRYPOINT : AGENT_RUNTIME_ENTRYPOINT,
              ),
            );
            // Only the two model-calling invocations: the authentication probe and app-server.
            assert.equal(
              codex.match(/unbounded_connection_retries/g)?.length ?? 0,
              disabled ? 2 : 0,
            );
            if (disabled) {
              assert.match(
                codex,
                /spawnSync\(codexExecutable\(\), \[\s+"--disable", "unbounded_connection_retries",\s+\.\.\.disabled/,
              );
              assert.match(codex, /"--disable", "unbounded_connection_retries",\s+"app-server",/);
            }
          }
        }
      } finally {
        core.listNamespacedPod = originalList;
        sandbox.enrollHarness = enrollHarness;
        sandbox.harnessEndpoint = harnessEndpoint;
      }
    },
  );
});
