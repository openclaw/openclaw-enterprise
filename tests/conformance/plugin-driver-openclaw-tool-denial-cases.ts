import assert from "node:assert/strict";
import test from "node:test";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  deniedOpenClawSelection,
  openClawToolDenialMessage,
} from "../../apps/controller/src/drivers/plugin/openclaw-tool-denial.ts";
import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "../../packages/contracts/src/index.ts";
import { occSelection } from "./plugin-driver-fixtures.ts";

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

function refusal(setting: string, verb = "blocks", entries = "entry") {
  return `Configuration ${setting} ${verb} every tool of plugin occ-plugin:diffs; remove the matching deny ${entries} or deselect the plugin.`;
}

test("OpenClaw Plugin Driver refuses a selection a roster entry's tools.deny blocks", () => {
  const driver = new OCCPluginDriver();
  const plugins = occSelection();
  const check = (configuration: OpenClawConfigurationDocument) => () =>
    driver.validateAgentConfiguration(plugins, configuration);
  // The pinned Gateway resolves a session's tool policy from its Agent's own entry, and with
  // one entry every session runs as it, whatever its key (finding 1848).
  for (const [key, deny] of [
    ["main", ["*"]],
    ["Ops", [" GROUP:PLUGINS "]],
    ["helper_1", ["exec", "dif*"]],
  ] as const) {
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
  const roster = (ops: readonly string[]) => ({
    ownership: "explicit",
    entries: { main: { tools: { deny: ["exec"] } }, ops: { tools: { deny: ops } } },
  });
  driver.validateAgentConfiguration(plugins, { agents: roster(["group:plugins"]) });
  // The refusal says that Agent's turns fail, not that its list blocks the plugin: a tool-less
  // Agent may be what the operator wanted (finding 1860).
  const denyAll = (setting: string, verb = "denies", both = "") =>
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
  const split = (entryDeny: readonly string[]) => ({
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
  const sole = split(["pair_write"]);
  const several = {
    ...sole,
    agents: { ownership: "explicit", entries: { ...sole.agents.entries, ops: {} } },
  };
  assert.equal(deniedOpenClawSelection(pairCatalog, pair, several), undefined);
  const denied = deniedOpenClawSelection(pairCatalog, pair, split(["pair_write"]));
  assert.ok(denied);
  assert.equal(
    openClawToolDenialMessage(denied),
    "Configuration settings tools.deny and agents.entries.main.tools.deny block every tool of plugin occ-plugin:pair; remove the matching deny entries or deselect the plugin.",
  );
});

test("OpenClaw Plugin Driver refuses a selection the primary model's tools.byProvider deny lists block", () => {
  const driver = new OCCPluginDriver();
  const plugins = occSelection();
  const check = (configuration: OpenClawConfigurationDocument) => () =>
    driver.validateAgentConfiguration(plugins, configuration);
  const model = (
    primary: OpenClawConfigurationValue,
    rest: OpenClawConfigurationDocument = {},
  ) => ({ agents: { defaults: { model: primary } }, ...rest });
  // OpenClaw applies the byProvider policy of the running model as its own deny-wins step
  // (finding 1855). Every Agent shares the primary model, so admission resolves its provider
  // from there. The refusal names the key as written, quoted when it is not a plain ID.
  for (const [primary, key, deny, path] of [
    ["openai/gpt-5.1", "openai", ["*"], ".openai"],
    [{ primary: "OpenAI/GPT-5.1" }, " OPENAI ", ["group:plugins"], '[" OPENAI "]'],
    ["openai/gpt-5.1", "openai/", ["diffs"], '["openai/"]'],
    [" openrouter:auto ", "openrouter", ["dif*"], ".openrouter"],
  ] as const) {
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
  const entry = (
    tools: OpenClawConfigurationDocument,
    entryModel?: string,
  ): OpenClawConfigurationDocument => ({
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
  const roster = (ops: readonly string[]) => ({
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
  const denied = deniedOpenClawSelection(pairCatalog, pair, together);
  assert.ok(denied);
  assert.equal(
    openClawToolDenialMessage(denied),
    "Configuration settings tools.deny and agents.entries.main.tools.byProvider.OpenAI.deny block every tool of plugin occ-plugin:pair; remove the matching deny entries or deselect the plugin.",
  );
  // When the top-level lists already block every tool together, an entry list is not named.
  together.tools.byProvider.openai.deny = ["pair_write"];
  together.agents.entries.main.tools.byProvider.OpenAI.deny = ["pair_read"];
  const topLevelDenial = deniedOpenClawSelection(pairCatalog, pair, together);
  assert.ok(topLevelDenial && topLevelDenial.kind === "deny");
  assert.deepEqual(topLevelDenial.lists, [{}, { provider: "openai" }]);
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
  const denyMessage = (entry: string) =>
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
  const check = (configuration: OpenClawConfigurationDocument) => () =>
    driver.validateAgentConfiguration(plugins, configuration);
  // The translator grants the plugin through top-level tools.alsoAllow. Under a profile that
  // lists core tools only, an entry's own alsoAllow replaces it at the profile step, so no
  // turn sees the plugin (finding 1857).
  const entry = (
    tools: OpenClawConfigurationDocument,
    top: OpenClawConfigurationDocument = {},
  ) => ({ tools: top, agents: { entries: { main: { tools } } } });
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
  const restricted = (deny: readonly string[]) => ({
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
  const denied = deniedOpenClawSelection(pairCatalog, pair, restricted(["pair_read"]));
  assert.ok(denied);
  assert.equal(
    openClawToolDenialMessage(denied),
    "Configuration settings agents.entries.main.tools.alsoAllow and tools.byProvider.openai.deny together hide every tool of plugin occ-plugin:pair; name its tools in alsoAllow, remove the deny entries, or deselect the plugin.",
  );
  // The sole entry's own deny lists apply too.
  const ownDeny = (deny: readonly string[]) => ({
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
