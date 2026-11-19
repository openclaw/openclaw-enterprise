import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Check } from "typebox/value";
import type { ControllerApp } from "../../apps/controller/src/index.ts";
import {
  JsonValue,
  PresetResponse,
  validatePresetTemplate,
  type Configuration,
  type ConfigurationDriver,
  type OpenClawConfigurationDocument,
  type PresetDraftTemplate,
  type PresetVariable,
  type renderPresetTemplate,
} from "../../packages/contracts/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  configIncludeRefusal,
  pluginEntryKeyVariantRefusal,
  pluginPolicyListRefusal,
  providerKeyVariantRefusal,
} from "../helpers/refusal-text.mjs";

export { registerConfigurationModelPolicyCases } from "./configuration-model-policy-cases.ts";

interface HttpResponse {
  status: number;
  body: unknown;
}

interface ConfigurationStore extends Pick<ConfigurationDriver, "update"> {
  storedConfigurations(): Configuration[];
}

interface StoredConfigurationContext {
  app: ControllerApp;
  collection: string;
  presets: string;
  configurationDriver: ConfigurationStore;
}

interface StoredConfigurationAgent {
  configurationDriver: ConfigurationStore;
  configurationId: string;
  created: HttpResponse;
  item: string;
  agentPath: string;
  valid: OpenClawConfigurationDocument;
}

type EntryMap = Readonly<Record<string, OpenClawConfigurationDocument>>;
type KeyVariant = readonly [entries: EntryMap, path: string, canonicalKey: string];
type PresetInputs = NonNullable<Parameters<typeof renderPresetTemplate>[1]>;
type PresetKeyVariant = readonly [
  key: string,
  refused: readonly [inputs: PresetInputs, path: string, canonicalKey: string] | undefined,
  accepted: PresetInputs,
];
type PresetConfigurationDraft = PresetDraftTemplate & {
  configuration: { values: OpenClawConfigurationDocument };
};

interface StoredConfigurationFixtures {
  runtimeSelected: OpenClawConfigurationDocument;
  storedConfigurationFixture(
    computeId: string,
    options: { name: string; secretName: string },
  ): Promise<{ context: StoredConfigurationContext; agent: StoredConfigurationAgent }>;
  writePastOcc(
    store: ConfigurationStore,
    configurationId: string,
    values: OpenClawConfigurationDocument,
  ): Promise<void>;
  refusedAtAgentSave(
    context: StoredConfigurationContext,
    agent: StoredConfigurationAgent,
    values: OpenClawConfigurationDocument,
    message: string,
    label?: string,
  ): Promise<void>;
  updateSaved(
    context: StoredConfigurationContext,
    item: string,
    values: OpenClawConfigurationDocument,
  ): Promise<HttpResponse>;
  deployAccepted(context: StoredConfigurationContext, agentPath: string): Promise<HttpResponse>;
  launchPreset(
    context: StoredConfigurationContext,
    template: PresetDraftTemplate,
    inputs: PresetInputs,
  ): Promise<HttpResponse>;
  savePreset(
    context: StoredConfigurationContext,
    template: PresetConfigurationDraft,
    name?: string,
  ): Promise<HttpResponse>;
  assertRefused(response: HttpResponse, message: string, options?: { label?: string }): void;
  refusedOnSave(
    context: StoredConfigurationContext,
    values: OpenClawConfigurationDocument,
    message: string,
    options?: { sentinel?: string },
  ): Promise<void>;
  acceptedOnSave(
    context: StoredConfigurationContext,
    values: OpenClawConfigurationDocument,
  ): Promise<HttpResponse>;
  refusedAtSaveAndDeploy(
    context: StoredConfigurationContext,
    agent: StoredConfigurationAgent,
    values: OpenClawConfigurationDocument,
    message: string,
  ): Promise<void>;
}

const schemaContext = { SafeJsonValue: JsonValue };

function savedPreset(response: HttpResponse, label?: string): PresetDraftTemplate {
  const details = JSON.stringify(response.body);
  assert.equal(response.status, 201, label === undefined ? details : `${label}: ${details}`);
  assert.ok(Check(schemaContext, PresetResponse, response.body));
  return validatePresetTemplate(response.body.data.template);
}

export function registerConfigurationStoredCompatibilityCases(
  fixtures: StoredConfigurationFixtures,
): void {
  const {
    runtimeSelected,
    storedConfigurationFixture,
    writePastOcc,
    refusedAtAgentSave,
    updateSaved,
    deployAccepted,
    launchPreset,
    savePreset,
    assertRefused,
    refusedOnSave,
    acceptedOnSave,
    refusedAtSaveAndDeploy,
  } = fixtures;

  test("Configuration save and deployment refuse another spelling of the codex or acpx plugin entry key", async () => {
    // Finding 3073. The pinned OpenClaw merges plugins.entries keys that match trimmed and
    // lowercased, and the last entry with a `config` replaces the plugin's whole config. OCE checks
    // codex and acpx settings, and Compute renders codex settings, only at the exact key, so a later
    // `Codex` entry would replace what OCE checked: every save path, Agent save and deployment
    // refuse such a key, whatever it holds.
    const { context, agent } = await storedConfigurationFixture("compute-plugin-key-integration", {
      name: "Plugin entry key consumer",
      secretName: "plugin-key",
    });
    const { configurationDriver } = context;
    const sentinel = `synthetic-url-userinfo-${randomUUID()}`;
    const proxy = syntheticCredentialUrl({
      protocol: "http",
      username: "u",
      password: sentinel,
      host: "proxy.example",
      port: 3128,
    });
    const codex = { config: { appServer: { approvalPolicy: "on-request" } } };
    const withEntries = (entries: EntryMap) => ({ ...runtimeSelected, plugins: { entries } });
    // Each variant holds a value OCE refuses at the exact key: a retired approval policy, a proxy
    // URL with userinfo, an MCP server environment proxy with userinfo.
    const variants: KeyVariant[] = [
      [
        { codex, Codex: { config: { appServer: { approvalPolicy: "untrusted" } } } },
        "plugins.entries.Codex",
        "codex",
      ],
      [
        { " codex": { config: { appServer: { networkProxy: { proxyUrl: proxy } } } } },
        'plugins.entries[" codex"]',
        "codex",
      ],
      [
        {
          acpx: { config: {} },
          ACPX: {
            config: { mcpServers: { docs: { command: "docs-mcp", env: { HTTPS_PROXY: proxy } } } },
          },
        },
        "plugins.entries.ACPX",
        "acpx",
      ],
      // Kubernetes Compute enables file-transfer for a workspace node and renders the managed diffs
      // plugin at the exact key, so its rules refuse their other spellings too (finding 3077).
      [
        { "file-transfer": {}, "File-Transfer": { enabled: false } },
        "plugins.entries.File-Transfer",
        "file-transfer",
      ],
      [{ diffs: { enabled: true }, Diffs: { config: {} } }, "plugins.entries.Diffs", "diffs"],
    ];
    for (const [entries, path, id] of variants) {
      const values = withEntries(entries);
      const message = pluginEntryKeyVariantRefusal(path, id);
      await refusedAtSaveAndDeploy(context, agent, values, message);
      await refusedOnSave(context, values, message, { sentinel });
    }
    // Agent save refuses a stored row the same way, before any deployment.
    await refusedAtAgentSave(
      context,
      agent,
      withEntries({ codex, CODEX: { config: {} } }),
      pluginEntryKeyVariantRefusal("plugins.entries.CODEX", "codex"),
    );
    // An update that renames the key recovers the stored row: a PATCH replaces all values.
    const exact = withEntries({ codex, acpx: { config: {} } });
    await updateSaved(context, agent.item, exact);
    // Beside an exact entry, the refusal's step moves the variant's settings into it and removes the
    // variant, in either key order, and that update saves with both entries' settings. Renaming it
    // instead would leave a duplicate key, whose last copy JSON keeps, losing one entry's settings
    // without notice (finding 3087).
    const bothKeyOrders = [
      { codex, Codex: { enabled: true } },
      { Codex: { enabled: true }, codex },
    ];
    for (const entries of bothKeyOrders) {
      await refusedAtAgentSave(
        context,
        agent,
        withEntries(entries),
        pluginEntryKeyVariantRefusal("plugins.entries.Codex", "codex"),
        Object.keys(entries).join(" before "),
      );
      const { Codex: variant, codex: canonical } = entries;
      const followed = withEntries({ codex: { ...canonical, ...variant } });
      assert.deepEqual(followed.plugins.entries, { codex: { ...codex, enabled: true } });
      await updateSaved(context, agent.item, followed);
    }
    await writePastOcc(configurationDriver, agent.configurationId, exact);
    // The exact keys deploy, and other plugins' keys in another spelling still save (finding 3072).
    await deployAccepted(context, agent.agentPath);
    await acceptedOnSave(
      context,
      withEntries({ ...exact.plugins.entries, Google: { enabled: false } }),
    );
    // On Kubernetes, the same update recovers a stored file-transfer variant.
    await writePastOcc(
      configurationDriver,
      agent.configurationId,
      withEntries({ "File-Transfer": {} }),
    );
    await updateSaved(context, agent.item, withEntries({ "file-transfer": {} }));
    // A Preset key that waits on a variable saves, as each canSpell rule decides: a launch can still
    // fill it with a key that names no such plugin, such as Codex-helper. The Configuration a launch
    // creates is checked with the filled key, and a filling that spells another key gets the same
    // refusal there. co{{ vars.suffix }}dex can spell only the exact codex key. A launch renders
    // the template the Preset save returned, as the Console does.
    const variables = {
      suffix: { type: "string" },
      a: { type: "string" },
      b: { type: "string" },
    } satisfies Record<string, PresetVariable>;
    const variantsAtLaunch: PresetKeyVariant[] = [
      [
        "Codex{{ vars.suffix }}",
        [{ suffix: "" }, "plugins.entries.Codex", "codex"],
        { suffix: "-helper" },
      ],
      [
        "{{ vars.a }}-{{ vars.b }}",
        [{ a: "File", b: "Transfer" }, "plugins.entries.File-Transfer", "file-transfer"],
        { a: "my", b: "plugin" },
      ],
      ["co{{ vars.suffix }}dex", undefined, { suffix: "" }],
      ["{{ vars.suffix }}", undefined, { suffix: "slack" }],
      ["codex-{{ vars.suffix }}", undefined, { suffix: "helper" }],
    ];
    for (const [index, [key, refused, accepted]] of variantsAtLaunch.entries()) {
      const preset = await savePreset(
        context,
        { variables, configuration: { values: withEntries({ [key]: {} }) } },
        `Variant-waits-${index}`,
      );
      const saved = savedPreset(preset, key);
      if (refused !== undefined) {
        const [inputs, path, id] = refused;
        assertRefused(
          await launchPreset(context, saved, inputs),
          pluginEntryKeyVariantRefusal(path, id),
          { label: key },
        );
      }
      const launched = await launchPreset(context, saved, accepted);
      assert.equal(launched.status, 201, `${key}: ${JSON.stringify(launched.body)}`);
    }
  });

  test("Configuration save and deployment refuse a model provider key OpenClaw applies to another key", async () => {
    // Finding 3097. The pinned OpenClaw trims models.providers keys and merges entries whose trimmed
    // keys are equal, the later entry's fields winning, and for a provider with no exactly matching
    // key it uses an entry whose key matches without case. OCE's rules and the startup model probe
    // read the exact key, so ` openai` beside `openai` would move the Gateway's model calls, with
    // the Agent's credential, to an endpoint the probe never checked (PostgreSQL's jsonb key order
    // puts the longer key last, so it wins there), and `OpenAI` alone would do the same while the
    // probe checks the default endpoint. Every save path, Agent save and deployment refuse such a
    // key, whatever its entry holds.
    const { context, agent } = await storedConfigurationFixture(
      "compute-provider-key-integration",
      {
        name: "Model provider key consumer",
        secretName: "provider-key",
      },
    );
    const { configurationDriver } = context;
    const checked = { baseUrl: "https://api.openai.com/v1" };
    const elsewhere = { baseUrl: "https://models.example/v1" };
    const withProviders = (providers: EntryMap) => ({ ...runtimeSelected, models: { providers } });
    const variants: KeyVariant[] = [
      [{ openai: checked, " openai": elsewhere }, 'models.providers[" openai"]', "openai"],
      [{ "openai ": elsewhere, openai: checked }, 'models.providers["openai "]', "openai"],
      // Alone, too: OpenClaw uses it for openai models, while the probe checks the default endpoint.
      [{ OpenAI: elsewhere }, "models.providers.OpenAI", "openai"],
      [{ openai: checked, " Anthropic ": {} }, 'models.providers[" Anthropic "]', "anthropic"],
      [{ Codex: elsewhere }, "models.providers.Codex", "codex"],
      // A custom provider's padded key merges into its entry as well.
      [
        { local: { ...elsewhere, models: [] }, "local\t": { baseUrl: "https://other.example/v1" } },
        'models.providers["local?"]',
        "local",
      ],
    ];
    for (const [providers, path, name] of variants) {
      const values = withProviders(providers);
      const message = providerKeyVariantRefusal(path, name);
      await refusedAtSaveAndDeploy(context, agent, values, message);
      await refusedOnSave(context, values, message);
    }
    // Agent save refuses a stored row the same way, before any deployment.
    await refusedAtAgentSave(
      context,
      agent,
      withProviders({ openai: checked, "openai ": elsewhere }),
      providerKeyVariantRefusal('models.providers["openai "]', "openai"),
    );
    // The exact keys deploy. A custom provider may still use a mixed-case key or a space inside it,
    // which OpenClaw reads as written.
    const exact = withProviders({ openai: checked, anthropic: {} });
    await writePastOcc(configurationDriver, agent.configurationId, exact);
    await deployAccepted(context, agent.agentPath);
    await acceptedOnSave(
      context,
      withProviders({
        ...exact.models.providers,
        MyGateway: { ...elsewhere, models: [] },
        "my gateway": { ...elsewhere, models: [] },
      }),
    );
  });

  test("Configuration save and deployment refuse OpenClaw's $include directive", async () => {
    // Finding 3078. The pinned OpenClaw replaces an object holding $include with the named files'
    // settings, merged under its other keys with arrays concatenated, and re-reads them when they
    // change. Configuration rules and Compute read the document as written, so an include would add
    // settings no rule checked, such as a gateway.auth.mode Kubernetes Compute refuses, from a file
    // in the Gateway's config directory. Every save path, Agent save and deployment refuse it at any
    // depth; configuration-occ.test.ts proves the paths the refusal names.
    const { context, agent } = await storedConfigurationFixture("compute-include-integration", {
      name: "Config include consumer",
      secretName: "config-include",
    });
    const includes: [OpenClawConfigurationDocument, string][] = [
      [{ $include: "./extra.json", ...runtimeSelected }, "$include"],
      [
        { ...runtimeSelected, gateway: { auth: { $include: "./auth.json" } } },
        "gateway.auth.$include",
      ],
    ];
    for (const [values, path] of includes) {
      const message = configIncludeRefusal(path);
      await refusedAtSaveAndDeploy(context, agent, values, message);
      await refusedOnSave(context, values, message);
    }
    // Agent save refuses a stored row the same way, before any deployment.
    await refusedAtAgentSave(
      context,
      agent,
      { ...runtimeSelected, tools: { $include: "./tools.json" } },
      configIncludeRefusal("tools.$include"),
    );
    // An update that removes the directive recovers the stored row, and the same Agent deploys.
    await updateSaved(context, agent.item, runtimeSelected);
    await deployAccepted(context, agent.agentPath);
    // A Preset key that waits on a variable saves: a launch can still fill it with another key. The
    // Configuration a launch creates is checked with the filled key, and a filling that spells
    // $include gets the same refusal there. A launch renders the template the Preset save
    // returned, as the Console does.
    const variables = { key: { type: "string" } } satisfies Record<string, PresetVariable>;
    const template = (key: string): PresetConfigurationDraft => ({
      variables,
      configuration: { values: { ...runtimeSelected, tools: { [key]: "x" } } },
    });
    const suffixedKey = "{{ vars.key }}e";
    const suffixed = savedPreset(
      await savePreset(context, template(suffixedKey), "Include-waits-0"),
      suffixedKey,
    );
    for (const [index, key] of ["$inc{{ vars.key }}", "{{ vars.key }}"].entries()) {
      const preset = await savePreset(context, template(key), `Include-waits-${index + 1}`);
      assert.equal(preset.status, 201, `${key}: ${JSON.stringify(preset.body)}`);
    }
    assertRefused(
      await launchPreset(context, suffixed, { key: "$includ" }),
      configIncludeRefusal("tools.$include"),
    );
    const launched = await launchPreset(context, suffixed, { key: "custom-rul" });
    assert.equal(launched.status, 201, JSON.stringify(launched.body));
  });

  test("Configuration save and deployment refuse a plugins.allow or plugins.deny OpenClaw's config schema refuses", async () => {
    // Finding 3101. The pinned OpenClaw's config schema takes plugins.allow and plugins.deny only as
    // lists of text, so the Gateway exits at every start on any other value, with or without
    // plugins. Where a plugin runtime applies an overlay (plugin approvers, a managed or catalog
    // plugin), the Gateway entrypoint crashes sooner, when it trims each item. Each of these saved
    // and deployed. Now every save path, Agent save and deployment refuse it, naming the setting.
    const { context, agent } = await storedConfigurationFixture("compute-plugin-policy-list", {
      name: "Plugin policy list consumer",
      secretName: "plugin-policy-list",
    });
    const withPlugins = (plugins: OpenClawConfigurationDocument) => ({
      ...runtimeSelected,
      plugins,
    });
    const invalidLists: [OpenClawConfigurationDocument, string][] = [
      [{ deny: ["discord", 7] }, pluginPolicyListRefusal("deny")],
      [{ allow: [null] }, pluginPolicyListRefusal("allow")],
      [{ allow: ["slack"], deny: [{ id: "discord" }] }, pluginPolicyListRefusal("deny")],
      [{ allow: "slack" }, pluginPolicyListRefusal("allow", false)],
      [{ deny: null }, pluginPolicyListRefusal("deny", false)],
    ];
    for (const [plugins, message] of invalidLists) {
      const values = withPlugins(plugins);
      await refusedAtSaveAndDeploy(context, agent, values, message);
      await refusedOnSave(context, values, message);
    }
    // Agent save refuses a stored row the same way, before any deployment.
    await refusedAtAgentSave(
      context,
      agent,
      withPlugins({ deny: [false] }),
      pluginPolicyListRefusal("deny"),
    );
    // Lists of text start, blank items and empty lists included; such an update recovers the row.
    await updateSaved(context, agent.item, withPlugins({ allow: [], deny: [" ", "Discord"] }));
    await deployAccepted(context, agent.agentPath);
    // On a Preset, a whole number variable can never fill text, so the Preset save refuses it; a
    // text variable saves, and the launch's Configuration is checked with the filled item.
    const variables = {
      name: { type: "string" },
      count: { type: "number" },
    } satisfies Record<string, PresetVariable>;
    const template = (item: string): PresetConfigurationDraft => ({
      variables,
      configuration: { values: withPlugins({ deny: ["discord", item] }) },
    });
    assertRefused(
      await savePreset(context, template("{{ vars.count }}")),
      pluginPolicyListRefusal("deny"),
    );
    const preset = await savePreset(context, template("{{ vars.name }}"), "Plugin-list-waits");
    const launched = await launchPreset(context, savedPreset(preset), {
      name: "slack",
      count: 1,
    });
    assert.equal(launched.status, 201, JSON.stringify(launched.body));
  });
}
