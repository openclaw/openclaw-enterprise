import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "occ-presets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const fixture = await createConsoleAppFixture(t, { state, providers: [] });
  await fixture.bootstrap();
  // The real filesystem Driver enforces native credential rules on copied configurations.
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const session = await fixture.signIn();
  return { ...fixture, audit, session };
}

const collection = (namespaceId) => `/namespaces/${namespaceId}/presets`;

async function createPreset(fixture, namespaceId, name, template = {}) {
  const response = await fixture.request("POST", collection(namespaceId), {
    body: { name, template },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.data;
}

async function deletePreset(fixture, namespaceId, presetId) {
  const result = await fixture.rawRequest("DELETE", `${collection(namespaceId)}/${presetId}`, {
    headers: authenticatedHeaders(fixture.session),
  });
  assert.equal(result.response.status, 204, result.text);
}

test("Preset CRUD keeps Namespace names unique and filters reads by exact Native IAM grants", async (t) => {
  const fixture = await createFixture(t);
  const alpha = await fixture.createNamespace("Preset Alpha", { ready: true });
  const beta = await fixture.createNamespace("Preset Beta", { ready: true });
  const visible = await createPreset(fixture, alpha.id, "Shared name");
  assert.match(visible.id, /^pre_[0-9a-f-]+$/);
  assert.equal(visible.namespaceId, alpha.id);
  const hidden = await createPreset(fixture, alpha.id, "Hidden");
  await createPreset(fixture, beta.id, "Shared name");

  const duplicate = await fixture.request("POST", collection(alpha.id), {
    body: { name: "Shared name", template: {} },
  });
  assert.equal(duplicate.status, 409);
  const conflictingRename = await fixture.request("PATCH", `${collection(alpha.id)}/${hidden.id}`, {
    body: { name: "Shared name" },
  });
  assert.equal(conflictingRename.status, 409);

  const limited = await fixture.createAccountWithPolicy("preset-reader", (principal) => {
    fixture.policy.roles.push({
      id: "preset-reader",
      namespaceId: alpha.id,
      permissions: [{ action: "read", resourceKind: "preset" }],
    });
    fixture.policy.bindings.push({
      id: "read-one-preset",
      namespaceId: alpha.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "preset-reader",
      resourceKind: "preset",
      resourceId: visible.id,
    });
  });
  const session = await fixture.signIn(limited.credentials);
  const readable = await fixture.request("GET", collection(alpha.id), { session });
  assert.equal(readable.status, 200, JSON.stringify(readable.body));
  assert.deepEqual(
    readable.data.map((preset) => preset.id),
    [visible.id],
  );
  const exact = await fixture.request("GET", `${collection(alpha.id)}/${visible.id}`, { session });
  assert.equal(exact.status, 200);
  assert.deepEqual(exact.data, visible);
  const denied = await fixture.request("GET", `${collection(alpha.id)}/${hidden.id}`, { session });
  assert.equal(denied.status, 403);
  const deniedUpdate = await fixture.request("PATCH", `${collection(alpha.id)}/${visible.id}`, {
    session,
    body: { name: "Unauthorized rename" },
  });
  assert.equal(deniedUpdate.status, 403);
  const deniedCreate = await fixture.request("POST", collection(alpha.id), {
    session,
    body: { name: "Unauthorized creation", template: {} },
  });
  assert.equal(deniedCreate.status, 403);
  const otherNamespace = await fixture.request("GET", collection(beta.id), { session });
  assert.equal(otherNamespace.status, 200);
  assert.deepEqual(otherNamespace.data, []);
  const wrongOwner = await fixture.request("GET", `${collection(beta.id)}/${visible.id}`);
  assert.equal(wrongOwner.status, 404);

  const renamed = await fixture.request("PATCH", `${collection(alpha.id)}/${visible.id}`, {
    body: { name: "Renamed" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.name, "Renamed");
  assert.deepEqual(renamed.data.template, {});
  await deletePreset(fixture, alpha.id, visible.id);
  const removed = await fixture.request("GET", `${collection(alpha.id)}/${visible.id}`);
  assert.equal(removed.status, 404);
  assert.ok(
    fixture.audit.events.some(
      (event) =>
        event.resource.kind === "preset" &&
        event.resource.id === visible.id &&
        event.outcome === "success",
    ),
  );
});

test("Preset variables create independent ordinary Agent drafts that survive template replacement and deletion", async (t) => {
  const { renderPresetTemplate } = await import("../../packages/contracts/src/index.ts");
  const fixture = await createFixture(t);
  const namespace = await fixture.createNamespace("Preset drafts", { ready: true });
  const template = {
    variables: {
      name: { type: "string" },
      model: { type: "string", default: "openai/gpt-5.1" },
      enabled: { type: "boolean", default: true },
      mode: { type: "string", default: "unfinished" },
    },
    agent: {
      name: "{{ vars.name }}",
      executionMode: "{{ vars.mode }}",
      plugins: { github: { enabled: "unfinished", approvalMode: "prompt" } },
      harnessAuth: null,
    },
    configuration: {
      values: {
        gateway: {
          auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" },
          controlUi: { enabled: "{{ vars.enabled }}" },
        },
        agents: {
          defaults: {
            model: "{{ vars.model }}",
            models: { "{{ vars.model }}": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: {
            openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
          },
        },
      },
    },
  };
  const preset = await createPreset(fixture, namespace.id, "Default model", template);
  const read = await fixture.request("GET", `${collection(namespace.id)}/${preset.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.data.template, template);
  // The API consumer uses the same renderer as the console, then the ordinary two-create flow.
  const rendered = renderPresetTemplate(read.data.template, { name: 'My "Agent"', enabled: false });
  const configuration = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    {
      body: { kind: "agent", ...rendered.configuration },
    },
  );
  assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
  assert.equal(configuration.data.values.agents.defaults.model, "openai/gpt-5.1");
  assert.deepEqual(Object.keys(configuration.data.values.agents.defaults.models), [
    "openai/gpt-5.1",
  ]);
  assert.equal(configuration.data.values.gateway.controlUi.enabled, false);
  assert.equal(configuration.data.values.gateway.auth.password, "${OPENCLAW_GATEWAY_PASSWORD}");
  assert.deepEqual(
    configuration.data.values.models.providers.openai.apiKey,
    template.configuration.values.models.providers.openai.apiKey,
  );
  // Presets may be unfinished. The ordinary API rejects invalid launch fields
  // after Configuration creation; correcting the draft reuses that Configuration.
  const rejected = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { ...rendered.agent, configurationId: configuration.data.id },
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  const agentsBeforeCorrection = await fixture.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.deepEqual(agentsBeforeCorrection.data, []);
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      ...rendered.agent,
      executionMode: "embedded",
      plugins: {},
      configurationId: configuration.data.id,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.data.name, 'My "Agent"');
  assert.equal(created.data.configurationId, configuration.data.id);
  assert.equal(Object.hasOwn(created.data, "presetId"), false);

  const replaced = await fixture.request("PATCH", `${collection(namespace.id)}/${preset.id}`, {
    body: { template: { agent: { name: "Changed later" } } },
  });
  assert.equal(replaced.status, 200);
  assert.deepEqual(replaced.data.template, { agent: { name: "Changed later" } });
  await deletePreset(fixture, namespace.id, preset.id);
  const savedAgent = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
  );
  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${configuration.data.id}`,
  );
  assert.equal(savedAgent.status, 200);
  assert.equal(savedConfiguration.status, 200);
  assert.deepEqual(savedAgent.data, created.data);
  assert.deepEqual(savedConfiguration.data, configuration.data);
});

test("Preset admission rejects malformed templates and credential leaks while preserving Secret reference isolation", async (t) => {
  const { renderPresetTemplate } = await import("../../packages/contracts/src/index.ts");
  const fixture = await createFixture(t);
  const alpha = await fixture.createNamespace("Credential owner", { ready: true });
  const beta = await fixture.createNamespace("Other credential owner", { ready: true });
  const secret = await fixture.createSecret(alpha.id, "Model key", "synthetic-preset-secret-value");
  const wrongSecret = await fixture.createSecret(beta.id, "Other key", "synthetic-other-secret");
  const sentinel = "synthetic-preset-credential-must-not-persist";
  const unsafeTemplates = [
    { configuration: { secretBindings: { OPENAI_API_KEY: { source: secret.ref } } } },
    { agent: { namespaceId: beta.id } },
    { agent: { name: "{{ vars.undeclared }}" } },
    { configuration: { secretBindings: { SLACK_BOT_TOKEN: { source: wrongSecret.ref } } } },
    { configuration: { values: { models: { providers: { openai: { apiKey: sentinel } } } } } },
    {
      variables: { key: { type: "string", default: sentinel } },
      configuration: {
        values: { models: { providers: { openai: { apiKey: "{{ vars.key }}" } } } },
      },
    },
  ];
  for (const template of unsafeTemplates) {
    const rejected = await fixture.request("POST", collection(alpha.id), {
      body: { name: "Rejected", template },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(JSON.stringify(rejected.body).includes(sentinel), false);
  }
  const empty = await fixture.request("GET", collection(alpha.id));
  assert.deepEqual(empty.data, []);

  const preset = await createPreset(fixture, alpha.id, "Secret reference", {
    variables: { secretId: { type: "string", default: secret.ref.id } },
    configuration: {
      values: {},
      secretBindings: {
        SLACK_BOT_TOKEN: {
          source: { kind: "secret", namespaceId: alpha.id, id: "{{ vars.secretId }}" },
        },
      },
    },
  });
  const rendered = renderPresetTemplate(preset.template, { secretId: secret.ref.id });
  const reader = await fixture.createAccountWithPolicy(
    "preset-user-without-secret",
    (principal) => {
      fixture.policy.roles.push({
        id: "preset-consumer",
        namespaceId: alpha.id,
        permissions: [
          { action: "read", resourceKind: "preset" },
          { action: "create", resourceKind: "configuration" },
        ],
      });
      fixture.policy.bindings.push({
        id: "preset-consumer",
        namespaceId: alpha.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "preset-consumer",
      });
    },
  );
  const session = await fixture.signIn(reader.credentials);
  const selected = await fixture.request("GET", `${collection(alpha.id)}/${preset.id}`, {
    session,
  });
  assert.equal(selected.status, 200);
  const denied = await fixture.request("POST", `/namespaces/${alpha.id}/configurations`, {
    session,
    body: { kind: "agent", ...rendered.configuration },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  // Substitution is not an authorization grant, including for an ID from another Namespace.
  const wrongScope = renderPresetTemplate(preset.template, { secretId: wrongSecret.ref.id });
  const invalid = await fixture.request("POST", `/namespaces/${alpha.id}/configurations`, {
    body: { kind: "agent", ...wrongScope.configuration },
  });
  assert.equal(invalid.status, 404, JSON.stringify(invalid.body));
  const admitted = await fixture.request("POST", `/namespaces/${alpha.id}/configurations`, {
    body: { kind: "agent", ...rendered.configuration },
  });
  assert.equal(admitted.status, 201, JSON.stringify(admitted.body));
  assert.deepEqual(admitted.data.secretBindings.SLACK_BOT_TOKEN.source, secret.ref);
  assert.equal(JSON.stringify(fixture.audit.events).includes(sentinel), false);
  const presetMutations = fixture.audit.events.filter(
    (event) => event.resource.kind === "preset" && event.kind === "mutation",
  );
  assert.ok(presetMutations.length > 0);
  assert.ok(presetMutations.every((event) => !JSON.stringify(event).includes("secretId")));
  assert.ok(presetMutations.every((event) => !JSON.stringify(event).includes(secret.ref.id)));
});

test("Presets block Namespace deletion and deleting one removes only its managed resource bindings", async (t) => {
  const fixture = await createFixture(t);
  const emptyNamespace = await fixture.createNamespace("Preset-only namespace", { ready: true });
  const only = await createPreset(fixture, emptyNamespace.id, "Only resource");
  const blocked = await fixture.request("DELETE", `/namespaces/${emptyNamespace.id}`);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  await deletePreset(fixture, emptyNamespace.id, only.id);
  const deleting = await fixture.request("DELETE", `/namespaces/${emptyNamespace.id}`);
  assert.equal(deleting.status, 202, JSON.stringify(deleting.body));

  const namespace = await fixture.createNamespace("Managed preset bindings", { ready: true });
  const target = await createPreset(fixture, namespace.id, "Bound preset");
  const preserved = await createPreset(fixture, namespace.id, "Other preset");
  const agent = await fixture.createAgent(
    namespace.id,
    "Binding subject",
    {},
    { harnessAuth: null },
  );
  const role = await fixture.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
    body: { name: "Preset reader", permissions: [{ action: "read", resourceKind: "preset" }] },
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  const bindings = [];
  for (const preset of [target, preserved]) {
    const binding = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/iam/access-bindings`,
      {
        body: {
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId: role.data.id,
          resourceKind: "preset",
          resourceId: preset.id,
        },
      },
    );
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    bindings.push(binding.data);
  }
  await deletePreset(fixture, namespace.id, target.id);
  const remaining = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.equal(remaining.status, 200);
  assert.deepEqual(
    remaining.data.map((binding) => binding.id),
    [bindings[1].id],
  );
  const retainedRole = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/iam/roles/${role.data.id}`,
  );
  assert.equal(retainedRole.status, 200);
  const retainedAgent = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(retainedAgent.status, 200);
});
