import assert from "node:assert/strict";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { labelSelectorLabels, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  readyServiceEndpointSliceList,
  singleReplicaReadyDeploymentStatus,
} from "./kubernetes-gateway-readiness-fixture.ts";

const coreKinds = [
  "ConfigMap",
  "Secret",
  "Service",
  "ServiceAccount",
  "PersistentVolumeClaim",
  "ResourceQuota",
] as const;

type NamespacedKind = (typeof coreKinds)[number] | "Deployment" | "NetworkPolicy";

type FixtureObject = {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    resourceVersion?: string;
    generation?: number;
    [field: string]: unknown;
  };
  spec?: unknown;
  status?: unknown;
  stringData?: Record<string, string>;
  data?: unknown;
  [field: string]: unknown;
};

type DeploymentObject = FixtureObject & { spec: { template?: unknown } };
type WorkspaceNodeBinding = FixtureObject & { data: { "workspace-node.json": string } };
type SetupPodPatch = { metadata: { annotations: Record<string, unknown> } };
type FixtureClock = { now: number };

type FixtureState = {
  unreadableKind?: string;
  providerPod?: unknown;
  terminatingRole?: string;
  unschedulableRole?: string;
  waitingRole?: string;
  waitingStatuses?: string;
  waitingReason?: unknown;
  pairAfterSetupMs?: number;
  pairAtMs?: number;
  gatewayAppliesBinding: boolean;
  gatewayWorkspaceNodeId?: unknown;
  gatewayWorkspaceNodeFailure?: unknown;
  gatewayRuntimeFailure?: unknown;
};

type FixtureOptions = {
  namespace: string;
  gatewayName: string;
  state: FixtureState;
  revision: { id: string };
  sandboxDriver: unknown;
  clock: FixtureClock | undefined;
};

type NamespacedName = { name: string; namespace?: string };
type SelectorRequest = { labelSelector?: string };
type WriteRequest = { body: FixtureObject };
type WriteObject = (
  request: WriteRequest,
  options?: { replace?: boolean },
) => Promise<FixtureObject>;

type NamespacedClient = Partial<
  Record<`readNamespaced${NamespacedKind}`, (request: NamespacedName) => Promise<FixtureObject>> &
    Record<`${"patch" | "create" | "replace"}Namespaced${NamespacedKind}`, WriteObject>
>;

type FixtureClients = {
  core: NamespacedClient & {
    listNamespace?: (request: SelectorRequest) => Promise<{ items: FixtureObject[] }>;
    readNamespace?: (request: { name: string }) => Promise<FixtureObject>;
    listNamespacedPod?: (
      request: SelectorRequest & { namespace?: string },
    ) => Promise<{ items: unknown[] }>;
    patchNamespacedPod?: (request: NamespacedName & { body: unknown }) => Promise<unknown>;
    connectGetNamespacedPodProxyWithPath?: (request: {
      name: string;
      path?: string;
    }) => Promise<unknown>;
  };
  apps: NamespacedClient;
  networking: NamespacedClient;
  objects: {
    read?: (object: FixtureObject) => Promise<FixtureObject>;
    patch?: (object: FixtureObject) => Promise<FixtureObject>;
  };
  discovery: {
    listNamespacedEndpointSlice?: () => Promise<unknown>;
  };
};

export function createDedicatedDeployKubernetesFixture(
  { namespace, gatewayName, state, revision, sandboxDriver, clock }: FixtureOptions,
  seed: (save: (object: FixtureObject) => void) => void,
) {
  const objects = new Map<string, FixtureObject>();
  const templates: Array<{ name: string; template: unknown }> = [];
  const key = (kind: string, name: string, target = namespace) =>
    `${kind}:${kind === "Namespace" ? "" : target}:${name}`;
  const save = (object: FixtureObject) =>
    objects.set(
      key(object.kind, object.metadata.name, object.metadata.namespace),
      structuredClone(object),
    );
  const read = (kind: string, name: string, target = namespace) => {
    const value = objects.get(key(kind, name, target));
    if (!value) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    return structuredClone(value);
  };

  seed(save);

  // Only transport observations are supplied. Startup order and readiness use
  // the real driver; successful writes do not make a Deployment ready.
  const clients: FixtureClients = {
    core: {},
    apps: {},
    networking: {},
    objects: {},
    discovery: {},
  };
  const namespacedClients: Array<[NamespacedClient, readonly NamespacedKind[]]> = [
    [clients.core, coreKinds],
    [clients.apps, ["Deployment"]],
    [clients.networking, ["NetworkPolicy"]],
  ];
  for (const [api, kinds] of namespacedClients) {
    for (const kind of kinds) {
      api[`readNamespaced${kind}`] = async ({ name, namespace: target }: NamespacedName) => {
        if (state.unreadableKind === kind) {
          throw Object.assign(new Error("forbidden"), { statusCode: 403 });
        }
        return read(kind, name, target);
      };
      const write: WriteObject = async ({ body }, { replace = false } = {}) => {
        const previous = objects.get(key(kind, body.metadata.name, body.metadata.namespace));
        // Like the API server: every write bumps resourceVersion, and a replace that names a
        // stale one is a 409 Conflict (finding 1678). Two writes with the metadata of one read,
        // as workspaceNodeReady once did (#2750 review), fail here as they do live.
        const current = previous?.metadata.resourceVersion;
        const named = body.metadata.resourceVersion;
        if (replace && previous !== undefined && named !== undefined && named !== current) {
          throw Object.assign(
            new Error(
              `Operation cannot be fulfilled on ${kind} ${body.metadata.name}: the object has been modified`,
            ),
            { statusCode: 409 },
          );
        }
        const changed =
          kind === "Deployment" && JSON.stringify(previous?.spec) !== JSON.stringify(body.spec);
        const value: FixtureObject = {
          ...previous,
          ...structuredClone(body),
          metadata: {
            ...previous?.metadata,
            ...body.metadata,
            uid: `${body.metadata.name}-uid`,
            resourceVersion: String(Number(current ?? "0") + 1),
          },
        };
        if (kind === "Deployment") {
          const deployment = body as DeploymentObject;
          const template = JSON.stringify(deployment.spec.template);
          if (
            template !== JSON.stringify((previous as DeploymentObject | undefined)?.spec.template)
          ) {
            // Each new pod template is a workload start: both use Recreate.
            templates.push({
              name: body.metadata.name,
              template: structuredClone(deployment.spec.template),
            });
          }
          value.metadata.generation = (previous?.metadata.generation ?? 0) + Number(changed);
          if (changed) {
            delete value.status;
          }
        }
        if (body.stringData) {
          value.data = Object.fromEntries(
            Object.entries(body.stringData).map(([name, value]) => [
              name,
              Buffer.from(value).toString("base64"),
            ]),
          );
        }
        save(value);
        return value;
      };
      api[`patchNamespaced${kind}`] = write;
      api[`createNamespaced${kind}`] = write;
      api[`replaceNamespaced${kind}`] = (request: WriteRequest) =>
        write(request, { replace: true });
    }
  }
  clients.core.listNamespace = async ({ labelSelector }) => ({
    items:
      namespace !== kubernetesNamespaceName(tenant.id) &&
      labelSelector === `openclaw.dev/namespace=${tenant.id}`
        ? [read("Namespace", namespace)]
        : [],
  });
  clients.core.readNamespace = async ({ name }) => read("Namespace", name);
  clients.objects.read = async (object) =>
    read(object.kind, object.metadata.name, object.metadata.namespace);
  clients.objects.patch = async (object) => {
    save(object);
    return object;
  };
  clients.discovery.listNamespacedEndpointSlice = async () =>
    readyServiceEndpointSliceList(gatewayName);
  clients.core.listNamespacedPod = async ({ labelSelector, namespace: requestedNamespace }) => {
    const labels = labelSelectorLabels(labelSelector) as Record<string, string | undefined>;
    const role = labels["openclaw.dev/workload-role"];
    if (role === "agent" && sandboxDriver !== undefined) {
      return { items: state.providerPod === undefined ? [] : [structuredClone(state.providerPod)] };
    }
    return {
      items: [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: `${role}-pod`,
            namespace: requestedNamespace,
            uid: `${role}-uid`,
            labels,
            // A Pod being deleted, as during a rollout or a scale-down.
            ...(state.terminatingRole === role
              ? { deletionTimestamp: "2026-08-25T00:00:00Z" }
              : {}),
          },
          ...(state.unschedulableRole === role
            ? {
                status: {
                  phase: "Pending",
                  conditions: [
                    {
                      type: "PodScheduled",
                      status: "False",
                      reason: "Unschedulable",
                      message: "0/1 nodes are available: 1 Insufficient memory.",
                    },
                  ],
                },
              }
            : state.waitingRole === role
              ? {
                  status: {
                    phase: "Pending",
                    conditions: [{ type: "PodScheduled", status: "True" }],
                    [state.waitingStatuses ?? "containerStatuses"]: [
                      {
                        name: role,
                        state: {
                          waiting: {
                            reason: state.waitingReason,
                            message: "Back-off pulling image registry.invalid/runtime:missing",
                          },
                        },
                      },
                    ],
                  },
                }
              : { status: { phase: "Running", podIP: "10.42.0.12" } }),
        },
      ],
    };
  };
  // Annotation patches on running Pods: the kubelet syncs a Pod on this update
  // event, which refreshes its optional setup Secret volume at once.
  const podPatches: Array<{ name: string; namespace: string | undefined; body: unknown }> = [];
  clients.core.patchNamespacedPod = async ({ name, namespace: target, body }) => {
    podPatches.push({ name, namespace: target, body: structuredClone(body) });
    if (
      name === "agent-pod" &&
      state.pairAfterSetupMs !== undefined &&
      (body as SetupPodPatch).metadata.annotations["openclaw.dev/workspace-node-setup"] !==
        undefined
    ) {
      // The setup file reaches the running Harness; its node host boots and pairs.
      assert.notEqual(clock, undefined, "pairAfterSetupMs needs the fake clock");
      state.pairAtMs = (clock as FixtureClock).now + state.pairAfterSetupMs;
    }
    const binding = objects.get(key("ConfigMap", `${gatewayName}-workspace-node`, namespace));
    if (name === "gateway-pod" && binding !== undefined && state.gatewayAppliesBinding) {
      // The kubelet refreshes the volume and the wrapper hot-applies the node.
      const { revisionId, deviceId } = JSON.parse(
        (binding as WorkspaceNodeBinding).data["workspace-node.json"],
      ) as { revisionId?: unknown; deviceId?: unknown };
      if (revisionId === revision.id) {
        state.gatewayWorkspaceNodeId = deviceId;
      }
    }
    return body;
  };
  clients.core.connectGetNamespacedPodProxyWithPath = async ({ name, path }) => {
    const role = name.startsWith("agent-") ? "agent" : "gateway";
    if (path === "openclaw/runtime/status") {
      return {
        revisionId: revision.id,
        container: role,
        podUid: `${role}-uid`,
        ...(role === "gateway" && state.gatewayWorkspaceNodeId !== undefined
          ? { workspaceNodeId: state.gatewayWorkspaceNodeId }
          : {}),
        ...(role === "gateway" && state.gatewayWorkspaceNodeFailure !== undefined
          ? { workspaceNodeFailure: state.gatewayWorkspaceNodeFailure }
          : {}),
        ...(role === "gateway" && state.gatewayRuntimeFailure !== undefined
          ? { runtimeFailure: state.gatewayRuntimeFailure }
          : {}),
      };
    }
    return {
      revisionId: revision.id,
      container: role,
      podUid: `${role}-uid`,
      startupId: `${role}-startup`,
      phase: "ready",
      successfulPluginIds: ["codex-plugin:example"],
      failures: [],
    };
  };

  const markReady = (name: string) => {
    const object = read("Deployment", name);
    object.status = singleReplicaReadyDeploymentStatus(object.metadata.generation);
    save(object);
  };

  return { objects, templates, key, save, read, clients, podPatches, markReady };
}
