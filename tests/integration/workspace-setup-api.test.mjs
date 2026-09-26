import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { WORKSPACE_DEFAULTS_ID } from "../../packages/contracts/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

async function setup(t) {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const fixture = await createConsoleAppFixture(t, { state, backends: [] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace setup", { ready: true });
  const configuration = await fixture.createConfiguration(namespace.id);
  const path = `/namespaces/${namespace.id}/agents`;
  const create = (name, fields = {}, options = {}) =>
    fixture.request("POST", path, {
      ...options,
      body: { name, configurationId: configuration.id, ...fields },
    });
  const staged = (agentId, namespaceId = namespace.id) =>
    state.read((view) => view.workspaceSetups.find(namespaceId, agentId));
  return { ...fixture, state, audit, namespace, configuration, path, create, staged };
}

test("Agent create stages exact partial workspace bytes privately and rejects replay without changing them", async (t) => {
  const f = await setup(t);
  const secretText = "private-workspace-directive-7a39";
  const files = { "SOUL.md": `  ${secretText}\r\n`, "USER.md": "" };
  const result = await f.create("Customized Agent", {
    initialWorkspaceFiles: files,
    workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.data.desiredRuntimeState, "stopped");
  const staged = await f.staged(result.data.id);
  assert.deepEqual(staged.files, files);
  assert.equal(staged.defaultsId, WORKSPACE_DEFAULTS_ID);
  assert.equal(staged.completed, false);
  assert.equal(staged.namespaceId, f.namespace.id);
  assert.equal(staged.agentId, result.data.id);

  // Creation must neither deploy nor publish setup bytes through durable Agent/configuration views.
  const views = [result.data];
  for (const route of [
    `${f.path}/${result.data.id}`,
    f.path,
    `${f.path}/${result.data.id}/revisions`,
    `/namespaces/${f.namespace.id}/configurations/${f.configuration.id}`,
  ]) {
    const response = await f.request("GET", route);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    views.push(response.data);
  }
  assert.deepEqual(views[3], []);
  const publicText = JSON.stringify(views);
  assert.equal(publicText.includes(secretText), false);
  assert.equal(publicText.includes("initialWorkspaceFiles"), false);
  assert.equal(publicText.includes("workspaceDefaultsId"), false);
  assert.equal(JSON.stringify(f.audit.events).includes(secretText), false);
  const foreign = await f.createNamespace("Other workspace", { ready: true });
  assert.equal(await f.staged(result.data.id, foreign.id), undefined);

  const replay = await f.create("Customized Agent", {
    initialWorkspaceFiles: { "USER.md": "replacement" },
  });
  assert.equal(replay.status, 409);
  assert.deepEqual(await f.staged(result.data.id), staged);
  const update = await f.request("PATCH", `${f.path}/${result.data.id}`, {
    body: {
      configurationId: f.configuration.id,
      initialWorkspaceFiles: { "USER.md": "replacement" },
    },
  });
  assert.equal(update.status, 400, "setup is a create-only input");
  assert.deepEqual(await f.staged(result.data.id), staged);
});

test("omitted and empty workspace maps retain native setup while an explicit empty file is staged", async (t) => {
  const f = await setup(t);
  for (const [name, fields] of [
    ["Omitted", {}],
    ["Empty map", { initialWorkspaceFiles: {} }],
  ]) {
    const result = await f.create(name, fields);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(await f.staged(result.data.id), undefined);
  }
  const explicit = await f.create("Blank file", { initialWorkspaceFiles: { "AGENTS.md": "" } });
  assert.equal(explicit.status, 201, JSON.stringify(explicit.body));
  assert.deepEqual((await f.staged(explicit.data.id)).files, { "AGENTS.md": "" });
});

test("invalid workspace content and stale defaults reject the complete create without an Agent", async (t) => {
  const f = await setup(t);
  const cases = [
    [null, 400],
    [[], 400],
    [{ "BOOTSTRAP.md": "private-invalid-content" }, 400],
    [{ "../USER.md": "private-invalid-content" }, 400],
    [{ "USER.md": null }, 400],
    [{ "USER.md": 12 }, 400],
    [{ "USER.md": "private-invalid-content\u0000" }, 400],
    [{ "USER.md": "private-invalid-content\ud800" }, 400],
    [{ "SOUL.md": "valid partial", "USER.md": "😀".repeat(4097) }, 400],
  ];
  for (const [index, [files, status]] of cases.entries()) {
    const result = await f.create(`Invalid ${index}`, { initialWorkspaceFiles: files });
    assert.equal(result.status, status, `invalid case ${index}: ${JSON.stringify(result.body)}`);
    assert.equal(JSON.stringify(result.body).includes("private-invalid-content"), false);
  }
  for (const [defaultsId, status] of [
    ["0".repeat(64), 409],
    ["A".repeat(64), 400],
    [null, 400],
  ]) {
    const result = await f.create("Wrong defaults", {
      initialWorkspaceFiles: { "USER.md": "private-invalid-content" },
      workspaceDefaultsId: defaultsId,
    });
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(JSON.stringify(result.body).includes("private-invalid-content"), false);
  }
  assert.deepEqual((await f.request("GET", f.path)).data, []);
  assert.equal(JSON.stringify(f.audit.events).includes("private-invalid-content"), false);
});

test("Agent create accepts four maximum UTF-8 files even when JSON escape expansion exceeds the ordinary body limit", async (t) => {
  const f = await setup(t);
  // U+0001 is valid non-NUL content: each input byte needs six bytes in JSON transport.
  const files = Object.fromEntries(
    ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"].map((name) => [
      name,
      "\u0001".repeat(16 * 1024),
    ]),
  );
  const result = await f.create("Maximum valid setup", { initialWorkspaceFiles: files });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.deepEqual((await f.staged(result.data.id)).files, files);
});

test("workspace setup creation requires exact Namespace permission, Configuration ownership, and same-site session writes", async (t) => {
  const f = await setup(t);
  const foreign = await f.createNamespace("Foreign", { ready: true });
  const foreignConfiguration = await f.createConfiguration(foreign.id);
  const files = { "USER.md": "private-scope-directive-8f24" };
  const wrongScope = await f.create("Cross Namespace", {
    configurationId: foreignConfiguration.id,
    initialWorkspaceFiles: files,
  });
  assert.ok([403, 404].includes(wrongScope.status), JSON.stringify(wrongScope.body));
  const csrf = await f.create(
    "Cross site",
    { initialWorkspaceFiles: files },
    { headers: { origin: "https://foreign.invalid", "sec-fetch-site": "cross-site" } },
  );
  assert.equal(csrf.status, 403, JSON.stringify(csrf.body));

  const account = await f.createAccountWithPolicy("no-namespace-permission", () => {});
  const session = await f.signIn(account.credentials);
  const forbidden = await f.create("Unauthorized", { initialWorkspaceFiles: files }, { session });
  assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  assert.deepEqual((await f.request("GET", f.path)).data, []);
  assert.equal(
    JSON.stringify([wrongScope.body, csrf.body, forbidden.body, f.audit.events]).includes(
      files["USER.md"],
    ),
    false,
  );
});
