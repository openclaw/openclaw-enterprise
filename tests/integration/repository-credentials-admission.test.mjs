import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
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
import { grantRole } from "../helpers/iam-grants.mjs";

const driverId = "repository-credentials";
const backendId = "repository-provider";
const selection = [{ repositoryRef: "project", profile: "git-write" }];

function kubernetesCompute(Driver = KubernetesComputeDriver, provisioning = false) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  const compute = new Driver(
    {
      ...(provisioning
        ? {
            gatewayRouting: {
              hostname: "agents.example.test",
              gatewayName: "gateways",
              gatewayNamespace: "controller",
              envoyNamespace: "envoy",
            },
          }
        : {}),
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
        ...(provisioning
          ? {}
          : { gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }] }),
        repositoryCredentials: {
          namespace: "controller",
          podLabels: { app: "worker" },
          port: 8443,
        },
      },
      servicePrincipalCredentials: { mode: "disabled" },
    },
    provisioning ? { nodeEnrollment: {} } : {},
  );
  // Repository admission has no cluster; its transport credential prerequisite is satisfied.
  compute.getAgentRuntimeCredentialStatus = async () => ({ transportConfigured: true });
  return compute;
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
    backendId,
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

function repositoryDriver(registry, Driver = GitHubRepoDriver) {
  return new Driver(
    {
      id: backendId,
      // Admission must complete without contacting the service or obtaining credentials.
      client: new UnixRepositoryCredentialControlClient({
        controlSocket: "/unused/repository-admission/control.sock",
      }),
      drivers: { repo: driverId },
    },
    validateGitHubRepositoryRegistry(registry, backendId),
    { sessionDurationSeconds: 600 },
  );
}

async function fixture(
  t,
  {
    compute = kubernetesCompute(),
    repositories = true,
    harness = "openclaw",
    configurationDriver = createTestConfigurationDriver(),
  } = {},
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
  let remainingIAMReads = Infinity;
  const iam = new NativeIAMDriver({
    async loadNativeIAMState() {
      if (remainingIAMReads === 0) {
        throw new Error("IAM policy storage is unavailable.");
      }
      remainingIAMReads -= 1;
      return iamState;
    },
  });
  const secretDriver = createTestSecretDriver();
  const backends = repositories
    ? [
        {
          id: backendId,
          type: "github",
          configuration: { registryPath: "/unused/repository-admission/registry.json" },
          drivers: { repo: driverId },
        },
      ]
    : [];

  async function compose(registry, Driver) {
    const controller = new OpenClawController(installation, { state, backends });
    for (const driver of [iam, compute, configurationDriver, secretDriver]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    if (registry !== undefined) {
      const driver = repositoryDriver(registry, Driver);
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    if (registry !== undefined || !repositories) {
      await controller.validateBackendConfiguration();
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
    grantRole(iamState, internal.servicePrincipalId, {
      id: roleId,
      namespaceId: namespace.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: secret.data.id },
    });
    const updated = await composed.request("PATCH", `${collection}/${agent.id}`, {
      configurationId: configuration.id,
      harnessAuth: { method: "api_key", source: secret.data.ref },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated));
  }

  return {
    ...composed,
    actorId: auth.seed.principal.id,
    iamState,
    failIAMAfterReads(count) {
      remainingIAMReads = count;
    },
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

test("Repository options expose only Namespace-approved display choices behind Agent create authorization", async (t) => {
  const f = await fixture(t);
  const path = `${f.collection}/repository-options`;
  const options = await f.request("GET", path);
  assert.equal(options.status, 200, JSON.stringify(options));
  assert.deepEqual(options.data, [
    {
      repositoryRef: "project",
      displayName: "example/project",
      allowedProfiles: ["git-full", "git-read", "git-write"],
    },
  ]);
  assert.deepEqual(Object.keys(options.data[0]).sort(), [
    "allowedProfiles",
    "displayName",
    "repositoryRef",
  ]);
  assert.doesNotMatch(
    JSON.stringify(options.data),
    /provider|backend|installation|repositoryId|grant|duration|token|key|credential/i,
  );

  // Metadata is advisory: an unavailable service must leave authorized choices usable.
  const unavailableMetadata = await f.request("GET", `${path}?descriptionRefs=project`);
  assert.equal(unavailableMetadata.status, 200, JSON.stringify(unavailableMetadata));
  assert.deepEqual(unavailableMetadata.data, options.data);
  assert.equal(unavailableMetadata.meta.descriptionsPending, false);
  for (const query of [
    "descriptionRefs=project,project",
    "descriptionRefs=project,invalid%2Fref",
    `descriptionRefs=${Array.from({ length: 21 }, (_, index) => `repo-${index}`).join(",")}`,
    "descriptionRefs=project&extra=value",
  ]) {
    const malformed = await f.request("GET", `${path}?${query}`);
    assert.equal(malformed.status, 400, JSON.stringify(malformed));
  }

  f.iamState.restrictions.push({
    id: "deny-repository-options",
    namespaceId: f.namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const denied = await f.request("GET", path);
  assert.equal(denied.status, 403, JSON.stringify(denied));
  assert.equal(denied.error.code, "FORBIDDEN");

  f.iamState.restrictions.pop();
  const sandbox = {
    id: "repository-options-sandbox",
    capability: "sandbox",
    implementation: "test-sandbox",
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
  f.controller.registerDriver(sandbox);
  f.controller.selectDriver("sandbox", sandbox.id);
  const incompatible = await f.request("GET", path);
  assert.equal(incompatible.status, 503, JSON.stringify(incompatible));
  assert.equal(incompatible.error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");

  const transient = await f.request("POST", "/namespaces", { name: "deleting-options" });
  assert.equal(transient.status, 201, JSON.stringify(transient));
  const deleting = await f.request("DELETE", `/namespaces/${transient.data.id}`);
  assert.equal(deleting.status, 202, JSON.stringify(deleting));
  const conflict = await f.request(
    "GET",
    `/namespaces/${transient.data.id}/agents/repository-options`,
  );
  assert.equal(conflict.status, 409, JSON.stringify(conflict));
  assert.equal(conflict.error.code, "RESOURCE_CONFLICT");
});

test("Denied Agent discovery cannot start repository metadata lookups", async (t) => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "repository-options-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socket = join(directory, "control.sock");
  let lookups = 0;
  // The independent socket peer observes actual metadata requests; IAM and Driver policy are real.
  const server = createServer((request, response) => {
    lookups++;
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          providerInstanceId: f.registry.providerInstanceId,
          appId: f.registry.appId,
          githubInstallationId: f.registry.githubInstallationId,
          descriptions: [{ repositoryRef: "project", repositoryId: "789", description: "Project" }],
          pending: false,
        }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  class ObservedRepositoryDriver extends GitHubRepoDriver {
    constructor(backend, registry, options) {
      super(
        {
          ...backend,
          client: new UnixRepositoryCredentialControlClient({ controlSocket: socket }),
        },
        registry,
        options,
      );
    }
  }
  const observed = await f.compose(f.registry, ObservedRepositoryDriver);
  const agent = await f.createAgent();
  const createPath = `${f.collection}/repository-options?descriptionRefs=project`;
  const updatePath = `${f.collection}/${agent.id}/repository-options?descriptionRefs=project`;
  for (const path of [createPath, updatePath]) {
    const allowed = await observed.request("GET", path);
    assert.equal(allowed.status, 200, JSON.stringify(allowed));
    assert.equal(allowed.data[0].description, "Project");
  }
  assert.equal(lookups, 2);

  for (const action of ["create", "update"]) {
    f.iamState.restrictions.push({
      id: `deny-metadata-${action}`,
      namespaceId: f.namespace.id,
      resourceKind: "agent",
      action,
      effect: "deny",
    });
  }
  for (const path of [createPath, updatePath]) {
    const denied = await observed.request("GET", path);
    assert.equal(denied.status, 403, JSON.stringify(denied));
    assert.equal(denied.error.code, "FORBIDDEN");
  }
  assert.equal(lookups, 2);
});

test("Repository options preserve an empty successful discovery", async (t) => {
  const f = await fixture(t);
  const registry = structuredClone(f.registry);
  registry.repositories = registry.repositories.filter(
    (repository) => repository.repositoryRef === "foreign-project",
  );
  const reconfigured = await f.compose(registry);
  const options = await reconfigured.request("GET", `${f.collection}/repository-options`);
  assert.equal(options.status, 200, JSON.stringify(options));
  assert.deepEqual(options.data, []);
});

test("Repository options refuse Driver display text with C0 controls or DEL", async (t) => {
  // The utils conformance suite pins every code unit of the shared helper; this pins its use here.
  let override = {};
  class CraftedRepositoryDriver extends GitHubRepoDriver {
    async listOptions(input) {
      const result = await super.listOptions(input);
      return { ...result, options: result.options.map((option) => ({ ...option, ...override })) };
    }
  }
  const f = await fixture(t);
  const { controller } = await f.compose(f.registry, CraftedRepositoryDriver);
  for (const [code, refused] of [
    [0x1f, true],
    [0x20, false],
    [0x7e, false],
    [0x7f, true],
    [0x80, false],
  ]) {
    const text = `example${String.fromCharCode(code)}project`;
    for (const field of ["displayName", "description"]) {
      const label = `${field} U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
      override = { [field]: text };
      const listing = controller.listRepositoryOptions(f.actorId, f.namespace.id);
      if (refused) {
        await assert.rejects(listing, /returned invalid repository options/, label);
      } else {
        assert.equal((await listing).options[0][field], text, label);
      }
    }
  }
});

test("Repository discovery supports a dedicated-only Compute Driver without admitting unsupported Harnesses", async (t) => {
  // A Driver may support a narrower topology than the platform's Harness catalog.
  // Discovery must not invent an embedded Harness to test that Driver's availability.
  class DedicatedRepositoryComputeDriver extends KubernetesComputeDriver {
    validateRepositoryCredentials(harness, sandboxDriverId) {
      super.validateRepositoryCredentials(harness, sandboxDriverId);
      if (harness.mode !== "dedicated") {
        throw new Error("This Compute Driver supports only dedicated repository execution.");
      }
    }
  }

  for (const [harness, executionMode, status] of [
    ["codex", "dedicated", 202],
    ["openclaw", "embedded", 409],
  ]) {
    const f = await fixture(t, {
      compute: kubernetesCompute(DedicatedRepositoryComputeDriver),
      harness,
    });
    const options = await f.request("GET", `${f.collection}/repository-options`);
    assert.equal(options.status, 200, JSON.stringify(options));
    assert.equal(options.data[0].repositoryRef, "project");

    const agent = await f.createAgent({ executionMode, repositoryBindings: selection });
    await f.prepareDeployment(agent);
    const path = `${f.collection}/${agent.id}`;
    const deployed = await f.request("POST", `${path}/deploy`);
    assert.equal(deployed.status, status, JSON.stringify(deployed));
    if (status === 409) {
      assert.equal(deployed.error.code, "RESOURCE_CONFLICT");
      assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
    } else {
      assert.equal(deployed.data.harness.mode, "dedicated");
      assert.equal(deployed.data.repositoryCredentials.bindings[0].repositoryRef, "project");
    }
  }
});

test("Missing repository composition cannot hide denied or unavailable IAM", async (t) => {
  const f = await fixture(t, { repositories: false });
  const path = `${f.collection}/repository-options`;
  const unavailable = await f.request("GET", path);
  assert.equal(unavailable.status, 503, JSON.stringify(unavailable));
  assert.equal(unavailable.error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");
  assert.equal(unavailable.error.message, "Repository options are unavailable.");

  f.iamState.restrictions.push({
    id: "deny-create-without-repositories",
    namespaceId: f.namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const denied = await f.request("GET", path);
  assert.equal(denied.status, 403, JSON.stringify(denied));
  assert.equal(denied.error.code, "FORBIDDEN");
  f.iamState.restrictions.pop();

  // Fail the real NativeIAM store during identity lookup, then after lookup at authorization.
  for (const successfulReads of [0, 1]) {
    f.failIAMAfterReads(successfulReads);
    const failure = await f.request("GET", path);
    assert.equal(failure.status, 503, JSON.stringify(failure));
    assert.equal(failure.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(failure.error.message, "A required platform dependency is unavailable.");
  }
});

test("Successful repository discovery does not authorize later writes", async (t) => {
  const f = await fixture(t);
  const agent = await f.createAgent({ repositoryBindings: selection });
  await f.prepareDeployment(agent);
  const path = `${f.collection}/${agent.id}`;
  const before = (await f.request("GET", path)).data;
  const options = await f.request("GET", `${f.collection}/repository-options`);
  assert.equal(options.status, 200, JSON.stringify(options));

  for (const scenario of [
    { action: "create", method: "POST", target: f.collection, fields: { name: "Denied Agent" } },
    { action: "update", method: "PATCH", target: path, fields: {} },
    { action: "deploy", method: "POST", target: `${path}/deploy` },
  ]) {
    // Fresh NativeIAM policy must win over an earlier successful discovery.
    f.iamState.restrictions.push({
      id: `deny-${scenario.action}-after-discovery`,
      namespaceId: f.namespace.id,
      resourceKind: "agent",
      action: scenario.action,
      effect: "deny",
    });
    const response = await f.request(
      scenario.method,
      scenario.target,
      scenario.fields === undefined
        ? undefined
        : {
            configurationId: f.configuration.id,
            repositoryBindings: selection,
            ...scenario.fields,
          },
    );
    assert.equal(response.status, 403, JSON.stringify(response));
    assert.equal(response.error.code, "FORBIDDEN");
    f.iamState.restrictions.pop();
  }
  assert.deepEqual((await f.request("GET", path)).data, before);
  assert.deepEqual((await f.request("GET", f.collection)).data, [before]);
  assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
});

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
  // A configured GitHub Backend cannot supply an Agent ServiceAccount association.
  const incompatible = await f.request("POST", f.collection, {
    name: "Wrong Backend kind",
    configurationId: f.configuration.id,
    backendId,
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

test("Agent repository access preserves inheritance intent and admits only resolved approved profiles", async (t) => {
  const f = await fixture(t);
  const intent = { defaultProfile: "git-full", repositories: [{ repositoryRef: "project" }] };
  const agent = await f.createAgent({ repositoryAccess: intent });
  const path = `${f.collection}/${agent.id}`;
  assert.deepEqual(agent.repositoryAccess, intent);
  assert.deepEqual(agent.repositoryBindings, [{ repositoryRef: "project", profile: "git-full" }]);
  assert.deepEqual((await f.request("GET", path)).data.repositoryAccess, intent);
  assert.equal((await f.request("GET", `${path}/repository-options`)).status, 200);
  const patch = { configurationId: f.configuration.id };
  const preserved = await f.request("PATCH", path, patch);
  assert.deepEqual(preserved.data.repositoryAccess, intent);

  // An explicit override stays explicit even while it equals the Agent default.
  const custom = {
    defaultProfile: "git-full",
    repositories: [{ repositoryRef: "project", profile: "git-full" }],
  };
  assert.equal(
    (await f.request("PATCH", path, { ...patch, repositoryAccess: custom })).status,
    200,
  );
  custom.defaultProfile = "git-read";
  const changed = await f.request("PATCH", path, { ...patch, repositoryAccess: custom });
  assert.equal(changed.status, 200, JSON.stringify(changed));
  assert.deepEqual(changed.data.repositoryAccess, custom);
  assert.deepEqual(changed.data.repositoryBindings, agent.repositoryBindings);

  // Reset to inheritance materializes the new default, without changing the saved intent.
  const reset = { defaultProfile: "git-read", repositories: [{ repositoryRef: "project" }] };
  const inherited = await f.request("PATCH", path, { ...patch, repositoryAccess: reset });
  assert.equal(inherited.status, 200);
  assert.deepEqual(inherited.data.repositoryAccess, reset);
  assert.deepEqual(inherited.data.repositoryBindings, [
    { repositoryRef: "project", profile: "git-read" },
  ]);
  const denied = await f.request("PATCH", path, {
    ...patch,
    repositoryAccess: { ...reset, defaultProfile: "unapproved" },
  });
  assert.notEqual(denied.status, 200);
  assert.deepEqual((await f.request("GET", path)).data.repositoryAccess, reset);
  const ambiguous = await f.request("PATCH", path, {
    ...patch,
    repositoryAccess: reset,
    repositoryBindings: selection,
  });
  assert.notEqual(ambiguous.status, 200);
  const legacy = await f.request("PATCH", path, { ...patch, repositoryBindings: selection });
  assert.equal(legacy.status, 200);
  assert.equal(Object.hasOwn(legacy.data, "repositoryAccess"), false);
  const empty = { defaultProfile: "git-full", repositories: [] };
  const cleared = await f.request("PATCH", path, { ...patch, repositoryAccess: empty });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data.repositoryAccess, empty);
  assert.equal(Object.hasOwn(cleared.data, "repositoryBindings"), false);
});

test("Agent updates apply repository access and validate plugin policy together", async (t) => {
  const f = await fixture(t);
  const driver = new OCCPluginDriver();
  f.controller.registerDriver(driver);
  f.controller.selectDriver("plugin", driver.id);
  const initialAccess = {
    defaultProfile: "git-read",
    repositories: [{ repositoryRef: "project" }],
  };
  const initialPlugins = { "occ-plugin:diffs": { enabled: true } };
  const agent = await f.createAgent({ repositoryAccess: initialAccess, plugins: initialPlugins });
  const path = `${f.collection}/${agent.id}`;
  const nextAccess = { ...initialAccess, defaultProfile: "git-full" };

  // A policy the selected Driver cannot enforce rejects the whole update, including access.
  const denied = await f.request("PATCH", path, {
    configurationId: f.configuration.id,
    repositoryAccess: nextAccess,
    plugins: { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "all_actions" } } },
  });
  assert.equal(denied.status, 400, JSON.stringify(denied));
  const unchanged = await f.request("GET", path);
  assert.deepEqual(unchanged.data.repositoryAccess, initialAccess);
  assert.deepEqual(unchanged.data.repositoryBindings, [
    { repositoryRef: "project", profile: "git-read" },
  ]);
  assert.deepEqual(unchanged.data.plugins, initialPlugins);

  const nextPlugins = {
    "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" } },
  };
  const updated = await f.request("PATCH", path, {
    configurationId: f.configuration.id,
    repositoryAccess: nextAccess,
    plugins: nextPlugins,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.deepEqual(updated.data.repositoryAccess, nextAccess);
  assert.deepEqual(updated.data.repositoryBindings, [
    { repositoryRef: "project", profile: "git-full" },
  ]);
  assert.deepEqual(updated.data.plugins, nextPlugins);
});

test("Agent repository access preserves request order when the Driver returns bindings in another order", async (t) => {
  // Driver resolutions are keyed by reference; their order is not part of the contract.
  class ReorderedRepositoryDriver extends GitHubRepoDriver {
    resolve(input) {
      const resolution = super.resolve(input);
      return { ...resolution, bindings: [...resolution.bindings].reverse() };
    }
  }

  const f = await fixture(t);
  const registry = structuredClone(f.registry);
  registry.repositories[1].namespaces.push({
    namespaceId: f.namespace.id,
    profiles: ["git-read", "git-write", "git-full"],
  });
  const { request } = await f.compose(registry, ReorderedRepositoryDriver);
  const access = {
    defaultProfile: "git-read",
    repositories: [
      { repositoryRef: "project" },
      { repositoryRef: "foreign-project", profile: "git-write" },
    ],
  };
  const created = await request("POST", f.collection, {
    name: "Reordered repository access",
    configurationId: f.configuration.id,
    repositoryAccess: access,
  });
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.deepEqual(created.data.repositoryAccess, access);
  assert.deepEqual(created.data.repositoryBindings, [
    { repositoryRef: "project", profile: "git-read" },
    { repositoryRef: "foreign-project", profile: "git-write" },
  ]);

  const path = `${f.collection}/${created.data.id}`;
  const updatedAccess = { ...access, defaultProfile: "git-full" };
  const updated = await request("PATCH", path, {
    configurationId: f.configuration.id,
    repositoryAccess: updatedAccess,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.deepEqual(updated.data.repositoryAccess, updatedAccess);
  assert.deepEqual(updated.data.repositoryBindings, [
    { repositoryRef: "project", profile: "git-full" },
    { repositoryRef: "foreign-project", profile: "git-write" },
  ]);
  assert.deepEqual((await request("GET", path)).data.repositoryAccess, updatedAccess);

  const legacy = await request("POST", f.collection, {
    name: "Defaulted repository bindings",
    configurationId: f.configuration.id,
    repositoryBindings: [{ repositoryRef: "project" }, { repositoryRef: "foreign-project" }],
  });
  assert.equal(legacy.status, 201, JSON.stringify(legacy));
  assert.deepEqual(legacy.data.repositoryBindings, [
    { repositoryRef: "project", profile: "git-write" },
    { repositoryRef: "foreign-project", profile: "git-write" },
  ]);
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
  assert.equal(internal.repositoryCredentials.bindings[0].backendId, backendId);
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
  const options = await f.request("GET", `${f.collection}/repository-options`);
  assert.equal(options.status, 503, JSON.stringify(options));
  assert.equal(options.error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");
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

test("Repository admission retains unknown Harness and execution-mode rejection", async (t) => {
  for (const { harness, executionMode, status, code, message } of [
    // An unsupported runtime identity is Configuration content, not a missing resource.
    { harness: "unknown", executionMode: "embedded", status: 400, code: "INVALID_REQUEST" },
    // Native dedicated execution requires full containment before Repository admission.
    {
      harness: "openclaw",
      executionMode: "dedicated",
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: /^A required platform dependency is unavailable\.$/,
    },
    // A Harness/mode mismatch names the execution mode the Configuration needs.
    {
      harness: "codex",
      executionMode: "embedded",
      status: 400,
      code: "INVALID_REQUEST",
      message: /selects the Codex Harness, which needs dedicated execution/,
    },
  ]) {
    await t.test(`${harness}/${executionMode}`, async (t) => {
      const f = await fixture(t, { harness });
      const agent = await f.createAgent({ executionMode, repositoryBindings: selection });
      await f.prepareDeployment(agent);
      const path = `${f.collection}/${agent.id}`;
      const denied = await f.request("POST", `${path}/deploy`);
      assert.equal(denied.status, status, JSON.stringify(denied));
      assert.equal(denied.error.code, code);
      if (message) {
        assert.match(denied.error.message, message);
      }
      assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
    });
  }
  const f = await fixture(t);
  const invalidMode = await f.request("POST", f.collection, {
    name: "Unknown mode",
    configurationId: f.configuration.id,
    repositoryBindings: selection,
    executionMode: "unknown",
  });
  assert.equal(invalidMode.status, 400, JSON.stringify(invalidMode));
  assert.equal(invalidMode.error.code, "INVALID_REQUEST");
  assert.deepEqual((await f.request("GET", f.collection)).data, []);
});

test("Dedicated repository admission still rejects a selected Sandbox Driver", async (t) => {
  const f = await fixture(t, { harness: "codex" });
  const agent = await f.createAgent({ executionMode: "dedicated", repositoryBindings: selection });
  await f.prepareDeployment(agent);
  // Selecting Sandbox changes the admitted topology; no Sandbox runtime is invoked.
  const sandbox = {
    id: "repository-admission-sandbox",
    capability: "sandbox",
    implementation: "test-sandbox",
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
  f.controller.registerDriver(sandbox);
  f.controller.selectDriver("sandbox", sandbox.id);
  const path = `${f.collection}/${agent.id}`;
  const denied = await f.request("POST", `${path}/deploy`);
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(denied.error.code, "RESOURCE_CONFLICT");
  assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
});

test("Kubernetes admission supports dedicated Codex repositories for every profile", async (t) => {
  for (const profile of ["git-read", "git-write", "git-full"]) {
    await t.test(profile, async (t) => {
      const f = await fixture(t, { harness: "codex" });
      const bindings = [{ repositoryRef: "project", profile }];
      const agent = await f.createAgent({
        executionMode: "dedicated",
        repositoryBindings: bindings,
      });
      assert.deepEqual(agent.repositoryBindings, bindings);
      await f.prepareDeployment(agent);
      const path = `${f.collection}/${agent.id}`;
      const deployed = await f.request("POST", `${path}/deploy`);
      assert.equal(deployed.status, 202, JSON.stringify(deployed));
      assert.deepEqual(deployed.data.harness, { id: "codex", version: "1.0.0", mode: "dedicated" });
      assert.deepEqual(deployed.data.repositoryCredentials.bindings, bindings);
      const historical = await f.request("GET", `${path}/revisions/${deployed.data.id}`);
      assert.deepEqual(historical.data.repositoryCredentials, deployed.data.repositoryCredentials);
    });
  }
});

test("Repository capability remains optional when no repository Backend or Driver is configured", async (t) => {
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
  const options = await f.request("GET", `${f.collection}/repository-options`);
  assert.equal(options.status, 503, JSON.stringify(options));
  assert.equal(options.error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");
});

test("Provisioning rejects a forbidden repository profile before queueing or creating resources", async (t) => {
  const configurationDriver = createTestConfigurationDriver();
  // These effect methods must remain unused when admission rejects the repository selection.
  configurationDriver.createExact = async () =>
    assert.fail("Rejected admission created Configuration");
  configurationDriver.inspectExact = async () =>
    assert.fail("Rejected admission inspected Configuration");
  const f = await fixture(t, {
    harness: "codex",
    configurationDriver,
    compute: kubernetesCompute(KubernetesComputeDriver, true),
  });
  await f.state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
  );
  const secret = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
    name: "Provisioning model",
    value: "synthetic-model-key",
  });
  assert.equal(secret.status, 201);
  const body = {
    requestId: `req_${randomUUID()}`,
    name: "Rejected provisioning",
    executionMode: "dedicated",
    configuration: { kind: "agent", values: f.configuration.values },
    harnessAuth: { method: "api_key", source: secret.data.ref },
    repositoryBindings: [{ repositoryRef: "foreign-project", profile: "git-write" }],
  };
  const response = await f.request("POST", `${f.collection}/provision`, body);
  assert.equal(response.status, 404, JSON.stringify(response));
  assert.equal(response.error.code, "NOT_FOUND");
  await assert.rejects(
    f.controller.provisionAgent(f.actorId, { ...body, namespaceId: f.namespace.id }),
    /repository selections are not approved/,
  );
  assert.deepEqual((await f.request("GET", f.collection)).data, []);
});
