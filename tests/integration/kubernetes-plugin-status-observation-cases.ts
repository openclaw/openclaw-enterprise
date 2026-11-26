import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test, { type TestContext, type TestOptions } from "node:test";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type {
  KubernetesComputeDriver,
  KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  AgentRevision,
  ComputeReadiness,
  ComputeRevisionContext,
  PluginDeploymentWarning,
} from "../../packages/contracts/src/index.ts";
import { sha256Hex } from "../../packages/utils/src/index.ts";
import type { createKubernetesClient } from "../helpers/kubernetes-real.ts";

const execute = promisify(execFile);
const statusPort = 18791;
const statusPath = "/openclaw/plugin-runtime/status";

const NonBlankString = Type.String({ pattern: "\\S" });
const Conditions = Type.Array(Type.Object({ type: Type.String(), status: Type.String() }));
const NodeList = Type.Object({
  items: Type.Array(
    Type.Object({
      metadata: Type.Object({
        name: NonBlankString,
        labels: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      spec: Type.Optional(Type.Object({ unschedulable: Type.Optional(Type.Boolean()) })),
      status: Type.Optional(Type.Object({ conditions: Type.Optional(Conditions) })),
    }),
  ),
});
const GatewayPods = Type.Array(
  Type.Object({
    metadata: Type.Object({
      name: NonBlankString,
      uid: NonBlankString,
      deletionTimestamp: Type.Optional(NonBlankString),
    }),
    spec: Type.Object({ nodeName: Type.Optional(NonBlankString) }),
    status: Type.Optional(Type.Object({ conditions: Type.Optional(Conditions) })),
  }),
);

const PluginStatus = Type.Object({
  revisionId: NonBlankString,
  container: Type.Union([Type.Literal("gateway"), Type.Literal("agent")]),
  startupId: NonBlankString,
  podUid: NonBlankString,
  phase: Type.Union([Type.Literal("ready"), Type.Literal("starting")]),
  successfulPluginIds: Type.Array(NonBlankString),
  failures: Type.Array(
    Type.Object(
      {
        pluginId: NonBlankString,
        code: Type.Union([
          Type.Literal("PLUGIN_INSTALL_FAILED"),
          Type.Literal("PLUGIN_AUTH_REQUIRED"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
});
const EffectiveConfig = Type.Object({
  plugins: Type.Object({
    entries: Type.Object({ diffs: Type.Object({ enabled: Type.Boolean() }) }),
  }),
  tools: Type.Optional(Type.Object({ alsoAllow: Type.Optional(Type.Array(Type.String())) })),
});

const TerminatedState = Type.Object({
  exitCode: Type.Number(),
  reason: Type.Optional(Type.String()),
});
const ContainerStatus = Type.Object({
  name: Type.String(),
  restartCount: Type.Number(),
  state: Type.Optional(
    Type.Object({
      terminated: Type.Optional(TerminatedState),
      waiting: Type.Optional(Type.Object({ reason: Type.Optional(Type.String()) })),
    }),
  ),
  lastState: Type.Optional(Type.Object({ terminated: Type.Optional(TerminatedState) })),
});
const DiagnosticPods = Type.Object({
  items: Type.Array(
    Type.Object({
      status: Type.Optional(
        Type.Object({
          phase: Type.Optional(Type.String()),
          conditions: Type.Optional(Conditions),
          initContainerStatuses: Type.Optional(Type.Array(ContainerStatus)),
          containerStatuses: Type.Optional(Type.Array(ContainerStatus)),
        }),
      ),
    }),
  ),
});

type StatusCandidate = {
  agentId: string;
  namespaceName: string;
  candidate: AgentRevision;
  driver: KubernetesComputeDriver;
  auth: { context: ComputeRevisionContext };
};
type Dependencies = {
  kubernetes: Pick<
    ReturnType<typeof createKubernetesClient>,
    "kubectl" | "kubectlArguments" | "resources" | "waitFor"
  >;
  requiresKubernetes: Pick<TestOptions, "skip">;
  pluginId: string;
  assertPrerequisites: () => Promise<void>;
  createStatusCandidate: (label: string, context: TestContext) => Promise<StatusCandidate>;
  createDriver: (options: {
    nodeSelector: NonNullable<KubernetesComputeDriverOptions["runtime"]>["nodeSelector"];
  }) => KubernetesComputeDriver;
  prepareRevisionEventually: (fixture: StatusCandidate) => Promise<ComputeReadiness>;
};

function parseJson(source: string): unknown {
  return JSON.parse(source);
}

function gatewayName(agentId: string) {
  return `gateway-${sha256Hex(agentId, 12)}`;
}

function gatewaySelector({ candidate }: StatusCandidate) {
  return `openclaw.dev/agent=${candidate.agentId},openclaw.dev/revision=${candidate.id},openclaw.dev/workload-role=gateway`;
}

function conditionIsTrue(
  conditions: readonly { type: string; status: string }[] | undefined,
  type: "Ready" | "PodScheduled",
) {
  return conditions?.some((condition) => condition.type === type && condition.status === "True");
}

export function registerPluginStatusObservationCases({
  kubernetes: { kubectl, kubectlArguments, resources, waitFor },
  requiresKubernetes,
  pluginId,
  assertPrerequisites,
  createStatusCandidate,
  createDriver,
  prepareRevisionEventually,
}: Dependencies) {
  async function scheduleGatewayOnNonServerNode(fixture: StatusCandidate) {
    const nodes = parseJson(await kubectl("get", "nodes", "-o", "json"));
    assert.ok(Check(NodeList, nodes), "kubectl returned an invalid node list");
    const worker = nodes.items.find(({ metadata: { labels = {} }, spec, status }) => {
      const controlPlane =
        Object.hasOwn(labels, "node-role.kubernetes.io/control-plane") ||
        Object.hasOwn(labels, "node-role.kubernetes.io/master");
      return !controlPlane && !spec?.unschedulable && conditionIsTrue(status?.conditions, "Ready");
    });
    assert.ok(
      worker,
      "real plugin status proxy tests require a schedulable non-server k3d worker node.",
    );
    const nodeName = worker.metadata.name;
    fixture.driver = createDriver({ nodeSelector: { "kubernetes.io/hostname": nodeName } });
    await prepareRevisionEventually(fixture);
    await waitForGatewayRollout(fixture, "initial-rollout");
    return nodeName;
  }

  async function gatewayPodDiagnostics(fixture: StatusCandidate) {
    const { stdout } = await execute(
      "kubectl",
      kubectlArguments([
        "get",
        "pods",
        "--namespace",
        fixture.namespaceName,
        "--selector",
        gatewaySelector(fixture),
        "--request-timeout=10s",
        "-o",
        "json",
      ]),
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const pods = parseJson(stdout);
    assert.ok(Check(DiagnosticPods, pods), "kubectl returned invalid diagnostic Pod data");
    return pods.items.slice(0, 3).map(({ status }) => ({
      phase: status?.phase,
      ready: conditionIsTrue(status?.conditions, "Ready"),
      scheduled: conditionIsTrue(status?.conditions, "PodScheduled"),
      containers: [...(status?.initContainerStatuses ?? []), ...(status?.containerStatuses ?? [])]
        .filter(({ name }) => name === "gateway" || name === "prepare-private-state")
        .slice(0, 2)
        .map(({ name, restartCount, state, lastState }) => {
          const terminated = state?.terminated ?? lastState?.terminated;
          return {
            name,
            restartCount,
            exitCode: terminated?.exitCode,
            waitingReason: state?.waiting?.reason,
            terminatedReason: state?.terminated?.reason ?? lastState?.terminated?.reason,
          };
        }),
    }));
  }

  async function observeWithPodDiagnostics<Result>(
    fixture: StatusCandidate,
    stage: "initial-rollout" | "warning-rollout" | "ready-status" | "warning-status",
    observe: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await observe();
    } catch (error) {
      if (error instanceof Error) {
        try {
          // Keep the original failure and attach only bounded Pod lifecycle fields.
          const pods = await gatewayPodDiagnostics(fixture).catch(() => undefined);
          Object.assign(error, {
            openclawCiDiagnostic: { kind: "kubernetes-plugin-status", stage, pods },
          });
        } catch {
          // An error that cannot carry diagnostics still takes precedence.
        }
      }
      throw error;
    }
  }

  function waitForGatewayRollout(
    fixture: StatusCandidate,
    stage: "initial-rollout" | "warning-rollout",
  ) {
    return observeWithPodDiagnostics(fixture, stage, () =>
      kubectl(
        "rollout",
        "status",
        `deployment/${gatewayName(fixture.agentId)}`,
        "--namespace",
        fixture.namespaceName,
        "--timeout=180s",
      ),
    );
  }

  async function readPluginStatus(namespaceName: string, podName: string) {
    const rawPath = `/api/v1/namespaces/${namespaceName}/pods/${podName}:${statusPort}/proxy${statusPath}`;
    const { stdout } = await execute(
      "kubectl",
      kubectlArguments(["get", "--request-timeout=10s", "--raw", rawPath]),
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseJson(stdout);
  }

  function waitForReadyPluginStatus(
    fixture: StatusCandidate,
    nodeName: string,
    warning?: PluginDeploymentWarning,
  ) {
    const stage = warning === undefined ? "ready-status" : "warning-status";
    const evidence = warning === undefined ? "status" : "warning";
    return observeWithPodDiagnostics(fixture, stage, () =>
      waitFor(`ready plugin runtime ${evidence} from the exact gateway Pod`, async () => {
        const observation = await prepareRevisionEventually(fixture);
        // Require Driver readiness as well as the subsequent Pod and plugin checks.
        if (!observation.ready) {
          return undefined;
        }
        const pods = await resources(
          "pods",
          fixture.namespaceName,
          "--selector",
          gatewaySelector(fixture),
        );
        assert.ok(Check(GatewayPods, pods), "kubectl returned an invalid gateway Pod list");
        const ready = pods.filter(
          ({ metadata, status }) =>
            metadata.deletionTimestamp === undefined &&
            conditionIsTrue(status?.conditions, "Ready"),
        );
        const [pod] = ready;
        if (ready.length !== 1 || pod?.spec.nodeName !== nodeName) {
          return undefined;
        }
        const status = await readPluginStatus(fixture.namespaceName, pod.metadata.name).catch(
          () => undefined,
        );
        if (status === undefined) {
          return undefined;
        }
        assert.ok(Check(PluginStatus, status), "gateway returned invalid plugin runtime status");
        if (
          status.phase !== "ready" ||
          (warning !== undefined && JSON.stringify(status.failures) !== JSON.stringify([warning]))
        ) {
          return undefined;
        }
        assert.equal(status.revisionId, fixture.candidate.id);
        assert.equal(status.container, "gateway");
        assert.equal(status.podUid, pod.metadata.uid);
        return { observation, pod, status };
      }),
    );
  }

  async function injectGatewayInstallFailure({ namespaceName, agentId }: StatusCandidate) {
    await kubectl(
      "patch",
      "deployment",
      gatewayName(agentId),
      "--namespace",
      namespaceName,
      "--type",
      "strategic",
      "--patch",
      JSON.stringify({
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: "gateway",
                  env: [{ name: "OPENCLAW_FIXTURE_DIFFS_INSTALL_RESULT", value: "fail" }],
                },
              ],
            },
          },
        },
      }),
    );
  }

  async function readGatewayOpenClawConfig(namespaceName: string, podName: string) {
    const effective = parseJson(
      await kubectl(
        "exec",
        podName,
        "--namespace",
        namespaceName,
        "--",
        "cat",
        "/home/node/.openclaw/openclaw.json",
      ),
    );
    assert.ok(Check(EffectiveConfig, effective), "gateway returned invalid OpenClaw configuration");
    return effective;
  }

  test(
    "real Kubernetes Compute reads plugin runtime status from the exact gateway Pod",
    { ...requiresKubernetes, timeout: 360_000 },
    async (context) => {
      await assertPrerequisites();
      const fixture = await createStatusCandidate("plugin-status", context);
      const nodeName = await scheduleGatewayOnNonServerNode(fixture);

      const first = await waitForReadyPluginStatus(fixture, nodeName);
      assert.equal(first.pod.spec.nodeName, nodeName);
      assert.equal(first.observation.ready, true);
      assert.equal(first.observation.warnings, undefined);
      assert.deepEqual(first.status.successfulPluginIds, [pluginId]);
      assert.deepEqual(first.status.failures, []);

      // Deleting the Pod must invalidate its status even though the revision remains current.
      await kubectl(
        "delete",
        "pod",
        first.pod.metadata.name,
        "--namespace",
        fixture.namespaceName,
        "--wait=false",
      );
      const restarted = await waitForReadyPluginStatus(fixture, nodeName);
      assert.notEqual(restarted.pod.metadata.uid, first.pod.metadata.uid);
      assert.equal(restarted.pod.spec.nodeName, nodeName);
      assert.deepEqual(restarted.status.successfulPluginIds, [pluginId]);
      assert.deepEqual(restarted.status.failures, []);
      assert.equal(restarted.observation.ready, true);
    },
  );

  test(
    "real Kubernetes Compute reports plugin install warnings and disables failed plugin config",
    { ...requiresKubernetes, timeout: 360_000 },
    async (context) => {
      await assertPrerequisites();
      const fixture = await createStatusCandidate("plugin-status-warning", context);
      const nodeName = await scheduleGatewayOnNonServerNode(fixture);
      const ready = await waitForReadyPluginStatus(fixture, nodeName);
      assert.equal(ready.pod.spec.nodeName, nodeName);
      const warning: PluginDeploymentWarning = { pluginId, code: "PLUGIN_INSTALL_FAILED" };

      await injectGatewayInstallFailure(fixture);
      // The environment patch already replaces the Pod. Let that rollout finish
      // before reconciliation observes the new startup's injected install failure.
      await waitForGatewayRollout(fixture, "warning-rollout");

      const failedInstall = await waitForReadyPluginStatus(fixture, nodeName, warning);
      assert.notEqual(failedInstall.pod.metadata.uid, ready.pod.metadata.uid);
      assert.equal(failedInstall.pod.spec.nodeName, nodeName);
      assert.equal(failedInstall.observation.ready, true);
      assert.deepEqual(failedInstall.observation.warnings, [warning]);
      assert.deepEqual(failedInstall.status.successfulPluginIds, []);
      assert.deepEqual(failedInstall.status.failures, [warning]);

      const effective = await readGatewayOpenClawConfig(
        fixture.namespaceName,
        failedInstall.pod.metadata.name,
      );
      assert.deepEqual(effective.plugins.entries.diffs, { enabled: false });
      assert.equal(effective.tools?.alsoAllow?.includes("diffs") ?? false, false);
    },
  );
}
