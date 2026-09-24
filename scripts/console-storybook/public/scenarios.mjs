const draft =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=draft";
const revision =
  "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=rev_00000000-0000-4000-8000-000000000001";
const create = "/console/agents/new?namespace=ns_00000000-0000-4000-8000-000000000001";
const click = (text) => ({ click: text });
const form = [click("Start without Preset")];
const readyForm = [
  ...form,
  { selector: "#agent-name", value: "Research assistant" },
  { selector: "#provider-api-key", value: "storybook-model-api-key" },
  { selector: "#agent-model", value: "gpt-5.6-sol" },
];
const passwordPresetForm = [
  { selector: "#agent-preset", value: "pre_00000000-0000-4000-8000-000000000001" },
  { selector: "#preset-variable-name", value: "Codex assistant" },
  { selector: "#preset-variable-model", value: "gpt-5.1" },
  { selector: "#preset-variable-modelSecret", value: "storybook-model-key" },
  click("Use Preset"),
];
const repositoryForm = [...readyForm, { selector: "#agent-name", value: "Repository assistant" }];
const pluginCapabilities = {
  driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
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
const pluginDiscoveryForm = [
  ...form,
  { selector: "#agent-auth-method", value: "codex_pat" },
  { selector: "#provider-api-key", value: "at-storybook-pat" },
  click("Configure plugins"),
];
const pluginDiscoveryGap =
  "The real Create Agent controls call simulated OCC discovery routes with a dummy token. Catalog pages and policy capabilities are fixtures. This verifies UI discovery and draft JSON editing, not live plugin-service access or runtime enforcement.";
const repositoryOptionsPath =
  "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/repository-options";
const account = [{ selector: ".account-toggle", click: true }];
const createSlackBotSecret = [
  { selector: "#slack-secret-slack-bot-token", value: "__openclaw_create_secret__" },
  { selector: "#create-slack-bot-token-value", value: "simulated-bot-token" },
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
  { selector: "#provider-api-key", value: "storybook-model-api-key" },
  { selector: "#agent-model", value: "gpt-5.6-sol" },
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
  { selector: "#slack-secret-slack-app-token", value: "sec_demo_slack_app_token" },
  ...createSlackBotSecret,
  { selector: "#slack-channel-ids", value: "CDEMO123" },
  ...allowEveryoneInSlackChannels,
  click("Apply channel settings"),
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
    gap: "Stop Agent requests the stopped desired state; deployment resumes an Agent. Namespace provisioning, Preset management, and installed Provider setup require an API, CLI, or operator workflow. Serving health and model responses require separate runtime verification.",
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
      "At a narrow viewport, use Open navigation and choose a page; the drawer must close and return focus to the page.",
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
  providers: {
    group: "Pages/Providers",
    name: "Configured",
    path: "/console/providers",
    description: "Installation-wide Provider discovery.",
    gap: "This is a read-only page; configure Providers through installation configuration.",
  },
  providersEmpty: {
    group: "Pages/Providers",
    name: "Empty",
    path: "/console/providers",
    emptyProviders: true,
    description: "No Providers are configured.",
  },
  providersError: {
    group: "Pages/Providers",
    name: "Discovery unavailable",
    path: "/console/providers",
    rules: [{ path: "/providers", status: 503 }],
    description: "Provider discovery fails and can be retried.",
  },
  namespaces: {
    group: "Pages/Namespaces",
    name: "Ready and provisioning",
    path: "/console/namespaces",
    description: "Namespace identity and status cards. Selection is in the account menu.",
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
    name: "Plugin discovery needs an entered token",
    path: create,
    pluginCapabilities,
    actions: [...form, click("Configure plugins")],
    description:
      "Plugin discovery requires a newly entered service account token with the Codex harness. Existing plugin IDs and policies stay in Plugin selections JSON.",
    steps: [
      "Click Done, open Plugin selections JSON, and enter a known plugin ID and policy.",
      "Open Configure plugins and choose the configured plugin. Change a policy, click Done, and inspect the JSON.",
    ],
    gap: "API keys and saved Preset credentials do not enable this discovery flow. Enter only dummy credentials in Storybook.",
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
      "Choose Calendar to load its tools, then Add Calendar. Configure its plugin defaults and expand a tool to override them.",
      "Filter this page matches plugins on the current page; Filter tools matches the selected plugin’s tools.",
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
      "Change Calendar's default reviewer to Human, click Done, and inspect toolDefaults.reviewer in Plugin selections JSON.",
      "Choose inheritance to omit the reviewer field without changing default approval or tool overrides.",
      "Use a tool toggle to set enabled or disabled explicitly; Tool policy opens overrides and lets you restore inheritance. Tool reviewer selection is unavailable for this Driver.",
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
    ],
    description:
      "A new Agent can choose existing simulated Namespace Secrets or create new Slack token Secrets before the Agent resource exists.",
  },
  createSlackCreateSecretModal: {
    group: "Pages/Create Agent",
    name: "Create Slack Secret before Agent exists",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
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
      { selector: "#slack-secret-slack-app-token", value: "sec_demo_slack_app_token" },
      ...createSlackBotSecret,
      click("Apply channel settings"),
    ],
    description:
      "Applying channel settings retains staged Slack Secret bindings for creation. The raw Secret bindings JSON editor is hidden; token values stay masked.",
  },
  createSlackChannelAccessRequired: {
    group: "Pages/Create Agent",
    name: "Slack channel sender required",
    path: create,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Slack launch demo" },
      click("Configure Slack"),
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
      { selector: "#slack-channel-ids", value: "CDEMO123" },
      ...allowEveryoneInSlackChannels,
      click("Apply channel settings"),
    ],
    description:
      'The create drawer stores users: ["*"] on the selected channel while leaving direct-message allowFrom out of the new draft.',
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
    name: "Optional repository service unavailable",
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
      "The endpoint-specific optional-unavailability response permits an ordinary Agent. The preview does not establish real authorization.",
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
      "The password remains masked in the editable draft; Configuration JSON contains no model key. The raw Secret bindings JSON editor is hidden.",
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
      { selector: "#provider-api-key", value: "storybook-anthropic-key" },
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
      { selector: "#provider-api-key", value: "at-storybook-pat" },
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
      { selector: "#provider-api-key", value: "at-storybook-pat" },
      { selector: "#agent-model", value: "gpt-5.6-sol" },
      { selector: "#agent-harness", value: "openclaw" },
    ],
    description:
      "Switching an unsaved service account form to OpenClaw clears the token and model, selects API-key authentication, and uses Embedded execution. Enter a dummy API key to continue.",
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
    actions: [...readyForm, click("Create Agent")],
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/secrets",
        method: "POST",
        status: 403,
      },
    ],
    description:
      "A rejected Secret write keeps the form available and does not create a Configuration or Agent.",
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
    name: "New revision",
    path: draft,
    description:
      "Editable desired configuration, masked authentication summary, deployment gate, and Agent deletion.",
  },
  configurationEditor: {
    group: "Pages/Agent detail",
    name: "Edit Configuration",
    path: draft,
    actions: [click("Edit Configuration")],
    description:
      "Edit native JSON on the current draft. Save Configuration persists values; deployment remains a separate action.",
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
    name: "Admitted revision",
    path: revision,
    deployed: true,
    description:
      "Immutable Configuration snapshot, revision navigation, and persisted deployment status. This does not establish live serving health.",
  },
  repositoryDraft: {
    group: "Pages/Agent detail",
    name: "Repository access in new revision",
    path: draft,
    repositoryBindings: [
      { repositoryRef: "application", profile: "git-write" },
      { repositoryRef: "handbook", profile: "git-read" },
    ],
    description: "The new revision names Contributor and Read-only access and shows write limits.",
  },
  repositoryAdmitted: {
    group: "Pages/Agent detail",
    name: "Repository access in admitted revision",
    path: revision,
    deployed: true,
    repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    description:
      "The admitted snapshot names Contributor access and retains the write-limit notice. This fixture does not establish provider authorization or runtime execution.",
  },
  deploymentPending: {
    group: "Pages/Agent detail",
    name: "Deployment pending",
    path: revision,
    deployed: true,
    deploymentStatus: "queued",
    description: "An admitted revision with pending simulated worker progress.",
  },
  deploymentFailed: {
    group: "Pages/Agent detail",
    name: "Deployment failed",
    path: revision,
    deployed: true,
    deploymentStatus: "failed",
    description:
      "Persisted startup failure with runtime component, readiness check, and failure code.",
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
    actions: [click("Deploy new revision")],
    description: "A rejected deployment reports failure and re-enables the action.",
  },
  buildRevision: {
    group: "Components/Navigation",
    name: "OCC build revision",
    path: "/console/agents?debug=true",
    buildRevision: "abcdef1234567890abcdef1234567890abcdef12",
    description:
      "OCE branding with an adjacent eight-character OCC commit. Hover the version for the full hash. This revision is simulated.",
  },
  developmentBuild: {
    group: "Components/Navigation",
    name: "OCC development build",
    path: "/console/agents?debug=true",
    description:
      "OCE branding with an adjacent dev label when OCC build metadata is unavailable. No checkout or gateway revision is inferred.",
  },
  menu: {
    group: "Components/Navigation",
    name: "Account menu",
    actions: account,
    description:
      "Account, Namespace switching, Settings, and Logout. Keyboard navigation uses the production handlers.",
  },
  namespaceMenu: {
    group: "Components/Navigation",
    name: "Namespace switcher",
    actions: [...account, { selector: '[aria-controls="namespace-menu"]', click: true }],
    description: "Current Namespace and alternative scopes.",
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
  slackDrawer: {
    group: "Components/Channels",
    name: "Slack editor",
    path: `${draft}&tab=channels`,
    slack: true,
    actions: [click("Edit Slack")],
    description:
      "Edit channels, users, mention requirement, and enabled state. Token references remain fixed; token values belong in Credentials.",
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
      "Slack token references are menus backed by simulated same-Namespace Secret metadata. Options include readable existing Secrets and Create new Secret.",
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
      "Create new Secret opens a modal with the fixed Slack binding key and a password value field. Values are simulated and never read back.",
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
    description: "Admitted channel settings are immutable. Switch to the new revision to edit.",
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
    name: "Stored",
    path: `${draft}&tab=credentials`,
    description: "Masked Secret reference and stored generated-runtime credential metadata.",
  },
  credentialsMissing: {
    group: "Components/Credentials",
    name: "Missing generated credentials",
    path: `${draft}&tab=credentials`,
    transport: false,
    description:
      "Provision generated connection credentials before deployment. No values are returned to the console.",
  },
  credentialsSlack: {
    group: "Components/Credentials",
    name: "Slack tokens missing",
    path: `${draft}&tab=credentials`,
    slack: true,
    slackBindings: false,
    description:
      "Both Slack token slots are empty and required before a Slack-enabled draft can deploy.",
  },
  credentialsSlackStored: {
    group: "Components/Credentials",
    name: "Slack tokens stored",
    path: `${draft}&tab=credentials`,
    slack: true,
    description:
      "Synthetic masks show existing Secret bindings. The console does not retrieve stored token values.",
  },
  credentialsSlackReplacement: {
    group: "Components/Credentials",
    name: "Slack token replacement",
    path: `${draft}&tab=credentials`,
    slack: true,
    actions: [{ selector: "#runtime-slack-app-token", value: "xapp-replacement-preview" }],
    description:
      "Only fields with entered replacements are saved. Empty stored fields preserve their existing Secret binding.",
  },
  credentialsSlackPartial: {
    group: "Components/Credentials",
    name: "One Slack token missing",
    path: `${draft}&tab=credentials`,
    slack: true,
    slackBindings: "app",
    description:
      "The app token is already bound and masked; the missing bot token remains empty and required.",
  },
  credentialsLocked: {
    group: "Components/Credentials",
    name: "Generated credentials locked",
    path: `${draft}&tab=credentials`,
    deployed: true,
    description:
      "After the first revision, generated credentials cannot be regenerated here; channel Secrets remain separately editable.",
  },
  credentialsError: {
    group: "Components/Credentials",
    name: "Metadata unavailable",
    path: `${draft}&tab=credentials`,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/runtime-credentials",
        status: 503,
      },
    ],
    description: "Metadata failure disables dependent provisioning and deployment controls.",
  },
  authMissing: {
    group: "Components/Credentials",
    name: "No authentication source",
    path: `${draft}&tab=credentials`,
    auth: null,
    description: "Select a source before deployment.",
    gap: "The API-key field expects an existing Secret ID, not a raw model API key. Create that Secret outside this console.",
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
      "Use AgentRevision to inspect the immutable snapshot and Workspace files to inspect runtime files seeded during creation.",
    ],
    gap: "The fixture supplies a ready Namespace, Preset, and model Secret. Set those up outside the console. Verify actual serving health and a model response outside this walkthrough.",
  },
  createHarnessFlow: {
    group: "Flows",
    name: "Choose provider and harness",
    path: create,
    actions: readyForm,
    description:
      "Choose the provider first, then a compatible harness. The production form updates native Configuration and execution mode; credentials and deployment remain simulated.",
    steps: [
      "OpenAI starts with Codex and Dedicated execution. Select OpenClaw: execution becomes Embedded and the API key and selected model remain available.",
      "Select Anthropic: only OpenClaw is available, and the previous provider's credential and model are cleared. Enter a dummy API key and choose a listed model.",
      "Select OpenAI again: Codex is selected by default. Choose Service Accounts, enter a dummy token, and choose a listed model.",
      "Select OpenClaw: authentication changes to API key and the token and model are cleared. Enter a dummy API key and select a model to continue creation.",
    ],
    gap: "This walkthrough covers form state and the fixed model choices. Real API integration and runtime checks establish credential routing and model execution.",
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
  updateFlow: {
    group: "Flows",
    name: "Update an Agent",
    path: `${draft}&tab=channels`,
    deployed: true,
    slack: true,
    description:
      "Edit the new revision while an admitted revision remains unchanged; deploy a new immutable revision.",
    steps: [
      "Open Edit Slack, add CNEW123 to Slack channel IDs, then Save configuration.",
      "Select v1 in AgentRevision and open Channels: it still has the original settings.",
      "Return to New revision, then Deploy new revision.",
      "Refresh deployment and inspect the new revision. The prior snapshot remains readable.",
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
      "Return to New revision and Deploy new revision to request running again.",
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
