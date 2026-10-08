import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  InMemoryPlatformState,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
  HarnessAuthSecretDriverError,
  ProvisioningSecretDriverError,
  SecretBindingDriverError,
  SecretDriverOwnershipError,
  SecretStorageDriverError,
  SecretValueError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import {
  createDevelopmentComputeDriver,
  registerAndSelectDrivers,
} from "../helpers/development.mjs";
import { bindRole, grantRole, principalIAMState } from "../helpers/iam-grants.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const administrator = "principal-secret-administrator";
const deployer = "principal-secret-deployer";
const noSecretOperator = "principal-secret-without-operate";
const secretConsumer = "principal-secret-consumer";
const metadataReader = "principal-secret-metadata-reader";
const zeroGrant = "principal-secret-zero-grant";
const installation = Object.freeze({
  id: "installation-secret-occ",
  name: "Secret OCC conformance",
  createdAt: "2026-08-28T00:00:00.000Z",
});

function configurationValues() {
  return {
    secrets: {
      providers: { model: { source: "env", allowlist: ["GATEWAY_TOOL_TOKEN"] } },
    },
  };
}

function adminPermissions() {
  return {
    namespace: ["create", "read", "delete"],
    configuration: ["create", "read", "update", "delete"],
    secret: ["create", "read", "update", "delete", "operate"],
    agent: ["create", "read", "update", "deploy", "operate"],
    agent_revision: ["read"],
  };
}

async function fixture(options = {}) {
  const iamState = principalIAMState(
    [administrator, deployer, noSecretOperator, secretConsumer, metadataReader, zeroGrant],
    "secret-occ-conformance",
  );
  const grant = (subjectId, name, permissions, bindingName = name) =>
    grantRole(iamState, subjectId, {
      id: `secret-occ-${name}-role`,
      bindingId: `secret-occ-${bindingName}-binding`,
      permissions,
    });
  grant(administrator, "administrator", adminPermissions());
  grant(deployer, "deployer", {
    namespace: ["read"],
    configuration: ["read"],
    agent: ["read", "deploy"],
    secret: ["operate"],
    agent_revision: ["read"],
  });
  grant(noSecretOperator, "no-secret", {
    namespace: ["read"],
    configuration: ["read"],
    agent: ["read", "deploy"],
    agent_revision: ["read"],
  });
  grant(secretConsumer, "agent-secret", { secret: ["operate"] }, "secret-consumer");
  grant(metadataReader, "metadata-reader", {
    namespace: ["read"],
    configuration: ["create", "read", "update"],
    agent: ["create", "read", "update"],
    secret: ["read"],
  });
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "secret-occ-iam" },
  );
  const state = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, { state });
  const compute =
    options.computeOverrides === undefined
      ? createDevelopmentComputeDriver({ id: "secret-occ-compute" })
      : Object.freeze({ ...createDevelopmentComputeDriver(), ...options.computeOverrides });
  const configurationDriver = createTestConfigurationDriver({ id: "secret-occ-configuration" });
  const secretDriver = options.secretDriver ?? createTestSecretDriver();

  registerAndSelectDrivers(controller, [iam, compute, configurationDriver, secretDriver]);

  const namespace = await controller.createNamespace(administrator, {
    name: options.namespaceName ?? "Secret OCC tenant",
  });
  const baseConfiguration = options.skipAgent
    ? undefined
    : await controller.createConfiguration(administrator, {
        namespaceId: namespace.id,
        kind: "agent",
        values: {},
      });
  const agent =
    baseConfiguration === undefined
      ? undefined
      : await controller.createAgent(administrator, {
          namespaceId: namespace.id,
          name: "Secret owner agent",
          configurationId: baseConfiguration.id,
        });

  async function makeReady() {
    await controller.transact((transaction) =>
      transaction.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
    );
    if (agent) {
      const modelSecret = await controller.createSecret(administrator, {
        namespaceId: namespace.id,
        name: "fixture-harness-key",
        value: "synthetic-harness-key",
      });
      grantAgentSecretOperate(agent, modelSecret);
      bindRole(iamState, noSecretOperator, {
        id: "fixture-harness-consumer",
        roleId: "secret-occ-agent-secret-role",
        namespaceId: namespace.id,
        resource: { kind: "secret", id: modelSecret.id },
      });
      await controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      });
    }
  }

  function grantAgentSecretOperate(targetAgent, secret) {
    if (!iamState.identities.some(({ id }) => id === targetAgent.servicePrincipalId)) {
      iamState.identities.push({
        kind: "service_principal",
        id: targetAgent.servicePrincipalId,
        namespaceId: targetAgent.namespaceId,
        agentId: targetAgent.id,
      });
    }
    bindRole(iamState, targetAgent.servicePrincipalId, {
      id: `secret-occ-agent-binding-${targetAgent.id}-${secret.id}`,
      roleId: "secret-occ-agent-secret-role",
      namespaceId: targetAgent.namespaceId,
      resource: { kind: "secret", id: secret.id },
    });
  }

  return {
    agent,
    baseConfiguration,
    configurationDriver,
    controller,
    grantAgentSecretOperate,
    iamState,
    makeReady,
    namespace,
    secretDriver,
    state,
  };
}

test("Secret storage requires a ready Namespace and no Agent owner before any gateway deployment", async () => {
  const { controller, makeReady, namespace, secretDriver } = await fixture({ skipAgent: true });

  // Secret material can be stored only after Compute has made the Namespace ready.
  await assert.rejects(
    controller.createSecret(administrator, {
      namespaceId: namespace.id,
      name: "model-key-before-ready",
      value: "sk-test-before-ready",
    }),
    NamespaceNotReadyError,
  );
  assert.equal(secretDriver.calls.length, 0);

  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-original",
  });

  assert.deepEqual(Object.keys(secret).sort(), ["id", "name", "namespaceId", "ref"]);
  assert.deepEqual(secret.ref, { kind: "secret", namespaceId: namespace.id, id: secret.id });
  assert.equal(secretDriver.valueFor(secret), "sk-test-original");
  assert.deepEqual(await controller.readSecret(administrator, namespace.id, secret.id), {
    ...secret,
    consumers: {
      agents: [],
      configurations: [],
      credentialSources: [],
      provisioningRequests: [],
      unreadable: 0,
      truncated: false,
    },
  });
  assert.equal(JSON.stringify(secret).includes("sk-test-original"), false);
});

test("Secret bindings freeze public refs in revisions while value-only updates keep bindings unchanged", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace, secretDriver } =
    await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-v1",
  });
  grantAgentSecretOperate(agent, secret);
  const secretBindings = {
    GATEWAY_TOOL_TOKEN: { source: secret.ref },
  };
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings,
  });
  assert.deepEqual(configuration.secretBindings, {
    GATEWAY_TOOL_TOKEN: { source: secret.ref, delivery: { type: "env" } },
  });
  const preserved = await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: { ...configurationValues(), marker: "preserved" },
  });
  assert.deepEqual(preserved.secretBindings, configuration.secretBindings);
  const cleared = await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: { ...configurationValues(), marker: "cleared" },
    secretBindings: {},
  });
  assert.equal(cleared.secretBindings, undefined);
  const restored = await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: configurationValues(),
    secretBindings,
  });
  assert.deepEqual(restored.secretBindings, configuration.secretBindings);
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
  });
  const first = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );

  const updated = await controller.updateSecret(administrator, {
    namespaceId: namespace.id,
    secretId: secret.id,
    value: "sk-test-v2",
  });
  const second = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );

  assert.deepEqual(updated, secret);
  assert.equal(secretDriver.valueFor(secret), "sk-test-v2");
  assert.equal(first.secretDriverId, secretDriver.id);
  assert.equal(second.secretDriverId, secretDriver.id);
  assert.deepEqual(first.secretBindings, {
    GATEWAY_TOOL_TOKEN: { source: secret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(second.secretBindings, first.secretBindings);
  assert.equal(first.configurationGeneration, restored.generation);
  assert.equal(second.configurationGeneration, restored.generation);
  assert.equal(JSON.stringify([first, second]).includes("sk-test-v"), false);
  assert.equal(secretDriver.calls.filter(({ operation }) => operation === "update").length, 1);
});

test("Secret bindings can be shared inside a Namespace and still deny cross-Namespace refs", async () => {
  const { agent, controller, makeReady, namespace } = await fixture();
  await makeReady();
  const siblingConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  const sibling = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "Sibling agent",
    configurationId: siblingConfiguration.id,
  });
  const ownerSecret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "owner-model-key",
    value: "sk-test-owner",
  });
  const siblingSecret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "sibling-model-key",
    value: "sk-test-sibling",
  });

  const sharedConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: ownerSecret.ref } },
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: sibling.id,
    configurationId: sharedConfiguration.id,
  });

  const mixedConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: {
      GATEWAY_TOOL_TOKEN: { source: ownerSecret.ref },
      MODEL_FALLBACK_KEY: { source: siblingSecret.ref },
    },
  });
  assert.deepEqual(mixedConfiguration.secretBindings, {
    GATEWAY_TOOL_TOKEN: { source: ownerSecret.ref, delivery: { type: "env" } },
    MODEL_FALLBACK_KEY: { source: siblingSecret.ref, delivery: { type: "env" } },
  });

  const foreign = await fixture({ namespaceName: "Foreign secret tenant" });
  await foreign.makeReady();
  const foreignSecret = await foreign.controller.createSecret(administrator, {
    namespaceId: foreign.namespace.id,
    name: "foreign-model-key",
    value: "sk-test-foreign",
  });
  await assert.rejects(
    controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: configurationValues(),
      secretBindings: { GATEWAY_TOOL_TOKEN: { source: foreignSecret.ref } },
    }),
    ScopeViolationError,
  );

  const assignedConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "Configuration holder",
    configurationId: assignedConfiguration.id,
  });
  const updatedAssigned = await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: assignedConfiguration.id,
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: ownerSecret.ref } },
  });
  assert.deepEqual(updatedAssigned.secretBindings, {
    GATEWAY_TOOL_TOKEN: { source: ownerSecret.ref, delivery: { type: "env" } },
  });
});

test("Secret material, metadata, and binding permissions stay separate", async () => {
  const { agent, controller, makeReady, namespace } = await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "permission-boundary-key",
    value: "sk-test-boundary",
  });

  await assert.rejects(
    controller.updateSecret(secretConsumer, {
      namespaceId: namespace.id,
      secretId: secret.id,
      value: "sk-test-denied-update",
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.deleteSecret(secretConsumer, namespace.id, secret.id),
    AuthorizationDeniedError,
  );
  assert.deepEqual(await controller.readSecret(metadataReader, namespace.id, secret.id), {
    ...secret,
    consumers: {
      agents: [],
      configurations: [],
      credentialSources: [],
      provisioningRequests: [],
      unreadable: 0,
      truncated: false,
    },
  });

  const secretBindings = { GATEWAY_TOOL_TOKEN: { source: secret.ref } };
  await assert.rejects(
    controller.createConfiguration(metadataReader, {
      namespaceId: namespace.id,
      kind: "agent",
      values: configurationValues(),
      secretBindings,
    }),
    AuthorizationDeniedError,
  );

  const retainedBindings = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings,
  });
  await assert.rejects(
    controller.updateConfiguration(metadataReader, {
      namespaceId: namespace.id,
      configurationId: retainedBindings.id,
      values: { ...configurationValues(), marker: "retained-bindings" },
    }),
    AuthorizationDeniedError,
  );

  const unboundConfiguration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  await assert.rejects(
    controller.updateConfiguration(metadataReader, {
      namespaceId: namespace.id,
      configurationId: unboundConfiguration.id,
      values: configurationValues(),
      secretBindings,
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.createAgent(metadataReader, {
      namespaceId: namespace.id,
      name: "unauthorized-bound-agent",
      configurationId: retainedBindings.id,
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.updateAgent(metadataReader, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: retainedBindings.id,
    }),
    AuthorizationDeniedError,
  );
  // Without a Harness Secret to recheck first, the refusal comes from the bound Secret itself.
  const withoutHarnessAuth = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "binding-check-agent",
    configurationId: unboundConfiguration.id,
  });
  await assert.rejects(
    controller.updateAgent(metadataReader, {
      namespaceId: namespace.id,
      agentId: withoutHarnessAuth.id,
      configurationId: retainedBindings.id,
    }),
    (error) =>
      error instanceof AuthorizationDeniedError &&
      error.authorization?.action === "operate" &&
      error.authorization.resource.id === secret.id,
  );
});

test("listing Secrets requires Namespace read before filtering each Secret", async () => {
  const { controller, makeReady, namespace } = await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "listing-boundary-key",
    value: "sk-test-listing",
  });
  const missingNamespace = "ns_00000000-0000-4000-8000-000000000000";

  // Without Namespace read, an existing and a missing Namespace are indistinguishable.
  for (const namespaceId of [namespace.id, missingNamespace]) {
    for (const principal of [zeroGrant, secretConsumer]) {
      await assert.rejects(
        controller.listSecrets(principal, namespaceId),
        AuthorizationDeniedError,
      );
    }
  }
  // Namespace read admits the list; each Secret still needs its own read.
  assert.deepEqual(await controller.listSecrets(noSecretOperator, namespace.id), []);
  const listed = await controller.listSecrets(metadataReader, namespace.id);
  assert.ok(listed.some(({ id }) => id === secret.id));
});

test("deployment admission stamps immutable native logging after sandbox policy", async () => {
  const { agent, configurationDriver, controller, makeReady, namespace } = await fixture();
  await makeReady();
  const originalValues = {
    logging: {
      level: "debug",
      consoleLevel: "debug",
      consoleStyle: "pretty",
      redactSensitive: "off",
      tenant: "kept",
    },
    diagnostics: { otel: { logs: true, traces: true } },
    app: { mode: "support" },
    agents: { defaults: { model: "codex/gpt-test" } },
    models: { providers: { codex: { agentRuntime: { id: "codex" } } } },
  };
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: originalValues,
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
    executionMode: "dedicated",
  });
  const sandbox = {
    id: "secret-occ-sandbox",
    capability: "sandbox",
    implementation: "test-sandbox",
    facets: ["filesystem"],
    configureAgent(values) {
      return { ...values, sandboxed: true, logging: { ...values.logging, level: "error" } };
    },
    async cleanup() {},
  };
  controller.registerDriver(sandbox);
  controller.selectDriver("sandbox", sandbox.id);

  const revision = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  const stored = await configurationDriver.read({
    namespaceId: namespace.id,
    id: configuration.id,
  });

  assert.deepEqual(stored.values, originalValues);
  assert.deepEqual(revision.configuration, {
    ...originalValues,
    sandboxed: true,
    logging: {
      level: "info",
      consoleLevel: "info",
      consoleStyle: "json",
      tenant: "kept",
    },
    diagnostics: { otel: { logs: false, traces: true } },
  });
});

test("deploying a bound Secret requires both the caller and Agent service principal to operate it", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace } = await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-authorized",
  });
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: secret.ref } },
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
  });

  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    {
      name: "AgentPrincipalAuthorizationError",
      principalId: agent.servicePrincipalId,
      authorization: { action: "operate", resource: secret.ref },
    },
  );
  grantAgentSecretOperate(agent, secret);
  await assert.rejects(
    controller.deployAgent(
      noSecretOperator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    {
      name: "AuthorizationDeniedError",
      authorization: { action: "operate", resource: secret.ref },
    },
  );
  const revision = await controller.deployAgent(
    deployer,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  assert.equal(revision.agentId, agent.id);
  assert.equal(revision.servicePrincipalId, agent.servicePrincipalId);
  assert.deepEqual(revision.secretBindings, {
    GATEWAY_TOOL_TOKEN: { source: secret.ref, delivery: { type: "env" } },
  });
});

test("Secret binding admission fails closed for missing selection and backend identity drift", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace, secretDriver } =
    await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-backend",
  });
  grantAgentSecretOperate(agent, secret);
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: secret.ref } },
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
  });

  const unselected = createTestSecretDriver({ id: "secret-unselected" });
  controller.registerDriver(unselected);
  controller.selectDriver("secret", unselected.id);
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    DependencyUnavailableError,
  );
  controller.selectDriver("secret", secretDriver.id);
  secretDriver.setResolveOverride((stored) =>
    stored.id === secret.id ? { ...stored.backendRef, uid: "uid-foreign" } : stored.backendRef,
  );
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    DependencyUnavailableError,
  );
  // The Harness authentication Secret is held to the same backend identity as a bound Secret.
  secretDriver.setResolveOverride((stored) =>
    stored.name === "fixture-harness-key"
      ? { ...stored.backendRef, uid: "uid-foreign" }
      : stored.backendRef,
  );
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The Harness Secret backend identity changed.",
  );
  assert.deepEqual(await controller.listRevisions(administrator, namespace.id, agent.id), []);
});

test("bound Secrets block deletion across current Configuration and admitted deployment dependencies", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace, secretDriver } =
    await fixture();
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-delete",
  });
  grantAgentSecretOperate(agent, secret);
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: secret.ref } },
  });

  await assert.rejects(
    controller.deleteSecret(administrator, namespace.id, secret.id),
    ResourceConflictError,
  );
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
  });
  const revision = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: configurationValues(),
    secretBindings: {},
  });
  await controller.transact((transaction) =>
    transaction.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
  );
  await assert.rejects(
    controller.deleteSecret(administrator, namespace.id, secret.id),
    ResourceConflictError,
  );
  await assert.rejects(
    controller.deleteNamespace(administrator, namespace.id),
    NamespaceNotEmptyError,
  );
  assert.equal(secretDriver.has(secret), true);
});

test("failed Secret updates do not roll back or leak the old value", async () => {
  const secretDriver = createTestSecretDriver({
    updateError: new Error("backend printed sk-test-v2"),
  });
  const { agent, controller, makeReady, namespace } = await fixture({ secretDriver });
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-v1",
  });

  await assert.rejects(
    controller.updateSecret(administrator, {
      namespaceId: namespace.id,
      secretId: secret.id,
      value: "sk-test-v2",
    }),
    (error) =>
      error instanceof DependencyUnavailableError &&
      !error.message.includes("sk-test-v1") &&
      !error.message.includes("sk-test-v2"),
  );
  assert.equal(secretDriver.valueFor(secret), "sk-test-v1");
  assert.equal(JSON.stringify(secretDriver.calls.at(-1).secret).includes("sk-test-v1"), false);
  assert.equal(JSON.stringify(secretDriver.calls.at(-1).secret).includes("sk-test-v2"), false);
});

test("channel directory lookup refuses saved IDs with C0 controls or DEL before authorization", async () => {
  const controller = new OpenClawController(installation, { state: new InMemoryPlatformState() });
  const lookup = (id) =>
    controller.lookupChannelDirectory(administrator, "ns_directory", {
      secretId: "secret_directory",
      kind: "users",
      ids: ["U0001", id],
    });
  // The controller uses the shared @openclaw-enterprise/utils check, swept over every code
  // unit in utils.test.mjs; these are its boundaries as seen through the lookup input.
  for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f]) {
    const character = String.fromCharCode(code);
    for (const id of [`${character}U2`, `U${character}2`, `U2${character}`]) {
      await assert.rejects(
        lookup(id),
        (error) =>
          error instanceof ScopeViolationError &&
          error.message === "The channel directory lookup input is invalid.",
        code.toString(16),
      );
    }
  }
  // C1 controls, line separators, lone surrogates and other Unicode pass the input check and
  // reach authorization, which this bare controller cannot provide.
  for (const id of [
    "U 2",
    "U~2",
    "U\u00802",
    "U\u00852",
    "U\u009f2",
    "U\u00a02",
    "U\u20282",
    "U\u20292",
    "U\ufeff2",
    "U\ud8002",
    "U\u{1f600}2",
  ]) {
    await assert.rejects(
      lookup(id),
      (error) =>
        error instanceof DependencyUnavailableError &&
        error.message === "The selected authorization Driver is unavailable.",
      JSON.stringify(id),
    );
  }
});

test("channel directory lookup measures the query and saved IDs in characters, as the contract does", async () => {
  const controller = new OpenClawController(installation, { state: new InMemoryPlatformState() });
  const lookup = (input) =>
    controller.lookupChannelDirectory(administrator, "ns_directory", {
      secretId: "secret_directory",
      kind: "users",
      ...input,
    });
  const refused = (error) =>
    error instanceof ScopeViolationError &&
    error.message === "The channel directory lookup input is invalid.";
  // Within the contract's 200 characters the input passes and reaches authorization,
  // which this bare controller cannot provide.
  const admitted = (error) =>
    error instanceof DependencyUnavailableError &&
    error.message === "The selected authorization Driver is unavailable.";
  // Each emoji is one character (code point) but two UTF-16 code units.
  const emoji = (count) => "\u{1f600}".repeat(count);
  await assert.rejects(lookup({ query: emoji(200) }), admitted, "200-character query");
  await assert.rejects(lookup({ query: emoji(201) }), refused, "201-character query");
  await assert.rejects(lookup({ ids: ["U0001", emoji(200)] }), admitted, "200-character ID");
  await assert.rejects(lookup({ ids: ["U0001", emoji(201)] }), refused, "201-character ID");
});

test("Secret values are checked before the Secret Driver sees them, on create and update", async () => {
  const { controller, makeReady, namespace, secretDriver } = await fixture({ skipAgent: true });
  await makeReady();
  const largest = "x".repeat(65_536);
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "largest-value",
    value: largest,
  });
  assert.equal(secretDriver.valueFor(secret), largest);
  const writes = secretDriver.calls.length;

  // Internal callers (device login sessions) reach this check without the HTTP schema.
  for (const [value, code] of [
    ["bad\u0000value", "INVALID_VALUE"],
    ["lone \ud800 surrogate", "INVALID_VALUE"],
    [`${largest}x`, "TOO_LONG"],
    ["\u00e9".repeat(32_769), "TOO_LONG"],
  ]) {
    await assert.rejects(
      controller.createSecret(administrator, {
        namespaceId: namespace.id,
        name: `rejected-${code}`,
        value,
      }),
      (error) => error instanceof SecretValueError && error.code === code,
    );
    await assert.rejects(
      controller.updateSecret(administrator, {
        namespaceId: namespace.id,
        secretId: secret.id,
        value,
      }),
      (error) => error instanceof SecretValueError && error.code === code,
    );
  }
  assert.equal(secretDriver.calls.length, writes);
  assert.equal(secretDriver.valueFor(secret), largest);
  assert.deepEqual(
    (await controller.listSecrets(administrator, namespace.id)).map(({ name }) => name),
    ["largest-value"],
  );
});

test("a Secret whose metadata does not commit leaves no backend copy behind", async () => {
  const { controller, makeReady, namespace, secretDriver } = await fixture({ skipAgent: true });
  await makeReady();
  const kept = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-kept",
  });
  // The duplicate name is refused by State after the driver stored the second value.
  await assert.rejects(
    controller.createSecret(administrator, {
      namespaceId: namespace.id,
      name: "model-key",
      value: "sk-test-orphan",
    }),
    ResourceConflictError,
  );
  const [, orphan] = secretDriver.calls.filter(({ operation }) => operation === "create");
  assert.equal(orphan.value, "sk-test-orphan");
  assert.equal(secretDriver.has(orphan.identity), false);
  assert.deepEqual(
    secretDriver.calls
      .filter(({ operation }) => operation === "delete")
      .map(({ secret }) => secret.id),
    [orphan.identity.id],
  );
  assert.equal(secretDriver.valueFor(kept), "sk-test-kept");
});

test("after a Secret Driver change a Secret still reads, but update and delete name the fix", async () => {
  const { controller, makeReady, namespace, secretDriver } = await fixture({ skipAgent: true });
  await makeReady();
  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "model-key",
    value: "sk-test-original",
  });
  const bound = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "bound-key",
    value: "sk-test-bound",
  });
  await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: bound.ref } },
  });
  // A reconfigured Installation selects a new driver; it must not write the old driver's Secret.
  const replacement = createTestSecretDriver({ id: "secret-replacement" });
  controller.registerDriver(replacement);
  controller.selectDriver("secret", replacement.id);
  const update = (principalId, secretId = secret.id) =>
    controller.updateSecret(principalId, {
      namespaceId: namespace.id,
      secretId,
      value: "sk-test-rotated",
    });
  const remove = (principalId, secretId = secret.id) =>
    controller.deleteSecret(principalId, namespace.id, secretId);

  // Reads return OCC metadata and never call a driver.
  assert.equal((await controller.readSecret(administrator, namespace.id, secret.id)).id, secret.id);

  const storageFix = (operation, remedy) => (error) => {
    assert.ok(error instanceof SecretStorageDriverError, `${error.name}: ${error.message}`);
    assert.ok(error instanceof DependencyUnavailableError);
    assert.equal(error.operation, operation);
    assert.match(error.message, remedy);
    return true;
  };
  await assert.rejects(update(administrator), storageFix("update", /Create a new Secret/));
  await assert.rejects(
    remove(administrator),
    storageFix("delete", /once the Installation again selects the Secret Driver that stored it/),
  );

  // Grants, the lookup and the reference check still answer first, unchanged.
  for (const attempt of [update, remove]) {
    await assert.rejects(attempt(metadataReader), (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.ok(!(error instanceof DependencyUnavailableError));
      return true;
    });
    await assert.rejects(
      attempt(administrator, "sec_00000000-0000-4000-8000-00000000ffff"),
      (error) =>
        error instanceof ScopeViolationError && !(error instanceof DependencyUnavailableError),
    );
  }
  await assert.rejects(remove(administrator, bound.id), (error) => {
    assert.ok(error instanceof ResourceConflictError);
    assert.equal(error.name, "SecretReferencedError");
    return true;
  });

  // No usable selected driver is an outage, not an ownership problem: the generic text stays.
  const implementation = replacement.implementation;
  replacement.implementation = "test-changed-after-selection";
  for (const attempt of [update, remove]) {
    await assert.rejects(attempt(administrator), (error) => {
      assert.ok(error instanceof DependencyUnavailableError);
      assert.ok(!(error instanceof SecretDriverOwnershipError), error.name);
      assert.equal(
        error.message,
        "The selected Secret Driver is unavailable or does not own this Secret.",
      );
      return true;
    });
  }
  replacement.implementation = implementation;

  assert.deepEqual(replacement.calls, []);
  assert.equal(secretDriver.valueFor(secret), "sk-test-original");
  assert.equal(secretDriver.has(secret), true);

  // With its driver selected again, the Secret updates and deletes as usual.
  controller.selectDriver("secret", secretDriver.id);
  await update(administrator);
  assert.equal(secretDriver.valueFor(secret), "sk-test-rotated");
  await remove(administrator);
  assert.equal(secretDriver.has(secret), false);
});

test("after a Secret Driver change an Agent update can replace the old Harness Secret but not keep it", async () => {
  const { agent, controller, iamState, makeReady, namespace } = await fixture();
  await makeReady();
  const update = (principalId, fields = {}) =>
    controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...fields,
    });
  const stored = async () =>
    (await controller.getAgent(administrator, namespace.id, agent.id)).harnessAuth;
  const oldHarnessAuth = await stored();
  assert.equal(oldHarnessAuth.method, "api_key");

  // The Installation re-selects its Secret Driver; the old Harness Secret stays stored.
  const replacement = createTestSecretDriver({ id: "secret-replacement" });
  controller.registerDriver(replacement);
  controller.selectDriver("secret", replacement.id);

  // Keeping the old Secret is still refused, as is creating an Agent with it: deploy could not
  // deliver it. The message names the fix.
  const harnessFix = (error) => {
    assert.ok(error instanceof HarnessAuthSecretDriverError, `${error.name}: ${error.message}`);
    assert.ok(error instanceof DependencyUnavailableError);
    assert.match(error.message, /set harnessAuth to another Secret/);
    return true;
  };
  await assert.rejects(update(administrator, { harnessAuth: oldHarnessAuth }), harnessFix);
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    harnessFix,
  );
  await assert.rejects(
    controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: "Second old-key agent",
      configurationId: agent.configurationId,
      harnessAuth: oldHarnessAuth,
    }),
    harnessFix,
  );
  assert.deepEqual(await stored(), oldHarnessAuth);

  // Any update still needs operate on the bound Secret, denied before any lookup, including
  // the lookup of a requested Secret that does not exist.
  iamState.restrictions.push({
    id: "deny-operate-old-harness-secret",
    namespaceId: namespace.id,
    action: "operate",
    resourceKind: "secret",
    resourceId: oldHarnessAuth.source.id,
    effect: "deny",
  });
  const missing = {
    method: "api_key",
    source: {
      kind: "secret",
      namespaceId: namespace.id,
      id: "sec_00000000-0000-4000-8000-00000000ffff",
    },
  };
  for (const fields of [{}, { harnessAuth: null }, { harnessAuth: missing }]) {
    await assert.rejects(update(administrator, fields), (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.deepEqual(error.authorization.resource, oldHarnessAuth.source);
      return true;
    });
  }
  iamState.restrictions.length = 0;
  // A requested Secret the Namespace does not hold stays a scope miss, not this 503.
  await assert.rejects(
    update(administrator, { harnessAuth: missing }),
    (error) =>
      error instanceof ScopeViolationError && !(error instanceof DependencyUnavailableError),
  );
  assert.deepEqual(await stored(), oldHarnessAuth);

  // An update that binds nothing new succeeds, and so does one that clears the old Secret.
  assert.deepEqual((await update(administrator)).harnessAuth, oldHarnessAuth);
  assert.equal((await update(administrator, { harnessAuth: null })).harnessAuth, null);

  // A Secret stored through the new driver binds as usual.
  const current = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "replacement-harness-key",
    value: "synthetic-replacement-key",
  });
  const harnessAuth = { method: "api_key", source: current.ref };
  assert.deepEqual((await update(administrator, { harnessAuth })).harnessAuth, harnessAuth);
});

test("after a Secret Driver change an Agent update and deploy wait for its Configuration's Secret bindings", async () => {
  const { agent, controller, grantAgentSecretOperate, iamState, makeReady, namespace } =
    await fixture();
  await makeReady();
  const old = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "gateway-tool-token",
    value: "synthetic-old-token",
  });
  grantAgentSecretOperate(agent, old);
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: old.ref } },
  });
  const update = (principalId, fields = {}) =>
    controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: configuration.id,
      ...fields,
    });
  const deploy = () =>
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
  // With runtime Harness authentication, only the Configuration binds an old-driver Secret.
  await update(administrator, { harnessAuth: { method: "runtime" } });

  const replacement = createTestSecretDriver({ id: "secret-replacement" });
  controller.registerDriver(replacement);
  controller.selectDriver("secret", replacement.id);

  // Every update names the Configuration, so even an unchanged one is refused, as deploy is,
  // with a message that names the fix. Keeping the binding in a Configuration write fails too.
  const configurationFix = (error) => {
    assert.ok(error instanceof SecretBindingDriverError, `${error.name}: ${error.message}`);
    assert.ok(error instanceof DependencyUnavailableError);
    assert.match(error.message, /update the Configuration's secretBindings/);
    return true;
  };
  await assert.rejects(update(administrator), configurationFix);
  await assert.rejects(deploy(), configurationFix);
  await assert.rejects(
    controller.updateConfiguration(administrator, {
      namespaceId: namespace.id,
      configurationId: configuration.id,
      values: configurationValues(),
    }),
    configurationFix,
  );
  // A Secret the Namespace does not hold stays a scope miss, not this 503.
  await assert.rejects(
    controller.updateConfiguration(administrator, {
      namespaceId: namespace.id,
      configurationId: configuration.id,
      values: configurationValues(),
      secretBindings: {
        GATEWAY_TOOL_TOKEN: {
          source: {
            kind: "secret",
            namespaceId: namespace.id,
            id: "sec_00000000-0000-4000-8000-00000000ffff",
          },
        },
      },
    }),
    (error) =>
      error instanceof ScopeViolationError && !(error instanceof DependencyUnavailableError),
  );

  // Grants still answer first: agent:update, then operate on the bound Secret.
  await assert.rejects(update(deployer), (error) => {
    assert.ok(!(error instanceof DependencyUnavailableError));
    assert.deepEqual(error.authorization, {
      action: "update",
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
    });
    return true;
  });
  iamState.restrictions.push({
    id: "deny-operate-old-gateway-secret",
    namespaceId: namespace.id,
    action: "operate",
    resourceKind: "secret",
    resourceId: old.id,
    effect: "deny",
  });
  await assert.rejects(update(administrator), (error) => {
    assert.ok(!(error instanceof DependencyUnavailableError));
    assert.deepEqual(error.authorization, { action: "operate", resource: old.ref });
    return true;
  });
  iamState.restrictions.length = 0;

  // Naming another Configuration checks only that one.
  const unbound = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
  });
  assert.equal(
    (await update(administrator, { configurationId: unbound.id })).configurationId,
    unbound.id,
  );

  // Once the Configuration binds a Secret stored through the selected driver, both proceed.
  const current = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "gateway-tool-token-current",
    value: "synthetic-current-token",
  });
  grantAgentSecretOperate(agent, current);
  await controller.updateConfiguration(administrator, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: current.ref } },
  });
  assert.equal((await update(administrator)).configurationId, configuration.id);
  assert.equal((await deploy()).secretDriverId, replacement.id);
});

/** A Channel Driver that reads one bound Secret through OCC when `binding` is set. */
function createTestChannelDriver() {
  const driver = {
    id: "channel-test",
    capability: "channel",
    implementation: "test-channel",
    binding: undefined,
    async validateCredentials(_values, withSecret) {
      if (driver.binding !== undefined) {
        await withSecret(driver.binding, "/channels/test/token", async () => {});
      }
    },
    async lookupDirectory() {
      return { entries: [] };
    },
  };
  return driver;
}

test("after a Secret Driver change Agent provisioning names the fix for its old-driver Secrets", async () => {
  const { configurationDriver, controller, iamState, makeReady, namespace } = await fixture({
    skipAgent: true,
    computeOverrides: {
      agentProvisioning: { executionModes: ["dedicated"] },
      validateAgentProvisioning() {},
      async provisionAgentRuntimeCredentials() {
        assert.fail("Provisioning admission must not provision runtime credentials.");
      },
      async getAgentRuntimeCredentialStatus() {
        return { transportConfigured: false };
      },
    },
  });
  await makeReady();
  grantRole(iamState, administrator, {
    id: "secret-occ-installation-administrator-role",
    permissions: { installation: ["administer"] },
  });
  Object.assign(configurationDriver, {
    async createExact() {
      assert.fail("Provisioning admission must not create a Configuration.");
    },
    async inspectExact() {
      assert.fail("Provisioning admission must not inspect a Configuration.");
    },
  });
  const channel = createTestChannelDriver();
  controller.registerDriver(channel);
  controller.selectDriver("channel", channel.id);
  const create = (name) =>
    controller.createSecret(administrator, {
      namespaceId: namespace.id,
      name,
      value: `synthetic-${name}`,
    });
  const oldToken = await create("old-gateway-token");
  const oldKey = await create("old-model-key");

  const replacement = createTestSecretDriver({ id: "secret-replacement" });
  controller.registerDriver(replacement);
  controller.selectDriver("secret", replacement.id);
  const currentToken = await create("current-gateway-token");
  const currentKey = await create("current-model-key");

  let request = 0;
  const provision = (token, key) =>
    controller.provisionAgent(administrator, {
      namespaceId: namespace.id,
      requestId: `req_secret_occ_${(request += 1)}`,
      name: "Provisioned agent",
      executionMode: "dedicated",
      configuration: {
        kind: "agent",
        values: configurationValues(),
        secretBindings: { GATEWAY_TOOL_TOKEN: { source: token.ref } },
      },
      harnessAuth: { method: "api_key", source: key.ref },
    });
  const provisioningFix = (error) => {
    assert.ok(error instanceof ProvisioningSecretDriverError, `${error.name}: ${error.message}`);
    assert.ok(error instanceof DependencyUnavailableError);
    assert.match(error.message, /submit a new provisioning request/);
    return true;
  };
  const missing = {
    ref: {
      kind: "secret",
      namespaceId: namespace.id,
      id: "sec_00000000-0000-4000-8000-00000000ffff",
    },
  };

  // A bound Secret or the Harness key stored through the old driver names the fix, whether the
  // Channel Driver reads it during admission or only the Secret check does.
  for (const binding of [undefined, "GATEWAY_TOOL_TOKEN"]) {
    channel.binding = binding;
    await assert.rejects(provision(oldToken, currentKey), provisioningFix);
    await assert.rejects(provision(currentToken, oldKey), provisioningFix);

    // Grants and the lookup still answer first.
    iamState.restrictions.push({
      id: "deny-operate-old-gateway-token",
      namespaceId: namespace.id,
      action: "operate",
      resourceKind: "secret",
      resourceId: oldToken.id,
      effect: "deny",
    });
    await assert.rejects(provision(oldToken, currentKey), (error) => {
      assert.ok(!(error instanceof DependencyUnavailableError));
      assert.deepEqual(error.authorization, { action: "operate", resource: oldToken.ref });
      return true;
    });
    iamState.restrictions.length = 0;
    await assert.rejects(
      provision(missing, currentKey),
      (error) =>
        error instanceof ScopeViolationError && !(error instanceof DependencyUnavailableError),
    );

    // Secrets stored through the selected driver pass, reaching the PostgreSQL-only work store.
    await assert.rejects(provision(currentToken, currentKey), (error) => {
      assert.ok(error instanceof DependencyUnavailableError);
      assert.ok(!(error instanceof SecretDriverOwnershipError), error.message);
      assert.match(error.message, /requires durable PostgreSQL state/);
      return true;
    });
  }
});

test("after a Secret Driver change a Channel Driver's deploy check names the Configuration fix", async () => {
  const { agent, controller, grantAgentSecretOperate, makeReady, namespace } = await fixture();
  await makeReady();
  const old = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "old-channel-token",
    value: "synthetic-old-channel-token",
  });
  grantAgentSecretOperate(agent, old);
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: configurationValues(),
    secretBindings: { GATEWAY_TOOL_TOKEN: { source: old.ref } },
  });
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
    harnessAuth: { method: "runtime" },
  });
  const channel = createTestChannelDriver();
  channel.binding = "GATEWAY_TOOL_TOKEN";
  controller.registerDriver(channel);
  controller.selectDriver("channel", channel.id);
  const replacement = createTestSecretDriver({ id: "secret-replacement" });
  controller.registerDriver(replacement);
  controller.selectDriver("secret", replacement.id);

  // The Channel Driver reads the binding before admission does; both name the same fix.
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    (error) => {
      assert.ok(error instanceof SecretBindingDriverError, `${error.name}: ${error.message}`);
      return true;
    },
  );
  // The deploy grant still answers first.
  await assert.rejects(
    controller.deployAgent(
      metadataReader,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.ok(!(error instanceof DependencyUnavailableError));
      return true;
    },
  );
});

test("an Agent update needs read on its current ServiceAccount, before any lookup", async () => {
  const { agent, controller, iamState, makeReady, namespace } = await fixture();
  await makeReady();
  grantRole(iamState, administrator, {
    id: "secret-occ-service-account-role",
    permissions: { service_account: ["create", "read"] },
  });
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "harness-account",
  });
  const accountRef = { kind: "service_account", namespaceId: namespace.id, id: account.id };
  const update = (principalId, fields = {}) =>
    controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...fields,
    });
  await update(administrator, { harnessAuth: { method: "codex_pat", source: accountRef } });

  // metadataReader may update the Agent but not read the account it binds.
  const missing = {
    method: "api_key",
    source: {
      kind: "secret",
      namespaceId: namespace.id,
      id: "sec_00000000-0000-4000-8000-00000000ffff",
    },
  };
  for (const fields of [{}, { harnessAuth: null }, { harnessAuth: missing }]) {
    await assert.rejects(update(metadataReader, fields), (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.deepEqual(error.authorization, { action: "read", resource: accountRef });
      return true;
    });
  }
  bindRole(iamState, metadataReader, {
    id: "secret-occ-metadata-reader-account",
    roleId: "secret-occ-service-account-role",
    namespaceId: namespace.id,
    resource: { kind: "service_account", id: account.id },
  });
  assert.deepEqual((await update(metadataReader)).harnessAuth, {
    method: "codex_pat",
    source: accountRef,
  });
  assert.equal((await update(metadataReader, { harnessAuth: null })).harnessAuth, null);
});
