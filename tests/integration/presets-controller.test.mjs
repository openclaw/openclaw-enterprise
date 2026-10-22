import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import { initializeInstallationPresets } from "../../apps/controller/src/composition/installation-config.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { emitOccLogEvent } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  renderPresetTemplate,
  validatePresetTemplate,
} from "../../packages/contracts/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  InMemoryPlatformState,
  OpenClawController,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { bindRole, grantRole } from "../helpers/iam-grants.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";
import {
  assertWriteAuthorizationDenial,
  partialWrite,
} from "../helpers/partial-write-authorization.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

async function createFixture(t, options = {}) {
  const root = await temporaryDirectory(t, "occ-presets-");
  const audit = options.auditSink ?? new InMemoryAuditSink();
  let policy;
  const state = new InMemoryPlatformState({
    auditSink: audit,
    // Live lookup, so people enrolled by the fixture can be bound as in Postgres.
    resolveIAMIdentity: (identityId) =>
      policy?.identities.find((identity) => identity.id === identityId),
  });
  // The real filesystem Driver enforces native credential rules, including bootstrap defaults.
  const configurationDriver = new FilesystemConfigurationDriver(root);
  const fixture = await createConsoleAppFixture(t, {
    state,
    providers: [],
    configurationDriver,
    ...options,
  });
  policy = fixture.policy;
  await fixture.bootstrap();
  // The bootstrap administrator, the only principal until a case enrolls more.
  const admin = policy.identities.find((identity) => identity.kind === "principal");
  return { ...fixture, admin, audit, state };
}

// A fixture seeded the way startup seeds it from an Installation file's runtime.
const startupFixture = (t, runtime) =>
  createFixture(t, {
    defaultPresets: runtime.defaultPresets,
    bundledPresetVersions: runtime.bundledPresetVersions,
    refreshBundledDefaultPresets: runtime.installation.presets.includeDefaults,
  });

const iamOf = (fixture) => fixture.controller.selectDriver("iam", "console-native-iam");
const collection = (namespaceId) => `/namespaces/${namespaceId}/presets`;
const presetPath = (namespaceId, presetId) => `${collection(namespaceId)}/${presetId}`;
const agentsPath = (namespaceId) => `/namespaces/${namespaceId}/agents`;
// The list route returns summaries without templates (finding 1323).
const listPresets = async (fixture, namespaceId) =>
  (await fixture.request("GET", collection(namespaceId))).data;
const presetSummary = ({ id, namespaceId, name, createdAt }) => ({
  id,
  namespaceId,
  name,
  createdAt,
});
// Each listed Preset with its template, read one by one as clients do.
const listPresetDocuments = async (fixture, namespaceId) =>
  Promise.all(
    (await listPresets(fixture, namespaceId)).map(
      async ({ id }) => (await fixture.request("GET", presetPath(namespaceId, id))).data,
    ),
  );
const presetNames = async (fixture, namespaceId) =>
  (await listPresets(fixture, namespaceId)).map((preset) => preset.name).sort();
const readPreset = (fixture, namespaceId, presetId) =>
  fixture.request("GET", presetPath(namespaceId, presetId));
const auditFrom = (fixture, source) =>
  fixture.audit.events.filter((event) => event.details?.source === source);

async function createPreset(fixture, namespaceId, name, template = {}) {
  const response = await fixture.request("POST", collection(namespaceId), {
    body: { name, template },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.data;
}

// Replaces a Preset's template by PATCH.
async function patchTemplate(fixture, namespaceId, presetId, template) {
  const response = await fixture.request("PATCH", presetPath(namespaceId, presetId), {
    body: { template },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.data;
}

async function deletePreset(fixture, namespaceId, presetId) {
  const response = await fixture.request("DELETE", presetPath(namespaceId, presetId));
  assert.equal(response.status, 204, JSON.stringify(response.body));
}

// Reads a Preset artifact shipped in deploy/presets.
async function shippedPreset(file) {
  return JSON.parse(
    await readFile(new URL(`../../deploy/presets/${file}`, import.meta.url), "utf8"),
  );
}

// Shipped versions of the bundled defaults, read from the archive the release ships.
async function archivedDefault(file, version) {
  return shippedPreset(`archive/${file.replace(/\.json$/, "")}/${version}.json`);
}

// Installs a shipped request through the operator API.
async function installShipped(fixture, namespaceId, file) {
  const artifact = await shippedPreset(file);
  const installed = await fixture.request("POST", collection(namespaceId), { body: artifact });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  return { artifact, installed };
}

// Creates the Agent Configuration of a rendered Preset template.
async function createAgentConfiguration(fixture, namespaceId, rendered) {
  const response = await fixture.request("POST", `/namespaces/${namespaceId}/configurations`, {
    body: { kind: "agent", ...rendered.configuration },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response;
}

// The ordinary Agent create of the two-create flow, with the rendered Agent fields.
const postAgent = (fixture, namespaceId, rendered, configuration, overrides = {}) =>
  fixture.request("POST", agentsPath(namespaceId), {
    body: { ...rendered.agent, configurationId: configuration.data.id, ...overrides },
  });

async function bundledRuntime(t, presets) {
  const configuration = createInstallationDriverConfiguration();
  configuration.presets = presets;
  return loadInstallationFile(t, configuration);
}

// A Namespace persisted directly, as before a default Preset existed or the setting was enabled.
const persistedNamespace = (fixture, name) =>
  fixture.controller.transact((state) =>
    state.namespaces.createNamespace({
      id: `ns_${crypto.randomUUID()}`,
      name,
      status: "ready",
      createdAt: new Date().toISOString(),
    }),
  );

// The administrator Role bound to the Installation resource only: it administers the
// Installation but grants nothing inside a Namespace.
function installationOnlyAdmin(fixture) {
  const adminRoleId = fixture.policy.bindings.find(
    (binding) => binding.subjectId === fixture.admin.id,
  ).roleId;
  return fixture.createAccountWithPolicy("installation-only", (identity) => {
    bindRole(fixture.policy, identity.id, {
      id: "installation-only-admin",
      roleId: adminRoleId,
      resource: { kind: "installation", id: fixture.controller.installation.id },
    });
  });
}

// Creates a Namespace Role granting Preset read; bindPreset binds it to one Preset.
async function presetReaderRole(fixture, namespaceId) {
  const role = await fixture.request("POST", `/namespaces/${namespaceId}/iam/roles`, {
    body: { name: "Preset reader", permissions: [{ action: "read", resourceKind: "preset" }] },
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  return role.data;
}

async function bindPreset(fixture, namespaceId, { subjectId, roleId, presetId }) {
  const binding = await fixture.request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId,
      roleId,
      resourceKind: "preset",
      resourceId: presetId,
    },
  });
  assert.equal(binding.status, 201, JSON.stringify(binding.body));
  return binding.data;
}

// Startup log lines, as the controller logger would emit them.
function captureLog() {
  const lines = [];
  const logger = Object.fromEntries(
    ["error", "warn", "info", "debug"].map((level) => [
      level,
      (record) => lines.push({ level, ...record }),
    ]),
  );
  return { lines, emit: (event) => emitOccLogEvent(logger, event) };
}

// Fails every `action` on Presets with an IAM outage until the case ends.
function failPresetAuthorization(t, iam, action) {
  const authorize = iam.authorize.bind(iam);
  iam.authorize = async (request) => {
    if (request.action === action && request.resource.kind === "preset") {
      throw new Error("IAM outage");
    }
    return authorize(request);
  };
  t.after(() => {
    iam.authorize = authorize;
  });
}

// Installs a shipped standard Preset and reads it back from the catalog, as the console chooser does.
async function installFromCatalog(fixture, namespaceId, file) {
  const { artifact, installed } = await installShipped(fixture, namespaceId, file);
  const catalog = await fixture.request("GET", collection(namespaceId));
  assert.equal(catalog.status, 200);
  const listed = catalog.data.find(({ id }) => id === installed.data.id);
  // The catalog lists a summary; the template comes from the exact Preset.
  assert.deepEqual(listed, presetSummary(installed.data));
  const preset = (await fixture.request("GET", presetPath(namespaceId, listed.id))).data;
  return { artifact, installed, preset };
}

// Creates a rendered standard Preset's Configuration and Agent with a same-Namespace model key,
// and checks the launch contract both standard Presets share.
async function launchWithKey(fixture, namespaceId, rendered, secret, installed) {
  const configuration = await createAgentConfiguration(fixture, namespaceId, rendered);
  const agent = await postAgent(fixture, namespaceId, rendered, configuration, {
    harnessAuth: { method: rendered.agent.harnessAuth.method, source: secret.ref },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  assert.deepEqual(agent.data.harnessAuth, { method: "api_key", source: secret.ref });
  assert.deepEqual(agent.data.plugins, {});
  // These are persisted launch contracts, not proof of a running runtime.
  const values = configuration.data.values;
  assert.equal(values.tools.web.fetch.enabled, false);
  assert.equal(values.browser.enabled, false);
  assert.equal(values.tools.elevated.enabled, false);
  assert.equal(configuration.data.secretBindings, undefined);
  assert.equal(JSON.stringify(installed.body).includes("synthetic-model-key"), false);
  return { agent: agent.data, values };
}

// Two cases at a time: the work is mostly on this thread, so two already overlap the password
// hashing, and more would only queue requests behind each other toward their 5 s timeout.
describe("Presets", { concurrency: 2 }, () => {
  // Cases that change only their own Namespaces, accounts and grants share one app. A case that
  // changes Drivers, controller methods or Restrictions, runs startup seeding, or counts audit
  // rows beyond its own resources must use its own createFixture(t) instead of shared().
  const cleanups = [];
  let sharedFixture;
  const shared = () =>
    (sharedFixture ??= createFixture(
      { after: (cleanup) => cleanups.push(cleanup) },
      // One sink for State and the HTTP layer, so the route's denial rows are recorded too.
      { auditSink: new InMemoryAuditSink() },
    ));
  // Runs the shared app's cleanups in registration order, as t.after does.
  after(async () => {
    let failure;
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      throw failure;
    }
  });

  test("Preset CRUD keeps Namespace names unique and filters reads by exact Native IAM grants", async () => {
    const fixture = await shared();
    const alpha = await fixture.createNamespace("Preset Alpha", { ready: true });
    const beta = await fixture.createNamespace("Preset Beta", { ready: true });
    const visible = await createPreset(fixture, alpha.id, "Shared name");
    assert.match(visible.id, /^pre_[0-9a-f-]+$/);
    assert.equal(visible.namespaceId, alpha.id);
    const hidden = await createPreset(fixture, alpha.id, "Hidden");
    await createPreset(fixture, beta.id, "Shared name");

    // The caller chose only the name, so the conflict says the name is taken here.
    for (const [method, path, body] of [
      ["POST", collection(alpha.id), { name: "Shared name", template: {} }],
      ["PATCH", presetPath(alpha.id, hidden.id), { name: "Shared name" }],
    ]) {
      const conflict = await fixture.request(method, path, { body });
      assert.equal(conflict.status, 409, method);
      assert.equal(conflict.body.error.code, "RESOURCE_CONFLICT", method);
      assert.equal(
        conflict.body.error.message,
        "A Preset with this name already exists in this Namespace. Choose a different name.",
        method,
      );
    }

    const limited = await fixture.createAccountWithPolicy("preset-reader", (principal) => {
      grantRole(fixture.policy, principal.id, {
        id: "preset-reader",
        bindingId: "read-one-preset",
        namespaceId: alpha.id,
        permissions: { preset: ["read"] },
        resource: { kind: "preset", id: visible.id },
      });
    });
    const session = await fixture.signIn(limited.credentials);
    // Listing needs Namespace read, like every Namespace-scoped list; an exact Preset grant alone
    // does not open the collection, so a refusal looks the same as for a missing Namespace.
    const unlisted = await fixture.request("GET", collection(alpha.id), { session });
    assert.equal(unlisted.status, 403, JSON.stringify(unlisted.body));
    grantRole(fixture.policy, limited.principal.id, {
      id: "alpha-namespace-reader",
      bindingId: "read-alpha",
      namespaceId: alpha.id,
      permissions: { namespace: ["read"] },
    });
    const readable = await fixture.request("GET", collection(alpha.id), { session });
    assert.equal(readable.status, 200, JSON.stringify(readable.body));
    assert.deepEqual(
      readable.data.map((preset) => preset.id),
      [visible.id],
    );
    const exact = await fixture.request("GET", presetPath(alpha.id, visible.id), { session });
    assert.equal(exact.status, 200);
    assert.deepEqual(exact.data, visible);
    for (const [method, path, body] of [
      ["GET", presetPath(alpha.id, hidden.id)],
      ["PATCH", presetPath(alpha.id, visible.id), { name: "Unauthorized rename" }],
      ["POST", collection(alpha.id), { name: "Unauthorized creation", template: {} }],
      ["GET", collection(beta.id)],
    ]) {
      const denied = await fixture.request(method, path, { session, body });
      assert.equal(denied.status, 403, `${method} ${path}`);
    }
    const wrongOwner = await readPreset(fixture, beta.id, visible.id);
    assert.equal(wrongOwner.status, 404);
    // Writes addressed through the wrong Namespace are a scope miss, not a write conflict.
    for (const method of ["PATCH", "DELETE"]) {
      const misdirected = await fixture.request(
        method,
        presetPath(beta.id, visible.id),
        method === "PATCH" ? { body: { name: "Moved" } } : {},
      );
      assert.equal(misdirected.status, 404, `${method}: ${JSON.stringify(misdirected.body)}`);
      assert.equal(misdirected.body.error.code, "NOT_FOUND", method);
    }

    const renamed = await fixture.request("PATCH", presetPath(alpha.id, visible.id), {
      body: { name: "Renamed" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.name, "Renamed");
    assert.deepEqual(renamed.data.template, {});
    await deletePreset(fixture, alpha.id, visible.id);
    assert.equal((await readPreset(fixture, alpha.id, visible.id)).status, 404);
    // Each successful write leaves exactly one attributable mutation row.
    assert.deepEqual(
      fixture.audit.events
        .filter(
          (event) =>
            event.kind === "mutation" &&
            event.resource.kind === "preset" &&
            event.resource.id === visible.id &&
            event.outcome === "success",
        )
        .map((event) => [event.action, event.resource.namespaceId]),
      [
        ["openclaw.presets.create", alpha.id],
        ["openclaw.presets.update", alpha.id],
        ["openclaw.presets.delete", alpha.id],
      ],
    );
  });

  test("Preset HTTP writes preserve all four full-size initial workspace files", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Workspace Preset", { ready: true });
    const content = (
      "# Workspace guidance\n" + "Routine fixture instructions.\n".repeat(600)
    ).slice(0, 16 * 1024);
    const template = {
      agent: {
        initialWorkspaceFiles: Object.fromEntries(
          ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"].map((name) => [name, content]),
        ),
      },
    };
    const created = await createPreset(fixture, namespace.id, "Full workspace", template);
    assert.deepEqual((await readPreset(fixture, namespace.id, created.id)).data.template, template);
    const replacement = await createPreset(fixture, namespace.id, "Replacement", {});
    await patchTemplate(fixture, namespace.id, replacement.id, template);
    assert.deepEqual(
      (await readPreset(fixture, namespace.id, replacement.id)).data.template,
      template,
    );
  });

  test("Preset transport admits the template JSON limit and escaped strings, while admission still rejects larger templates", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Preset JSON budget", { ready: true });
    const template = { variables: { guidance: { type: "string", default: "" } } };
    const overhead = Buffer.byteLength(JSON.stringify(template));
    template.variables.guidance.default = "Routine guidance. "
      .repeat(60_000)
      .slice(0, 1024 * 1024 - overhead);
    assert.equal(Buffer.byteLength(JSON.stringify(template)), 1024 * 1024);
    const accepted = await createPreset(fixture, namespace.id, "JSON boundary", template);
    assert.deepEqual(
      (await readPreset(fixture, namespace.id, accepted.id)).data.template,
      template,
    );

    // JSON permits Unicode escapes for ordinary string characters, without changing the template.
    const encoded = JSON.stringify({ name: "Escaped JSON", template }).replace(
      /[A-Za-z .]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const escaped = await fetch(fixture.origin + collection(namespace.id), {
      method: "POST",
      headers: {
        ...authenticatedHeaders(await fixture.signIn()),
        "content-type": "application/json",
      },
      body: encoded,
    });
    assert.equal(escaped.status, 201, await escaped.text());

    const oversized = structuredClone(template);
    oversized.variables.guidance.default += "x";
    const rejected = await fixture.request("PATCH", presetPath(namespace.id, accepted.id), {
      body: { template: oversized },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error.message, /JSON exceeds maximum size of 1 MiB/);
    assert.deepEqual(
      (await readPreset(fixture, namespace.id, accepted.id)).data.template,
      template,
    );
  });

  test("Preset writes refuse a caller without the grant before reading the body", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Preset pre-body grant", { ready: true });
    const existing = await createPreset(fixture, namespace.id, "Existing");
    const member = await fixture.createAccountWithPolicy("preset-member", (principal) => {
      grantRole(fixture.policy, principal.id, {
        id: "pre-body-namespace-reader",
        bindingId: "pre-body-read-namespace",
        namespaceId: namespace.id,
        permissions: { namespace: ["read"], preset: ["read"] },
      });
    });
    const memberId = member.principal.id;
    const session = await fixture.signIn(member.credentials);
    // Over the general 64 KiB limit and under the Preset route limit (6 MiB + 8 KiB).
    const declaredBytes = 6 * 1024 * 1024;
    const forbidden = {
      code: "FORBIDDEN",
      message: "The exact platform operation was not authorized.",
    };
    for (const [method, path, action, grant, targetId] of [
      ["POST", collection(namespace.id), "openclaw.presets.create", "create", namespace.id],
      [
        "PATCH",
        presetPath(namespace.id, existing.id),
        "openclaw.presets.update",
        "update",
        existing.id,
      ],
    ]) {
      const target = { kind: "preset", id: targetId, namespaceId: namespace.id };
      const small = await fixture.request(method, path, {
        session,
        body: { name: "Unauthorized", template: {} },
      });
      assert.equal(small.status, 403, `${method}: ${JSON.stringify(small.body)}`);
      assert.deepEqual(small.body.error, forbidden, method);
      const auditStart = fixture.audit.events.length;
      const refused = await partialWrite({
        origin: fixture.origin,
        method,
        path,
        session,
        declaredBytes,
        bodyPrefix:
          '{"name":"Unread","template":{"variables":{"guidance":{"type":"string","default":"',
      });
      assert.notEqual(refused, null, `${method}: the controller waited for the unread body`);
      assert.equal(refused.status, 403, `${method}: ${JSON.stringify(refused.body)}`);
      assert.deepEqual(refused.body.error, forbidden, method);
      // The refusal keeps its audit row, naming the exact grant the write itself checks.
      assertWriteAuthorizationDenial(
        fixture.audit.events.slice(auditStart),
        { principalId: memberId, action, grant, resource: target },
        method,
      );
    }
    assert.deepEqual((await readPreset(fixture, namespace.id, existing.id)).data, existing);
    assert.deepEqual(
      (await listPresets(fixture, namespace.id)).map((preset) => preset.id),
      [existing.id],
    );
  });

  test("Preset writes check the grant again in their transaction after the pre-body check", async (t) => {
    // Own app: the pre-body check is patched controller-wide.
    const fixture = await createFixture(t);
    const namespace = await fixture.createNamespace("Preset grant re-check", { ready: true });
    const existing = await createPreset(fixture, namespace.id, "Existing");
    let writer;
    const member = await fixture.createAccountWithPolicy("preset-writer", (principal) => {
      ({ binding: writer } = grantRole(fixture.policy, principal.id, {
        id: "re-check-preset-writer",
        bindingId: "re-check-write-presets",
        namespaceId: namespace.id,
        permissions: { namespace: ["read"], preset: ["read", "create", "update"] },
      }));
    });
    const session = await fixture.signIn(member.credentials);
    // The grant is withdrawn right after the pre-body check passes, before the handler runs.
    const occ = fixture.controller;
    const preBodyCheck = occ.authorizePresetWrite;
    occ.authorizePresetWrite = async (...args) => {
      await preBodyCheck.apply(occ, args);
      const index = fixture.policy.bindings.indexOf(writer);
      assert.notEqual(index, -1);
      fixture.policy.bindings.splice(index, 1);
    };
    t.after(() => delete occ.authorizePresetWrite);
    for (const [method, path] of [
      ["POST", collection(namespace.id)],
      ["PATCH", presetPath(namespace.id, existing.id)],
    ]) {
      const refused = await fixture.request(method, path, {
        session,
        body: { name: "Withdrawn", template: {} },
      });
      assert.equal(refused.status, 403, `${method}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error.code, "FORBIDDEN", method);
      // The pre-body check passed and withdrew the grant; restore it for the next write.
      assert.equal(fixture.policy.bindings.includes(writer), false, method);
      fixture.policy.bindings.push(writer);
    }
    assert.deepEqual(await listPresets(fixture, namespace.id), [presetSummary(existing)]);
  });

  test("Preset variables create independent ordinary Agent drafts that survive template replacement and deletion", async (t) => {
    // Own app: it registers and selects a plugin Driver.
    const fixture = await createFixture(t);
    const namespace = await fixture.createNamespace("Preset drafts", { ready: true });
    const template = {
      variables: {
        name: { type: "string" },
        model: { type: "string", default: "openai/gpt-5.1" },
        reviewer: { type: "string", default: "U456" },
        enabled: { type: "boolean", default: true },
        mode: { type: "string", default: "unfinished" },
        access: { type: "string", default: "git-read" },
      },
      agent: {
        name: "{{ vars.name }}",
        executionMode: "{{ vars.mode }}",
        plugins: { github: { enabled: "unfinished", toolDefaults: { approval: "all_actions" } } },
        pluginApprovers: [{ channel: "slack", id: "team:T123:user:{{ vars.reviewer }}" }],
        harnessAuth: null,
        repositoryAccess: { defaultProfile: "{{ vars.access }}", repositories: [] },
        initialWorkspaceFiles: {
          "AGENTS.md": "# {{ vars.name }}\n",
          "IDENTITY.md": "",
          "USER.md": "Model {{ vars.model }}",
        },
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
    const pluginDriver = new OCCPluginDriver();
    fixture.controller.registerDriver(pluginDriver);
    fixture.controller.selectDriver("plugin", pluginDriver.id);
    const read = await readPreset(fixture, namespace.id, preset.id);
    assert.equal(read.status, 200);
    assert.deepEqual(read.data.template, template);
    // The API consumer uses the same renderer as the console, then the ordinary two-create flow.
    const rendered = renderPresetTemplate(read.data.template, {
      name: 'My "Agent"',
      enabled: false,
    });
    const configuration = await createAgentConfiguration(fixture, namespace.id, rendered);
    const values = configuration.data.values;
    assert.equal(values.agents.defaults.model, "openai/gpt-5.1");
    assert.deepEqual(Object.keys(values.agents.defaults.models), ["openai/gpt-5.1"]);
    assert.equal(values.gateway.controlUi.enabled, false);
    assert.equal(values.gateway.auth.password, "${OPENCLAW_GATEWAY_PASSWORD}");
    assert.deepEqual(
      values.models.providers.openai.apiKey,
      template.configuration.values.models.providers.openai.apiKey,
    );
    assert.deepEqual(rendered.agent.initialWorkspaceFiles, {
      "AGENTS.md": '# My "Agent"\n',
      "IDENTITY.md": "",
      "USER.md": "Model openai/gpt-5.1",
    });
    assert.deepEqual(rendered.agent.pluginApprovers, [
      { channel: "slack", id: "team:T123:user:U456" },
    ]);
    // Presets may be unfinished. The ordinary API rejects invalid launch fields
    // after Configuration creation; correcting the draft reuses that Configuration.
    const rejected = await postAgent(fixture, namespace.id, rendered, configuration);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.deepEqual((await fixture.request("GET", agentsPath(namespace.id))).data, []);
    const created = await postAgent(fixture, namespace.id, rendered, configuration, {
      executionMode: "embedded",
      plugins: {},
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.name, 'My "Agent"');
    assert.equal(created.data.configurationId, configuration.data.id);
    assert.deepEqual(created.data.repositoryAccess, {
      defaultProfile: "git-read",
      repositories: [],
    });
    assert.deepEqual(created.data.pluginApprovers, rendered.agent.pluginApprovers);
    assert.equal(Object.hasOwn(created.data, "presetId"), false);
    const workspaceSetup = await fixture.state.read((state) =>
      state.workspaceSetups.find(namespace.id, created.data.id),
    );
    assert.deepEqual(workspaceSetup?.files, rendered.agent.initialWorkspaceFiles);

    const replaced = await patchTemplate(fixture, namespace.id, preset.id, {
      agent: { name: "Changed later" },
    });
    assert.deepEqual(replaced.template, { agent: { name: "Changed later" } });
    await deletePreset(fixture, namespace.id, preset.id);
    for (const [path, saved] of [
      [`${agentsPath(namespace.id)}/${created.data.id}`, created.data],
      [`/namespaces/${namespace.id}/configurations/${configuration.data.id}`, configuration.data],
    ]) {
      const response = await fixture.request("GET", path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(response.data, saved, path);
    }
  });

  test("Preset admission rejects malformed templates and credential leaks while preserving Secret reference isolation", async () => {
    const fixture = await shared();
    const alpha = await fixture.createNamespace("Credential owner", { ready: true });
    const beta = await fixture.createNamespace("Other credential owner", { ready: true });
    const secret = await fixture.createSecret(
      alpha.id,
      "Model key",
      "synthetic-preset-secret-value",
    );
    const wrongSecret = await fixture.createSecret(beta.id, "Other key", "synthetic-other-secret");
    const sentinel = "synthetic-preset-credential-must-not-persist";
    // A null list used to persist successfully, then crash the Console's Use Preset flow.
    const nullRepositoryTemplate = {
      agent: { repositoryAccess: { defaultProfile: "git-read", repositories: null } },
    };
    const unsafeTemplates = [
      nullRepositoryTemplate,
      { configuration: { secretBindings: { OPENAI_API_KEY: { source: secret.ref } } } },
      { agent: { namespaceId: beta.id } },
      { agent: { harnessAuth: { method: "api_key", source: wrongSecret.ref } } },
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
    assert.deepEqual(await listPresets(fixture, alpha.id), []);

    const preset = await createPreset(fixture, alpha.id, "Secret reference", {
      variables: { secretId: { type: "string", default: secret.ref.id } },
      configuration: {
        values: {},
        secretBindings: {
          SLACK_BOT_TOKEN: {
            source: { kind: "secret", id: "{{ vars.secretId }}" },
          },
        },
      },
    });
    const rejectedUpdate = await fixture.request("PATCH", presetPath(alpha.id, preset.id), {
      body: { template: nullRepositoryTemplate },
    });
    assert.equal(rejectedUpdate.status, 400, JSON.stringify(rejectedUpdate.body));
    const unchanged = await readPreset(fixture, alpha.id, preset.id);
    assert.equal(unchanged.status, 200);
    assert.deepEqual(unchanged.data.template, preset.template);
    const rendered = renderPresetTemplate(preset.template, { secretId: secret.ref.id });
    const reader = await fixture.createAccountWithPolicy(
      "preset-user-without-secret",
      (principal) => {
        grantRole(fixture.policy, principal.id, {
          id: "preset-consumer",
          namespaceId: alpha.id,
          permissions: { preset: ["read"], configuration: ["create"] },
        });
      },
    );
    const session = await fixture.signIn(reader.credentials);
    const selected = await fixture.request("GET", presetPath(alpha.id, preset.id), { session });
    assert.equal(selected.status, 200);
    const createConfiguration = (configuration, options) =>
      fixture.request("POST", `/namespaces/${alpha.id}/configurations`, {
        ...options,
        body: { kind: "agent", ...configuration },
      });
    const denied = await createConfiguration(rendered.configuration, { session });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    // Substitution is not an authorization grant, including for an ID from another Namespace.
    const wrongScope = renderPresetTemplate(preset.template, { secretId: wrongSecret.ref.id });
    const invalid = await createConfiguration(wrongScope.configuration);
    assert.equal(invalid.status, 404, JSON.stringify(invalid.body));
    const admitted = await createConfiguration(rendered.configuration);
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

  test("Preset write errors name the template field and the shape it expects", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Preset errors", { ready: true });
    const contract = "The request does not match the operation contract:";
    const openaiModel = {
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
          models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    const unsupportedType = `${contract} body /template/variables/model/type has an unsupported value (expected one of "string", "number", "boolean", "password").`;
    // Each rejection names one field and what it accepts, so a CLI or API user can fix it directly.
    const cases = [
      [
        { agent: { name: "{{ vars.missing }}" } },
        "Preset agent.name: variable missing is undeclared; declare it under variables.",
      ],
      [
        { variables: { model: { type: "string", default: 123 } } },
        "Preset variables.model: default must match its declared type, string.",
      ],
      [
        { variables: { key: { type: "password", default: "stored" } } },
        "Preset variables.key: password variables cannot have stored defaults.",
      ],
      [
        { variables: { model: { type: "strng" } } },
        unsupportedType,
        [{ path: "/template/variables/model/type", code: "INVALID_VALUE" }],
      ],
      // A number fails each string literal on both type and value; the accepted values are still named once.
      [
        { variables: { model: { type: 5 } } },
        unsupportedType,
        [{ path: "/template/variables/model/type", code: "INVALID_VALUE" }],
      ],
      [
        { variables: { model: { type: "string", default: { nested: true } } } },
        `${contract} body /template/variables/model/default has the wrong type (expected one of string, number, boolean).`,
        [{ path: "/template/variables/model/default", code: "INVALID_TYPE" }],
      ],
      [
        { variables: { model: { type: "number", extra: 1 } } },
        `${contract} body /template/variables/model/extra is not an accepted field.`,
        [{ path: "/template/variables/model/extra", code: "UNKNOWN_FIELD" }],
      ], // Kubernetes Compute's topology-independent rules refuse the rendered values with the
      // Configuration save message (finding 1116), not at the first deployment.
      [
        {
          configuration: {
            values: { ...openaiModel, channels: { discord: { enabled: true } } },
          },
        },
        "Configuration setting channels.discord is not a supported channel: use slack or msteams, or set its enabled to false.",
      ],
      [
        {
          configuration: {
            values: {
              ...openaiModel,
              env: { vars: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } },
            },
          },
        },
        "Configuration setting env.vars.ANTHROPIC_API_KEY must not be set: the Agent's Harness authentication binding owns model provider environment.",
      ],
      // A literal both rule sets refuse gets the Compute message, as on Configuration save.
      [
        {
          configuration: {
            values: {
              ...openaiModel,
              models: {
                providers: {
                  openai: {
                    request: { auth: { mode: "authorization-bearer", token: "sk-literal" } },
                  },
                },
              },
            },
          },
        },
        `Configuration setting models.providers.openai.request.auth must be unset or {mode: "provider-default"}: model credentials come from the Agent's Harness authentication binding.`,
      ],
    ];
    for (const [template, message, details] of cases) {
      const rejected = await fixture.request("POST", collection(namespace.id), {
        body: { name: "Rejected", template },
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.code, "INVALID_REQUEST");
      assert.equal(rejected.body.error.message, message);
      assert.deepEqual(rejected.body.error.details, details);
    }
    assert.deepEqual(await listPresets(fixture, namespace.id), []);
  });

  test("method-only Preset authentication is a default, not an Agent credential", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Method-only Preset", { ready: true });
    const template = {
      variables: {
        name: { type: "string" },
        model: { type: "string", default: "gpt-6-astra" },
      },
      agent: {
        name: "{{ vars.name }}",
        executionMode: "dedicated",
        harnessAuth: { method: "codex_pat" },
      },
      configuration: {
        values: {
          agents: {
            defaults: {
              model: "codex/{{ vars.model }}",
              models: {
                "codex/{{ vars.model }}": { agentRuntime: { id: "codex" } },
              },
            },
          },
          gateway: { auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" } },
          models: {
            providers: {
              codex: {
                models: [{ id: "{{ vars.model }}", name: "{{ vars.model }}" }],
              },
            },
          },
        },
      },
    };
    const preset = await createPreset(fixture, namespace.id, "Method default", template);
    const rendered = renderPresetTemplate(preset.template, {
      name: "Method-only Agent",
      model: "gpt-6-astra",
    });
    assert.deepEqual(rendered.agent.harnessAuth, { method: "codex_pat" });
    const configuration = await createAgentConfiguration(fixture, namespace.id, rendered);
    const rejected = await postAgent(fixture, namespace.id, rendered, configuration);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    const secret = await fixture.createSecret(
      namespace.id,
      "Service account token",
      "synthetic-token",
    );
    const created = await postAgent(fixture, namespace.id, rendered, configuration, {
      harnessAuth: { method: "codex_pat", source: secret.ref },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.data.harnessAuth, { method: "codex_pat", source: secret.ref });
  });

  test("Presets block Namespace deletion and deleting one removes only its managed resource bindings", async () => {
    const fixture = await shared();
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
    const role = await presetReaderRole(fixture, namespace.id);
    const bindings = [];
    for (const preset of [target, preserved]) {
      bindings.push(
        await bindPreset(fixture, namespace.id, {
          subjectId: agent.servicePrincipalId,
          roleId: role.id,
          presetId: preset.id,
        }),
      );
    }
    await deletePreset(fixture, namespace.id, target.id);
    const deletion = fixture.audit.events.filter(
      (event) =>
        event.action === "openclaw.presets.delete" &&
        event.resource.id === target.id &&
        event.outcome === "success",
    );
    assert.equal(deletion.length, 1);
    assert.deepEqual(
      deletion[0].details.removedAccessBindings.map((binding) => binding.id),
      [bindings[0].id],
    );
    const remaining = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/iam/access-bindings`,
    );
    assert.equal(remaining.status, 200);
    assert.deepEqual(
      remaining.data.map((binding) => binding.id),
      [bindings[1].id],
    );
    for (const path of [
      `/namespaces/${namespace.id}/iam/roles/${role.id}`,
      `${agentsPath(namespace.id)}/${agent.id}`,
    ]) {
      assert.equal((await fixture.request("GET", path)).status, 200, path);
    }
  });

  test("standard Codex Preset installs and creates a dedicated Agent with restricted native configuration", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Standard Codex", { ready: true });
    const secret = await fixture.createSecret(namespace.id, "Model key", "synthetic-model-key");
    // Install the shipped request through the operator API, then render the
    // persisted template as the existing console chooser does.
    const { artifact, installed, preset } = await installFromCatalog(
      fixture,
      namespace.id,
      "standard-codex.json",
    );
    assert.equal(preset.name, "Standard Codex");
    // PATCH accepts the same portable request and binds it to the route Namespace.
    const updated = await patchTemplate(fixture, namespace.id, preset.id, artifact.template);
    assert.deepEqual(updated.template, artifact.template);
    const rendered = renderPresetTemplate(preset.template, {
      name: "Restricted assistant",
      model: "gpt-5.1",
      modelSecret: "synthetic-model-key",
    });
    const { agent, values } = await launchWithKey(
      fixture,
      namespace.id,
      rendered,
      secret,
      installed,
    );
    assert.equal(agent.executionMode, "dedicated");
    assert.equal(values.agents.defaults.model, "codex/gpt-5.1");
    assert.equal(values.agents.defaults.models["codex/gpt-5.1"].agentRuntime.id, "codex");
    assert.equal(values.models.providers.codex.baseUrl, "http://127.0.0.1:9");
    assert.equal(Object.hasOwn(values.models.providers.codex, "apiKey"), false);
    const appServer = values.plugins.entries.codex.config.appServer;
    assert.equal(appServer.transport, "websocket");
    assert.equal(appServer.url, "${APP_SERVER_URL}");
    assert.equal(appServer.authToken, "${APP_SERVER_TOKEN}");
    assert.equal(appServer.sandbox, "workspace-write");
    assert.equal(appServer.approvalPolicy, "on-request");
    assert.deepEqual(appServer.networkProxy, {
      enabled: true,
      baseProfile: "workspace",
      mode: "limited",
      domains: {
        "codeload.github.com": "allow",
        "dl.google.com": "allow",
        "github.com": "allow",
        "go.dev": "allow",
        "nodejs.org": "allow",
        "proxy.golang.org": "allow",
        "registry.npmjs.org": "allow",
        "storage.googleapis.com": "allow",
        "sum.golang.org": "allow",
      },
      unixSockets: {},
      enableSocks5: false,
      enableSocks5Udp: false,
      allowUpstreamProxy: false,
      allowLocalBinding: false,
      dangerouslyAllowNonLoopbackProxy: false,
      dangerouslyAllowAllUnixSockets: false,
    });
    assert.deepEqual(values.tools.web.search, {
      enabled: true,
      openaiCodex: { enabled: true, mode: "cached" },
    });

    // Variable substitution cannot grant access to another Namespace's model key.
    const other = await fixture.createNamespace("Other owner", { ready: true });
    // The identical artifact installs independently in another Namespace without inputs for scope.
    const { installed: otherInstalled } = await installShipped(
      fixture,
      other.id,
      "standard-codex.json",
    );
    assert.deepEqual(otherInstalled.data.template, artifact.template);
    const boundTemplate = structuredClone(preset.template);
    boundTemplate.agent.harnessAuth = { method: "api_key", source: secret.ref };
    const crossNamespaceUpdate = await fixture.request(
      "PATCH",
      presetPath(other.id, otherInstalled.data.id),
      { body: { template: boundTemplate } },
    );
    assert.equal(crossNamespaceUpdate.status, 400, JSON.stringify(crossNamespaceUpdate.body));
    const otherConfiguration = await createAgentConfiguration(fixture, other.id, rendered);
    const rejected = await postAgent(fixture, other.id, rendered, otherConfiguration, {
      harnessAuth: { method: "api_key", source: secret.ref },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.message, "Secret references cannot cross Namespaces.");
  });

  test("standard OpenClaw Preset installs and creates an embedded Agent with native configuration", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Standard OpenClaw", { ready: true });
    const secret = await fixture.createSecret(namespace.id, "Model key", "synthetic-model-key");
    const { installed, preset } = await installFromCatalog(
      fixture,
      namespace.id,
      "standard-openclaw.json",
    );
    assert.equal(preset.name, "Standard OpenClaw");
    const rendered = renderPresetTemplate(preset.template, {
      name: "Native assistant",
      model: "gpt-6-sol",
      modelSecret: "synthetic-model-key",
    });
    const { agent, values } = await launchWithKey(
      fixture,
      namespace.id,
      rendered,
      secret,
      installed,
    );
    assert.equal(agent.executionMode, "embedded");
    assert.equal(values.agents.defaults.model, "openai/gpt-6-sol");
    assert.equal(values.agents.defaults.models["openai/gpt-6-sol"].agentRuntime.id, "openclaw");
    assert.equal(values.models.providers.openai.baseUrl, "https://api.openai.com/v1");
    assert.equal(values.models.providers.openai.api, "openai-responses");
    assert.deepEqual(values.models.providers.openai.models, [
      { id: "gpt-6-sol", name: "gpt-6-sol" },
    ]);
    assert.equal(values.plugins, undefined);
    assert.deepEqual(values.tools.web.search, { enabled: true });
  });

  test("default-codex Preset creates a Configuration that references the generated gateway password", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Default Codex", { ready: true });
    const gatewayPassword = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" };
    // D381: a dedicated Codex Gateway acknowledges its workspace node through the
    // in-Pod gateway CLI, which is refused without this password reference. Every
    // bundled Preset carries it and none chooses the authentication mode, which
    // stays with the Compute Driver (#314).
    for (const file of [
      "default-codex.json",
      "standard-codex.json",
      "standard-openclaw.json",
      "swe-preset.json",
    ]) {
      const bundled = await shippedPreset(file);
      assert.deepEqual(
        bundled.template.configuration.values.gateway.auth,
        { password: gatewayPassword },
        file,
      );
    }
    const { installed } = await installShipped(fixture, namespace.id, "default-codex.json");
    const rendered = renderPresetTemplate(installed.data.template, {});
    const configuration = await createAgentConfiguration(fixture, namespace.id, rendered);
    assert.equal(rendered.agent.executionMode, "dedicated");
    assert.deepEqual(configuration.data.values.gateway.auth, { password: gatewayPassword });
  });

  test("SWE Agent Preset defaults to Astra and reuses an existing service-account Secret", async (t) => {
    // The SWE Preset enables Slack, which Agent save refuses without an Installation channel
    // runtime, as deployment does.
    const fixture = await createFixture(t, { channelRuntime: true });
    const namespace = await fixture.createNamespace("SWE Agent service account", { ready: true });
    const serviceAccount = await fixture.createSecret(
      namespace.id,
      "Existing service account token",
      "synthetic-existing-service-account-token",
    );
    const artifact = await shippedPreset("swe-preset.json");
    const originalTemplate = structuredClone(artifact.template);
    validatePresetTemplate(originalTemplate);
    assert.equal(artifact.name, "SWE Agent");
    assert.equal(Object.hasOwn(originalTemplate.variables, "modelSecret"), false);
    assert.equal(originalTemplate.variables.model.default, "gpt-6-astra");
    assert.equal(originalTemplate.agent.executionMode, "dedicated");
    assert.deepEqual(originalTemplate.agent.harnessAuth, { method: "codex_pat" });

    const { installed } = await installShipped(fixture, namespace.id, "swe-preset.json");
    assert.deepEqual(installed.data.template, originalTemplate);
    const defaultRendered = renderPresetTemplate(originalTemplate, { name: "SWE lifecycle" });
    assert.deepEqual(defaultRendered.agent.harnessAuth, { method: "codex_pat" });
    const selectedTemplate = structuredClone(originalTemplate);
    selectedTemplate.agent.harnessAuth = { method: "codex_pat", source: serviceAccount.ref };

    const rendered = renderPresetTemplate(selectedTemplate, { name: "SWE lifecycle" });
    assert.deepEqual(rendered.agent.harnessAuth, {
      method: "codex_pat",
      source: serviceAccount.ref,
    });
    assert.deepEqual(rendered.configuration.values.channels.slack.replyToModeByChatType, {
      channel: "all",
    });
    for (const [values, model] of [
      [rendered.configuration.values, "gpt-6-astra"],
      [
        renderPresetTemplate(selectedTemplate, { name: "SWE override", model: "gpt-6-sol" })
          .configuration.values,
        "gpt-6-sol",
      ],
    ]) {
      assert.equal(values.agents.defaults.model, `codex/${model}`);
      assert.deepEqual(Object.keys(values.agents.defaults.models), [`codex/${model}`]);
      assert.equal(values.agents.defaults.models[`codex/${model}`].agentRuntime.id, "codex");
    }

    const retained = await readPreset(fixture, namespace.id, installed.data.id);
    assert.equal(retained.status, 200, JSON.stringify(retained.body));
    assert.deepEqual(retained.data.template, originalTemplate);

    // The channel editor binds the Slack tokens before the Agent is saved; Agent save refuses
    // Slack references without bindings, as deployment does.
    const slackSecrets = [
      await fixture.createSecret(namespace.id, "SWE Slack app token", "synthetic-slack-app"),
      await fixture.createSecret(namespace.id, "SWE Slack bot token", "synthetic-slack-bot"),
    ];
    const configuration = await createAgentConfiguration(fixture, namespace.id, {
      ...rendered,
      configuration: {
        ...rendered.configuration,
        secretBindings: {
          SLACK_APP_TOKEN: { source: slackSecrets[0].ref },
          SLACK_BOT_TOKEN: { source: slackSecrets[1].ref },
        },
      },
    });
    assert.deepEqual(configuration.data.values.channels.slack.replyToModeByChatType, {
      channel: "all",
    });
    // The reusable preset must not admit any preconfigured deployment-specific channels.
    assert.deepEqual(configuration.data.values.channels.slack.channels, {});
    const secretIds = async () =>
      (await fixture.request("GET", `/namespaces/${namespace.id}/secrets`)).data.map(
        (secret) => secret.id,
      );
    const existingSecretIds = [serviceAccount.id, ...slackSecrets.map((secret) => secret.id)];
    assert.deepEqual((await secretIds()).sort(), existingSecretIds.toSorted());
    const created = [];
    for (const name of ["SWE existing service account", "SWE existing service account reuse"]) {
      const agent = await postAgent(fixture, namespace.id, rendered, configuration, { name });
      assert.equal(agent.status, 201, JSON.stringify(agent.body));
      assert.equal(agent.data.executionMode, "dedicated");
      assert.deepEqual(agent.data.harnessAuth, {
        method: "codex_pat",
        source: serviceAccount.ref,
      });
      created.push(agent);
    }
    assert.deepEqual((await secretIds()).sort(), existingSecretIds.toSorted());
    for (const body of [installed.body, created[0].body]) {
      assert.equal(
        JSON.stringify(body).includes("synthetic-existing-service-account-token"),
        false,
      );
    }
  });

  test("password Presets reject stored credentials and password substitution outside credential inputs", async () => {
    const fixture = await shared();
    const namespace = await fixture.createNamespace("Password admission", { ready: true });
    const template = {
      variables: { key: { type: "password" } },
      agent: { harnessAuth: { method: "api_key", secret: "{{ vars.key }}" } },
    };
    const preset = await createPreset(fixture, namespace.id, "Password", template);
    const unsafe = [
      { ...template, variables: { key: { type: "password", default: "sentinel-credential" } } },
      { ...template, agent: { harnessAuth: { method: "api_key", secret: "sentinel-credential" } } },
      { ...template, variables: { key: { type: "string", default: "sentinel-credential" } } },
      { ...template, agent: { name: "{{ vars.key }}" } },
      { ...template, configuration: { values: { env: { MODEL_KEY: "{{ vars.key }}" } } } },
      {
        ...template,
        agent: { harnessAuth: { method: "api_key", secret: "prefix-{{ vars.key }}" } },
      },
    ];
    for (const candidate of unsafe) {
      for (const [method, path] of [
        ["POST", collection(namespace.id)],
        ["PATCH", presetPath(namespace.id, preset.id)],
      ]) {
        const response = await fixture.request(method, path, {
          body: { name: "Unsafe", template: candidate },
        });
        assert.equal(response.status, 400, JSON.stringify(response.body));
        assert.equal(JSON.stringify(response.body).includes("sentinel-credential"), false);
      }
    }
    assert.deepEqual((await readPreset(fixture, namespace.id, preset.id)).data.template, template);
    assert.equal(JSON.stringify(fixture.audit.events).includes("sentinel-credential"), false);
  });

  test("Installation YAML seeds authorized default Presets for new and existing Namespaces without replacing copies", async (t) => {
    const customPreset = await shippedPreset("swe-preset.json");
    const runtime = await bundledRuntime(t, {
      includeDefaults: true,
      files: [fileURLToPath(new URL("../../deploy/presets/swe-preset.json", import.meta.url))],
    });
    const fixture = await createFixture(t, { defaultPresets: runtime.defaultPresets });
    const principal = fixture.admin;
    const namespace = await fixture.createNamespace("Default catalog", { ready: true });
    const list = await fixture.request("GET", collection(namespace.id));
    assert.equal(list.status, 200);
    const defaultNames = [
      customPreset.name,
      "default-codex",
      "Standard Codex",
      "Standard OpenClaw",
    ].sort();
    assert.deepEqual(list.data.map((preset) => preset.name).sort(), defaultNames);
    const documents = await listPresetDocuments(fixture, namespace.id);
    const named = (name) => documents.find((preset) => preset.name === name);
    assert.equal(named("Standard Codex").template.variables.modelSecret.type, "password");
    const customDefault = named(customPreset.name);
    assert.ok(customDefault, `missing ${customPreset.name}`);
    assert.equal(Object.hasOwn(customDefault.template.variables, "modelSecret"), false);
    assert.equal(customDefault.template.variables.model.default, "gpt-6-astra");
    assert.equal(customDefault.template.agent.harnessAuth.method, "codex_pat");
    assert.deepEqual(customDefault.template.configuration.values.channels.slack.channels, {});
    assert.equal(customDefault.template.configuration.values.plugins.entries.slack.enabled, true);
    const openclaw = named("Standard OpenClaw");
    assert.equal(openclaw.template.agent.executionMode, "embedded");
    assert.equal(openclaw.template.agent.harnessAuth.method, "api_key");
    assert.equal(
      openclaw.template.configuration.values.agents.defaults.models["openai/{{ vars.model }}"]
        .agentRuntime.id,
      "openclaw",
    );
    const renamedTemplate = { agent: { name: "Operator customization" } };
    await patchTemplate(fixture, namespace.id, list.data[0].id, renamedTemplate);
    // Simulate a Namespace persisted before the setting was enabled, then run the
    // same initialization invoked by production and development API composition.
    const existing = await persistedNamespace(fixture, "Existing namespace");
    // A Namespace that is being deleted is skipped and does not fail startup. Its unmodified
    // defaults from creation do not block the deletion request.
    const leaving = await fixture.createNamespace("Leaving namespace", { ready: true });
    const leave = await fixture.request("DELETE", `/namespaces/${leaving.id}`);
    assert.equal(leave.status, 202, JSON.stringify(leave.body));
    await Promise.all([
      fixture.controller.initializeDefaultPresets(principal.id),
      fixture.controller.initializeDefaultPresets(principal.id),
    ]);
    const retained = await readPreset(fixture, namespace.id, list.data[0].id);
    assert.deepEqual(retained.data.template, renamedTemplate);
    const seeded = await listPresets(fixture, existing.id);
    assert.deepEqual(seeded.map((preset) => preset.name).sort(), defaultNames);
    const audit = auditFrom(fixture, "installation-defaults");
    assert.ok(
      audit.some((event) => event.resource.id === seeded[0].id && event.actorId === principal.id),
    );
    assert.equal(audit.filter((event) => event.resource.id === seeded[0].id).length, 1);

    // Namespace creation must roll back if its caller cannot create the defaults.
    const limited = await fixture.createAccountWithPolicy("namespace-only", (identity) => {
      grantRole(fixture.policy, identity.id, {
        id: "namespace-only",
        permissions: { namespace: ["create"] },
      });
    });
    const session = await fixture.signIn(limited.credentials);
    const createDeniedDefaults = () =>
      fixture.request("POST", "/namespaces", { session, body: { name: "Denied defaults" } });
    const denied = await createDeniedDefaults();
    assert.equal(denied.status, 403);
    const afterDenied = await fixture.request("GET", "/namespaces");
    assert.equal(
      afterDenied.data.some((item) => item.name === "Denied defaults"),
      false,
    );
    fixture.policy.roles
      .find((role) => role.id === "namespace-only")
      .permissions.push({ action: "create", resourceKind: "preset" });
    const permitted = await createDeniedDefaults();
    assert.equal(permitted.status, 201);
    const provisioningPresets = await listPresets(fixture, permitted.data.id);
    assert.deepEqual(provisioningPresets.map((preset) => preset.name).sort(), defaultNames);
    // Startup seeds the defaults while the Namespace provisions; callers wait until it is ready.
    for (const [method, path, body] of [
      ["POST", collection(permitted.data.id), { name: "Too early", template: {} }],
      ["PATCH", presetPath(permitted.data.id, provisioningPresets[0].id), { name: "Too early" }],
    ]) {
      const early = await fixture.request(method, path, { body });
      assert.equal(early.status, 409, `${method}: ${JSON.stringify(early.body)}`);
      assert.equal(early.body.error.code, "NAMESPACE_NOT_READY", method);
    }
    // Startup must skip a persisted non-administrator even when it is returned first.
    await initializeInstallationPresets(
      fixture.controller,
      iamOf(fixture),
      [limited.principal, principal],
      runtime.defaultPresets,
    );
    // Disabling startup defaults never removes a saved Preset.
    const disabledRuntime = await bundledRuntime(t, { includeDefaults: false });
    const disabled = new OpenClawController(fixture.controller.installation, {
      state: fixture.state,
      defaultPresets: disabledRuntime.defaultPresets,
    });
    await disabled.initializeDefaultPresets(principal.id);
    assert.deepEqual(await presetNames(fixture, existing.id), defaultNames);
  });

  test("startup seeds default Presets with an administrator who can create them when an Installation-only administrator is returned first", async (t) => {
    const runtime = await bundledRuntime(t, { includeDefaults: true });
    const fixture = await createFixture(t, { defaultPresets: runtime.defaultPresets });
    const iam = iamOf(fixture);
    const principal = fixture.admin;
    const { principal: scoped } = await installationOnlyAdmin(fixture);
    const administers = await iam.authorize({
      principalId: scoped.id,
      action: "administer",
      resource: { kind: "installation", id: fixture.controller.installation.id },
    });
    assert.equal(administers.allowed, true);
    // A Namespace persisted before a default Preset existed, as after an upgrade adds one.
    const existing = await persistedNamespace(fixture, "Existing before upgrade");
    await assert.rejects(
      fixture.controller.initializeDefaultPresets(scoped.id),
      AuthorizationDeniedError,
    );
    assert.deepEqual(await listPresets(fixture, existing.id), []);

    await initializeInstallationPresets(
      fixture.controller,
      iam,
      [scoped, principal],
      runtime.defaultPresets,
    );
    assert.deepEqual(
      await presetNames(fixture, existing.id),
      runtime.defaultPresets.map((preset) => preset.name).sort(),
    );
    const audit = auditFrom(fixture, "installation-defaults").filter(
      (event) => event.namespaceId === existing.id,
    );
    assert.equal(audit.length, runtime.defaultPresets.length);
    assert.ok(audit.every((event) => event.actorId === principal.id));

    // With no administrator able to create them, startup still fails, and says why: the
    // administrator's Preset refusal, never a later non-administrator's.
    const unseeded = await persistedNamespace(fixture, "Existing without a capable administrator");
    const { principal: member } = await fixture.createAccountWithPolicy("member", () => {});
    await assert.rejects(
      initializeInstallationPresets(
        fixture.controller,
        iam,
        [scoped, member],
        runtime.defaultPresets,
      ),
      (error) =>
        /can create Presets in every Namespace/.test(error.message) &&
        error.cause instanceof AuthorizationDeniedError &&
        error.cause.authorization?.action === "create" &&
        error.cause.evidence?.identityId === scoped.id,
    );
    assert.deepEqual(await listPresets(fixture, unseeded.id), []);

    // An authorization outage is not a denial: startup stops with it instead of trying others.
    failPresetAuthorization(t, iam, "create");
    await assert.rejects(
      initializeInstallationPresets(
        fixture.controller,
        iam,
        [principal, scoped],
        runtime.defaultPresets,
      ),
      DependencyUnavailableError,
    );
    assert.deepEqual(await listPresets(fixture, unseeded.id), []);
  });

  test("Namespace deletion removes unmodified default Presets and names what still blocks it", async (t) => {
    const runtime = await bundledRuntime(t, { includeDefaults: true });
    assert.ok(runtime.defaultPresets.length > 0);
    const fixture = await createFixture(t, { defaultPresets: runtime.defaultPresets });

    // A Namespace holding only its seeded, unmodified defaults is empty to its operator.
    const pristine = await fixture.createNamespace("Pristine defaults", { ready: true });
    const seeded = await listPresets(fixture, pristine.id);
    assert.equal(seeded.length, runtime.defaultPresets.length);
    // A grant on a seeded default is removed with it and named in its delete event.
    const { principal: reader } = await fixture.createAccountWithPolicy("preset-grantee", () => {});
    const role = await presetReaderRole(fixture, pristine.id);
    const binding = await bindPreset(fixture, pristine.id, {
      subjectId: reader.id,
      roleId: role.id,
      presetId: seeded[0].id,
    });
    const deleted = await fixture.request("DELETE", `/namespaces/${pristine.id}`);
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    assert.equal(deleted.data.status, "deleting");
    const remaining = await fixture.controller.transact((state) =>
      state.presets.listPresets(pristine.id),
    );
    assert.deepEqual(remaining, []);
    const cascaded = auditFrom(fixture, "namespace-deletion").filter(
      (event) => event.action === "openclaw.presets.delete" && event.namespaceId === pristine.id,
    );
    assert.deepEqual(
      cascaded.map((event) => event.resource.id).sort(),
      seeded.map((preset) => preset.id).sort(),
    );
    assert.deepEqual(
      cascaded.find((event) => event.resource.id === seeded[0].id).details.removedAccessBindings,
      [
        {
          id: binding.id,
          subjectKind: "identity",
          subjectId: reader.id,
          roleId: role.id,
          resourceKind: "preset",
          resourceId: seeded[0].id,
        },
      ],
    );
    assert.equal(
      cascaded.filter((event) => event.details.removedAccessBindings !== undefined).length,
      1,
    );

    // An operator-edited default is real content: keep it and say what blocks deletion.
    const edited = await fixture.createNamespace("Edited defaults", { ready: true });
    const [first, ...rest] = await listPresets(fixture, edited.id);
    await patchTemplate(fixture, edited.id, first.id, {
      agent: { name: "Operator customization" },
    });
    const blockingSecret = await fixture.createSecret(edited.id, "blocking-secret", "value");
    const blocked = await fixture.request("DELETE", `/namespaces/${edited.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "NAMESPACE_NOT_EMPTY");
    // Only the edited default is named; unmodified defaults are deleted with the Namespace.
    assert.equal(
      blocked.body.error.message,
      `The requested Namespace is not empty. It still contains: Presets (${first.id}), Secrets (${blockingSecret.id}).`,
    );
    assert.equal((await listPresets(fixture, edited.id)).length, rest.length + 1);
  });

  test("startup refreshes untouched copies of superseded bundled defaults in place and keeps edited ones", async (t) => {
    const runtime = await bundledRuntime(t, { includeDefaults: true });
    const fixture = await startupFixture(t, runtime);
    const principal = fixture.admin;
    const byName = async (namespaceId) =>
      Object.fromEntries(
        (await listPresetDocuments(fixture, namespaceId)).map((preset) => [preset.name, preset]),
      );
    // What the running release seeds into a new Namespace is the refresh target.
    const fresh = await fixture.createNamespace("Seeded by this release", { ready: true });
    const current = await byName(fresh.id);

    // A Namespace seeded by an earlier release: its copies hold earlier shipped files.
    // Roll this release's copies back by PATCH, which stores them as that seeding did.
    const upgraded = await fixture.createNamespace("Seeded by an earlier release", {
      ready: true,
    });
    const seeded = await byName(upgraded.id);
    const rollBack = ({ name, template }) =>
      patchTemplate(fixture, upgraded.id, seeded[name].id, template);
    const staleCodex = await archivedDefault("default-codex.json", "32576b8f13976778");
    const staleOpenClaw = await archivedDefault("standard-openclaw.json", "ed4bae5153f86b94");
    const editedStandard = await archivedDefault("standard-codex.json", "e0e77652015e991b");
    editedStandard.template.variables.name.description = "Operator wording";
    const oldName = await archivedDefault("standard-codex.json", "a07d1e2070d95c99");
    const stale = await rollBack(staleCodex);
    const staleStandard = await rollBack(staleOpenClaw);
    const edited = await rollBack(editedStandard);
    const renamed = await createPreset(fixture, upgraded.id, oldName.name, oldName.template);
    assert.equal(stale.template.gateway, undefined);
    assert.notDeepEqual(stale.template, current["default-codex"].template);
    // A grant on the stale copy must survive the refresh: the ID stays the same.
    const { principal: reader } = await fixture.createAccountWithPolicy("stale-reader", () => {});
    const role = await presetReaderRole(fixture, upgraded.id);
    const binding = await bindPreset(fixture, upgraded.id, {
      subjectId: reader.id,
      roleId: role.id,
      presetId: stale.id,
    });

    await initializeInstallationPresets(
      fixture.controller,
      iamOf(fixture),
      fixture.policy.identities,
      runtime.defaultPresets,
    );
    const after = await byName(upgraded.id);
    // Untouched copies now hold the current release's template under their old IDs.
    for (const [name, copy] of [
      ["default-codex", stale],
      ["Standard OpenClaw", staleStandard],
    ]) {
      assert.equal(after[name].id, copy.id, name);
      assert.deepEqual(after[name].template, current[name].template, name);
    }
    // An edited copy is the operator's and is never replaced.
    assert.deepEqual(after["Standard Codex"], edited);
    // A copy under a name the bundle no longer ships is not refreshed or duplicated.
    assert.deepEqual(after["standard-codex"], renamed);
    assert.equal(Object.keys(after).length, 4);
    const grants = await fixture.request("GET", `/namespaces/${upgraded.id}/iam/access-bindings`);
    assert.ok(grants.data.some((grant) => grant.id === binding.id));

    // Each refresh is audited with the version it replaced.
    const refreshes = () => auditFrom(fixture, "installation-defaults-refresh");
    const versions = Object.fromEntries(
      runtime.bundledPresetVersions
        .filter((version) => version.current)
        .map((version) => [version.name, version.version]),
    );
    const byResource = (a, b) => a.resource.id.localeCompare(b.resource.id);
    assert.deepEqual(
      refreshes()
        .map(({ action, actorId, resource, details }) => ({ action, actorId, resource, details }))
        .sort(byResource),
      [
        [stale, "32576b8f13976778", "default-codex"],
        [staleStandard, "ed4bae5153f86b94", "Standard OpenClaw"],
      ]
        .map(([copy, previousVersion, name]) => ({
          action: "openclaw.presets.update",
          actorId: principal.id,
          resource: { kind: "preset", id: copy.id, namespaceId: upgraded.id },
          details: {
            source: "installation-defaults-refresh",
            previousVersion,
            version: versions[name],
          },
        }))
        .sort(byResource),
    );
    // A second startup finds nothing left to refresh.
    await fixture.controller.initializeDefaultPresets(principal.id);
    assert.equal(refreshes().length, 2);
  });

  test("startup never refreshes a presets.files copy, even one that repeats a bundled file", async (t) => {
    // Seeding one bundled default through files, without the others, is a supported setup.
    const runtime = await bundledRuntime(t, {
      includeDefaults: false,
      files: [fileURLToPath(new URL("../../deploy/presets/default-codex.json", import.meta.url))],
    });
    assert.deepEqual(
      runtime.defaultPresets.map(({ name }) => name),
      ["default-codex"],
    );
    const fixture = await startupFixture(t, runtime);
    const namespace = await fixture.createNamespace("Files seeded", { ready: true });
    const copy = (await listPresets(fixture, namespace.id)).find(
      (preset) => preset.name === "default-codex",
    );
    const earlier = await archivedDefault("default-codex.json", "32576b8f13976778");
    const rolledBack = await patchTemplate(fixture, namespace.id, copy.id, earlier.template);

    await initializeInstallationPresets(
      fixture.controller,
      iamOf(fixture),
      fixture.policy.identities,
      runtime.defaultPresets,
    );
    assert.deepEqual((await readPreset(fixture, namespace.id, copy.id)).data, rolledBack);
    assert.deepEqual(auditFrom(fixture, "installation-defaults-refresh"), []);
  });

  test("startup refreshes a copy only from its own bundled file's history, not another file reusing its name", async (t) => {
    const runtime = await bundledRuntime(t, { includeDefaults: true });
    // standard-codex.json once shipped as "standard-codex"; a later release bundles a
    // different file, here with the OpenClaw template, under that retired name.
    const retired = await archivedDefault("standard-codex.json", "a07d1e2070d95c99");
    const { template } = runtime.bundledPresetVersions.find(
      (version) => version.current && version.file === "standard-openclaw.json",
    );
    const reused = { name: retired.name, template };
    const fixture = await createFixture(t, {
      defaultPresets: [...runtime.defaultPresets, reused],
      bundledPresetVersions: [
        ...runtime.bundledPresetVersions,
        { ...reused, file: "reused-name.json", version: "0".repeat(16), current: true },
      ],
      refreshBundledDefaultPresets: true,
    });
    const namespace = await fixture.createNamespace("Retired name reused", { ready: true });
    const copy = (await listPresets(fixture, namespace.id)).find(
      (preset) => preset.name === retired.name,
    );
    // The copy an earlier release seeded from standard-codex.json under the retired name.
    const earlier = await patchTemplate(fixture, namespace.id, copy.id, retired.template);

    await initializeInstallationPresets(
      fixture.controller,
      iamOf(fixture),
      fixture.policy.identities,
      [...runtime.defaultPresets, reused],
    );
    assert.deepEqual((await readPreset(fixture, namespace.id, copy.id)).data, earlier);
    assert.deepEqual(auditFrom(fixture, "installation-defaults-refresh"), []);
  });

  test("startup skips and warns about a default refresh the policy refuses instead of failing", async (t) => {
    const runtime = await bundledRuntime(t, { includeDefaults: true });
    const fixture = await startupFixture(t, runtime);
    const iam = iamOf(fixture);
    const principal = fixture.admin;
    // Administers the Installation but holds no grant inside a Namespace.
    const { principal: scoped } = await installationOnlyAdmin(fixture);
    const staleCodex = await archivedDefault("default-codex.json", "32576b8f13976778");
    const staleCopy = async (label) => {
      const namespace = await fixture.createNamespace(label, { ready: true });
      const copy = (await listPresets(fixture, namespace.id)).find(
        (preset) => preset.name === staleCodex.name,
      );
      return {
        namespace,
        copy: await patchTemplate(fixture, namespace.id, copy.id, staleCodex.template),
      };
    };
    const frozen = await staleCopy("Frozen presets");
    const open = await staleCopy("Open presets");
    // An administrator froze one Namespace's Presets before the upgrade.
    fixture.policy.restrictions.push({
      id: "freeze-presets",
      namespaceId: frozen.namespace.id,
      action: "update",
      resourceKind: "preset",
      effect: "deny",
    });
    const { lines, emit } = captureLog();
    const refreshes = () => auditFrom(fixture, "installation-defaults-refresh");

    // The Installation-only administrator comes first; it must not stand in for the one
    // who can refresh the open Namespace.
    await initializeInstallationPresets(
      fixture.controller,
      iam,
      [scoped, principal],
      runtime.defaultPresets,
      emit,
    );
    const read = async ({ namespace, copy }) =>
      (await readPreset(fixture, namespace.id, copy.id)).data;
    assert.deepEqual(await read(frozen), frozen.copy);
    assert.notDeepEqual((await read(open)).template, open.copy.template);
    assert.deepEqual(
      refreshes().map((event) => [event.resource.id, event.actorId]),
      [[open.copy.id, principal.id]],
    );
    assert.deepEqual(lines, [
      {
        level: "warn",
        event: "presets.default-refresh-skipped",
        namespaceId: frozen.namespace.id,
        presetId: frozen.copy.id,
        presetName: staleCodex.name,
        reason: "An applicable Restriction denies the exact action and resource.",
        restrictionIds: ["freeze-presets"],
      },
    ]);

    // With no administrator able to update Presets at all, startup still completes.
    const unbound = await staleCopy("Unbound administrators");
    lines.length = 0;
    await initializeInstallationPresets(
      fixture.controller,
      iam,
      [scoped],
      runtime.defaultPresets,
      emit,
    );
    assert.deepEqual(await read(unbound), unbound.copy);
    assert.deepEqual(
      lines.map(({ level, event, presetId, reason }) => ({ level, event, presetId, reason })),
      [frozen, unbound]
        .sort((a, b) => a.namespace.id.localeCompare(b.namespace.id))
        .map(({ copy }) => ({
          level: "warn",
          event: "presets.default-refresh-skipped",
          presetId: copy.id,
          reason: "No explicit scoped binding grants the exact action and resource.",
        })),
    );
    assert.equal(refreshes().length, 1);

    // An authorization outage is not a refusal: startup still stops with it.
    failPresetAuthorization(t, iam, "update");
    await assert.rejects(
      initializeInstallationPresets(fixture.controller, iam, [principal], runtime.defaultPresets),
      DependencyUnavailableError,
    );
  });

  test("startup keeps a default missing where a deny Restriction refuses its creation", async (t) => {
    const runtime = await bundledRuntime(t, { includeDefaults: true });
    const fixture = await startupFixture(t, runtime);
    // Deletes a Namespace's copy of default-codex, which startup would then seed again.
    const missingDefault = async (label) => {
      const namespace = await fixture.createNamespace(label, { ready: true });
      const copy = (await listPresets(fixture, namespace.id)).find(
        (preset) => preset.name === "default-codex",
      );
      await deletePreset(fixture, namespace.id, copy.id);
      return namespace;
    };
    // An operator removed one default copy, then froze the Namespace's Presets.
    const frozen = await missingDefault("Frozen presets");
    fixture.policy.restrictions.push({
      id: "freeze-preset-creation",
      namespaceId: frozen.id,
      action: "create",
      resourceKind: "preset",
      effect: "deny",
    });
    // Another Namespace is missing the same default and may still receive it.
    const open = await missingDefault("Open presets");
    const before = await presetNames(fixture, frozen.id);
    const { lines, emit } = captureLog();

    await initializeInstallationPresets(
      fixture.controller,
      iamOf(fixture),
      [fixture.admin],
      runtime.defaultPresets,
      emit,
    );
    assert.deepEqual(await presetNames(fixture, frozen.id), before);
    assert.ok((await presetNames(fixture, open.id)).includes("default-codex"));
    assert.deepEqual(lines, [
      {
        level: "warn",
        event: "presets.default-create-skipped",
        namespaceId: frozen.id,
        presetName: "default-codex",
        reason: "An applicable Restriction denies the exact action and resource.",
        restrictionIds: ["freeze-preset-creation"],
      },
    ]);
  });

  test("Namespace deletion treats every shipped bundled version as unmodified, even with defaults off", async (t) => {
    const runtime = await bundledRuntime(t, { includeDefaults: false });
    assert.deepEqual(runtime.defaultPresets, []);
    const fixture = await startupFixture(t, runtime);
    const shipped = [
      await shippedPreset("default-codex.json"),
      await archivedDefault("default-codex.json", "32576b8f13976778"),
      await archivedDefault("standard-codex.json", "a07d1e2070d95c99"),
      await archivedDefault("standard-openclaw.json", "ed4bae5153f86b94"),
    ];

    // Copies seeded by this or an earlier release do not block deletion.
    const seeded = await fixture.createNamespace("Earlier release defaults", { ready: true });
    // Names are unique per Namespace, so the earlier default-codex gets its own below.
    for (const preset of [shipped[0], shipped[2], shipped[3]]) {
      await createPreset(fixture, seeded.id, preset.name, preset.template);
    }
    const deleted = await fixture.request("DELETE", `/namespaces/${seeded.id}`);
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    assert.deepEqual(
      await fixture.controller.transact((state) => state.presets.listPresets(seeded.id)),
      [],
    );
    const stale = await fixture.createNamespace("Stale default", { ready: true });
    const staleCopy = await createPreset(fixture, stale.id, shipped[1].name, shipped[1].template);
    const staleDeleted = await fixture.request("DELETE", `/namespaces/${stale.id}`);
    assert.equal(staleDeleted.status, 202, JSON.stringify(staleDeleted.body));
    assert.equal(
      auditFrom(fixture, "namespace-deletion").some(
        (event) => event.action === "openclaw.presets.delete" && event.resource.id === staleCopy.id,
      ),
      true,
    );

    // An edit to a shipped version, or a shipped template under another name, is real content.
    const edited = await fixture.createNamespace("Edited old default", { ready: true });
    const old = structuredClone(shipped[2].template);
    old.variables.name.description = "Operator wording";
    const editedCopy = await createPreset(fixture, edited.id, shipped[2].name, old);
    const renamedCopy = await createPreset(fixture, edited.id, "my-codex", shipped[3].template);
    const blocked = await fixture.request("DELETE", `/namespaces/${edited.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "NAMESPACE_NOT_EMPTY");
    // The message lists them in storage order.
    const listed = (await listPresets(fixture, edited.id)).map(({ id }) => id);
    assert.deepEqual([...listed].sort(), [editedCopy.id, renamedCopy.id].sort());
    assert.equal(
      blocked.body.error.message,
      `The requested Namespace is not empty. It still contains: Presets (${listed.join(", ")}).`,
    );
  });
});
