import { createAgentDetailScenarios } from "./scenario-groups/agent-detail.mts";
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
import { calendarPlugin, pluginCapabilities, pluginSetup } from "./plugin-scenario-data.mts";
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

const agentDetailScenarios = createAgentDetailScenarios({
  draft,
  revision,
  currentVersion,
  candidateVersion,
});

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
  ...agentDetailScenarios.savedLogin,
  ...credentialsOAuthScenarios({ draft }),
  ...createAgentOutcomeScenarios,
  ...agentDetailScenarios.configuration,
  ...pluginApproverScenarios(draft),
  ...agentDetailScenarios.versions,
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
  ...agentDetailScenarios.bootstrap,
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
  ...agentDetailScenarios.runtime,
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
  ...agentDetailScenarios.saveAccess,
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
  ...agentDetailScenarios.layout,
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
  ...agentDetailScenarios.dangerZone,
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
