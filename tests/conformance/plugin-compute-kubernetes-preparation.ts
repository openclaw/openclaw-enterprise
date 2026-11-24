import assert from "node:assert/strict";
import test from "node:test";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { PLUGIN_RUNTIME_MANIFEST } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import type { PluginDeploymentWarning } from "../../packages/contracts/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { CODEX_LINEAR_NATIVE_ID } from "../helpers/codex-runtime-helper-fixture.ts";
import {
  CODEX_ASANA_NATIVE_ID,
  codexLinearPluginState,
  codexNoPluginState,
  codexSelection,
  harnessAuthContext,
  items,
  openClawPluginState,
  parseJson,
  property,
  record,
  required,
  revision,
  shortHash,
  tenant,
} from "./plugin-compute-fixtures.ts";
import {
  admitRevisionHarness,
  dedicatedPluginDriver,
  enrolledNodeSecret,
  pluginComputeDriver,
  useRoutedGateway,
  type KubernetesObject,
  type PodProxyRequest,
} from "./plugin-compute-kubernetes-fixture.ts";

export function registerKubernetesPreparation(): void {
  test("embedded plugin preparation applies runtime egress before gateway readiness", async () => {
    const driver = pluginComputeDriver();
    const rawSlackApprovers = [
      { channel: "slack", id: "U456" },
      { channel: "slack", id: "W789" },
    ];
    const embedded = revision({
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      compute: { id: driver.id, implementation: driver.implementation },
      plugins: openClawPluginState(),
      pluginApprovers: rawSlackApprovers,
    });
    admitRevisionHarness(driver, embedded);
    const namespace = kubernetesNamespaceName(tenant.id);
    const tenantOwnership = { namespaceId: tenant.id };
    const defaultPolicies = new Map(
      driver
        .networkPolicies(tenantOwnership, { name: namespace, plane: "execution" })
        .map((policy) => [policy.metadata.name, policy]),
    );
    const configMaps = new Map<string, KubernetesObject<"ConfigMap">>();
    const reconciled: KubernetesObject[] = [];

    // This fresh Agent has no prior authentication-probe workloads to retire.
    const credentialObjects = new Map<string, KubernetesObject<"Secret">>();
    const cp = kubernetesNamespaceName(tenant.id);
    credentialObjects.set(`${cp}:plugin-model-key`, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "plugin-model-key", namespace: cp, uid: "plugin-model-key-uid" },
      data: { value: Buffer.from("fixture-model").toString("base64") },
    });
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
        createNamespacedConfigMap: async ({ body }) => {
          configMaps.set(body.metadata.name, {
            ...structuredClone(body),
            metadata: { ...body.metadata, uid: `${body.metadata.name}-uid` },
          });
          return {};
        },
        patchNamespacedConfigMap: async ({ name, body }) => {
          configMaps.set(name, {
            ...structuredClone(body),
            metadata: { ...body.metadata, name, uid: `${name}-uid` },
          });
          return {};
        },
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
      if (kind === "Secret" && name !== driver.workspaceNodeName(embedded)) {
        return credentialObjects.get(`${target.name}:${name}`);
      }
      if (kind === "NetworkPolicy") {
        return defaultPolicies.get(name);
      }
      if (kind === "ConfigMap") {
        return configMaps.get(name);
      }
      return undefined;
    };
    driver.reconcile = async (object) => {
      reconciled.push(structuredClone(object));
    };
    driver.gatewayReady = async () => true;

    const readiness = await driver.prepareRevision(embedded, harnessAuthContext(embedded));
    assert.deepEqual(readiness, {
      namespaceId: embedded.namespaceId,
      agentId: embedded.agentId,
      revisionId: embedded.id,
      ready: false,
    });
    const pluginRuntimeConfigMap = reconciled.find(
      ({ kind, metadata }) => kind === "ConfigMap" && metadata.name.startsWith("plugin-runtime-"),
    );
    assert.ok(pluginRuntimeConfigMap, "Kubernetes Compute must generate plugin runtime ConfigMap");
    assert.deepEqual(
      property(
        parseJson(pluginRuntimeConfigMap.data?.[PLUGIN_RUNTIME_MANIFEST]),
        "pluginApprovers",
      ),
      rawSlackApprovers,
    );

    const runtimePolicyIndex = reconciled.findIndex(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name.startsWith("allow-agent-runtime-"),
    );
    const gatewayDeploymentIndex = reconciled.findIndex(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    );
    assert.ok(runtimePolicyIndex >= 0);
    assert.ok(gatewayDeploymentIndex >= 0);
    assert.ok(runtimePolicyIndex < gatewayDeploymentIndex);
    assert.deepEqual(
      property(required(reconciled[runtimePolicyIndex]).spec, "podSelector", "matchLabels"),
      {
        "openclaw.dev/namespace": embedded.namespaceId,
        "openclaw.dev/workload-role": "gateway",
        "openclaw.dev/agent": embedded.agentId,
        "openclaw.dev/network-profile": "broad-egress-v1",
      },
    );
    assert.deepEqual(
      property(items(required(reconciled[runtimePolicyIndex]).spec?.egress)[0], "ports"),
      [{ protocol: "TCP", port: 443 }],
    );

    const dedicatedDriver = dedicatedPluginDriver();
    const dedicated = revision({
      compute: { id: dedicatedDriver.id, implementation: dedicatedDriver.implementation },
      plugins: codexLinearPluginState({
        toolDefaults: { approval: "provider_default", reviewer: "auto" },
      }),
    });
    useRoutedGateway(dedicated);
    admitRevisionHarness(dedicatedDriver, dedicated);
    const dedicatedNamespace = kubernetesNamespaceName(dedicated.namespaceId);
    const dedicatedTenantOwnership = { namespaceId: dedicated.namespaceId };
    const dedicatedDefaultPolicies = new Map(
      dedicatedDriver
        .networkPolicies(dedicatedTenantOwnership, { name: dedicatedNamespace, plane: "execution" })
        .map((policy) => [policy.metadata.name, policy]),
    );
    const dedicatedReconciled: KubernetesObject[] = [];

    const transportName = `transport-${shortHash(dedicated.agentId)}`;
    const transport = {
      ...dedicatedDriver.manifest(
        "v1",
        "Secret",
        transportName,
        { namespaceId: tenant.id, agentId: dedicated.agentId },
        { name: cp, plane: "execution" },
      ),
      type: "Opaque",
      data: { "app-server-token": Buffer.from("fixture-transport").toString("base64") },
    };
    transport.metadata.uid = "transport-uid";
    credentialObjects.set(`${cp}:${transportName}`, transport);
    dedicatedDriver.clients = async () => ({
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
        replaceNamespacedSecret: async ({ body }) => {
          credentialObjects.set(`${body.metadata.namespace}:${body.metadata.name}`, body);
          return body;
        },
        createNamespacedConfigMap: async () => ({}),
        patchNamespacedConfigMap: async () => ({}),
        listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [] }),
      },
    });
    dedicatedDriver.resolveNamespace = async () => ({
      name: { name: dedicatedNamespace, plane: "execution" },
      external: false,
    });
    dedicatedDriver.get = async (kind, name, target) =>
      kind === "Secret"
        ? credentialObjects.get(`${target.name}:${name}`)
        : kind === "Namespace"
          ? {
              ...(name === cp
                ? dedicatedDriver.gatewayNamespaceManifest(dedicatedTenantOwnership)
                : dedicatedDriver.manifest("v1", "Namespace", name, dedicatedTenantOwnership)),
              status: { phase: "Active" },
            }
          : undefined;
    dedicatedDriver.getOwned = async (kind, name, target) => {
      if (kind === "Secret" && name !== dedicatedDriver.workspaceNodeName(dedicated)) {
        return credentialObjects.get(`${target.name}:${name}`);
      }
      if (kind === "Secret") {
        return enrolledNodeSecret(dedicatedDriver, dedicated, dedicatedNamespace);
      }
      if (kind === "NetworkPolicy") {
        return dedicatedDefaultPolicies.get(name);
      }
      if (kind === "Deployment" && name.startsWith("agent-") && name.includes("-rev-")) {
        const reconciledDeployment = dedicatedReconciled.find(
          (object) => object.kind === "Deployment" && object.metadata?.name === name,
        );
        if (reconciledDeployment === undefined) {
          return undefined;
        }
        return {
          ...structuredClone(reconciledDeployment),
          metadata: { ...reconciledDeployment.metadata, generation: 1 },
          status: { observedGeneration: 1, readyReplicas: 1 },
        };
      }
      return undefined;
    };
    dedicatedDriver.reconcile = async (object) => {
      dedicatedReconciled.push(structuredClone(object));
    };
    dedicatedDriver.gatewayReady = async () => true;
    dedicatedDriver.pluginRuntimeStatus = async (_revision, _target, role) => ({
      revisionId: dedicated.id,
      container: role,
      startupId: "startup-plugin-status-1",
      podUid: "pod-plugin-status-1",
      phase: "ready",
      failures: [],
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    });

    const dedicatedReadiness = await dedicatedDriver.prepareRevision(
      dedicated,
      harnessAuthContext(dedicated),
    );
    assert.deepEqual(dedicatedReadiness, {
      namespaceId: dedicated.namespaceId,
      agentId: dedicated.agentId,
      revisionId: dedicated.id,
      ready: true,
    });
    const runtimeGatewayPolicyIndex = dedicatedReconciled.findIndex(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name.startsWith("allow-gateway-agent-"),
    );
    const runtimeAgentPolicyIndex = dedicatedReconciled.findIndex(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name.startsWith("allow-agent-runtime-"),
    );
    const statusGatewayPolicyIndex = dedicatedReconciled.findIndex(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name.startsWith("allow-plugin-status-gateway-"),
    );
    const statusAgentPolicyIndex = dedicatedReconciled.findIndex(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name.startsWith("allow-plugin-status-agent-"),
    );
    const dedicatedAgentServiceIndex = dedicatedReconciled.findIndex(
      ({ kind, metadata, spec }) =>
        kind === "Service" &&
        metadata.name.startsWith("agent-") &&
        (spec?.selector === undefined
          ? undefined
          : record(spec.selector)["openclaw.dev/revision"]) === dedicated.id,
    );
    const dedicatedGatewayDeploymentIndex = dedicatedReconciled.findIndex(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    );
    assert.ok(runtimeGatewayPolicyIndex >= 0);
    assert.ok(runtimeAgentPolicyIndex >= 0);
    assert.ok(statusGatewayPolicyIndex >= 0);
    assert.ok(statusAgentPolicyIndex >= 0);
    assert.ok(dedicatedAgentServiceIndex >= 0);
    assert.ok(dedicatedGatewayDeploymentIndex >= 0);
    assert.ok(runtimeGatewayPolicyIndex < dedicatedGatewayDeploymentIndex);
    assert.ok(runtimeAgentPolicyIndex < dedicatedGatewayDeploymentIndex);
    assert.ok(statusGatewayPolicyIndex < dedicatedGatewayDeploymentIndex);
    assert.ok(statusAgentPolicyIndex < dedicatedGatewayDeploymentIndex);
    assert.ok(dedicatedAgentServiceIndex < dedicatedGatewayDeploymentIndex);
    assert.deepEqual(
      required(dedicatedReconciled[runtimeGatewayPolicyIndex]).metadata.namespace,
      cp,
    );
    assert.deepEqual(
      property(
        required(dedicatedReconciled[runtimeGatewayPolicyIndex]).spec,
        "podSelector",
        "matchLabels",
      ),
      {
        "openclaw.dev/namespace": dedicated.namespaceId,
        "openclaw.dev/workload-role": "gateway",
        "openclaw.dev/agent": dedicated.agentId,
        "openclaw.dev/network-profile": "broad-egress-v1",
      },
    );
    assert.deepEqual(
      property(
        items(required(dedicatedReconciled[runtimeGatewayPolicyIndex]).spec?.egress)[0],
        "ports",
      ),
      [
        { protocol: "TCP", port: 18790 },
        { protocol: "TCP", port: 18791 },
      ],
    );
    assert.deepEqual(
      required(dedicatedReconciled[runtimeAgentPolicyIndex]).metadata.namespace,
      dedicatedNamespace,
    );
    assert.deepEqual(
      property(
        required(dedicatedReconciled[runtimeAgentPolicyIndex]).spec,
        "podSelector",
        "matchLabels",
      ),
      {
        "openclaw.dev/namespace": dedicated.namespaceId,
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/agent": dedicated.agentId,
        "openclaw.dev/revision": dedicated.id,
        "openclaw.dev/network-profile": "broad-egress-v1",
      },
    );
    assert.deepEqual(
      property(
        items(required(dedicatedReconciled[runtimeAgentPolicyIndex]).spec?.ingress)[0],
        "ports",
      ),
      [
        { protocol: "TCP", port: 18790 },
        { protocol: "TCP", port: 18791 },
      ],
    );
  });

  test("Kubernetes plugin runtime status requires the exact ready Pod report", async (t) => {
    const driver = pluginComputeDriver();
    const candidate = revision({
      compute: { id: driver.id, implementation: driver.implementation },
      plugins: {
        ...codexLinearPluginState(),
        plugins: {
          ...codexSelection(),
          [`codex-plugin:${CODEX_ASANA_NATIVE_ID}`]: {
            enabled: true,
            toolDefaults: { approval: "provider_default" },
          },
        },
      },
    });
    const namespace = kubernetesNamespaceName(tenant.id);
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "gateway-plugin-status",
        namespace: kubernetesNamespaceName(tenant.id),
        uid: "pod-plugin-status-1",
        labels: {
          "openclaw.dev/agent": candidate.agentId,
          "openclaw.dev/revision": candidate.id,
          "openclaw.dev/workload-role": "gateway",
        },
      },
      status: { phase: "Running", podIP: "10.42.0.20" },
    };
    const readyReport = {
      revisionId: candidate.id,
      container: "gateway",
      startupId: "startup-plugin-status-1",
      podUid: "pod-plugin-status-1",
      phase: "ready",
      successfulPluginIds: [
        `codex-plugin:${CODEX_LINEAR_NATIVE_ID}`,
        `codex-plugin:${CODEX_ASANA_NATIVE_ID}`,
      ],
      failures: [],
    };
    // Gateway readiness requires the Harness's complete warning set, regardless of order.
    const warningReport = {
      ...readyReport,
      successfulPluginIds: [],
      failures: [
        { pluginId: `codex-plugin:${CODEX_ASANA_NATIVE_ID}`, code: "PLUGIN_INSTALL_FAILED" },
        { pluginId: `codex-plugin:${CODEX_LINEAR_NATIVE_ID}`, code: "PLUGIN_AUTH_REQUIRED" },
      ] satisfies [PluginDeploymentWarning, PluginDeploymentWarning],
    };

    for (const [name, response, expected, expectedWarnings = []] of [
      ["missing proxy", Object.assign(new Error("not found"), { code: 404 }), "not-ready"],
      ["starting phase", { ...readyReport, phase: "starting" }, "not-ready"],
      ["wrong revision", { ...readyReport, revisionId: "another-revision" }, "rejects"],
      ["wrong container", { ...readyReport, container: "agent" }, "rejects"],
      ["malformed report", { ...readyReport, successfulPluginIds: "occ-plugin:diffs" }, "rejects"],
      ["ready", readyReport, readyReport],
      [
        "matching warnings in another order",
        { ...warningReport, failures: [...warningReport.failures].reverse() },
        warningReport,
        warningReport.failures,
      ],
      [
        "different warning code keeps the runtime unready",
        warningReport,
        "not-ready",
        [{ ...warningReport.failures[0], code: "PLUGIN_AUTH_REQUIRED" }, warningReport.failures[1]],
      ],
    ] satisfies readonly [string, unknown, unknown, (readonly PluginDeploymentWarning[])?][]) {
      await t.test(name, async () => {
        let proxied = 0;
        driver.clients = async () => ({
          core: {
            listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [pod] }),
            connectGetNamespacedPodProxyWithPath: async () => {
              proxied += 1;
              if (response instanceof Error) {
                throw response;
              }
              return response;
            },
          },
        });
        const readStatus = () =>
          driver.pluginRuntimeStatus(
            candidate,
            { name: namespace, plane: "execution" },
            "gateway",
            expectedWarnings,
          );
        if (expected === "rejects") {
          await assert.rejects(readStatus, DependencyUnavailableError);
        } else {
          const status = await readStatus();
          assert.deepEqual(status, expected === "not-ready" ? undefined : expected);
        }
        // Every case, not-ready ones included, reads the running Pod's report.
        assert.equal(proxied, 1);
      });
    }
  });

  test("Kubernetes startup failure evidence requires the exact runtime Pod report", async () => {
    const driver = pluginComputeDriver();
    const candidate = revision({
      compute: { id: driver.id, implementation: driver.implementation },
      plugins: codexNoPluginState(),
    });
    const namespace = kubernetesNamespaceName(tenant.id);
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "agent-runtime-status",
        namespace,
        uid: "pod-runtime-status-1",
        labels: {
          "openclaw.dev/agent": candidate.agentId,
          "openclaw.dev/revision": candidate.id,
          "openclaw.dev/workload-role": "agent",
        },
      },
      status: {
        phase: "Running",
        podIP: "10.42.0.21",
        containerStatuses: [{ name: "agent", containerID: "containerd://runtime-status-1" }],
      },
    };
    const failure: {
      component: string;
      check: string;
      checkedAt: string;
      code: string;
      cause?: unknown;
    } = {
      component: "agent",
      check: "model-probe",
      checkedAt: "2026-09-20T12:00:00.000Z",
      code: "MODEL_PROBE_FAILED",
    };
    const requests: PodProxyRequest[] = [];
    driver.clients = async () => ({
      core: {
        listNamespacedPod: async () => ({ apiVersion: "v1", kind: "PodList", items: [pod] }),
        connectGetNamespacedPodProxyWithPath: async (request) => {
          requests.push(request);
          return JSON.stringify({
            revisionId: candidate.id,
            container: "agent",
            podUid: "pod-runtime-status-1",
            runtimeFailure: failure,
          });
        },
      },
    });

    const observed = await driver.safeRuntimeFailureObservation(candidate, {
      name: namespace,
      plane: "execution",
    });

    assert.deepEqual(observed, failure);
    assert.deepEqual(requests, [
      {
        name: "agent-runtime-status:18791",
        namespace,
        path: "openclaw/runtime/status",
      },
    ]);

    // A model-probe cause crosses the runtime boundary only inside its closed
    // vocabulary. Anything else is dropped and the failure code still stands.
    const reports: readonly [unknown, string, boolean][] = [
      [{ kind: "PROBE_STATUS", detail: "rate_limit" }, "MODEL_PROBE_FAILED", true],
      [{ kind: "WRAPPER_ERROR" }, "MODEL_PROBE_FAILED", true],
      [{ kind: "PROCESS_EXIT", detail: "exit-1" }, "MODEL_PROBE_FAILED", true],
      // A retried transient failure keeps its token with the second attempt's suffix.
      [{ kind: "PROBE_STATUS", detail: "turn-failed-attempt2" }, "MODEL_PROBE_FAILED", true],
      [{ kind: "PROCESS_EXIT", detail: "signal-SIGKILL-attempt2" }, "MODEL_PROBE_FAILED", true],
      [{ kind: "PROBE_STATUS", detail: "turn-failed-attempt3" }, "MODEL_PROBE_FAILED", false],
      [{ kind: "PROBE_STATUS", detail: "attempt2" }, "MODEL_PROBE_FAILED", false],
      [{ kind: "PROBE_STATUS", detail: "-attempt2" }, "MODEL_PROBE_FAILED", false],
      [{ kind: "WRAPPER_ERROR", detail: "-attempt2" }, "MODEL_PROBE_FAILED", false],
      [
        { kind: "PROBE_STATUS", detail: "turn-failed-attempt2-attempt2" },
        "MODEL_PROBE_FAILED",
        false,
      ],
      [{ kind: "PROBE_STATUS", detail: "sk-fixture-credential" }, "MODEL_PROBE_FAILED", false],
      [{ kind: "PROCESS_EXIT", detail: "HTTP 404 model not found" }, "MODEL_PROBE_FAILED", false],
      [{ kind: "WRAPPER_ERROR", detail: "json" }, "MODEL_PROBE_FAILED", false],
      [{ kind: "PROVIDER_SAID", detail: "format" }, "MODEL_PROBE_FAILED", false],
      [{ kind: "PROBE_STATUS", detail: "format", text: "raw" }, "MODEL_PROBE_FAILED", false],
      ["PROBE_STATUS", "MODEL_PROBE_FAILED", false],
      [{ kind: "PROBE_STATUS", detail: "format" }, "AUTHENTICATION_FAILED", false],
    ];
    for (const [cause, code, kept] of reports) {
      failure.code = code;
      failure.cause = cause;
      const evidence = await driver.safeRuntimeFailureObservation(candidate, {
        name: namespace,
        plane: "execution",
      });
      const { cause: _reported, ...withoutCause } = failure;
      assert.deepEqual(evidence, kept ? failure : withoutCause, `${code} ${JSON.stringify(cause)}`);
    }
  });
}
