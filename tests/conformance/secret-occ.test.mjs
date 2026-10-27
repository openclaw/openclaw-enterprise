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
const missingSecretId = "sec_00000000-0000-4000-8000-00000000ffff";
const noConsumers = {
  agents: [],
  configurations: [],
  credentialSources: [],
  provisioningRequests: [],
  unreadable: 0,
  truncated: false,
};

function configurationValues() {
  return {
    secrets: {
      providers: { model: { source: "env", allowlist: ["GATEWAY_TOOL_TOKEN"] } },
    },
  };
}

/** The GATEWAY_TOOL_TOKEN binding of `ref`, as written and as stored. */
const gatewayBinding = (ref) => ({ GATEWAY_TOOL_TOKEN: { source: ref } });
const storedBinding = (ref) => ({ GATEWAY_TOOL_TOKEN: { source: ref, delivery: { type: "env" } } });

/** A requested Secret the Namespace does not hold is a scope miss, never a driver 503. */
const scopeMiss = (error) =>
  error instanceof ScopeViolationError && !(error instanceof DependencyUnavailableError);

/** A refused grant (optionally exactly `authorization`) that answers before any driver check. */
function deniedFirst(authorization) {
  return (error) => {
    assert.ok(error instanceof AuthorizationDeniedError, `${error.name}: ${error.message}`);
    assert.ok(!(error instanceof DependencyUnavailableError));
    if (authorization !== undefined) {
      assert.deepEqual(error.authorization, authorization);
    }
    return true;
  };
}

/** A refusal after a Secret Driver change: still a 503, of `ErrorClass`, naming the fix. */
function namesFix(ErrorClass, remedy, operation) {
  return (error) => {
    assert.ok(error instanceof ErrorClass, `${error.name}: ${error.message}`);
    assert.ok(error instanceof DependencyUnavailableError);
    if (operation !== undefined) {
      assert.equal(error.operation, operation);
    }
    assert.match(error.message, remedy);
    return true;
  };
}
const configurationFix = namesFix(
  SecretBindingDriverError,
  /update the Configuration's secretBindings/,
);

/** A ready Namespace (unless `ready: false`) with one Agent (unless `skipAgent`) and helpers. */
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
  grant(administrator, "administrator", {
    namespace: ["create", "read", "delete"],
    configuration: ["create", "read", "update", "delete"],
    secret: ["create", "read", "update", "delete", "operate"],
    agent: ["create", "read", "update", "deploy", "operate"],
    agent_revision: ["read"],
  });
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
  const controller = new OpenClawController(installation, { state: new InMemoryPlatformState() });
  const compute =
    options.computeOverrides === undefined
      ? createDevelopmentComputeDriver()
      : Object.freeze({ ...createDevelopmentComputeDriver(), ...options.computeOverrides });
  const configurationDriver = createTestConfigurationDriver({ id: "secret-occ-configuration" });
  const secretDriver = options.secretDriver ?? createTestSecretDriver();
  registerAndSelectDrivers(controller, [iam, compute, configurationDriver, secretDriver]);

  const namespace = await controller.createNamespace(administrator, {
    name: options.namespaceName ?? "Secret OCC tenant",
  });
  const namespaceId = namespace.id;
  const createSecret = (name, value = `synthetic-${name}`) =>
    controller.createSecret(administrator, { namespaceId, name, value });
  const updateSecret = (secretId, value, principalId = administrator) =>
    controller.updateSecret(principalId, { namespaceId, secretId, value });
  const configure = (
    secretBindings,
    { values = configurationValues(), principalId = administrator } = {},
  ) =>
    controller.createConfiguration(principalId, {
      namespaceId,
      kind: "agent",
      values,
      ...(secretBindings === undefined ? {} : { secretBindings }),
    });
  const reconfigure = (configurationId, fields = {}, principalId = administrator) =>
    controller.updateConfiguration(principalId, {
      namespaceId,
      configurationId,
      values: configurationValues(),
      ...fields,
    });
  const createAgent = (name, configurationId, fields = {}, principalId = administrator) =>
    controller.createAgent(principalId, { namespaceId, name, configurationId, ...fields });
  const baseConfiguration = options.skipAgent
    ? undefined
    : await configure(undefined, { values: {} });
  const agent =
    baseConfiguration && (await createAgent("Secret owner agent", baseConfiguration.id));
  /** Updates the fixture Agent (or `fields.agentId`), keeping its first Configuration by default. */
  const updateAgent = (principalId, fields = {}) =>
    controller.updateAgent(principalId, {
      namespaceId,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...fields,
    });
  const deploy = (principalId = administrator) =>
    controller.deployAgent(
      principalId,
      { namespaceId, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
  /** Assigns the Agent a new Configuration that binds GATEWAY_TOOL_TOKEN to `secret`. */
  async function assignBound(secret, fields = {}) {
    const configuration = await configure(gatewayBinding(secret.ref));
    await updateAgent(administrator, { configurationId: configuration.id, ...fields });
    return configuration;
  }
  function select(driver) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
    return driver;
  }
  /** The Installation re-selects its Secret Driver; Secrets stored so far keep the old one. */
  const replaceSecretDriver = () => select(createTestSecretDriver({ id: "secret-replacement" }));
  const denyOperate = (resourceId) =>
    iamState.restrictions.push({
      id: `deny-operate-${resourceId}`,
      namespaceId,
      action: "operate",
      resourceKind: "secret",
      resourceId,
      effect: "deny",
    });

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

  async function makeReady() {
    await controller.transact((transaction) =>
      transaction.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
    );
    if (agent) {
      const modelSecret = await createSecret("fixture-harness-key", "synthetic-harness-key");
      grantAgentSecretOperate(agent, modelSecret);
      bindRole(iamState, noSecretOperator, {
        id: "fixture-harness-consumer",
        roleId: "secret-occ-agent-secret-role",
        namespaceId,
        resource: { kind: "secret", id: modelSecret.id },
      });
      await updateAgent(administrator, {
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      });
    }
  }
  if (options.ready !== false) {
    await makeReady();
  }

  return {
    agent,
    assignBound,
    configurationDriver,
    configure,
    controller,
    createAgent,
    createSecret,
    denyOperate,
    deploy,
    grantAgentSecretOperate,
    iamState,
    makeReady,
    missingRef: { kind: "secret", namespaceId, id: missingSecretId },
    namespace,
    reconfigure,
    replaceSecretDriver,
    secretDriver,
    select,
    updateAgent,
    updateSecret,
  };
}

test("Secret storage requires a ready Namespace and no Agent owner before any gateway deployment", async () => {
  const { controller, createSecret, makeReady, namespace, secretDriver } = await fixture({
    skipAgent: true,
    ready: false,
  });

  // Secret material can be stored only after Compute has made the Namespace ready.
  await assert.rejects(
    createSecret("model-key-before-ready", "sk-test-before-ready"),
    NamespaceNotReadyError,
  );
  assert.equal(secretDriver.calls.length, 0);

  await makeReady();
  const secret = await createSecret("model-key", "sk-test-original");

  assert.deepEqual(Object.keys(secret).sort(), ["id", "name", "namespaceId", "ref"]);
  assert.deepEqual(secret.ref, { kind: "secret", namespaceId: namespace.id, id: secret.id });
  assert.equal(secretDriver.valueFor(secret), "sk-test-original");
  assert.deepEqual(await controller.readSecret(administrator, namespace.id, secret.id), {
    ...secret,
    consumers: noConsumers,
  });
  assert.equal(JSON.stringify(secret).includes("sk-test-original"), false);
});

test("Secret bindings freeze public refs in revisions while value-only updates keep bindings unchanged", async () => {
  const { agent, configure, createSecret, deploy, reconfigure, secretDriver, ...f } =
    await fixture();
  const secret = await createSecret("model-key", "sk-test-v1");
  f.grantAgentSecretOperate(agent, secret);
  const secretBindings = gatewayBinding(secret.ref);
  const configuration = await configure(secretBindings);
  assert.deepEqual(configuration.secretBindings, storedBinding(secret.ref));
  const preserved = await reconfigure(configuration.id, {
    values: { ...configurationValues(), marker: "preserved" },
  });
  assert.deepEqual(preserved.secretBindings, configuration.secretBindings);
  const cleared = await reconfigure(configuration.id, {
    values: { ...configurationValues(), marker: "cleared" },
    secretBindings: {},
  });
  assert.equal(cleared.secretBindings, undefined);
  const restored = await reconfigure(configuration.id, { secretBindings });
  assert.deepEqual(restored.secretBindings, configuration.secretBindings);
  await f.updateAgent(administrator, { configurationId: configuration.id });
  const first = await deploy();

  const updated = await f.updateSecret(secret.id, "sk-test-v2");
  const second = await deploy();

  assert.deepEqual(updated, secret);
  assert.equal(secretDriver.valueFor(secret), "sk-test-v2");
  assert.equal(first.secretDriverId, secretDriver.id);
  assert.equal(second.secretDriverId, secretDriver.id);
  assert.deepEqual(first.secretBindings, storedBinding(secret.ref));
  assert.deepEqual(second.secretBindings, first.secretBindings);
  assert.equal(first.configurationGeneration, restored.generation);
  assert.equal(second.configurationGeneration, restored.generation);
  assert.equal(JSON.stringify([first, second]).includes("sk-test-v"), false);
  assert.equal(secretDriver.calls.filter(({ operation }) => operation === "update").length, 1);
});

test("Secret bindings can be shared inside a Namespace and still deny cross-Namespace refs", async () => {
  const { configure, createAgent, createSecret, reconfigure, updateAgent } = await fixture();
  const sibling = await createAgent(
    "Sibling agent",
    (await configure(undefined, { values: {} })).id,
  );
  const ownerSecret = await createSecret("owner-model-key", "sk-test-owner");
  const siblingSecret = await createSecret("sibling-model-key", "sk-test-sibling");

  const sharedConfiguration = await configure(gatewayBinding(ownerSecret.ref));
  await updateAgent(administrator, {
    agentId: sibling.id,
    configurationId: sharedConfiguration.id,
  });

  const mixedConfiguration = await configure({
    GATEWAY_TOOL_TOKEN: { source: ownerSecret.ref },
    MODEL_FALLBACK_KEY: { source: siblingSecret.ref },
  });
  assert.deepEqual(mixedConfiguration.secretBindings, {
    ...storedBinding(ownerSecret.ref),
    MODEL_FALLBACK_KEY: { source: siblingSecret.ref, delivery: { type: "env" } },
  });

  const foreign = await fixture({ namespaceName: "Foreign secret tenant" });
  const foreignSecret = await foreign.createSecret("foreign-model-key", "sk-test-foreign");
  await assert.rejects(configure(gatewayBinding(foreignSecret.ref)), ScopeViolationError);

  const assignedConfiguration = await configure(undefined, { values: {} });
  await createAgent("Configuration holder", assignedConfiguration.id);
  const updatedAssigned = await reconfigure(assignedConfiguration.id, {
    secretBindings: gatewayBinding(ownerSecret.ref),
  });
  assert.deepEqual(updatedAssigned.secretBindings, storedBinding(ownerSecret.ref));
});

test("Secret material, metadata, and binding permissions stay separate", async () => {
  const { configure, controller, createAgent, namespace, reconfigure, updateAgent, ...f } =
    await fixture();
  const secret = await f.createSecret("permission-boundary-key", "sk-test-boundary");

  await assert.rejects(
    f.updateSecret(secret.id, "sk-test-denied-update", secretConsumer),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    controller.deleteSecret(secretConsumer, namespace.id, secret.id),
    AuthorizationDeniedError,
  );
  assert.deepEqual(await controller.readSecret(metadataReader, namespace.id, secret.id), {
    ...secret,
    consumers: noConsumers,
  });

  const secretBindings = gatewayBinding(secret.ref);
  const asReader = { principalId: metadataReader };
  await assert.rejects(configure(secretBindings, asReader), AuthorizationDeniedError);

  const retainedBindings = await configure(secretBindings);
  await assert.rejects(
    reconfigure(
      retainedBindings.id,
      { values: { ...configurationValues(), marker: "retained-bindings" } },
      metadataReader,
    ),
    AuthorizationDeniedError,
  );

  const unboundConfiguration = await configure(undefined, { values: {} });
  await assert.rejects(
    reconfigure(unboundConfiguration.id, { secretBindings }, metadataReader),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    createAgent("unauthorized-bound-agent", retainedBindings.id, {}, metadataReader),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    updateAgent(metadataReader, { configurationId: retainedBindings.id }),
    AuthorizationDeniedError,
  );
  // Without a Harness Secret to recheck first, the refusal comes from the bound Secret itself.
  const withoutHarnessAuth = await createAgent("binding-check-agent", unboundConfiguration.id);
  await assert.rejects(
    updateAgent(metadataReader, {
      agentId: withoutHarnessAuth.id,
      configurationId: retainedBindings.id,
    }),
    deniedFirst({ action: "operate", resource: secret.ref }),
  );
});

test("listing Secrets requires Namespace read before filtering each Secret", async () => {
  const { controller, createSecret, namespace } = await fixture();
  const secret = await createSecret("listing-boundary-key", "sk-test-listing");
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
  const { agent, configurationDriver, configure, deploy, namespace, select, updateAgent } =
    await fixture();
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
  const configuration = await configure(undefined, { values: originalValues });
  await updateAgent(administrator, {
    configurationId: configuration.id,
    executionMode: "dedicated",
  });
  select({
    id: "secret-occ-sandbox",
    capability: "sandbox",
    implementation: "test-sandbox",
    facets: ["filesystem"],
    configureAgent(values) {
      return { ...values, sandboxed: true, logging: { ...values.logging, level: "error" } };
    },
    async cleanup() {},
  });

  const revision = await deploy();
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
    // OpenClaw's earlier value for a setting its security preset would otherwise fill.
    tools: { exec: { applyPatch: { workspaceOnly: true } } },
    // The omitted roster gains its served main entry, named after the OCC Agent.
    agents: { ...originalValues.agents, entries: { main: { identity: { name: agent.name } } } },
  });
});

test("deploying a bound Secret requires both the caller and Agent service principal to operate it", async () => {
  const { agent, assignBound, createSecret, deploy, grantAgentSecretOperate } = await fixture();
  const secret = await createSecret("model-key", "sk-test-authorized");
  await assignBound(secret);

  await assert.rejects(deploy(), {
    name: "AgentPrincipalAuthorizationError",
    principalId: agent.servicePrincipalId,
    authorization: { action: "operate", resource: secret.ref },
  });
  grantAgentSecretOperate(agent, secret);
  await assert.rejects(deploy(noSecretOperator), {
    name: "AuthorizationDeniedError",
    authorization: { action: "operate", resource: secret.ref },
  });
  const revision = await deploy(deployer);
  assert.equal(revision.agentId, agent.id);
  assert.equal(revision.servicePrincipalId, agent.servicePrincipalId);
  assert.deepEqual(revision.secretBindings, storedBinding(secret.ref));
});

test("Secret binding admission fails closed for missing selection and backend identity drift", async () => {
  const { agent, controller, deploy, namespace, secretDriver, ...f } = await fixture();
  const secret = await f.createSecret("model-key", "sk-test-backend");
  f.grantAgentSecretOperate(agent, secret);
  await f.assignBound(secret);

  f.select(createTestSecretDriver({ id: "secret-unselected" }));
  await assert.rejects(deploy(), DependencyUnavailableError);
  controller.selectDriver("secret", secretDriver.id);
  const foreignUid = (matches) =>
    secretDriver.setResolveOverride((stored) =>
      matches(stored) ? { ...stored.backendRef, uid: "uid-foreign" } : stored.backendRef,
    );
  foreignUid((stored) => stored.id === secret.id);
  await assert.rejects(deploy(), DependencyUnavailableError);
  // The Harness authentication Secret is held to the same backend identity as a bound Secret.
  foreignUid((stored) => stored.name === "fixture-harness-key");
  await assert.rejects(
    deploy(),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The Harness Secret backend identity changed.",
  );
  assert.deepEqual(
    (await controller.listRevisions(administrator, namespace.id, agent.id)).revisions,
    [],
  );
});

test("bound Secrets block deletion across current Configuration and admitted deployment dependencies", async () => {
  const { agent, controller, namespace, secretDriver, ...f } = await fixture();
  const secret = await f.createSecret("model-key", "sk-test-delete");
  f.grantAgentSecretOperate(agent, secret);
  const configuration = await f.configure(gatewayBinding(secret.ref));
  const remove = () => controller.deleteSecret(administrator, namespace.id, secret.id);

  await assert.rejects(remove(), ResourceConflictError);
  await f.updateAgent(administrator, { configurationId: configuration.id });
  const revision = await f.deploy();
  await f.reconfigure(configuration.id, { secretBindings: {} });
  await controller.transact((transaction) =>
    transaction.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
  );
  await assert.rejects(remove(), ResourceConflictError);
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
  const { createSecret, updateSecret } = await fixture({ secretDriver });
  const secret = await createSecret("model-key", "sk-test-v1");

  await assert.rejects(
    updateSecret(secret.id, "sk-test-v2"),
    (error) =>
      error instanceof DependencyUnavailableError &&
      !error.message.includes("sk-test-v1") &&
      !error.message.includes("sk-test-v2"),
  );
  assert.equal(secretDriver.valueFor(secret), "sk-test-v1");
  const sent = JSON.stringify(secretDriver.calls.at(-1).secret);
  assert.equal(sent.includes("sk-test-v1"), false);
  assert.equal(sent.includes("sk-test-v2"), false);
});

/**
 * A channel directory lookup on a bare controller. Input that passes the check reaches
 * authorization, which this controller cannot provide.
 */
function directoryLookup() {
  const controller = new OpenClawController(installation, { state: new InMemoryPlatformState() });
  return (input) =>
    controller.lookupChannelDirectory(administrator, "ns_directory", {
      secretId: "secret_directory",
      kind: "users",
      ...input,
    });
}
const lookupRefused = (error) =>
  error instanceof ScopeViolationError &&
  error.message === "The channel directory lookup input is invalid.";
const lookupAdmitted = (error) =>
  error instanceof DependencyUnavailableError &&
  error.message === "The selected authorization Driver is unavailable.";

test("channel directory lookup refuses saved IDs with C0 controls or DEL before authorization", async () => {
  const lookup = directoryLookup();
  // The controller uses the shared @openclaw-enterprise/utils check, swept over every code
  // unit in utils.test.mjs; these are its boundaries as seen through the lookup input.
  for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f]) {
    const character = String.fromCharCode(code);
    for (const id of [`${character}U2`, `U${character}2`, `U2${character}`]) {
      await assert.rejects(lookup({ ids: ["U0001", id] }), lookupRefused, code.toString(16));
    }
  }
  // C1 controls, line separators, lone surrogates and other Unicode pass the input check.
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
    await assert.rejects(lookup({ ids: ["U0001", id] }), lookupAdmitted, JSON.stringify(id));
  }
});

test("channel directory lookup measures the query and saved IDs in characters, as the contract does", async () => {
  const lookup = directoryLookup();
  // Each emoji is one character (code point) but two UTF-16 code units; the contract allows 200.
  const emoji = (count) => "\u{1f600}".repeat(count);
  await assert.rejects(lookup({ query: emoji(200) }), lookupAdmitted, "200-character query");
  await assert.rejects(lookup({ query: emoji(201) }), lookupRefused, "201-character query");
  await assert.rejects(lookup({ ids: ["U0001", emoji(200)] }), lookupAdmitted, "200-character ID");
  await assert.rejects(lookup({ ids: ["U0001", emoji(201)] }), lookupRefused, "201-character ID");
});

test("Secret values are checked before the Secret Driver sees them, on create and update", async () => {
  const { controller, createSecret, namespace, secretDriver, updateSecret } = await fixture({
    skipAgent: true,
  });
  const largest = "x".repeat(65_536);
  const secret = await createSecret("largest-value", largest);
  assert.equal(secretDriver.valueFor(secret), largest);
  const writes = secretDriver.calls.length;

  // Internal callers (device login sessions) reach this check without the HTTP schema.
  for (const [value, code] of [
    ["bad\u0000value", "INVALID_VALUE"],
    ["lone \ud800 surrogate", "INVALID_VALUE"],
    [`${largest}x`, "TOO_LONG"],
    ["\u00e9".repeat(32_769), "TOO_LONG"],
  ]) {
    const invalid = (error) => error instanceof SecretValueError && error.code === code;
    await assert.rejects(createSecret(`rejected-${code}`, value), invalid);
    await assert.rejects(updateSecret(secret.id, value), invalid);
  }
  assert.equal(secretDriver.calls.length, writes);
  assert.equal(secretDriver.valueFor(secret), largest);
  assert.deepEqual(
    (await controller.listSecrets(administrator, namespace.id)).map(({ name }) => name),
    ["largest-value"],
  );
});

test("a Secret whose metadata does not commit leaves no backend copy behind", async () => {
  const { createSecret, secretDriver } = await fixture({ skipAgent: true });
  const kept = await createSecret("model-key", "sk-test-kept");
  // The duplicate name is refused by State after the driver stored the second value.
  await assert.rejects(createSecret("model-key", "sk-test-orphan"), ResourceConflictError);
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
  const { controller, createSecret, namespace, secretDriver, ...f } = await fixture({
    skipAgent: true,
  });
  const secret = await createSecret("model-key", "sk-test-original");
  const bound = await createSecret("bound-key", "sk-test-bound");
  await f.configure(gatewayBinding(bound.ref));
  // A reconfigured Installation selects a new driver; it must not write the old driver's Secret.
  const replacement = f.replaceSecretDriver();
  const update = (principalId, secretId = secret.id) =>
    f.updateSecret(secretId, "sk-test-rotated", principalId);
  const remove = (principalId, secretId = secret.id) =>
    controller.deleteSecret(principalId, namespace.id, secretId);

  // Reads return OCC metadata and never call a driver.
  assert.equal((await controller.readSecret(administrator, namespace.id, secret.id)).id, secret.id);

  await assert.rejects(
    update(administrator),
    namesFix(SecretStorageDriverError, /Create a new Secret/, "update"),
  );
  await assert.rejects(
    remove(administrator),
    namesFix(
      SecretStorageDriverError,
      /once the Installation again selects the Secret Driver that stored it/,
      "delete",
    ),
  );

  // Grants, the lookup and the reference check still answer first, unchanged.
  for (const attempt of [update, remove]) {
    await assert.rejects(attempt(metadataReader), deniedFirst());
    await assert.rejects(attempt(administrator, missingSecretId), scopeMiss);
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
  const { agent, controller, createAgent, iamState, namespace, updateAgent, ...f } =
    await fixture();
  const stored = async () =>
    (await controller.getAgent(administrator, namespace.id, agent.id)).harnessAuth;
  const oldHarnessAuth = await stored();
  assert.equal(oldHarnessAuth.method, "api_key");

  // The Installation re-selects its Secret Driver; the old Harness Secret stays stored.
  f.replaceSecretDriver();

  // Keeping the old Secret is still refused, as is creating an Agent with it: deploy could not
  // deliver it. The message names the fix.
  const harnessFix = namesFix(HarnessAuthSecretDriverError, /set harnessAuth to another Secret/);
  await assert.rejects(updateAgent(administrator, { harnessAuth: oldHarnessAuth }), harnessFix);
  await assert.rejects(f.deploy(), harnessFix);
  await assert.rejects(
    createAgent("Second old-key agent", agent.configurationId, { harnessAuth: oldHarnessAuth }),
    harnessFix,
  );
  assert.deepEqual(await stored(), oldHarnessAuth);

  // Any update still needs operate on the bound Secret, denied before any lookup, including
  // the lookup of a requested Secret that does not exist.
  f.denyOperate(oldHarnessAuth.source.id);
  const missing = { method: "api_key", source: f.missingRef };
  for (const fields of [{}, { harnessAuth: null }, { harnessAuth: missing }]) {
    await assert.rejects(
      updateAgent(administrator, fields),
      deniedFirst({ action: "operate", resource: oldHarnessAuth.source }),
    );
  }
  // A requested Harness Secret is denied before its lookup too: without operate, the old-driver
  // Secret gets the same 403 as a missing one, never this 503 or a 404.
  f.denyOperate(missing.source.id);
  for (const harnessAuth of [oldHarnessAuth, missing]) {
    await assert.rejects(
      createAgent("Denied old-key agent", agent.configurationId, { harnessAuth }),
      deniedFirst({ action: "operate", resource: harnessAuth.source }),
    );
  }
  iamState.restrictions.length = 0;
  // A requested Secret the Namespace does not hold stays a scope miss, not this 503.
  await assert.rejects(updateAgent(administrator, { harnessAuth: missing }), scopeMiss);
  assert.deepEqual(await stored(), oldHarnessAuth);

  // An update that binds nothing new succeeds, and so does one that clears the old Secret.
  assert.deepEqual((await updateAgent(administrator)).harnessAuth, oldHarnessAuth);
  assert.equal((await updateAgent(administrator, { harnessAuth: null })).harnessAuth, null);

  // A Secret stored through the new driver binds as usual.
  const current = await f.createSecret("replacement-harness-key");
  const harnessAuth = { method: "api_key", source: current.ref };
  assert.deepEqual((await updateAgent(administrator, { harnessAuth })).harnessAuth, harnessAuth);
});

test("after a Secret Driver change an Agent update and deploy wait for its Configuration's Secret bindings", async () => {
  const { agent, createSecret, deploy, grantAgentSecretOperate, iamState, reconfigure, ...f } =
    await fixture();
  const old = await createSecret("gateway-tool-token");
  grantAgentSecretOperate(agent, old);
  // With runtime Harness authentication, only the Configuration binds an old-driver Secret.
  const configuration = await f.assignBound(old, { harnessAuth: { method: "runtime" } });
  const update = (principalId, fields = {}) =>
    f.updateAgent(principalId, { configurationId: configuration.id, ...fields });
  const replacement = f.replaceSecretDriver();

  // Every update names the Configuration, so even an unchanged one is refused, as deploy is,
  // with a message that names the fix. Keeping the binding in a Configuration write fails too.
  await assert.rejects(update(administrator), configurationFix);
  await assert.rejects(deploy(), configurationFix);
  await assert.rejects(reconfigure(configuration.id), configurationFix);
  // A Secret the Namespace does not hold stays a scope miss, not this 503.
  await assert.rejects(
    reconfigure(configuration.id, { secretBindings: gatewayBinding(f.missingRef) }),
    scopeMiss,
  );

  // Grants still answer first: agent:update, then operate on the bound Secret.
  await assert.rejects(
    update(deployer),
    deniedFirst({
      action: "update",
      resource: { kind: "agent", id: agent.id, namespaceId: f.namespace.id },
    }),
  );
  f.denyOperate(old.id);
  await assert.rejects(
    update(administrator),
    deniedFirst({ action: "operate", resource: old.ref }),
  );
  iamState.restrictions.length = 0;

  // Naming another Configuration checks only that one.
  const unbound = await f.configure();
  assert.equal(
    (await update(administrator, { configurationId: unbound.id })).configurationId,
    unbound.id,
  );

  // The Agent's own bound Harness Secret answers before the Configuration's bindings: a caller
  // denied operate on it gets that 403, not the Configuration's 503. The Agent keeps this
  // Secret to the end, so the final deploy admits it through the selected driver too.
  const harnessSecret = await createSecret("harness-key-current");
  grantAgentSecretOperate(agent, harnessSecret);
  await update(administrator, {
    configurationId: unbound.id,
    harnessAuth: { method: "api_key", source: harnessSecret.ref },
  });
  f.denyOperate(harnessSecret.id);
  await assert.rejects(
    update(administrator),
    deniedFirst({ action: "operate", resource: harnessSecret.ref }),
  );
  iamState.restrictions.length = 0;

  // Once the Configuration binds a Secret stored through the selected driver, both proceed.
  const current = await createSecret("gateway-tool-token-current");
  grantAgentSecretOperate(agent, current);
  await reconfigure(configuration.id, { secretBindings: gatewayBinding(current.ref) });
  assert.equal((await update(administrator)).configurationId, configuration.id);
  assert.equal((await deploy()).secretDriverId, replacement.id);
});

/** A Channel Driver that reads one bound Secret through OCC when `binding` is set. */
function createTestChannelDriver(binding) {
  const driver = {
    id: "channel-test",
    capability: "channel",
    implementation: "test-channel",
    binding,
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
  const { configurationDriver, controller, createSecret, iamState, namespace, ...f } =
    await fixture({
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
  const channel = f.select(createTestChannelDriver());
  const oldToken = await createSecret("old-gateway-token");
  const oldKey = await createSecret("old-model-key");
  f.replaceSecretDriver();
  const currentToken = await createSecret("current-gateway-token");
  const currentKey = await createSecret("current-model-key");

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
        secretBindings: gatewayBinding(token.ref),
      },
      harnessAuth: { method: "api_key", source: key.ref },
    });
  const provisioningFix = namesFix(
    ProvisioningSecretDriverError,
    /submit a new provisioning request/,
  );

  // A bound Secret or the Harness key stored through the old driver names the fix, whether the
  // Channel Driver reads it during admission or only the Secret check does.
  for (const binding of [undefined, "GATEWAY_TOOL_TOKEN"]) {
    channel.binding = binding;
    await assert.rejects(provision(oldToken, currentKey), provisioningFix);
    await assert.rejects(provision(currentToken, oldKey), provisioningFix);

    // Grants and the lookup still answer first.
    f.denyOperate(oldToken.id);
    await assert.rejects(
      provision(oldToken, currentKey),
      deniedFirst({ action: "operate", resource: oldToken.ref }),
    );
    iamState.restrictions.length = 0;
    await assert.rejects(provision({ ref: f.missingRef }, currentKey), scopeMiss);

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
  const { agent, deploy, select, ...f } = await fixture();
  const old = await f.createSecret("old-channel-token");
  f.grantAgentSecretOperate(agent, old);
  await f.assignBound(old, { harnessAuth: { method: "runtime" } });
  select(createTestChannelDriver("GATEWAY_TOOL_TOKEN"));
  f.replaceSecretDriver();

  // The Channel Driver reads the binding before admission does; both name the same fix.
  await assert.rejects(deploy(), configurationFix);
  // The deploy grant still answers first.
  await assert.rejects(deploy(metadataReader), deniedFirst());
});

test("an Agent update needs read on its current ServiceAccount, before any lookup", async () => {
  const { controller, iamState, missingRef, namespace, updateAgent } = await fixture();
  grantRole(iamState, administrator, {
    id: "secret-occ-service-account-role",
    permissions: { service_account: ["create", "read"] },
  });
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "harness-account",
  });
  const accountRef = { kind: "service_account", namespaceId: namespace.id, id: account.id };
  await updateAgent(administrator, { harnessAuth: { method: "codex_pat", source: accountRef } });

  // metadataReader may update the Agent but not read the account it binds.
  const missing = { method: "api_key", source: missingRef };
  for (const fields of [{}, { harnessAuth: null }, { harnessAuth: missing }]) {
    await assert.rejects(
      updateAgent(metadataReader, fields),
      deniedFirst({ action: "read", resource: accountRef }),
    );
  }
  bindRole(iamState, metadataReader, {
    id: "secret-occ-metadata-reader-account",
    roleId: "secret-occ-service-account-role",
    namespaceId: namespace.id,
    resource: { kind: "service_account", id: account.id },
  });
  assert.deepEqual((await updateAgent(metadataReader)).harnessAuth, {
    method: "codex_pat",
    source: accountRef,
  });
  assert.equal((await updateAgent(metadataReader, { harnessAuth: null })).harnessAuth, null);
});
