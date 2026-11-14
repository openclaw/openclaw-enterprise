import assert from "node:assert/strict";
import { ComputeCleanupFailedError } from "../../apps/controller/src/drivers/compute/cleanup-failure.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  AgentRevision,
  HarnessExecutionMode,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { ActivationFailedError, TransientDependencyError } from "../../packages/occ/src/index.ts";
import { supervisorPeerLabels } from "../fixtures/kubernetes-provider-readiness.mjs";
import { assertCleanupFailure } from "../helpers/compute-cleanup-failure.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  openShellPolicyOptions,
  openShellPolicySandbox,
} from "../helpers/kubernetes-openshell-network-policy.ts";
import {
  authContext,
  digest,
  options,
  routedOptions,
  routedRevision,
  selectorMatches,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import { workspaceNodePluginRefusal } from "../helpers/refusal-text.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import {
  ORDINARY_PROFILE,
  ORDINARY_PROFILE_LABEL,
  computeDriver,
  firstPeerSelector,
  matchLabels,
  observedResource,
  podSelector,
  policyRules,
  prepareUntilReady,
  renderedPolicies,
  resourceRecord,
  resourceRecords,
  serviceSelector,
  templateLabels,
} from "./kubernetes-network-profile-cases.ts";

function openShellNetworkSandbox(
  hooks: Parameters<typeof openShellPolicySandbox>[0],
): SandboxDriver {
  return {
    ...openShellPolicySandbox(hooks),
    capability: "sandbox",
    facets: ["networking", "filesystem", "process"],
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    cleanup:
      hooks.cleanup ?? (async () => assert.fail("rendering policies must not clean up a Harness")),
  };
}

export async function checkOpenShellSupervisorGatewayIsolation() {
  const sandboxIds = new Map([
    ["revision-d1", "d1"],
    ["revision-d2", "d2"],
    ["revision-f1", "f1"],
  ]);
  let peerLabels: (
    context: Parameters<NonNullable<SandboxDriver["workspaceNodePeerLabels"]>>[0],
  ) => Record<string, string> | undefined = ({ revision: target }) =>
    sandboxIds.has(target.id)
      ? {
          "openshell.ai/sandbox-id": `sandbox-${sandboxIds.get(target.id)}`,
          "openshell.ai/boundary-role": "supervisor",
        }
      : undefined;
  const installation = () => options(openShellPolicyOptions(options().network));
  const driver = new KubernetesComputeDriver(installation(), {
    sandboxDriver: openShellNetworkSandbox({
      async workspaceNodePeerLabels(context) {
        assert.equal(context.namespace.id, context.revision.namespaceId);
        return peerLabels(context);
      },
      async cleanup() {},
    }),
  });
  Object.assign(driver, { apiClients: Promise.resolve({ objects: {} }) });
  const d = routedRevision(driver, {
    id: "revision-d1",
    agentId: "agent-openshell-d",
    sandboxDriverId: "sandbox-provider",
  });
  const f = { ...d, id: "revision-f1", agentId: "agent-openshell-f" };
  const namespace = kubernetesNamespaceName(d.namespaceId);
  const target = { name: namespace, plane: "execution" } as const;
  const render = async (
    revision: AgentRevision,
    preparation?: { anyRevision: boolean; predecessorRevisionId: string },
  ) =>
    renderedPolicies(await driver["agentNetworkPoliciesWithPeers"](revision, target, preparation));
  type Policy = Awaited<ReturnType<typeof render>>[number];
  function ingressOf(policies: readonly Policy[], revision: AgentRevision) {
    const name = `allow-gateway-workspace-node-${digest(revision.agentId)}`;
    const policy = policies.find(({ metadata }) => metadata.name === name);
    assert.ok(policy, `expected ${name}`);
    return policy;
  }
  const supervisor = (id: string | undefined, sourceNamespace = namespace) => ({
    namespace: sourceNamespace,
    labels: {
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/component": "supervisor",
      "openshell.ai/boundary-role": "supervisor",
      ...(id === undefined ? {} : { "openshell.ai/sandbox-id": `sandbox-${id}` }),
    },
  });
  // NetworkPolicies are additive: a connection is admitted if any policy selecting
  // the Gateway Pod admits the source on the Gateway port.
  const admitted = (
    policies: readonly Policy[],
    gatewayLabels: Record<string, string>,
    source: ReturnType<typeof supervisor>,
    port = 8080,
  ) =>
    policies.some((policy) => {
      const spec = resourceRecord(policy.spec, "policy spec");
      const policyTypes = spec.policyTypes ?? [];
      assert.ok(Array.isArray(policyTypes));
      return (
        policyTypes.includes("Ingress") &&
        selectorMatches(podSelector(policy), gatewayLabels) &&
        resourceRecords(spec.ingress ?? [], "ingress").some(
          (rule) =>
            resourceRecords(rule.from, "ingress peers").some(
              (peer) =>
                selectorMatches(resourceRecord(peer.namespaceSelector, "peer namespaceSelector"), {
                  "kubernetes.io/metadata.name": source.namespace,
                }) &&
                selectorMatches(
                  resourceRecord(peer.podSelector, "peer podSelector"),
                  source.labels,
                ),
            ) && resourceRecords(rule.ports, "ingress ports").some((entry) => entry.port === port),
        )
      );
    });
  const dPolicies = await render(d);
  const fPolicies = await render(f);
  const all = [...dPolicies, ...fPolicies];
  const gatewayLabels = (revision: AgentRevision) => ({
    "openclaw.dev/namespace": revision.namespaceId,
    "openclaw.dev/workload-role": "gateway",
    "openclaw.dev/agent": revision.agentId,
    [ORDINARY_PROFILE_LABEL]: ORDINARY_PROFILE,
  });
  const dGateway = gatewayLabels(d);
  const fGateway = gatewayLabels(f);
  assert.equal(admitted(all, dGateway, supervisor("d1")), true, "D's own supervisor");
  assert.equal(admitted(all, fGateway, supervisor("f1")), true, "F's own supervisor");
  assert.equal(admitted(all, dGateway, supervisor("f1")), false, "F's supervisor -> D's Gateway");
  assert.equal(admitted(all, fGateway, supervisor("d1")), false, "D's supervisor -> F's Gateway");
  assert.equal(admitted(all, dGateway, supervisor(undefined)), false, "an unscoped supervisor");
  assert.equal(admitted(all, dGateway, supervisor("d1", "other-tenant")), false, "other tenant");
  assert.equal(admitted(all, dGateway, supervisor("d1"), 8081), false, "another port");
  // The supervisor's egress is OpenShell's own: no Compute policy selects it.
  for (const policy of all) {
    assert.equal(
      selectorMatches(podSelector(policy), supervisor("d1").labels),
      false,
      policy.metadata.name,
    );
  }

  // Preparing D's successor while rev-d1 serves keeps that supervisor connected.
  const d2 = { ...d, id: "revision-d2", revision: d.revision + 1 };
  const preparing = await render(d2, { anyRevision: true, predecessorRevisionId: d.id });
  assert.equal(admitted(preparing, dGateway, supervisor("d1")), true, "serving predecessor");
  assert.equal(admitted(preparing, dGateway, supervisor("d2")), true, "candidate");
  assert.equal(admitted(preparing, dGateway, supervisor("f1")), false, "other Agent");
  // Activation pins the peer to the active revision's Sandbox.
  const active = await render(d2);
  assert.equal(admitted(active, dGateway, supervisor("d2")), true);
  assert.equal(admitted(active, dGateway, supervisor("d1")), false);

  // Before its Sandbox exists a revision admits no relay: an empty `from` would
  // admit every source, so the policy carries no rule at all.
  const unprovisioned = ingressOf(await render({ ...d, id: "revision-d3" }), d);
  assert.deepEqual(policyRules(unprovisioned, "ingress"), []);
  assert.equal(admitted([unprovisioned], dGateway, supervisor("d1")), false);

  // Labels a Driver returns are validated like any configured peer.
  peerLabels = () => ({});
  await assert.rejects(render(d), /Workspace-node peer Pod labels cannot be empty/);
  peerLabels = () => ({ "not a key": "x" });
  await assert.rejects(render(d), /Workspace-node peer label keys/);

  // An OpenShell Driver that cannot name its relay fails closed with a cause.
  const unnamed = new KubernetesComputeDriver(installation(), {
    sandboxDriver: openShellNetworkSandbox({
      async cleanup() {},
    }),
  });
  assert.throws(
    () => unnamed["agentNetworkPolicies"](d, target),
    /OpenShell SandboxDriver must implement workspaceNodePeerLabels/,
  );
}

export async function checkOpenShellPolicyRetirement() {
  const {
    driver,
    revision,
    namespace,
    objects,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(false);
  const context = { ...fixtureContext, secretEnvironment: [] };
  const target = { name: namespace, plane: "execution" } as const;
  const suffix = digest(revision.agentId);
  const policyKey = (name: string) => `NetworkPolicy:${namespace}:${name}`;
  // Render what the OpenShell predecessor's activation wrote.
  const openShell = new KubernetesComputeDriver(routedOptions(openShellPolicyOptions()), {
    sandboxDriver: openShellNetworkSandbox({
      async workspaceNodePeerLabels({ revision: target }) {
        return supervisorPeerLabels(target.id);
      },
    }),
  });
  const predecessor = { ...revision, sandboxDriverId: "sandbox-provider" };
  const pair = [`allow-workspace-node-gateway-${suffix}`, `allow-gateway-workspace-node-${suffix}`];
  // An earlier controller wrote both halves; this one writes only the Gateway ingress.
  const seeded = [
    ...renderedPolicies(
      openShell["agentNetworkPolicies"](predecessor, target, {}, [
        supervisorPeerLabels(predecessor.id),
      ]),
    ),
    openShell["manifest"](
      "networking.k8s.io/v1",
      "NetworkPolicy",
      pair[0],
      { namespaceId: predecessor.namespaceId, agentId: predecessor.agentId },
      target,
    ),
  ];
  assert.deepEqual(
    pair.filter((name) => !seeded.some(({ metadata }) => metadata.name === name)),
    [],
  );
  for (const policy of seeded) {
    objects.set(policyKey(policy.metadata.name), {
      ...structuredClone(policy),
      metadata: { ...structuredClone(policy.metadata), uid: `${policy.metadata.name}-uid` },
    });
  }
  // Another Agent's OpenShell pair in the same namespace must survive.
  const siblings = renderedPolicies(
    openShell["agentNetworkPolicies"](
      { ...predecessor, agentId: "agent-openshell-sibling" },
      target,
    ),
  ).filter(({ metadata }) => metadata.name.startsWith("allow-gateway-workspace-node-"));
  assert.equal(siblings.length, 1);
  for (const policy of siblings) {
    objects.set(policyKey(policy.metadata.name), {
      ...structuredClone(policy),
      metadata: { ...structuredClone(policy.metadata), uid: `${policy.metadata.name}-uid` },
    });
  }

  const successor = { ...revision, id: "plain-successor", revision: revision.revision + 1 };
  const successorContext = { ...context, ...authContext(successor) };
  state.ready = true;
  assert.equal(await prepareUntilReady(driver, successor, successorContext), 1);
  for (const name of pair) {
    assert.equal(objects.has(policyKey(name)), true, `preparation must keep ${name}`);
  }

  await driver.activateRevision(successor, successorContext);
  for (const name of pair) {
    assert.equal(objects.has(policyKey(name)), false, `activation must delete ${name}`);
  }
  const written = new Set(
    renderedPolicies(computeDriver(driver)["agentNetworkPolicies"](successor, target)).map(
      ({ metadata }) => metadata.name,
    ),
  );
  const remaining = [...objects.keys()]
    .filter((name) => name.startsWith(`NetworkPolicy:${namespace}:`) && name.endsWith(suffix))
    .map((name) => name.slice(`NetworkPolicy:${namespace}:`.length));
  assert.deepEqual(
    remaining.filter(
      (name) =>
        !written.has(name) &&
        name !== `allow-agent-auth-${suffix}` &&
        name !== `allow-gateway-channels-${suffix}`,
    ),
    [],
  );
  const gatewayAgent = observedResource(
    objects.get(policyKey(`allow-gateway-agent-${suffix}`)),
    "NetworkPolicy",
  );
  const transportPeer = firstPeerSelector(gatewayAgent, "egress");
  assert.equal(matchLabels(transportPeer)["openclaw.dev/agent"], successor.agentId);
  assert.equal(matchLabels(transportPeer)["openclaw.dev/revision"], successor.id);
  assert.equal(JSON.stringify(gatewayAgent.spec).includes("openshell-system"), false);
  for (const policy of siblings) {
    assert.equal(
      objects.get(policyKey(policy.metadata.name))?.metadata.uid,
      policy.metadata.name + "-uid",
    );
  }

  // A repeated activation has nothing left to trim.
  const policyKeys = () => [...objects.keys()].filter((key) => key.startsWith("NetworkPolicy:"));
  const before = policyKeys();
  await driver.activateRevision(successor, successorContext);
  assert.deepEqual(policyKeys(), before);
}

export async function checkDedicatedPredecessorPolicyRetirement() {
  const {
    driver,
    revision,
    namespace,
    objects,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(true);
  const context = { ...fixtureContext, secretEnvironment: [] };
  const target = { name: namespace, plane: "execution" } as const;
  const suffix = digest(revision.agentId);
  const policyKey = (name: string) => `NetworkPolicy:${namespace}:${name}`;
  const renderer = computeDriver(driver);
  const dedicated = routedRevision(renderer, {
    ...revision,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    configuration: {
      ...revision.configuration,
      agents: { defaults: { model: "codex/gpt-5" } },
    },
  });
  for (const policy of renderedPolicies(renderer["agentNetworkPolicies"](dedicated, target))) {
    objects.set(policyKey(policy.metadata.name), {
      ...structuredClone(policy),
      metadata: { ...structuredClone(policy.metadata), uid: `${policy.metadata.name}-uid` },
    });
  }
  // The dedicated Gateway's Harness transport egress would select the embedded Gateway.
  assert.equal(objects.has(policyKey(`allow-gateway-agent-${suffix}`)), true);

  state.ready = true;
  assert.equal(await prepareUntilReady(driver, revision, context), 1);
  await driver.activateRevision(revision, context);
  assert.equal(objects.has(policyKey(`allow-gateway-agent-${suffix}`)), false);
  const written = new Set(
    renderedPolicies(renderer["agentNetworkPolicies"](revision, target)).map(
      ({ metadata }) => metadata.name,
    ),
  );
  const remaining = [...objects.keys()]
    .filter((name) => name.startsWith(`NetworkPolicy:${namespace}:`) && name.endsWith(suffix))
    .map((name) => name.slice(`NetworkPolicy:${namespace}:`.length));
  assert.deepEqual(
    remaining.filter((name) => !written.has(name) && name !== `allow-gateway-channels-${suffix}`),
    [],
  );
  // The embedded Gateway keeps the model egress it writes under the shared name.
  const runtime = observedResource(
    objects.get(policyKey(`allow-agent-runtime-${suffix}`)),
    "NetworkPolicy",
  );
  assert.equal(matchLabels(podSelector(runtime))["openclaw.dev/workload-role"], "gateway");
}

export async function checkServingPredecessorGrants(embedded: boolean) {
  const {
    driver,
    revision,
    namespace,
    objects,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(embedded, true, { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] });
  const context = { ...fixtureContext, secretEnvironment: [] };
  const suffix = digest(revision.agentId);
  const gatewayNamespace = embedded ? namespace : kubernetesNamespaceName(tenant.id);
  const policy = (target: string, name: string) =>
    observedResource(objects.get(`NetworkPolicy:${target}:${name}-${suffix}`), "NetworkPolicy");
  const harnessLabels = (selected: AgentRevision) => {
    const key = embedded
      ? `Deployment:${namespace}:gateway-${suffix}`
      : `Deployment:${namespace}:agent-${suffix}-rev-${digest(selected.id)}`;
    return templateLabels(observedResource(objects.get(key), "Deployment"));
  };
  const grants = () =>
    embedded
      ? [podSelector(policy(namespace, "allow-plugin-status-proxy"))]
      : [
          firstPeerSelector(policy(gatewayNamespace, "allow-gateway-agent"), "egress"),
          podSelector(policy(namespace, "allow-agent-runtime")),
          podSelector(policy(namespace, "allow-plugin-status-proxy")),
        ];
  state.ready = true;
  assert.equal(await prepareUntilReady(driver, revision, context), 1);
  await driver.activateRevision(revision, context);
  const predecessor = structuredClone(harnessLabels(revision));
  assert.equal(predecessor["openclaw.dev/revision"], revision.id);

  const successor = { ...revision, id: "grant-successor", revision: revision.revision + 1 };
  const successorContext = { ...context, ...authContext(successor) };
  assert.equal(await prepareUntilReady(driver, successor, successorContext), 1);
  for (const selector of grants()) {
    assert.equal(selectorMatches(selector, predecessor), true, JSON.stringify(selector));
    assert.equal(
      selectorMatches(selector, { ...predecessor, "openclaw.dev/agent": "another" }),
      false,
    );
    if (!embedded) {
      assert.equal(selectorMatches(selector, harnessLabels(successor)), true);
    }
  }

  // Activation pins the grants to the revision that now serves.
  await driver.activateRevision(successor, successorContext);
  for (const selector of grants()) {
    assert.equal(selectorMatches(selector, predecessor), false, JSON.stringify(selector));
    assert.equal(selectorMatches(selector, harnessLabels(successor)), true);
  }
}

export async function checkLifecycleCleanupFailurePrecedence() {
  let started = false;
  let cleanups = 0;
  // Embedded: its preparation starts the lifecycle before any write, and activating a successor
  // moves the Agent's Gateway to it, which starts the lifecycle again.
  const {
    driver,
    revision,
    state,
    clients,
    context: fixtureContext,
  } = workspaceSetupFixture(
    true,
    true,
    undefined,
    {},
    {
      lifecycleDrivers: [
        {
          id: "hooks",
          capability: "configuration",
          implementation: "test",
          computeLifecycleHooks: {
            async beforeWorkloadStart() {
              started = true;
            },
            async beforeWorkloadStop() {
              cleanups += 1;
              throw new Error("lifecycle cleanup refused");
            },
          },
        },
      ],
    },
  );
  const context = { ...fixtureContext, secretEnvironment: [] };
  const fullContext = { ...context, ...authContext(revision) };
  // Fail the API write after the lifecycle starts so the real reconciliation and cleanup run.
  const patchDeployment = clients.apps.patchNamespacedDeployment;
  let outage: Error | undefined;
  clients.apps.patchNamespacedDeployment = async (request) => {
    if (started && outage !== undefined) {
      throw outage;
    }
    return patchDeployment(request);
  };
  const failure = (operation: Promise<unknown>): Promise<unknown> =>
    operation.then(
      () => assert.fail("the operation must fail"),
      (error: unknown) => error,
    );

  outage = Object.assign(new Error("Service Unavailable"), { code: 503 });
  const prepared = await failure(driver.prepareRevision(revision, fullContext));
  assertCleanupFailure(prepared, /HTTP 503/, [/lifecycle hook beforeWorkloadStop failed/]);
  assert.ok(prepared instanceof ComputeCleanupFailedError);
  assert.ok(prepared.primary instanceof TransientDependencyError);
  assert.equal(prepared.primary.dependency, "kubernetes_api");
  assert.equal(prepared.primary.cause, outage);
  assert.equal(cleanups, 1);

  outage = undefined;
  state.ready = true;
  await prepareUntilReady(driver, revision, fullContext);
  await driver.activateRevision(revision, fullContext);
  const successor = { ...revision, id: "cleanup-successor", revision: revision.revision + 1 };
  const successorContext = { ...context, ...authContext(successor) };
  started = false;
  outage = new ActivationFailedError("AGENT_GATEWAY_UNAUTHORIZED", "The Gateway refused.");
  const activated = await failure(driver.activateRevision(successor, successorContext));
  assertCleanupFailure(activated, outage, [/lifecycle hook beforeWorkloadStop failed/]);
  assert.equal(cleanups, 2);

  // An API outage in activation stays transient too.
  started = false;
  outage = Object.assign(new Error("Service Unavailable"), { code: 503 });
  const unavailable = await failure(driver.activateRevision(successor, successorContext));
  assertCleanupFailure(unavailable, /HTTP 503/, [/lifecycle hook beforeWorkloadStop failed/]);
  assert.ok(unavailable instanceof ComputeCleanupFailedError);
  assert.ok(unavailable.primary instanceof TransientDependencyError);
  assert.equal(unavailable.primary.cause, outage);
  assert.equal(cleanups, 3);
}

export async function checkNeverServedGatewayRepair() {
  const {
    driver,
    revision,
    namespace,
    objects,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(true);
  const context = { ...fixtureContext, secretEnvironment: [] };
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gatewayKey = `Deployment:${namespace}:${gatewayName}`;
  const serviceKey = `Service:${namespace}:${gatewayName}`;
  assert.equal((await driver.prepareRevision(revision, context)).ready, false);
  assert.equal(
    objects.get(gatewayKey)?.metadata.annotations?.["openclaw.dev/agent-revision-id"],
    revision.id,
  );
  assert.equal(
    serviceSelector(observedResource(objects.get(serviceKey), "Service"))["app.kubernetes.io/name"],
    `${gatewayName}-inactive`,
  );
  const revisionArtifacts = (target: AgentRevision) => [
    `Secret:${namespace}:harness-secrets-${digest(target.agentId)}-${digest(target.id)}`,
    `ConfigMap:${namespace}:${gatewayName}-rev-${digest(target.id)}`,
  ];
  for (const artifact of revisionArtifacts(revision)) {
    assert.ok(objects.has(artifact), `${artifact} is projected for the first deploy`);
  }

  const successor = { ...revision, id: "redeploy-successor", revision: revision.revision + 1 };
  const successorContext = { ...context, ...authContext(successor) };
  assert.equal(successorContext.workspaceSetup.completed, false);
  assert.equal((await driver.prepareRevision(successor, successorContext)).ready, false);
  const repaired = objects.get(gatewayKey);
  assert.equal(repaired?.metadata.annotations?.["openclaw.dev/agent-revision-id"], successor.id);
  // The repaired Gateway no longer runs the failed predecessor, so its credential
  // and configuration copies go now rather than on stop or delete.
  for (const artifact of revisionArtifacts(revision)) {
    assert.equal(objects.has(artifact), false, `${artifact} is removed once superseded`);
  }
  for (const artifact of revisionArtifacts(successor)) {
    assert.ok(objects.has(artifact), `${artifact} is kept for the repairing successor`);
  }
  assert.equal(
    serviceSelector(observedResource(objects.get(serviceKey), "Service"))["app.kubernetes.io/name"],
    `${gatewayName}-inactive`,
    "the repaired Gateway stays unserved until activation",
  );

  state.ready = true;
  assert.equal(await prepareUntilReady(driver, successor, successorContext), 1);
  await driver.activateRevision(successor, successorContext);
  assert.equal(
    objects.get(gatewayKey)?.metadata.annotations?.["openclaw.dev/agent-revision-id"],
    successor.id,
  );
}

export function checkGatewayToolPolicyAdmission() {
  const driver = new KubernetesComputeDriver(options());
  const { harnessAuth } = routedRevision(driver);
  const rejectedPolicies: readonly (readonly [OpenClawConfigurationValue, RegExp])[] = [
    [{ allow: ["plugins"] }, /must not grant Gateway administrative tools/],
    [{ allow: ["gateway_exec"] }, /must not grant Gateway administrative tools/],
    [{ allow: ["group:runtime"] }, /concrete tool/],
    [{ allow: ["message"], actions: { message: ["set-profile"] } }, /reviewed task actions/],
    [{ allow: ["sessions"] }, /actions.sessions must list/],
    // The pinned OpenClaw fails every turn's tool assembly for an action-bearing tool
    // allowed without actions (finding 2679), so save refuses it.
    [{ allow: ["dashboard"] }, /actions.dashboard must list/],
    [null, /must be an object/],
  ];
  const acceptedPolicies: readonly (OpenClawConfigurationValue | undefined)[] = [
    undefined,
    { allow: [] },
    { allow: ["sessions", "diffs"], actions: { sessions: ["patch"] } },
    { allow: ["dashboard"], actions: { dashboard: ["read"] } },
  ];
  // The embedded Gateway applies the policy natively too, so it gets the same checks (finding
  // 2688), and Configuration save, which knows no topology, refuses the same policies with the
  // same text (finding 2689).
  const topologies: readonly (readonly [string, HarnessExecutionMode])[] = [
    ["openclaw", "dedicated"],
    ["codex", "dedicated"],
    ["openclaw", "embedded"],
  ];
  for (const [id, mode] of topologies) {
    const harness = { id, version: "1.0.0", mode };
    const config = createHarnessConfiguration(id, "gpt-4o-mini");
    const withPolicy = (
      gatewayPolicy: OpenClawConfigurationValue | undefined,
    ): OpenClawConfigurationDocument => ({
      ...config,
      tools: gatewayPolicy === undefined ? {} : { gatewayPolicy },
    });
    for (const [gatewayPolicy, expected] of rejectedPolicies) {
      const label = `${id} ${mode} ${JSON.stringify(gatewayPolicy)}`;
      assert.throws(
        () => driver.validateHarnessAuth(harness, harnessAuth, withPolicy(gatewayPolicy), null),
        { name: "ConfigurationHarnessError", message: expected },
        label,
      );
      assert.throws(
        () => driver.validateConfiguration(withPolicy(gatewayPolicy)),
        { name: "ConfigurationHarnessError", message: expected },
        label,
      );
    }
    for (const gatewayPolicy of acceptedPolicies) {
      const label = `${id} ${mode} ${JSON.stringify(gatewayPolicy)}`;
      assert.doesNotThrow(
        () => driver.validateHarnessAuth(harness, harnessAuth, withPolicy(gatewayPolicy), null),
        label,
      );
      assert.doesNotThrow(() => driver.validateConfiguration(withPolicy(gatewayPolicy)), label);
    }
  }
}

export async function checkWorkspaceNodePolicyMaintenance() {
  // Finding 3083. Admission now refuses plugins.enabled false for an Agent whose Gateway hosts its
  // workspace node. A revision admitted before that rule must keep its maintenance and recovery
  // passes (preparation and activation of the active revision) until a redeploy, which admission
  // refuses.
  const {
    driver,
    revision: admitted,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(false);
  const context = { ...fixtureContext, secretEnvironment: [] };
  const revision = {
    ...admitted,
    configuration: {
      ...structuredClone(admitted.configuration),
      plugins: { enabled: false },
    },
  };
  state.ready = true;
  await prepareUntilReady(driver, revision, context);
  await driver.activateRevision(revision, context);
  assert.equal((await driver.prepareRevision(revision, context)).ready, true);
  await driver.activateRevision(revision, context);
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        revision.configuration,
        revision.secretBindings,
      ),
    { message: workspaceNodePluginRefusal("plugins.enabled", "must not be false") },
    "a new deployment",
  );
}

export async function checkStoredGatewayToolPolicyMaintenance() {
  // Finding 2694. The worker prepares and activates the active revision again on maintenance
  // and recovery passes (every 30 s with repository credentials). A revision admitted before
  // Agent admission checked the embedded policy must keep those passes until a redeploy, which
  // admission refuses with the Configuration save text.
  const {
    driver,
    revision: admitted,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(true);
  const context = { ...fixtureContext, secretEnvironment: [] };
  const revision = {
    ...admitted,
    configuration: {
      ...structuredClone(admitted.configuration),
      tools: { gatewayPolicy: { allow: ["sessions"] } },
    },
  };
  state.ready = true;
  await prepareUntilReady(driver, revision, context);
  await driver.activateRevision(revision, context);
  // The maintenance pass: preparation and activation of the same, now active, revision.
  assert.equal((await driver.prepareRevision(revision, context)).ready, true);
  await driver.activateRevision(revision, context);
  const refused = {
    name: "ConfigurationHarnessError",
    message: /tools\.gatewayPolicy\.actions\.sessions must list the permitted actions/,
  };
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        revision.harness,
        revision.harnessAuth,
        revision.configuration,
        revision.secretBindings,
      ),
    refused,
    "a new deployment",
  );
  assert.throws(() => driver.validateConfiguration(revision.configuration), refused, "save");
}
