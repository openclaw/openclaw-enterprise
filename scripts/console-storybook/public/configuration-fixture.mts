import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import type { slack } from "../../../apps/controller/src/console/channels/slack.mts";

type SlackConfig = Extract<ReturnType<typeof slack.support>, { supported: true }>["config"];

type ConfigurationScenario = {
  harnessId?: string;
  gatewayPassword?: boolean;
  gatewayPasswordProviderless?: boolean;
  secretProviderAliasRefused?: boolean;
  pluginSecretInputProviderless?: boolean;
  pluginDeny?: readonly OpenClawConfigurationValue[];
  configInclude?: boolean;
  pluginEntryKeyVariant?: boolean;
  openClawSandbox?: boolean;
  providerKeyVariant?: boolean;
  codexPluginsDisabled?: boolean;
  trustedProxyWithoutMachine?: boolean;
  kubernetesEntryKeyVariant?: boolean;
  gatewayPasswordAllowlistOmits?: boolean;
  messageQueue?: OpenClawConfigurationDocument;
  retiredSetting?: boolean;
  slack?: boolean;
  slackOff?: boolean;
  slackMode?: "socket" | "http";
  slackReplyToMode?: "off";
  slackEnterpriseOrgInstall?: boolean;
  slackPolicy?: SlackConfig["dmPolicy"];
  slackTokens?: {
    appToken?: OpenClawConfigurationValue;
    botToken?: OpenClawConfigurationValue;
    signingSecret?: OpenClawConfigurationValue;
  };
  slackAllowFrom?: SlackConfig["allowFrom"];
  slackChannels?: SlackConfig["channels"];
  slackAllowEveryone?: boolean;
};

// Historical invalid settings remain JSON, not validated production Configuration values.
type FixtureConfiguration = {
  gateway: { mode: string; auth?: OpenClawConfigurationDocument };
  agents: {
    defaults: {
      model: string;
      models: Record<string, { agentRuntime: { id: string } }>;
      $include?: string;
      sandbox?: OpenClawConfigurationDocument;
    };
  };
  channels: { slack?: OpenClawConfigurationDocument };
  secrets?: OpenClawConfigurationDocument;
  plugins?: OpenClawConfigurationDocument;
  models?: OpenClawConfigurationDocument;
  messages?: OpenClawConfigurationDocument;
  security?: OpenClawConfigurationDocument;
};

function slackChannels(scenario: ConfigurationScenario): NonNullable<SlackConfig["channels"]> {
  if (scenario.slackChannels !== undefined) {
    return structuredClone(scenario.slackChannels);
  }
  return {
    CDEMO123: {
      requireMention: true,
      users: scenario.slackAllowEveryone ? ["*"] : ["UDEMO123"],
    },
  };
}

export function configurationValues(scenario: ConfigurationScenario): FixtureConfiguration {
  const values: FixtureConfiguration = {
    gateway: { mode: "local" },
    agents: {
      defaults: {
        model: "codex/gpt-4.1",
        models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
      },
    },
    channels: {},
  };
  if (scenario.harnessId === "openclaw") {
    const model = "openai/gpt-5.1";
    values.agents.defaults.model = model;
    values.agents.defaults.models = { [model]: { agentRuntime: { id: "openclaw" } } };
  }
  if (scenario.gatewayPassword) {
    values.gateway.auth = {
      password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
    };
  }
  if (scenario.gatewayPasswordProviderless) {
    // A reference an older release saved without a provider, which OpenClaw cannot read.
    values.gateway.auth = { password: { source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" } };
  }
  if (scenario.secretProviderAliasRefused) {
    // An env alias an older release saved in upper case, which OpenClaw's config check refuses.
    values.secrets = { defaults: { env: "BAD" } };
  }
  if (scenario.pluginSecretInputProviderless) {
    // A Google web search header an older release saved as a SecretRef without a provider, which
    // OpenClaw cannot read, so the Gateway exits at startup.
    values.plugins = {
      entries: {
        google: {
          config: {
            webSearch: { headers: { "X-Goog-User-Project": { source: "env", id: "GOOG_TOKEN" } } },
          },
        },
      },
    };
  }
  if (scenario.pluginDeny !== undefined) {
    values.plugins = { ...values.plugins, deny: structuredClone(scenario.pluginDeny) };
  }
  if (scenario.configInclude) {
    // An OpenClaw $include an older release saved, which would merge settings OCE never checked.
    values.agents.defaults.$include = "./defaults.json";
  }
  if (scenario.pluginEntryKeyVariant) {
    // A Codex entry an older release saved beside codex, which OpenClaw merges into codex.
    values.plugins = {
      entries: {
        codex: { config: { appServer: { approvalPolicy: "on-request" } } },
        Codex: { enabled: true },
      },
    };
  }
  if (scenario.openClawSandbox) {
    // OpenClaw's own sandbox, which an older release saved and the OCE runtime cannot run.
    values.agents.defaults.sandbox = { mode: "all" };
  }
  if (scenario.providerKeyVariant) {
    // An OpenAI model provider key an older release saved, which OpenClaw applies to openai.
    values.models = { providers: { OpenAI: { baseUrl: "https://models.example.test/v1" } } };
  }
  if (scenario.codexPluginsDisabled) {
    // plugins.enabled false saved before Kubernetes Compute refused it on Dedicated Codex, whose
    // Gateway runs the codex plugin.
    values.plugins = { ...values.plugins, enabled: false };
  }
  if (scenario.trustedProxyWithoutMachine) {
    // A trusted-proxy allowlist without occ-workspace-files, saved before Kubernetes Compute
    // refused it.
    values.gateway = {
      ...values.gateway,
      auth: {
        ...values.gateway?.auth,
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["oidc:member-01"] },
      },
    };
  }
  if (scenario.kubernetesEntryKeyVariant) {
    // A File-Transfer entry saved before Kubernetes Compute refused it, which OpenClaw merges into
    // file-transfer, the entry Kubernetes Compute enables for the workspace node.
    values.plugins = { entries: { "File-Transfer": { enabled: true } } };
  }
  if (scenario.gatewayPasswordAllowlistOmits) {
    // A default env alias on a configured env provider whose allowlist leaves out the generated
    // password, so OpenClaw cannot read the reference Enable gateway password access would write.
    values.secrets = {
      defaults: { env: "vault" },
      providers: { vault: { source: "env", allowlist: ["OTHER_SECRET"] } },
    };
  }
  if (scenario.messageQueue !== undefined) {
    values.messages = { queue: structuredClone(scenario.messageQueue) };
  }
  if (scenario.retiredSetting) {
    // A setting an older release saved and the pinned OpenClaw has since retired.
    values.security = { preset: "corporate" };
  }
  if (scenario.slack) {
    values.channels.slack = {
      // `slackOff`: Disable Slack saved the channel off and kept its bindings.
      enabled: scenario.slackOff !== true,
      mode: scenario.slackMode ?? "socket",
      ...(scenario.slackReplyToMode === undefined
        ? {}
        : { replyToMode: scenario.slackReplyToMode }),
      ...(scenario.slackEnterpriseOrgInstall ? { enterpriseOrgInstall: true } : {}),
      dmPolicy: scenario.slackPolicy ?? "pairing",
      groupPolicy: scenario.slackPolicy === "open" ? "open" : "allowlist",
      ...(scenario.slackTokens ?? {
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      }),
      allowFrom:
        scenario.slackAllowFrom ?? (scenario.slackPolicy === "open" ? ["*"] : ["UDEMO123"]),
      channels: slackChannels(scenario),
    };
  }
  return values satisfies OpenClawConfigurationDocument;
}
