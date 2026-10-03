const draft =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=draft";
const revision =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=rev_00000000-0000-4000-8000-000000000001";
const currentVersion =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=rev_00000000-0000-4000-8000-000000000006";
const candidateVersion =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=rev_00000000-0000-4000-8000-000000000007";
const create = "/console/agents/new?namespace=ns_00000000-0000-4000-8000-000000000001";
const click = (text) => ({ click: text });
const form = [click("Start without Preset")];
const oauthForm = [...form, { selector: "#agent-auth-method", value: "oauth" }];
const startOAuthLogin = [...oauthForm, click("Sign in with OAuth")];
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
  { selector: ".native-admin-access a.primary" },
];

const shareExistingPerson = [
  { selector: "#share-principal-id", value: "prn_00000000-0000-4000-8000-000000000003" },
  { selector: ".agent-access-consent input", click: true },
  click("Share Agent"),
];

// Page failures use the HTTP boundary; isolated component previews receive their input state.
export const scenarios = {
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
    description:
      "The email and password form. Any nonempty demo email/password signs into this fixture.",
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
      click("Login"),
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
      click("Login"),
    ],
    description: "A rejected sign-in leaves the form available for retry.",
  },
  expired: {
    group: "Pages/Sign in",
    name: "Session expired",
    path: draft,
    signedOut: true,
    description:
      "A protected deep link with no session redirects to sign-in and retains the return destination.",
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
      "A pending session read. The real client times out after 15 seconds; reset to replay loading.",
  },
  logoutFailure: {
    group: "Pages/Sign in",
    name: "Logout unconfirmed",
    rules: [{ path: "/api/auth/sign-out", method: "POST", status: 503 }],
    actions: [...account, click("Logout")],
    description:
      "Failed logout with a still-active session hides private content until revocation can be confirmed.",
  },
  agents: {
    group: "Pages/Agents",
    name: "Populated",
    description:
      "Searchable Agent table with draft and deployed Agents. Open an Agent to explore its tabs. The shared shell, table, and controls use the Claw palette and typography.",
    steps: [
      "Check text, search input, buttons, and the current navigation item. The console stays light with either system appearance preference.",
      "Tab through the search and creation controls, then search for an Agent and open its detail page.",
      "Open Namespaces and return to Agents; the sidebar stays mounted while the destination data loads.",
      "At a narrow viewport, use Open navigation and choose a page; the drawer must close and return focus to the page.",
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
      "Returning to unchanged pages and Agent tabs preserves loaded controls, expanded panels, and edits. Access is rechecked before page controls become active. Refresh explicitly reloads. Simulated API; no backend persistence proof.",
    steps: [
      "Wait for Agents, enter a search, open Create Agent, then return using the Agents breadcrumb. The loaded list and search remain visible while reads are pending.",
      "Visit Namespaces and Settings, then repeat with browser Back and Forward. First visits may load; returning pages retain their content.",
      "Open an Agent and expand Native configuration. Visit Credentials and Workspace files, then return to Configuration: the disclosure stays expanded. Return to Agents and use Back: native admin access and the selected tab stay loaded through access checks. Refresh explicitly rereads the page.",
      "Switch Namespace to confirm the previous scope's rows disappear. Reset the story to clear retained state.",
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
      "Wait for OpenClaw, then open Credentials and return to Configuration. The access result remains visible.",
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
    rules: [{ path: "/api/auth/session", skip: 1, delayMs: 1200, status: 401 }],
    description:
      "Session expiry clears private content and retained navigation state. The fixture supplies a delayed unauthorized response.",
    steps: [
      "Wait for Agents, then select Refresh or navigate to Namespaces.",
      "When the session check fails, confirm the sign-in form replaces all private content. Browser Back must not restore the collection.",
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
    gap: "Provisioning a Namespace and granting access happen outside the console.",
  },
  namespaceMissing: {
    group: "Pages/Agents",
    name: "Namespace unavailable",
    path: "/console/agents?namespace=ns_missing",
    description: "A stale Namespace link asks the reader to switch scope.",
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
  namespaces: {
    group: "Pages/Namespaces",
    name: "Ready and provisioning",
    path: "/console/namespaces",
    description:
      "Installation-wide Namespace identity and status cards, without a Namespace selector.",
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
    description: "No accessible Namespaces. Provisioning and IAM are external prerequisites.",
  },
  namespacesDenied: {
    group: "Pages/Namespaces",
    name: "Access denied",
    path: "/console/namespaces",
    rules: [{ path: "/namespaces", status: 403 }],
    description: "Namespace discovery is denied.",
  },
  settings: {
    group: "Pages/Settings",
    name: "Account",
    path: "/console/settings",
    description: "Signed-in name and email. There are no editable settings in this release.",
  },
  notFound: {
    group: "Pages/Navigation",
    name: "Page not found",
    path: "/console/missing",
    description: "An unknown console route offers a return to Agents.",
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
      "OpenAI defaults to Codex with Dedicated execution. Selecting OpenClaw starts in Embedded mode; supported Installations also offer Dedicated under Runtime details. No model is selected by default.",
    steps: [
      "Keep OpenAI and the Codex harness, enter a dummy API key, and select a listed model.",
      'In Configuration JSON, edit plugins.entries.codex.config.appServer: set sandbox to "workspace-write", approvalPolicy to "never", and remoteWorkspaceRoot to "/workspace/custom".',
      "Change the model, then replace the dummy credential. Confirm the selected model remains. Confirm all three edited appServer settings remain in Configuration JSON.",
      "Choose Reset template and confirm to restore the standard runtime settings for the selected model.",
    ],
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
      "Review the Driver's workspace access and service account setup guidance. Connection status is unverified; catalog availability does not confirm linked credentials. External help links open separately from plugin navigation.",
      "Open the information button beside each unavailable plugin to compare its administrator, plan, or unsupported-runtime reason and help link. Escape or a click outside dismisses the popover. Choose the plugin row to see the same guidance in detail; Add stays disabled.",
      "Available and Configured share a compact sidebar; page controls stay below the scrolling list. Next page and Previous page navigate server pages.",
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
      { selector: '[aria-label="Default plugin approvers people"]', focus: true },
    ],
    description:
      "New Agents inherit OpenClaw's existing approval routing until an operator selects a default. The directory explains that a Slack bot Secret must be selected under Channels before names can be resolved.",
    gap: "The fixture does not prove Secret permissions or OpenClaw approval enforcement.",
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
      "The component explains that discovery requires an entered service account token with the Codex harness.",
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
    name: "Created Agent with pending deployment",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "queued",
    description:
      "Creation opens Agent details after provisioning completes, while the first deployment remains queued.",
    steps: [
      "Click Create Agent and wait for Agent details to open.",
      "Inspect Deployment activity: the recorded status remains queued, and no version is selected.",
      "Click Refresh deployment. The simulated deployment stays queued; the create form does not reopen.",
    ],
  },
  createDeploymentFailed: {
    group: "Pages/Create Agent",
    name: "Created Agent with failed deployment",
    path: create,
    actions: readyForm,
    provisionedDeploymentStatus: "failed",
    description:
      "A first-deployment failure appears on Agent details after successful provisioning, without trapping creation on the form.",
    steps: [
      "Click Create Agent and wait for Agent details to open.",
      "Inspect the failed Deployment activity and its reconciliation error.",
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
  createDedicatedOpenclaw: {
    group: "Pages/Create Agent",
    name: "OpenAI with dedicated OpenClaw",
    path: create,
    nativeWorkerSupport: "custom-image",
    actions: [
      ...readyForm,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
      { selector: "#execution-mode", value: "dedicated" },
    ],
    description:
      "Experimental Dedicated OpenClaw uses the same Agent creation form as Codex. The simulated Installation declares custom-image native worker support. A model and dummy API-key Secret are selected; channel controls remain available.",
    steps: [
      "Confirm the Harness is OpenClaw and Execution mode is Dedicated.",
      "Open the Slack editor, then cancel it. Channel controls remain available for dedicated OpenClaw.",
      "Select Embedded, then return to Dedicated. Confirm the Harness remains OpenClaw.",
      "Create the Agent and follow simulated provisioning to Agent details. Open Configuration and confirm the snapshot shows Dedicated execution and the OpenClaw Harness.",
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
      "Retry repository choices, or save a draft without repositories.",
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
  createPreset: {
    group: "Pages/Create Agent",
    name: "Preset variables",
    path: create,
    actions: [{ selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" }],
    description:
      "A reusable template with required and defaulted variables. Use Preset copies values into an editable draft.",
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
  createNoPresets: {
    group: "Pages/Create Agent",
    name: "No Presets",
    path: create,
    emptyPresets: true,
    description: "Creation remains available without a Preset.",
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
      "Anthropic offers only the OpenClaw harness, with Embedded execution. Its fixed model list is available before credential entry and starts without a selection.",
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
      "Experimental first-deploy login for a dedicated Codex Agent. The limitations notice stays visible throughout login and recovery. The model picker remains available; credentials never enter the browser.",
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
      "The fixture completes login after one poll. Configure plugins uses the server-owned login reference. No access or refresh token appears in this preview.",
    steps: [
      "Wait for ChatGPT login ready, then open Configure plugins and add Calendar.",
      "Choose a model and create the Agent. Deployment is simulated; the runtime token handoff is not proved here.",
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
    name: "Separate ChatGPT login for plugin editing (Experimental)",
    path: `${draft}&tab=plugins`,
    deployed: true,
    auth: "oauth",
    agentPlugins: JSON.parse(pluginSelections),
    pluginCapabilities,
    pluginDiscovery,
    actions: [click("Sign in with OAuth")],
    description:
      "A separate configuration login enables plugin browsing while the deployed Agent retains its own credential. Saving plugin selections never replaces authentication.",
  },
  authOAuthReconnect: {
    group: "Components/Credentials",
    name: "Explicit ChatGPT credential replacement (Experimental)",
    path: `${draft}&tab=credentials`,
    deployed: true,
    auth: "oauth",
    actions: [click("Sign in with OAuth")],
    description:
      "The current Agent login is preserved by default. A completed new login only replaces the saved source when Save authentication source is chosen; deployment remains separate.",
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
        once: true,
      },
    ],
    actions: [...readyForm, click("Create Agent")],
    description:
      "Provisioning admission conflicts before any separate Configuration save. Edit the request and retry from the same draft.",
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
    actions: [
      click("Edit Configuration"),
      { selector: "#configuration-json", value: '{"unfinished":' },
    ],
    description:
      "Unfinished JSON survives tabs, pages, and browser history. Unsaved edits continue to block deployment.",
    steps: [
      "Visit Channels, then Configuration and confirm the unfinished text remains.",
      "Open Namespaces and return with Back. Cancel discards the edit without saving.",
    ],
    gap: "Simulated UI proof; no deployment or real persistence.",
  },
  agentSharing: {
    group: "Pages/Agent detail",
    name: "Share an Agent",
    path: draft,
    description:
      "Choose any configured OpenClaw role for an existing person. The selected role controls native permissions.",
    steps: [
      "Enter prn_00000000-0000-4000-8000-000000000003 as the existing Principal ID.",
      "Choose an OpenClaw role, review its permissions, acknowledge shared access, and share.",
      "Remove the direct binding; Namespace discovery remains available.",
    ],
  },
  agentSharingGranted: {
    group: "Pages/Agent detail",
    name: "Agent shared",
    path: draft,
    actions: shareExistingPerson,
    description:
      "Namespace discovery and the selected Agent grant are present. Removing the runtime assignment revokes OpenClaw entry; other grants may still provide OCE management access.",
  },
  agentSharingRemoved: {
    group: "Pages/Agent detail",
    name: "Direct Agent grant removed",
    path: draft,
    actions: [...shareExistingPerson, click("Remove binding")],
    description:
      "The selected direct Agent binding was removed. Namespace discovery and unrelated grants are preserved.",
  },
  agentSharingRoleChanged: {
    group: "Pages/Agent detail",
    name: "Change OpenClaw role",
    path: draft,
    actions: [
      ...shareExistingPerson,
      { selector: ".agent-access-grant select", value: "reviewer" },
    ],
    description:
      "Change the selected role and inspect the success feedback. This simulated preview does not verify backend atomicity or native connection closure.",
  },
  agentSharingRolesUnavailable: {
    group: "Pages/Agent detail",
    name: "OpenClaw roles unavailable",
    path: draft,
    runtimeRolesUnavailable: true,
    sharingRoles: [
      {
        id: "role-demo-entry",
        namespaceId: "ns_00000000-0000-4000-8000-000000000001",
        permissions: [
          { action: "read", resourceKind: "agent" },
          { action: "use", resourceKind: "agent" },
        ],
      },
    ],
    sharingBindings: [
      {
        id: "binding-demo-entry",
        namespaceId: "ns_00000000-0000-4000-8000-000000000001",
        subjectKind: "identity",
        subjectId: "prn_00000000-0000-4000-8000-000000000003",
        roleId: "role-demo-entry",
        resourceKind: "agent",
        resourceId: "agt_00000000-0000-4000-8000-000000000001",
        runtimeRole: "reviewer",
      },
    ],
    description:
      "Sharing remains disabled while the deployed role catalog is unavailable; existing assignments can be removed.",
  },
  agentSharingDenied: {
    group: "Pages/Agent detail",
    name: "Sharing administration denied",
    path: draft,
    rules: [{ suffix: "/iam/roles", status: 403 }],
    description:
      "An Agent's other controls retain their own permissions when sharing administration is unavailable.",
  },
  agentSharingUnknown: {
    group: "Pages/Agent detail",
    name: "Sharing outcome uncertain",
    path: draft,
    actions: shareExistingPerson,
    rules: [{ suffix: "/iam/access-bindings", method: "POST", status: 503, once: true }],
    description:
      "A failed mutation response leaves the outcome uncertain. Refresh current policy before explicitly retrying; no automatic replay occurs.",
  },
  configurationEditor: {
    group: "Pages/Agent detail",
    name: "Edit Configuration",
    path: draft,
    actions: [click("Edit Configuration")],
    description:
      "Edit native JSON on the current draft. Save Configuration persists values; deployment remains a separate action.",
  },
  gatewayPasswordAccess: {
    group: "Pages/Agent detail",
    name: "Enable Gateway password access",
    path: draft,
    deployed: true,
    description: "Configure the generated Gateway password without typing native JSON.",
    steps: [
      "Select Enable Gateway password access. The draft receives a password reference; no password value is displayed.",
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
    actions: [click("Enable Gateway password access"), click("Save Configuration")],
    rules: [
      {
        method: "PATCH",
        suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
        status: 403,
      },
    ],
    description: "A denied save retains the draft and does not change the saved Configuration.",
  },
  gatewayPasswordSaving: {
    group: "Pages/Agent detail",
    name: "Gateway password save in progress",
    path: draft,
    actions: [click("Enable Gateway password access"), click("Save Configuration")],
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
      "In Configure plugins, change Calendar's tool policy, add Documents from the next page, and select Done.",
      "Select Save plugin selections, then Deploy new version. Compare the new version with the earlier immutable plugin snapshot.",
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
      "Search Create event tool approvers people to choose between duplicate Alex Chen names by exact ID.",
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
      "The selected bot Secret resolves names within Demo workspace. The open Alex search keeps its results on browser refocus; choosing one saves a team-qualified selector.",
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
      { selector: ".slack-directory-panel:not([hidden]) .error:not(:empty)" },
      click("Add UDEMO123"),
      click("Save plugin selections"),
      { selector: '.content [aria-live="polite"][aria-busy="false"]' },
    ],
    description:
      "When the API reports channel directory lookup as unavailable, the approver field still accepts a raw Slack user ID and saves it on the draft Agent.",
    steps: [
      "Confirm the directory error explains that exact IDs can still be entered.",
      "Review the saved default plugin approver chip: UDEMO123 remains visible because names could not be resolved.",
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
    description: "Invalid JSON retains editor contents and sends no Configuration write.",
  },
  admitted: {
    group: "Pages/Agent detail",
    name: "Current version",
    path: revision,
    deployed: true,
    description:
      "The selected immutable version has recorded deployment success. It is not proof of current live serving health.",
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
      "v7 is admitted and queued without a live worker claim. v6 remains selected; serving is unverified.",
  },
  deploymentRunning: {
    group: "Pages/Agent detail",
    name: "New version in progress",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "running",
    description:
      "A worker holds the v7 deployment claim while v6 remains selected. The API does not expose finer runtime stages.",
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
  deploymentFailed: {
    group: "Pages/Agent detail",
    name: "New version failed",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    description:
      "v7 failed before activation; v6 remains selected. The record includes bounded startup failure evidence.",
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
  deploymentSucceeded: {
    group: "Pages/Agent detail",
    name: "New version activated",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    description:
      "v7 is now selected and its original deployment recorded success. This remains historical evidence, not a live probe.",
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
    actions: [click("Run diagnostics for this version")],
    description:
      "An on-demand observation for viewed v7 reports timestamped Slack configuration, authentication, and connectivity checks. It does not change v7's persisted deployment result.",
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
        code: "DEPENDENCY_UNAVAILABLE",
      },
    ],
    actions: [click("Run diagnostics for this version")],
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
    description: "A rejected deployment reports failure and re-enables the action.",
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
      "Approved OpenClaw mech mascot beside OCE and an eight-character OCC commit. Check the mascot at desktop and mobile widths, then hover the version for the full hash. This revision is simulated.",
  },
  developmentBuild: {
    group: "Components/Navigation",
    name: "OCC development build",
    path: "/console/agents?debug=true",
    description:
      "Approved OpenClaw mech mascot beside OCE with an adjacent dev label when OCC build metadata is unavailable. No checkout or gateway revision is inferred.",
  },
  menu: {
    group: "Components/Navigation",
    name: "Account menu",
    actions: account,
    description:
      "Account Settings and Logout. Namespace selection is available directly in the page header.",
  },
  namespaceMenu: {
    group: "Components/Navigation",
    name: "Namespace switcher",
    description: "The header selector shows the current Namespace and readable alternatives.",
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
      "Check that the long Namespace name truncates before the inset chevron.",
      "Choose Research, then return to the long Namespace and check the selection.",
    ],
  },
  mobile: {
    group: "Components/Navigation",
    name: "Mobile drawer",
    buildRevision: "abcdef1234567890abcdef1234567890abcdef12",
    mobile: true,
    actions: [{ selector: '.content [aria-busy="false"]' }, click("Open navigation")],
    description:
      "390px viewport with the simulated OCC revision beside OCE in the open drawer. Escape or the overlay closes it.",
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
      },
    ],
    actions: [click("Edit Slack"), click("Save configuration")],
    description: "A rejected Configuration write keeps the drawer and feedback visible.",
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
      "The app token binding is staged to a different Secret while the bot token binding remains unchanged.",
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
      "A saved Secret reference remains visible when the follow-up exact Secret access grant is denied.",
  },
  credentialsSavePending: {
    group: "Components/Credentials",
    name: "Channel Secret save pending",
    path: `${draft}&tab=credentials`,
    slack: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets/sec_demo_slack_app_token",
        method: "PATCH",
        hold: true,
      },
    ],
    actions: [
      { selector: "#runtime-slack-app-token", value: "simulated-token" },
      click("Save channel Secrets"),
    ],
    description:
      "A pending Secret save disables deployment. The real client times out after 15 seconds; reset the story to replay it.",
  },
  credentialsSaveUnknown: {
    group: "Components/Credentials",
    name: "Channel Secret save outcome unknown",
    path: `${draft}&tab=credentials`,
    slack: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets/sec_demo_slack_app_token",
        method: "PATCH",
        status: 503,
        once: true,
      },
    ],
    actions: [{ selector: "#runtime-slack-app-token", value: "simulated-token" }],
    description:
      "Save the simulated replacement to see an uncertain Secret save. Reload the draft and inspect saved state before deploying or retrying.",
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
      "The refreshed form retains Service Accounts; the request log shows the Agent PATCH followed by exact Secret access creation.",
    ],
  },
  authSecretGrantDenied: {
    group: "Components/Credentials",
    name: "Authentication saved, grant denied",
    path: `${draft}&tab=credentials`,
    rules: [{ suffix: "/iam/access-bindings", method: "POST", status: 403, once: true }],
    actions: [click("Save authentication source")],
    description:
      "The Agent binding is saved, but granting its Secret access is denied. Deployment stays blocked in this view until access is confirmed.",
    steps: [
      "Read the partial-save message and disabled authentication controls.",
      "Click Retry credential access. This fixture permits the next grant to simulate an administrator restoring authority.",
      "The form refreshes without another Agent PATCH.",
    ],
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
    description: "Select an existing issued service account.",
    gap: "Service-account issuance is outside the console.",
  },
  nativeAdmin: {
    group: "Components/Native admin",
    name: "Available",
    path: revision,
    deployed: true,
    nativeAdmin: "available",
    description:
      "Authorized launch link and warning. The fixture opens an explanatory page instead of a real gateway.",
  },
  nativeReadError: {
    group: "Components/Native admin",
    name: "Status read failure",
    path: revision,
    deployed: true,
    nativeAdmin: "available",
    rules: [{ suffix: "/native-admin", method: "GET", status: 503, once: true }],
    description: "A failed access read keeps its error and Refresh access visible.",
    steps: [
      "Confirm the OpenClaw card shows Service unavailable and no launch link.",
      "Click Refresh access. The error clears and Open OpenClaw becomes available.",
    ],
    gap: "Simulated status recovery; deployment-triggered refresh is covered by the Console browser integration.",
  },
  nativeReadRecovery: {
    group: "Components/Native admin",
    name: "Recovery on Back",
    path: revision,
    deployed: true,
    nativeAdmin: "available",
    rules: [{ suffix: "/native-admin", method: "GET", status: 503, once: true }],
    description: "Back rechecks a failed access read and replaces the error after recovery.",
    steps: [
      "Confirm the OpenClaw card shows Service unavailable and no launch link.",
      "Open Namespaces, then use Back. The error clears and Open OpenClaw becomes available.",
    ],
    gap: "Simulated status recovery; the browser integration uses the real role catalog after its outage ends.",
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
    rules: [{ suffix: "/native-admin", method: "GET", status: 403 }],
    description:
      "A person without an OpenClaw assignment can retain their Agent page while access is denied.",
    steps: [
      "Confirm the OpenClaw card is hidden.",
      "Open Namespaces, then use Back. The cached Agent page returns with OpenClaw still hidden.",
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
  workspaceMissing: {
    group: "Components/Workspace",
    name: "Missing file",
    path: `${revision}&tab=workspace`,
    deployed: true,
    rules: [{ suffix: "/AGENTS.md", method: "GET", status: 404, once: true }],
    description: "A missing file can be created; unrelated file editors still load.",
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
      "An uncertain write blocks retry until Reload lets the reader inspect current content.",
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
    description:
      "Pending cleanup removes editing and deployment controls. Refresh deletion status checks completion.",
  },
  deletionDenied: {
    group: "Components/Deletion",
    name: "Permission denied",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "DELETE",
        status: 403,
      },
    ],
    actions: [click("Delete Agent"), click("Permanently delete Agent")],
    description:
      "A denied deletion leaves the Agent available and explains the missing permission.",
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
      "The request may have started cleanup. Refresh status instead of submitting again.",
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
      "OpenAI starts with Codex and Dedicated execution. Select OpenClaw: Embedded is selected and channel controls are disabled. Dedicated requires an Installation with native worker support; the separate Dedicated OpenClaw stories simulate that prerequisite.",
      "Select Anthropic: only OpenClaw is available, and the previous provider's credential and model are cleared. Enter a dummy API key and choose a listed model.",
      "Select OpenAI again: Codex is selected by default. Choose Service Accounts, enter a dummy token, and choose a listed model.",
      "Select OpenClaw: authentication changes to API key and the token and model are cleared. Enter a dummy API key and select a model to continue creation.",
    ],
    gap: "This walkthrough covers form state and the fixed model choices. Real API integration and runtime checks establish credential routing and model execution.",
  },
  createExitFlow: {
    group: "Flows",
    name: "Restart Agent creation",
    path: create,
    description: "Leave a no-Preset Agent form and return to the initial creation choices.",
    steps: [
      "Choose Start without Preset and enter an Agent name.",
      "Select Cancel or the Agents link, then choose Create Agent again.",
      "Confirm the initial choices are shown. Start without Preset again and check that the name is empty.",
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
      "Create a Dedicated Agent from the no-Preset form after editing IDENTITY.md and clearing USER.md, then inspect the seeded workspace after simulated provisioning.",
    steps: [
      "Start without Preset, enter a demo Agent name, keep OpenAI with the Codex harness, enter a dummy API key or service account token, and choose a listed model or enter a model ID manually.",
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
      "Start without Preset and enter the Agent name.",
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
      "Click Open OpenClaw. The target fixture opens with an existing #openclaw-feedback message.",
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
  stopConfirm: {
    group: "Components/Stop Agent",
    name: "Confirmation",
    path: revision,
    deployed: true,
    actions: [click("Stop Agent")],
    description: "Confirm stopping the Agent or cancel without changing its requested state.",
  },
  stopRequested: {
    group: "Components/Stop Agent",
    name: "Stop requested",
    path: revision,
    deployed: true,
    stopped: true,
    description:
      "The requested state is stopped. Deployment resumes the Agent; shutdown completion is not exposed here.",
  },
  stopDenied: {
    group: "Components/Stop Agent",
    name: "Permission denied",
    path: revision,
    deployed: true,
    rules: [{ suffix: "/stop", method: "POST", status: 403 }],
    actions: [click("Stop Agent"), { selector: ".agent-stop-dialog button.danger", click: true }],
    description:
      "An authorization denial keeps the Agent running and explains the required access.",
  },
  stopUnknown: {
    group: "Components/Stop Agent",
    name: "Outcome unknown",
    path: revision,
    deployed: true,
    rules: [{ suffix: "/stop", method: "POST", status: 503, once: true }],
    actions: [click("Stop Agent"), { selector: ".agent-stop-dialog button.danger", click: true }],
    description:
      "An uncertain stop response requires a status refresh before another stop request.",
  },
  stopFlow: {
    group: "Flows",
    name: "Stop an Agent",
    path: revision,
    deployed: true,
    description:
      "Open the Stop Agent confirmation and request the stopped desired state while preserving draft, revisions, credentials, and workspace data.",
    steps: [
      "Open Stop Agent and review the confirmation copy.",
      "Confirm Stop Agent. The page reports Stop requested and keeps revision/workspace inspection available.",
      "Return to Create new version and Deploy new version to request running again.",
    ],
    gap: "Stop Agent confirms OCC accepted the stopped desired state and selected revision metadata only. Verify live gateway shutdown outside Console if required. Disabling a channel does not stop the Agent; deletion is destructive.",
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
      "The page enters Deletion in progress and removes edit/deploy controls.",
      "Click Refresh deletion status. The fixture now reports completion and the console returns to the Agent list.",
    ],
    gap: "The console reports deletion status but provides no detailed cleanup-progress view. Configurations and Secrets remain Namespace-owned and need separate management.",
  },
};
