import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { supervisorPeerLabels } from "../fixtures/kubernetes-provider-readiness.mjs";
import {
  tenant,
  authContext,
  digest,
  selectorMatches,
} from "../helpers/kubernetes-routed-scenarios.mjs";

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
      nodeUrl: `ws://${gatewayName}.${gatewayNamespace}.svc.cluster.local:8080/node`,
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

test("provider Harness unreachable transport is diagnosed as Sandbox provisioning failure", async () => {
  const fixture = await endpointWithGateway();
  const { driver } = fixture;
  fixture.observePods([fixture.pod("ready")]);
  // An unreachable Harness transport is a Sandbox provisioning failure in diagnostics.
  fixture.sandbox.harnessStatus = async () => {
    throw new DependencyUnavailableError("OpenShell service is unreachable.");
  };
  const unreachable = await fixture.prepare().then(
    () => assert.fail("an unreachable Harness must not prepare"),
    (error) => error,
  );
  assert.ok(unreachable instanceof DependencyUnavailableError, String(unreachable));
  assert.equal(driver.describePrepareRevisionFailure(unreachable).stage, "sandbox_provision");
});
