import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { WORKSPACE_DEFAULTS_ID } from "../../packages/contracts/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

async function setup(t, options = {}) {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const fixture = await createConsoleAppFixture(t, { state, backends: [], ...options });
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
  const privateContent = "private-invalid-content";
  async function assertRejectedCreate(name, fields, expectedStatus) {
    const { status, body } = await f.create(name, fields);
    assert.equal(status, expectedStatus, `${name}: unexpected response status`);
    assert.equal(
      JSON.stringify(body).includes(privateContent),
      false,
      `${name}: response exposed workspace content`,
    );
  }
  const invalidFiles = [
    null,
    [],
    { "BOOTSTRAP.md": privateContent },
    { "../USER.md": privateContent },
    { "USER.md": null },
    { "USER.md": 12 },
    { "USER.md": `${privateContent}\u0000` },
    { "USER.md": `${privateContent}\ud800` },
    { "SOUL.md": "valid partial", "USER.md": "😀".repeat(4097) },
  ];
  for (const [index, files] of invalidFiles.entries()) {
    await assertRejectedCreate(`Invalid ${index}`, { initialWorkspaceFiles: files }, 400);
  }
  for (const [index, [defaultsId, status]] of [
    ["0".repeat(64), 409],
    ["A".repeat(64), 400],
    ["0".repeat(63), 400],
    ["0".repeat(65), 400],
    [null, 400],
  ].entries()) {
    await assertRejectedCreate(
      `Wrong defaults ${index}`,
      { initialWorkspaceFiles: { "USER.md": privateContent }, workspaceDefaultsId: defaultsId },
      status,
    );
  }
  assert.deepEqual((await f.request("GET", f.path)).data, []);
  assert.equal(JSON.stringify(f.audit.events).includes(privateContent), false);
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

test("Agent save and deployment refuse initial workspace files the Configuration's main Agent cannot read", async (t) => {
  // Finding 1117: preparation of the first deployment refused these after the Agent saved.
  const f = await setup(t);
  const model = {
    agents: {
      defaults: {
        model: "openai/gpt-4.1",
        models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
  const withAgents = (agents) => ({ agents: { ...model.agents, ...agents } });
  const valid = await f.createConfiguration(f.namespace.id, model);
  const files = { "USER.md": "workspace-setup-roster" };
  const workspace =
    "Configuration setting agents.defaults.workspace must be /home/node/.openclaw/workspace, or unset, for initial workspace files.";
  const roster =
    "Configuration setting agents.entries must hold only main, or be omitted, for initial workspace files: only the main Agent reads them.";
  for (const [agents, message] of [
    [{ defaults: { ...model.agents.defaults, workspace: "/srv/elsewhere" } }, workspace],
    // Only a dedicated Agent mounts the second managed workspace; this Agent is embedded.
    [{ defaults: { ...model.agents.defaults, workspace: "/home/node/workspace" } }, workspace],
    [{ ownership: "explicit", entries: { main: {}, helper: {} } }, roster],
  ]) {
    const stored = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
      body: { kind: "agent", values: withAgents(agents) },
    });
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    const configuration = stored.data;
    const refused = await f.create("Unreadable setup", {
      configurationId: configuration.id,
      initialWorkspaceFiles: files,
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.message, message);
    // Without initial workspace files the same Configuration saves.
    const plain = await f.create(`Plain ${configuration.id}`, {
      configurationId: configuration.id,
    });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
  }
  assert.equal(
    (await f.request("GET", f.path)).data.filter(({ name }) => name === "Unreadable setup").length,
    0,
  );

  // A pending setup whose Configuration changes after the Agent saved still reads; its next
  // update and its deployment are refused with the same message.
  const key = await f.createSecret(
    f.namespace.id,
    "Pending setup key",
    "workspace-setup-model-key",
  );
  const created = await f.create("Pending setup", {
    configurationId: valid.id,
    initialWorkspaceFiles: files,
    harnessAuth: { method: "api_key", source: key.ref },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await f.grantAgentSecretOperate(created.data, key.ref, { listed: false });
  await f.updateConfiguration(
    f.namespace.id,
    valid.id,
    withAgents({ defaults: { ...model.agents.defaults, workspace: "/srv/elsewhere" } }),
  );
  const agentPath = `${f.path}/${created.data.id}`;
  assert.equal((await f.request("GET", agentPath)).status, 200);
  const updated = await f.request("PATCH", agentPath, { body: { configurationId: valid.id } });
  assert.equal(updated.status, 400, JSON.stringify(updated.body));
  assert.equal(updated.body.error.message, workspace);
  const deployed = await f.request("POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 400, JSON.stringify(deployed.body));
  assert.equal(deployed.body.error.message, workspace);
  assert.deepEqual((await f.request("GET", `${agentPath}/revisions`)).data, []);
  assert.equal((await f.staged(created.data.id)).completed, false);
});

test("Agent save accepts initial workspace files for a main roster entry in any letter case", async (t) => {
  // Finding 1144: OpenClaw normalizes Agent ids case-insensitively, as the roster rules do.
  const f = await setup(t);
  const model = {
    model: "openai/gpt-4.1",
    models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
  };
  for (const [key, status] of [
    ["Main", 201],
    ["MAIN", 201],
    ["helper", 400],
  ]) {
    const stored = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
      body: { kind: "agent", values: { agents: { defaults: model, entries: { [key]: {} } } } },
    });
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    const result = await f.create(`Roster ${key}`, {
      configurationId: stored.data.id,
      initialWorkspaceFiles: { "USER.md": "roster-case" },
    });
    assert.equal(result.status, status, `${key}: ${JSON.stringify(result.body)}`);
  }
  // A workspace refusal names the entry as written.
  const stored = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
    body: {
      kind: "agent",
      values: { agents: { defaults: model, entries: { Main: { workspace: "/srv/elsewhere" } } } },
    },
  });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  const refused = await f.create("Roster workspace", {
    configurationId: stored.data.id,
    initialWorkspaceFiles: { "USER.md": "roster-case" },
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(
    refused.body.error.message,
    "Configuration setting agents.entries.Main.workspace must be /home/node/.openclaw/workspace, or unset, for initial workspace files.",
  );
});

test("Agent save refuses initial workspace files in a Sandbox with a 409 that names the Sandbox", async (t) => {
  // A provider without an initializer must remain unsupported even when its configuration
  // hook moves the workspace. Report the missing capability, not a caller path error.
  const sandboxDriver = {
    id: "workspace-setup-sandbox",
    capability: "sandbox",
    implementation: "openshell",
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {
      assert.fail("Agent save must not provision a Harness");
    },
    async cleanup() {},
    // OpenShell's own rewrite: the workspace moves to the Sandbox data mount.
    configureAgent(configuration, harness) {
      return OpenShellSandboxDriver.prototype.configureAgent.call(
        {
          options: {
            gateway: {},
            kubernetes: { userNamespaces: false, sandboxDataMount: { mountPath: "/sandbox/data" } },
          },
        },
        configuration,
        harness,
      );
    },
  };
  const f = await setup(t, { sandboxDriver });
  const message =
    "The selected Compute Driver cannot deliver initial workspace files to a Harness in the selected Sandbox. Use an Agent without initialWorkspaceFiles.";
  for (const [runtime, model] of [
    ["openclaw", "openai/gpt-4.1"],
    ["codex", "codex/gpt-5.1"],
  ]) {
    const stored = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
      body: {
        kind: "agent",
        values: {
          agents: { defaults: { model, models: { [model]: { agentRuntime: { id: runtime } } } } },
        },
      },
    });
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    const refused = await f.create(`Sandboxed ${runtime}`, {
      configurationId: stored.data.id,
      executionMode: "dedicated",
      initialWorkspaceFiles: { "USER.md": "sandboxed-setup" },
    });
    assert.equal(refused.status, 409, `${runtime}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error.message, message);
    // Without initial workspace files the same Agent saves.
    const plain = await f.create(`Plain ${runtime}`, {
      configurationId: stored.data.id,
      executionMode: "dedicated",
    });
    assert.equal(plain.status, 201, `${runtime}: ${JSON.stringify(plain.body)}`);
    assert.equal(await f.staged(plain.data.id), undefined);
  }
  assert.equal(
    (await f.request("GET", f.path)).data.filter(({ name }) => name.startsWith("Sandboxed")).length,
    0,
  );
});

/** A real OpenShell Sandbox Driver whose Kubernetes settings `overrides` overrides (an
 * undefined value removes the setting), with extra `gateway` settings. */
function openShellSandbox(t, overrides = {}, gateway = {}) {
  const kubernetes = {
    runtimeClassName: "openshell-sandbox",
    // Native OpenClaw workspace preparation requires it.
    userNamespaces: false,
    serviceAccount: { mode: "gatewayConfigured" },
    sandboxDataMount: { subPath: "workspace", mountPath: "/sandbox/enterprise", readOnly: false },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete kubernetes[key];
    } else {
      kubernetes[key] = value;
    }
  }
  const definition = {
    id: "workspace-openshell",
    type: "openshell",
    configuration: { endpoint: "http://127.0.0.1:9", insecureTransport: "network-policy" },
    drivers: {
      sandbox: "workspace-openshell-sandbox",
      credential_gateway: "workspace-openshell-credentials",
    },
  };
  const backend = createOpenShellBackend(definition);
  t.after(() => backend.client.close());
  const sandboxDriver = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator", ...gateway },
      kubernetes,
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/usr/local/bin/node" }],
          },
        ],
      },
    },
    { id: "workspace-openshell-sandbox", backend },
  );
  return {
    sandboxDriver,
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: sandboxDriver.id,
        implementation: sandboxDriver.implementation,
        definition: OpenShellSandboxDriver,
      },
    ],
  };
}

/** Saves an Agent Configuration that selects `model` on the `runtime` Harness. */
async function storeConfiguration(f, runtime, model) {
  const stored = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
    body: {
      kind: "agent",
      values: {
        agents: { defaults: { model, models: { [model]: { agentRuntime: { id: runtime } } } } },
      },
    },
  });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  return stored;
}

test("Agent create admits private workspace files through the OpenShell initializer contract", async (t) => {
  const f = await setup(t, openShellSandbox(t));
  for (const [runtime, model] of [
    ["openclaw", "openai/gpt-4.1"],
    ["codex", "codex/gpt-5.1"],
  ]) {
    const stored = await storeConfiguration(f, runtime, model);
    const files = { "USER.md": `private-${runtime}-workspace-content` };
    // Real API admission composes Compute with OpenShell's workspace projection and validator.
    // No Sandbox is provisioned: the private payload remains staged for deployment.
    const created = await f.create(`OpenShell ${runtime}`, {
      configurationId: stored.data.id,
      executionMode: "dedicated",
      initialWorkspaceFiles: files,
    });
    assert.equal(created.status, 201, `${runtime}: ${JSON.stringify(created.body)}`);
    assert.equal(created.data.desiredRuntimeState, "stopped");
    assert.deepEqual((await f.staged(created.data.id)).files, files);
    assert.equal(JSON.stringify(created.body).includes(files["USER.md"]), false);
  }
});

// Native OpenClaw's workspace preparation needs userNamespaces: false and at most one operator
// ServiceAccount, and runs only after a deploy has stopped its predecessors, so Agent save refuses
// those settings first and the Installation stops offering dedicated OpenClaw (findings 2334,
// 2346, 2347).
test("Agent create refuses dedicated OpenClaw on OpenShell settings its workspace preparation refuses", async (t) => {
  const userNamespaces =
    "Dedicated OpenClaw needs kubernetes.userNamespaces: false in the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to set it.";
  const serviceAccounts = ["a", "b"].map((name) => ({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name },
  }));
  for (const [kubernetes, gateway, message] of [
    [{ userNamespaces: undefined }, {}, userNamespaces],
    [{ userNamespaces: true }, {}, userNamespaces],
    [
      {},
      { operatorWorkspaceResources: serviceAccounts },
      "Dedicated OpenClaw needs at most one ServiceAccount in gateway.operatorWorkspaceResources of the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to remove the others.",
    ],
    // Control: the shape workspace preparation accepts.
    [{}, { operatorWorkspaceResources: serviceAccounts.slice(0, 1) }],
  ]) {
    const f = await setup(t, openShellSandbox(t, kubernetes, gateway));
    const installation = await f.request("GET", "/installation");
    assert.equal(installation.status, 200, JSON.stringify(installation.body));
    // Create Agent offers only the modes admission accepts.
    assert.deepEqual(
      installation.data.capabilities.openclaw.executionModes,
      message === undefined ? ["dedicated"] : [],
    );
    const openclaw = await storeConfiguration(f, "openclaw", "openai/gpt-4.1");
    const refused = await f.create("OpenShell openclaw", {
      configurationId: openclaw.data.id,
      executionMode: "dedicated",
    });
    if (message === undefined) {
      assert.equal(refused.status, 201, JSON.stringify(refused.body));
      continue;
    }
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "INVALID_REQUEST");
    assert.equal(refused.body.error.message, message);
    assert.equal(
      (await f.request("GET", f.path)).data.some(({ name }) => name === "OpenShell openclaw"),
      false,
    );
    // Control: Codex never runs that preparation and still saves.
    const codex = await storeConfiguration(f, "codex", "codex/gpt-5.1");
    const created = await f.create("OpenShell codex", {
      configurationId: codex.data.id,
      executionMode: "dedicated",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
});
