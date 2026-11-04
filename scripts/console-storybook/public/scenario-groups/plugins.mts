import type { PluginFieldsOptions } from "../../../../apps/controller/src/console/agents/plugin-fields.mts";
import type {
  PluginApprovers,
  PluginDesiredSelection,
  PluginDesiredState,
} from "../../../../packages/contracts/src/index.ts";
import type { StoryAction } from "../../story-action.mts";
import { click } from "../create-agent-form-data.mts";
import {
  pluginCapabilities,
  pluginCatalog,
  pluginDiscovery,
  pluginSelections,
  pluginSelectionState,
  projectTrackerPlugin,
} from "../plugin-scenario-data.mts";

type PluginScenario = {
  name: string;
  description: string;
  actions: StoryAction[];
  steps?: string[];
  gap?: string;
  pluginCapabilities?: PluginFieldsOptions["capabilities"];
  connectionPreview?: ConnectionPreview;
} & (
  | {
      group: "Components/Plugins";
      component: "plugins";
      pluginCatalog?: PluginFieldsOptions["catalog"];
      pluginSelections?: string;
    }
  | {
      group: "Pages/Agent detail";
      path: string;
      slack: true;
      auth: "codex_pat";
      agentPlugins: PluginDesiredState;
      agentPluginApprovers: PluginApprovers;
      pluginDiscovery: typeof pluginDiscovery;
    }
);

const pluginPreviewGap =
  "Catalog entries, local placeholder logos, and Driver capabilities are passed directly to the production component as Storybook fixtures. These previews do not verify PAT access, plugin availability, or runtime policy enforcement.";

type ConnectionPreview = "choose" | "bound" | "empty" | "denied" | "loading";

function googleSlotStory(preview: ConnectionPreview) {
  const pluginId = "occ-plugin:google@1.0.0";
  const releaseSha256 = "a".repeat(64);
  const boundId = "cs_00000000-0000-4000-8000-000000000010";
  return {
    group: "Components/Plugins" as const,
    name: `Google Workspace account — ${preview}`,
    component: "plugins" as const,
    description: "Preview an explicit template choice for the Google Workspace account slot.",
    gap: "Simulated template discovery and consent navigation. This component preview does not contact a provider or change an Agent grant.",
    connectionPreview: preview,
    pluginCatalog: {
      status: "ready" as const,
      entries: [
        { id: pluginId, name: "Google Workspace", selectableWithoutTools: true, tools: [] },
      ],
    },
    pluginCapabilities: {
      ...pluginCapabilities,
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      policyScopeByPlugin: { [pluginId]: "enablement_only" as const },
      credentialSlots: [
        {
          pluginId,
          releaseSha256,
          id: "account",
          label: "Workspace account",
          ...(preview !== "bound" && { connectAccount: true as const }),
          sources: preview === "bound" ? [{ id: boundId, name: "Existing Gmail account" }] : [],
        },
      ],
    },
    pluginSelections: JSON.stringify({
      [pluginId]: {
        enabled: true,
        ...(preview === "bound" && {
          driverPolicy: { releaseSha256, credentials: { account: boundId } },
        }),
      },
    }),
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Google Workspace"]', click: true },
      ...(["choose", "bound"].includes(preview) ? [] : [click("Choose a connection template")]),
    ],
  };
}

export function pluginConnectionReturn(
  draft: string,
  outcome: "saved" | "attached" | "unconfirmed",
) {
  const sourceId = "cs_00000000-0000-4000-8000-000000000010";
  const bound = outcome === "attached";
  const preview = googleSlotStory(bound ? "bound" : "choose");
  return {
    group: "Pages/Agent detail",
    name: `Google Workspace consent return — ${outcome}`,
    path: `${draft}&tab=plugins&connection=${outcome}${outcome === "saved" ? `&sourceId=${sourceId}` : ""}`,
    harnessId: "openclaw",
    auth: "runtime",
    agentPlugins: JSON.parse(preview.pluginSelections),
    credentialSources: bound ? [{ sourceId }] : [],
    pluginCapabilities: preview.pluginCapabilities,
    pluginDiscoveryCredential: "none",
    pluginDiscovery: {
      pages: { initial: { plugins: preview.pluginCatalog.entries, nextCursor: null } },
    },
    savedPluginAccount: { id: sourceId, name: "Existing Gmail account" },
    description:
      "Read the consent result on the saved Agent’s Plugins tab. If attachment failed, attach the saved account without starting consent again.",
    gap: "The callback result, saved account, and Agent are Storybook fixtures. These previews do not contact a provider or issue runtime credentials.",
  };
}

export const pluginsScenarios = {
  pluginConnectChoose: googleSlotStory("choose"),
  pluginConnectBound: googleSlotStory("bound"),
  pluginConnectEmpty: googleSlotStory("empty"),
  pluginConnectDenied: googleSlotStory("denied"),
  pluginConnectLoading: googleSlotStory("loading"),
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
      } satisfies PluginDesiredState,
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
    pluginCatalog: {
      status: "ready",
      entries: [projectTrackerPlugin],
    },
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
  managedGoogleInstall: {
    group: "Components/Plugins",
    name: "Install Google Workspace",
    component: "plugins",
    pluginCapabilities: {
      ...pluginCapabilities,
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      policyScopeByPlugin: { "occ-plugin:google@1.0.0": "enablement_only" },
    },
    pluginCatalog: {
      status: "ready",
      entries: [
        {
          id: "occ-plugin:google@1.0.0",
          name: "Google Workspace",
          description:
            "Install the pinned gog Google Workspace CLI on a dedicated OpenClaw worker using Kubernetes Compute.",
          selectableWithoutTools: true,
          tools: [],
        },
      ],
    },
    actions: [
      click("Configure plugins"),
      { selector: 'button[aria-label="Google Workspace"]', click: true },
      click("Add Google Workspace"),
    ],
    description:
      "Toggle Enable plugin. Open More actions to find Remove Google Workspace. Compare the Plugin policies, Driver policy, and Tools sections. Each shows which settings Google Workspace supports. This fixture simulates the catalog.",
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
      } satisfies PluginDesiredState,
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
} satisfies Record<string, PluginScenario>;

// Codex offers only Agent-wide approvers. These stories reuse its catalog to show the plugin and
// tool fields that a Driver advertising them (OpenClaw) renders.
const overrideApproverCapabilities = {
  ...pluginCapabilities,
  approvers: { agent: true, plugin: true, tools: true },
};
const overrideApproverGap =
  "This is simulated UI and does not prove runtime approval authorization. The Codex Plugin Driver does not offer plugin or tool approvers; these fixtures enable them on its catalog to preview the fields.";

export function pluginApproverScenarios(draft: string) {
  const calendarId = "codex-plugin:calendar@openai-curated-remote";
  const calendarSelection = structuredClone(pluginSelectionState[calendarId]);
  const overrideSelection = {
    ...calendarSelection,
    tools: {
      ...calendarSelection.tools,
      "app_calendar/create_event": {
        ...calendarSelection.tools["app_calendar/create_event"],
        approvers: [{ channel: "slack", id: "team:TDEMO123:user:UDEMO124" }],
      },
    },
    approvers: [],
  } satisfies PluginDesiredSelection;
  const pluginApproverOverrides = { [calendarId]: overrideSelection };
  const pluginApproverNoneHints = {
    [calendarId]: {
      ...structuredClone(pluginSelectionState[calendarId]),
      approvers: [],
    } satisfies PluginDesiredSelection,
  };
  const pluginApproverPreservedHints = {
    [calendarId]: {
      ...structuredClone(pluginSelectionState[calendarId]),
      approvers: [{ channel: "teams", id: "person-1" }],
    } satisfies PluginDesiredSelection,
  };
  return {
    pluginApproversInherited: {
      group: "Pages/Agent detail",
      name: "Plugin approver inheritance",
      path: draft,
      slack: true,
      auth: "codex_pat",
      agentPlugins: structuredClone(pluginSelectionState),
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
        "Open No Slack approvers hints and Preserved non-Slack approver for the hidden no-approvers sentences.",
      ],
      gap: overrideApproverGap,
    },
    pluginApproversNoneHints: {
      group: "Pages/Agent detail",
      name: "No Slack approvers hints",
      path: draft,
      slack: true,
      auth: "codex_pat",
      agentPlugins: pluginApproverNoneHints,
      agentPluginApprovers: [{ channel: "slack", id: "team:TDEMO123:user:UDEMO123" }],
      pluginCapabilities: overrideApproverCapabilities,
      pluginDiscovery,
      actions: [
        click("Plugins"),
        click("Configure plugins"),
        { selector: 'button[aria-label="Calendar"]', click: true },
      ],
      description:
        "Calendar starts with an empty approver list on No Slack approvers. The hint says no Slack user can approve and the people picker is hidden. Selected Slack users with that empty list asks for people and shows the picker.",
      steps: [
        "Read Calendar plugin approvers: No Slack user can approve. The people picker is hidden.",
        "Change Calendar plugin approvers to Selected Slack users and leave the list empty. The hint asks you to select people, and the picker is visible.",
        "Change it back to No Slack approvers. The first sentence returns and the picker hides again.",
      ],
      gap: overrideApproverGap,
    },
    pluginApproversPreservedChannel: {
      group: "Pages/Agent detail",
      name: "Preserved non-Slack approver",
      path: draft,
      slack: true,
      auth: "codex_pat",
      agentPlugins: pluginApproverPreservedHints,
      agentPluginApprovers: [{ channel: "slack", id: "team:TDEMO123:user:UDEMO123" }],
      pluginCapabilities: overrideApproverCapabilities,
      pluginDiscovery,
      actions: [
        click("Plugins"),
        click("Configure plugins"),
        { selector: 'button[aria-label="Calendar"]', click: true },
      ],
      description:
        "Calendar has no Slack approvers and keeps one simulated non-Slack entry. No Slack approvers says no Slack user can approve, names that preserved entry, and hides the people picker. Selected Slack users still counts zero Slack approvers while that entry remains.",
      steps: [
        "Read Calendar plugin approvers: No Slack user can approve. 1 other channel entries are preserved. The people picker is hidden.",
        "Change Calendar plugin approvers to Selected Slack users. The picker is shown, and the hint stays 0 Slack approvers selected because the simulated non-Slack entry remains.",
        "Change it back to No Slack approvers. The preserved-entry sentence returns and the picker hides again. The teams / person-1 entry is fixture data, not a real channel.",
      ],
      gap: overrideApproverGap,
    },
  } satisfies Record<string, PluginScenario>;
}
