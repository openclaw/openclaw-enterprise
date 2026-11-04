import type { Configuration, SecretMetadata } from "@openclaw-enterprise/contracts";
import type { ErrorCode, ErrorDetail } from "../../../../packages/contracts/src/api/common.ts";
import type { agentSaveGap } from "../../../../apps/controller/src/console/agents/list.mts";
import type { slack } from "../../../../apps/controller/src/console/channels/slack.mts";
import type { StoryAction } from "../../story-action.mts";

type SlackConfig = Extract<ReturnType<typeof slack.support>, { supported: true }>["config"];

type ChannelRule = ({ path: string } | { prefix: string } | { suffix: string }) & {
  method?: string;
  bodyHasIds?: boolean;
  status?: number;
  code?: ErrorCode;
  message?: string;
  details?: ErrorDetail[];
  hold?: boolean;
  delayMs?: number;
  once?: boolean;
};

type ChannelScenario = {
  group: "Components/Channels";
  name: string;
  path: string;
  description: string;
  steps?: readonly string[];
  gap?: string;
  actions?: readonly StoryAction[];
  rules?: readonly ChannelRule[];
  slack?: boolean;
  slackPolicy?: SlackConfig["dmPolicy"];
  slackChannels?: SlackConfig["channels"];
  slackAllowFrom?: SlackConfig["allowFrom"];
  slackEnterpriseOrgInstall?: boolean;
  slackReplyToMode?: "off";
  slackMode?: "http";
  slackBindings?: "app";
  slackAllowEveryone?: boolean;
  // Existing Channels snapshots omit readLogs; the fixture sends them unchanged.
  agentPermissionSummary?: Omit<NonNullable<Parameters<typeof agentSaveGap>[0]>, "readLogs">;
  auth?: "runtime" | null;
  extraSecrets?: readonly Pick<SecretMetadata, "id" | "name">[];
  agentName?: string;
  pluginDeny?: readonly string[];
  deployed?: boolean;
  configurationChangedElsewhere?: boolean | { values: Configuration["values"] };
  observabilityDenied?: boolean;
};

type ChannelDependencies = {
  click(text: string): StoryAction;
  draft: string;
  revision: string;
  presetSecretsPath: string;
  reservedConfigurationWrite: ChannelRule;
};

export function channelsScenarios({
  click,
  draft,
  revision,
  presetSecretsPath,
  reservedConfigurationWrite,
}: ChannelDependencies) {
  return {
    slack: {
      group: "Components/Channels",
      name: "Slack configured",
      path: `${draft}&tab=channels`,
      slack: true,
      description: "Enabled Socket Mode with standard unresolved credential references.",
    },
    slackDisableReplaceDenied: {
      group: "Components/Channels",
      name: "Slack Disable, editor must replace the bot token Secret",
      path: `${draft}&tab=channels`,
      slack: true,
      agentPermissionSummary: {
        update: true,
        deploy: true,
        operate: true,
        delete: true,
        administer: true,
        configurationUpdate: true,
        configurationRead: true,
        configurationSecretsOperate: false,
        configurationSecretsOperateDeniedBindings: ["SLACK_BOT_TOKEN"],
        agentSourcesOperate: false,
        sandboxPolicyRead: true,
      },
      description:
        "The permission answer lists the bot token binding as the only one whose Secret the editor cannot operate. Disable saves no bindings, so it would keep that Secret bound: Disable Slack is shown disabled with a note to choose another Secret in Edit Slack first. Edit Slack stays available.",
      steps: [
        "Tab to Disable Slack. It takes focus and looks unavailable, described by the note; Enter, Space or a click saves nothing.",
      ],
      gap: "The permission answer is simulated, so a rebind here does not enable Disable; the browser test covers that step.",
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
      rules: [
        { suffix: "/channel-directory/lookup", method: "POST", bodyHasIds: false, hold: true },
      ],
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
    slackTokensMissing: {
      group: "Components/Channels",
      name: "Slack token Secrets missing",
      path: `${draft}&tab=channels`,
      actions: [
        click("Configure Slack"),
        { selector: "#slack-dm-policy", value: "disabled" },
        { selector: "#slack-channel-ids-search", value: "CDEMO123", key: "Enter" },
        { selector: "#slack-channel-access", value: "everyone" },
        click("Save configuration"),
      ],
      description:
        "An enabled Slack channel saves only with both token Secrets: each missing one is named under its picker, and nothing is sent.",
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
      agentName: "Research " + "engineering ".repeat(15) + "review team",
      actions: [
        click("Edit Slack"),
        { selector: "#slack-secret-slack-bot-token", value: "__openclaw_create_secret__" },
      ],
      description:
        "A long Agent name produces a shortened, editable Secret Name that retains the Slack bot token purpose. Creation uses only the simulated service.",
      steps: [
        "Inspect Name before editing: it contains an ellipsis, ends with Slack bot token, and fits the 200-character limit.",
        "Replace Name with Walkthrough Slack bot token and enter synthetic-demo-token as Value. Select Create Secret.",
        "Confirm Create Secret closes and Walkthrough Slack bot token is selected in the Slack editor. The binding is staged until you save the editor.",
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
      description:
        "A disabled access policy does not disable the editor or silently change policy.",
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
    slackPluginDenied: {
      group: "Components/Channels",
      name: "Slack plugin denied",
      path: `${draft}&tab=channels`,
      pluginDeny: [" Slack"],
      description:
        'plugins.deny names " Slack". OpenClaw matches deny entries by trimmed, lowercased plugin ID, so the slack plugin is blocked: Configure Slack is disabled and described by the danger note.',
      steps: [
        "Tab to Configure Slack. It takes focus and looks unavailable, described by the blocked note; Enter, Space or a click opens nothing.",
      ],
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
      actions: [
        click("Edit Slack"),
        { selector: "#slack-dm-policy", value: "disabled" },
        click("Save configuration"),
      ],
      description:
        "The API refuses the Configuration write with 409: another save landed after the page's reread. The editor closes and the section offers Reload draft, with focus on it.",
    },
    channelProvisioningReserved: {
      group: "Components/Channels",
      name: "Save refused during provisioning",
      path: `${draft}&tab=channels`,
      slack: true,
      rules: [reservedConfigurationWrite],
      actions: [
        click("Edit Slack"),
        { selector: "#slack-dm-policy", value: "disabled" },
        click("Save configuration"),
      ],
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
      actions: [
        click("Edit Slack"),
        { selector: "#slack-dm-policy", value: "disabled" },
        click("Save configuration"),
      ],
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
      actions: [
        click("Edit Slack"),
        { selector: "#slack-dm-policy", value: "disabled" },
        click("Save configuration"),
      ],
      description:
        "A caller without Configuration update is refused. The drawer stays open with the edits and names the grant to ask an administrator for; the text is the same for every refusal.",
    },
    channelChangedElsewhere: {
      group: "Components/Channels",
      name: "Configuration changed elsewhere",
      path: `${draft}&tab=channels`,
      slack: true,
      configurationChangedElsewhere: true,
      actions: [click("Disable Slack")],
      description:
        "Another browser saved this Configuration after the page read it. Disable Slack detects the change during its preflight read, without opening an editor or sending a Configuration PATCH. The section offers Reload draft; editing, deployment and tab changes wait for this deliberate reload.",
      steps: [
        "Check that focus is on Reload draft, no editor is open, and the request log contains no Configuration PATCH.",
        "Select Reload draft deliberately: the tab rebuilds in place with Draft reloaded. Slack remains enabled because Disable Slack sent no write; no unsaved editor changes are restored.",
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
        "The editor closes. The warning above Channels says access was not verified; Deploy new version stays available, since the API checks the Agent's access when it deploys. The request log shows no /iam/ request.",
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
  } satisfies Record<string, ChannelScenario>;
}
