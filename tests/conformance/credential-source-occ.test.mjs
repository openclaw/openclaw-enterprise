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
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const administrator = "principal-source-administrator";
const deployer = "principal-source-deployer";
const zeroGrant = "principal-source-zero-grant";
const updater = "principal-source-updater";
const installation = Object.freeze({
  id: "installation-credential-source-occ",
  name: "Credential source OCC conformance",
  createdAt: "2026-09-26T00:00:00.000Z",
});

/**
 * Test-only Credential Gateway: records what OCC hands it. These cases prove OCC admission,
 * authorization, and lifecycle; injection itself is proved by the real OpenShell integration.
 */
function createTestCredentialGateway(options = {}) {
  const calls = [];
  const stored = new Map();
  const lateCreates = [];
  return {
    id: "credential-gateway-test",
    capability: "credential_gateway",
    implementation: "test-recording-gateway",
    calls,
    stored,
    completeLateCreates() {
      for (const create of lateCreates.splice(0)) {
        create();
      }
    },
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
        {
          type: "registry",
          config: [{ name: "host", required: true }],
          secrets: [],
          rotation: "none",
        },
      ];
    },
    async registerSource(context, input) {
      calls.push({
        operation: "registerSource",
        sourceId: context.source.id,
        namespaceName: context.namespace.name,
        input,
      });
      if (options.registerError !== undefined) {
        throw options.registerError;
      }
      if (options.registerStatus !== undefined) {
        return options.registerStatus;
      }
      // Models a timed-out create that the gateway applies only after OCC's cleanup ran.
      if (options.lateCreate === true) {
        lateCreates.push(() => stored.set(context.source.id, input.secrets));
        throw new Error("registration timed out");
      }
      stored.set(context.source.id, input.secrets);
      // Models a gateway that stored the copy but whose reply was lost.
      if (options.replyError !== undefined) {
        throw options.replyError;
      }
      return { state: "ready" };
    },
    async updateSource(context, input) {
      calls.push({ operation: "updateSource", sourceId: context.source.id, input });
      if (options.updateError !== undefined) {
        throw options.updateError;
      }
      if (options.updateStatus !== undefined) {
        return options.updateStatus;
      }
      if (!stored.has(context.source.id)) {
        return { state: "absent" };
      }
      stored.set(context.source.id, input.secrets);
      return { state: "ready" };
    },
    async rotateSource() {
      throw new Error("not exercised");
    },
    async sourceStatus(context) {
      return stored.has(context.source.id) ? { state: "ready" } : { state: "absent" };
    },
    async removeSource(context) {
      calls.push({ operation: "removeSource", sourceId: context.source.id });
      if (options.removeError?.() !== undefined) {
        throw options.removeError();
      }
      stored.delete(context.source.id);
    },
    async attachForRevision(context) {
      return context.sources.map((source) => ({ sourceId: source.id, ref: `ref-${source.id}` }));
    },
    async attachmentStatus(context) {
      return context.sources.map((source) => ({ sourceId: source.id, state: "ready" }));
    },
    async withdraw() {
      throw new Error("not exercised");
    },
  };
}

function createTestSandbox() {
  return {
    id: "sandbox-test",
    capability: "sandbox",
    implementation: "test-sandbox",
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
}

async function fixture(options = {}) {
  const iamState = {
    identities: [administrator, deployer, zeroGrant, updater].map((id) => ({
      kind: "principal",
      id,
      issuer: "credential-source-occ",
      subject: id,
    })),
    groups: [],
    memberships: [],
    roles: [
      {
        id: "source-administrator-role",
        permissions: [
          { action: "administer", resourceKind: "installation" },
          ...["create", "read", "delete"].map((action) => ({ action, resourceKind: "namespace" })),
          ...["create", "read", "update", "delete"].map((action) => ({
            action,
            resourceKind: "configuration",
          })),
          ...["create", "read", "update", "delete", "operate"].map((action) => ({
            action,
            resourceKind: "secret",
          })),
          ...["create", "read", "update", "delete", "operate"].map((action) => ({
            action,
            resourceKind: "credential_source",
          })),
          ...["create", "read", "update", "delete", "deploy", "operate"].map((action) => ({
            action,
            resourceKind: "agent",
          })),
          { action: "read", resourceKind: "agent_revision" },
        ],
      },
      {
        // May create sources and deploy, but may not operate on the Secret material.
        id: "source-deployer-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "create", resourceKind: "credential_source" },
          { action: "read", resourceKind: "credential_source" },
        ],
      },
      {
        id: "source-agent-role",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      },
      {
        // May update sources but may not operate on the Secret material an update reads.
        id: "source-updater-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "credential_source" },
          { action: "update", resourceKind: "credential_source" },
        ],
      },
    ],
    bindings: [
      {
        id: "source-administrator-binding",
        subjectKind: "identity",
        subjectId: administrator,
        roleId: "source-administrator-role",
      },
      {
        id: "source-deployer-binding",
        subjectKind: "identity",
        subjectId: deployer,
        roleId: "source-deployer-role",
      },
      {
        id: "source-updater-binding",
        subjectKind: "identity",
        subjectId: updater,
        roleId: "source-updater-role",
      },
    ],
    restrictions: [],
  };
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "credential-source-iam" },
  );
  let now = Date.parse("2026-09-27T12:00:00.000Z");
  const state = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, {
    state,
    now: () => new Date(now),
  });
  // Deletion is final only once no timed-out registration could still create a gateway copy.
  function passRegistrationFence() {
    now += 71_000;
  }
  const secretDriver = createTestSecretDriver();
  const gateway = createTestCredentialGateway(options.gateway);
  // Compute owns runtime placement; the gateway must see the same name as the paired Sandbox.
  const compute = {
    ...createDevelopmentComputeDriver({ id: "credential-source-compute" }),
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: `placed-${namespace.id.slice(-12)}` };
    },
  };
  const drivers = [
    iam,
    compute,
    createTestConfigurationDriver({ id: "credential-source-configuration" }),
    secretDriver,
    ...(options.withoutGateway ? [] : [gateway]),
    ...(options.withoutSandbox ? [] : [createTestSandbox()]),
  ];
  for (const driver of drivers) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const namespace = await controller.createNamespace(administrator, { name: "Source tenant" });

  async function makeReady() {
    await controller.handleNamespaceLifecycle(administrator, namespace.id, "ready");
  }

  async function modelSecret() {
    return controller.createSecret(administrator, {
      namespaceId: namespace.id,
      name: `model-key-${crypto.randomUUID()}`,
      value: "synthetic-model-key",
    });
  }

  async function dedicatedAgent() {
    const configuration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: {
        agents: {
          defaults: {
            model: "codex/gpt-5.6-sol",
            models: { "codex/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
      },
    });
    return controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: `dedicated-${crypto.randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
    });
  }

  function grantAgentSourceOperate(agent, source) {
    iamState.identities.push({
      kind: "service_principal",
      id: agent.servicePrincipalId,
      namespaceId: agent.namespaceId,
      agentId: agent.id,
    });
    iamState.bindings.push({
      id: `source-agent-binding-${agent.id}`,
      namespaceId: agent.namespaceId,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: "source-agent-role",
      resourceKind: "credential_source",
      resourceId: source.id,
    });
  }

  return {
    controller,
    dedicatedAgent,
    gateway,
    grantAgentSourceOperate,
    makeReady,
    modelSecret,
    namespace,
    passRegistrationFence,
    secretDriver,
    state,
  };
}

test("registration validates the catalog and hands the gateway values OCC never stores", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
  await assert.rejects(
    controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "before-ready",
      type: "openai",
    }),
    NamespaceNotReadyError,
  );
  await makeReady();
  const secret = await modelSecret();

  // Unknown types, missing required inputs, and unknown fields fail before any gateway effect.
  for (const [input, expected] of [
    [{ type: "unknown" }, /does not support this source type/],
    [{ type: "openai" }, /secrets field api_key is required/],
    [
      { type: "openai", secrets: { api_key: secret.ref, extra: secret.ref } },
      /extra is not supported/,
    ],
    [{ type: "registry" }, /config field host is required/],
  ]) {
    await assert.rejects(
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name: "invalid",
        ...input,
      }),
      expected,
    );
  }
  assert.equal(gateway.calls.length, 0);

  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  assert.equal(source.state, "ready");
  assert.deepEqual(source.status, { state: "ready" });
  assert.deepEqual(source.ref, {
    kind: "credential_source",
    namespaceId: namespace.id,
    id: source.id,
  });
  assert.deepEqual(source.secrets, { api_key: secret.ref });
  // The gateway receives the resolved value; OCC metadata only carries the Secret reference.
  assert.deepEqual(gateway.stored.get(source.id), { api_key: "synthetic-model-key" });
  // The gateway receives Compute's placement, not the Namespace display name.
  assert.equal(
    gateway.calls.find(({ operation }) => operation === "registerSource").namespaceName,
    `placed-${namespace.id.slice(-12)}`,
  );
  assert.equal(JSON.stringify(source).includes("synthetic-model-key"), false);
  const listed = await controller.listCredentialSources(administrator, namespace.id);
  assert.equal(JSON.stringify(listed).includes("synthetic-model-key"), false);
});

test("registration requires operate on every referenced Secret before reading it", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace, secretDriver } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  await assert.rejects(
    controller.createCredentialSource(deployer, {
      namespaceId: namespace.id,
      name: "unauthorized",
      type: "openai",
      secrets: { api_key: secret.ref },
    }),
    AuthorizationDeniedError,
  );
  assert.equal(secretDriver.calls.filter(({ operation }) => operation === "withValue").length, 0);
  assert.equal(gateway.calls.length, 0);
});

function auditEvent(namespaceId, id, action) {
  return {
    id: `aud_${crypto.randomUUID()}`,
    installationId: installation.id,
    namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: administrator,
    source: "occ",
    action,
    resource: { kind: "credential_source", id, namespaceId },
    outcome: "success",
  };
}

async function auditActions(controller) {
  return (await controller.transact((unit) => unit.audit.list()))
    .map(({ action }) => action)
    .filter((action) => action.startsWith("openclaw.credential_sources."));
}

test("credential source writes refuse active and stale borrowed transactions before effects", async () => {
  const {
    controller,
    gateway,
    makeReady,
    modelSecret,
    namespace,
    passRegistrationFence,
    secretDriver,
  } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const input = {
    namespaceId: namespace.id,
    name: "nested-openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  };
  // A top-level create is also the ready record that a nested delete must leave alone.
  const source = await controller.createCredentialSource(administrator, {
    ...input,
    name: "top-level-openai",
  });
  let catalogCalls = 0;
  const listSourceTypes = gateway.listSourceTypes.bind(gateway);
  gateway.listSourceTypes = async (...args) => {
    catalogCalls += 1;
    return listSourceTypes(...args);
  };
  let auditCallbacks = 0;
  const createAudit = (created) => {
    auditCallbacks += 1;
    return auditEvent(namespace.id, created.id, "openclaw.credential_sources.create");
  };
  const deleteAudit = () => {
    auditCallbacks += 1;
    return auditEvent(namespace.id, source.id, "openclaw.credential_sources.delete");
  };
  const snapshot = async (unit) =>
    structuredClone({
      sources: await unit.credentialSources.listCredentialSources(namespace.id),
      audit: await unit.audit.list(),
    });
  const before = await controller.transact(snapshot);
  const gatewayCalls = gateway.calls.length;
  const secretReads = secretDriver.calls.filter(
    ({ operation }) => operation === "withValue",
  ).length;
  const stored = structuredClone(gateway.stored);
  const assertRefused = async (operation) =>
    assert.rejects(operation, (error) => {
      assert.ok(error instanceof ResourceConflictError);
      assert.match(error.message, /cannot run in a controller transaction/);
      return true;
    });
  const attemptBoth = async () => {
    await assertRefused(controller.createCredentialSource(administrator, input, createAudit));
    await assertRefused(
      controller.deleteCredentialSource(administrator, namespace.id, source.id, deleteAudit),
    );
  };

  await controller.transact(async (unit) => {
    await attemptBoth();
    assert.deepEqual(await snapshot(unit), before);
  });

  // The async task inherits the unit of work, but is released only after its owner commits.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let staleAttempt;
  await controller.transact(async () => {
    staleAttempt = (async () => {
      await gate;
      await attemptBoth();
    })();
  });
  release();
  await staleAttempt;
  assert.deepEqual(await controller.transact(snapshot), before);
  assert.equal(
    secretDriver.calls.filter(({ operation }) => operation === "withValue").length,
    secretReads,
  );
  assert.equal(catalogCalls, 0);
  assert.equal(gateway.calls.length, gatewayCalls);
  assert.deepEqual(gateway.stored, stored);
  assert.equal(auditCallbacks, 0);

  // The boundary check must not prevent ordinary independent create and delete phases.
  const second = await controller.createCredentialSource(administrator, input);
  assert.equal(second.state, "ready");
  passRegistrationFence();
  await controller.deleteCredentialSource(administrator, namespace.id, source.id);
  await controller.deleteCredentialSource(administrator, namespace.id, second.id);
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
});

test("a definitive registration failure removes the gateway copy and the record", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
    gateway: { registerStatus: { state: "failed", reason: "rejected" } },
  });
  await makeReady();
  const secret = await modelSecret();
  await assert.rejects(
    controller.createCredentialSource(
      administrator,
      {
        namespaceId: namespace.id,
        name: "openai",
        type: "openai",
        secrets: { api_key: secret.ref },
      },
      (source) => auditEvent(namespace.id, source.id, "openclaw.credential_sources.create"),
    ),
    DependencyUnavailableError,
  );
  // The gateway answered, so no create is still in flight and the record can go at once.
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  assert.deepEqual(
    gateway.calls.map(({ operation }) => operation),
    ["registerSource", "removeSource"],
  );
  // Only a completed registration is audited as a successful mutation.
  assert.deepEqual(await auditActions(controller), []);
});

test("a timed-out registration keeps its record until a late gateway create is removed", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace, passRegistrationFence } =
    await fixture({ gateway: { lateCreate: true } });
  await makeReady();
  const secret = await modelSecret();
  await assert.rejects(
    controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    }),
    DependencyUnavailableError,
  );
  // Cleanup found no copy, but the outcome was unknown, so OCC keeps the cleanup handle.
  const [orphan] = await controller.listCredentialSources(administrator, namespace.id);
  assert.equal(orphan.state, "deleting");
  assert.equal(gateway.stored.has(orphan.id), false);
  gateway.completeLateCreates();
  assert.equal(gateway.stored.has(orphan.id), true);

  // Within the fence, DELETE removes the copy but keeps the record for a later retry.
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, orphan.id),
    DependencyUnavailableError,
  );
  assert.equal(gateway.stored.has(orphan.id), false);
  assert.equal(
    (await controller.readCredentialSource(administrator, namespace.id, orphan.id)).state,
    "deleting",
  );
  passRegistrationFence();
  await controller.deleteCredentialSource(administrator, namespace.id, orphan.id);
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
});

test("an uncertain registration whose cleanup fails stays listed until DELETE removes the copy", async () => {
  let failRemove = true;
  const { controller, gateway, makeReady, modelSecret, namespace, passRegistrationFence } =
    await fixture({
      gateway: {
        replyError: new Error("reply lost"),
        removeError: () => (failRemove ? new Error("gateway unavailable") : undefined),
      },
    });
  await makeReady();
  const secret = await modelSecret();
  // The gateway stored a copy but OCC never learned the outcome, and cleanup failed too.
  await assert.rejects(
    controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    }),
    DependencyUnavailableError,
  );
  const [orphan] = await controller.listCredentialSources(administrator, namespace.id);
  assert.equal(orphan.state, "deleting");
  assert.equal(gateway.stored.has(orphan.id), true);

  // The record keeps the provider identity, so an ordinary DELETE retry removes the copy.
  failRemove = false;
  passRegistrationFence();
  await controller.deleteCredentialSource(administrator, namespace.id, orphan.id);
  assert.equal(gateway.stored.has(orphan.id), false);
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
});

test("registration and deletion commit their audit events with the final state change", async () => {
  const { controller, makeReady, modelSecret, namespace, passRegistrationFence } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(
    administrator,
    { namespaceId: namespace.id, name: "openai", type: "openai", secrets: { api_key: secret.ref } },
    (created) => auditEvent(namespace.id, created.id, "openclaw.credential_sources.create"),
  );
  assert.equal(source.state, "ready");
  assert.deepEqual(await auditActions(controller), ["openclaw.credential_sources.create"]);
  passRegistrationFence();

  // An audit that cannot be appended rolls back the removal, so DELETE can be retried.
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id, () => ({
      ...auditEvent(namespace.id, source.id, "openclaw.credential_sources.delete"),
      installationId: "ins_other",
    })),
    ScopeViolationError,
  );
  const retained = await controller.readCredentialSource(administrator, namespace.id, source.id);
  assert.equal(retained.state, "deleting");
  await controller.deleteCredentialSource(administrator, namespace.id, source.id, () =>
    auditEvent(namespace.id, source.id, "openclaw.credential_sources.delete"),
  );
  assert.deepEqual(await auditActions(controller), [
    "openclaw.credential_sources.create",
    "openclaw.credential_sources.delete",
  ]);
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
});

test("deletion is refused while referenced, retried while the gateway fails, and gates the Namespace", async () => {
  let failRemove = false;
  const {
    controller,
    dedicatedAgent,
    gateway,
    makeReady,
    modelSecret,
    namespace,
    passRegistrationFence,
  } = await fixture({
    gateway: { removeError: () => (failRemove ? new Error("gateway unavailable") : undefined) },
  });
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "credential_source", sourceId: source.id },
  });

  // A bound source and its Secret cannot be removed out from under the Agent.
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id),
    ResourceConflictError,
  );
  await assert.rejects(controller.deleteSecret(administrator, namespace.id, secret.id));
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: null,
  });

  // A gateway failure keeps the record `deleting` so the caller can retry.
  failRemove = true;
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id),
    DependencyUnavailableError,
  );
  const deleting = await controller.readCredentialSource(administrator, namespace.id, source.id);
  assert.equal(deleting.state, "deleting");
  // A deleting source cannot be bound again, and it still makes the Namespace nonempty.
  await assert.rejects(
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: source.id },
    }),
    ScopeViolationError,
  );

  failRemove = false;
  passRegistrationFence();
  await controller.deleteCredentialSource(administrator, namespace.id, source.id);
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  assert.equal(gateway.stored.has(source.id), false);
});

test("a credential source, including one being deleted, keeps its Namespace nonempty", async () => {
  let failRemove = false;
  const { controller, makeReady, namespace, passRegistrationFence } = await fixture({
    gateway: { removeError: () => (failRemove ? new Error("gateway unavailable") : undefined) },
  });
  await makeReady();
  // A secretless source is the Namespace's only resource, so only the source guard can refuse.
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
  });
  await assert.rejects(
    controller.deleteNamespace(administrator, namespace.id),
    NamespaceNotEmptyError,
  );
  failRemove = true;
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id),
    DependencyUnavailableError,
  );
  await assert.rejects(
    controller.deleteNamespace(administrator, namespace.id),
    NamespaceNotEmptyError,
  );
  failRemove = false;
  passRegistrationFence();
  await controller.deleteCredentialSource(administrator, namespace.id, source.id);
  await controller.deleteNamespace(administrator, namespace.id);
});

test("an update re-sends current or replacement Secret values and keeps config immutable", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace, state } = await fixture();
  await makeReady();
  const original = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: original.ref },
  });

  // A bare update re-reads the referenced Secret, so a changed Secret reaches the gateway copy.
  await controller.updateSecret(administrator, {
    namespaceId: namespace.id,
    secretId: original.id,
    value: "rotated-model-key",
  });
  const resynced = await controller.updateCredentialSource(administrator, {
    namespaceId: namespace.id,
    credentialSourceId: source.id,
  });
  assert.deepEqual(resynced.status, { state: "ready" });
  assert.deepEqual(gateway.stored.get(source.id), { api_key: "rotated-model-key" });
  // Only the gateway holds the value: the response, the read, and OCC's record carry references.
  assert.equal(JSON.stringify(resynced).includes("rotated-model-key"), false);
  const reread = await controller.readCredentialSource(administrator, namespace.id, source.id);
  assert.equal(JSON.stringify(reread).includes("rotated-model-key"), false);
  const persisted = await state.read((view) =>
    view.credentialSources.findCredentialSource(namespace.id, source.id),
  );
  assert.equal(JSON.stringify(persisted).includes("rotated-model-key"), false);

  // Replacement references switch the source to another same-Namespace Secret.
  const replacement = await modelSecret();
  const replaced = await controller.updateCredentialSource(administrator, {
    namespaceId: namespace.id,
    credentialSourceId: source.id,
    secrets: { api_key: replacement.ref },
  });
  assert.deepEqual(replaced.secrets, { api_key: replacement.ref });
  assert.deepEqual(gateway.stored.get(source.id), { api_key: "synthetic-model-key" });
  assert.equal(JSON.stringify(replaced).includes("synthetic-model-key"), false);
  // The original Secret is no longer referenced by the source, so it can now be deleted.
  await controller.deleteSecret(administrator, namespace.id, original.id);

  // Replacements must keep the catalog's exact fields.
  await assert.rejects(
    controller.updateCredentialSource(administrator, {
      namespaceId: namespace.id,
      credentialSourceId: source.id,
      secrets: { api_key: replacement.ref, extra: replacement.ref },
    }),
    /extra is not supported/,
  );
});

test("an update requires update on the source and operate on every Secret it reads", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
    gateway: {},
  });
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  // The deployer may read and create sources but holds neither update nor Secret operate.
  await assert.rejects(
    controller.updateCredentialSource(deployer, {
      namespaceId: namespace.id,
      credentialSourceId: source.id,
    }),
    AuthorizationDeniedError,
  );
  // Update on the source alone is not enough: every Secret it reads needs operate too.
  await assert.rejects(
    controller.updateCredentialSource(updater, {
      namespaceId: namespace.id,
      credentialSourceId: source.id,
    }),
    (error) =>
      error instanceof AuthorizationDeniedError &&
      error.authorization?.resource.kind === "secret" &&
      error.authorization.resource.id === secret.id,
  );
  assert.equal(gateway.calls.filter(({ operation }) => operation === "updateSource").length, 0);
});

test("an update whose commit fails after the gateway accepted it converges when repeated", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const original = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: original.ref },
  });
  const replacement = await modelSecret();
  await controller.updateSecret(administrator, {
    namespaceId: namespace.id,
    secretId: replacement.id,
    value: "replacement-model-key",
  });
  const input = {
    namespaceId: namespace.id,
    credentialSourceId: source.id,
    secrets: { api_key: replacement.ref },
  };

  // The gateway call runs inside the request's transaction; a later failure, such as its
  // audit append, rolls back OCC's references while the gateway copy is already newer.
  await assert.rejects(
    controller.transact(async () => {
      await controller.updateCredentialSource(administrator, input);
      throw new Error("audit append failed");
    }),
    /audit append failed/,
  );
  assert.deepEqual(gateway.stored.get(source.id), { api_key: "replacement-model-key" });
  const retained = await controller.readCredentialSource(administrator, namespace.id, source.id);
  assert.deepEqual(retained.secrets, { api_key: original.ref });

  // Repeating the same request brings OCC level with the gateway.
  const repeated = await controller.updateCredentialSource(administrator, input);
  assert.deepEqual(repeated.secrets, { api_key: replacement.ref });
  assert.deepEqual(gateway.stored.get(source.id), { api_key: "replacement-model-key" });
});

for (const [failure, gatewayOptions] of [
  ["throws", { updateError: new Error("gateway unavailable") }],
  // The gateway lost its copy while OCC still records the source as ready.
  ["reports the copy absent", { updateStatus: { state: "absent" } }],
  ["reports the update failed", { updateStatus: { state: "failed" } }],
]) {
  test(`a gateway update that ${failure} keeps the source and its Secret references unchanged`, async () => {
    const { controller, makeReady, modelSecret, namespace } = await fixture({
      gateway: gatewayOptions,
    });
    await makeReady();
    const original = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: original.ref },
    });
    const replacement = await modelSecret();
    await assert.rejects(
      controller.updateCredentialSource(administrator, {
        namespaceId: namespace.id,
        credentialSourceId: source.id,
        secrets: { api_key: replacement.ref },
      }),
      DependencyUnavailableError,
    );
    const retained = await controller.readCredentialSource(administrator, namespace.id, source.id);
    assert.equal(retained.state, "ready");
    assert.deepEqual(retained.secrets, { api_key: original.ref });
  });
}

test("withdrawal is recorded for the active revision and queued for the worker once", async () => {
  const {
    controller,
    dedicatedAgent,
    grantAgentSourceOperate,
    makeReady,
    modelSecret,
    namespace,
    state,
  } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "credential_source", sourceId: source.id },
  });
  grantAgentSourceOperate(agent, source);
  const request = { namespaceId: namespace.id, agentId: agent.id, credentialSourceId: source.id };

  // Withdrawal revokes a running revision's access, so the Agent needs an active revision.
  await assert.rejects(
    controller.withdrawAgentCredentialSource(administrator, request),
    ResourceConflictError,
  );
  const revision = await controller.deployAgent(
    administrator,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedDevelopmentHarness,
  );
  await controller.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
  );
  const withdrawalWork = () =>
    state
      .pendingOperations()
      .filter(
        (operation) =>
          operation.kind === "agent_revision" && operation.target === "credentials_withdrawn",
      );

  // Withdrawal requires operate on the Agent, which the deployer lacks.
  await assert.rejects(
    controller.withdrawAgentCredentialSource(deployer, request),
    AuthorizationDeniedError,
  );
  const withdrawal = await controller.withdrawAgentCredentialSource(administrator, request);
  assert.equal(withdrawal.state, "pending");
  assert.equal(withdrawal.revisionId, revision.id);
  assert.equal(withdrawal.requestedBy, administrator);
  assert.equal(withdrawalWork().length, 1);
  assert.equal(withdrawalWork()[0].resourceId, revision.id);
  assert.deepEqual(
    await controller.readAgentCredentialWithdrawal(administrator, request),
    withdrawal,
  );

  // A replay keeps the same withdrawal; while the first attempt is outstanding it queues none.
  assert.deepEqual(
    await controller.withdrawAgentCredentialSource(administrator, request),
    withdrawal,
  );
  assert.equal(withdrawalWork().length, 1);

  // Only the source the active revision authenticates with can be withdrawn.
  const other = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "other",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  await assert.rejects(
    controller.withdrawAgentCredentialSource(administrator, {
      ...request,
      credentialSourceId: other.id,
    }),
    ScopeViolationError,
  );
  // A withdrawn source stays referenced by the active revision until a redeploy replaces it.
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id),
    ResourceConflictError,
  );
});

test("deploy admission freezes the source and requires the Agent principal to operate it", async () => {
  const {
    controller,
    dedicatedAgent,
    gateway,
    grantAgentSourceOperate,
    makeReady,
    modelSecret,
    namespace,
  } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "credential_source", sourceId: source.id },
  });
  const deploy = () =>
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );

  await assert.rejects(deploy(), AuthorizationDeniedError);
  grantAgentSourceOperate(agent, source);
  const revision = await deploy();
  assert.deepEqual(revision.harnessAuth, {
    method: "credential_source",
    sourceId: source.id,
    credentialGatewayId: gateway.id,
    sourceType: "openai",
    loginMode: "api_key",
  });
});

test("Namespace IAM delegates operate on an exact credential source to an Agent principal", async () => {
  const { controller, dedicatedAgent, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const agent = await dedicatedAgent();
  // Operators grant deployment access through the Namespace IAM API, so the policy surface
  // must accept credential_source Roles and exact source targets like other Namespace kinds.
  const role = await controller.createIAMRole(administrator, {
    namespaceId: namespace.id,
    name: "Use a credential source",
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const binding = await controller.createIAMAccessBinding(administrator, {
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: source.id,
  });
  assert.equal(binding.resourceId, source.id);
  // A target outside the Namespace's credential sources is refused before policy is written.
  await assert.rejects(
    controller.createIAMAccessBinding(administrator, {
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: role.id,
      resourceKind: "credential_source",
      resourceId: "cs_00000000-0000-4000-8000-000000000000",
    }),
    ScopeViolationError,
  );
});

test("listing credential sources requires Namespace read before filtering each source", async () => {
  const { controller, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  // Without Namespace read, an existing and a missing Namespace are indistinguishable.
  for (const namespaceId of [namespace.id, "ns_00000000-0000-4000-8000-000000000000"]) {
    await assert.rejects(
      controller.listCredentialSources(zeroGrant, namespaceId),
      AuthorizationDeniedError,
    );
  }
  const listed = await controller.listCredentialSources(deployer, namespace.id);
  assert.deepEqual(
    listed.map(({ id }) => id),
    [source.id],
  );
});

test("a selected Credential Gateway rejects Secret-backed Harness authentication", async () => {
  const { controller, dedicatedAgent, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  // There is no environment-delivery fallback once a gateway owns model credentials.
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    /requires credential-source Harness authentication/,
  );
});
