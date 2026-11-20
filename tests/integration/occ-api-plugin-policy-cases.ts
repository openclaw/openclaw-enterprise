import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  AgentListResponse,
  AgentReadResponse,
  AgentResponse,
  AgentRevisionListResponse,
  AgentRevisionResponse,
  ErrorResponse,
  InstallationResponse,
  type AgentWire,
  type CreateAgentBody,
  type CreateConfigurationBody,
  type ErrorCode,
  type OpenClawConfigurationDocument,
  type PluginDesiredSelection,
  type PluginDesiredState,
  type PluginDriver,
  type UpdateAgentBody,
} from "../../packages/contracts/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { pluginPolicyListRefusal } from "../helpers/refusal-text.mjs";
import { managedPluginSettingRefusal } from "../helpers/refusal-configuration-runtime.ts";
import {
  bindHarnessKey,
  bootstrapInstallation,
  checkedInjectedBody,
  createConfiguration,
  createInjectedControllerFixture,
  createNamespace,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type Controller = {
  fixture: Awaited<ReturnType<typeof createInjectedControllerFixture>>;
  request: FixtureRequest;
};
type ConfiguredController = (options?: {
  configurationDriver?: ConfigurationDriver;
}) => Promise<Controller>;
type Reply = Awaited<ReturnType<FixtureRequest>>;
type ConfigurationDriver = ReturnType<typeof createTestConfigurationDriver>;
type AgentCreate = Omit<CreateAgentBody, "plugins"> & { plugins?: PluginDesiredState };
type AgentUpdate = Omit<UpdateAgentBody, "plugins"> & { plugins?: PluginDesiredState };
type ApprovalPolicy = "never" | "on-request" | "on-failure";

const diffsPluginId = "occ-plugin:diffs";
const linearPluginId = "codex-plugin:linear@openai-curated-remote";
const diffsSelection = {
  [diffsPluginId]: { enabled: true, toolDefaults: { approval: "none" } },
} satisfies PluginDesiredState;

function selectPluginDriver({ fixture }: Controller, pluginDriver: PluginDriver) {
  assert(fixture.controller, "bootstrap must create the controller");
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
}

function apiError(reply: Reply, status: number, code: ErrorCode, label?: string) {
  const { error } = checkedInjectedBody(reply, status, ErrorResponse);
  assert.equal(error.code, code, `${label ?? "API error"}: ${JSON.stringify(reply.body)}`);
  return error;
}

function readAgent(reply: Reply) {
  const { data } = checkedInjectedBody(reply, 200, AgentReadResponse);
  assert(!("configurationReadError" in data), JSON.stringify(data));
  return data;
}

function savedConfiguration(driver: ConfigurationDriver, namespaceId: string, id: string) {
  const stored = driver.stored({ namespaceId, id });
  assert(stored, "Agent must have a saved Configuration");
  return stored;
}

async function readRevisions({ request }: Controller, agentPath: string) {
  return checkedInjectedBody(
    await request("GET", `${agentPath}/revisions`),
    200,
    AgentRevisionListResponse,
  ).data;
}

function codexConfiguration(approvalPolicy?: ApprovalPolicy): OpenClawConfigurationDocument {
  const configuration = createHarnessConfiguration("codex", "gpt-5.4");
  const { plugins } = configuration;
  assert(plugins, "the Codex fixture must include its native plugin transport");
  const { appServer } = plugins.entries.codex.config;
  const { approvalPolicy: _defaultPolicy, ...transport } = appServer;
  return {
    ...configuration,
    plugins: {
      ...plugins,
      entries: {
        codex: {
          ...plugins.entries.codex,
          config: {
            ...plugins.entries.codex.config,
            appServer: {
              ...transport,
              ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
            },
          },
        },
      },
    },
  };
}

export function registerCodexPluginPolicyCases(configuredController: ConfiguredController): void {
  test("Agent plugin reviewer selection preserves omission and rejects unsupported tool scope", async () => {
    const controller = await configuredController();
    await bootstrapInstallation(controller);
    const namespace = await createNamespace(controller, "plugin-reviewer-api");
    // The automatic reviewer below needs an explicit on-request session policy at save.
    const configuration = await createConfiguration(controller, namespace.id, {
      ...createHarnessConfiguration("codex", "gpt-5.4"),
      plugins: { entries: { codex: { config: { appServer: { approvalPolicy: "on-request" } } } } },
    });
    const pluginDriver = new CodexPluginDriver();
    selectPluginDriver(controller, pluginDriver);
    const installation = await controller.request("GET", "/installation");
    const { data: installed } = checkedInjectedBody(installation, 200, InstallationResponse);
    const catalog = installed.capabilities?.pluginCatalogs?.[0];
    assert(catalog, "the selected Plugin Driver must publish its policy capabilities");
    const capabilities = catalog.pluginPolicies;
    assert.equal(capabilities.driver.id, "codex-plugin");
    assert.deepEqual(capabilities.toolDefaults.reviewer, ["human", "auto"]);
    assert.deepEqual(capabilities.tools.reviewer, []);
    const properties = capabilities.driverPolicySchema.properties;
    assert(properties && typeof properties === "object" && !Array.isArray(properties));
    assert.equal(Object.hasOwn(properties, "approvalsReviewer"), false);

    const plugins = {
      [linearPluginId]: { enabled: true, toolDefaults: { reviewer: "auto" } },
    } satisfies PluginDesiredState;
    const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "reviewer-agent",
        executionMode: "dedicated",
        configurationId: configuration.id,
        plugins,
      } satisfies AgentCreate,
    });
    const { data: agent } = checkedInjectedBody(created, 201, AgentResponse);
    assert.deepEqual(agent.plugins, plugins);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const saved = await controller.request("GET", path);
    assert.deepEqual(readAgent(saved).plugins, plugins);
    const omitted = await controller.request("PATCH", path, {
      body: { configurationId: configuration.id } satisfies AgentUpdate,
    });
    assert.deepEqual(checkedInjectedBody(omitted, 200, AgentResponse).data.plugins, plugins);

    // A tool reviewer must not silently become an app reviewer, even when redundant or disabled.
    for (const policy of [
      {
        enabled: true,
        toolDefaults: { reviewer: "auto" },
        tools: { "app/search": { reviewer: "auto" } },
      },
      { enabled: true, tools: { "app/search": { enabled: false, reviewer: "human" } } },
      { enabled: false, tools: { "app/search": { reviewer: "auto" } } },
    ] satisfies PluginDesiredSelection[]) {
      const rejected = await controller.request("PATCH", path, {
        body: {
          configurationId: configuration.id,
          plugins: { [linearPluginId]: policy },
        } satisfies AgentUpdate,
      });
      assert.equal(
        apiError(rejected, 400, "INVALID_REQUEST").message,
        "This Plugin Driver does not support tools[id].reviewer. Use toolDefaults.reviewer when supported, or omit the reviewer.",
      );
    }
    assert.deepEqual(readAgent(await controller.request("GET", path)).plugins, plugins);

    // Replacing the policy removes the explicit reviewer without writing a replacement default.
    const inherited = { [linearPluginId]: { enabled: true } } satisfies PluginDesiredState;
    const replaced = await controller.request("PATCH", path, {
      body: { configurationId: configuration.id, plugins: inherited } satisfies AgentUpdate,
    });
    assert.deepEqual(checkedInjectedBody(replaced, 200, AgentResponse).data.plugins, inherited);
  });

  test("the Codex Plugin Driver refuses an automatic reviewer without an on-request session policy at save and deployment", async (t) => {
    const configurationDriver = createTestConfigurationDriver();
    const controller = await configuredController({ configurationDriver });
    await bootstrapInstallation(controller);
    const namespace = await createNamespace(controller, "codex-approval-policy-api");
    const setting = "plugins.entries.codex.config.appServer.approvalPolicy";
    // Configuration saves do not know the Agents' plugins, so an omitted or never policy saves.
    const omitted = await createConfiguration(controller, namespace.id, codexConfiguration());
    const never = await createConfiguration(controller, namespace.id, codexConfiguration("never"));
    const configuration = await createConfiguration(
      controller,
      namespace.id,
      codexConfiguration("on-request"),
    );
    const pluginDriver = new CodexPluginDriver();
    selectPluginDriver(controller, pluginDriver);
    const automatic = {
      [linearPluginId]: { enabled: true, toolDefaults: { reviewer: "auto" } },
    } satisfies PluginDesiredState;
    const assertRefused = (refused: Reply, fix: string, label: string) => {
      assert.equal(
        apiError(refused, 400, "INVALID_REQUEST", label).message,
        `An automatic plugin reviewer requires Configuration setting ${setting} "on-request"; ${fix} or choose the human reviewer.`,
      );
    };
    const refusals = [
      [omitted, "set it explicitly"],
      [never, "change it"],
    ] as const;
    // The Gateway can default to "never" when the policy is omitted. An Agent save sees both the
    // plugins and the Configuration it names, so it can refuse the pair before deployment.
    for (const [named, fix] of refusals) {
      const refused = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
        body: {
          name: "approval-policy-agent",
          executionMode: "dedicated",
          configurationId: named.id,
          plugins: automatic,
        } satisfies AgentCreate,
      });
      assertRefused(refused, fix, `create with ${fix}`);
    }
    // One automatic reviewer among human ones is enough to need the policy.
    const mixed = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "approval-policy-agent",
        executionMode: "dedicated",
        configurationId: omitted.id,
        plugins: {
          "codex-plugin:github@openai-curated-remote": {
            enabled: true,
            toolDefaults: { reviewer: "human" },
          },
          ...automatic,
        },
      } satisfies AgentCreate,
    });
    assertRefused(mixed, "set it explicitly", "create with mixed reviewers");
    const listed = await controller.request("GET", `/namespaces/${namespace.id}/agents`);
    assert.deepEqual(checkedInjectedBody(listed, 200, AgentListResponse).data, []);
    const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "approval-policy-agent",
        executionMode: "dedicated",
        configurationId: configuration.id,
        plugins: automatic,
      } satisfies AgentCreate,
    });
    const { data: agent } = checkedInjectedBody(created, 201, AgentResponse);
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    // An update is checked with the plugins it leaves in place as well as the ones it sends.
    for (const [named, fix] of refusals) {
      for (const body of [
        { configurationId: named.id },
        { configurationId: named.id, plugins: automatic },
      ] satisfies AgentUpdate[]) {
        const refused = await controller.request("PATCH", agentPath, { body });
        assertRefused(refused, fix, `update ${JSON.stringify(body)}`);
      }
    }
    const unchanged = readAgent(await controller.request("GET", agentPath));
    assert.equal(unchanged.configurationId, configuration.id);
    assert.deepEqual(unchanged.plugins, automatic);
    // Any other Plugin Driver refusal gets fixed text: its message may describe Configuration
    // values the caller does not own.
    const validation = t.mock.method(pluginDriver, "validateAgentConfiguration", () => {
      throw new Error("synthetic Driver detail");
    });
    let conflict: Reply;
    try {
      conflict = await controller.request("PATCH", agentPath, {
        body: { configurationId: configuration.id } satisfies AgentUpdate,
      });
    } finally {
      validation.mock.restore();
    }
    assert.equal(
      apiError(conflict, 409, "RESOURCE_CONFLICT").message,
      "The selected Plugin Driver cannot run these plugin selections with this Configuration.",
    );
    // Clearing the plugins leaves nothing to check against that Configuration.
    const cleared = await controller.request("PATCH", agentPath, {
      body: { configurationId: omitted.id, plugins: {} } satisfies AgentUpdate,
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    const restored = await controller.request("PATCH", agentPath, {
      body: { configurationId: configuration.id, plugins: automatic } satisfies AgentUpdate,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    await controller.fixture.markNamespaceReady(namespace.id);
    await bindHarnessKey(controller.fixture, namespace.id, agent);
    const store = async (approvalPolicy?: ApprovalPolicy) => {
      const stored = savedConfiguration(configurationDriver, namespace.id, configuration.id);
      await configurationDriver.update({ ...stored, values: codexConfiguration(approvalPolicy) });
    };
    const deploy = () => controller.request("POST", `${agentPath}/deploy`);
    // A later Configuration save can still drop the policy under a saved Agent, so deployment
    // checks the admitted pair again.
    for (const [approvalPolicy, fix] of [
      [undefined, "set it explicitly"],
      ["never", "change it"],
    ] as const) {
      await store(approvalPolicy);
      assertRefused(await deploy(), fix, `deploy with ${approvalPolicy}`);
      assert.equal((await readRevisions(controller, agentPath)).length, 0);
    }
    // The Gateway runs on-failure as on-request; Compute renders on-request for both.
    for (const approvalPolicy of ["on-request", "on-failure"] as const) {
      await store(approvalPolicy);
      const deployed = await deploy();
      checkedInjectedBody(deployed, 202, AgentRevisionResponse);
    }
    // Without an enabled automatic reviewer the native default stays, and nothing is required.
    await store(undefined);
    for (const plugins of [
      { [linearPluginId]: { enabled: true, toolDefaults: { reviewer: "human" } } },
      { [linearPluginId]: { enabled: false, toolDefaults: { reviewer: "auto" } } },
    ] satisfies PluginDesiredState[]) {
      const updated = await controller.request("PATCH", agentPath, {
        body: { configurationId: configuration.id, plugins } satisfies AgentUpdate,
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      const deployed = await deploy();
      checkedInjectedBody(deployed, 202, AgentRevisionResponse);
    }
  });
}

export function registerOpenClawPluginPolicyCases(
  configuredController: ConfiguredController,
): void {
  test("the OpenClaw Plugin Driver refuses a selection whose every tool the Configuration denies at save and deployment", async () => {
    const configurationDriver = createTestConfigurationDriver();
    const controller = await configuredController({ configurationDriver });
    await bootstrapInstallation(controller);
    const namespace = await createNamespace(controller, "openclaw-plugin-tool-deny");
    // Configuration saves do not know the Agents' plugins, so a deny-all list saves.
    const denials = [["*"], [" DIFFS "], ["group:plugins"], ["dif*"], ["exec", "*"]];
    const denying: Awaited<ReturnType<typeof createConfiguration>>[] = [];
    for (const deny of denials) {
      denying.push(await createConfiguration(controller, namespace.id, { tools: { deny } }));
    }
    const allowed = { tools: { deny: ["exec", "diffs-*", 7] } };
    const configuration = await createConfiguration(controller, namespace.id, allowed);
    const pluginDriver = new OCCPluginDriver();
    selectPluginDriver(controller, pluginDriver);
    const plugins = diffsSelection;
    const assertRefused = (refused: Reply, label: string) => {
      assert.equal(
        apiError(refused, 400, "INVALID_REQUEST", label).message,
        `Configuration setting tools.deny blocks every tool of plugin ${diffsPluginId}; remove the matching deny entry or deselect the plugin.`,
      );
    };
    // Even when translation puts the selected plugin on the tool allowlist, a matching denial
    // can leave it with zero callable tools. Agent save refuses that combination.
    for (const [index, named] of denying.entries()) {
      const refused = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
        body: { name: "tool-deny-agent", configurationId: named.id, plugins } satisfies AgentCreate,
      });
      assertRefused(refused, `create with ${JSON.stringify(denials[index])}`);
    }
    // Every session runs as a sole roster entry, so its tools.deny counts too (finding 1848).
    const entryDenying = await createConfiguration(controller, namespace.id, {
      agents: {
        ...createHarnessConfiguration("openclaw", "gpt-5.1").agents,
        entries: { main: { tools: { deny: ["*"] } } },
      },
    });
    const refusedEntry = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "tool-deny-agent",
        configurationId: entryDenying.id,
        plugins,
      } satisfies AgentCreate,
    });
    assert.equal(
      apiError(refusedEntry, 400, "INVALID_REQUEST").message,
      `Configuration setting agents.entries.main.tools.deny blocks every tool of plugin ${diffsPluginId}; remove the matching deny entry or deselect the plugin.`,
    );
    // The primary model's tools.byProvider deny list is its own deny step (finding 1855).
    const providerDenying = await createConfiguration(controller, namespace.id, {
      ...createHarnessConfiguration("openclaw", "gpt-5.1"),
      tools: { byProvider: { openai: { deny: ["*"] } } },
    });
    const refusedProvider = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "tool-deny-agent",
        configurationId: providerDenying.id,
        plugins,
      } satisfies AgentCreate,
    });
    assert.equal(
      apiError(refusedProvider, 400, "INVALID_REQUEST").message,
      `Configuration setting tools.byProvider.openai.deny blocks every tool of plugin ${diffsPluginId}; remove the matching deny entry or deselect the plugin.`,
    );
    const listed = await controller.request("GET", `/namespaces/${namespace.id}/agents`);
    assert.deepEqual(checkedInjectedBody(listed, 200, AgentListResponse).data, []);
    const [denyAll] = denying;
    assert(denyAll, "the first Configuration denies every tool");
    // A disabled selection adds nothing to the allowlist, so it can stay denied.
    const disabled = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "tool-deny-disabled",
        configurationId: denyAll.id,
        plugins: { [diffsPluginId]: { enabled: false } },
      } satisfies AgentCreate,
    });
    assert.equal(disabled.status, 201, JSON.stringify(disabled.body));
    const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "tool-deny-agent",
        configurationId: configuration.id,
        plugins,
      } satisfies AgentCreate,
    });
    const { data: agent } = checkedInjectedBody(created, 201, AgentResponse);
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    // An update is checked with the plugins it leaves in place as well as the ones it sends.
    for (const body of [
      { configurationId: denyAll.id },
      { configurationId: denyAll.id, plugins },
    ] satisfies AgentUpdate[]) {
      const refused = await controller.request("PATCH", agentPath, { body });
      assertRefused(refused, `update ${JSON.stringify(body)}`);
    }
    const unchanged = readAgent(await controller.request("GET", agentPath));
    assert.equal(unchanged.configurationId, configuration.id);
    assert.deepEqual(unchanged.plugins, plugins);
    await controller.fixture.markNamespaceReady(namespace.id);
    await bindHarnessKey(controller.fixture, namespace.id, agent);
    const store = async (values: OpenClawConfigurationDocument) => {
      const stored = savedConfiguration(configurationDriver, namespace.id, configuration.id);
      await configurationDriver.update({ ...stored, values });
    };
    const deploy = () => controller.request("POST", `${agentPath}/deploy`);
    // A later Configuration save can still deny every tool under a saved Agent, so deployment
    // checks the admitted pair again and creates no revision.
    await store({ tools: { deny: ["*"] } });
    assertRefused(await deploy(), "deploy with a deny-all list");
    assert.equal((await readRevisions(controller, agentPath)).length, 0);
    await store(allowed);
    const deployed = await deploy();
    checkedInjectedBody(deployed, 202, AgentRevisionResponse);
  });

  test("the OpenClaw Plugin Driver refuses Configuration plugin settings the Gateway refuses for a selected plugin, at save and deployment", async () => {
    const configurationDriver = createTestConfigurationDriver();
    const controller = await configuredController({ configurationDriver });
    await bootstrapInstallation(controller);
    const namespace = await createNamespace(controller, "openclaw-plugin-settings");
    const pluginDriver = new OCCPluginDriver();
    selectPluginDriver(controller, pluginDriver);
    const plugins = diffsSelection;
    const disabled = { [diffsPluginId]: { enabled: false } } satisfies PluginDesiredState;
    const step = {
      enabled: "remove it or deselect the plugin",
      deny: "remove that item or deselect the plugin",
      allow: "add it or deselect the plugin",
      entry: "OCE writes that entry from the selection; remove it or deselect the plugin",
      origin:
        "OCE writes that entry from the selection and gateway.publicOrigin; remove it or deselect the plugin",
    };
    const origin = "https://agent.example.com";
    const servedOrigin = { publicOrigin: origin, controlUi: { allowedOrigins: [origin] } };
    // These settings can prevent Gateway startup when the entrypoint writes the selected plugin.
    // Configuration save does not know the Agents' plugins, so each Configuration saves.
    const copy = (enabled: boolean) => `must be unset or ${JSON.stringify({ enabled })}`;
    const refusals: [
      settings: OpenClawConfigurationDocument,
      selection: PluginDesiredState,
      setting: string,
      rule: string,
      fix?: string,
      gateway?: OpenClawConfigurationDocument,
    ][] = [
      [{ enabled: false }, plugins, "plugins.enabled", "must not be false", step.enabled],
      // OpenClaw compares plugin IDs trimmed and lowercased.
      [{ deny: ["slack", " DIFFS "] }, plugins, "plugins.deny", "must not list diffs", step.deny],
      // The Standard Codex Presets and channel saves write a non-empty allowlist.
      [{ allow: ["codex"] }, plugins, "plugins.allow", "must list diffs", step.allow],
      [{ entries: { diffs: { config: {} } } }, plugins, "plugins.entries.diffs", copy(true)],
      [{ entries: { diffs: { enabled: false } } }, plugins, "plugins.entries.diffs", copy(true)],
      // A disabled selection still writes its entry, so another one conflicts there too.
      [{ entries: { diffs: { enabled: true } } }, disabled, "plugins.entries.diffs", copy(false)],
      // Where the Gateway can serve a public origin, the entrypoint writes the entry with the Diffs
      // viewer's config, and PostgreSQL stores a copy of it with its keys reordered: no copy matches.
      [
        { entries: { diffs: { enabled: true } } },
        plugins,
        "plugins.entries.diffs",
        "must be unset",
        step.origin,
        servedOrigin,
      ],
    ];
    for (const [
      index,
      [settings, selection, setting, rule, fix = step.entry, gateway],
    ] of refusals.entries()) {
      const configuration = await createConfiguration(controller, namespace.id, {
        plugins: settings,
        ...(gateway === undefined ? {} : { gateway }),
      });
      const refused = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
        body: {
          name: `plugin-settings-${index}`,
          configurationId: configuration.id,
          plugins: selection,
        } satisfies AgentCreate,
      });
      assert.equal(
        apiError(refused, 400, "INVALID_REQUEST", `create ${index}`).message,
        managedPluginSettingRefusal(setting, rule, diffsPluginId, fix),
      );
    }
    // The Gateway requires text in these lists even for a disabled selection, so Configuration
    // save refuses invalid items independently of an Agent's plugin selection.
    for (const [settings, key] of [
      [{ allow: ["diffs", 1] }, "allow"],
      [{ deny: [null] }, "deny"],
    ] as const) {
      const refused = await controller.request(
        "POST",
        `/namespaces/${namespace.id}/configurations`,
        {
          body: { kind: "agent", values: { plugins: settings } } satisfies CreateConfigurationBody,
        },
      );
      assert.equal(
        apiError(refused, 400, "INVALID_REQUEST", key).message,
        pluginPolicyListRefusal(key),
      );
    }
    // Seed a row saved before the validation rule. Removing the item is the remedy even when the
    // Agent deselects the plugin, because the Gateway validates the Configuration itself.
    const older = await createConfiguration(controller, namespace.id, {});
    await configurationDriver.update({
      ...savedConfiguration(configurationDriver, namespace.id, older.id),
      values: { plugins: { deny: ["slack", 7] } },
    });
    const refusedOlder = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "plugin-settings-older",
        configurationId: older.id,
        plugins,
      } satisfies AgentCreate,
    });
    assert.equal(
      apiError(refusedOlder, 400, "INVALID_REQUEST", "older row").message,
      managedPluginSettingRefusal(
        "plugins.deny",
        "must list only plugin IDs as text",
        diffsPluginId,
        "remove any other item",
      ),
    );
    const listed = await controller.request("GET", `/namespaces/${namespace.id}/agents`);
    assert.deepEqual(checkedInjectedBody(listed, 200, AgentListResponse).data, []);
    // Settings that leave the selected plugin on, and a disabled selection's plugin turned off, save.
    // So does an exact copy of the entry the entrypoint writes, which the Gateway starts with.
    const accepted: [
      settings: OpenClawConfigurationDocument,
      selection: PluginDesiredState,
      gateway?: OpenClawConfigurationDocument,
    ][] = [
      [{ enabled: true, allow: ["codex", " Diffs"], deny: ["slack"] }, plugins],
      [{ allow: [" "], entries: { slack: { enabled: true } } }, plugins],
      [{ enabled: false, deny: ["diffs"], allow: ["codex"] }, disabled],
      [{ entries: { diffs: { enabled: true } } }, plugins],
      [{ entries: { diffs: { enabled: false } } }, disabled, servedOrigin],
    ];
    const agents: AgentWire[] = [];
    for (const [index, [settings, selection, gateway]] of accepted.entries()) {
      const configuration = await createConfiguration(controller, namespace.id, {
        plugins: settings,
        ...(gateway === undefined ? {} : { gateway }),
      });
      const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
        body: {
          name: `plugin-settings-ok-${index}`,
          configurationId: configuration.id,
          plugins: selection,
        } satisfies AgentCreate,
      });
      agents.push(checkedInjectedBody(created, 201, AgentResponse).data);
    }
    // A later Configuration save can add such a setting under a saved Agent, so deployment checks
    // the pair again and creates no revision; removing the setting deploys.
    const [agent] = agents;
    assert(agent, "the first accepted configuration must have an Agent");
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    await controller.fixture.markNamespaceReady(namespace.id);
    await bindHarnessKey(controller.fixture, namespace.id, agent);
    const stored = savedConfiguration(configurationDriver, namespace.id, agent.configurationId);
    await configurationDriver.update({ ...stored, values: { plugins: { allow: ["codex"] } } });
    const refusedDeploy = await controller.request("POST", `${agentPath}/deploy`);
    assert.equal(
      apiError(refusedDeploy, 400, "INVALID_REQUEST", "deploy").message,
      managedPluginSettingRefusal("plugins.allow", "must list diffs", diffsPluginId, step.allow),
    );
    assert.deepEqual(await readRevisions(controller, agentPath), []);
    await configurationDriver.update({
      ...stored,
      values: { plugins: { allow: ["codex", "diffs"] } },
    });
    const deployed = await controller.request("POST", `${agentPath}/deploy`);
    checkedInjectedBody(deployed, 202, AgentRevisionResponse);
  });
}
