import assert from "node:assert/strict";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
  KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  AgentRevision,
  ComputeRevisionContext,
  HarnessExecutionMode,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import {
  authContext,
  digest,
  gatewayRouting,
  preparedAuth,
  routedOptions,
  routedRevision,
  selectorMatches,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

type Labels = Record<string, string>;
type FixtureResource = NonNullable<
  ReturnType<ReturnType<typeof workspaceSetupFixture>["objects"]["get"]>
>;
type ResourceSpec = { metadata: object; spec?: unknown };

type RenderedPolicy = {
  kind: "NetworkPolicy";
  metadata: { name: string; namespace?: string; uid?: string; resourceVersion?: string };
  spec: Record<string, unknown>;
};

export function isNetworkPolicy(value: unknown): value is RenderedPolicy {
  const resource = asRecord(value);
  const metadata = asRecord(resource?.metadata);
  return (
    resource?.kind === "NetworkPolicy" &&
    typeof metadata?.name === "string" &&
    (metadata.namespace === undefined || typeof metadata.namespace === "string") &&
    (metadata.uid === undefined || typeof metadata.uid === "string") &&
    (metadata.resourceVersion === undefined || typeof metadata.resourceVersion === "string") &&
    asRecord(resource.spec) !== undefined
  );
}

export function renderedPolicies(entries: unknown): RenderedPolicy[] {
  assert.ok(Array.isArray(entries));
  return entries.map((entry: unknown) => {
    const resource = resourceRecord(entry, "targeted policy").resource;
    assert.ok(isNetworkPolicy(resource), "expected a rendered NetworkPolicy");
    return resource;
  });
}

export function computeDriver(value: unknown) {
  assert.ok(value instanceof KubernetesComputeDriver);
  return value;
}

export function resourceRecord(value: unknown, field: string) {
  const record = asRecord(value);
  assert.ok(record, `expected ${field} to be an object`);
  return record;
}

export function resourceRecords(value: unknown, field: string) {
  assert.ok(Array.isArray(value), `expected ${field} to be an array`);
  return value.map((entry: unknown) => resourceRecord(entry, field));
}

export function observedResource(resource: FixtureResource | undefined, kind: string) {
  assert.ok(resource, `expected stored ${kind}`);
  assert.equal(resource.kind, kind);
  return resource;
}

function labelValues(value: unknown): value is Labels {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every((label) => typeof label === "string");
}

function resourceLabels(value: unknown, field: string) {
  assert.ok(labelValues(value), `expected ${field} to contain string labels`);
  return value;
}

export function podSelector(resource: ResourceSpec) {
  return resourceRecord(resourceRecord(resource.spec, "policy spec").podSelector, "pod selector");
}

function podTemplate(resource: ResourceSpec) {
  return resourceRecord(resourceRecord(resource.spec, "Deployment spec").template, "Pod template");
}

function templateMetadata(resource: ResourceSpec) {
  return resourceRecord(podTemplate(resource).metadata, "Pod template metadata");
}

export function templateLabels(resource: ResourceSpec) {
  return resourceLabels(templateMetadata(resource).labels, "Pod template labels");
}

export function policyRules(resource: ResourceSpec, direction: "egress" | "ingress") {
  return resourceRecords(resourceRecord(resource.spec, "policy spec")[direction], direction);
}

function policyPeers(rule: Record<string, unknown> | undefined, direction: "to" | "from") {
  assert.ok(rule, `expected policy rule with ${direction} peers`);
  return resourceRecords(rule[direction], direction);
}

export function matchLabels(selector: Record<string, unknown>) {
  return resourceLabels(selector.matchLabels, "selector matchLabels");
}

export function serviceSelector(resource: ResourceSpec) {
  return resourceLabels(resourceRecord(resource.spec, "Service spec").selector, "Service selector");
}

export function firstPeerSelector(resource: ResourceSpec, direction: "ingress" | "egress") {
  const peers = policyPeers(
    policyRules(resource, direction)[0],
    direction === "ingress" ? "from" : "to",
  );
  return resourceRecord(peers[0]?.podSelector, "peer podSelector");
}

export const ORDINARY_PROFILE_LABEL = "openclaw.dev/network-profile";

export const ORDINARY_PROFILE = "broad-egress-v1";

export const UNAPPROVED_PROFILES: readonly (string | undefined)[] = [
  undefined,
  "",
  "unknown-profile",
];

export function withProfile(labels: Labels | undefined, profile: string | undefined) {
  const changed = { ...labels };
  if (profile === undefined) {
    delete changed[ORDINARY_PROFILE_LABEL];
  } else {
    changed[ORDINARY_PROFILE_LABEL] = profile;
  }
  return changed;
}

export function profileNetworkDriver() {
  return createKubernetesComputeDriver(
    routedOptions({
      network: {
        pluginStatusProxySourceCidrs: ["192.0.2.20/32"],
        repositoryCredentials: {
          namespace: "repository-service",
          podLabels: { app: "repository" },
          port: 8443,
        },
      },
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://192.0.2.15:3128" },
      },
    }),
  );
}

export function profileNetworkRevision(
  driver: KubernetesComputeDriver,
  mode: HarnessExecutionMode,
): AgentRevision {
  const base = routedRevision(driver);
  const embedded = mode === "embedded";
  const configuration = {
    ...base.configuration,
    agents: { defaults: { model: embedded ? "openai/gpt-5" : "codex/gpt-5" } },
  };
  const harness = { id: embedded ? "openclaw" : "codex", version: "1.0.0", mode, overrides: {} };
  return {
    ...base,
    id: `revision-network-${mode}`,
    agentId: `agent-network-${mode}`,
    servicePrincipalId: `principal-network-${mode}`,
    harness: {
      ...harness,
      configuration: driver.resolveHarnessConfiguration(harness, base.harnessAuth, configuration),
    },
    configuration,
    plugins: {
      driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
      plugins: { "codex-plugin:example": { enabled: true } },
    },
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-credentials" },
      deadlineWallMs: Date.now() + 60_000,
      bindings: [
        {
          repositoryRef: "project",
          profile: "read",
          backendId: "github",
          grant: { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" },
        },
      ],
    },
  };
}

export function profileNetworkWorkload(
  driver: KubernetesComputeDriver,
  revision: AgentRevision,
  role: "gateway" | "agent",
) {
  const embedded = revision.harness.mode === "embedded";
  const executionNamespace = {
    name: kubernetesNamespaceName(revision.namespaceId),
    plane: "execution",
  } as const;
  const namespace =
    role === "gateway" && !embedded
      ? ({ name: kubernetesNamespaceName(revision.namespaceId), plane: "control" } as const)
      : executionNamespace;
  const ownership =
    role === "gateway"
      ? { namespaceId: revision.namespaceId, agentId: revision.agentId }
      : {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          servicePrincipalId: revision.servicePrincipalId,
          revisionId: revision.id,
        };
  return driver["deployment"](
    `network-${role}`,
    ownership,
    namespace,
    `${role}:local`,
    `network-${role}`,
    role,
    {},
    "info",
    role === "gateway"
      ? driver["gatewayConfiguration"](revision, undefined, executionNamespace)
      : undefined,
    role === "gateway" && embedded,
    role === "gateway" && embedded ? revision.servicePrincipalId : undefined,
    role === "agent" || embedded
      ? preparedAuth(driver, executionNamespace.name, embedded)
      : undefined,
  );
}

export function checkWorkloadTemplateProfiles() {
  const driver = profileNetworkDriver();
  for (const [mode, role] of [
    ["embedded", "gateway"],
    ["dedicated", "gateway"],
    ["dedicated", "agent"],
  ] as const) {
    const workload = profileNetworkWorkload(driver, profileNetworkRevision(driver, mode), role);
    assert.equal(
      templateLabels(workload)[ORDINARY_PROFILE_LABEL],
      ORDINARY_PROFILE,
      `${mode} ${role} template must be classified`,
    );
    assert.equal(templateLabels(workload)["openclaw.dev/workload-role"], role);
    // The Deployment selector is immutable; the profile must never become part of it.
    assert.equal(
      resourceLabels(
        resourceRecord(
          resourceRecord(workload.spec, "Deployment spec").selector,
          "Deployment selector",
        ).matchLabels,
        "Deployment matchLabels",
      )[ORDINARY_PROFILE_LABEL],
      undefined,
    );
    assert.equal(workload.metadata.labels?.[ORDINARY_PROFILE_LABEL], undefined);
  }
}

export function checkProfileReadiness() {
  const driver = profileNetworkDriver();
  for (const [mode, role] of [
    ["embedded", "gateway"],
    ["dedicated", "gateway"],
    ["dedicated", "agent"],
  ] as const) {
    const workload = profileNetworkWorkload(driver, profileNetworkRevision(driver, mode), role);
    workload.metadata.generation = 1;
    const ready = {
      ...workload,
      status: { observedGeneration: 1, readyReplicas: workload.spec?.replicas },
    };
    assert.equal(driver["deploymentReady"](ready), true, `${mode} ${role} must be ready`);
    for (const profile of UNAPPROVED_PROFILES) {
      const unapproved = structuredClone(ready);
      templateMetadata(unapproved).labels = withProfile(templateLabels(unapproved), profile);
      assert.equal(
        driver["deploymentReady"](unapproved),
        false,
        `${mode} ${role} with profile ${JSON.stringify(profile)} must not be ready`,
      );
    }
  }
}

export function checkSandboxPreviewIngressProfile() {
  const driver = createKubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      gatewayRouting: {
        ...gatewayRouting,
        sandbox: { domain: "previews.example.test", publicPort: 9443 },
      },
    }),
  );
  const revision = profileNetworkRevision(driver, "dedicated");
  const serving = profileNetworkWorkload(driver, revision, "gateway");
  const labels = templateLabels(serving);
  const metadata = {
    name: "gateway-sandbox",
    namespace: kubernetesNamespaceName(tenant.id),
  };
  const routing = driver["options"].gatewayRouting;
  assert.ok(routing);
  const selector = podSelector(
    driver["gatewaySandboxNetworkPolicy"](revision, metadata, routing, serving),
  );
  assert.equal(matchLabels(selector)[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  assert.equal(selectorMatches(selector, labels), true);
  for (const profile of UNAPPROVED_PROFILES) {
    assert.equal(selectorMatches(selector, withProfile(labels, profile)), false);
  }
  // A serving Gateway from a pre-profile template keeps preview ingress until
  // activation replaces it.
  const legacy = structuredClone(serving);
  templateMetadata(legacy).labels = withProfile(labels, undefined);
  const legacySelector = podSelector(
    driver["gatewaySandboxNetworkPolicy"](revision, metadata, routing, legacy),
  );
  assert.equal(matchLabels(legacySelector)[ORDINARY_PROFILE_LABEL], undefined);
  assert.equal(selectorMatches(legacySelector, templateLabels(legacy)), true);
  assert.equal(matchLabels(legacySelector)["openclaw.dev/workload-role"], "gateway");
  assert.equal(matchLabels(legacySelector)["openclaw.dev/agent"], revision.agentId);
}

export function checkExactModelAndHarnessRoutes() {
  const driver = profileNetworkDriver();
  const dedicated = profileNetworkRevision(driver, "dedicated");
  const embedded = profileNetworkRevision(driver, "embedded");
  const execution = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const find = (revision: AgentRevision, prefix: string) => {
    const name = `${prefix}-${digest(revision.agentId)}`;
    const policy = renderedPolicies(driver["agentNetworkPolicies"](revision, execution)).find(
      ({ metadata }) => metadata.name === name,
    );
    assert.ok(policy, `expected ${name}`);
    return policy;
  };
  const gateway = find(dedicated, "allow-gateway-agent");
  const agent = find(dedicated, "allow-agent-runtime");
  const embeddedRuntime = find(embedded, "allow-agent-runtime");
  const auth = driver["agentAuthenticationNetworkPolicy"](dedicated, execution);
  const agentEgress = policyRules(agent, "egress");
  assert.deepEqual(agentEgress, policyRules(embeddedRuntime, "egress"));
  assert.deepEqual(policyRules(auth, "egress"), agentEgress);
  assert.deepEqual(agentEgress[0], {
    to: [
      {
        ipBlock: {
          cidr: "0.0.0.0/0",
          except: [
            "10.0.0.0/8",
            "100.64.0.0/10",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
          ],
        },
      },
    ],
    ports: [{ protocol: "TCP", port: 443 }],
  });
  const agentIngress = policyRules(agent, "ingress");
  assert.equal(agentIngress.length, 1);
  const [transportEgress] = policyRules(gateway, "egress");
  const [transportIngress] = agentIngress;
  assert.ok(transportEgress && transportIngress);
  assert.deepEqual(
    resourceRecords(transportEgress.ports, "Gateway transport ports"),
    resourceRecords(transportIngress.ports, "Harness transport ports"),
  );

  const agentLabels = templateLabels(profileNetworkWorkload(driver, dedicated, "agent"));
  const gatewayLabels = templateLabels(profileNetworkWorkload(driver, dedicated, "gateway"));
  const embeddedLabels = templateLabels(profileNetworkWorkload(driver, embedded, "gateway"));
  assert.equal(selectorMatches(podSelector(embeddedRuntime), embeddedLabels), true);
  for (const [selector, labels] of [
    [podSelector(gateway), gatewayLabels],
    [firstPeerSelector(gateway, "egress"), agentLabels],
    [podSelector(agent), agentLabels],
    [firstPeerSelector(agent, "ingress"), gatewayLabels],
    [podSelector(auth), agentLabels],
  ] as const) {
    assert.equal(selectorMatches(selector, labels), true);
    for (const profile of UNAPPROVED_PROFILES) {
      assert.equal(selectorMatches(selector, withProfile(labels, profile)), false);
    }
  }
  // The profile widens nothing: revision and Agent scope still bind the grants.
  assert.equal(
    selectorMatches(podSelector(agent), {
      ...agentLabels,
      "openclaw.dev/revision": "revision-network-other",
    }),
    false,
  );
  assert.equal(
    selectorMatches(podSelector(auth), { ...agentLabels, "openclaw.dev/agent": "another" }),
    false,
  );
}

export function checkDetachedProfileSelectors() {
  const driver = profileNetworkDriver();
  const revision = profileNetworkRevision(driver, "dedicated");
  const execution = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const runtimeName = `allow-agent-runtime-${digest(revision.agentId)}`;
  function runtimeLabels() {
    const policy = renderedPolicies(driver["agentNetworkPolicies"](revision, execution)).find(
      ({ metadata }) => metadata.name === runtimeName,
    );
    assert.ok(policy, `expected ${runtimeName}`);
    return matchLabels(podSelector(policy));
  }
  const first = runtimeLabels();
  delete first[ORDINARY_PROFILE_LABEL];
  first["openclaw.dev/agent"] = "mutated";
  const second = runtimeLabels();
  assert.equal(second[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  assert.equal(second["openclaw.dev/agent"], revision.agentId);
}

export async function prepareUntilReady(
  driver: Pick<KubernetesComputeDriver, "prepareRevision">,
  revision: AgentRevision,
  context: ComputeRevisionContext,
  limit = 4,
) {
  for (let pass = 1; pass <= limit; pass += 1) {
    if ((await driver.prepareRevision(revision, context)).ready) {
      return pass;
    }
  }
  assert.fail(`${revision.id} did not become ready within ${limit} preparation passes`);
}

function preProfilePolicy(policy: RenderedPolicy) {
  const legacy = structuredClone(policy);
  legacy.metadata.uid = `${policy.metadata.namespace}-${policy.metadata.name}-legacy-uid`;
  legacy.metadata.resourceVersion = "1";
  const spec = resourceRecord(legacy.spec, "legacy policy spec");
  spec.podSelector =
    policy.metadata.name === "allow-dns" || policy.metadata.name === "default-deny"
      ? {}
      : { matchLabels: withProfile(matchLabels(podSelector(policy)), undefined) };
  if (policy.metadata.name === "allow-dns") {
    const [dns] = policyRules(legacy, "egress");
    assert.ok(dns);
    dns.ports = resourceRecords(dns.ports, "DNS ports").filter(({ port }) => port === 53);
  }
  return legacy;
}

export async function checkPreProfileNamespaceGrants(embedded: boolean) {
  const {
    driver,
    revision,
    namespace,
    objects,
    records,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(embedded);
  const context = { ...fixtureContext, secretEnvironment: [] };
  const renderer = computeDriver(driver);
  const execution = { name: namespace, plane: "execution" } as const;
  const control = { name: kubernetesNamespaceName(tenant.id), plane: "control" } as const;
  const ownership = { namespaceId: tenant.id };
  const legacy = [
    ...renderer["networkPolicies"](ownership, execution),
    ...renderer["networkPolicies"](ownership, control),
    renderer["workspaceNodeNetworkPolicy"](ownership, execution),
  ].map((policy: unknown) => {
    assert.ok(isNetworkPolicy(policy), "expected a rendered NetworkPolicy");
    return preProfilePolicy(policy);
  });
  for (const policy of legacy) {
    objects.set(`NetworkPolicy:${policy.metadata.namespace}:${policy.metadata.name}`, policy);
  }

  state.ready = true;
  assert.equal(await prepareUntilReady(driver, revision, context), 1);

  const stored = (name: string, namespace: string | undefined) =>
    observedResource(objects.get(`NetworkPolicy:${namespace}:${name}`), "NetworkPolicy");
  for (const policy of legacy) {
    const current = stored(policy.metadata.name, policy.metadata.namespace);
    assert.equal(current.metadata.uid, policy.metadata.uid);
    const expected = structuredClone(resourceRecord(policy.spec, "legacy policy spec"));
    if (
      policy.metadata.name === "allow-dns" &&
      (policy.metadata.namespace === namespace || !embedded)
    ) {
      const [dns] = policyRules({ metadata: policy.metadata, spec: expected }, "egress");
      assert.ok(dns);
      dns.ports = [
        ...resourceRecords(dns.ports, "DNS ports"),
        { protocol: "UDP", port: 5353 },
        { protocol: "TCP", port: 5353 },
      ];
    }
    assert.deepEqual(current.spec, expected, `${policy.metadata.name} must keep its selector`);
  }
  const namespaceWide = new Set(legacy.map(({ metadata }) => metadata.name));
  assert.equal(
    records.some(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" &&
        namespaceWide.has(metadata.name) &&
        metadata.name !== "allow-node-gateway" &&
        metadata.name !== "allow-dns",
    ),
    false,
    "preparation must not write namespace-wide deny or Gateway ingress policies",
  );
  if (!embedded) {
    // The workspace-node policy is reconciled on every dedicated preparation.
    assert.equal(
      records.some(({ metadata }) => metadata.name === "allow-node-gateway"),
      true,
    );
  }

  // Pods from the prepared Agent's new templates carry the profile; its
  // previous Pods and every other Agent's Pods predate it.
  const templates = [...objects.values()]
    .filter(({ kind }) => kind === "Deployment")
    .map(templateLabels);
  assert.equal(templates.length, embedded ? 1 : 2);
  for (const labels of templates) {
    assert.equal(labels[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  }
  const others = ["gateway", "agent"].map((role) => ({
    "openclaw.dev/namespace": tenant.id,
    "openclaw.dev/workload-role": role,
    "openclaw.dev/agent": "another-agent",
    "openclaw.dev/revision": "another-revision",
  }));
  const pods = [
    ...templates,
    ...templates.map((labels) => withProfile(labels, undefined)),
    ...others,
  ];
  const byName = (name: string, namespace: string) => podSelector(stored(name, namespace));
  const policyNamespaces = new Set([execution.name, control.name]);
  for (const labels of pods) {
    const role = labels["openclaw.dev/workload-role"];
    for (const namespace of policyNamespaces) {
      assert.equal(selectorMatches(byName("allow-dns", namespace), labels), true);
      assert.equal(
        selectorMatches(byName("allow-gateway-ingress", namespace), labels),
        role === "gateway",
      );
    }
    assert.equal(
      selectorMatches(byName("allow-node-gateway", execution.name), labels),
      role === "agent",
    );
  }

  // Per-Agent grants are re-rendered with the profile and select the new templates.
  const perAgent = records.filter(
    ({ kind, metadata }) => kind === "NetworkPolicy" && !namespaceWide.has(metadata.name),
  );
  assert.notEqual(perAgent.length, 0);
  for (const policy of perAgent) {
    const selector = podSelector(policy);
    assert.equal(matchLabels(selector)[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
    assert.equal(
      templates.some((labels) => selectorMatches(selector, labels)),
      true,
      `${policy.metadata.name} must select a prepared template`,
    );
    assert.equal(
      others.some((labels) => selectorMatches(selector, labels)),
      false,
      `${policy.metadata.name} must not select another Agent`,
    );
  }

  // New namespaces are narrowed: unprofiled Pods receive no ordinary grant.
  for (const policy of [
    ...renderer["networkPolicies"](ownership, execution),
    renderer["workspaceNodeNetworkPolicy"](ownership, execution),
  ]) {
    if (policy.metadata.name === "default-deny") {
      continue;
    }
    for (const labels of others) {
      assert.equal(selectorMatches(podSelector(policy), labels), false);
    }
  }
}

export async function checkWorkspaceNodePolicyNarrowing() {
  const {
    driver,
    revision,
    namespace,
    objects,
    context: fixtureContext,
  } = workspaceSetupFixture(false);
  const context = { ...fixtureContext, secretEnvironment: [] };
  const key = `NetworkPolicy:${namespace}:allow-node-gateway`;
  const current: unknown = computeDriver(driver)["workspaceNodeNetworkPolicy"](
    { namespaceId: tenant.id },
    { name: namespace, plane: "execution" },
  );
  assert.ok(isNetworkPolicy(current));
  const expected = {
    matchLabels: { "openclaw.dev/workload-role": "agent" },
    matchExpressions: [
      {
        key: ORDINARY_PROFILE_LABEL,
        operator: "In",
        values: [ORDINARY_PROFILE, "provider-fenced-v1"],
      },
    ],
  };
  for (const selector of [podSelector(current), {}]) {
    const seeded = structuredClone(current);
    seeded.metadata.uid = "node-policy-uid";
    resourceRecord(seeded.spec, "policy spec").podSelector = structuredClone(selector);
    objects.set(key, seeded);
    await driver.prepareRevision(revision, context);
    // The profiled grant stays narrow, including after repair of an empty selector.
    assert.deepEqual(podSelector(observedResource(objects.get(key), "NetworkPolicy")), expected);
  }
}

export async function checkPreProfileEmbeddedModelEgress() {
  const {
    driver,
    revision,
    namespace,
    objects,
    records,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(true);
  const context = { ...fixtureContext, secretEnvironment: [] };
  await driver.prepareRevision(revision, context);
  const gatewayKey = `Deployment:${namespace}:gateway-${digest(revision.agentId)}`;
  const runtimeKey = `NetworkPolicy:${namespace}:allow-agent-runtime-${digest(revision.agentId)}`;
  // The serving Gateway was rendered before the explicit profile existed.
  const serving = observedResource(objects.get(gatewayKey), "Deployment");
  templateMetadata(serving).labels = withProfile(templateLabels(serving), undefined);
  const servingLabels = templateLabels(serving);
  const replacement = { ...revision, id: "embedded-replacement", revision: revision.revision + 1 };
  const replacementContext = { ...context, ...authContext(replacement) };
  records.length = 0;
  state.ready = true;
  // The serving Gateway is observed, not replaced, so the first pass is ready.
  assert.equal(await prepareUntilReady(driver, replacement, replacementContext), 1);
  const runtimeSelector = () =>
    podSelector(observedResource(objects.get(runtimeKey), "NetworkPolicy"));
  const retained = runtimeSelector();
  assert.equal(matchLabels(retained)[ORDINARY_PROFILE_LABEL], undefined);
  assert.equal(selectorMatches(retained, servingLabels), true);
  assert.equal(
    selectorMatches(retained, { ...servingLabels, "openclaw.dev/agent": "other" }),
    false,
  );
  assert.deepEqual(
    templateLabels(observedResource(objects.get(gatewayKey), "Deployment")),
    servingLabels,
  );

  // Activation replaces the Gateway with a profiled template, then narrows the grant.
  await driver.activateRevision(replacement, replacementContext);
  const replaced = templateLabels(observedResource(objects.get(gatewayKey), "Deployment"));
  assert.equal(replaced[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  const narrowed = runtimeSelector();
  assert.equal(matchLabels(narrowed)[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  assert.equal(selectorMatches(narrowed, servingLabels), false);
  assert.equal(selectorMatches(narrowed, replaced), true);

  // With a profiled Gateway serving, preparation keeps the grant narrowed.
  const next = { ...replacement, id: "embedded-next", revision: replacement.revision + 1 };
  assert.equal(await prepareUntilReady(driver, next, { ...context, ...authContext(next) }), 1);
  assert.equal(matchLabels(runtimeSelector())[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
}

export async function checkPreProfileGatewayUpgrade(embedded: boolean) {
  const {
    driver,
    revision,
    namespace,
    objects,
    records,
    state,
    context: fixtureContext,
  } = workspaceSetupFixture(embedded);
  const context = { ...fixtureContext, secretEnvironment: [] };
  const gatewayNamespace = embedded ? namespace : kubernetesNamespaceName(tenant.id);
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gatewayKey = `Deployment:${gatewayNamespace}:${gatewayName}`;
  const agentServiceKey = `Service:${namespace}:agent-${digest(revision.agentId)}`;
  const gatewayAgentKey = `NetworkPolicy:${gatewayNamespace}:allow-gateway-agent-${digest(revision.agentId)}`;
  const runtimeKey = `NetworkPolicy:${namespace}:allow-agent-runtime-${digest(revision.agentId)}`;
  state.ready = true;
  assert.equal(await prepareUntilReady(driver, revision, context), 1);
  await driver.activateRevision(revision, context);

  const serving = observedResource(objects.get(gatewayKey), "Deployment");
  templateMetadata(serving).labels = withProfile(templateLabels(serving), undefined);
  const servingLabels = structuredClone(templateLabels(serving));
  const servingTemplate = structuredClone(podTemplate(serving));
  const agentSelector = () =>
    serviceSelector(observedResource(objects.get(agentServiceKey), "Service"));
  const gatewayAgentSelector = () =>
    podSelector(observedResource(objects.get(gatewayAgentKey), "NetworkPolicy"));
  const runtimePeer = () =>
    firstPeerSelector(observedResource(objects.get(runtimeKey), "NetworkPolicy"), "ingress");
  const stableSelector = embedded ? undefined : structuredClone(agentSelector());
  if (!embedded) {
    assert.equal(stableSelector?.["openclaw.dev/revision"], revision.id);
  }

  const successor = { ...revision, id: "upgrade-successor", revision: revision.revision + 1 };
  // The pending workspace setup keeps embedded preparation on the Gateway readiness path.
  const successorContext = { ...context, ...authContext(successor) };
  assert.equal(successorContext.workspaceSetup.completed, false);
  records.length = 0;
  assert.equal(await prepareUntilReady(driver, successor, successorContext), 1);
  const gateway = observedResource(objects.get(gatewayKey), "Deployment");
  assert.deepEqual(podTemplate(gateway), servingTemplate, "preparation must not restart it");
  assert.equal(gateway.metadata.annotations?.["openclaw.dev/agent-revision-id"], revision.id);
  assert.equal(
    records.some(({ kind, metadata }) => kind === "Deployment" && metadata.name === gatewayName),
    false,
    "preparation must not re-render the serving Gateway",
  );
  if (!embedded) {
    // The stable Agent Service keeps selecting the predecessor Harness.
    assert.deepEqual(agentSelector(), stableSelector);
    const harnessKey = `Deployment:${namespace}:agent-${digest(revision.agentId)}-rev-${digest(successor.id)}`;
    assert.equal(
      templateLabels(observedResource(objects.get(harnessKey), "Deployment"))[
        ORDINARY_PROFILE_LABEL
      ],
      ORDINARY_PROFILE,
    );
    // The pre-profile Gateway keeps its Harness transport grants until activation.
    const gatewayAgent = gatewayAgentSelector();
    assert.equal(matchLabels(gatewayAgent)[ORDINARY_PROFILE_LABEL], undefined);
    assert.equal(selectorMatches(gatewayAgent, servingLabels), true);
    const peer = runtimePeer();
    assert.equal(matchLabels(peer)[ORDINARY_PROFILE_LABEL], undefined);
    assert.equal(selectorMatches(peer, servingLabels), true);
  }

  await driver.activateRevision(successor, successorContext);
  const activated = observedResource(objects.get(gatewayKey), "Deployment");
  assert.equal(activated.metadata.annotations?.["openclaw.dev/agent-revision-id"], successor.id);
  assert.equal(templateLabels(activated)[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  if (!embedded) {
    assert.equal(agentSelector()["openclaw.dev/revision"], successor.id);
    assert.equal(matchLabels(gatewayAgentSelector())[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
    assert.equal(matchLabels(runtimePeer())[ORDINARY_PROFILE_LABEL], ORDINARY_PROFILE);
  }
  // Once the profiled Gateway serves, the next preparation is ready at once.
  const next = { ...successor, id: "upgrade-next", revision: successor.revision + 1 };
  assert.equal(await prepareUntilReady(driver, next, { ...context, ...authContext(next) }), 1);
}
