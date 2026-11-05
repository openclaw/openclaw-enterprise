import type { PluginFieldsOptions } from "../../../../apps/controller/src/console/agents/plugin-fields.mts";
import {
  allowEveryoneInSlackChannels,
  click,
  create,
  createModelSecret,
  createSlackBotSecret,
  deviceLoginSourceTypes,
  form,
  modelCredentialSourceTypes,
  presetSecretsPath,
  readyForm,
} from "../create-agent-form-data.mts";
import {
  pluginCapabilities,
  pluginDiscovery,
  pluginSelections,
  pluginSetup,
  pluginToolRefusal,
} from "../plugin-scenario-data.mts";
import type { StoryAction } from "../../story-action.mts";
import type {
  AgentDeploymentStatusWire,
  OpenClawConfigurationDocument,
  CredentialSourceType,
  NamespaceStatus,
  PresetVariable,
  RepositoryOption,
} from "@openclaw-enterprise/contracts";
import type { createFixtureFetch } from "../preview-rules.mts";
import type { servePluginDiscovery } from "../plugin-discovery-fixture.mts";

type CreateAgentScenario = {
  group: "Pages/Create Agent";
  name: string;
  path: typeof create;
  description: string;
  steps?: readonly string[];
  gap?: string;
  actions?: readonly StoryAction[];
  rules?: Parameters<typeof createFixtureFetch>[0];
  credentialSourceTypes?: readonly CredentialSourceType[];
  credentialRegistrationOutcome?: "invalid-config" | "ready" | "different-source" | "deleting";
  extraSecrets?: readonly { id: string; name: string }[];
  namespaceStatus?: NamespaceStatus;
  namespaceRechecks?: readonly (NamespaceStatus | "missing" | number)[];
  nativeWorkerSupport?: false | "custom-image";
  openclawExecutionModes?: readonly "dedicated"[];
  openclawSettingRefusal?: string;
  pluginDiscovery?: Parameters<typeof servePluginDiscovery>[0];
  pluginDiscoveryCredential?: "none";
  pluginCapabilities?: PluginFieldsOptions["capabilities"];
  // Deliberately unsupported input for the Preset validation scenario.
  presetAgent?: { executionMode: "turbo" };
  presetAuth?: "codex_pat";
  presetVariables?: Readonly<Record<string, PresetVariable>>;
  presetWorkspaceFiles?: Readonly<Record<string, string>>;
  malformedProvisioningReply?: "revision-id" | "error-message";
  provisionedDeploymentStatus?: AgentDeploymentStatusWire["status"];
  provisionedDeploymentAttempt?: Omit<
    NonNullable<NonNullable<AgentDeploymentStatusWire["progress"]>["lastAttempt"]>,
    "at"
  >;
  provisionedDeploymentError?: AgentDeploymentStatusWire["error"];
  repositoryOptions?: readonly RepositoryOption[];
  secretOperateDenied?: readonly string[];
  denySecretCreate?: true;
  emptyPresets?: true;
  emptySecrets?: true;
  modelFallbackSelection?: true;
  modelRosterSelection?: true;
  nativeAdminSetup?: true;
  noDefaultPreset?: true;
  oauthExpired?: true;
  oauthPending?: true;
  observabilityDenied?: true;
  provisionedDeploymentStopped?: true;
  provisioningCancelledByStop?: true;
  provisioningNamesDeploymentWait?: true;
  readOnlyPermissionSummary?: true;
  repositoryDescriptionsPending?: true;
  repositoryNotConfigured?: true;
  sandboxDriverUnavailable?: true;
  secretCreateNotPermitted?: true;
  standardCodexPreset?: true;
  standardOpenclawPreset?: true;
  nativePluginSettings?: OpenClawConfigurationDocument;
  unsupportedProvisioning?: true;
  presetTrustedProxyVariable?: true;
  presetModelKeyVariable?: true;
};

// The OpenShell Sandbox Driver's refusal of Dedicated OpenClaw on its settings alone.
const openShellUserNamespacesRefusal =
  "Dedicated OpenClaw needs kubernetes.userNamespaces: false in the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to set it.";

const oauthForm: StoryAction[] = [
  ...form,
  { selector: "#agent-auth-method", value: "credential_source" },
];

const startOAuthLogin: StoryAction[] = [...oauthForm, click("Sign in with OAuth")];

const dedicatedOpenclawForm: StoryAction[] = [
  ...readyForm,
  { selector: "#agent-harness", value: "openclaw" },
  { selector: ".launch-runtime summary", click: true },
  { selector: "#execution-mode", value: "dedicated" },
];

const passwordPresetForm: StoryAction[] = [
  { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
  { selector: "#preset-variable-name", value: "Codex assistant" },
  { selector: "#preset-variable-model", value: "gpt-5.1" },
  { selector: "#preset-variable-modelSecret", value: "storybook-model-key" },
  click("Use Preset"),
];
const nativePluginForm: StoryAction[] = [
  ...passwordPresetForm,
  { selector: ".launch-advanced summary", click: true },
];
const nativePlugins = {
  entries: { knowledge: { enabled: true, config: { collection: "team-notes" } } },
};
const nativePluginSteps = [
  "Inspect Configuration JSON, select Codex, then OpenClaw. Allow and deny lists stay unchanged; only Codex runtime wiring changes.",
];

const existingPresetSecret: StoryAction[] = [
  { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
  { selector: "#preset-variable-name", value: "Codex assistant" },
  { selector: "#preset-variable-model", value: "gpt-5.1" },
  { selector: "#preset-variable-modelSecret-secret-source", value: "existing" },
];

// A Preset variable that duplicates the machine identity in the trusted-proxy allowlist, which
// the Compute preflight refuses by the setting's name (finding 3122).
const presetVariableRefusal = {
  standardCodexPreset: true,
  presetTrustedProxyVariable: true,
  rules: [
    {
      suffix: "/agents/validate",
      method: "POST",
      status: 400,
      code: "INVALID_REQUEST",
      message:
        "Configuration setting gateway.auth.trustedProxy.allowUsers must include occ-workspace-files and list distinct (case-insensitive for occ-workspace-files and @ identities), nonblank, trimmed, printable ASCII identities that are not object property names.",
    },
  ],
} satisfies Partial<CreateAgentScenario>;

const presetVariableRefused: StoryAction[] = [
  ...passwordPresetForm.slice(0, -1),
  { selector: "#preset-variable-human", value: "OCC-Workspace-Files" },
  click("Use Preset"),
  click("Create Agent"),
];

// A model policy key a Preset variable filled with a space, which the API quotes in the setting
// it refuses (finding 3122). The message is the API's sentence for that model policy rule
// (packages/occ/src/configured-harness.ts); tests/browser/console-agent-presets.test.ts pins it.
const presetQuotedSettingRefusal = {
  standardCodexPreset: true,
  presetModelKeyVariable: true,
  rules: [
    {
      suffix: "/agents/validate",
      method: "POST",
      status: 400,
      code: "INVALID_REQUEST",
      message:
        'Configuration setting agents.defaults.models["openai/gpt 5 mini"] is not on the primary model\'s provider, "codex": remove it, or list a model of that provider.',
    },
  ],
} satisfies Partial<CreateAgentScenario>;

const presetQuotedSettingRefused: StoryAction[] = [
  ...passwordPresetForm.slice(0, -1),
  { selector: "#preset-variable-fallback", value: "openai/gpt 5 mini" },
  click("Use Preset"),
  click("Create Agent"),
];

const repositoryForm: StoryAction[] = [
  ...readyForm,
  { selector: "#agent-name", value: "Repository assistant" },
];

const repositorySearchOptions: RepositoryOption[] = [
  "alpha/application-api",
  "beta/my-application",
  "omega/application",
  "zeta/application",
  "tools/cli",
  "docs/handbook",
  "ops/infrastructure",
].map((displayName, index) => ({
  repositoryRef: `catalog-${index}`,
  displayName,
  allowedProfiles: ["git-read", "git-write", "git-full"],
}));

// The same refusal from Create Agent's preflight, worded as the OpenClaw Plugin Driver words it.
const pluginPreflightRefusal =
  "Configuration setting tools.deny blocks every tool of plugin codex-plugin:calendar@openai-curated-remote; remove the matching deny entry or deselect the plugin.";

const pluginDiscoveryForm: StoryAction[] = [
  ...form,
  { selector: "#agent-auth-method", value: "codex_pat" },
  { selector: "#plugin-discovery-token summary", click: true },
  { selector: "#provider-api-key", value: "at-storybook-pat" },
  click("Configure plugins"),
];

const pluginDiscoveryGap =
  "The real Create Agent controls call simulated OCC discovery routes with a dummy token. Catalog pages and policy capabilities are fixtures. This verifies UI discovery and draft JSON editing, not live plugin-service access or runtime enforcement.";

const repositoryOptionsPath =
  "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/repository-options";

const createWorkspaceFields: StoryAction[] = [
  ...form,
  { selector: ".launch-advanced summary", click: true },
  { selector: "#agent-name", value: "Workspace seed demo" },
  { selector: "#agent-model", value: "gpt-5.6-sol" },
  ...createModelSecret("storybook-model-api-key"),
  {
    selector: "#workspace-IDENTITY-md",
    value:
      "# IDENTITY.md - Who Am I?\n\n- **Name:** Demo Agent\n- **Creature:** Console familiar\n- **Vibe:** Calm and precise\n- **Emoji:** 🦀\n",
  },
  { selector: "#workspace-USER-md", value: "" },
];

const createProvisioningSecrets: StoryAction[] = [
  ...readyForm,
  { selector: "#agent-name", value: "Slack research assistant" },
  click("Configure Slack"),
  { selector: "#slack-dm-policy", value: "disabled" },
  { selector: "#slack-secret-slack-app-token", value: "sec_demo_slack_app_token" },
  ...createSlackBotSecret,
  { selector: "#slack-channel-ids-search", value: "CDEMO123", key: "Enter" },
  ...allowEveryoneInSlackChannels,
  click("Apply channel settings"),
];

export const createAgentFormScenarios = {
  createNamespaceProvisioning: {
    group: "Pages/Create Agent",
    name: "Namespace still provisioning",
    path: create,
    namespaceStatus: "provisioning",
    description:
      "Create Agent in a Namespace that is still provisioning names its status above the starting points, before any Secret is asked for.",
  },
  createFormNamespaceProvisioning: {
    group: "Pages/Create Agent",
    name: "Form, Namespace still provisioning",
    path: create,
    namespaceStatus: "provisioning",
    actions: [click("Start without Preset"), { selector: "#agent-auth-method", value: "api_key" }],
    description:
      "The Create form keeps the provisioning Namespace's warning note, and says a Dedicated Agent can be created once the Namespace is ready instead of promising it deploys when created. Create Agent stays disabled, described by that line; an Embedded OpenClaw draft still saves.",
    steps: [
      "Tab to Create Agent. It takes focus and looks unavailable, described by that line; Enter, Space or a click submits nothing.",
    ],
  },
  createFormNamespaceBecomesReady: {
    group: "Pages/Create Agent",
    name: "Form, Namespace becomes ready after a failed check",
    path: create,
    namespaceStatus: "provisioning",
    namespaceRechecks: [503, "ready"],
    actions: [
      click("Start without Preset"),
      { selector: "#agent-auth-method", value: "api_key" },
      { selector: "#agent-name", value: "Release notes Agent", focus: true },
    ],
    description:
      "The open form rechecks a provisioning Namespace every 10 s while Create Agent waits for it. The first recheck fails and the next one still runs; when the Namespace reads ready, a success note takes the warning's place at the same height, so the field being typed in does not move, and Create Agent is enabled.",
    steps: [
      'Keep the caret in Agent name. Within about 20 s the warning note above the form becomes "Namespace status: Ready. Agents created here can be deployed now."',
      'Confirm Agent name did not move and keeps its text and focus, the status line reads "Dedicated Agents are provisioned and deployed when created.", and Create Agent is enabled.',
    ],
  },
  createFormNamespaceFailed: {
    group: "Pages/Create Agent",
    name: "Form, Namespace turns failed",
    path: create,
    namespaceStatus: "provisioning",
    namespaceRechecks: ["failed"],
    actions: [click("Start without Preset"), { selector: "#agent-auth-method", value: "api_key" }],
    description:
      'A Namespace that fails while the form is open never becomes ready by waiting. The next recheck shows its failed status, ends the recheck, and Create Agent stays disabled for every plan, described by "This Namespace cannot hold new Agents, so Create Agent is unavailable."',
    steps: [
      'Within about 10 s the note reads "Namespace status: Failed." and the status line says the Namespace cannot hold new Agents.',
      "Switch Harness to OpenClaw: Create Agent stays disabled. No further Namespace reads happen.",
    ],
  },
  createFormNamespaceMissing: {
    group: "Pages/Create Agent",
    name: "Form, Namespace no longer listed",
    path: create,
    namespaceStatus: "provisioning",
    namespaceRechecks: ["missing"],
    actions: [click("Start without Preset"), { selector: "#agent-auth-method", value: "api_key" }],
    description:
      "The Namespace list the form rereads no longer holds its Namespace: it was deleted, or the reader lost access. The recheck ends, the note asks for another Namespace, and Create Agent stays disabled for every plan. Start over keeps that answer.",
    steps: [
      'Within about 10 s the note reads "This Namespace is missing or you no longer have access. Choose another Namespace." and the status line reads "Create Agent is unavailable until you choose another Namespace."',
      "Switch Harness to OpenClaw: Create Agent stays disabled. Choose Start over: Creating Agents is not available, with the same note.",
    ],
  },
  createStart: {
    group: "Pages/Create Agent",
    name: "Choose a starting point",
    path: create,
    description: "Choose a Preset or start with standard defaults.",
    steps: [
      "Tab to Use Preset. It takes focus and looks unavailable; its description is the status line under the chooser, and Enter or Space does nothing until a Preset is chosen.",
    ],
  },
  createForm: {
    group: "Pages/Create Agent",
    name: "OpenAI with Codex harness",
    path: create,
    actions: form,
    description:
      "OpenAI defaults to Codex with Dedicated execution. Selecting OpenClaw starts in Embedded mode; Runtime details also offers Dedicated. No model is selected by default.",
    steps: [
      "Keep OpenAI and the Codex harness, enter a dummy API key, and select a listed model.",
      'In Configuration JSON, edit plugins.entries.codex.config.appServer: set sandbox to "workspace-write", approvalPolicy to "never", and remoteWorkspaceRoot to "/workspace/custom".',
      "Change the model, then replace the dummy credential. Confirm the selected model remains. Confirm all three edited appServer settings remain in Configuration JSON.",
      "Choose Reset template and confirm to restore the standard runtime settings for the selected model.",
      "Open Runtime details and Tab to Execution mode. With Codex it takes focus and looks unavailable, described by its hint; keys and clicks do not change it. OpenClaw makes it selectable (finding 2945).",
    ],
  },
  createNativeAdmin: {
    group: "Pages/Create Agent",
    name: "Native admin UI opt-in",
    path: create,
    nativeAdminSetup: true,
    actions: readyForm,
    description:
      "Enable native administration during the first deployment. Simulated UI proof; no runtime is deployed.",
    steps: [
      "Check Enable Native admin UI, then uncheck it. It starts off and explains the required Agent administer permission.",
      "Check it again and create the Agent. The provisioning request includes nativeAdmin: true.",
    ],
  },
  createNativeAdminSelected: {
    group: "Pages/Create Agent",
    name: "Native admin UI selected",
    path: create,
    nativeAdminSetup: true,
    actions: [...readyForm, { selector: "#native-admin", click: true }],
    description:
      "The explicit opt-in is selected before creation. The API prepares the exact Agent origin; this preview does not prove deployment or authentication.",
  },
  createNativeAdminDisabled: {
    group: "Pages/Create Agent",
    name: "Native admin UI unavailable",
    path: create,
    actions: form,
    description:
      "The installation has not enabled native admin access. The unchecked control is disabled with an explanation; Agent creation remains available.",
  },
  createSecretCreateNotPermitted: {
    group: "Pages/Create Agent",
    name: "Secret creation not permitted",
    path: create,
    actions: form,
    secretCreateNotPermitted: true,
    description:
      "The Namespace permission answer denies Secret creation. The API key Secret field still lists Create new Secret..., disabled with the reason, and its hint says to choose an existing Secret.",
    steps: [
      "Type a name no Secret has in API key Secret. Create new Secret... is listed with the access note under it and opens nothing.",
      "Open Configure Slack. Its hints say to choose existing Slack token Secrets, with no offer to create them.",
    ],
    gap: "The permission answer is simulated; the API still authorizes Secret creation.",
  },
  createSecretOperateDenied: {
    group: "Pages/Create Agent",
    name: "Secret operate not permitted",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
    ],
    secretOperateDenied: ["sec_demo_slack_backup_token"],
    description:
      "The Namespace Secret answer lists the Slack backup token as readable but not operable for this member. Each Create Agent Secret field lists it disabled with the reason and never stages it, since Agent create would refuse it. Secret operate is then granted per Secret, so a new Secret would have none: each field lists Create new Secret... disabled with the reason, and the drawer hints offer only existing Secrets.",
    steps: [
      "Type backup in Slack bot token. Slack backup token (simulated) is listed with the access note under it; choosing it stages nothing.",
      "Type a name no Secret has in Slack bot token. Create new Secret... is listed with the access note under it and opens nothing; the drawer hints say to choose existing Slack token Secrets.",
      "Close the drawer and type backup in API key Secret: the same option is listed the same way.",
    ],
    gap: "The Secret answer is simulated; the API still authorizes Agent create and the Secrets it binds.",
  },
  createRepositoryNotConfigured: {
    group: "Pages/Create Agent",
    name: "Repository access not set up",
    path: create,
    actions: form,
    repositoryNotConfigured: true,
    description:
      "An Installation without repository access: the intro offers a model and Slack, not repository access, and the Repository access card links its setup.",
  },
  createInvalidConfiguration: {
    group: "Pages/Create Agent",
    name: "Invalid Configuration JSON",
    path: create,
    actions: [
      ...readyForm,
      { selector: "#configuration-json", value: '{\n  "agents": {\n    "defaults": {,\n  }\n}' },
      click("Create Agent"),
    ],
    description:
      "Invalid JSON is reported once, under the field, with its line and column. Nothing is saved.",
  },
  createPluginsUnavailable: {
    group: "Pages/Create Agent",
    name: "Plugin discovery needs a service account credential",
    path: create,
    pluginCapabilities,
    actions: [...form, click("Configure plugins")],
    description:
      "Plugin discovery requires a selected service account Secret or an entered token with the Codex harness. Existing plugin IDs and policies stay in Plugin selections JSON.",
    steps: [
      "Click Done, open Plugin selections JSON, and enter a known plugin ID and policy.",
      "Open Configure plugins and choose the configured plugin. Change a policy, click Done, and inspect the JSON.",
    ],
    gap: "API keys do not enable this discovery flow. Enter only dummy credentials in Storybook.",
  },
  createPluginsSelectedSecret: {
    group: "Pages/Create Agent",
    name: "Discover plugins with a selected PAT Secret",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    extraSecrets: [{ id: "sec_storybook_pat", name: "Service account PAT (simulated)" }],
    actions: [
      ...form,
      { selector: "#agent-auth-method", value: "codex_pat" },
      { selector: "#provider-credential-secret", value: "sec_storybook_pat" },
      click("Configure plugins"),
    ],
    description:
      "Selecting the Secret starts catalog discovery before the picker opens, without entering a separate token.",
    steps: [
      "Choose Calendar to load its details, then click Done and select another Secret to clear the catalog.",
      "Without a selected Secret, the optional token field remains available for a preview.",
    ],
    gap: "The Secret and OCC discovery responses are simulated. This preview does not verify live provider access or Secret storage.",
  },
  createPluginsSelectedSecretDenied: {
    group: "Pages/Create Agent",
    name: "Selected PAT Secret discovery denied",
    path: create,
    pluginCapabilities,
    extraSecrets: [{ id: "sec_storybook_pat", name: "Service account PAT (simulated)" }],
    actions: [
      ...form,
      { selector: "#agent-auth-method", value: "codex_pat" },
      { selector: "#provider-credential-secret", value: "sec_storybook_pat" },
      click("Configure plugins"),
    ],
    rules: [{ suffix: "/agents/plugins", method: "POST", status: 403, code: "FORBIDDEN" }],
    description:
      "A denied discovery request explains that permission is required without exposing Secret data.",
    gap: "The Secret and denial are simulated; this preview does not verify IAM enforcement.",
  },
  createPluginsCurated: {
    group: "Pages/Create Agent",
    name: "Select Linear from the curated catalog",
    path: create,
    pluginCapabilities,
    pluginDiscoveryCredential: "none",
    pluginDiscovery: (() => {
      const linear = {
        id: "codex-plugin:linear@openai-curated-remote",
        remoteId: "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c",
        name: "Linear",
        description: "Plan and build products",
        websiteUrl: "https://linear.app/",
        privacyPolicyUrl: "https://linear.app/privacy",
        termsOfServiceUrl: "https://linear.app/terms",
        selectableWithoutTools: true,
        tools: null,
      };
      return {
        pages: {
          initial: {
            plugins: [linear],
            nextCursor: null,
            setup: {
              message:
                "This catalog does not verify workspace access, app connections, or tool availability. Configure the Agent's credentials and app access before deployment.",
              links: [
                {
                  label: "Manage workspace plugins",
                  url: "https://chatgpt.com/admin/plugins?catalog=GLOBAL",
                },
              ],
            },
          },
        },
        details: { [linear.remoteId]: linear },
      };
    })(),
    actions: [...form, click("Configure plugins")],
    description:
      "The selected Driver exposes Linear without a discovery token. Its tool inventory remains unknown.",
    steps: [
      "Choose Linear, add it, and set a default policy. Close the modal and inspect Plugin selections JSON.",
      "The catalog does not establish account access or runtime readiness; configure the Agent's actual credentials separately.",
    ],
    gap: "The catalog and provider responses are simulated. This preview does not invoke Linear or verify runtime authentication.",
  },
  createPluginsDiscovered: {
    group: "Pages/Create Agent",
    name: "Discover plugins with a service account token",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: pluginDiscoveryForm,
    description:
      "The actual form lists the first catalog page, places enableable plugins first, and keeps unavailable rows compact with reasons in popovers. Selecting a plugin loads its tools before Add becomes available.",
    steps: [
      "Expand Access and credential setup for the full Driver guidance and external help links, then collapse it. The credential/access reminder stays visible; catalog availability does not verify connections.",
      "Open the information button beside each unavailable plugin to compare its administrator, plan, or unsupported-runtime reason and help link. Escape or a click outside dismisses the popover. Choose the plugin row to see the same guidance in detail; Add stays disabled.",
      "At 390px width and both 844px and 640px height, scroll the plugin list and use Next page and Previous page. Search and pagination remain reachable while the list and details scroll within the dialog.",
      "At 1440×480, keep setup collapsed, then expand it. Scroll the catalog browser: plugin names remain readable, Calendar opens its details, and pagination stays reachable. Compare the Short window plugin picker story.",
      "Choose Calendar to load its tools and inspect their IDs beneath the titles, then Add Calendar. Configure its plugin defaults and expand a tool to override them.",
      "Type create into Filter tools: only Create event remains, and the caret stays after the text. Clear it to restore the other tools. Search plugins for Documents before visiting its catalog page, then clear the query.",
      "Click Done and expand Plugin selections JSON: one heading labels a bounded monospace editor. Replacing the dummy token or authentication method clears discovery results and preserves selections.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPluginsPrefetch: {
    group: "Pages/Create Agent",
    name: "Preload plugins after entering a service account token",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: pluginDiscoveryForm.slice(0, -1),
    description:
      "Entering the dummy service account token starts the first catalog request while Configure plugins stays closed.",
    steps: [
      "Open Configure plugins after the background request completes. Calendar appears without another first-page request.",
      "Close the picker, replace the dummy token, and reopen it. The new credential gets a fresh catalog; previous selections remain.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPluginsSearchLoading: {
    group: "Pages/Create Agent",
    name: "Plugin search loading",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: [
      ...pluginDiscoveryForm,
      { selector: 'button[aria-label="Calendar"]', focus: true },
      { selector: "#plugin-search", value: "Documents", focus: true },
    ],
    rules: [{ suffix: "/agents/plugins", method: "POST", skip: 1, hold: true }],
    description:
      "Search shows a loading state immediately while waiting for the debounce and held catalog request, without a no-results message.",
    steps: [
      "Confirm the search field keeps Documents and its focus while the catalog indicates that results are loading.",
      "Type another query while loading. The field remains usable and the obsolete search is canceled.",
      "Close the picker to cancel the request. Reset the story before the simulated request reaches its timeout to capture the pending state again.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPluginsToolsLoading: {
    group: "Pages/Create Agent",
    name: "Plugin tools loading",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: [...pluginDiscoveryForm, { selector: 'button[aria-label="Calendar"]', click: true }],
    rules: [{ suffix: "/agents/plugins/details", method: "POST", hold: true }],
    description:
      "Selecting Calendar shows a pending tool lookup instead of reporting that its tools are unavailable. Add stays disabled until details arrive.",
    steps: [
      "Confirm Calendar's detail panel announces loading tools and keeps Add Calendar disabled.",
      "Compare Load plugin tools for the completed result and Plugin tool discovery failed for a retryable failure.",
      "Close the picker to cancel the request. Reset the story to review the pending state again.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPluginsTools: {
    group: "Pages/Create Agent",
    name: "Load plugin tools",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: [...pluginDiscoveryForm, { selector: 'button[aria-label="Calendar"]', click: true }],
    description:
      "A details request uses the selected catalog entry's remote ID. Website, privacy policy, and terms links describe the plugin; they do not confirm account access or invocation readiness.",
    steps: [
      "Review Calendar's website and policy links without following the external destinations during fixture review.",
      "On the next page, choose Documents: only its provided website link appears. Missing privacy and terms links are omitted.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPluginsPolicies: {
    group: "Pages/Create Agent",
    name: "Configure discovered plugin policies",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: [
      ...pluginDiscoveryForm,
      { selector: 'button[aria-label="Calendar"]', click: true },
      click("Add Calendar"),
      { selector: 'select[aria-label="Calendar default reviewer"]', value: "auto" },
      {
        selector: 'details.plugin-tool-row[data-tool="app_calendar/create_event"] > summary',
        click: true,
      },
      { selector: 'select[aria-label="Create event require approval for"]', value: "all_actions" },
    ],
    description:
      "Add writes an enabled selection to the draft JSON. Plugin defaults and expanded tool overrides update the same JSON, and Done keeps those changes for Agent creation.",
    steps: [
      "Review the plugin default reviewer and Create event approval override.",
      "Collapse Create event and filter tools for Delete event. Its toggle starts with a dash for inheritance; switch it on and off without opening the row. Choose Tool policy to restore inheritance or set approval overrides.",
      "Click Done, open Plugin selections JSON, and inspect the policies. Reopen Configure plugins to continue editing.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPluginApproversMissingSecret: {
    group: "Pages/Create Agent",
    name: "Plugin approvers need a Slack bot Secret",
    path: create,
    pluginCapabilities,
    actions: [
      ...form,
      { selector: 'select[aria-label="Default plugin approvers mode"]', value: "chosen" },
    ],
    description:
      "Choose a Slack bot Secret here to search by name, or enter exact IDs. The search choice does not bind the Secret to the Agent.",
    gap: "The fixture does not prove Secret permissions or OpenClaw approval enforcement.",
  },
  createPluginApproversLookup: {
    group: "Pages/Create Agent",
    name: "Search for plugin approvers",
    path: create,
    pluginCapabilities,
    actions: [
      ...form,
      { selector: 'select[aria-label="Default plugin approvers mode"]', value: "chosen" },
      { selector: "#approver-directory-secret", value: "Slack bot token (simulated)" },
      { selector: '[aria-label="Default plugin approvers people"]', value: "Alex" },
      { selector: '[aria-label="Default plugin approvers people results"] [role="option"]' },
    ],
    description:
      "A search-only Secret resolves people by name before the Agent has a Slack channel. Select Alex Chen: their name and handle stay visible while the saved selection resolves.",
    gap: "The Secret and directory are simulated; no Slack request or permission check is made.",
  },
  createPluginsSetupReminder: {
    group: "Pages/Create Agent",
    name: "Configured plugin access reminder",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: [
      ...pluginDiscoveryForm,
      { selector: 'button[aria-label="Calendar"]', click: true },
      click("Add Calendar"),
      click("Done"),
      { selector: ".plugin-setup-reminder > summary", click: true },
    ],
    description:
      "After adding a plugin and closing the modal, the form keeps the Driver's access and credentials guidance beside the configured selections. Connection status remains unverified.",
    steps: [
      "Review the reminder before deployment: catalog availability does not confirm linked credentials, and OCE policies do not configure them.",
      "Open Plugin selections JSON and confirm that Calendar has only enabled: true; presentation links and setup guidance are not stored in selections.",
      "Reopen Configure plugins, open More actions on Calendar, choose Remove Calendar, and click Done. With no configured plugins, the reminder is hidden.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPluginsSecondPage: {
    group: "Pages/Create Agent",
    name: "Browse the next plugin page",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: [...pluginDiscoveryForm, click("Next page")],
    description:
      "Catalog pages use upstream cursors and contain up to 20 plugins. Search plugins waits 300 ms after typing, then searches the catalog from its first page. Enter and page navigation run immediately.",
    steps: [
      "Type a plugin name quickly and pause. Verify the matching catalog results appear and Previous page is disabled for the new query.",
      "Change the query and press Enter before pausing; results load immediately. Clear the query to restore the full catalog, then use Next page and Previous page.",
      "Type a new query and immediately close the dialog. Reopen it to search the retained query. Configured-plugin and tool filters update immediately without catalog requests.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPluginsEmpty: {
    group: "Pages/Create Agent",
    name: "No plugins returned",
    path: create,
    pluginDiscovery: {
      pages: { initial: { plugins: [], nextCursor: null, setup: pluginSetup } },
      details: {},
    },
    pluginCapabilities,
    actions: pluginDiscoveryForm,
    description:
      "A successful empty discovery response retains the Driver's access and credential setup guidance and is distinct from a failed request.",
    gap: pluginDiscoveryGap,
  },
  createPluginsLoading: {
    group: "Pages/Create Agent",
    name: "Plugin discovery loading",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: pluginDiscoveryForm,
    rules: [{ suffix: "/agents/plugins", method: "POST", hold: true }],
    description:
      "A pending discovery request disables duplicate loading. Editing the token clears the pending catalog and fences its eventual response.",
    gap: pluginDiscoveryGap,
  },
  createPluginsRejected: {
    group: "Pages/Create Agent",
    name: "Plugin discovery token rejected",
    path: create,
    actions: pluginDiscoveryForm,
    rules: [
      {
        suffix: "/agents/plugins",
        method: "POST",
        status: 403,
        code: "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED",
      },
    ],
    description:
      "A plugin-service credential rejection asks the operator to check the token and its permissions without treating it as an expired OCE session.",
    gap: pluginDiscoveryGap,
  },
  createPluginsError: {
    group: "Pages/Create Agent",
    name: "Plugin discovery unavailable",
    path: create,
    actions: pluginDiscoveryForm,
    rules: [
      {
        suffix: "/agents/plugins",
        method: "POST",
        status: 503,
        code: "PLUGIN_DISCOVERY_UNAVAILABLE",
      },
    ],
    description: "A failed catalog read gives a safe error and lets the operator retry.",
    gap: pluginDiscoveryGap,
  },
  createPluginsDetailsError: {
    group: "Pages/Create Agent",
    name: "Plugin tool discovery failed",
    path: create,
    pluginDiscovery,
    pluginCapabilities,
    actions: [...pluginDiscoveryForm, { selector: 'button[aria-label="Calendar"]', click: true }],
    rules: [
      {
        suffix: "/agents/plugins/details",
        method: "POST",
        status: 429,
        code: "PLUGIN_DISCOVERY_RATE_LIMITED",
      },
    ],
    description:
      "A tool-details error stays with its plugin and preserves the rest of the catalog. The operator can retry that plugin's tool lookup.",
    gap: pluginDiscoveryGap,
  },
  createPluginsConfigured: {
    group: "Pages/Create Agent",
    name: "Edit existing plugin policies",
    path: create,
    pluginCapabilities,
    actions: [
      ...form,
      { selector: ".plugin-json > summary", click: true },
      { selector: "#agent-plugins", value: pluginSelections },
      click("Configure plugins"),
      { selector: 'button[aria-label="codex-plugin:calendar@openai-curated-remote"]', click: true },
    ],
    description:
      "Plugin IDs and tool overrides entered in the existing JSON field appear in the real create-form controls without requiring catalog discovery.",
    steps: [
      "Review the configured plugin, then expand one of its saved tool overrides.",
      "Change a policy or disable a tool, click Done, and inspect Plugin selections JSON for the same change.",
      "Edit the JSON and reopen Configure plugins to confirm the controls update without losing unrelated fields.",
    ],
  },
} satisfies Record<string, CreateAgentScenario>;

export const createAgentProvisioningScenarios = {
  createProvisioningSecrets: {
    group: "Pages/Create Agent",
    name: "Provisioning with Slack Secret refs",
    path: create,
    actions: createProvisioningSecrets,
    description:
      "Codex creation submits provisioning with inline Configuration and Secret references prepared through the channel modal.",
  },
  createDeploymentPending: {
    group: "Pages/Create Agent",
    name: "Initial deployment pending",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "running",
    description:
      "Creation stays on the original provisioning request while its first deployment is running.",
    steps: [
      "Click Create Agent and confirm provisioning remains in progress.",
      "Confirm Create Agent stays disabled and the same provisioning handle is polled.",
    ],
  },
  createPending: {
    group: "Pages/Create Agent",
    name: "Create pending",
    path: create,
    rules: [{ suffix: "/agents/provision", method: "POST", hold: true }],
    actions: [...readyForm, click("Create Agent")],
    description:
      "The provisioning request is held, so Create Agent stays disabled and busy: it sets aria-busy and shows the progress pointer (finding 1961).",
    steps: ["Hover Create Agent: the pointer is progress, not not-allowed."],
    gap: "The real client gives up after 15 seconds and reports an unknown outcome, which ends the busy state; reset the story to replay it. Other controls' requests disable Create without marking it busy; the browser tests cover that, not this story.",
  },
  createDeploymentNamedWait: {
    group: "Pages/Create Agent",
    name: "Initial deployment names its wait",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "running",
    provisionedDeploymentAttempt: {
      code: "REVISION_INCOMPLETE",
      message: "Waiting for the runtime to become ready.",
    },
    provisioningNamesDeploymentWait: true,
    description:
      "After handoff the provisioning job names its first deployment's wait. Create Agent adds that sentence, the one Deployment activity shows, to the provisioning line.",
    steps: [
      "Click Create Agent. The line moves from “Provisioning Agent…” to “Provisioning Agent… Waiting for the runtime to become ready.” and Create Agent stays disabled.",
    ],
  },
  createDeploymentPodQuotaFull: {
    group: "Pages/Create Agent",
    name: "Initial deployment waits on a full Pod quota",
    path: create,
    actions: readyForm,
    // Each rule skips the first read so the quota message appears before the interruption.
    rules: [
      { pathIncludes: "/deployments/", skip: 1, hold: true, once: true },
      {
        pathIncludes: "/deployments/",
        skip: 1,
        status: 503,
        code: "DEPENDENCY_UNAVAILABLE",
        message: "A required platform dependency is unavailable.",
        once: true,
      },
      { pathIncludes: "/deployments/", skip: 1, status: 404, code: "NOT_FOUND" },
    ],
    provisionedDeploymentStatus: "running",
    provisionedDeploymentAttempt: {
      code: "NAMESPACE_POD_QUOTA_EXCEEDED",
      message:
        "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an Installation administrator to raise the quota.",
    },
    description:
      "The first deployment read explains the full Pod quota. A stalled read and a temporary outage preserve that detail; a later not-found response clears it while provisioning continues.",
    steps: [
      "Click Create Agent. Watch the Pod quota message stay in place while the next read stalls and another gets a 503.",
      "After the deployment read returns 404, the line changes to “Provisioning Agent…”. This does not say the quota cleared or the job stopped.",
    ],
  },
  createDeploymentImagePullFailed: {
    group: "Pages/Create Agent",
    name: "Initial deployment cannot pull its image",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "running",
    provisionedDeploymentAttempt: {
      code: "REVISION_IMAGE_PULL_FAILED",
      message:
        "Kubernetes cannot pull a container image for this Agent and keeps retrying. Ask an Installation administrator to check the runtime image reference and that the cluster's nodes can pull from its registry.",
    },
    provisioningNamesDeploymentWait: true,
    description:
      "The first deployment waits on a container image the cluster's nodes cannot pull. Create Agent shows that sentence alone in place of the provisioning line, as it does for a full Pod quota.",
    steps: [
      "Click Create Agent. The line changes from “Provisioning Agent…” to the image pull sentence, which asks an administrator to check the runtime image reference and registry access.",
    ],
  },
  createDeploymentSuperseded: {
    group: "Pages/Create Agent",
    name: "A newer deployment took over",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "failed",
    provisionedDeploymentError: {
      code: "REVISION_SUPERSEDED",
      message: "Deployment was superseded by a newer revision.",
    },
    description:
      "A newer deployment took over before the first was ready. The provisioning response identifies only the deployment that ended.",
    steps: [
      "Click Create Agent and wait for the message that a newer deployment took over.",
      "Confirm the message explains what happened without offering a repair, retry or deployment link.",
    ],
  },
  createDeploymentFailed: {
    group: "Pages/Create Agent",
    name: "Initial deployment failed",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "failed",
    description:
      "The original provisioning request reports its first-deployment failure and links to the existing Agent and revision.",
    steps: [
      "Click Create Agent and wait for the credential initialization failure.",
      "Open the existing Agent link; confirm the form offers no retry that would create another Agent.",
    ],
  },
  createMalformedProvisioningRevision: {
    group: "Pages/Create Agent",
    name: "Provisioning reply has an invalid version ID",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "failed",
    malformedProvisioningReply: "revision-id",
    rules: [
      {
        method: "POST",
        prefix: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/provision/",
        suffix: "/retry",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message: "The Agent lifecycle does not allow provisioning retry.",
      },
    ],
    description:
      "An accepted job reports failure with its saved Agent ID but numeric revisionId 17. The unreadable identity leaves the outcome unknown, with no version link.",
    steps: [
      "Click Create Agent. Wait for Outcome unknown; confirm Create Agent is disabled, Retry provisioning request is available, and no Agent recovery link appears.",
      "Click Retry provisioning request. The same job's /retry returns 409 because the Agent lifecycle no longer permits retry after handoff.",
      "Confirm the form enables Create Agent to resend the same request ID. Stop here: this preview does not prove that a fresh Create is safe.",
    ],
    gap: "Simulated UI proof: only the outgoing terminal status has the invalid ID. Saved Agent, version, and deployment details remain valid; the retry rule simulates the Controller's lifecycle refusal.",
  },
  createMalformedProvisioningMessage: {
    group: "Pages/Create Agent",
    name: "Provisioning failure has an unreadable message",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "failed",
    malformedProvisioningReply: "error-message",
    description:
      "The accepted job reports valid saved Agent and version IDs with a failure code but an object message. The form keeps the confirmed failure and uses plain generic text.",
    steps: [
      "Click Create Agent. Wait for Provisioning did not complete. Confirm no object text or Retry provisioning request appears, and the guidance does not suggest a new Agent.",
      "Open Agent and deployment details. Confirm the link opens the existing Agent's failed version and its recovery guidance.",
    ],
    gap: "Simulated UI proof: only the outgoing terminal error message is malformed. Deployment details retain their normal failure message; this does not prove runtime recovery.",
  },
  createProvisioningStopped: {
    group: "Pages/Create Agent",
    name: "Stopped before the first deployment",
    path: create,
    actions: readyForm,
    provisioningCancelledByStop: true,
    description:
      "Someone stopped the new Agent before its first version was admitted. Provisioning is cancelled, but the stopped Agent keeps its name, so the page links it instead of offering a new Agent.",
    steps: [
      "Click Create Agent and wait for the cancelled provisioning.",
      "Confirm the page says Provisioning stopped, asks for no new Agent, and links the kept Agent.",
    ],
  },
  createDeploymentStopped: {
    group: "Pages/Create Agent",
    name: "Initial deployment stopped",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "failed",
    provisionedDeploymentStopped: true,
    description:
      "Someone stopped the new Agent while its first deployment was rolling out. The request names the stop and asks for no repair.",
    steps: [
      "Click Create Agent and wait for the stopped first deployment.",
      "Confirm the message names the stop without asking to correct a cause, and open the existing Agent link.",
    ],
  },
  createUnsupportedProvisioning: {
    group: "Pages/Create Agent",
    name: "Unsupported provisioning",
    path: create,
    unsupportedProvisioning: true,
    actions: readyForm,
    description:
      "When the runtime does not advertise first-time Agent provisioning, Codex creation saves a draft Configuration and Agent for later deployment.",
  },
  createSlackSecretMenu: {
    group: "Pages/Create Agent",
    name: "Slack Secret menu before Agent exists",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
    ],
    description:
      "A new Agent can choose existing simulated Namespace Secrets by name or create new Slack token Secrets before the Agent resource exists.",
  },
  createSlackCreateSecretModal: {
    group: "Pages/Create Agent",
    name: "Create Slack Secret before Agent exists",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
      { selector: "#slack-secret-slack-app-token", value: "__openclaw_create_secret__" },
    ],
    description:
      "The create form opens the same modal before an Agent exists. The default simulated Secret name follows the current Agent name.",
    steps: [
      "Enter a synthetic value, then click the gray backdrop. Only Create Secret closes; the Slack editor stays open.",
      "Open Create new Secret again and confirm Value is empty. Press Escape, then cancel the Slack editor without creating an Agent.",
    ],
  },
  createSecretRequiredFields: {
    group: "Pages/Create Agent",
    name: "Create Secret required fields",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
      { selector: "#slack-secret-slack-app-token", value: "__openclaw_create_secret__" },
      click("Create Secret"),
    ],
    description:
      "Create Secret with no value: the Value field shows its error under the control and takes focus, with no browser bubble.",
  },
  createSecretRefused: {
    group: "Pages/Create Agent",
    name: "Create Secret refused",
    path: create,
    rules: [{ suffix: "/secrets", method: "POST", status: 409, code: "NAMESPACE_NOT_READY" }],
    actions: [
      ...form,
      { selector: "#agent-name", value: "Research assistant" },
      ...createModelSecret("storybook-model-api-key"),
    ],
    description:
      "Create Secret on a Namespace that is not ready: the refusal shows in the dialog and takes focus there, not on the page behind it.",
  },
  createSecretFieldsRefused: {
    group: "Pages/Create Agent",
    name: "Create Secret fields the API would refuse",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Research assistant" },
      { selector: "#provider-credential-secret", value: "__openclaw_create_secret__" },
      { selector: "#create-provider-credential-secret-name", value: "model\tkey" },
      { selector: "#create-provider-credential-secret-value", value: "to\u0000ken" },
      click("Create Secret"),
    ],
    description:
      "Create Secret with a tab in the name and a NUL in the value: each field names the API's rule under the control before any request; Name takes focus. Value is a masked multiline box, so a multiline credential is kept exactly.",
  },
  createAgentNameRefused: {
    group: "Pages/Create Agent",
    name: "Agent name the API would refuse",
    path: create,
    actions: [
      ...readyForm,
      { selector: "#agent-name", value: "Research\u2028assistant" },
      click("Create Agent"),
    ],
    description:
      "Create Agent with a line separator in the name: Agent name shows the API's Name rule and takes focus before anything is saved.",
  },
  createWorkspaceFileRefused: {
    group: "Pages/Create Agent",
    name: "Initial workspace file the API would refuse",
    path: create,
    actions: [
      ...readyForm,
      { selector: ".launch-advanced summary", click: true },
      { selector: "#workspace-AGENTS-md", value: "a".repeat(16_385) },
      { selector: ".launch-advanced summary", click: true },
      click("Create Agent"),
    ],
    description:
      "Create Agent with an AGENTS.md over 16 KiB: the check opens Advanced settings and AGENTS.md names itself and the rule under the field, with focus, before anything is saved.",
  },
  createModelSecretRequired: {
    group: "Pages/Create Agent",
    name: "Model credential Secret required",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Research assistant" },
      { selector: "#agent-auth-method", value: "codex_pat" },
      click("Create Agent"),
    ],
    description:
      "Create Agent with Service Accounts and no Secret: the error names the Service account token Secret field and the field takes focus with its list closed, so the error stays in sight.",
  },
  createSlackSecretStaged: {
    group: "Pages/Create Agent",
    name: "Slack Secret bindings staged",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
      { selector: "#slack-secret-slack-app-token", value: "sec_demo_slack_app_token" },
      ...createSlackBotSecret,
      click("Apply channel settings"),
    ],
    description:
      "Applying channel settings retains staged Slack Secret bindings for creation. There is no raw Secret bindings JSON editor; token values stay masked.",
  },
  createSlackChannelAccessRequired: {
    group: "Pages/Create Agent",
    name: "Slack channel sender required",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
      { selector: "#slack-channel-ids-search", value: "CDEMO123", key: "Enter" },
      click("Apply channel settings"),
    ],
    description:
      "The create drawer requires explicit channel user IDs or the everyone checkbox before channel settings can be applied.",
  },
  createSlackAllowEveryone: {
    group: "Pages/Create Agent",
    name: "Slack allow everyone",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
      { selector: "#slack-channel-ids-search", value: "CDEMO123", key: "Enter" },
      ...allowEveryoneInSlackChannels,
      click("Apply channel settings"),
    ],
    description:
      'The create drawer stores users: ["*"] on the selected channel while leaving direct-message allowFrom out of the new draft.',
  },
  createPresetWorkspaceFiles: {
    group: "Pages/Create Agent",
    name: "Preset workspace files",
    path: create,
    presetWorkspaceFiles: {
      "IDENTITY.md": "# Identity\nName: {{ vars.name }}\n",
      "USER.md": "",
    },
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      { selector: "#preset-variable-name", value: "Workspace preset example" },
      click("Use Preset"),
      { selector: ".launch-advanced summary", click: true },
    ],
    description:
      "The Preset renders IDENTITY.md and explicitly clears USER.md. Omitted files keep the ordinary defaults; these are editable creation-time copies.",
  },
  createWorkspaceFiles: {
    group: "Pages/Create Agent",
    name: "Workspace files",
    path: create,
    actions: createWorkspaceFields,
    description:
      "The creation form seeds AGENTS.md, SOUL.md, IDENTITY.md, and USER.md before the Agent's first deployment. Clearing a field creates an empty file.",
  },
  createPresetMultiline: {
    group: "Pages/Create Agent",
    name: "Multiline Preset strings",
    path: create,
    presetVariables: {
      notes: {
        type: "string",
        default: "# Notes\r\n- First instruction\r\n- Second instruction\r\n",
      },
    },
    presetWorkspaceFiles: { "USER.md": "{{ vars.notes }}" },
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      { selector: "#preset-variable-name", value: "Multiline preset example" },
    ],
    description:
      "String variables accept multiple lines. An untouched CRLF default retains its original value; editing uses the browser's LF text.",
  },
  createPresetMultilineApplied: {
    group: "Pages/Create Agent",
    name: "Multiline Preset applied",
    path: create,
    presetVariables: {
      notes: {
        type: "string",
        default: "# Notes\r\n- First instruction\r\n- Second instruction\r\n",
      },
    },
    presetWorkspaceFiles: { "USER.md": "{{ vars.notes }}" },
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      { selector: "#preset-variable-name", value: "Multiline preset example" },
      click("Use Preset"),
      { selector: ".launch-advanced summary", click: true },
    ],
    description:
      "Use Preset preserves the line structure in the editable workspace copy. Workspace textareas follow the existing LF submission contract; no Agent is created by this story.",
  },
  createDedicatedOpenclaw: {
    group: "Pages/Create Agent",
    name: "OpenAI with dedicated OpenClaw",
    path: create,
    credentialSourceTypes: modelCredentialSourceTypes,
    actions: dedicatedOpenclawForm,
    description:
      "Dedicated OpenClaw uses the same Agent creation form as Codex. The simulated Installation has the default runtime's native worker support and a model Credential Source catalog. Its selected dummy Secret is registered before provisioning; the Harness receives a placeholder.",
    steps: [
      "Confirm the Harness is OpenClaw and Execution mode is Dedicated.",
      "Open the Slack editor, then cancel it. Channel controls remain available for dedicated OpenClaw.",
      "Select Embedded, then return to Dedicated. Confirm the Harness remains OpenClaw.",
      "Create the Agent and follow simulated provisioning to Agent details. Open Configuration and confirm the snapshot shows Dedicated execution and the OpenClaw Harness.",
    ],
  },
  createSharedModelProviderSource: {
    group: "Pages/Create Agent",
    name: "Authorize shared model destination",
    path: create,
    credentialSourceTypes: modelCredentialSourceTypes,
    actions: readyForm,
    description:
      "Enter destination authorization for the selected key. This does not change the Installation endpoint. The simulated API records the source and starts provisioning.",
    steps: [
      "Enter https://models.example.com/v1 under Authorized base url.",
      "Create the Agent and inspect the source request: config.authorized_base_url is present; config.base_url is absent.",
    ],
  },
  createSharedModelProviderRefusal: {
    group: "Pages/Create Agent",
    name: "Destination authorization refusal",
    path: create,
    credentialSourceTypes: modelCredentialSourceTypes,
    credentialRegistrationOutcome: "invalid-config",
    actions: readyForm,
    description:
      "The first source request receives a simulated destination mismatch. Check registration to confirm absence, then correct authorization and retry. Uncertain writes remain locked until checked.",
    steps: [
      "Select the simulated model Secret and enter https://other.example.com/v1.",
      "Create the Agent, then choose Check credential registration.",
      "Correct the authorization to https://models.example.com/v1 and retry.",
    ],
  },
  createDedicatedCodexCredentialSource: {
    group: "Pages/Create Agent",
    name: "Codex with model Credential Source",
    path: create,
    credentialSourceTypes: modelCredentialSourceTypes,
    actions: readyForm,
    description:
      "The same model Secret picker and Credential Gateway guidance apply to dedicated Codex. Creating the Agent registers its model source before guided provisioning.",
    steps: [
      "Confirm the API-key Secret picker remains available and its guidance explains credential registration.",
      "Create the Agent and follow simulated provisioning. Its saved authentication uses a Credential Source.",
    ],
  },
  createCredentialRegistrationUnknown: {
    group: "Pages/Create Agent",
    name: "Model credential registration outcome unknown",
    path: create,
    credentialSourceTypes: modelCredentialSourceTypes,
    credentialRegistrationOutcome: "ready",
    actions: [...dedicatedOpenclawForm, click("Create Agent")],
    description:
      "The registration response is unavailable after the simulated Credential Source becomes ready. The form preserves the model Secret and asks the operator to check registration before retrying.",
    steps: [
      "Select Check credential registration. The saved source is found ready and Create Agent becomes available.",
      "Create the Agent and confirm the source is reused, with no new model Secret or registration.",
    ],
  },
  createCredentialRegistrationMismatch: {
    group: "Pages/Create Agent",
    name: "Registration response identifies a different source",
    path: create,
    credentialSourceTypes: modelCredentialSourceTypes,
    credentialRegistrationOutcome: "different-source",
    actions: dedicatedOpenclawForm,
    description:
      "The simulated registration succeeds, but its response identifies another source in the same Namespace.",
    steps: [
      "Select Create Agent. The form asks you to check registration and does not start provisioning.",
      "Select Check credential registration. The form finds the requested source and lets you continue without registering it again.",
    ],
  },
  createCredentialRegistrationCleanup: {
    group: "Pages/Create Agent",
    name: "Remove failed model credential registration",
    path: create,
    credentialSourceTypes: modelCredentialSourceTypes,
    credentialRegistrationOutcome: "deleting",
    actions: [
      ...dedicatedOpenclawForm,
      click("Create Agent"),
      click("Check credential registration"),
    ],
    description:
      "An uncertain registration leaves a visible deleting source. Creation stays blocked until its gateway copy is removed; the model Secret remains saved for the next registration.",
    steps: [
      "Remove failed credential registration is a red-edged destructive button: it deletes the registration at once. Select it and confirm that the model Secret remains saved.",
      "Create the Agent again. A fresh source registration uses the same model Secret before provisioning.",
    ],
  },
  createEmbedded: {
    group: "Pages/Create Agent",
    name: "Embedded OpenClaw",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
    ],
    description:
      "Selecting OpenClaw defaults to Embedded, keeping OpenClaw and its model credential together in the Gateway. Unsupported channel editing remains disabled.",
  },
  createOpenclawWithoutNativeWorkers: {
    group: "Pages/Create Agent",
    name: "OpenClaw without native worker support",
    path: create,
    nativeWorkerSupport: false,
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
    ],
    description:
      "This simulated Installation cannot admit dedicated OpenClaw: it has no Sandbox Driver that can provision it, or its runtime lacks native worker support. OpenClaw defaults to Embedded execution, which works only when no Sandbox Driver is selected; Dedicated is disabled with an explanation.",
    steps: [
      "Confirm Dedicated is unavailable for OpenClaw and the explanation names the missing Sandbox Driver or runtime support.",
      "Read the Harness hint: it names Codex for Dedicated execution without repeating the reason under Runtime details.",
      "Select Codex and confirm Dedicated remains available.",
    ],
  },
  createOpenclawNoExecutionMode: {
    group: "Pages/Create Agent",
    name: "OpenClaw with no usable execution mode",
    path: create,
    nativeWorkerSupport: false,
    openclawExecutionModes: [],
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
    ],
    description:
      "This Sandbox Driver refuses Embedded OpenClaw and cannot provision Dedicated OpenClaw. The form explains why neither mode is available, disables Create Agent, and does not promise to save a draft.",
    steps: [
      "Look for “Execution mode unavailable” in Runtime details. Both modes and Create Agent are disabled; there is no “saved as drafts” message.",
      "Select Codex and confirm the alert clears and Dedicated remains available.",
    ],
  },
  createOpenclawSettingRefusal: {
    group: "Pages/Create Agent",
    name: "OpenClaw refused by Sandbox Driver settings",
    path: create,
    nativeWorkerSupport: false,
    openclawExecutionModes: [],
    openclawSettingRefusal: openShellUserNamespacesRefusal,
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
    ],
    description:
      "This simulated Sandbox Driver refuses Embedded OpenClaw, and its settings refuse Dedicated OpenClaw. The alert quotes the refusal, which names the setting and suggests Codex, because Codex can still be selected.",
    steps: [
      "Confirm the alert names kubernetes.userNamespaces and ends with “Select Codex, or ask an operator to set it.”",
      "Select Codex and confirm the alert clears.",
    ],
  },
  createOpenclawSettingRefusalAnthropic: {
    group: "Pages/Create Agent",
    name: "OpenClaw refused by Sandbox Driver settings, Anthropic",
    path: create,
    nativeWorkerSupport: false,
    openclawExecutionModes: [],
    openclawSettingRefusal: openShellUserNamespacesRefusal,
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: "#model-provider", value: "anthropic" },
      { selector: ".launch-runtime summary", click: true },
    ],
    description:
      "As above, with Anthropic, which hides Codex. The alert keeps the setting requirement but drops “Select Codex”, and names the switch to OpenAI instead.",
    steps: [
      "Confirm the alert names kubernetes.userNamespaces, does not say “Select Codex”, and ends with “Choose OpenAI with the Codex harness, or ask an operator to change that setting.”",
    ],
  },
  createOpenclawSandboxDriverOutage: {
    group: "Pages/Create Agent",
    name: "OpenClaw during a Sandbox Driver outage",
    path: create,
    nativeWorkerSupport: false,
    openclawExecutionModes: [],
    sandboxDriverUnavailable: true,
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
    ],
    description:
      "This simulated Installation's selected Sandbox Driver is unavailable right now, so Agent save answers 503 for every harness until the driver returns. The alert says Agents cannot be created for now and to reload, not that an administrator must select another Sandbox Driver. Create Agent stays disabled for OpenClaw and Codex.",
    steps: [
      "Confirm the alert says the Sandbox Driver is unavailable right now and Create Agent is disabled.",
      "Select Codex and confirm the alert stays and Create Agent stays disabled.",
    ],
  },
  createOpenclawSandboxDedicated: {
    group: "Pages/Create Agent",
    name: "OpenClaw on a Sandbox Driver installation",
    path: create,
    openclawExecutionModes: ["dedicated"],
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
    ],
    description:
      "This simulated Installation selects a Sandbox Driver that provisions dedicated OpenClaw. It refuses Embedded execution, so selecting OpenClaw preselects Dedicated and disables Embedded.",
  },
  createDedicatedOpenclawExperimental: {
    group: "Pages/Create Agent",
    name: "Experimental Dedicated OpenClaw",
    path: create,
    nativeWorkerSupport: "custom-image",
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
      { selector: "#execution-mode", value: "dedicated" },
    ],
    description:
      "The simulated Installation declares custom-image native worker support. Dedicated OpenClaw displays its experimental status and runtime-build compatibility requirement before deployment.",
    gap: "This simulated form does not verify that a selected OpenClaw runtime image includes native worker-inference support.",
  },
  createRepositoriesSelected: {
    group: "Pages/Create Agent",
    name: "Repositories using the Agent default",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: 'input[data-repository-ref="application"]', click: true },
      { selector: 'input[data-repository-ref="handbook"]', click: true },
      { selector: "#repository-default-git-read", click: true },
    ],
    description:
      "Two approved repositories inherit Read-only access. Expand a repository header to customize its access; an explicit override stays fixed when the Agent default changes.",
    gap: "An operator supplies Namespace approvals, GitHub App configuration, credential service, compatible runtime images, and network policy. Repository grants do not change Harness filesystem or approval policy.",
  },
  createRepositoriesDetails: {
    group: "Pages/Create Agent",
    name: "Repository descriptions and selection",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: 'input[data-repository-ref="application"]', click: true },
      { selector: 'input[data-repository-ref="design-system"]', click: true },
    ],
    repositoryOptions: [
      {
        repositoryRef: "application",
        displayName: "example/application",
        description: "The application and services used by the team.",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
      {
        repositoryRef: "design-system",
        displayName: "example/design-system",
        description: "Shared components and styles for product interfaces.",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
      {
        repositoryRef: "handbook",
        displayName: "example/handbook",
        description: "Guides and operating practices for the team.",
        allowedProfiles: ["git-read"],
      },
      {
        repositoryRef: "prod-infra",
        displayName: "example/infrastructure",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
      {
        repositoryRef: "web",
        displayName: "example/web",
        description: "The public website and documentation.",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
    ],
    description:
      "Adjacent selected repositories share a highlighted surface. Descriptions are optional; select or clear a repository with its checkbox or row.",
  },
  createRepositoriesDescriptionsPending: {
    group: "Pages/Create Agent",
    name: "Repository descriptions loading",
    path: create,
    actions: repositoryForm,
    repositoryDescriptionsPending: true,
    description:
      "Repository choices are usable while descriptions load. Descriptions appear without changing selections or moving focus.",
  },
  createRepositoriesHiddenCharacters: {
    group: "Pages/Create Agent",
    name: "Repository descriptions with hidden characters",
    path: create,
    actions: repositoryForm,
    repositoryOptions: [
      {
        repositoryRef: "application",
        displayName: "example/application",
        description: "Release notes \u202etxt.exe, zero\u200bwidth and \u2066isolate\u2069 end",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
      {
        repositoryRef: "handbook",
        displayName: "example/handbook",
        description: "Guías del equipo · Ελληνικά · Русский · עברית",
        allowedProfiles: ["git-read"],
      },
      {
        repositoryRef: "team",
        displayName: "example/team",
        description:
          "Team \u{1f468}\u200d\u{1f469}\u200d\u{1f467} \u{1f3f3}\ufe0f\u200d\u{1f308} " +
          "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f} " +
          "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 \u0915\u094d\u200d\u0937, " +
          "joined A\u200dB, stray \u200d\u200djoiners",
        allowedProfiles: ["git-read"],
      },
    ],
    description:
      "The picker shows bidi controls and stray joiners as escapes. It preserves a single joiner between letters, marks, or symbols, and the England, Scotland, and Wales flag sequences. In the Team row, the joiner between A and B is present even if it looks like plain AB.",
  },
  createRepositoriesContributor: {
    group: "Pages/Create Agent",
    name: "Contributor access and write limits",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: 'input[data-repository-ref="application"]', click: true },
      { selector: "#repository-default-git-full", click: true },
      { selector: ".repository-customize summary", click: true },
      { selector: "#repository-default-issues", click: true },
    ],
    description:
      "Customize Contributor access to turn off issue management while keeping push and pull request access. The Contributor description and collapsed summary retain that restriction.",
  },
  createRepositoriesCollaborator: {
    group: "Pages/Create Agent",
    name: "Contributor access and write limits",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: 'input[data-repository-ref="application"]', click: true },
      { selector: "#repository-default-git-full", click: true },
    ],
    description:
      "Contributor also creates and manages issues. GraphQL can permit merges and branch changes within the installation token grant; the Git push allowlist does not constrain GraphQL.",
  },
  ...Object.fromEntries<CreateAgentScenario>(
    [1, 5, 25, 140].map((count): [string, CreateAgentScenario] => [
      `createRepositories${count}`,
      {
        group: "Pages/Create Agent",
        name: `${count} approved repositories`,
        path: create,
        actions: repositoryForm,
        repositoryOptions: Array.from({ length: count }, (_, index) => ({
          repositoryRef: `repository-${String(index + 1).padStart(3, "0")}`,
          displayName: `example/${index === count - 1 && count > 1 ? "a-long-repository-name-for-mobile-review" : `repository-${String(index + 1).padStart(3, "0")}`}`,
          allowedProfiles: ["git-read", "git-write", "git-full"],
        })),
        description:
          count <= 5
            ? "A small catalog shows selectable approved repositories and their references. Access inherits the Agent default."
            : "Search and six initial repository choices keep a large catalog bounded. Browse all uses pages of twenty; selected repositories have their own access settings.",
      },
    ]),
  ),
  createRepositoriesExactSearch: {
    group: "Pages/Create Agent",
    name: "Exact repository names before prefix matches",
    path: create,
    actions: [...repositoryForm, { selector: "#repository-search", value: "application" }],
    repositoryOptions: repositorySearchOptions,
    description:
      "Search a short repository name. Exact names appear first with their owners visible, followed by prefixes and substrings. Press Enter to add the first match; the query stays available for another addition.",
  },
  createRepositoriesNoMatches: {
    group: "Pages/Create Agent",
    name: "Repository search with no matches",
    path: create,
    actions: [...repositoryForm, { selector: "#repository-search", value: "unknown/repository" }],
    repositoryOptions: repositorySearchOptions,
    description:
      "An approved catalog search with no matches directs users to their Namespace operator. Search for application to return to matching repositories.",
  },
  createRepositoriesLocaleSearch: {
    group: "Pages/Create Agent",
    name: "Locale-stable repository search",
    path: create,
    actions: [...repositoryForm, { selector: "#repository-search", value: "ibm" }],
    repositoryOptions: [
      {
        repositoryRef: "IBM-platform",
        displayName: "acme/platform",
        allowedProfiles: ["git-read", "git-write", "git-full"],
      },
      {
        repositoryRef: "handbook",
        displayName: "acme/handbook",
        allowedProfiles: ["git-read"],
      },
      ...["api", "docs", "infrastructure", "mobile"].map((name) => ({
        repositoryRef: name,
        displayName: `acme/${name}`,
        allowedProfiles: ["git-read", "git-write", "git-full"],
      })),
    ],
    description:
      "Search matching uses stable casing, so ibm finds the approved IBM-platform reference even when its display name does not contain the query.",
    steps: [
      "Confirm that searching for ibm leaves acme/platform visible.",
      "Select acme/platform and confirm IBM-platform appears as the selected repository reference.",
    ],
    gap: "Simulated UI proof only; this preview does not verify GitHub App access or repository credential delivery.",
  },
  createRepositoriesCustom: {
    group: "Pages/Create Agent",
    name: "Custom access survives default changes",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: 'input[data-repository-ref="application"]', click: true },
      { selector: '[aria-label="Access for example/application"]', click: true },
      { selector: "#repository-inherit-application", click: true },
      { selector: "#repository-default-git-read", click: true },
      { selector: 'input[data-repository-ref="handbook"]', click: true },
    ],
    description:
      "The application keeps custom Contributor access while the handbook inherits Read-only. The broader exception remains explicit beside the default.",
  },
  createRepositoriesPolicyConflict: {
    group: "Pages/Create Agent",
    name: "Repair a restricted repository",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: 'input[data-repository-ref="handbook"]', click: true },
    ],
    description:
      "A repository restricted to Read-only remains expanded. The operator must explicitly repair the selection before saving.",
  },
  createRepositoriesEmpty: {
    group: "Pages/Create Agent",
    name: "No approved repositories",
    path: create,
    actions: repositoryForm,
    repositoryOptions: [],
    description:
      "An empty approved catalog directs users to their Namespace operator and permits a draft without repositories.",
  },
  createRepositoriesLoading: {
    group: "Pages/Create Agent",
    name: "Repository discovery pending",
    path: create,
    actions: form,
    rules: [{ path: repositoryOptionsPath, hold: true }],
    description: "Creation waits for repository discovery. Reset to replay the pending read.",
  },
  createRepositoriesUnavailable: {
    group: "Pages/Create Agent",
    name: "Repository choices unavailable",
    path: create,
    actions: repositoryForm,
    rules: [
      {
        path: repositoryOptionsPath,
        status: 503,
        code: "REPOSITORY_OPTIONS_UNAVAILABLE",
      },
    ],
    description:
      "Unavailable repository choices show administrator setup guidance and allow a draft without repositories.",
    steps: [
      "Read the setup guidance and open Set up repository access to review the operator procedure.",
      "Confirm no Retry repository choices button appears, then save a draft without repositories.",
    ],
    gap: "Simulated UI proof only; this preview does not configure a GitHub App or verify repository access.",
  },
  createRepositoryNavigationOutage: {
    group: "Pages/Create Agent",
    name: "Keep repository choices through an outage",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Repository assistant" },
      { selector: "#repository-application", click: true },
      { selector: "#repository-profile-git-full", click: true },
    ],
    rules: [
      {
        path: repositoryOptionsPath,
        skip: 1,
        once: true,
        status: 503,
        code: "REPOSITORY_OPTIONS_UNAVAILABLE",
      },
    ],
    description:
      "A failed refresh retains repository selections while blocking Create until current choices can be checked.",
    steps: [
      "Open Agents, then Create Agent. Discovery fails and reports that selections are retained.",
      "Retry repository choices. The application repository and Contributor access return selected.",
    ],
    gap: "Simulated UI proof only; this walkthrough does not create an Agent or contact GitHub.",
  },
  createRepositoriesDenied: {
    group: "Pages/Create Agent",
    name: "Repository discovery denied",
    path: create,
    actions: repositoryForm,
    rules: [{ path: repositoryOptionsPath, status: 403 }],
    description: "Denied Agent-create authorization blocks both Configuration and Agent writes.",
  },
  createRepositoriesAmbiguous: {
    group: "Pages/Create Agent",
    name: "Repository authorization unverified",
    path: create,
    actions: repositoryForm,
    rules: [{ path: repositoryOptionsPath, status: 503 }],
    description:
      "A generic dependency failure cannot establish authorization. The form blocks creation and offers retry.",
  },
  createRepositoriesRecovery: {
    group: "Pages/Create Agent",
    name: "Reselect repositories after rejection",
    path: create,
    unsupportedProvisioning: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message:
          "The selected Compute Driver cannot deliver repository credentials to this Harness topology.",
        once: true,
      },
    ],
    actions: [
      ...repositoryForm,
      { selector: 'input[data-repository-ref="application"]', click: true },
      { selector: "#repository-default-git-full", click: true },
      { selector: ".repository-customize summary", click: true },
      { selector: "#repository-default-issues", click: true },
      click("Create Agent"),
      click("Reload repository choices"),
    ],
    description:
      "A rejected save retains its Configuration. Reload clears stale choices; retry requires a current repository and access level. Starting a new draft explicitly leaves repository-scoped recovery.",
  },
  createRosterModelSelection: {
    group: "Pages/Create Agent",
    name: "Change a roster's shared primary model",
    path: create,
    modelFallbackSelection: true,
    modelRosterSelection: true,
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      click("Use Preset"),
    ],
    description:
      "Model ID changes the shared primary in defaults and matching explicit roster entries, preserving local policies and ordered fallbacks. Inherited model selections stay omitted. Simulated UI proof; no deployment or model request occurs.",
    steps: [
      "Change Model ID from primary-model to replacement-model, then leave the field.",
      "Open Advanced settings. Configuration JSON has the new primary in defaults, main and assistant; inherited has no model field.",
      "Clear Model ID and enter another-model. Local aliases, parameters and ordered fallbacks remain, and unreferenced old provider rows are retired.",
    ],
  },
  createModelFallbackSelection: {
    group: "Pages/Create Agent",
    name: "Choose an existing fallback as primary",
    path: create,
    modelFallbackSelection: true,
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      click("Use Preset"),
      { selector: "#agent-model", value: "fallback-one" },
      { selector: ".launch-advanced summary", click: true },
    ],
    description:
      "Changing the primary removes the unused old model and preserves the ordered fallback references, their model metadata and the existing transport. Simulated UI proof; no model request is executed.",
    steps: [
      "Inspect Configuration JSON: primary is openai/fallback-one; the directory contains fallback-one and fallback-two.",
      "Choose fallback-two as primary. Both referenced model entries and their saved aliases/parameters remain.",
      "Clear the Model ID, then enter another-model. Existing fallback metadata remains while the new primary is added.",
    ],
  },
  createPreset: {
    group: "Pages/Create Agent",
    name: "Preset variables",
    path: create,
    actions: [{ selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" }],
    description:
      "A reusable template with required and defaulted variables. Use Preset copies values into an editable draft. With a Preset chosen, Use Preset is the filled button and Start with default Preset is secondary.",
    steps: [
      'Under Start with default Preset, the hint reads "The default Preset is default-codex."',
      "Use Preset is filled and Start with default Preset is secondary. Choose Choose a Preset in Preset template: the filled style returns to Start with default Preset.",
    ],
    gap: "Preset CRUD has no console page; the fixture supplies a pre-existing Preset.",
  },
  createPresetExistingSecret: {
    group: "Pages/Create Agent",
    name: "Standard Codex existing Secret",
    path: create,
    standardCodexPreset: true,
    extraSecrets: [{ id: "sec_devday_model_token", name: "Codex API key (simulated)" }],
    actions: [
      ...existingPresetSecret,
      { selector: "#preset-variable-modelSecret-existing-secret", value: "sec_devday_model_token" },
    ],
    description:
      "The standard Codex Preset reuses this Namespace Secret without reading its value; Create Agent grants access.",
    gap: "Secret metadata and API responses are simulated. This does not validate a real API key.",
  },
  createPresetSecretsLoading: {
    group: "Pages/Create Agent",
    name: "Preset Secrets loading",
    path: create,
    standardCodexPreset: true,
    actions: existingPresetSecret,
    rules: [{ path: presetSecretsPath, hold: true }],
    description:
      "Existing Secret selection waits for metadata. Users can explicitly switch to creating a new Secret.",
  },
  createPresetSecretsDenied: {
    group: "Pages/Create Agent",
    name: "Preset Secret metadata denied",
    path: create,
    standardCodexPreset: true,
    actions: existingPresetSecret,
    rules: [{ path: presetSecretsPath, status: 403 }],
    description:
      "Denied Secret metadata prevents existing selection. New-token entry remains available through an explicit mode change.",
  },
  createPresetSecretsEmpty: {
    group: "Pages/Create Agent",
    name: "No existing Preset Secrets",
    path: create,
    standardCodexPreset: true,
    emptySecrets: true,
    actions: existingPresetSecret,
    description:
      "An empty Namespace Secret catalog requires creating a new Secret or returning after a Secret is available.",
  },
  createNativePluginsUnrestricted: {
    group: "Pages/Create Agent",
    name: "Native plugins without an allowlist",
    path: create,
    standardOpenclawPreset: true,
    nativePluginSettings: nativePlugins,
    actions: nativePluginForm,
    description:
      "Harness switches preserve an omitted native plugin allowlist and configured entries.",
    steps: nativePluginSteps,
    gap: "Simulated UI proof; no plugin is loaded or model turn executed.",
  },
  createNativePluginsAllowlist: {
    group: "Pages/Create Agent",
    name: "Native plugins with an allowlist",
    path: create,
    standardOpenclawPreset: true,
    nativePluginSettings: { ...nativePlugins, allow: ["knowledge", "openai"] },
    actions: nativePluginForm,
    description:
      "A restrictive allowlist is preserved. Selecting Codex does not silently grant permission; existing server admission decides at creation.",
    steps: nativePluginSteps,
    gap: "Simulated UI proof; no plugin is loaded or model turn executed.",
  },
  createNativePluginsEmptyAllowlist: {
    group: "Pages/Create Agent",
    name: "Native plugins with an empty allowlist",
    path: create,
    standardOpenclawPreset: true,
    nativePluginSettings: { ...nativePlugins, allow: [] },
    actions: nativePluginForm,
    description: "An explicitly authored empty array remains unrestricted in both Harnesses.",
    steps: nativePluginSteps,
    gap: "Simulated UI proof; no plugin is loaded or model turn executed.",
  },
  createNativePluginsCodexRoundTrip: {
    group: "Pages/Create Agent",
    name: "Codex allowlist round-trip",
    path: create,
    standardCodexPreset: true,
    actions: [...passwordPresetForm, { selector: ".launch-advanced summary", click: true }],
    description: "The shipped Codex Preset keeps its codex-only allowlist across Harness switches.",
    steps: [
      'Inspect plugins.allow, switch to OpenClaw, then back to Codex. The list stays ["codex"] throughout. OpenClaw uses existing provider admission without an additional editor restriction.',
    ],
    gap: "Simulated UI proof; no plugin is loaded or model turn executed.",
  },
  createNativePluginsDenyConflict: {
    group: "Pages/Create Agent",
    name: "Codex denied by native policy",
    path: create,
    standardOpenclawPreset: true,
    nativePluginSettings: { ...nativePlugins, deny: ["codex"] },
    actions: [...nativePluginForm, { selector: "#agent-harness", value: "codex" }],
    // This story simulates the first server refusal; admission is not implemented in the preview.
    rules: [
      {
        suffix: "/agents/validate",
        method: "POST",
        once: true,
        status: 400,
        code: "INVALID_REQUEST",
        message:
          "Configuration setting plugins.deny must not list codex: Dedicated Codex runs the codex plugin, so its Gateway would not start. Remove that item.",
      },
    ],
    description:
      "Selecting Codex preserves the denylist. Existing server admission refuses the denial on creation.",
    steps: [
      "Try Create Agent. Edit Configuration JSON to deliberately remove the codex denial, or select OpenClaw.",
    ],
    gap: "Simulated UI proof; no plugin is loaded or model turn executed.",
  },
  createNativePluginsDisabledEntry: {
    group: "Pages/Create Agent",
    name: "Codex explicitly disabled in Configuration",
    path: create,
    standardOpenclawPreset: true,
    nativePluginSettings: {
      ...nativePlugins,
      allow: ["knowledge", "openai", "codex"],
      entries: { ...nativePlugins.entries, codex: { enabled: false } },
    },
    actions: nativePluginForm,
    description:
      "An explicit disabled Codex entry survives Harness switches. Existing admission accepts it because the runtime overlay enables the required plugin.",
    steps: [
      "Inspect plugins.entries.codex.enabled: false, switch to Codex, then OpenClaw and back. The explicit setting remains false.",
      "Select Create Agent without repairing the entry. The simulated workflow starts provisioning; actual runtime enablement is not shown by this preview.",
    ],
    gap: "Simulated UI proof; no plugin is loaded or model turn executed.",
  },
  createStandardOpenclawPreset: {
    group: "Pages/Create Agent",
    name: "Standard OpenClaw preset",
    path: create,
    standardOpenclawPreset: true,
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      { selector: "#preset-variable-name", value: "OpenClaw assistant" },
      { selector: "#preset-variable-model", value: "gpt-5.1" },
      { selector: "#preset-variable-modelSecret", value: "storybook-model-key" },
      click("Use Preset"),
    ],
    description:
      "The shipped standard-openclaw Preset uses the OpenClaw harness with a masked model API key. Review its native configuration before creation.",
    gap: "All credentials and API responses in this preview are simulated.",
  },
  createPasswordPreset: {
    group: "Pages/Create Agent",
    name: "Standard Codex password variable",
    path: create,
    standardCodexPreset: true,
    actions: [{ selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" }],
    description:
      "The shipped Preset asks for Name, Model, and a masked Model Secret. No Namespace or Secret ID is needed.",
    steps: [
      "Enter a name, model ID, and a dummy model key.",
      "Use Preset and review the masked API key and restricted configuration.",
      "Create Agent saves a same-Namespace Secret before provisioning.",
    ],
    gap: "All credentials and API responses in this preview are simulated.",
  },
  createPasswordPresetOperateSome: {
    group: "Pages/Create Agent",
    name: "Standard Codex, Secret operate on some Secrets",
    path: create,
    standardCodexPreset: true,
    secretOperateDenied: ["sec_demo_slack_backup_token"],
    actions: [{ selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" }],
    description:
      "The Namespace Secret answer lists the Slack backup token as readable but not operable, so this member's Secret operate is granted per Secret and a new Secret would have none. Secret source lists Create new Secret disabled with the reason and starts on Use existing Secret, which lists the backup token disabled too.",
    steps: [
      "Open Secret source for Model Secret: Create new Secret is disabled, and the hint under the existing Secret list gives the reason.",
      "Choose another Secret and select Use Preset: the form opens with that Secret bound.",
    ],
    gap: "The Secret answer is simulated; the API still authorizes Agent create and the Secrets it binds.",
  },
  createPasswordPresetMissingModel: {
    group: "Pages/Create Agent",
    name: "Standard Codex missing model",
    path: create,
    standardCodexPreset: true,
    actions: passwordPresetForm.filter((action) => action.selector !== "#preset-variable-model"),
    description:
      "Use Preset with an empty Model stops at the required Model field. Variables with defaults stay optional.",
    gap: "All credentials and API responses in this preview are simulated.",
  },
  createPresetRequiredFields: {
    group: "Pages/Create Agent",
    name: "Preset required fields",
    path: create,
    standardCodexPreset: true,
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      click("Use Preset"),
    ],
    description:
      "Use Preset with every variable empty: each field shows its own error under the control, linked to it, and focus moves to Name. The browser's validation bubble never shows.",
    gap: "All credentials and API responses in this preview are simulated.",
  },
  createPasswordPresetDraft: {
    group: "Pages/Create Agent",
    name: "Standard Codex password draft",
    path: create,
    standardCodexPreset: true,
    actions: passwordPresetForm,
    description:
      "The password remains masked in the editable draft; Configuration JSON contains no model key. There is no raw Secret bindings JSON editor.",
  },
  presetVariableNavigation: {
    group: "Pages/Create Agent",
    name: "Keep Preset variables",
    path: create,
    standardCodexPreset: true,
    actions: passwordPresetForm.slice(0, -1),
    description:
      "Preset variable edits and Secret reference choices survive navigation. New token bytes clear.",
    steps: [
      "Open Agents, then Create Agent. Check the retained name/model and cleared token.",
      "Reenter a dummy token, then Use Preset to continue.",
    ],
    gap: "Simulated UI proof only.",
  },
  createPresetNavigation: {
    group: "Pages/Create Agent",
    name: "Keep an unsaved Preset draft",
    path: create,
    standardCodexPreset: true,
    actions: passwordPresetForm,
    description:
      "Unsaved settings remain in memory while navigating the Console. Password inputs clear when leaving the form. Start over explicitly discards the draft.",
    steps: [
      "Rename the Agent and edit a workspace file under Advanced settings.",
      "Open Namespaces, then use browser Back and Forward to revisit both pages.",
      "Open Agents and Create Agent: the edited draft returns with an empty API key field.",
      "Select Start over, cancel once, then confirm. Navigate away and return to see the fresh Preset chooser.",
    ],
    gap: "Simulated UI proof only; this walkthrough does not save or deploy an Agent.",
  },
  createPasswordSecretConflict: {
    group: "Pages/Create Agent",
    name: "Password Secret conflict recovery",
    path: create,
    standardCodexPreset: true,
    actions: [...passwordPresetForm, click("Create Agent")],
    rules: [
      {
        suffix: "/secrets",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message:
          "A Secret with this name already exists in this Namespace. Choose a different name.",
        once: true,
      },
    ],
    description:
      "A confirmed duplicate model Secret keeps the draft and offers deliberate existing Secret selection or a separate new Secret name.",
    steps: [
      "Change Agent name after the conflict: the old collision notice clears without a write. Reset to exercise the recovery choices.",
      "Choose existing Secret and select a readable model credential. Confirm the Agent name, model and other draft fields remain.",
      "Reset the story. Use another Secret name, submit spaces, then a name longer than 255 characters. Both stop at field validation. Correct the name and create the Agent.",
      "Reset the story. Tab from the collision notice through both choices. Use another Secret name focuses its input. Switch Authentication method to ChatGPT OAuth: recovery and its required input disappear. Switch back: no stale choice returns.",
    ],
    gap: "Simulated UI proof; native controller browser tests exercise duplicate rejection and recovery.",
  },
  createPasswordSecretConflictPat: {
    group: "Pages/Create Agent",
    name: "Secret conflict restores plugin discovery",
    path: create,
    standardCodexPreset: true,
    pluginDiscovery,
    pluginCapabilities,
    actions: [
      ...passwordPresetForm,
      { selector: "#agent-auth-method", value: "codex_pat" },
      { selector: "#provider-api-key", value: "at-storybook-pat" },
      { selector: "#agent-model", value: "gpt-5.1" },
      click("Create Agent"),
      click("Choose existing Secret"),
      { selector: "#plugin-discovery-token summary", click: true },
    ],
    rules: [
      {
        suffix: "/secrets",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message:
          "A Secret with this name already exists in this Namespace. Choose a different name.",
        once: true,
      },
    ],
    description:
      "Choosing an existing Secret restores the normal optional service account token for plugin discovery.",
    steps: [
      "Enter a dummy token, then open Configure plugins. Select a Secret deliberately before creating the Agent.",
    ],
    gap: pluginDiscoveryGap,
  },
  createPasswordSecretConflictOAuth: {
    group: "Pages/Create Agent",
    name: "Secret conflict cleared for OAuth",
    path: create,
    standardCodexPreset: true,
    actions: [
      ...passwordPresetForm,
      click("Create Agent"),
      click("Use another Secret name"),
      { selector: "#agent-auth-method", value: "credential_source" },
    ],
    rules: [
      {
        suffix: "/secrets",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message:
          "A Secret with this name already exists in this Namespace. Choose a different name.",
        once: true,
      },
    ],
    description:
      "Switching the refused password draft to OAuth clears the Secret collision choices and required alternate name. Returning to API key requires fresh credentials without restoring the collision.",
    gap: "Simulated UI proof; native fixtures cover the actual duplicate refusal and keyboard recovery.",
  },
  createPresetVariableRefused: {
    group: "Pages/Create Agent",
    name: "Refused setting filled by a Preset variable",
    path: create,
    ...presetVariableRefusal,
    actions: presetVariableRefused,
    description:
      "Create Agent's preflight refuses gateway.auth.trustedProxy.allowUsers, which the Preset variable Human filled. The refusal keeps the API's sentence, names the variable and offers Change Human.",
    steps: ["Select Change Human: the Preset step opens with Human marked and focused."],
    gap: "The preflight refusal is simulated; tests/browser/console-agent-presets.test.ts covers it with the real Kubernetes Compute rules.",
  },
  createPresetQuotedSettingRefused: {
    group: "Pages/Create Agent",
    name: "Refused quoted setting filled by a Preset variable",
    path: create,
    ...presetQuotedSettingRefusal,
    actions: presetQuotedSettingRefused,
    description:
      'Create Agent\'s preflight refuses agents.defaults.models["openai/gpt 5 mini"], a key the Preset variable Fallback filled. The API quotes the key; the refusal still names the variable and offers Change Fallback.',
    steps: ["Select Change Fallback: the Preset step opens with Fallback marked and focused."],
    gap: "The preflight refusal is simulated; tests/browser/console-agent-presets.test.ts covers it with the real model policy rules.",
  },
  createPresetVariableMarked: {
    group: "Pages/Create Agent",
    name: "Preset variable marked after a refusal",
    path: create,
    ...presetVariableRefusal,
    actions: [...presetVariableRefused, click("Change Human")],
    description:
      "Change Human reopens the Preset with the entered variables kept, except the model key. Human shows the refusal under it and has focus.",
    steps: [
      "Type in Human: the refusal clears.",
      "Enter the model key again and select Use Preset to return to the form.",
    ],
    gap: "The preflight refusal is simulated; tests/browser/console-agent-presets.test.ts covers it with the real Kubernetes Compute rules.",
  },
  createPasswordPresetDenied: {
    group: "Pages/Create Agent",
    name: "Password Secret creation denied",
    path: create,
    standardCodexPreset: true,
    denySecretCreate: true,
    actions: [...passwordPresetForm, click("Create Agent")],
    description:
      "Missing Secret create permission leaves the draft available with its password masked. No Agent is created.",
  },
  createDefaultPresetLoading: {
    group: "Pages/Create Agent",
    name: "Loading default Preset",
    path: create,
    rules: [{ path: presetSecretsPath.replace(/secrets$/, "presets"), hold: true }],
    description: "Quick-start waits for the authorized Namespace Preset list.",
  },
  createDefaultPresetDenied: {
    group: "Pages/Create Agent",
    name: "Default Preset access denied",
    path: create,
    rules: [{ path: presetSecretsPath.replace(/secrets$/, "presets"), status: 403 }],
    description:
      "Denied Preset access leaves quick-start disabled and reports the error. Start without Preset remains available as a separate action.",
    steps: [
      "Tab to Start with default Preset. It takes focus and looks unavailable, described by the Presets unavailable status; Enter, Space or a click does nothing.",
    ],
  },
  createPresetInvalidField: {
    group: "Pages/Create Agent",
    name: "Preset with an invalid field",
    path: create,
    presetAgent: { executionMode: "turbo" },
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      { selector: "#preset-variable-name", value: "Codex assistant" },
      click("Use Preset"),
    ],
    description:
      "The Preset API saves launch-field errors such as an unknown execution mode. Use Preset names the first field the form cannot use and keeps the chooser open.",
    gap: "The fixture edits a simulated Preset; Preset CRUD has no console page.",
  },
  createCapabilitiesDenied: {
    group: "Pages/Create Agent",
    name: "Permission check failed",
    path: create,
    actions: form,
    rules: [
      { path: "/installation", status: 403, code: "FORBIDDEN" },
      { suffix: "/permissions", status: 503, code: "DEPENDENCY_UNAVAILABLE" },
    ],
    description:
      "The Installation read is refused and the Namespace permission read failed, so whether this caller may create Agents is unknown. Create Agent stays disabled, a warning above the form says the permission check failed, and its Retry permission check rereads only the permission answer: a grant continues as Member with Agent create, a denial replaces the form with the refusal a fresh load shows. Repository access reads no choices until the answer allows Agent create.",
    steps: [
      'Above the form, the "Your access" warning reads "Your permissions in this Namespace could not be checked"; the hint under the form fields is empty.',
      'Repository access reads "Repository choices load after your permission check." and offers no retry.',
      "Retry permission check is the warning's action; the fixture keeps failing the read, so the text stays.",
    ],
    gap: "The member creation browser tests cover a retry that grants and one that refuses Agent create.",
  },
  createPermissionRetryDenied: {
    group: "Pages/Create Agent",
    name: "Permission retry refuses Agent create",
    path: create,
    actions: [...form, click("Retry permission check")],
    rules: [
      { path: "/installation", status: 403, code: "FORBIDDEN" },
      { suffix: "/permissions", status: 503, code: "DEPENDENCY_UNAVAILABLE", once: true },
      {
        suffix: "/permissions",
        data: {
          agents: { create: false },
          secrets: { create: false },
          installation: { administer: false },
        },
      },
    ],
    description:
      "The Installation read is refused and the first Namespace permission read failed. Retry permission check then answers that this caller may not create Agents: the form is replaced by the refusal a fresh load shows. Repository access never read its choices.",
    steps: [
      'The page shows "Creating Agents is not available" with the access reason, and no form or start choices.',
    ],
    gap: "The story presses Retry permission check from a script, so focus stays on the page heading. The member creation browser test presses it, checks that the refusal takes focus, and counts repository reads and audited denials against the real API.",
  },
  createMember: {
    group: "Pages/Create Agent",
    name: "Member with Agent create",
    path: create,
    actions: form,
    rules: [{ path: "/installation", status: 403, code: "FORBIDDEN" }],
    description:
      "A member whose Namespace grants Agent create cannot read the Installation. The form goes on: an info status above it says why, the badge names the Preset, and Create Agent stays available; the API still decides at the preflight and at create.",
    steps: [
      'Above the form, "Your access" says you can create Agents in Engineering and that an Installation administrator then gives the new Agent access to its Secrets.',
      'The form starts with the badge "From Preset · default-codex", and no mid-form note asks for Installation access.',
    ],
    gap: "The member creation browser test uses a member account and the real Installation permission check.",
  },
  createMemberGrantRefused: {
    group: "Pages/Create Agent",
    name: "Member Agent created, grant needs an administrator",
    path: create,
    observabilityDenied: true,
    actions: [...readyForm, click("Create Agent")],
    rules: [{ path: "/installation", status: 403, code: "FORBIDDEN" }],
    description:
      "The session already knows this member does not administer the Installation, so after the Agent saves the form sends no IAM read for its credential grant. It names the administrator step at once and offers Open saved Agent, with no Retry credential access.",
    steps: [
      "Read the alert: giving the Agent access to its Secrets needs Installation administration, so it asks an Installation administrator to open the saved Agent and grant it.",
      "The saved-resources line identifies the Configuration and Agent, offers Open saved Agent, and does not promise a retry.",
      "The request log shows no /iam/ request. Only Cancel and Start over remain beside the saved-resources line.",
    ],
  },
  createRestricted: {
    group: "Pages/Create Agent",
    name: "Create Agent unavailable for this caller",
    path: create,
    readOnlyPermissionSummary: true,
    description:
      "Opened by URL, Create Agent refuses up front when the permission summary says this caller cannot create an Agent here. The API still decides.",
  },
  createCapabilitiesError: {
    group: "Pages/Create Agent",
    name: "Capability check failure",
    path: create,
    actions: form,
    rules: [{ path: "/installation", status: 503, code: "DEPENDENCY_UNAVAILABLE" }],
    description:
      "A transient capability-read failure keeps Create Agent disabled and offers Retry capability check.",
  },
  createNoPresets: {
    group: "Pages/Create Agent",
    name: "No Presets",
    path: create,
    emptyPresets: true,
    description:
      "The default starter is unavailable until an administrator installs a readable Preset. Start without Preset opens an independent form.",
    steps: [
      "Tab to Start with default Preset. It takes focus and looks unavailable, described by the hint under it, “default-codex is not available to you in this Namespace.” Enter, Space or a click does nothing (finding 2937).",
    ],
  },
  createNoDefaultPreset: {
    group: "Pages/Create Agent",
    name: "Other Presets, no default",
    path: create,
    noDefaultPreset: true,
    description:
      "Another Preset is readable, but default-codex is not. The chooser's status says “Choose a Preset.” and the hint under Start with default Preset says why the shortcut is unavailable, once (finding 2946).",
    steps: [
      "Tab to Use Preset. It is described by “Choose a Preset.” Then Tab to Start with default Preset. It is described by the hint, “default-codex is not available to you in this Namespace.”",
    ],
  },
  createWithoutPreset: {
    group: "Pages/Create Agent",
    name: "Start without Preset",
    path: create,
    emptyPresets: true,
    actions: [click("Start without Preset")],
    description: "Create an editable Agent draft independently of a saved Preset.",
    steps: ["Enter an Agent name, choose a model and credential, and review the Configuration."],
    gap: "The fixture simulates API responses and does not verify deployment.",
  },
  createBoundCredentialPreset: {
    group: "Pages/Create Agent",
    name: "Preset with saved model credential",
    path: create,
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      { selector: "#preset-variable-name", value: "Preset credential demo" },
      { selector: "#preset-variable-model", value: "codex/gpt-5.1" },
      click("Use Preset"),
    ],
    description:
      "The saved API-key credential fixes the provider. Models and compatible harnesses remain editable; JSON cannot redirect the credential to another provider.",
  },
  createAnthropic: {
    group: "Pages/Create Agent",
    name: "Anthropic with OpenClaw harness",
    path: create,
    actions: [
      ...form,
      { selector: "#model-provider", value: "anthropic" },
      ...createModelSecret("storybook-anthropic-key"),
    ],
    description:
      "Anthropic offers only the OpenClaw harness, with Embedded execution. Authentication method stays clickable with Anthropic API key as its only option. Its fixed model list is available before credential entry and starts without a selection.",
    steps: [
      "Open Authentication method and select Anthropic API key. It remains clickable even though it is the only available method.",
      "Confirm the selected model credential Secret stays selected after choosing the authentication method.",
    ],
  },
  createCodexPat: {
    group: "Pages/Create Agent",
    name: "Service Accounts",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-auth-method", value: "codex_pat" },
      ...createModelSecret("at-storybook-pat"),
    ],
    description:
      "Service Accounts authentication is available with the Codex harness and uses the same fixed OpenAI model list. Switching to OpenClaw selects API-key authentication and clears the credential and model selection.",
  },
  createOAuth: {
    group: "Pages/Create Agent",
    name: "ChatGPT OAuth before sign-in (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    pluginDiscovery,
    pluginCapabilities,
    actions: oauthForm,
    description:
      "Experimental login for a dedicated Codex Agent. The limitations notice stays visible throughout login and recovery. The model picker remains available; credentials never enter the browser.",
  },
  createOAuthPending: {
    group: "Pages/Create Agent",
    name: "ChatGPT device login pending (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    oauthPending: true,
    actions: startOAuthLogin,
    description:
      "The user code and provider link are visible while authorization is pending. Cancel login removes this staged login locally.",
  },
  createOAuthStartNavigation: {
    group: "Pages/Create Agent",
    name: "ChatGPT sign-in interrupted by navigation (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    rules: [{ suffix: "/device-authorizations", method: "POST", hold: true }],
    actions: oauthForm,
    description:
      "Start sign-in, navigate to Secrets, and return with Back. The retained attempt blocks a second start and asks an administrator to investigate. The fixture holds the response; it does not prove provider persistence.",
  },
  createOAuthReady: {
    group: "Pages/Create Agent",
    name: "ChatGPT login ready for plugin discovery (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    pluginDiscovery,
    pluginCapabilities,
    actions: startOAuthLogin,
    description:
      "The fixture completes login after one poll. Agent creation includes the source in both Harness authentication and its credentialSources list. No access or refresh token appears in this preview.",
    steps: [
      "Wait for ChatGPT login ready, then open Configure plugins and add Calendar.",
      "Choose a model and create the Agent. Deployment is simulated; credential-service delivery is not proved here.",
    ],
  },
  createOAuthDenied: {
    group: "Pages/Create Agent",
    name: "ChatGPT login permission denied (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    rules: [{ suffix: "/device-authorizations", method: "POST", status: 403 }],
    actions: startOAuthLogin,
    description:
      "A denied authorization request leaves the form usable and does not create a browser credential.",
  },
  createOAuthUnavailable: {
    group: "Pages/Create Agent",
    name: "ChatGPT login unavailable (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    rules: [
      {
        suffix: "/device-authorizations",
        method: "POST",
        status: 501,
        code: "NOT_IMPLEMENTED",
        message:
          "Device login needs a Credential Gateway and a Credential Refresh Driver, and this Installation does not select both. Ask an Installation administrator to select them; see the credential lifecycle guide.",
      },
    ],
    actions: startOAuthLogin,
    description:
      "The Credential Gateway offers device login, but the Installation selects no Credential Refresh Driver. The refused start names the API's reason, and Sign in with OAuth stays unavailable, described by it. No device code or sign-in link appears.",
  },
  createOAuthNotOffered: {
    group: "Pages/Create Agent",
    name: "ChatGPT login not offered by the Drivers (Experimental)",
    path: create,
    credentialSourceTypes: modelCredentialSourceTypes,
    actions: oauthForm,
    description:
      "The Installation's Credential Gateway offers no ChatGPT device login. Sign in with OAuth is unavailable before any request: Tab reaches it, it is described by the reason, and Enter sends nothing.",
  },
  createOAuthStartUnconfirmed: {
    group: "Pages/Create Agent",
    name: "ChatGPT sign-in start unconfirmed (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    rules: [{ suffix: "/device-authorizations", method: "POST", bodyError: true }],
    actions: oauthForm,
    description:
      "Choose Sign in with OAuth. The simulated response is interrupted after its headers, so the Console cannot tell whether sign-in started. Switch authentication methods and return: a second sign-in stays unavailable.",
  },
  createOAuthError: {
    group: "Pages/Create Agent",
    name: "ChatGPT login exchange failed (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    rules: [{ suffix: "/poll", method: "POST", status: 503 }],
    actions: startOAuthLogin,
    description:
      "A failed poll stops polling. Cancel the staged login and connect again; the console does not retry an uncertain exchange.",
  },
  createOAuthExpired: {
    group: "Pages/Create Agent",
    name: "ChatGPT device login expired (Experimental)",
    path: create,
    credentialSourceTypes: deviceLoginSourceTypes,
    oauthExpired: true,
    actions: startOAuthLogin,
    description:
      "An expired device code cannot be used to create the Agent. Cancel it and sign in again.",
  },
} satisfies Record<string, CreateAgentScenario>;

export const createAgentOutcomeScenarios = {
  createPatToOpenClaw: {
    group: "Pages/Create Agent",
    name: "Switch from Service Accounts to OpenClaw",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-auth-method", value: "codex_pat" },
      ...createModelSecret("at-storybook-pat"),
      { selector: "#agent-model", value: "gpt-5.6-sol" },
      { selector: "#agent-harness", value: "openclaw" },
    ],
    description:
      "Switching an unsaved service account form to OpenClaw clears the token and model, selects API-key authentication, and defaults to Embedded execution. Review the selected authentication before continuing.",
  },
  createBoundPatPreset: {
    group: "Pages/Create Agent",
    name: "Preset with saved service account token",
    path: create,
    presetAuth: "codex_pat",
    actions: [
      { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
      { selector: "#preset-variable-name", value: "Preset Service Accounts demo" },
      click("Use Preset"),
    ],
    description:
      "A Preset with a saved service account token keeps its OpenAI provider and Codex harness fixed because the credential requires Codex. Start without a Preset to choose OpenClaw with an API key.",
  },
  createModels: {
    group: "Pages/Create Agent",
    name: "Model choices before credential entry",
    path: create,
    actions: form,
    description:
      "The fixed model list is available before entering a credential and starts with Choose a model. No model is selected by default.",
    steps: [
      "Choose a model before entering a dummy API key. Confirm the selection remains after entering or replacing the key.",
      "Change the provider to Anthropic and inspect its model list. The previous provider's model and credential are cleared.",
    ],
  },
  createModelManual: {
    group: "Pages/Create Agent",
    name: "Enter another model ID",
    path: create,
    actions: [
      ...form,
      click("Enter model ID manually"),
      { selector: "#agent-model-manual", value: "custom-model-id" },
    ],
    description:
      "Enter an explicit model ID when it is absent from the fixed list. The credential must have access to that model; the Console does not verify access.",
    steps: [
      "Select Choose a model from the list. Confirm the custom ID is cleared and Choose a model is selected, then select a listed model.",
      "Select Enter model ID manually again. Confirm Model ID keeps the selected model and receives focus. Edit it to another listed model, then return to the list and confirm that model is selected.",
      "Repeat the switch and edit Model ID to an ID outside the list. Return to the list and confirm a new selection is required; credentials and other form values remain.",
      "Under Advanced settings, edit Configuration JSON to use an anthropic/ model. Select Choose a model from the list and confirm it offers Anthropic models.",
    ],
  },
  createSecretDenied: {
    group: "Pages/Create Agent",
    name: "API key storage denied",
    path: create,
    actions: readyForm,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets",
        method: "POST",
        status: 403,
      },
    ],
    description:
      "A rejected Secret write keeps the creation dialog open and does not create a Configuration or Agent.",
  },
  createGrantDenied: {
    unsupportedProvisioning: true,
    group: "Pages/Create Agent",
    name: "Credential access retry",
    path: create,
    actions: [...readyForm, click("Create Agent")],
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/iam/access-bindings",
        method: "POST",
        status: 403,
        once: true,
      },
    ],
    description:
      "The Agent is saved but its Secret grant failed. Retry credential access reuses the same Agent and Secret.",
  },
  createInvalid: {
    group: "Pages/Create Agent",
    name: "Invalid JSON",
    path: create,
    actions: [
      ...readyForm,
      { selector: ".launch-advanced summary", click: true },
      { selector: "#configuration-json", value: "[]" },
      click("Create Agent"),
    ],
    description: "Client validation rejects a non-object Configuration before saving.",
  },
  createConflict: {
    group: "Pages/Create Agent",
    name: "Provisioning conflict",
    path: create,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/provision",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        // The API's catch-all conflict names nothing to act on, so the Console keeps its own text.
        message: "The requested platform resource already exists.",
        once: true,
      },
      // The first Namespace check after the refusal fails; the refused draft survives it.
      { path: "/namespaces", skip: 1, status: 503, code: "DEPENDENCY_UNAVAILABLE", once: true },
    ],
    actions: [...readyForm, click("Create Agent")],
    description:
      "Provisioning admission conflicts before any separate Configuration save. The refusal replaces the submitting status and takes focus. Edit the request and retry from the same draft.",
    steps: [
      "Select the Agents link: the simulated Namespace check fails once. Select Retry.",
      "Choose Create Agent: the refused form returns with its name, model, and Secret.",
    ],
  },
  createRefusalReason: {
    group: "Pages/Create Agent",
    name: "Provisioning refusal with a reason",
    path: create,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/provision",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message:
          "Dedicated OpenClaw requires a provisioning SandboxDriver with networking, filesystem, and process containment. Select a codex/<model> model with agentRuntime.id codex, or ask an Installation administrator for such a SandboxDriver.",
        once: true,
      },
    ],
    actions: [...dedicatedOpenclawForm, click("Create Agent")],
    description:
      "The Installation lost its provisioning Sandbox Driver after the form loaded. The API refuses dedicated OpenClaw with a 409 that names the missing Driver, and the Console shows that reason instead of an unknown outcome.",
    steps: [
      "Confirm the refusal names the missing Sandbox Driver and no Retry provisioning request button appears.",
      "Choose Codex, or Embedded execution if the installation selects no Sandbox Driver, then create the Agent again.",
    ],
  },
  createPreflightTimeout: {
    group: "Pages/Create Agent",
    name: "Configuration check timed out",
    path: create,
    unsupportedProvisioning: true,
    rules: [{ suffix: "/agents/validate", method: "POST", hold: true, once: true }],
    actions: readyForm,
    description: "The first configuration check stays pending until the Console stops waiting.",
    steps: [
      "Select Create Agent. After 15 seconds, the timeout message takes focus and the button is available again.",
      "Select Create Agent again to check the same entries and continue creating the draft.",
    ],
  },
  createNameTaken: {
    group: "Pages/Create Agent",
    name: "Agent name taken",
    path: create,
    unsupportedProvisioning: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/validate",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message:
          "An Agent with this name already exists in this Namespace. Choose a different name.",
        once: true,
      },
    ],
    actions: [...readyForm, { ...click("Create Agent"), focus: true }],
    description:
      "Another Agent in this Namespace has the name. The configuration check refuses it before anything is saved: the refusal line keeps the API's sentence, the Agent name field shows a short error under it and takes focus.",
    steps: [
      "Confirm focus is in Agent name, the field reads Another Agent in this Namespace has this name. under it, and no Secret or Configuration saved line shows.",
      "Type another name: the field error clears. Select Create Agent again; the Agent is created.",
    ],
    gap: "The refusal is simulated; tests/integration/occ-api.test.mjs and tests/browser/console-agents-2.test.ts cover the API's preflight.",
  },
  createPluginPreflightRefusal: {
    group: "Pages/Create Agent",
    name: "Plugin refusal before anything is saved",
    path: create,
    unsupportedProvisioning: true,
    pluginCapabilities,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/validate",
        method: "POST",
        status: 400,
        code: "INVALID_REQUEST",
        message: pluginPreflightRefusal,
        once: true,
      },
    ],
    actions: [
      ...readyForm,
      { selector: ".plugin-json > summary", click: true },
      { selector: "#agent-plugins", value: pluginSelections },
      // Pressed as a person would, so focus starts on the button that disables.
      { ...click("Create Agent"), focus: true },
    ],
    description:
      "Create Agent asks the API first whether it would refuse the plugin selections with this Configuration. The API refuses: the Configuration denies every tool of the selected plugin. Nothing is saved, so the refusal is the only line, takes focus in view, and every field stays editable, the Configuration JSON included.",
    steps: [
      "At 360-390 px, confirm the focused refusal is on screen with no Secret or Configuration saved line and no sideways scroll.",
      "Open Configuration JSON under Advanced settings and confirm it is editable, then select Create Agent again; the Agent is created.",
    ],
    gap: "The refusal is simulated; the in-memory API's preflight is covered by tests/browser/console-agent-plugin-refusals.test.mjs and tests/integration/agent-create-validate-api.test.mjs.",
  },
  createPluginRefusal: {
    group: "Pages/Create Agent",
    name: "Plugin refusal after the Configuration is saved",
    path: create,
    unsupportedProvisioning: true,
    pluginCapabilities,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents",
        method: "POST",
        status: 400,
        code: "INVALID_REQUEST",
        message: pluginToolRefusal,
        once: true,
      },
    ],
    actions: [
      ...readyForm,
      { selector: ".plugin-json > summary", click: true },
      { selector: "#agent-plugins", value: pluginSelections },
      // Pressed as a person would, so focus starts on the button that disables.
      { ...click("Create Agent"), focus: true },
    ],
    description:
      "Agent create refuses after the form saved its Configuration, as on a retry, which has no preflight: the Configuration denies every tool of the selected plugin. The refusal leads the saved-resources line, scrolls into view with focus, wraps its setting path at phone widths, and names the fix this form allows: deselect the plugin.",
    steps: [
      "At 360-390 px, confirm the focused refusal is on screen above the Secret and Configuration saved line, with no sideways scroll.",
      "Clear Plugin selections JSON to {} and select Create Agent again; the Agent is created.",
    ],
    gap: "The refusal is simulated; the in-memory API's plugin check is covered by tests/browser/console-agent-plugin-refusals.test.mjs.",
  },
  createUnknown: {
    group: "Pages/Create Agent",
    name: "Provisioning outcome unknown",
    path: create,
    rules: [
      {
        prefix: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/provision/",
        method: "GET",
        status: 503,
      },
    ],
    actions: [...readyForm, click("Create Agent")],
    description:
      "The create request was accepted, but provisioning status is temporarily unavailable. Refresh and inspect saved state.",
  },
} satisfies Record<string, CreateAgentScenario>;
