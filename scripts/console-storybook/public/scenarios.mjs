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
  { selector: "#harness-auth-method", value: "runtime" },
];
const account = [{ selector: ".account-toggle", click: true }];
const createWorkspaceFields = [
  ...form,
  { selector: "#agent-name", value: "Workspace seed demo" },
  { selector: "#harness-auth-method", value: "api_key" },
  { selector: "#harness-auth-secret", value: "sec_demo_model" },
  {
    selector: "#workspace-IDENTITY-md",
    value:
      "# IDENTITY.md - Who Am I?\n\n- **Name:** Demo Agent\n- **Creature:** Console familiar\n- **Vibe:** Calm and precise\n- **Emoji:** 🦀\n",
  },
  { selector: "#workspace-USER-md", value: "" },
];

// API failures are injected at the HTTP boundary. The console owns their presentation.
export const scenarios = {
  overview: {
    group: "Overview",
    name: "Console coverage",
    path: "/console/agents",
    description:
      "Browse pages, component states, and guided Agent workflows. Every preview mounts the production console modules and styles in its own frame. Reset story discards all local changes.",
    gap: "Stop Agent requests the stopped desired state; deployment resumes an Agent. Model-Secret creation, Namespace provisioning, Preset management, and Provider setup require an API, CLI, or operator workflow. Serving health and model responses require separate runtime verification.",
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
      "Searchable Agent table with draft and deployed Agents. Open an Agent to explore its tabs.",
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
    name: "Dedicated form",
    path: create,
    actions: form,
    description:
      "Name, execution mode, native JSON, authentication, Providers, plugins, Secret bindings, channel controls, and seeded workspace files.",
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
    name: "Embedded form",
    path: create,
    actions: [...form, { selector: "#execution-mode", value: "embedded" }],
    description:
      "Embedded execution uses its starter configuration and disables unsupported channel editing.",
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
  createNoPresets: {
    group: "Pages/Create Agent",
    name: "No Presets",
    path: create,
    emptyPresets: true,
    description: "Creation remains available without a Preset.",
  },
  createDiscoveryError: {
    group: "Pages/Create Agent",
    name: "Optional discovery denied",
    path: create,
    actions: form,
    rules: [
      { path: "/providers", status: 403 },
      { path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/service-accounts", status: 403 },
    ],
    description: "Unavailable Provider and service-account lists do not hide the Agent form.",
  },
  createInvalid: {
    group: "Pages/Create Agent",
    name: "Invalid JSON",
    path: create,
    actions: [
      ...readyForm,
      { selector: "#configuration-json", value: "[]" },
      click("Create Agent"),
    ],
    description: "Client validation rejects a non-object Configuration before saving.",
  },
  createConflict: {
    group: "Pages/Create Agent",
    name: "Partial save and conflict",
    path: create,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents",
        method: "POST",
        status: 409,
        once: true,
      },
    ],
    actions: [...readyForm, click("Create Agent")],
    description:
      "Configuration saves but Agent creation conflicts. Edit the name and retry; the form reuses the saved Configuration.",
  },
  createUnknown: {
    group: "Pages/Create Agent",
    name: "Save outcome unknown",
    path: create,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents",
        method: "POST",
        status: 503,
      },
    ],
    actions: [...readyForm, click("Create Agent")],
    description:
      "An uncertain write outcome disables unsafe repeat submission. Refresh and inspect saved state.",
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
    mobile: true,
    actions: [click("Open navigation")],
    description: "390px viewport with the navigation drawer open. Escape or the overlay closes it.",
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
  slackOpen: {
    group: "Components/Channels",
    name: "Slack open policy",
    path: `${draft}&tab=channels`,
    slack: true,
    slackPolicy: "open",
    actions: [click("Edit Slack")],
    description: "Editing preserves the existing open policy and wildcard allowFrom entry.",
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
      "Interactive walkthrough from Preset selection through draft creation, credential provisioning, workspace defaults, and deployment admission. Worker progress is simulated; it is not a live deployment.",
    steps: [
      "Choose Research assistant, fill Variable: name, then Use Preset.",
      "Review the Configuration, masked pre-existing model Secret reference, and four seeded workspace files; click Create Agent.",
      "Open Credentials and Provision generated runtime credentials.",
      "Click Deploy new revision. Inspect Deployment status and Refresh deployment to advance the simulated worker, then Refresh the page to read the active revision.",
      "Use AgentRevision to inspect the immutable snapshot and Workspace files to inspect runtime files seeded during creation.",
    ],
    gap: "The fixture supplies a ready Namespace, Preset, and model Secret. Set those up outside the console. Verify actual serving health and a model response outside this walkthrough.",
  },
  createWorkspaceFlow: {
    group: "Flows",
    name: "Create with workspace files",
    path: create,
    emptyAgents: true,
    transport: false,
    description:
      "Create an Agent from the no-Preset form after editing IDENTITY.md and clearing USER.md, then deploy and inspect the seeded runtime workspace files.",
    steps: [
      "Start without Preset, enter a demo Agent name, choose OpenAI API key, and enter the existing fixture Secret ID sec_demo_model.",
      "Review AGENTS.md, SOUL.md, IDENTITY.md, and USER.md. Edit IDENTITY.md, leave USER.md empty, and create the Agent.",
      "Provision generated runtime credentials, then Deploy new revision and Refresh deployment until the simulated worker succeeds. Use the page Refresh button to read the active revision.",
      "Open Workspace files and inspect IDENTITY.md or USER.md to confirm the fixture carried the creation-time file contents into the deployed workspace.",
    ],
    gap: "This Storybook flow proves the UI request body and fixture readback path. It does not prove real gateway filesystem writes or serving health.",
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
