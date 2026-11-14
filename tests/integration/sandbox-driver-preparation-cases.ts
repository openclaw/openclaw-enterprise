import assert from "node:assert/strict";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type {
  OpenShellGatewayClient,
  OpenShellWorkspaceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import type { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type KubernetesApi = InstanceType<KubernetesSdk["KubernetesObjectApi"]>;
type KubernetesObject = Parameters<KubernetesApi["create"]>[0];
type ResourceReference = Parameters<KubernetesApi["read"]>[0];
type PreparationApi = {
  create: (resource: KubernetesObject) => Promise<unknown>;
  read: (resource: ResourceReference) => Promise<KubernetesObject>;
  delete: (...args: Parameters<KubernetesApi["delete"]>) => Promise<void>;
  list: (...args: Parameters<KubernetesApi["list"]>) => Promise<{ items: KubernetesObject[] }>;
};

type WorkspaceGateway = ReturnType<typeof workspaceGatewayClient>;
type PreparationGateway = Omit<WorkspaceGateway, "calls" | "createSandbox"> &
  Pick<OpenShellGatewayClient, "createSandbox"> & {
    calls: Array<WorkspaceGateway["calls"][number] | ["deleteSandbox"]>;
  };

type PreparationDependencies = {
  V1Deployment: KubernetesSdk["V1Deployment"];
  openShellDriver: (
    gateway: PreparationGateway,
    configuration: NonNullable<Parameters<typeof openShellDriver>[1]>,
  ) => ReturnType<typeof openShellDriver>;
  runtimeSandboxFixture: (
    driver: ReturnType<typeof openShellDriver>,
    options: { harnessId: "openclaw" },
  ) => {
    context: SandboxNamespaceContext & { kubernetes: PreparationApi };
    revision: SandboxFixtureRevision;
    requirements: HarnessWorkloadRequirements & {
      workspaceMounts: Array<HarnessWorkloadRequirements["workspaceMounts"][number]>;
    };
    prepared: readonly KubernetesObject[];
  };
  ownedWorkspace: (name: string, namespaceId: string) => OpenShellWorkspaceResponse;
};

type PreparationOptions = { scratch?: boolean; dataMountPath?: string };

function assertPreparationResource(
  resource: KubernetesObject | undefined,
): asserts resource is ResourceReference {
  assert.equal(resource?.kind, "Deployment");
  assert.ok(resource?.metadata?.name);
  assert.ok(resource.metadata.namespace);
}

// These cases invoke the production Driver over controlled Kubernetes/Gateway
// transports. They prove cleanup selection, fencing and completion ordering, not
// Kubernetes garbage collection, filesystem isolation, or live Pod termination.
export function createOrphanedNativePreparation({
  V1Deployment,
  openShellDriver,
  runtimeSandboxFixture,
  ownedWorkspace,
}: PreparationDependencies) {
  return async function orphanedNativePreparation({
    scratch = false,
    dataMountPath = "/sandbox/enterprise",
  }: PreparationOptions = {}) {
    const gateway: PreparationGateway = workspaceGatewayClient();
    gateway.deleteSandbox = async () => {
      gateway.calls.push(["deleteSandbox"]);
    };
    const configuration = buildSandboxInstallation().drivers.sandbox.configuration;
    configuration.kubernetes.userNamespaces = false;
    configuration.kubernetes.sandboxDataMount.mountPath = dataMountPath;
    const driver = openShellDriver(gateway, configuration);
    const {
      context: namespaceContext,
      revision: fixtureRevision,
      requirements,
      prepared,
    } = runtimeSandboxFixture(driver, { harnessId: "openclaw" });
    const revision = completeWorkspaceRevision(fixtureRevision, requirements);
    // Revision cleanup confirms an absent Sandbox through the Workspace ensureNamespace created.
    const { name, id } = namespaceContext.namespace;
    gateway.workspaces.set(name, ownedWorkspace(name, id));
    if (scratch) {
      requirements.workspaceMounts.push({
        claimName: "operator-scratch",
        subPath: "scratch",
        mountPath: "/sandbox/scratch",
        readOnly: false,
      });
    }
    const api = namespaceContext.kubernetes;
    const create = api.create;
    // The API stored the real manifest, but the response never reached the Driver.
    api.create = async (resource) => {
      await create(resource);
      throw new Error("preparation create response lost");
    };
    const context = { ...namespaceContext, revision };
    await assert.rejects(
      driver.provisionHarness({ ...context, requirements }),
      /preparation create response lost/,
    );
    assert.equal(gateway.providers.size, 1);
    assert.equal(
      gateway.calls.some(([method]) => method === "deleteSandbox"),
      false,
    );
    const [resource] = prepared;
    assertPreparationResource(resource);
    const deployment = await api.read(resource);
    assert.ok(deployment instanceof V1Deployment);
    return { driver, gateway, api, resource, deployment, context, requirements };
  };
}
