import type {
  HarnessExecutionMode,
  OpenClawConfigurationDocument,
  SecretBindings,
  SecretMetadata,
} from "../../packages/contracts/src/index.ts";

import { nativeValues } from "./console-agents-browser-helpers.ts";

// The Slack channel settings an allowlisted Socket Mode Agent uses: direct messages from one user
// and mentions in one channel.
export const SLACK_ALLOWLIST = {
  dmPolicy: "allowlist",
  groupPolicy: "allowlist",
  allowFrom: ["U123"],
  channels: { C123: { requireMention: true } },
};

// Codex Agent values with Socket Mode Slack reading its two tokens from the SLACK_APP_TOKEN and
// SLACK_BOT_TOKEN env vars. `settings` are the rest of the Slack channel settings.
export function slackAgentValues(
  marker: string,
  settings: OpenClawConfigurationDocument = SLACK_ALLOWLIST,
): OpenClawConfigurationDocument {
  return nativeValues(marker, {
    harnessId: "codex",
    channels: {
      slack: {
        enabled: true,
        mode: "socket",
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        ...settings,
      },
    },
  });
}

// Create options for a dedicated Agent whose two Slack tokens are bound to the Secrets `app` and
// `bot` as env vars.
export function slackTokenBindings(
  app: Pick<SecretMetadata, "ref">,
  bot: Pick<SecretMetadata, "ref">,
): {
  executionMode: Extract<HarnessExecutionMode, "dedicated">;
  secretBindings: SecretBindings;
} {
  return {
    executionMode: "dedicated",
    secretBindings: {
      SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
      SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
    },
  };
}
