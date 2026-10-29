import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  codexCatalogEntries,
  codexOpenClawConfiguration,
  codexRuntimeArtifact,
  codexRuntimeReadParams,
  openClawRuntimeArtifact,
  validatePolicies,
} from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import {
  deniedOpenClawSelection,
  openClawToolDenialMessage,
} from "../../apps/controller/src/drivers/plugin/openclaw-tool-denial.ts";
import { NativeCodexPluginCatalogReader } from "../../apps/controller/src/drivers/plugin/stdio-catalog-reader.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { NotImplementedError } from "../../packages/occ/src/index.ts";
import { waitFor, waitUntil } from "../helpers/wait-for.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

const namespace = Object.freeze({
  id: "ns_plugin",
  name: "Plugin conformance",
  status: "ready",
  createdAt: "2026-09-08T00:00:00.000Z",
});

const agent = Object.freeze({
  id: "agent_plugin",
  namespaceId: namespace.id,
  name: "Plugin agent",
  configurationId: "cfg_plugin",
  executionMode: "embedded",
  servicePrincipalId: "sp_plugin",
  createdAt: namespace.createdAt,
});

const linearPluginId = "codex-plugin:linear@openai-curated-remote";
const calendarPluginId = "codex-plugin:google-calendar@openai-curated-remote";
const thirdPluginId = "codex-plugin:third-plugin@openai-curated-remote";
const thirdRemotePluginId = "opaque-third-123";

function context(mode, configuration = {}) {
  return {
    namespace,
    agent: { ...agent, executionMode: mode },
    harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "2026.9.0", mode },
    configuration,
    signal: AbortSignal.timeout(1_000),
  };
}

function occSelection(overrides = {}) {
  return {
    "occ-plugin:diffs": {
      enabled: true,
      toolDefaults: { approval: "none" },
      ...overrides,
    },
  };
}

// A catalog plugin with two tools, for deny lists that block it only together.
const pairCatalog = Object.freeze([
  Object.freeze({
    id: "occ-plugin:pair",
    name: "Pair",
    tools: Object.freeze([
      Object.freeze({ id: "pair_read", name: "pair_read", ownerId: "pair" }),
      Object.freeze({ id: "pair_write", name: "pair_write", ownerId: "pair" }),
    ]),
  }),
]);
const pair = Object.freeze({ "occ-plugin:pair": Object.freeze({ enabled: true }) });

function codexSelection(pluginId = linearPluginId, overrides = {}) {
  return {
    [pluginId]: {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
      ...overrides,
    },
  };
}

function codexCatalogFixture() {
  return {
    marketplaces: [
      {
        name: "openai-internal-testing",
        plugins: [
          {
            id: "internal-only@openai-internal-testing",
            remotePluginId: "opaque-internal-only",
            interface: { displayName: "Internal Only" },
            version: "0.0.1",
          },
        ],
      },
      {
        name: "openai-curated-remote",
        plugins: [
          {
            id: "linear@openai-curated-remote",
            remotePluginId: "linear",
            interface: { displayName: "Linear" },
            version: "5.0.1",
          },
          {
            id: "google-calendar@openai-curated-remote",
            remotePluginId: "google-calendar",
            interface: { displayName: "Google Calendar" },
            version: "1.2.7",
          },
          {
            id: "third-plugin@openai-curated-remote",
            remotePluginId: thirdRemotePluginId,
            interface: { displayName: "Third Plugin" },
            version: "2.3.4",
          },
        ],
      },
    ],
  };
}

function codexDetail(remotePluginId, appIds, options = {}) {
  return {
    plugin: {
      summary: {
        id: options.summaryId ?? `${remotePluginId}@openai-curated-remote`,
        remotePluginId,
        interface: { displayName: options.displayName ?? remotePluginId },
        ...(options.version === undefined ? { version: "1.0.0" } : { version: options.version }),
      },
      apps: appIds.map((id) => ({ id })),
      appTemplates: options.appTemplates ?? [],
      hooks: options.hooks ?? [],
      skills: options.skills ?? [],
      mcpServers: options.mcpServers ?? [],
      scheduledTasks: options.scheduledTasks ?? [],
    },
  };
}

const codexDetails = Object.freeze([
  codexDetail("linear", ["asdk_app_69a089a326dc8191b32a3f2553f5be2c"], {
    displayName: "Linear",
    version: "5.0.1",
  }),
  codexDetail("google-calendar", ["connector_947e0d954944416db111db556030eea6"], {
    displayName: "Google Calendar",
    version: "1.2.7",
  }),
  codexDetail(thirdRemotePluginId, ["connector_third_fixture"], {
    summaryId: "third-plugin@openai-curated-remote",
    displayName: "Third Plugin",
    version: "2.3.4",
  }),
]);

test("OpenClaw Plugin Driver lists the vetted Diffs catalog entry", async () => {
  const driver = new OCCPluginDriver(
    {},
    { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
  );

  const [catalogEntry] = await driver.listCatalog(context("embedded"));
  assert.deepEqual(catalogEntry, {
    id: "occ-plugin:diffs",
    name: "Diffs",
    tools: [{ id: "diffs", name: "diffs", ownerId: "diffs" }],
  });
});

test("dedicated OpenClaw offers the pinned Google package and refuses unsupported selection fields", async () => {
  const driver = new OCCPluginDriver();
  const dedicated = context("dedicated");
  const [google] = await driver.listCatalog({
    ...dedicated,
    harness: { ...dedicated.harness, id: "openclaw" },
  });
  assert.equal(google.id, "occ-plugin:google@1.0.0");
  driver.validatePolicies({ [google.id]: { enabled: true } });
  assert.throws(
    () => driver.validatePolicies({ ...occSelection(), [google.id]: { enabled: true } }),
    /must be the only plugin selected/,
  );
  assert.throws(
    () =>
      driver.validatePolicies({
        [google.id]: { enabled: true, credentialSourceId: "src_personal" },
      }),
    /optional credential slot/,
  );
});

test("OpenClaw plugin startup translation renders native install and enablement", () => {
  const enabled = openClawRuntimeArtifact(occSelection());
  assert.deepEqual(enabled.installs, [
    {
      pluginId: "occ-plugin:diffs",
      nativeId: "diffs",
      packageName: "@openclaw/diffs",
      version: "2026.8.2",
      integrity: OCC_DIFFS_DIGEST,
    },
  ]);
  assert.deepEqual(enabled.configuration.plugins.entries.diffs, { enabled: true });
  assert.deepEqual(enabled.configuration.tools, { alsoAllow: ["diffs"] });

  const blocked = openClawRuntimeArtifact(occSelection({ enabled: false }));
  assert.deepEqual(blocked.configuration.plugins.entries.diffs, { enabled: false });
  assert.equal(Object.hasOwn(blocked.configuration, "tools"), false);
});

test("Plugin approver translation keeps Agent, plugin, and exact scoped tool overrides", () => {
  const first = { channel: "slack", id: "team:T123:user:U123" };
  const second = { channel: "slack", id: "U456" };
  const toolId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c/repos%2Fread";
  const codex = codexOpenClawConfiguration(
    codexSelection(linearPluginId, {
      approvers: [],
      tools: { [toolId]: { approvers: [second] } },
    }),
    [],
    { pluginApprovers: [first] },
  );
  assert.deepEqual(codex.approvals.plugin.slack, {
    approvers: [first.id],
    plugins: {
      linear: { approvers: [], tools: { [toolId]: { approvers: [second.id] } } },
    },
  });
  assert.deepEqual(codexOpenClawConfiguration({}, [], { pluginApprovers: [] }).approvals, {
    plugin: { slack: { approvers: [] } },
  });
  assert.deepEqual(
    codexOpenClawConfiguration(codexSelection(linearPluginId, { approvers: [] })).approvals.plugin
      .slack,
    { plugins: { linear: { approvers: [] } } },
  );

  const native = openClawRuntimeArtifact(
    occSelection({ approvers: [second], tools: { diffs: { approvers: [] } } }),
    [],
    [first],
  );
  assert.deepEqual(native.configuration.approvals.plugin.slack, {
    approvers: [first.id],
    plugins: { diffs: { approvers: [second.id], tools: { diffs: { approvers: [] } } } },
  });
  assert.throws(
    () => validatePolicies("openclaw", occSelection({ toolDefaults: { approvers: [] } })),
    { message: "Plugin tool defaults contains unsupported policy fields." },
  );
  // Each input breaks one approver rule; Slack approvers are user IDs, never channels.
  const approver = (id) => ({ channel: "slack", id });
  for (const [approvers, message] of [
    [[approver("team:X123:user:Y456")], "Plugin approver must identify a Slack user."],
    [[approver("C123")], "Plugin approver must identify a Slack user."],
    [approver("U123"), "Plugin approvers must be a bounded list."],
    [
      Array.from({ length: 65 }, (_, index) => approver(`U${index}`)),
      "Plugin approvers must be a bounded list.",
    ],
    [[approver("U123"), approver("U123")], "Plugin approvers must be unique."],
  ]) {
    assert.throws(() => validatePolicies("openclaw", {}, approvers), { message });
  }
});

test("Codex Plugin Driver admits only Agent-wide approvers; OpenClaw keeps plugin and tool overrides", () => {
  const approver = { channel: "slack", id: "team:T123:user:U123" };
  const toolId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c/repos%2Fread";
  const codex = new CodexPluginDriver();
  const occ = new OCCPluginDriver();
  // Codex approval requests carry no plugin or tool identity, so OpenClaw's Slack resolver
  // denies every Codex request once any plugin list exists. Only the Agent default works.
  assert.deepEqual(codex.policyCapabilities.approvers, {
    agent: true,
    plugin: false,
    tools: false,
  });
  assert.deepEqual(occ.policyCapabilities.approvers, { agent: true, plugin: true, tools: true });
  codex.validatePolicies(codexSelection(), [approver]);
  for (const selection of [
    codexSelection(linearPluginId, { approvers: [] }),
    codexSelection(linearPluginId, { tools: { [toolId]: { approvers: [approver] } } }),
    // A disabled plugin still renders its list into approvals.plugin.slack.plugins.
    codexSelection(linearPluginId, { enabled: false, approvers: [approver] }),
  ]) {
    assert.throws(
      () => codex.validatePolicies(selection, [approver]),
      (error) =>
        error.name === "PluginPolicyValidationError" &&
        /does not support plugin or tool approvers.*Agent-wide pluginApprovers/.test(error.message),
    );
  }
  occ.validatePolicies(
    occSelection({ approvers: [approver], tools: { diffs: { approvers: [] } } }),
    [approver],
  );
});

test("Plugin Drivers refuse two selection keys for the same native plugin", () => {
  const aliased = (error) =>
    error.name === "PluginPolicyValidationError" &&
    /same plugin.*Keep one selection per plugin/.test(error.message);
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();
  for (const enabled of [true, false]) {
    assert.throws(
      () => occ.validatePolicies({ diffs: { enabled: true }, "occ-plugin:diffs": { enabled } }),
      aliased,
    );
    assert.throws(
      () =>
        codex.validatePolicies({
          [linearPluginId]: { enabled: true },
          "linear@openai-curated-remote": { enabled },
        }),
      aliased,
    );
  }
  occ.validatePolicies({ diffs: { enabled: true } });
  codex.validatePolicies({
    ...codexSelection(linearPluginId),
    ...codexSelection(calendarPluginId),
  });
  // Admission-only: revisions admitted before the check still render.
  validatePolicies("openclaw", { diffs: { enabled: true }, "occ-plugin:diffs": { enabled: true } });
});

test("Plugin Drivers name themselves when a selection names a plugin they do not offer", () => {
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();
  // The error names the Driver and the rejected selection key, which HTTP reports as a
  // /plugins/<id> detail.
  const unknownFor = (driverId, pluginId) => (error) =>
    error.name === "PluginPolicyValidationError" &&
    error.pluginId === pluginId &&
    error.message.startsWith(
      `A plugin selection names a plugin that the selected Plugin Driver (${driverId}) does not offer: ${pluginId}.`,
    );
  // The other Driver's plugin, as after an Installation switches its single Plugin Driver.
  assert.throws(
    () => codex.validatePolicies(occSelection()),
    unknownFor("codex-plugin", "occ-plugin:diffs"),
  );
  assert.throws(
    () => occ.validatePolicies(codexSelection(linearPluginId)),
    unknownFor("occ-plugin", linearPluginId),
  );
  assert.throws(
    () => occ.validatePolicies({ "occ-plugin:unknown": { enabled: true } }),
    unknownFor("occ-plugin", "occ-plugin:unknown"),
  );
  assert.throws(
    () => codex.validatePolicies({ "codex-plugin:linear": { enabled: true } }),
    unknownFor("codex-plugin", "codex-plugin:linear"),
  );
  // With several selections, the error names the one the Driver does not offer.
  assert.throws(
    () => occ.validatePolicies({ ...occSelection(), ...codexSelection(linearPluginId) }),
    unknownFor("occ-plugin", linearPluginId),
  );
  // The ID mismatch wins over a policy field the selected Driver does not support.
  assert.throws(
    () =>
      occ.validatePolicies(codexSelection(linearPluginId, { toolDefaults: { reviewer: "human" } })),
    unknownFor("occ-plugin", linearPluginId),
  );
  // Policy errors on an offered plugin keep their own message.
  assert.throws(
    () => occ.validatePolicies(occSelection({ toolDefaults: { approval: "all_actions" } })),
    { name: "PluginPolicyValidationError", message: "The supplied plugin policies are invalid." },
  );
});

test("OpenClaw plugin startup translation rejects unsupported policies", () => {
  // Each selection breaks exactly one admission rule, named by its message.
  for (const [selection, message] of [
    [
      occSelection({ toolDefaults: { approval: "all_actions" } }),
      "OpenClaw plugin all_actions approval is unsupported.",
    ],
    [
      occSelection({ toolDefaults: { approval: "write_actions" } }),
      "OpenClaw plugin write_actions approval is unsupported.",
    ],
    [
      occSelection({ toolDefaults: { reviewer: "auto" } }),
      "This runtime does not support toolDefaults.reviewer; omit it to inherit.",
    ],
    [
      occSelection({ tools: { unknown: { enabled: false } } }),
      "Unknown OpenClaw plugin tool selection.",
    ],
    [
      occSelection({ tools: { diffs: { approval: "all_actions" } } }),
      "OpenClaw plugin all_actions approval is unsupported.",
    ],
    [
      occSelection({ tools: { diffs: { approval: "write_actions" } } }),
      "OpenClaw plugin write_actions approval is unsupported.",
    ],
    [
      occSelection({ approvalMode: "never" }),
      "Plugin selection contains unsupported policy fields.",
    ],
    [{ "occ-plugin:unknown": { enabled: true } }, "Unknown OpenClaw plugin selection."],
    [null, "Plugin selections must be an object."],
    [{ "occ-plugin:diffs": true }, "Plugin selection must be an object."],
    [{ "occ-plugin:diffs": {} }, "Plugin enabled must be a boolean."],
    [occSelection({ tools: [] }), "Plugin tool policies must be an object."],
    [occSelection({ tools: { diffs: { enabled: "yes" } } }), "Tool enabled must be a boolean."],
    [
      occSelection({ tools: { diffs: { approval: "sometimes" } } }),
      "Tool approval policy is unsupported.",
    ],
    [
      occSelection({ tools: { diffs: { reviewer: "human" } } }),
      "Per-tool reviewer selection is unsupported; omit tools[id].reviewer.",
    ],
    [
      occSelection({ driverPolicy: { any: true } }),
      "OpenClaw driver policy contains unsupported policy fields.",
    ],
  ]) {
    assert.throws(() => openClawRuntimeArtifact(selection), { message });
  }
  // Admission refuses an unknown plugin on its own; translation repeats the check with the
  // same message, so only a direct admission call shows the admission check exists.
  assert.throws(() => validatePolicies("openclaw", { "occ-plugin:unknown": { enabled: true } }), {
    message: "Unknown OpenClaw plugin selection.",
  });
});

test("OpenClaw tool enablement overrides tool defaults without enabling a disabled plugin", () => {
  const selections = occSelection({
    toolDefaults: { enabled: false },
    tools: { diffs: { enabled: true } },
  });
  assert.deepEqual(openClawRuntimeArtifact(selections).configuration, {
    plugins: { entries: { diffs: { enabled: true } } },
    tools: { alsoAllow: ["diffs"] },
  });
  const disabledTool = openClawRuntimeArtifact(
    occSelection({ tools: { diffs: { enabled: false, approval: "none" } } }),
  );
  assert.deepEqual(disabledTool.configuration.tools, { alsoAllow: ["diffs"], deny: ["diffs"] });
  selections["occ-plugin:diffs"].enabled = false;
  assert.deepEqual(openClawRuntimeArtifact(selections).configuration, {
    plugins: { entries: { diffs: { enabled: false } } },
  });
});

test("OpenClaw Plugin Driver refuses a selection a roster entry's tools.deny blocks", () => {
  const driver = new OCCPluginDriver();
  const plugins = occSelection();
  const refusal = (setting, verb = "blocks", entries = "entry") =>
    `Configuration ${setting} ${verb} every tool of plugin occ-plugin:diffs; remove the matching deny ${entries} or deselect the plugin.`;
  const check = (configuration) => () => driver.validateAgentConfiguration(plugins, configuration);
  // The pinned Gateway resolves a session's tool policy from its Agent's own entry, and with
  // one entry every session runs as it, whatever its key (finding 1848).
  for (const [key, deny] of [
    ["main", ["*"]],
    ["Ops", [" GROUP:PLUGINS "]],
    ["helper_1", ["exec", "dif*"]],
  ]) {
    const configuration = { agents: { entries: { [key]: { tools: { deny } } } } };
    assert.throws(check(configuration), {
      name: "ConfigurationHarnessError",
      message: refusal(`setting agents.entries.${key}.tools.deny`),
    });
  }
  // An entry key that is not a plain ID is quoted, as other roster refusals quote it.
  assert.throws(check({ agents: { entries: { "a.b": { tools: { deny: ["diffs"] } } } } }), {
    message: refusal('setting agents.entries["a.b"].tools.deny'),
  });
  // Each list that blocks the plugin on its own is named, so one fix clears the refusal.
  assert.throws(
    check({ tools: { deny: ["*"] }, agents: { entries: { main: { tools: { deny: ["*"] } } } } }),
    {
      message: refusal(
        "settings tools.deny and agents.entries.main.tools.deny",
        "block",
        "entries",
      ),
    },
  );
  assert.throws(
    check({ tools: { deny: ["*"] }, agents: { entries: { main: { tools: { deny: ["exec"] } } } } }),
    { message: refusal("setting tools.deny") },
  );
  // A disabled selection adds nothing to the allowlist, and agents.defaults carries no tool
  // policy in the pinned Gateway.
  driver.validateAgentConfiguration(
    { "occ-plugin:diffs": { enabled: false } },
    { agents: { entries: { main: { tools: { deny: ["*"] } } } } },
  );
  // A selection may name the plugin by its native ID alone, and the refusal names it so.
  assert.throws(
    () =>
      driver.validateAgentConfiguration(
        { diffs: { enabled: true } },
        { agents: { entries: { main: { tools: { deny: ["*"] } } } } },
      ),
    {
      message:
        "Configuration setting agents.entries.main.tools.deny blocks every tool of plugin diffs; remove the matching deny entry or deselect the plugin.",
    },
  );
  // Only deny lists are checked: an entry allowlist that leaves the plugin out still leaves
  // other tools callable, so turns run. Only * is a wildcard: "." and other regular
  // expression characters match themselves.
  for (const configuration of [
    { agents: { entries: { main: { tools: { deny: ["exec", "diffs-*", 7] } } } } },
    { agents: { entries: { main: { tools: { deny: ["d.ffs*", "di(f)fs*", "dif+s*"] } } } } },
    { agents: { entries: { main: { tools: { allow: ["exec"] } } } } },
    { agents: { defaults: { tools: { deny: ["*"] } } } },
    { agents: { entries: { main: {} } } },
  ]) {
    driver.validateAgentConfiguration(plugins, configuration);
  }
  // With several entries each session names its Agent. Denying the plugin to one of them is
  // a valid setup, but an entry denying every tool fails each of its sessions' turns.
  const roster = (ops) => ({
    ownership: "explicit",
    entries: { main: { tools: { deny: ["exec"] } }, ops: { tools: { deny: ops } } },
  });
  driver.validateAgentConfiguration(plugins, { agents: roster(["group:plugins"]) });
  // The refusal says that Agent's turns fail, not that its list blocks the plugin: a tool-less
  // Agent may be what the operator wanted (finding 1860).
  const denyAll = (setting, verb = "denies", both = "") =>
    `Configuration setting ${setting} ${verb} every tool, so every turn of that Agent fails with plugin occ-plugin:diffs selected; remove "*"${both} or move the Agent to a Configuration without plugins.`;
  assert.throws(check({ agents: roster(["exec", " ** "]) }), {
    message: denyAll("agents.entries.ops.tools.deny"),
  });
  const diffs = [
    {
      id: "occ-plugin:diffs",
      name: "Diffs",
      tools: [{ id: "diffs", name: "diffs", ownerId: "diffs" }],
    },
  ];
  assert.deepEqual(deniedOpenClawSelection(diffs, plugins, { agents: roster(["*"]) }), {
    pluginId: "occ-plugin:diffs",
    kind: "entryDenyAll",
    lists: [{ entry: "ops" }],
  });
  // A top-level list that does not block the plugin on its own is not named.
  assert.deepEqual(
    deniedOpenClawSelection(diffs, plugins, { tools: { deny: ["exec"] }, agents: roster(["*"]) }),
    { pluginId: "occ-plugin:diffs", kind: "entryDenyAll", lists: [{ entry: "ops" }] },
  );
  const both = {
    defaults: { model: "openai/gpt-5.1" },
    ownership: "explicit",
    entries: {
      main: {},
      "research-assistant": { tools: { deny: ["*"], byProvider: { openai: { deny: ["*"] } } } },
    },
  };
  // Realistic Agent keys fit uncut, also when both of the entry's lists deny every tool.
  assert.throws(check({ agents: both }), {
    message: denyAll(
      "agents.entries.research-assistant.tools.deny",
      "and its byProvider list deny",
      " from both",
    ),
  });
  const longKey = "k".repeat(300);
  const longDenyAll = openClawToolDenialMessage({
    pluginId: "occ-plugin:diffs",
    kind: "entryDenyAll",
    lists: [{ entry: longKey }, { entry: longKey, provider: longKey }],
  });
  assert.ok(Array.from(longDenyAll).length <= 256, longDenyAll);
  assert.match(
    longDenyAll,
    /^Configuration setting agents\.entries\["k+…"\]\.tools\.deny and its byProvider list deny every tool, .* without plugins\.$/,
  );
  assert.throws(check({ tools: { deny: ["*"] }, agents: roster(["*"]) }), {
    message: refusal("settings tools.deny and agents.entries.ops.tools.deny", "block", "entries"),
  });
  assert.throws(check({ tools: { deny: ["diffs"] }, agents: roster(["exec"]) }), {
    message: refusal("setting tools.deny"),
  });
  // A plugin with several tools is refused when the two lists together block all of them,
  // and the refusal names both.
  const split = (entryDeny) => ({
    tools: { deny: ["pair_read"] },
    agents: { entries: { main: { tools: { deny: entryDeny } } } },
  });
  assert.deepEqual(deniedOpenClawSelection(pairCatalog, pair, split(["pair_write"])), {
    pluginId: "occ-plugin:pair",
    kind: "deny",
    lists: [{}, { entry: "main" }],
  });
  assert.deepEqual(deniedOpenClawSelection(pairCatalog, pair, split(["pair"])), {
    pluginId: "occ-plugin:pair",
    kind: "deny",
    lists: [{ entry: "main" }],
  });
  assert.equal(deniedOpenClawSelection(pairCatalog, pair, split(["pair_read"])), undefined);
  // A plugin without tools has none to hide, so it is never refused (the check skips it).
  assert.equal(
    deniedOpenClawSelection(
      [{ id: "occ-plugin:empty", name: "Empty", tools: [] }],
      { "occ-plugin:empty": { enabled: true } },
      { tools: { deny: ["*"] } },
    ),
    undefined,
  );
  // With several entries only a deny-all entry is refused, never a union of lists.
  const several = split(["pair_write"]);
  several.agents = { ownership: "explicit", entries: { ...several.agents.entries, ops: {} } };
  assert.equal(deniedOpenClawSelection(pairCatalog, pair, several), undefined);
  assert.equal(
    openClawToolDenialMessage(deniedOpenClawSelection(pairCatalog, pair, split(["pair_write"]))),
    "Configuration settings tools.deny and agents.entries.main.tools.deny block every tool of plugin occ-plugin:pair; remove the matching deny entries or deselect the plugin.",
  );
});

test("OpenClaw Plugin Driver refuses a selection the primary model's tools.byProvider deny lists block", () => {
  const driver = new OCCPluginDriver();
  const plugins = occSelection();
  const refusal = (setting, verb = "blocks", entries = "entry") =>
    `Configuration ${setting} ${verb} every tool of plugin occ-plugin:diffs; remove the matching deny ${entries} or deselect the plugin.`;
  const check = (configuration) => () => driver.validateAgentConfiguration(plugins, configuration);
  const model = (primary, rest = {}) => ({ agents: { defaults: { model: primary } }, ...rest });
  // OpenClaw applies the byProvider policy of the running model as its own deny-wins step
  // (finding 1855). Every Agent shares the primary model, so admission resolves its provider
  // from there. The refusal names the key as written, quoted when it is not a plain ID.
  for (const [primary, key, deny, path] of [
    ["openai/gpt-5.1", "openai", ["*"], ".openai"],
    [{ primary: "OpenAI/GPT-5.1" }, " OPENAI ", ["group:plugins"], '[" OPENAI "]'],
    ["openai/gpt-5.1", "openai/", ["diffs"], '["openai/"]'],
    [" openrouter:auto ", "openrouter", ["dif*"], ".openrouter"],
  ]) {
    assert.throws(check(model(primary, { tools: { byProvider: { [key]: { deny } } } })), {
      name: "ConfigurationHarnessError",
      message: refusal(`setting tools.byProvider${path}.deny`),
    });
  }
  // A model key for the provider wins over the provider key when it matches the model ID as
  // the Gateway rewrites it (openrouter:auto runs as openrouter/openrouter/auto), which
  // admission cannot know: such a byProvider object is not checked, whichever key denies.
  for (const byProvider of [
    { openai: { deny: ["*"] }, "openai/gpt-5.1": { deny: ["exec"] } },
    { openai: { deny: ["*"] }, "OpenAI/gpt-5.1-mini": {} },
    { "openai/gpt-5.1": { deny: ["*"] } },
  ]) {
    driver.validateAgentConfiguration(plugins, model("openai/gpt-5.1", { tools: { byProvider } }));
  }
  driver.validateAgentConfiguration(
    plugins,
    model("openrouter:auto", { tools: { byProvider: { "openrouter/auto": { deny: ["*"] } } } }),
  );
  // Another provider's policy, or one without a primary model, never applies to the primary
  // model's turns; another provider's model key leaves the provider key in force.
  for (const configuration of [
    model("openai/gpt-5.1", { tools: { byProvider: { openrouter: { deny: ["*"] } } } }),
    model("openai/gpt-5.1", { tools: { byProvider: { "openrouter/gpt-5.1": { deny: ["*"] } } } }),
    { tools: { byProvider: { openai: { deny: ["*"] } } } },
    model("openai/gpt-5.1", { tools: { byProvider: { openai: { deny: ["exec", "diffs-*"] } } } }),
  ]) {
    driver.validateAgentConfiguration(plugins, configuration);
  }
  assert.throws(
    check(
      model("openai/gpt-5.1", {
        tools: { byProvider: { openai: { deny: ["*"] }, "openrouter/gpt-5.1": {} } },
      }),
    ),
    { message: refusal("setting tools.byProvider.openai.deny") },
  );
  // Keys that normalize alike ("openai/" normalizes to the provider key openai): the one
  // written in normalized form applies, wherever it stands.
  for (const byProvider of [
    { "openai/": { deny: ["exec"] }, openai: { deny: ["*"] } },
    { openai: { deny: ["*"] }, "openai/": { deny: ["exec"] } },
  ]) {
    assert.throws(check(model("openai/gpt-5.1", { tools: { byProvider } })), {
      message: refusal("setting tools.byProvider.openai.deny"),
    });
  }
  // A sole entry's byProvider list counts like its tools.deny, and an entry without its own
  // model runs the defaults' primary.
  const entry = (tools, entryModel) => ({
    agents: {
      ...(entryModel === undefined ? { defaults: { model: "openai/gpt-5.1" } } : {}),
      entries: { main: { ...(entryModel === undefined ? {} : { model: entryModel }), tools } },
    },
  });
  for (const configuration of [
    entry({ byProvider: { openai: { deny: ["diffs"] } } }),
    entry({ byProvider: { openai: { deny: ["*"] } } }, "openai/gpt-5.1"),
  ]) {
    assert.throws(check(configuration), {
      message: refusal("setting agents.entries.main.tools.byProvider.openai.deny"),
    });
  }
  // With several entries only an entry's deny-all list is refused.
  const roster = (ops) => ({
    defaults: { model: "openai/gpt-5.1" },
    ownership: "explicit",
    entries: { main: {}, ops: { tools: { byProvider: { openai: { deny: ops } } } } },
  });
  driver.validateAgentConfiguration(plugins, { agents: roster(["diffs"]) });
  assert.throws(check({ agents: roster(["*"]) }), {
    message:
      'Configuration setting agents.entries.ops.tools.byProvider.openai.deny denies every tool, so every turn of that Agent fails with plugin occ-plugin:diffs selected; remove "*" or move the Agent to a Configuration without plugins.',
  });
  // A top-level provider list applies to every Agent, whatever the roster.
  assert.throws(
    check({ agents: roster(["exec"]), tools: { byProvider: { openai: { deny: ["diffs"] } } } }),
    { message: refusal("setting tools.byProvider.openai.deny") },
  );
  // Lists that only together block every tool of a plugin are all named.
  const together = {
    tools: { deny: ["pair_read"], byProvider: { openai: { deny: ["exec"] } } },
    agents: {
      defaults: { model: "openai/gpt-5.1" },
      entries: { main: { tools: { byProvider: { OpenAI: { deny: ["pair_write"] } } } } },
    },
  };
  assert.deepEqual(deniedOpenClawSelection(pairCatalog, pair, together), {
    pluginId: "occ-plugin:pair",
    kind: "deny",
    lists: [{}, { entry: "main", provider: "OpenAI" }],
  });
  assert.equal(
    openClawToolDenialMessage(deniedOpenClawSelection(pairCatalog, pair, together)),
    "Configuration settings tools.deny and agents.entries.main.tools.byProvider.OpenAI.deny block every tool of plugin occ-plugin:pair; remove the matching deny entries or deselect the plugin.",
  );
  // When the top-level lists already block every tool together, an entry list is not named.
  together.tools.byProvider.openai.deny = ["pair_write"];
  together.agents.entries.main.tools.byProvider.OpenAI.deny = ["pair_read"];
  assert.deepEqual(deniedOpenClawSelection(pairCatalog, pair, together).lists, [
    {},
    { provider: "openai" },
  ]);
  // Long keys are cut so the message keeps the 256-character cap, and each path keeps the
  // setting it names.
  const long = "k".repeat(300);
  const message = openClawToolDenialMessage({
    pluginId: "occ-plugin:diffs",
    kind: "deny",
    lists: [{}, { entry: long }, { entry: long, provider: long }],
  });
  assert.ok(Array.from(message).length <= 256, message);
  assert.match(
    message,
    /^Configuration settings tools\.deny, agents\.entries\["k+…"\]\.tools\.deny and agents\.entries\["k+…"\]\.tools\.byProvider\["k+…"\]\.deny block every tool of plugin occ-plugin:diffs; remove the matching deny entries or deselect the plugin\.$/,
  );
  const hidden = openClawToolDenialMessage({
    pluginId: "occ-plugin:diffs",
    kind: "alsoAllow",
    entry: long,
  });
  assert.ok(Array.from(hidden).length <= 256, hidden);
  assert.match(
    hidden,
    /^Configuration setting agents\.entries\["k+…"\]\.tools\.alsoAllow overrides/,
  );
  // A message of exactly 256 characters is kept whole; one more cuts the key.
  const denyMessage = (entry) =>
    openClawToolDenialMessage({ pluginId: "occ-plugin:diffs", kind: "deny", lists: [{ entry }] });
  const exact = "k".repeat(257 - Array.from(denyMessage("k")).length);
  assert.equal(denyMessage(exact), refusal(`setting agents.entries.${exact}.tools.deny`));
  assert.equal(Array.from(denyMessage(exact)).length, 256);
  const over = denyMessage(`${exact}k`);
  assert.ok(Array.from(over).length <= 256, over);
  assert.match(over, /agents\.entries\["k+…"\]\.tools\.deny/);
  // With several long keys nothing fits even cut to …, so the end is cut instead.
  const crowded = openClawToolDenialMessage({
    pluginId: "occ-plugin:diffs",
    kind: "alsoAllow",
    entry: long,
    lists: [{ provider: long }, { entry: long, provider: long }],
  });
  assert.equal(Array.from(crowded).length, 256);
  assert.match(crowded, /^Configuration settings agents\.entries\["…"\]\.tools\.alsoAllow, .*…$/);
});

test("OpenClaw Plugin Driver refuses a sole entry's tools.alsoAllow that drops the plugin grant under a tool profile", () => {
  const driver = new OCCPluginDriver();
  const plugins = occSelection();
  const check = (configuration) => () => driver.validateAgentConfiguration(plugins, configuration);
  // The translator grants the plugin through top-level tools.alsoAllow. Under a profile that
  // lists core tools only, an entry's own alsoAllow replaces it at the profile step, so no
  // turn sees the plugin (finding 1857).
  const entry = (tools, top = {}) => ({ tools: top, agents: { entries: { main: { tools } } } });
  for (const configuration of [
    entry({ alsoAllow: ["browser"] }, { profile: "coding" }),
    entry({ profile: "minimal", alsoAllow: [] }),
    entry({ profile: "messaging", alsoAllow: ["exec", "diffs-*"] }, { profile: "full" }),
  ]) {
    assert.throws(check(configuration), {
      name: "ConfigurationHarnessError",
      message:
        "Configuration setting agents.entries.main.tools.alsoAllow overrides the plugin's tool grant under a tool profile, which hides every tool of plugin occ-plugin:diffs; add the plugin to that list or deselect the plugin.",
    });
  }
  for (const configuration of [
    // The list names the plugin, its tool, plugin tools, or everything.
    ...[["diffs"], [" Diffs "], ["group:plugins"], ["*"], ["dif*"]].map((alsoAllow) =>
      entry({ alsoAllow }, { profile: "coding" }),
    ),
    // No profile and the full profile add no restricting profile step.
    entry({ alsoAllow: ["browser"] }),
    entry({ alsoAllow: ["browser"] }, { profile: "full" }),
    entry({ profile: "full", alsoAllow: ["browser"] }, { profile: "coding" }),
    // Without its own alsoAllow the entry keeps the top-level grant.
    entry({ profile: "coding" }, { profile: "minimal" }),
    // With several entries, hiding a plugin from one Agent is a valid setup.
    {
      tools: { profile: "coding" },
      agents: {
        ownership: "explicit",
        entries: { main: { tools: { alsoAllow: ["browser"] } }, ops: {} },
      },
    },
  ]) {
    driver.validateAgentConfiguration(plugins, configuration);
  }
  driver.validateAgentConfiguration(
    { "occ-plugin:diffs": { enabled: false } },
    entry({ alsoAllow: ["browser"] }, { profile: "coding" }),
  );
  // One survivor check: the plugin tools the entry's list names must outlive every deny list
  // that applies. Each setting alone leaves a tool here; together they leave none.
  const restricted = (deny) => ({
    tools: { profile: "coding", byProvider: { openai: { deny } } },
    agents: {
      defaults: { model: "openai/gpt-5.1" },
      entries: { main: { tools: { alsoAllow: ["pair_read"] } } },
    },
  });
  assert.deepEqual(deniedOpenClawSelection(pairCatalog, pair, restricted(["pair_read"])), {
    pluginId: "occ-plugin:pair",
    kind: "alsoAllow",
    entry: "main",
    lists: [{ provider: "openai" }],
  });
  assert.equal(
    openClawToolDenialMessage(
      deniedOpenClawSelection(pairCatalog, pair, restricted(["pair_read"])),
    ),
    "Configuration settings agents.entries.main.tools.alsoAllow and tools.byProvider.openai.deny together hide every tool of plugin occ-plugin:pair; name its tools in alsoAllow, remove the deny entries, or deselect the plugin.",
  );
  // The sole entry's own deny lists apply too.
  const ownDeny = (deny) => ({
    tools: { profile: "coding" },
    agents: { entries: { main: { tools: { alsoAllow: ["pair_read"], deny } } } },
  });
  assert.deepEqual(deniedOpenClawSelection(pairCatalog, pair, ownDeny(["pair_read"])), {
    pluginId: "occ-plugin:pair",
    kind: "alsoAllow",
    entry: "main",
    lists: [{ entry: "main" }],
  });
  assert.equal(deniedOpenClawSelection(pairCatalog, pair, ownDeny(["pair_write"])), undefined);
  assert.equal(deniedOpenClawSelection(pairCatalog, pair, restricted(["pair_write"])), undefined);
  assert.equal(deniedOpenClawSelection(pairCatalog, pair, restricted([])), undefined);
});

test("Hardcoded OpenAI catalog returns curated details without provider requests", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", (url) => {
    requests.push(String(url));
    throw new Error("Unexpected provider request");
  });
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  const page = await driver.discoverCatalog({});
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    new Set(page.plugins.map((entry) => entry.name)),
    new Set([
      "Linear",
      "Slack",
      "GitHub",
      "Notion",
      "Figma",
      "Canva",
      "Datadog",
      "Sentry",
      "Adobe",
      "Coursera Learning",
      "Google Contacts",
    ]),
  );
  const linear = page.plugins.find((entry) => entry.id === linearPluginId);
  assert.ok(linear);
  assert.equal(linear.id, linearPluginId);
  assert.equal(linear.remoteId, "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c");
  assert.equal(linear.tools, null);
  assert.equal(linear.selectableWithoutTools, true);
  assert.deepEqual(await driver.getCatalogPlugin({ pluginId: linear.remoteId }), linear);
  const github = page.plugins.find((entry) => entry.name === "GitHub");
  assert.ok(github);
  assert.equal(github.remoteId, "plugin_connector_1p_1a69035c238881919c4190932b2df699");
  assert.deepEqual(await driver.getCatalogPlugin({ pluginId: github.remoteId }), github);
  // Recorded releases with unsupported components must never be offered for selection.
  assert.deepEqual(
    new Set(page.plugins.filter((entry) => entry.available === false).map((entry) => entry.name)),
    new Set(["Sentry"]),
  );
  assert.equal(new Set(page.plugins.map((entry) => entry.remoteId)).size, page.plugins.length);
  for (const entry of page.plugins) {
    assert.ok(entry.remoteId);
    assert.deepEqual(await driver.getCatalogPlugin({ pluginId: entry.remoteId }), entry);
    if (entry.available === false) {
      assert.match(entry.unavailableReason, /no concrete hosted app/);
    } else {
      assert.equal(entry.selectableWithoutTools, true);
    }
  }
  assert.deepEqual(await driver.listCatalog(context("dedicated")), page.plugins);
  // The curated catalog is a single page with fixed IDs; anything else is an invalid response.
  const invalidResponse = { name: "PluginDiscoveryError", reason: "invalid_response" };
  await assert.rejects(driver.discoverCatalog({ cursor: "invalid" }), invalidResponse);
  await assert.rejects(driver.getCatalogPlugin({ pluginId: "invalid" }), invalidResponse);
  assert.deepEqual(requests, []);
});

test("Codex curated catalog discovery projects arbitrary marketplace entries", () => {
  const catalog = codexCatalogEntries(codexCatalogFixture());
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [linearPluginId, calendarPluginId, thirdPluginId],
  );
  assert.deepEqual(catalog[2], {
    id: thirdPluginId,
    name: "Third Plugin",
    tools: null,
  });
  assert.deepEqual(codexRuntimeReadParams(codexSelection(thirdPluginId), codexCatalogFixture()), [
    { remoteMarketplaceName: "openai-curated-remote", pluginName: thirdRemotePluginId },
  ]);
});

test("native Codex catalog reader accepts initialized logged-in accounts and opaque remote IDs", async (context) => {
  const directory = await temporaryDirectory(context, "occ-codex-plugin-reader-");
  const executable = join(directory, "codex-fixture.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";

const catalog = ${JSON.stringify(codexCatalogFixture())};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {} }));
    return;
  }
  if (message.method === "account/read") {
    console.log(JSON.stringify({
      id: message.id,
      result: {
        account: {
          type: "chatgpt",
          email: "fixture@example.test",
          planType: "team"
        },
        requiresOpenaiAuth: true
      }
    }));
    return;
  }
  if (message.method === "plugin/list") {
    console.log(JSON.stringify({ id: message.id, result: catalog }));
    process.exit(0);
  }
});
`,
  );
  await chmod(executable, 0o755);

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 1_000,
  });

  const catalog = await reader.listCatalog();
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [linearPluginId, calendarPluginId, thirdPluginId],
  );
  assert.equal(catalog[2].name, "Third Plugin");

  const fixture = await readFile(executable, "utf8");
  await writeFile(executable, fixture.replace('type: "chatgpt"', 'type: "apiKey"'));
  await assert.rejects(reader.listCatalog(), /ChatGPT\/Codex-backed account/);
});

test("native Codex catalog reader rejects, without crashing, when Codex closes its input early", async (context) => {
  const directory = await temporaryDirectory(context, "occ-codex-plugin-reader-");
  const executable = join(directory, "codex-fixture.mjs");
  // Answers initialize after closing stdin, so the reader's next write hits a closed pipe.
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { closeSync } from "node:fs";
closeSync(0);
process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
setTimeout(() => {}, 2_000);
`,
  );
  await chmod(executable, 0o755);
  const uncaught = [];
  const record = (error) => uncaught.push(error);
  // Record any uncaught error so the assertion below names it.
  process.prependListener("uncaughtException", record);
  context.after(() => process.off("uncaughtException", record));

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 5_000,
  });
  await assert.rejects(reader.listCatalog(), NotImplementedError);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    uncaught.map((error) => error.code ?? error.message),
    [],
  );
});

test("native Codex catalog reader does not echo the Codex app-server error message", async (context) => {
  const directory = await temporaryDirectory(context, "occ-codex-plugin-reader-");
  const executable = join(directory, "codex-fixture.mjs");
  const leaked = join(directory, "home", "operator", ".codex", "auth.json");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {} }));
    return;
  }
  console.log(JSON.stringify({
    id: message.id,
    error: { code: -32603, message: ${JSON.stringify(`failed to read ${leaked}: permission denied`)} },
  }));
});
`,
  );
  await chmod(executable, 0o755);

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 5_000,
  });
  const error = await reader.listCatalog().then(
    () => assert.fail("the catalog read must fail"),
    (rejection) => rejection,
  );
  assert.ok(error instanceof NotImplementedError, String(error));
  // The 501 body carries this message; it names the request, never the app-server's text.
  const body = requestFailure(error);
  assert.equal(body.status, 501);
  assert.equal(body.message, "Codex plugin catalog discovery failed during account/read.");
  assert.ok(!body.message.includes(directory));
});

test("native Codex catalog reader kills a Codex process that ignores SIGTERM after an abort", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-codex-plugin-reader-"));
  const pidFile = join(directory, "codex.pid");
  let pid;
  context.after(async () => {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone: the reader stopped it.
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const executable = join(directory, "codex-fixture.mjs");
  // The PID file appears only once the SIGTERM handler is installed (rename is atomic).
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { renameSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));
renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
process.stdin.resume();
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o755);

  const reader = new NativeCodexPluginCatalogReader({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 60_000,
  });
  const controller = new AbortController();
  const listed = reader.listCatalog(controller.signal);
  listed.catch(() => {});
  pid = await waitFor(
    "the Codex fixture to start",
    () =>
      readFile(pidFile, "utf8").then(
        (text) => Number(text) || undefined,
        () => undefined,
      ),
    30_000,
  );
  assert.ok(pid > 0, "the Codex fixture did not start");
  controller.abort();
  await assert.rejects(listed, /aborted/);
  // The aborted Codex app-server must not outlive the request.
  await waitUntil(
    "the aborted Codex app-server to exit",
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { timeoutMs: 5_000, intervalMs: 50 },
  );
});

test("Codex native catalog rejects a non-object response without escaping discovery", async (t) => {
  const directory = await temporaryDirectory(t, "oce-codex-catalog-shape-");
  const executable = join(directory, "codex-fixture.mjs");
  // The configured peer writes valid JSON with an invalid JSON-RPC envelope.
  // Exercise the public Driver and real OS pipes, not a substituted reader.
  await writeFile(
    executable,
    `#!/usr/bin/env node
process.stdin.once("data", () => process.stdout.write("null\\n"));
`,
  );
  await chmod(executable, 0o755);
  const driver = new CodexPluginDriver({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 1_000,
  });
  await assert.rejects(driver.listCatalog(context("dedicated")), (error) => {
    assert.ok(error instanceof NotImplementedError);
    assert.match(error.message, /returned an invalid JSON-RPC response/);
    return true;
  });
});

test("Codex native catalog rejects a malformed plugin/list result as discovery failure", async (t) => {
  const directory = await temporaryDirectory(t, "oce-codex-catalog-result-");
  const executable = join(directory, "codex-fixture.mjs");
  const resultFile = join(directory, "plugin-list-result.json");
  // Valid envelopes from a logged-in account; only the plugin/list result varies.
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  const result =
    message.method === "account/read"
      ? { account: { type: "chatgpt" } }
      : message.method === "plugin/list"
        ? JSON.parse(readFileSync(${JSON.stringify(resultFile)}, "utf8"))
        : {};
  console.log(JSON.stringify({ id: message.id, result }));
});
`,
  );
  await chmod(executable, 0o755);
  const driver = new CodexPluginDriver({
    codexExecutable: executable,
    codexHome: directory,
    requestTimeoutMs: 5_000,
  });
  const listWith = async (result) => {
    await writeFile(resultFile, JSON.stringify(result));
    return await driver.listCatalog(context("dedicated"));
  };
  const curated = (plugins) => ({ marketplaces: [{ name: "openai-curated-remote", plugins }] });

  // Control: the same fixture serves a well-formed catalog.
  assert.deepEqual(
    (await listWith(codexCatalogFixture())).map((entry) => entry.id),
    [linearPluginId, calendarPluginId, thirdPluginId],
  );
  for (const empty of [
    { marketplaces: [] },
    { marketplaces: [{ name: "another-marketplace", plugins: [] }] },
    curated([]),
  ]) {
    assert.deepEqual(await listWith(empty), []);
  }
  const malformed = {
    "null result": null,
    "array result": [],
    "string result": "catalog",
    "result without marketplaces": {},
    "null marketplaces": { marketplaces: null },
    "curated marketplace without plugins": curated(undefined),
    "null curated plugin list": curated(null),
    "non-array curated plugin list": curated({}),
    "null plugin summary": curated([null]),
    "plugin without an ID": curated([{ remotePluginId: "linear" }]),
    "plugin from another marketplace": curated([
      { id: "linear@openai-internal-testing", remotePluginId: "linear" },
    ]),
  };
  for (const [name, result] of Object.entries(malformed)) {
    await assert.rejects(
      listWith(result),
      (error) => {
        assert.ok(error instanceof NotImplementedError, `${name}: ${error}`);
        assert.equal(
          error.message,
          "Codex plugin catalog discovery returned an invalid plugin catalog.",
          name,
        );
        return true;
      },
      name,
    );
  }
});

test("Codex startup default-denies plugins", () => {
  const empty = codexRuntimeArtifact({}, []);
  assert.equal(empty.kind, "codex");
  assert.deepEqual(empty.configuration.features, {
    apps: false,
    plugins: false,
    remote_plugin: false,
  });
  assert.deepEqual(empty.configuration.apps, { _default: { enabled: false } });
  assert.deepEqual(empty.configuration.plugins, { _default: { enabled: false } });
  assert.deepEqual(empty.installs, []);
});

test("Codex bridge keeps runtime binaries readable after the last plugin is removed", () => {
  // A normal no-plugin revision still starts the packaged native sandbox helper.
  // Plugin skill and credential directories must not survive as incidental grants.
  const config = codexOpenClawConfiguration({}).plugins.entries.codex.config;
  assert.deepEqual(config, {
    appServer: {
      networkProxy: { readOnlyPaths: ["/app/node_modules/openclaw"] },
    },
  });
});

test("Codex bridge configuration carries repository broker network policy without plugins", () => {
  const bridgeConfiguration = codexOpenClawConfiguration({}, [], {
    repositoryBrokerNetworkPolicy: { host: "git.tenant.svc", domains: { "github.com": "allow" } },
  });

  assert.deepEqual(bridgeConfiguration.plugins.entries.codex.config, {
    appServer: {
      networkProxy: {
        enabled: true,
        mode: "full",
        allowLocalBinding: true,
        readOnlyPaths: [
          "/app/node_modules/openclaw",
          "/home/node/.openclaw/plugin-skills",
          "/home/node/openclaw-runtime-assets/plugin-skills",
          "/opt/oce/repository-credentials",
          "/run/oce/repository-credentials",
        ],
        domains: { "github.com": "allow", "git.tenant.svc": "allow" },
      },
    },
  });
});

test("Codex bridge configuration grants plugin skill reads without broker policy", () => {
  const bridgeConfiguration = codexOpenClawConfiguration(codexSelection());

  assert.deepEqual(bridgeConfiguration.plugins.entries.codex.config.appServer, {
    networkProxy: {
      readOnlyPaths: [
        "/app/node_modules/openclaw",
        "/home/node/.openclaw/plugin-skills",
        "/home/node/openclaw-runtime-assets/plugin-skills",
      ],
    },
  });
  assert.deepEqual(bridgeConfiguration.plugins.entries.codex.config.codexPlugins.plugins.linear, {
    enabled: true,
    marketplaceName: "openai-curated-remote",
    pluginName: "linear",
    allow_destructive_actions: "auto",
  });
});

test("Codex startup translation renders selected marketplace app plugins", () => {
  const selections = {
    ...codexSelection(linearPluginId),
    ...codexSelection(calendarPluginId, {
      toolDefaults: { approval: "provider_default", reviewer: "auto" },
    }),
    ...codexSelection(thirdPluginId),
  };
  const artifact = codexRuntimeArtifact(selections, codexDetails);
  const bridgeConfiguration = codexOpenClawConfiguration(selections);

  assert.equal(artifact.kind, "codex");
  assert.deepEqual(artifact.configuration.plugins, {
    _default: { enabled: false },
    "linear@openai-curated-remote": { enabled: true },
    "google-calendar@openai-curated-remote": { enabled: true },
    "third-plugin@openai-curated-remote": { enabled: true },
  });
  assert.deepEqual(artifact.configuration.apps, {
    _default: { enabled: false },
    asdk_app_69a089a326dc8191b32a3f2553f5be2c: {
      enabled: true,
      default_tools_approval_mode: "auto",
    },
    connector_947e0d954944416db111db556030eea6: {
      enabled: true,
      default_tools_approval_mode: "auto",
      approvals_reviewer: "auto_review",
    },
    connector_third_fixture: { enabled: true, default_tools_approval_mode: "auto" },
  });
  assert.deepEqual(bridgeConfiguration.plugins.entries.codex.config.codexPlugins.plugins, {
    linear: {
      enabled: true,
      marketplaceName: "openai-curated-remote",
      pluginName: "linear",
      allow_destructive_actions: "auto",
    },
    "google-calendar": {
      enabled: true,
      marketplaceName: "openai-curated-remote",
      pluginName: "google-calendar",
      allow_destructive_actions: "auto",
    },
    "third-plugin": {
      enabled: true,
      marketplaceName: "openai-curated-remote",
      pluginName: "third-plugin",
      allow_destructive_actions: "auto",
    },
  });
  assert.deepEqual(artifact.installs, [
    {
      pluginId: linearPluginId,
      nativeId: "linear@openai-curated-remote",
      remotePluginId: "linear",
      version: "5.0.1",
      registry: "openai-curated-remote",
    },
    {
      pluginId: calendarPluginId,
      nativeId: "google-calendar@openai-curated-remote",
      remotePluginId: "google-calendar",
      version: "1.2.7",
      registry: "openai-curated-remote",
    },
    {
      pluginId: thirdPluginId,
      nativeId: "third-plugin@openai-curated-remote",
      remotePluginId: thirdRemotePluginId,
      version: "2.3.4",
      registry: "openai-curated-remote",
    },
  ]);
});

test("Codex activates selected skills independently of app tools", () => {
  const skillPluginId = "codex-plugin:writing@openai-curated-remote";
  const skillDetail = codexDetail("writing", [], { skills: [{ name: "draft" }] });
  const selections = {
    ...codexSelection(linearPluginId, { toolDefaults: { enabled: false } }),
    ...codexSelection(skillPluginId),
  };
  const artifact = codexRuntimeArtifact(selections, [
    codexDetail("linear", ["app_notes"], { skills: [{ name: "notes" }] }),
    skillDetail,
  ]);
  assert.deepEqual(artifact.configuration.plugins, {
    _default: { enabled: false },
    "linear@openai-curated-remote": { enabled: true },
    "writing@openai-curated-remote": { enabled: true },
  });
  assert.deepEqual(artifact.configuration.apps, {
    _default: { enabled: false },
    app_notes: {
      enabled: true,
      default_tools_enabled: false,
      default_tools_approval_mode: "auto",
    },
  });

  // Aliases cannot represent separate install outcomes for one native plugin.
  const aliases = {
    ...codexSelection(skillPluginId),
    "writing@openai-curated-remote": { enabled: true },
  };
  for (const enabled of [true, false]) {
    aliases["writing@openai-curated-remote"].enabled = enabled;
    assert.throws(
      () => codexRuntimeArtifact(aliases, [skillDetail]),
      /duplicate native plugin IDs/,
    );
  }
});

test("Codex startup translation preserves explicit approval defaults and routed reviewer selection", () => {
  for (const [approval, nativeApproval] of [
    ["provider_default", "auto"],
    ["all_actions", "prompt"],
    ["write_actions", "writes"],
    ["none", "approve"],
  ]) {
    for (const [reviewer, nativeReviewer] of [
      ["human", "user"],
      ["auto", "auto_review"],
      [undefined, undefined],
    ]) {
      const selections = codexSelection(linearPluginId, {
        toolDefaults: { approval, ...(reviewer === undefined ? {} : { reviewer }) },
      });
      const app = codexRuntimeArtifact(selections, codexDetails).configuration.apps
        .asdk_app_69a089a326dc8191b32a3f2553f5be2c;
      assert.equal(app.default_tools_approval_mode, nativeApproval);
      assert.equal(app.approvals_reviewer, nativeReviewer);
      assert.equal(Object.hasOwn(app, "approvals_reviewer"), reviewer !== undefined);
      assert.equal(Object.hasOwn(app, "default_tools_enabled"), false);
      assert.equal(Object.hasOwn(app, "tools"), false);
      assert.equal(
        codexOpenClawConfiguration(selections).plugins.entries.codex.config.codexPlugins.plugins
          .linear.allow_destructive_actions,
        "auto",
      );
    }
  }
  const disabled = codexSelection(linearPluginId, { enabled: false });
  assert.deepEqual(codexRuntimeArtifact(disabled, codexDetails).configuration.apps, {
    _default: { enabled: false },
  });
  assert.equal(
    codexOpenClawConfiguration(disabled).plugins.entries.codex.config.codexPlugins.plugins.linear
      .enabled,
    false,
  );
});

test("Codex scoped tools override write action defaults and retain omitted native fields", () => {
  const appId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
  const inventory = [
    {
      name: "codex_apps",
      tools: Object.fromEntries(
        ["repos/read", "repos/write"].map((name) => [
          name,
          { name, _meta: { connector_id: appId } },
        ]),
      ),
    },
  ];
  const selections = codexSelection(linearPluginId, {
    toolDefaults: { enabled: false, approval: "write_actions", reviewer: "auto" },
    tools: {
      [appId + "/repos%2Fread"]: { enabled: true },
      [appId + "/repos%2Fwrite"]: { approval: "provider_default" },
    },
  });
  const app = codexRuntimeArtifact(selections, codexDetails, [], inventory).configuration.apps[
    appId
  ];
  assert.deepEqual(app, {
    enabled: true,
    default_tools_enabled: false,
    default_tools_approval_mode: "writes",
    approvals_reviewer: "auto_review",
    tools: {
      "repos/read": { enabled: true },
      "repos/write": { approval_mode: "auto" },
    },
  });
  assert.equal(
    codexOpenClawConfiguration(selections).plugins.entries.codex.config.codexPlugins.plugins.linear
      .allow_destructive_actions,
    "auto",
  );
  for (const id of [
    "repos/read",
    "other-app/repos%2Fread",
    appId + "/missing",
    appId + "/repos%2fread",
  ]) {
    assert.throws(
      () =>
        codexRuntimeArtifact(
          codexSelection(linearPluginId, { tools: { [id]: { enabled: false } } }),
          codexDetails,
          [],
          inventory,
        ),
      /tool/i,
    );
  }
  assert.throws(() => codexRuntimeArtifact(selections, codexDetails), /inventory/i);
});

test("Codex catalog tool policies resolve through owned action metadata to native names", () => {
  const appId = "catalog-app";
  const nativeName = "renamed_123.search";
  const details = [codexDetail("linear", [appId])];
  const tool = {
    name: nativeName,
    _meta: {
      connector_id: appId,
      _codex_apps: { resource_uri: "/catalog-app/link_fixture/search" },
    },
  };
  const inventory = [{ name: "codex_apps", tools: { [nativeName]: tool } }];
  const selections = codexSelection(linearPluginId, {
    tools: { "catalog-app/search": { enabled: true, approval: "all_actions" } },
  });
  assert.deepEqual(
    codexRuntimeArtifact(selections, details, [], inventory).configuration.apps[appId].tools,
    { [nativeName]: { enabled: true, approval_mode: "prompt" } },
  );
  const writeActionSelection = codexSelection(linearPluginId, {
    tools: { "catalog-app/search": { approval: "write_actions" } },
  });
  assert.deepEqual(
    codexRuntimeArtifact(writeActionSelection, details, [], inventory).configuration.apps[appId]
      .tools,
    { [nativeName]: { approval_mode: "writes" } },
  );

  // Display prefixes are not identities; missing, malformed or foreign metadata cannot bind them.
  for (const resourceUri of [
    undefined,
    "/other-app/link_fixture/search",
    "/catalog-app//search",
    "/catalog-app/link_fixture/search/extra",
    "catalog-app/link_fixture/search",
  ]) {
    const invalid = structuredClone(inventory);
    invalid[0].tools[nativeName]._meta._codex_apps.resource_uri = resourceUri;
    assert.throws(
      () => codexRuntimeArtifact(selections, details, [], invalid),
      /unknown or unowned tool/,
    );
  }

  const ambiguous = structuredClone(inventory);
  ambiguous[0].tools["another.search"] = { ...tool, name: "another.search" };
  assert.throws(() => codexRuntimeArtifact(selections, details, [], ambiguous), /ambiguous/);
  assert.throws(
    () =>
      codexRuntimeArtifact(
        codexSelection(linearPluginId, {
          tools: {
            "catalog-app/search": { enabled: true },
            [appId + "/" + nativeName]: { enabled: false },
          },
        }),
        details,
        [],
        inventory,
      ),
    /same native tool/,
  );
});

test("Codex shared apps accept identical policies using mixed catalog and native IDs", () => {
  const details = [codexDetail("linear", ["app"]), codexDetail("google-calendar", ["app"])];
  const inventory = [
    {
      name: "codex_apps",
      tools: Object.fromEntries(
        ["alpha", "beta"].map((action) => [
          "prefix." + action,
          {
            name: "prefix." + action,
            _meta: {
              connector_id: "app",
              _codex_apps: { resource_uri: "/app/link_fixture/" + action },
            },
          },
        ]),
      ),
    },
  ];
  // Alias sorting differs, but both plugins request the same native policy.
  const selections = {
    ...codexSelection(linearPluginId, {
      tools: { "app/prefix.alpha": { enabled: true }, "app/beta": { enabled: false } },
    }),
    ...codexSelection(calendarPluginId, {
      tools: { "app/alpha": { enabled: true }, "app/beta": { enabled: false } },
    }),
  };
  assert.deepEqual(
    codexRuntimeArtifact(selections, details, [], inventory).configuration.apps.app.tools,
    {
      "prefix.alpha": { enabled: true },
      "prefix.beta": { enabled: false },
    },
  );
});

test("Codex destructive defaults project to native config and the hosted-app bridge", () => {
  const selections = codexSelection(linearPluginId, {
    toolDefaults: { approval: "provider_default", reviewer: "human" },
    driverPolicy: { destructiveEnabled: false },
  });
  const app = codexRuntimeArtifact(selections, codexDetails).configuration.apps
    .asdk_app_69a089a326dc8191b32a3f2553f5be2c;
  assert.equal(app.destructive_enabled, false);
  assert.equal(Object.hasOwn(app, "default_tools_enabled"), false);
  assert.equal(
    codexOpenClawConfiguration(selections).plugins.entries.codex.config.codexPlugins.plugins.linear
      .allow_destructive_actions,
    false,
  );
  for (const enabled of [true, false]) {
    assert.throws(
      () =>
        validatePolicies(
          "codex",
          codexSelection(linearPluginId, {
            toolDefaults: { enabled },
            driverPolicy: { destructiveEnabled: false },
          }),
        ),
      /bypasses category/,
    );
  }
  for (const [driverPolicy, message] of [
    [{ unknown: true }, "Codex driver policy contains unsupported policy fields."],
    [{ destructiveEnabled: "false" }, "Codex destructiveEnabled must be a boolean."],
    [{ approvalsReviewer: "user" }, "Codex driver policy contains unsupported policy fields."],
  ]) {
    assert.throws(
      () => validatePolicies("codex", codexSelection(linearPluginId, { driverPolicy })),
      { message },
    );
  }
  // Codex accepts toolDefaults.reviewer, so only the value check can refuse this one.
  assert.throws(
    () =>
      validatePolicies(
        "codex",
        codexSelection(linearPluginId, { toolDefaults: { reviewer: "robot" } }),
      ),
    { message: "Tool reviewer must be human or auto." },
  );
  // Codex selections must name a plugin from the curated remote marketplace.
  assert.throws(
    () => validatePolicies("codex", codexSelection("codex-plugin:linear@openai-internal-testing")),
    { message: "Codex plugin ID must identify the curated remote marketplace." },
  );
});

test("Codex startup translation admits a selected plugin with native skills", () => {
  const detail = codexDetail("linear", ["linear_app"], {
    skills: [{ name: "linear-workflow" }],
  });
  const artifact = codexRuntimeArtifact(codexSelection(linearPluginId), [detail]);
  assert.deepEqual(
    artifact.installs.map((install) => install.pluginId),
    [linearPluginId],
  );
  assert.equal(artifact.configuration.apps.linear_app.enabled, true);
});

test("Codex startup translation fails selected-only policy gaps at startup", () => {
  for (const [selection, details, pattern] of [
    [codexSelection(linearPluginId, { approvalMode: "never" }), codexDetails, /unsupported/i],
    [codexSelection(linearPluginId, { writes: "prompt" }), codexDetails, /unsupported/i],
    [codexSelection(linearPluginId, { tools: { search: {} } }), codexDetails, /tool/i],
    [codexSelection(linearPluginId), [], /detail/i],
    [codexSelection(linearPluginId), [codexDetail("linear", [])], /app mapping/i],
    [
      codexSelection(linearPluginId),
      [codexDetail("linear", ["app"], { version: "" })],
      /release version/i,
    ],
    ...["hooks", "mcpServers", "scheduledTasks"].map((field) => [
      codexSelection(linearPluginId),
      [codexDetail("linear", [], { skills: [{ name: "draft" }], [field]: [{ id: "native" }] })],
      new RegExp(field, "i"),
    ]),
    [
      {
        ...codexSelection(linearPluginId, {
          toolDefaults: { approval: "provider_default", reviewer: "human" },
        }),
        ...codexSelection(thirdPluginId, {
          toolDefaults: { approval: "provider_default", reviewer: "auto" },
        }),
      },
      [
        codexDetail("linear", ["shared_app"]),
        codexDetail(thirdRemotePluginId, ["shared_app"], {
          summaryId: "third-plugin@openai-curated-remote",
          version: "2.3.4",
        }),
      ],
      /conflicting approval policy/i,
    ],
  ]) {
    assert.throws(() => codexRuntimeArtifact(selection, details), pattern);
  }
});

test("Codex rejects shared app enablement conflicts in either selection order", () => {
  const selections = {
    ...codexSelection(linearPluginId),
    ...codexSelection(thirdPluginId, { enabled: false }),
  };
  const details = [
    codexDetail("linear", ["shared_app"]),
    codexDetail(thirdRemotePluginId, ["shared_app"], {
      summaryId: "third-plugin@openai-curated-remote",
      version: "2.3.4",
    }),
  ];
  for (const entries of [Object.entries(selections), Object.entries(selections).reverse()]) {
    assert.throws(
      () => codexRuntimeArtifact(Object.fromEntries(entries), details),
      /conflicting enablement/,
    );
  }
});

test("Codex startup translation rejects malformed native plugin detail metadata", () => {
  const baseSummary = {
    id: "linear@openai-curated-remote",
    remotePluginId: "linear",
    interface: { displayName: "Linear" },
    version: "5.0.1",
  };
  const baseDetail = {
    plugin: {
      summary: baseSummary,
      apps: [{ id: "linear_app" }],
      appTemplates: [],
      hooks: [],
      skills: [],
      mcpServers: [],
      scheduledTasks: [],
    },
  };

  for (const [detail, pattern] of [
    [{ plugin: { ...baseDetail.plugin, apps: "linear_app" } }, /app/i],
    [{ plugin: { ...baseDetail.plugin, hooks: "hook" } }, /hooks/i],
    [{ plugin: { ...baseDetail.plugin, skills: "skill" } }, /skills/i],
    [{ plugin: { ...baseDetail.plugin, mcpServers: "native" } }, /mcpServers/i],
    [
      {
        plugin: {
          ...baseDetail.plugin,
          releaseVersion: "9.9.9",
          summary: {
            id: "linear@openai-curated-remote",
            remotePluginId: "linear",
            interface: {
              displayName: "Linear",
              manifest: { version: "9.9.9" },
            },
          },
        },
      },
      /release version/i,
    ],
  ]) {
    assert.throws(() => codexRuntimeArtifact(codexSelection(linearPluginId), [detail]), pattern);
  }
});

test("bundled Plugin Drivers enforce Harness identity", async () => {
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();

  await assert.rejects(occ.listCatalog(context("dedicated")), NotImplementedError);
  await assert.rejects(codex.listCatalog(context("embedded")), NotImplementedError);
});
