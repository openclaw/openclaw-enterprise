import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  KubernetesComputeDriver,
  kubernetesGatewayNamespaceName,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/providers/repository-credentials/control-client.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "./console-app.mjs";

/** Real Console/API/Drivers with passive storage, but no cluster or external providers. */
export async function createConsoleRepositoryLaunchFixture(t) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  const compute = new KubernetesComputeDriver(
    {
      authentication: { mode: "inCluster" },
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }],
        repositoryCredentials: {
          namespace: "controller",
          podLabels: { app: "credentials" },
          port: 8443,
        },
      },
      servicePrincipalCredentials: { mode: "disabled" },
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        channels: { proxyUrl: "http://10.42.0.15:3128" },
      },
    },
    { id: "console-launch-compute" },
  );
  // This draft/deploy fixture has no PostgreSQL provisioning queue.
  compute.agentProvisioning = undefined;
  const namespaces = new Map();
  const secrets = new Map();
  const notFound = () =>
    Object.assign(new Error("Fixture Kubernetes resource missing."), {
      statusCode: 404,
    });
  // Only Kubernetes transport/storage is substituted. The real Driver generates
  // credentials and validates ownership/completeness; no workload is started.
  const clients = {
    core: {
      async listNamespace({ labelSelector }) {
        const namespaceId = labelSelector.slice("openclaw.dev/namespace=".length);
        return {
          items: [...namespaces.values()].filter(
            ({ metadata }) => metadata.labels["openclaw.dev/namespace"] === namespaceId,
          ),
        };
      },
      async readNamespace({ name }) {
        const value = namespaces.get(name);
        if (!value) {
          throw notFound();
        }
        return structuredClone(value);
      },
      async readNamespacedSecret({ namespace, name }) {
        const value = secrets.get(`${namespace}/${name}`);
        if (!value) {
          throw notFound();
        }
        return structuredClone(value);
      },
      async createNamespacedSecret({ namespace, body }) {
        const key = `${namespace}/${body.metadata.name}`;
        assert.equal(secrets.has(key), false);
        const { stringData, ...rest } = body;
        const saved = {
          ...structuredClone(rest),
          metadata: { ...body.metadata, uid: randomUUID() },
          data: Object.fromEntries(
            Object.entries(stringData).map(([name, value]) => [
              name,
              Buffer.from(value).toString("base64"),
            ]),
          ),
        };
        secrets.set(key, saved);
        return structuredClone(saved);
      },
    },
    apps: {
      async listNamespacedDeployment() {
        return { items: [] };
      },
    },
  };
  compute.apiClients = Promise.resolve(clients);
  const secretDriver = new KubernetesSecretDriver({ authentication: { mode: "inCluster" } });
  secretDriver.client = Promise.resolve(clients.core);
  const state = new InMemoryPlatformState();
  let managedPolicy = { identities: [], roles: [], bindings: [] };
  const storage = {
    read: (work) => state.read(work),
    async transact(work) {
      const result = await state.transact(work);
      // IAM reads a committed projection, including during a subsequent State
      // transaction. Reentering memory State.read there would wait on itself.
      managedPolicy = await state.read(async (unit) => {
        const identities = [];
        const roles = [];
        const bindings = [];
        for (const namespace of await unit.namespaces.listNamespaces()) {
          identities.push(
            ...(await unit.agents.listAgents(namespace.id)).map((agent) => ({
              id: agent.servicePrincipalId,
              kind: "service_principal",
              namespaceId: namespace.id,
              agentId: agent.id,
            })),
          );
          roles.push(...(await unit.iamPolicy.listRoles(namespace.id)));
          bindings.push(...(await unit.iamPolicy.listAccessBindings(namespace.id)));
        }
        return { identities, roles, bindings };
      });
      return result;
    },
  };
  const provider = {
    id: "console-repositories",
    type: "github",
    configuration: { registryPath: "/unused/console/registry.json" },
    drivers: { repo: "console-repository-driver" },
  };
  const fixture = await createConsoleAppFixture(t, {
    state: storage,
    providers: [provider],
    computeDriver: compute,
    secretDriver,
    recordOperations: true,
    // Credential provisioning requires a configured browser CSRF origin.
    publicOrigin: true,
  });
  await fixture.bootstrap("Repository demo");
  // Namespace provisioning is outside this Console journey. Seed its completed
  // lifecycle through State, not by replacing any Agent admission decision.
  const namespace = await fixture.createNamespace("Engineering");
  await storage.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const namespaceName = kubernetesNamespaceName(namespace.id);
  namespaces.set(namespaceName, {
    ...compute.manifest("v1", "Namespace", namespaceName, { namespaceId: namespace.id }),
    status: { phase: "Active" },
  });
  const controlNamespaceName = kubernetesGatewayNamespaceName(namespace.id);
  const controlNamespace = compute.manifest("v1", "Namespace", controlNamespaceName, {
    namespaceId: namespace.id,
  });
  delete controlNamespace.metadata.labels["openclaw.dev/namespace"];
  controlNamespace.metadata.labels["openclaw.dev/gateway-namespace"] = namespace.id;
  namespaces.set(controlNamespaceName, {
    ...controlNamespace,
    status: { phase: "Active" },
  });
  const repo = new GitHubRepoDriver(
    {
      id: provider.id,
      client: new UnixRepositoryCredentialControlClient({
        controlSocket: "/unused/console/control.sock",
      }),
      drivers: provider.drivers,
    },
    validateGitHubRepositoryRegistry(
      {
        version: 1,
        providerId: provider.id,
        providerInstanceId: "console-repository-provider",
        appId: "123",
        githubInstallationId: "456",
        maximumDurationSeconds: 3600,
        repositories: ["application", "documentation"].map((name, index) => ({
          repositoryRef: name,
          repositoryId: String(789 + index),
          repository: `example/${name}`,
          namespaces: [
            {
              namespaceId: namespace.id,
              profiles: ["git-read", "git-write", "git-full"],
            },
          ],
        })),
      },
      provider.id,
    ),
    { sessionDurationSeconds: 600 },
  );
  fixture.controller.registerDriver(repo);
  fixture.controller.selectDriver("repo", repo.id);
  // Read managed policy written through the actual IAM API. The adapter supplies
  // state only; NativeIAMDriver remains the authorization decision owner.
  const iam = new NativeIAMDriver(
    {
      async loadNativeIAMState() {
        return {
          ...fixture.policy,
          identities: [...fixture.policy.identities, ...managedPolicy.identities],
          roles: [...fixture.policy.roles, ...managedPolicy.roles],
          bindings: [...fixture.policy.bindings, ...managedPolicy.bindings],
        };
      },
    },
    { id: "console-launch-iam" },
  );
  fixture.controller.registerDriver(iam);
  fixture.controller.selectDriver("iam", iam.id);
  const modelSecret = await fixture.createSecret(
    namespace.id,
    "Demo model credential",
    "synthetic-model-credential",
  );
  async function grantModelAccess(agent) {
    const role = await fixture.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
      body: { name: "Model access", permissions: [{ action: "operate", resourceKind: "secret" }] },
    });
    assert.equal(role.status, 201);
    const binding = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/iam/access-bindings`,
      {
        body: {
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId: role.data.id,
          resourceKind: "secret",
          resourceId: modelSecret.id,
        },
      },
    );
    assert.equal(binding.status, 201);
  }
  return { fixture, namespace, modelSecret, grantModelAccess };
}
