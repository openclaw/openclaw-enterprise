import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/providers/repository-credentials/control-client.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  createAuthenticatedControllerRequest,
  createTestAuthPrincipal,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const driverId = "repository-credentials";
const providerId = "repository-provider";
const selection = [{ repositoryRef: "project", profile: "git-write" }];

function kubernetesCompute() {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  return new KubernetesComputeDriver({
    authentication: { mode: "inCluster" },
    images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: { quota: { pods: "10" }, containerDefaults: resources },
    },
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    network: {
      dns: { namespace: "kube-system", podLabels: { app: "dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }],
      repositoryCredentials: { namespace: "controller", podLabels: { app: "worker" }, port: 8443 },
    },
    servicePrincipalCredentials: { mode: "disabled" },
  });
}

function sshCompute() {
  return new SshComputeDriver({
    ssh: { identityFile: "/tmp/admission-key", knownHostsFile: "/tmp/admission-hosts" },
    hosts: { repositories: { address: "127.0.0.1", user: "root" } },
    runtime: {
      nodePath: "/usr/bin/node",
      openclawPath: "/opt/openclaw/index.js",
      user: "openclaw",
      root: "/tmp/admission-runtime",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  });
}

function registryFor(namespaceId) {
  return {
    version: 1,
    providerId,
    providerInstanceId: "github-admission",
    appId: "123",
    githubInstallationId: "456",
    maximumDurationSeconds: 3600,
    repositories: [
      {
        repositoryRef: "project",
        repositoryId: "789",
        repository: "example/project",
        namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
      },
      {
        repositoryRef: "foreign-project",
        repositoryId: "790",
        repository: "example/foreign-project",
        namespaces: [{ namespaceId: `ns_${randomUUID()}`, profiles: ["git-read", "git-write"] }],
      },
    ],
  };
}

function repositoryDriver(registry) {
  return new GitHubRepoDriver(
    {
      id: providerId,
      // Admission must complete without contacting the service or obtaining credentials.
      client: new UnixRepositoryCredentialControlClient({
        controlSocket: "/unused/repository-admission/control.sock",
      }),
      drivers: { repo: driverId },
    },
    validateGitHubRepositoryRegistry(registry, providerId),
    { sessionDurationSeconds: 600 },
  );
}

async function fixture(
  t,
  { compute = kubernetesCompute(), repositories = true, harness = "openclaw" } = {},
) {
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Repository admission",
    createdAt: new Date().toISOString(),
  };
  const auth = await createTestAuthPrincipal({ installationId: installation.id });
  const iamState = {
    identities: [auth.seed.principal],
    groups: [],
    memberships: [],
    roles: [...auth.seed.roles],
    bindings: [...auth.seed.bindings],
    restrictions: [],
  };
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  const iam = new NativeIAMDriver({ loadNativeIAMState: async () => iamState });
  const configurationDriver = createTestConfigurationDriver();
  const secretDriver = createTestSecretDriver();
  const providers = repositories
    ? [
        {
          id: providerId,
          type: "github",
          configuration: { registryPath: "/unused/repository-admission/registry.json" },
          drivers: { repo: driverId },
        },
      ]
    : [];

  async function compose(registry) {
    const controller = new OpenClawController(installation, { state, providers });
    for (const driver of [iam, compute, configurationDriver, secretDriver]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    if (registry !== undefined) {
      const driver = repositoryDriver(registry);
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    if (registry !== undefined || !repositories) {
      await controller.validateProviderConfiguration();
    }
    const app = createFastifyApp({
      controller,
      iamDriver: iam,
      resolveHarness: resolveApprovedHarness,
      auditSink,
      auth: auth.auth,
      development: { enabled: true, installationId: installation.id },
    });
    t.after(() => app.close());
    const request = await createAuthenticatedControllerRequest(app, auth);
    return { controller, request };
  }

  const initial = await compose();
  const namespaceResponse = await initial.request("POST", "/namespaces", { name: "repositories" });
  assert.equal(namespaceResponse.status, 201, JSON.stringify(namespaceResponse));
  const namespace = namespaceResponse.data;
  const native = createHarnessConfiguration(harness, "gpt-5.1");
  delete native.gateway.auth;
  const configurationResponse = await initial.request(
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    { kind: "agent", values: native },
  );
  assert.equal(configurationResponse.status, 201, JSON.stringify(configurationResponse));
  const configuration = configurationResponse.data;
  const registry = registryFor(namespace.id);
  const composed = repositories ? await compose(registry) : initial;
  const collection = `/namespaces/${namespace.id}/agents`;

  async function createAgent(fields = {}) {
    const response = await composed.request("POST", collection, {
      name: `Repository Agent ${randomUUID()}`,
      configurationId: configuration.id,
      ...fields,
    });
    assert.equal(response.status, 201, JSON.stringify(response));
    return response.data;
  }

  async function prepareDeployment(agent) {
    // Readiness is a prerequisite here; no Kubernetes/SSH provisioning is claimed.
    await state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
    );
    if (agent.harnessAuth?.method === "runtime") {
      return;
    }
    const secret = await composed.request("POST", `/namespaces/${namespace.id}/secrets`, {
      name: `model-${agent.id}`,
      value: "synthetic-admission-model-key",
    });
    assert.equal(secret.status, 201, JSON.stringify(secret));
    const internal = await composed.controller.getAgent(
      auth.seed.principal.id,
      namespace.id,
      agent.id,
    );
    const roleId = `model-${agent.id}`;
    iamState.identities.push({
      kind: "service_principal",
      id: internal.servicePrincipalId,
      namespaceId: namespace.id,
    });
    iamState.roles.push({
      id: roleId,
      namespaceId: namespace.id,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    iamState.bindings.push({
      id: roleId,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: internal.servicePrincipalId,
      roleId,
      resourceKind: "secret",
      resourceId: secret.data.id,
    });
    const updated = await composed.request("PATCH", `${collection}/${agent.id}`, {
      configurationId: configuration.id,
      harnessAuth: { method: "api_key", source: secret.data.ref },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated));
  }

  return {
    ...composed,
    state,
    namespace,
    configuration,
    collection,
    registry,
    compose,
    createAgent,
    prepareDeployment,
  };
}

test("Repository bindings normalize through Agent create and preserve or clear through PATCH", async (t) => {
  const f = await fixture(t);
  for (const fields of [{}, { repositoryBindings: [] }]) {
    const agent = await f.createAgent(fields);
    assert.equal(Object.hasOwn(agent, "repositoryBindings"), false);
  }
  const agent = await f.createAgent({ repositoryBindings: [{ repositoryRef: "project" }] });
  const path = `${f.collection}/${agent.id}`;
  assert.deepEqual(agent.repositoryBindings, selection);
  assert.deepEqual((await f.request("GET", path)).data.repositoryBindings, selection);
  const patch = { configurationId: f.configuration.id };
  const preserved = await f.request("PATCH", path, patch);
  assert.equal(preserved.status, 200);
  assert.deepEqual(preserved.data.repositoryBindings, selection);
  const cleared = await f.request("PATCH", path, { ...patch, repositoryBindings: [] });
  assert.equal(cleared.status, 200);
  assert.equal(Object.hasOwn(cleared.data, "repositoryBindings"), false);
  assert.equal(Object.hasOwn((await f.request("GET", path)).data, "repositoryBindings"), false);
  // A configured GitHub Provider cannot supply an Agent ServiceAccount association.
  const incompatible = await f.request("POST", f.collection, {
    name: "Wrong Provider kind",
    configurationId: f.configuration.id,
    providerId,
  });
  assert.equal(incompatible.status, 404, JSON.stringify(incompatible));
  assert.equal(incompatible.error.code, "NOT_FOUND");
});

test("Repository policy rejects invalid create and PATCH before changing stored Agents", async (t) => {
  const f = await fixture(t);
  const agent = await f.createAgent({ repositoryBindings: selection });
  const path = `${f.collection}/${agent.id}`;
  const before = (await f.request("GET", f.collection)).data;
  const cases = [
    {
      name: "unsupported profile",
      bindings: [{ repositoryRef: "project", profile: "read-write" }],
    },
    {
      name: "duplicate reference",
      bindings: [{ repositoryRef: "project" }, { repositoryRef: "project" }],
    },
    { name: "unknown reference", bindings: [{ repositoryRef: "missing" }] },
    { name: "foreign namespace", bindings: [{ repositoryRef: "foreign-project" }] },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const body = { configurationId: f.configuration.id, repositoryBindings: scenario.bindings };
      for (const [method, target, fields] of [
        ["POST", f.collection, { ...body, name: "Refused Agent" }],
        ["PATCH", path, body],
      ]) {
        const response = await f.request(method, target, fields);
        assert.equal(response.status, 404, JSON.stringify(response));
        assert.equal(response.error.code, "NOT_FOUND");
      }
      assert.deepEqual((await f.request("GET", f.collection)).data, before);
    });
  }
});

test("Deploy freezes public repository selection without exposing provider grants", async (t) => {
  const f = await fixture(t);
  const agent = await f.createAgent({ repositoryBindings: [{ repositoryRef: "project" }] });
  await f.prepareDeployment(agent);
  const path = `${f.collection}/${agent.id}`;
  const deployed = await f.request("POST", `${path}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed));
  const snapshot = deployed.data.repositoryCredentials;
  assert.deepEqual(Object.keys(snapshot).sort(), ["bindings", "deadlineWallMs", "driver"]);
  assert.deepEqual(snapshot.bindings, selection);
  assert.equal(snapshot.driver.id, driverId);
  assert.equal(typeof snapshot.driver.implementation, "string");
  assert.equal(snapshot.deadlineWallMs, Date.parse(deployed.data.createdAt) + 600_000);
  const internal = await f.state.read((view) =>
    view.revisions.findRevision(f.namespace.id, agent.id, deployed.data.id),
  );
  assert.equal(internal.repositoryCredentials.bindings[0].providerId, providerId);
  assert.equal(internal.repositoryCredentials.bindings[0].grant.repositoryId, "789");

  const cleared = await f.request("PATCH", path, {
    configurationId: f.configuration.id,
    repositoryBindings: [],
  });
  assert.equal(cleared.status, 200);
  const historical = await f.request("GET", `${path}/revisions/${deployed.data.id}`);
  assert.deepEqual(historical.data.repositoryCredentials, snapshot);
  assert.deepEqual(
    (await f.request("GET", `${path}/revisions`)).data[0].repositoryCredentials,
    snapshot,
  );
  const independent = await f.request("POST", `${path}/deploy`);
  assert.equal(independent.status, 202, JSON.stringify(independent));
  assert.equal(Object.hasOwn(independent.data, "repositoryCredentials"), false);
});

test("Deploy rechecks repository policy after a draft was accepted", async (t) => {
  const f = await fixture(t);
  const agent = await f.createAgent({ repositoryBindings: selection });
  await f.prepareDeployment(agent);
  // Recomposition replaces operator policy; an accepted draft is not a permanent grant.
  const replacement = structuredClone(f.registry);
  replacement.repositories[0].namespaces[0].profiles = ["git-read"];
  const reconfigured = await f.compose(replacement);
  const path = `${f.collection}/${agent.id}`;
  const deployed = await reconfigured.request("POST", `${path}/deploy`);
  assert.equal(deployed.status, 404, JSON.stringify(deployed));
  assert.equal(deployed.error.code, "NOT_FOUND");
  assert.deepEqual((await reconfigured.request("GET", `${path}/revisions`)).data, []);
  const unchanged = (await reconfigured.request("GET", path)).data;
  assert.deepEqual(unchanged.repositoryBindings, selection);
  assert.equal(unchanged.desiredRuntimeState, "stopped");
});

test("Unsupported Compute refuses repository deployment while ordinary deployment remains optional", async (t) => {
  const f = await fixture(t, { compute: sshCompute() });
  const agent = await f.createAgent({
    repositoryBindings: selection,
    harnessAuth: { method: "runtime" },
  });
  await f.prepareDeployment(agent);
  const path = `${f.collection}/${agent.id}`;
  const denied = await f.request("POST", `${path}/deploy`);
  assert.equal(denied.status, 503, JSON.stringify(denied));
  assert.equal(denied.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
  const cleared = await f.request("PATCH", path, {
    configurationId: f.configuration.id,
    repositoryBindings: [],
  });
  assert.equal(cleared.status, 200);
  const ordinary = await f.request("POST", `${path}/deploy`);
  assert.equal(ordinary.status, 202, JSON.stringify(ordinary));
  assert.equal(Object.hasOwn(ordinary.data, "repositoryCredentials"), false);
});

test("Kubernetes admission refuses repositories for an unsupported dedicated Harness", async (t) => {
  const f = await fixture(t, { harness: "codex" });
  const agent = await f.createAgent({ executionMode: "dedicated", repositoryBindings: selection });
  await f.prepareDeployment(agent);
  const path = `${f.collection}/${agent.id}`;
  const denied = await f.request("POST", `${path}/deploy`);
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(denied.error.code, "RESOURCE_CONFLICT");
  assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
  // The same model/auth/topology is admissible after only the repository selection is removed.
  await f.request("PATCH", path, {
    configurationId: f.configuration.id,
    repositoryBindings: [],
  });
  const ordinary = await f.request("POST", `${path}/deploy`);
  assert.equal(ordinary.status, 202, JSON.stringify(ordinary));
});

test("Repository capability remains optional when no repository Provider or Driver is configured", async (t) => {
  const f = await fixture(t, { compute: sshCompute(), repositories: false });
  const agent = await f.createAgent({ harnessAuth: { method: "runtime" } });
  await f.prepareDeployment(agent);
  const deployed = await f.request("POST", `${f.collection}/${agent.id}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed));
  assert.equal(Object.hasOwn(deployed.data, "repositoryCredentials"), false);
  const missingDriver = await f.request("PATCH", `${f.collection}/${agent.id}`, {
    configurationId: f.configuration.id,
    repositoryBindings: selection,
  });
  assert.equal(missingDriver.status, 503, JSON.stringify(missingDriver));
  assert.equal(missingDriver.error.code, "DEPENDENCY_UNAVAILABLE");
  const unchanged = await f.request("GET", `${f.collection}/${agent.id}`);
  assert.equal(Object.hasOwn(unchanged.data, "repositoryBindings"), false);
});
