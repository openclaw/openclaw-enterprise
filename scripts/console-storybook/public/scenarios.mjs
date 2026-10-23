const draft =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=draft";
const revision =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=rev_00000000-0000-4000-8000-000000000001";
const currentVersion =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=rev_00000000-0000-4000-8000-000000000006";
const candidateVersion =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=rev_00000000-0000-4000-8000-000000000007";
// A SOUL.md long enough to scroll; its first line names the version that serves it.
const soulVersion = (version) =>
  `# SOUL.md served by ${version}\n\n` +
  Array.from(
    { length: 40 },
    (_, index) => `Line ${index + 1}: keep answers short and cite the files you used.\n`,
  ).join("");
const create = "/console/agents/new?namespace=ns_00000000-0000-4000-8000-000000000001";
const click = (text) => ({ click: text });
const runtimeLogsPage = {
  group: "Pages/Agent detail",
  path: `${candidateVersion}&tab=logs`,
  deployed: true,
  candidateDeploymentStatus: "succeeded",
};
const refuseLogRead = { suffix: "/runtime/logs", status: 403, code: "FORBIDDEN" };
const form = [click("Start with default Preset")];
const oauthForm = [...form, { selector: "#agent-auth-method", value: "credential_source" }];
const startOAuthLogin = [...oauthForm, click("Sign in with OAuth")];
const reservedConfigurationWrite = {
  path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
  method: "PATCH",
  status: 409,
  code: "RESOURCE_CONFLICT",
  message:
    "The Configuration is reserved for provisioning and is not available for this operation.",
};

const createModelSecret = (value) => [
  { selector: "#provider-credential-secret", value: "__openclaw_create_secret__" },
  { selector: "#create-provider-credential-secret-value", value },
  click("Create Secret"),
];
const readyForm = [
  ...form,
  { selector: "#agent-name", value: "Research assistant" },
  { selector: "#agent-model", value: "gpt-5.6-sol" },
  ...createModelSecret("storybook-model-api-key"),
];
const modelCredentialSourceTypes = [
  {
    type: "openai",
    config: [],
    secrets: [{ name: "api_key", required: true }],
    rotation: "none",
    harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
  },
];
const dedicatedOpenclawForm = [
  ...readyForm,
  { selector: "#agent-harness", value: "openclaw" },
  { selector: ".launch-runtime summary", click: true },
  { selector: "#execution-mode", value: "dedicated" },
];
const passwordPresetForm = [
  { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
  { selector: "#preset-variable-name", value: "Codex assistant" },
  { selector: "#preset-variable-model", value: "gpt-5.1" },
  { selector: "#preset-variable-modelSecret", value: "storybook-model-key" },
  click("Use Preset"),
];
const existingPresetSecret = [
  { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
  { selector: "#preset-variable-name", value: "Codex assistant" },
  { selector: "#preset-variable-model", value: "gpt-5.1" },
  { selector: "#preset-variable-modelSecret-secret-source", value: "existing" },
];
const presetSecretsPath = "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets";
const repositoryForm = [...readyForm, { selector: "#agent-name", value: "Repository assistant" }];
// A plugin tool-deny refusal as the API words it, naming the selected plugin.
const pluginToolRefusal =
  'Configuration setting agents.entries.research_assistant.tools.deny denies every tool, so every turn of that Agent fails with plugin codex-plugin:calendar@openai-curated-remote selected; remove "*" or move the Agent to a Configuration without plugins.';
// The same refusal from Create Agent's preflight, worded as the OpenClaw Plugin Driver words it.
const pluginPreflightRefusal =
  "Configuration setting tools.deny blocks every tool of plugin codex-plugin:calendar@openai-curated-remote; remove the matching deny entry or deselect the plugin.";
const pluginCapabilities = {
  driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
  approvers: { agent: true, plugin: false, tools: false },
  toolDefaults: {
    enabled: true,
    approval: ["provider_default", "all_actions", "write_actions", "none"],
    reviewer: ["human", "auto"],
  },
  tools: {
    enabled: true,
    approval: ["provider_default", "all_actions", "write_actions", "none"],
    reviewer: [],
  },
  driverPolicySchema: {
    type: "object",
    properties: {
      destructiveEnabled: { type: "boolean", title: "Destructive tools" },
    },
    additionalProperties: false,
  },
};
const pluginSetup = {
  message:
    "App connection status is not verified. Catalog availability does not confirm linked credentials. In ChatGPT admin, select the same workspace as this credential and enable plugin and app access for its user or service account. For service-account plugin credentials, open Service accounts, choose the account, and configure its app connections. Workspace administrator access is required. OCE policies do not grant access or configure credentials. Reload plugins after changes.",
  links: [
    { label: "Manage workspace plugins", url: "https://chatgpt.com/admin/plugins?catalog=GLOBAL" },
    { label: "Service account credentials", url: "https://admin.openai.com/" },
    {
      label: "OCE plugin setup",
      url: "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/reference/drivers/plugin-bundled.md#selection-and-catalogs",
    },
  ],
};
const unavailablePlugins = [
  {
    id: "codex-plugin:archive@openai-curated-remote",
    remoteId: "plugin_demo_archive",
    name: "Archive",
    available: false,
    unavailableReason:
      "This plugin requires local components or skills that OCE hosted discovery does not support. Changing ChatGPT access will not enable it here.",
    unavailableHelp: pluginSetup.links[2],
    tools: null,
  },
  {
    id: "codex-plugin:team-chat@openai-curated-remote",
    remoteId: "plugin_demo_team_chat",
    name: "Team chat",
    available: false,
    unavailableReason:
      "Disabled by a ChatGPT workspace administrator. Ask an administrator to enable access for the user or service account behind this token.",
    unavailableHelp: pluginSetup.links[0],
    tools: null,
  },
  {
    id: "codex-plugin:analytics@openai-curated-remote",
    remoteId: "plugin_demo_analytics",
    name: "Analytics",
    available: false,
    unavailableReason:
      "This workspace's plan is not eligible for this plugin. Ask a workspace administrator to review plan availability.",
    unavailableHelp: pluginSetup.links[0],
    tools: null,
  },
];
// Names and IDs from plugin-suggestions branch commit eb83563c.
// Catalog availability and tool details are simulated in this Storybook fixture.
const codexPluginSuggestions = [
  { id: "codex-plugin:airtable@openai-curated-remote", name: "Airtable" },
  { id: "codex-plugin:asana@openai-curated-remote", name: "Asana" },
  { id: "codex-plugin:box@openai-curated-remote", name: "Box" },
  { id: "codex-plugin:canva@openai-curated-remote", name: "Canva" },
  { id: "codex-plugin:datadog@openai-curated-remote", name: "Datadog (Preview)" },
  { id: "codex-plugin:figma@openai-curated-remote", name: "Figma" },
  { id: "codex-plugin:github@openai-curated-remote", name: "GitHub" },
  { id: "codex-plugin:google-contacts@openai-curated-remote", name: "Google Contacts" },
  { id: "codex-plugin:granola@openai-curated-remote", name: "Granola" },
  { id: "codex-plugin:hubspot@openai-curated-remote", name: "HubSpot" },
  { id: "codex-plugin:quickbooks@openai-curated-remote", name: "Intuit QuickBooks" },
  { id: "codex-plugin:linear@openai-curated-remote", name: "Linear" },
  { id: "codex-plugin:monday-com@openai-curated-remote", name: "monday.com" },
  { id: "codex-plugin:notion@openai-curated-remote", name: "Notion" },
  { id: "codex-plugin:outlook-calendar@openai-curated-remote", name: "Outlook Calendar" },
  { id: "codex-plugin:outlook-email@openai-curated-remote", name: "Outlook Email" },
  { id: "codex-plugin:posthog@openai-curated-remote", name: "PostHog" },
  { id: "codex-plugin:semrush@openai-curated-remote", name: "Semrush" },
  { id: "codex-plugin:sentry@openai-curated-remote", name: "Sentry" },
  { id: "codex-plugin:sharepoint@openai-curated-remote", name: "SharePoint" },
  { id: "codex-plugin:slack@openai-curated-remote", name: "Slack" },
  { id: "codex-plugin:supabase@openai-curated-remote", name: "Supabase" },
  { id: "codex-plugin:superhuman@openai-curated-remote", name: "Superhuman Mail" },
  { id: "codex-plugin:teams@openai-curated-remote", name: "Teams" },
  { id: "codex-plugin:vercel@openai-curated-remote", name: "Vercel" },
  { id: "codex-plugin:zoom@openai-curated-remote", name: "Zoom" },
];
const linearAppId = "asdk_app_69a089a326dc8191b32a3f2553f5be2c";
const devdayCuratedEntries = codexPluginSuggestions.map((suggestion) => {
  const remoteId = suggestion.id.match(/^codex-plugin:([^@]+)@/)?.[1] ?? suggestion.id;
  return {
    ...suggestion,
    remoteId,
    available: true,
    tools:
      suggestion.id === "codex-plugin:linear@openai-curated-remote"
        ? [
            {
              id: `${linearAppId}/create_issue`,
              name: "Create issue",
              ownerId: linearAppId,
              description: "Create a Linear issue with a title, description, and team.",
            },
            {
              id: `${linearAppId}/search_issues`,
              name: "Search issues",
              ownerId: linearAppId,
              description: "Search Linear issues by text and status.",
            },
          ]
        : [],
  };
});
const pluginCatalog = {
  status: "ready",
  setup: pluginSetup,
  entries: [
    {
      id: "codex-plugin:calendar@openai-curated-remote",
      remoteId: "plugin_demo_calendar",
      name: "Calendar",
      logoUrl: "/storybook-fixtures/plugin-logos/calendar.svg",
      websiteUrl: "https://example.com/calendar",
      privacyPolicyUrl: "https://example.com/calendar/privacy",
      termsOfServiceUrl: "https://example.com/calendar/terms",
      description: "Find events and manage a team calendar.",
      available: true,
      tools: [
        {
          id: "app_calendar/list_events",
          name: "List events",
          ownerId: "app_calendar",
          description: "Find events in a calendar and date range.",
        },
        {
          id: "app_calendar/create_event",
          name: "Create event",
          ownerId: "app_calendar",
          description: "Create a calendar event with a title, time, and attendees.",
        },
        {
          id: "app_calendar/delete_event",
          name: "Delete event",
          ownerId: "app_calendar",
          description: "Remove an existing calendar event.",
        },
      ],
    },
    {
      id: "codex-plugin:documents@openai-curated-remote",
      remoteId: "plugin_demo_documents",
      name: "Documents",
      logoUrl: "/storybook-fixtures/plugin-logos/documents.svg",
      websiteUrl: "https://example.com/documents",
      available: true,
      tools: [
        {
          id: "app_documents/search_documents",
          name: "Search documents",
          ownerId: "app_documents",
        },
        {
          id: "app_documents/update_document",
          name: "Update document",
          ownerId: "app_documents",
        },
      ],
    },
    {
      id: "codex-plugin:project-tracker@openai-curated-remote",
      remoteId: "plugin_demo_project_tracker",
      name: "Project tracker",
      logoUrl: "/storybook-fixtures/plugin-logos/missing.svg",
      tools: null,
    },
    ...unavailablePlugins,
  ],
};
const pluginSelections = JSON.stringify(
  {
    "codex-plugin:calendar@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "write_actions", reviewer: "auto" },
      tools: {
        "app_calendar/create_event": { approval: "all_actions" },
        "app_calendar/delete_event": { enabled: false },
      },
    },
  },
  null,
  2,
);
// Codex offers only Agent-wide approvers. These stories reuse its catalog to show the plugin and
// tool fields that a Driver advertising them (OpenClaw) renders.
const overrideApproverCapabilities = {
  ...pluginCapabilities,
  approvers: { agent: true, plugin: true, tools: true },
};
const overrideApproverGap =
  "This is simulated UI and does not prove runtime approval authorization. The Codex Plugin Driver does not offer plugin or tool approvers; these fixtures enable them on its catalog to preview the fields.";
const pluginApproverOverrides = JSON.parse(pluginSelections);
pluginApproverOverrides["codex-plugin:calendar@openai-curated-remote"].approvers = [];
pluginApproverOverrides["codex-plugin:calendar@openai-curated-remote"].tools[
  "app_calendar/create_event"
].approvers = [{ channel: "slack", id: "team:TDEMO123:user:UDEMO124" }];
const pluginPreviewGap =
  "Catalog entries, local placeholder logos, and Driver capabilities are passed directly to the production component as Storybook fixtures. These previews do not verify PAT access, plugin availability, or runtime policy enforcement.";
const pluginDiscovery = {
  pages: {
    initial: {
      plugins: [...unavailablePlugins, { ...pluginCatalog.entries[0], tools: null }],
      nextCursor: "demo-page-2",
      setup: pluginSetup,
    },
    "demo-page-2": {
      plugins: pluginCatalog.entries.slice(1, 3).map((entry) => ({ ...entry, tools: null })),
      nextCursor: null,
      setup: pluginSetup,
    },
  },
  details: Object.fromEntries(pluginCatalog.entries.map((entry) => [entry.remoteId, entry])),
};
const devdayPluginCatalog = {
  status: "ready",
  setup: pluginSetup,
  entries: [...devdayCuratedEntries, pluginCatalog.entries[0]],
};
const devdayPluginDiscovery = {
  pages: {
    initial: {
      plugins: devdayPluginCatalog.entries.map((entry) => ({ ...entry, tools: null })),
      nextCursor: null,
      setup: pluginSetup,
    },
  },
  details: Object.fromEntries(devdayPluginCatalog.entries.map((entry) => [entry.remoteId, entry])),
};
const pluginDiscoveryForm = [
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
const account = [{ selector: ".account-toggle", click: true }];
const devdayRepositorySelector = 'input[data-repository-ref="openclaw/openclaw-enterprise"]';
const createSlackBotSecret = [
  { selector: "#slack-secret-slack-bot-token", value: "__openclaw_create_secret__" },
  { selector: "#create-slack-secret-slack-bot-token-value", value: "simulated-bot-token" },
  click("Create Secret"),
];
const allowEveryoneInSlackChannels = [{ selector: "#slack-channel-access", value: "everyone" }];
const createWorkspaceFields = [
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
const createProvisioningSecrets = [
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
const devdayCreateCheckpoint = [
  click("Create Agent"),
  { selector: "#agent-preset", value: "pre_swe_codex" },
  { selector: "#preset-variable-name", value: "devday claw" },
  click("Use Preset"),
  { selector: "#provider-credential-secret", value: "sec_devday_model_token" },
  click("Configure plugins"),
  { selector: 'button[aria-label="Linear"]', click: true },
  click("Add Linear"),
  { selector: 'select[aria-label="Linear default reviewer"]', value: "auto" },
  {
    selector:
      'details.plugin-tool-row[data-tool="asdk_app_69a089a326dc8191b32a3f2553f5be2c/create_issue"] > summary',
    click: true,
  },
  { selector: 'select[aria-label="Create issue require approval for"]', value: "all_actions" },
  click("Done"),
  { selector: devdayRepositorySelector, click: true },
  { selector: "#repository-default-git-full", click: true },
  { selector: ".repository-customize summary", click: true },
  { selector: "#repository-default-issues", click: true },
  click("Edit Slack"),
  { selector: "#slack-channel-ids-search", value: "CDEMO123", key: "Enter" },
  { selector: "#slack-channel-access", value: "selected" },
  { selector: "#slack-allowed-user-ids-search", value: "UDEMO123", key: "Enter" },
  { selector: "#slack-secret-slack-app-token", value: "sec_devday_slack_app_token" },
  { selector: "#slack-secret-slack-bot-token", value: "sec_devday_slack_bot_token" },
  click("Apply channel settings"),
  click("Create Agent"),
  { selector: ".deployment-status" },
];
const devdayAdminCheckpoint = [
  { selector: 'a[href*="agt_00000000-0000-4000-8000-000000000001"]', click: true },
  { selector: ".native-admin-access a[href]" },
];

const shareExistingPerson = [
  { selector: "#share-principal-id", value: "prn_person-demo" },
  { selector: ".agent-access-consent input", click: true },
  click("Share Agent"),
];

// Page failures use the HTTP boundary; isolated component previews receive their input state.
export const scenarios = {
  secrets: {
    group: "Pages/Secrets",
    name: "Populated",
    path: "/console/secrets",
    description:
      "The library shows names and IDs. The privacy notice explains why stored values are never returned. Simulated UI proof.",
    steps: [
      "Search by name or ID. Tab to a result and press Enter; its dialog names the Namespace and lists consumers.",
      "Create a Secret with a dummy value, replace it, then delete it. Switch Namespace to inspect isolation in navigation.",
    ],
  },
  secretsMobile: {
    group: "Pages/Secrets",
    name: "Mobile",
    path: "/console/secrets",
    mobile: true,
    description: "The Secret list and dialogs at phone width. Simulated UI proof.",
  },
  secretsSearch: {
    group: "Pages/Secrets",
    name: "No search matches",
    path: "/console/secrets",
    actions: [{ selector: '[aria-label="Search Secrets"]', value: "no-such-secret" }],
    description: "Clear the search to see the Secrets in this Namespace again.",
  },
  secretsEmpty: {
    group: "Pages/Secrets",
    name: "Empty",
    path: "/console/secrets",
    emptySecrets: true,
    description: "An authorized list without Secrets offers creation.",
  },
  secretsLoading: {
    group: "Pages/Secrets",
    name: "Loading",
    path: "/console/secrets",
    rules: [{ path: presetSecretsPath, hold: true }],
    description: "Namespace admission succeeds while the Secret list is still loading.",
  },
  secretsUnavailable: {
    group: "Pages/Secrets",
    name: "Read unavailable",
    path: "/console/secrets",
    rules: [{ path: presetSecretsPath, status: 503 }],
    description: "A failed Secret collection read shows recovery, with no stale rows.",
  },
  secretsNoNamespace: {
    group: "Pages/Secrets",
    name: "No readable Namespace",
    path: "/console/secrets",
    emptyNamespaces: true,
    description: "Secret requests require an admitted Namespace selection.",
  },
  secretsNamespaceNotReady: {
    group: "Pages/Secrets",
    name: "Namespace provisioning",
    path: "/console/secrets",
    namespaceStatus: "provisioning",
    description: "Metadata stays readable; creation and replacement wait for Namespace readiness.",
  },
  secretsCreate: {
    group: "Pages/Secrets",
    name: "Create",
    path: "/console/secrets",
    actions: [click("Create Secret")],
    description:
      "The header identifies the Namespace. The form preserves whitespace and explains that you can replace a saved value but cannot retrieve it.",
    steps: [
      "Enter a name and a dummy value. Use Show value beside the Value label, then hide it again.",
      "Press Enter from Secret name to submit. After the save, Close is the only dialog action.",
    ],
  },
  secretsMissingValue: {
    group: "Pages/Secrets",
    name: "Missing value",
    path: "/console/secrets",
    actions: [
      click("Create Secret"),
      { selector: "#secret-name", value: "Team API key" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description: "Required-value errors remain beside their field; no request is sent.",
  },
  secretsCreateDenied: {
    group: "Pages/Secrets",
    name: "Create denied",
    path: "/console/secrets",
    denySecretCreate: true,
    actions: [
      click("Create Secret"),
      { selector: "#secret-name", value: "Team API key" },
      { selector: "#secret-value", value: "synthetic-story-value" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "The API refuses creation. The form clears the value, disables editing, and focuses Close.",
  },
  secretsUnknownSave: {
    group: "Pages/Secrets",
    name: "Unknown save outcome",
    path: "/console/secrets",
    rules: [{ path: presetSecretsPath, method: "POST", bodyError: true }],
    actions: [
      click("Create Secret"),
      { selector: "#secret-name", value: "Team API key" },
      { selector: "#secret-value", value: "synthetic-story-value" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "An unreadable reply leaves an amber warning that the outcome is unknown. The value is erased and this dialog cannot resubmit.",
  },
  secretsConsumers: {
    group: "Pages/Secrets",
    name: "Consumers and restricted references",
    path: "/console/secrets",
    secretConsumers: {
      agents: ["agt_00000000-0000-4000-8000-000000000001"],
      configurations: ["cfg_00000000-0000-4000-8000-000000000001"],
      credentialSources: [],
      provisioningRequests: [],
      unreadable: 2,
      truncated: true,
    },
    actions: [click("Demo model API key (simulated)")],
    description:
      "Agent links and other consumer IDs are grouped by resource. The blue notice explains restricted visibility; the amber warning identifies an incomplete list. Simulated UI proof.",
  },
  secretsReplace: {
    group: "Pages/Secrets",
    name: "Replace value",
    path: "/console/secrets",
    actions: [click("Demo model API key (simulated)"), click("Replace value")],
    description:
      "Replacement preserves the reference and explains deployment and CredentialSource handoff. Existing values are never loaded.",
  },
  secretsReplaceDenied: {
    group: "Pages/Secrets",
    name: "Replace denied",
    path: "/console/secrets",
    rules: [{ suffix: "/secrets/sec_demo_model", method: "PATCH", status: 403, code: "FORBIDDEN" }],
    actions: [
      click("Demo model API key (simulated)"),
      click("Replace value"),
      { selector: "#secret-value", value: "synthetic-story-value" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description: "A denied replacement clears the value, disables editing, and focuses Close.",
  },
  secretsDelete: {
    group: "Pages/Secrets",
    name: "Delete confirmation",
    path: "/console/secrets",
    actions: [click("Demo model API key (simulated)"), click("Delete Secret")],
    description:
      "Permanent storage deletion requires confirmation and explains upstream revocation and previously delivered values.",
  },
  secretsDeleteConflict: {
    group: "Pages/Secrets",
    name: "Concurrent reference conflict",
    path: "/console/secrets",
    rules: [
      {
        suffix: "/secrets/sec_demo_model",
        method: "DELETE",
        status: 409,
        code: "RESOURCE_CONFLICT",
      },
    ],
    actions: [
      click("Demo model API key (simulated)"),
      click("Delete Secret"),
      click("Permanently delete Secret"),
    ],
    description:
      "A newly added reference can refuse deletion after the detail read. Reopen the detail to inspect current consumers.",
  },
  secretsDeletionUnconfirmed: {
    group: "Pages/Secrets",
    name: "Deletion could not be confirmed",
    path: "/console/secrets",
    rules: [
      { suffix: "/secrets/sec_demo_model", method: "DELETE", bodyError: true },
      {
        suffix: "/secrets/sec_demo_model",
        skip: 1,
        data: { id: "sec_different", name: "Different Secret (simulated)" },
      },
    ],
    actions: [
      click("Demo model API key (simulated)"),
      click("Delete Secret"),
      click("Permanently delete Secret"),
      click("Check deletion status"),
    ],
    description:
      "The delete response was lost, then the status check returned a different Secret. The dialog leaves the outcome unknown and offers no second Delete.",
  },

  runtimeImages: {
    group: "Pages/Navigation",
    name: "Debug runtime images",
    path: "/console/agents?debug=true",
    buildRevision: "1234567890abcdef1234567890abcdef12345678",
    runtimeImages: {
      status: "observed",
      images: [
        {
          workload: "research/agent-runtime",
          container: "gateway",
          image: "ghcr.io/example/runtime:sha-1234567890abcdef1234567890abcdef12345678",
          imageId: `sha256:${"a".repeat(64)}`,
          commit: "1234567890abcdef1234567890abcdef12345678",
          openclawCommit: "abcdef1234567890abcdef1234567890abcdef12",
        },
        {
          workload: "research/agent-runtime",
          container: "log-forwarder",
          image: "example/log-forwarder:1",
          imageId: `sha256:${"b".repeat(64)}`,
          commit: null,
          openclawCommit: null,
        },
      ],
    },
    actions: [{ selector: ".runtime-debug-images summary", click: true }],
    description:
      "Inspect the OCE commit and each Agent's observed runtime images. Expand an Agent, compare the gateway image ID, Enterprise source commit, and upstream OpenClaw commit, then navigate to Namespaces: debug=true remains enabled. Remove the flag to hide diagnostics.",
    gap: "Simulated image identities demonstrate presentation. Native Driver integration verifies actual Docker and Kubernetes observations separately.",
  },
  runtimeImagesUnavailable: {
    group: "Pages/Navigation",
    name: "Debug metadata unavailable",
    path: "/console/agents?debug=true",
    rules: [{ suffix: "/runtime-images", status: 503 }],
    actions: [{ selector: ".runtime-debug-images summary", click: true }],
    description:
      "A failed runtime read leaves normal navigation available and tells the operator to refresh. Unknown commits are never inferred from tags.",
  },
  overview: {
    group: "Overview",
    name: "Console coverage",
    path: "/console/agents",
    description:
      "Browse pages, component states, and guided Agent workflows. Every preview mounts the production console modules and styles in its own frame. Reset story discards all local changes.",
    gap: "Stop Agent requests the stopped desired state; deployment resumes an Agent. Namespace provisioning, Preset management, and experimental Backend setup require an API, CLI, or operator workflow. Serving health and model responses require separate runtime verification.",
  },
  login: {
    group: "Pages/Sign in",
    name: "Signed out",
    path: "/console/login",
    signedOut: true,
    buildRevision: "1234567890abcdef1234567890abcdef12345678",
    description:
      "The email and password form, and a footer naming the build. Any nonempty demo email/password signs into this fixture.",
  },
  githubLogin: {
    group: "Pages/Sign in",
    name: "GitHub enabled",
    path: "/console/login",
    signedOut: true,
    githubEnabled: true,
    description:
      "Provider discovery adds Continue with GitHub beside the password form. Clicking it demonstrates an unavailable provider; this fixture never navigates to GitHub.",
    steps: [
      "Check the GitHub icon and label, then select the button to see the unavailable message.",
    ],
    gap: "An administrator must attach the numeric GitHub identity to an existing account through the API. Enrollment, account creation, and recovery administration have no console controls. OAuth navigation and session issuance require backend verification.",
  },
  githubUnavailable: {
    group: "Pages/Sign in",
    name: "GitHub unavailable",
    path: "/console/login",
    signedOut: true,
    githubEnabled: true,
    actions: [click("Continue with GitHub")],
    description: "A failed GitHub start leaves password sign-in and a deliberate retry available.",
  },
  githubRateLimited: {
    group: "Pages/Sign in",
    name: "GitHub rate limited",
    path: "/console/login",
    signedOut: true,
    githubEnabled: true,
    rules: [{ path: "/api/auth/providers/github/start", method: "POST", status: 429 }],
    actions: [click("Continue with GitHub")],
    description: "Admission refusal asks the user to wait without automatically retrying.",
  },
  recoveryOnlyLogin: {
    group: "Pages/Sign in",
    name: "Recovery-only password",
    path: "/console/login",
    signedOut: true,
    githubEnabled: true,
    googleEnabled: true,
    passwordRecoveryOnly: true,
    description:
      "With OCC_AUTH_PASSWORD_SIGN_IN=recovery-only, ordinary accounts continue with GitHub or Google. The password form stays behind Recovery sign-in for the recovery account.",
  },
  recoveryOnlyForm: {
    group: "Pages/Sign in",
    name: "Recovery sign-in form",
    path: "/console/login",
    signedOut: true,
    githubEnabled: true,
    passwordRecoveryOnly: true,
    rules: [{ path: "/api/auth/sign-in/email", method: "POST", status: 401 }],
    actions: [
      click("Recovery sign-in"),
      { selector: "#username", value: "member@example.com" },
      { selector: "#password", value: "demo-only" },
      click("Sign in"),
    ],
    description:
      "Recovery sign-in reveals the password form. A refused password explains that only the recovery account can use one.",
  },
  recoveryOnlyCallbackRejected: {
    group: "Pages/Sign in",
    name: "Recovery-only GitHub callback rejected",
    path: "/console/?authError=github",
    signedOut: true,
    githubEnabled: true,
    passwordRecoveryOnly: true,
    description:
      "Without a password to fall back on, a rejected callback points the user to an administrator.",
  },
  githubCallbackRejected: {
    group: "Pages/Sign in",
    name: "GitHub callback rejected",
    path: "/console/?authError=github",
    signedOut: true,
    githubEnabled: true,
    description:
      "A rejected callback shows the generic sign-in error and keeps password recovery available.",
  },
  githubResultRejected: {
    group: "Pages/Sign in",
    name: "GitHub result not confirmed",
    path: "/console/",
    pendingGithubAttempt: true,
    githubEnabled: true,
    rules: [{ path: "/api/auth/providers/github/result", method: "POST", status: 401 }],
    description:
      "The tab that started GitHub sign-in could not confirm that the current session is the one its attempt created, so it shows the sign-in error instead of adopting that session.",
  },
  googleLogin: {
    group: "Pages/Sign in",
    name: "Google enabled",
    path: "/console/login",
    signedOut: true,
    githubEnabled: true,
    googleEnabled: true,
    description:
      "Provider discovery adds Continue with Google beside the password form and any other configured provider. Clicking it demonstrates an unavailable provider; this fixture never navigates to Google.",
    steps: [
      "Check the Google and GitHub icons and labels, then select either button to see the unavailable message.",
    ],
    gap: "An administrator must attach the Google subject identifier to an existing account through the API. Email addresses never match an account. OAuth navigation and session issuance require backend verification.",
  },
  googleUnavailable: {
    group: "Pages/Sign in",
    name: "Google unavailable",
    path: "/console/login",
    signedOut: true,
    googleEnabled: true,
    actions: [click("Continue with Google")],
    description: "A failed Google start leaves password sign-in and a deliberate retry available.",
  },
  googleCallbackRejected: {
    group: "Pages/Sign in",
    name: "Google callback rejected",
    path: "/console/?authError=google",
    signedOut: true,
    googleEnabled: true,
    description:
      "A rejected Google callback shows the generic sign-in error and keeps password recovery available.",
  },
  googleAccountDisabled: {
    group: "Pages/Sign in",
    name: "Google account disabled",
    path: "/console/?authError=google&authReason=account-disabled",
    signedOut: true,
    googleEnabled: true,
    description:
      "Google authenticated an identity attached to a disabled account, so the page says the account is disabled and names an administrator, not a retry, password or identity attach.",
  },
  recoveryOnlyAccountDisabled: {
    group: "Pages/Sign in",
    name: "Recovery-only account disabled",
    path: "/console/?authError=github&authReason=account-disabled",
    signedOut: true,
    githubEnabled: true,
    passwordRecoveryOnly: true,
    description:
      "With recovery-only password sign-in, a disabled account's GitHub sign-in gives the same administrator advice.",
  },
  recoveryOnlyProviderUnavailable: {
    group: "Pages/Sign in",
    name: "Recovery-only provider outage",
    path: "/console/?authError=github&authReason=provider-unavailable",
    signedOut: true,
    githubEnabled: true,
    passwordRecoveryOnly: true,
    description:
      "The provider could not answer or refused the client, so the page says sign-in is unavailable right now and points administrators to Recovery sign-in, not to an identity attach.",
  },
  googleResultRejected: {
    group: "Pages/Sign in",
    name: "Google result not confirmed",
    path: "/console/",
    pendingGoogleAttempt: true,
    googleEnabled: true,
    rules: [{ path: "/api/auth/providers/google/result", method: "POST", status: 401 }],
    description:
      "The tab that started Google sign-in could not confirm that the current session is the one its attempt created, so it shows the sign-in error instead of adopting that session.",
  },
  providerDiscoveryUnavailable: {
    group: "Pages/Sign in",
    name: "Provider discovery unavailable",
    path: "/console/login",
    signedOut: true,
    rules: [{ path: "/api/auth/providers", status: 503 }],
    description:
      "Failed provider discovery leaves the password form usable without provider buttons.",
  },
  loginError: {
    group: "Pages/Sign in",
    name: "Invalid credentials",
    path: "/console/login",
    signedOut: true,
    rules: [{ path: "/api/auth/sign-in/email", method: "POST", status: 401 }],
    actions: [
      { selector: "#username", value: "operator@example.com" },
      { selector: "#password", value: "demo-only" },
      click("Sign in"),
    ],
    description: "A rejected sign-in leaves the form available for retry.",
  },
  expired: {
    group: "Pages/Sign in",
    name: "Session expired",
    path: draft,
    signedOut: true,
    expiredSession: true,
    description:
      "A protected deep link in a tab whose session expired says so, redirects to sign-in and retains the return destination.",
    steps: [
      "Sign in with the fixture credentials and confirm the Agent draft page returns.",
      "Confirm no draft is saved or deployment started by signing in.",
    ],
  },
  firstVisit: {
    group: "Pages/Sign in",
    name: "Deep link, first visit",
    path: draft,
    signedOut: true,
    description:
      "A first visit to a protected deep link asks to sign in without saying a session expired, and retains the return destination.",
    steps: ["Sign in with the fixture credentials and confirm the Agent draft page returns."],
  },
  sessionUnavailable: {
    group: "Pages/Sign in",
    name: "Session unavailable",
    rules: [{ path: "/api/auth/session", status: 503 }],
    description: "The console cannot verify the session. Private data stays hidden.",
  },
  loading: {
    group: "Pages/Sign in",
    name: "Checking session",
    rules: [{ path: "/api/auth/session", hold: true }],
    description:
      "Reload with the entry script throttled: “Loading OpenClaw Enterprise…” appears before it runs, then becomes “Checking session…” in the same place.",
    steps: [
      "Check that neither console navigation nor a sign-in form appears while the session is unknown.",
      "Wait for Session unavailable, then choose Retry to repeat the check.",
    ],
  },
  logoutFailure: {
    group: "Pages/Sign in",
    name: "Sign-out unconfirmed",
    rules: [{ path: "/api/auth/sign-out", method: "POST", status: 503 }],
    actions: [...account, click("Sign out")],
    description:
      "Failed sign-out with a still-active session hides private content until revocation can be confirmed.",
  },
  agents: {
    group: "Pages/Agents",
    name: "Populated",
    description:
      "Searchable Agent table with draft and deployed Agents, each with Stop and Delete row icons. Open an Agent to explore its tabs. The shared shell, table, and controls use the Claw palette and typography.",
    steps: [
      "Check text, search input, buttons, and the current navigation item. The console stays light with either system appearance preference.",
      "Click an open area of an Agent row, such as the padding in Execution mode or Created. The same Agent detail opens as when clicking its name. Use ← Agents and repeat at phone width.",
      "Tab to an Agent name and press Enter. Keyboard navigation still opens that Agent.",
      "Open a current-version or latest-deployment link: it opens that version. Stop and Delete open their confirmations and keep the list visible; Cancel returns to the row. Disabled icons do not open the Agent.",
      "Drag across an Agent ID to select text. Releasing the mouse keeps the list visible so the ID can be copied.",
      "Open Namespaces and return to Agents; the sidebar stays mounted while the destination data loads.",
      "At a narrow viewport, use Open navigation and choose a page; the drawer must close and return focus to the page.",
    ],
  },
  agentsRowNavigation: {
    group: "Pages/Agents",
    name: "Row navigation",
    description:
      "Open an Agent from row padding or text. Name and version links, row actions, and text selection keep their existing behavior.",
    steps: [
      "Click padding in Execution mode or Created. The Agent detail opens. Use ← Agents and confirm focus returns to its name. Repeat at phone width.",
      "Press Enter on the focused name to open the same Agent, then return.",
      "Open a current-version or latest-deployment link and confirm its version is selected.",
      "Open Stop or Delete and cancel. The list stays visible. In Row restricted, disabled buttons and their icons do not open the Agent.",
      "Select part of an Agent ID with the mouse. Releasing the mouse keeps the selected text and list visible.",
    ],
  },
  navigationFirstVisit: {
    group: "Pages/Navigation",
    name: "First visits",
    rules: [
      { suffix: "/agents/agt_00000000-0000-4000-8000-000000000001", delayMs: 150 },
      { suffix: "/agents/agt_00000000-0000-4000-8000-000000000002", delayMs: 1200 },
    ],
    description:
      "Open an Agent from the list. The destination and Back to Agents appear immediately. The Agent’s name, actions, and overview appear together after the access checks. Read times are simulated.",
    steps: [
      "Open Research assistant. Its 150 ms read finishes without waiting for a minimum loading time.",
      "Open Documentation assistant. During its 1200 ms read, choose Back to Agents. Focus returns to that link and the late response does not reopen it.",
      "Open Documentation assistant again and switch to another window and back during its read: Loading agent details and Back to Agents stay. Double-click Back to Agents: the list opens once and the console stays.",
      "Reload the story: the cold visit shows the session status, then Agents, with no loading panels between them.",
    ],
  },
  navigationAgentReadRetry: {
    group: "Pages/Navigation",
    name: "Retry opening an Agent",
    rules: [
      {
        method: "GET",
        suffix: "/agents/agt_00000000-0000-4000-8000-000000000002",
        delayMs: 900,
        status: 503,
        once: true,
      },
    ],
    description:
      "The first read of Documentation assistant returns a simulated 503. The page stays on Agent details so you can retry or go back to the list.",
    steps: [
      "Open Documentation assistant. Loading agent details is replaced by Could not load agent details; the page heading stays Agent details.",
      "Choose Try again. Documentation assistant opens without a page reload, and Back returns to the list.",
    ],
  },
  navigationRetained: {
    group: "Pages/Navigation",
    name: "Return to loaded pages",
    rules: [
      { path: "/api/auth/session", skip: 1, delayMs: 1200 },
      { path: "/namespaces", skip: 1, delayMs: 1200 },
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents",
        skip: 1,
        delayMs: 1200,
      },
    ],
    description:
      "Returning to unchanged pages and Agent tabs preserves loaded controls, expanded panels, and edits. Access and reads are rechecked before a retained page is shown. Refresh explicitly reloads. Simulated API; no backend persistence proof.",
    steps: [
      "Wait for Agents, enter a search, open Create Agent, then return using the Agents breadcrumb. Create Agent stays shown, inactive, while access and reads are rechecked; then the loaded list and search return unchanged. Refocusing the window rechecks the same way, without a loading state.",
      "Use Tab to focus Namespaces, then Enter. After loading, its heading has focus and the next Tab reaches Refresh. Back and Forward focus the destination heading while retaining loaded content.",
      "Open an Agent and expand Native configuration. Visit Credentials and Workspace files, then return to Configuration: the disclosure stays expanded. Return to Agents and use Back: native admin access and the selected tab stay loaded through access checks. Refresh explicitly rereads the page.",
      "Switch Namespace to confirm the previous scope's rows disappear. Reset the story to clear retained state.",
    ],
  },
  navigationSlowRecheck: {
    group: "Pages/Navigation",
    name: "Slow rechecks",
    rules: [{ path: "/api/auth/session", skip: 1, delayMs: 2500 }],
    description:
      "Every session check after the first load takes 2.5 s. Returns and refocus keep the shown page and say Still checking after 1 s; Refresh shows loading after 250 ms. Simulated API; no backend proof.",
    steps: [
      "Wait for Agents, then select Refresh. The list stays shown, inactive, for 250 ms, then Loading replaces it. When the list returns, focus is on Refresh.",
      "Open Namespaces and wait for it, then use browser Back. The Namespaces page stays shown, inactive; after 300 ms it dims with a progress cursor, without moving, and after 1 s Still checking… appears beside Refresh until the unchanged Agents list returns.",
      "Focus an Agent link, switch windows, then return. The list stays visible and inactive, says Still checking… after 1 s, then returns focus to the link. If you focus Namespaces while waiting, focus stays there.",
      "Focus Refresh, the Namespace selector or a sidebar link, switch windows, then return. When the list returns, focus is back on that control.",
      "Open the Agent. In the sidebar, focus Agents and press Enter. Focus waits on the page heading while the list loads, then returns to the Agent link; it does not drop to the page body.",
    ],
  },
  navigationAgentReturn: {
    group: "Pages/Navigation",
    name: "Return to Agent panels",
    path: revision,
    deployed: true,
    nativeAdmin: "unsupported",
    description:
      "Agent panels retain loaded controls on tab and page returns. This preview uses simulated API data.",
    steps: [
      "Wait for Native admin UI, then open Credentials and return to Configuration. The native access result remains visible.",
      "Expand View admitted native configuration, visit Workspace files, then return. The disclosure stays expanded.",
      "Return to Agents and use browser Back. Native admin access and expanded panels remain loaded after admission succeeds.",
      "Click Refresh access to explicitly check the native endpoint again. Page Refresh reloads all panels.",
    ],
  },
  navigationDenied: {
    group: "Pages/Navigation",
    name: "Return access denied",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents",
        skip: 1,
        delayMs: 1200,
        status: 403,
      },
    ],
    description:
      "A previously readable collection becomes denied on its next read. Retained content must clear when the denial arrives.",
    steps: [
      "Wait for the populated Agents list, open Create Agent, and return to Agents.",
      "Observe the retained list while the response is pending, then the access-denied state. Retry must not restore the old rows.",
    ],
  },
  navigationBackendDenied: {
    group: "Pages/Navigation",
    name: "Return Backend access denied",
    path: "/console/backends?namespace=ns_00000000-0000-4000-8000-000000000001",
    rules: [
      { path: "/backends", skip: 2, delayMs: 1200, status: 403 },
      { path: "/api/auth/session", skip: 3, delayMs: 1200 },
    ],
    description:
      "An Installation-wide Backend denial invalidates previews under every Namespace selection.",
    steps: [
      "Wait for Backends, select Research, and wait for the Backend row again.",
      "Select Refresh and wait for Access denied, then use browser Back to return to Engineering.",
      "Confirm the previous Backend row stays absent while the session check runs and the denied state returns.",
    ],
  },
  navigationExpired: {
    group: "Pages/Navigation",
    name: "Return session expired",
    rules: [{ path: "/api/auth/session", skip: 1, delayMs: 1200, status: 401, once: true }],
    description:
      "Session expiry clears private content and retains only the validated destination. The fixture supplies a delayed unauthorized response.",
    steps: [
      "Wait for Agents, then select Refresh or navigate to Namespaces.",
      "When the session check fails, confirm the sign-in form replaces all private content.",
      "Sign in again and confirm the requested collection returns without replaying a write.",
    ],
  },
  observabilityLink: {
    group: "Components/Navigation",
    name: "Admin Observability link",
    observabilityUrl: "https://observability.example.test/d/occ-observability",
    description:
      "Installation administrators see Observability with an external-link icon; it opens in a new tab.",
  },
  observabilityDenied: {
    group: "Components/Navigation",
    name: "Observability access denied",
    observabilityDenied: true,
    description: "Namespace-only access keeps Observability out of navigation.",
  },
  agentsEmpty: {
    group: "Pages/Agents",
    name: "Empty",
    emptyAgents: true,
    description: "A ready Namespace with no Agents offers creation.",
  },
  agentsUnreadableConfiguration: {
    group: "Pages/Agents",
    name: "Unreadable saved configuration",
    deployed: true,
    unreadableAgentConfiguration: "plugins",
    description:
      "One Agent has unreadable saved plugin selections. Both Agents remain in the list, and the affected row shows a warning. This is simulated API data, not database recovery proof.",
    steps: [
      "Open Research assistant and select Create new version. Its saved settings show a repair banner without editing or deployment controls.",
      "Select v1 to inspect the readable admitted snapshot. Return to Agents and open Documentation assistant to check that its draft remains editable.",
    ],
  },
  agentsRowStopConfirm: {
    group: "Pages/Agents",
    name: "Stop from the list",
    deployed: true,
    actions: [{ selector: '[aria-label="Stop Research assistant"]', click: true }],
    description:
      "The row's Stop icon opens the same confirmation as Agent detail. Cancel returns focus to the icon without a write; Stop Agent requests the stopped state.",
    steps: [
      "Cancel the dialog and check focus returns to the Stop icon.",
      "Open it again and select Stop Agent. The row shows Stop requested, its Stop icon is disabled, and the list stays open.",
      "In Populated, never-deployed Agents show no Stop icon, as on Agent detail.",
    ],
    gap: "The fixture records the requested state only. Live runtime shutdown is not simulated.",
  },
  agentsRowStopped: {
    group: "Pages/Agents",
    name: "Stop requested from the list",
    deployed: true,
    actions: [
      { selector: '[aria-label="Stop Research assistant"]', click: true },
      { selector: ".agent-stop-dialog button.danger", click: true },
    ],
    description:
      "An accepted row Stop shows a status notice, a Stop requested badge, and a disabled Stop icon. Delete stays available.",
  },
  agentsRowDeleteConfirm: {
    group: "Pages/Agents",
    name: "Delete from the list",
    deployed: true,
    actions: [{ selector: '[aria-label="Delete Research assistant"]', click: true }],
    description:
      "The row's Delete icon opens the permanent-deletion confirmation, including the commands that remove the kept Configuration and model Secret.",
    steps: [
      "Select Permanently delete Agent. The row shows Deleting and both icons are disabled.",
      "Select Refresh: the row still shows Deleting, because the list keeps an Agent until its cleanup finishes.",
    ],
    gap: "The fixture does not run cleanup. Open the Agent to follow deletion status.",
  },
  agentsRowStopDenied: {
    group: "Pages/Agents",
    name: "Stop from the list denied",
    deployed: true,
    rules: [{ suffix: "/stop", method: "POST", status: 403 }],
    actions: [
      { selector: '[aria-label="Stop Research assistant"]', click: true },
      { selector: ".agent-stop-dialog button.danger", click: true },
    ],
    description:
      "Permission advice allowed Stop, but the controller refuses the confirmed write, as after a removed grant. The alert names the missing Agent operate access; the row stays running.",
  },
  agentsRowDeleteDenied: {
    group: "Pages/Agents",
    name: "Delete from the list denied",
    deployed: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "DELETE",
        status: 403,
      },
    ],
    actions: [
      { selector: '[aria-label="Delete Research assistant"]', click: true },
      { selector: ".agent-delete-dialog button.danger", click: true },
    ],
    description:
      "Permission advice allowed Delete, but the controller refuses the confirmed write. The alert names the missing Agent delete access; the Agent stays in the list.",
  },
  agentsRowRestricted: {
    group: "Pages/Agents",
    name: "Row actions unavailable for this caller",
    deployed: true,
    readOnlyPermissionSummary: true,
    description:
      "The permission summary says this caller can neither stop nor delete these Agents. Each row disables its icons and says why before any confirmation.",
    steps: [
      "Find No access to stop or delete under each row's icons. The icons do not open a confirmation.",
      "Open an Agent: its detail page explains the same restrictions.",
    ],
    gap: "The summary is advisory. The controller still authorizes each write.",
  },
  agentsRowStopUnknown: {
    group: "Pages/Agents",
    name: "Stop from the list outcome unknown",
    deployed: true,
    rules: [{ suffix: "/stop", method: "POST", status: 503, once: true }],
    actions: [
      { selector: '[aria-label="Stop Research assistant"]', click: true },
      { selector: ".agent-stop-dialog button.danger", click: true },
    ],
    description:
      "An unconfirmed row Stop disables that row's actions until Refresh rereads the list. The console never resends the request.",
  },
  agentsSearch: {
    group: "Pages/Agents",
    name: "No search matches",
    actions: [{ selector: 'input[type="search"]', value: "no-such-agent" }],
    description: "Search returns no matches without changing the Namespace.",
  },
  noNamespaces: {
    group: "Pages/Agents",
    name: "No readable Namespaces",
    emptyNamespaces: true,
    description: "Agent pages need an accessible Namespace.",
    gap: "Create a Namespace from Namespaces; granting access still requires an administrator.",
  },
  namespaceMissing: {
    group: "Pages/Agents",
    name: "Namespace unavailable",
    path: "/console/agents?namespace=ns_missing",
    description: "A stale Namespace link asks the reader to switch scope.",
  },
  agentsCreateRestricted: {
    group: "Pages/Agents",
    name: "Create Agent unavailable for this caller",
    readOnlyPermissionSummary: true,
    description: "The permission summary says this caller cannot create an Agent here.",
    steps: [
      "Find the explanation beside Create Agent. The action is unavailable; opening a readable Agent still works.",
    ],
  },
  agentsCreateRestrictedEmpty: {
    group: "Pages/Agents",
    name: "Empty, Create Agent unavailable",
    emptyAgents: true,
    readOnlyPermissionSummary: true,
    description:
      "A caller who cannot create Agents in an empty Namespace is told shared Agents appear here, not invited to create one.",
  },
  agentsNamespaceProvisioning: {
    group: "Pages/Agents",
    name: "Empty, Namespace still provisioning",
    emptyAgents: true,
    namespaceStatus: "provisioning",
    description:
      "A first run's Namespace is still provisioning: the page names its status and what waits for it, and Create Agent stays available for drafts.",
  },
  agentsNamespaceBecomesReady: {
    group: "Pages/Agents",
    name: "Namespace becomes ready",
    namespaceStatus: "provisioning",
    namespaceRechecks: ["provisioning", "ready"],
    actions: [{ selector: 'input[type="search"]', value: "Research", focus: true }],
    description:
      "The Agents list rechecks a provisioning Namespace every 10 s while the reader stays on it, without a Refresh. When it reads ready, a success note replaces the warning in place, Create Agent loses its not-ready description, and the search text and focus stay.",
    steps: [
      'Keep the caret in Search Agents. After the first recheck (about 10 s) the note still begins "Namespace status: Provisioning."; within about 20 s it becomes "Namespace status: Ready. Agents created here can be deployed now."',
      "Confirm Search Agents keeps its text and focus, Research assistant is still listed, and Create Agent is enabled with no description pointing at the note. No further Namespace reads happen.",
    ],
  },
  agentsNamespaceMissing: {
    group: "Pages/Agents",
    name: "Namespace leaves the list while provisioning",
    emptyAgents: true,
    namespaceStatus: "provisioning",
    namespaceRechecks: ["missing"],
    // Rechecks start once the page shows its search box, so the first load still lists it.
    actions: [{ selector: 'input[type="search"]', focus: true }],
    description:
      "The Namespace list the Agents page rereads while its Namespace provisions no longer holds it: it was deleted, or the reader lost access. The wait ends, the note asks for another Namespace, as Create Agent's does, and Create Agent is disabled.",
    steps: [
      'Within about 10 s the note "Namespace status: Provisioning." becomes "This Namespace is missing or you no longer have access. Choose another Namespace."',
      'Confirm Create Agent is disabled and described by that note, the empty state reads "Agents cannot be created in this Namespace.", and no further Namespace reads happen.',
    ],
  },
  agentsDenied: {
    group: "Pages/Agents",
    name: "Access denied",
    rules: [{ path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents", status: 403 }],
    description: "Collection authorization denial with a request ID and Retry.",
  },
  agentsError: {
    group: "Pages/Agents",
    name: "Read failure",
    rules: [{ path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents", status: 503 }],
    description: "A failed collection read offers retry rather than presenting an empty result.",
  },
  agentsLoading: {
    group: "Pages/Agents",
    name: "Loading",
    rules: [{ path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents", hold: true }],
    description: "The collection read remains pending until the real 15-second client timeout.",
  },
  agentsInterruptedResponse: {
    group: "Pages/Agents",
    name: "Interrupted response",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents",
        bodyError: true,
        once: true,
      },
    ],
    description:
      "A collection response body fails after its headers arrive. Retry reloads the list.",
    gap: "This preview simulates a stream failure; the socket tests verify real HTTP interruption.",
    workflow: [
      "Check that Request interrupted appears with Retry instead of an empty Agent collection.",
      "Select Retry. The populated Agent list returns without changing Namespace or saved resources.",
    ],
  },
  backends: {
    group: "Pages/Backends",
    name: "Configured",
    path: "/console/backends",
    description:
      "Experimental Installation-wide Backend discovery, separate from model provider selection.",
    gap: "This is a read-only page; configure experimental Backends through Installation configuration.",
  },
  backendsEmpty: {
    group: "Pages/Backends",
    name: "Empty",
    path: "/console/backends",
    emptyBackends: true,
    description: "No experimental Backends are configured.",
  },
  backendsError: {
    group: "Pages/Backends",
    name: "Discovery unavailable",
    path: "/console/backends",
    rules: [{ path: "/backends", status: 503 }],
    description: "Backend discovery fails and can be retried.",
  },
  backendsDenied: {
    group: "Pages/Backends",
    name: "Access denied",
    path: "/console/backends",
    rules: [{ path: "/backends", status: 403 }],
    description:
      "A caller without Installation access is told Backends apply to the whole Installation. The Namespace selector is hidden, since another Namespace would not change the answer.",
  },
  namespaces: {
    group: "Pages/Namespaces",
    name: "Ready and provisioning",
    path: "/console/namespaces",
    description:
      "Installation-wide Namespace cards and Create Namespace, without a Namespace selector. Each card opens that Namespace's Agents; status badges read Ready or Provisioning.",
    steps: [
      "Select Create Namespace, enter a unique name, and submit. The success dialog explains provisioning; Open Agents selects the created Namespace.",
      "Reset, then cancel a new form with Escape. No Namespace is created and focus returns to Create Namespace.",
    ],
  },
  namespacesUnavailable: {
    group: "Pages/Namespaces",
    name: "Unavailable selection",
    path: "/console/namespaces?namespace=ns_00000000-0000-4000-8000-000000000099",
    description: "Recover from a stale Namespace URL using the selector inside the message.",
    steps: [
      "Choose Engineering under Choose a valid Namespace; the URL changes and the warning disappears without leaving Namespaces.",
      "Use browser Back to return to the unavailable selection and recover again.",
    ],
  },
  namespacesUnavailableMobile: {
    group: "Pages/Namespaces",
    name: "Unavailable selection mobile",
    path: "/console/namespaces?namespace=ns_00000000-0000-4000-8000-000000000099",
    mobile: true,
    description: "Recover inline at 390px without opening navigation.",
  },
  namespacesUnavailableEmpty: {
    group: "Pages/Namespaces",
    name: "Unavailable selection without access",
    path: "/console/namespaces?namespace=ns_00000000-0000-4000-8000-000000000099",
    emptyNamespaces: true,
    description: "No readable alternatives: show access guidance instead of a selection action.",
  },
  namespacesEmpty: {
    group: "Pages/Namespaces",
    name: "Empty",
    path: "/console/namespaces",
    emptyNamespaces: true,
    description:
      "No accessible Namespaces. Create Namespace remains available; the API decides whether creation is permitted.",
  },
  namespacesEmptyMember: {
    group: "Pages/Namespaces",
    name: "Empty for a member",
    path: "/console/namespaces",
    emptyNamespaces: true,
    observabilityDenied: true,
    description:
      "A person who does not administer the Installation gets Create Namespace as a secondary action and is told to ask an administrator. A Namespace create grant still works from it.",
  },
  namespaceCreateRefused: {
    group: "Pages/Namespaces",
    name: "Create refused, then closed",
    path: "/console/namespaces",
    emptyNamespaces: true,
    observabilityDenied: true,
    rules: [{ path: "/namespaces", method: "POST", status: 403, code: "FORBIDDEN" }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
      { click: "Cancel" },
    ],
    description:
      "After the API refuses creation, the page disables Create Namespace, says why, and focuses that reason. Refresh or a browser reload offers creation again.",
  },
  namespaceCreate: {
    group: "Pages/Namespaces",
    name: "Create Namespace",
    path: "/console/namespaces",
    actions: [{ click: "Create Namespace", focus: true }],
    description:
      "A name-only dialog uses the shared field and modal patterns. No credentials or infrastructure configuration are required in this form.",
    steps: [
      "Enter a unique name and create. Inspect the provisioning explanation, then select Done to see the new Namespace or Open Agents to use it.",
    ],
  },
  namespaceCreateMobile: {
    group: "Pages/Namespaces",
    name: "Create Namespace on mobile",
    path: "/console/namespaces",
    mobile: true,
    emptyNamespaces: true,
    actions: [{ click: "Create Namespace", focus: true }],
    description:
      "The empty list offers creation. On a phone the form becomes a bottom sheet with reachable actions.",
  },
  namespaceCreateRequired: {
    group: "Pages/Namespaces",
    name: "Create name required",
    path: "/console/namespaces",
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "Submitting an empty name shows a persistent inline error and focuses the field without sending a request.",
  },
  namespaceCreateInvalidName: {
    group: "Pages/Namespaces",
    name: "Create invalid name",
    path: "/console/namespaces",
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support\tteam" },
    ],
    description:
      "A pasted tab is refused at the field as it arrives, by the API's own Name rule, before any request. More than 200 characters is refused the same way instead of being cut.",
  },
  namespaceCreateConflict: {
    group: "Pages/Namespaces",
    name: "Create name conflict",
    path: "/console/namespaces",
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Engineering" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "An existing name is refused. The entered name remains editable; choose another name and submit again.",
  },
  namespaceCreateDenied: {
    group: "Pages/Namespaces",
    name: "Create permission denied",
    path: "/console/namespaces",
    emptyNamespaces: true,
    rules: [{ path: "/namespaces", method: "POST", status: 403, code: "FORBIDDEN" }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "A creation denial explains the missing Installation permission and disables resubmission. Cancel returns to the empty list.",
  },
  namespaceCreatePending: {
    group: "Pages/Namespaces",
    name: "Create pending",
    path: "/console/namespaces",
    rules: [{ path: "/namespaces", method: "POST", hold: true }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "While creation waits, the field and actions are disabled and Escape cannot dismiss the form. After the client timeout, inspect the unknown-outcome recovery.",
  },
  namespaceCreateUnknown: {
    group: "Pages/Namespaces",
    name: "Create outcome unknown",
    path: "/console/namespaces",
    rules: [{ path: "/namespaces", method: "POST", status: 503, code: "DEPENDENCY_UNAVAILABLE" }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "An unconfirmed write blocks resubmission. Check Namespaces rereads the list before a deliberate new attempt; this fixture does not establish whether the write committed.",
  },
  namespaceCreateSuccess: {
    group: "Pages/Namespaces",
    name: "Namespace created",
    path: "/console/namespaces",
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "Creation succeeded in the simulated fixture. The dialog distinguishes provisioning from readiness and offers the new Namespace's Agents.",
  },
  namespaceCreateUnreadable: {
    group: "Pages/Namespaces",
    name: "Created without read access",
    path: "/console/namespaces",
    emptyNamespaces: true,
    // A create-only role: the authorized list never includes the new Namespace.
    rules: [{ path: "/namespaces", data: [] }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "The caller may create Namespaces but not read them. The dialog says the Namespace was created and that their access does not include viewing it, and offers only Done.",
  },
  namespacesDenied: {
    group: "Pages/Namespaces",
    name: "Access denied",
    path: "/console/namespaces",
    rules: [{ path: "/namespaces", status: 403 }],
    description:
      "Namespace discovery is denied, as for an account whose access was removed. Private data stays hidden, and the panel offers Sign out beside Retry.",
    steps: ["Choose Sign out and confirm the sign-in page replaces the panel."],
  },
  settings: {
    group: "Pages/Settings",
    name: "Account",
    path: "/console/settings",
    description:
      "An account card with initials, name and email, and a Session card with Sign out. Administrators can inspect read-only Installation Driver schemas. There are no editable settings in this release.",
    steps: [
      "Check that the page has no Namespace selector and that the account card shows initials, name and email.",
      "Inspect Installation Driver schemas below the cards; no startup values or mutation controls are shown.",
      "Choose Sign out in the Session card: “Signing out…” appears, then the sign-in page.",
      "At a phone width, Sign out spans the Session card.",
    ],
  },
  settingsNameIsEmail: {
    group: "Pages/Settings",
    name: "Account without a display name",
    path: "/console/settings",
    // Sign-in providers that have no display name record the email as the name.
    sessionUser: {
      id: "storybook-operator",
      name: "operator@example.com",
      email: "operator@example.com",
    },
    description:
      "An account whose recorded name is its email address. The account card names it once, by email.",
    steps: [
      "Check that the account card shows the initial O and operator@example.com under Email, with no Name row repeating the address.",
      "Compare Account: a distinct display name still shows under Name.",
    ],
  },
  settingsSignOutFailure: {
    group: "Pages/Settings",
    name: "Sign-out unconfirmed",
    path: "/console/settings",
    rules: [{ path: "/api/auth/sign-out", method: "POST", status: 503 }],
    // The account menu's hidden Sign out comes first in the page, so name the card's button.
    actions: [{ selector: ".settings-sign-out", click: true }],
    description:
      "Sign out from the Session card fails with the session still active: private content stays hidden until revocation can be confirmed.",
    steps: [
      "Choose Retry: it repeats the sign-out and keeps private content hidden until it succeeds.",
    ],
  },
  notFound: {
    group: "Pages/Navigation",
    name: "Page not found",
    path: "/console/missing",
    description: "An unknown console route offers a return to Agents.",
  },
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
    ],
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
      "Reopen Configure plugins, remove Calendar, and click Done. With no configured plugins, the reminder is hidden.",
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
  pluginsAvailable: {
    group: "Components/Plugins",
    name: "Available catalog",
    component: "plugins",
    actions: [click("Configure plugins")],
    pluginCatalog,
    pluginCapabilities,
    description:
      "Browse a fixture catalog in the production plugin modal. Selecting a plugin opens its policies and a collapsed list of tools.",
    steps: [
      "Review the simulated Calendar and Documents logos. Project tracker’s intentionally missing image falls back to its initial. Choose each plugin to check the same logo or fallback in its detail heading.",
      "Search plugins for Documents, then clear the query and choose Calendar.",
      "Click Add Calendar. Its tool defaults remain omitted until you change them.",
      "Choose Require approval for → Write actions. Reviewer stays separate; choose Human or Automatic review, or inherit the Harness reviewer.",
      "Click Done and confirm toolDefaults.approval is write_actions. New tools inherit this default without needing entries in tools.",
      "Review the Driver-specific policy fields supplied by the capability descriptor.",
      "Expand Create event, change a tool setting, then click Done and inspect Plugin selections JSON.",
      "Reopen Configure plugins, click inside its padding, then click the gray backdrop. Only the backdrop closes it; selections remain and focus returns to Configure plugins.",
      "In a frame 1100 px wide or narrower (Components / Dialogs / Plugins (tablet) is 1024 px), the catalog and detail stack: choose Calendar to see only its detail, then Back to plugins to return to the catalog. Wider, both panes show side by side.",
    ],
    gap: pluginPreviewGap,
  },
  pluginsUnavailableReasonPopover: {
    group: "Components/Plugins",
    name: "Unavailable reason popover",
    component: "plugins",
    pluginCatalog,
    pluginCapabilities,
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Why Team chat is unavailable"]', focus: true },
    ],
    description:
      "Unavailable plugins keep compact rows. The information button opens the Driver's reason and help link without selecting the plugin or changing the list layout.",
    steps: [
      "Open Team chat's information button to review its administrator guidance and Manage workspace plugins link without following the external destination during fixture review.",
      "Press Escape to dismiss the popover while keeping Configure plugins open. Focus the information button and press Enter to reopen it; click outside to dismiss it.",
      "Open the information buttons for Analytics and Archive to compare plan and unsupported-runtime guidance. The list keeps its row heights as each popover opens.",
      "Choose the Team chat row. Its detail pane retains the reason and help link, and Add Team chat stays disabled.",
    ],
    gap: pluginPreviewGap,
  },
  pluginsSelected: {
    group: "Components/Plugins",
    name: "Write approval and tool overrides",
    component: "plugins",
    pluginCatalog,
    pluginCapabilities,
    pluginSelections,
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Calendar"]', click: true },
    ],
    description:
      "Calendar requires approval for write actions and uses automatic review, with explicit overrides for creating and deleting events. Tool reviewers inherit because this Driver advertises reviewer selection only at the default scope.",
    steps: [
      "Type create into Filter tools one character at a time; only Create event remains. Clear the search to restore the other tools.",
      "Compare Create event's ID beneath its title with its key in Plugin selections JSON after Done.",
      "Inspect Require approval for: Write actions is selected. Choose Every action, Provider default, or No additional approval to compare the available scopes.",
      "Change Calendar's default reviewer to Human, click Done, and inspect toolDefaults.approval and toolDefaults.reviewer in Plugin selections JSON.",
      "Choose inheritance to omit the reviewer field without changing default approval or tool overrides.",
      "Use a tool toggle to set enabled or disabled explicitly; Tool policy opens overrides and lets you restore inheritance. Set reviewer for all tools jumps to the plugin default reviewer because this Driver does not support per-tool reviewers.",
    ],
    gap: pluginPreviewGap,
  },
  pluginsUnsupportedToolReviewer: {
    group: "Components/Plugins",
    name: "Unsupported saved tool reviewer",
    component: "plugins",
    pluginCatalog,
    pluginCapabilities,
    pluginSelections: JSON.stringify(
      {
        "codex-plugin:calendar@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "provider_default", reviewer: "auto" },
          tools: { "app_calendar/create_event": { approval: "all_actions", reviewer: "auto" } },
        },
      },
      null,
      2,
    ),
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Calendar"]', click: true },
      {
        selector: 'details.plugin-tool-row[data-tool="app_calendar/create_event"] > summary',
        click: true,
      },
    ],
    description:
      "An explicit saved tool reviewer is unsupported when the Driver advertises no per-tool reviewer values, even when it equals the default reviewer. The editor preserves the value without treating it as inherited or enabling new unsupported choices.",
    gap: pluginPreviewGap,
  },
  pluginsUnknownTools: {
    group: "Components/Plugins",
    name: "Tool catalog unavailable",
    component: "plugins",
    pluginCapabilities,
    pluginCatalog: { status: "ready", entries: [pluginCatalog.entries[2]] },
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Project tracker"]', click: true },
    ],
    description:
      "Project tracker’s intentionally missing logo falls back to its initial in the list and detail. Its unavailable tool metadata remains distinct from a verified empty tool list.",
    gap: pluginPreviewGap,
  },
  pluginsEmpty: {
    group: "Components/Plugins",
    name: "Empty catalog",
    component: "plugins",
    actions: [click("Configure plugins")],
    pluginCapabilities,
    pluginCatalog: { status: "ready", entries: [] },
    description:
      "An empty catalog has an explicit empty state and keeps the JSON editor available.",
    gap: pluginPreviewGap,
  },
  pluginsLoading: {
    group: "Components/Plugins",
    name: "Catalog loading",
    component: "plugins",
    actions: [click("Configure plugins")],
    pluginCapabilities,
    pluginCatalog: { status: "loading" },
    description: "A pending catalog is distinct from a successful empty catalog.",
    gap: pluginPreviewGap,
  },
  pluginsDenied: {
    group: "Components/Plugins",
    name: "Catalog access denied",
    component: "plugins",
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Available plugins"]', click: true },
    ],
    pluginCapabilities,
    pluginCatalog: {
      status: "error",
      canLoad: true,
      message: "This credential does not have access to the plugin catalog.",
    },
    description:
      "A simulated catalog permission error stays visible while existing configuration remains editable.",
    pluginSelections,
    gap: pluginPreviewGap,
  },
  pluginsError: {
    group: "Components/Plugins",
    name: "Catalog unavailable",
    component: "plugins",
    actions: [click("Configure plugins")],
    pluginCapabilities,
    pluginCatalog: {
      status: "error",
      canLoad: true,
      message: "The plugin catalog could not be loaded. Try again after restoring connectivity.",
    },
    description: "A simulated catalog failure is shown as an error, not a successful empty result.",
    gap: pluginPreviewGap,
  },
  pluginsUnavailable: {
    group: "Components/Plugins",
    name: "Discovery credential required",
    component: "plugins",
    actions: [click("Configure plugins")],
    pluginCapabilities,
    description:
      "The component explains that discovery requires an entered service account token with the Codex harness. The empty list points to Plugin selections JSON for adding a plugin by ID instead of the unavailable Load plugins.",
  },
  pluginsCapabilitiesUnavailable: {
    group: "Components/Plugins",
    name: "Policy capabilities unavailable",
    component: "plugins",
    pluginCatalog,
    pluginSelections,
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Calendar"]', click: true },
    ],
    description:
      "Without a Driver capability descriptor, saved policies remain visible and policy controls stay disabled. The component does not assume policy support from the catalog.",
    gap: pluginPreviewGap,
  },
  pluginsNativeLimited: {
    group: "Components/Plugins",
    name: "Native Driver with unsupported saved policy",
    component: "plugins",
    pluginCatalog: {
      status: "ready",
      entries: [{ id: "occ-plugin:diffs", name: "Diffs", tools: null }],
    },
    pluginCapabilities: {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      toolDefaults: { enabled: true, approval: ["provider_default", "none"], reviewer: [] },
      tools: { enabled: true, approval: ["provider_default", "none"], reviewer: [] },
      driverPolicySchema: { type: "object", properties: {}, additionalProperties: false },
    },
    pluginSelections: JSON.stringify(
      {
        "occ-plugin:diffs": {
          enabled: true,
          toolDefaults: { approval: "write_actions" },
        },
      },
      null,
      2,
    ),
    actions: [click("Configure plugins"), { selector: 'button[aria-label="Diffs"]', click: true }],
    description:
      "The simulated native Driver supports Provider default and No additional approval. Every action and Write actions remain visible but disabled, with an explanation. A saved unsupported choice stays selected until the operator changes it.",
    steps: [
      "Inspect the selected Write actions (unsupported) value and the provider support explanation.",
      "Open Require approval for: Every action and Write actions are visible but disabled.",
      "Click Done and confirm the saved write_actions value remains unchanged. Reopen the modal, choose Provider default or inherit, then inspect the updated JSON.",
    ],
    gap: pluginPreviewGap,
  },
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
        "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an administrator to raise the quota.",
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
        "Kubernetes cannot pull a container image for this Agent and keeps retrying. Ask an administrator to check the runtime image reference and that the cluster's nodes can pull from its registry.",
    },
    provisioningNamesDeploymentWait: true,
    description:
      "The first deployment waits on a container image the cluster's nodes cannot pull. Create Agent shows that sentence alone in place of the provisioning line, as it does for a full Pod quota.",
    steps: [
      "Click Create Agent. The line changes from “Provisioning Agent…” to the image pull sentence, which asks an administrator to check the runtime image reference and registry access.",
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
  ...Object.fromEntries(
    [1, 5, 25, 140].map((count) => [
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
    repositoryOptions: [
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
    })),
    description:
      "Search a short repository name. Exact names appear first with their owners visible, followed by prefixes and substrings. Press Enter to add the first match; the query stays available for another addition.",
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
    description: "Successful empty discovery permits an ordinary Agent without repository access.",
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
      "The Installation read is refused and the Namespace permission read failed, so whether this caller may create Agents is unknown. Create Agent stays disabled, the page says the permission check failed, and Retry permission check rereads only the permission answer: a grant continues as Member with Agent create, a denial keeps the refusal.",
    steps: [
      'Under the form fields, read "Your permissions in this Namespace could not be checked".',
      "Retry permission check is offered; the fixture keeps failing the read, so the text stays.",
    ],
    gap: "The member creation browser test also covers a successful retry.",
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
      "Read the alert: giving the Agent access to its Secrets needs Installation administration access.",
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
    oauthPending: true,
    actions: startOAuthLogin,
    description:
      "The user code and provider link are visible while authorization is pending. Cancel login removes this staged login locally.",
  },
  createOAuthReady: {
    group: "Pages/Create Agent",
    name: "ChatGPT login ready for plugin discovery (Experimental)",
    path: create,
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
    rules: [{ suffix: "/device-authorizations", method: "POST", status: 403 }],
    actions: startOAuthLogin,
    description:
      "A denied authorization request leaves the form usable and does not create a browser credential.",
  },
  createOAuthUnavailable: {
    group: "Pages/Create Agent",
    name: "ChatGPT login unavailable (Experimental)",
    path: create,
    rules: [{ suffix: "/device-authorizations", method: "POST", status: 501 }],
    actions: startOAuthLogin,
    description:
      "An Installation whose selected Drivers do not support device login reports it as unavailable. Choose another authentication method; no device code or sign-in link appears.",
  },
  createOAuthStartUnconfirmed: {
    group: "Pages/Create Agent",
    name: "ChatGPT sign-in start unconfirmed (Experimental)",
    path: create,
    rules: [{ suffix: "/device-authorizations", method: "POST", bodyError: true }],
    actions: oauthForm,
    description:
      "Choose Sign in with OAuth. The simulated response is interrupted after its headers, so the Console cannot tell whether sign-in started. Switch authentication methods and return: a second sign-in stays unavailable.",
  },
  createOAuthError: {
    group: "Pages/Create Agent",
    name: "ChatGPT login exchange failed (Experimental)",
    path: create,
    rules: [{ suffix: "/poll", method: "POST", status: 503 }],
    actions: startOAuthLogin,
    description:
      "A failed poll stops polling. Cancel the staged login and connect again; the console does not retry an uncertain exchange.",
  },
  createOAuthExpired: {
    group: "Pages/Create Agent",
    name: "ChatGPT device login expired (Experimental)",
    path: create,
    oauthExpired: true,
    actions: startOAuthLogin,
    description:
      "An expired device code cannot be used to create the Agent. Cancel it and sign in again.",
  },
  pluginsOAuthRevision: {
    group: "Pages/Agent detail",
    name: "Saved ChatGPT login for plugin editing (Experimental)",
    path: `${draft}&tab=plugins`,
    deployed: true,
    auth: "oauth",
    agentPlugins: JSON.parse(pluginSelections),
    pluginCapabilities,
    pluginDiscovery,
    description:
      "Plugin browsing uses the Agent's saved credential source without another login. Saving plugin selections never replaces authentication.",
  },
  authOAuthReconnect: {
    group: "Components/Credentials",
    name: "Explicit ChatGPT credential replacement (Experimental)",
    path: `${draft}&tab=credentials`,
    deployed: true,
    auth: "oauth",
    credentialSources: [
      { sourceId: "cs_00000000-0000-4000-8000-000000000010" },
      { sourceId: "cs_00000000-0000-4000-8000-000000000011" },
    ],
    description:
      "Sign in and save a replacement explicitly. The Agent replaces its prior Harness source binding and retains unrelated tool bindings; deployment remains separate.",
    steps: [
      "Sign in with OAuth, wait for the simulated ready status, then Save authentication source.",
      "Inspect the PATCH: credentialSources keeps the tool entry, removes the old Harness entry, and adds the new Harness source once.",
    ],
  },
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
          "Dedicated OpenClaw requires a provisioning SandboxDriver with networking, filesystem, and process containment.",
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
  draft: {
    group: "Pages/Agent detail",
    name: "First version",
    path: draft,
    steps: [
      "Resize through desktop, tablet, and phone widths. Prepare this version sits beside Versions on a desktop and above it below 1,100 px. Each step shows a check when done or an open ring, with its detail line under the step text; Deploy new version stays on the first screen at 1440x900.",
      "Focus the selected tab and press Left, Right, Home and End: focus moves between tabs without opening one. Enter opens the focused tab. Tab leaves the strip and Shift+Tab returns to the selected tab. At phone width the edge with more tabs past it fades.",
    ],
    description:
      "An Agent without a version can edit saved settings and deploy its first immutable version.",
  },
  newVersion: {
    group: "Pages/Agent detail",
    name: "Create new version",
    path: draft,
    deployed: true,
    description:
      "Edit and save the current Configuration before deploying a new immutable version. The selected version stays unchanged until activation.",
    steps: [
      "Review the selected version and saved draft settings.",
      "Edit and save Configuration; then deploy the new version.",
      "Inspect the admitted version and its deployment activity.",
    ],
    gap: "The fixture simulates admission and worker completion; it does not verify a live Agent.",
  },
  editCurrentConfiguration: {
    group: "Pages/Agent detail",
    name: "Edit current Configuration",
    path: `${revision}&tab=configuration`,
    deployed: true,
    actions: [click("Edit current Configuration")],
    // The page brings the editor into view itself.
    scrollToTabs: false,
    description:
      "Edit current Configuration on a version's Configuration tab opens the draft with its Configuration editor already open, brought into view and focused. It used to open the draft at the top of the page and still need an Edit Configuration click far below. The draft's \"New version\" notice comes to the top with the editor below it, so the screen says this is the draft; a window too short for both brings the editor to the top instead.",
    steps: [
      'The page shows the draft. The notice "New version. Changes affect future deployments using this Configuration." sits at the top of the window, and Configuration JSON is in view below it with the caret in it; no Edit Configuration button is left to press. Check this at desktop and phone widths.',
      "In a window about 420 px tall, open the story again: Configuration JSON comes to the top with the caret in it, and the notice is above the window.",
      "Choose Cancel: the editor closes and Edit Configuration takes focus.",
    ],
  },
  agentHeaderActions: {
    group: "Pages/Agent detail",
    name: "Header actions",
    path: revision,
    deployed: true,
    rules: [{ path: "/api/auth/session", skip: 1, delayMs: 1500 }],
    description:
      "The Agent header keeps its identity and actions visible while access is rechecked. The delay and Agent data are simulated.",
    steps: [
      "Choose Copy Agent ID. If clipboard access is available, Copied appears briefly; otherwise, the ID is selected for manual copying.",
      "Focus Create new version, switch to another window, then return. During the 1.5-second access check, the action stays visible but cannot be used; focus returns to it after the check.",
      "Repeat the window switch and focus Namespaces while the check is pending. Focus stays in the sidebar when the check finishes.",
      "Choose Create new version to open the draft Configuration without deploying. In the next story, try the Agents back link and Namespace selector while a save is in progress.",
    ],
    nextStory: "authSaveHoldsNavigation",
  },
  longVersionHistory: {
    group: "Pages/Agent detail",
    name: "Long version history",
    path: draft,
    deployed: true,
    revisionHistory: 8,
    revisionPageSize: 3,
    // Each older page takes 1.5 s, so its loading state can be seen.
    rules: [{ suffix: "/revisions", queryParam: "cursor", delayMs: 1500 }],
    description:
      "Versions list one page at a time, newest first. Older versions load on request, and nothing is pruned.",
    steps: [
      "Check that v8, v7, and v6 are listed with Show older versions below the list.",
      "With the keyboard, Tab into the list (focus lands on v8), then Tab once more to Show older versions and press Enter. For about 1.5 s it reads Loading older versions…, looks disabled and keeps focus; pressing Enter again loads nothing more. When v5, v4, and v3 appear, focus is still on Show older versions.",
      "Press Enter again. When v2 and v1 load, the button is gone and focus moves to v2, the first version that loaded, scrolled into view in the list.",
      "Tab out of the list and Shift+Tab back: focus lands on v8. Down and Up move between versions and wrap at either end; Home and End jump to v8 and v1. Tab leaves the list in one press, and Shift+Tab returns to v8, not the version the arrows last reached.",
      "Press Down twice, to v6, then Enter. v6 opens, and the next Tab into the list lands on v6, the viewed version.",
    ],
    gap: "The fixture uses three versions per page; the API default is 50.",
  },
  draftAutomaticCredentials: {
    group: "Pages/Agent detail",
    name: "First deployment creates credentials",
    path: draft,
    transport: false,
    description: "A saved draft can deploy without a separate connection-credential action.",
    steps: [
      "Check that the Agent has no selected version and does not report a Stop request.",
      "Confirm Deploy new version is available and the page explains automatic connection setup.",
      "Select Deploy new version and inspect the admitted version.",
    ],
    gap: "The fixture admits a version but does not model server-side credential creation, delivery, or runtime readiness.",
  },
  configurationNavigation: {
    group: "Pages/Agent detail",
    name: "Keep Configuration edits",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        delayMs: 3000,
        once: true,
      },
    ],
    actions: [
      click("Edit Configuration"),
      { selector: "#configuration-json", value: '{"unfinished":' },
    ],
    description:
      "Unfinished JSON survives tabs, pages, and browser history. Unsaved edits continue to block deployment.",
    steps: [
      "Visit Channels, then Configuration and confirm the unfinished text remains.",
      "Open Namespaces and return with Back. Cancel discards the edit without saving.",
      "Edit again, enter {} and select Save configuration. During the 3-second simulated save, a sidebar link keeps the page and says to wait; once saved, it leaves.",
    ],
    gap: "Simulated UI proof; no deployment or real persistence.",
  },
  agentSharing: {
    group: "Pages/Agent detail",
    name: "Share an Agent",
    path: `${draft}&tab=access`,
    description:
      "Grant an existing person access to this Agent's full native Gateway. Other Agents and OCE administration remain separate.",
    steps: [
      "Enter prn_person-demo as the existing Principal ID.",
      "Review the native-access disclosure, acknowledge it, and share.",
      "Remove the direct binding with the red-edged destructive Remove binding button (it acts at once, with no confirmation); Namespace discovery remains available.",
    ],
  },
  agentSharingGranted: {
    group: "Pages/Agent detail",
    name: "Agent shared",
    path: `${draft}&tab=access`,
    actions: shareExistingPerson,
    description:
      "Namespace discovery and the selected Agent grant are present. Removing the direct grant does not remove other effective access.",
  },
  agentSharingHoldsNavigation: {
    group: "Pages/Agent detail",
    name: "Sharing holds navigation",
    path: `${draft}&tab=configuration`,
    deployed: true,
    rules: [
      {
        suffix: "/iam/access-bindings",
        method: "POST",
        delayMs: 4000,
        once: true,
      },
    ],
    actions: [
      { selector: 'button[aria-label^="View version v1"]', click: true },
      click("Access"),
      ...shareExistingPerson,
      { selector: 'a[data-nav="agents"]', click: true },
    ],
    description:
      "The story opens a version from the draft, shares the Agent, then selects Agents in the sidebar while the first grant is pending. The page stays, and a note at the top of the tab panel says why until both grants are written, about 4 s later.",
    steps: [
      "While the note “This page stays open until sharing finishes.” shows, check that the versions in the Versions rail are disabled, and that ← Agents and Refresh keep the page. Select Reset story to replay the hold.",
      "Open the preview in its own tab to try browser Back. While sharing, Back opens Configuration. Back again keeps that version open and explains why.",
      "When the grants are written, the note goes, Direct Agent grants lists the new binding, and navigation is available again. If you tried Back above, Back now reaches the draft and Forward returns through Configuration to Access.",
    ],
  },
  agentSharingHoldsAfterDelete: {
    group: "Pages/Agent detail",
    name: "Sharing holds navigation after Delete",
    path: `${draft}&tab=access`,
    deployed: true,
    rules: [
      {
        suffix: "/iam/access-bindings",
        method: "POST",
        delayMs: 4000,
        once: true,
      },
      // The deletion status poll never answers, so the Agent stays deleting.
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        skip: 1,
        hold: true,
      },
    ],
    actions: [
      ...shareExistingPerson,
      click("Delete Agent"),
      { selector: ".agent-delete-dialog button.danger", click: true },
      { selector: "a.page-back", click: true },
    ],
    description:
      "The story shares the Agent, deletes it while the first grant is pending, then selects ← Agents. Delete replaces the page with its deletion row; the note above that row says why the page stays until both grants are written, about 4 s later.",
    steps: [
      "While the note “This page stays open until sharing finishes.” shows above Danger zone, select ← Agents or Agents in the sidebar: the page stays and the note remains. Select Reset story to replay the hold.",
      "When the grants are written, the note goes and ← Agents opens the Agents list.",
    ],
    gap: "The deletion status check never answers here, so the Agent stays deleting.",
  },
  agentSharingRemoved: {
    group: "Pages/Agent detail",
    name: "Direct Agent grant removed",
    path: `${draft}&tab=access`,
    actions: [...shareExistingPerson, click("Remove binding")],
    description:
      "The selected direct Agent binding was removed. Namespace discovery and unrelated grants are preserved.",
  },
  agentSharingDenied: {
    group: "Pages/Agent detail",
    name: "Sharing administration denied",
    path: `${draft}&tab=access`,
    rules: [{ suffix: "/iam/roles", status: 403 }],
    description:
      "An Agent's other controls retain their own permissions when sharing administration is unavailable.",
  },
  agentSharingUnknown: {
    group: "Pages/Agent detail",
    name: "Sharing outcome uncertain",
    path: `${draft}&tab=access`,
    actions: shareExistingPerson,
    rules: [{ suffix: "/iam/access-bindings", method: "POST", status: 503, once: true }],
    description:
      "A failed mutation response leaves the outcome uncertain. Refresh current policy before explicitly retrying; no automatic replay occurs.",
  },
  agentSharingRequiredFields: {
    group: "Pages/Agent detail",
    name: "Share Agent required fields",
    path: `${draft}&tab=access`,
    actions: [click("Share Agent")],
    description:
      "Share Agent with no Principal ID and no acknowledgement: both fields show their errors and focus moves to the Principal ID, with no browser bubble.",
  },
  agentPluginsRequiredFields: {
    group: "Pages/Agent detail",
    name: "Plugin selections JSON error",
    path: `${draft}&tab=plugins`,
    actions: [{ selector: "#agent-plugins", value: "[]" }, click("Save plugin selections")],
    description:
      "Save with Plugin selections JSON that is not an object: the error shows under the JSON and focus moves to it, with no browser bubble.",
  },
  agentAuthenticationRequiredFields: {
    group: "Pages/Agent detail",
    name: "Authentication source required fields",
    path: `${draft}&tab=credentials`,
    auth: null,
    actions: [
      { selector: "#harness-auth-method", value: "api_key" },
      click("Save authentication source"),
    ],
    description:
      "API key with no Secret: the API key Secret field shows its error under the control and takes focus, with no browser bubble.",
  },
  agentWorkspaceRequiredFields: {
    group: "Pages/Agent detail",
    name: "Workspace file too large",
    path: `${revision}&tab=workspace`,
    deployed: true,
    actions: [
      { selector: '[id="workspace-AGENTS.md"]', value: "a".repeat(16_385) },
      click("Save AGENTS.md"),
    ],
    description:
      "Save a file over 16 KiB: the error shows under AGENTS.md and focus moves to it, with no browser bubble. Reload clears it.",
    gap: "Simulated files; no live Agent gateway.",
  },
  configurationEditor: {
    group: "Pages/Agent detail",
    name: "Edit Configuration",
    path: draft,
    actions: [click("Edit Configuration")],
    rules: [
      {
        method: "PATCH",
        suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
        delayMs: 1500,
      },
    ],
    description:
      "Save this draft without leaving the editor’s place on the page. Deployment is a separate action.",
    steps: [
      "Choose Edit Configuration with the keyboard. Focus moves to the Configuration JSON editor.",
      "Change a draft setting. Focus Save Configuration and press Enter; “Checking Configuration…” takes focus while Save is disabled.",
      "If you stay in the editor, focus returns to Edit Configuration with “Configuration saved.” as its description.",
      "Edit and save once more. Move focus to the Agents link before the save finishes; focus stays on the link.",
      "Visit Plugins, then Channels, then Configuration. Edit and save a setting, then use browser Back while the save is in progress. Configuration stays open to show the result.",
      "After “Configuration saved.”, use Back once to return to Channels. Forward returns to Configuration without saving again.",
    ],
  },
  configurationSaveRefused: {
    group: "Pages/Agent detail",
    name: "Edit Configuration refused",
    path: draft,
    rules: [
      {
        method: "PATCH",
        suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    actions: [click("Enable gateway password access"), click("Save Configuration")],
    description:
      "A viewer without Configuration update saves: the refusal is an alert that takes focus and comes into view.",
  },
  configurationSaveUnconfirmed: {
    group: "Pages/Agent detail",
    name: "Save response names another Configuration",
    path: draft,
    configurationSaveResponseId: "cfg_00000000-0000-4000-8000-000000000002",
    description:
      "The simulated save succeeds, but the response names a different Configuration. The editor requires a reload before another save.",
    steps: [
      "Choose Enable gateway password access, then Save Configuration. Save stays disabled and the message says the outcome is unknown.",
      "Choose Reload draft. The saved password reference is visible without a second save.",
    ],
  },
  gatewayPasswordAccess: {
    group: "Pages/Agent detail",
    name: "Enable gateway password access",
    path: draft,
    deployed: true,
    description: "Configure the generated gateway password without typing native JSON.",
    steps: [
      "Select Enable gateway password access. The draft receives a password reference; no password value is displayed.",
      "Cancel to discard the edit, or Save Configuration to persist it.",
      "Confirm the saved-access message, then Deploy new version to apply the reference.",
    ],
    gap: "Simulated UI proof; does not verify credential generation, delivery, or a real Gateway login.",
  },
  gatewayPasswordEnabled: {
    group: "Pages/Agent detail",
    name: "Gateway password access configured",
    path: draft,
    gatewayPassword: true,
    description:
      "The saved Configuration uses the generated password; deployment is still required to apply edits.",
  },
  gatewayPasswordSaveDenied: {
    group: "Pages/Agent detail",
    name: "Gateway password save denied",
    path: draft,
    actions: [click("Enable gateway password access"), click("Save Configuration")],
    rules: [
      {
        method: "PATCH",
        suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
        status: 403,
      },
    ],
    description:
      "A denied save names the Configuration update grant it needs, retains the draft and does not change the saved Configuration.",
  },
  gatewayPasswordSaving: {
    group: "Pages/Agent detail",
    name: "Gateway password save in progress",
    path: draft,
    actions: [click("Enable gateway password access"), click("Save Configuration")],
    rules: [
      {
        method: "PATCH",
        suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
        hold: true,
      },
    ],
    description:
      "A pending save blocks further Configuration edits and deployment; a timed-out write requires draft readback.",
  },
  pluginsUpdateDenied: {
    group: "Pages/Agent detail",
    name: "Plugin selections, viewer cannot update the Agent",
    path: `${draft}&tab=plugins`,
    deployed: true,
    auth: "codex_pat",
    agentPlugins: JSON.parse(pluginSelections),
    pluginCapabilities,
    pluginDiscovery,
    readOnlyPermissionSummary: true,
    description:
      "The permission answer denies Agent update, so Save plugin selections and the plugin fields are disabled, the saved selections stay in view, and the note names the grant to ask for. The API still decides.",
    gap: "The permission answer is simulated; the API still authorizes every save.",
  },
  pluginsToolRefusal: {
    group: "Pages/Agent detail",
    name: "Plugin selections refused by the Configuration",
    path: `${draft}&tab=plugins`,
    // Keep the scroll the refusal's focus gives, rather than jump back to the tabs.
    scrollToTabs: false,
    deployed: true,
    auth: "codex_pat",
    pluginCapabilities,
    pluginDiscovery,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 400,
        code: "INVALID_REQUEST",
        message: pluginToolRefusal,
      },
    ],
    actions: [
      { selector: ".plugin-json > summary", click: true },
      { selector: "#agent-plugins", value: pluginSelections },
      { ...click("Save plugin selections"), focus: true },
    ],
    description:
      "The Configuration denies every tool of the selected plugin, so the API refuses the save. The refusal shows as an error and takes focus; editing the selections clears it.",
    gap: "The refusal is simulated; the in-memory API's plugin check is covered by tests/browser/console-agent-plugin-refusals.test.mjs.",
  },
  pluginsDraft: {
    group: "Pages/Agent detail",
    name: "Edit plugins in new version",
    path: draft,
    deployed: true,
    auth: "codex_pat",
    agentPlugins: JSON.parse(pluginSelections),
    pluginCapabilities,
    pluginDiscovery,
    actions: [click("Plugins")],
    description:
      "Edit Agent-owned plugin selections on the draft while the admitted version keeps its original snapshot.",
    steps: [
      "The first catalog page loads in the background when the Plugins tab opens, using the saved Service Accounts token. Open Configure plugins to review Calendar's saved policy.",
      "Open Calendar and inspect the tool IDs beneath their titles. Type create into Filter tools, then clear it; filtering should keep the cursor in the search box.",
      "In Available, select Calendar, filter tools by create, and expand Create event. Switch to Configured, filter plugins by Calendar, and choose Calendar with a different tool filter. Round-trip the tabs: each keeps its selection, query, tool filter, and expanded rows without another catalog request.",
      "Remove Calendar from Configured: its details clear even though Available still lists it. Add Calendar again from Available; Configured must not restore the removed detail state.",
      "In Configure plugins, change Calendar's tool policy, add Documents from the next page, and select Done.",
      "Select Save plugin selections. The tab updates in place: the page keeps its scroll and focus moves to Plugin selections saved. Then select Deploy new version and compare the new version with the earlier immutable plugin snapshot.",
    ],
    gap: "Catalog and deployment responses are simulated. This does not verify plugin access, installation, policy enforcement, or a live Agent turn.",
  },
  pluginApproversInherited: {
    group: "Pages/Agent detail",
    name: "Plugin approver inheritance",
    path: draft,
    slack: true,
    auth: "codex_pat",
    agentPlugins: JSON.parse(pluginSelections),
    agentPluginApprovers: [{ channel: "slack", id: "team:TDEMO123:user:UDEMO123" }],
    pluginCapabilities: overrideApproverCapabilities,
    pluginDiscovery,
    actions: [
      click("Plugins"),
      click("Configure plugins"),
      { selector: 'button[aria-label="Calendar"]', click: true },
      {
        selector: 'details.plugin-tool-row[data-tool="app_calendar/create_event"] > summary',
        click: true,
      },
    ],
    description:
      "The Agent default has one workspace-qualified Slack user. Calendar inherits that list, and Create event inherits Calendar. Clearing a plugin or tool override restores inheritance.",
    gap: overrideApproverGap,
  },
  pluginApproversOverrides: {
    group: "Pages/Agent detail",
    name: "Plugin and tool approver overrides",
    path: draft,
    slack: true,
    auth: "codex_pat",
    agentPlugins: pluginApproverOverrides,
    agentPluginApprovers: [{ channel: "slack", id: "team:TDEMO123:user:UDEMO123" }],
    pluginCapabilities: overrideApproverCapabilities,
    pluginDiscovery,
    actions: [
      click("Plugins"),
      click("Configure plugins"),
      { selector: 'button[aria-label="Calendar"]', click: true },
      {
        selector: 'details.plugin-tool-row[data-tool="app_calendar/create_event"] > summary',
        click: true,
      },
    ],
    description:
      "Calendar explicitly has no Slack approvers, while Create event overrides it with a different user. The UI distinguishes both from inherited lists.",
    steps: [
      "Change Calendar to Inherit Agent default approvers and inspect Plugin selections JSON.",
      "Search Create event tool approvers people to distinguish the two Alex Chen results by their handles.",
    ],
    gap: overrideApproverGap,
  },
  pluginApproversLookup: {
    group: "Pages/Agent detail",
    name: "Find Slack plugin approvers",
    path: draft,
    slack: true,
    auth: "codex_pat",
    agentPlugins: JSON.parse(pluginSelections),
    agentPluginApprovers: [],
    pluginCapabilities,
    actions: [
      { selector: '.content [aria-live="polite"][aria-busy="false"]' },
      click("Plugins"),
      { selector: 'select[aria-label="Default plugin approvers mode"]', value: "chosen" },
      { selector: '[aria-label="Default plugin approvers people"]', focus: true },
      { selector: '[aria-label="Default plugin approvers people"]', value: "Alex" },
      { selector: '[aria-label="Default plugin approvers people results"] [role="option"]' },
    ],
    description:
      "The selected bot Secret resolves names within Demo workspace. The open Alex search keeps its results on browser refocus; choosing one shows their name and handle and saves a team-qualified selector.",
    steps: [
      "Switch to another browser tab and return. The open query and results remain while Agent access is checked.",
      "Move focus to another Console control to close the list, then focus the search field to reopen it.",
    ],
    gap: "The fixture simulates directory data; it does not contact Slack or read a real Secret.",
  },
  pluginApproversDirectoryUnavailable501: {
    group: "Pages/Agent detail",
    name: "Plugin approvers accept raw Slack IDs",
    path: draft,
    slack: true,
    auth: "codex_pat",
    agentPlugins: JSON.parse(pluginSelections),
    agentPluginApprovers: [],
    pluginCapabilities,
    pluginDiscovery,
    rules: [{ suffix: "/channel-directory/lookup", method: "POST", status: 501 }],
    actions: [
      { selector: '.content [aria-live="polite"][aria-busy="false"]' },
      click("Plugins"),
      { selector: 'select[aria-label="Default plugin approvers mode"]', value: "chosen" },
      { selector: '[aria-label="Default plugin approvers people"]', focus: true },
      { selector: '[aria-label="Default plugin approvers people"]', value: "UDEMO123" },
      { selector: ".slack-directory-panel:not([hidden]) .status:not(:empty)" },
      click("Add UDEMO123"),
      click("Save plugin selections"),
      { selector: '.content [aria-live="polite"][aria-busy="false"]' },
    ],
    description:
      "When the API reports channel directory lookup as unavailable, the approver field still accepts a raw Slack user ID and saves it on the draft Agent.",
    steps: [
      "Confirm the directory error explains that exact IDs can still be entered.",
      "Review the saved default plugin approver chip: Name unavailable keeps the selection visible and removable when the directory cannot resolve it.",
      "Open Plugin selections JSON or inspect the saved Agent response in browser tools to confirm the plugin policy JSON was not changed by the approver save.",
    ],
    gap: "The 501 directory response, Slack user ID, and Agent save are simulated. This proves Console behavior only, not Slack identity validity or runtime approval delivery.",
  },
  pluginsAdmitted: {
    group: "Pages/Agent detail",
    name: "Plugins in admitted version",
    path: revision,
    deployed: true,
    agentPlugins: JSON.parse(pluginSelections),
    pluginCapabilities,
    actions: [click("Plugins")],
    description: "An admitted version shows its immutable Agent-owned plugin selection and policy.",
  },
  invalidConfiguration: {
    group: "Pages/Agent detail",
    name: "Invalid Configuration JSON",
    path: draft,
    actions: [
      click("Edit Configuration"),
      { selector: "#configuration-json", value: "{ invalid" },
      click("Save Configuration"),
    ],
    description:
      "Invalid JSON is reported under the editor with its line and column. The editor keeps its contents and sends no Configuration write.",
  },
  invalidConfigurationInvisibleCharacters: {
    group: "Pages/Agent detail",
    name: "Invalid Configuration JSON after invisible characters",
    path: draft,
    actions: [
      click("Edit Configuration"),
      // A left-to-right mark, a soft hyphen and a word joiner, as pasted from a document.
      { selector: "#configuration-json", value: '{"name": "a\u200Eb\u00ADc\u2060d", x}' },
      click("Save Configuration"),
    ],
    description:
      "The name hides a left-to-right mark, a soft hyphen and a word joiner, which take no visible space. The error names column 18, where the stray x appears, not the 21st character.",
    steps: [
      "Read the error under the editor: Invalid JSON at line 1, column 18.",
      "Count the visible characters on the line: the x is the 18th.",
    ],
  },
  configurationChangedElsewhereMerged: {
    group: "Pages/Agent detail",
    name: "Configuration edits merged over another browser's save",
    path: draft,
    configurationChangedElsewhere: {
      values: { gateway: { bind: "loopback" }, agents: { defaults: { model: "codex/gpt-5.1" } } },
    },
    actions: [
      click("Edit Configuration"),
      {
        selector: "#configuration-json",
        value: JSON.stringify(
          {
            gateway: { mode: "local", bind: "lan" },
            agents: {
              defaults: {
                model: "codex/gpt-4.1",
                models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
              },
            },
            channels: {},
          },
          null,
          2,
        ),
      },
      click("Save Configuration"),
      click("Reload draft"),
    ],
    description:
      "Another browser changed the model and the gateway bind while this editor set the bind. Reload draft merges this reader's edit over the reread document and names the value both changed.",
    steps: [
      "Check the note names /gateway/bind with the saved value, and the editor keeps the other browser's model with this reader's bind.",
    ],
  },
  admitted: {
    group: "Pages/Agent detail",
    name: "Current version",
    path: revision,
    deployed: true,
    description:
      "v1 is selected, its recorded deployment completed, and live serving is not verified.",
    steps: [
      "Open Deployment details with Enter to inspect the completed stages. Refresh deployment; your disclosure choice is preserved.",
    ],
  },
  repositoryDraft: {
    group: "Pages/Agent detail",
    name: "Repository access in new version",
    path: draft,
    repositoryBindings: [
      { repositoryRef: "application", profile: "git-write" },
      { repositoryRef: "handbook", profile: "git-read" },
    ],
    description:
      "The new version draft names Contributor and Read-only access and shows write limits.",
  },
  repositoryEditor: {
    group: "Pages/Agent detail",
    name: "Edit inherited and custom repository access",
    path: `${draft}&tab=repositories`,
    repositoryAccess: {
      defaultProfile: "git-full",
      repositories: [
        { repositoryRef: "application" },
        { repositoryRef: "handbook", profile: "git-read" },
      ],
    },
    repositoryBindings: [
      { repositoryRef: "application", profile: "git-full" },
      { repositoryRef: "handbook", profile: "git-read" },
    ],
    description:
      "Reopening the desired configuration keeps the Agent default and each explicit override. Saving changes updates the draft; admitted revisions retain their prior access.",
    steps: [
      "Visit Channels, return to Repositories, change a selection, then press browser Back. The selection stays, with a note to save or cancel before leaving.",
      "Cancel the edit. Back returns to Channels; Forward opens Repositories with the saved selection.",
    ],
  },
  repositoryEditorNotConfigured: {
    group: "Pages/Agent detail",
    name: "Repository access without a Repo Driver",
    path: `${draft}&tab=repositories`,
    repositoryAccess: {
      defaultProfile: "git-full",
      repositories: [{ repositoryRef: "application" }],
    },
    repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/repository-options",
        status: 503,
        code: "REPOSITORY_OPTIONS_UNAVAILABLE",
      },
    ],
    description:
      "The Installation has no Repo Driver: the tab names the setup step, links the runbook, offers no Retry, and keeps Save repository access disabled.",
    gap: "Simulated UI proof only; this preview does not configure a Repo Driver.",
  },
  repositoryEditorLoading: {
    group: "Pages/Agent detail",
    name: "Repository access while choices load",
    path: `${draft}&tab=repositories`,
    repositoryAccess: {
      defaultProfile: "git-full",
      repositories: [{ repositoryRef: "application" }],
    },
    repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/repository-options",
        hold: true,
      },
    ],
    description:
      "Repository choices are still loading. The selected repository's summary reads “Access awaiting verification” in a blue badge: nothing is wrong yet, so it is not red.",
    gap: "The simulated repository choices never answer in this story.",
  },
  repositoryEditorUpdateDenied: {
    group: "Pages/Agent detail",
    name: "Repository access, viewer cannot update the Agent",
    path: `${draft}&tab=repositories`,
    repositoryAccess: {
      defaultProfile: "git-full",
      repositories: [{ repositoryRef: "application" }],
    },
    repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    readOnlyPermissionSummary: true,
    description:
      "The permission answer denies Agent update, so Save repository access and the repository fields are disabled (Cancel stays), and the note names the grant to ask for.",
    gap: "The permission answer is simulated; the API still authorizes every save.",
  },
  repositoryEditorSaveRefused: {
    group: "Pages/Agent detail",
    name: "Repository access save refused",
    path: `${draft}&tab=repositories`,
    repositoryAccess: {
      defaultProfile: "git-full",
      repositories: [{ repositoryRef: "application" }],
    },
    repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    rules: [
      {
        suffix: "/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    actions: [
      { selector: "#repository-default-git-read", click: true },
      click("Save repository access"),
    ],
    description:
      "The Agent update is refused. The refusal is a danger block under the editor and takes focus; the grey line keeps progress and unsaved-change notes only.",
    gap: "The refusal is simulated; the API decides every save.",
  },
  repositoryAdmitted: {
    group: "Pages/Agent detail",
    name: "Repository access in current version",
    path: revision,
    deployed: true,
    repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    description:
      "The admitted snapshot names Contributor access and retains the write-limit notice. This fixture does not establish provider authorization or runtime execution.",
  },
  deploymentPending: {
    group: "Pages/Agent detail",
    name: "New version queued",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "queued",
    description:
      "v7 is admitted and queued without a live worker claim. v6 remains selected; serving is unverified. Deployment details keep Last recorded result, Reason and Since rows (not recorded yet), so the first result fills them in place.",
    steps: [
      'Selected version reads v6. v7\'s Configuration tab notice begins "Deploying version", not "Historical version".',
    ],
  },
  deploymentRunning: {
    group: "Pages/Agent detail",
    name: "New version in progress",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "running",
    description:
      "A worker holds the v7 deployment claim while v6 remains selected. The API does not expose finer runtime stages.",
    steps: [
      'Selected version reads v6. v7\'s Configuration tab notice reads "Deploying version · read-only admitted snapshot. It becomes the current version only if its deployment completes."',
    ],
  },
  deploymentRunningActivates: {
    group: "Pages/Agent detail",
    name: "New version in progress, then current",
    path: `${candidateVersion}&tab=configuration`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    description:
      "v7 is deploying while v6 stays selected, then the next status poll records success and selects v7. Its notice goes from Deploying version to Current version without showing Historical version in between. The deployment and activation are simulated.",
    steps: [
      'On arrival the notice begins "Deploying version" and Selected version reads v6.',
      "Before the status poll lands, Tab into the Versions list (focus lands on v7, the viewed version) and press Down to v6.",
      'Within about 5 s the notice begins "Current version" and Selected version reads v7. The Versions list is rebuilt with v7 marked Current, and focus stays on v6; Tab out and back lands on v6.',
    ],
  },
  deploymentCompletesRereadFails: {
    group: "Pages/Agent detail",
    name: "New version completes, Agent reread fails",
    path: `${candidateVersion}&tab=configuration`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    // The page's own Agent read answers; the reread after the deployment completes fails.
    rules: [{ suffix: "/agents/agt_00000000-0000-4000-8000-000000000001", skip: 1, status: 503 }],
    description:
      "v7's deployment completes, but the Agent reread that would make it current fails. The notice says the deployment completed and that the current version could not be refreshed, rather than Deploying beside Completed. The deployment and the failure are simulated.",
    steps: [
      'On arrival the notice begins "Deploying version" and Selected version reads v6.',
      'Within about 5 s Latest visible deployment reads "v7 · Completed", the page says the current version and version history could not be refreshed, and the notice reads "Deployed version · read-only admitted snapshot. Its deployment completed, but the current version could not be refreshed."',
    ],
  },
  deploymentStatusReadRecovers: {
    group: "Pages/Agent detail",
    name: "New version in progress, one status read fails",
    path: `${candidateVersion}&tab=configuration`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    // The first poll after arrival fails once; the next one records success.
    rules: [
      {
        suffix: "/deployments/rev_00000000-0000-4000-8000-000000000007",
        skip: 1,
        once: true,
        status: 503,
      },
    ],
    description:
      "One deployment status read fails while v7 is deploying. The notice keeps Deploying version rather than turning Historical, polling continues, and the next read records success and makes v7 current. The deployment, failure and activation are simulated.",
    steps: [
      'On arrival the notice begins "Deploying version". Within about 5 s Latest visible deployment reads "v7 · Unavailable" and the notice still begins "Deploying version".',
      'Within about 10 s the notice begins "Current version" and Selected version reads v7, with no "Historical version" in between.',
    ],
  },
  deploymentDeferred: {
    group: "Pages/Agent detail",
    name: "Deployment waiting for runtime",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "queued",
    deploymentLastAttempt: {
      at: "2026-09-26T22:53:00.000Z",
      code: "REVISION_INCOMPLETE",
      message: "Waiting for the runtime to become ready.",
    },
    description:
      "v7 has already been checked and is waiting for another reconciliation. Its last result and timestamp remain distinct from current runtime health.",
    steps: [
      "Read the pending reason and Since time in Deployment activity.",
      "Click Refresh deployment; the simulated pending result remains visible.",
      "View v6 and confirm the latest deployment still describes v7.",
    ],
    gap: "Simulated API results demonstrate presentation only. PostgreSQL integration covers durable work attribution.",
  },
  deploymentRetrying: {
    group: "Pages/Agent detail",
    name: "Deployment retry after dependency failure",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "running",
    deploymentLastAttempt: {
      at: "2026-09-26T22:53:00.000Z",
      code: "DEPENDENCY_UNAVAILABLE",
      message: "A dependency was unavailable. The controller will retry.",
    },
    description:
      "A worker is active again. The previous dependency failure is explicitly labeled as the last recorded result, not a current failure or a terminal outcome.",
  },
  currentVersionDuringDeployment: {
    group: "Pages/Agent detail",
    name: "Current version during deployment",
    path: currentVersion,
    deployed: true,
    candidateDeploymentStatus: "running",
    description:
      "Inspect v6 details while the newest deployment, v7, is still in progress. Browsing does not change selection.",
  },
  agentsLongName: {
    group: "Pages/Agents",
    name: "Long unbroken name",
    deployed: true,
    agentName: "ResearchAssistantForTheQuarterlyReleaseReviewAndSignOff".repeat(4).slice(0, 200),
    description:
      "One Agent has the longest allowed name, 200 characters with no space. The name wraps within the width of its ID, so the other columns keep their places.",
    steps: [
      "At a desktop width the table does not scroll sideways, and every column shows beside the long name.",
      "Tab to the long name and press Enter: the Agent opens.",
    ],
  },
  agentsLongNameDigits: {
    group: "Pages/Agents",
    name: "Long name of digit groups",
    deployed: true,
    agentName: Array.from({ length: 40 }, (_, index) => String(1000 + index))
      .join("-")
      .slice(0, 200),
    description:
      "A 200-character name of digit groups joined by hyphens. A browser breaks a line after each hyphen, so the name wraps at its hyphens like any hyphenated name.",
    steps: [
      "At a desktop width the table does not scroll sideways, and every column shows beside the long name.",
    ],
  },
  agentsLongNamePunctuation: {
    group: "Pages/Agents",
    name: "Long name with punctuation after hyphens",
    deployed: true,
    agentName: Array.from({ length: 50 }, () => "abc")
      .join("-.5")
      .slice(0, 200),
    description:
      "A 200-character name of letter groups joined by a hyphen, a full stop and a digit. A browser does not break a line at a hyphen before closing punctuation, so the console treats the name as unbroken and it wraps within the width of its ID.",
    steps: [
      "At a desktop width the table does not scroll sideways, and every column shows beside the long name.",
    ],
  },
  agentsLongNameDashes: {
    group: "Pages/Agents",
    name: "Long name of em dashes",
    deployed: true,
    agentName: "\u2014".repeat(200),
    description:
      "A name of 200 em dashes. A browser does not break a line between two em dashes, so the name wraps within the width of its ID.",
    steps: [
      "At a desktop width the table does not scroll sideways, and every column shows beside the long name.",
    ],
  },
  agentsLongNameJoiners: {
    group: "Pages/Agents",
    name: "Long name of word-joiner runs",
    deployed: true,
    agentName: `Joiners ${`${"\u2060".repeat(20)} `.repeat(9)}`.trimEnd(),
    actions: [{ selector: 'input[type="search"]', value: "Joiners" }],
    description:
      "A 196-character name of word-joiner (U+2060) runs of 20, each just short of the long-name threshold, found by a search. Checking such a name took seconds and froze the list on load and on each search keystroke (finding 1999); the check is now linear, so search answers at once and the name wraps as before.",
    steps: [
      "Clear Search Agents, then type Joiners one letter at a time. Each letter filters the list at once, and the Agent stays listed.",
    ],
  },
  agentsLongNameMixed: {
    group: "Pages/Agents",
    name: "Long name held by emoji, quotes and digits",
    deployed: true,
    agentName: "\u043e\u0442\u0447\u0451\u0442-2026-\u00abbuild\u00bb\u26a1deploy\u26a1"
      .repeat(10)
      .slice(0, 200),
    description:
      "A 200-character name of Cyrillic words, digits after hyphens, quoted words and lightning emoji. A browser breaks a line at none of these, so the name has no break at all; the console now treats it as unbroken and it wraps within the width of its ID, where before it widened the table (findings 2000 and 2001).",
    steps: [
      "At a desktop width the table does not scroll sideways, and every column shows beside the long name.",
    ],
  },
  agentsLongNamePhone: {
    group: "Pages/Agents",
    name: "Long unbroken name (phone)",
    deployed: true,
    mobile: true,
    agentName: "ResearchAssistantForTheQuarterlyReleaseReviewAndSignOff".repeat(4).slice(0, 200),
    description:
      "The same 200-character name at 390 px wraps inside its stacked row, and the page does not scroll sideways.",
  },
  agentsIdLigaturesPhone: {
    group: "Pages/Agents",
    name: "Agent ID with ff (phone)",
    deployed: true,
    mobile: true,
    agentId: "agt_ffffffff-ffff-4fff-bfff-ffffffffffff",
    description:
      'Each character of an ID is its own glyph: "ff" never draws as a ligature, so this ID is as wide as one with no "f". To compare, view it where the monospace font has ligatures (Nimbus Mono PS, a common Linux default): before finding 2114 each "ff" there drew as one glyph, and this ID was a third shorter.',
  },
  agentsDeploymentFailed: {
    group: "Pages/Agents",
    name: "Latest deployment failed",
    deployed: true,
    candidateDeploymentStatus: "failed",
    bootstrapFailure: true,
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    description:
      "The list shows the newest visible failure beside the current version, without asserting serving health. The failure keeps to one line, so the row keeps its height when the read lands; its title and the Agent page give the whole text.",
    steps: [
      'Current version reads "v6", not an ID, and the latest deployment reads "v7 · Failed": the words the Agent page uses.',
      "Hover the one-line failure to read its whole text.",
      "Open the failed v7 deployment link and inspect retained credential preparation evidence.",
    ],
  },
  deploymentBootstrapCleanup: {
    group: "Pages/Agent detail",
    name: "Bootstrap failure with cleanup pending",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    bootstrapFailure: true,
    cleanupStatus: "queued",
    cleanupCompletes: true,
    description:
      "A failed deployment stays failed while its separate cleanup completes. Safe evidence remains after the Pod disappears.",
    steps: [
      "Read the failing oauth-bootstrap exit status beside the successful init container.",
      "Wait for revision cleanup to change from pending to completed; the deployment must still show failed.",
    ],
  },
  agentsDeploymentDenied: {
    group: "Pages/Agents",
    name: "Latest deployment access denied",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    deployed: true,
    latestDeploymentReadStatus: 403,
    description:
      "Agent identity and current pointer remain visible while deployment access is denied.",
    steps: [
      "Current version cannot be named by number without the versions read, so it shows the selected version's short ID as a link, in code type.",
    ],
  },
  agentsDeploymentLoading: {
    group: "Pages/Agents",
    name: "Latest deployment loading",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    deployed: true,
    latestDeploymentReadDelay: 6000,
    description:
      "Deployment reads show loading beside the current pointer, then show the visible result.",
    steps: [
      'Current version reads "Reading version…" and Latest deployment "Reading deployment…" until the versions read lands; then they read "v1" and "v1 · Completed".',
    ],
  },
  agentsCurrentVersionOlder: {
    group: "Pages/Agents",
    name: "Current version older than the first page",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    deployed: true,
    candidateDeploymentStatus: "failed",
    revisionPageSize: 1,
    rules: [
      {
        suffix: "/revisions/rev_00000000-0000-4000-8000-000000000006",
        delayMs: 4000,
        once: true,
      },
    ],
    description:
      "The newest page of versions lists only v7, so the current v6 is read on its own while the latest deployment fills from that page.",
    steps: [
      'Latest deployment reads "v7 · Failed" while Current version still reads "Reading version…". About 4 s later it reads "v6".',
    ],
    gap: "The fixture lists one version per page so the current version falls off the first page; the API default is 50.",
  },
  agentsCurrentVersionDenied: {
    group: "Pages/Agents",
    name: "Current version unreadable",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    deployed: true,
    candidateDeploymentStatus: "failed",
    revisionPageSize: 1,
    rules: [
      {
        suffix: "/revisions/rev_00000000-0000-4000-8000-000000000006",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "The current v6 is off the first page and its own read is refused, so Current version keeps its short ID. The console remembers the refusal for the session, as the Agent page does, and does not ask again.",
    steps: [
      'Current version shows the short ID as a link, in code type, and Latest deployment reads "v7 · Failed".',
    ],
  },
  agentsReturnWhileDeploymentsLoad: {
    group: "Pages/Agents",
    name: "Return while deployments load",
    deployed: true,
    rules: [
      {
        suffix: "/deployments/rev_00000000-0000-4000-8000-000000000001",
        skip: 1,
        delayMs: 2500,
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "Back reveals the rechecked Agents list before a slow deployment read finishes. The previous result does not stand in for the pending one.",
    steps: [
      "Wait for the Research assistant’s deployment, open Documentation assistant, then use browser Back.",
      "The list is usable immediately. Latest deployment starts blank; after 250 ms it says “Reading deployment…”, never linking to the old result. When access is denied, the Agent stays visible.",
      "After Back, focus the Research assistant link while its deployment still reads, switch windows, then return. The same list returns with focus on the link.",
    ],
  },
  agentsDeploymentError: {
    group: "Pages/Agents",
    name: "Latest deployment unavailable",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    deployed: true,
    latestDeploymentReadStatus: 503,
    description:
      "An interrupted deployment read leaves the Agent and current pointer visible without guessing an outcome.",
  },
  runtimeBootstrapContainers: {
    group: "Pages/Agent detail",
    name: "Bootstrap container status and logs",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "failed",
    bootstrapFailure: true,
    bootstrapRuntime: true,
    description:
      "The Pod card names both containers; the writer's exit 1 is visible beside the init container's exit 0.",
    steps: [
      "Switch Pod / container from oauth-bootstrap to prepare-oauth-home and read its initialization output.",
      "Switch back to oauth-bootstrap to inspect the failed writer.",
    ],
  },
  deploymentFailed: {
    group: "Pages/Agent detail",
    name: "New version failed",
    path: currentVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    description:
      "While viewing current v6, deployment activity reports failed v7 with bounded startup failure evidence. Open v7 Logs selects that failed version and brings its output into view.",
    steps: [
      "Above the facts, the failure is one danger status block: a red stripe on a light red wash, the label DEPLOYMENT FAILED · V7, the title This Agent may be offline, and CONVERGENCE_DEADLINE_EXCEEDED in code at the end of the first sentence. Open v7 Logs is the page's one filled button; at 390 wide it spans the block.",
      "In Deployment details, the three step tiles are white cards with a light edge; only the failed Deployment work tile has a red wash, and each marker carries its step's colour.",
      'In the Versions list, v7 reads "v7", a space, then a red "Failed" badge; v6 keeps its blue "Current" badge and no other version has an outcome badge. A screen reader announces "View version v7, deployment failed".',
      "Select Open v7 Logs in Deployment activity. The version selector changes from v6 to v7 and the Logs tab receives focus and its panel scrolls into view.",
      "Check the simulated Pod status and operational output, then use Back to return to v6. Browsing leaves v6 selected for service.",
    ],
    gap: "Runtime status and output are simulated UI evidence; this story does not verify a live deployment or log read.",
  },
  sandboxLost: {
    group: "Pages/Agent detail",
    name: "Current version's Sandbox lost",
    path: currentVersion,
    deployed: true,
    harness: { state: "lost", code: "SANDBOX_STOPPED" },
    description:
      "The current version's Sandbox stopped (for example after a node restart) and OCC does not restart it. The Agent still reads active, so Live serving says the Sandbox is lost and names the next step.",
    steps: [
      'Live serving shows a red "Sandbox lost" badge and, on the line under it, "Deploy a new version." The line was reserved while the Sandbox was read, so nothing below moved.',
      "At 390 and 900 wide the note stays on one line under the badge.",
    ],
    gap: "The Sandbox record is simulated; this story does not verify a live OpenShell read or a node restart.",
  },
  sandboxRunning: {
    group: "Pages/Agent detail",
    name: "Current version's Sandbox running",
    path: currentVersion,
    deployed: true,
    harness: { state: "running" },
    description:
      "A healthy Sandbox carries no warning: Live serving stays Not verified, with Sandbox running under it.",
  },
  sandboxStatusUnknown: {
    group: "Pages/Agent detail",
    name: "Sandbox status unknown",
    path: currentVersion,
    deployed: true,
    harness: { state: "unknown", code: "UNAVAILABLE" },
    description:
      "The Sandbox Driver could not read the Sandbox record. Live serving stays Not verified and says the Sandbox status is unknown; it never reports a Sandbox it could not read as lost.",
  },
  agentHeader: {
    group: "Pages/Agent detail",
    name: "Page header with a long name",
    path: currentVersion,
    deployed: true,
    agentName: "Quarterly release review and signoff bot",
    description:
      "The Agent page header: ← Agents, the name with Refresh and Create new version at its right, then the Agent ID, Copy Agent ID and the compact Namespace control in the row under it.",
    steps: [
      "At 1440 and 1024 the 40-character name wraps on the left; Refresh and Create new version stay on its first line and nothing overlaps.",
      "Select Copy Agent ID. The ID is on the clipboard and Copied shows beside the button for two seconds.",
      "Choose Research in the Namespace control; the console opens Research's Agents list, as the header selector always has. Go Back.",
      "Select Create new version; the draft opens and its header shows Refresh only.",
      "On the draft, select Edit Configuration and change a value, then select ← Agents. The page stays and says why, as the sidebar does.",
    ],
  },
  agentHeaderMobile: {
    group: "Pages/Agent detail",
    name: "Page header at 390px",
    path: currentVersion,
    deployed: true,
    mobile: true,
    description:
      "At 390px the header is four rows: ← Agents with Refresh and Create new version, the name, the Agent ID with Copy Agent ID, then the Namespace control at full width. It ends by 240px.",
    steps: [
      "Check that the ID row has no trailing separator and the Namespace control spans the row.",
      "Leave the window and come back while the access recheck runs: Create new version is held with the page, and focus returns to it afterwards.",
    ],
  },
  agentHeaderNoClipboard: {
    group: "Pages/Agent detail",
    name: "Copy Agent ID without clipboard access",
    path: currentVersion,
    deployed: true,
    clipboard: "unavailable",
    actions: [{ selector: ".page-meta-copy", click: true }],
    description:
      "Where the browser offers no clipboard (an http origin, say), Copy Agent ID selects the ID instead, so it can be copied by hand.",
    steps: ["Check that the Agent ID is selected and no Copied status appears."],
  },
  draftCredentialRejected: {
    group: "Pages/Agent detail",
    name: "Next step after a rejected credential",
    path: draft,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateCredentialRejected: true,
    description:
      "The provider rejected v7's model credential and the draft still uses it. Prepare this version keeps Check authentication and credentials open and never says Ready to deploy: deploying again does not fix the credential.",
    steps: [
      "In Prepare this version, the first step has a check and the second an open ring with the detail The last deployment's model credential was rejected.",
      "Beside Deploy new version the status asks to update or replace the credential in Credentials first. Deploy stays enabled because a Secret value can be updated in place.",
    ],
    gap: "The rejected credential is simulated deployment evidence; this story does not call a model provider.",
  },
  deploymentFailedLogsFromDraft: {
    group: "Pages/Agent detail",
    name: "Failed deployment logs from draft",
    path: draft,
    deployed: true,
    candidateDeploymentStatus: "failed",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007/runtime/logs",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "The draft has no Logs tab, but failed v7 activity links directly to v7 Logs. Simulated log access is denied and the visible panel explains the required permission.",
    steps: [
      "Select Open v7 Logs in Deployment activity. Confirm v7 is viewed, the Logs tab is selected and focused, and its panel scrolls into view.",
      "Check that the log permission error is visible instead of output. The recovery at the top drops Open v7 Logs and asks someone with log access to check them; use Back to restore the draft.",
    ],
    gap: "The failure and permission denial are simulated UI evidence; they do not establish backend authorization or live log availability.",
  },
  deploymentModelProbeFailed: {
    group: "Pages/Agent detail",
    name: "New version failed its model check",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "format" },
    description:
      "Recovery comes first: v7 failed its startup model check, while selected v6 may have stopped. The detailed record preserves the reported cause without assuming a credential problem.",
    steps: [
      "Open v7 Logs and confirm the failed version, then go Back. Open Configuration goes to the draft without deploying, scrolls it into view and focuses its Configuration tab.",
      "From the draft, open Channels, then Repositories. Select example/application without saving, then follow Open Configuration in the recovery card.",
      "Focus returns to Repositories with your selection intact and a reminder to save or cancel. Choose Cancel, then go Back once to Channels and Forward to Repositories.",
      "At phone width, the failure, both recovery links, and selected version are still near the top.",
    ],
  },
  deploymentFailsWhileWatching: {
    group: "Pages/Agent detail",
    name: "Deployment fails while watching",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "format" },
    // Show the in-progress record on arrival, then let the next poll read the failed record.
    rules: [
      {
        suffix: "/deployments/rev_00000000-0000-4000-8000-000000000007",
        once: true,
        data: { status: "running", progress: null, error: null, warnings: [] },
      },
    ],
    description:
      "Watch v7 change from running to failed. The recovery card then leads the page, as it does on a reload, and Deployment details fold under it. The deployment and failure are simulated.",
    steps: [
      'On arrival v7\'s Configuration tab notice begins "Deploying version". Once v7 reads Failed, it begins "Historical version" and Selected version still reads v6.',
      'Once v7 fails, "Deployment failed · v7" is the first card and Deployment details are folded. Open them: they show the failure\'s record and stay open.',
    ],
  },
  deploymentModelProbeRetried: {
    group: "Pages/Agent detail",
    name: "New version failed its model check after a retry",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "rate_limit-attempt2" },
    description:
      "The startup model check was retried once. On the second attempt, the provider reported a rate limit.",
    steps: [
      "In the failed deployment, confirm the Cause gives the rate or usage limit advice and says the check was retried once and failed again.",
    ],
    gap: "The failure is simulated; it does not prove the runtime's retry or the provider's limit.",
  },
  deploymentModelProbeFailedReadOnly: {
    group: "Pages/Agent detail",
    name: "New version failed, viewer cannot edit",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "format" },
    readOnlyPermissionSummary: true,
    description:
      "The same failed model check for a viewer whose permission answer denies Agent update and deploy. Recovery offers Open v7 Logs only.",
    steps: [
      "Check that the recovery has one link, Open v7 Logs, and the header says Open version draft.",
      "Open v7 Logs is the block's filled primary button; at 390 wide it spans the block.",
    ],
    gap: "The permission answer is simulated; the API still authorizes every page a link opens.",
  },
  deploymentModelProbeFailedDeployOnly: {
    group: "Pages/Agent detail",
    name: "New version failed, viewer may deploy",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "format" },
    agentPermissionSummary: { update: false, deploy: true, operate: false, delete: false },
    description:
      "Recovery offers Open version draft when the viewer may deploy but cannot update the Agent. Configuration access is separate.",
    steps: [
      "Select Open version draft and confirm the Configuration tab opens in view, focused, without deploying.",
    ],
    gap: "The failure and permissions are simulated; this story does not verify API authorization or deployment.",
  },
  deploymentFailedDeployAgain: {
    group: "Pages/Agent detail",
    name: "New version failed, deploy again",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateDependencyUnavailable: true,
    description:
      "v7 failed because a controller dependency stayed unavailable. The recovery leads with the failure's own next step and offers Deploy again first, because that message says to deploy again.",
    steps: [
      "At 1440 and 390 wide, read the message and see Deploy again without scrolling.",
      "Deploy again is the one filled button and Open v7 Logs an edged secondary button. At 390 wide they stack, each the block's full width. The message's first sentence ends with DEPENDENCY_UNAVAILABLE in code.",
      "Select Deploy again: the draft opens with its Deploy new version in view and focused, without deploying.",
    ],
    gap: "The failure is simulated; this story does not verify a live deployment.",
  },
  deploymentFailedDeployAgainUnreadable: {
    group: "Pages/Agent detail",
    name: "New version failed, Configuration unreadable",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateDependencyUnavailable: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "GET",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "The same failure for a viewer who may deploy but cannot read the Configuration. The draft Deploy again opens would have no Deploy new version, so recovery reads the Configuration first and, on the denial, offers Open v7 Logs only.",
    steps: [
      "At 1440 and 390 wide, confirm the recovery shows the deploy-again message with one link, Open v7 Logs, and never shows Deploy again.",
    ],
    gap: "The failure and the denial are simulated; the API still authorizes every page a link opens.",
  },
  deploymentModelProbeFailedDeployOnlyUnreadable: {
    group: "Pages/Agent detail",
    name: "New version failed, viewer may deploy, Configuration unreadable",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "format" },
    agentPermissionSummary: { update: false, deploy: true, operate: false, delete: false },
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "GET",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "The startup model check failure for a viewer who may deploy but can neither update the Agent nor read its Configuration. The draft Open version draft opens would have no Deploy new version, so recovery reads the Configuration first and, on the denial, offers Open v7 Logs only.",
    steps: [
      "At 1440 and 390 wide, confirm the recovery shows one link, Open v7 Logs, and never shows Open version draft.",
    ],
    gap: "The failure, permissions and denial are simulated; the API still authorizes every page a link opens.",
  },
  deploymentFailedAfterSelection: {
    group: "Pages/Agent detail",
    name: "Deployment failed after selection",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateSelected: true,
    description:
      "v7 is selected despite a recorded finalization failure. The timeline reports failure without claiming selection never occurred.",
  },
  deploymentStopped: {
    group: "Pages/Agent detail",
    name: "Deployment stopped by the owner",
    path: candidateVersion,
    deployed: true,
    stopped: true,
    candidateDeploymentStatus: "failed",
    candidateStopped: true,
    description:
      "The owner stopped the Agent while v7 was deploying. Latest visible deployment reads v7 · Stopped with neutral stages, no failure banner, and a deploy-again next step.",
    gap: "The stopped record is simulated UI evidence; it does not verify a live deployment.",
  },
  deploymentSuperseded: {
    group: "Pages/Agent detail",
    name: "Deployment superseded by a newer version",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateSuperseded: true,
    description:
      "A newer version the viewer cannot read superseded v7 before it became current. Latest visible deployment reads v7 · Superseded with neutral stages and no failure banner, and nothing names the newer version.",
    gap: "The superseded record is simulated UI evidence; it does not verify a live deployment.",
  },
  deploymentSucceeded: {
    group: "Pages/Agent detail",
    name: "New version activated",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    description:
      "v7 is now selected and its original deployment recorded success. This remains historical evidence, not a live probe.",
  },
  deploymentActivityLoading: {
    group: "Pages/Agent detail",
    name: "Deployment activity loading",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "running",
    rules: [
      {
        prefix:
          "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/",
        delayMs: 4000,
      },
    ],
    description:
      "Deployment status reads take 4 s, longer than the page waits for them (about 2 s). The page shows with Deployment activity as one loading row; the in-progress record then fills that row as folded Deployment details, and Latest visible deployment reads v7 · In progress. Nothing above the version tabs moves.",
    steps: [
      "Reload at desktop and phone width and watch the version tabs: they stay in place when the record arrives, and v7's deployment record fills its two loading rows.",
      "Open Deployment details to read the in-progress stages.",
    ],
  },
  deploymentUnavailable: {
    group: "Pages/Agent detail",
    name: "Deployment activity unavailable",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "running",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007",
        status: 503,
      },
    ],
    description:
      "The latest deployment record cannot be read. Version history and the selected version remain distinct from the status error.",
  },
  diagnosticsSuccess: {
    group: "Pages/Agent detail",
    name: "Current observations for v7",
    path: candidateVersion,
    deployed: true,
    slack: true,
    candidateDeploymentStatus: "succeeded",
    rules: [{ suffix: "/diagnostics", method: "POST", delayMs: 3000 }],
    steps: [
      "Tab to Run diagnostics for this version, then press Enter or Space.",
      "After 250 ms, focus moves to “Waiting for diagnostic results…” while the button is disabled. Leave focus there.",
      "When the checks arrive, focus returns to Run diagnostics. Its description gives the Observed time.",
      "Click Refresh record, which re-renders this panel as a deployment poll does, then press Tab. Run diagnostics still has that description.",
    ],
    description:
      "Run diagnostics for v7. The panel shows it is waiting for results, then displays timestamped Slack configuration, authentication, and connectivity checks. The recorded deployment result stays the same.",
  },
  diagnosticsFast: {
    group: "Pages/Agent detail",
    name: "Current observations that answer at once",
    path: candidateVersion,
    deployed: true,
    slack: true,
    candidateDeploymentStatus: "succeeded",
    rules: [{ suffix: "/diagnostics", method: "POST", delayMs: 100 }],
    steps: [
      "Tab to Run diagnostics for this version, then press Enter. The checks answer in 100 ms.",
      "No “Waiting for diagnostic results…” line appears and the button does not disable. Focus stays on Run diagnostics, and its description gives the Observed time.",
      "Press Enter again. No waiting line appears in between; the same checks are inserted again, so a screen reader announces them again.",
    ],
    description:
      "Diagnostics that answer within 250 ms replace the panel's result directly, without painting the waiting line or moving focus.",
  },
  diagnosticsReader: {
    group: "Pages/Agent detail",
    name: "Current observations for a reader without operate",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    agentPermissionSummary: { update: true, deploy: true, operate: false, delete: true },
    description:
      "Diagnostics need Agent operate. For a viewer whose permission answer denies it, Run diagnostics is disabled and says why, and the danger zone has no Stop row.",
    gap: "The permission answer is simulated; the API still authorizes every request.",
  },
  diagnosticsRefused: {
    group: "Pages/Agent detail",
    name: "Current observations refused",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [{ suffix: "/diagnostics", method: "POST", status: 403, code: "FORBIDDEN" }],
    actions: [click("Run diagnostics for this version")],
    description:
      "The API refuses diagnostics. The refusal comes into view below the button, which keeps focus.",
  },
  diagnosticsUnknown: {
    group: "Pages/Agent detail",
    name: "Unknown observation for v6",
    path: currentVersion,
    deployed: true,
    slack: true,
    candidateDeploymentStatus: "running",
    diagnosticsState: "unknown",
    actions: [click("Run diagnostics for this version")],
    description:
      "While v7 deploys, the operator requests checks for viewed v6. Authentication and connectivity are unknown, not deployment failures.",
  },
  diagnosticsUnavailable: {
    group: "Pages/Agent detail",
    name: "Current observation unavailable",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007/diagnostics",
        method: "POST",
        status: 503,
        delayMs: 3000,
        code: "DEPENDENCY_UNAVAILABLE",
      },
    ],
    steps: [
      "Tab to Run diagnostics for this version and press Enter. Leave focus on “Waiting for diagnostic results…” until the response arrives.",
      "Focus returns to Run diagnostics, described by the alert that current-runtime diagnostics are unavailable (a simulated 503).",
      "Click Refresh record, which re-renders this panel as a deployment poll does, then press Tab. Run diagnostics is still described by the alert.",
      "Press Enter to run it again. While waiting, press Shift+Tab to move to Refresh record. Focus should stay there when the same alert appears.",
    ],
    description:
      "A failed on-demand check reports its own error. The viewed v7 deployment record remains succeeded.",
  },
  runtimeLogs: {
    group: "Pages/Agent detail",
    name: "Runtime status and logs for v7",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    description:
      "The Logs tab shows the Gateway Pod, its OOMKilled restart and BackOff Event, then redacted operational output with a withheld-structured-output row. Previous instance is available after the restart.",
    steps: [
      "At 390px, open this direct Logs route and check its selected tab is visible. Visit Configuration, then use Back and Forward; selected tabs remain visible without resetting expanded panels.",
      "Inspect Source, Previous instance, and Include debug in the controls card; toggle the two options and check their selected states.",
      "Expand the runtime.startup_phase row to inspect its fields. Check the local date, time, and UTC offset in each timestamp. From 320px up, each timestamp stays on one line; below about 400px it takes a line of its own, with the level beside the origin under it. When the Logs card is narrower than 662px (at 1000px and below, and from 1101px to about 1280px, where the card sits beside the version list), the message moves under the time, level, and origin instead of shrinking.",
      "Select Follow, confirm it changes to Following, then select Following to stop. At 390px, check that the controls remain usable, each log level stays on one line, and long messages wrap without horizontal scrolling.",
    ],
    gap: "Runtime records and refreshes are simulated UI evidence; source reads, filtering, and following require real backend verification.",
  },
  runtimeLogsSlowFirstStatus: {
    group: "Pages/Agent detail",
    name: "Open Logs on a phone while runtime status is loading",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    mobile: true,
    // Let the Console place the reader; a fixture scroll would conceal a jump on entry.
    scrollToTabs: false,
    rules: [{ suffix: "/runtime", delayMs: 700, once: true }],
    description:
      "Open the direct Logs link at 390 px. The first runtime status takes 700 ms; status and log output appear together instead of moving the output after it appears.",
  },
  runtimeLogsSlowTabClick: {
    group: "Pages/Agent detail",
    name: "Select Logs while runtime status is loading",
    path: `${candidateVersion}&tab=configuration`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [{ suffix: "/runtime", delayMs: 1200, once: true }],
    description:
      "The first runtime status takes 1.2 s after the Logs tab is selected. Stop Agent and Delete Agent stay hidden under the reserved area until the strip and output appear, so nothing below moves.",
    steps: [
      "Scroll to the version tabs and select Logs. The area keeps its height and Stop and Delete are hidden; after 1.2 s the strip, output and both cards appear in place and the panel scrolls into view.",
    ],
  },
  runtimeLogsStartupWarnings: {
    group: "Pages/Agent detail",
    name: "Runtime status after a healthy first deploy",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    runtimePod: "startupWarnings",
    description:
      "The Gateway Pod is Ready with no restarts; its startup readiness-probe Event is listed in muted text as an earlier warning instead of in the warning color.",
  },
  runtimeLogsDedicatedPods: {
    ...runtimeLogsPage,
    name: "Runtime status for a dedicated Agent's Pods",
    runtimePod: "dedicatedPair",
    description:
      "The Agent (Harness) and Gateway Pod cards share the Logs panel's width, each with its long generated name and its init containers.",
    steps: [
      "At 1440 the two cards sit side by side and together fill the panel; no blank column is left beside them.",
      "At 390 each card spans the panel, one under the other.",
    ],
  },
  runtimeLogsFilteredDownload: {
    group: "Pages/Agent detail",
    name: "Runtime logs filtered and downloaded",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    actions: [
      click("Download"),
      { selector: ".log-chip.log-level-info", click: true },
      { selector: "#runtime-log-filter", value: "slack" },
    ],
    description:
      "Download saves the redacted text tail as a .log file through its own audited read. Hiding info and filtering for slack narrows the loaded window to the redacted reconnect warning; the status line counts the hidden rows.",
    steps: [
      "Check that info is deselected, the Filter field contains slack, and the visible row keeps its level, origin, and redacted message readable.",
      "Clear Filter and enable info to restore the loaded rows; the filter status and source retention notice stay visible.",
    ],
  },
  runtimeLogsRateLimited: {
    ...runtimeLogsPage,
    name: "Rate-limited log reads with Follow off or on",
    rules: [{ suffix: "/runtime/logs", skip: 1, status: 429, code: "RUNTIME_LOGS_RATE_LIMITED" }],
    actions: [click("Refresh logs")],
    description:
      "The first page loads, then log requests are rate limited. This fixture omits Retry-After: Refresh logs asks you to try again, without another audited read.",
    steps: [
      "Select Follow. When its next read is rate limited, the message says the Console is waiting for the next read.",
      "While Following is still selected, choose Download. That action asks you to try again; the Console will not repeat the download.",
    ],
  },
  runtimeLogsRefreshRateLimited: {
    ...runtimeLogsPage,
    name: "Rate-limited Refresh logs keeps the loaded lines",
    rules: [
      {
        suffix: "/runtime/logs",
        skip: 1,
        status: 429,
        code: "RUNTIME_LOGS_RATE_LIMITED",
        retryAfter: 5,
      },
    ],
    actions: [click("Refresh logs")],
    description:
      "The first page loads, then Refresh logs is rate limited with Retry-After: 5. The loaded lines and their Showing line stay; the message says when to try again.",
    steps: [
      "Check that the loaded log rows are still shown under 'Too many requests. Try again in 5 seconds.'",
      "Wait 5 seconds. The message changes to 'Too many requests. You can try again now.' without another read.",
      "Select Include debug. That read is for another selection, so the old rows clear before its rate-limited answer.",
    ],
  },
  runtimeLogsDenied: {
    group: "Pages/Agent detail",
    name: "Runtime logs without administer",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007/runtime/logs",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "An Agent operator sees Pod status and Events but no log text. The page names the missing grants and does not request the log view again.",
    steps: [
      "Check that the permission message is visible inside the Logs card and unavailable actions remain disabled.",
    ],
  },
  runtimeLogPodReplaced: {
    ...runtimeLogsPage,
    name: "Selected Pod disappears from runtime status",
    runtimePod: "rollover",
    description:
      "On the next status poll, gateway-retiring disappears. The Console starts the selected Pod’s log tail without mixing the two Pods’ output.",
    steps: [
      "Select gateway-retiring in Pod / container before the next status poll. Its name appears in the output and the caption.",
      "After about ten seconds, the picker, output and caption all name the remaining Pod. No action or manual refresh is needed.",
    ],
  },
  runtimeLogAccessLost: {
    ...runtimeLogsPage,
    name: "Log access lost after output appears",
    rules: [{ ...refuseLogRead, skip: 1, once: true }],
    description:
      "The first page loads. The next log read is refused, then the fixture restores access. The Console remembers the refusal until sign-out.",
    steps: [
      "With log rows visible, select Follow. At the next poll the rows and their source caption disappear, Follow stops, and Download is disabled. The Pod card stays: status access did not change.",
      "Without resetting the story, log out and sign in with invented values. Open Research assistant, then Logs: the rows return. Reset the story to try Download instead of Follow.",
    ],
  },
  runtimeLogDownloadRefused: {
    ...runtimeLogsPage,
    name: "Download refused while an earlier log page is in flight",
    rules: [
      { suffix: "/runtime/logs", queryParam: "cursor", delayMs: 8000, once: true },
      { ...refuseLogRead, queryParam: "download" },
    ],
    description:
      "A follow poll starts after two seconds. The fixture holds its successful response for eight more seconds; a Download during that interval is refused immediately.",
    steps: [
      "With rows visible, select Follow, wait about three seconds, then select Download. No file downloads; the rows clear and the controls become unavailable.",
      "Wait for the earlier page to arrive. The access message stays, no rows come back, and Follow does not restart. Reset the story to repeat.",
    ],
  },
  runtimeStatusAccessLost: {
    ...runtimeLogsPage,
    name: "Pod status access lost while logs remain readable",
    rules: [{ suffix: "/runtime", skip: 1, status: 403, code: "FORBIDDEN" }],
    description:
      "The first status and log reads succeed. At the next status poll, about ten seconds later, the Pod and its observation time are replaced by the status access message.",
    steps: [
      "Leave Follow off until the Pod disappears. The log rows stay, and the Console does not read another log page just because the status request was refused.",
      "Select Follow. Reading logs still works without the old Pod selection; it does not restore the Pod card.",
    ],
  },
  runtimeStatusAccessRestored: {
    ...runtimeLogsPage,
    name: "Pod status access restored on Back",
    rules: [
      {
        suffix: "/permissions",
        once: true,
        data: { update: true, deploy: true, operate: false, delete: true },
      },
      { suffix: "/runtime", once: true, status: 403, code: "FORBIDDEN" },
    ],
    description:
      "At first the Agent permission response says operate is not granted: logs load, but status is refused. On the next visit the permission response grants operate.",
    steps: [
      "Wait for both the status access message and the log rows. Open Namespaces, then use browser Back; the Console asks for status once more and shows the Pod.",
    ],
  },
  runtimeLogsReaderDownload: {
    group: "Pages/Agent detail",
    name: "Runtime logs downloaded by a log reader",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007/runtime",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    actions: [click("Download")],
    description:
      "A log reader without Agent operate has no runtime status or Pod picker. Log text still loads from the source's current Pod, and Download names the saved file after that Pod, as the status line does.",
  },
  runtimeLogsReaderNoPodDownload: {
    group: "Pages/Agent detail",
    name: "Log reader downloads after the Pod disappears",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    runtimeLogDownloadNoPod: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007/runtime",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    actions: [click("Download")],
    description:
      "Simulated UI: the page retains the last Pod's log text, but the Pod disappears before Download. The fresh download has a valid no-Pod response header, so the saved filename ends in no-pod.log rather than naming the previous Pod.",
  },
  runtimeLogsClusterRbac: {
    group: "Pages/Agent detail",
    name: "Runtime logs blocked by cluster RBAC",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007/runtime/logs",
        status: 503,
        code: "RUNTIME_LOGS_CLUSTER_RBAC",
      },
    ],
    description:
      "The cluster denied pods/log. The page asks the platform operator to enable agentRuntimeLogs in the Helm chart.",
  },
  agentMissing: {
    group: "Pages/Agent detail",
    name: "Agent unavailable",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        status: 404,
      },
    ],
    description: "A deleted or inaccessible Agent link returns a resource-unavailable panel.",
  },
  configurationError: {
    group: "Pages/Agent detail",
    name: "Configuration unavailable",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        status: 503,
      },
    ],
    description: "The Configuration read fails independently of the Agent header.",
  },
  unreadableAgentConfiguration: {
    group: "Pages/Agent detail",
    name: "Unreadable Agent draft",
    path: draft,
    deployed: true,
    unreadableAgentConfiguration: "plugins",
    description:
      "Saved Agent plugin selections could not be read. The Agent header and version history remain visible; draft settings and deployment are unavailable. The admitted v1 snapshot is independently readable.",
    steps: [
      "Open Plugins, Channels, and Credentials. Each shows the saved-configuration banner, with no empty settings or editable defaults.",
      "Select v1 to inspect its admitted configuration, then return to Create new version to see the unreadable draft.",
    ],
  },
  unreadableRevisionConfiguration: {
    group: "Pages/Agent detail",
    name: "Unreadable revision snapshot",
    path: revision,
    deployed: true,
    unreadableRevisionConfiguration: "plugins",
    rules: [{ suffix: "/deployments/rev_00000000-0000-4000-8000-000000000001", status: 503 }],
    description:
      "An admitted revision has unreadable plugin selections. Its identity and history remain visible while its saved settings show a repair banner. Deployment activity can fail separately because it still requires a valid snapshot.",
    steps: [
      "Open Plugins and confirm the invalid snapshot is not shown as empty JSON.",
      "Select Create new version. The healthy current draft remains editable independently of the unreadable historical snapshot.",
    ],
  },
  revisionError: {
    group: "Pages/Agent detail",
    name: "Revision history unavailable",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/revisions",
        status: 403,
      },
    ],
    description: "Deployment stays disabled when revision history cannot be read.",
  },
  deployDenied: {
    group: "Pages/Agent detail",
    name: "Deployment denied",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deploy",
        method: "POST",
        status: 403,
      },
    ],
    actions: [click("Deploy new version")],
    description:
      "A rejected deployment reports failure and re-enables the action. Focus returns to Deploy new version, described by the failure.",
  },
  deployInProgress: {
    group: "Pages/Agent detail",
    name: "Deployment in progress",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deploy",
        method: "POST",
        hold: true,
      },
    ],
    actions: [click("Deploy new version")],
    description:
      "One “Deploying…” status covers the whole request and appears only if it outlasts 250 ms. It holds keyboard focus while the request runs.",
  },
  deployHoldsNavigation: {
    group: "Pages/Agent detail",
    name: "Deployment holds navigation",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deploy",
        method: "POST",
        delayMs: 3600,
      },
    ],
    actions: [click("Deploy new version"), { selector: 'a[data-nav="agents"]', click: true }],
    description:
      "The story selects Deploy new version, then Agents in the sidebar. The page stays, and a note under “Deploying…” says why until the simulated request answers 3.6 s later.",
    steps: [
      "While the note “This page stays open until the deploy request finishes.” shows, select ← Agents or Agents again: the page stays. Select Reset story to replay the hold.",
      "Double-click Agents while the note shows: its text is written once, so a screen reader reads it once.",
      "When the request answers, the note goes and the new version opens; Agents in the sidebar now leaves.",
    ],
  },
  deployRefusedBeforeAdmission: {
    group: "Pages/Agent detail",
    name: "Deployment refused before admission",
    path: draft,
    rules: [
      {
        method: "POST",
        suffix: "/deploy",
        delayMs: 1_000,
        status: 503,
        code: "DEPENDENCY_UNAVAILABLE",
        message:
          "The selected Secret Driver does not own a Secret the Configuration binds. Bind only Secrets stored through the selected driver: update the Configuration's secretBindings, or assign the Agent another Configuration.",
      },
    ],
    description:
      "The Controller refuses this deployment because the Configuration binds a Secret from a different Secret Driver.",
    steps: [
      "Focus Deploy new version and press Enter. Focus moves to “Deploying…” while the request is pending.",
      "Read the refusal. Focus returns to Deploy new version, enabled and described by that message. No second request is sent.",
    ],
  },
  deployOutcomeUnknown: {
    group: "Pages/Agent detail",
    name: "Deployment outcome unknown",
    path: draft,
    rules: [{ method: "POST", suffix: "/deploy", delayMs: 1_000, status: 503, once: true }],
    description:
      "The browser gets a 503 after submitting a deployment. It cannot tell whether the Controller accepted the request.",
    steps: [
      "Focus Deploy new version and press Enter. Focus moves to “Deploying…” while the request is pending.",
      "When “Outcome unknown” takes focus, “Deploying…” is gone and Deploy is still disabled. Refresh and inspect the saved state before trying again.",
    ],
  },
  deployRefusedSetting: {
    group: "Pages/Agent detail",
    name: "Deployment refused by a Configuration setting",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deploy",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message:
          "Configuration setting gateway.bind must listen on all interfaces to serve routed traffic: use lan or omit the setting.",
      },
    ],
    actions: [click("Deploy new version")],
    description:
      "A typed conflict shows the API's sentence, which names the setting to change. No version is created.",
  },
  deployOpensVersion: {
    group: "Pages/Agent detail",
    name: "Deployment opens the new version",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deploy",
        method: "POST",
        delayMs: 600,
      },
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        skip: 2,
        once: true,
        delayMs: 900,
      },
    ],
    description:
      "An admitted deployment opens the new version. The draft stays shown, inactive, while the version loads; keyboard focus moves from “Deploying…” to the page heading, then to the new version’s heading, never to the page itself.",
    steps: [
      "Use Tab to reach Deploy new version, then press Enter. “Deploying…” appears and holds focus during the 600 ms request.",
      "Once the deployment is admitted, focus moves to the Agent heading while the draft stays shown, then to the Loading page heading after 250 ms, then to the new version’s heading when it opens.",
    ],
  },
  deployAgentPrincipalDenied: {
    group: "Pages/Agent detail",
    name: "Deployment denied for the Agent's service principal",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deploy",
        method: "POST",
        status: 403,
        code: "FORBIDDEN",
        message:
          "The Agent service principal service-agent-agt_00000000-0000-4000-8000-000000000001 is not authorized to operate secret sec_00000000-0000-4000-8000-000000000001. Grant that principal operate on the secret, then deploy again.",
      },
    ],
    actions: [click("Deploy new version")],
    description:
      "A denial for the Agent's own service principal names the principal and the grant to add. A caller's own denial keeps the console's guidance.",
  },
  revisionDeployDenied: {
    group: "Pages/Agent detail",
    name: "New version deployment denied",
    path: draft,
    deployed: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deploy",
        method: "POST",
        status: 403,
      },
    ],
    actions: [click("Deploy new version")],
    description:
      "A denied deployment from saved settings leaves the current version unchanged and permits an explicit retry.",
  },
  revisionCredentialsMissing: {
    group: "Pages/Agent detail",
    name: "New version missing credentials",
    path: draft,
    deployed: true,
    transport: false,
    description:
      "A previous version exists, but generated runtime credentials are missing. Deployment remains blocked pending operator recovery.",
  },
  buildRevision: {
    group: "Components/Navigation",
    name: "OCC build revision",
    path: "/console/agents?debug=true",
    buildRevision: "abcdef1234567890abcdef1234567890abcdef12",
    description:
      "Approved OpenClaw mech mascot beside the OpenClaw Enterprise wordmark and an eight-character OCC commit. Check the mascot at desktop and mobile widths, then hover the version for the full hash. This revision is simulated.",
  },
  developmentBuild: {
    group: "Components/Navigation",
    name: "OCC development build",
    path: "/console/agents?debug=true",
    description:
      "Approved OpenClaw mech mascot beside the OpenClaw Enterprise wordmark with an adjacent dev label when OCC build metadata is unavailable. No checkout or gateway revision is inferred.",
  },
  menu: {
    group: "Components/Navigation",
    name: "Account menu",
    actions: account,
    description:
      "The account row in the dark navigation opens a light menu with Settings and Sign out. Use the arrow keys to check focus inside the menu, then Escape to return to the account.",
  },
  menuMobile: {
    group: "Components/Navigation",
    name: "Mobile account menu",
    mobile: true,
    actions: [
      { selector: '.content [aria-busy="false"]' },
      { selector: ".topbar-avatar", click: true },
    ],
    description:
      "390px top bar: navigation toggle, wordmark and the account avatar, which opens Settings and Sign out without the drawer.",
    steps: [
      "Press Escape; focus returns to the avatar. Open navigation, then check the menu closed.",
    ],
  },
  namespaceMenu: {
    group: "Components/Navigation",
    name: "Namespace switcher",
    description:
      "The header's compact Namespace control (its label is the muted prefix inside the box) shows the current Namespace and readable alternatives.",
    steps: [
      "Choose Research in the Namespace selector; the URL changes and its empty Agents collection appears.",
      "Choose Engineering to return to its Agents, then use browser Back to restore Research.",
      "Open Namespaces; the Installation-wide list has no Namespace selector. Return to Agents to switch scope.",
    ],
  },
  namespaceSelectorMobile: {
    group: "Components/Navigation",
    name: "Mobile Namespace selector",
    mobile: true,
    namespaceName: "Engineering platform operations and infrastructure",
    description:
      "Choose a Namespace directly from the header at 390px, without opening navigation.",
    steps: [
      "Check that the compact control stays 32px tall and the long Namespace name truncates before the inset chevron.",
      "Choose Research, then return to the long Namespace and check the selection.",
    ],
  },
  mobile: {
    group: "Components/Navigation",
    name: "Mobile drawer",
    buildRevision: "abcdef1234567890abcdef1234567890abcdef12",
    mobile: true,
    actions: [
      { selector: '.content [aria-busy="false"]' },
      { selector: ".mobile-toggle", click: true },
    ],
    description:
      "390px viewport with the simulated OCC revision beside the wordmark in the open drawer. Escape or the overlay closes it; widening to desktop releases the page.",
    steps: [
      "With the drawer open, widen past 760px. Search Agents without pressing Escape; content is active and navigation is no longer trapped.",
      "Return to 390px. The drawer starts closed; reopen it and press Escape to return focus to Open navigation.",
    ],
  },
  slack: {
    group: "Components/Channels",
    name: "Slack configured",
    path: `${draft}&tab=channels`,
    slack: true,
    description: "Enabled Socket Mode with standard unresolved credential references.",
  },
  slackThreadedDefault: {
    group: "Components/Channels",
    name: "Slack threaded default",
    path: `${draft}&tab=channels`,
    description:
      "New Slack setup threads channel replies without changing DM reply behavior. Missing credentials remain visible until Secrets are bound.",
    steps: [
      "Configure Slack, enter CDEMO123, allow everyone in the channel, and choose Disabled for direct messages.",
      "Save configuration and open Configuration → View native Configuration: replyToModeByChatType.channel is all, with no global replyToMode.",
    ],
  },
  slackDmPolicy: {
    group: "Components/Channels",
    name: "Slack direct-message policy",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack")],
    description:
      "Choose DM access independently of channel senders. Invalid allowlists stay in the drawer without saving.",
    steps: [
      "Select Allowlist, remove the selected people, and save to inspect the validation error.",
      "Enter UDIRECT123, save, and reopen Slack to verify the saved selection.",
      'Select Open and save: allowFrom becomes ["*"]. Switch to Allowlist: enter explicit IDs before saving.',
      "Select Disabled for channel-only access; existing channel users and reply overrides stay unchanged.",
    ],
  },
  slackEnterpriseDm: {
    group: "Components/Channels",
    name: "Slack organization-wide DM policy",
    path: `${draft}&tab=channels`,
    slack: true,
    slackPolicy: "disabled",
    slackEnterpriseOrgInstall: true,
    actions: [click("Edit Slack")],
    description:
      "Organization-wide installs recommend Disabled. Selecting Pairing or Allowlist fails before saving; Open is supported.",
  },
  slackReplyOverride: {
    group: "Components/Channels",
    name: "Slack non-threaded override",
    path: `${draft}&tab=channels`,
    slack: true,
    slackReplyToMode: "off",
    description: "An existing explicit non-threaded setting survives Slack drawer edits.",
    steps: [
      "Edit Slack, change the channel IDs, and save configuration.",
      "Open Configuration → View native Configuration: replyToMode remains off.",
    ],
  },
  slackNavigation: {
    group: "Components/Channels",
    name: "Keep Slack edits",
    path: `${draft}&tab=configuration`,
    slack: true,
    actions: [
      click("Channels"),
      click("Edit Slack"),
      { selector: "#slack-channel-ids-search", value: "CNAVIGATION", key: "Enter" },
    ],
    description:
      "An open Slack drawer restores ordinary edits and staged Secret references after browser history navigation.",
    steps: [
      "Use Back to return to Configuration, then Forward to reopen the drawer.",
      "Confirm CNAVIGATION remains. Cancel, reopen Slack, and check saved channel IDs.",
    ],
    gap: "Simulated UI proof, not Slack delivery or Secret propagation.",
  },
  slackDrawer: {
    group: "Components/Channels",
    name: "Slack editor",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack")],
    description:
      "Select or create Slack token Secrets at the top, then configure channel and direct-message access. The bot token enables name lookup; both tokens are required before deployment.",
    steps: [
      "Change the channel IDs, then click inside the panel and drag from its heading onto the gray backdrop. The editor stays open.",
      "Click the gray backdrop. Reopen Edit Slack and confirm the unsaved channel changes were discarded, just as with Cancel.",
    ],
  },
  slackDrawerNoAuthentication: {
    group: "Components/Channels",
    name: "Slack editor, no model authentication",
    path: `${draft}&tab=channels`,
    slack: true,
    auth: null,
    actions: [click("Edit Slack")],
    description:
      "An Agent with no model authentication source: the drawer's notice adds that model credentials are configured in the Credentials tab before deploying. With a source bound (Slack editor), the notice stops after the first sentence.",
    steps: [
      'The notice at the top of the drawer reads "New version. Changes affect future deployments using this Configuration. Configure model credentials in the Credentials tab before deploying."',
      'Open the Slack editor story: its notice reads only "New version. Changes affect future deployments using this Configuration."',
    ],
  },
  slackDirectoryChannels: {
    group: "Components/Channels",
    name: "Find Slack channels by name",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack"), { selector: "#slack-channel-ids-search", focus: true }],
    description:
      "The picker shows five channels per page with the bot's workspace, names and exact IDs. Next page shows two buffered matches before another directory request. Typing waits 300 ms; Enter searches immediately. Selecting a result saves only its ID.",
    steps: [
      "Use Next page to see design and engineering, then Previous page to restore the first five without another directory request.",
      "Use Next page twice to fetch product and announcements. Type platform and select its result.",
      "Type another query, then click Save configuration once while results are open. The dropdown closes without moving Save, and only selected channel chips are saved.",
    ],
    gap: "Directory data and Secret access are simulated; no Slack API call occurs.",
  },
  slackDirectorySavedNames: {
    group: "Components/Channels",
    name: "Saved Slack IDs show current names",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack")],
    description:
      "Saved channel and user IDs are resolved with the selected bot Secret when the editor opens. Names appear as removable chips. Exact IDs are available on hover and are the only values saved.",
    gap: "Directory data and Secret access are simulated; no Slack API call occurs.",
  },
  slackDirectoryQualifiedNames: {
    group: "Components/Channels",
    name: "Qualified Slack targets keep names and IDs",
    path: `${draft}&tab=channels`,
    slack: true,
    slackChannels: {
      "team:TDEMO123:channel:CDEMO123": {
        requireMention: true,
        users: ["team:TDEMO123:user:UDEMO123"],
      },
    },
    slackAllowFrom: ["user:UDEMO123"],
    actions: [click("Edit Slack")],
    description:
      "Existing workspace-qualified channel and user targets remain editable. Matching names label removable chips, with exact saved targets on hover; the directory picker still inserts bare IDs.",
    gap: "Directory data and Secret access are simulated; no Slack API call occurs.",
  },
  slackDirectoryUsers: {
    group: "Components/Channels",
    name: "Resolve duplicate Slack people",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack"), { selector: "#slack-dm-user-ids-search", focus: true }],
    description:
      "People appear five per page. Two share the same display name; their handle and exact Slack user IDs identify which one will be saved. Next page preserves the remaining matches from the directory response.",
    gap: "Directory data and Secret access are simulated; no Slack API call occurs.",
  },
  slackDirectoryDenied: {
    group: "Components/Channels",
    name: "Slack directory access denied",
    path: `${draft}&tab=channels`,
    slack: true,
    rules: [
      { suffix: "/channel-directory/lookup", method: "POST", bodyHasIds: false, status: 403 },
    ],
    actions: [click("Edit Slack"), { selector: "#slack-channel-ids-search", focus: true }],
    description:
      "A denied lookup keeps manual exact-ID entry available and explains Secret permissions.",
  },
  slackDirectoryLoading: {
    group: "Components/Channels",
    name: "Slack directory loading",
    path: `${draft}&tab=channels`,
    slack: true,
    rules: [{ suffix: "/channel-directory/lookup", method: "POST", bodyHasIds: false, hold: true }],
    actions: [click("Edit Slack"), { selector: "#slack-channel-ids-search", focus: true }],
    description:
      "While lookup is pending, the picker announces loading and disables page navigation.",
  },
  slackDirectorySearchRace: {
    group: "Components/Channels",
    name: "New search supersedes pending results",
    path: `${draft}&tab=channels`,
    slack: true,
    rules: [
      {
        suffix: "/channel-directory/lookup",
        method: "POST",
        bodyHasIds: false,
        delayMs: 500,
        once: true,
      },
    ],
    actions: [click("Edit Slack"), { selector: "#slack-channel-ids-search", focus: true }],
    description:
      "An older directory request is delayed. Search for platform before it returns; typing cancels the browser request and searches after 300 ms. Escape dismisses results and cancels a queued search. Enter searches immediately.",
  },
  slackDirectoryMissingSecret: {
    group: "Components/Channels",
    name: "Slack directory needs a bot Secret",
    path: `${draft}&tab=channels`,
    slack: true,
    slackBindings: "app",
    actions: [click("Edit Slack")],
    description:
      "Credentials appear before access settings. The instructions explain that name lookup needs a bot token; exact-ID entry remains available.",
    steps: [
      "At the top of the editor, open Slack bot token and choose Slack bot token (simulated). Existing IDs resolve to names.",
      "Continue to Channels, search for platform, and select the result. Review channel and direct-message access before saving.",
    ],
    gap: "Secret choices and directory responses are simulated; this does not verify a real Slack token.",
  },
  slackEveryone: {
    group: "Components/Channels",
    name: "Slack everyone in channels",
    path: `${draft}&tab=channels`,
    slack: true,
    slackAllowEveryone: true,
    actions: [click("Edit Slack")],
    description:
      'The editor shows users: ["*"] as Allow everyone in these channels and keeps direct-message allowFrom unchanged.',
  },
  slackRestrictedUsers: {
    group: "Components/Channels",
    name: "Slack restricted channel users",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack")],
    description:
      "Explicit channel user IDs disable the everyone checkbox while preserving unrelated channel properties and direct-message allowFrom.",
  },
  slackChannelAccessIncomplete: {
    group: "Components/Channels",
    name: "Slack sender access incomplete",
    path: `${draft}&tab=channels`,
    actions: [
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
      { selector: "#slack-channel-ids-search", value: "CDEMO123", key: "Enter" },
      click("Save configuration"),
    ],
    description:
      "A selected channel needs allowed channel user IDs or the everyone checkbox before the Configuration can be saved.",
  },
  slackSecretMenu: {
    group: "Components/Channels",
    name: "Slack Secret menu",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack")],
    description:
      "Search Slack token Secrets by name or ID; options and selections show names only. Use arrow keys and Enter to select, and Escape to retain the current binding. Metadata is simulated within this Namespace.",
  },
  slackSecretNameCollision: {
    group: "Components/Channels",
    name: "Slack Secret action name collision",
    path: `${draft}&tab=channels`,
    slack: true,
    extraSecrets: [
      { id: "sec_story_create_name", name: "Create new Secret..." },
      { id: "sec_story_none_name", name: "No Secret bound" },
      { id: "sec_story_bound_name", name: "Bound Secret" },
    ],
    actions: [click("Edit Slack")],
    description:
      "Open the bot token selector to compare Secret names with matching picker actions. Real Secret names remain unchanged and conflicting actions have a qualifier.",
  },
  slackCreateSecretModal: {
    group: "Components/Channels",
    name: "Slack create Secret modal",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [
      click("Edit Slack"),
      { selector: "#slack-secret-slack-bot-token", value: "__openclaw_create_secret__" },
    ],
    description:
      "Create new Secret opens a modal with an editable Agent-prefixed Name, a fixed Slack binding key, and a masked Secret value. Values are simulated and never read back.",
    steps: [
      "Enter a dummy value, then click the gray backdrop. Only Create Secret closes; the Slack editor stays open.",
      "Open Create new Secret again and confirm Value is empty. Close it, then click the backdrop again to dismiss the Slack editor.",
    ],
  },
  slackDuplicateSecret: {
    group: "Components/Channels",
    name: "Slack duplicate Secret name",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [
      click("Edit Slack"),
      { selector: "#slack-secret-slack-bot-token", value: "__openclaw_create_secret__" },
      {
        selector: "#create-slack-secret-slack-bot-token-name",
        value: "Slack bot token (simulated)",
      },
      { selector: "#create-slack-secret-slack-bot-token-value", value: "synthetic-demo-token" },
      click("Create Secret"),
    ],
    description:
      "A simulated duplicate-name rejection preserves Name and the masked value. Change the Name and create again; the existing Secret remains unchanged.",
    gap: "Simulated UI proof only; the browser integration suite verifies real controller conflict handling.",
  },
  slackSecretStaged: {
    group: "Components/Channels",
    name: "Slack staged Secret binding",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [
      click("Edit Slack"),
      { selector: "#slack-secret-slack-app-token", value: "sec_demo_slack_backup_token" },
    ],
    description:
      "Selecting a different existing Secret stages the binding and updates the metadata link. Cancel discards the staged choice; Save persists it.",
  },
  slackOpen: {
    group: "Components/Channels",
    name: "Slack open policy",
    path: `${draft}&tab=channels`,
    slack: true,
    slackPolicy: "open",
    actions: [click("Edit Slack")],
    description: "Editing preserves the existing open direct-message policy and allowFrom entry.",
  },
  slackDisabled: {
    group: "Components/Channels",
    name: "Slack disabled policy",
    path: `${draft}&tab=channels`,
    slack: true,
    slackPolicy: "disabled",
    actions: [click("Edit Slack")],
    description: "A disabled access policy does not disable the editor or silently change policy.",
  },
  slackUnsupported: {
    group: "Components/Channels",
    name: "Slack unsupported shape",
    path: `${draft}&tab=channels`,
    slack: true,
    slackMode: "http",
    description:
      "The Socket Mode editor disables editing for an HTTP-mode configuration and shows native JSON.",
  },
  slackMixedUsersUnsupported: {
    group: "Components/Channels",
    name: "Slack mixed sender lists",
    path: `${draft}&tab=channels`,
    slack: true,
    slackChannels: {
      CDEMO123: { requireMention: true, users: ["UDEMO123"] },
      CDEMO456: { requireMention: true, users: ["UDEMO456"] },
    },
    description:
      "Different per-channel sender lists are unsupported by the simple editor and remain editable through native Configuration JSON.",
  },
  slackWildcardUnsupported: {
    group: "Components/Channels",
    name: "Slack wildcard channel map",
    path: `${draft}&tab=channels`,
    slack: true,
    slackChannels: { "*": { requireMention: true, users: ["*"] } },
    description:
      "A native Slack '*' channel map matches all channels and is unsupported by this editor.",
  },
  channelsEmpty: {
    group: "Components/Channels",
    name: "Not configured",
    path: `${draft}&tab=channels`,
    description: "Configure Slack from the supported channel card.",
  },
  channelsReadOnly: {
    group: "Components/Channels",
    name: "Revision read only",
    path: `${revision}&tab=channels`,
    deployed: true,
    slack: true,
    description:
      "Inspect the app and bot token Secret names and IDs, then switch to Configuration to inspect the Harness Secret. This read-only snapshot retains its own bindings.",
  },
  revisionSecretsDenied: {
    group: "Components/Channels",
    name: "Revision Secret metadata denied",
    path: `${revision}&tab=channels`,
    deployed: true,
    slack: true,
    rules: [{ prefix: `${presetSecretsPath}/`, status: 403 }],
    description:
      "Bound IDs remain visible when exact Secret metadata reads are denied. Switch to Configuration to inspect the same state for Harness authentication.",
  },
  revisionSecretsMissing: {
    group: "Components/Channels",
    name: "Revision Secret metadata missing",
    path: `${revision}&tab=channels`,
    deployed: true,
    slack: true,
    rules: [{ prefix: `${presetSecretsPath}/`, status: 404 }],
    description:
      "Unavailable metadata does not erase the revision's bindings or claim credentials are unconfigured.",
  },
  revisionSecretsLoading: {
    group: "Components/Channels",
    name: "Revision Secret metadata loading",
    path: `${revision}&tab=channels`,
    deployed: true,
    slack: true,
    rules: [{ prefix: `${presetSecretsPath}/`, hold: true }],
    description: "The bound IDs stay visible while metadata loads. Other tabs remain usable.",
  },
  revisionSecretsAbsent: {
    group: "Components/Channels",
    name: "Revision without Slack bindings",
    path: `${revision}&tab=channels`,
    deployed: true,
    description: "A revision without Slack bindings shows No Secret bound for both token slots.",
  },
  channelConflict: {
    group: "Components/Channels",
    name: "Save conflict",
    path: `${draft}&tab=channels`,
    slack: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message:
          "The Configuration changed since it was read. Read its current generation before updating it.",
        details: [{ path: "/expectedGeneration", code: "INVALID_VALUE" }],
      },
    ],
    actions: [click("Edit Slack"), click("Save configuration")],
    description:
      "The API refuses the Configuration write with 409: another save landed after the page's reread. The editor closes and the section offers Reload draft, with focus on it.",
  },
  channelProvisioningReserved: {
    group: "Components/Channels",
    name: "Save refused during provisioning",
    path: `${draft}&tab=channels`,
    slack: true,
    rules: [reservedConfigurationWrite],
    actions: [click("Edit Slack"), click("Save configuration")],
    description:
      "Save keeps the editor open and explains that this Configuration is reserved for provisioning. There is no Reload draft action: reloading would not release the reservation.",
  },
  channelSaveRejected: {
    group: "Components/Channels",
    name: "Save rejected",
    path: `${draft}&tab=channels`,
    slack: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 400,
      },
    ],
    actions: [click("Edit Slack"), click("Save configuration")],
    description:
      "A rejected Configuration write keeps the drawer and feedback visible, with focus back on Save configuration.",
  },
  channelSaveDenied: {
    group: "Components/Channels",
    name: "Save denied",
    path: `${draft}&tab=channels`,
    slack: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    actions: [click("Edit Slack"), click("Save configuration")],
    description:
      "A caller without Configuration update is refused. The drawer stays open with the edits and names the grant to ask an administrator for; the text is the same for every refusal.",
  },
  channelChangedElsewhere: {
    group: "Components/Channels",
    name: "Configuration changed elsewhere",
    path: `${draft}&tab=channels`,
    slack: true,
    configurationChangedElsewhere: true,
    actions: [click("Edit Slack"), click("Save configuration")],
    description:
      "Another browser saved this Configuration after the page read it. The editor closes and the section offers Reload draft; editing, deployment and tab changes wait for it.",
    steps: [
      "Check that focus is on Reload draft and the alert says the saved Configuration changed while you were editing.",
      "Select Reload draft: the tab rebuilds in place with Draft reloaded., and Edit Slack saves again.",
    ],
  },
  channelChangedElsewhereWithEdits: {
    group: "Components/Channels",
    name: "Configuration changed elsewhere with unsaved edits",
    path: `${draft}&tab=channels`,
    slack: true,
    configurationChangedElsewhere: true,
    actions: [
      click("Edit Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
      click("Save configuration"),
    ],
    description:
      "Another browser saved this Configuration while Edit Slack had unsaved changes. The alert says Reload draft reopens them over the saved settings.",
    steps: [
      "Check that focus is on Reload draft and the alert ends with Reload draft reopens your Slack edits over the saved settings.",
      "Select Reload draft: Edit Slack reopens with Direct-message policy still Disabled and says the edits are applied over the reloaded settings; Save configuration saves them.",
    ],
  },
  channelChangedElsewhereMerged: {
    group: "Components/Channels",
    name: "Edits merged over another browser's save",
    path: `${draft}&tab=channels`,
    slack: true,
    slackPolicy: "open",
    configurationChangedElsewhere: {
      values: {
        channels: {
          slack: {
            dmPolicy: "allowlist",
            allowFrom: ["UDDDD111", "UEEEE222"],
            channels: { CDEMO123: { users: ["UDEMO123", "UOTHER99"] } },
          },
        },
      },
    },
    actions: [
      click("Edit Slack"),
      { selector: "#slack-allowed-user-ids", value: "UDEMO123, UNEW4567" },
      { selector: "#slack-dm-policy", value: "pairing" },
      click("Save configuration"),
      click("Reload draft"),
    ],
    description:
      "Another browser added a channel user and set a DM allowlist while this editor added a user and chose Pairing. Reload draft adds only this reader's user to the reread list and names the DM policy both browsers changed.",
    steps: [
      "Check the note: Allowed people in these channels (added UNEW4567), and Direct-message policy also changed in another browser, saved as Allowlist.",
      "Check that the channel list keeps UOTHER99 and the DM list keeps UDDDD111 and UEEEE222; Save configuration saves the merge.",
    ],
  },
  channelSavePending: {
    group: "Components/Channels",
    name: "Channel save pending",
    path: `${draft}&tab=channels`,
    slack: true,
    auth: "runtime",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        hold: true,
      },
    ],
    actions: [click("Disable Slack")],
    description:
      "A pending channel save disables deployment and revision navigation. The real client times out after 15 seconds; reset the story to replay it.",
  },
  channelSecretGrantRefused: {
    group: "Components/Channels",
    name: "Slack token saved, grant refused",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [
      click("Edit Slack"),
      { selector: "#slack-secret-slack-app-token", value: "sec_demo_slack_backup_token" },
      click("Save configuration"),
    ],
    rules: [{ suffix: "/iam/roles", status: 403 }],
    description:
      "A session the console takes for an Installation administrator saves a Slack token from the editor. The Configuration saves, but its IAM read for the Agent's grant is refused. That is a known outcome, not an unknown one: the page names who can grant it and links to Credentials, where Retry Secret access waits.",
    steps: [
      "The editor closes. A warning above Channels names the Installation administrator step; Prepare says to resolve the saved Secret access grant, not that the outcome is unknown.",
      "Edit Slack stays available. Open Credentials: the app token reads Bound · Agent access not confirmed beside Retry Secret access.",
    ],
    gap: "The member browser test uses a member account and the real Native IAM refusal.",
  },
  channelSecretGrantMemberUnverified: {
    group: "Components/Channels",
    name: "Member Slack token saved, access not verified",
    path: `${draft}&tab=channels`,
    slack: true,
    observabilityDenied: true,
    actions: [
      click("Edit Slack"),
      { selector: "#slack-secret-slack-app-token", value: "sec_demo_slack_backup_token" },
      click("Save configuration"),
    ],
    description:
      "A member saves a Slack token from the editor. The session already knows this member does not administer the Installation, so it sends no IAM request for the Agent's grant. The warning says this session did not verify the Agent's access and names the Installation administrator step.",
    steps: [
      "The editor closes. The warning above Channels says access was not verified; Prepare says to resolve the saved Secret access grant. The request log shows no /iam/ request.",
      "Open Credentials: the app token reads Bound · Agent access not confirmed. There is no Retry Secret access; Reload draft clears the warning.",
    ],
    gap: "The member browser test uses a member account and the real Installation permission check.",
  },
  channelSaveUnknown: {
    group: "Components/Channels",
    name: "Channel save outcome unknown",
    path: `${draft}&tab=channels`,
    slack: true,
    auth: "runtime",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 503,
        once: true,
      },
    ],
    description:
      "Disable Slack to simulate an uncertain save. Deployment and navigation stay blocked until Reload draft; inspect the saved state before retrying.",
  },
  credentials: {
    group: "Components/Credentials",
    name: "Model authentication",
    path: `${draft}&tab=credentials`,
    description:
      "The saved harness authentication source can be reviewed or changed before deployment.",
  },
  credentialsUpdateDenied: {
    group: "Components/Credentials",
    name: "Model authentication, viewer cannot update the Agent",
    path: `${draft}&tab=credentials`,
    readOnlyPermissionSummary: true,
    description:
      "The permission answer denies Agent update, so Save authentication source and its fields are disabled, and the note names the grant to ask for.",
    gap: "The permission answer is simulated; the API still authorizes every save.",
  },
  credentialsSlack: {
    group: "Components/Credentials",
    name: "Slack tokens missing",
    path: `${draft}&tab=credentials`,
    slack: true,
    slackBindings: false,
    description:
      "Both Slack token bindings are empty and required before a Slack-enabled draft can deploy.",
  },
  credentialsSlackStored: {
    group: "Components/Credentials",
    name: "Slack tokens stored",
    path: `${draft}&tab=credentials`,
    slack: true,
    description:
      "Readable Secret names show existing bindings. The console does not retrieve stored token values.",
  },
  credentialsSlackReplacement: {
    group: "Components/Credentials",
    name: "Slack token switch",
    path: `${draft}&tab=credentials`,
    slack: true,
    actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
    description:
      "A different app Secret is selected but not saved. Deploy would use the saved Secret, not the one shown in the picker.",
    steps: [
      "Deploy new version is disabled. Choose the saved Slack app token again; Deploy becomes available without a save.",
      "Choose the Slack backup token, then Save channel Secrets. Deploy becomes available when the save succeeds; do not deploy.",
    ],
  },
  credentialsDiscardSecretChoice: {
    group: "Components/Credentials",
    name: "Discard an unsaved Secret choice",
    path: `${draft}&tab=credentials`,
    slack: true,
    unreadableSecretId: "sec_demo_slack_bot_token",
    description:
      "The saved Slack bot token is not readable. After choosing a different Secret, you can discard that unsaved choice without finding the original in the picker.",
    steps: [
      "Slack bot token shows “Bound Secret”. Choose “Slack backup token (simulated)”; Deploy is disabled until you save or reload.",
      "Choose Reset story to reopen the saved configuration, as a page reload would. The bot token again shows “Bound Secret” and Deploy is available. Do not deploy.",
    ],
  },
  credentialsSaveProvisioningReserved: {
    group: "Components/Credentials",
    name: "Secret choices after a refused save",
    path: `${draft}&tab=credentials`,
    slack: true,
    rules: [reservedConfigurationWrite],
    actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
    description:
      "Provisioning has reserved the Configuration. The app token selection is an unsaved choice, not a new binding.",
    steps: [
      "Press Save channel Secrets. The Console explains why the Configuration cannot be saved.",
      "The unsaved choice stays selected and Deploy stays disabled. Choose the saved Slack app token again to make Deploy available; no retry or reload is needed.",
    ],
  },
  credentialsSaveConflict: {
    group: "Components/Credentials",
    name: "Secret choices after a conflict",
    path: `${draft}&tab=credentials`,
    slack: true,
    rules: [
      {
        ...reservedConfigurationWrite,
        message: "The requested platform resource already exists.",
      },
    ],
    actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
    description:
      "A save meets a generic conflict. The Console explains that the Secret choices conflict with saved state, without claiming a duplicate or a stale generation.",
    steps: [
      "Press Save channel Secrets. The backup token stays selected, Deploy stays disabled, and no second save is sent. The message does not say the Secret already exists or offer Reload draft.",
      "Choose the saved Slack app token again. Deploy becomes available; no deployment or second save is needed.",
    ],
  },
  credentialsSlackCarried: {
    group: "Components/Credentials",
    name: "Slack token choice carried through a conflict",
    path: `${draft}&tab=credentials`,
    slack: true,
    configurationChangedElsewhere: true,
    actions: [
      { selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" },
      click("Save channel Secrets"),
      click("Reload draft"),
    ],
    description:
      "Another browser saved this Configuration first. The chosen app token stays shown, and Reload draft applies it over the reread bindings for Save channel Secrets.",
  },
  credentialsSecretListDenied: {
    group: "Components/Credentials",
    name: "Secret list denied",
    path: `${draft}&tab=credentials`,
    slack: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets",
        method: "GET",
        status: 403,
      },
    ],
    description:
      "Secret references remain preserved when metadata cannot be listed; the picker shows Bound Secret without an ID.",
  },
  credentialsSecretListScrolling: {
    group: "Components/Credentials",
    name: "Scrolling Secret list",
    path: `${draft}&tab=credentials`,
    extraSecrets: [1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
      id: `sec_story_scroll_${index}`,
      name: `Scrolling Secret ${index} (simulated)`,
    })),
    description:
      "With more readable Secrets than fit, the open API key Secret list scrolls. It is not a Tab stop: focus stays in the field and moves on with Tab.",
    steps: [
      "Click API key Secret. The list opens and scrolls.",
      "Press Tab. The list closes and focus moves to the metadata link below the field, not to the page.",
      "Click the field, type Scrolling, then drag the list's scrollbar. The list stays open with the search kept, and the field keeps focus.",
    ],
  },
  credentialsSecretListFailsAfterStaging: {
    group: "Components/Credentials",
    name: "Secret list fails after a staged Secret",
    path: `${draft}&tab=credentials`,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets",
        method: "GET",
        delayMs: 4000,
        status: 503,
      },
    ],
    actions: [
      { selector: "#harness-auth-secret", value: "__openclaw_create_secret__" },
      { selector: "#create-harness-auth-secret-name", value: "Created while loading (simulated)" },
      { selector: "#create-harness-auth-secret-value", value: "synthetic-demo-key" },
      click("Create Secret"),
    ],
    description:
      "A Secret created while the list loads is staged. The list read then fails, and the hint still says the binding is staged instead of showing a list error.",
    steps: [
      "Wait four seconds for the simulated list failure. The hint under API key Secret still reads Secret binding staged. Save changes to apply it.",
      "Choose Reset story to replay it.",
    ],
    gap: "The list failure is simulated; a lost session (401) still ends the session as before.",
  },
  credentialsSlackGrantDenied: {
    group: "Components/Credentials",
    name: "Slack grant denied",
    path: `${draft}&tab=credentials`,
    slack: true,
    actions: [
      { selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" },
      click("Save channel Secrets"),
    ],
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/iam/access-bindings",
        method: "POST",
        status: 403,
      },
    ],
    description:
      "The Configuration saves, but the follow-up exact Secret access grant is refused (403). The warning says only an Installation administrator can grant it, the saved app token reads Bound · Agent access not confirmed, and Retry Secret access retries the grant without another save.",
  },
  credentialsSlackGrantMissing: {
    group: "Components/Credentials",
    name: "Slack Secret bound without an Agent grant",
    path: `${draft}&tab=credentials`,
    slack: true,
    slackGrantMissing: "SLACK_APP_TOKEN",
    description:
      "An Installation administrator opens an Agent whose saved app token Secret has no Agent grant, for example after a member's refused grant. The console reads the Namespace IAM policy, marks the token, blocks Deploy, and offers Retry Secret access.",
    steps: [
      "The Slack app token reads Bound · Agent access not confirmed; the warning says deploying would be refused.",
      "Select Retry Secret access. Both tokens read Bound and Deploy new version is available; do not deploy.",
    ],
  },
  credentialsSavePending: {
    group: "Components/Credentials",
    name: "Channel Secret save pending",
    path: `${draft}&tab=credentials`,
    slack: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        hold: true,
        once: true,
      },
    ],
    actions: [
      { selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" },
      click("Save channel Secrets"),
    ],
    description:
      "Saving and deployment stay blocked while the channel Secret binding save is pending. After the 15-second timeout, select Reload draft and inspect the saved app token binding before retrying.",
  },
  credentialsSaveUnknown: {
    group: "Components/Credentials",
    name: "Channel Secret save outcome unknown",
    path: `${draft}&tab=credentials`,
    slack: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 503,
        once: true,
      },
    ],
    actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
    description:
      "Press Save channel Secrets to simulate an uncertain save. Select Reload draft and inspect the saved app token binding before deploying or retrying; the Console does not retry automatically.",
  },
  credentialsSlackPartial: {
    group: "Components/Credentials",
    name: "One Slack token missing",
    path: `${draft}&tab=credentials`,
    slack: true,
    slackBindings: "app",
    description:
      "The app token is already bound; the missing bot token remains empty and required.",
  },
  authenticationNavigation: {
    group: "Components/Credentials",
    name: "Keep authentication choices",
    path: `${draft}&tab=credentials`,
    auth: null,
    actions: [
      { selector: "#harness-auth-method", value: "api_key" },
      { selector: "#harness-auth-secret", value: "sec_demo_model" },
    ],
    description:
      "Authentication method and existing source references survive navigation. Reload authentication source discards the choice.",
    steps: [
      "Switch to Configuration and back to Credentials.",
      "Open Namespaces and return. Reload authentication source to restore saved settings.",
    ],
    gap: "Simulated Secret metadata, not provider authentication proof.",
  },
  authMissing: {
    group: "Components/Credentials",
    name: "No authentication source",
    path: `${draft}&tab=credentials`,
    auth: null,
    description: "Select a source before deployment.",
    gap: "The API-key field expects an existing Secret or a Secret created through the picker. It never reads raw credential values back.",
  },
  authApiKeySwitch: {
    group: "Components/Credentials",
    name: "API key Secret switch",
    path: `${draft}&tab=credentials`,
    extraSecrets: [
      { id: "sec_demo_model_replacement", name: "Replacement model API key (simulated)" },
    ],
    actions: [{ selector: "#harness-auth-secret", value: "sec_demo_model_replacement" }],
    description:
      "The authentication source picker displays Secret names and stages a different API-key Secret.",
  },
  authSecretReplacement: {
    group: "Components/Credentials",
    name: "Replace model Secret",
    path: `${draft}&tab=credentials`,
    extraSecrets: [{ id: "sec_demo_replacement", name: "Replacement model token" }],
    actions: [
      { selector: "#harness-auth-method", value: "codex_pat" },
      { selector: "#harness-auth-secret", value: "sec_demo_replacement" },
    ],
    description:
      "Save the selected model Secret, then confirm the exact Agent grant through Namespace IAM. Saving does not establish model readiness.",
    steps: [
      "Click Save authentication source.",
      "Look for “Authentication source saved.” Focus stays at Save authentication source; the request log shows the Agent PATCH followed by access for that Secret.",
    ],
  },
  authSecretGrantDenied: {
    group: "Components/Credentials",
    name: "Authentication saved, grant denied",
    path: `${draft}&tab=credentials`,
    rules: [{ suffix: "/iam/access-bindings", method: "POST", status: 403, once: true }],
    actions: [click("Save authentication source")],
    description:
      "The Agent binding is saved, but the request to grant its Secret access is refused (403). The warning says that request was refused, names the Installation administrator step, and keeps Retry credential access for when access is restored. Deployment stays blocked in this view until access is confirmed.",
    steps: [
      "Read the partial-save message and disabled authentication controls.",
      "Click Retry credential access. This fixture permits the next grant to simulate an administrator restoring authority.",
      "The form refreshes without another Agent PATCH.",
    ],
  },
  authSecretGrantMissing: {
    group: "Components/Credentials",
    name: "Authentication Secret without an Agent grant",
    path: `${draft}&tab=credentials`,
    harnessGrantMissing: true,
    description:
      "An Installation administrator opens an Agent whose saved model Secret has no Agent grant, for example after a member saved it. The console reads the Namespace IAM policy, says deploying would be refused, names Save authentication source and blocks Deploy.",
    steps: [
      "Read the warning under the authentication form; Prepare says to confirm authentication and Secret access in Credentials.",
      "Select Save authentication source. The grant is written, the tab rebuilds without the warning, and Deploy new version is available; do not deploy.",
    ],
  },
  authSecretGrantMemberUnverified: {
    group: "Components/Credentials",
    name: "Member authentication saved, access not verified",
    path: `${draft}&tab=credentials`,
    observabilityDenied: true,
    extraSecrets: [{ id: "sec_demo_replacement", name: "Replacement model token" }],
    actions: [
      { selector: "#harness-auth-method", value: "codex_pat" },
      { selector: "#harness-auth-secret", value: "sec_demo_replacement" },
      click("Save authentication source"),
    ],
    description:
      "A member saves a new model Secret. The session already knows this member does not administer the Installation, so the form sends no IAM request for the Agent's grant. The warning says this session did not verify the Agent's access, names the Installation administrator and the step that grants it, and offers no Retry credential access.",
    steps: [
      "Read the warning: this session did not verify access, and an Installation administrator opens this Agent's Credentials and selects Save authentication source.",
      "Only Reload authentication source remains. Deploy new version stays blocked. The request log shows the Agent PATCH and no /iam/ request.",
    ],
    gap: "The member browser test uses a member account and the real Installation permission check.",
  },
  authSaveRefused: {
    group: "Components/Credentials",
    name: "Authentication save refused",
    path: `${draft}&tab=credentials`,
    extraSecrets: [{ id: "sec_demo_replacement", name: "Replacement model token" }],
    rules: [
      {
        suffix: "/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    actions: [
      { selector: "#harness-auth-method", value: "codex_pat" },
      { selector: "#harness-auth-secret", value: "sec_demo_replacement" },
      click("Save authentication source"),
    ],
    description:
      "The Agent update is refused. The refusal is a danger block that takes focus; progress (“Saving authentication…”) stays a grey hint.",
    gap: "The refusal is simulated; the API decides every save.",
  },
  authSecretGrantLoading: {
    group: "Components/Credentials",
    name: "Checking model Secret access",
    path: `${draft}&tab=credentials`,
    rules: [{ suffix: "/iam/access-bindings", method: "POST", hold: true }],
    actions: [click("Save authentication source")],
    description:
      "Authentication is saved while the grant is pending. Saving and deployment remain disabled; a timeout reports partial success.",
  },
  authSaveHoldsNavigation: {
    group: "Components/Credentials",
    name: "Authentication save holds navigation",
    path: `${draft}&tab=credentials`,
    rules: [
      {
        suffix: "/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        delayMs: 3600,
      },
    ],
    actions: [
      click("Save authentication source"),
      { selector: 'a[data-nav="agents"]', click: true },
    ],
    description:
      "The story selects Save authentication source, then Agents in the sidebar. The page stays, and a note in the authentication form says why until the simulated save answers 3.6 s later.",
    steps: [
      "While the note “This page stays open until the authentication save finishes.” shows, select ← Agents or choose another Namespace. The page and selected Namespace stay the same. Reset the story to try again.",
      "When the save answers, the note goes; Agents in the sidebar now leaves.",
    ],
  },
  authSaveUnknown: {
    group: "Components/Credentials",
    name: "Authentication save unknown",
    path: `${draft}&tab=credentials`,
    rules: [
      { suffix: "/agents/agt_00000000-0000-4000-8000-000000000001", method: "PATCH", status: 503 },
    ],
    actions: [click("Save authentication source")],
    description:
      "An unavailable save response requires Refresh to inspect persisted state before another save or grant attempt.",
  },
  authRuntime: {
    group: "Components/Credentials",
    name: "Operator-managed authentication",
    path: `${draft}&tab=credentials`,
    auth: "runtime",
    description:
      "The operator configures runtime credentials. The console cannot validate provider login or model readiness.",
  },
  authService: {
    group: "Components/Credentials",
    name: "ChatGPT service account",
    path: `${draft}&tab=credentials`,
    auth: "service",
    description:
      "Select an issued service account, or switch to an imported Service Accounts token Secret. Both use the same PAT login method.",
    gap: "Service-account issuance is outside the console.",
  },
  authServiceEmpty: {
    group: "Components/Credentials",
    name: "No issued service accounts",
    path: `${draft}&tab=credentials`,
    auth: null,
    serviceAccountsEmpty: true,
    actions: [{ selector: "#harness-auth-method", value: "service_account" }],
    description:
      "An empty issued-account list cannot be saved. Choose another authentication source.",
  },
  authServiceDenied: {
    group: "Components/Credentials",
    name: "Issued service accounts unavailable",
    path: `${draft}&tab=credentials`,
    auth: "service",
    rules: [{ suffix: "/service-accounts", method: "GET", status: 403 }],
    description:
      "A failed list request preserves the saved account and explains that accounts are unavailable only while issued-account authentication is selected.",
    steps: [
      "Switch Authentication source to API key, Service Accounts, and Operator-managed credentials. The issued-account error disappears; each source shows its own fields with consistent styling.",
      "Return to Issued ChatGPT service account. The unavailable-account feedback and saved account return; the failed lookup does not change its selection.",
    ],
  },
  nativeAdmin: {
    group: "Components/Native admin",
    name: "Available",
    path: revision,
    deployed: true,
    nativeAdmin: "available",
    description:
      "The Agent overview puts the authorized admin launch beside its access and configuration warning. The link opens a fixture, not a gateway.",
    steps: [
      "Check the selected version, completed deployment, and unverified live serving at desktop and phone widths.",
      "Expand Deployment details, then open the admin console. Compare Denied and hidden: there is no launch or access warning there.",
    ],
  },
  nativeStopped: {
    group: "Components/Native admin",
    name: "Stopped",
    path: draft,
    nativeAdmin: "stopped",
    description: "The native-admin panel reports that the Agent must be started.",
    gap: "Deploying a new revision resumes the Agent; Console does not expose live shutdown completion evidence.",
  },
  nativeUnsupported: {
    group: "Components/Native admin",
    name: "Unsupported",
    path: revision,
    deployed: true,
    nativeAdmin: "unsupported",
    description: "The selected runtime does not expose a supported native admin endpoint.",
  },
  nativeDenied: {
    group: "Components/Native admin",
    name: "Denied and hidden",
    path: revision,
    deployed: true,
    nativeAdmin: "denied",
    description: "Denied native-admin access hides the whole panel.",
  },
  nativeRefreshing: {
    group: "Components/Native admin",
    name: "Refreshing access",
    path: draft,
    nativeAdmin: "stopped",
    // The first access check answers at once; each Refresh access reads for 1.5 s.
    rules: [{ suffix: "/native-admin", skip: 1, delayMs: 1500 }],
    description: "Refresh access keeps keyboard focus while it rereads native admin access.",
    steps: [
      "Tab to Refresh access and press Enter. While Checking access… shows, focus stays on the button and Enter again sends nothing.",
    ],
  },
  workspaceNavigation: {
    group: "Components/Workspace",
    name: "Keep unsaved files",
    path: `${revision}&tab=workspace`,
    deployed: true,
    actions: [
      {
        selector: '[id="workspace-AGENTS.md"]',
        value: "# Unsaved guidance\nKeep these edits while navigating.\n",
      },
      { selector: '[id="workspace-USER.md"]', value: "" },
    ],
    description: "File edits, including empty text, survive tabs and pages until Save or Reload.",
    steps: [
      "Switch to Configuration and back to Workspace files.",
      "Open Namespaces, return with Back, then save AGENTS.md and reload USER.md.",
    ],
    gap: "Simulated files; no live Agent gateway.",
  },
  workspace: {
    group: "Components/Workspace",
    name: "Editable files",
    path: `${revision}&tab=workspace`,
    deployed: true,
    description:
      "Load, edit, save, and reload AGENTS.md, SOUL.md, IDENTITY.md, and USER.md. Changes apply to live files, not revisions.",
  },
  workspaceCleanCRLF: {
    group: "Components/Workspace",
    name: "Unchanged Windows line endings",
    path: `${revision}&tab=workspace`,
    deployed: true,
    workspaceFiles: { "USER.md": "# Saved USER.md\r\n# Windows instructions\r\n" },
    description:
      "An untouched CRLF file shows LF and stays clean. Save enables only after an edit.",
    steps: [
      "Reload USER.md without editing; Save stays disabled.",
      "Edit USER.md, then Save and Reload.",
    ],
    gap: "Simulated files; no live Agent gateway.",
  },
  workspaceUnavailable: {
    group: "Components/Workspace",
    name: "No deployed revision",
    path: `${draft}&tab=workspace`,
    description: "Workspace editing requires a deployed Agent and reachable gateway.",
  },
  workspaceDenied: {
    group: "Components/Workspace",
    name: "Access denied",
    path: `${revision}&tab=workspace`,
    deployed: true,
    rules: [
      {
        prefix:
          "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/workspace/",
        status: 403,
      },
    ],
    description: "Unauthorized reads do not enable blank overwrites.",
  },
  workspaceSaveDenied: {
    group: "Components/Workspace",
    name: "Save denied",
    path: `${revision}&tab=workspace`,
    deployed: true,
    rules: [{ suffix: "/AGENTS.md", method: "PUT", status: 403 }],
    actions: [
      {
        selector: '[id="workspace-AGENTS.md"]',
        value: "# Updated guidance\nReview changes before applying them.",
      },
      click("Save AGENTS.md"),
    ],
    description:
      "A refused save names the Agent operate grant it needs and keeps the edit on screen.",
  },
  workspaceOperateDenied: {
    group: "Components/Workspace",
    name: "Save needs Agent operate",
    path: `${revision}&tab=workspace`,
    deployed: true,
    agentPermissionSummary: { update: true, deploy: true, operate: false, delete: true },
    description:
      "The Agent permission answer denies operate: the files load read-only, and each Save stays in the Tab order, looks disabled and is described by the note naming Agent operate.",
    steps: ["Tab to Save AGENTS.md and press Enter. Nothing is sent and the file is unchanged."],
    gap: "Simulated files and permission answer; the API still refuses the write.",
  },
  workspaceMissing: {
    group: "Components/Workspace",
    name: "Missing file",
    path: `${revision}&tab=workspace`,
    deployed: true,
    rules: [
      {
        suffix: "/AGENTS.md",
        method: "GET",
        status: 404,
        code: "NOT_FOUND",
        message: "The requested workspace file was not found.",
        once: true,
      },
    ],
    description:
      "A file the API confirms missing says so on first load and can be created; unrelated file editors still load.",
  },
  workspaceResourceMissing: {
    group: "Components/Workspace",
    name: "Agent unavailable while reading a file",
    path: `${revision}&tab=workspace`,
    deployed: true,
    rules: [
      {
        suffix: "/AGENTS.md",
        method: "GET",
        status: 404,
        code: "NOT_FOUND",
        message: "The requested platform resource was not found.",
        once: true,
      },
    ],
    description: "The Agent was unavailable, so the editor cannot assume AGENTS.md is empty.",
    steps: ["Choose Reload AGENTS.md. Once its contents load, edit the file to enable Save."],
  },
  workspaceUnknown: {
    group: "Components/Workspace",
    name: "Write outcome unknown",
    path: `${revision}&tab=workspace`,
    deployed: true,
    rules: [{ suffix: "/AGENTS.md", method: "PUT", status: 503 }],
    actions: [
      {
        selector: '[id="workspace-AGENTS.md"]',
        value: "# Updated guidance\nReview changes before applying them.",
      },
      click("Save AGENTS.md"),
    ],
    description:
      "After an uncertain save, reload the same file to inspect its contents before deciding whether to save again.",
  },
  workspaceMissingReadback: {
    group: "Components/Workspace",
    name: "Missing file after uncertain create",
    path: `${revision}&tab=workspace`,
    deployed: true,
    rules: [
      {
        suffix: "/AGENTS.md",
        method: "GET",
        status: 404,
        code: "NOT_FOUND",
        message: "The requested workspace file was not found.",
      },
      { suffix: "/AGENTS.md", method: "PUT", status: 503, once: true },
    ],
    actions: [
      { selector: '[id="workspace-AGENTS.md"]', value: "# Interrupted first create" },
      click("Save AGENTS.md"),
    ],
    description:
      "Simulated uncertain creation stays guarded until explicit Reload confirms file absence. Reload opens an empty editor; creation still requires Save.",
  },
  workspaceVersionReread: {
    group: "Components/Workspace",
    name: "Reread after a version change",
    path: `${currentVersion}&tab=workspace`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    rules: [
      // IDENTITY.md stays missing: the file-specific 404 answers the first read and the reread.
      {
        suffix: "/IDENTITY.md",
        method: "GET",
        status: 404,
        code: "NOT_FOUND",
        message: "The requested workspace file was not found.",
      },
      // The new version's gateway cannot answer the SOUL.md reread.
      { suffix: "/SOUL.md", method: "GET", skip: 1, once: true, status: 503 },
    ],
    description:
      "v7 finishes deploying while Workspace files are open. Unedited files are reread in place from it.",
    steps: [
      "Wait about 5 seconds for Deployment activity to record v7 as succeeded, or click Refresh deployment.",
      "IDENTITY.md keeps its missing-file error and adds no reread warning.",
      "SOUL.md says it could not be reread. Click Reload SOUL.md: the warning is replaced by SOUL.md loaded.",
    ],
    gap: "Simulated API results demonstrate presentation only. Browser tests cover reread ordering and later rereads clearing a failure.",
  },
  workspaceVersionRereadFocused: {
    group: "Components/Workspace",
    name: "Reread keeps a focused editor's caret",
    path: `${currentVersion}&tab=workspace`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    workspaceFiles: { "SOUL.md": soulVersion("v6") },
    // v7 serves a different SOUL.md; the reread after it succeeds.
    rules: [
      {
        suffix: "/SOUL.md",
        method: "GET",
        skip: 1,
        once: true,
        data: { name: "SOUL.md", content: soulVersion("v7") },
      },
    ],
    description:
      "v7 finishes deploying while a reader has clicked into SOUL.md without editing. The file is reread with v7's contents, and the caret, selection and scroll stay where they were.",
    steps: [
      "Scroll SOUL.md to line 20 and select a word there. Don't type, and don't click Refresh deployment (it would take focus).",
      "Wait about 5 seconds for Deployment activity to record v7 as succeeded. SOUL.md says SOUL.md reloaded with its current contents., and its first line now reads v7.",
      "The selection is still on line 20 and SOUL.md has not scrolled. Type a word: it replaces the selection on line 20.",
    ],
    gap: "Simulated API results demonstrate presentation only. Browser tests cover the caret and scroll after a changed reread.",
  },
  workspaceVersionRereadUnconfirmed: {
    group: "Components/Workspace",
    name: "Reread cannot confirm a missing file",
    path: `${currentVersion}&tab=workspace`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    rules: [
      {
        suffix: "/IDENTITY.md",
        method: "GET",
        once: true,
        status: 404,
        code: "NOT_FOUND",
        message: "The requested workspace file was not found.",
      },
      // A resource 404 does not confirm the file is still missing.
      {
        suffix: "/IDENTITY.md",
        method: "GET",
        once: true,
        status: 404,
        code: "NOT_FOUND",
        message: "The requested platform resource was not found.",
      },
    ],
    description:
      "IDENTITY.md was read as missing; the reread for v7 gets a resource 404, which does not confirm that.",
    steps: [
      "IDENTITY.md shows its missing-file error.",
      "Wait about 5 seconds for Deployment activity to record v7 as succeeded, or click Refresh deployment.",
      "IDENTITY.md says it could not be reread. Click Reload IDENTITY.md: the file now reads, and IDENTITY.md loaded. replaces the warning and the error.",
    ],
    gap: "Simulated API results demonstrate presentation only; the resource 404 is controlled.",
  },
  deletionPermissionDuringConfirmation: {
    group: "Components/Deletion",
    name: "Permission arrives while confirmation is open",
    path: revision,
    deployed: true,
    readOnlyPermissionSummary: true,
    rules: [{ suffix: "/permissions", delayMs: 3500 }],
    actions: [click("Delete Agent")],
    description: "The story opens Delete before the delayed permission summary answers no.",
    steps: [
      "Watch the open confirmation explain the restriction, disable Delete, and move focus to Cancel.",
      "Cancel or press Escape. The page should explain why Delete is unavailable, without sending a delete request.",
    ],
  },
  deletionConfirm: {
    group: "Components/Deletion",
    name: "Confirmation",
    path: draft,
    actions: [click("Delete Agent")],
    description:
      "A focused confirmation dialog describes irreversible Agent, revision, and workspace deletion. Namespace Configurations and Secrets remain.",
  },
  deleting: {
    group: "Components/Deletion",
    name: "Cleanup in progress",
    path: draft,
    deleting: true,
    rules: [{ suffix: "/agents/agt_00000000-0000-4000-8000-000000000001", skip: 1, delayMs: 1300 }],
    steps: [
      "Focus Refresh deletion status and press Enter. When Checking finishes, focus returns to Refresh.",
      "Refresh again and press Tab during Checking. The response leaves focus where you moved it.",
      "Leave the page open: the 3 s status polls do not change Refresh to Checking or rewrite the deletion notice.",
    ],
    description:
      "An already deleting Agent retains manual confirmed recovery and status refresh controls; worker progress is simulated.",
  },
  deletionRetryConfirm: {
    group: "Components/Deletion",
    name: "Repeat cleanup confirmation",
    path: draft,
    deleting: true,
    actions: [click("Request deletion again")],
    description:
      "A manual repeated deletion requires confirmation. Queued or running cleanup remains unchanged.",
  },
  deletionRetryUnknown: {
    group: "Components/Deletion",
    name: "Repeat cleanup outcome unknown",
    path: draft,
    deleting: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "DELETE",
        status: 503,
        once: true,
      },
    ],
    actions: [
      click("Request deletion again"),
      { selector: ".agent-delete-dialog button.danger", click: "Request deletion again" },
    ],
    description:
      "An uncertain repeat request remains disabled until Refresh reads the already deleting Agent successfully. No write is automatically retried.",
  },
  deletionDenied: {
    group: "Components/Deletion",
    name: "Permission denied",
    path: draft,
    rules: [
      { suffix: "/permissions", status: 503 },
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "DELETE",
        status: 403,
      },
    ],
    actions: [click("Delete Agent"), click("Permanently delete Agent")],
    description:
      "Permission advice is unavailable. The attempted deletion is denied and the Console explains the missing access.",
  },
  deletionConflict: {
    group: "Components/Deletion",
    name: "Conflict",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "DELETE",
        status: 409,
      },
    ],
    actions: [click("Delete Agent"), click("Permanently delete Agent")],
    description: "Refresh status before retrying deletion after a conflict.",
  },
  deletionUnknown: {
    group: "Components/Deletion",
    name: "Outcome unknown",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "DELETE",
        status: 503,
      },
    ],
    actions: [click("Delete Agent"), click("Permanently delete Agent")],
    description:
      "Deletion may have started. Refresh deletion status checks this Agent without sending another deletion request.",
  },
  createFlow: {
    group: "Flows",
    name: "Create and deploy an Agent",
    path: create,
    emptyAgents: true,
    transport: false,
    description:
      "Interactive walkthrough from Preset selection through first-time provisioning and deployment activation. Worker progress is simulated; it is not a live deployment.",
    steps: [
      "Choose Research assistant, fill Name, then Use Preset.",
      "Review the Configuration, masked pre-existing model Secret reference, and four seeded workspace files; click Create Agent.",
      "Wait for provisioning to finish; the Console opens Agent details with the queued deployment. Wait a few seconds or use Refresh deployment to finish simulated activation, then open Workspace files.",
      "Use Versions to inspect the immutable snapshot and Workspace files to inspect runtime files seeded during creation.",
    ],
    gap: "The fixture supplies a ready Namespace, Preset, and model Secret. Set those up outside the console. Verify actual serving health and a model response outside this walkthrough.",
  },
  createHarnessFlow: {
    group: "Flows",
    name: "Choose provider, harness, and authentication",
    path: create,
    actions: readyForm,
    description:
      "Choose the provider first, then a compatible harness. The production form updates native Configuration and execution mode; credentials and deployment remain simulated.",
    steps: [
      "Check the inset arrows on the Namespace, Provider, Harness, and Authentication method controls. Use the controls with a mouse and keyboard.",
      "OpenAI starts with Codex and Dedicated execution. Select OpenClaw: Embedded is selected and channel controls are disabled. Expand Runtime details and select Dedicated; the OpenClaw harness stays selected and channel controls become available.",
      "Select Anthropic: only OpenClaw is available, and the previous provider's credential and model are cleared. Enter a dummy API key and choose a listed model.",
      "Select OpenAI again: Codex is selected by default. Choose Service Accounts, enter a dummy token, and choose a listed model.",
      "Select OpenClaw: authentication changes to API key and the token and model are cleared. Enter a dummy API key and select a model to continue creation.",
    ],
    gap: "This walkthrough covers form state and the fixed model choices. Real API integration and runtime checks establish credential routing and model execution.",
  },
  createExitFlow: {
    group: "Flows",
    name: "Keep an Agent draft",
    path: create,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/provision",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message: "The requested platform resource already exists.",
        once: true,
      },
    ],
    description:
      "Leave a default starter Agent form and return to it, keep it after a refused Create, then discard it with Cancel.",
    steps: [
      "Choose Start with default Preset and enter an Agent name.",
      "Select the Agents link, then choose Create Agent again: the form returns with the name.",
      "Choose a listed model, create a model Secret, and select Create Agent: a simulated conflict refuses it once. Leave and return the same way: the name, model, and Secret return, ready to retry.",
      "Select Cancel and confirm Discard this draft. Choose Create Agent: the initial choices are shown.",
    ],
    gap: "The fixture demonstrates simulated console state; it does not verify a live backend or deployment.",
  },
  createWorkspaceFlow: {
    group: "Flows",
    name: "Create with workspace files",
    path: create,
    emptyAgents: true,
    transport: false,
    description:
      "Create a Dedicated Agent from the default Preset form after editing IDENTITY.md and clearing USER.md, then inspect the seeded workspace after simulated provisioning.",
    steps: [
      "Start with default Preset, enter a demo Agent name, keep OpenAI with the Codex harness, enter a dummy API key or service account token, and choose a listed model or enter a model ID manually.",
      "Review AGENTS.md, SOUL.md, IDENTITY.md, and USER.md. Edit IDENTITY.md, leave USER.md empty, and create the Agent.",
      "Wait for automatic provisioning and deployment activation; the Console then opens Workspace files for the returned revision.",
      "Open Workspace files and inspect IDENTITY.md or USER.md to confirm the fixture carried the creation-time file contents into the deployed workspace.",
    ],
    gap: "This Storybook flow proves the UI request body and fixture readback path. It does not prove real gateway filesystem writes or serving health.",
  },
  createSlackSecretsFlow: {
    group: "Flows",
    name: "Create with Slack Secrets",
    path: create,
    emptyAgents: true,
    transport: false,
    actions: [
      ...readyForm,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
      { selector: "#slack-dm-policy", value: "disabled" },
      { selector: "#slack-channel-ids-search", value: "CDEMO123", key: "Enter" },
      ...allowEveryoneInSlackChannels,
      { selector: "#slack-secret-slack-app-token", value: "sec_demo_slack_app_token" },
      ...createSlackBotSecret,
      click("Apply channel settings"),
    ],
    description:
      "Guided create-form state with one existing simulated Slack Secret and one newly created simulated Secret staged into the Agent Configuration.",
    steps: [
      "Start with default Preset and enter the Agent name.",
      "Open Configure Slack, choose the existing Slack app Secret, create a new Slack bot Secret from the modal, and allow everyone in the selected channel.",
      'Apply channel settings. The form receives channel JSON with users: ["*"] and Secret binding JSON while token values stay hidden.',
      "Create the Agent to persist the Configuration and let the controller grant the Agent access to the staged Slack Secrets.",
    ],
    gap: "The fixture proves the Console request workflow with simulated Secret metadata. Use a live Namespace and Slack app to prove real Secret propagation and Slack replies.",
  },
  devdayCreateFlow: {
    group: "Flows",
    name: "DevDay segment 1: create devday claw",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    agentName: "oceclaw",
    deployed: true,
    slack: true,
    slackChannels: { COPENCLAWFEEDBACK: { requireMention: true, users: ["UDEMO123"] } },
    nativeAdmin: "available",
    nativeAdminUrl: "/storybook-fixtures/devday-admin.html?agent=oceclaw&channel=openclaw-feedback",
    swePreset: true,
    pluginDiscovery: devdayPluginDiscovery,
    pluginCapabilities,
    fixturePluginCatalog: true,
    fixturePluginCatalogMessage:
      "Storybook is showing a simulated curated plugin catalog for DevDay rehearsal. Real deployments still require plugin access for the selected service account.",
    repositoryOptions: [
      {
        repositoryRef: "openclaw/openclaw-enterprise",
        displayName: "openclaw/openclaw-enterprise",
        allowedProfiles: ["git-read", "git-write"],
      },
      {
        repositoryRef: "openclaw/openclaw",
        displayName: "openclaw/openclaw",
        allowedProfiles: ["git-read", "git-write"],
      },
    ],
    extraSecrets: [
      {
        id: "sec_devday_model_token",
        name: "DevDay Codex service account (simulated)",
      },
      {
        id: "sec_devday_slack_app_token",
        name: "devday claw Slack app token (simulated)",
      },
      {
        id: "sec_devday_slack_bot_token",
        name: "devday claw Slack bot token (simulated)",
      },
    ],
    nextStory: "devdayAdminFlow",
    description:
      "DevDay create-flow rehearsal using real Console controls with fake service-account and Slack Secret data. Provisioning and deployment progress are simulated in the Storybook fixture.",
    steps: [
      "Start on the Agents list with the already deployed oceclaw seed, then click Create Agent.",
      "The picker includes SWE Agent, Standard Codex, and Standard OpenClaw. Select SWE Agent and enter devday claw for its name.",
      "Keep the default gpt-6-astra model and click Use Preset. Choose the existing DevDay Codex service account (simulated) Secret, or explicitly create a new simulated Secret. No credential is preselected. Review AGENTS.md: its opening sentence now says You are devday claw. Workspace defaults remain editable.",
      "Open Configure plugins. The simulated curated catalog is available for every Preset and Secret choice in this Storybook flow; add Linear, set Linear default reviewer to Automatic review, and set Create issue approval to Ask for approval.",
      "Repository access offers openclaw/openclaw-enterprise and openclaw/openclaw. Select either or both with Contributor access, then turn off issue management to match the approved profiles.",
      "Open Edit Slack. Confirm no channels are prefilled. Add the simulated channel CDEMO123. Allow simulated user UDEMO123, then bind the existing simulated DevDay Slack Secrets and apply settings.",
      "Create Agent and wait for provisioning to open Agent details. Inspect Deployment activity; it finishes simulated activation after a few seconds, or use Refresh deployment.",
      "Use ← Agents and open oceclaw in the same fixture to continue segment 2. The next-segment link starts an independent resettable fixture.",
    ],
    gap: "This Storybook flow proves only the UI sequence and fixture state. It does not store a real credential, deploy a workload, prove GitHub authorization, or prove Slack delivery.",
  },
  devdayCreateCheckpoint: {
    group: "Flows",
    name: "DevDay segment 1 checkpoint: deployed devday claw",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    agentName: "oceclaw",
    deployed: true,
    slack: true,
    slackChannels: { COPENCLAWFEEDBACK: { requireMention: true, users: ["UDEMO123"] } },
    nativeAdmin: "available",
    nativeAdminUrl: "/storybook-fixtures/devday-admin.html?agent=oceclaw&channel=openclaw-feedback",
    swePreset: true,
    pluginDiscovery: devdayPluginDiscovery,
    pluginCapabilities,
    fixturePluginCatalog: true,
    fixturePluginCatalogMessage:
      "Storybook is showing a simulated curated plugin catalog for DevDay rehearsal. Real deployments still require plugin access for the selected service account.",
    repositoryOptions: [
      {
        repositoryRef: "openclaw/openclaw-enterprise",
        displayName: "openclaw/openclaw-enterprise",
        allowedProfiles: ["git-read", "git-write"],
      },
      {
        repositoryRef: "openclaw/openclaw",
        displayName: "openclaw/openclaw",
        allowedProfiles: ["git-read", "git-write"],
      },
    ],
    extraSecrets: [
      {
        id: "sec_devday_model_token",
        name: "DevDay Codex service account (simulated)",
      },
      {
        id: "sec_devday_slack_app_token",
        name: "devday claw Slack app token (simulated)",
      },
      {
        id: "sec_devday_slack_bot_token",
        name: "devday claw Slack bot token (simulated)",
      },
    ],
    actions: devdayCreateCheckpoint,
    description:
      "Auto-run checkpoint for reviewers who want the created Agent detail view without replaying every presenter click.",
    steps: [
      "Use the primary DevDay segment 1 story for recording the manual presenter flow.",
      "This checkpoint clicks through the same controls, including the Linear plugin policy choices, and opens Agent details while the first deployment remains queued.",
    ],
    gap: "Checkpoint automation is a setup aid. Use the manual story for the demo video.",
  },
  devdayAdminFlow: {
    group: "Flows",
    name: "DevDay segment 2: oceclaw Admin UI",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    agentName: "oceclaw",
    deployed: true,
    slack: true,
    slackChannels: { COPENCLAWFEEDBACK: { requireMention: true, users: ["UDEMO123"] } },
    nativeAdmin: "available",
    nativeAdminUrl: "/storybook-fixtures/devday-admin.html?agent=oceclaw&channel=openclaw-feedback",
    description:
      "DevDay handoff from a deployed Console Agent to the simulated native Admin UI. The Agent is named oceclaw and its Slack fixture represents #openclaw-feedback.",
    steps: [
      "Start on the Agents list and open oceclaw.",
      "Confirm the Console shows a selected deployed revision, simulated deployment status, and available native admin access.",
      "Click Open admin console. The target fixture opens with an existing #openclaw-feedback message.",
      "Enter a new message, click Send in the simulated Admin UI, and confirm the visible assistant reply.",
    ],
    gap: "The Admin UI target is a fixture page. It demonstrates the link target and chat-shaped result only; it does not connect to a gateway, Slack, credentials, or a model.",
  },
  devdayAdminCheckpoint: {
    group: "Flows",
    name: "DevDay segment 2 checkpoint: oceclaw detail",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    agentName: "oceclaw",
    deployed: true,
    slack: true,
    slackChannels: { COPENCLAWFEEDBACK: { requireMention: true, users: ["UDEMO123"] } },
    nativeAdmin: "available",
    nativeAdminUrl: "/storybook-fixtures/devday-admin.html?agent=oceclaw&channel=openclaw-feedback",
    actions: devdayAdminCheckpoint,
    description: "Auto-run checkpoint that opens oceclaw and waits for the native Admin UI link.",
    steps: [
      "Use the primary DevDay segment 2 story for recording the manual presenter flow.",
      "This checkpoint opens oceclaw and stops at the available native Admin UI link.",
    ],
    gap: "Checkpoint automation is a setup aid. The Admin UI remains a simulated fixture.",
  },
  updateFlow: {
    group: "Flows",
    name: "Update an Agent",
    path: `${draft}&tab=channels`,
    deployed: true,
    slack: true,
    description:
      "Edit saved settings while the current version stays unchanged; deploy a new immutable version.",
    steps: [
      "Open Edit Slack, paste CNEW123 into Channels and press Enter, then Save configuration.",
      "Select View version v1 and open Channels: it still has the original settings.",
      "Select Create new version, then Deploy new version. The saved draft is deployed, not the viewed snapshot.",
      "Refresh deployment and inspect the new version. The prior snapshot remains readable.",
      "Workspace file edits are separate: they save immediately without a new revision.",
    ],
    gap: "Native JSON edits use Configuration, while Slack has a dedicated drawer. The Slack drawer preserves existing policies; change unsupported policy fields through native JSON.",
  },
  slackChannelAccessFlow: {
    group: "Flows",
    name: "Change Slack channel senders",
    path: `${draft}&tab=channels`,
    deployed: true,
    slack: true,
    actions: [
      click("Edit Slack"),
      ...allowEveryoneInSlackChannels,
      click("Save configuration"),
      click("Edit Slack"),
    ],
    description:
      "Save channel sender access as everyone, reopen the drawer, and verify the saved setting without changing direct-message access.",
    steps: [
      "Open Edit Slack and inspect the Specific people selection and saved people chips.",
      "Choose Everyone in these channels from the access menu and save the Configuration.",
      'Reopen Edit Slack. The drawer shows Everyone in these channels for the saved users: ["*"] channel setting.',
      "Choose Specific people and select users if you want to restrict channel senders before saving again.",
    ],
    gap: "The fixture proves saved Console state and request shape only. Use a live Slack app to prove channel delivery.",
  },
  stopPermissionDuringConfirmation: {
    group: "Components/Stop Agent",
    name: "Permission arrives while confirmation is open",
    path: revision,
    deployed: true,
    readOnlyPermissionSummary: true,
    rules: [{ suffix: "/permissions", delayMs: 3500 }],
    actions: [click("Stop Agent")],
    description: "The story opens Stop before the delayed permission summary answers no.",
    steps: [
      "Watch the open confirmation explain the restriction, disable Stop, and move focus to Cancel.",
      "Cancel or press Escape. The page should explain why Stop is unavailable, without sending a stop request.",
    ],
  },
  dangerZoneReader: {
    group: "Pages/Agent detail",
    name: "Danger zone, viewer cannot stop or delete",
    path: revision,
    deployed: true,
    readOnlyPermissionSummary: true,
    description:
      "The permission answer denies Agent operate and delete, so the page has no Danger zone: neither Stop Agent nor Delete Agent is offered.",
    gap: "The permission answer is simulated; the API still authorizes every request.",
  },
  stopConfirm: {
    group: "Components/Stop Agent",
    name: "Confirmation",
    path: revision,
    deployed: true,
    actions: [click("Stop Agent")],
    description: "Confirm stopping the Agent or cancel without changing its requested state.",
    steps: [
      "Confirm Stop Agent. The result stays in view, focus moves to Refresh stop status, and the version detail does not reload.",
      "For the revision clearing while Workspace is open, use Flows / Stop an Agent.",
    ],
  },
  stopPending: {
    group: "Components/Stop Agent",
    name: "Stop pending",
    path: revision,
    deployed: true,
    rules: [{ suffix: "/stop", method: "POST", hold: true }],
    actions: [click("Stop Agent"), { selector: ".agent-stop-dialog button.danger", click: true }],
    description:
      "The Stop request is held, so the confirmation stays on Stopping…. The button is busy, not unavailable: it sets aria-busy and shows the progress pointer (finding 1927).",
    steps: ["Hover Stopping…: the pointer is progress, not not-allowed, and Cancel is disabled."],
    gap: "The request never answers; this story does not verify a stop.",
  },
  stopRequested: {
    group: "Components/Stop Agent",
    name: "Stop requested",
    path: revision,
    deployed: true,
    stopped: true,
    rules: [{ suffix: "/agents/agt_00000000-0000-4000-8000-000000000001", skip: 1, delayMs: 1800 }],
    steps: [
      "Focus Refresh stop status and press Enter. When Checking finishes, focus returns to Refresh.",
      "Refresh again, then press Tab while Checking is visible. Focus stays on the control you moved to.",
    ],
    description:
      "The requested state is stopped with a selected revision. The overview shows Runtime: Stop requested, and the Stop row offers only Request Stop again and Refresh; shutdown completion is not exposed here.",
  },
  stopReadDiscoversDeletion: {
    group: "Components/Stop Agent",
    name: "Deletion discovered",
    path: revision,
    deployed: true,
    stopped: true,
    deletingOnRefresh: true,
    description: "Another actor starts deletion after the page loads.",
    steps: [
      "Choose Refresh stop status. The page shows deletion recovery and focuses Refresh deletion status without sending a write.",
    ],
  },
  stopRepeatConfirm: {
    group: "Components/Stop Agent",
    name: "Repeat confirmation",
    path: revision,
    deployed: true,
    stopped: true,
    actions: [click("Request Stop again")],
    description:
      "An explicit repeated Stop uses the same confirmation and preserves the selected version. Cancel or Escape returns keyboard focus to Request Stop again.",
  },
  stopNoSelection: {
    group: "Components/Stop Agent",
    name: "No selected version",
    path: revision,
    deployed: true,
    stopped: true,
    stopNoSelection: true,
    description:
      "An absent selected version does not establish candidate cleanup. Explicit repeated Stop remains available; history is readable.",
  },
  stopNeverDeployed: {
    group: "Components/Stop Agent",
    name: "Never deployed",
    path: draft,
    description:
      "An Agent created without a deploy is stopped with no version, so the danger zone has no Stop row and the overview reports no stop request.",
  },
  stopRepeatUnknown: {
    group: "Components/Stop Agent",
    name: "Repeated Stop outcome unknown",
    path: revision,
    deployed: true,
    stopped: true,
    rules: [{ suffix: "/stop", method: "POST", status: 503, once: true }],
    actions: [
      click("Request Stop again"),
      { selector: ".agent-stop-dialog button.danger", click: true },
    ],
    description:
      "An uncertain repeated Stop offers only Refresh stop status until a successful readback.",
  },
  stopDenied: {
    group: "Components/Stop Agent",
    name: "Permission denied",
    path: revision,
    deployed: true,
    rules: [
      { suffix: "/permissions", status: 503 },
      { suffix: "/stop", method: "POST", status: 403 },
    ],
    actions: [click("Stop Agent"), { selector: ".agent-stop-dialog button.danger", click: true }],
    description:
      "Permission advice is unavailable. The attempted stop is denied and the Console explains the required access.",
  },
  stopUnknown: {
    group: "Components/Stop Agent",
    name: "Outcome unknown",
    path: revision,
    deployed: true,
    rules: [{ suffix: "/stop", method: "POST", status: 503, once: true }],
    actions: [click("Stop Agent"), { selector: ".agent-stop-dialog button.danger", click: true }],
    description:
      "Stop may have been accepted. Refresh stop status checks this Agent without sending another stop request.",
  },
  stopFlow: {
    group: "Flows",
    name: "Stop an Agent",
    path: `${revision}&tab=workspace`,
    deployed: true,
    clearRevisionOnStopReadback: true,
    description:
      "Open the Stop Agent confirmation and request the stopped desired state while preserving draft, revisions, credentials, and workspace data.",
    steps: [
      "Open Stop Agent and review the confirmation copy.",
      "With Workspace files open, confirm Stop Agent. The result stays in view, focus moves to Refresh stop status, and the current version still has file editors.",
      "Refresh stop status. The fixture now clears the current version; Workspace shows why files are unavailable, without reloading the page.",
      "Open Configuration, then Workspace files again. The unavailable notice remains; the old editors do not return.",
      "Focus Request Stop again, press Enter, then Cancel or Escape. Focus returns to Request Stop again without submitting. Reopen and confirm if recovery is needed; refresh an uncertain outcome before retrying.",
      "Return to Create new version and Deploy new version to request running again.",
    ],
    gap: "The fixture separates Stop acceptance from the next read clearing the selected revision. Neither establishes that a live gateway shut down. Disabling a channel does not stop the Agent; deletion is destructive.",
  },
  deleteFlow: {
    group: "Flows",
    name: "Delete an Agent",
    path: revision,
    deployed: true,
    description:
      "Interactive deletion through the actual console controls, with simulated asynchronous cleanup.",
    steps: [
      "Scroll to Delete Agent and open its confirmation dialog.",
      "Cancel once to inspect the safe exit, then reopen and confirm Permanently delete Agent.",
      "The page marks deletion requested, removes edit/deploy controls, and keeps confirmed manual recovery available.",
      "Click Refresh deletion status. The fixture now reports completion and the console returns to the Agent list.",
    ],
    gap: "The console reports deletion status but provides no detailed cleanup-progress view. Configurations and Secrets remain Namespace-owned and need separate management.",
  },
};

for (const [id, state, name] of [
  ["policyDenials", "ready", "Policy denials and reviewed network additions"],
  [
    "policyConfigurationAlternate",
    "alternate",
    "Another Driver renders enum fields from its schema",
  ],
  ["policyConfigurationLoading", "discoveryLoading", "Configuration discovery loading"],
  ["policyConfigurationDenied", "discoveryDenied", "Configuration discovery denied"],
  ["policyConfigurationStale", "stalePreview", "A superseded preview preserves the newer draft"],
  [
    "policyConfigurationRefresh",
    "refreshRace",
    "Overlapping policy refreshes retain the newest read",
  ],
  ["policyConfigurationJson", "json", "Complex fields retain invalid JSON for correction"],
  [
    "policyConfigurationHidden",
    "ownerDenied",
    "Policy hidden while independent logs remain visible",
  ],
  ["policyConfigurationInvalid", "invalid", "Configuration preview field errors"],
  ["policyConfigurationConflict", "conflict", "Configuration version conflict retains draft"],
  ["policyDenialsEmpty", "empty", "No denials in the loaded window"],
  ["policyDenialsDisabled", "disabled", "Policy editing disabled"],
  ["policyDenialsUnsupported", "unsupported", "Sandbox policy capability unavailable"],
  ["policyDenialsGap", "gap", "Policy denial window has a buffer gap"],
  ["policyDenialsMissingMetadata", "missingMetadata", "Policy denial with unknown metadata"],
  ["policyDenialsFailed", "failed", "Policy application unconfirmed"],
  ["policyDenialsApplyRejected", "applyRejected", "Policy saved but live application rejected"],
  ["policyIncompletePreview", "incompletePreview", "Policy preview omits the validated rules"],
  ["policyUnconfirmedSave", "unconfirmedSave", "Policy save returns different rules than reviewed"],
  ["policyDenialsEditDenied", "editDenied", "Independent policy permission denied"],
  ["policyDenialsCeilingDenied", "ceilingDenied", "Policy addition exceeds the delegation ceiling"],
  [
    "policyDenialsSuggestionsUnavailable",
    "suggestionsUnavailable",
    "Manual policy editing without suggestions",
  ],
  ["policyDenialsReadDenied", "readDenied", "Policy logs denied but policy remains editable"],
  ["policyDenialsLoading", "loading", "Policy decisions loading"],
  [
    "policyDenialsNoCredential",
    "noCredential",
    "Policy logs unavailable without runtime credentials",
  ],
  ["policyDenialsProtected", "protected", "Protected execution refuses network policy additions"],
]) {
  scenarios[id] = {
    group: "Pages/Agent detail",
    name,
    path: `${candidateVersion}&tab=policy`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    policyState: state,
    ...(state === "discoveryLoading"
      ? { rules: [{ suffix: "/driver-configurations", hold: true }] }
      : {}),
    ...(state === "discoveryDenied"
      ? { rules: [{ suffix: "/driver-configurations", status: 403 }] }
      : {}),
    ...(state === "stalePreview" ? { rules: [{ suffix: "/validate", delayMs: 3000 }] } : {}),
    description:
      "Observed denial records, aggregated provider suggestions, and governed policy additions remain distinct.",
    steps: [
      "Expand a denial to inspect the sanitized log. Review its exact executable and endpoint before saving an addition.",
      "Use the schema field Add and Remove controls to edit proposed rules. Confirm these local edits do not save. Review changes and return with Back to editing.",
      "Compare Save (current revision unchanged) with Save and apply to current revision (pending, then confirmed with a provider version). Apply saved policy to current revision is unavailable while a proposal has unsaved edits.",
      "Disable policy editing and confirm approved grants remain visible. Check the empty, denied, unsupported, missing metadata, and unconfirmed stories.",
    ],
    gap: "Simulated UI proof only. These fixtures do not prove authorization, persistence, enforcement, or provider policy activation.",
    ...(state === "refreshRace"
      ? {
          description:
            "Another operator's simulated saves advance the policy between two overlapping reads.",
          steps: [
            "Double-click Refresh policy. The older read returns first; wait for saved policy v3.",
            "Apply the saved policy to the current revision. Observe pending status, then simulated provider confirmation from continued polling.",
          ],
        }
      : {}),
    ...(state === "ownerDenied"
      ? {
          steps: [
            "Refresh denials and confirm the independent log window loads even though discovery has no policy descriptor.",
            "Scroll to the policy and suggestion permission refusals. Confirm neither offers a retry or editing control.",
          ],
        }
      : {}),
    ...(state === "unsupported"
      ? {
          steps: [
            "The tab says once that the Sandbox Driver does not support per-Agent network policy. It reads no Sandbox logs or suggestions and offers no editor.",
          ],
        }
      : {}),
    ...(state === "protected"
      ? {
          steps: [
            "The tab states that protected execution applies: the Credential Proxy routes alone govern this Agent's egress, so network policy additions are refused. The proposal editor and Apply are unavailable.",
            "A rule saved before protected execution applied blocks every protected deploy. Choose Remove saved network rules and confirm the saved policy is now empty.",
          ],
        }
      : {}),
    ...(state === "ceilingDenied"
      ? {
          steps: [
            "Review the suggested outside.example.org addition and compare it with the Installation delegation ceiling.",
            "Choose Review changes. The preview ceiling rejection must be announced and brought into view, with the attempted addition preserved for correction.",
            "Confirm the saved policy version and additions are unchanged. This preview simulates the API rejection; the browser integration exercises actual OCC admission.",
          ],
        }
      : {}),
    ...(state === "applyRejected"
      ? {
          steps: [
            "Review a suggestion, then choose Review changes and Save and apply to current revision.",
            "Confirm the alert states the policy was saved but application was not confirmed. The saved version increases and the rule remains saved; do not infer live enforcement.",
          ],
        }
      : {}),
    ...(state === "incompletePreview"
      ? {
          steps: [
            "Choose Review suggestion, then Review changes. The preview omits the rules; your proposal stays editable and Save is unavailable.",
          ],
        }
      : {}),
    ...(state === "unconfirmedSave"
      ? {
          steps: [
            "Review a suggestion, then choose Review changes and Save and apply to current revision.",
            "The save response omits the rule. Confirm that live application was not requested, then choose Refresh policy to see the rule that was saved.",
          ],
        }
      : {}),
    ...(state === "readDenied"
      ? { rules: [{ suffix: "/runtime/logs", status: 403, code: "AUTHORIZATION_DENIED" }] }
      : {}),
    ...(state === "loading" ? { rules: [{ suffix: "/runtime/logs", hold: true }] } : {}),
    ...(state === "noCredential"
      ? { rules: [{ suffix: "/runtime/logs", status: 503, code: "DEPENDENCY_UNAVAILABLE" }] }
      : {}),
  };
}

// The shell and assets are produced by the API's actual theme loader/renderer.
for (const [id, source, name, theme] of [
  ["themeSignIn", "login", "Custom sign-in", "custom"],
  ["themeNavigation", "agents", "Custom desktop navigation", "custom"],
  ["themeMobile", "mobile", "Custom mobile navigation", "custom"],
  ["themeLongName", "agents", "Long product name", "long-name"],
  ["themeEmpty", "agentsEmpty", "Custom empty state", "custom"],
  ["themeDenied", "agentsDenied", "Custom denied state", "custom"],
  ["themeLoading", "agentsLoading", "Custom loading state", "custom"],
  ["themeCredentials", "authMissing", "Custom missing credentials", "custom"],
  ["themePublicError", "sessionUnavailable", "Custom public error", "custom"],
]) {
  scenarios[id] = {
    ...scenarios[source],
    name,
    theme,
    description:
      "Deployment branding from the production theme loader. Resource, session, and runtime states are simulated.",
  };
}
