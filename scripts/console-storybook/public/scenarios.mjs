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
  approvers: { agent: true, plugin: true, tools: true },
  toolDefaults: {
    enabled: true,
    approval: ["native", "prompt", "approve"],
    reviewer: ["human", "auto"],
  },
  tools: { enabled: true, approval: ["native", "prompt", "approve"], reviewer: [] },
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
    "App connection status is not verified. Catalog availability does not confirm linked credentials. In ChatGPT admin, select the same workspace as this PAT and enable plugin and app access for its user or service account. For service-account plugin credentials, open Service accounts, choose the account, and configure its app connections. Workspace administrator access is required. OCE policies do not grant access or configure credentials. Reload plugins after changes.",
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
      toolDefaults: { approval: "native", reviewer: "auto" },
      tools: {
        "app_calendar/create_event": { approval: "prompt" },
        "app_calendar/delete_event": { enabled: false },
      },
    },
  },
  null,
  2,
);
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
const devdayRepositorySelector = 'input[value="openclaw/openclaw-enterprise"]';
const createSlackBotSecret = [
  { selector: "#slack-secret-slack-bot-token", value: "__openclaw_create_secret__" },
  { selector: "#create-slack-secret-slack-bot-token-value", value: "simulated-bot-token" },
  click("Create Secret"),
];
const allowEveryoneInSlackChannels = [
  { selector: "#slack-allowed-user-ids", value: "" },
  { selector: "#slack-allow-everyone", click: true },
];
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
  { selector: "#slack-channel-ids", value: "CDEMO123" },
  ...allowEveryoneInSlackChannels,
  click("Apply channel settings"),
];
const devdayCreateCheckpoint = [
  click("Create Agent"),
  { selector: "#agent-preset", value: "pre_devday_codex" },
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
  { selector: 'select[aria-label="Create issue approval"]', value: "prompt" },
  click("Done"),
  { selector: devdayRepositorySelector, click: true },
  { selector: "#repository-profile-git-write", click: true },
  click("Edit Slack"),
  { selector: "#slack-allow-everyone", click: true },
  { selector: "#slack-allowed-user-ids", value: "UDEMO123" },
  { selector: "#slack-secret-slack-app-token", value: "sec_devday_slack_app_token" },
  { selector: "#slack-secret-slack-bot-token", value: "sec_devday_slack_bot_token" },
  click("Apply channel settings"),
  click("Create Agent"),
  { selector: '[id="workspace-AGENTS.md"]' },
];
const devdayAdminCheckpoint = [
  { selector: 'a[href*="agt_00000000-0000-4000-8000-000000000001"]', click: true },
  { selector: ".native-admin-access a.primary" },
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
  loginError: {
    group: "Pages/Sign in",
    name: "Invalid credentials",
    path: "/console/login",
    signedOut: true,
    rules: [{ path: "/api/auth/sign-in/email", status: 401 }],
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
    rules: [{ path: "/api/auth/sign-out", status: 503 }],
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
      "Return navigation and Refresh retain previously loaded content during slow reads. Responses are simulated; this story does not prove backend authorization or persistence.",
    steps: [
      "Wait for Agents, enter a search, open Create Agent, then return using the Agents breadcrumb. The loaded list and search remain visible while reads are pending.",
      "Visit Namespaces and Settings, then repeat with browser Back and Forward. First visits may load; returning pages retain their content.",
      "Open an Agent, visit its tabs, return to Agents, and use Back. Check the selected revision and tab. Refocus keeps the Agent detail mounted during access checks; Refresh rereads the page.",
      "Switch Namespace to confirm the previous scope's rows disappear. Reset the story to clear retained state.",
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
  agentsEmpty: {
    group: "Pages/Agents",
    name: "Empty",
    emptyAgents: true,
    description: "A ready Namespace with no Agents offers creation.",
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
      "OpenAI defaults to Codex. Choose the harness before entering its supported credential; execution mode follows the harness. No model is selected by default.",
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
    description: "The selected Secret enables discovery without entering a separate token.",
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
      "The actual form lists the first catalog page, places enableable plugins first, and retains unavailable entries with their reason. Selecting a plugin loads its tools before Add becomes available.",
    steps: [
      "Review the Driver's workspace access and service account setup guidance. Connection status is unverified; catalog availability does not confirm linked credentials. External help links open separately from plugin navigation.",
      "Compare the administrator, plan, and unsupported-runtime reasons in the list. Choose each unavailable plugin to see its reason and help link in detail; Add stays disabled.",
      "Available and Configured share a compact sidebar; page controls stay below the scrolling list. Next page and Previous page navigate server pages.",
      "Choose Calendar to load its tools and inspect their IDs beneath the titles, then Add Calendar. Configure its plugin defaults and expand a tool to override them.",
      "Type create into Filter tools: only Create event remains, and the caret stays after the text. Clear it to restore the other tools. Filter this page matches plugins on the current page.",
      "Click Done and expand Plugin selections JSON: one heading labels a bounded monospace editor. Replacing the dummy token or authentication method clears discovery results and preserves selections.",
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
      { selector: 'select[aria-label="Create event approval"]', value: "prompt" },
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
      click("Find approver for Default plugin approvers"),
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
      "Catalog pages use upstream cursors and contain up to 20 plugins. Driver setup guidance persists across pages. Filtering applies to the current page, and Previous page restores the prior catalog page.",
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
      "Filter this page for Documents, then clear the filter and choose Calendar.",
      "Click Add Calendar. Its tool defaults remain omitted until you change them.",
      "Choose the default tool availability, approval behavior, and reviewer, or keep the runtime defaults.",
      "Review the Driver-specific policy fields supplied by the capability descriptor.",
      "Expand Create event, change a tool setting, then click Done and inspect Plugin selections JSON.",
    ],
    gap: pluginPreviewGap,
  },
  pluginsSelected: {
    group: "Components/Plugins",
    name: "Selected plugin and tool overrides",
    component: "plugins",
    pluginCatalog,
    pluginCapabilities,
    pluginSelections,
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Calendar"]', click: true },
    ],
    description:
      "Calendar uses native approval and automatic review as its tool defaults, with explicit overrides for creating and deleting events. Tool reviewers inherit because this Driver advertises reviewer selection only at the default scope.",
    steps: [
      "Type create into Filter tools one character at a time; only Create event remains. Clear the search to restore the other tools.",
      "Compare Create event's ID beneath its title with its key in Plugin selections JSON after Done.",
      "Change Calendar's default reviewer to Human, click Done, and inspect toolDefaults.reviewer in Plugin selections JSON.",
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
          toolDefaults: { approval: "native", reviewer: "auto" },
          tools: { "app_calendar/create_event": { approval: "prompt", reviewer: "auto" } },
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
      toolDefaults: { enabled: true, approval: ["native", "approve"], reviewer: [] },
      tools: { enabled: true, approval: ["native", "approve"], reviewer: [] },
      driverPolicySchema: { type: "object", properties: {}, additionalProperties: false },
    },
    pluginSelections: JSON.stringify(
      {
        "occ-plugin:diffs": {
          enabled: true,
          toolDefaults: { approval: "prompt" },
        },
      },
      null,
      2,
    ),
    actions: [click("Configure plugins"), { selector: 'button[aria-label="Diffs"]', click: true }],
    description:
      "The simulated native Driver advertises native and approve. An existing prompt default remains visible as unsupported, while new choices use only advertised values.",
    steps: [
      "Inspect the saved prompt default and the visible unsupported-policy notice.",
      "Open the default approval control: new policies can use only the advertised choices.",
      "Change the unsupported default to Native behavior or inherit, then inspect the updated JSON.",
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
      { selector: "#slack-channel-ids", value: "CDEMO123" },
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
      { selector: "#slack-channel-ids", value: "CDEMO123" },
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
  createEmbedded: {
    group: "Pages/Create Agent",
    name: "OpenAI with OpenClaw harness",
    path: create,
    actions: [...form, { selector: "#agent-harness", value: "openclaw" }],
    description:
      "OpenClaw remains available for OpenAI with an API key. It uses Embedded execution and disables unsupported channel editing.",
  },
  createRepositoriesSelected: {
    group: "Pages/Create Agent",
    name: "Approved repositories and shared access",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: "#repository-application", click: true },
      { selector: "#repository-handbook", click: true },
      { selector: "#repository-profile-git-read", click: true },
    ],
    description:
      "Two approved repositories share Read-only access to code, issues, pull requests, and checks. The real form offers only their common levels and requires an explicit choice.",
    gap: "An operator supplies Namespace approvals, GitHub App configuration, credential service, compatible runtime images, and network policy. Repository grants do not change Harness filesystem or approval policy.",
  },
  createRepositoriesContributor: {
    group: "Pages/Create Agent",
    name: "Contributor access and write limits",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: "#repository-application", click: true },
      { selector: "#repository-profile-git-full", click: true },
      { selector: ".repository-customize summary", click: true },
      { selector: "#repository-issue-access", click: true },
    ],
    description:
      "Customize Contributor access to turn off issue management while keeping push and pull request access. The collapsed summary retains that restriction.",
  },
  createRepositoriesCollaborator: {
    group: "Pages/Create Agent",
    name: "Contributor access and write limits",
    path: create,
    actions: [
      ...repositoryForm,
      { selector: "#repository-application", click: true },
      { selector: "#repository-profile-git-full", click: true },
    ],
    description:
      "Contributor also creates and manages issues. GraphQL can permit merges and branch changes within the installation token grant; the Git push allowlist does not constrain GraphQL.",
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
      { selector: "#repository-application", click: true },
      { selector: "#repository-profile-git-full", click: true },
      { selector: ".repository-customize summary", click: true },
      { selector: "#repository-issue-access", click: true },
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
      "The shipped Preset asks for name, model, and a masked modelSecret password. No Namespace or Secret ID is needed.",
    steps: [
      "Enter a name, model ID, and a dummy model key.",
      "Use Preset and review the masked API key and restricted configuration.",
      "Create Agent saves a same-Namespace Secret before provisioning.",
    ],
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
      "Switching an unsaved service account form to OpenClaw clears the token and model, selects API-key authentication, and uses Embedded execution. Choose or create a simulated API key Secret to continue.",
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
  configurationEditor: {
    group: "Pages/Agent detail",
    name: "Edit Configuration",
    path: draft,
    actions: [click("Edit Configuration")],
    description:
      "Edit native JSON on the current draft. Save Configuration persists values; deployment remains a separate action.",
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
      "Review Calendar's saved policy. The catalog loads from the Agent's saved Service Accounts token.",
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
    pluginCapabilities,
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
    gap: "This is simulated UI and does not prove runtime approval authorization.",
  },
  pluginApproversOverrides: {
    group: "Pages/Agent detail",
    name: "Plugin and tool approver overrides",
    path: draft,
    slack: true,
    auth: "codex_pat",
    agentPlugins: pluginApproverOverrides,
    agentPluginApprovers: [{ channel: "slack", id: "team:TDEMO123:user:UDEMO123" }],
    pluginCapabilities,
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
      "Open Find approver for Create event tool approvers to choose between duplicate Alex Chen names by exact ID.",
    ],
    gap: "This is simulated UI and does not prove runtime approval authorization.",
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
    actions: [click("Plugins"), click("Find approver for Default plugin approvers")],
    description:
      "The selected bot Secret resolves names within Demo workspace. Duplicate Alex Chen results show their distinct user IDs; choosing one saves a team-qualified selector.",
    gap: "The fixture simulates directory data; it does not contact Slack or read a real Secret.",
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
      "Select Allowlist, clear Allowed DM user IDs, and save to inspect the validation error.",
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
      { selector: "#slack-channel-ids", value: "CNAVIGATION" },
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
      "Edit channels, users, mention requirement, and enabled state. Token references remain fixed; token values belong in Credentials.",
  },
  slackDirectoryChannels: {
    group: "Components/Channels",
    name: "Find Slack channels by name",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack"), click("Find Slack channel")],
    description:
      "The picker shows the bot's workspace, channel names and exact IDs. Next page reaches more channels. Selecting one appends only its ID to the editable channel list.",
    gap: "Directory data and Secret access are simulated; no Slack API call occurs.",
  },
  slackDirectorySavedNames: {
    group: "Components/Channels",
    name: "Saved Slack IDs show current names",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack")],
    description:
      "Saved channel and user IDs are resolved with the selected bot Secret when the editor opens. Names are only display labels; the exact IDs remain visible and are the only values saved.",
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
      "Existing workspace-qualified channel and user targets remain editable. Matching names appear beside their exact saved targets; the directory picker still inserts bare IDs.",
    gap: "Directory data and Secret access are simulated; no Slack API call occurs.",
  },
  slackDirectoryUsers: {
    group: "Components/Channels",
    name: "Resolve duplicate Slack people",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack"), click("Find allowed DM user")],
    description:
      "Two people share the same display name. Their handle and exact Slack user IDs identify which one will be saved.",
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
    actions: [click("Edit Slack"), click("Find Slack channel")],
    description:
      "A denied lookup keeps manual exact-ID entry available and explains Secret permissions.",
  },
  slackDirectoryLoading: {
    group: "Components/Channels",
    name: "Slack directory loading",
    path: `${draft}&tab=channels`,
    slack: true,
    rules: [{ suffix: "/channel-directory/lookup", method: "POST", bodyHasIds: false, hold: true }],
    actions: [click("Edit Slack"), click("Find Slack channel")],
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
    actions: [click("Edit Slack"), click("Find Slack channel")],
    description:
      "An older directory request is delayed. Search for platform before it returns; the late results must not replace the newer search.",
  },
  slackDirectoryMissingSecret: {
    group: "Components/Channels",
    name: "Slack directory needs a bot Secret",
    path: `${draft}&tab=channels`,
    slack: true,
    slackBindings: "app",
    actions: [click("Edit Slack"), click("Find Slack channel")],
    description: "The picker explains that a Slack bot token Secret must be selected first.",
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
      { selector: "#slack-channel-ids", value: "CDEMO123" },
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
      "Choose Research assistant, fill Variable: name, then Use Preset.",
      "Review the Configuration, masked pre-existing model Secret reference, and four seeded workspace files; click Create Agent.",
      "Wait for the simulated provisioning and deployment to finish; the Console opens Workspace files for the admitted revision.",
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
      "OpenAI starts with Codex and Dedicated execution. Select OpenClaw: execution becomes Embedded and the API key and selected model remain available.",
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
      { selector: "#slack-channel-ids", value: "CDEMO123" },
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
    devdayPreset: true,
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
      "The picker includes SWE Agent, Community Agent, Q&A Agent, and Oncall Agent. Select SWE Agent and enter devday claw for its name.",
      "Keep the default gpt-6-astra model and click Use Preset. Choose the existing DevDay Codex service account (simulated) Secret, or explicitly create a new simulated Secret. No credential is preselected. Review AGENTS.md: its opening sentence now says You are devday claw. Workspace defaults remain editable.",
      "Open Configure plugins. The simulated curated catalog is available for every Preset and Secret choice in this Storybook flow; add Linear, set Linear default reviewer to Automatic review, and set Create issue approval to Ask for approval.",
      "Repository access offers openclaw/openclaw-enterprise and openclaw/openclaw. Select either or both with Contributor access.",
      "Open Edit Slack. Confirm the four prefilled channels: oce-feedback (C0C49E7CS4A), oce-team (C0C43A2QA11), oce-feedback-test (C0C569NN9ME), and oce-team-test (C0C4A0JH2BG); mentions are not required. Allow simulated user UDEMO123, then bind the existing simulated DevDay Slack Secrets and apply settings.",
      "Create Agent and keep the Console visible while the fixture progresses through provisioning and deployment activation until Workspace files open for the admitted revision.",
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
    devdayPreset: true,
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
      "Auto-run checkpoint for reviewers who want the deployed end state of the DevDay create segment without replaying every presenter click.",
    steps: [
      "Use the primary DevDay segment 1 story for recording the manual presenter flow.",
      "This checkpoint clicks through the same controls, including the Linear plugin policy choices, and waits until Workspace files open for the admitted revision.",
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
      "Click Open native admin UI. The target fixture opens with an existing #openclaw-feedback message.",
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
      "Open Edit Slack, add CNEW123 to Slack channel IDs, then Save configuration.",
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
      "Open Edit Slack. Explicit channel user IDs disable the everyone checkbox.",
      "Clear Allowed channel user IDs. Allow everyone in these channels becomes available.",
      "Select Allow everyone in these channels and save the Configuration.",
      'Reopen Edit Slack. The drawer shows Allow everyone selected for the saved users: ["*"] channel setting.',
      "Turn everyone off to re-enable ID entry, then enter explicit IDs if you want to restrict channel senders before saving again.",
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
