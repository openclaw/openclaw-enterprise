import type { StoryAction } from "../story-action.mts";
import type { CredentialSourceType } from "@openclaw-enterprise/contracts";

export const create = "/console/agents/new?namespace=ns_00000000-0000-4000-8000-000000000001";

export const click = (text: string): { click: string } => ({ click: text });

export const form: StoryAction[] = [click("Start with default Preset")];

export const createModelSecret = (value: string): StoryAction[] => [
  { selector: "#provider-credential-secret", value: "__openclaw_create_secret__" },
  { selector: "#create-provider-credential-secret-value", value },
  click("Create Secret"),
];

export const readyForm: StoryAction[] = [
  ...form,
  { selector: "#agent-name", value: "Research assistant" },
  { selector: "#agent-model", value: "gpt-5.6-sol" },
  ...createModelSecret("storybook-model-api-key"),
];

export const modelCredentialSourceTypes: CredentialSourceType[] = [
  {
    type: "openai",
    config: [
      {
        name: "authorized_base_url",
        required: false,
        description:
          "Immutable destination authorization. Must match the Installation model provider; omission authorizes only the default OpenAI endpoint.",
      },
    ],
    secrets: [{ name: "api_key", required: true }],
    rotation: "none",
    harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
  },
];

// A Credential Gateway that also offers ChatGPT device login. Without that source type Sign in
// with OAuth is unavailable before the click (finding 2991).
export const deviceLoginSourceTypes: CredentialSourceType[] = [
  ...modelCredentialSourceTypes,
  {
    type: "codex-oauth",
    config: [],
    secrets: [],
    rotation: "refresh",
    deviceAuthorization: { harnessId: "codex" },
    harnessAuth: { modelProvider: "openai", loginMode: "chatgptAuthTokens" },
  },
];

export const presetSecretsPath = "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets";

export const createSlackBotSecret: StoryAction[] = [
  { selector: "#slack-secret-slack-bot-token", value: "__openclaw_create_secret__" },
  { selector: "#create-slack-secret-slack-bot-token-value", value: "simulated-bot-token" },
  click("Create Secret"),
];

export const allowEveryoneInSlackChannels: StoryAction[] = [
  { selector: "#slack-channel-access", value: "everyone" },
];
