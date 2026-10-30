import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { reconcileSandboxPolicy } from "../../apps/controller/src/worker/sandbox-policy.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { assertExecutionAdmission } from "../../packages/contracts/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  InMemoryPlatformState,
  DriverConfigurationRegistry,
  CredentialProxyRepositoryOnlyError,
  CredentialSourceUnprotectedError,
  InstalledDriver,
  OpenClawController,
  RepositoryGitProfileUnsupportedError,
  RepositoryGitSenderUnqualifiedError,
  SandboxNetworkPolicyConflictError,
} from "../../packages/occ/src/index.ts";
import {
  createAuthenticatedControllerRequest,
  createTestAuthPrincipal,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { grantRole, liftRestriction, restrict } from "../helpers/iam-grants.mjs";
import {
  BROKER_PROXY_DISABLED,
  BROKER_PROXY_DOMAIN_DECISION,
  BROKER_PROXY_DOMAINS,
  BROKER_PROXY_EMPTY_HOST,
  BROKER_PROXY_LOCAL_BINDING,
  BROKER_PROXY_MODE,
  COMPUTE_REPOSITORY_UNSUPPORTED,
  COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED,
  CREDENTIAL_PROXY_GIT_ALONE,
  CREDENTIAL_PROXY_INSTALLATION_ACCESS,
  CREDENTIAL_PROXY_INSTALLATION_PREVIEW,
  DEPENDENCY_UNAVAILABLE,
  PREVIEW_GATEWAY_VERSION,
  PROXY_REGISTRATION_UNAVAILABLE,
  REPOSITORY_ACCESS_OR_BINDINGS,
  REPOSITORY_SELECTION_NOT_APPROVED,
  REPOSITORY_SETTINGS_MISSING,
  SAVED_REPOSITORY_SELECTION_NOT_APPROVED,
} from "../helpers/refusal-text.mjs";
import { assertSameAnswer } from "../helpers/refusal-answers.mjs";
import { protectedSourceInputs } from "../helpers/protected-source-refusals.mjs";

const driverId = "repository-credentials";
const backendId = "repository-provider";
const selection = [{ repositoryRef: "project", profile: "git-write" }];

const sandboxRegistration = (driverId) => ({
  capability: "sandbox",
  driverId,
  implementation: "openshell",
  definition: OpenShellSandboxDriver,
});

function repositorySandbox(registry, id = "repository-admission-openshell") {
  return new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model",
            binaries: [{ path: "/usr/bin/codex" }],
            endpoints: [{ host: "api.openai.com", ports: [443] }],
          },
        ],
      },
    },
    {
      id,
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: id },
        client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
      },
      ...(registry === undefined
        ? {}
        : {
            // Admission reads only the route's host check; nothing starts it.
            openShellGit: new OpenShellGitRuntime(
              {},
              createGitHubRepositoryDeliveryResolver(
                validateGitHubRepositoryRegistry(registry, backendId),
              ),
            ),
          }),
    },
  );
}

// Stands in for the Kubernetes Driver composed with drivers.repo.openShell, which admits
// dedicated Codex repository bindings in the selected OpenShell Sandbox.
class OpenShellGitComputeDriver extends KubernetesComputeDriver {
  validateRepositoryCredentials(harness) {
    assert.deepEqual([harness.id, harness.mode], ["codex", "dedicated"]);
  }
}

// An Installation with runtime storage that dedicated Agents can use: gateway routing, node
// enrollment and a Gateway node selector (deployment admission refuses dedicated Agents
// otherwise, finding 2349).
function kubernetesCompute(Driver = KubernetesComputeDriver) {
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  const compute = new Driver(
    {
      gatewayRouting: {
        hostname: "agents.example.test",
        gatewayName: "gateways",
        gatewayNamespace: "controller",
        envoyNamespace: "envoy",
      },
      authentication: { mode: "inCluster" },
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        gatewayNodeSelector: { "oce-role": "control" },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        repositoryCredentials: {
          namespace: "controller",
          podLabels: { app: "worker" },
          port: 8443,
        },
      },
      servicePrincipalCredentials: { mode: "disabled" },
    },
    { nodeEnrollment: {} },
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
      root: "/var/lib/admission-runtime",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  });
}

function registryFor(namespaceId, extraRepositories = [], installationAccess = false) {
  return {
    ...(installationAccess && {
      installationAccess: {
        repositoryRef: "installation",
        namespaces: [{ namespaceId, accessMode: "installation" }],
      },
    }),
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
      ...extraRepositories.map((repositoryRef, index) => ({
        repositoryRef,
        repositoryId: String(800 + index),
        repository: `example/${repositoryRef}`,
        namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
      })),
    ],
  };
}

function repositoryDriver(registry, Driver = GitHubRepositoryPolicy) {
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
    controllerOptions = {},
    extraRepositories = [],
    installationAccess = false,
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
    const controller = new OpenClawController(installation, {
      state,
      backends,
      ...controllerOptions,
    });
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
    return { controller, request, app };
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
  const registry = registryFor(namespace.id, extraRepositories, installationAccess);
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

  // A signed-in person with no grant at all, for answers that must not depend on existence.
  async function requestWithoutGrants(app) {
    const credentials = {
      email: `outsider-${randomUUID()}@example.com`,
      password: `outsider-password-${randomUUID()}`,
      name: "Outsider",
    };
    const account = await auth.auth.createAccount(credentials);
    iamState.identities.push(auth.auth.principalSeed(account, { grant: "none" }).principal);
    return createAuthenticatedControllerRequest(app, credentials);
  }

  return {
    ...composed,
    actorId: auth.seed.principal.id,
    requestWithoutGrants,
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

  const removedQuery = await f.request("GET", `${path}?descriptionRefs=project`);
  assert.equal(removedQuery.status, 400, JSON.stringify(removedQuery));

  restrict(f.iamState, "create", "agent", { namespaceId: f.namespace.id });
  const denied = await f.request("GET", path);
  assert.equal(denied.status, 403, JSON.stringify(denied));
  assert.equal(denied.error.code, "FORBIDDEN");

  f.iamState.restrictions.pop();
  const sandbox = {
    id: "repository-options-sandbox",
    capability: "sandbox",
    implementation: "test-sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
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

test("Exact-Agent repository choices require Agent update authorization", async (t) => {
  const f = await fixture(t);
  const agent = await f.createAgent();
  const path = `${f.collection}/${agent.id}/repository-options`;
  assert.equal((await f.request("GET", path)).status, 200);
  restrict(f.iamState, "update", "agent", { namespaceId: f.namespace.id });
  const denied = await f.request("GET", path);
  assert.equal(denied.status, 403, JSON.stringify(denied));
  assert.equal(denied.error.code, "FORBIDDEN");
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
  class CraftedRepositoryDriver extends GitHubRepositoryPolicy {
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
  override = { description: "😀".repeat(512) };
  assert.equal(
    (await controller.listRepositoryOptions(f.actorId, f.namespace.id)).options[0].description,
    override.description,
  );
  override = { description: "😀".repeat(513) };
  await assert.rejects(
    controller.listRepositoryOptions(f.actorId, f.namespace.id),
    /returned invalid repository options/,
  );
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

    if (status === 409) {
      // Agent save refuses the topology every deployment refuses (finding 1117), with
      // deployment's message, and stores no Agent.
      const refused = await f.request("POST", f.collection, {
        name: `Repository Agent ${randomUUID()}`,
        configurationId: f.configuration.id,
        executionMode,
        repositoryBindings: selection,
      });
      assert.equal(refused.status, 409, JSON.stringify(refused));
      assert.equal(refused.error.code, "RESOURCE_CONFLICT");
      assert.equal(refused.error.message, COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED);
      assert.deepEqual((await f.request("GET", f.collection)).data, []);
      continue;
    }
    const agent = await f.createAgent({ executionMode, repositoryBindings: selection });
    await f.prepareDeployment(agent);
    const deployed = await f.request("POST", `${f.collection}/${agent.id}/deploy`);
    assert.equal(deployed.status, status, JSON.stringify(deployed));
    assert.equal(deployed.data.harness.mode, "dedicated");
    assert.equal(deployed.data.repositoryCredentials.bindings[0].repositoryRef, "project");
  }
});

test("Missing repository composition cannot hide denied or unavailable IAM", async (t) => {
  const f = await fixture(t, { repositories: false });
  const path = `${f.collection}/repository-options`;
  // No repository settings is a fixed Installation state, not an outage (finding 2387): the
  // authorized read answers no options and says why instead of a 503 on every Agent page.
  const notConfigured = await f.request("GET", path);
  assert.equal(notConfigured.status, 200, JSON.stringify(notConfigured));
  assert.deepEqual(notConfigured.data, []);
  assert.equal(notConfigured.meta.notConfigured, true);

  restrict(f.iamState, "create", "agent", { namespaceId: f.namespace.id });
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
    assert.equal(failure.error.message, DEPENDENCY_UNAVAILABLE);
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
    restrict(f.iamState, scenario.action, "agent", {
      id: `deny-${scenario.action}-after-discovery`,
      namespaceId: f.namespace.id,
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
      // The caller may edit the Agent, so the refusal names the rules instead of a 404 (finding
      // 2536). It reads the same for every cause and names no repository.
      for (const [method, target, fields] of [
        ["POST", f.collection, { ...body, name: "Refused Agent" }],
        ["PATCH", path, body],
      ]) {
        const response = await f.request(method, target, fields);
        assert.equal(response.status, 400, JSON.stringify(response));
        assert.equal(response.error.code, "INVALID_REQUEST");
        assert.equal(response.error.message, REPOSITORY_SELECTION_NOT_APPROVED);
      }
      assert.deepEqual((await f.request("GET", f.collection)).data, before);
    });
  }
});

test("Installation-wide repository access refuses other bindings at save, as deploy does", async (t) => {
  // Finding 2316: create and PATCH accepted github-installation next to another binding, and
  // only deploy refused it (hidden as a 404). Save and deploy now share the rule and name it.
  const f = await fixture(t, { installationAccess: true });
  const installation = { repositoryRef: "installation", profile: "github-installation" };
  const sole = await f.createAgent({ repositoryBindings: [installation] });
  assert.deepEqual(sole.repositoryBindings, [installation]);
  // Installation-wide access needs a Credential Proxy, which this Installation does not select:
  // an Installation property, so deploy names it in a 409 instead of a generic 503 (finding 2536).
  await f.prepareDeployment(sole);
  const unprotected = await f.request("POST", `${f.collection}/${sole.id}/deploy`);
  assert.equal(unprotected.status, 409, JSON.stringify(unprotected));
  assert.equal(unprotected.error.code, "RESOURCE_CONFLICT");
  assert.equal(unprotected.error.message, CREDENTIAL_PROXY_INSTALLATION_ACCESS);
  assert.deepEqual((await f.request("GET", `${f.collection}/${sole.id}/revisions`)).data, []);
  const agent = await f.createAgent({ repositoryBindings: selection });
  const path = `${f.collection}/${agent.id}`;
  const before = (await f.request("GET", f.collection)).data;
  const message =
    "Installation-wide repository access (profile github-installation) must be the Agent's only repository selection. Remove the other entries from repositoryBindings or repositoryAccess.repositories, or select each repository with its own profile instead.";
  const mixed = [installation, ...selection];
  const access = {
    defaultProfile: "git-write",
    repositories: [installation, { repositoryRef: "project" }],
  };
  for (const [method, target, fields] of [
    ["POST", f.collection, { name: "Refused Agent", repositoryBindings: mixed }],
    ["PATCH", path, { repositoryBindings: mixed }],
    // In any position.
    ["PATCH", path, { repositoryBindings: [...selection, installation] }],
    ["POST", f.collection, { name: "Refused Agent", repositoryAccess: access }],
    ["PATCH", path, { repositoryAccess: access }],
  ]) {
    const response = await f.request(method, target, {
      configurationId: f.configuration.id,
      ...fields,
    });
    assert.equal(response.status, 400, JSON.stringify(response));
    assert.equal(response.error.code, "INVALID_REQUEST");
    assert.equal(response.error.message, message);
  }
  assert.deepEqual((await f.request("GET", f.collection)).data, before);
  // An Agent saved with both before this check still gets the same answer at deploy.
  await f.prepareDeployment(agent);
  const stored = await f.state.transact((unit) =>
    unit.agents.updateConfiguration(
      f.namespace.id,
      agent.id,
      f.configuration.id,
      undefined,
      undefined,
      undefined,
      undefined,
      mixed,
    ),
  );
  assert.deepEqual(stored.repositoryBindings, mixed);
  const deployed = await f.request("POST", `${path}/deploy`);
  assert.equal(deployed.status, 400, JSON.stringify(deployed));
  assert.equal(deployed.error.message, message);
  assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
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
  assert.equal(denied.status, 400, JSON.stringify(denied));
  assert.equal(denied.error.message, REPOSITORY_SELECTION_NOT_APPROVED);
  assert.deepEqual((await f.request("GET", path)).data.repositoryAccess, reset);
  const ambiguous = await f.request("PATCH", path, {
    ...patch,
    repositoryAccess: reset,
    repositoryBindings: selection,
  });
  assert.equal(ambiguous.status, 400, JSON.stringify(ambiguous));
  assert.equal(ambiguous.error.message, REPOSITORY_ACCESS_OR_BINDINGS);
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
  class ReorderedRepositoryDriver extends GitHubRepositoryPolicy {
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
  // The list names the revision without its saved settings; the snapshot stays on the GET.
  const [listed] = (await f.request("GET", `${path}/revisions`)).data;
  assert.equal(listed.id, deployed.data.id);
  assert.equal(Object.hasOwn(listed, "repositoryCredentials"), false);
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
  // The request sends no selections: the saved ones are refused as saved state, a 409, both by
  // deploy and by the standing approval review that reads them (finding 2536).
  for (const [method, suffix] of [
    ["POST", "/deploy"],
    ["GET", "/repository-approval-scopes"],
  ]) {
    const refused = await reconfigured.request(method, `${path}${suffix}`);
    assert.equal(refused.status, 409, `${suffix}: ${JSON.stringify(refused)}`);
    assert.equal(refused.error.code, "RESOURCE_CONFLICT", suffix);
    assert.equal(refused.error.message, SAVED_REPOSITORY_SELECTION_NOT_APPROVED, suffix);
  }
  assert.deepEqual((await reconfigured.request("GET", `${path}/revisions`)).data, []);
  const unchanged = (await reconfigured.request("GET", path)).data;
  assert.deepEqual(unchanged.repositoryBindings, selection);
  assert.equal(unchanged.desiredRuntimeState, "stopped");
});

test("Repository refusals wait for the Agent grant: a missing and an unreadable Agent answer alike", async (t) => {
  // Finding 2536 names repository refusals at save and deploy. They run only after the caller's
  // grant on the Agent, so a caller without it learns nothing from them: the same request gets
  // the same answer for an Agent that exists and one that does not, each request's ID hidden.
  const f = await fixture(t);
  const agent = await f.createAgent({ repositoryBindings: selection });
  await f.prepareDeployment(agent);
  const narrowed = structuredClone(f.registry);
  narrowed.repositories[0].namespaces[0].profiles = ["git-read"];
  const reconfigured = await f.compose(narrowed);
  const outsider = await f.requestWithoutGrants(reconfigured.app);
  const missing = `agt_${randomUUID()}`;
  const refusedSave = {
    configurationId: f.configuration.id,
    repositoryBindings: [{ repositoryRef: "missing" }],
  };
  for (const [method, suffix, body, status, message] of [
    ["PATCH", "", refusedSave, 400, REPOSITORY_SELECTION_NOT_APPROVED],
    ["POST", "/deploy", undefined, 409, SAVED_REPOSITORY_SELECTION_NOT_APPROVED],
  ]) {
    // The same request from the administrator meets the named refusal.
    const named = await reconfigured.request(method, `${f.collection}/${agent.id}${suffix}`, body);
    assert.equal(named.status, status, JSON.stringify(named));
    assert.equal(named.error.message, message);
    await assertSameAnswer(
      (id) => outsider(method, `${f.collection}/${id}${suffix}`, body),
      [agent.id, missing],
      { label: `${method} ${suffix}` },
    );
  }
  // Agent create names the refusal only after the Namespace grant: an outsider gets the same
  // answer for this Namespace and for one that does not exist.
  const refusedCreate = { name: "Refused Agent", ...refusedSave };
  const named = await reconfigured.request("POST", f.collection, refusedCreate);
  assert.equal(named.status, 400, JSON.stringify(named));
  assert.equal(named.error.message, REPOSITORY_SELECTION_NOT_APPROVED);
  await assertSameAnswer(
    (id) => outsider("POST", `/namespaces/${id}/agents`, refusedCreate),
    [f.namespace.id, `ns_${randomUUID()}`],
    { label: "POST agents" },
  );
});

test("Unsupported Compute refuses repository deployment while ordinary deployment remains optional", async (t) => {
  const f = await fixture(t, { compute: sshCompute() });
  const options = await f.request("GET", `${f.collection}/repository-options`);
  assert.equal(options.status, 503, JSON.stringify(options));
  assert.equal(options.error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");
  const agent = await f.createAgent({
    repositoryBindings: selection,
    harnessAuth: { method: "runtime" },
    gatewayManagedMode: false,
  });
  await f.prepareDeployment(agent);
  const path = `${f.collection}/${agent.id}`;
  // A permanent Installation property, not an outage to retry (finding 2536).
  const denied = await f.request("POST", `${path}/deploy`);
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(denied.error.code, "RESOURCE_CONFLICT");
  assert.equal(denied.error.message, COMPUTE_REPOSITORY_UNSUPPORTED);
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
  for (const { harness, executionMode, status, code, message, atSave } of [
    // An unsupported runtime identity is Configuration content, not a missing resource.
    { harness: "unknown", executionMode: "embedded", status: 400, code: "INVALID_REQUEST" },
    // Kubernetes cannot deliver repository credentials to dedicated OpenClaw, so Agent save
    // refuses this Harness/mode pair before deployment admission.
    {
      harness: "openclaw",
      executionMode: "dedicated",
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: /cannot deliver repository credentials to this Harness topology/,
      atSave: true,
    },
    // A Harness/mode mismatch names the execution mode the Configuration needs, at Agent save
    // as at deployment.
    {
      harness: "codex",
      executionMode: "embedded",
      status: 400,
      code: "INVALID_REQUEST",
      message: /selects the Codex Harness, which needs dedicated execution/,
      atSave: true,
    },
  ]) {
    await t.test(`${harness}/${executionMode}`, async (t) => {
      const f = await fixture(t, { harness });
      if (atSave) {
        const refused = await f.request("POST", f.collection, {
          name: `Repository Agent ${randomUUID()}`,
          configurationId: f.configuration.id,
          executionMode,
          repositoryBindings: selection,
        });
        assert.equal(refused.status, status, JSON.stringify(refused));
        assert.equal(refused.error.code, code);
        assert.match(refused.error.message, message);
        assert.deepEqual((await f.request("GET", f.collection)).data, []);
        return;
      }
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
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
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

// Kubernetes Compute sends a Codex Harness's repository traffic through its Codex network proxy
// and refused a proxy setting that blocks the broker only in preparation, after a dedicated
// deployment had stopped the running revision (finding 2350). Configuration save does not know
// which Agents use the Configuration, so Agent save, provisioning and deployment refuse it, with
// the text preparation uses. A deny of the broker host itself stays with preparation, the only
// step that knows the host (tests/conformance/repository-runtime-material.test.mjs).
const brokerProxyRefusals = [
  ["disabled", { enabled: false }, BROKER_PROXY_DISABLED],
  ["unknown mode", { enabled: true, mode: "offline" }, BROKER_PROXY_MODE],
  ["local binding", { enabled: true, allowLocalBinding: "yes" }, BROKER_PROXY_LOCAL_BINDING],
  ["domains list", { enabled: true, domains: ["github.com"] }, BROKER_PROXY_DOMAINS],
  [
    "domain decision",
    { enabled: true, domains: { "github.com": "block" } },
    BROKER_PROXY_DOMAIN_DECISION,
  ],
  ["empty host", { enabled: true, domains: { " ": "allow" } }, BROKER_PROXY_EMPTY_HOST],
];

function codexProxyValues(harness, networkProxy) {
  const values = createHarnessConfiguration(harness, "gpt-5.1");
  delete values.gateway.auth;
  values.plugins ??= {};
  values.plugins.entries ??= {};
  values.plugins.entries.codex ??= { enabled: true, config: {} };
  values.plugins.entries.codex.config.appServer ??= {};
  values.plugins.entries.codex.config.appServer.networkProxy = networkProxy;
  return values;
}

function assertBrokerProxyRefused(response, message, label) {
  assert.equal(response.status, 400, `${label}: ${JSON.stringify(response)}`);
  assert.equal(response.error.code, "INVALID_REQUEST", label);
  assert.equal(response.error.message, message, label);
}

test("Agent save and deployment refuse a Codex network proxy that blocks the repository broker", async (t) => {
  const f = await fixture(t, { harness: "codex" });
  const configurationPath = `/namespaces/${f.namespace.id}/configurations/${f.configuration.id}`;
  // A limited proxy with its own allowlist lets Compute add the broker host: it deploys.
  const allowing = await f.request("PATCH", configurationPath, {
    values: codexProxyValues("codex", {
      enabled: true,
      mode: "limited",
      domains: { "github.com": "allow" },
    }),
  });
  assert.equal(allowing.status, 200, JSON.stringify(allowing));
  const agent = await f.createAgent({ executionMode: "dedicated", repositoryBindings: selection });
  await f.prepareDeployment(agent);
  const path = `${f.collection}/${agent.id}`;
  const running = await f.request("POST", `${path}/deploy`);
  assert.equal(running.status, 202, JSON.stringify(running));

  for (const [label, networkProxy, message] of brokerProxyRefusals) {
    // An edit of the Configuration the running Agent uses is accepted.
    const edited = await f.request("PATCH", configurationPath, {
      values: codexProxyValues("codex", networkProxy),
    });
    assert.equal(edited.status, 200, `${label}: ${JSON.stringify(edited)}`);
    assertBrokerProxyRefused(
      await f.request("POST", f.collection, {
        name: `Repository Agent ${randomUUID()}`,
        configurationId: f.configuration.id,
        executionMode: "dedicated",
        repositoryBindings: selection,
      }),
      message,
      `${label} create`,
    );
    assertBrokerProxyRefused(
      await f.request("PATCH", path, {
        configurationId: f.configuration.id,
        repositoryBindings: selection,
      }),
      message,
      `${label} update`,
    );
    assertBrokerProxyRefused(await f.request("POST", `${path}/deploy`), message, `${label} deploy`);
    // Deployment admitted no revision, so the worker has nothing to stop the running one for:
    // it stays the Agent's only revision, and the Agent stays running.
    const revisions = (await f.request("GET", `${path}/revisions`)).data;
    assert.deepEqual(
      revisions.map(({ id }) => id),
      [running.data.id],
      label,
    );
    assert.equal((await f.request("GET", path)).data.desiredRuntimeState, "running", label);
  }

  // Without repository bindings the proxy carries no broker traffic, and the same setting saves
  // and deploys: the refusal's other remedy works.
  const cleared = await f.request("PATCH", path, {
    configurationId: f.configuration.id,
    repositoryBindings: [],
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared));
  const unbound = await f.request("POST", `${path}/deploy`);
  assert.equal(unbound.status, 202, JSON.stringify(unbound));
});

test("Embedded OpenClaw refuses a broker-blocking Codex proxy only with the Codex Plugin Driver", async (t) => {
  const f = await fixture(t);
  const configuration = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
    kind: "agent",
    values: codexProxyValues("openclaw", { enabled: false }),
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration));
  const create = (plugins) =>
    f.request("POST", f.collection, {
      name: `Repository Agent ${randomUUID()}`,
      configurationId: configuration.data.id,
      repositoryBindings: selection,
      ...(plugins === undefined ? {} : { plugins }),
    });
  // Without plugins no Plugin Driver runs Codex in the Gateway, so nothing reads the proxy.
  const plain = await create();
  assert.equal(plain.status, 201, JSON.stringify(plain));
  // With the Codex Plugin Driver, the Gateway's Codex carries the broker traffic.
  const driver = new CodexPluginDriver();
  f.controller.registerDriver(driver);
  f.controller.selectDriver("plugin", driver.id);
  assertBrokerProxyRefused(
    await create({ "codex-plugin:linear@openai-curated-remote": { enabled: true } }),
    BROKER_PROXY_DISABLED,
    "embedded Codex plugins",
  );
});

test("Provisioning refuses a Codex network proxy that blocks the repository broker before queueing", async (t) => {
  const configurationDriver = createTestConfigurationDriver();
  // Refusing the request creates no Configuration; only the worker would.
  configurationDriver.createExact = async () => assert.fail("The request created Configuration");
  configurationDriver.inspectExact = async () => assert.fail("The request inspected Configuration");
  const f = await fixture(t, { harness: "codex", configurationDriver });
  await f.state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
  );
  const secret = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
    name: "Provisioning model",
    value: "synthetic-model-key",
  });
  assert.equal(secret.status, 201, JSON.stringify(secret));
  for (const [label, networkProxy, message] of brokerProxyRefusals) {
    assertBrokerProxyRefused(
      await f.request("POST", `${f.collection}/provision`, {
        requestId: `req_${randomUUID()}`,
        name: `Provisioned ${label}`,
        executionMode: "dedicated",
        configuration: { kind: "agent", values: codexProxyValues("codex", networkProxy) },
        harnessAuth: { method: "api_key", source: secret.data.ref },
        repositoryBindings: selection,
      }),
      message,
      `${label} provision`,
    );
  }
  assert.deepEqual((await f.request("GET", f.collection)).data, []);
});

test("Repository capability remains optional when no repository Backend or Driver is configured", async (t) => {
  const f = await fixture(t, { compute: sshCompute(), repositories: false });
  const agent = await f.createAgent({
    harnessAuth: { method: "runtime" },
    gatewayManagedMode: false,
  });
  await f.prepareDeployment(agent);
  const deployed = await f.request("POST", `${f.collection}/${agent.id}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed));
  assert.equal(Object.hasOwn(deployed.data, "repositoryCredentials"), false);
  // Finding 2362: binding a repository with no repository Driver configured is a permanent
  // Installation state, not an outage, so create and update name the setting instead of a 503.
  for (const [method, path, body] of [
    [
      "PATCH",
      `${f.collection}/${agent.id}`,
      { configurationId: f.configuration.id, repositoryBindings: selection },
    ],
    [
      "POST",
      f.collection,
      {
        name: `Repository Agent ${randomUUID()}`,
        configurationId: f.configuration.id,
        repositoryBindings: selection,
      },
    ],
  ]) {
    const missingDriver = await f.request(method, path, body);
    assert.equal(missingDriver.status, 409, `${method}: ${JSON.stringify(missingDriver)}`);
    assert.equal(missingDriver.error.code, "RESOURCE_CONFLICT", method);
    // Names the missing settings and who adds them (finding D763).
    assert.equal(missingDriver.error.message, REPOSITORY_SETTINGS_MISSING);
  }
  assert.equal((await f.request("GET", f.collection)).data.length, 1, "no Agent was created");
  const unchanged = await f.request("GET", `${f.collection}/${agent.id}`);
  assert.equal(Object.hasOwn(unchanged.data, "repositoryBindings"), false);
  // Without a repository Driver, discovery answers no options before the Compute check.
  const options = await f.request("GET", `${f.collection}/repository-options`);
  assert.equal(options.status, 200, JSON.stringify(options));
  assert.deepEqual(options.data, []);
  assert.equal(options.meta.notConfigured, true);
  // A binding stored before the Installation dropped its repository settings has no approval
  // scope to review: nothing can approve it, so the review lists none instead of the refusal.
  await f.state.transact((unit) =>
    unit.agents.updateConfiguration(
      f.namespace.id,
      agent.id,
      f.configuration.id,
      undefined,
      undefined,
      undefined,
      undefined,
      selection,
    ),
  );
  const scopes = await f.request("GET", `${f.collection}/${agent.id}/repository-approval-scopes`);
  assert.equal(scopes.status, 200, JSON.stringify(scopes));
  assert.deepEqual(scopes.data, []);
  // Such a binding can still be dropped: an empty selection needs no repository Driver, so the
  // console's Repositories tab offers Save for it (finding 2398).
  const dropped = await f.request("PATCH", `${f.collection}/${agent.id}`, {
    configurationId: f.configuration.id,
    repositoryAccess: { defaultProfile: "git-full", repositories: [] },
  });
  assert.equal(dropped.status, 200, JSON.stringify(dropped));
  const cleared = await f.request("GET", `${f.collection}/${agent.id}`);
  assert.deepEqual(cleared.data.repositoryBindings ?? [], []);
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
    compute: kubernetesCompute(),
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
  assert.equal(response.status, 400, JSON.stringify(response));
  assert.equal(response.error.code, "INVALID_REQUEST");
  assert.equal(response.error.message, REPOSITORY_SELECTION_NOT_APPROVED);
  assert.deepEqual((await f.request("GET", f.collection)).data, []);
  // The refusal follows the Namespace's provisioning grants (finding 2536).
  const outsider = await f.requestWithoutGrants(f.app);
  const outsiderBody = { ...body, requestId: `req_${randomUUID()}` };
  await assertSameAnswer(
    (id) => outsider("POST", `/namespaces/${id}/agents/provision`, outsiderBody),
    [f.namespace.id, `ns_${randomUUID()}`],
    { label: "POST agents/provision" },
  );
});

// Finding 1145: the provisioning request answers the 409 Agent create gives for repository
// bindings its topology cannot deliver, instead of a 202 the worker's admission then fails.
test("Provisioning refuses repository bindings on a topology Agent create refuses before queueing", async (t) => {
  const configurationDriver = createTestConfigurationDriver();
  // Accepting or refusing the request creates no Configuration; only the worker would.
  configurationDriver.createExact = async () => assert.fail("The request created Configuration");
  configurationDriver.inspectExact = async () => assert.fail("The request inspected Configuration");
  const f = await fixture(t, {
    harness: "codex",
    configurationDriver,
    compute: kubernetesCompute(),
  });
  await f.state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
  );
  const secret = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
    name: "Provisioning model",
    value: "synthetic-model-key",
  });
  assert.equal(secret.status, 201);
  const plan = (name) => ({
    requestId: `req_${randomUUID()}`,
    name,
    executionMode: "dedicated",
    configuration: { kind: "agent", values: f.configuration.values },
    harnessAuth: { method: "api_key", source: secret.data.ref },
    repositoryBindings: selection,
  });
  // Without a Sandbox the plan passes admission and reaches the provisioning queue, which
  // in-memory state does not provide (the PostgreSQL provisioning tests cover acceptance).
  await assert.rejects(
    f.controller.provisionAgent(f.actorId, {
      ...plan("Plain provisioning"),
      namespaceId: f.namespace.id,
    }),
    /requires durable PostgreSQL state/,
  );
  // Selecting a Sandbox Driver puts every Agent in a Sandbox, where Kubernetes Compute delivers
  // no repository credentials. No Sandbox runtime is invoked.
  const sandbox = {
    id: "repository-provisioning-sandbox",
    capability: "sandbox",
    implementation: "test-sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
  f.controller.registerDriver(sandbox);
  f.controller.selectDriver("sandbox", sandbox.id);
  const created = await f.request("POST", f.collection, {
    name: "Sandboxed repository Agent",
    configurationId: f.configuration.id,
    executionMode: "dedicated",
    repositoryBindings: selection,
  });
  assert.equal(created.status, 409, JSON.stringify(created));
  const refused = await f.request("POST", `${f.collection}/provision`, plan("Sandboxed plan"));
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.error.code, "RESOURCE_CONFLICT");
  assert.equal(refused.error.message, created.error.message);
  assert.deepEqual((await f.request("GET", f.collection)).data, []);
});

test("OpenShell Git refuses an Agent network grant to the Git hosts at save, binding and deploy", async (t) => {
  // Finding 2144: with the OpenShell Git route, github.com and its subdomains are reachable only
  // through its middleware. An approved grant for them would add a direct route beside it, so
  // the policy save, the binding save (the reverse order), deploy and live application refuse
  // it with a message naming the grant. The Driver's provisioning backstop is covered in
  // sandbox-driver-startup.
  const grant = (id, host, port = 443) => ({
    id,
    binary: "/usr/bin/git",
    host,
    ports: [{ from: port, to: port }],
  });
  const docs = grant("docs", "objects.githubusercontent.com");
  const direct = grant("git-direct", "github.com", 22);
  // Finding 2145: an IP address may lead to GitHub, so it is refused the same way.
  const address = grant("git-address", "140.82.112.3");
  const f = await fixture(t, {
    harness: "codex",
    compute: kubernetesCompute(OpenShellGitComputeDriver),
    controllerOptions: {
      sandboxNetworkPolicyCeiling: [docs, direct, address],
      driverConfigurations: [sandboxRegistration("repository-admission-openshell")],
    },
  });
  const sandbox = repositorySandbox(f.registry);
  f.controller.registerDriver(sandbox);
  f.controller.selectDriver("sandbox", sandbox.id);
  const message =
    "OpenShell Git reaches github.com and its subdomains only through its middleware route, so an Agent with a repository binding cannot also allow them: remove network grant git-direct (github.com).";
  const policyPath = (agent) => `${f.collection}/${agent.id}/sandbox-policy/networking`;
  const enableEditing = async (agent) => {
    const enabled = await f.request("PATCH", `${policyPath(agent)}/editing`, { enabled: true });
    assert.equal(enabled.status, 200, JSON.stringify(enabled));
  };
  const additions = async (agent) =>
    (await f.request("GET", policyPath(agent))).data.policy.additions;

  // Policy save on a repository-bound Agent.
  const bound = await f.createAgent({ executionMode: "dedicated", repositoryBindings: selection });
  await enableEditing(bound);
  const refused = await f.request("PUT", policyPath(bound), {
    expectedVersion: 1,
    additions: [docs, direct],
  });
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.error.code, "RESOURCE_CONFLICT");
  assert.equal(refused.error.message, message);
  assert.deepEqual(await additions(bound), []);
  const refusedAddress = await f.request("PUT", policyPath(bound), {
    expectedVersion: 1,
    additions: [docs, address],
  });
  assert.equal(refusedAddress.status, 409, JSON.stringify(refusedAddress));
  assert.equal(refusedAddress.error.code, "RESOURCE_CONFLICT");
  const addressMessage =
    "OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there, so an Agent with a repository binding cannot allow one: remove network grant git-address (140.82.112.3).";
  assert.equal(refusedAddress.error.message, addressMessage);
  assert.deepEqual(await additions(bound), []);
  const saved = await f.request("PUT", policyPath(bound), {
    expectedVersion: 1,
    additions: [docs],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved));

  // The reverse order: the grant first, then the binding.
  const unbound = await f.createAgent({ executionMode: "dedicated" });
  await enableEditing(unbound);
  const granted = await f.request("PUT", policyPath(unbound), {
    expectedVersion: 1,
    additions: [direct],
  });
  assert.equal(granted.status, 200, "without a binding the grant is an ordinary one");
  const binding = await f.request("PATCH", `${f.collection}/${unbound.id}`, {
    configurationId: f.configuration.id,
    repositoryBindings: selection,
  });
  assert.equal(binding.status, 409, JSON.stringify(binding));
  assert.equal(binding.error.message, message);
  assert.equal(
    (await f.request("GET", `${f.collection}/${unbound.id}`)).data.repositoryBindings,
    undefined,
  );
  // Finding 2881: that refusal names a saved grant, so an Agent update without SandboxPolicy
  // read gets the read refusal first, as deploy does when saved additions exist (finding 2151).
  // Each Restriction names one exact SandboxPolicy, so the check must target the Agent's own.
  const plain = await f.createAgent({ executionMode: "dedicated" });
  const plainPolicyId = (await f.request("GET", policyPath(plain))).data.policy.id;
  const unreadable = [granted.data.id, plainPolicyId].map((resourceId) =>
    restrict(f.iamState, "read", "sandbox_policy", { namespaceId: f.namespace.id, resourceId }),
  );
  const hidden = await f.request("PATCH", `${f.collection}/${unbound.id}`, {
    configurationId: f.configuration.id,
    repositoryBindings: selection,
  });
  assert.equal(hidden.status, 403, JSON.stringify(hidden));
  assert.match(hidden.error.message, /needs SandboxPolicy read on /);
  assert.doesNotMatch(JSON.stringify(hidden), /git-direct|github\.com/);
  // An Agent with no saved additions has nothing to name, so its binding saves without read.
  const plainBinding = await f.request("PATCH", `${f.collection}/${plain.id}`, {
    configurationId: f.configuration.id,
    repositoryBindings: selection,
  });
  assert.equal(plainBinding.status, 200, JSON.stringify(plainBinding));
  for (const restriction of unreadable) {
    liftRestriction(f.iamState, restriction);
  }
  assert.equal(
    (await f.request("GET", `${f.collection}/${unbound.id}`)).data.repositoryBindings,
    undefined,
  );
  const addressed = await f.createAgent({ executionMode: "dedicated" });
  await enableEditing(addressed);
  const addressGranted = await f.request("PUT", policyPath(addressed), {
    expectedVersion: 1,
    additions: [address],
  });
  assert.equal(addressGranted.status, 200, "without a binding an IP-address grant is ordinary");
  const addressBinding = await f.request("PATCH", `${f.collection}/${addressed.id}`, {
    configurationId: f.configuration.id,
    repositoryBindings: selection,
  });
  assert.equal(addressBinding.status, 409, JSON.stringify(addressBinding));
  assert.equal(addressBinding.error.message, addressMessage);

  // Deploy refuses a pair stored before these checks, and creates no revision.
  await f.prepareDeployment(bound);
  const stored = async (agent, grants) =>
    f.state.transact(async (unit) => {
      const policy = await unit.sandboxPolicies.find(f.namespace.id, agent.id);
      const { application: _application, ...rest } = policy;
      assert.ok(
        await unit.sandboxPolicies.save(
          { ...rest, version: policy.version + 1, additions: grants },
          policy.version,
        ),
      );
    });
  await stored(bound, [direct]);
  const deployPath = `${f.collection}/${bound.id}/deploy`;
  const deploy = await f.request("POST", deployPath);
  assert.equal(deploy.status, 409, JSON.stringify(deploy));
  assert.equal(deploy.error.message, message);
  assert.deepEqual((await f.request("GET", `${f.collection}/${bound.id}/revisions`)).data, []);

  // Live application to the active Git-bound revision refuses it too.
  await stored(bound, [docs]);
  const deployed = await f.request("POST", deployPath);
  assert.equal(deployed.status, 202, JSON.stringify(deployed));
  assert.ok(deployed.data.repositoryCredentials);
  const revision = await f.state.read((view) =>
    view.revisions.findRevision(f.namespace.id, bound.id, deployed.data.id),
  );
  assert.deepEqual(revision.sandboxPolicy.additions, [docs]);
  await f.state.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(f.namespace.id, bound.id, undefined, deployed.data.id),
  );
  await stored(bound, [docs, direct]);
  const version = (await f.request("GET", policyPath(bound))).data.policy.version;
  const applied = await f.request("POST", `${policyPath(bound)}/apply`, {
    expectedVersion: version,
    revisionId: deployed.data.id,
  });
  assert.equal(applied.status, 409, JSON.stringify(applied));
  assert.equal(applied.error.message, message);
  assert.equal((await f.request("GET", policyPath(bound))).data.policy.application, undefined);
});

// Composes the bundled OpenShell Credential Proxy in the repository.openShell shape, where the
// request-phase registration is also its only egress registration. `advertised` adds the
// execution profile to the stock 0.1.5 registration, as a gateway with a stronger exchange would;
// `registered: false` leaves the registration out of gateway info; `extension` overrides fields
// of the registration gateway info reports; `middlewareName` names a separate egress
// registration; `credentialGateway` also selects the bundled OpenShell Credential Gateway;
// `installationAccess` offers github-installation and composes the Proxy with its Git transport,
// as repository.openShell does; `preview` opts in to the observed-hook preview, and
// `gatewayVersion` replaces the version the gateway reports.
async function protectedOpenShellComposition(
  t,
  {
    bindings = [],
    advertised = false,
    registered = true,
    extension = {},
    middlewareName,
    credentialGateway = false,
    installationAccess = false,
    preview = false,
    gatewayVersion = "0.1.5",
  } = {},
) {
  class ProtectedGitComputeDriver extends OpenShellGitComputeDriver {
    // Stands in for Kubernetes Compute with its paired protected release, so only the Credential
    // Proxy and the contract decide whether the repository execution is admitted.
    validateExecutionAdmission(revision) {
      assertExecutionAdmission(revision);
    }
  }
  class GatewayHarnessComputeDriver extends ProtectedGitComputeDriver {
    // Kubernetes Compute paired with the OpenShell Gateway delivers credential-source Harness
    // authentication; this one is not bound to that pair, so its delivery check is not the subject.
    validateHarnessAuth() {}
  }
  const f = await fixture(t, {
    harness: "codex",
    compute: kubernetesCompute(
      credentialGateway ? GatewayHarnessComputeDriver : ProtectedGitComputeDriver,
    ),
    controllerOptions: {
      driverConfigurations: [sandboxRegistration("repository-admission-openshell")],
    },
    // Every bound repository other than the fixture's own is approved for the Namespace too.
    extraRepositories: bindings
      .map(({ repositoryRef }) => repositoryRef)
      .filter((repositoryRef) => repositoryRef !== "project" && repositoryRef !== "installation"),
    installationAccess,
  });
  const sandbox = repositorySandbox(f.registry);
  const registration = "oce-prepared-git";
  let gatewayReads = 0;
  const gateway = {
    async getGatewayInfo() {
      gatewayReads += 1;
      // What stock 0.1.5 reports once the request-phase service is registered.
      return {
        gateway_version: gatewayVersion,
        extensions: registered
          ? [
              {
                configured_name: registration,
                kind: 4,
                protocol_major: 1,
                ...(advertised && {
                  required_capabilities: [...openShellExchangeCapabilities],
                  supported_capabilities: [...openShellExchangeCapabilities],
                }),
                ...extension,
              },
            ]
          : [],
      };
    },
  };
  const options = {
    middlewareName: middlewareName ?? registration,
    repositoryMiddlewareName: registration,
    authorityScope: "execution",
    ...(preview && { observedHookPreviewWorkspace: "preview-1" }),
  };
  const backend = {
    id: "openshell",
    drivers: credentialGateway ? { credential_gateway: "openshell-credentials" } : {},
    client: { clientForNamespace: () => gateway, placement: () => undefined },
  };
  // Production composes the Proxy with the Git runtime's transport whenever repository Git is
  // protected; admission only checks that it is there.
  const git =
    installationAccess &&
    new OpenShellGitRuntime(
      { protectedExecution: true },
      createGitHubRepositoryDeliveryResolver(
        validateGitHubRepositoryRegistry(f.registry, backendId),
      ),
    );
  const proxy = new OpenShellCredentialProxyDriver(options, {
    id: sandbox.id,
    sandbox,
    backend,
    ...(git && {
      bindRepositoryGit: git.bindRepositoryGit.bind(git),
      previewEnforcement: git.previewEnforcement.bind(git),
    }),
  });
  const owner = new InstalledDriver(
    { id: sandbox.id, implementation: sandbox.implementation, configuration: options },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  f.controller.registerDriver(owner);
  f.controller.selectDriver("sandbox", sandbox.id);
  f.controller.selectDriver("credential_proxy", proxy.id);
  if (credentialGateway) {
    const catalog = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/bin/codex"] },
      { id: "openshell-credentials", backend },
    );
    f.controller.registerDriver(catalog);
    f.controller.selectDriver(catalog.capability, catalog.id);
  }
  return { ...f, gatewayReads: () => gatewayReads };
}

// Deploys a dedicated Codex Agent with `bindings` on that composition; the response and the
// number of gateway reads are returned.
async function protectedOpenShellDeploy(t, bindings, options = {}) {
  const f = await protectedOpenShellComposition(t, { ...options, bindings });
  const agent = await f.createAgent({ executionMode: "dedicated", repositoryBindings: bindings });
  await f.prepareDeployment(agent);
  const path = `${f.collection}/${agent.id}`;
  const response = await f.request("POST", `${path}/deploy`);
  const revisions = (await f.request("GET", `${path}/revisions`)).data;
  return { response, revisions, gatewayReads: f.gatewayReads() };
}

test("Deploy refuses OpenShell Git when its Credential Proxy has no qualified sender", async (t) => {
  // Finding 2199: stock OpenShell registers oce-prepared-git, so admission accepted a git-write
  // binding as protected online authorization. No release is qualified to enforce it, so the
  // Harness waited at enrollment until the 15-minute convergence deadline. Deploy now refuses it
  // with a stable code before contacting the gateway, and creates no revision.
  const { response, revisions, gatewayReads } = await protectedOpenShellDeploy(t, selection);
  assert.equal(response.status, 409, JSON.stringify(response));
  assert.equal(response.error.code, "REPOSITORY_GIT_SENDER_UNQUALIFIED");
  assert.equal(response.error.message, RepositoryGitSenderUnqualifiedError.description);
  assert.deepEqual(revisions, []);
  assert.equal(gatewayReads, 0, "the refusal needs no gateway read");
});

test("Deploy names what installation-wide access needs from the OpenShell Proxy and its gateway", async (t) => {
  // Finding 2536: without observedHookPreviewWorkspace the OpenShell Credential Proxy cannot
  // enforce a github-installation binding, an Installation setting no retry changes; with it,
  // the preview needs gateway 0.1.5, a gateway state an operator changes. Deploy answered both
  // with a generic 503. Now the setting is a 409 before any gateway read, and the gateway state a
  // 503 that names it. Neither creates a revision.
  const installation = [{ repositoryRef: "installation", profile: "github-installation" }];
  for (const [label, options, status, code, message, reads] of [
    ["no preview", {}, 409, "RESOURCE_CONFLICT", CREDENTIAL_PROXY_INSTALLATION_PREVIEW, 0],
    [
      "preview on another gateway",
      { preview: true, gatewayVersion: "0.1.6" },
      503,
      "DEPENDENCY_UNAVAILABLE",
      PREVIEW_GATEWAY_VERSION,
      1,
    ],
  ]) {
    const f = await protectedOpenShellComposition(t, {
      ...options,
      bindings: installation,
      installationAccess: true,
    });
    const agent = await f.createAgent({
      executionMode: "dedicated",
      repositoryBindings: installation,
    });
    await f.prepareDeployment(agent);
    const response = await f.request("POST", `${f.collection}/${agent.id}/deploy`);
    assert.equal(response.status, status, `${label}: ${JSON.stringify(response)}`);
    assert.equal(response.error.code, code, label);
    assert.equal(response.error.message, message, label);
    assert.deepEqual(
      (await f.request("GET", `${f.collection}/${agent.id}/revisions`)).data,
      [],
      label,
    );
    assert.equal(f.gatewayReads(), reads, label);
    // The refusal comes after the deploy grant: a caller without it gets the same answer for
    // this Agent and a missing one, each request's ID hidden.
    const outsider = await f.requestWithoutGrants(f.app);
    await assertSameAnswer(
      (id) => outsider("POST", `${f.collection}/${id}/deploy`),
      [agent.id, `agt_${randomUUID()}`],
      { label },
    );
  }
});

test("Deploy names the Proxy's limit when a protected source sits beside repository Git", async (t) => {
  // Finding 2536 (review-3732): the OpenShell Proxy has no policy reduction, so with the
  // observed-hook preview it delivers installation-wide Git only alone. An Agent that also binds
  // a Proxy-owned source can never start: deploy answers 409 naming the limit and the fixes,
  // after the deploy grant and without a revision.
  const installation = [{ repositoryRef: "installation", profile: "github-installation" }];
  const f = await protectedOpenShellComposition(t, {
    bindings: installation,
    installationAccess: true,
    preview: true,
    // The gateway also registers the execution profile, so the Proxy can own a source.
    advertised: true,
  });
  const agent = await f.createAgent({
    executionMode: "dedicated",
    repositoryBindings: installation,
  });
  // Also registers the Agent's own principal.
  await f.prepareDeployment(agent);
  await f.state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
  );
  const created = await f.request(
    "POST",
    `/namespaces/${f.namespace.id}/credential-sources`,
    protectedSourceInputs["credential-free-repository-metadata"](agent.id),
  );
  assert.equal(created.status, 201, JSON.stringify(created));
  const sourceId = created.data.id;
  // The Agent's own principal may use the source, so only the Proxy's limit refuses the deploy.
  const internal = await f.controller.getAgent(f.actorId, f.namespace.id, agent.id);
  grantRole(f.iamState, internal.servicePrincipalId, {
    id: `source-${agent.id}`,
    namespaceId: f.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: { kind: "credential_source", id: sourceId },
  });
  const path = `${f.collection}/${agent.id}`;
  const bound = await f.request("PATCH", path, {
    configurationId: f.configuration.id,
    credentialSources: [{ sourceId }],
  });
  assert.equal(bound.status, 200, JSON.stringify(bound));
  const deployed = await f.request("POST", `${path}/deploy`);
  assert.equal(deployed.status, 409, JSON.stringify(deployed));
  assert.equal(deployed.error.code, "RESOURCE_CONFLICT");
  assert.equal(deployed.error.message, CREDENTIAL_PROXY_GIT_ALONE);
  assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
  const outsider = await f.requestWithoutGrants(f.app);
  await assertSameAnswer(
    (id) => outsider("POST", `${f.collection}/${id}/deploy`),
    [agent.id, `agt_${randomUUID()}`],
  );
});

test("Deploy refuses a repository profile a Credential Proxy cannot deliver by name", async (t) => {
  // Finding 2204: git-read and git-full map to no delivery profile, so admission checked the
  // counterpart as an ordinary egress plan. Stock 0.1.5 answered a generic 503; a gateway that
  // advertises the execution profile admitted a v4 plan that assertExecutionAdmission rejected
  // as a 500. Deploy now names the supported profiles before contacting the gateway. Two
  // bindings map to no profile either, even when one of them is git-write.
  const several = [
    { repositoryRef: "project", profile: "git-write" },
    { repositoryRef: "second-project", profile: "git-read" },
  ];
  for (const [name, bindings] of [
    ["git-read", [{ repositoryRef: "project", profile: "git-read" }]],
    ["git-full", [{ repositoryRef: "project", profile: "git-full" }]],
    ["two bindings", several],
  ]) {
    for (const advertised of [false, true]) {
      const label = `${name}${advertised ? " with the execution profile" : ""}`;
      const { response, revisions, gatewayReads } = await protectedOpenShellDeploy(t, bindings, {
        advertised,
      });
      assert.equal(response.status, 409, `${label}: ${JSON.stringify(response)}`);
      assert.equal(response.error.code, "REPOSITORY_GIT_PROFILE_UNSUPPORTED", label);
      assert.equal(response.error.message, RepositoryGitProfileUnsupportedError.description);
      assert.deepEqual(revisions, [], label);
      assert.equal(gatewayReads, 0, `${label}: the refusal needs no gateway read`);
    }
  }
});

test("A Git-only Credential Proxy names repository.openShell instead of a 503 or a bare 404", async (t) => {
  // Finding 2360: with repository.openShell the Proxy's only registration is the request-phase
  // Git service, which never advertises the execution profile. Creating a model source answered a
  // generic 503, and deploying an Agent without Git whose Gateway source predates the Proxy
  // answered 404 with nothing logged. Each refusal now names what cannot serve it; any other
  // probe outcome keeps the binding refusal.
  for (const [label, options, refusal] of [
    ["stock 0.1.5", {}, CredentialProxyRepositoryOnlyError],
    ["with the execution profile", { advertised: true }, CredentialSourceUnprotectedError],
    ["registration missing", { registered: false }, CredentialSourceUnprotectedError],
  ]) {
    const f = await protectedOpenShellComposition(t, { ...options, credentialGateway: true });
    const namespaceId = f.namespace.id;
    await f.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
    );
    const secret = await f.request("POST", `/namespaces/${namespaceId}/secrets`, {
      name: "model-key",
      value: "synthetic-admission-model-key",
    });
    assert.equal(secret.status, 201, JSON.stringify(secret));
    const sourceInput = { type: "openai", config: {}, secrets: { api_key: secret.data.ref } };
    if (label !== "with the execution profile") {
      // The Installation refusal comes before any Secret read: this fixture's Secret Driver
      // has no versioned reads, which would otherwise answer first. A gateway without the
      // registration is a state an operator fixes: a 503 that names it (finding 2536).
      const created = await f.request("POST", `/namespaces/${namespaceId}/credential-sources`, {
        name: "fresh-model",
        ...sourceInput,
      });
      const [status, message] =
        label === "stock 0.1.5"
          ? [409, CredentialProxyRepositoryOnlyError.description]
          : [503, PROXY_REGISTRATION_UNAVAILABLE];
      assert.equal(created.status, status, `${label}: ${JSON.stringify(created)}`);
      assert.equal(created.error.message, message, label);
    }
    // A Gateway-owned source registered before the Installation selected the Proxy.
    const sourceId = `cs_${randomUUID()}`;
    await f.state.transact((unit) =>
      unit.credentialSources.createCredentialSource({
        id: sourceId,
        namespaceId,
        name: "earlier-model",
        ...sourceInput,
        ownerCapability: "credential_gateway",
        driverId: "openshell-credentials",
        state: "ready",
        createdAt: new Date().toISOString(),
      }),
    );
    const agent = await f.createAgent({
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: [{ sourceId }],
    });
    const internal = await f.controller.getAgent(f.actorId, namespaceId, agent.id);
    f.iamState.identities.push({
      kind: "service_principal",
      id: internal.servicePrincipalId,
      namespaceId,
    });
    grantRole(f.iamState, internal.servicePrincipalId, {
      id: `source-${agent.id}`,
      namespaceId,
      permissions: { credential_source: ["operate"] },
      resource: { kind: "credential_source", id: sourceId },
    });
    const path = `${f.collection}/${agent.id}`;
    const deployed = await f.request("POST", `${path}/deploy`);
    assert.equal(deployed.status, 409, `${label}: ${JSON.stringify(deployed)}`);
    assert.equal(deployed.error.message, refusal.description, label);
    assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, [], label);
  }
  // An Agent with no credential source reached the same 503 through the counterpart check.
  const { response, revisions } = await protectedOpenShellDeploy(t, []);
  assert.equal(response.status, 409, JSON.stringify(response));
  assert.equal(response.error.message, CredentialProxyRepositoryOnlyError.description);
  assert.deepEqual(revisions, []);
  // Only the repository registration, of either kind encoding, at protocol 1 and advertising no
  // execution capability, is Git-only. A registration missing from gateway info, a partial
  // negotiation or a separate egress registration is still an unavailable counterpart.
  for (const [label, options, status] of [
    ["named kind", { extension: { kind: "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE" } }, 409],
    ["registration missing", { registered: false }, 503],
    ["protocol 2", { extension: { protocol_major: 2 } }, 503],
    [
      "required capabilities only",
      { extension: { required_capabilities: [...openShellExchangeCapabilities] } },
      503,
    ],
    [
      "supported capabilities only",
      { extension: { supported_capabilities: [...openShellExchangeCapabilities] } },
      503,
    ],
    [
      "separate egress registration",
      { middlewareName: "oce-egress", extension: { configured_name: "oce-egress" } },
      503,
    ],
  ]) {
    const { response } = await protectedOpenShellDeploy(t, [], options);
    assert.equal(response.status, status, `${label}: ${JSON.stringify(response)}`);
    if (status === 409) {
      assert.equal(response.error.message, CredentialProxyRepositoryOnlyError.description, label);
    } else {
      // A gateway state an operator fixes, named (finding 2536).
      assert.equal(response.error.code, "DEPENDENCY_UNAVAILABLE", label);
      assert.equal(response.error.message, PROXY_REGISTRATION_UNAVAILABLE, label);
    }
  }
});

test("the policy worker fails a Driver's named policy refusal at once", async () => {
  // Finding 2144's live-application backstop: the OpenShell Driver refuses a Git route bypass
  // before updating the policy. A retry cannot change that, so the worker fails the application
  // as unsupported instead of retrying until it reports the outcome unconfirmed.
  const grant = {
    id: "git-direct",
    binary: "/usr/bin/git",
    host: "github.com",
    ports: [{ from: 22, to: 22 }],
  };
  const application = {
    id: "application-2144",
    revisionId: "rev-2144",
    policyVersion: 2,
    snapshot: {
      driverId: "sandbox",
      implementation: "openshell",
      version: 2,
      defaults: {},
      additions: [grant],
    },
    expectedProviderVersion: "1",
    state: "pending",
    requestedBy: "principal",
    requestedAt: new Date().toISOString(),
  };
  let policy = {
    id: "sbp-2144",
    namespaceId: "ns-2144",
    agentId: "agt-2144",
    version: 2,
    additions: [grant],
    application,
  };
  const outcomes = [];
  const unit = {
    namespaces: { lockNamespace: async () => ({ status: "ready" }) },
    agents: {
      lockAgent: async () => ({
        status: "active",
        desiredRuntimeState: "running",
        activeRevisionId: application.revisionId,
      }),
    },
    sandboxPolicies: {
      find: async () => policy,
      save: async (next) => (policy = next),
    },
    revisions: {
      findRevision: async () => ({
        id: application.revisionId,
        sandboxDriverId: "sandbox",
        executionAdmission: { version: 2, mode: "unprotected" },
        compute: { id: "compute", implementation: "kubernetes" },
        repositoryCredentials: {},
      }),
    },
    audit: { append: async () => {} },
  };
  const queue = {
    heartbeat: async (claim) => claim,
    complete: async () => outcomes.push("complete"),
    fail: async (_claim, { code }) => outcomes.push(`fail ${code}`),
    retry: async (_claim, { code }) => outcomes.push(`retry ${code}`),
  };
  let applied = 0;
  const configurations = new DriverConfigurationRegistry();
  configurations.register(sandboxRegistration("sandbox"));
  // Exercise the registered schema and real admission method before the
  // controlled provider refusal that this worker classification case proves.
  const driver = repositorySandbox(undefined, "sandbox");
  driver.observeNetworkPolicy = async () => ({
    resourceVersion: "1",
    policyVersion: "1",
    state: "applied",
    matches: false,
  });
  driver.applyNetworkPolicy = async () => {
    applied++;
    throw new SandboxNetworkPolicyConflictError("remove network grant git-direct (github.com).");
  };
  const outcome = await reconcileSandboxPolicy(
    {
      configurations,
      state: { transactWithQueue: (operation) => operation(unit, queue) },
      driver,
      compute: {
        id: "compute",
        implementation: "kubernetes",
        resolveSandboxNamespace: async (namespace) => namespace,
      },
      iam: { id: "iam", authorize: async () => ({ allowed: true }) },
      installationId: "ins-2144",
      ceiling: [grant],
      signal: AbortSignal.timeout(5_000),
      maxAttempts: 5,
      deadlineMs: 600_000,
      leaseDurationMs: 30_000,
    },
    {
      idempotencyKey: `agent:${policy.agentId}:reconcile:sandbox_policy:${application.id}`,
      namespaceId: policy.namespaceId,
      agentId: policy.agentId,
      actorId: "principal",
      attemptCount: 1,
      ageMs: 0,
    },
  );
  assert.equal(applied, 1);
  assert.equal(outcome, "permanent");
  assert.deepEqual(outcomes, ["fail SANDBOX_POLICY_UNSUPPORTED"]);
  assert.equal(policy.application.state, "failed");
  assert.equal(policy.application.reason, "SANDBOX_POLICY_UNSUPPORTED");
});
