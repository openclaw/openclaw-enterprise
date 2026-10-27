import assert from "node:assert/strict";
import test from "node:test";

import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
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
  const audit = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink: audit });
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
  return { ...fixture, audit, namespace, agents, validate, create };
}

test("Agent create preflight refuses what Agent create refuses, with its message, and saves nothing", async (t) => {
  const f = await setup(t);
  const mutationsBefore = f.audit.events.filter((event) => event.kind === "mutation").length;
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
  assert.equal(f.audit.events.filter((event) => event.kind === "mutation").length, mutationsBefore);
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
    const auditStart = f.audit.events.length;
    const refused = await f.request("POST", path, { session, body });
    assert.equal(refused.status, 403, `${action}: ${JSON.stringify(refused.body)}`);
    // The same refusal as Agent create: the deny-all pair is never evaluated for this caller.
    assert.deepEqual(refused.body.error, {
      code: "FORBIDDEN",
      message: createDenied("Agent", f.namespace.id),
    });
    assertWriteAuthorizationDenial(
      f.audit.events.slice(auditStart),
      { principalId: member.principal.id, action, grant: "create", resource: target },
      action,
    );
  }
});
