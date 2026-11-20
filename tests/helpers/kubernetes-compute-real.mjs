import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  createKubernetesFixtureHarnessAuth,
  retryKubectlRead,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.ts";
import { kubectlGetJson } from "../helpers/kubernetes-api-read.ts";
import { waitForResult } from "../helpers/wait-for.ts";

export const execute = promisify(execFile);
export const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
export const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
export const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
export const runtimeImage = process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
export const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
export const requested = [kubeconfigPath, kubernetesContext, fixtureImage].some(Boolean);
export const requiresKubernetes = {
  skip: requested
    ? false
    : "Set OCC_TEST_KUBERNETES_KUBECONFIG, OCC_TEST_KUBERNETES_CONTEXT to a k3d-* context, and OCC_TEST_KUBERNETES_IMAGE to run real Kubernetes integration tests.",
};
export const requiresKubernetesAndPostgres = {
  skip: !requested
    ? requiresKubernetes.skip
    : databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a dedicated openclaw_k8s_* database to run Kubernetes API and worker integration.",
};
export const { kubernetesGatewayNamespaceName } =
  await import("../../apps/controller/src/drivers/compute/kubernetes/index.ts");

export const driverPath = "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
const configurationIds = new Map();
export const probeSource = await readFile(
  new URL("../fixtures/kubernetes/probe.mts", import.meta.url),
  "utf8",
);
const harnessAuthentication = new Map();

/** @param {string} value */
export function hash(value, length = 12) {
  return sha256Hex(value, length);
}

/** @param {...string} args */
export async function kubectl(...args) {
  const answered = await kubectlGetJson({ kubeconfigPath, kubernetesContext }, args);
  if (answered !== undefined) {
    return answered;
  }
  const { stdout } = await execute(
    "kubectl",
    ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext, ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

// A get, or an exec that only reads, survives a dropped API server or kubelet
// stream (finding 308: an exec into a Ready gateway Pod failed with
// "error: EOF"). Commands that change state stay single-shot.
/** @param {...string} args */
export function kubectlRead(...args) {
  return retryKubectlRead(() => kubectl(...args));
}

/** @param {string} kind @param {string} name @param {string} [namespace] */
export async function resource(kind, name, namespace) {
  const args = ["get", kind, name, "-o", "json"];
  if (namespace !== undefined) {
    args.push("--namespace", namespace);
  }
  return JSON.parse(await kubectlRead(...args));
}

/** @param {string} kind @param {string} namespace */
export async function resources(kind, namespace) {
  return JSON.parse(await kubectlRead("get", kind, "--namespace", namespace, "-o", "json")).items;
}

function notFound(error) {
  return /NotFound|not found/i.test(error.stderr ?? error.message);
}

/** @param {string} kind @param {string} name @param {string} [namespace] */
export async function missing(kind, name, namespace) {
  try {
    await resource(kind, name, namespace);
    return false;
  } catch (error) {
    if (notFound(error)) {
      return true;
    }
    throw error;
  }
}

/**
 * @template T
 * @param {string | (() => string)} description
 * @param {() => T | false | undefined | PromiseLike<T | false | undefined>} operation
 * @returns {Promise<T>}
 */
export function waitFor(description, operation, timeoutMs = 120_000) {
  return waitForResult(description, operation, { timeoutMs, intervalMs: 500 });
}

// Asserts a PersistentVolumeClaim's delete was already issued, then waits for the claim to go.
// A deleted claim stays Terminating until Kubernetes' PVC-protection controller has seen every
// Pod using it removed, which can trail the Pods' own removal (finding 2409).
export async function waitForDeletedClaim(name, namespace) {
  await waitFor(`PersistentVolumeClaim ${name} to be removed`, async () => {
    let claim;
    try {
      claim = await resource("persistentvolumeclaim", name, namespace);
    } catch (error) {
      if (notFound(error)) {
        return true;
      }
      throw error;
    }
    assert.notEqual(
      claim.metadata?.deletionTimestamp,
      undefined,
      `PersistentVolumeClaim ${name} was not deleted`,
    );
    return undefined;
  });
}

// Test cleanup deletes its randomly named namespaces without waiting: no later step reads
// them, and each deletion waits out namespace-controller passes (5 s each, longer while Pods
// terminate). local-path removes a deleted claim's volume directory with a helper Pod, maybe
// after the file ends; lane cleanup removes whatever such volumes leave in the shared storage
// (scripts/ci/cleanup.ts), so no file waits for them.
/** @param {...string} names */
export function deleteNamespaces(...names) {
  return kubectl("delete", "namespace", ...names, "--ignore-not-found=true", "--wait=false");
}

export async function assertKubernetesFixtureAvailable() {
  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE is required.");
  await validateExplicitK3dLoopbackContext({ kubeconfigPath, kubernetesContext });
}

export function namespace(label) {
  const id = `ns_${label}_${randomUUID()}`;
  return {
    id,
    name: label,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

export async function provisionFixtureAuth(owner) {
  const auth = await createKubernetesFixtureHarnessAuth({
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    namespaceId: owner.id,
  });
  harnessAuthentication.set(owner.id, auth);
}

export function revisionContext(candidate) {
  const auth = harnessAuthentication.get(candidate.namespaceId);
  assert.ok(auth, "the ready Namespace must have its fixture authentication provisioned");
  return auth.context;
}

export function revision(driver, owner, agentId, number) {
  const identity = `${owner.id}:${agentId}`;
  let configurationId = configurationIds.get(identity);
  if (configurationId === undefined) {
    configurationId = `cfg_${randomUUID()}`;
    configurationIds.set(identity, configurationId);
  }
  const loggingLevel = number === 1 ? "info" : "debug";
  const candidate = {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: number,
    configurationId,
    configurationKind: "agent",
    configurationGeneration: number,
    configuration: admitLoggingConfiguration(
      {
        gateway: { controlUi: { enabled: false } },
        agents: { defaults: { model: "codex/gpt-5" } },
        logging: { level: loggingLevel },
      },
      loggingLevel,
    ),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    harnessAuth: harnessAuthentication.get(owner.id).snapshot,
    compute: { id: driver.id, implementation: driver.implementation },
    executionAdmission: { version: 2, mode: "unprotected" },
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
  candidate.harness.overrides = {};
  candidate.harness.configuration = driver.resolveHarnessConfiguration(
    candidate.harness,
    candidate.harnessAuth,
    candidate.configuration,
  );
  candidate.compute.admission = driver.admitRevision(candidate);
  return candidate;
}

export function agentName(agentId) {
  return `agent-${hash(agentId)}`;
}

/** @param {string} agentId */
export function gatewayName(agentId) {
  return `gateway-${hash(agentId)}`;
}

/** @param {string} agentId */
export function harnessWorkspaceClaimName(agentId) {
  return `workspace-${hash(agentId)}`;
}

/** @param {{agentId: string, id: string}} candidate */
export function revisionName(candidate) {
  return `${agentName(candidate.agentId)}-rev-${hash(candidate.id)}`;
}

export function fixtureComputeConfiguration(overrides = {}) {
  const workloadResources = {
    requests: { cpu: "25m", memory: "48Mi" },
    limits: { cpu: "250m", memory: "192Mi" },
  };
  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    images: { gateway: fixtureImage, agent: fixtureImage, requireImmutableDigest: false },
    resources: {
      gateway: workloadResources,
      agent: workloadResources,
      namespace: {
        quota: {
          pods: "20",
          "requests.cpu": "1",
          "requests.memory": "1Gi",
          "limits.cpu": "4",
          "limits.memory": "3Gi",
        },
        containerDefaults: workloadResources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      gatewayClients: [
        { namespace: "default", podLabels: { "app.kubernetes.io/name": "platform-probe" } },
      ],
    },
    servicePrincipalCredentials: {
      mode: "projectedServiceAccountToken",
      audience: "openclaw-enterprise",
      expirationSeconds: 3_600,
    },
    ...overrides,
  };
}

/**
 * @param {Partial<import("../../apps/controller/src/drivers/compute/kubernetes/index.ts").KubernetesComputeDriverOptions>} [overrides]
 * @param {ConstructorParameters<typeof import("../../apps/controller/src/drivers/compute/kubernetes/index.ts").KubernetesComputeDriver>[1]} [selection]
 */
export async function createDriver(overrides = {}, selection = {}) {
  const { KubernetesComputeDriver, kubernetesNamespaceName } =
    await import("../../apps/controller/src/drivers/compute/kubernetes/index.ts");
  return {
    driver: new KubernetesComputeDriver(fixtureComputeConfiguration(overrides), selection),
    kubernetesNamespaceName,
  };
}

export async function authorized(namespaceName, actor, verb, kind) {
  const output = await kubectl(
    "auth",
    "can-i",
    verb,
    kind,
    "--namespace",
    namespaceName,
    `--as=${actor}`,
  ).catch(({ stdout }) => stdout);
  return output.trim() === "yes";
}

/**
 * @param {import("./console-file-app.ts").CleanupRegistrar} context
 * @param {string} installationId
 * @param {string} platformNamespace
 * @returns {Promise<{authentication: Extract<import("../../apps/controller/src/drivers/kubernetes/authentication.ts").KubernetesAuthentication, {mode: "kubeconfig"}>, account: string, tenantRole: string}>}
 */
export async function createScopedController(context, installationId, platformNamespace) {
  const identifier = hash(installationId);
  const account = "openclaw-controller";
  const namespaceRole = `oce-namespaces-${identifier}`;
  const tenantRole = `oce-tenant-${identifier}`;
  const binding = `oce-controller-${identifier}`;
  const directory = await mkdtemp(join(tmpdir(), "openclaw-kubernetes-controller-"));
  context.after(async () => {
    await kubectl("delete", "clusterrolebinding", binding, "--ignore-not-found=true");
    await kubectl("delete", "clusterrole", namespaceRole, tenantRole, "--ignore-not-found=true");
    await rm(directory, { force: true, recursive: true });
  });

  await kubectl("create", "serviceaccount", account, "--namespace", platformNamespace);
  await kubectl(
    "create",
    "clusterrole",
    namespaceRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=namespaces",
  );
  await kubectl(
    "patch",
    "clusterrole",
    namespaceRole,
    "--type=json",
    "--patch",
    JSON.stringify([
      {
        op: "add",
        path: "/rules/-",
        value: { nonResourceURLs: ["/version"], verbs: ["get"] },
      },
    ]),
  );
  await kubectl(
    "create",
    "clusterrole",
    tenantRole,
    "--verb=create,get,list,patch,update,delete",
    "--resource=deployments.apps,services,serviceaccounts,configmaps,endpointslices.discovery.k8s.io,networkpolicies.networking.k8s.io,resourcequotas,limitranges",
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
        value: { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "create", "delete"] },
      },
      {
        op: "add",
        path: "/rules/-",
        value: { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["get", "list"] },
      },
      {
        op: "add",
        path: "/rules/-",
        value: {
          apiGroups: [""],
          resources: ["secrets"],
          verbs: ["get", "create", "update", "delete"],
        },
      },
    ]),
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
          resources: ["pods"],
          verbs: ["get", "list", "watch", "patch"],
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
  const current = JSON.parse(
    await kubectl("config", "view", "--minify", "--flatten", "-o", "json"),
  );
  const scopedContext = `scoped-${identifier}`;
  const scopedKubeconfig = join(directory, "kubeconfig.json");
  await writeFile(
    scopedKubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "local", cluster: current.clusters[0].cluster }],
      users: [{ name: account, user: { token } }],
      contexts: [{ name: scopedContext, context: { cluster: "local", user: account } }],
      "current-context": scopedContext,
    }),
    { mode: 0o600 },
  );

  return {
    authentication: {
      mode: "kubeconfig",
      kubeconfigPath: scopedKubeconfig,
      context: scopedContext,
    },
    account,
    tenantRole,
  };
}
