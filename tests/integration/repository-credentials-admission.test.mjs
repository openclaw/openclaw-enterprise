import { loadedProxyInstallation } from "../helpers/loaded-proxy-installation.ts";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { createOccApi, exportTenants, importTenants } from "../../scripts/split-layout-tenants.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  registerRepositoryAccessUpdateCases,
  registerRepositoryAdmissionCases,
  registerRepositoryOptionCases,
} from "./repository-credentials-agent-access-cases.ts";
import { registerRepositoryCredentialsDeploymentAdmissionCases } from "./repository-credentials-deployment-admission-cases.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  installationControllerOptions,
  loadInstallationConfiguration,
} from "../../apps/controller/src/composition/installation-config.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { harnessEgressEnrollment } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { OpenShellLegacyEgressProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { reconcileSandboxPolicy } from "../../apps/controller/src/worker/sandbox-policy.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
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
  RepositoryGitSenderUnqualifiedError,
  SandboxNetworkPolicyConflictError,
} from "../../packages/occ/src/index.ts";
import {
  createAuthenticatedControllerRequest,
  createTestAuthPrincipal,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { grantRole, liftRestriction, restrict } from "../helpers/iam-grants.ts";
import {
  callerDenied,
  CREDENTIAL_PROXY_GIT_ALONE,
  CREDENTIAL_PROXY_INSTALLATION_ACCESS,
  CREDENTIAL_PROXY_INSTALLATION_PREVIEW,
  DEPENDENCY_UNAVAILABLE,
  PROXY_REGISTRATION_UNAVAILABLE,
  REPOSITORY_SELECTION_NOT_APPROVED,
} from "../helpers/refusal-text.mjs";
import { assertSameAnswer } from "../helpers/refusal-answers.ts";
import { protectedSourceInputs } from "../helpers/protected-source-refusals.ts";

const driverId = "repository-credentials";
const backendId = "repository-provider";
const selection = [{ repositoryRef: "project", profile: "git-write" }];

/**
 * @typedef {ReturnType<typeof createFastifyApp>} AdmissionApp
 * @typedef {(method: string, path: string, payload?: unknown) =>
 *   Promise<{status: number, [field: string]: unknown}>} AdmissionRequest
 */

const sandboxRegistration = (driverId) => ({
  capability: "sandbox",
  driverId,
  implementation: "openshell",
  definition: OpenShellSandboxDriver,
});

function repositorySandbox(registry, id = "repository-admission-openshell", userNamespaces) {
  return new OpenShellSandboxDriver(
    {
      integrationMode: "legacy",
      gateway: {},
      kubernetes: {
        ...(userNamespaces === undefined ? {} : { userNamespaces }),
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
/** @param {typeof KubernetesComputeDriver} [Driver] */
function kubernetesCompute(Driver = KubernetesComputeDriver, selection = {}) {
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
    { nodeEnrollment: {}, ...selection },
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

/**
 * @param {string} namespaceId
 * @param {readonly string[]} extraRepositories
 * @returns {import("../../apps/controller/src/drivers/repo/github/access/registry.ts").GitHubRepositoryRegistry}
 */
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
  // Admission must complete without contacting the service or obtaining credentials.
  return new Driver(
    {
      driverId,
      backendId,
    },
    validateGitHubRepositoryRegistry(registry, backendId),
    { sessionDurationSeconds: 600 },
  );
}

/** @param {import("node:test").TestContext} t */
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
    repositoryAdmission,
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

  /**
   * @param {import("../../apps/controller/src/drivers/repo/github/access/registry.ts").GitHubRepositoryRegistry} [registry]
   * @param {typeof GitHubRepositoryPolicy} [Driver]
   */
  async function compose(registry, Driver) {
    const options = {
      state,
      backends,
      ...controllerOptions,
    };
    const repository = registry === undefined ? undefined : repositoryDriver(registry, Driver);
    const controller =
      repositoryAdmission !== undefined && repository !== undefined
        ? OpenClawController.forInstallation(installation, options, {
            policy: repository,
            backendId,
            ...(repositoryAdmission === "built-in" && { policyMode: "built-in" }),
          })
        : new OpenClawController(installation, options);
    for (const driver of [iam, compute, configurationDriver, secretDriver]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    if (repository !== undefined && repositoryAdmission !== "built-in") {
      controller.registerDriver(repository);
      controller.selectDriver(repository.capability, repository.id);
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
      development: {
        enabled: true,
        installationId: installation.id,
        browserOrigin: "https://console.oce.localhost",
      },
    });
    t.after(() => app.close());
    /** @type {AdmissionRequest} */
    const request = await createAuthenticatedControllerRequest(app, auth);
    return { controller, request, app, repository };
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

  /** @param {Partial<import("../../packages/contracts/src/index.ts").CreateAgentBody>} fields */
  async function createAgent(fields = {}) {
    const response = await composed.request("POST", collection, {
      name: `Repository Agent ${randomUUID()}`,
      configurationId: configuration.id,
      ...fields,
    });
    assert.equal(response.status, 201, JSON.stringify(response));
    return response.data;
  }

  /** @param {Pick<import("../../packages/contracts/src/index.ts").AgentWire, "id" | "harnessAuth">} agent */
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
  /** @param {AdmissionApp} app @returns {Promise<AdmissionRequest>} */
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
    /** @param {number} count */
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

registerRepositoryOptionCases(fixture);

test("Repository options preserve the full valid GitHub catalog and refuse overflow", async (t) => {
  const f = await fixture(t);
  const agent = await f.createAgent();
  const foreign = await f.request("POST", "/namespaces", { name: "foreign-repositories" });
  assert.equal(foreign.status, 201, JSON.stringify(foreign));
  const paths = [
    `${f.collection}/repository-options`,
    `${f.collection}/${agent.id}/repository-options`,
  ];
  const ordinaryOptions = Array.from({ length: 1000 }, (_, index) => {
    const repositoryRef = `repository-${String(index + 1).padStart(4, "0")}`;
    return {
      repositoryRef,
      displayName: `example/${repositoryRef}`,
      allowedProfiles: ["git-read"],
    };
  });
  const registry = {
    ...f.registry,
    repositories: ordinaryOptions.map((option, index) => ({
      repositoryRef: option.repositoryRef,
      repositoryId: String(10000 + index),
      repository: option.displayName,
      namespaces: [
        { namespaceId: f.namespace.id, profiles: ["git-read"] },
        ...(index === 0 ? [{ namespaceId: foreign.data.id, profiles: ["git-read"] }] : []),
      ],
    })),
  };
  const installationAccess = {
    repositoryRef: "installation",
    namespaces: [{ namespaceId: f.namespace.id, accessMode: "installation" }],
  };
  const installationOption = {
    repositoryRef: "installation",
    displayName: "All repositories and permissions available to this GitHub App installation",
    allowedProfiles: ["github-installation"],
  };

  // The public catalog has room for the separately registered Installation choice.
  // Construct every positive case through the real registry validator and policy.
  for (const [count, installation] of [
    [1000, false],
    [999, true],
    [1000, true],
  ]) {
    await t.test(`${count} repositories${installation ? " plus Installation" : ""}`, async () => {
      const configured = {
        ...registry,
        repositories: registry.repositories.slice(0, count),
        ...(installation && { installationAccess }),
      };
      const reconfigured = await f.compose(configured);
      const expected = [
        ...ordinaryOptions.slice(0, count),
        ...(installation ? [installationOption] : []),
      ];
      for (const path of paths) {
        const response = await reconfigured.request("GET", path);
        assert.equal(response.status, 200, JSON.stringify(response));
        assert.deepEqual(response.data, expected, path);
      }
      const filtered = await reconfigured.request(
        "GET",
        `/namespaces/${foreign.data.id}/agents/repository-options`,
      );
      assert.equal(filtered.status, 200, JSON.stringify(filtered));
      assert.deepEqual(filtered.data, [ordinaryOptions[0]]);
    });
  }

  const extraRepository = {
    repositoryRef: "overflow",
    repositoryId: "20000",
    repository: "example/overflow",
    namespaces: [{ namespaceId: f.namespace.id, profiles: ["git-read"] }],
  };
  assert.throws(
    () =>
      repositoryDriver({ ...registry, repositories: [...registry.repositories, extraRepository] }),
    /invalid-repository-registry/,
    "the ordinary registry still refuses more than 1,000 repositories",
  );

  // A third-party Driver may return an oversized result even though GitHub policy cannot.
  // Keep the real maximum-size GitHub catalog and add one otherwise valid, distinct choice.
  class OversizedRepositoryDriver extends GitHubRepositoryPolicy {
    async listOptions(input) {
      const result = await super.listOptions(input);
      return {
        options: [
          ...result.options,
          {
            repositoryRef: "overflow",
            displayName: "example/overflow",
            allowedProfiles: ["git-read"],
          },
        ],
      };
    }
  }
  const oversized = await f.compose({ ...registry, installationAccess }, OversizedRepositoryDriver);
  for (const path of paths) {
    const response = await oversized.request("GET", path);
    assert.equal(response.status, 503, JSON.stringify(response));
    assert.equal(response.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(response.error.message, DEPENDENCY_UNAVAILABLE);
    assert.equal(response.data, undefined, "an oversized catalog must not return partial choices");
  }
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

registerRepositoryAdmissionCases({ fixture, kubernetesCompute, selection, backendId });

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

registerRepositoryAccessUpdateCases({ fixture, selection });

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

/**
 * @param {string} harness
 * @param {import("../../packages/contracts/src/index.ts").OpenClawConfigurationValue} networkProxy
 */
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

registerRepositoryCredentialsDeploymentAdmissionCases({
  fixture,
  kubernetesCompute,
  sshCompute,
  codexProxyValues,
  selection,
  driverId,
  backendId,
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

test("the SandboxPolicy read shows only current Namespace repository approvals", async (t) => {
  const repositoryNetworkPolicyCeiling = /** @type {const} */ ([
    { repository: "example/manual", access: "read" },
    { repository: "example/project", access: "write" },
  ]);
  const foreignGrant = /** @type {const} */ ({
    repository: "example/foreign-project",
    access: "write",
  });
  const path = join(await temporaryDirectory(t, "occ-repository-ceiling-"), "installation.yaml");
  await writeFile(
    path,
    JSON.stringify({
      ...createInstallationDriverConfiguration(),
      repositoryNetworkPolicyCeiling: [...repositoryNetworkPolicyCeiling, foreignGrant],
    }),
  );
  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.ok(loaded);
  const f = await fixture(t, {
    harness: "codex",
    repositoryAdmission: "selected",
    extraRepositories: ["manual"],
    controllerOptions: {
      ...installationControllerOptions(loaded.installation),
      driverConfigurations: [sandboxRegistration("repository-admission-openshell")],
    },
  });
  const sandbox = repositorySandbox();
  Object.assign(sandbox, {
    namespaceLifecycleHooks: sandboxNamespaceLifecycleBinding(
      f.controller.selectedDriver("compute"),
      sandbox,
    ).hooks,
  });
  f.controller.registerDriver(sandbox);
  f.controller.selectDriver("sandbox", sandbox.id);
  const agent = await f.createAgent({ executionMode: "dedicated" });
  const policyPath = `${f.collection}/${agent.id}/sandbox-policy/networking`;
  await f.prepareDeployment(agent);
  const initial = await f.request("GET", policyPath);
  assert.equal(initial.status, 200, JSON.stringify(initial));
  assert.equal(initial.data.repositoryNetworkPolicySaveSupported, false);
  assert.deepEqual(initial.data.repositoryNetworkPolicyCeiling, repositoryNetworkPolicyCeiling);
  const repository = f.controller.selectedDriver("repo");

  function installApproval(descriptor) {
    const key = "repositoryNetworkPolicyAllows";
    const original = Object.getOwnPropertyDescriptor(repository, key);
    Object.defineProperty(repository, key, { configurable: true, ...descriptor });
    return () => {
      if (original) {
        Object.defineProperty(repository, key, original);
      } else {
        Reflect.deleteProperty(repository, key);
      }
    };
  }

  await t.test("keeps the approved read fallback within the configured ceiling", async (t) => {
    t.after(
      installApproval({
        value: ({ grant }) => {
          if (grant.repository !== "example/project" || grant.access !== "read") {
            return false;
          }
          // A Driver may approve the read fallback but cannot change what it delegates.
          Reflect.set(grant, "repository", "example/outside");
          Reflect.set(grant, "access", "write");
          return true;
        },
      }),
    );
    const current = await f.request("GET", policyPath);
    assert.equal(current.status, 200, JSON.stringify(current));
    assert.deepEqual(current.data.repositoryNetworkPolicyCeiling, [
      { repository: "example/project", access: "read" },
    ]);
  });

  // The Console's policy readback must omit grants when the Driver violates its synchronous contract.
  const approval = t.mock.fn(() => Promise.resolve(false));
  const restoreApproval = installApproval({ value: (input) => approval(input) });
  try {
    const denied = await f.request("GET", policyPath);
    assert.equal(denied.status, 200, JSON.stringify(denied));
    assert.deepEqual(denied.data.repositoryNetworkPolicyCeiling, [], "async denial");

    approval.mock.mockImplementation(() => Promise.reject(new Error("synthetic approval failure")));
    const rejected = await f.request("GET", policyPath);
    assert.equal(rejected.status, 200, JSON.stringify(rejected));
    assert.deepEqual(rejected.data.repositoryNetworkPolicyCeiling, [], "async rejection");

    approval.mock.mockImplementation(() => {
      throw new Error("synthetic private approval diagnostic");
    });
    const failed = await f.request("GET", policyPath);
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.data.repositoryNetworkPolicyCeiling, [], "synchronous exception");
    assert.equal(JSON.stringify(failed).includes("synthetic private approval diagnostic"), false);

    // Discard approvals if the selected policy replaces the method while filtering the ceiling.
    approval.mock.mockImplementation(() => {
      Object.defineProperty(repository, "repositoryNetworkPolicyAllows", {
        value: () => false,
      });
      return true;
    });
    const replaced = await f.request("GET", policyPath);
    assert.equal(replaced.status, 200, JSON.stringify(replaced));
    assert.deepEqual(replaced.data.repositoryNetworkPolicyCeiling, [], "method replacement");
  } finally {
    restoreApproval();
  }
});

test("the SandboxPolicy read preserves saved grants when the built-in repository owner fails", async (t) => {
  const savedGrants = [{ repository: "example/project", access: "read" }];
  for (const ceiling of [savedGrants, []]) {
    await t.test(ceiling.length ? "configured ceiling" : "empty ceiling", async (t) => {
      const f = await fixture(t, {
        repositoryAdmission: "built-in",
        controllerOptions: { repositoryNetworkPolicyCeiling: ceiling },
      });
      const agent = await f.createAgent();
      const policyPath = `${f.collection}/${agent.id}/sandbox-policy/networking`;
      // This controller can read saved grants from a compatible writer but cannot create them.
      await f.state.transact(async (unit) => {
        const policy = await unit.sandboxPolicies.find(f.namespace.id, agent.id);
        assert.ok(policy);
        const saved = {
          ...policy,
          version: policy.version + 1,
          repositoryNetworkPolicy: savedGrants,
        };
        assert.deepEqual(await unit.sandboxPolicies.save(saved, policy.version), saved);
      });
      const initial = await f.request("GET", policyPath);
      assert.equal(initial.status, 200, JSON.stringify(initial));
      assert.deepEqual(initial.data.repositoryNetworkPolicyCeiling, ceiling);
      assert.deepEqual(initial.data.policy.repositoryNetworkPolicy, savedGrants);
      assert.equal(initial.data.repositoryNetworkPolicySaveSupported, true);

      const privateDiagnostic = "synthetic private repository owner diagnostic";
      const resolve = t.mock.fn(() => {
        throw new Error(privateDiagnostic);
      });
      // Break contract introspection after the actual owner has been bound and validated.
      Object.defineProperty(f.repository, "resolve", { get: resolve });
      const current = await f.request("GET", policyPath);
      assert.equal(current.status, 200, JSON.stringify(current));
      assert.deepEqual(current.data, { ...initial.data, repositoryNetworkPolicyCeiling: [] });
      assert.equal(JSON.stringify(current).includes(privateDiagnostic), false);
      assert.equal(resolve.mock.callCount(), ceiling.length ? 1 : 0);
    });
  }
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
  Object.assign(sandbox, {
    namespaceLifecycleHooks: sandboxNamespaceLifecycleBinding(
      f.controller.selectedDriver("compute"),
      sandbox,
    ).hooks,
  });
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
  assert.equal(
    hidden.error.message,
    callerDenied("SandboxPolicy read", `SandboxPolicy ${granted.data.id}`),
  );
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
    credentialRefresh = false,
    toolBinaries,
    credentialProxy = true,
    harness = "codex",
    installationAccess = false,
    preview = false,
    gatewayVersion = "0.1.5",
    installedProfile,
    sandboxNetworkPolicyCeiling = [],
    runtimeAuthCompute = false,
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
    // This admission fixture has no Kubernetes cluster; placement is a separate integration.
    async resolveSandboxNamespace(namespace) {
      return namespace;
    }
  }
  const namespaceLifecycleBindings = [];
  const f = await fixture(t, {
    harness,
    compute: kubernetesCompute(
      credentialGateway ? GatewayHarnessComputeDriver : ProtectedGitComputeDriver,
    ),
    controllerOptions: {
      namespaceLifecycleBindings,
      driverConfigurations: [sandboxRegistration("repository-admission-openshell")],
      sandboxNetworkPolicyCeiling,
    },
    // Every bound repository other than the fixture's own is approved for the Namespace too.
    extraRepositories: bindings
      .map(({ repositoryRef }) => repositoryRef)
      .filter((repositoryRef) => repositoryRef !== "project" && repositoryRef !== "installation"),
    installationAccess,
  });
  let sandbox = repositorySandbox(
    f.registry,
    "repository-admission-openshell",
    harness === "openclaw" ? false : undefined,
  );
  const registration = "oce-prepared-git";
  let gatewayReads = 0;
  // Gateway storage is simulated; registration still uses the bundled Gateway Driver.
  const providers = new Map();
  const profiles = new Map();
  const gateway = {
    async getProvider(workspace, name) {
      return providers.get(`${workspace}/${name}`);
    },
    async createProvider(input) {
      providers.set(`${input.workspace}/${input.name}`, structuredClone(input));
    },
    async getProviderProfile(workspace, id) {
      return profiles.get(`${workspace}/${id}`);
    },
    async importProviderProfile(workspace, profile) {
      profiles.set(`${workspace}/${profile.id}`, structuredClone(profile));
    },
    async getGatewayInfo() {
      gatewayReads += 1;
      // What stock 0.1.5 reports once the request-phase service is registered.
      return {
        gateway_version: gatewayVersion,
        extensions: registered
          ? [
              {
                configured_name: installedProfile === "execution" ? "oce-authority" : registration,
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
    drivers: {
      sandbox: sandbox.id,
      credential_proxy: sandbox.id,
      ...(credentialGateway && { credential_gateway: "openshell-credentials" }),
      ...(credentialRefresh && { credential_refresh: "openshell-refresh" }),
    },
    client: { clientForNamespace: () => gateway, placement: () => undefined, close() {} },
  };
  // Production composes the Proxy with the Git runtime's transport whenever repository Git is
  // protected; admission only checks that it is there.
  const git =
    installationAccess &&
    new OpenShellGitRuntime(
      {},
      createGitHubRepositoryDeliveryResolver(
        validateGitHubRepositoryRegistry(f.registry, backendId),
      ),
    );
  let proxy = new OpenShellLegacyEgressProxyDriver(options, {
    id: sandbox.id,
    sandbox,
    backend,
    ...(git && {
      bindRepositoryGit: git.bindRepositoryGit.bind(git),
      previewEnforcement: git.previewEnforcement.bind(git),
    }),
  });
  let owner = new InstalledDriver(
    { id: sandbox.id, implementation: sandbox.implementation, configuration: options },
    {
      capabilities: { sandbox, credential_proxy: proxy },
    },
  );
  if (installedProfile) {
    const loaded = await loadedProxyInstallation(t, {
      profile: installedProfile,
      id: sandbox.id,
      registry: f.registry,
      preview,
      createOpenShellBackend: () => backend,
    });
    owner = loaded.protectedDriver;
    sandbox = loaded.sandboxDriver;
    proxy = loaded.proxyDriver;
    t.after(() => owner.close());
  }
  if (runtimeAuthCompute) {
    const compute = kubernetesCompute(KubernetesComputeDriver, {
      id: "runtime-admission-kubernetes",
      protectedDriver: owner,
    });
    f.controller.registerDriver(compute);
    f.controller.selectDriver("compute", compute.id);
  }
  namespaceLifecycleBindings.push(
    sandboxNamespaceLifecycleBinding(f.controller.selectedDriver("compute"), sandbox, owner),
  );
  f.controller.registerDriver(owner);
  f.controller.selectDriver("sandbox", sandbox.id);
  if (credentialProxy) {
    f.controller.selectDriver("credential_proxy", proxy.id);
  }
  if (credentialGateway) {
    const catalog = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/bin/codex"], ...(toolBinaries && { toolBinaries }) },
      { id: "openshell-credentials", backend },
    );
    f.controller.registerDriver(catalog);
    f.controller.selectDriver(catalog.capability, catalog.id);
  }
  if (credentialRefresh) {
    const refresh = new OpenShellCredentialRefreshDriver({}, { id: "openshell-refresh", backend });
    f.controller.registerDriver(refresh);
    f.controller.selectDriver(refresh.capability, refresh.id);
  }
  return { ...f, providers, protectedDriver: owner, gatewayReads: () => gatewayReads };
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
  // Opt-in is an Installation setting (409); missing registration is gateway state (503).
  // Neither refusal creates a revision or changes with the gateway release label.
  const installation = [{ repositoryRef: "installation", profile: "github-installation" }];
  for (const [label, options, status, code, message, reads] of [
    [
      "no preview",
      { gatewayVersion: "0.1.6" },
      409,
      "RESOURCE_CONFLICT",
      CREDENTIAL_PROXY_INSTALLATION_PREVIEW,
      0,
    ],
    [
      "preview without registration",
      { preview: true, gatewayVersion: "unknown", registered: false },
      503,
      "DEPENDENCY_UNAVAILABLE",
      PROXY_REGISTRATION_UNAVAILABLE,
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
  // A lone unsupported binding and a mixed selection need different fixes. The mixed one must
  // point to github-repository, which delivers several repositories, not say they are refused.
  const lone = /cannot deliver this repository's Git access level/u;
  for (const [name, bindings, message] of [
    ["git-read", [{ repositoryRef: "project", profile: "git-read" }], lone],
    ["git-full", [{ repositoryRef: "project", profile: "git-full" }], lone],
    ["two bindings", several, /To use more than one repository, .*`github-repository`/u],
  ]) {
    for (const advertised of [false, true]) {
      const label = `${name}${advertised ? " with the execution profile" : ""}`;
      const { response, revisions, gatewayReads } = await protectedOpenShellDeploy(t, bindings, {
        advertised,
      });
      assert.equal(response.status, 409, `${label}: ${JSON.stringify(response)}`);
      assert.equal(response.error.code, "REPOSITORY_GIT_PROFILE_UNSUPPORTED", label);
      assert.match(response.error.message, message, label);
      assert.deepEqual(revisions, [], label);
      assert.equal(gatewayReads, 0, `${label}: the refusal needs no gateway read`);
    }
  }

  // A resumed migration must report each real refusal and continue to the next Agent.
  const f = await protectedOpenShellComposition(t);
  for (const profile of ["git-read", "git-full"]) {
    const agent = await f.createAgent({
      executionMode: "dedicated",
      repositoryBindings: [{ repositoryRef: "project", profile }],
    });
    await f.prepareDeployment(agent);
  }
  const deployedIds = [];
  const api = createOccApi({
    baseUrl: "https://console.oce.localhost",
    async fetchImpl(url, init) {
      const path = new URL(url).pathname;
      if (init.method === "POST" && path.endsWith("/deploy")) {
        deployedIds.push(path.split("/").at(-2));
      }
      // Preserve the real Fastify response, including its OCC request ID. No
      // admission decision or error payload is replaced by this transport adapter.
      const { status, ...payload } = await f.request(
        init.method,
        path,
        init.body === undefined ? undefined : JSON.parse(init.body),
      );
      return new Response(status === 204 ? null : JSON.stringify(payload), { status });
    },
  });
  const bundle = await exportTenants(api);
  bundle.namespaces = bundle.namespaces.filter(({ id }) => id === f.namespace.id);
  const tenant = bundle.namespaces[0];
  assert.ok(tenant);
  const restored = { ids: { [tenant.id]: tenant.id }, deployed: [] };
  for (const collection of [
    tenant.secrets,
    tenant.credentialSources,
    tenant.configurations,
    tenant.presets,
    tenant.roles,
    tenant.accessBindings,
    tenant.serviceAccounts,
    tenant.agents,
  ]) {
    for (const resource of collection) {
      restored.ids[resource.id] = resource.id;
    }
  }
  for (const agent of tenant.agents) {
    restored.ids[agent.servicePrincipalId] = agent.servicePrincipalId;
    // The source bundle asks to restore running intent from the old Installation.
    // Target Agents are already recreated and stopped; its selected Proxy now
    // refuses their saved repository profiles before admitting any revision.
    agent.desiredRuntimeState = "running";
  }
  const values = {
    [tenant.name]: Object.fromEntries(
      tenant.secrets.map(({ name }) => [name, "synthetic-admission-model-key"]),
    ),
  };
  const before = structuredClone(restored);
  let saves = 0;
  const outcome = await importTenants(api, bundle, values, {
    state: restored,
    save: () => {
      saves += 1;
    },
  });
  assert.equal(outcome.complete, true);
  assert.equal(outcome.failedDeploys.length, 2);
  assert.deepEqual(
    deployedIds,
    tenant.agents.map(({ id }) => id),
  );
  for (const [index, agent] of tenant.agents.entries()) {
    assert.equal(
      outcome.failedDeploys[index],
      `${tenant.name}/${agent.name}: POST ${f.collection}/${agent.id}/deploy: ` +
        "HTTP 409 REPOSITORY_GIT_PROFILE_UNSUPPORTED " +
        "A Credential Proxy cannot deliver this repository's Git access level. " +
        "Use `github-repository` or `git-write` for it, or ask an administrator to " +
        "use native prepared Git without a Sandbox or Proxy, then deploy again.",
    );
    assert.deepEqual((await f.request("GET", `${f.collection}/${agent.id}/revisions`)).data, []);
  }
  assert.deepEqual(restored, before);
  assert.equal(saves, 0);
  assert.equal(f.gatewayReads(), 0);
});

test("Git Proxy selection preserves Gateway model registration and independent Git admission", async (t) => {
  const addition = {
    id: "docs",
    binary: "/usr/bin/curl",
    host: "docs.example.test",
    ports: [{ from: 443, to: 443 }],
  };
  for (const [label, options, git = false, expected = 202] of [
    ["Git-only Proxy", { installedProfile: "repository", policyEdges: true }],
    ["Codex without repositories", { harness: "codex", installedProfile: "repository" }],
    ["Git-only without remote registration", { installedProfile: "repository", registered: false }],
    ["no Proxy", { credentialProxy: false, policyEdges: true }],
    ["extra ordinary source", { installedProfile: "repository", extraOrdinary: true }, false, 409],
    ["no Proxy with extra ordinary source", { credentialProxy: false, extraOrdinary: true }],
    [
      "Git with model",
      { installedProfile: "repository", installationAccess: true, preview: true },
      true,
    ],
    [
      "Git enforcement unavailable",
      {
        installedProfile: "repository",
        installationAccess: true,
        preview: true,
        registered: false,
      },
      true,
      503,
    ],
  ]) {
    const f = await protectedOpenShellComposition(t, {
      ...options,
      credentialGateway: true,
      harness: git ? "codex" : (options.harness ?? "openclaw"),
      sandboxNetworkPolicyCeiling: [addition],
    });
    // Exercise the shipped Compute gate through the deploy route. The original fixture
    // bypassed it and missed rejection of ordinary Agents when a Proxy was configured.
    const compute = kubernetesCompute(KubernetesComputeDriver, {
      ...(options.credentialProxy !== false && { protectedDriver: f.protectedDriver }),
      sandboxDriver: f.controller.selectedDriver("sandbox"),
      credentialGatewayDriver: f.controller.selectedDriver("credential_gateway"),
    });
    f.controller.selectedDriver("compute").validateExecutionAdmission =
      compute.validateExecutionAdmission.bind(compute);
    const namespaceId = f.namespace.id;
    const capabilitiesPath = `/namespaces/${namespaceId}/agent-capabilities`;
    const outsider = await f.requestWithoutGrants(f.app);
    assert.equal((await outsider("GET", capabilitiesPath)).status, 403, label);
    for (const path of [capabilitiesPath, "/installation"]) {
      const response = await f.request("GET", path);
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.data.capabilities.repositoryAccessRequired, undefined, label);
      assert.ok(
        response.data.capabilities.credentialSources.types.some(({ type }) => type === "openai"),
      );
    }
    await f.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
    );
    const secret = await f.request("POST", `/namespaces/${namespaceId}/secrets`, {
      name: "model-key",
      value: "synthetic-admission-model-key",
    });
    assert.equal(secret.status, 201, JSON.stringify(secret));
    const created = await f.request("POST", `/namespaces/${namespaceId}/credential-sources`, {
      name: "fresh-model",
      type: "openai",
      config: {},
      secrets: { api_key: secret.data.ref },
    });
    assert.equal(created.status, 201, `${label}: ${JSON.stringify(created)}`);
    assert.equal(created.data.state, "ready");
    assert.equal(created.data.egress, undefined);
    assert.equal(f.providers.size, 1, "registration writes the model provider through the Gateway");
    const sourceId = created.data.id;
    const bindings = [{ sourceId }];
    if (options.extraOrdinary) {
      const extra = await f.request("POST", `/namespaces/${namespaceId}/credential-sources`, {
        name: "unrelated-model",
        type: "openai",
        secrets: { api_key: secret.data.ref },
      });
      assert.equal(extra.status, 201, JSON.stringify(extra));
      bindings.push({ sourceId: extra.data.id });
    }
    const agent = await f.createAgent({
      ...(git && {
        repositoryBindings: [{ repositoryRef: "installation", profile: "github-installation" }],
      }),
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: bindings,
    });
    const internal = await f.controller.getAgent(f.actorId, namespaceId, agent.id);
    f.iamState.identities.push({
      kind: "service_principal",
      id: internal.servicePrincipalId,
      namespaceId,
    });
    for (const binding of bindings) {
      grantRole(f.iamState, internal.servicePrincipalId, {
        id: `source-${agent.id}-${binding.sourceId}`,
        namespaceId,
        permissions: { credential_source: ["operate"] },
        resource: { kind: "credential_source", id: binding.sourceId },
      });
    }
    const path = `${f.collection}/${agent.id}`;
    const deployed = await f.request("POST", `${path}/deploy`);
    assert.equal(deployed.status, expected, `${label}: ${JSON.stringify(deployed)}`);
    const revisions = (await f.request("GET", `${path}/revisions`)).data;
    assert.equal(revisions.length, expected === 202 ? 1 : 0);
    if (expected === 202) {
      assert.equal(deployed.data.id, revisions[0].id);
    }
    if (!git && expected === 202) {
      const revision = await f.state.transact((unit) =>
        unit.revisions.findRevision(namespaceId, agent.id, revisions[0].id),
      );
      assert.deepEqual(revision.executionAdmission, { version: 2, mode: "unprotected" });
      assert.equal(revision.egressPlan, undefined);
      compute.validateExecutionAdmission(revision, "stored");
      if (!options.extraOrdinary) {
        const gateway = f.controller.selectedDriver("credential_gateway");
        const catalog = await gateway.listSourceTypes({ signal: AbortSignal.timeout(1000) });
        let currentCatalog = catalog;
        const catalogRead = t.mock.method(gateway, "listSourceTypes", async () => currentCatalog);
        const attachment = t.mock.method(gateway, "attachForRevision");
        // Stop at the first Kubernetes request, after real catalog/auth validation.
        // This proves dispatch eligibility, not cluster readiness or model execution.
        // A definitive 4xx stops the real Driver's retry loop after one request.
        const placementReached = Object.assign(new Error("Kubernetes namespace lookup reached"), {
          statusCode: 400,
        });
        let placementReads = 0;
        compute.apiClients = Promise.resolve({
          core: {
            async listNamespace() {
              placementReads += 1;
              throw placementReached;
            },
          },
        });
        try {
          for (const change of [
            {},
            { rotation: "refresh" },
            { deviceAuthorization: { harnessId: "codex" } },
          ]) {
            currentCatalog = catalog.map((type) =>
              type.type === "openai" ? { ...type, ...change } : type,
            );
            const refused = options.credentialProxy !== false && Object.keys(change).length > 0;
            for (const lifecycle of ["prepareRevision", "activateRevision"]) {
              const beforePlacement = placementReads;
              const beforeCatalog = catalogRead.mock.callCount();
              await assert.rejects(
                compute[lifecycle](revision),
                refused
                  ? {
                      message:
                        "The selected Credential Proxy cannot preserve this credential source's lifecycle.",
                    }
                  : (error) => error === placementReached,
                `${label}: ${lifecycle}: ${JSON.stringify(change)}`,
              );
              assert.equal(catalogRead.mock.callCount(), beforeCatalog + 1);
              assert.equal(placementReads, beforePlacement + (refused ? 0 : 1));
              assert.equal(attachment.mock.callCount(), 0);
            }
          }
        } finally {
          catalogRead.mock.restore();
          attachment.mock.restore();
        }
      }
      if (options.credentialProxy !== false) {
        for (const invalid of [
          { ...revision, harnessAuth: { method: "runtime" }, credentialSources: [] },
          {
            ...revision,
            credentialSources: [...revision.credentialSources, ...revision.credentialSources],
          },
          {
            ...revision,
            harnessAuth: { ...revision.harnessAuth, credentialGatewayId: "other-owner" },
          },
          { ...revision, harnessAuth: { ...revision.harnessAuth, sourceId: "other-source" } },
        ]) {
          assert.throws(
            () => compute.validateExecutionAdmission(invalid, "stored"),
            /exact paired Compute release/,
          );
        }
      }
      assert.equal(f.gatewayReads(), 0, "ordinary model use does not probe the Proxy");
    } else if (expected === 202) {
      const revision = await f.state.read((unit) =>
        unit.revisions.findRevision(namespaceId, agent.id, revisions[0].id),
      );
      assert.equal(revision.executionAdmission.mode, "protected");
      assert.deepEqual(revision.egressPlan.harnessCredentialSource, revision.harnessAuth);
      assert.equal(revision.egressPlan.harnessCredentialSource.sourceId, sourceId);
      assert.ok(revision.egressPlan.repositoryGit);
      compute.validateExecutionAdmission(revision, "stored");
    } else if (expected === 503) {
      assert.equal(deployed.error.message, PROXY_REGISTRATION_UNAVAILABLE);
    } else if (expected === 409) {
      assert.equal(deployed.error.message, CredentialSourceUnprotectedError.description);
    }
    if (expected === 202 || expected === 409) {
      const protectedExecution = git || expected === 409;
      const policyPath = `${path}/sandbox-policy/networking`;
      const enabled = await f.request("PATCH", `${policyPath}/editing`, { enabled: true });
      assert.equal(enabled.status, 200, JSON.stringify(enabled));
      const view = await f.request("GET", policyPath);
      assert.equal(view.data.protectedExecution, protectedExecution);
      const input = { expectedVersion: view.data.policy.version, additions: [addition] };
      const validation = await f.request("POST", `${policyPath}/validate`, input);
      assert.equal(validation.status, protectedExecution ? 409 : 200, JSON.stringify(validation));
      if (protectedExecution) {
        assert.equal(validation.error.code, "SANDBOX_POLICY_PROTECTED_EXECUTION");
      } else {
        assert.equal(validation.data.success, true);
      }
      const saved = await f.request("PUT", policyPath, input);
      assert.equal(saved.status, protectedExecution ? 409 : 200, JSON.stringify(saved));
      if (protectedExecution) {
        assert.equal(saved.error.code, "SANDBOX_POLICY_PROTECTED_EXECUTION");
      }
      if (options.policyEdges) {
        const revisionId = revisions[0].id;
        await f.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(namespaceId, agent.id, undefined, revisionId),
        );
        if (options.installedProfile) {
          const gateway = f.controller.selectedDriver("credential_gateway");
          const catalog = await gateway.listSourceTypes({ signal: AbortSignal.timeout(1000) });
          // Withdrawal or lifecycle changes must revoke the ordinary-model exception,
          // even when the source identity and Harness authentication stay unchanged.
          for (const change of [
            undefined,
            { rotation: "refresh" },
            { deviceAuthorization: { harnessId: "codex" } },
          ]) {
            t.mock.method(gateway, "listSourceTypes", async () =>
              change === undefined
                ? catalog.filter((type) => type.type !== "openai")
                : catalog.map((type) => (type.type === "openai" ? { ...type, ...change } : type)),
            );
            const refused = await f.request("GET", policyPath);
            assert.equal(refused.status, 200, JSON.stringify(refused));
            assert.equal(refused.data.protectedExecution, true);
            const refusedInput = {
              expectedVersion: refused.data.policy.version,
              additions: [addition],
            };
            assert.equal(
              (await f.request("POST", `${policyPath}/validate`, refusedInput)).status,
              409,
            );
            assert.equal((await f.request("PUT", policyPath, refusedInput)).status, 409);
            const afterRefusal = await f.request("GET", policyPath);
            assert.equal(afterRefusal.status, 200, JSON.stringify(afterRefusal));
            assert.equal(afterRefusal.data.policy.version, refused.data.policy.version);
            assert.deepEqual(afterRefusal.data.policy, refused.data.policy);
            const redeploy = await f.request("POST", `${path}/deploy`);
            assert.equal(redeploy.status, 409, JSON.stringify(redeploy));
            if (change === undefined) {
              assert.match(redeploy.error.message, /type|offered/i);
            }
            const afterDeploy = await f.request("GET", `${path}/revisions`);
            assert.equal(afterDeploy.status, 200, JSON.stringify(afterDeploy));
            assert.deepEqual(afterDeploy.data, revisions);
          }
        }
      }
    }
  }
});

test("Git-only compatibility does not enroll plugin or OAuth refresh credentials", async (t) => {
  const f = await protectedOpenShellComposition(t, {
    installedProfile: "repository",
    credentialGateway: true,
    credentialRefresh: true,
    toolBinaries: ["/usr/bin/curl"],
  });
  const catalog = await f.controller.selectedDriver("credential_gateway").listSourceTypes({
    signal: AbortSignal.timeout(1000),
  });
  assert.ok(catalog.some(({ type }) => type === "bearer-token"));
  const oauth = catalog.find((type) => type.deviceAuthorization !== undefined);
  assert.ok(oauth);
  const visible = await f.request("GET", `/namespaces/${f.namespace.id}/agent-capabilities`);
  assert.equal(visible.status, 200);
  assert.equal(
    visible.data.capabilities.credentialSources.types.some(({ type }) => type === "bearer-token"),
    false,
  );
  assert.equal(
    visible.data.capabilities.credentialSources.types.some(({ type }) => type === oauth.type),
    false,
  );
  await f.state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
  );
  const secret = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
    name: "plugin-token",
    value: "synthetic-plugin-token",
  });
  assert.equal(secret.status, 201);
  const path = `/namespaces/${f.namespace.id}/credential-sources`;
  const refused = await f.request("POST", path, {
    name: "plugin",
    type: "bearer-token",
    config: { host: "plugin.example.test", env_var: "PLUGIN_TOKEN" },
    secrets: { token: secret.data.ref },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.match(refused.error.message, /cannot protect bearer-token sources/);
  const refreshRefused = await f.request("POST", path, {
    name: "oauth",
    type: oauth.type,
    config: {},
    secrets: {},
  });
  assert.equal(refreshRefused.status, 409, JSON.stringify(refreshRefused));
  assert.match(refreshRefused.error.message, /cannot preserve.*lifecycle/);
  t.mock.method(f.controller.selectedDriver("credential_gateway"), "listSourceTypes", async () =>
    catalog.map((type) =>
      type.type === "openai" ? { ...type, deviceAuthorization: { harnessId: "codex" } } : type,
    ),
  );
  const deviceCatalog = await f.request("GET", `/namespaces/${f.namespace.id}/agent-capabilities`);
  assert.equal(deviceCatalog.status, 200);
  assert.equal(
    deviceCatalog.data.capabilities.credentialSources.types.some((type) => type.type === "openai"),
    false,
  );
  const deviceRefused = await f.request("POST", path, {
    name: "model-device-login",
    type: "openai",
    secrets: { api_key: secret.data.ref },
  });
  assert.equal(deviceRefused.status, 409, JSON.stringify(deviceRefused));
  assert.match(deviceRefused.error.message, /cannot preserve.*lifecycle/);
  assert.equal(f.providers.size, 0);
  assert.deepEqual((await f.request("GET", path)).data, []);
});

test("full and unknown Proxy profiles never enroll ordinary sources through Gateway fallback", async (t) => {
  for (const [options, status] of [
    [{ installedProfile: "execution", advertised: true }, 409],
    [{ installedProfile: "execution", registered: false }, 409],
    [{}, 409],
    [{ registered: false }, 503],
    [{ advertised: true }, 503],
  ]) {
    const f = await protectedOpenShellComposition(t, { ...options, credentialGateway: true });
    await f.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
    );
    const secret = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
      name: "model-key",
      value: "synthetic-model-key",
    });
    assert.equal(secret.status, 201);
    const path = `/namespaces/${f.namespace.id}/credential-sources`;
    const result = await f.request("POST", path, {
      name: "ordinary-model",
      type: "openai",
      secrets: { api_key: secret.data.ref },
    });
    // The installed bundled provider is retired. Unknown compositions must still pass
    // protected admission (this fixture deliberately has no versioned Secret reader).
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(f.providers.size, 0);
    assert.deepEqual((await f.request("GET", path)).data, []);
    if (options.installedProfile) {
      assert.match(result.error.message, /retired new uses/);
      const listed = await f.request("GET", `/namespaces/${f.namespace.id}/agent-capabilities`);
      assert.equal(listed.status, 200);
      assert.equal(
        listed.data.capabilities.credentialSources.types.some(({ type }) => type === "openai"),
        false,
      );
    }
  }
});

test("runtime-authenticated Dedicated Codex requires a qualified Proxy without sources or repositories", async (t) => {
  for (const [label, options, status] of [
    ["qualified Proxy", { advertised: true }, 202],
    ["missing Proxy registration", { advertised: true, registered: false }, 503],
    ["Git-only Proxy", {}, 409],
    ["loaded execution Proxy", { installedProfile: "execution", advertised: true }, 202],
    [
      "loaded execution Proxy unavailable",
      { installedProfile: "execution", registered: false },
      503,
    ],
    ["loaded Git-only Proxy", { installedProfile: "repository" }, 409],
    [
      "loaded Git-only Proxy unavailable",
      { installedProfile: "repository", registered: false },
      503,
    ],
  ]) {
    await t.test(label, async (t) => {
      // Use shipped Compute authentication and execution admission, paired with the same
      // Namespace lifecycle binding. Gateway discovery is simulated; no cluster is started.
      const f = await protectedOpenShellComposition(t, {
        ...options,
        credentialGateway: options.installedProfile !== undefined,
        runtimeAuthCompute: true,
      });
      const compute = f.controller.selectedDriver("compute");
      assert.throws(
        () =>
          compute.validateExecutionAdmission(
            {
              executionAdmission: { version: 2, mode: "unprotected" },
              harnessAuth: { method: "runtime" },
              credentialSources: [],
            },
            "stored",
          ),
        /exact paired Compute release/,
      );
      const agent = await f.createAgent({
        executionMode: "dedicated",
        harnessAuth: { method: "runtime" },
        credentialSources: [],
        repositoryBindings: [],
      });
      await f.prepareDeployment(agent);
      const path = `${f.collection}/${agent.id}`;
      const deployed = await f.request("POST", `${path}/deploy`);
      assert.equal(deployed.status, status, JSON.stringify(deployed));
      const revisions = (await f.request("GET", `${path}/revisions`)).data;
      assert.equal(f.providers.size, 0, "no model provider is registered");
      assert.equal(f.gatewayReads(), 1, "empty plans still require Proxy availability");
      if (status !== 202) {
        assert.equal(
          deployed.error.message,
          status === 503
            ? PROXY_REGISTRATION_UNAVAILABLE
            : CredentialProxyRepositoryOnlyError.description,
        );
        assert.deepEqual(revisions, [], "refused deployment must not save a revision");
        return;
      }
      // A source-free runtime needs a protected plan but receives no inference or Git authority.
      assert.equal(revisions.length, 1);
      assert.equal(deployed.data.id, revisions[0].id);
      const revision = await f.state.transact((unit) =>
        unit.revisions.findRevision(f.namespace.id, agent.id, revisions[0].id),
      );
      assert.deepEqual(revision.executionAdmission, { version: 3, mode: "protected" });
      assert.deepEqual(revision.harnessAuth, { method: "runtime" });
      const plan = revision.egressPlan;
      assert.ok(plan);
      assert.deepEqual(plan.driver, f.protectedDriver.ref);
      assert.deepEqual(plan.routes, []);
      assert.equal(plan.repositoryGit, undefined);
      assert.equal(plan.harnessCredentialSource, undefined);
      assert.equal(revision.repositoryCredentials, undefined);
      const enrollment = harnessEgressEnrollment(plan);
      assert.equal(enrollment.routeCount, 0);
      assert.equal(enrollment.inference, false);
      compute.validateExecutionAdmission(revision, "stored");
    });
  }
});

test("explicit live adoption still requires a qualified Proxy", async (t) => {
  for (const [label, options, status, message] of [
    ["Git-only", {}, 409, CredentialProxyRepositoryOnlyError.description],
    ["missing registration", { registered: false }, 503, PROXY_REGISTRATION_UNAVAILABLE],
    ["wrong protocol", { extension: { protocol_major: 2 } }, 503, PROXY_REGISTRATION_UNAVAILABLE],
    [
      "partial capabilities",
      { extension: { required_capabilities: [...openShellExchangeCapabilities] } },
      503,
      PROXY_REGISTRATION_UNAVAILABLE,
    ],
  ]) {
    const f = await protectedOpenShellComposition(t, {
      ...options,
      credentialGateway: true,
      credentialProxy: false,
    });
    await f.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
    );
    const secret = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
      name: "model-key",
      value: "synthetic-model-key",
    });
    assert.equal(secret.status, 201, JSON.stringify(secret));
    const path = `/namespaces/${f.namespace.id}/credential-sources`;
    const source = await f.request("POST", path, {
      name: "model",
      type: "openai",
      secrets: { api_key: secret.data.ref },
    });
    assert.equal(source.status, 201, JSON.stringify(source));
    f.controller.selectDriver("credential_proxy", f.protectedDriver.require("credential_proxy").id);
    const adoption = await f.request("PATCH", `${path}/${source.data.id}`, {
      adoption: "live",
      authorityScope: "execution",
    });
    assert.equal(adoption.status, status, `${label}: ${JSON.stringify(adoption)}`);
    assert.equal(adoption.error.message, message, label);
    const unchanged = await f.request("GET", `${path}/${source.data.id}`);
    assert.equal(unchanged.data.egress, undefined);
    assert.equal(unchanged.data.status.state, "ready");
  }
});

// Runs one worker pass for a pending application whose provider write is refused by `apply`.
// `observe` answers the worker's provider reads, calls counted in `applied` for each write.
async function policyWorkerPass({
  apply,
  observe,
  heartbeat,
  signal = AbortSignal.timeout(5_000),
}) {
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
  let heartbeats = 0;
  const queue = {
    heartbeat: async (claim) => (heartbeat ? heartbeat(++heartbeats, claim) : claim),
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
  driver.observeNetworkPolicy = async () => observe(applied);
  driver.applyNetworkPolicy = async () => {
    applied++;
    throw apply();
  };
  let failure;
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
      signal,
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
  ).catch((error) => {
    failure = error;
  });
  return { applied, outcome, outcomes, policy, failure };
}

test("the policy worker fails a Driver's named policy refusal at once", async () => {
  // Finding 2144's live-application backstop: the OpenShell Driver refuses a Git route bypass
  // before updating the policy. A retry cannot change that, so the worker fails the application
  // as unsupported instead of retrying until it reports the outcome unconfirmed.
  const { applied, outcome, outcomes, policy } = await policyWorkerPass({
    apply: () =>
      new SandboxNetworkPolicyConflictError("remove network grant git-direct (github.com)."),
    observe: () => ({ resourceVersion: "1", policyVersion: "1", state: "applied", matches: false }),
  });
  assert.equal(applied, 1);
  assert.equal(outcome, "permanent");
  assert.deepEqual(outcomes, ["fail SANDBOX_POLICY_UNSUPPORTED"]);
  assert.equal(policy.application.state, "failed");
  assert.equal(policy.application.reason, "SANDBOX_POLICY_UNSUPPORTED");
});

test("the policy worker does not dispatch a write at a known stale provider version", async () => {
  const { applied, outcome, outcomes, policy } = await policyWorkerPass({
    apply: () => new Error("RESOURCE_VERSION_CONFLICT"),
    observe: () => ({ resourceVersion: "2", policyVersion: "1", state: "applied", matches: false }),
  });
  assert.equal(applied, 0, "a known stale CAS must not consume a provider mutation admission");
  assert.equal(outcome, "permanent");
  assert.deepEqual(outcomes, ["fail SANDBOX_POLICY_PROVIDER_FAILED"]);
  assert.equal(policy.application.reason, "SANDBOX_POLICY_PROVIDER_FAILED");
});

test("the policy worker fails a write when the provider moves after preflight", async () => {
  const { applied, outcome, outcomes, policy } = await policyWorkerPass({
    apply: () => new Error("RESOURCE_VERSION_CONFLICT"),
    observe: (writes) => ({
      resourceVersion: writes === 0 ? "1" : "2",
      policyVersion: "1",
      state: "applied",
      matches: false,
    }),
  });
  assert.equal(applied, 1);
  assert.equal(outcome, "permanent");
  assert.deepEqual(outcomes, ["fail SANDBOX_POLICY_PROVIDER_FAILED"]);
  assert.equal(policy.application.reason, "SANDBOX_POLICY_PROVIDER_FAILED");
});

test("the policy worker retries a refused write while the provider version is unchanged", async () => {
  // A transient refusal at the pinned version may still succeed later, so the worker retries.
  const { applied, outcome, outcomes, policy } = await policyWorkerPass({
    apply: () => new Error("gateway unavailable"),
    observe: () => ({ resourceVersion: "1", policyVersion: "1", state: "applied", matches: false }),
  });
  assert.equal(applied, 1);
  assert.equal(outcome, "retry");
  assert.deepEqual(outcomes, ["retry DEPENDENCY_UNAVAILABLE"]);
  assert.equal(policy.application.state, "pending");
});

test("the policy worker accepts a write that landed although the response failed", async () => {
  // The provider applied the policy but the response was lost. The worker confirms it from the
  // provider's own state, without a second write.
  const { applied, outcome, outcomes, policy } = await policyWorkerPass({
    apply: () => new Error("connection reset"),
    observe: (writes) => ({
      resourceVersion: writes === 0 ? "1" : "2",
      policyVersion: "2",
      state: "applied",
      matches: writes > 0,
    }),
  });
  assert.equal(applied, 1);
  assert.equal(outcome, "success");
  assert.deepEqual(outcomes, ["complete"]);
  assert.equal(policy.application.state, "applied");
});

test("the policy worker rolls back when shutdown interrupts the recovery read", async () => {
  // A replacement worker can still confirm the write, so the pass must not close the application.
  const shutdown = new AbortController();
  const { outcomes, policy, failure } = await policyWorkerPass({
    signal: shutdown.signal,
    apply: () => new Error("connection reset"),
    observe: (writes) => {
      if (writes === 0) {
        return { resourceVersion: "1", policyVersion: "1", state: "applied", matches: false };
      }
      shutdown.abort();
      throw new Error("read aborted");
    },
  });
  assert.equal(failure?.message, "read aborted");
  assert.deepEqual(outcomes, []);
  assert.equal(policy.application.state, "pending");
});

test("the policy worker rolls back when shutdown starts during a successful recovery read", async () => {
  const shutdown = new AbortController();
  const { outcomes, policy, failure } = await policyWorkerPass({
    signal: shutdown.signal,
    apply: () => new Error("connection reset"),
    observe: (writes) => {
      if (writes > 0) {
        shutdown.abort(new Error("worker stopped"));
      }
      return {
        resourceVersion: writes > 0 ? "2" : "1",
        policyVersion: "1",
        state: "applied",
        matches: false,
      };
    },
  });
  assert.equal(failure?.message, "worker stopped");
  assert.deepEqual(outcomes, []);
  assert.equal(policy.application.state, "pending");
});

test("the policy worker rolls back when its lease is lost after the recovery read", async () => {
  let observations = 0;
  const { outcomes, policy, failure } = await policyWorkerPass({
    apply: () => new Error("connection reset"),
    observe: (writes) => {
      observations++;
      return {
        resourceVersion: writes > 0 ? "2" : "1",
        policyVersion: "1",
        state: "applied",
        matches: false,
      };
    },
    heartbeat: (count, claim) => (count === 5 ? undefined : claim),
  });
  assert.equal(observations, 2, "the lease must be checked after the recovery observation");
  assert.ok(failure, "the pass must discard a recovery result when its lease is lost");
  assert.deepEqual(outcomes, []);
  assert.equal(policy.application.state, "pending");
});

test("the policy worker rolls back when shutdown starts during the recovery heartbeat", async () => {
  const shutdown = new AbortController();
  const { outcomes, policy, failure } = await policyWorkerPass({
    signal: shutdown.signal,
    apply: () => new Error("connection reset"),
    observe: (writes) => ({
      resourceVersion: writes > 0 ? "2" : "1",
      policyVersion: "1",
      state: "applied",
      matches: false,
    }),
    heartbeat: (count, claim) => {
      if (count === 5) {
        shutdown.abort(new Error("worker stopped during heartbeat"));
      }
      return claim;
    },
  });
  assert.equal(failure?.message, "worker stopped during heartbeat");
  assert.deepEqual(outcomes, []);
  assert.equal(policy.application.state, "pending");
});
