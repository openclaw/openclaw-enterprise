import assert from "node:assert/strict";
import test from "node:test";

import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { WORKSPACE_DEFAULTS_ID } from "../../packages/contracts/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { assertWriteAuthorizationDenial } from "../helpers/partial-write-authorization.mjs";
import { createDenied } from "../helpers/refusal-text.mjs";

// The real controller over HTTP: OCC, Native IAM, the bundled OpenClaw Plugin Driver and the
// fixture's test Kubernetes Compute Driver, whose workspace rule Agent create applies.
const pluginId = "occ-plugin:diffs";
const plugins = { [pluginId]: { enabled: true, toolDefaults: { approval: "none" } } };
const files = { "USER.md": "Preflight notes." };
const denyAll = { tools: { deny: ["*"] } };
// The workspace rule applies once the Configuration selects a Harness through its model.
const roster = {
  agents: {
    defaults: {
      model: "openai/gpt-5.1",
      models: { "openai/gpt-5.1": { agentRuntime: { id: "openclaw" } } },
    },
    ownership: "explicit",
    entries: { main: {}, research: {} },
  },
};

async function setup(t) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new OCCPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Agent create preflight", { ready: true });
  const agents = `/namespaces/${namespace.id}/agents`;
  const validate = (fields, options = {}) =>
    fixture.request("POST", `${agents}/validate`, { ...options, body: fields });
  // The same pair through Agent create, with the Configuration saved first as the console does.
  let created = 0;
  const create = async (values, fields) => {
    const configuration = await fixture.createConfiguration(namespace.id, values);
    created += 1;
    return fixture.request("POST", agents, {
      body: { name: `preflight-agent-${created}`, configurationId: configuration.id, ...fields },
    });
  };
  return { ...fixture, namespace, agents, validate, create };
}

test("Agent create preflight refuses what Agent create refuses, with its message, and saves nothing", async (t) => {
  const f = await setup(t);
  const mutationsBefore = f.auditSink.events.filter((event) => event.kind === "mutation").length;
  const refusals = [
    // The plugin's every tool is denied (findings 508, 1848).
    [denyAll, { plugins }],
    // With several roster entries, one entry's deny-all list fails its turns (finding 1860).
    // The workspace rule refuses this roster too; the plugin rule answers first, as in create.
    [
      { agents: { ...roster.agents, entries: { main: {}, research: { tools: { deny: ["*"] } } } } },
      { plugins, initialWorkspaceFiles: files },
    ],
    // Initial workspace files reach only the main Agent, so the roster must be main alone.
    [roster, { initialWorkspaceFiles: files }],
  ];
  const answers = [];
  for (const [index, [values, fields]] of refusals.entries()) {
    const refused = await f.validate({ configuration: { kind: "agent", values }, ...fields });
    assert.equal(refused.status, 400, `${index}: ${JSON.stringify(refused.body)}`);
    answers.push(refused.body.error);
  }
  assert.match(
    answers[0].message,
    new RegExp(`tools\\.deny blocks every tool of plugin ${pluginId}`),
  );
  assert.match(answers[1].message, /agents\.entries\.research\.tools\.deny/);
  assert.equal(
    answers[2].message,
    "Configuration setting agents.entries must hold only main, or be omitted, for initial workspace files: only the main Agent reads them.",
  );
  // The preflight wrote nothing: no Secret, Configuration or Agent, and no mutation audit row.
  assert.deepEqual((await f.request("GET", f.agents)).data, []);
  assert.deepEqual((await f.request("GET", `/namespaces/${f.namespace.id}/secrets`)).data, []);
  assert.equal(
    f.auditSink.events.filter((event) => event.kind === "mutation").length,
    mutationsBefore,
  );
  // Agent create gives each pair the same answer once its Configuration is saved.
  for (const [index, [values, fields]] of refusals.entries()) {
    const refused = await f.create(values, fields);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.error, answers[index], `create ${index}`);
  }
  // The form saves the Configuration before Agent create runs, so Configuration create's content
  // rules answer first: here, a several-entry roster without explicit ownership.
  const unowned = { agents: { entries: { main: {}, research: {} } } };
  const content = await f.validate({ configuration: { kind: "agent", values: unowned }, plugins });
  assert.equal(content.status, 400, JSON.stringify(content.body));
  const saved = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
    body: { kind: "agent", values: unowned },
  });
  assert.equal(saved.status, 400, JSON.stringify(saved.body));
  assert.deepEqual(content.body.error, saved.body.error);
});

test("Agent create preflight accepts what Agent create accepts", async (t) => {
  const f = await setup(t);
  const accepted = [
    // A disabled selection adds nothing to the tool allowlist.
    [denyAll, { plugins: { [pluginId]: { enabled: false } }, initialWorkspaceFiles: files }],
    // Several entries are fine without initial workspace files.
    [roster, { plugins }],
    [{}, { plugins, initialWorkspaceFiles: files, executionMode: "embedded" }],
  ];
  for (const [index, [values, fields]] of accepted.entries()) {
    const checked = await f.validate({ configuration: { kind: "agent", values }, ...fields });
    assert.equal(checked.status, 204, `${index}: ${JSON.stringify(checked.body)}`);
    const created = await f.create(values, {
      ...fields,
      ...(fields.initialWorkspaceFiles ? { workspaceDefaultsId: WORKSPACE_DEFAULTS_ID } : {}),
    });
    assert.equal(created.status, 201, `${index}: ${JSON.stringify(created.body)}`);
  }
  // A body outside the create contract is refused as one. The name is part of it (finding 2420).
  const extra = await f.validate({ configuration: { kind: "agent", values: {} }, unknown: "x" });
  assert.equal(extra.status, 400, JSON.stringify(extra.body));
});

test("Agent create preflight refuses a caller without Agent create as Agent create does", async (t) => {
  const f = await setup(t);
  const configuration = await f.createConfiguration(f.namespace.id, {});
  // An Agent already holds the name both requests use. The 403 must still come first: a caller
  // without Agent create never learns that the name is taken (finding 2420).
  const taken = await f.create({}, {});
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  // Configuration create and read, but no Agent create: the console form saves nothing for them.
  const member = await f.createAccountWithPolicy("preflight-member", (principal) => {
    grantRole(f.policy, principal.id, {
      id: "preflight-configuration-writer",
      namespaceId: f.namespace.id,
      permissions: { namespace: ["read"], agent: ["read"], configuration: ["read", "create"] },
    });
  });
  const session = await f.signIn(member.credentials);
  const target = { kind: "agent", id: f.namespace.id, namespaceId: f.namespace.id };
  for (const [action, path, body] of [
    [
      "openclaw.agents.validate",
      `${f.agents}/validate`,
      { configuration: { kind: "agent", values: denyAll }, plugins, name: taken.data.name },
    ],
    [
      "openclaw.agents.create",
      f.agents,
      { name: taken.data.name, configurationId: configuration.id, plugins },
    ],
  ]) {
    const auditStart = f.auditSink.events.length;
    const refused = await f.request("POST", path, { session, body });
    assert.equal(refused.status, 403, `${action}: ${JSON.stringify(refused.body)}`);
    // The same refusal as Agent create: the deny-all pair is never evaluated for this caller.
    assert.deepEqual(refused.body.error, {
      code: "FORBIDDEN",
      message: createDenied("Agent", f.namespace.id),
    });
    assertWriteAuthorizationDenial(
      f.auditSink.events.slice(auditStart),
      { principalId: member.principal.id, action, grant: "create", resource: target },
      action,
    );
  }
});

test("ordinary creators enable browser access atomically on an unshared Configuration", async (t) => {
  const f = await createConsoleAppFixture(t, {
    publicOrigin: true,
    nativeAdmin: { enabled: true, domain: "agents.oce.localhost" },
    nativeAdminGatewayApiKey: "synthetic-browser-create-service-key",
    filesystemConfiguration: true,
  });
  const bootstrapped = await f.request("POST", "/installation/bootstrap", {
    body: { name: "Browser creation integration" },
  });
  assert.equal(bootstrapped.status, 201, JSON.stringify(bootstrapped.body));
  const namespace = await f.createNamespace("Browser chat creators", { ready: true });
  const member = await f.createNamespaceMember("browser-creator", namespace.id, [
    ["read", "namespace"],
    ["create", "agent"],
    ["read", "agent"],
    ["read", "configuration"],
    ["create", "configuration"],
    ["update", "configuration"],
  ]);
  const session = await f.signIn(member.credentials);
  assert.equal((await f.request("GET", "/installation", { session })).status, 403);
  const capabilities = await f.request("GET", `/namespaces/${namespace.id}/agent-capabilities`, {
    session,
  });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.data.capabilities.nativeAdmin, true);
  assert.equal(capabilities.data.capabilities.agentProvisioning, undefined);
  const agents = `/namespaces/${namespace.id}/agents`;
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const freshConfiguration = async () => {
    const result = await f.request("POST", configurations, {
      session,
      body: { kind: "agent", values: {} },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.data;
  };
  const config = await freshConfiguration();
  const body = {
    name: "browser-agent",
    configurationId: config.id,
    nativeAdmin: true,
    expectedConfigurationGeneration: 1,
  };
  const created = await f.request("POST", agents, { session, body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const saved = await f.request("GET", `${configurations}/${config.id}`, { session });
  assert.equal(saved.data.generation, 2);
  assert.equal(saved.data.values.gateway.controlUi.enabled, true);
  assert.equal(saved.data.values.gateway.controlUi.allowedOrigins.length, 1);
  const nativeOrigin = new URL(saved.data.values.gateway.controlUi.allowedOrigins[0]);
  assert.equal(nativeOrigin.protocol, "https:");
  assert.match(nativeOrigin.hostname, /^agent-[a-f0-9]+\.agents\.oce\.localhost$/);
  assert.equal(nativeOrigin.port, new URL(f.origin).port);
  assert.ok(
    saved.data.values.gateway.auth.trustedProxy.requiredHeaders.includes("x-openclaw-scopes"),
  );
  const event = f.auditSink.events.find(
    (event) => event.action === "openclaw.agents.create" && event.resource?.id === created.data.id,
  );
  assert.equal(event.actor.principalId, member.principal.id);
  assert.equal(event.details.browserAccess, true);
  assert.equal(event.details.preparedConfiguration.id, config.id);

  // Reusing a referenced Configuration must not retarget the first Agent's browser origin.
  const shared = await f.request("POST", agents, {
    session,
    body: { ...body, name: "shared-browser", expectedConfigurationGeneration: 2 },
  });
  assert.equal(shared.status, 409, JSON.stringify(shared.body));
  assert.deepEqual(
    (await f.request("GET", `${configurations}/${config.id}`, { session })).data,
    saved.data,
  );
  const unused = await freshConfiguration();
  const unusedBody = { ...body, configurationId: unused.id };
  const stale = await f.request("POST", agents, {
    session,
    body: { ...unusedBody, expectedConfigurationGeneration: 2 },
  });
  assert.equal(stale.status, 409);
  // A duplicate-name failure happens after native preparation. The filesystem document
  // and metadata must both roll back rather than leave an origin for a nonexistent Agent.
  const duplicate = await f.request("POST", agents, { session, body: unusedBody });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.deepEqual(
    (await f.request("GET", `${configurations}/${unused.id}`, { session })).data,
    unused,
  );
  const readonly = await f.createNamespaceMember("browser-config-reader", namespace.id, [
    ["create", "agent"],
    ["read", "configuration"],
  ]);
  const denied = await f.request("POST", agents, {
    session: await f.signIn(readonly.credentials),
    body: { ...unusedBody, name: "cannot-configure" },
  });
  assert.equal(denied.status, 403);
  assert.equal((await f.request("GET", agents, { session })).data.length, 1);
});
