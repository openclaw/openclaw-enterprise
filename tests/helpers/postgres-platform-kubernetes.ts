import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import Type from "typebox";
import { Check } from "typebox/value";

import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  createKubernetesInstallationConfiguration,
  kubectlArguments,
  kubernetesHash,
  validateExplicitK3dLoopbackContext,
} from "./kubernetes-real.mjs";
import { waitFor } from "./wait-for.mjs";

const execute = promisify(execFile);
const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
const selection = { kubeconfigPath, kubernetesContext };
const kubeconfigSchema = Type.Object({
  clusters: Type.Array(Type.Object({ cluster: Type.Object({ server: Type.String() }) }), {
    minItems: 1,
    maxItems: 1,
  }),
});
type StartupEnvironment = {
  environment: { OCC_CONFIG_PATH: string };
  platformNamespace: string;
  account: string;
  tenantRole: string;
};
const kubernetesStartupEnvironments = new WeakMap<TestContext, StartupEnvironment>();
const kubernetesWorkloadResources = Object.freeze({
  requests: Object.freeze({ cpu: "25m", memory: "48Mi" }),
  limits: Object.freeze({ cpu: "250m", memory: "192Mi" }),
});

async function kubectl(...args: string[]) {
  const { stdout } = await execute("kubectl", kubectlArguments(selection, args), {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export async function createKubernetesStartupEnvironment(context: TestContext) {
  // The API and worker share a scoped controller identity; the base kubeconfig is used only
  // to create that identity and grant per-tenant access after each Namespace exists.
  const cached = kubernetesStartupEnvironments.get(context);
  if (cached !== undefined) {
    return cached;
  }

  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE is required.");
  await validateExplicitK3dLoopbackContext(selection);
  const installationId = `ins_${randomUUID()}`;
  const identifier = kubernetesHash(installationId);
  const account = "openclaw-controller";
  const namespaceRole = `oce-postgres-namespaces-${identifier}`;
  const tenantRole = `oce-postgres-tenant-${identifier}`;
  const binding = `oce-postgres-controller-${identifier}`;
  const platformNamespace = `oce-postgres-platform-${identifier}`;
  const directory = await mkdtemp(join(tmpdir(), "openclaw-postgres-kubernetes-"));
  context.after(async () => {
    const cleanup = await Promise.allSettled([
      kubectl("delete", "namespace", platformNamespace, "--ignore-not-found=true", "--wait=true"),
      kubectl("delete", "clusterrolebinding", binding, "--ignore-not-found=true"),
      kubectl("delete", "clusterrole", namespaceRole, tenantRole, "--ignore-not-found=true"),
      rm(directory, { recursive: true, force: true }),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ reason }) => reason));
    }
  });

  await kubectl("create", "namespace", platformNamespace);
  await kubectl("create", "serviceaccount", account, "--namespace", platformNamespace);
  await kubectl(
    "create",
    "clusterrole",
    namespaceRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=namespaces",
  );
  await kubectl(
    "create",
    "clusterrole",
    tenantRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges,secrets",
  );
  await kubectl(
    "patch",
    "clusterrole",
    tenantRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          // Match the worker's production plugin-status Pod observation permissions.
          resources: ["pods"],
          verbs: ["get", "list", "watch"],
        },
      },
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          // The worker reads the runtime-owned status endpoint through the Pod proxy.
          resources: ["pods/proxy"],
          verbs: ["get"],
        },
      },
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          resources: ["persistentvolumeclaims"],
          verbs: ["get", "create", "patch", "delete"],
        },
      },
    ]),
  );
  await kubectl(
    "create",
    "clusterrolebinding",
    binding,
    `--clusterrole=${namespaceRole}`,
    `--serviceaccount=${platformNamespace}:${account}`,
  );

  const token = (
    await kubectl("create", "token", account, "--namespace", platformNamespace)
  ).trim();
  const current: unknown = JSON.parse(
    await kubectl("config", "view", "--minify", "--flatten", "-o", "json"),
  );
  assert.ok(
    Check(kubeconfigSchema, current),
    "expected a single cluster in the selected kubeconfig",
  );
  const [selectedCluster] = current.clusters;
  assert.ok(selectedCluster);
  const scopedContext = `scoped-${identifier}`;
  const scopedKubeconfig = join(directory, "kubeconfig.json");
  await writeFile(
    scopedKubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "local", cluster: selectedCluster.cluster }],
      users: [{ name: account, user: { token } }],
      contexts: [{ name: scopedContext, context: { cluster: "local", user: account } }],
      "current-context": scopedContext,
    }),
    { mode: 0o600 },
  );

  const authentication = {
    mode: "kubeconfig",
    kubeconfigPath: scopedKubeconfig,
    context: scopedContext,
  };
  const installation = createKubernetesInstallationConfiguration({
    authentication,
    platformNamespace,
    gatewayImage: fixtureImage,
    codexImage: fixtureImage,
    cluster: `postgres-platform-state-${identifier}`,
    codexSeccompProfile: undefined,
  });
  const { runtime: _runtime, ...compute } = installation.drivers.compute.configuration;
  const configuration = {
    ...installation,
    drivers: {
      ...installation.drivers,
      compute: {
        ...installation.drivers.compute,
        configuration: {
          ...compute,
          images: { ...compute.images, requireImmutableDigest: false },
          resources: {
            ...compute.resources,
            gateway: structuredClone(kubernetesWorkloadResources),
            agent: structuredClone(kubernetesWorkloadResources),
            namespace: {
              quota: {
                pods: "20",
                "requests.cpu": "1",
                "requests.memory": "1Gi",
                "limits.cpu": "4",
                "limits.memory": "3Gi",
              },
              containerDefaults: structuredClone(kubernetesWorkloadResources),
            },
          },
          network: { ...compute.network, gatewayPort: 8080 },
        },
      },
    },
  };
  const configurationPath = join(directory, "installation.yaml");
  await writeFile(configurationPath, JSON.stringify(configuration), {
    encoding: "utf8",
    mode: 0o600,
  });

  const environment = { OCC_CONFIG_PATH: configurationPath };
  const startup = { environment, platformNamespace, account, tenantRole };
  kubernetesStartupEnvironments.set(context, startup);
  return startup;
}

function kubectlErrorText(error: unknown) {
  if (error instanceof Error) {
    return "stderr" in error && typeof error.stderr === "string" ? error.stderr : error.message;
  }
  return String(error);
}

async function waitForKubernetesNamespace(name: string) {
  return waitFor(
    `Kubernetes Namespace ${name}`,
    async () => {
      try {
        await kubectl("get", "namespace", name, "-o", "json");
        return name;
      } catch (error) {
        // Only a missing Namespace means "not yet"; any other kubectl failure fails now.
        if (!/NotFound|not found/i.test(kubectlErrorText(error))) {
          throw error;
        }
        return undefined;
      }
    },
    { timeoutMs: 60_000, intervalMs: 100 },
  );
}

export async function grantTenantAccess(context: TestContext, namespaceId: string) {
  // Kubernetes namespace creation succeeds before tenant resources can be reconciled;
  // this mirrors the operator-owned RoleBinding handoff required by the real driver.
  const { platformNamespace, account, tenantRole } =
    await createKubernetesStartupEnvironment(context);
  const name = kubernetesNamespaceName(namespaceId);
  await waitForKubernetesNamespace(name);
  try {
    await kubectl(
      "create",
      "rolebinding",
      "openclaw-controller",
      "--namespace",
      name,
      `--clusterrole=${tenantRole}`,
      `--serviceaccount=${platformNamespace}:${account}`,
    );
  } catch (error) {
    if (!/AlreadyExists|already exists/i.test(kubectlErrorText(error))) {
      throw error;
    }
  }
}

export function cleanupKubernetesNamespaces(context: TestContext, namespaceIds: readonly string[]) {
  context.after(async () => {
    const cleanup = await Promise.allSettled(
      namespaceIds
        .map(kubernetesNamespaceName)
        .map((name) =>
          kubectl("delete", "namespace", name, "--ignore-not-found=true", "--wait=true"),
        ),
    );
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ reason }) => reason));
    }
  });
}
