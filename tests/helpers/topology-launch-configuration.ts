import assert from "node:assert/strict";
import { managedGatewayConfiguration } from "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts";
import type {
  OpenClawConfigurationDocument,
  PresetDraftTemplate,
  SecretBindings,
  SecretReference,
} from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "./harness-configuration.mjs";

type NativeTopologyOptions = {
  controlUi?: OpenClawConfigurationDocument;
  gatewayAuth?: {
    auth: OpenClawConfigurationDocument;
    allowRealIpFallback?: boolean;
    trustedProxies: readonly string[];
  };
  modelEnvName?: string;
};

type SlackTopologyOptions = {
  allowedUserId: string;
  channelId: string;
};

export function createNativeTopologyConfiguration(
  harnessId: string,
  providerModel: string,
  slack?: SlackTopologyOptions,
  options: NativeTopologyOptions = {},
): TopologyLaunchValues {
  const configuration = createHarnessConfiguration(harnessId, providerModel);
  const provider =
    harnessId === "codex"
      ? configuration.models.providers.codex
      : configuration.models.providers.openai;
  const model = provider?.models[0];
  assert.ok(provider && model, "the fixture builder supplies its selected model");
  Object.assign(model, { input: ["text", "image"] });

  if (options.controlUi !== undefined) {
    Object.assign(configuration.gateway, { controlUi: options.controlUi });
  }
  if (options.gatewayAuth !== undefined) {
    Object.assign(configuration, {
      gateway: {
        ...configuration.gateway,
        auth: options.gatewayAuth.auth,
        ...(options.gatewayAuth.allowRealIpFallback === undefined
          ? {}
          : { allowRealIpFallback: options.gatewayAuth.allowRealIpFallback }),
        trustedProxies: options.gatewayAuth.trustedProxies,
      },
    });
  }

  if (harnessId === "openclaw") {
    const modelEnvName = options.modelEnvName ?? "OPENAI_API_KEY";
    Object.assign(configuration, {
      secrets: {
        providers: {
          model: {
            source: "env",
            allowlist: Array.from(new Set(["OPENAI_API_KEY", modelEnvName])),
          },
        },
      },
    });
    Object.assign(provider, {
      apiKey: {
        source: "env",
        provider: "model",
        id: modelEnvName,
      },
    });
  }
  if (harnessId === "codex" && slack === undefined) {
    // Native Codex file tools require a writable app-server sandbox plus an omitted or wildcard
    // OpenClaw dynamic-tool allowlist; this case explicitly edits AGENTS.md in the workspace.
    const plugins:
      | (NonNullable<typeof configuration.plugins> & {
          slots?: OpenClawConfigurationDocument;
        })
      | undefined = configuration.plugins;
    assert.ok(plugins);
    const appServer = plugins.entries.codex.config.appServer;
    appServer.approvalPolicy = "never";
    appServer.sandbox = "workspace-write";
    const tools = { allow: ["*"], fs: { workspaceOnly: true } };
    Object.assign(configuration, { tools });

    // Admission and slot selection are separate. Select the intended recall tool owner
    // explicitly; provider status/search alone does not prove agent-tool registration.
    plugins.allow.push("memory-core");
    Object.assign(plugins.entries, { "memory-core": { enabled: true } });
    plugins.slots = { ...plugins.slots, memory: "memory-core" };

    // Dedicated Gateways apply a second, concrete tool gate after plugin admission. Preserve
    // the normal baseline and opt into only the Memory search used by this scenario.
    const managedTools = managedGatewayConfiguration(configuration, configuration, true).tools;
    assert.ok(managedTools && typeof managedTools === "object" && "gatewayPolicy" in managedTools);
    const { gatewayPolicy } = managedTools;
    assert.ok(
      gatewayPolicy &&
        typeof gatewayPolicy === "object" &&
        "allow" in gatewayPolicy &&
        Array.isArray(gatewayPolicy.allow),
    );
    Object.assign(tools, {
      gatewayPolicy: { ...gatewayPolicy, allow: [...gatewayPolicy.allow, "memory_search"] },
    });

    // Exercise remote file indexing without projecting the Harness model key into Gateway.
    Object.assign(configuration, {
      memory: {
        search: {
          enabled: true,
          provider: "none",
          sources: ["memory"],
          store: { vector: { enabled: false } },
        },
      },
    });
  }
  if (slack === undefined) {
    return configuration;
  }

  // The live Slack fixture selects dedicated Codex.
  const plugins = configuration.plugins;
  assert.ok(plugins);
  plugins.allow.push("slack");
  Object.assign(plugins.entries, { slack: { enabled: true } });
  return Object.assign(configuration, {
    channels: {
      slack: {
        enabled: true,
        mode: "socket",
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        dmPolicy: "allowlist",
        allowFrom: [slack.allowedUserId],
        channels: {
          [slack.channelId]: {
            requireMention: true,
            allowBots: "mentions",
            users: [slack.allowedUserId],
            replyToMode: "off",
          },
        },
      },
    },
  });
}

type TopologyLaunchValues = Readonly<Record<string, unknown>> & {
  agents: {
    defaults: {
      model: string;
      models: Record<string, unknown>;
    };
  };
};

export function createTopologyPresetTemplate(
  launchValues: TopologyLaunchValues,
  mode: "embedded" | "dedicated",
  modelSecret: SecretReference,
  secretBindings: SecretBindings,
) {
  const templateValues = structuredClone(launchValues);
  const modelReference = templateValues.agents.defaults.model;
  templateValues.agents.defaults.model = "{{ vars.model }}";
  templateValues.agents.defaults.models = {
    "{{ vars.model }}": templateValues.agents.defaults.models[modelReference],
  };

  return {
    variables: {
      name: { type: "string" },
      model: { type: "string", default: modelReference },
      secretId: { type: "string" },
    },
    agent: {
      name: "{{ vars.name }}",
      executionMode: mode,
      harnessAuth: {
        method: "api_key",
        source: { ...modelSecret, id: "{{ vars.secretId }}" },
      },
    },
    configuration: {
      values: templateValues,
      ...(Object.keys(secretBindings).length === 0 ? {} : { secretBindings }),
    },
  } satisfies PresetDraftTemplate;
}
