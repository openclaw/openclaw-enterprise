import {
  credentialsOAuthScenarios,
  credentialsScenarios,
  credentialsRecoveryScenarios,
  credentialsThemeScenario,
} from "./scenario-groups/credentials.mts";
import { pluginsScenarios, pluginApproverScenarios } from "./scenario-groups/plugins.mts";
import { channelsScenarios } from "./scenario-groups/channels.mts";
import {
  createAgentFormScenarios,
  createAgentProvisioningScenarios,
  createAgentOutcomeScenarios,
} from "./scenario-groups/create-agent.mts";
import {
  allowEveryoneInSlackChannels,
  click,
  create,
  createSlackBotSecret,
  presetSecretsPath,
  readyForm,
} from "./create-agent-form-data.mts";
import {
  calendarPlugin,
  pluginCapabilities,
  pluginDiscovery,
  pluginSelections,
  pluginSelectionState,
  pluginSetup,
  pluginToolRefusal,
} from "./plugin-scenario-data.mts";
import { namespacesScenarios } from "./scenario-groups/namespaces.mts";
import { secretsScenarios } from "./scenario-groups/secrets.mts";
import { settingsScenarios } from "./scenario-groups/settings.mts";
import { signInScenarios } from "./scenario-groups/sign-in.mts";

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
const runtimeLogsPage = {
  group: "Pages/Agent detail",
  path: `${candidateVersion}&tab=logs`,
  deployed: true,
  candidateDeploymentStatus: "succeeded",
};
// The current version, v8, which the viewer cannot read, opened on its Logs tab.
const hiddenCurrentLogsPage = {
  group: "Pages/Agent detail",
  path: "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&tab=logs",
  deployed: true,
  candidateDeploymentStatus: "succeeded",
  candidateSuperseded: true,
  rules: [
    {
      suffix: "/revisions/rev_00000000-0000-4000-8000-000000000008",
      status: 403,
      code: "FORBIDDEN",
    },
  ],
};
const refuseLogRead = { suffix: "/runtime/logs", status: 403, code: "FORBIDDEN" };
const reservedConfigurationWrite = {
  path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
  method: "PATCH",
  status: 409,
  code: "RESOURCE_CONFLICT",
  message:
    "The Configuration is reserved for provisioning and is not available for this operation.",
};
/** @typedef {import("../../../apps/controller/src/console/agents/plugin-fields.mts").PluginFieldsOptions} PluginFieldsOptions */
/** @typedef {PluginFieldsOptions["catalog"]} PluginFieldCatalog */

const slackPluginId = "occ-plugin:slack@1.0.0";
const slackSourceId = "cs_00000000-0000-4000-8000-000000000001";
const slackEntry = { id: slackPluginId, name: "Slack", tools: [] };
const slackTool = {
  id: "slack_search_public",
  name: "slack_search_public",
  ownerId: slackPluginId,
};
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
/** @satisfies {PluginFieldCatalog} */
const devdayPluginCatalog = {
  status: "ready",
  setup: pluginSetup,
  entries: [...devdayCuratedEntries, calendarPlugin],
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
const account = [{ selector: ".account-toggle", click: true }];
const devdayRepositorySelector = 'input[data-repository-ref="openclaw/openclaw-enterprise"]';
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
  { text: "devday claw" },
  { selector: '.agent-tabs button[role="tab"][aria-controls$="-deployment-panel"]', click: true },
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
  ...secretsScenarios({ presetSecretsPath, click }),

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
  ...signInScenarios({ draft, click, account }),
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
  navigationOffline: {
    group: "Pages/Navigation",
    name: "Refresh while offline",
    rules: [{ path: "/api/auth/session", skip: 1, networkError: true }],
    actions: [click("Refresh")],
    description:
      "Refresh rereads the session, and the read never reaches the API. The signed-in shell stays, the page says it could not reach OpenClaw Enterprise, and focus is on Retry. The fixture fails every later session read as the browser does offline.",
    steps: [
      "Confirm the account and navigation stay, and no Agent or Namespace name shows.",
      "Choose Retry: the same message returns and focus is on Retry again.",
      "Repeat at phone width.",
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
  agentsEmptyMember: {
    group: "Pages/Agents",
    name: "Empty for a member",
    emptyAgents: true,
    readOnlyPermissionSummary: true,
    description:
      "A member without Agent create sees no Agents. The heading says none are shared with them, not that the Namespace has none, and nothing invites creating.",
  },
  agentsCreateBlockedByRestriction: {
    group: "Pages/Agents",
    name: "Create blocked by a Restriction",
    agentCreateRestricted: true,
    description:
      "An Installation administrator in a Namespace whose deny Restriction blocks Agent create. Create Agent is disabled, and the note names the Restriction and who can lift it, not an administrator to ask.",
    steps: [
      "Check that Create Agent is disabled and that a screen reader names the note as its description.",
    ],
    gap: "The permission answer is advisory. The controller still authorizes each create.",
  },
  agentsUnreadableConfiguration: {
    group: "Pages/Agents",
    name: "Unreadable saved configuration",
    deployed: true,
    unreadableAgentConfiguration: "plugins",
    description:
      "One Agent has unreadable saved plugin selections. Both Agents remain in the list, and the affected row shows a warning. This is simulated API data, not database recovery proof.",
    steps: [
      "Open Research assistant and select Open draft. Its saved settings show a repair banner without editing or deployment controls.",
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
      "Open it again and select Stop Agent. The row shows Stop requested, its Stop icon is disabled but keeps focus with Stop requested as its description, and the list stays open.",
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
      "An accepted row Stop shows a status notice, a Stop requested badge, and a disabled Stop icon that keeps focus, described by the badge. Delete stays available.",
  },
  agentsRowDeleteConfirm: {
    group: "Pages/Agents",
    name: "Delete from the list",
    deployed: true,
    actions: [{ selector: '[aria-label="Delete Research assistant"]', click: true }],
    description:
      "The confirmation says what deletion removes and what stays in the Namespace. Separate cleanup commands are available on request.",
    steps: [
      "Open View separate cleanup commands. Copying a command leaves the confirmation open.",
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
      "Permission advice allowed Stop, but the controller refuses the confirmed write, as after a removed grant. The alert names the missing Agent operate access; the row stays running. Its Stop icon takes focus back and looks unavailable, described by the alert, and the row's note under the icons says Needs Agent operate.",
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
      "Permission advice allowed Delete, but the controller refuses the confirmed write. The alert names the missing Agent delete access; the Agent stays in the list. Its Delete icon takes focus back and looks unavailable, described by the alert, and the row's note under the icons says Needs Agent delete.",
  },
  agentsRowDeleteRefusedOther: {
    group: "Pages/Agents",
    name: "Delete from the list refused for another reason",
    deployed: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "DELETE",
        status: 403,
        code: "FORBIDDEN",
        message:
          "Only the actor that started this deletion can retry it while that actor still holds delete. Retry as that actor, or remove its delete permission first.",
      },
    ],
    actions: [
      { selector: '[aria-label="Delete Research assistant"]', click: true },
      { selector: ".agent-delete-dialog button.danger", click: true },
    ],
    description:
      "The row is stale: another person's deletion of this Agent failed after the list loaded, and the controller refuses this caller's Delete for that reason, not for a missing grant. The alert shows the API's text with the Agent's name. The row's note names no grant; it reads Not deleted: see above, so a narrow screen that scrolled the alert away still says why. Both icons stay in the Tab order, unavailable and described by the refusal, until Refresh; focus stays on Delete.",
  },
  agentsRowRefocusDeleting: {
    group: "Pages/Agents",
    name: "Refocus after another person's deletion, with a kept refusal",
    deployed: true,
    deletingOnListReread: true,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "DELETE",
        status: 403,
        code: "FORBIDDEN",
        message:
          "Only the actor that started this deletion can retry it while that actor still holds delete. Retry as that actor, or remove its delete permission first.",
      },
    ],
    actions: [
      { selector: '[aria-label="Delete Research assistant"]', click: true },
      { selector: ".agent-delete-dialog button.danger", click: true },
    ],
    description:
      "This caller's Delete was refused for a reason that is not a grant, and another person's deletion of the Agent started after the list loaded. A window refocus rebuilds the list: the row gains its Deleting badge, keeps the refusal and its note, and focus returns to Delete. The page scrolls only as far as needed to keep the icon and its note in view (finding 2976). Simulated API; no backend proof.",
    steps: [
      "At 390 px, scroll until the note Not deleted: see above sits at the bottom of the window, with Delete Research assistant focused. Switch to another window, then return. The row reads Deleting, and Delete and its note are both in view.",
    ],
  },
  agentsRowRefocusStopped: {
    group: "Pages/Agents",
    name: "Refocus after another person's stop",
    deployed: true,
    stoppedOnListReread: true,
    description:
      "Another person's stop completes after the list loads, so the Agent has no selected version. A window refocus rechecks the list and rebuilds it; the row has no Stop icon now, so focus on it moves to the same row's name, not to the page (finding 2967). Simulated API; no backend proof.",
    steps: [
      "Press Tab until Stop Research assistant has focus. Switch to another window, then return. The row has no Stop icon, and focus is on the Research assistant link.",
    ],
  },
  agentsRowRestricted: {
    group: "Pages/Agents",
    name: "Row actions unavailable for this caller",
    deployed: true,
    readOnlyPermissionSummary: true,
    description:
      "The permission summary says this caller can neither stop nor delete these Agents. Each row disables its icons and says why before any confirmation.",
    steps: [
      "Tab to a row's Stop and Delete icons. Each takes focus and looks unavailable, its description is the row's whole reason without the short grant line, and Enter, Space or a click opens no confirmation.",
      "Find Needs operate and delete under each row's icons. Hover it for the whole reason, which names an Installation administrator as who grants them. The icons do not open a confirmation.",
      "Open an Agent: its detail page explains the same restrictions.",
    ],
    gap: "The summary is advisory. The controller still authorizes each write.",
  },
  agentsRowStopPermissionDuringConfirmation: {
    group: "Pages/Agents",
    name: "Stop from the list, permission arrives while confirmation is open",
    deployed: true,
    readOnlyPermissionSummary: true,
    rules: [
      { suffix: "/agents/agt_00000000-0000-4000-8000-000000000001/permissions", delayMs: 3500 },
    ],
    actions: [{ selector: '[aria-label="Stop Research assistant"]', click: true }],
    description:
      "The story opens Stop from the list before the delayed permission answer says no. The confirmation explains the restriction and focuses Cancel.",
    steps: [
      "Tab to Stop Agent. It takes focus and looks unavailable, described by the restriction; Enter, Space or a click sends nothing (finding 2935).",
    ],
    gap: "The permission answer is simulated; the API still authorizes every request.",
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
    steps: [
      "Tab to the Namespace selector. It takes focus and looks unavailable, described by the panel's sentence; arrow keys and a click change nothing (finding 2936).",
    ],
    gap: "Create a Namespace from Namespaces; granting access still requires an administrator.",
  },
  namespaceMissing: {
    group: "Pages/Agents",
    name: "Namespace unavailable",
    path: "/console/agents?namespace=ns_missing",
    description: "A stale Namespace link asks the reader to switch scope.",
  },
  namespaceMissingNoneReadable: {
    group: "Pages/Agents",
    name: "Namespace unavailable, none readable",
    emptyNamespaces: true,
    path: "/console/agents?namespace=ns_missing",
    description:
      "A stale Namespace link for a reader with no readable Namespace points at the header's Refresh, with no Switch Namespace button.",
  },
  namespaceMissingAgentBookmark: {
    group: "Pages/Agents",
    name: "Namespace unavailable, Agent bookmark",
    emptyNamespaces: true,
    path: "/console/agents/agt_bookmarked?namespace=ns_missing",
    description:
      "An Agent bookmark in a Namespace the reader can no longer read shows the Agents header and the panel, without the Agent's ID, copy button or back link.",
    gap: "Simulated UI proof only; this preview does not revoke a grant.",
  },
  agentsCreateRestricted: {
    group: "Pages/Agents",
    name: "Create Agent unavailable for this caller",
    readOnlyPermissionSummary: true,
    description: "The permission summary says this caller cannot create an Agent here.",
    steps: [
      "Find the explanation beside Create Agent. The action is unavailable; opening a readable Agent still works.",
      "Tab to Create Agent. It takes focus and looks unavailable, its description is the explanation, and Enter, Space or a click does nothing.",
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
      "Confirm Create Agent is disabled and described by that note, no empty-list message appears, and no further Namespace reads happen.",
    ],
  },
  agentsNamespaceMissingStopDialog: {
    group: "Pages/Agents",
    name: "Namespace loss with Stop dialog",
    deployed: true,
    namespaceStatus: "provisioning",
    namespaceRechecks: ["missing"],
    actions: [{ selector: '[aria-label="Stop Research assistant"]', click: true }],
    description:
      "The last Namespace response still says provisioning. Its idle recheck removes access while the row confirmation is open.",
    steps: [
      "Wait for the recheck. The dialog, rows and previous feedback disappear. Search Agents receives focus, with no empty-list message.",
    ],
  },
  agentsNamespaceMissingLateStop: {
    group: "Pages/Agents",
    name: "Namespace loss before Stop response",
    deployed: true,
    namespaceStatus: "provisioning",
    namespaceRechecks: ["missing"],
    rules: [{ suffix: "/stop", method: "POST", delayMs: 12000 }],
    actions: [
      { selector: '[aria-label="Stop Research assistant"]', click: true },
      { selector: ".agent-stop-dialog .danger", click: true },
    ],
    description: "The Namespace becomes unavailable while a Stop response is pending.",
    steps: [
      "Wait for the result. Only generic acceptance and the unavailable warning remain, with no Agent name, ID or empty-list message.",
    ],
  },
  agentsNamespaceMissingDeleteDialog: {
    group: "Pages/Agents",
    name: "Namespace loss with Delete dialog",
    deployed: true,
    namespaceStatus: "provisioning",
    namespaceRechecks: ["missing"],
    actions: [{ selector: '[aria-label="Delete Research assistant"]', click: true }],
    description:
      "The last Namespace response still says provisioning. Its idle recheck removes access while the row confirmation is open.",
    steps: [
      "Wait for the recheck. The dialog, rows and previous feedback disappear. Search Agents receives focus, with no empty-list message.",
    ],
  },
  agentsNamespaceMissingPopulated: {
    group: "Pages/Agents",
    name: "Populated Namespace leaves the list",
    namespaceStatus: "provisioning",
    namespaceRechecks: ["missing"],
    actions: [{ selector: 'input[type="search"]', value: "Research", focus: true }],
    description:
      "A provisioning Namespace becomes unreadable while its Agents are displayed. The idle check removes the rows and disables Create Agent without moving search focus.",
    steps: [
      "Wait for the missing-Namespace warning. Research assistant and its actions disappear.",
      "Clear Search Agents. The old rows must not return. Repeat at phone width.",
    ],
  },
  agentsDenied: {
    group: "Pages/Agents",
    name: "Access denied",
    rules: [{ path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents", status: 403 }],
    description:
      "Collection authorization denial. Its request ID is behind a Request details disclosure, not in the reason. Retry would repeat the refusal, so the panel offers none; the header's Refresh checks access again.",
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
  ...namespacesScenarios,
  ...settingsScenarios,
  notFound: {
    group: "Pages/Navigation",
    name: "Page not found",
    path: "/console/missing",
    description: "An unknown console route offers a return to Agents.",
  },
  ...createAgentFormScenarios,
  ...pluginsScenarios,
  ...createAgentProvisioningScenarios,
  pluginsOAuthRevision: {
    group: "Pages/Agent detail",
    name: "Saved ChatGPT login for plugin editing (Experimental)",
    path: `${draft}&tab=plugins`,
    deployed: true,
    auth: "oauth",
    agentPlugins: structuredClone(pluginSelectionState),
    pluginCapabilities,
    pluginDiscovery,
    description:
      "Plugin browsing uses the Agent's saved credential source without another login. Saving plugin selections never replaces authentication.",
    steps: [
      "Tab to Save plugin selections and Discard changes. Each takes focus, looks unavailable and is described by No plugin changes to save.; Enter or Space does nothing. Edit the JSON: both become live.",
    ],
  },
  ...credentialsOAuthScenarios({ draft }),
  ...createAgentOutcomeScenarios,
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
  failedFirstVersion: {
    group: "Pages/Agent detail",
    name: "Failed first version",
    path: revision,
    deployed: true,
    firstDeploymentFailed: true,
    description:
      "The only version's deployment failed, so no version serves. Live serving says Not running, the version is labelled Failed rather than Historical, and no diagnostics are offered for a runtime that never started.",
    steps: [
      "Read Live serving in the summary: Not running.",
      "Read the notice above the Configuration snapshot: Failed version.",
      "Find Open draft once, in the page header. The version picker names the draft as New version, Editable Configuration.",
    ],
    gap: "Simulated UI proof only; this preview does not run a deployment.",
  },
  newVersion: {
    group: "Pages/Agent detail",
    name: "Open draft",
    path: draft,
    deployed: true,
    description:
      "Edit and save the current Configuration before deploying a new immutable version. The selected version stays unchanged until activation.",
    steps: [
      "Review the selected version and saved draft settings.",
      "Check the new-version notice has an even, neutral border without a blue stripe. Its message stays visible when Configuration opens for editing, including at phone width.",
      "Turn off Gateway managed mode and confirm the current version still requests it on.",
      "Return to the draft, edit and save Configuration, then deploy the new version.",
      "Inspect the admitted version and its deployment activity.",
    ],
    gap: "The fixture simulates saves, admission, and worker completion; it does not run a live Agent or Gateway.",
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
  currentConfigurationReader: {
    group: "Pages/Agent detail",
    name: "Current Configuration, viewer can only read",
    path: `${revision}&tab=configuration`,
    deployed: true,
    readOnlyPermissionSummary: true,
    description:
      "The permission answer denies Configuration update, so a version's Configuration tab offers Open draft instead of Edit current Configuration. The draft it opens shows the saved JSON with no editor. The API still decides.",
    steps: [
      "Find Open draft below the Configuration snapshot, and no Edit current Configuration.",
      "Choose Open draft: the draft opens read-only, with no Edit Configuration button.",
    ],
    gap: "The permission answer is simulated; the API still authorizes every save.",
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
      "Focus Open draft, switch to another window, then return. During the 1.5-second access check, the action stays visible but cannot be used; focus returns to it after the check.",
      "Repeat the window switch and focus Namespaces while the check is pending. Focus stays in the sidebar when the check finishes.",
      "Choose Open draft to open the draft Configuration without deploying. In the next story, try the Agents back link and Namespace selector while a save is in progress.",
    ],
    nextStory: "authSaveHoldsNavigation",
  },
  earlierFailedVersion: {
    group: "Pages/Agent detail",
    name: "Earlier failed version",
    path: draft,
    deployed: true,
    revisionHistory: 3,
    earlierFailedVersion: 2,
    description:
      "v2's deployment failed and v3 now serves. The version picker marks v2 from the list's own outcome, so the mark shows on load, before v2 is opened.",
    steps: [
      'Check Viewing version: v3 includes "Selected for service" and v2 includes "Failed" without opening it; v1 has no outcome label.',
      "Reload the page: v2 keeps its Failed label.",
    ],
    gap: "The deployment records are simulated; the API reports each listed version's outcome the same way.",
  },
  earlierSupersededVersion: {
    group: "Pages/Agent detail",
    name: "Earlier superseded version",
    path: draft,
    deployed: true,
    revisionHistory: 3,
    earlierFailedVersion: 2,
    // The API lists a superseded deployment as failed with this code.
    earlierVersionError: {
      code: "REVISION_SUPERSEDED",
      message: "Deployment was superseded by a newer revision.",
    },
    description:
      "v3 took over before v2's deployment finished. The version picker marks v2 Superseded, not Failed, from the list's own outcome, and v2's page says a newer version took over.",
    steps: [
      'Check Viewing version: v3 includes "Selected for service" and v2 reads "v2 · Superseded"; v1 has no outcome label.',
      'Choose v2. The notice reads "Superseded version · read-only admitted snapshot. A newer version took over before its deployment finished." and names neither the newer version nor a runtime stop.',
    ],
    gap: "The deployment records are simulated; the API reports each listed version's outcome the same way.",
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
      "The version picker loads history one page at a time, newest first. Browsing does not deploy or roll back.",
    steps: [
      "Open Viewing version and check Draft, v8, v7, and v6. Selected for service identifies the service target.",
      "Choose Load older versions. During the 1.5-second read the button keeps focus and ignores repeat activation.",
      "When v5, v4, and v3 load, the button keeps focus. Load the final page; focus returns to Viewing version without changing the viewed version.",
      "Choose v6, then Open draft. Neither action changes the version selected for service.",
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
      { selector: "#revision-selector", value: "rev_00000000-0000-4000-8000-000000000001" },
      click("Access"),
      ...shareExistingPerson,
      { selector: 'a[data-nav="agents"]', click: true },
    ],
    description:
      "The story opens a version from the draft, shares the Agent, then selects Agents in the sidebar while the first grant is pending. The page stays, and a note at the top of the tab panel says why until both grants are written, about 4 s later.",
    steps: [
      "While the note “This page stays open until sharing finishes.” shows, check that the version picker is disabled, and that ← Agents and Refresh keep the page. Select Reset story to replay the hold.",
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
      click("Configuration"),
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
  agentSharingRefusedOnReturn: {
    group: "Pages/Agent detail",
    name: "Sharing refused on return",
    path: `${draft}&tab=access`,
    // The first policy read succeeds; the reread on the return to the tab is refused.
    rules: [{ suffix: "/iam/roles", status: 403, skip: 1 }],
    actions: [{ text: "Current policy loaded." }, click("Configuration"), click("Access")],
    description:
      "The story loads the Access tab, opens Configuration, then returns to Access, whose policy reread is refused as after a revoke. The tab gives way to Configuration and says why; the earlier grants and Remove binding are gone.",
    steps: [
      "Configuration is selected and the note reads “The Access tab needs Installation administration, which your access does not include. Showing Configuration.” The Access tab is gone.",
      "The request log shows one refused /iam/roles read on the return and no /iam/access-bindings read after it.",
    ],
    gap: "Simulated UI proof: the refused reread stands in for administration revoked while the page is open.",
  },
  agentSharingRegranted: {
    group: "Pages/Agent detail",
    name: "Refresh sharing after administration is granted again",
    path: `${draft}&tab=access`,
    rules: [
      // The page load reads the policy; the share's reread is refused, as after a revoke.
      { suffix: "/iam/roles", status: 403, skip: 1, once: true },
      // The permission answer that settles the refusal says "not an administrator"; the one
      // Refresh sharing asks reports administration granted again.
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/permissions",
        skip: 1,
        once: true,
        data: {
          delete: true,
          agents: { create: true },
          secrets: { create: true },
          installation: { administer: false },
        },
      },
    ],
    actions: [
      { text: "Current policy loaded." },
      ...shareExistingPerson,
      { text: "Sharing policy requires Installation administration." },
      click("Refresh sharing"),
    ],
    description:
      "A share is refused after a revoke, and administration is granted again. Refresh sharing rereads the Agent's and the Namespace's permission answers, then the policy, one list at a time: the Access tab stays and shows the current policy without a page reload (finding 2943).",
    steps: [
      "The panel shows “Current policy loaded.” and the Share form is usable again; the Access tab is still selected.",
      "The request log shows the Agent and Namespace /permissions reads after Refresh sharing, then one /iam/roles and one /iam/access-bindings read.",
    ],
    gap: "Simulated UI proof: the refused reread and the permission answers stand in for administration revoked and granted again while the page is open.",
  },
  agentSharingUnknown: {
    group: "Pages/Agent detail",
    name: "Sharing outcome uncertain",
    path: `${draft}&tab=access`,
    actions: shareExistingPerson,
    rules: [{ suffix: "/iam/access-bindings", method: "POST", status: 503, once: true }],
    description:
      "A failed mutation response leaves the outcome uncertain. Refresh current policy before explicitly retrying; no automatic replay occurs.",
    steps: [
      "Tab to the Principal ID, the acknowledgement and Share Agent. Each takes focus and looks unavailable, described by the alert that asks for Refresh sharing; typing, Enter, Space or a click changes nothing.",
    ],
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
  gatewayPasswordUnreadable: {
    group: "Pages/Agent detail",
    name: "Gateway password reference OpenClaw cannot read",
    path: draft,
    deployed: true,
    gatewayPasswordProviderless: true,
    description:
      "An older release saved gateway.auth.password without a provider. OpenClaw cannot read it and OCC refuses to save or deploy it, so the page shows OCC's refusal and keeps Enable gateway password access.",
    steps: [
      "On Configuration the hint reads Configuration setting gateway.auth.password is a SecretRef without a provider: add provider default, then says to enable access, save and deploy.",
      "In Prepare this version, the first step reads Fix the gateway password and Deploy new version is disabled with the same refusal.",
      "Select Enable gateway password access and Save Configuration: the hint says access is enabled and the status returns to Ready to deploy.",
    ],
    gap: "The stored reference is simulated; this story does not call OCC's save or deploy admission or start a Gateway.",
  },
  secretProviderAliasRefused: {
    group: "Pages/Agent detail",
    name: "Secret provider alias OpenClaw refuses",
    path: draft,
    deployed: true,
    secretProviderAliasRefused: true,
    description:
      "An older release saved secrets.defaults.env as BAD. OpenClaw's configuration check refuses an alias outside its grammar and OCC refuses to save or deploy it, so the page names the alias and offers no Enable gateway password access.",
    steps: [
      "On Configuration the hint reads Configuration setting secrets.defaults.env is BAD, not a provider alias OpenClaw reads, with the grammar and the fix (use bad, or remove it), then says to edit the Configuration before you enable gateway password access; the button is absent.",
      "In Prepare this version, the first step reads Fix the secret provider alias and Deploy new version is disabled with the same refusal.",
    ],
    gap: "The stored alias is simulated; this story does not call OCC's save or deploy admission or start a Gateway.",
  },
  pluginSecretInputUnreadable: {
    group: "Pages/Agent detail",
    name: "Plugin secret input OpenClaw cannot read",
    path: draft,
    deployed: true,
    pluginSecretInputProviderless: true,
    description:
      "An older release saved a Google web search header as a SecretRef without a provider. OpenClaw cannot read it and Kubernetes Compute refuses to save or deploy it, so the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Fix the plugin secret input.",
      "Deploy new version is disabled with Configuration setting plugins.entries.google.config.webSearch.headers.X-Goog-User-Project is a SecretRef without a provider: add provider default, or remove plugins.entries.google or set its enabled to false.",
    ],
    gap: "The stored reference is simulated; this story does not call save or deploy admission or start a Gateway.",
  },
  configIncludeRefused: {
    group: "Pages/Agent detail",
    name: "Configuration include OCE refuses",
    path: draft,
    deployed: true,
    configInclude: true,
    description:
      "An older release saved OpenClaw's $include in agents.defaults. OpenClaw would merge settings from another file that OCE does not check, and every Compute refuses to save or deploy it, so the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Remove the $include setting.",
      "Deploy new version is disabled with Configuration setting agents.defaults.$include is not supported: OpenClaw would merge settings from another file that OCE does not check. Write those settings in the Configuration instead.",
    ],
    gap: "The stored include is simulated; this story does not call save or deploy admission or start a Gateway.",
  },
  pluginEntryKeyVariantRefused: {
    group: "Pages/Agent detail",
    name: "Plugin entry key in another spelling",
    path: draft,
    deployed: true,
    pluginEntryKeyVariant: true,
    description:
      "An older release saved a plugins.entries.Codex entry beside codex. OpenClaw merges it into codex, and every Compute refuses to save or deploy it, so the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Fix the plugin entry key.",
      "Deploy new version is disabled with Configuration setting plugins.entries.Codex must be named codex: OpenClaw merges it into plugins.entries.codex, the entry OCE checks. If that entry exists, move these settings into it and remove this key; else rename this key.",
    ],
    gap: "The stored key is simulated; this story does not call save or deploy admission or start a Gateway.",
  },
  openClawSandboxRefused: {
    group: "Pages/Agent detail",
    name: "OpenClaw sandbox before a plugin entry key",
    path: draft,
    deployed: true,
    openClawSandbox: true,
    pluginEntryKeyVariant: true,
    description:
      "An older release saved OpenClaw's sandbox on and a plugins.entries.Codex entry beside codex. Every Compute refuses to save or deploy both, and deploy names the sandbox first, so the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Turn off OpenClaw's sandbox.",
      'Deploy new version is disabled with Configuration setting agents.defaults.sandbox.mode must be "off" or unset: OCE runs each Agent in its own isolated runtime and does not support OpenClaw\'s sandbox.',
    ],
    gap: "The stored settings are simulated; this story does not call save or deploy admission or start a Gateway.",
  },
  providerKeyVariantRefused: {
    group: "Pages/Agent detail",
    name: "Model provider key in another spelling",
    path: draft,
    deployed: true,
    providerKeyVariant: true,
    description:
      "An older release saved a models.providers.OpenAI entry. OpenClaw applies it to openai, and every Compute refuses to save or deploy it, so the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Fix the model provider key.",
      'Deploy new version is disabled with Configuration setting models.providers.OpenAI must be named "openai": OpenClaw applies it to that provider\'s entry, the one OCE checks. Move these settings there if that key exists, else rename this key.',
    ],
    gap: "The stored key is simulated; this story does not call save or deploy admission or start a Gateway.",
  },
  pluginPolicyListRefused: {
    group: "Pages/Agent detail",
    name: "Plugin deny list item that is not text",
    path: draft,
    deployed: true,
    pluginDeny: ["discord", 7],
    description:
      "An older release saved a plugins.deny list with a number in it. OpenClaw's config schema refuses it, so no Gateway starts, and every Compute refuses to save or deploy it: the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Fix the plugin allow or deny list.",
      "Deploy new version is disabled with Configuration setting plugins.deny must list only plugin IDs as text, or the Gateway does not start: remove any other item.",
    ],
    gap: "The stored list is simulated; this story does not call save or deploy admission or start a Gateway.",
  },
  kubernetesEntryKeyVariantRefused: {
    group: "Pages/Agent detail",
    name: "Plugin entry key Kubernetes Compute refuses",
    path: draft,
    deployed: true,
    kubernetesEntryKeyVariant: true,
    rules: [
      {
        suffix: "/agents/validate",
        method: "POST",
        status: 400,
        code: "INVALID_REQUEST",
        message:
          "Configuration setting plugins.entries.File-Transfer must be named file-transfer: OpenClaw merges it into plugins.entries.file-transfer, the entry OCE checks. If that entry exists, move these settings into it and remove this key; else rename this key.",
      },
    ],
    description:
      "An older release saved a plugins.entries.File-Transfer entry. Only Kubernetes Compute refuses that spelling, so the page asks Create Agent's preflight, which runs the Installation's Compute rules. Here it refuses, so the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Fix the plugin entry key.",
      "Deploy new version is disabled with Configuration setting plugins.entries.File-Transfer must be named file-transfer: OpenClaw merges it into plugins.entries.file-transfer, the entry OCE checks. If that entry exists, move these settings into it and remove this key; else rename this key.",
    ],
    gap: "The stored key and the preflight refusal are simulated; tests/browser/console-agent-detail.test.mjs covers the page with the real Kubernetes and SSH Compute rules.",
  },
  codexPluginsDisabledRefused: {
    group: "Pages/Agent detail",
    name: "Codex plugin turned off on Dedicated Codex",
    path: draft,
    deployed: true,
    codexPluginsDisabled: true,
    rules: [
      {
        suffix: "/agents/validate",
        method: "POST",
        status: 400,
        code: "INVALID_REQUEST",
        message:
          "Configuration setting plugins.enabled must not be false: Dedicated Codex runs the codex plugin, so its Gateway would not start. Remove it.",
      },
    ],
    description:
      "An older release saved plugins.enabled false on a Dedicated Codex Agent. Only Kubernetes Compute refuses it, so the page asks Create Agent's preflight, which runs the Installation's Compute rules. Here it refuses, so the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Let the codex plugin run.",
      "Deploy new version is disabled with Configuration setting plugins.enabled must not be false: Dedicated Codex runs the codex plugin, so its Gateway would not start. Remove it.",
    ],
    gap: "The stored setting and the preflight refusal are simulated; tests/browser/console-agent-detail.test.mjs covers the page with the real Kubernetes Compute rules.",
  },
  trustedProxyAllowUsersRefused: {
    group: "Pages/Agent detail",
    name: "Trusted-proxy allowlist without the machine identity",
    path: draft,
    deployed: true,
    trustedProxyWithoutMachine: true,
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
    description:
      "An older release saved a trusted-proxy allowlist without occ-workspace-files. Only Kubernetes Compute refuses it, so the page asks Create Agent's preflight, which runs the Installation's Compute rules. Here it refuses, so the page shows that refusal and holds Deploy.",
    steps: [
      "In Prepare this version, the first step reads Fix the Gateway authentication.",
      "Deploy new version is disabled with the allowUsers refusal deploy gives.",
    ],
    gap: "The stored setting and the preflight refusal are simulated; tests/browser/console-agent-detail.test.mjs covers the page with the real Kubernetes Compute rules.",
  },
  kubernetesEntryKeyVariantChecking: {
    group: "Pages/Agent detail",
    name: "Plugin entry key, Compute check in flight",
    path: draft,
    deployed: true,
    kubernetesEntryKeyVariant: true,
    rules: [{ suffix: "/agents/validate", method: "POST", hold: true }],
    description:
      "An older release saved a plugins.entries.File-Transfer entry, and Create Agent's preflight has not answered yet. Deploy waits for it, and after 250 ms the draft says it is checking the Configuration with this Installation's Compute.",
    steps: [
      "Deploy new version is disabled with Checking the Configuration with this Installation's Compute before deploying.",
    ],
    gap: "The preflight is held by the fixture; the API client gives up after 15 seconds, and then the page holds nothing and Deploy is enabled.",
  },
  kubernetesEntryKeyVariantCreateDenied: {
    group: "Pages/Agent detail",
    name: "Plugin entry key, caller without Agent create",
    path: draft,
    deployed: true,
    kubernetesEntryKeyVariant: true,
    agentCreateRestricted: true,
    rules: [
      {
        suffix: "/agents/validate",
        method: "POST",
        status: 400,
        code: "INVALID_REQUEST",
        message:
          "Configuration setting plugins.entries.File-Transfer must be named file-transfer: OpenClaw merges it into plugins.entries.file-transfer, the entry OCE checks. If that entry exists, move these settings into it and remove this key; else rename this key.",
      },
    ],
    description:
      "An older release saved a plugins.entries.File-Transfer entry, and the Namespace permission answer says this caller may not create Agents. Create Agent's preflight needs that permission, so the page does not ask it and holds nothing. Deploy stays the authority and gives Kubernetes Compute's refusal, if any.",
    steps: [
      "Deploy new version is enabled and the draft reads Ready to deploy.",
      "The fixture would refuse the preflight, yet no refusal is shown: the page never sent it.",
    ],
    gap: "The permission answer is simulated; tests/browser/console-agent-detail.test.mjs covers a member without Agent create against the real API, with no preflight request and no audited denial.",
  },
  gatewayPasswordAllowlistOmits: {
    group: "Pages/Agent detail",
    name: "Gateway password reference an allowlist omits",
    path: draft,
    deployed: true,
    gatewayPasswordAllowlistOmits: true,
    description:
      "The default env alias is vault, a configured env provider whose allowlist leaves out OPENCLAW_GATEWAY_PASSWORD. OpenClaw cannot read the generated reference on that alias and OCC refuses to save it, so the page states why and offers no Enable gateway password access.",
    steps: [
      'On Configuration the hint reads The generated gateway password reference {source: "env", provider: "vault", id: "OPENCLAW_GATEWAY_PASSWORD"} references OPENCLAW_GATEWAY_PASSWORD, which secrets.providers.vault.allowlist omits: add it to that allowlist, then says to edit the Configuration before you enable gateway password access; the button is absent.',
    ],
    gap: "The stored secrets are simulated; this story does not call OCC's save or deploy admission or start a Gateway.",
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
  gatewaySafety: {
    group: "Pages/Agent detail",
    name: "Collaboration and safety settings",
    path: draft,
    deployed: true,
    description:
      "The Configuration tab shows the Gateway collaboration and safety settings a deployment runs with. By default, other participants can steer a running turn, and apply_patch changes files only in the workspace.",
    steps: [
      "Read each toggle's state and where it comes from: Default: on. Check that steering help distinguishes channel users and local operators from OCE users who share one Gateway identity.",
      "Turn on Strict mode. The Configuration JSON opens with both locked-down values written, and focus stays on Strict mode.",
      "Turn steering back on. Its value leaves the JSON and Strict mode turns off. Cancel, or Save Configuration and deploy a new version.",
    ],
    gap: "Simulated UI proof; does not show a deployed Gateway steering a turn.",
  },
  gatewaySafetyStrict: {
    group: "Pages/Agent detail",
    name: "Strict mode staged in the Configuration JSON",
    path: draft,
    deployed: true,
    actions: [{ selector: "#gateway-safety-strict", click: true }],
    description:
      "Strict mode writes every locked-down value into the Configuration JSON; Save Configuration keeps them, and the next deployment applies them.",
    gap: "Simulated UI proof; does not show a deployed Gateway steering a turn.",
  },
  gatewaySafetyRejectSteering: {
    group: "Pages/Agent detail",
    name: "Collaboration and safety, reject steering",
    path: `${draft}&tab=configuration`,
    deployed: true,
    messageQueue: { allowCollaborativeSteering: false, collaborativeSteeringFallback: "reject" },
    description:
      "The Configuration disables collaborative steering and sets its fallback to reject. The help explains that another participant must resend their message with /followup.",
    gap: "Simulated UI proof; does not show a deployed Gateway refusing a message.",
  },
  gatewaySafetyReader: {
    group: "Pages/Agent detail",
    name: "Collaboration and safety, viewer can only read",
    path: `${draft}&tab=configuration`,
    deployed: true,
    readOnlyPermissionSummary: true,
    messageQueue: { allowCollaborativeSteering: false },
    description:
      "A viewer sees the saved strict settings, with every toggle unavailable and the reason linked to each. The note above them names the grant to ask for.",
    steps: [
      "Tab to Strict mode and on through each toggle. Each takes focus, its label draws the focus ring, its description ends with These settings are read-only with your access., and Space leaves it unchanged.",
    ],
    gap: "The permission answer is simulated; the API still authorizes every save.",
  },
  pluginsUpdateDenied: {
    group: "Pages/Agent detail",
    name: "Plugin selections, viewer cannot update the Agent",
    path: `${draft}&tab=plugins`,
    deployed: true,
    auth: "codex_pat",
    agentPlugins: structuredClone(pluginSelectionState),
    agentPluginApprovers: [{ channel: "slack", id: "team:TDEMO123:user:UDEMO123" }],
    pluginCapabilities,
    pluginDiscovery,
    readOnlyPermissionSummary: true,
    description:
      "The permission answer denies Agent update, so the saved selections show as a read-only summary with no editor, Save or Discard, and the note names the grant to ask for. The page does not read the plugin policy capabilities, which need Agent update, so the saved default plugin approvers show as text. The API still decides.",
    steps: [
      "Under Default plugin approvers, read that the next deployment uses these Agent default approvers and find slack: team:TDEMO123:user:UDEMO123. No approver field is offered.",
    ],
    gap: "The permission answer is simulated; the API still authorizes every save.",
  },
  draftReader: {
    group: "Pages/Agent detail",
    name: "Version draft, viewer can only read",
    path: `${draft}&tab=configuration`,
    deployed: true,
    readOnlyPermissionSummary: true,
    description:
      "The permission answer denies Agent and Configuration update and deploy. The draft says it is read-only with this access, the Configuration tab shows the saved JSON with no editor, and the draft card has no editor's checklist. The API still decides.",
    steps: [
      "Read the notice: Version draft · read-only with your access.",
      "Find no Edit Configuration button; View native Configuration opens the saved JSON.",
      "The draft card reads Version draft, with Deploy unavailable and its reason, and no Prepare this version steps. Tab reaches Deploy new version: it looks unavailable, its description is the reason, and Enter or Space does nothing.",
    ],
    gap: "The permission answer is simulated; the API still authorizes every save.",
  },
  draftSourcesOperateDenied: {
    group: "Pages/Agent detail",
    name: "Version draft, editor cannot operate a bound Secret",
    path: `${draft}&tab=configuration`,
    deployed: true,
    slack: true,
    secretOperateDenied: ["sec_demo_slack_app_token", "sec_demo_slack_bot_token"],
    agentPermissionSummary: {
      update: true,
      deploy: false,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: true,
      configurationRead: true,
      configurationSecretsOperate: false,
      configurationSecretsOperateDeniedBindings: [],
      agentSourcesOperate: false,
      sandboxPolicyRead: false,
    },
    description:
      "The permission answer allows Agent and Configuration update but not operate on a Secret the Configuration binds, which every save checks. Each editor is disabled, so the draft reads as read-only with this access, as for a viewer.",
    steps: [
      "Read the notice: Version draft · read-only with your access.",
      "In Configuration, read that saving needs Secret operate on Slack app token (simulated) and Slack bot token (simulated). No Edit Configuration button is offered. View native Configuration still opens the saved JSON.",
      "In Plugins and Credentials, read the same missing Secret names after the general source-grant explanation. Plugin selections remain a saved summary; authentication controls remain unavailable. Switching tabs retains their state.",
      "The Versions entry reads Version draft with Read-only Configuration, and the draft card has no Prepare this version steps.",
    ],
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
  pluginsPrefetchReturn: {
    group: "Pages/Agent detail",
    name: "Return before plugin prefetch starts",
    path: draft,
    deployed: true,
    auth: "codex_pat",
    agentPlugins: structuredClone(pluginSelectionState),
    pluginCapabilities,
    pluginDiscovery,
    actions: [click("Plugins"), click("Configuration")],
    description:
      "The fixture leaves Plugins while catalog prefetch is deferred. Returning can load the catalog without losing saved selections.",
    steps: [
      "After the initial Configuration view settles, select Plugins and open Configure plugins. Calendar should load and Load plugins should be enabled; Loading plugins must not persist.",
      "Close and reopen the picker. Calendar's saved policy is unchanged. Repeat from Reset story to inspect the skipped prefetch again.",
    ],
    gap: "Catalog responses and the saved Agent are simulated. This verifies Console recovery, not plugin installation or a live runtime.",
  },
  slackMcpTools: {
    group: "Pages/Agent detail",
    name: "Choose tools for a connected Slack account",
    path: `${draft}&tab=plugins`,
    harnessId: "openclaw",
    deployed: true,
    agentPlugins: { [slackPluginId]: { enabled: true } },
    credentialSources: [{ sourceId: slackSourceId }],
    pluginDiscoveryCredential: "none",
    pluginCapabilities: {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      approvers: { agent: false, plugin: false, tools: false },
      toolDefaults: { enabled: false, approval: [], reviewer: [] },
      tools: { enabled: false, approval: [], reviewer: [] },
      driverPolicySchema: { type: "object", properties: {} },
      policyScopeByPlugin: { [slackPluginId]: "enablement_only" },
      credentialSlots: [
        {
          pluginId: slackPluginId,
          releaseSha256: "a".repeat(64),
          id: "account",
          label: "Slack account",
          toolDiscovery: true,
          sources: [{ id: slackSourceId, name: "Slack search connection (simulated)" }],
        },
      ],
    },
    pluginDiscovery: {
      pages: { initial: { plugins: [slackEntry], nextCursor: null } },
      details: { [slackPluginId]: { ...slackEntry, tools: [slackTool] } },
    },
    rules: [
      {
        suffix: "/plugins/details",
        method: "POST",
        delayMs: 650,
        once: true,
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    actions: [click("Configure plugins")],
    description:
      "The Tools picker loads available tools from the selected Slack account. Select the tools the next deployment may call.",
    steps: [
      "Open Slack. Before selecting an account, no tools can be loaded. Select Slack search connection (simulated).",
      "Choose Load tools. The first request shows a loading state, then a permission error. Choose Load tools again to recover.",
      "Check slack_search_public. Choose Done and Save plugin selections. Open the picker and load tools again to confirm the saved choice.",
    ],
    gap: "The account and MCP response are simulated. This verifies Console selection and readback.",
  },
  pluginsDraft: {
    group: "Pages/Agent detail",
    name: "Edit plugins in new version",
    path: draft,
    deployed: true,
    auth: "codex_pat",
    agentPlugins: structuredClone(pluginSelectionState),
    pluginCapabilities,
    pluginDiscovery,
    actions: [click("Plugins")],
    description:
      "Edit Agent-owned plugin selections on the draft while the admitted version keeps its original snapshot.",
    steps: [
      "The first catalog page loads in the background when the Plugins tab opens, using the saved Service Accounts token. Open Configure plugins to review Calendar's saved policy.",
      "Open Calendar and inspect the tool IDs beneath their titles. Type create into Filter tools, then clear it; filtering should keep the cursor in the search box.",
      "In Available, select Calendar, filter tools by create, and expand Create event. Switch to Configured, filter plugins by Calendar, and choose Calendar with a different tool filter. Round-trip the tabs: each keeps its selection, query, tool filter, and expanded rows without another catalog request.",
      "In Configured, open More actions and choose Remove Calendar. Its details clear even though Available still lists it. Add Calendar again from Available; Configured must not restore the removed detail state.",
      "In Configure plugins, change Calendar's tool policy, add Documents from the next page, and select Done.",
      "Select Save plugin selections. The tab updates in place: the page keeps its scroll and focus moves to Plugin selections saved. Then select Deploy new version and compare the new version with the earlier immutable plugin snapshot.",
    ],
    gap: "Catalog and deployment responses are simulated. This does not verify plugin access, installation, policy enforcement, or a live Agent turn.",
  },
  ...pluginApproverScenarios(draft),
  pluginApproversLookup: {
    group: "Pages/Agent detail",
    name: "Find Slack plugin approvers",
    path: draft,
    slack: true,
    auth: "codex_pat",
    agentPlugins: structuredClone(pluginSelectionState),
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
    agentPlugins: structuredClone(pluginSelectionState),
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
    agentPlugins: structuredClone(pluginSelectionState),
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
  invalidConfigurationCurlyQuotes: {
    group: "Pages/Agent detail",
    name: "Invalid Configuration JSON with curly quotes",
    path: draft,
    actions: [
      click("Edit Configuration"),
      // Quotes a word processor or chat app curled, as pasted from a document.
      { selector: "#configuration-json", value: '{\n  "agents": {\u201Cdefaults\u201D: {}}\n}' },
      click("Save Configuration"),
    ],
    description:
      "A key wrapped in curly quotes looks like JSON but is not. The error names the curly quote and the straight quote to use instead.",
    steps: [
      'Read the error under the editor: Invalid JSON at line 2, column 14: replace the curly quote \u201C there with a straight quote (").',
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
      "Reopening the desired configuration keeps the Agent default and each explicit override. Saving changes updates the draft; earlier Agent revisions retain their prior access.",
    steps: [
      "Check that Repository access shows the controls without a Runtime support and access limits disclosure or an empty space in its place. Create Agent keeps that disclosure.",
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
    // Without repository settings, discovery answers 200 with no options and meta.notConfigured.
    repositoryOptions: [],
    repositoryNotConfigured: true,
    description:
      "The Installation has no Repo Driver: for an Installation administrator the tab links the setup guide and offers no Retry. Save repository access stays hidden while the stale binding remains.",
    steps: [
      "Remove application. Save repository access appears, and the status says to save to continue without repository access.",
    ],
    gap: "Simulated UI proof only; this preview does not configure a Repo Driver.",
  },
  repositoryEditorNotConfiguredMember: {
    group: "Pages/Agent detail",
    name: "Repository access without a Repo Driver, for a member",
    path: `${draft}&tab=repositories`,
    repositoryOptions: [],
    repositoryNotConfigured: true,
    observabilityDenied: true,
    description:
      "A member who may edit the Agent is told to ask an Installation administrator to set up repository access, with no setup guide link.",
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
      "The permission answer denies Agent update, so the saved repository access shows as a read-only summary with no editor, and the note names the grant to ask for. The page does not read the repository choices, which need Agent update.",
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
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "queued",
    description:
      "v7 is admitted and queued without a live worker claim. v6 remains selected; serving is unverified. Deployment details keep Last recorded result, Reason and Since rows (not recorded yet), so the first result fills them in place.",
    steps: [
      "Fold Deployment details and Tab to Run diagnostics for this version. Routine queued polls keep the fold, focus and visible button position. Repeat expanded at desktop and phone widths; unchanged healthy Refresh deployment also keeps the fold.",
      'Selected for service reads v6. v7\'s Configuration tab notice begins "Deploying version", not "Historical version".',
    ],
  },
  deploymentRunning: {
    group: "Pages/Agent detail",
    name: "New version in progress",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "running",
    description:
      "A worker holds the v7 deployment claim while v6 remains selected. The API does not expose finer runtime stages.",
    steps: [
      'Selected for service reads v6. v7\'s Configuration tab notice reads "Deploying version · read-only admitted snapshot. It becomes the current version only if its deployment completes."',
    ],
  },
  deploymentRunningActivates: {
    group: "Pages/Agent detail",
    name: "New version in progress, then current",
    path: `${candidateVersion}&tab=configuration`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    // Keep the automatic full reread visible long enough to inspect its quiet presentation.
    rules: [
      {
        suffix: "/agents/agt_00000000-0000-4000-8000-000000000001",
        skip: 1,
        delayMs: 2500,
        once: true,
      },
    ],
    description:
      "v7 is deploying while v6 stays selected, then the next status poll records success and selects v7. Its notice goes from Deploying version to Current version without showing Historical version in between. The deployment and activation are simulated.",
    steps: [
      'On arrival the notice begins "Deploying version" and Selected for service reads v6.',
      "Before the status poll lands, focus Viewing version without changing its v7 selection.",
      'After the next poll and its delayed overview reread, the notice begins "Current version" and Selected for service reads v7. The picker adds Selected for service to v7 without moving focus.',
      "Reset. Open Deployment and hover Refresh deployment before the next poll. Keep the pointer still: completion and the delayed overview reread preserve the hover fill without marking the button busy.",
      "Reset and repeat, this time pressing Refresh deployment during the delayed reread. The button acknowledges immediately; one full user refresh follows the automatic read. Further presses while busy do not queue more reads.",
    ],
  },
  deploymentCompletionFocus: {
    group: "Pages/Agent detail",
    name: "Diagnostics focus when deployment completes",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    // Give the reader time to position the focused button before the terminal poll answers.
    rules: [
      {
        suffix: "/deployments/rev_00000000-0000-4000-8000-000000000007",
        skip: 1,
        once: true,
        delayMs: 12000,
      },
    ],
    description:
      "The automatic poll records a simulated completion and opens Deployment details. The focused diagnostics button stays in view if it was visible before the update.",
    steps: [
      "Collapse Deployment details, then Tab to Run diagnostics for this version. Scroll up just enough to put the entire focused button near the bottom edge of the viewport.",
      "Wait for the recorded status to read Completed. The details open and the same button stays focused and fully in view. Repeat at desktop and phone widths.",
      "At phone width, reload the preview and repeat, this time scrolling all the way to the top without changing focus. The details open on completion and the reader stays at the top with the focused button still offscreen.",
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
      'On arrival the notice begins "Deploying version" and Selected for service reads v6.',
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
      "Open Deployment before the first poll, choose folded or expanded details, and Tab to Run diagnostics for this version. The transient failure preserves that choice and the visible focused control; the selected record retains its outcome with an update-delayed label. Expanded activity keeps the last readable progress and labels the delayed update without an alert. Repeat without focusing a control: the summary must stay in place. Reset to repeat the other choice. The later completion is a terminal result, not routine pending recovery.",
      'On arrival the notice begins "Deploying version". Within about 5 s Latest visible deployment keeps "v7 · In progress" with "Update delayed" in its existing status line and the notice still begins "Deploying version".',
      'Within about 10 s the notice begins "Current version" and Selected for service reads v7, with no "Historical version" in between.',
      "After completion, hover and focus Refresh deployment, then press Enter. The hovered fill and focus stay while the busy control blocks another Enter; the selected version and tab stay unchanged.",
    ],
  },
  deploymentDeferred: {
    group: "Pages/Agent detail",
    name: "Deployment waiting for runtime",
    path: `${candidateVersion}&tab=deployment`,
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
    path: `${candidateVersion}&tab=deployment`,
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
    path: `${candidateVersion}&tab=deployment`,
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
      "The current v6 is off the first page and its own read is refused, so Current version says the reader cannot read it. The console remembers the refusal for the session, as the Agent page does, and does not ask again.",
    steps: [
      'Current version reads "A version you cannot read" in muted text, with no link and no ID, and Latest deployment reads "v7 · Failed". Beside a failed deployment, the current version may be older or newer.',
    ],
  },
  agentsCurrentVersionHidden: {
    group: "Pages/Agents",
    name: "Current version newer and unreadable",
    path: "/console/agents?namespace=ns_00000000-0000-4000-8000-000000000001",
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    // A newer v8 the viewer cannot read is current; the list shows v6 and v7 only.
    candidateSuperseded: true,
    rules: [
      {
        suffix: "/revisions/rev_00000000-0000-4000-8000-000000000008",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "Every version the reader can read is on the first page, and the current one is not among them, so the list says so without reading it. v7's deployment succeeded, so the current version is newer.",
    steps: [
      'Current version reads "A newer version you cannot read", with no link and no ID, and Latest deployment reads "v7 · Completed".',
      "The request log shows no read of the current version.",
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
      'In Viewing version, v7 includes "Failed" and v6 includes "Selected for service". The status summary also shows the latest failure.',
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
      "The Agent page header: ← Agents, the name with Refresh and Open draft at its right, then the Agent ID, Copy Agent ID and the compact Namespace control in the row under it.",
    steps: [
      "At 1440 and 1024 the 40-character name wraps on the left; Refresh and Open draft stay on its first line and nothing overlaps.",
      "Select Copy Agent ID. The ID is on the clipboard and Copied shows beside the button for two seconds.",
      "Choose Research in the Namespace control; the console opens Research's Agents list, as the header selector always has. Go Back.",
      "Select Open draft; the draft opens and its header shows Refresh only.",
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
      "At 390px the header is four rows: ← Agents with Refresh and Open draft, the name, the Agent ID with Copy Agent ID, then the Namespace control at full width. It ends by 240px.",
    steps: [
      "Check that the ID row has no trailing separator and the Namespace control spans the row.",
      "Leave the window and come back while the access recheck runs: Open draft is held with the page, and focus returns to it afterwards.",
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
  draftRetiredSetting: {
    group: "Pages/Agent detail",
    name: "Next step for a draft with a retired setting",
    path: draft,
    deployed: true,
    retiredSetting: true,
    description:
      "An older release saved this draft's security.preset, which the pinned OpenClaw has since retired. OCC refuses to deploy it, so Prepare this version shows OCC's refusal beside a disabled Deploy instead of Ready to deploy.",
    steps: [
      "In Prepare this version, the first step has an open ring with the detail Remove the retired setting.",
      "Beside Deploy new version the status reads Configuration setting security.preset must be removed: the OpenClaw runtime retired it (configure the individual security controls explicitly). Deploy is disabled.",
      "Open Configuration, remove security.preset and save: the status returns to Ready to deploy.",
    ],
    gap: "The stored setting is simulated; this story does not call OCC's deploy admission.",
  },
  credentialRejectedBindingEditor: {
    group: "Pages/Agent detail",
    name: "Rejected credential, binding editor cannot deploy",
    path: draft,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateCredentialRejected: true,
    agentPermissionSummary: {
      update: true,
      deploy: false,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: false,
      configurationRead: true,
      configurationSecretsOperate: true,
      configurationSecretsOperateDeniedBindings: [],
      agentSourcesOperate: true,
      sandboxPolicyRead: false,
      readLogs: true,
    },
    secretCallerPermissions: { update: false, delete: false },
    description:
      "Simulated recovery for an editor with Agent update, Configuration read and bound-source operate, but no Agent deploy. Secret metadata is readable; Secret update is not needed to choose an authentication source.",
    steps: [
      "Read Deployment needs attention: choose a valid authentication source in Credentials, and ask an Installation administrator for Agent deploy on it. It must not instruct this actor to deploy or offer Deploy again.",
      "Select Open Credentials. Confirm the draft Credentials tab is selected and focused, and Save authentication source is enabled. Save the selected source and check the saved feedback; Deploy new version remains unavailable.",
      "Repeat at 390px. Check the recovery message, link and keyboard focus remain usable.",
    ],
    gap: "Simulated UI proof only. Fixture saves do not enforce IAM; this story does not prove authorization, persistence, credential validity or deployment.",
  },
  credentialRejectedHiddenSecretUpdater: {
    group: "Pages/Agent detail",
    name: "Rejected credential, hidden Secret updater cannot rebind",
    path: draft,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateCredentialRejected: true,
    unreadableSecretId: "sec_demo_model",
    secretCallerPermissions: { update: true, delete: false },
    secretOperateDenied: ["sec_demo_model"],
    agentPermissionSummary: {
      update: true,
      deploy: true,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: true,
      configurationRead: true,
      configurationSecretsOperate: true,
      configurationSecretsOperateDeniedBindings: [],
      agentSourcesOperate: false,
      sandboxPolicyRead: false,
      readLogs: true,
    },
    description:
      "Simulated recovery for a known-Secret updater without Secret read or operate. Agent update and Configuration editing do not permit rebinding without source operate. Agent deploy alone does not supply Secret operate.",
    steps: [
      "Check recovery explains that replacing the value needs Secret update, choosing another credential needs operate on bound sources, and deploying also needs Secret operate. It must offer no Open Credentials recovery link.",
      "Check the draft deployment guidance also names the missing grants instead of saying update or replace it in Credentials, even though Configuration editing is available.",
      "Check recovery and draft guidance expose neither sec_demo_model nor Demo model API key (simulated). Open Credentials through its tab only to inspect the disabled authentication editor; recovery must not send the actor there.",
      "Repeat at 390px and check that the grant guidance remains readable.",
    ],
    gap: "Simulated UI proof only. The unreadableSecretId fixture hides metadata and returns 404 before Secret PATCH handling, so it cannot demonstrate a known-Secret update. secretCallerPermissions describes update separately but is not delivered for this hidden Secret. Real IAM and in-place updates require owner-run integration proof.",
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
    name: "New version uses an unavailable model",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "model_not_found" },
    description:
      "The recovery banner names the model configured for v7 and leads with Open Configuration so the operator can correct the model and deploy the same Agent.",
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
    path: `${candidateVersion}&tab=deployment`,
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
      'On arrival v7\'s Configuration tab notice begins "Deploying version". Once v7 reads Failed, it begins "Failed version" and Selected for service still reads v6.',
      "Repeat after reloading: focus Refresh record and press Enter before the next poll. Completion must also refresh the overview while preserving focus.",
      'Once v7 fails, "Deployment failed · v7" is the first card and Deployment details are folded. Open them: they show the failure\'s record and stay open.',
    ],
  },
  deploymentModelProbeRetried: {
    group: "Pages/Agent detail",
    name: "New version failed its model check after a retry",
    path: `${candidateVersion}&tab=deployment`,
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
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "model_not_found" },
    readOnlyPermissionSummary: true,
    description:
      "The viewer can read the Agent. Recovery tells them to ask a Configuration editor to choose a model and someone with deploy access to redeploy.",
    steps: [
      "Check that the recovery has one link, Open v7 Logs, and the header says Open draft. The picker includes Draft and its Configuration access.",
      "Open v7 Logs is the block's filled primary button; at 390 wide it spans the block.",
    ],
    gap: "The permission answer is simulated; the API still authorizes every page a link opens.",
  },
  deploymentModelProbeFailedDeployOnly: {
    group: "Pages/Agent detail",
    name: "New version failed, viewer may deploy",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "model_not_found" },
    agentPermissionSummary: {
      update: false,
      deploy: true,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: false,
      configurationRead: true,
      configurationSecretsOperate: false,
      configurationSecretsOperateDeniedBindings: [],
      agentSourcesOperate: false,
      sandboxPolicyRead: false,
    },
    description:
      "The viewer can deploy the Agent. Recovery tells them to ask a Configuration editor to choose a model, then redeploy after the editor saves it.",
    steps: [
      "Select Open draft and confirm the Configuration tab opens in view, focused, without deploying.",
    ],
    gap: "The failure and permissions are simulated; this story does not verify API authorization or deployment.",
  },
  deploymentModelProbeFailedConfigurationEditor: {
    group: "Pages/Agent detail",
    name: "New version failed, viewer may edit only the Configuration",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "model_not_found" },
    agentPermissionSummary: {
      update: true,
      deploy: false,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: true,
      configurationRead: true,
      configurationSecretsOperate: true,
      configurationSecretsOperateDeniedBindings: [],
      agentSourcesOperate: false,
      sandboxPolicyRead: false,
    },
    description:
      "The viewer may save the Configuration but not the Agent: an Agent update would also need operate on its Harness authentication Secret. Recovery follows the Configuration's own answer and offers Open Configuration.",
    steps: [
      "Check that Open Configuration is first. Recovery tells the editor to choose a model and ask someone with deploy access to redeploy.",
      "Select Open Configuration and confirm the draft's Configuration tab opens in view with Edit Configuration available.",
    ],
    gap: "The failure and permissions are simulated; the API still authorizes every save.",
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
  // Finding 2537: these codes read "Deployment reconciliation failed." and got the generic logs
  // advice. Messages copy deploymentErrorMessage in packages/occ/src/state/controller-work.ts.
  deploymentFailedAdmissionUnavailable: {
    group: "Pages/Agent detail",
    name: "New version failed, protected admission changed",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateFailure: {
      code: "EXECUTION_ADMISSION_UNAVAILABLE",
      message:
        "This version was admitted for protected execution that the Installation can no longer provide, for example after its Credential Proxy changed. Deploy again; if the deploy is refused, ask an Installation administrator to check the Credential Proxy.",
    },
    description:
      "v7 failed because the Installation's protected execution changed after admission. OCC's step table says deploying again can help, so the recovery offers Deploy again first and adds no logs advice.",
    steps: [
      "At 1440 and 390 wide, read the message ending with the administrator step, with no 'check the failed version's logs' sentence after it.",
      "Deploy again is the one filled button and Open v7 Logs an edged secondary button.",
    ],
    gap: "The failure is simulated; this story does not verify a live deployment.",
  },
  deploymentFailedStoredInconsistent: {
    group: "Pages/Agent detail",
    name: "New version failed, stored records inconsistent",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateFailure: {
      code: "INVALID_REVISION_OWNER",
      message:
        "The stored records for this version are inconsistent with its Agent or Namespace, so the controller did not start it and it has no runtime logs. Ask an Installation administrator to check the controller worker log for this deployment.",
    },
    description:
      "v7 failed before any runtime started because its stored records disagree with its Agent. The recovery sends the reader to an administrator and offers no Deploy again.",
    steps: [
      "At 1440 and 390 wide, confirm the message names the administrator step with no logs advice after it, and that the only action is Open v7 Logs.",
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
    candidateModelProbeCause: { kind: "PROBE_STATUS", detail: "model_not_found" },
    agentPermissionSummary: {
      update: false,
      deploy: true,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: false,
      configurationRead: false,
      configurationSecretsOperate: false,
      configurationSecretsOperateDeniedBindings: [],
      agentSourcesOperate: false,
      sandboxPolicyRead: false,
    },
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        method: "GET",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "The viewer has deploy access but cannot read the Configuration. Recovery asks them to involve a Configuration editor and someone who can redeploy, and offers only the Logs link.",
    steps: [
      "At 1440 and 390 wide, confirm the recovery shows one link, Open v7 Logs, and never shows Open draft.",
    ],
    gap: "The failure, permissions and denial are simulated; the API still authorizes every page a link opens.",
  },
  deploymentFailedAfterSelection: {
    group: "Pages/Agent detail",
    name: "Deployment failed after selection",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateSelected: true,
    description:
      "v7 is selected despite a recorded finalization failure. The timeline reports failure without claiming selection never occurred.",
  },
  deploymentStopped: {
    group: "Pages/Agent detail",
    name: "Deployment stopped by the owner",
    path: `${candidateVersion}&tab=deployment`,
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
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "failed",
    candidateSuperseded: true,
    description:
      "A newer version the viewer cannot read superseded v7 before it became current. Latest visible deployment reads v7 · Superseded with neutral stages and no failure banner, and nothing names the newer version.",
    gap: "The superseded record is simulated UI evidence; it does not verify a live deployment.",
  },
  agentCurrentVersionHidden: {
    group: "Pages/Agent detail",
    name: "Current version newer and unreadable",
    // No version in the link: the page opens the current one, v8, which the viewer cannot read.
    path: "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001",
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    candidateSuperseded: true,
    rules: [
      {
        suffix: "/revisions/rev_00000000-0000-4000-8000-000000000008",
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "Every version the reader can read is on the first page of versions, and the current one is not among them, so the page names it as the Agents list does and does not read it. v7's deployment succeeded, so the current version is newer.",
    steps: [
      'Selected for service reads "A newer version you cannot read"; the line under the version chooser reads "A newer version you cannot read remains selected for service." and the status line "The current version is one you cannot read; v7 is an older version." No raw version ID shows.',
      "The request log shows no read of the current version.",
      "Switch to another window and back: the page checks the session, the Agent and its versions again and keeps this page. The request log still shows no read of the current version.",
    ],
  },
  agentCurrentVersionHiddenLogs: {
    ...hiddenCurrentLogsPage,
    name: "Logs of a current version the viewer cannot read",
    description:
      "An operator opens Logs on a current version she cannot read. Runtime status also needs AgentRevision read on it, so the page does not read it and says why in words; log text, which needs no version read, still shows.",
    steps: [
      'The runtime strip reads "You cannot read this version, so its runtime status is not shown. Ask an Installation administrator for AgentRevision read on it." with no Request ID.',
      "The request log shows no /runtime status read and no read of the current version; log output still loads.",
    ],
    gap: "Simulated UI proof: it does not verify the API's refusal of the status read.",
  },
  agentCurrentVersionHiddenLogsStopped: {
    ...hiddenCurrentLogsPage,
    name: "Logs of a current version the viewer cannot read, stopped elsewhere",
    stopElsewhereOnReread: true,
    description:
      "The operator has Logs open on the current version, which she cannot read. Another person stops the Agent. The Logs view reads no runtime status for this version, so it says in place that a stop was requested (finding 3012), as the summary does.",
    steps: [
      "Wait for the next Agent reread (at most 10 seconds). The summary reads Selected for service None.",
      "Check the Logs view under the runtime status: “Stop requested. This Agent will not start again until a new version is deployed.” It says nothing else about the version. Focus and the Logs view stay where they were, at 1440 and at 390 px wide.",
      "The request log shows only Agent reads: no /runtime status read and no read of the version.",
    ],
    gap: "Simulated UI state only; this preview does not prove a live stop or the screen reader announcement.",
  },
  deploymentSucceeded: {
    group: "Pages/Agent detail",
    name: "New version activated",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [
      {
        method: "GET",
        suffix: "/deployments/rev_00000000-0000-4000-8000-000000000007",
        skip: 1,
        delayMs: 1800,
      },
    ],
    description:
      "v7 is now selected and its original deployment recorded success. This remains historical evidence, not a live probe.",
    steps: [
      "Focus Refresh record and press Enter. While Refreshing… is shown, the button keeps focus and repeated Enter or Space does not start another read. Completion leaves focus on Refresh record.",
      "Refresh again and press Tab before the response arrives. Completion leaves focus on the control you moved to.",
    ],
  },
  deploymentRecordRefused: {
    group: "Pages/Agent detail",
    name: "Selected record refusal clears shared evidence",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [
      {
        method: "GET",
        suffix: "/deployments/rev_00000000-0000-4000-8000-000000000007",
        skip: 1,
        once: true,
        status: 403,
        code: "FORBIDDEN",
      },
    ],
    description:
      "A selected-record refresh loses access to the same version shown in Deployment activity. Both panels clear their previous evidence.",
    steps: [
      "Read the completed record, focus Refresh record, and press Enter. Both panels must show the refusal, with no completed outcome remaining.",
      "Focus remains on Refresh record. Fold and unfold Deployment details: only the visible leading refusal owns the alert role.",
      "Refresh record again after the one-time refusal. Both panels recover to Completed and the overview refreshes once. Repeat on the settled record: its overview does not reread.",
    ],
    gap: "Simulated UI proof only. The deployment browser suite verifies native IAM denial, missing records, stale deliveries, recovery, and version isolation with the real controller.",
  },
  deploymentActivityLoading: {
    group: "Pages/Agent detail",
    name: "Deployment activity loading",
    path: `${candidateVersion}&tab=deployment`,
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
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "running",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007",
        status: 503,
      },
    ],
    steps: [
      "Fold Deployment details. The selected record still shows the read error outside the fold with one visible alert. Expand again: the activity owns that alert instead of announcing it twice.",
      "Fold and press Refresh deployment. The same failed read opens the details again; this explicit action differs from a routine transient poll.",
    ],
    description:
      "The latest deployment record cannot be read. Version history and the selected version remain distinct from the status error.",
  },
  diagnosticsSuccess: {
    group: "Pages/Agent detail",
    name: "Current observations for v7",
    path: `${candidateVersion}&tab=deployment`,
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
    path: `${candidateVersion}&tab=deployment`,
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
  diagnosticsNoSlack: {
    group: "Pages/Agent detail",
    name: "Current observations for a version without Slack",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    diagnosticsState: "noSlack",
    actions: [click("Run diagnostics for this version")],
    description:
      "The gateway reports a version with no Slack channel as a failed configuration check with code NOT_CONFIGURED. The rows read not set up and not checked, and the note says there is nothing to check.",
  },
  diagnosticsReader: {
    group: "Pages/Agent detail",
    name: "Current observations for a reader without operate",
    path: `${candidateVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    agentPermissionSummary: { update: true, deploy: true, operate: false, delete: true },
    description:
      "Diagnostics need Agent operate. For a viewer whose permission answer denies it, Run diagnostics is disabled and says why, and the danger zone has no Stop row.",
    steps: [
      "Tab to Run diagnostics for this version. It takes focus and looks unavailable, its description is the note under it, and Enter, Space or a click runs nothing.",
    ],
    gap: "The permission answer is simulated; the API still authorizes every request.",
  },
  diagnosticsRefused: {
    group: "Pages/Agent detail",
    name: "Current observations refused",
    path: `${candidateVersion}&tab=deployment`,
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
    path: `${candidateVersion}&tab=deployment`,
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
      "The first runtime status takes 1.2 s after the Logs tab is selected. The Logs panel reserves space for the strip and output.",
    steps: [
      "Scroll to the version tabs and select Logs. The area keeps its height. After 1.2 s the strip and output appear and the panel scrolls into view.",
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
      "The Gateway Pod is Ready with no restarts; its startup readiness-probe Event is listed in muted text as an earlier warning instead of in the warning color. With no restart there is no previous instance, and a note under the log toolbar says so.",
    steps: [
      "Tab through the log controls. Previous instance takes focus and looks unavailable, described by “This container has not restarted, so there is no previous instance.” Space or a click does not check it (finding 2944).",
    ],
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
  runtimeLogsMissingAgentPod: {
    ...runtimeLogsPage,
    name: "Gateway logs with no current Agent Pod",
    runtimePod: "missingAgent",
    actions: [{ selector: "#runtime-log-source", value: "gateway" }],
    description:
      "A simulated dedicated Agent source remains listed when no current Agent Pod is reported. Gateway logs show the note without claiming the Agent never started.",
    steps: [
      "Keep Gateway selected and check the note: No current Agent (Harness) Pod was reported. Check Deployment activity for the latest status.",
    ],
    gap: "Simulated UI state only; this preview does not prove a live Pod transition.",
  },
  runtimeLogsNoPod: {
    ...runtimeLogsPage,
    name: "Logs of a version with no running Pod",
    runtimePod: "none",
    description:
      "The version has no running Pod, so Previous instance, Follow, Refresh logs and Download are unavailable, and the output status says why.",
    steps: [
      "Tab through the log controls. Previous instance, Follow, Refresh logs and Download each take focus and look unavailable, described by “This version has no running Pod for this source.” Enter, Space or a click does nothing (finding 2929).",
    ],
    gap: "Simulated UI state only; this preview does not prove a live Pod transition.",
  },
  runtimeLogsReplacedVersion: {
    ...runtimeLogsPage,
    name: "Logs of a version stopped and replaced since",
    path: `${currentVersion}&tab=logs`,
    runtimePod: "replaced",
    description:
      "v6 has no running Pod: it was stopped and v7 is now selected for service. The Logs view keeps v6, says it has no running Pod, and names v7 with a link to its Logs.",
    steps: [
      "Check the notice under the runtime status: “v7 is selected for service.” with Open v7 Logs. The version picker still shows v6, and its log controls stay unavailable, described by “This version has no running Pod for this source.” (finding 2975).",
      "Select Open v7 Logs. The page opens v7's Logs with its running Gateway Pod and no notice.",
    ],
    gap: "Simulated UI state only; this preview does not prove a live stop and redeploy.",
  },
  runtimeLogsFailedRedeploy: {
    ...runtimeLogsPage,
    name: "Logs of a stopped version after a failed redeploy elsewhere",
    stopped: true,
    stopNoSelection: true,
    runtimePod: "none",
    failedRedeployOnReread: true,
    description:
      "v7 was stopped, so no version is selected and its Pods are gone. While its Logs are open, another person deploys v8, and v8's startup model check times out: the Agent runs again with no version selected. The Logs status poll rereads the Agent and, finding it running with no version selected, lists the versions again: the page shows v8's failed deployment (finding 2978), and the Logs view says so in place under its runtime status (finding 2993).",
    steps: [
      "Wait for the Logs view to say “This version has no running Pod for this source.” The summary reads Latest visible deployment v7 · Completed and Selected for service None.",
      "Wait for the next status poll (10 seconds). The summary then reads Latest visible deployment v8 · Failed, and Deployment needs attention leads with v8's timed-out model check.",
      "Check the Logs view under the runtime status: “v8 failed its startup model check.” with the same next step and no error code, and View v8 deployment. Focus and the scroll position stay where they were; at 390 px wide the line is in view under the Runtime heading.",
      "Open the version picker: v8 is listed above v7.",
    ],
    gap: "Simulated UI state only; this preview does not prove a live stop, redeploy or deployment failure.",
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
      "Tab through Source, Previous instance, Include debug, Follow, Refresh logs and Download. Each takes focus and looks unavailable, its description is the permission message, and Enter, Space, a click or an arrow key changes nothing.",
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
  runtimeLogTextDenied: {
    group: "Pages/Agent detail",
    name: "Runtime status and log text refused",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deployments/rev_00000000-0000-4000-8000-000000000007/runtime",
        status: 403,
        code: "FORBIDDEN",
      },
      refuseLogRead,
    ],
    description:
      "A reader with neither Agent operate nor Agent read_logs. The status line names the grants runtime status and log text need, in the API's words, and that an Installation administrator gives them.",
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
  configurationReadDeniedReloadRefocus: {
    group: "Pages/Agent detail",
    name: "Configuration read denied across reload and refocus",
    path: draft,
    rules: [
      {
        method: "GET",
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
        status: 403,
      },
    ],
    description:
      "The draft Configuration is never readable. Its repeated permission denial preserves the permitted Agent after reload and a fresh refocus check.",
    steps: [
      "Confirm the Agent heading and Configuration unavailable are visible together. This is a persistent 403, not a 503 or unreadable saved data.",
      "Reload the Storybook preview page in the browser. The same tab remembers the exact denied path and still shows the partial Agent.",
      "Focus another browser tab, then return to the Console preview. Refocus sends a fresh Configuration GET returning 403; the Agent remains visible without draft editors.",
      "Choose Retry to perform another denied read. Repeat at phone width. No Save action is available for the unreadable draft.",
      "For Save recovery, follow Channel binding read denied and the binding preflight workflow: Save, inspect the scrubbed refusal, Refresh, then explicitly save again.",
    ],
    gap: "Simulated permission responses through the production Console; Native IAM browser regressions cover real authorization. See unreadable-configuration-workflow.md for reload, refocus, and Save recovery instructions.",
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
      "Select v1 to inspect its admitted configuration, then return to Open draft to see the unreadable draft.",
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
      "Select Open draft. The healthy current draft remains editable independently of the unreadable historical snapshot.",
    ],
  },
  deploymentSnapshotUnavailable: {
    group: "Pages/Agent detail",
    name: "Deployment snapshot unavailable",
    path: `${currentVersion}&tab=deployment`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    rules: [
      { suffix: "/revisions/rev_00000000-0000-4000-8000-000000000006", status: 503, once: true },
    ],
    description:
      "A historical version's snapshot read fails while Deployment is open. Its error and Retry stay visible beside the latest deployment's activity.",
    steps: [
      "Read Configuration unavailable inside Deployment. The latest deployment remains separate from the viewed version's failed snapshot read.",
      "Choose Retry. The same historical version and Deployment tab stay selected, and its deployment record and diagnostics appear.",
      "Repeat at phone width. Switching to Configuration also shows the snapshot error until Retry succeeds.",
    ],
    gap: "Simulated UI proof; browser regressions exercise recovery through the controller API.",
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
  tabLinkUnavailable: {
    group: "Pages/Agent detail",
    name: "Link to an unavailable tab",
    path: `${draft}&tab=bogus`,
    description:
      "A link names a tab this Agent page does not have. The page shows Configuration with a note above it that names the tab and says Configuration is shown instead.",
    steps: ["Read the note above the panel, then choose Plugins: the note goes away."],
    gap: "The link is simulated; a reader without Installation administration gets the same note for the Access tab.",
  },
  deploySecretOperateDenied: {
    group: "Pages/Agent detail",
    name: "Deployment needs Secret operate",
    path: draft,
    secretOperateDenied: ["sec_demo_model"],
    description:
      "The Agent's Secret answer lists the draft's model Secret as readable but not operable for this caller. Deploying needs Secret operate on every Secret the draft binds, so Deploy new version is disabled and the note beside it names the Secret and who grants it.",
    steps: [
      "Read the note beside Deploy new version: it names Demo model API key (simulated) and asks an Installation administrator to grant Secret operate.",
    ],
    gap: "The Secret answer is simulated; the API still authorizes the deployment and every Secret it binds.",
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
          "Agent agt_00000000-0000-4000-8000-000000000001 cannot use Secret sec_00000000-0000-4000-8000-000000000001: the Agent itself needs Secret operate on it. Ask an Installation administrator to give the Agent access, then deploy again.",
      },
    ],
    actions: [click("Deploy new version")],
    description:
      "A denial for the Agent's own service principal names the grant the Agent lacks and who gives it. The Secret is named only to a caller who may read it. A caller's own denial keeps the console's guidance.",
  },
  deploySandboxPolicyReadDenied: {
    group: "Pages/Agent detail",
    name: "Deployment needs SandboxPolicy read",
    path: draft,
    rules: [
      {
        path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/deploy",
        method: "POST",
        status: 403,
        code: "FORBIDDEN",
        message:
          "Not authorized: this needs SandboxPolicy read on SandboxPolicy sbp_00000000-0000-4000-8000-000000000001. Ask an Installation administrator to grant it.",
      },
    ],
    actions: [click("Deploy new version")],
    description:
      "The Agent's network policy has saved rules, so deploying also needs SandboxPolicy read on it. The API's denial names the policy by its ID; the alert under Deploy new version names it in words and says who grants the read.",
    steps: [
      'The alert reads "Deploying this Agent needs SandboxPolicy read on its network policy, which your access does not include. Ask an Installation administrator to grant it." No sbp_ ID shows.',
      "Deploy new version is enabled again for a retry after a grant.",
    ],
    gap: "The refusal is simulated; the API decides whether the policy has saved rules and whether the caller may read it.",
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
  navigationDrawerScroll: {
    group: "Components/Navigation",
    name: "Compact drawer scroll position",
    path: "/console/secrets?namespace=ns_00000000-0000-4000-8000-000000000001",
    mobile: true,
    description:
      "The compact drawer keeps the document in place while its own contents scroll. API responses are simulated.",
    steps: [
      "At 390×480, open navigation and press Page Down on the focused link. Wheel over the overlay: the Secrets page behind it stays in place.",
      "Choose Namespaces, then use Back. The Secrets heading and search return in view.",
      "Open navigation and press Escape. Scroll Secrets normally. Reopen navigation, widen past 760px, and check that desktop scrolling is available.",
    ],
  },
  ...channelsScenarios({
    click,
    draft,
    revision,
    presetSecretsPath,
    reservedConfigurationWrite,
  }),
  ...credentialsScenarios({ draft, reservedConfigurationWrite }),
  authenticationReadDenied: {
    group: "Pages/Agent detail",
    name: "Authentication Save read denied",
    path: `${draft}&tab=credentials`,
    rules: [
      {
        method: "GET",
        suffix: "/agents/agt_00000000-0000-4000-8000-000000000001",
        skip: 1,
        status: 403,
        once: true,
      },
    ],
    description:
      "The Agent becomes unreadable before authentication Save. The contextual receipt remains while the Agent name, authentication binding and editors are removed.",
    steps: [
      "Select Save authentication source. Read the Save refusal and request ID; no editor or binding remains.",
      "Select Refresh after the one-shot refusal. Saved state returns without replaying Save.",
    ],
  },
  configurationSaveReadDenied: {
    group: "Pages/Agent detail",
    name: "Configuration Save read denied",
    path: draft,
    rules: [
      {
        method: "GET",
        suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
        skip: 1,
        status: 403,
        once: true,
      },
    ],
    actions: [click("Enable gateway password access")],
    description:
      "A staged Configuration edit loses read access before Save. The entire protected editor is retired with its causal receipt, and no PATCH starts.",
    steps: [
      "Select Save Configuration. Confirm the staged document disappears and the read-access reason remains.",
      "Refocus to see the partial Agent with Configuration unavailable. Select Retry after access recovers; the unsaved edit must not return.",
    ],
  },
  ...credentialsRecoveryScenarios({ draft }),
  nativeAdmin: {
    group: "Components/Native admin",
    name: "Available",
    path: revision,
    deployed: true,
    nativeAdmin: "available",
    description:
      "Open Agent UI appears in the header after access is verified. Its target, scope, and Gateway managed-mode warning remain visible. The link opens a simulated fixture.",
    steps: [
      "Check the selected version, completed deployment, and unverified live serving at desktop and phone widths.",
      "Open Deployment and expand Deployment details, then use Open Agent UI directly. Compare Denied and hidden: there is no launch or access warning there.",
    ],
  },
  nativeStopped: {
    group: "Components/Native admin",
    name: "Stopped",
    path: draft,
    nativeAdmin: "stopped",
    description:
      "The native-admin panel reports that the Agent must be started. The header's Open Agent UI stays in the Tab order, unavailable, and its description names that reason.",
    steps: [
      "Tab to Open Agent UI in the header. It takes focus, looks unavailable, and pressing Enter opens nothing.",
    ],
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
  nativeAvailableAfterDeploy: {
    group: "Components/Native admin",
    name: "Available once a deployment completes",
    path: `${candidateVersion}&tab=configuration`,
    deployed: true,
    candidateDeploymentStatus: "running",
    candidateActivates: true,
    nativeAdmin: "available",
    // The first access check finds no version serving; the reread after the deployment completes
    // finds the new version available.
    rules: [{ suffix: "/native-admin", once: true, data: { status: "unavailable" } }],
    description:
      "v7 is deploying, so Open Agent UI is unavailable. When the next status poll records success, the page rereads access and the live Open Agent UI link replaces the button in the same place. Keyboard focus moves with it.",
    steps: [
      "Before the status poll lands, Tab to Open Agent UI in the header. It is unavailable and its description says no version is serving.",
      "Wait for the poll. The live Open Agent UI link replaces the button and keeps focus: press Tab once and focus moves to the next header control, not to the start of the page.",
    ],
    gap: "The deployment, its activation and native admin access are simulated.",
  },
  agentDetailLayout: {
    group: "Pages/Agent detail",
    name: "Agent detail layout",
    path: candidateVersion,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    nativeAdmin: "available",
    description:
      "Compact Agent status, a version picker, Deployment details, direct Agent UI access, and live workspace file roles.",
    steps: [
      "Browse v6 using Viewing version. The Agent UI target and Selected for service stay on v7.",
      "Open Deployment for historical records and diagnostics. Open Logs for runtime output.",
      "Open Workspace files. Choose each file, read its role, and edit one. Unsaved marks that file until Save or Reload.",
      "Open Agent UI directly in a new tab. Review the scope and Gateway managed-mode warning.",
    ],
    gap: "Simulated UI proof; no backend persistence, credential delivery, or live runtime execution.",
  },
  deploymentEmpty: {
    group: "Pages/Agent detail",
    name: "No deployment history",
    path: `${draft}&tab=deployment`,
    description:
      "The saved draft has no deployment records. Deployment stays available without reading its Configuration; the empty state does not claim live health.",
  },
  workspaceLoading: {
    group: "Components/Workspace",
    name: "Loading files",
    path: `${revision}&tab=workspace`,
    deployed: true,
    rules: [
      {
        prefix:
          "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/workspace/files/",
        delayMs: 3000,
      },
    ],
    description:
      "File selection and role descriptions remain available during reads. Each file shows Loading and disables its editor until the read finishes.",
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
    ],
    description: "File edits, including empty text, survive tabs and pages until Save or Reload.",
    steps: [
      "Choose User context and clear its text. Switch between Instructions and User context; check the Unsaved indicators and role descriptions. On a phone use Workspace file.",
      "Switch to Configuration and back to Workspace files; the selected file and unsaved contents remain.",
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
      "Choose Instructions (AGENTS.md), Personality (SOUL.md), Identity (IDENTITY.md), or User context (USER.md). Each file has a role description and its own Save and Reload. Changes apply to the live workspace.",
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
    description:
      "Workspace editing requires a deployed Agent and reachable gateway; the note says to deploy the Agent.",
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
    gap: "Simulated files and the first permission answer only. Operate answer on return covers a later grant and revocation while this editor stays mounted. The API still refuses the write.",
  },
  workspaceOperateRestored: {
    group: "Components/Workspace",
    name: "Operate answer on return",
    path: `${revision}&tab=workspace`,
    deployed: true,
    agentPermissionSummary: { update: true, deploy: true, operate: false, delete: true },
    rules: [
      { suffix: "/runtime", status: 403 },
      {
        suffix: "/agents/agt_00000000-0000-4000-8000-000000000001/permissions",
        // Keep the initial read and first Logs recheck denied.
        skip: 2,
        once: true,
        data: { update: true, deploy: true, operate: true, delete: true },
      },
    ],
    actions: [
      { selector: "#workspace-operate-denied" },
      { selector: '[id="workspace-AGENTS.md"][readonly]' },
      click("Logs"),
      { text: "Runtime status requires Agent operate" },
      click("Workspace files"),
      { selector: "#workspace-operate-denied" },
      click("Logs"),
      { text: "Runtime status requires Agent operate" },
      click("Workspace files"),
      click("Configuration"),
      { selector: "#agent-stop-title" },
      click("Deployment"),
      { selector: ".version-diagnostics .deployment-heading button:not(:disabled)" },
      click("Workspace files"),
      {
        selector: 'textarea[id="workspace-AGENTS.md"]:not([readonly])',
        value: "kept across the revocation",
      },
      click("Logs"),
      { text: "Runtime status requires Agent operate" },
      click("Workspace files"),
      { selector: '[id="workspace-AGENTS.md"][readonly]', matches: "kept across the revocation" },
    ],
    description:
      "Workspace files stay parked while Logs reads a newer Agent operate answer. A grant makes them editable on return, shows the Stop row and enables Run diagnostics. A revocation makes them read-only again, keeps unsaved text, hides Stop and disables Run diagnostics.",
    steps: [
      "Workspace files open read-only, with the note that saving needs Agent operate. Open Configuration to check that the Danger zone has no Stop row.",
      "Logs records the runtime-status refusal. Returning to Workspace files keeps that note.",
      "The next Logs visit reads an operate grant. Returning hides the note, AGENTS.md is editable, Configuration offers Stop, and Deployment offers Run diagnostics.",
      "After the edit, the following Logs visit reads a revocation. Returning keeps the unsaved text and makes AGENTS.md read-only; Stop hides and Run diagnostics is disabled with its reason.",
    ],
    gap: "The permission changes and runtime refusal are simulated. The preview checks Stop and Run diagnostics after the grant only; the browser test also checks them after the revocation, changing the controller's real IAM policy across the same tab visits. A failed permission read is not shown; the page keeps the previous answer. The controller still authorizes every write.",
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
      "IDENTITY.md keeps its Missing indicator in the desktop tabs and phone picker, with no reread warning. A later confirmed-missing read clears a previous Needs attention indicator; the browser regression covers that recovery.",
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
      "Watch the open confirmation explain the restriction, make Permanently delete Agent unavailable, and move focus to Cancel. Tab to it: it takes focus, described by the restriction, and Enter, Space or a click sends nothing (finding 2935).",
      "Cancel or press Escape. The page explains why Delete is unavailable, without sending a delete request; Delete Agent stays in the Tab order, described by that note.",
    ],
  },
  deletionConfirm: {
    group: "Components/Deletion",
    name: "Confirmation",
    path: draft,
    actions: [click("Delete Agent")],
    description:
      "The confirmation names what will be permanently deleted and what stays in the Namespace. Open View separate cleanup commands to find the full resource IDs.",
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
      "A manual repeated deletion requires confirmation. Queued or running cleanup remains unchanged, and separate cleanup commands stay collapsed until opened.",
  },
  deletionRetryAccessEnded: {
    group: "Components/Deletion",
    name: "Status access ends during repeat confirmation",
    path: draft,
    deleting: true,
    rules: [{ suffix: "/agents/agt_00000000-0000-4000-8000-000000000001", skip: 1, status: 403 }],
    actions: [click("Request deletion again")],
    description:
      "The Agent was already marked for deletion. The next status check is refused while the repeat confirmation is open.",
    steps: [
      "Leave the confirmation open. It closes when the status check returns, without sending another deletion request.",
      "Focus returns to Delete Agent. The notice says you can no longer check whether cleanup finished.",
    ],
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
      { selector: ".agent-delete-dialog button.danger", click: true },
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
        code: "FORBIDDEN",
        message:
          "Not authorized: this needs Agent delete on Agent agt_00000000-0000-4000-8000-000000000001. Ask an Installation administrator to grant it.",
      },
    ],
    actions: [click("Delete Agent"), click("Permanently delete Agent")],
    description:
      "Permission advice is unavailable. The attempted deletion is denied; the Console names the Agent, the missing grant and who grants it, keeps the Request ID, and leaves Delete Agent unavailable, described by the refusal.",
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
        code: "RESOURCE_CONFLICT",
        message: "The Agent lifecycle changed during deletion.",
      },
    ],
    actions: [click("Delete Agent"), click("Permanently delete Agent")],
    description:
      "The API's conflict reason shows with the step that recovers: refresh deletion status before retrying.",
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
    steps: [
      "Tab to Delete Agent. It takes focus and looks unavailable, described by the Outcome unknown alert; Enter, Space or a click sends nothing (finding 2935).",
    ],
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
    fixturePluginCatalog: /** @type {const} */ (true),
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
    name: "DevDay segment 1 checkpoint: first deployment queued",
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
    fixturePluginCatalog: /** @type {const} */ (true),
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
      "Click Open Agent UI. The target fixture opens with an existing #openclaw-feedback message.",
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
      "Choose v1 in Viewing version and open Channels: it still has the original settings.",
      "Select Open draft, then Deploy new version. The saved draft is deployed, not the viewed snapshot.",
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
      "Watch the open confirmation explain the restriction, make Stop Agent unavailable, and move focus to Cancel. Tab to it: it takes focus, described by the restriction, and Enter, Space or a click sends nothing (finding 2935).",
      "Cancel or press Escape. The page explains why Stop is unavailable, without sending a stop request; Stop Agent stays in the Tab order, described by that note.",
    ],
  },
  dangerZoneTabs: {
    group: "Pages/Agent detail",
    name: "Danger zone on Configuration",
    path: `${revision}&tab=workspace`,
    deployed: true,
    stopped: true,
    description:
      "Compare the Workspace files and Configuration tabs for an Agent with a stop request.",
    steps: [
      "Workspace files opens directly. Scroll to the end of the tab.",
      "Select Configuration and scroll to Danger zone. Check the stop status, Request Stop again, Refresh stop status and Delete Agent.",
      "Return to Workspace files. The lifecycle controls disappear.",
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
      "For the revision clearing after Stop, use Flows / Stop an Agent.",
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
      "The requested state is stopped with a selected revision. The overview shows Runtime: Stop requested. The Stop row replaces its action description with the result and restart guidance; shutdown completion is not verified here.",
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
      "An explicit repeated Stop preserves the selected version. Its confirmation says the Agent is already requested to stop and that this sends the request again, not that it interrupts a running gateway (finding D815). Cancel or Escape returns keyboard focus to Request Stop again.",
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
  stopFirstDeploymentFailed: {
    group: "Components/Stop Agent",
    name: "Failed first deployment",
    path: draft,
    deployed: true,
    firstDeploymentFailed: true,
    description:
      "A failed readable deployment leaves the Agent requested to run with no selected version. Stop stays available because a newer queued deployment may be unreadable.",
    gap: "Simulated UI proof only; this preview does not run a deployment.",
  },
  stopFirstDeploymentQueued: {
    group: "Components/Stop Agent",
    name: "First deployment queued",
    path: draft,
    deployed: true,
    firstDeploymentQueued: true,
    actions: [click("Stop Agent")],
    description:
      "A queued first deployment has no selected version yet. Stop stays, and its row and confirmation say it cancels the deployment in progress instead of interrupting a gateway. Confirming reports cancellation requested, not completed; later lifecycle reads retire that local result.",
    gap: "Simulated UI proof only; this preview does not run a deployment.",
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
      {
        suffix: "/stop",
        method: "POST",
        status: 403,
        code: "FORBIDDEN",
        message:
          "Not authorized: this needs Agent operate on Agent agt_00000000-0000-4000-8000-000000000001. Ask an Installation administrator to grant it.",
      },
    ],
    actions: [click("Stop Agent"), { selector: ".agent-stop-dialog button.danger", click: true }],
    description:
      "Permission advice is unavailable. The attempted stop is denied; the Console names the Agent, the missing grant and who grants it, keeps the Request ID, and leaves Stop Agent unavailable, described by the refusal.",
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
      "Select Configuration and open Stop Agent. Review the confirmation.",
      "Confirm Stop Agent. The result stays in view, focus moves to Refresh stop status, and the current version still has file editors.",
      "Select Refresh stop status. The fixture clears the current version.",
      "Open Workspace files. It explains why the files are unavailable. Return to Configuration.",
      "Focus Request Stop again, press Enter, then Cancel or Escape. Focus returns to Request Stop again without submitting. Reopen and confirm if recovery is needed; refresh an uncertain outcome before retrying.",
      "Return to Open draft and Deploy new version to request running again.",
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
      "Read what stays in the Namespace. Open View separate cleanup commands to copy a command without running it.",
      "Cancel once to inspect the safe exit, then reopen and confirm Permanently delete Agent.",
      "The page marks deletion requested, removes edit/deploy controls, and keeps confirmed manual recovery available.",
      "Click Refresh deletion status. The fixture now reports completion and the console returns to the Agent list.",
    ],
    gap: "The console reports deletion status but provides no detailed cleanup-progress view. Configurations and Secrets remain Namespace-owned and need separate management.",
  },
};

for (const [id, state, name] of [
  ["policyDenials", "ready", "Policy denials and reviewed network additions"],
  ["policyUnicodeExecutable", "unicode", "Unicode executable path remains complete"],
  ["policyDenialsMany", "many", "Two hundred denials with batch approval"],
  ["policyRulesPopulated", "populated", "Manage ten applied network rules"],
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
  [
    "policyApplicationCeilingChanged",
    "failedCeiling",
    "Policy application refused by a changed ceiling",
  ],
  ["policyDenialsApplyRejected", "applyRejected", "Policy saved but live application rejected"],
  ["policyDenialsApplyDenied", "applyDenied", "Policy saved but live application refused access"],
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
  ["policyDenialsWithheldOne", "withheldOne", "One policy record withheld since the last refresh"],
  [
    "policyDenialsWithheldMany",
    "withheldMany",
    "Multiple policy records withheld since the last refresh",
  ],
]) {
  scenarios[id] = {
    group: "Pages/Agent detail",
    name,
    path: `${candidateVersion}&tab=policy`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
    policyState: state,
    ...(["many", "populated"].includes(state)
      ? { policyDenialCount: 200, policyRuleCount: 10, policyNewDenials: 12 }
      : {}),
    ...(state === "withheldOne" ? { policyWithheld: 1 } : {}),
    ...(state === "withheldMany" ? { policyWithheld: 2 } : {}),
    ...(state === "discoveryLoading"
      ? { rules: [{ suffix: "/driver-configurations", hold: true }] }
      : {}),
    ...(state === "discoveryDenied"
      ? { rules: [{ suffix: "/driver-configurations", status: 403 }] }
      : {}),
    ...(state === "editDenied"
      ? { rules: [{ method: "PATCH", suffix: "/sandbox-policy/networking/editing", status: 403 }] }
      : {}),
    ...(state === "stalePreview" ? { rules: [{ suffix: "/validate", delayMs: 3000 }] } : {}),
    description:
      "Observed denial records, aggregated provider suggestions, and governed policy additions remain distinct.",
    steps: [
      ...(state === "many"
        ? [
            "Scroll to Denials. The pager is the last control below the five rows. Go to page 2 and turn on Follow. The page stays in place when 12 new denials arrive. Choose Show newest to see page 1 of 43 with 212 loaded denials.",
          ]
        : []),
      "Expand a denial to inspect the sanitized log. Review its exact executable and endpoint before saving an addition.",
      "Select denial rows across pages, then Allow selected. Confirm the validated proposal retains existing rules and combines repeated executable/host/port requests. Back to editing preserves the draft.",
      "Open Manage rules. Search the five-row pages, use a row menu to edit or remove a rule, or Add rule. Compare Save for later with Save and apply to current revision. Apply saved rules is unavailable while a proposal has unsaved edits.",
      "Use the Policy editing switch in the Network policy card on the page. Open Manage rules and confirm the editing toggle is absent, saved rules remain, and Add rule follows the editing setting. Close the dialog to re-enable editing. Check the empty, denied, unsupported, missing metadata, and unconfirmed stories.",
    ],
    gap: "Simulated UI proof only. These fixtures do not prove authorization, persistence, enforcement, or provider policy activation.",
    ...(state === "unicode"
      ? {
          description:
            "A normalized executable path has 281 Unicode code points and 551 UTF-16 code units, within the API schema's 512-code-point limit.",
          steps: [
            "Expand Policy details, then Read-only Installation defaults. The JSON is indented and the executable path wraps inside the block, even on a phone.",
            "Open View network limits and copy the full executable path from the Installation ceiling. Close the dialog, choose Review suggestion, then paste the copied path into Executable path. Confirm the value still ends with /tool.",
            "Choose Review changes. Confirm the complete executable path, including /tool, appears in Proposed rules. Choose Save for later and confirm policy v2 keeps that same path while the current revision stays unchanged.",
            "Reset the story to repeat. The six directory components each contain 45 Deseret letters (U+10400); the path is 1091 UTF-8 bytes.",
          ],
          gap: "Simulated UI proof only. This story does not validate a real executable, save to OCC, apply OpenShell policy or start a workload.",
        }
      : {}),
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
            "Open Manage rules. The protected execution notice is visible, adding and editing are disabled, and live application is unavailable.",
            "A rule saved before protected execution applied blocks every protected deploy. Choose Remove saved network rules, review the removal, then Save for later and confirm the saved policy is empty.",
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
    ...(state === "applyDenied"
      ? {
          rules: [
            {
              method: "POST",
              suffix: "/sandbox-policy/networking/apply",
              status: 403,
              code: "FORBIDDEN",
            },
          ],
          steps: [
            "Review a suggestion, then choose Review changes and Save and apply to current revision.",
            "The simulated apply answers 403, as when SandboxPolicy read is revoked while the page is open. Confirm the alert says the policy was saved but not applied, and names Agent manage_policy and SandboxPolicy update and read.",
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
    ...(state === "withheldOne"
      ? {
          description:
            'The Denials tab shows a warning banner when sandbox records are withheld. One withheld record uses the singular "record".',
          steps: [
            'Check the warning banner above the denial list. It reads "1 record withheld since the last refresh." Confirm the singular form.',
          ],
        }
      : {}),
    ...(state === "withheldMany"
      ? {
          description: 'Two withheld records: the warning banner uses the plural "records".',
          steps: [
            'Check the warning banner above the denial list. It reads "2 records withheld since the last refresh." Confirm the plural form.',
          ],
        }
      : {}),
  };
}

// An Installation that selects no Sandbox Driver: the API names that cause instead of the
// Driver's missing capability (D774).
scenarios.policyDenialsNoSandboxDriver = {
  ...scenarios.policyDenialsUnsupported,
  name: "Installation selects no Sandbox Driver",
  policyNoSandboxDriver: true,
  description:
    "The Policy denials tab says once that Agents run without a Sandbox, and offers no policy editor.",
  steps: [
    "Confirm the single status sentence names the missing Sandbox Driver, and that the Policy editing switch and Manage rules are absent.",
  ],
};

// Collaborator-only approval exercises the same editor as the legacy default story.
const collaboratorRepositoryOptions = [
  {
    repositoryRef: "application",
    displayName: "example/application",
    allowedProfiles: ["github-repository", "github-installation"],
  },
  {
    repositoryRef: "api-only",
    displayName: "example/api-only",
    allowedProfiles: ["github-installation"],
  },
  {
    repositoryRef: "handbook",
    displayName: "example/handbook",
    allowedProfiles: ["git-read"],
  },
];
scenarios.repositoryCollaborator = {
  ...scenarios.repositoryEditor,
  name: "Select repository collaborator from an empty set",
  repositoryOptions: collaboratorRepositoryOptions,
  repositoryAccess: { defaultProfile: "git-full", repositories: [] },
  repositoryBindings: [],
  description:
    "An empty selection offers the approved collaborator repository. API-only access is not a Git repository choice; the existing Contributor default stays unchanged.",
  steps: [
    "Select example/application. Its access reads Repository collaborator; the Agent default remains Contributor.",
    "Save repository access. Confirm the saved message, visit Channels, and return to Repositories to inspect the saved selection.",
    "Confirm example/api-only is absent from repository choices.",
  ],
  gap: "Simulated API state only; saving does not prove Controller persistence, authorization, or runtime Git access.",
};
scenarios.repositoryCollaboratorSaved = {
  ...scenarios.repositoryCollaborator,
  name: "Saved inheritance survives delayed collaborator discovery",
  repositoryAccess: {
    defaultProfile: "git-full",
    repositories: [{ repositoryRef: "application" }],
  },
  repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
  rules: [{ suffix: "/repository-options", delayMs: 3000 }],
  description:
    "A saved inherited Contributor selection meets a changed collaborator-only approval after a three-second discovery delay. Discovery must not migrate the saved intent or mark it dirty.",
  steps: [
    "During discovery, inspect Access awaiting verification. After discovery, inspect Choose approved access; Save stays disabled and Channels stays enabled.",
    "Expand Access for example/application, clear Use Agent default, and choose Repository collaborator. Save the explicit change and confirm the saved message.",
  ],
};
scenarios.repositoryCollaboratorReadOnly = {
  ...scenarios.repositoryCollaborator,
  name: "Explicit Read-only refuses implicit collaborator access",
  actions: [
    { selector: "#repository-default-git-read", click: true },
    { selector: 'input[data-repository-ref="application"]', click: true },
  ],
  description:
    "Choosing Read-only before adding a collaborator-only repository preserves that intent. The editor requires an explicit per-repository choice before saving.",
  steps: [
    "Confirm Read-only stays selected, the repository needs approved access, and Save is disabled.",
    "Expand Access for example/application, clear Use Agent default, and choose Repository collaborator. The Agent default stays Read-only; Save now succeeds.",
    "Reset, remove example/application, and select example/handbook. Save succeeds with inherited Read-only access.",
  ],
};

// The shell and assets are produced by the API's actual theme loader/renderer.
for (const [id, source, name, theme] of [
  ["themeSignIn", "login", "Custom sign-in", "custom"],
  ["themeNavigation", "agents", "Custom desktop navigation", "custom"],
  ["themeMobile", "mobile", "Custom mobile navigation", "custom"],
  ["themeLongName", "agents", "Long product name", "long-name"],
  ["themeEmpty", "agentsEmpty", "Custom empty state", "custom"],
  ["themeDenied", "agentsDenied", "Custom denied state", "custom"],
  ["themeLoading", "agentsLoading", "Custom loading state", "custom"],
  credentialsThemeScenario,
  ["themePublicError", "sessionUnavailable", "Custom public error", "custom"],
]) {
  scenarios[id] = {
    ...scenarios[source],
    name,
    theme,
    description:
      "Deployment branding from the production theme loader. Navigation logos fit within 48 × 48 px; sign-in logos use 40 × 40 px. Resource, session, and runtime states are simulated.",
  };
}

const policySuggestions = Array.from({ length: 12 }, (_, index) => ({
  id: `suggested-${index}`,
  status: "pending",
  observations: 12 - index,
  grant: {
    id: `suggested-rule-${index}`,
    binary: "/usr/bin/python3.11",
    host: `service-${index + 1}.example.org`,
    ports: [{ from: 443, to: 443 }],
  },
}));
for (const [id, outcome, name] of [
  ["policySuggestionsExpanded", undefined, "Twelve suggestions with compact review"],
  ["policySavedForLater", "saved", "Saved rules awaiting application"],
  ["policyApplying", "pending", "Waiting for Sandbox confirmation"],
  ["policyApplied", "applied", "Confirmed running policy"],
  ["policyRetryApplication", "failed", "Inspect then retry unconfirmed application"],
]) {
  scenarios[id] = {
    ...scenarios.policyRulesPopulated,
    name,
    policySuggestions,
    policyInitialOutcome: outcome,
    policyKeepPending: outcome === "pending",
    policyNewDenials: 0,
    steps: [
      "Inspect three suggestions, show all twelve, then show fewer. Expand a full executable path.",
      "Open View network limits directly from the page. The ceiling is read-only and grants no access.",
      "Manage rules: inspect five at a time. Remove a rule and review through the fixed footer. Done preserves the local proposal without saving.",
      "For failed application, Refresh status reads without applying. Retry application is a separate explicit action after inspection.",
    ],
  };
}
scenarios.policyDenialsDisabled = {
  ...scenarios.policyDenialsDisabled,
  policyRuleCount: 10,
  policySuggestions,
};
scenarios.policyEditingAdminDenied = {
  ...scenarios.policyDenialsDisabled,
  name: "Editing administration refused",
  policyAdminDenied: true,
};
scenarios.policyNoNetworkLimits = {
  ...scenarios.policyDenialsDisabled,
  name: "No additional network access delegated",
  policyRuleCount: 0,
  policyCeiling: [],
};
