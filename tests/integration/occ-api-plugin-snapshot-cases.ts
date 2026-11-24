import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  AgentListResponse,
  AgentResponse,
  AgentRevisionListResponse,
  AgentRevisionResponse,
  InstallationResponse,
  type PluginDesiredSelection,
  type PluginDesiredState,
} from "../../packages/contracts/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  bindHarnessKey,
  bootstrapInstallation,
  checkedInjectedBody,
  createConfiguration,
  createNamespace,
} from "./occ-api-injected-fixture.ts";
import {
  apiError,
  diffsPluginId,
  diffsSelection,
  linearPluginId,
  readAgent,
  selectPluginDriver,
  type AgentCreate,
  type AgentUpdate,
  type ConfiguredController,
  type Reply,
} from "./occ-api-plugin-policy-support.ts";

function assertPolicyOnlyPlugin(selection: PluginDesiredSelection): void {
  for (const key of ["id", "nativeId", "name", "driver", "release", "artifacts"]) {
    assert.equal(
      Object.hasOwn(selection, key),
      false,
      `Agent plugin policy must not expose ${key}`,
    );
  }
}

export function registerPluginSnapshotCase(configuredController: ConfiguredController): void {
  test("Agent create and update replace policy-only plugin maps and revisions freeze the requested snapshot", async () => {
    const configurationDriver = createTestConfigurationDriver();
    const readConfiguration = configurationDriver.read.bind(configurationDriver);
    let configurationReads = 0;
    configurationDriver.read = (reference) => {
      configurationReads += 1;
      return readConfiguration(reference);
    };
    const controller = await configuredController({ configurationDriver });
    await bootstrapInstallation(controller);
    const namespace = await createNamespace(controller, "plugin-api");
    const configuration = await createConfiguration(controller, namespace.id);
    const replacementConfiguration = await createConfiguration(controller, namespace.id, {
      runtime: { revision: "replacement" },
    });
    selectPluginDriver(controller, new OCCPluginDriver());
    const installation = await controller.request("GET", "/installation");
    const { data: installed } = checkedInjectedBody(installation, 200, InstallationResponse);
    const catalog = installed.capabilities?.pluginCatalogs?.[0];
    assert(catalog, "the selected Plugin Driver must publish its policy capabilities");
    const capabilities = catalog.pluginPolicies;
    assert.deepEqual(capabilities.driver, {
      id: "occ-plugin",
      implementation: "occ/openclaw-plugin",
    });
    assert.deepEqual(capabilities.toolDefaults, {
      enabled: true,
      approval: ["provider_default", "none"],
      reviewer: [],
    });
    assert.deepEqual(capabilities.tools, {
      enabled: true,
      approval: ["provider_default", "none"],
      reviewer: [],
    });
    assert.deepEqual(capabilities.approvers, { agent: true, plugin: true, tools: true });
    assert.equal(capabilities.driverPolicySchema.additionalProperties, false);
    assert.deepEqual(capabilities.driverPolicySchema.properties, {});
    const initialPlugins = {
      [diffsPluginId]: {
        ...diffsSelection[diffsPluginId],
        approvers: [{ channel: "slack", id: "team:T123:user:U123" }],
        toolDefaults: { enabled: false, approval: "none" },
        tools: { diffs: { enabled: true, approvers: [] } },
      },
    } satisfies PluginDesiredState;

    const readsBeforeSave = configurationReads;
    const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "plugin-agent",
        configurationId: configuration.id,
        plugins: initialPlugins,
        pluginApprovers: [],
      } satisfies AgentCreate,
    });
    const { data: agent } = checkedInjectedBody(created, 201, AgentResponse);
    assert.deepEqual(agent.plugins, initialPlugins);
    assert.deepEqual(agent.pluginApprovers, []);
    const createdSelection = agent.plugins?.[diffsPluginId];
    assert(createdSelection, "the saved Agent must retain its selected plugin");
    assertPolicyOnlyPlugin(createdSelection);
    // The Plugin Driver's Configuration check and Agent save's check of the Agent against its
    // Configuration as deployment would (the Harness and its execution mode) read the values
    // once, shared by every check.
    assert.equal(configurationReads, readsBeforeSave + 1);

    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const saved = readAgent(await controller.request("GET", agentPath));
    assert.deepEqual(saved.plugins, initialPlugins);
    assert.deepEqual(saved.pluginApprovers, []);

    await controller.fixture.markNamespaceReady(namespace.id);
    await bindHarnessKey(controller.fixture, namespace.id, agent);
    const deployment = checkedInjectedBody(
      await controller.request("POST", `${agentPath}/deploy`),
      202,
      AgentRevisionResponse,
    ).data;
    assert.deepEqual(deployment.plugins, {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: initialPlugins,
    });
    assert.deepEqual(deployment.pluginApprovers, []);
    assert(deployment.plugins, "the admitted revision must freeze its plugin snapshot");
    assert.equal(Object.hasOwn(deployment.plugins, "artifacts"), false);

    const omittedPlugins = checkedInjectedBody(
      await controller.request("PATCH", agentPath, {
        body: { configurationId: replacementConfiguration.id } satisfies AgentUpdate,
      }),
      200,
      AgentResponse,
    ).data;
    assert.equal(omittedPlugins.configurationId, replacementConfiguration.id);
    assert.deepEqual(omittedPlugins.plugins, initialPlugins);
    assert.deepEqual(omittedPlugins.pluginApprovers, []);

    const replacementPlugins = {
      [diffsPluginId]: {
        ...diffsSelection[diffsPluginId],
        toolDefaults: { approval: "provider_default" },
        tools: { diffs: { approval: "none" } },
      },
    } satisfies PluginDesiredState;
    const replaced = checkedInjectedBody(
      await controller.request("PATCH", agentPath, {
        body: {
          configurationId: replacementConfiguration.id,
          plugins: replacementPlugins,
          pluginApprovers: [{ channel: "slack", id: "team:T123:user:U456" }],
        } satisfies AgentUpdate,
      }),
      200,
      AgentResponse,
    ).data;
    // Replacing policy removes old enablement overrides without inventing new defaults.
    assert.deepEqual(replaced.plugins, replacementPlugins);
    assert.deepEqual(replaced.pluginApprovers, [{ channel: "slack", id: "team:T123:user:U456" }]);
    const replacedSelection = replaced.plugins?.[diffsPluginId];
    assert(replacedSelection, "the updated Agent must retain its selected plugin");
    assertPolicyOnlyPlugin(replacedSelection);
    // The nullable approver list is a referenced schema ($id PluginApprovers). Its problems belong
    // to the list's branch, so the null branch adds no wrong-type clause (finding 808).
    const approver = { channel: "slack", id: "team:T123:user:U456" };
    for (const [pluginApprovers, problem] of [
      [
        [approver, approver],
        "body /pluginApprovers has an unsupported value (expected no duplicate items)",
      ],
      [
        Array.from({ length: 65 }, (_, index) => ({ channel: "slack", id: `user:${index}` })),
        "body /pluginApprovers has an unsupported value (expected at most 64 items)",
      ],
      [[{ ...approver, role: "admin" }], "body /pluginApprovers/0/role is not an accepted field"],
      [
        [{ channel: "Slack", id: "user:1" }],
        "body /pluginApprovers/0/channel has an invalid format",
      ],
      ["slack", "body /pluginApprovers has the wrong type (expected one of array, null)"],
    ] as const) {
      const rejected = await controller.request("PATCH", agentPath, {
        body: { configurationId: replacementConfiguration.id, pluginApprovers },
      });
      assert.equal(
        apiError(rejected, 400, "INVALID_REQUEST").message,
        `The request does not match the operation contract: ${problem}.`,
      );
    }

    const cleared = checkedInjectedBody(
      await controller.request("PATCH", agentPath, {
        body: { configurationId: replacementConfiguration.id, plugins: {} } satisfies AgentUpdate,
      }),
      200,
      AgentResponse,
    ).data;
    assert.deepEqual(cleared.plugins, {});
    assert.deepEqual(cleared.pluginApprovers, [{ channel: "slack", id: "team:T123:user:U456" }]);

    const historical = checkedInjectedBody(
      await controller.request("GET", `${agentPath}/revisions/${deployment.id}`),
      200,
      AgentRevisionResponse,
    ).data;
    assert.deepEqual(historical.plugins, deployment.plugins);
    assert.deepEqual(historical.pluginApprovers, []);

    const pluginFreeRevision = checkedInjectedBody(
      await controller.request("POST", `${agentPath}/deploy`),
      202,
      AgentRevisionResponse,
    ).data;
    assert.equal(Object.hasOwn(pluginFreeRevision, "plugins"), false);
    assert.deepEqual(pluginFreeRevision.pluginApprovers, [
      { channel: "slack", id: "team:T123:user:U456" },
    ]);
    const clearedApprovers = checkedInjectedBody(
      await controller.request("PATCH", agentPath, {
        body: {
          configurationId: replacementConfiguration.id,
          pluginApprovers: null,
        } satisfies AgentUpdate,
      }),
      200,
      AgentResponse,
    ).data;
    assert.equal(Object.hasOwn(clearedApprovers, "pluginApprovers"), false);
    const inheritedRevision = checkedInjectedBody(
      await controller.request("POST", `${agentPath}/deploy`),
      202,
      AgentRevisionResponse,
    ).data;
    assert.equal(Object.hasOwn(inheritedRevision, "pluginApprovers"), false);
    assert.deepEqual(pluginFreeRevision.pluginApprovers, [
      { channel: "slack", id: "team:T123:user:U456" },
    ]);
  });
}

export function registerPluginHarnessCase(configuredController: ConfiguredController): void {
  test("Agent save and deployment refuse plugins the Plugin Driver cannot run in the Agent's Harness", async () => {
    const controller = await configuredController();
    await bootstrapInstallation(controller);
    const namespace = await createNamespace(controller, "plugin-harness-pair");
    const codex = await createConfiguration(
      controller,
      namespace.id,
      createHarnessConfiguration("codex", "gpt-6-astra"),
    );
    const openclaw = await createConfiguration(
      controller,
      namespace.id,
      createHarnessConfiguration("openclaw", "gpt-5.1"),
    );
    selectPluginDriver(controller, new OCCPluginDriver());
    const plugins = diffsSelection;
    const assertRefused = (refused: Reply, label: string, harness = "codex") => {
      assert.equal(
        apiError(refused, 400, "INVALID_REQUEST", label).message,
        `No Plugin Driver is enabled for the ${harness} Harness. Remove the Agent's plugins or enable its catalog.`,
        label,
      );
    };
    // Kubernetes Compute renders OpenClaw plugin artifacts only into an OpenClaw Harness and
    // refused a dedicated Codex Agent's plugins in preparation, after the deployment had stopped
    // the running revision (finding 2348).
    const agents = `/namespaces/${namespace.id}/agents`;
    assertRefused(
      await controller.request("POST", agents, {
        body: {
          name: "codex-plugins",
          executionMode: "dedicated",
          configurationId: codex.id,
          plugins,
        } satisfies AgentCreate,
      }),
      "create",
    );
    assert.deepEqual(
      checkedInjectedBody(await controller.request("GET", agents), 200, AgentListResponse).data,
      [],
    );
    const embedded = checkedInjectedBody(
      await controller.request("POST", agents, {
        body: {
          name: "openclaw-plugins",
          configurationId: openclaw.id,
          plugins,
        } satisfies AgentCreate,
      }),
      201,
      AgentResponse,
    ).data;
    const created = checkedInjectedBody(
      await controller.request("POST", agents, {
        body: {
          name: "codex-agent",
          executionMode: "dedicated",
          configurationId: codex.id,
        } satisfies AgentCreate,
      }),
      201,
      AgentResponse,
    ).data;
    const agentPath = `${agents}/${created.id}`;
    assertRefused(
      await controller.request("PATCH", agentPath, {
        body: { configurationId: codex.id, plugins } satisfies AgentUpdate,
      }),
      "update",
    );
    await controller.fixture.markNamespaceReady(namespace.id);
    await bindHarnessKey(controller.fixture, namespace.id, embedded);
    // Removing an installed catalog prevents another deployment of an Agent that already selected it.
    const openclawPath = `${agents}/${embedded.id}`;
    assert(controller.fixture.controller, "bootstrap must create the controller");
    controller.fixture.controller.installPluginDrivers([]);
    const missing = await controller.request("POST", `${openclawPath}/deploy`);
    apiError(missing, 501, "NOT_IMPLEMENTED");
    assert.deepEqual(
      checkedInjectedBody(
        await controller.request("GET", `${openclawPath}/revisions`),
        200,
        AgentRevisionListResponse,
      ).data,
      [],
    );

    // An Installation offering only Codex plugins refuses both OpenClaw modes at save.
    selectPluginDriver(controller, new CodexPluginDriver());
    const codexPlugins = { [linearPluginId]: { enabled: true } } satisfies PluginDesiredState;
    const codexHarness = "openclaw";
    assertRefused(
      await controller.request("POST", agents, {
        body: {
          name: "openclaw-codex-plugins",
          executionMode: "dedicated",
          configurationId: openclaw.id,
          plugins: codexPlugins,
        } satisfies AgentCreate,
      }),
      "Codex Plugin Driver create",
      codexHarness,
    );
    assertRefused(
      await controller.request("POST", `${agents}/validate`, {
        body: {
          configuration: {
            kind: "agent",
            values: createHarnessConfiguration("openclaw", "gpt-5.1"),
          },
          executionMode: "dedicated",
          plugins: codexPlugins,
        },
      }),
      "Codex Plugin Driver preflight",
      codexHarness,
    );
    const codexEmbedded = await controller.request("POST", agents, {
      body: {
        name: "embedded-codex-plugins",
        configurationId: openclaw.id,
        plugins: codexPlugins,
      } satisfies AgentCreate,
    });
    assertRefused(codexEmbedded, "embedded OpenClaw cannot use the Codex catalog", codexHarness);
  });
}
