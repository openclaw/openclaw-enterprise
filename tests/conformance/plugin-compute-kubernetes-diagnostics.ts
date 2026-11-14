import assert from "node:assert/strict";
import test from "node:test";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  agent,
  codexLinearPluginState,
  property,
  revision,
  tenant,
  waitForCondition,
} from "./plugin-compute-fixtures.ts";
import { pluginComputeDriver } from "./plugin-compute-kubernetes-fixture.ts";
import { readStatusFromHandlerAsync } from "./plugin-compute-status.ts";
import { startCodexGatewaySupervisor } from "./plugin-compute-supervisor.ts";

export function registerKubernetesDiagnostics(): void {
  // Run diagnostics is where an operator looks first. A Gateway held on an
  // unusable peer bridge record still answers diagnostics, but only with Slack
  // checks it could not run; the Compute Driver reads the held failure from the
  // same wrapper's status path and reports it first, named after the startup step.
  test("Kubernetes diagnostics name the startup step a held Gateway failed", async (t) => {
    const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
    const savedFiles = new Map(previous.files);
    savedFiles.set("/home/node/.openclaw/openclaw.json.oce-peer-bridge.json", "");
    const gateway = await startCodexGatewaySupervisor(t, {
      writableConfig: true,
      savedFiles,
      runtimeStatus: true,
      expectStart: false,
    });
    await waitForCondition("the held runtime failure", () =>
      property(gateway.runtimeStatus(), "runtimeFailure"),
    );
    // No native Gateway listens while the wrapper holds, so OpenClaw's SDK reports
    // a transport failure for the Slack channel probe.
    const transportError = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    const sandboxRequire = gateway.sandbox.require;
    gateway.sandbox.AbortController = AbortController;
    gateway.sandbox.require = (specifier) =>
      specifier === "openclaw/plugin-sdk/gateway-runtime"
        ? {
            async callGatewayFromCli() {
              throw transportError;
            },
            isGatewayTransportError: (error: unknown) => error === transportError,
          }
        : sandboxRequire(specifier);

    const driver = pluginComputeDriver();
    const candidate = revision({
      compute: { id: driver.id, implementation: driver.implementation },
      plugins: codexLinearPluginState(),
    });
    const namespace = kubernetesNamespaceName(tenant.id);
    const pod = (role: "agent" | "gateway", uid: string) => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `${role}-held-diagnostics`,
        namespace,
        uid,
        labels: {
          "openclaw.dev/agent": candidate.agentId,
          "openclaw.dev/revision": candidate.id,
          "openclaw.dev/workload-role": role,
        },
      },
      status: {
        phase: "Running",
        podIP: "10.42.0.22",
        containerStatuses: [{ name: role, containerID: `containerd://${role}-1` }],
      },
    });
    // The Pod UIDs match the ones each runtime reports for itself.
    const pods = { agent: pod("agent", "agent-pod-1"), gateway: pod("gateway", "gateway-pod-1") };
    const activeNamespace = {
      ...driver.manifest("v1", "Namespace", namespace, { namespaceId: tenant.id }),
      status: { phase: "Active" },
    };
    driver.apiClients = Promise.resolve({
      core: {
        listNamespace: async () => ({
          apiVersion: "v1",
          kind: "NamespaceList",
          items: [activeNamespace],
        }),
        readNamespace: async () => activeNamespace,
        listNamespacedPod: async ({ labelSelector }) => ({
          apiVersion: "v1",
          kind: "PodList",
          items: [pods[labelSelector?.includes("workload-role=agent") ? "agent" : "gateway"]],
        }),
        // The Gateway Pod proxy reaches the held wrapper's real status server. The
        // Codex Agent's status port is not serving in this case.
        connectGetNamespacedPodProxyWithPath: async ({ name, path }) => {
          if (name.startsWith("agent-")) {
            throw Object.assign(new Error("status port not serving"), { code: 503, headers: {} });
          }
          return readStatusFromHandlerAsync(gateway.statusHandler, `/${path}`);
        },
      },
    });

    const diagnostics = await driver.diagnoseAgentDeployment({
      namespace: tenant,
      agent: { ...agent, executionMode: "dedicated" },
      revision: candidate,
    });

    assert.deepEqual(
      diagnostics.checks
        .filter(({ component }) => component === "gateway")
        .map(({ check, state, code }) => ({ check, state, code })),
      [
        { check: "peer-bridge-record", state: "failed", code: "UNAVAILABLE" },
        { check: "configuration", state: "unknown", code: "UNAVAILABLE" },
        { check: "authentication", state: "unknown", code: "UNAVAILABLE" },
        { check: "connectivity", state: "unknown", code: "UNAVAILABLE" },
      ],
    );
    assert.equal(
      diagnostics.checks.find(({ check }) => check === "peer-bridge-record")?.checkedAt,
      property(gateway.runtimeStatus(), "runtimeFailure", "checkedAt"),
    );
    assert.deepEqual(gateway.children, [], "diagnostics do not start OpenClaw");
    gateway.signalHandlers.SIGTERM!();
  });
}
