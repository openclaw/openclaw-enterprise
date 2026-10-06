import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  PRODUCTION_HARNESS_DESCRIPTOR,
  resolveApprovedHarness as resolveApprovedDevelopmentHarness,
} from "../../apps/controller/src/composition/production-harness.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NativeWorkerSupportError,
  OpenClawController,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { registerAndSelectDrivers } from "../helpers/development.mjs";
import { bindRole, permissionsFor } from "../helpers/iam-grants.mjs";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";

const installation = {
  id: "installation-a",
  name: "Enterprise installation",
  createdAt: "2026-08-15T00:00:00.000Z",
};
const iamStates = new WeakMap();

function createIAMDriver({ identities = [], roles = [], bindings = [], restrictions = [] } = {}) {
  const state = {
    identities: [
      {
        kind: "principal",
        id: "principal-admin",
        issuer: "https://identity.example.com",
        subject: "administrator",
      },
      {
        kind: "principal",
        id: "principal-unbound",
        issuer: "https://identity.example.com",
        subject: "unbound",
      },
      ...identities,
    ],
    groups: [],
    memberships: [],
    roles: [
      {
        id: "role-admin",
        permissions: permissionsFor({
          namespace: ["create", "read", "delete"],
          configuration: ["create", "read"],
          secret: ["create", "operate"],
          agent: ["create", "read", "update", "deploy", "operate"],
        }),
      },
      { id: "role-harness-secret", permissions: [{ action: "operate", resourceKind: "secret" }] },
      ...roles,
    ],
    bindings: [
      {
        id: "binding-admin",
        subjectKind: "identity",
        subjectId: "principal-admin",
        roleId: "role-admin",
      },
      ...bindings,
    ],
    restrictions,
  };
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => state },
    { id: "iam-native-a", implementation: "native" },
  );
  iamStates.set(iam, state);
  return iam;
}

function createDrivers(iam) {
  const calls = {
    ensureNamespace: 0,
    deleteNamespace: 0,
    prepareRevision: 0,
    stop: 0,
    retire: 0,
  };
  const compute = {
    id: "compute-driver-a",
    capability: "compute",
    implementation: "test-only-compute",
    // This passive lifecycle fixture admits synthetic API-key references, not provider login.
    validateHarnessAuth(harness, auth) {
      if (
        auth.method !== "api_key" ||
        !(
          (harness.id === "openclaw" &&
            (harness.mode === "embedded" || harness.mode === "dedicated")) ||
          (harness.id === "codex" && harness.mode === "dedicated")
        )
      ) {
        throw new ScopeViolationError("Unsupported lifecycle fixture authentication.");
      }
    },
    async ensureNamespace(namespace) {
      calls.ensureNamespace += 1;
      return {
        namespaceId: namespace.id,
        namespaceReady: true,
      };
    },
    async deleteNamespace(namespace) {
      calls.deleteNamespace += 1;
      return {
        namespaceId: namespace.id,
        namespaceDeleted: true,
      };
    },
    async prepareRevision(revision) {
      calls.prepareRevision += 1;
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async stopRevision() {
      calls.stop += 1;
    },
    async retireRevision() {
      calls.retire += 1;
    },
  };
  const configuration = createTestConfigurationDriver({ id: "configuration-driver-a" });
  return { iam, compute, configuration, calls };
}

function createSandboxDriver(options = {}) {
  return {
    id: options.id ?? "sandbox-driver-a",
    capability: "sandbox",
    implementation: options.implementation ?? "openshell",
    facets: options.facets ?? ["networking", "filesystem", "process"],
    ...(options.configureAgent === undefined ? {} : { configureAgent: options.configureAgent }),
    async provisionHarness(context) {
      return {
        namespaceName: context.namespace.name,
        resourceName: `sandbox-${context.revision.id}`,
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
      };
    },
    async cleanup() {},
  };
}

function createController(iam = createIAMDriver(), options = {}) {
  let nextIdentifier = 0;
  const controller = new OpenClawController(installation, {
    ...options,
    now: () => new Date("2026-08-15T00:00:00.000Z"),
    createId: (kind) =>
      kind === "configuration"
        ? `cfg_${randomUUID()}`
        : kind === "secret"
          ? `sec_${randomUUID()}`
          : kind === "namespace"
            ? `ns_00000000-0000-4000-8000-${String(++nextIdentifier).padStart(12, "0")}`
            : `${kind}-${++nextIdentifier}`,
  });
  const drivers = createDrivers(iam);
  registerAndSelectDrivers(controller, [
    drivers.iam,
    drivers.compute,
    drivers.configuration,
    createTestSecretDriver(),
  ]);
  return { controller, ...drivers };
}

async function bindHarnessAuth(controller, agent) {
  const secret = await controller.createSecret("principal-admin", {
    namespaceId: agent.namespaceId,
    name: `harness-key-${agent.id}`,
    value: "synthetic-lifecycle-key",
  });
  const iamState = iamStates.get(controller.selectedDriver("iam"));
  iamState.identities.push({
    kind: "service_principal",
    id: agent.servicePrincipalId,
    namespaceId: agent.namespaceId,
    agentId: agent.id,
  });
  bindRole(iamState, agent.servicePrincipalId, {
    id: `harness-secret-${agent.id}`,
    roleId: "role-harness-secret",
    namespaceId: agent.namespaceId,
    resource: { kind: "secret", id: secret.id },
  });
  await controller.updateAgent("principal-admin", {
    namespaceId: agent.namespaceId,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: secret.ref },
  });
}

async function createConfiguration(
  controller,
  namespaceId,
  values = {},
  principalId = "principal-admin",
) {
  return controller.createConfiguration(principalId, { namespaceId, kind: "agent", values });
}

test("Agent stop records an authorized Agent-scoped target without deleting its revision", async () => {
  const { controller } = createController();
  const namespace = await controller.createNamespace("principal-admin", { name: "Stop target" });
  await controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const configuration = await createConfiguration(controller, namespace.id, { model: "gpt-test" });
  const created = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Stoppable Agent",
    configurationId: configuration.id,
  });
  assert.equal(created.desiredRuntimeState, "stopped");
  await bindHarnessAuth(controller, created);
  const revision = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespace.id, agentId: created.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.equal(
    (await controller.getAgent("principal-admin", namespace.id, created.id)).desiredRuntimeState,
    "running",
  );

  const beforeDenial = controller.pendingOperations().length;
  await assert.rejects(
    controller.stopAgent("principal-unbound", namespace.id, created.id),
    AuthorizationDeniedError,
  );
  assert.equal(controller.pendingOperations().length, beforeDenial);

  const stopped = await controller.stopAgent("principal-admin", namespace.id, created.id);
  assert.equal(stopped.desiredRuntimeState, "stopped");
  assert.equal(
    (
      await controller.transact((state) => state.revisions.listRevisions(namespace.id, created.id))
    ).at(-1)?.id,
    revision.id,
  );
  const operation = controller.pendingOperations().at(-1);
  assert.equal(operation.kind, "agent");
  assert.equal(operation.resourceId, created.id);
  assert.equal(operation.target, "stopped");
  assert.equal(operation.actorId, "principal-admin");
  assert.match(operation.operationId, /^[0-9a-f-]{36}$/);
});

test("only the controller selects explicitly registered Drivers for each capability", () => {
  const { controller, iam, compute } = createController();

  assert.equal(controller.selectedDriver("iam"), iam);
  assert.equal(controller.selectedDriver("compute"), compute);

  assert.throws(() => {
    controller.selectDriver("compute", iam.id);
  }, DriverSelectionError);
  assert.throws(() => {
    controller.selectDriver("compute", "unregistered-compute");
  }, DriverSelectionError);

  assert.equal(controller.selectedDriver("iam"), iam);
  assert.equal(controller.selectedDriver("compute"), compute);

  const iamOnly = new OpenClawController(installation);
  iamOnly.registerDriver(iam);
  iamOnly.selectDriver("iam", iam.id);
  assert.throws(() => {
    iamOnly.selectedDriver("compute");
  }, DriverSelectionError);
});

test("the controller selects explicitly registered Sandbox Drivers with closed facet declarations", () => {
  const { controller } = createController();
  const sandbox = createSandboxDriver();
  controller.registerDriver(sandbox);
  controller.selectDriver("sandbox", sandbox.id);
  assert.equal(controller.selectedDriver("sandbox"), sandbox);

  // A containment-only provider needs neither namespace bootstrap nor workload provisioning.
  const containmentOnly = createSandboxDriver({ id: "containment-only" });
  delete containmentOnly.provisionHarness;
  controller.registerDriver(containmentOnly);

  for (const facets of [
    [],
    ["networking", "networking"],
    ["networking", "exec"],
    ["networking", ""],
  ]) {
    assert.throws(
      () => controller.registerDriver(createSandboxDriver({ id: String(facets), facets })),
      DriverSelectionError,
    );
  }
  assert.throws(
    () => controller.selectDriver("sandbox", "unregistered-sandbox"),
    DriverSelectionError,
  );
  assert.throws(
    () =>
      controller.registerDriver({
        ...createSandboxDriver({ id: "invalid-configure-agent" }),
        configureAgent: "invalid",
      }),
    DriverSelectionError,
  );
  for (const hook of ["ensureNamespace", "provisionHarness", "cleanup"]) {
    assert.throws(
      () =>
        controller.registerDriver({
          ...createSandboxDriver({ id: `invalid-${hook}` }),
          [hook]: "invalid",
        }),
      DriverSelectionError,
    );
  }
});

test("controller validates selected lifecycle hooks and registered Driver ownership", () => {
  for (const hooks of [
    null,
    [],
    {},
    { beforeWorkloadStart: "invalid" },
    { unsupported: async () => {} },
  ]) {
    const controller = new OpenClawController(installation);
    const configuration = createTestConfigurationDriver({ id: "configuration-invalid-hooks" });
    configuration.computeLifecycleHooks = hooks;

    assert.throws(() => controller.registerDriver(configuration), DriverSelectionError);
  }

  const controller = new OpenClawController(installation);
  const iam = createIAMDriver();
  const configuration = createTestConfigurationDriver({ id: "configuration-owned-hooks" });
  configuration.computeLifecycleHooks = { beforeWorkloadStart: async () => {} };
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  controller.registerDriver(configuration);
  controller.selectDriver("configuration", configuration.id);

  assert.throws(
    () =>
      controller.registerDriver({
        ...createTestConfigurationDriver({ id: configuration.id }),
        computeLifecycleHooks: { beforeWorkloadStart: async () => {} },
      }),
    DriverSelectionError,
  );
  assert.equal(controller.selectedDriver("configuration"), configuration);
});

test("lifecycle-owner selection fails atomically when compute cannot accept hooks", () => {
  const controller = new OpenClawController(installation);
  const iam = createIAMDriver();
  const { compute } = createDrivers(iam);
  const frozenCompute = Object.freeze(compute);
  const configuration = createTestConfigurationDriver({ id: "configuration-requires-hooks" });
  configuration.computeLifecycleHooks = { beforeWorkloadStart: async () => {} };

  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  controller.registerDriver(frozenCompute);
  controller.selectDriver("compute", frozenCompute.id);
  controller.registerDriver(configuration);

  // Existing frozen development drivers remain supported until an actual hook owner is selected.
  assert.throws(
    () => controller.selectDriver("configuration", configuration.id),
    DriverSelectionError,
  );
  assert.throws(() => controller.selectedDriver("configuration"), DriverSelectionError);
  assert.equal(controller.selectedDriver("compute"), frozenCompute);
  assert.equal(controller.selectedDriver("iam"), iam);
});

test("Installation ownership is server-selected, detached, and immutable", () => {
  const suppliedInstallation = { ...installation };
  const controller = new OpenClawController(suppliedInstallation);
  suppliedInstallation.id = "caller-selected-installation";

  assert.equal(controller.installation.id, installation.id);
  assert.equal(Object.isFrozen(controller.installation), true);
  assert.throws(() => {
    controller.installation.id = "mutated-installation";
  }, TypeError);
});

// Names the API's Name schema refuses but a length-and-blankness check accepts: a C1 control,
// line and paragraph separators, edge Unicode whitespace and a lone surrogate.
const namesOutsideTheNameRule = [
  "name\u0085x",
  "name\u2028x",
  "name\u2029x",
  "name\u00a0",
  "\u3000name",
  "name\ud800x",
];

test("a stored Installation or configured default Preset name follows the API Name rule", () => {
  // 200 code points with an interior NBSP is a valid Name.
  const longest = `name\u00a0${"😀".repeat(195)}`;
  assert.equal(
    new OpenClawController({ ...installation, name: longest }).installation.name,
    longest,
  );
  for (const name of namesOutsideTheNameRule) {
    assert.throws(
      () => new OpenClawController({ ...installation, name }),
      (error) =>
        error instanceof ScopeViolationError &&
        /^The stored Installation name breaks the Name rule: 1 to 200 characters/.test(
          error.message,
        ),
      JSON.stringify(name),
    );
    assert.throws(
      () =>
        new OpenClawController(installation, {
          defaultPresets: [{ name, template: { agent: {} } }],
        }),
      /Default Presets require distinct names that follow the Name rule: 1 to 200 characters/,
      JSON.stringify(name),
    );
  }
});

test("direct controller creates and renames apply the API Name rule", async () => {
  const { controller } = createController();
  const namespaceId = "ns_00000000-0000-4000-8000-000000000999";
  for (const name of namesOutsideTheNameRule) {
    const label = JSON.stringify(name);
    await assert.rejects(
      controller.createNamespace("principal-admin", { name }),
      {
        message: "The Namespace name is invalid.",
      },
      label,
    );
    await assert.rejects(
      controller.createAgent("principal-admin", { namespaceId, name, configurationId: "cfg_a" }),
      { message: "The Agent name is invalid." },
      label,
    );
    await assert.rejects(
      controller.provisionAgent("principal-admin", {
        namespaceId,
        requestId: "request-a",
        name,
        configuration: {},
      }),
      { message: "The Agent name is invalid." },
      label,
    );
    await assert.rejects(
      controller.createSecret("principal-admin", { namespaceId, name, value: "synthetic" }),
      { message: "The Secret name is invalid." },
      label,
    );
    await assert.rejects(
      controller.createPreset("principal-admin", { namespaceId, name, template: { agent: {} } }),
      { message: "The Preset name is invalid." },
      label,
    );
    await assert.rejects(
      controller.updatePreset("principal-admin", { namespaceId, presetId: "preset-a", name }),
      { message: "The Preset name is invalid." },
      label,
    );
    await assert.rejects(
      controller.createCredentialSource("principal-admin", { namespaceId, name, config: {} }),
      { message: "The credential source name is invalid." },
      label,
    );
    await assert.rejects(
      controller.createServiceAccount("principal-admin", { namespaceId, name }),
      { message: "The ServiceAccount name is invalid." },
      label,
    );
    await assert.rejects(
      controller.createIAMRole("principal-admin", {
        namespaceId,
        name,
        permissions: [{ action: "read", resourceKind: "agent" }],
      }),
      { message: "The IAM Role name is invalid." },
      label,
    );
  }
});

test("authorized resources retain exact Namespace ownership without metadata-only work", async () => {
  const { controller, calls } = createController();
  const namespace = await controller.createNamespace("principal-admin", {
    name: "Support namespace",
  });
  assert.equal(Object.hasOwn(namespace, "installationId"), false);
  assert.equal(namespace.status, "provisioning");

  const mutableConfiguration = { model: "gpt-test", tool: "lookup" };
  const configuration = await createConfiguration(controller, namespace.id, mutableConfiguration);
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Support agent",
    configurationId: configuration.id,
  });
  assert.equal(Object.hasOwn(agent, "installationId"), false);
  assert.equal(agent.namespaceId, namespace.id);
  assert.equal(agent.servicePrincipalId, `service-agent-${agent.id}`);
  assert.equal(Object.hasOwn(agent, "workloadIdentityId"), false);
  assert.deepEqual(
    controller.pendingOperations().map((operation) => operation.kind),
    ["namespace"],
    "Agent metadata creation does not require an infrastructure effect",
  );

  await controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  await bindHarnessAuth(controller, agent);
  const firstRevision = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.equal(Object.hasOwn(firstRevision, "installationId"), false);
  assert.equal(firstRevision.namespaceId, namespace.id);
  assert.equal(firstRevision.agentId, agent.id);
  assert.equal(firstRevision.revision, 1);
  assert.equal(firstRevision.configurationId, configuration.id);
  assert.equal(firstRevision.configurationKind, "agent");
  assert.equal(firstRevision.configurationGeneration, 1);
  assert.equal(firstRevision.servicePrincipalId, agent.servicePrincipalId);
  assert.equal(Object.hasOwn(firstRevision, "workloadIdentityId"), false);
  assert.equal(Object.isFrozen(firstRevision), true);
  assert.equal(Object.isFrozen(firstRevision.configuration), true);
  assert.deepEqual(
    firstRevision.configuration,
    admitLoggingConfiguration({ model: "gpt-test", tool: "lookup" }, "info"),
  );

  const nextConfiguration = await createConfiguration(controller, namespace.id, {
    model: "gpt-next",
  });
  await controller.updateAgent("principal-admin", {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: nextConfiguration.id,
  });
  const nextRevision = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.equal(nextRevision.revision, 2);
  assert.equal(nextRevision.configurationId, nextConfiguration.id);
  assert.equal(nextRevision.configurationKind, "agent");
  assert.equal(nextRevision.configurationGeneration, 1);
  assert.equal(nextRevision.servicePrincipalId, firstRevision.servicePrincipalId);
  assert.notEqual(nextRevision.id, firstRevision.id);

  const operations = controller.pendingOperations();
  assert.deepEqual(
    operations.map((operation) => operation.kind),
    ["namespace", "agent_revision", "agent_revision"],
  );
  for (const operation of operations) {
    assert.equal(operation.action, "reconcile");
    assert.equal(Object.hasOwn(operation, "installationId"), false);
    assert.equal(operation.actorId, "principal-admin");
    assert.equal(Object.isFrozen(operation), true);
  }

  assert.deepEqual(calls, {
    ensureNamespace: 0,
    deleteNamespace: 0,
    prepareRevision: 0,
    stop: 0,
    retire: 0,
  });
});

test("deployment fails closed when no Compute Driver is selected", async () => {
  const iam = createIAMDriver();
  const controller = new OpenClawController(installation);
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const configurationDriver = createTestConfigurationDriver();
  controller.registerDriver(configurationDriver);
  controller.selectDriver("configuration", configurationDriver.id);

  const namespace = await controller.createNamespace("principal-admin", {
    name: "Namespace without Compute",
  });
  const configuration = await createConfiguration(controller, namespace.id, {
    model: "local-codex",
  });
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Agent without Compute",
    configurationId: configuration.id,
  });
  await controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );

  await assert.rejects(
    controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    DependencyUnavailableError,
  );
  assert.equal(controller.pendingOperations().length, 1);
  assert.deepEqual(
    await controller.transact((state) => state.revisions.listRevisions(namespace.id, agent.id)),
    [],
  );
});

test("Agent configuration references stay mutable while deployment admits deeply immutable OpenClaw documents", async () => {
  const { controller, calls } = createController();
  const harness = { id: "openclaw", version: "1.0.0" };
  const namespace = await controller.createNamespace("principal-admin", {
    name: "Draft isolation namespace",
  });
  const initialValues = {
    models: {
      providers: {
        openai: {
          baseUrl: "https://initial.example/v1",
          apiKey: { source: "store", provider: "teamstore", id: "INITIAL_API_KEY" },
        },
      },
    },
  };
  const initialConfiguration = await createConfiguration(controller, namespace.id, initialValues);
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Editable agent",
    configurationId: initialConfiguration.id,
  });
  assert.equal(agent.configurationId, initialConfiguration.id);
  assert.equal(controller.pendingOperations().length, 1);

  await assert.rejects(
    controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    NamespaceNotReadyError,
  );
  assert.equal(controller.pendingOperations().length, 1);

  const savedValues = {
    models: {
      providers: {
        openai: {
          baseUrl: "https://saved.example/v1",
          apiKey: { source: "store", provider: "teamstore", id: "SAVED_API_KEY" },
        },
      },
    },
    plugins: {
      entries: { knowledge: { enabled: true, config: { labels: ["lookup", "search"] } } },
    },
  };
  const savedConfiguration = await createConfiguration(controller, namespace.id, savedValues);
  const updated = await controller.updateAgent("principal-admin", {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: savedConfiguration.id,
  });
  assert.equal(updated.configurationId, savedConfiguration.id);
  assert.equal(
    controller.pendingOperations().length,
    1,
    "configuration reference changes never enqueue Compute work",
  );

  await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
  await bindHarnessAuth(controller, updated);
  await assert.rejects(
    controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      () => undefined,
    ),
    DependencyUnavailableError,
  );
  assert.equal(controller.pendingOperations().length, 1);
  const first = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.equal(first.revision, 1);
  assert.equal(first.configurationId, savedConfiguration.id);
  assert.equal(first.configurationKind, "agent");
  assert.equal(first.configurationGeneration, 1);
  assert.equal(first.servicePrincipalId, agent.servicePrincipalId);
  assert.deepEqual(first.configuration, admitLoggingConfiguration(savedValues, "info"));
  assert.deepEqual(first.harness, { ...harness, mode: "embedded" });
  assert.deepEqual(first.compute, {
    id: "compute-driver-a",
    implementation: "test-only-compute",
  });
  assert.equal(Object.isFrozen(first.configuration.models), true);
  assert.equal(Object.isFrozen(first.configuration.models.providers.openai.apiKey), true);
  assert.equal(Object.isFrozen(first.configuration.plugins.entries.knowledge.config.labels), true);

  // Mutating caller-owned nested objects and arrays cannot rewrite the admitted workload identity.
  savedValues.models.providers.openai.apiKey.id = "MUTATED_AFTER_ADMISSION";
  savedValues.plugins.entries.knowledge.config.labels.push("unexpected");
  const expectedFirstConfiguration = {
    models: {
      providers: {
        openai: {
          baseUrl: "https://saved.example/v1",
          apiKey: { source: "store", provider: "teamstore", id: "SAVED_API_KEY" },
        },
      },
    },
    plugins: {
      entries: { knowledge: { enabled: true, config: { labels: ["lookup", "search"] } } },
    },
  };
  assert.deepEqual(
    first.configuration,
    admitLoggingConfiguration(expectedFirstConfiguration, "info"),
  );

  const replacementValues = {
    models: {
      providers: {
        openai: {
          baseUrl: "https://replacement.example/v1",
          apiKey: { source: "file", provider: "teamfile", id: "/backends/openai/apiKey" },
        },
      },
    },
    agents: { defaults: { sandbox: { mode: "all" } } },
  };
  const replacementConfiguration = await createConfiguration(
    controller,
    namespace.id,
    replacementValues,
  );
  await controller.updateAgent("principal-admin", {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: replacementConfiguration.id,
  });
  const second = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.equal(second.revision, 2);
  assert.equal(second.configurationId, replacementConfiguration.id);
  assert.equal(second.configurationKind, "agent");
  assert.equal(second.configurationGeneration, 1);
  assert.notEqual(second.id, first.id);
  assert.equal(second.servicePrincipalId, first.servicePrincipalId);
  assert.deepEqual(second.configuration, admitLoggingConfiguration(replacementValues, "info"));
  assert.deepEqual(
    first.configuration,
    admitLoggingConfiguration(expectedFirstConfiguration, "info"),
  );
  assert.deepEqual(
    controller.pendingOperations().map(({ kind }) => kind),
    ["namespace", "agent_revision", "agent_revision"],
  );
  assert.deepEqual(calls, {
    ensureNamespace: 1,
    deleteNamespace: 0,
    prepareRevision: 0,
    stop: 0,
    retire: 0,
  });
});

test("Sandbox admission applies provider-owned Agent configuration before freezing its revision", async () => {
  const { controller } = createController();
  const sandbox = createSandboxDriver({
    implementation: "custom-containment",
    configureAgent(configuration, harness) {
      assert.equal(Object.isFrozen(configuration), true);
      assert.equal(Object.isFrozen(configuration.plugins.entries.codex.config.appServer), true);
      assert.deepEqual(harness, {
        ...PRODUCTION_HARNESS_DESCRIPTOR,
        mode: "dedicated",
      });
      assert.equal(Object.isFrozen(harness), true);
      const configured = structuredClone(configuration);
      configured.plugins.entries.codex.enabled = true;
      configured.plugins.entries.codex.config.appServer.sandbox = "danger-full-access";
      return configured;
    },
  });
  controller.registerDriver(sandbox);
  controller.selectDriver("sandbox", sandbox.id);

  const namespace = await controller.createNamespace("principal-admin", {
    name: "OpenShell sandbox namespace",
  });
  await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
  const values = {
    agents: {
      defaults: {
        model: "codex/gpt-5.6-sol",
        models: { "codex/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
      },
    },
    plugins: {
      entries: {
        codex: {
          enabled: false,
          config: {
            appServer: { bind: "0.0.0.0", sandbox: "read-only" },
            preserved: true,
          },
        },
        search: { enabled: true, config: { regions: ["west"] } },
      },
    },
  };
  const configuration = await createConfiguration(controller, namespace.id, values);
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Dedicated OpenShell agent",
    configurationId: configuration.id,
    executionMode: "dedicated",
  });

  await bindHarnessAuth(controller, agent);
  const revision = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );

  assert.equal(revision.sandboxDriverId, sandbox.id);
  assert.deepEqual(revision.configuration.plugins.entries.search, values.plugins.entries.search);
  assert.deepEqual(revision.configuration.plugins.entries.codex, {
    enabled: true,
    config: {
      appServer: { bind: "0.0.0.0", sandbox: "danger-full-access" },
      preserved: true,
    },
  });
  assert.equal(Object.isFrozen(revision), true);
  assert.equal(values.plugins.entries.codex.enabled, false);
  assert.equal(values.plugins.entries.codex.config.appServer.sandbox, "read-only");
});

test("Sandbox Drivers without an Agent configuration hook preserve the admitted configuration", async () => {
  const { controller } = createController();
  const sandbox = createSandboxDriver();
  controller.registerDriver(sandbox);
  controller.selectDriver("sandbox", sandbox.id);

  const namespace = await controller.createNamespace("principal-admin", {
    name: "Sandbox without configuration overrides",
  });
  await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
  const values = {
    agents: {
      defaults: {
        model: "codex/gpt-5.6-sol",
        models: { "codex/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
      },
    },
    plugins: {
      entries: {
        codex: { enabled: true, config: { appServer: { sandbox: "read-only" } } },
      },
    },
  };
  const configuration = await createConfiguration(controller, namespace.id, values);
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Unmodified dedicated Agent",
    configurationId: configuration.id,
    executionMode: "dedicated",
  });

  await bindHarnessAuth(controller, agent);
  const revision = await controller.deployAgent(
    "principal-admin",
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );

  assert.deepEqual(revision.configuration, admitLoggingConfiguration(values, "info"));
  assert.equal(revision.configuration.plugins.entries.codex.config.appServer.sandbox, "read-only");
});

test("Sandbox admission rejects malformed provider configuration before creating a revision", async () => {
  const { controller } = createController();
  const sandbox = createSandboxDriver({
    implementation: "malformed-containment",
    configureAgent() {
      return null;
    },
  });
  controller.registerDriver(sandbox);
  controller.selectDriver("sandbox", sandbox.id);

  const namespace = await controller.createNamespace("principal-admin", {
    name: "Malformed Sandbox configuration",
  });
  await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
  const configuration = await createConfiguration(controller, namespace.id, {
    agents: { defaults: { model: "codex/gpt-5.6-sol" } },
  });
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Rejected dedicated Agent",
    configurationId: configuration.id,
    executionMode: "dedicated",
  });
  await bindHarnessAuth(controller, agent);

  await assert.rejects(
    controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    ScopeViolationError,
  );
  assert.deepEqual(
    await controller.transact((state) => state.revisions.listRevisions(namespace.id, agent.id)),
    [],
  );
});

for (const facets of [["networking"], ["filesystem"], ["process"], ["networking", "filesystem"]]) {
  test(`Sandbox admission accepts a dedicated Agent with facets ${facets.join(", ")}`, async () => {
    const { controller } = createController();
    const sandbox = createSandboxDriver({ facets });
    controller.registerDriver(sandbox);
    controller.selectDriver("sandbox", sandbox.id);
    const namespace = await controller.createNamespace("principal-admin", {
      name: `Sandbox facets ${facets.join(", ")}`,
    });
    await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
    const configuration = await createConfiguration(controller, namespace.id, {
      agents: {
        defaults: {
          model: "codex/gpt-5.6-sol",
          models: { "codex/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
        },
      },
    });
    const agent = await controller.createAgent("principal-admin", {
      namespaceId: namespace.id,
      name: "Dedicated Agent with optional containment facets",
      configurationId: configuration.id,
      executionMode: "dedicated",
    });

    // A provider's declared subset is sufficient to admit and persist a revision.
    await bindHarnessAuth(controller, agent);
    const revision = await controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
    assert.equal(revision.sandboxDriverId, sandbox.id);
    assert.deepEqual(
      await controller.transact((state) => state.revisions.listRevisions(namespace.id, agent.id)),
      [revision],
    );
  });
}

test("dedicated native OpenClaw requires native worker support and a full-facet provisioning Sandbox", async () => {
  for (const [name, sandbox, nativeWorkerSupport, refusal] of [
    ["pinned runtime", createSandboxDriver(), undefined, NativeWorkerSupportError],
    ["missing", undefined, "custom-image", DependencyUnavailableError],
    [
      "partial",
      createSandboxDriver({ facets: ["networking", "filesystem"] }),
      "custom-image",
      DependencyUnavailableError,
    ],
    ["complete", createSandboxDriver(), "custom-image", undefined],
  ]) {
    const { controller } = createController(
      undefined,
      nativeWorkerSupport === undefined ? {} : { nativeWorkerSupport },
    );
    if (sandbox !== undefined) {
      controller.registerDriver(sandbox);
      controller.selectDriver("sandbox", sandbox.id);
    }
    const namespace = await controller.createNamespace("principal-admin", {
      name: `Native sandbox ${name}`,
    });
    await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
    const configuration = await createConfiguration(controller, namespace.id, {
      agents: {
        defaults: {
          model: "openai/gpt-5",
          models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
        },
      },
    });
    const agent = await controller.createAgent("principal-admin", {
      namespaceId: namespace.id,
      name: `Dedicated native ${name}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
    });
    await bindHarnessAuth(controller, agent);

    const deployment = controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
    if (refusal === undefined) {
      const revision = await deployment;
      assert.equal(revision.harness.id, "openclaw");
      assert.equal(revision.sandboxDriverId, sandbox.id);
    } else {
      await assert.rejects(deployment, refusal, name);
      assert.deepEqual(
        await controller.transact((state) => state.revisions.listRevisions(namespace.id, agent.id)),
        [],
      );
    }
  }
});

async function createDedicatedNativeAgentWithUngrantedSecret(controller, name) {
  const namespace = await controller.createNamespace("principal-admin", { name });
  await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
  const configuration = await createConfiguration(controller, namespace.id, {
    agents: {
      defaults: {
        model: "openai/gpt-5",
        models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
      },
    },
  });
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name,
    configurationId: configuration.id,
    executionMode: "dedicated",
  });
  // Bind a Harness Secret without granting the Agent service principal operate on it.
  const secret = await controller.createSecret("principal-admin", {
    namespaceId: namespace.id,
    name: `harness-key-${agent.id}`,
    value: "synthetic-lifecycle-key",
  });
  await controller.updateAgent("principal-admin", {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  return { namespace, agent, secret };
}

test("dedicated native OpenClaw reports missing native worker support before Agent principal grants", async () => {
  const { controller } = createController();
  const sandbox = createSandboxDriver();
  controller.registerDriver(sandbox);
  controller.selectDriver("sandbox", sandbox.id);
  const { namespace, agent } = await createDedicatedNativeAgentWithUngrantedSecret(
    controller,
    "Unsupported native before grants",
  );

  // Granting the Agent principal would not make this deployable, so the capability refusal wins.
  await assert.rejects(
    controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    NativeWorkerSupportError,
  );
  assert.deepEqual(
    await controller.transact((state) => state.revisions.listRevisions(namespace.id, agent.id)),
    [],
  );
});

test("deploy names the Agent service principal and the permission it lacks", async () => {
  const { controller } = createController(undefined, { nativeWorkerSupport: "custom-image" });
  const sandbox = createSandboxDriver();
  controller.registerDriver(sandbox);
  controller.selectDriver("sandbox", sandbox.id);
  const { namespace, agent, secret } = await createDedicatedNativeAgentWithUngrantedSecret(
    controller,
    "Ungranted Agent principal",
  );

  let refusal;
  await assert.rejects(
    controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    (error) => {
      refusal = error;
      return error instanceof AgentPrincipalAuthorizationError;
    },
  );
  assert.ok(refusal instanceof AuthorizationDeniedError);
  assert.equal(refusal.principalId, agent.servicePrincipalId);
  assert.deepEqual(refusal.authorization, {
    action: "operate",
    resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
  });
  const failure = requestFailure(refusal);
  assert.equal(failure.status, 403);
  assert.equal(failure.code, "FORBIDDEN");
  assert.match(failure.message, new RegExp(agent.servicePrincipalId));
  assert.match(failure.message, /operate/);
  assert.match(failure.message, new RegExp(`secret ${secret.id}`));

  // Caller denials keep the generic message so they do not disclose resource details.
  assert.equal(
    requestFailure(new AuthorizationDeniedError("denied")).message,
    "The exact platform operation was not authorized.",
  );
  assert.deepEqual(
    await controller.transact((state) => state.revisions.listRevisions(namespace.id, agent.id)),
    [],
  );
});

test("selected Sandbox Drivers fail closed for embedded Agents regardless of declared facets", async () => {
  for (const sandbox of [
    createSandboxDriver(),
    createSandboxDriver({ id: "partial-sandbox", facets: ["networking"] }),
  ]) {
    const { controller } = createController();
    controller.registerDriver(sandbox);
    controller.selectDriver("sandbox", sandbox.id);
    const namespace = await controller.createNamespace("principal-admin", {
      name: `Sandbox rejection ${sandbox.id}`,
    });
    await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
    const configuration = await createConfiguration(controller, namespace.id, {
      agents: { defaults: { model: "openclaw/local" } },
    });
    const agent = await controller.createAgent("principal-admin", {
      namespaceId: namespace.id,
      name: `Rejected ${sandbox.id}`,
      configurationId: configuration.id,
      executionMode: "embedded",
    });

    await assert.rejects(
      controller.deployAgent(
        "principal-admin",
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      ScopeViolationError,
    );
    assert.deepEqual(
      await controller.transact((state) => state.revisions.listRevisions(namespace.id, agent.id)),
      [],
    );
  }
});

test("configuration updates and admission reject unauthorized or foreign exact Agents without side effects", async () => {
  const { controller } = createController();
  const namespace = await controller.createNamespace("principal-admin", {
    name: "Protected configurations",
  });
  const configuration = await createConfiguration(controller, namespace.id, { model: "original" });
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Protected agent",
    configurationId: configuration.id,
  });
  const operationCount = controller.pendingOperations().length;

  await assert.rejects(
    controller.updateAgent("principal-unbound", {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: configuration.id,
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.updateAgent("principal-admin", {
      namespaceId: "namespace-foreign",
      agentId: agent.id,
      configurationId: configuration.id,
    }),
    ScopeViolationError,
  );
  await assert.rejects(
    controller.deployAgent(
      "principal-unbound",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    AuthorizationDeniedError,
  );

  const persisted = await controller.transact((state) =>
    state.agents.findAgent(namespace.id, agent.id),
  );
  assert.equal(persisted.configurationId, configuration.id);
  assert.equal(controller.pendingOperations().length, operationCount);
});

test("the one-shot lifecycle harness gates deployment and tombstones an empty Namespace", async () => {
  const { controller, calls } = createController();
  const namespace = await controller.createNamespace("principal-admin", { name: "Tenant A" });
  const configuration = await createConfiguration(controller, namespace.id);
  const agent = await controller.createAgent("principal-admin", {
    namespaceId: namespace.id,
    name: "Tenant A agent",
    configurationId: configuration.id,
  });

  await assert.rejects(
    controller.deployAgent(
      "principal-admin",
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    NamespaceNotReadyError,
  );
  const ready = await controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready");
  assert.equal(ready?.status, "ready");
  await bindHarnessAuth(controller, agent);
  assert.equal(
    (
      await controller.deployAgent(
        "principal-admin",
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      )
    ).agentId,
    agent.id,
  );
  assert.equal(calls.ensureNamespace, 1);

  const alreadyReady = await controller.handleNamespaceLifecycle(
    "principal-admin",
    namespace.id,
    "ready",
  );
  assert.equal(alreadyReady?.status, "ready");
  assert.equal(calls.ensureNamespace, 1, "a terminal target must not invoke Compute twice");

  await assert.rejects(
    controller.deleteNamespace("principal-admin", namespace.id),
    NamespaceNotEmptyError,
  );

  const empty = await controller.createNamespace("principal-admin", { name: "Empty tenant" });
  assert.equal(
    (await controller.handleNamespaceLifecycle("principal-admin", empty.id, "ready"))?.status,
    "ready",
  );
  const deleting = await controller.deleteNamespace("principal-admin", empty.id);
  assert.equal(deleting.status, "deleting");
  assert.equal((await controller.getNamespace("principal-admin", empty.id)).status, "deleting");
  assert.equal(
    controller
      .pendingOperations()
      .find((operation) => operation.resourceId === empty.id && operation.target === "deleted")
      ?.target,
    "deleted",
  );

  const staleEnsure = await controller.handleNamespaceLifecycle(
    "principal-admin",
    empty.id,
    "ready",
  );
  assert.equal(staleEnsure?.status, "deleting");
  assert.equal(calls.deleteNamespace, 0, "stale ensure work must never become teardown work");

  const deleted = await controller.handleNamespaceLifecycle("principal-admin", empty.id, "deleted");
  assert.equal(deleted?.status, "deleting");
  assert.equal(calls.deleteNamespace, 1);
  await assert.rejects(controller.getNamespace("principal-admin", empty.id), ScopeViolationError);
  assert.deepEqual(
    (await controller.listNamespaces("principal-admin")).map(({ id }) => id),
    [namespace.id],
  );

  const lifecycleAudits = await controller.transact((state) => state.audit.list());
  assert.ok(
    lifecycleAudits.some(
      (event) =>
        event.action === "openclaw.namespaces.lifecycle.ensure" &&
        event.actorId === "principal-admin" &&
        event.iamDriverId === "iam-native-a" &&
        event.details?.computeDriverId === "compute-driver-a",
    ),
  );
});

test("incomplete and permanent lifecycle results preserve fail-closed Namespace status", async () => {
  const { controller, compute } = createController();
  const retrying = await controller.createNamespace("principal-admin", { name: "Retrying" });
  compute.ensureNamespace = async (namespace) => ({
    namespaceId: namespace.id,
    namespaceReady: false,
    failure: "retryable",
  });
  assert.equal(
    (await controller.handleNamespaceLifecycle("principal-admin", retrying.id, "ready"))?.status,
    "provisioning",
  );

  compute.ensureNamespace = async (namespace) => ({
    namespaceId: namespace.id,
    namespaceReady: false,
    failure: "permanent",
  });
  assert.equal(
    (await controller.handleNamespaceLifecycle("principal-admin", retrying.id, "ready"))?.status,
    "failed",
  );

  const invalid = await controller.createNamespace("principal-admin", { name: "Invalid result" });
  compute.ensureNamespace = async (namespace) => ({
    namespaceId: "namespace-foreign",
    namespaceReady: true,
  });
  await assert.rejects(
    controller.handleNamespaceLifecycle("principal-admin", invalid.id, "ready"),
    DependencyUnavailableError,
  );
  assert.equal(
    (await controller.getNamespace("principal-admin", invalid.id)).status,
    "provisioning",
  );
});

test("a missing selected Compute Driver fails closed with attributable lifecycle audit", async () => {
  const iam = createIAMDriver();
  const controller = new OpenClawController(installation);
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const namespace = await controller.createNamespace("principal-admin", { name: "No compute" });

  await assert.rejects(
    controller.handleNamespaceLifecycle("principal-admin", namespace.id, "ready"),
    DependencyUnavailableError,
  );
  assert.equal(
    (await controller.getNamespace("principal-admin", namespace.id)).status,
    "provisioning",
  );
  const audit = (await controller.transact((state) => state.audit.list())).at(-1);
  assert.equal(audit.actorId, "principal-admin");
  assert.equal(audit.iamDriverId, iam.id);
  assert.equal(audit.outcome, "failure");
  assert.equal(audit.details.failure, "compute_driver_unavailable");
});

test("denied or cross-Namespace mutations never write resources or queue Driver work", async () => {
  const { controller, calls } = createController();

  await assert.rejects(
    controller.createNamespace("principal-unknown", { name: "Unknown tenant" }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.createNamespace("principal-unbound", { name: "Ungranted tenant" }),
    AuthorizationDeniedError,
  );
  assert.deepEqual(controller.pendingOperations(), []);

  const namespace = await controller.createNamespace("principal-admin", { name: "Tenant A" });
  const configuration = await createConfiguration(controller, namespace.id);
  const expectedOperationCount = controller.pendingOperations().length;

  await assert.rejects(
    controller.createAgent("principal-admin", {
      namespaceId: "namespace-foreign",
      name: "Cross-namespace agent",
      configurationId: configuration.id,
    }),
    ScopeViolationError,
  );
  await assert.rejects(
    controller.createAgent("principal-unbound", {
      namespaceId: namespace.id,
      name: "Ungranted agent",
      configurationId: configuration.id,
    }),
    AuthorizationDeniedError,
  );

  assert.equal(controller.pendingOperations().length, expectedOperationCount);
  assert.deepEqual(calls, {
    ensureNamespace: 0,
    deleteNamespace: 0,
    prepareRevision: 0,
    stop: 0,
    retire: 0,
  });
});

test("the controller fails closed until an authoritative IAM Driver is selected", async () => {
  const controller = new OpenClawController(installation);
  await assert.rejects(
    controller.createNamespace("principal-admin", { name: "Unconfigured authority" }),
    AuthorizationDeniedError,
  );
  assert.deepEqual(controller.pendingOperations(), []);
});

test("an authorization callback cannot bypass the selected IAM Driver", async () => {
  const controller = new OpenClawController(installation, {
    // Well-formed apart from naming another Driver, so only the Driver check refuses it.
    authorize: async () => ({
      allowed: true,
      reason: "An untrusted callback attempted to grant access.",
      driverId: "unregistered-iam",
      evidence: { groupIds: [], bindingIds: [], roleIds: [], restrictionIds: [] },
    }),
  });

  await assert.rejects(
    controller.createNamespace("principal-unknown", { name: "Unauthorized namespace" }),
    AuthorizationDeniedError,
  );
  assert.deepEqual(controller.pendingOperations(), []);

  const iam = createIAMDriver();
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);

  await assert.rejects(controller.createNamespace("principal-admin", { name: "Wrong authority" }), {
    name: "DependencyUnavailableError",
    message: /belongs to another Driver/,
  });
  assert.deepEqual(controller.pendingOperations(), []);
});

test("two Namespace tenants cannot create or deploy each other's Agents", async () => {
  const tenantRole = {
    id: "role-tenant-b",
    namespaceId: "ns_00000000-0000-4000-8000-000000000002",
    permissions: [
      { action: "operate", resourceKind: "secret" },
      { action: "create", resourceKind: "configuration" },
      { action: "read", resourceKind: "configuration" },
      { action: "create", resourceKind: "agent" },
      { action: "deploy", resourceKind: "agent" },
    ],
  };
  const tenantBinding = {
    id: "binding-tenant-b",
    namespaceId: tenantRole.namespaceId,
    subjectKind: "identity",
    subjectId: "principal-tenant-b",
    roleId: tenantRole.id,
  };
  const iam = createIAMDriver({
    identities: [
      {
        kind: "principal",
        id: "principal-tenant-b",
        issuer: "https://identity.example.com",
        subject: "tenant-b",
      },
    ],
    roles: [tenantRole],
    bindings: [tenantBinding],
  });
  const { controller, calls } = createController(iam);
  const namespaceA = await controller.createNamespace("principal-admin", { name: "Tenant A" });
  const namespaceB = await controller.createNamespace("principal-admin", { name: "Tenant B" });
  assert.equal(namespaceB.id, tenantRole.namespaceId);

  const configurationA = await createConfiguration(controller, namespaceA.id);
  const configurationB = await createConfiguration(
    controller,
    namespaceB.id,
    { model: "tenant-b-model" },
    "principal-tenant-b",
  );
  const agentA = await controller.createAgent("principal-admin", {
    namespaceId: namespaceA.id,
    name: "Tenant A agent",
    configurationId: configurationA.id,
  });
  const beforeDeniedMutation = controller.pendingOperations().length;
  await assert.rejects(
    controller.createAgent("principal-tenant-b", {
      namespaceId: namespaceA.id,
      name: "Unauthorized tenant A agent",
      configurationId: configurationA.id,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(controller.pendingOperations().length, beforeDeniedMutation);

  const agentB = await controller.createAgent("principal-tenant-b", {
    namespaceId: namespaceB.id,
    name: "Tenant B agent",
    configurationId: configurationB.id,
  });
  assert.notEqual(
    agentA.servicePrincipalId,
    agentB.servicePrincipalId,
    "Agents in different Namespaces must never share a platform principal",
  );
  await controller.transact((state) =>
    state.namespaces.transitionNamespaceStatus(namespaceB.id, "provisioning", "ready"),
  );
  await bindHarnessAuth(controller, agentB);
  const revisionB = await controller.deployAgent(
    "principal-tenant-b",
    { namespaceId: namespaceB.id, agentId: agentB.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.equal(revisionB.namespaceId, namespaceB.id);
  assert.equal(revisionB.servicePrincipalId, agentB.servicePrincipalId);

  const beforeCrossTenantDeploy = controller.pendingOperations().length;
  await assert.rejects(
    controller.deployAgent(
      "principal-tenant-b",
      { namespaceId: namespaceB.id, agentId: agentA.id },
      resolveApprovedDevelopmentHarness,
    ),
    ScopeViolationError,
  );
  assert.equal(controller.pendingOperations().length, beforeCrossTenantDeploy);
  assert.deepEqual(calls, {
    ensureNamespace: 0,
    deleteNamespace: 0,
    prepareRevision: 0,
    stop: 0,
    retire: 0,
  });
});
