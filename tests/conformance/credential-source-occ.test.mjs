import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AgentCredentialSourceBindingError,
  AuthorizationDeniedError,
  CredentialGatewayNotConfiguredError,
  CredentialSourceDriverError,
  CredentialSourceTypeNotOfferedError,
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
import { grantRole } from "../helpers/iam-grants.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const administrator = "principal-source-administrator";
const deployer = "principal-source-deployer";
const zeroGrant = "principal-source-zero-grant";
const updater = "principal-source-updater";
const editor = "principal-agent-editor";
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
        {
          type: "oauth-client",
          config: [{ name: "client_id", required: true }],
          secrets: [{ name: "client_secret", required: true }],
          rotation: "refresh",
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

/**
 * Test-only Credential Refresh Driver: records OCC's calls in the gateway's call log, so cases
 * can assert ordering across both roles. Real minting is proved against OpenShell and Keycloak.
 */
function createTestCredentialRefresh(calls, options = {}) {
  const configured = new Map();
  return {
    id: "credential-refresh-test",
    capability: "credential_refresh",
    implementation: "test-recording-refresh",
    configured,
    async configureRefresh(context, input) {
      calls.push({ operation: "configureRefresh", sourceId: context.source.id, input });
      configured.set(context.source.id, input.secrets);
      return { state: "pending" };
    },
    async rotate(context, requestId) {
      calls.push({ operation: "rotate", sourceId: context.source.id, requestId });
      return (
        options.rotateStatus ?? { state: "ready", lastRefreshAt: "2026-09-27T12:00:00.000000000Z" }
      );
    },
    async refreshStatus(context) {
      calls.push({ operation: "refreshStatus", sourceId: context.source.id });
      return { state: "ready", expiresAt: "2026-09-27T13:00:00.000000000Z" };
    },
    async removeRefresh(context) {
      calls.push({ operation: "removeRefresh", sourceId: context.source.id });
      configured.delete(context.source.id);
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
    identities: [administrator, deployer, zeroGrant, updater, editor].map((id) => ({
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
        // May edit Agents but may not operate on any credential source.
        id: "agent-editor-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "configuration" },
          { action: "read", resourceKind: "agent" },
          { action: "update", resourceKind: "agent" },
        ],
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
        id: "agent-editor-binding",
        subjectKind: "identity",
        subjectId: editor,
        roleId: "agent-editor-role",
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
  const refresh = createTestCredentialRefresh(gateway.calls, options.refresh);
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
    ...(options.withoutRefresh || options.withoutGateway ? [] : [refresh]),
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

  function grantAgentSourceOperate(agent, source, suffix) {
    if (!iamState.identities.some(({ id }) => id === agent.servicePrincipalId)) {
      iamState.identities.push({
        kind: "service_principal",
        id: agent.servicePrincipalId,
        namespaceId: agent.namespaceId,
        agentId: agent.id,
      });
    }
    iamState.bindings.push({
      id: `source-agent-binding-${agent.id}${suffix === undefined ? "" : `-${suffix}`}`,
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
    iamState,
    makeReady,
    modelSecret,
    namespace,
    passRegistrationFence,
    refresh,
    secretDriver,
    state,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function refreshSource(context, name = "oauth-client") {
  const secret = await context.controller.createSecret(administrator, {
    namespaceId: context.namespace.id,
    name: `client-secret-${crypto.randomUUID()}`,
    value: "synthetic-client-secret",
  });
  const source = await context.controller.createCredentialSource(administrator, {
    namespaceId: context.namespace.id,
    name,
    type: "oauth-client",
    config: { client_id: "occ-tools" },
    secrets: { client_secret: secret.ref },
  });
  return { secret, source };
}

test("a refresh source is ready only after its first mint, and its material is not a gateway value", async () => {
  const context = await fixture();
  await context.makeReady();
  const { secret, source } = await refreshSource(context);
  assert.equal(source.state, "ready");
  assert.deepEqual(source.status, {
    state: "ready",
    refresh: { state: "ready", lastRefreshAt: "2026-09-27T12:00:00.000000000Z" },
  });
  // The gateway registers the source first; refresh material goes only to the refresh role,
  // which then mints the first token. Each step carries a UUID request ID for replay.
  const calls = context.gateway.calls.filter(({ sourceId }) => sourceId === source.id);
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    ["registerSource", "configureRefresh", "rotate"],
  );
  // Custody boundary: the gateway registers config only and never receives the issuer secret.
  assert.deepEqual(calls[0].input.secrets, {});
  assert.deepEqual(calls[1].input.secrets, { client_secret: "synthetic-client-secret" });
  assert.deepEqual(calls[1].input.config, { client_id: "occ-tools" });
  assert.match(calls[1].input.requestId, UUID);
  assert.match(calls[2].requestId, UUID);
  assert.notEqual(calls[1].input.requestId, calls[2].requestId);
  assert.deepEqual(source.secrets, { client_secret: secret.ref });
  assert.equal(JSON.stringify(source).includes("synthetic-client-secret"), false);
});

test("a refresh type needs a selected Credential Refresh Driver before any gateway effect", async () => {
  const context = await fixture({ withoutRefresh: true });
  await context.makeReady();
  await assert.rejects(refreshSource(context), DependencyUnavailableError);
  assert.equal(context.gateway.calls.length, 0);
  assert.deepEqual(
    await context.controller.listCredentialSources(administrator, context.namespace.id),
    [],
  );
});

test("a refresh source whose first mint fails is removed from the gateway and from OCC", async () => {
  const context = await fixture({
    refresh: {
      rotateStatus: {
        state: "failed",
        failureCode: "oauth_invalid_client",
        recoveryAction: "fix_configuration",
      },
    },
  });
  await context.makeReady();
  // The Driver's safe failure code reaches the caller; the issuer's own text never does.
  await assert.rejects(
    refreshSource(context),
    (error) =>
      error instanceof DependencyUnavailableError && /oauth_invalid_client/.test(error.message),
  );
  assert.deepEqual(
    context.gateway.calls.map(({ operation }) => operation),
    ["registerSource", "configureRefresh", "rotate", "removeRefresh", "removeSource"],
  );
  assert.equal(context.refresh.configured.size, 0);
  assert.equal(context.gateway.stored.size, 0);
  assert.deepEqual(
    await context.controller.listCredentialSources(administrator, context.namespace.id),
    [],
  );
});

test("rotation needs update on a refresh source, reads no Secret, and refuses static types", async () => {
  const context = await fixture();
  await context.makeReady();
  const { source } = await refreshSource(context);
  const input = { namespaceId: context.namespace.id, credentialSourceId: source.id };
  await assert.rejects(
    context.controller.rotateCredentialSource(deployer, input),
    AuthorizationDeniedError,
  );
  // The updater holds update on sources but no Secret operate: rotation reads no material.
  const rotated = await context.controller.rotateCredentialSource(updater, input);
  assert.equal(rotated.status.refresh.state, "ready");
  assert.equal(context.gateway.calls.filter(({ operation }) => operation === "rotate").length, 2);
  // Rotation forces a mint with the stored material; it never reconfigures the source.
  assert.equal(
    context.gateway.calls.filter(({ operation }) => operation === "configureRefresh").length,
    1,
  );

  // A static source has no issuer; rotating it means updating its Secret values instead.
  const model = await context.modelSecret();
  const staticSource = await context.controller.createCredentialSource(administrator, {
    namespaceId: context.namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: model.ref },
  });
  await assert.rejects(
    context.controller.rotateCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      credentialSourceId: staticSource.id,
    }),
    (error) => error instanceof ResourceConflictError && /refresh-type/.test(error.message),
  );
});

test("an update reconfigures refresh material and mints again instead of pushing a value", async () => {
  const context = await fixture();
  await context.makeReady();
  const { source } = await refreshSource(context);
  const replacement = await context.controller.createSecret(administrator, {
    namespaceId: context.namespace.id,
    name: `client-secret-${crypto.randomUUID()}`,
    value: "replacement-client-secret",
  });
  const before = context.gateway.calls.length;
  const updated = await context.controller.updateCredentialSource(administrator, {
    namespaceId: context.namespace.id,
    credentialSourceId: source.id,
    secrets: { client_secret: replacement.ref },
  });
  assert.deepEqual(updated.secrets, { client_secret: replacement.ref });
  assert.equal(updated.status.refresh.state, "ready");
  const calls = context.gateway.calls.slice(before);
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    ["configureRefresh", "rotate"],
  );
  assert.deepEqual(calls[0].input.secrets, { client_secret: "replacement-client-secret" });
  assert.equal(JSON.stringify(updated).includes("replacement-client-secret"), false);
});

test("reading a refresh source reports its refresh status, and deletion removes refresh first", async () => {
  const context = await fixture();
  await context.makeReady();
  const { source } = await refreshSource(context);
  const read = await context.controller.readCredentialSource(
    administrator,
    context.namespace.id,
    source.id,
  );
  assert.deepEqual(read.status, {
    state: "ready",
    refresh: { state: "ready", expiresAt: "2026-09-27T13:00:00.000000000Z" },
  });
  context.passRegistrationFence();
  const before = context.gateway.calls.length;
  await context.controller.deleteCredentialSource(administrator, context.namespace.id, source.id);
  assert.deepEqual(
    context.gateway.calls.slice(before).map(({ operation }) => operation),
    ["removeRefresh", "removeSource"],
  );
});

test("reading a source whose type left the catalog keeps the gateway's status", async () => {
  const context = await fixture();
  await context.makeReady();
  const tool = await context.controller.createCredentialSource(administrator, {
    namespaceId: context.namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
  });
  const { source: refresh } = await refreshSource(context);
  // Removing an Installation setting, such as OpenShell's toolBinaries, withdraws types from
  // the catalog. Existing sources stay registered, so a read must still report the gateway's
  // own status rather than a false failure.
  context.gateway.listSourceTypes = async () => [];
  const read = (source) =>
    context.controller.readCredentialSource(administrator, context.namespace.id, source.id);
  assert.deepEqual((await read(tool)).status, { state: "ready" });
  // An unoffered refresh type cannot be classified, so its read omits refresh status.
  assert.deepEqual((await read(refresh)).status, { state: "ready" });
});

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
    [{ type: "unknown" }, CredentialSourceTypeNotOfferedError],
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

test("a cross-Namespace Secret is an invalid request; a Secret the Namespace lacks stays not-found", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace, secretDriver } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  gateway.calls.length = 0;
  secretDriver.calls.length = 0;
  const foreign = { ...secret.ref, namespaceId: `ns_${crypto.randomUUID()}` };
  const missing = { ...secret.ref, id: `sec_${crypto.randomUUID()}` };
  const writes = [
    [
      "create",
      (ref) =>
        controller.createCredentialSource(administrator, {
          namespaceId: namespace.id,
          name: `openai-${crypto.randomUUID().slice(0, 8)}`,
          type: "openai",
          secrets: { api_key: ref },
        }),
    ],
    [
      "update",
      (ref) =>
        controller.updateCredentialSource(administrator, {
          namespaceId: namespace.id,
          credentialSourceId: source.id,
          secrets: { api_key: ref },
        }),
    ],
  ];
  for (const [write, call] of writes) {
    for (const [description, ref, expected] of [
      [
        "cross-Namespace Secret",
        foreign,
        {
          status: 400,
          code: "INVALID_REQUEST",
          message: "Credential source Secrets cannot cross Namespaces.",
        },
      ],
      [
        "missing Secret",
        missing,
        {
          status: 404,
          code: "NOT_FOUND",
          message: "The requested platform resource was not found.",
        },
      ],
    ]) {
      const rejection = await call(ref).then(
        () => assert.fail(`${write}, ${description}: expected a rejection`),
        (error) => error,
      );
      const { status, code, message } = requestFailure(rejection);
      assert.deepEqual({ status, code, message }, expected, `${write}, ${description}`);
    }
  }
  // Every reference is checked before any of them is authorized: a foreign second field wins
  // over a first field the deployer may not operate.
  const listSourceTypes = gateway.listSourceTypes.bind(gateway);
  gateway.listSourceTypes = async (...args) => [
    ...(await listSourceTypes(...args)),
    {
      type: "pair",
      config: [],
      secrets: [
        { name: "first", required: true },
        { name: "second", required: true },
      ],
      rotation: "none",
    },
  ];
  const mixed = await controller
    .createCredentialSource(deployer, {
      namespaceId: namespace.id,
      name: "pair",
      type: "pair",
      secrets: { first: secret.ref, second: foreign },
    })
    .then(
      () => assert.fail("a foreign second field must be rejected"),
      (error) => error,
    );
  const { status, code, message } = requestFailure(mixed);
  assert.deepEqual(
    { status, code, message },
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Credential source Secrets cannot cross Namespaces.",
    },
  );
  assert.deepEqual(gateway.calls, []);
  assert.equal(secretDriver.calls.filter(({ operation }) => operation === "withValue").length, 0);
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
    credentialSources: [{ sourceId: source.id }],
  });

  // A bound source and its Secret cannot be removed out from under the Agent.
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id),
    ResourceConflictError,
  );
  await assert.rejects(
    controller.deleteSecret(administrator, namespace.id, secret.id),
    (error) =>
      error instanceof ResourceConflictError &&
      error.message ===
        `The Secret is still referenced by credential source ${source.id}. Remove those references first.`,
  );
  // The list holds the reference, so unbinding clears both the Harness binding and the list.
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: null,
    credentialSources: [],
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
      credentialSources: [{ sourceId: source.id }],
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
    credentialSources: [{ sourceId: source.id }],
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

  // Only a source the active revision was admitted with can be withdrawn.
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

test("withdrawal also covers each admitted successor revision that holds the source", async () => {
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
  const model = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: (await modelSecret()).ref },
  });
  const registry = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
  });
  const agent = await dedicatedAgent();
  const bind = (credentialSources) =>
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: model.id },
      credentialSources,
    });
  await bind([{ sourceId: model.id }, { sourceId: registry.id }]);
  grantAgentSourceOperate(agent, model);
  grantAgentSourceOperate(agent, registry, "registry");
  const deploy = () =>
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
  const activate = (from, to) =>
    controller.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, from, to),
    );
  const rows = (revision) =>
    controller.transact((unit) =>
      unit.credentialSources.listCredentialWithdrawals(namespace.id, revision.id),
    );
  const workFor = (revision) =>
    state
      .pendingOperations()
      .filter(
        (operation) =>
          operation.kind === "agent_revision" &&
          operation.target === "credentials_withdrawn" &&
          operation.resourceId === revision.id,
      );
  const first = await deploy();
  await activate(undefined, first.id);
  // Two deployments are admitted but not active yet; only the first still holds the registry.
  const second = await deploy();
  await bind([{ sourceId: model.id }]);
  const third = await deploy();
  const request = { namespaceId: namespace.id, agentId: agent.id, credentialSourceId: registry.id };

  const withdrawal = await controller.withdrawAgentCredentialSource(administrator, request);
  assert.equal(withdrawal.revisionId, first.id);
  assert.equal(withdrawal.state, "pending");
  // The successor gets its own pending row and work, so its deployment cannot attach the source.
  const [successorRow] = await rows(second);
  assert.equal(successorRow.state, "pending");
  assert.equal(successorRow.credentialSourceId, registry.id);
  assert.equal(successorRow.requestedBy, administrator);
  assert.equal(workFor(first).length, 1);
  assert.equal(workFor(second).length, 1);
  assert.deepEqual(await rows(third), []);
  assert.equal(workFor(third).length, 0);
  // A replay keeps both rows and queues nothing while their attempts are outstanding.
  assert.deepEqual(
    await controller.withdrawAgentCredentialSource(administrator, request),
    withdrawal,
  );
  assert.equal(workFor(first).length + workFor(second).length, 2);

  // Once the successor activates, the read reports its withdrawal instead of a 404.
  await activate(first.id, second.id);
  const read = await controller.readAgentCredentialWithdrawal(administrator, request);
  assert.equal(read.revisionId, second.id);
  assert.equal(read.state, "pending");

  // A revoked withdrawal on the active revision still reaches a later successor, and the
  // response reports that successor's pending withdrawal instead of the revoked one. (The
  // in-memory store never retires the first revision, so its withdrawal is revoked here too.)
  for (const revision of [first, second]) {
    await controller.transact((unit) =>
      unit.credentialSources.markCredentialWithdrawalRevoked(
        namespace.id,
        revision.id,
        registry.id,
        new Date().toISOString(),
      ),
    );
  }
  await bind([{ sourceId: model.id }, { sourceId: registry.id }]);
  const fourth = await deploy();
  const replay = await controller.withdrawAgentCredentialSource(administrator, request);
  assert.equal(replay.revisionId, fourth.id);
  assert.equal(replay.state, "pending");
  assert.equal(replay.withdrawalInProgress, true);
  const [laterRow] = await rows(fourth);
  assert.equal(laterRow.state, "pending");
  assert.equal(workFor(fourth).length, 1);
  assert.deepEqual(await rows(third), []);
  const pendingRead = await controller.readAgentCredentialWithdrawal(administrator, request);
  assert.equal(pendingRead.revisionId, fourth.id);
  assert.equal(pendingRead.withdrawalInProgress, true);

  // Once every revision that may run with the source confirmed it, the active one is reported.
  await controller.transact((unit) =>
    unit.credentialSources.markCredentialWithdrawalRevoked(
      namespace.id,
      fourth.id,
      registry.id,
      new Date().toISOString(),
    ),
  );
  const revokedRead = await controller.readAgentCredentialWithdrawal(administrator, request);
  assert.equal(revokedRead.revisionId, second.id);
  assert.equal(revokedRead.state, "revoked");
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
    credentialSources: [{ sourceId: source.id }],
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

test("one credentialSources list binds every source, and harnessAuth names a listed one", async () => {
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
  const model = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const otherModel = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai-other",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  // A type without Harness authentication, such as a registry token.
  const registry = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
  });
  const agent = await dedicatedAgent();
  const update = (principalId, fields) =>
    controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...fields,
    });

  // harnessAuth only points into the list, so the source it names must be listed. The
  // rule names itself as an invalid request instead of the generic not-found.
  const unlisted = await update(administrator, {
    harnessAuth: { method: "credential_source", sourceId: model.id },
    credentialSources: [{ sourceId: registry.id }],
  }).catch((error) => error);
  assert.ok(unlisted instanceof AgentCredentialSourceBindingError);
  assert.deepEqual(
    (({ status, code, message }) => ({ status, code, message }))(requestFailure(unlisted)),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The Harness credential source must be listed in the Agent's credentialSources.",
    },
  );
  await assert.rejects(
    update(administrator, {
      credentialSources: [{ sourceId: registry.id }, { sourceId: registry.id }],
    }),
    ScopeViolationError,
  );
  // Binding needs operate on the exact source, which an Agent editor alone lacks.
  await assert.rejects(
    update(editor, { credentialSources: [{ sourceId: registry.id }] }),
    AuthorizationDeniedError,
  );
  const bound = await update(administrator, {
    harnessAuth: { method: "credential_source", sourceId: model.id },
    credentialSources: [{ sourceId: model.id }, { sourceId: registry.id }],
  });
  assert.deepEqual(bound.credentialSources, [{ sourceId: model.id }, { sourceId: registry.id }]);
  // Dropping the Harness source from the list while harnessAuth still names it is refused.
  await assert.rejects(
    update(administrator, { credentialSources: [{ sourceId: registry.id }] }),
    AgentCredentialSourceBindingError,
  );

  // Admission rechecks every listed source for the Agent principal.
  const deploy = () =>
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
  grantAgentSourceOperate(agent, model);
  await assert.rejects(deploy(), AuthorizationDeniedError);
  grantAgentSourceOperate(agent, registry, "registry");
  const revision = await deploy();
  assert.equal(revision.harnessAuth.sourceId, model.id);
  assert.deepEqual(revision.credentialSources, [
    { sourceId: model.id, credentialGatewayId: gateway.id, sourceType: "openai" },
    { sourceId: registry.id, credentialGatewayId: gateway.id, sourceType: "registry" },
  ]);
  await controller.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
  );

  // Both the draft and the active revision keep the source referenced.
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, registry.id),
    ResourceConflictError,
  );
  // Any listed source on the active revision can be withdrawn.
  const withdrawal = await controller.withdrawAgentCredentialSource(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    credentialSourceId: registry.id,
  });
  assert.equal(withdrawal.revisionId, revision.id);

  // A model-type source that harnessAuth does not name is an ordinary listed credential.
  await update(administrator, {
    credentialSources: [{ sourceId: model.id }, { sourceId: otherModel.id }],
  });
  grantAgentSourceOperate(agent, otherModel, "other-model");
  const toolRevision = await deploy();
  assert.deepEqual(
    toolRevision.credentialSources.map(({ sourceId }) => sourceId),
    [model.id, otherModel.id],
  );

  // Clearing the list requires clearing the Harness binding that points into it.
  const cleared = await update(administrator, { harnessAuth: null, credentialSources: [] });
  assert.equal(cleared.credentialSources, undefined);
});

test("the listing rule answers only after every source authorization", async () => {
  const { controller, dedicatedAgent, iamState, makeReady, modelSecret, namespace } =
    await fixture();
  await makeReady();
  const secret = await modelSecret();
  const model = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const registry = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
  });
  const agent = await dedicatedAgent();
  const unlisted = {
    harnessAuth: { method: "credential_source", sourceId: model.id },
    credentialSources: [{ sourceId: registry.id }],
  };
  const update = (principalId) =>
    controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...unlisted,
    });
  const create = (principalId) =>
    controller.createAgent(principalId, {
      namespaceId: namespace.id,
      name: `unlisted-${crypto.randomUUID()}`,
      configurationId: agent.configurationId,
      executionMode: "dedicated",
      ...unlisted,
    });
  // An Agent editor without operate on any source gets 403, not the listing rule.
  await assert.rejects(update(editor), (error) => {
    assert.ok(error instanceof AuthorizationDeniedError);
    assert.equal(requestFailure(error).status, 403);
    return true;
  });
  // operate on a listed source is checked before the rule, too.
  iamState.restrictions.push({
    id: "deny-registry-operate",
    namespaceId: namespace.id,
    action: "operate",
    resourceKind: "credential_source",
    resourceId: registry.id,
    effect: "deny",
  });
  for (const write of [update, create]) {
    await assert.rejects(write(administrator), (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.equal(error.authorization.resource.id, registry.id);
      return true;
    });
  }
  iamState.restrictions.pop();
  for (const write of [update, create]) {
    await assert.rejects(write(administrator), AgentCredentialSourceBindingError);
  }
});

test("binding without a Credential Gateway is a 409 after operate, whether or not the source exists", async () => {
  const { controller, dedicatedAgent, makeReady, namespace } = await fixture({
    withoutGateway: true,
  });
  await makeReady();
  const agent = await dedicatedAgent();
  // A stored source the Installation can no longer serve: the answer must match a missing one.
  const stored = await controller.transact((unit) =>
    unit.credentialSources.createCredentialSource({
      id: `cs_${crypto.randomUUID()}`,
      namespaceId: namespace.id,
      name: "stored",
      type: "registry",
      config: { host: "registry.example.com" },
      secrets: {},
      driverId: "credential-gateway-test",
      state: "ready",
      createdAt: "2026-09-27T12:00:00.000Z",
    }),
  );
  const writes = (sourceId) => ({
    "list on update": (principalId) =>
      controller.updateAgent(principalId, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        credentialSources: [{ sourceId }],
      }),
    "Harness source on update": (principalId) =>
      controller.updateAgent(principalId, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        harnessAuth: { method: "credential_source", sourceId },
        credentialSources: [{ sourceId }],
      }),
    "unlisted Harness source on update": (principalId) =>
      controller.updateAgent(principalId, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        harnessAuth: { method: "credential_source", sourceId },
      }),
    "list on create": (principalId) =>
      controller.createAgent(principalId, {
        namespaceId: namespace.id,
        name: `no-gateway-${crypto.randomUUID()}`,
        configurationId: agent.configurationId,
        executionMode: "dedicated",
        credentialSources: [{ sourceId }],
      }),
  });
  const outcome = async (write, principalId) => {
    const error = await write(principalId).then(
      () => assert.fail("binding without a Credential Gateway succeeded"),
      (rejection) => rejection,
    );
    const { status, code, message } = requestFailure(error);
    return { status, code, message, gateway: error instanceof CredentialGatewayNotConfiguredError };
  };
  for (const sourceId of [stored.id, `cs_${crypto.randomUUID()}`]) {
    for (const [name, write] of Object.entries(writes(sourceId))) {
      const administered = await outcome(write, administrator);
      assert.equal(administered.gateway, true, `${name}, ${sourceId}`);
      assert.equal(administered.status, 409, `${name}, ${sourceId}`);
      assert.equal(administered.code, "CREDENTIAL_GATEWAY_NOT_CONFIGURED", `${name}, ${sourceId}`);
      // The Agent editor holds no grant on any source: 403 for both, so neither the source
      // nor the Installation's gateway selection leaks.
      const denied = await outcome(write, editor);
      assert.deepEqual(
        { status: denied.status, code: denied.code },
        { status: 403, code: "FORBIDDEN" },
        `${name}, ${sourceId}`,
      );
    }
  }
  assert.equal(
    (await controller.getAgent(administrator, namespace.id, agent.id)).credentialSources,
    undefined,
  );

  // An Agent whose stored binding outlived the gateway: deploy names the fix, and an update
  // that binds nothing new still needs operate on every bound source but no gateway.
  await controller.transact((unit) =>
    unit.agents.updateConfiguration(
      namespace.id,
      agent.id,
      agent.configurationId,
      undefined,
      { method: "credential_source", sourceId: stored.id },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ sourceId: stored.id }],
    ),
  );
  const deploy = (principalId) =>
    controller.deployAgent(
      principalId,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
  const administered = await outcome(deploy, administrator);
  assert.equal(administered.gateway, true);
  assert.equal(administered.status, 409);
  assert.equal((await outcome(deploy, editor)).status, 403);
  const update = (principalId, fields = {}) =>
    controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...fields,
    });
  const drop = { harnessAuth: { method: "runtime" }, credentialSources: [] };
  assert.equal((await outcome(update, editor)).status, 403);
  assert.equal((await outcome((principalId) => update(principalId, drop), editor)).status, 403);
  assert.deepEqual((await update(administrator)).credentialSources, [{ sourceId: stored.id }]);
  const dropped = await update(administrator, drop);
  assert.deepEqual(
    { harnessAuth: dropped.harnessAuth, credentialSources: dropped.credentialSources },
    { harnessAuth: { method: "runtime" }, credentialSources: undefined },
  );
});

test("deploying credential sources without a Sandbox Driver is a 409 naming the driver, after agent:deploy", async () => {
  const { controller, dedicatedAgent, iamState, makeReady, namespace } = await fixture({
    withoutSandbox: true,
  });
  await makeReady();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
    secrets: {},
  });
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "runtime" },
    credentialSources: [{ sourceId: source.id }],
  });
  const deploy = (principalId) =>
    controller.deployAgent(
      principalId,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
  const outcome = async (principalId) => {
    const error = await deploy(principalId).then(
      () => assert.fail("deploying credential sources without a Sandbox Driver succeeded"),
      (rejection) => rejection,
    );
    const { status, code, message } = requestFailure(error);
    return { status, code, message };
  };
  const refusal = {
    status: 409,
    code: "RESOURCE_CONFLICT",
    message: "Agent credential sources require a selected Sandbox Driver.",
  };
  assert.deepEqual(await outcome(administrator), refusal);
  // Like the other capability refusals on deploy, the missing driver is an Installation
  // property that precedes source grants: a deployer without operate on the source gets the
  // same answer. A caller without agent:deploy still gets 403 before any of it.
  iamState.restrictions.push({
    id: "deny-source-operate",
    namespaceId: namespace.id,
    action: "operate",
    resourceKind: "credential_source",
    resourceId: source.id,
    effect: "deny",
  });
  // The restriction takes effect: binding the source is now denied.
  await assert.rejects(
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      credentialSources: [{ sourceId: source.id }],
    }),
    AuthorizationDeniedError,
  );
  assert.deepEqual(await outcome(administrator), refusal);
  iamState.restrictions.pop();
  const denied = await outcome(editor);
  assert.deepEqual(
    { status: denied.status, code: denied.code },
    { status: 403, code: "FORBIDDEN" },
  );
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

test("binding a credential source as Harness authentication requires operate on it", async () => {
  const { controller, dedicatedAgent, iamState, makeReady, modelSecret, namespace } =
    await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  const agent = await dedicatedAgent();
  const bindSource = () =>
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    });
  // The administrator may update the Agent but is denied operate on this one source.
  iamState.restrictions.push({
    id: "deny-source-operate",
    namespaceId: namespace.id,
    action: "operate",
    resourceKind: "credential_source",
    resourceId: source.id,
    effect: "deny",
  });
  await assert.rejects(bindSource(), (error) => {
    assert.ok(error instanceof AuthorizationDeniedError);
    assert.deepEqual(error.authorization, {
      action: "operate",
      resource: { kind: "credential_source", namespaceId: namespace.id, id: source.id },
    });
    return true;
  });
  assert.equal(
    (await controller.getAgent(administrator, namespace.id, agent.id)).harnessAuth ?? null,
    agent.harnessAuth ?? null,
  );
  iamState.restrictions.pop();
  assert.deepEqual((await bindSource()).harnessAuth, {
    method: "credential_source",
    sourceId: source.id,
  });
});

test("a deletion that wins against a registration removes the late gateway copy and the record", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const register = gateway.registerSource.bind(gateway);
  let deletion;
  gateway.registerSource = async (context, input) => {
    // DELETE marks the `registering` record `deleting` while the gateway call is in flight.
    deletion = await controller
      .deleteCredentialSource(administrator, namespace.id, context.source.id)
      .then(
        () => "deleted",
        (error) => error,
      );
    return register(context, input);
  };
  await assert.rejects(
    controller.createCredentialSource(
      administrator,
      {
        namespaceId: namespace.id,
        name: "openai",
        type: "openai",
        secrets: { api_key: secret.ref },
      },
      (created) => auditEvent(namespace.id, created.id, "openclaw.credential_sources.create"),
    ),
    (error) =>
      error instanceof ResourceConflictError &&
      error.message === "The credential source changed during registration.",
  );
  // The deletion found no copy yet and stays retryable inside the registration fence.
  assert.ok(deletion instanceof DependencyUnavailableError, String(deletion));
  // The copy stored after the deletion is removed, and no success event is committed.
  assert.equal(gateway.stored.size, 0);
  assert.deepEqual(await auditActions(controller), []);
  assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
});

test("only a ready credential source can be updated", async () => {
  let failRemove = false;
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
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
  failRemove = true;
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, source.id),
    DependencyUnavailableError,
  );
  // Precondition: a `deleting` source keeps its gateway copy until DELETE completes.
  assert.equal(gateway.stored.has(source.id), true);
  // An update must not refresh that copy.
  await assert.rejects(
    controller.updateCredentialSource(administrator, {
      namespaceId: namespace.id,
      credentialSourceId: source.id,
    }),
    (error) =>
      error instanceof ResourceConflictError &&
      error.message === "Only a ready credential source can be updated.",
  );
  assert.equal(gateway.calls.filter(({ operation }) => operation === "updateSource").length, 0);
});

test("reading a credential source requires read on it, and listing filters per source", async () => {
  const { controller, iamState, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const sources = [];
  for (const name of ["visible", "hidden"]) {
    sources.push(
      await controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name,
        type: "openai",
        secrets: { api_key: secret.ref },
      }),
    );
  }
  await assert.rejects(
    controller.readCredentialSource(zeroGrant, namespace.id, sources[0].id),
    AuthorizationDeniedError,
  );
  // Namespace read lists only the sources this principal may read.
  const reader = "principal-source-namespace-reader";
  iamState.identities.push({
    kind: "principal",
    id: reader,
    issuer: "credential-source-occ",
    subject: reader,
  });
  grantRole(iamState, reader, {
    id: "source-namespace-reader-role",
    namespaceId: namespace.id,
    permissions: { namespace: ["read"] },
  });
  assert.deepEqual(await controller.listCredentialSources(reader, namespace.id), []);
  grantRole(iamState, reader, {
    id: "source-one-reader-role",
    namespaceId: namespace.id,
    permissions: { credential_source: ["read"] },
    resource: { kind: "credential_source", id: sources[0].id },
  });
  assert.deepEqual(
    (await controller.listCredentialSources(reader, namespace.id)).map(({ id }) => id),
    [sources[0].id],
  );
  assert.equal(
    (await controller.readCredentialSource(reader, namespace.id, sources[0].id)).id,
    sources[0].id,
  );
  await assert.rejects(
    controller.readCredentialSource(reader, namespace.id, sources[1].id),
    AuthorizationDeniedError,
  );
});

test("a failing gateway status read reports a fixed reason, not the gateway's error", async () => {
  const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
  await makeReady();
  const secret = await modelSecret();
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: secret.ref },
  });
  gateway.sourceStatus = async () => {
    throw new Error("gateway echoed synthetic-model-key and internal address 10.0.0.7");
  };
  const read = await controller.readCredentialSource(administrator, namespace.id, source.id);
  assert.deepEqual(read.status, {
    state: "failed",
    reason: "The Credential Gateway status is unavailable.",
  });
  assert.equal(JSON.stringify(read).includes("synthetic-model-key"), false);
  assert.equal(JSON.stringify(read).includes("10.0.0.7"), false);
});

test("an Agent's credentialSources list is validated, and binding or unbinding needs operate", async () => {
  const { controller, dedicatedAgent, iamState, makeReady, namespace } = await fixture();
  await makeReady();
  const registry = (name) =>
    controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name,
      type: "registry",
      config: { host: `${name}.example.com` },
    });
  const kept = await registry("registry-kept");
  const added = await registry("registry-added");
  const agent = await dedicatedAgent();
  const update = (credentialSources) =>
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      credentialSources,
    });
  const invalid = {
    name: "ScopeViolationError",
    message: "The Agent credential sources are invalid.",
  };

  // The controller enforces the list grammar itself, whatever the store would accept.
  const nine = Array.from({ length: 9 }, (_, i) => ({ sourceId: `${kept.id}-${i}` }));
  await assert.rejects(update(nine), invalid);
  await assert.rejects(update([{ sourceId: kept.id, type: "registry" }]), invalid);
  await assert.rejects(update([{ sourceId: 7 }]), invalid);
  await assert.rejects(update([{ sourceId: "" }]), invalid);
  await assert.rejects(update({ sourceId: kept.id }), invalid);
  await assert.rejects(update([{ sourceId: kept.id }, { sourceId: kept.id }]), invalid);

  // Creating an Agent that lists a source needs operate on that exact source.
  const denyOperate = (source) =>
    iamState.restrictions.push({
      id: `deny-operate-${source.id}`,
      namespaceId: namespace.id,
      action: "operate",
      resourceKind: "credential_source",
      resourceId: source.id,
      effect: "deny",
    });
  denyOperate(added);
  await assert.rejects(
    controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: `listed-${crypto.randomUUID()}`,
      configurationId: agent.configurationId,
      executionMode: "dedicated",
      credentialSources: [{ sourceId: added.id }],
    }),
    (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.deepEqual(error.authorization.resource, {
        kind: "credential_source",
        namespaceId: namespace.id,
        id: added.id,
      });
      return true;
    },
  );
  iamState.restrictions.length = 0;

  // Unbinding a source needs operate on it too: a caller who lost operate on the bound source
  // cannot swap it out for another one.
  assert.deepEqual((await update([{ sourceId: kept.id }])).credentialSources, [
    { sourceId: kept.id },
  ]);
  denyOperate(kept);
  await assert.rejects(update([{ sourceId: added.id }]), (error) => {
    assert.ok(error instanceof AuthorizationDeniedError);
    assert.equal(error.authorization.resource.id, kept.id);
    return true;
  });
  assert.deepEqual(
    (await controller.getAgent(administrator, namespace.id, agent.id)).credentialSources,
    [{ sourceId: kept.id }],
  );
  iamState.restrictions.length = 0;
  assert.deepEqual((await update([{ sourceId: added.id }])).credentialSources, [
    { sourceId: added.id },
  ]);
  const created = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: `listed-${crypto.randomUUID()}`,
    configurationId: agent.configurationId,
    executionMode: "dedicated",
    credentialSources: [{ sourceId: added.id }, { sourceId: kept.id }],
  });
  assert.deepEqual(created.credentialSources, [{ sourceId: added.id }, { sourceId: kept.id }]);

  // The controller names the listing rule itself; the store's own check is a backstop with
  // another message. Only the message is pinned, so the error class can still change.
  const listed = {
    message: "The Harness credential source must be listed in the Agent's credentialSources.",
  };
  const model = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: {
      api_key: (
        await controller.createSecret(administrator, {
          namespaceId: namespace.id,
          name: `model-key-${crypto.randomUUID()}`,
          value: "synthetic-model-key",
        })
      ).ref,
    },
  });
  const harnessAuth = { method: "credential_source", sourceId: model.id };
  const updateFields = (fields) =>
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...fields,
    });
  await assert.rejects(updateFields({ harnessAuth }), listed);
  await assert.rejects(
    updateFields({ harnessAuth, credentialSources: [{ sourceId: added.id }] }),
    listed,
  );
  await updateFields({ harnessAuth, credentialSources: [{ sourceId: model.id }] });
  await assert.rejects(updateFields({ credentialSources: [{ sourceId: added.id }] }), listed);
});

test("binding refuses a missing, deleting, other-Namespace or foreign-gateway source", async () => {
  let failRemove = false;
  const { controller, dedicatedAgent, gateway, makeReady, namespace } = await fixture({
    gateway: { removeError: () => (failRemove ? new Error("gateway unavailable") : undefined) },
  });
  await makeReady();
  const registry = (name) =>
    controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name,
      type: "registry",
      config: { host: `${name}.example.com` },
    });
  const deleting = await registry("registry-deleting");
  const ready = await registry("registry-ready");
  const agent = await dedicatedAgent();
  const bind = (sourceId) =>
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      credentialSources: [{ sourceId }],
    });
  const unavailable = {
    name: "ScopeViolationError",
    message: "The credential source is unavailable in the exact Namespace.",
  };
  await assert.rejects(bind("cs_00000000-0000-4000-8000-00000000ffff"), unavailable);
  // A ready source of another Namespace is not in the Agent's Namespace.
  const other = await controller.createNamespace(administrator, { name: "Other source tenant" });
  await controller.handleNamespaceLifecycle(administrator, other.id, "ready");
  const foreign = await controller.createCredentialSource(administrator, {
    namespaceId: other.id,
    name: "registry-foreign",
    type: "registry",
    config: { host: "registry-foreign.example.com" },
  });
  await assert.rejects(bind(foreign.id), unavailable);
  failRemove = true;
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, deleting.id),
    DependencyUnavailableError,
  );
  // A source being deleted still exists, but it can no longer be newly bound.
  await assert.rejects(bind(deleting.id), unavailable);
  // A source registered through a gateway that is no longer selected cannot be bound.
  controller.registerDriver({ ...gateway, id: "credential-gateway-replacement" });
  controller.selectDriver("credential_gateway", "credential-gateway-replacement");
  await assert.rejects(bind(ready.id), DependencyUnavailableError);
  assert.equal(
    (await controller.getAgent(administrator, namespace.id, agent.id)).credentialSources,
    undefined,
  );
});

test("after a Credential Gateway change an Agent update can drop the old sources but not keep them", async () => {
  const { controller, dedicatedAgent, gateway, iamState, makeReady, modelSecret, namespace } =
    await fixture();
  await makeReady();
  const model = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai-old",
    type: "openai",
    secrets: { api_key: (await modelSecret()).ref },
  });
  const registry = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "registry-old",
    type: "registry",
    config: { host: "registry-old.example.com" },
  });
  const agent = await dedicatedAgent();
  const update = (principalId, fields = {}) =>
    controller.updateAgent(principalId, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...fields,
    });
  const oldHarnessAuth = { method: "credential_source", sourceId: model.id };
  await update(administrator, {
    harnessAuth: oldHarnessAuth,
    credentialSources: [{ sourceId: model.id }, { sourceId: registry.id }],
  });

  // The Installation re-selects its Credential Gateway; the old sources stay stored and ready.
  controller.registerDriver({ ...gateway, id: "credential-gateway-replacement" });
  controller.selectDriver("credential_gateway", "credential-gateway-replacement");
  const stored = async () => {
    const current = await controller.getAgent(administrator, namespace.id, agent.id);
    return { harnessAuth: current.harnessAuth, credentialSources: current.credentialSources };
  };
  const before = await stored();

  // Keeping an old-gateway source bound is still refused: deploy could not admit it.
  await assert.rejects(
    update(administrator, { credentialSources: [{ sourceId: model.id }] }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    update(administrator, {
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: registry.id }],
    }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    update(administrator, { harnessAuth: oldHarnessAuth }),
    DependencyUnavailableError,
  );
  assert.deepEqual(await stored(), before);

  // Dropping a bound source still needs operate on it, and is denied before any lookup,
  // including the lookup of a requested source that does not exist.
  iamState.restrictions.push({
    id: `deny-operate-${registry.id}`,
    namespaceId: namespace.id,
    action: "operate",
    resourceKind: "credential_source",
    resourceId: registry.id,
    effect: "deny",
  });
  const drop = { harnessAuth: { method: "runtime" }, credentialSources: [] };
  const missing = "cs_00000000-0000-4000-8000-00000000ffff";
  const missingSource = {
    harnessAuth: { method: "credential_source", sourceId: missing },
    credentialSources: [{ sourceId: missing }],
  };
  for (const fields of [{}, drop, missingSource]) {
    await assert.rejects(update(administrator, fields), (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.deepEqual(error.authorization.resource, {
        kind: "credential_source",
        namespaceId: namespace.id,
        id: registry.id,
      });
      return true;
    });
    assert.equal(requestFailure(await update(editor, fields).catch((e) => e)).status, 403);
  }
  iamState.restrictions.length = 0;
  assert.deepEqual(await stored(), before);

  // An update that binds nothing new succeeds, and so does one that drops the old sources.
  assert.deepEqual(
    (await update(administrator, { executionMode: "dedicated" })).credentialSources,
    [{ sourceId: model.id }, { sourceId: registry.id }],
  );
  // Leaving the list out keeps the old sources, which deploy admission still refuses.
  const implicitlyKept = await update(administrator, { harnessAuth: { method: "runtime" } });
  assert.deepEqual(implicitlyKept.credentialSources, before.credentialSources);
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    DependencyUnavailableError,
  );
  const dropped = await update(administrator, drop);
  assert.deepEqual(
    { harnessAuth: dropped.harnessAuth, credentialSources: dropped.credentialSources },
    { harnessAuth: { method: "runtime" }, credentialSources: undefined },
  );

  // A source registered through the new gateway binds as usual.
  const replacement = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai-new",
    type: "openai",
    secrets: { api_key: (await modelSecret()).ref },
  });
  const rebound = await update(administrator, {
    harnessAuth: { method: "credential_source", sourceId: replacement.id },
    credentialSources: [{ sourceId: replacement.id }],
  });
  assert.deepEqual(rebound.credentialSources, [{ sourceId: replacement.id }]);
});

test("deploy admission rechecks every listed source for the deployer, Sandbox and gateway catalog", async () => {
  const {
    controller,
    dedicatedAgent,
    gateway,
    grantAgentSourceOperate,
    iamState,
    makeReady,
    modelSecret,
    namespace,
  } = await fixture();
  await makeReady();
  const model = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: (await modelSecret()).ref },
  });
  const source = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
  });
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "credential_source", sourceId: model.id },
    credentialSources: [{ sourceId: model.id }, { sourceId: source.id }],
  });
  grantAgentSourceOperate(agent, model);
  grantAgentSourceOperate(agent, source, "registry");
  const deploy = () =>
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );

  // The Agent principal's grant is not enough: the deploying caller must still operate it.
  const sourceless = "principal-deployer-without-source-operate";
  const administratorRole = iamState.roles.find(({ id }) => id === "source-administrator-role");
  iamState.identities.push({
    kind: "principal",
    id: sourceless,
    issuer: "credential-source-occ",
    subject: sourceless,
  });
  iamState.roles.push({
    id: "deployer-without-source-operate-role",
    permissions: administratorRole.permissions.filter(
      ({ action, resourceKind }) => !(action === "operate" && resourceKind === "credential_source"),
    ),
  });
  iamState.bindings.push(
    {
      id: "deployer-without-source-operate-binding",
      subjectKind: "identity",
      subjectId: sourceless,
      roleId: "deployer-without-source-operate-role",
    },
    {
      id: "deployer-model-operate-binding",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: sourceless,
      roleId: "source-agent-role",
      resourceKind: "credential_source",
      resourceId: model.id,
    },
  );
  await assert.rejects(
    controller.deployAgent(
      sourceless,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    (error) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.deepEqual(error.authorization, {
        action: "operate",
        resource: { kind: "credential_source", namespaceId: namespace.id, id: source.id },
      });
      return true;
    },
  );

  // A source type the selected gateway no longer offers is not frozen into a revision.
  const listSourceTypes = gateway.listSourceTypes;
  gateway.listSourceTypes = async () =>
    (await listSourceTypes()).filter(({ type }) => type !== "registry");
  await assert.rejects(deploy(), CredentialSourceTypeNotOfferedError);
  gateway.listSourceTypes = listSourceTypes;
  assert.deepEqual((await deploy()).credentialSources, [
    { sourceId: model.id, credentialGatewayId: gateway.id, sourceType: "openai" },
    { sourceId: source.id, credentialGatewayId: gateway.id, sourceType: "registry" },
  ]);

  // Only a Sandbox Driver can carry listed sources into the runtime.
  const unsandboxed = await fixture({ withoutSandbox: true });
  await unsandboxed.makeReady();
  const unsandboxedSource = await unsandboxed.controller.createCredentialSource(administrator, {
    namespaceId: unsandboxed.namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
  });
  const unsandboxedAgent = await unsandboxed.dedicatedAgent();
  await unsandboxed.controller.updateAgent(administrator, {
    namespaceId: unsandboxed.namespace.id,
    agentId: unsandboxedAgent.id,
    configurationId: unsandboxedAgent.configurationId,
    harnessAuth: { method: "runtime" },
    credentialSources: [{ sourceId: unsandboxedSource.id }],
  });
  unsandboxed.grantAgentSourceOperate(unsandboxedAgent, unsandboxedSource);
  await assert.rejects(
    unsandboxed.controller.deployAgent(
      administrator,
      { namespaceId: unsandboxed.namespace.id, agentId: unsandboxedAgent.id },
      resolveApprovedDevelopmentHarness,
    ),
    {
      name: "ResourceStateConflictError",
      message: "Agent credential sources require a selected Sandbox Driver.",
    },
  );
});

test("a source type the gateway stops offering is a 409 naming the fix, after the grant and lookup", async () => {
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
  const model = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai",
    type: "openai",
    secrets: { api_key: (await modelSecret()).ref },
  });
  const tool = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "registry",
    type: "registry",
    config: { host: "registry.example.com" },
  });
  const agent = await dedicatedAgent();
  await controller.updateAgent(administrator, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    harnessAuth: { method: "credential_source", sourceId: model.id },
    credentialSources: [{ sourceId: model.id }, { sourceId: tool.id }],
  });
  grantAgentSourceOperate(agent, model);
  grantAgentSourceOperate(agent, tool, "registry");
  const deploy = (principal = administrator) =>
    controller.deployAgent(
      principal,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
  const update = (principal = administrator) =>
    controller.updateCredentialSource(principal, {
      namespaceId: namespace.id,
      credentialSourceId: tool.id,
    });
  const register = (principal = administrator) =>
    controller.createCredentialSource(principal, {
      namespaceId: namespace.id,
      name: "registry-2",
      type: "registry",
      config: { host: "registry.example.com" },
    });
  // The sources exist, so a generic "not found" would mislead (D548): the answer names the
  // Installation setting to restore, the way OpenShell drops bearer-token without toolBinaries.
  const notOffered = (error) => {
    assert.ok(error instanceof CredentialSourceTypeNotOfferedError, error.name);
    const failure = requestFailure(error);
    assert.deepEqual(
      { status: failure.status, code: failure.code, message: failure.message },
      {
        status: 409,
        code: "RESOURCE_CONFLICT",
        // Fixed text that names the Installation setting and where it is documented.
        message:
          "The selected Credential Gateway does not offer this credential source type. An administrator must enable it, for example toolBinaries for OpenShell bearer-token; see https://docs-enterprise.openclaw.org/reference/drivers/openshell-credential-gateway/",
      },
    );
    return true;
  };
  const offered = gateway.listSourceTypes;
  const withdrawType = (type) => {
    gateway.listSourceTypes = async () => (await offered()).filter((entry) => entry.type !== type);
  };

  withdrawType("registry");
  const updatesBefore = gateway.calls.filter(({ operation }) => operation === "updateSource");
  await assert.rejects(update(), notOffered);
  await assert.rejects(register(), notOffered);
  await assert.rejects(deploy(), notOffered);
  assert.deepEqual(
    gateway.calls.filter(({ operation }) => operation === "updateSource"),
    updatesBefore,
  );
  // The catalog is an Installation property, but callers without the grant still learn nothing.
  for (const call of [update, register, deploy]) {
    await assert.rejects(call(zeroGrant), AuthorizationDeniedError);
  }

  // The Harness source's type is checked the same way.
  withdrawType("openai");
  await assert.rejects(deploy(), notOffered);

  // Offering the type again restores every path.
  gateway.listSourceTypes = offered;
  assert.deepEqual((await update()).status, { state: "ready" });
  assert.equal((await deploy()).credentialSources.length, 2);
});

test("after a Credential Gateway change, every path refuses an old source with one fixed message and DELETE keeps it ready", async () => {
  const {
    controller,
    dedicatedAgent,
    gateway,
    makeReady,
    modelSecret,
    namespace,
    passRegistrationFence,
  } = await fixture();
  await makeReady();
  const registry = (name) =>
    controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name,
      type: "registry",
      config: { host: `${name}.example.com` },
    });
  const bound = await registry("registry-bound");
  const unbound = await registry("registry-unbound");
  const model = await controller.createCredentialSource(administrator, {
    namespaceId: namespace.id,
    name: "openai-old",
    type: "openai",
    secrets: { api_key: (await modelSecret()).ref },
  });
  // A source an earlier deletion left `deleting` through the old gateway, as before this fix.
  const stuck = await controller.transact((unit) =>
    unit.credentialSources.createCredentialSource({
      id: `cs_${crypto.randomUUID()}`,
      namespaceId: namespace.id,
      name: "registry-stuck",
      type: "registry",
      config: { host: "registry-stuck.example.com" },
      secrets: {},
      driverId: gateway.id,
      state: "deleting",
      createdAt: "2026-09-27T12:00:00.000Z",
    }),
  );
  const agent = await dedicatedAgent();
  const update = (fields) =>
    controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      ...fields,
    });
  await update({ harnessAuth: { method: "runtime" }, credentialSources: [{ sourceId: bound.id }] });

  controller.registerDriver({ ...gateway, id: "credential-gateway-replacement" });
  controller.selectDriver("credential_gateway", "credential-gateway-replacement");
  const removals = () => gateway.calls.filter(({ operation }) => operation === "removeSource");
  const removalsBefore = removals().length;
  const ownership = (error) => {
    assert.ok(error instanceof CredentialSourceDriverError, `${error.name}: ${error.message}`);
    const { status, code, message } = requestFailure(error);
    assert.deepEqual(
      { status, code, message },
      {
        status: 503,
        code: "DEPENDENCY_UNAVAILABLE",
        message: new CredentialSourceDriverError().message,
      },
    );
    assert.doesNotMatch(message, /cs_|credential-gateway-/);
    return true;
  };
  // Bind (list and Harness), deploy admission, update and delete all name the same fix.
  await assert.rejects(
    update({ credentialSources: [{ sourceId: bound.id }, { sourceId: unbound.id }] }),
    ownership,
  );
  await assert.rejects(
    update({
      harnessAuth: { method: "credential_source", sourceId: model.id },
      credentialSources: [{ sourceId: model.id }],
    }),
    ownership,
  );
  await assert.rejects(
    controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    ),
    ownership,
  );
  await assert.rejects(
    controller.updateCredentialSource(administrator, {
      namespaceId: namespace.id,
      credentialSourceId: model.id,
    }),
    ownership,
  );
  for (const source of [unbound, stuck]) {
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, source.id),
      ownership,
    );
  }
  // The refused deletion committed nothing: the source is still ready, so it is not stranded
  // in the one-way `deleting` state, and no gateway was asked to remove anything.
  const unchanged = await controller.readCredentialSource(administrator, namespace.id, unbound.id);
  assert.equal(unchanged.state, "ready");
  // Its live status names the driver change rather than an outage.
  assert.deepEqual(unchanged.status, {
    state: "failed",
    reason: "A Credential Gateway Driver that is no longer selected registered the source.",
  });
  assert.equal(removals().length, removalsBefore);
  // A referenced source still reports the reference first.
  await assert.rejects(
    controller.deleteCredentialSource(administrator, namespace.id, bound.id),
    ResourceConflictError,
  );

  // Selecting the registering driver again lets both sources be deleted.
  controller.selectDriver("credential_gateway", gateway.id);
  passRegistrationFence();
  for (const source of [unbound, stuck]) {
    await controller.deleteCredentialSource(administrator, namespace.id, source.id);
  }
  assert.deepEqual(
    (await controller.listCredentialSources(administrator, namespace.id))
      .map(({ name }) => name)
      .toSorted(),
    ["openai-old", "registry-bound"],
  );
});

test("update and delete without a Credential Gateway are a 409 after the grant, whether or not the source exists", async () => {
  const { controller, makeReady, namespace } = await fixture({ withoutGateway: true });
  await makeReady();
  const stored = await controller.transact((unit) =>
    unit.credentialSources.createCredentialSource({
      id: `cs_${crypto.randomUUID()}`,
      namespaceId: namespace.id,
      name: "stored",
      type: "registry",
      config: { host: "registry.example.com" },
      secrets: {},
      driverId: "credential-gateway-test",
      state: "ready",
      createdAt: "2026-09-27T12:00:00.000Z",
    }),
  );
  const missing = "cs_00000000-0000-4000-8000-00000000ffff";
  const notConfigured = (error) => {
    assert.ok(error instanceof CredentialGatewayNotConfiguredError, error.name);
    assert.equal(requestFailure(error).status, 409);
    return true;
  };
  for (const id of [stored.id, missing]) {
    await assert.rejects(
      controller.updateCredentialSource(administrator, {
        namespaceId: namespace.id,
        credentialSourceId: id,
      }),
      notConfigured,
    );
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, id),
      notConfigured,
    );
    // A caller without the grant is denied first.
    await assert.rejects(
      controller.deleteCredentialSource(zeroGrant, namespace.id, id),
      AuthorizationDeniedError,
    );
  }
  const [after] = await controller.listCredentialSources(administrator, namespace.id);
  assert.equal(after.state, "ready");
});
