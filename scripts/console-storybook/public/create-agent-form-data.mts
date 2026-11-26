import type { StoryAction } from "../story-action.mts";

export const create = "/console/agents/new?namespace=ns_00000000-0000-4000-8000-000000000001";

export const click = (text: string): { click: string } => ({ click: text });

export const form: StoryAction[] = [click("Start with default Preset")];

export const createModelSecret = (value: string): StoryAction[] => [
  { selector: "#provider-credential-secret", value: "__openclaw_create_secret__" },
  { selector: "#create-provider-credential-secret-value", value },
  click("Create Secret"),
];

export const managedStaticForm: StoryAction[] = [
  ...form,
  { selector: "#agent-name", value: "Research assistant" },
  { selector: "#agent-model", value: "gpt-5.6-sol" },
  { selector: "#agent-model-credential", value: "new" },
  { selector: "#provider-api-key", value: "storybook-model-api-key" },
];

// Guided provisioning still supports Namespace Secret authentication.
export const provisionableForm: StoryAction[] = [
  ...form,
  { selector: "#agent-name", value: "Research assistant" },
  { selector: "#agent-model", value: "gpt-5.6-sol" },
  { selector: "#provider-credential-secret", value: "sec_demo_model" },
];

export const presetSecretsPath = "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets";

export const addSlackBotSource: StoryAction[] = [
  { selector: "#slack-source-slack-bot-token", value: "new" },
  { selector: "#slack-source-slack-bot-token-name", value: "New Slack bot token (simulated)" },
  { selector: "#slack-source-slack-bot-token-value", value: "xoxb-storybook-demo" },
];

export const allowEveryoneInSlackChannels: StoryAction[] = [
  { selector: "#slack-channel-access", value: "everyone" },
];
