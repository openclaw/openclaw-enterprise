import assert from "node:assert/strict";
import test from "node:test";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT,
  PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT,
  PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  agent,
  codexLinearPluginState,
  codexNoPluginState,
  harnessAuthContext,
  record,
  required,
  revision,
  shortHash,
  tenant,
  text,
} from "./plugin-compute-fixtures.ts";
import {
  admitRevisionHarness,
  dedicatedPluginDriver,
  enrolledNodeSecret,
  pluginComputeDriver,
  renderedPod,
  useRoutedGateway,
  type KubernetesObject,
} from "./plugin-compute-kubernetes-fixture.ts";

export function registerKubernetesDeployment(): void {
  test("Kubernetes dedicated Codex agent mounts plugin-free runtime without plugin status auth", async () => {
    const driver = pluginComputeDriver();
    const candidate = revision({ plugins: codexNoPluginState() });
    const runtime = required(pluginRuntimeSpecForRevision(candidate));
    const deployment = driver.deployment(
      "agent-plugin-compute-rev",
      {
        namespaceId: tenant.id,
        agentId: agent.id,
        revisionId: "revision-plugin-compute-1",
      },
      { name: kubernetesNamespaceName(tenant.id), plane: "execution" },
      "openclaw-enterprise/agent-fixture:local",
      "agent-plugin-compute",
      "agent",
      {},
      "info",
      undefined,
      false,
      undefined,
      driver.harnessAuthForRevision(candidate, harnessAuthContext(candidate), {
        name: kubernetesNamespaceName(tenant.id),
        plane: "control",
      }),
      [],
      [],
      { name: "plugin-runtime-agent-plugin-compute", runtime },
    );

    const pod = renderedPod(deployment);
    assert.equal(
      pod.volumes.some(
        (volume) => volume.configMap?.name === "plugin-runtime-agent-plugin-compute",
      ),
      true,
    );
    const container = pod.container;
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT),
      true,
    );
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT),
      true,
    );
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT),
      true,
    );
    assert.deepEqual(
      container.env
        .filter((variable) =>
          [
            "OPENCLAW_AGENT_REVISION_ID",
            "OPENCLAW_RUNTIME_STATUS_CONTAINER",
            "OPENCLAW_RUNTIME_STATUS_PORT",
            "OPENCLAW_PLUGIN_STATUS_CONTAINER",
            "OPENCLAW_PLUGIN_STATUS_PORT",
          ].includes(text(variable.name)),
        )
        .map((variable) => [variable.name, variable.value]),
      [
        ["OPENCLAW_AGENT_REVISION_ID", "revision-plugin-compute-1"],
        ["OPENCLAW_RUNTIME_STATUS_CONTAINER", "agent"],
        ["OPENCLAW_RUNTIME_STATUS_PORT", "18791"],
      ],
    );
    assert.deepEqual(
      container.ports.map((port) => [port.name, port.containerPort]),
      [
        ["websocket", 18790],
        ["plugin-status", 18791],
      ],
    );
    assert.deepEqual(container.readinessProbe, {
      httpGet: { path: "/readyz", port: "plugin-status" },
      periodSeconds: 2,
    });
  });

  for (const withBroker of [false, true]) {
    test(`Kubernetes dedicated Codex gateway mounts plugin-free runtime (broker=${withBroker})`, async () => {
      const driver = pluginComputeDriver();
      const runtime = required(
        pluginRuntimeSpecForRevision(
          revision({ plugins: codexNoPluginState() }),
          withBroker
            ? {
                host: "git.oce.svc",
                domains: {},
              }
            : undefined,
        ),
      );
      const deployment = driver.deployment(
        "gateway-plugin-compute-rev",
        {
          namespaceId: tenant.id,
          agentId: agent.id,
          revisionId: "revision-plugin-compute-1",
        },
        { name: "oce-plugin-compute", plane: "execution" },
        "openclaw-enterprise/gateway-fixture:local",
        "gateway-plugin-compute",
        "gateway",
        {},
        "info",
        driver.gatewayConfiguration(revision(), undefined, {
          name: "oce-plugin-compute",
          plane: "execution",
        }),
        false,
        undefined,
        undefined,
        [],
        [],
        { name: "plugin-runtime-gateway-plugin-compute", runtime },
      );

      const pod = renderedPod(deployment);
      assert.equal(
        pod.volumes.some(
          (volume) => volume.configMap?.name === "plugin-runtime-gateway-plugin-compute",
        ),
        true,
      );
      const container = pod.container;
      assert.equal(
        container.env.some((variable) => variable.name === PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT),
        true,
      );
      assert.equal(
        container.env.some((variable) => variable.name === PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT),
        false,
      );
      assert.equal(
        container.env.some((variable) => variable.name === PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT),
        false,
      );
      assert.equal(
        container.env.some((variable) => variable.name === "OPENCLAW_PLUGIN_STATUS_CONTAINER"),
        false,
      );
    });
  }

  test("an embedded OpenClaw revision cannot mount a historical broker-only Codex bridge", () => {
    assert.throws(
      () =>
        pluginRuntimeSpecForRevision(
          revision({
            harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
            plugins: codexNoPluginState(),
          }),
          { host: "git.oce.svc", domains: {} },
        ),
      /a dedicated Codex Harness/,
    );
  });

  test("Kubernetes dedicated successor readiness preserves the stable Agent Service until activation", async () => {
    const driver = dedicatedPluginDriver();
    const predecessor = revision({
      id: "revision-plugin-compute-predecessor",
      revision: 1,
      compute: { id: driver.id, implementation: driver.implementation },
      plugins: codexNoPluginState(),
    });
    const candidate = revision({
      id: "revision-plugin-compute-successor",
      revision: 2,
      compute: { id: driver.id, implementation: driver.implementation },
      plugins: codexNoPluginState(),
    });
    useRoutedGateway(candidate);
    useRoutedGateway(predecessor);
    admitRevisionHarness(driver, candidate);
    admitRevisionHarness(driver, predecessor);
    const namespace = kubernetesNamespaceName(tenant.id);
    const tenantOwnership = { namespaceId: tenant.id };
    const agentName = `agent-${shortHash(candidate.agentId)}`;
    const predecessorRevisionName = `${agentName}-rev-${shortHash(predecessor.id)}`;
    const defaultPolicies = new Map(
      driver
        .networkPolicies(tenantOwnership, { name: namespace, plane: "execution" })
        .map((policy) => [policy.metadata.name, policy]),
    );
    const reconciled: KubernetesObject[] = [];
    let candidateRevisionName: string | undefined;

    const credentialObjects = new Map<string, KubernetesObject<"Secret">>();
    const cp = kubernetesNamespaceName(tenant.id);
    credentialObjects.set(`${cp}:plugin-model-key`, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "plugin-model-key", namespace: cp, uid: "plugin-model-key-uid" },
      data: { value: Buffer.from("fixture-model").toString("base64") },
    });
    const transportName = `transport-${shortHash(candidate.agentId)}`;
    const transport = {
      ...driver.manifest(
        "v1",
        "Secret",
        transportName,
        { namespaceId: tenant.id, agentId: candidate.agentId },
        { name: cp, plane: "execution" },
      ),
      type: "Opaque",
      data: { "app-server-token": Buffer.from("fixture-transport").toString("base64") },
    };
    transport.metadata.uid = "transport-uid";
    credentialObjects.set(`${cp}:${transportName}`, transport);
    driver.clients = async () => ({
      apps: { listNamespacedDeployment: async () => ({ items: [] }) },
      core: {
        createNamespacedSecret: async ({ body }) => {
          const observed = {
            ...body,
            metadata: { ...body.metadata, uid: `${body.metadata.name}-uid`, resourceVersion: "1" },
          };
          credentialObjects.set(`${body.metadata.namespace}:${body.metadata.name}`, observed);
          return observed;
        },
        // The connected readiness check records the enrolled revision in the node Secret.
        replaceNamespacedSecret: async ({ body }) => body,
        createNamespacedConfigMap: async () => ({}),
        patchNamespacedConfigMap: async () => ({}),
        listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [] }),
      },
    });
    driver.resolveNamespace = async () => ({
      name: { name: namespace, plane: "execution" },
      external: false,
    });
    driver.get = async (kind, name, target) =>
      kind === "Secret"
        ? credentialObjects.get(`${target.name}:${name}`)
        : kind === "Namespace"
          ? {
              ...(name === cp
                ? driver.gatewayNamespaceManifest(tenantOwnership)
                : driver.manifest("v1", "Namespace", name, tenantOwnership)),
              status: { phase: "Active" },
            }
          : undefined;
    driver.getOwned = async (kind, name, target) => {
      if (kind === "Secret" && name !== driver.workspaceNodeName(candidate)) {
        return credentialObjects.get(`${target.name}:${name}`);
      }
      if (kind === "Secret") {
        return enrolledNodeSecret(driver, candidate, namespace);
      }
      if (kind === "NetworkPolicy") {
        return defaultPolicies.get(name);
      }
      if (kind === "Deployment" && name.startsWith("gateway-")) {
        return {
          ...driver.manifest(
            "apps/v1",
            "Deployment",
            name,
            { ...tenantOwnership, agentId: candidate.agentId },
            { name: namespace, plane: "execution" },
          ),
          metadata: {
            name,
            annotations: {
              "openclaw.dev/agent-revision": String(predecessor.revision),
              "openclaw.dev/agent-revision-id": predecessor.id,
            },
            generation: 1,
          },
          spec: {
            replicas: 1,
            template: {
              spec: {
                volumes: [
                  {
                    name: "openclaw-configuration",
                    configMap: { name: "predecessor-config" },
                  },
                ],
              },
            },
          },
          status: { observedGeneration: 1, readyReplicas: 1 },
        };
      }
      if (kind === "Deployment" && name.startsWith("agent-") && name.includes("-rev-")) {
        candidateRevisionName = name;
        const reconciledCandidate = reconciled.find(
          (object) => object.kind === "Deployment" && object.metadata?.name === name,
        );
        return {
          ...(reconciledCandidate === undefined
            ? driver.manifest(
                "apps/v1",
                "Deployment",
                name,
                {
                  ...tenantOwnership,
                  agentId: candidate.agentId,
                  servicePrincipalId: candidate.servicePrincipalId,
                  revisionId: candidate.id,
                },
                { name: namespace, plane: "execution" },
              )
            : structuredClone(reconciledCandidate)),
          metadata: { ...(reconciledCandidate?.metadata ?? { name }), generation: 1 },
          spec: { ...(reconciledCandidate?.spec ?? {}), replicas: 1 },
          status: { observedGeneration: 1, readyReplicas: 1 },
        };
      }
      if (kind === "Service" && name.startsWith("agent-")) {
        return driver.service(
          name,
          {
            ...tenantOwnership,
            agentId: candidate.agentId,
            servicePrincipalId: candidate.servicePrincipalId,
          },
          { name: namespace, plane: "execution" },
          { "app.kubernetes.io/name": predecessorRevisionName },
        );
      }
      return undefined;
    };
    driver.reconcile = async (object) => {
      reconciled.push(structuredClone(object));
    };
    driver.gatewayReady = async () => true;

    const readiness = await driver.prepareRevision(candidate, harnessAuthContext(candidate));
    assert.deepEqual(readiness, {
      namespaceId: candidate.namespaceId,
      agentId: candidate.agentId,
      revisionId: candidate.id,
      ready: true,
    });
    assert.equal(typeof candidateRevisionName, "string");
    assert.equal(
      reconciled.some(
        ({ kind, metadata, spec }) =>
          kind === "Service" &&
          metadata.name === agentName &&
          (spec?.selector === undefined
            ? undefined
            : record(spec.selector)["app.kubernetes.io/name"]) === candidateRevisionName,
      ),
      false,
    );
  });

  test("Kubernetes dedicated Codex gateway mounts bridge runtime and prior plugin warnings", async () => {
    const driver = pluginComputeDriver();
    const runtime = required(
      pluginRuntimeSpecForRevision(
        revision({
          plugins: codexLinearPluginState({
            toolDefaults: { approval: "provider_default", reviewer: "auto" },
          }),
        }),
      ),
    );
    const deployment = driver.deployment(
      "gateway-plugin-compute-rev",
      {
        namespaceId: tenant.id,
        agentId: agent.id,
        revisionId: "revision-plugin-compute-1",
      },
      { name: "oce-plugin-compute", plane: "execution" },
      "openclaw-enterprise/gateway-fixture:local",
      "gateway-plugin-compute",
      "gateway",
      {},
      "info",
      driver.gatewayConfiguration(revision(), undefined, {
        name: "oce-plugin-compute",
        plane: "execution",
      }),
      false,
      undefined,
      undefined,
      [],
      [],
      { name: "plugin-runtime-gateway-plugin-compute", runtime },
      [{ pluginId: "codex-plugin:linear@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" }],
    );

    const pod = renderedPod(deployment);
    assert.equal(
      pod.volumes.some(
        (volume) => volume.configMap?.name === "plugin-runtime-gateway-plugin-compute",
      ),
      true,
    );
    const container = pod.container;
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT),
      true,
    );
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT),
      false,
    );
    assert.equal(
      container.env.some((variable) => variable.name === PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT),
      false,
    );
    assert.deepEqual(
      container.env
        .filter((variable) =>
          [
            "OPENCLAW_AGENT_REVISION_ID",
            "OPENCLAW_PLUGIN_STATUS_CONTAINER",
            "OPENCLAW_PLUGIN_STATUS_PORT",
            "OPENCLAW_PLUGIN_FAILURES_JSON",
          ].includes(text(variable.name)),
        )
        .map((variable) => [variable.name, variable.value]),
      [
        ["OPENCLAW_AGENT_REVISION_ID", "revision-plugin-compute-1"],
        ["OPENCLAW_PLUGIN_STATUS_CONTAINER", "gateway"],
        ["OPENCLAW_PLUGIN_STATUS_PORT", "18791"],
        [
          "OPENCLAW_PLUGIN_FAILURES_JSON",
          JSON.stringify([
            {
              pluginId: "codex-plugin:linear@openai-curated-remote",
              code: "PLUGIN_AUTH_REQUIRED",
            },
          ]),
        ],
      ],
    );
    assert.deepEqual(
      container.ports.map((port) => [port.name, port.containerPort]),
      [
        ["http", 8080],
        ["plugin-status", 18791],
      ],
    );
  });

  test("Kubernetes plugin-free Codex gateway receives explicit Agent approvers", () => {
    const driver = pluginComputeDriver();
    for (const pluginApprovers of [undefined, []]) {
      const candidate = revision({ pluginApprovers });
      const runtime = required(pluginRuntimeSpecForRevision(candidate));
      const deployment = driver.deployment(
        "gateway-plugin-free",
        { namespaceId: tenant.id, agentId: agent.id, revisionId: candidate.id },
        { name: "oce-plugin-compute", plane: "execution" },
        "openclaw-enterprise/gateway-fixture:local",
        "gateway-plugin-compute",
        "gateway",
        {},
        "info",
        driver.gatewayConfiguration(candidate, undefined, {
          name: "oce-plugin-compute",
          plane: "execution",
        }),
        false,
        undefined,
        undefined,
        [],
        [],
        { name: "plugin-runtime-gateway-plugin-free", runtime },
      );
      const pod = renderedPod(deployment);
      assert.equal(
        pod.volumes.some(
          (volume) => volume.configMap?.name === "plugin-runtime-gateway-plugin-free",
        ),
        true,
      );
    }
  });
}
