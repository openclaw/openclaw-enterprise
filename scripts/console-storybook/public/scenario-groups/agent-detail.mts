import type {
  AgentCredentialSourceBinding,
  AgentDeploymentStatusWire,
  AgentRuntimeHarnessStatus,
  OpenClawConfigurationDocument,
  PluginApprovers,
  PluginDesiredState,
  RepositoryAccess,
  RepositoryBindingSelection,
  RepositoryOption,
  RuntimeFailureCause,
  SecretDetailResponse,
} from "@openclaw-enterprise/contracts";
import type { PluginFieldsOptions } from "../../../../apps/controller/src/console/agents/plugin-fields.mts";
import type { agentSaveGap } from "../../../../apps/controller/src/console/agents/list.mts";
import type { StoryAction } from "../../story-action.mts";
import type { createFixtureFetch } from "../preview-rules.mts";
import type { servePluginDiscovery } from "../plugin-discovery-fixture.mts";
import { click } from "../create-agent-form-data.mts";
import {
  pluginCapabilities,
  pluginDiscovery,
  pluginSelections,
  pluginSelectionState,
  pluginToolRefusal,
} from "../plugin-scenario-data.mts";

type AgentPermissions = NonNullable<Parameters<typeof agentSaveGap>[0]>;

// Preserve the full, pre-readLogs, and four-flag permission responses authored here.
type PermissionSnapshot =
  | AgentPermissions
  | Omit<AgentPermissions, "readLogs">
  | Pick<AgentPermissions, "update" | "deploy" | "operate" | "delete">;

type AgentDetailScenario = {
  group: "Pages/Agent detail";
  name: string;
  path: string;
  description: string;
  steps?: string[];
  gap?: string;
  actions?: StoryAction[];
  rules?: Parameters<typeof createFixtureFetch>[0];
  nextStory?: string;
  deployed?: true;
  auth?: "oauth" | "codex_pat" | "api-source" | null;
  harnessOverrides?: Record<string, unknown>;
  agentPlugins?: PluginDesiredState;
  agentPluginApprovers?: PluginApprovers;
  pluginCapabilities?: PluginFieldsOptions["capabilities"];
  pluginDiscovery?: Parameters<typeof servePluginDiscovery>[0];
  pluginDiscoveryCredential?: "none";
  firstDeploymentFailed?: true;
  scrollToTabs?: false;
  readOnlyPermissionSummary?: true;
  revisionHistory?: number;
  earlierFailedVersion?: number;
  earlierVersionError?: AgentDeploymentStatusWire["error"];
  revisionPageSize?: number;
  transport?: false;
  configurationSaveResponseId?: string;
  gatewayPassword?: true;
  gatewayPasswordProviderless?: true;
  secretProviderAliasRefused?: true;
  pluginSecretInputProviderless?: true;
  configInclude?: true;
  pluginEntryKeyVariant?: true;
  openClawSandbox?: true;
  providerKeyVariant?: true;
  // This authored refusal input deliberately contains a non-text deny-list item.
  pluginDeny?: (string | number)[];
  kubernetesEntryKeyVariant?: true;
  codexPluginsDisabled?: true;
  trustedProxyWithoutMachine?: true;
  agentCreateRestricted?: true;
  gatewayPasswordAllowlistOmits?: true;
  messageQueue?: OpenClawConfigurationDocument;
  slack?: true;
  secretOperateDenied?: string[];
  agentPermissionSummary?: PermissionSnapshot;
  harnessId?: "openclaw";
  credentialSources?: AgentCredentialSourceBinding[];
  configurationChangedElsewhere?: { values: OpenClawConfigurationDocument };
  repositoryBindings?: RepositoryBindingSelection[];
  repositoryAccess?: RepositoryAccess;
  repositoryOptions?: RepositoryOption[];
  repositoryNotConfigured?: true;
  observabilityDenied?: true;
  candidateDeploymentStatus?: AgentDeploymentStatusWire["status"];
  candidateActivates?: true;
  deploymentLastAttempt?: NonNullable<AgentDeploymentStatusWire["progress"]>["lastAttempt"];
  bootstrapFailure?: true;
  cleanupStatus?: "queued";
  cleanupCompletes?: true;
  bootstrapRuntime?: true;
  harness?: AgentRuntimeHarnessStatus;
  agentName?: string;
  mobile?: true;
  clipboard?: "unavailable";
  candidateCredentialRejected?: true;
  retiredSetting?: true;
  secretCallerPermissions?: SecretDetailResponse["data"]["callerPermissions"];
  unreadableSecretId?: string;
  candidateModelProbeCause?: RuntimeFailureCause;
  candidateDependencyUnavailable?: true;
  candidateFailure?: AgentDeploymentStatusWire["error"];
  candidateSelected?: true;
  stopped?: true;
  candidateStopped?: true;
  candidateSuperseded?: true;
  stopElsewhereOnReread?: true;
  diagnosticsState?: "noSlack" | "unknown";
  runtimePod?:
    "startupWarnings" | "dedicatedPair" | "missingAgent" | "none" | "replaced" | "rollover";
  stopNoSelection?: true;
  failedRedeployOnReread?: true;
  runtimeLogDownloadNoPod?: true;
  unreadableAgentConfiguration?: "plugins";
  unreadableRevisionConfiguration?: "plugins";
  nativeAdmin?: "available";
};

export function createAgentDetailScenarios({
  draft,
  revision,
  currentVersion,
  candidateVersion,
}: {
  draft: string;
  revision: string;
  currentVersion: string;
  candidateVersion: string;
}) {
  const configurationConflictDraft = {
    group: "Pages/Agent detail",
    path: draft,
    configurationChangedElsewhere: {
      values: {
        gateway: { bind: "loopback" },
        agents: { defaults: { model: "codex/gpt-5.1" } },
      },
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
    ],
  } satisfies Pick<
    AgentDetailScenario,
    "group" | "path" | "configurationChangedElsewhere" | "actions"
  >;

  const runtimeLogsPage = {
    group: "Pages/Agent detail",
    path: `${candidateVersion}&tab=logs`,
    deployed: true,
    candidateDeploymentStatus: "succeeded",
  } satisfies Pick<
    AgentDetailScenario,
    "group" | "path" | "deployed" | "candidateDeploymentStatus"
  >;

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
  } satisfies Pick<
    AgentDetailScenario,
    "group" | "path" | "deployed" | "candidateDeploymentStatus" | "candidateSuperseded" | "rules"
  >;

  const refuseLogRead = {
    suffix: "/runtime/logs",
    status: 403,
    code: "FORBIDDEN",
  } satisfies Parameters<typeof createFixtureFetch>[0][number];

  const slackPluginId = "occ-plugin:slack@1.0.0";

  const slackSourceId = "cs_00000000-0000-4000-8000-000000000001";

  const slackEntry = { id: slackPluginId, name: "Slack", tools: [] };

  const slackTool = {
    id: "slack_search_public",
    name: "slack_search_public",
    ownerId: slackPluginId,
  };

  const shareExistingPerson = [
    { selector: "#share-principal-id", value: "prn_person-demo" },
    { selector: ".agent-access-consent input", click: true },
    click("Share Agent"),
  ] satisfies StoryAction[];
  // Keep these groups separate to preserve their original catalog insertion points.
  return {
    savedLogin: {
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
    } satisfies Record<string, AgentDetailScenario>,

    configuration: {
      harnessOverrides: {
        group: "Pages/Agent detail",
        name: "Harness destination override",
        path: draft,
        deployed: true,
        auth: "api-source",
        harnessOverrides: {
          modelProvider: {
            baseUrl: "https://evaluation.example.com/v1",
            protocol: "openai-responses",
            supportsStandaloneWebSearch: false,
          },
        },
        description:
          "Submit requested overrides and inspect the resolved settings after deployment.",
        steps: [
          "Read the requested destination beside the deployment checklist. Open Harness destination, choose Override model provider, enter an authorized HTTPS /v1 endpoint, then deploy and inspect requested and resolved settings.",
        ],
        gap: "Simulated UI proof only; source consent, persistence and inference routing require integration checks.",
      },
      harnessDeploymentPending: {
        group: "Pages/Agent detail",
        name: "Harness deployment pending",
        path: draft,
        description:
          "The actual deployment request is pending; duplicate submission is unavailable.",
        rules: [{ method: "POST", suffix: "/deploy", hold: true }],
      },
      harnessDeploymentDenied: {
        group: "Pages/Agent detail",
        name: "Harness deployment denied",
        path: draft,
        description: "Admission refuses the requested settings without creating a version.",
        rules: [{ method: "POST", suffix: "/deploy", status: 403 }],
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
        steps: [
          "Confirm the array error appears below the raw JSON editor and the editor has focus.",
          'Replace the draft with {"sample":{"enabled":true,"driverPolicy":{"destructiveEnabled":1e400}}}. Collapse the JSON editor and choose Save plugin selections. The editor opens and takes focus with a number-range error; no save request starts.',
          "Open Configure plugins. The existing invalid-JSON guidance appears, focus stays in the dialog, and the raw draft remains unchanged. Correct the number before using policy controls.",
        ],
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
        messageQueue: {
          allowCollaborativeSteering: false,
          collaborativeSteeringFallback: "reject",
        },
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
    } satisfies Record<string, AgentDetailScenario>,

    versions: {
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
        description:
          "An admitted version shows its immutable Agent-owned plugin selection and policy.",
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
        steps: [
          "Check the initial syntax error, then Cancel and reopen Edit Configuration. Expand Advanced settings to restore a complete Configuration JSON draft.",
          'Set plugins.entries.knowledge to {"enabled":true,"config":{"thresholds":[1,1e400,3]}}, preserving the rest of the document. This is valid JSON syntax, but the middle number is outside the supported range. Select Save Configuration.',
          "Read the error under the editor: A number is too large or too small to save. Use a number closer to zero. Check that the editor has focus, its exact text is unchanged, and no Configuration write occurs.",
          "Change only 1e400 to 2 and save again. Reopen the editor and check that thresholds is [1,2,3], with no null substituted. This is simulated UI evidence only.",
        ],
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
          {
            selector: "#configuration-json",
            value: '{\n  "agents": {\u201Cdefaults\u201D: {}}\n}',
          },
          click("Save Configuration"),
        ],
        description:
          "A key wrapped in curly quotes looks like JSON but is not. The error names the curly quote and the straight quote to use instead.",
        steps: [
          'Read the error under the editor: Invalid JSON at line 2, column 14: replace the curly quote \u201C there with a straight quote (").',
        ],
      },
      configurationChangedElsewhereMerged: {
        ...configurationConflictDraft,
        name: "Configuration edits merged over another browser's save",
        actions: [
          ...configurationConflictDraft.actions,
          click("Save Configuration"),
          click("Reload draft"),
        ],
        description:
          "Another browser changed the model and the gateway bind while this editor set the bind. Reload draft merges this reader's edit over the reread document and names the value both changed.",
        steps: [
          "Check the note names /gateway/bind with the saved value, and the editor keeps the other browser's model with this reader's bind.",
        ],
      },
      configurationConflictFocus: {
        ...configurationConflictDraft,
        name: "Configuration conflict preserves moved focus",
        rules: [
          {
            method: "GET",
            suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
            skip: 1,
            once: true,
            // Leave time for a person to move focus during the simulated preflight.
            delayMs: 10000,
          },
        ],
        description:
          "The first save waits 10 seconds for its simulated preflight read, then reports a conflict. Compare recovery focus with focus moved to the editor or navigation.",
        steps: [
          "Focus Save Configuration and press Enter. Stay on Checking Configuration: the conflict moves focus to Reload draft and announces an alert.",
          "Reset. Save, then click Configuration JSON and use Select All during the 10-second check. The conflict keeps focus and active selection in the read-only editor without scrolling to the alert.",
          "Reset and repeat, moving focus to the Agents link during the check. Focus stays on that link.",
          "Choose Reload draft to merge the edits. Check that the saved model and this reader's bind remain, with a note naming /gateway/bind.",
        ],
        gap: "Simulated preflight conflict only; the browser regression checks a real Controller PATCH race.",
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
      repositoryAccessRedeployRequired: {
        group: "Pages/Agent detail",
        name: "Repository access needs redeployment after completion",
        path: `${candidateVersion}&tab=deployment`,
        deployed: true,
        candidateDeploymentStatus: "succeeded",
        candidateSelected: true,
        rules: [
          {
            method: "GET",
            suffix: "/deployments/rev_00000000-0000-4000-8000-000000000007",
            skip: 1,
            data: {
              deploymentId: "rev_00000000-0000-4000-8000-000000000007",
              namespaceId: "ns_00000000-0000-4000-8000-000000000001",
              agentId: "agt_00000000-0000-4000-8000-000000000001",
              status: "succeeded",
              cleanup: null,
              error: null,
              progress: null,
              warnings: [],
              repositoryAccess: {
                state: "redeploy-required",
                code: "REPOSITORY_EXECUTION_REDEPLOY_REQUIRED",
                message:
                  "The controller can no longer renew this version's repository access on its current runtime. Deploy again to restore repository access.",
              },
            } satisfies AgentDeploymentStatusWire,
          },
        ],
        description:
          "A completed version acquires a repository access condition on refresh. The original deployment remains Completed and the API guidance appears beside it.",
        steps: [
          "Open Deployment and choose Refresh record. Both the version record and expanded Deployment activity show the repository access guidance while keeping Completed.",
          "View v6 and open Deployment. Its record has no repository notice; Deployment activity still describes v7. Browsing and refreshing send no deployment request.",
          "Return to v7 and choose Refresh deployment. The guidance stays with v7. Repeat at phone width and check the full message wraps without horizontal scrolling.",
        ],
        gap: "Simulated UI proof only; no repository renewal, deployment, or runtime is exercised. Absence of the condition does not establish healthy Git access.",
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
        rules: [
          { suffix: "/agents/agt_00000000-0000-4000-8000-000000000001", skip: 1, status: 503 },
        ],
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
    } satisfies Record<string, AgentDetailScenario>,

    bootstrap: {
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
    } satisfies Record<string, AgentDetailScenario>,

    runtime: {
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
        rules: [
          { suffix: "/runtime/logs", skip: 1, status: 429, code: "RUNTIME_LOGS_RATE_LIMITED" },
        ],
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
        description:
          "A simulated 404 shows Agent details and Resource unavailable without an Agent name.",
        actions: [{ text: "Agent details" }],
        steps: [
          "Confirm the page heading is Agent details and the panel says Resource unavailable, without an Agent name.",
          "Choose ← Agents and confirm the collection heading is Agents.",
        ],
      },
      agentReadInterrupted: {
        group: "Pages/Agent detail",
        name: "Retry a direct Agent link",
        path: draft,
        rules: [
          {
            method: "GET",
            path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001",
            once: true,
            status: 503,
            code: "DEPENDENCY_UNAVAILABLE",
          },
        ],
        description:
          "A simulated interruption shows Agent details and Request unavailable. Retry reads the fixture's Research assistant.",
        actions: [{ text: "Agent details" }, { text: "Request unavailable" }],
        steps: [
          "Open the preview directly in its own tab, without navigating from the Agents list.",
          "Confirm the heading is Agent details and the panel says Request unavailable, without an Agent name.",
          "Use Tab to reach Retry and press Enter. Confirm the H1 becomes Research assistant and receives keyboard focus.",
        ],
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
          {
            suffix: "/revisions/rev_00000000-0000-4000-8000-000000000006",
            status: 503,
            once: true,
          },
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
      revisionRejected: {
        group: "Pages/Agent detail",
        name: "Revision history rejects with null",
        path: `${draft}&tab=configuration`,
        rules: [
          {
            method: "GET",
            path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/agents/agt_00000000-0000-4000-8000-000000000001/revisions",
            rejectWithNull: true,
          },
        ],
        description:
          "The revision-history fetch rejects with raw JavaScript null and no HTTP status. The draft Configuration GET uses its normal fixture response. The separate Revision history unavailable preview retains HTTP 403.",
        steps: [
          "At desktop and 390-pixel widths, confirm Version history unavailable appears without No readable versions or Load older versions.",
          "Read the draft Configuration, open Edit Configuration, then Cancel. The history warning remains local to version history.",
          "Confirm Deploy new version stays unavailable and explains that version history is required before deploying.",
        ],
        gap: "Simulated JavaScript rejection through the production Console; this does not prove a normal browser network failure, backend persistence, or deployment.",
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
    } satisfies Record<string, AgentDetailScenario>,

    saveAccess: {
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
    } satisfies Record<string, AgentDetailScenario>,

    layout: {
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
    } satisfies Record<string, AgentDetailScenario>,

    dangerZone: {
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
    } satisfies Record<string, AgentDetailScenario>,
  };
}

export function createAgentDetailRepositoryScenarios(
  repositoryEditor: ReturnType<typeof createAgentDetailScenarios>["versions"]["repositoryEditor"],
) {
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
  ] satisfies RepositoryOption[];
  const repositoryCollaborator = {
    ...repositoryEditor,
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
  } satisfies AgentDetailScenario;
  const repositoryCollaboratorSaved = {
    ...repositoryCollaborator,
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
  } satisfies AgentDetailScenario;
  const repositoryCollaboratorReadOnly = {
    ...repositoryCollaborator,
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
  } satisfies AgentDetailScenario;
  return { repositoryCollaborator, repositoryCollaboratorSaved, repositoryCollaboratorReadOnly };
}
