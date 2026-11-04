import type {
  AgentCredentialSourceBinding,
  Configuration,
  CredentialSourceType,
  SecretMetadata,
} from "../../../../packages/contracts/src/index.ts";
import type { agentSaveGap } from "../../../../apps/controller/src/console/agents/list.mts";
import type { StoryAction } from "../../story-action.mts";
import type { configurationValues } from "../configuration-fixture.mts";
import type { createFixtureFetch } from "../preview-rules.mts";
import { click, deviceLoginSourceTypes, presetSecretsPath } from "../create-agent-form-data.mts";

type CredentialScenario = Pick<
  Parameters<typeof configurationValues>[0],
  "slack" | "slackOff" | "slackMode" | "slackTokens"
> & {
  group: "Components/Credentials";
  name: string;
  path: string;
  description: string;
  steps?: readonly string[];
  gap?: string;
  actions?: readonly StoryAction[];
  rules?: Parameters<typeof createFixtureFetch>[0];
  credentialSourceTypes?: readonly CredentialSourceType[];
  credentialSources?: readonly AgentCredentialSourceBinding[];
  extraSecrets?: readonly Pick<SecretMetadata, "id" | "name">[];
  // These authored permission snapshots omit readLogs; preserve the fixture response.
  agentPermissionSummary?: Omit<NonNullable<Parameters<typeof agentSaveGap>[0]>, "readLogs">;
  auth?: "oauth" | "runtime" | "service" | null;
  configurationChangedElsewhere?: boolean | { afterReads: number; values: Configuration["values"] };
  deployed?: boolean;
  harnessGrantMissing?: boolean;
  oauthPending?: boolean;
  observabilityDenied?: boolean;
  readOnlyPermissionSummary?: boolean;
  secretCreateNotPermitted?: boolean;
  secretOperateDenied?: readonly string[];
  serviceAccountsEmpty?: boolean;
  slackBindings?: false | "app" | readonly string[];
  slackGrantMissing?: string;
  unreadableSecretId?: string;
};

type CredentialDependencies = {
  draft: string;
  reservedConfigurationWrite: Parameters<typeof createFixtureFetch>[0][number];
};

export function credentialsOAuthScenarios({ draft }: Pick<CredentialDependencies, "draft">) {
  return {
    authOAuthStartNavigation: {
      group: "Components/Credentials",
      name: "ChatGPT replacement interrupted by navigation (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: deviceLoginSourceTypes,
      deployed: true,
      auth: "oauth",
      rules: [{ suffix: "/device-authorizations", method: "POST", hold: true }],
      description:
        "Start a replacement sign-in, navigate to Secrets, and return with Back. The saved authentication remains; the unconfirmed replacement cannot start twice.",
    },
    authOAuthStartTabSwitch: {
      group: "Components/Credentials",
      name: "ChatGPT sign-in answered on another tab (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: deviceLoginSourceTypes,
      deployed: true,
      auth: "oauth",
      oauthPending: true,
      rules: [{ suffix: "/device-authorizations", method: "POST", delayMs: 3000, once: true }],
      description:
        "Start a replacement sign-in and open Configuration within 3 s. The reply arrives while Configuration shows; Credentials keeps it, so returning shows the code and Cancel login. The fixture delays the reply; it does not prove provider persistence.",
    },
    authOAuthStartTabSwitchRefused: {
      group: "Components/Credentials",
      name: "ChatGPT sign-in refused on another tab (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: deviceLoginSourceTypes,
      deployed: true,
      auth: "oauth",
      rules: [
        {
          suffix: "/device-authorizations",
          method: "POST",
          delayMs: 3000,
          status: 403,
          once: true,
        },
      ],
      description:
        "Start a replacement sign-in and open Configuration within 3 s. The simulated refusal arrives while Configuration shows; returning to Credentials names the missing grants and offers Sign in with OAuth again.",
    },
    authOAuthRestartTabSwitch: {
      group: "Components/Credentials",
      name: "ChatGPT sign-in restarted on another tab (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: deviceLoginSourceTypes,
      deployed: true,
      auth: "oauth",
      oauthPending: true,
      rules: [
        { suffix: "/device-authorizations", method: "POST", delayMs: 3000, skip: 1, once: true },
      ],
      description:
        "Start a replacement sign-in, choose Cancel login, then start again and open Configuration within 3 s. The second reply arrives while Configuration shows; Credentials keeps it, so returning shows the code. The fixture delays the reply; it does not prove provider persistence.",
    },
    authOAuthReconnect: {
      group: "Components/Credentials",
      name: "Explicit ChatGPT credential replacement (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: deviceLoginSourceTypes,
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
  } satisfies Record<string, CredentialScenario>;
}

export function credentialsScenarios({
  draft,
  reservedConfigurationWrite,
}: CredentialDependencies) {
  return {
    credentials: {
      group: "Components/Credentials",
      name: "Model authentication",
      path: `${draft}&tab=credentials`,
      description:
        "The saved harness authentication source can be reviewed or changed before deployment.",
    },
    credentialsSecretCreateNotPermitted: {
      group: "Components/Credentials",
      name: "Model authentication, Secret creation not permitted",
      path: `${draft}&tab=credentials`,
      secretCreateNotPermitted: true,
      description:
        "The Namespace permission answer denies Secret creation. The Secret field still lists Create new Secret..., disabled with the reason, and its hint says to choose an existing Secret.",
      steps: [
        "Type a name no Secret has in the Secret field. Create new Secret... is listed with the access note under it and opens nothing.",
      ],
      gap: "The permission answer is simulated; the API still authorizes Secret creation.",
    },
    credentialsUpdateDenied: {
      group: "Components/Credentials",
      name: "Model authentication, viewer cannot update the Agent",
      path: `${draft}&tab=credentials`,
      readOnlyPermissionSummary: true,
      description:
        "The permission answer denies Agent update, so Save authentication source and its fields are disabled, and the note names the grant to ask for.",
      steps: [
        "Tab to Authentication source, API key Secret and Save authentication source. Each takes focus and looks unavailable. The select and Save are described by the note; the Secret field by its status. Enter, Space, a click, an arrow key or typing changes nothing.",
      ],
      gap: "The permission answer is simulated; the API still authorizes every save.",
    },
    credentialsSourcesOperateDenied: {
      group: "Components/Credentials",
      name: "Model authentication, editor cannot operate a bound source",
      path: `${draft}&tab=credentials`,
      agentPermissionSummary: {
        update: true,
        deploy: true,
        operate: true,
        delete: true,
        administer: true,
        configurationUpdate: true,
        configurationRead: true,
        configurationSecretsOperate: true,
        configurationSecretsOperateDeniedBindings: [],
        agentSourcesOperate: false,
        sandboxPolicyRead: false,
      },
      description:
        "The permission answer allows Agent update but not operate on every Secret and credential source the Agent and its Configuration bind, which each Agent update checks. Save authentication source and its fields are disabled, and the note names the missing grant. Plugins and repository access saves show the same note.",
      gap: "The permission answer is simulated; the API still authorizes every save.",
    },
    credentialsServiceAccountReadDenied: {
      group: "Components/Credentials",
      name: "Model authentication, editor may lack read on the ChatGPT service account",
      path: `${draft}&tab=credentials`,
      auth: "service",
      agentPermissionSummary: {
        update: true,
        deploy: true,
        operate: true,
        delete: true,
        administer: true,
        configurationUpdate: true,
        configurationRead: true,
        configurationSecretsOperate: true,
        configurationSecretsOperateDeniedBindings: [],
        agentSourcesOperate: false,
        sandboxPolicyRead: false,
      },
      description:
        "The Agent uses a ChatGPT service account for Harness authentication, which each Agent update reads. The permission answer says a source grant is missing but not which one, so the note names operate on the bound Secrets and credential sources and read on the service account.",
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
    credentialsSlackOtherKeys: {
      group: "Components/Credentials",
      name: "Slack tokens on other keys",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackTokens: {
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken: "${ACME_SLACK_BOT}",
      },
      slackBindings: ["SLACK_APP_TOKEN"],
      description:
        "The bot token reads ACME_SLACK_BOT, which the token pickers do not bind, so the tab lists each key the tokens read without pickers. Deploy waits until ACME_SLACK_BOT is bound through the Configuration API.",
    },
    credentialsSlackHttp: {
      group: "Components/Credentials",
      name: "Slack HTTP mode, bot token only",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackMode: "http",
      slackTokens: { botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" } },
      slackBindings: ["SLACK_BOT_TOKEN"],
      description:
        "HTTP mode reads no app token, so the tab offers only the Slack bot token picker, and Deploy is available while it is bound.",
    },
    credentialsSlackReader: {
      group: "Components/Credentials",
      name: "Slack tokens, viewer can only read",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackBindings: false,
      readOnlyPermissionSummary: true,
      description:
        "The permission answer denies Configuration update, so the Slack token pickers are disabled, Save channel Secrets is not offered, and a note says why.",
      gap: "The permission answer is simulated; the API still authorizes every save.",
    },
    credentialsSlackSecretsOperateDenied: {
      group: "Components/Credentials",
      name: "Slack tokens, editor cannot operate the bound Secrets",
      path: `${draft}&tab=credentials`,
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
        configurationSecretsOperateDeniedBindings: [],
        agentSourcesOperate: false,
        sandboxPolicyRead: false,
      },
      description:
        "The permission answer allows Configuration update but not Secret operate on every Secret the Configuration binds, which each Configuration save needs. The Slack token pickers are disabled, Save channel Secrets is not offered, and a note names the missing grant. Each Agent update checks the same Secrets, so Save authentication source is disabled too.",
      steps: [
        "Tab to Slack app token and Slack bot token. Each takes focus and looks unavailable, its description is its status line, and an arrow key or typing opens no list and changes nothing.",
      ],
      gap: "The permission answer is simulated; the API still authorizes every save.",
    },
    credentialsSlackReplaceDenied: {
      group: "Components/Credentials",
      name: "Slack tokens, editor must replace the bot token Secret",
      path: `${draft}&tab=credentials`,
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
        "The permission answer lists the bot token binding as the only one whose Secret the editor cannot operate. A save is checked on the Secrets it submits, so the Slack token pickers stay editable and a note says to choose another Secret for the bot token. A save that keeps it is refused before any request.",
      steps: [
        "Choose the Slack backup token for the app token and select Save channel Secrets. The panel says the save keeps Slack bot token and sends nothing.",
        "Choose the Slack backup token for the bot token too, then Save channel Secrets. The save goes through; do not deploy.",
      ],
      gap: "The permission answer is simulated; the API still authorizes every save and the Secrets it binds.",
    },
    credentialsSlackOperateDenied: {
      group: "Components/Credentials",
      name: "Slack tokens, editor cannot operate one readable Secret",
      path: `${draft}&tab=credentials`,
      slack: true,
      secretOperateDenied: ["sec_demo_slack_backup_token"],
      description:
        "The Secret answer lists the Slack backup token as readable but not operable for this editor. Each Secret field lists it disabled with the reason and never stages it, since a save that binds it would be refused. Secret operate is then granted per Secret, so each field lists Create new Secret... disabled with the reason too.",
      steps: [
        "Type backup in Slack bot token. Slack backup token (simulated) is listed with the access note under it; choosing it stages nothing and Save channel Secrets stays disabled.",
        "Type backup in API key Secret: the same option is listed the same way.",
        "Type a name no Secret has in API key Secret. Create new Secret... is listed with the access note under it and opens nothing.",
      ],
      gap: "The Secret answer is simulated; the API still authorizes every save and the Secrets it binds.",
    },
    credentialsSlackStored: {
      group: "Components/Credentials",
      name: "Slack tokens stored",
      path: `${draft}&tab=credentials`,
      slack: true,
      description:
        "Readable Secret names show existing bindings. The console does not retrieve stored token values.",
      steps: [
        "Tab to Save channel Secrets. It takes focus, looks unavailable and is described by No channel Secret changes to save.; Enter submits nothing.",
      ],
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
    credentialsSaveChannelRefused: {
      group: "Components/Credentials",
      name: "Channel Secret save refused for a channel setting",
      path: `${draft}&tab=credentials`,
      slack: true,
      rules: [
        {
          path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
          method: "PATCH",
          status: 400,
          code: "INVALID_REQUEST",
          message:
            "Configuration setting channels.slack.botToken holds a SecretRef the Slack Channel Driver cannot read: use an env SecretRef with provider default, or one whole ${NAME}, bound in secretBindings.",
        },
      ],
      actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
      description:
        "The stored Configuration holds a Slack token form that save now refuses, so saving channel Secrets, which resends the stored values, is refused for that setting.",
      gap: "The refusal is simulated; the API refuses the stored form on the bundled Kubernetes Compute.",
      steps: [
        "Press Save channel Secrets. The Console shows the API's message, which names the setting, and says to fix it in the Configuration JSON on the Configuration tab.",
      ],
    },
    credentialsSaveChannelBindingRefused: {
      group: "Components/Credentials",
      name: "Channel Secret save refused for a missing binding",
      path: `${draft}&tab=credentials`,
      slack: true,
      rules: [
        {
          path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
          method: "PATCH",
          status: 400,
          code: "INVALID_REQUEST",
          message:
            "Configuration setting channels.slack.signingSecret references SLACK_SIGNING_SECRET without a Configuration Secret binding: bind SLACK_SIGNING_SECRET in secretBindings to an environment-backed Secret, or remove the reference.",
        },
      ],
      actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
      description:
        "The stored Configuration references a name that has no Secret binding, so saving channel Secrets, which resends the stored values, is refused for that setting.",
      gap: "The refusal is simulated; the API refuses the unbound reference on the bundled Kubernetes Compute.",
      steps: [
        "Press Save channel Secrets. The Console shows the API's message, which names the setting, and says where the console binds a Secret: this tab for SLACK_APP_TOKEN and SLACK_BOT_TOKEN, the Configuration API for other names.",
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
    credentialsSecretListRefresh: {
      group: "Components/Credentials",
      name: "Refresh Secret list without saving",
      path: `${draft}&tab=credentials`,
      slack: true,
      actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
      // Setup makes three exact collection reads; the permission endpoint is separate.
      rules: [{ path: presetSecretsPath, method: "GET", skip: 3, once: true, delayMs: 3000 }],
      description:
        "The first explicit refresh waits three seconds, preserving query, focus and the staged app token. Save channel Secrets applies the choices.",
      steps: [
        "Type a nonmatching name in Slack bot token. ArrowDown highlights Create; a second ArrowDown highlights Refresh Secret list. Press Enter.",
        "Loading Secrets is disabled during the three-second read. Check that query, focus and staged app token remain. Afterward, choose a Secret; only Save channel Secrets saves bindings. Existing access restrictions still apply.",
      ],
      gap: "The delay is simulated. Real two-tab persistence, races and grants require the browser test; no provider readiness is established.",
    },
    credentialsSecretListRetry: {
      group: "Components/Credentials",
      name: "Retry Secret list without losing a choice",
      path: `${draft}&tab=credentials`,
      slack: true,
      actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
      // Fail the first explicit collection read, after the three successful setup reads.
      rules: [
        {
          path: presetSecretsPath,
          method: "GET",
          skip: 3,
          once: true,
          status: 503,
          code: "UNAVAILABLE",
        },
      ],
      description:
        "The first explicit refresh fails; retry succeeds without clearing the query or staged app token, or saving bindings.",
      steps: [
        "Type a nonmatching name in Slack bot token. Press ArrowDown twice to pass Create and highlight Refresh Secret list, then Enter. Check Secrets unavailable, retained query/focus and the staged app token.",
        "Choose Refresh Secret list again. The read succeeds with query, focus and staged app token intact. Clear the query to choose a Secret; Save channel Secrets alone persists the choices.",
      ],
      gap: "The one-shot failure is simulated. Real staged-choice preservation, late responses and grants require the browser test; no provider readiness is established.",
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
        {
          selector: "#create-harness-auth-secret-name",
          value: "Created while loading (simulated)",
        },
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
  } satisfies Record<string, CredentialScenario>;
}

export function credentialsRecoveryScenarios({ draft }: Pick<CredentialDependencies, "draft">) {
  return {
    credentialsSavedRetryReadDenied: {
      group: "Components/Credentials",
      name: "Saved channel bindings, retry read denied",
      path: `${draft}&tab=credentials`,
      slack: true,
      rules: [
        { method: "POST", suffix: "/iam/access-bindings", status: 403, once: true },
        {
          method: "GET",
          suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
          skip: 2,
          status: 403,
          once: true,
        },
      ],
      actions: [
        { selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" },
        click("Save channel Secrets"),
      ],
      description:
        "Bindings saved, but their grant failed. Retry then loses Configuration read access. A sanitized receipt preserves the successful save while removing binding metadata.",
      steps: [
        "Select Retry Secret access. The receipt says bindings are saved and the Configuration could not be read. No additional PATCH or grant starts.",
        "Select Refresh, then Retry Secret access after reads recover. The saved replacement remains and only its missing grant is retried.",
      ],
    },
    credentialsBindingReadDenied: {
      group: "Components/Credentials",
      name: "Channel binding read denied",
      path: `${draft}&tab=credentials`,
      slack: true,
      rules: [
        {
          path: "/namespaces/ns_00000000-0000-4000-8000-000000000001/configurations/cfg_00000000-0000-4000-8000-000000000001",
          method: "GET",
          skip: 1,
          status: 403,
          once: true,
        },
      ],
      actions: [{ selector: "#runtime-slack-app-token", value: "sec_demo_slack_backup_token" }],
      description:
        "The binding preflight is refused once. Its receipt remains visible, but the saved bindings and staged choice are removed. Refresh reads the saved state without repeating a write.",
      steps: [
        "Select Save channel Secrets. Check Access denied and the failed preflight receipt; no token picker or saved binding remains.",
        "Select Refresh. The simulated read succeeds again and restores the saved bindings, without applying the staged choice.",
        "Select Slack backup token (simulated) again, then Save channel Secrets once. A fresh preflight and one PATCH save that replacement. See unreadable-configuration-workflow.md for the complete walkthrough.",
      ],
    },
    credentialsSlackLeftoverGrantMissing: {
      group: "Components/Credentials",
      name: "Slack key left bound without an Agent grant",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackMode: "http",
      slackTokens: { botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" } },
      slackBindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
      slackGrantMissing: "SLACK_APP_TOKEN",
      description:
        "HTTP mode reads no app token, but SLACK_APP_TOKEN is still bound from Socket Mode and its Secret has no Agent grant. Deploy checks every bound Secret, so the tab lists the key as read by no Slack setting, marks it, blocks Deploy, and offers Retry Secret access.",
      steps: [
        "SLACK_APP_TOKEN reads Bound · not read by the Slack settings · Agent access not confirmed; the warning says deploying would be refused.",
        "Select Retry Secret access. The row reads Bound · not read by the Slack settings and Deploy new version is available; do not deploy.",
      ],
    },
    credentialsSlackOffGrantMissing: {
      group: "Components/Credentials",
      name: "Slack off with a bound Secret without an Agent grant",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackOff: true,
      slackBindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
      slackGrantMissing: "SLACK_APP_TOKEN",
      description:
        "Disable Slack kept both token bindings, and the app token Secret has no Agent grant. Deploy checks every bound Secret, so with Slack off the tab still lists the bound keys as read by no Slack setting, marks the app token, blocks Deploy, and offers Retry Secret access (finding 3018).",
      steps: [
        "SLACK_APP_TOKEN reads Bound · not read by the Slack settings · Agent access not confirmed; Deploy new version names SLACK_APP_TOKEN and says to select Retry Secret access.",
        "Select Retry Secret access. The section says Secret access granted. This Agent can use its bound Secrets. Deploy the new version to deliver them. The row reads Bound · not read by the Slack settings and Deploy new version is available; do not deploy (finding 3021).",
      ],
    },
    credentialsSlackOffRetryUnconfirmed: {
      group: "Components/Credentials",
      name: "Slack off Retry with an unconfirmed grant",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackOff: true,
      slackBindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
      slackGrantMissing: "SLACK_APP_TOKEN",
      rules: [{ suffix: "/iam/access-bindings", method: "POST", status: 503, once: true }],
      actions: [click("Retry Secret access")],
      description:
        "With Slack off, Retry Secret access sends the app token Secret's grant, and the IAM API is unavailable (503), so the grant is not confirmed. A Retry saves no Configuration, so the warning names only the grant and what to do next (finding 3023).",
      gap: "The unavailable IAM API is simulated.",
      steps: [
        "The section says Secret access grants could not be confirmed. Select Retry Secret access again; if it is refused, ask an Installation administrator. It does not say Configuration saved.",
        "Select Retry Secret access again. The section says Secret access granted and Deploy new version is available; do not deploy.",
      ],
    },
    credentialsSlackOffRetryAnswerLost: {
      group: "Components/Credentials",
      name: "Slack off Retry whose answer is lost",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackOff: true,
      slackBindings: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
      slackGrantMissing: "SLACK_APP_TOKEN",
      rules: [{ suffix: "/iam/access-bindings", method: "POST", lostAnswer: true, once: true }],
      // Another browser saves the Configuration after the first Retry, so the second one asks for
      // Reload draft.
      configurationChangedElsewhere: {
        afterReads: 2,
        values: { channels: { slack: { allowFrom: ["UOTHER99"] } } },
      },
      actions: [click("Retry Secret access")],
      description:
        "With Slack off, Retry Secret access makes the app token Secret's grant, but its answer is lost, so the grant is not confirmed. Reload draft rebuilds the section, and its grant read finds the grant: the section says that access is confirmed and takes focus, instead of disappearing (finding 3030).",
      gap: "The lost answer and the other browser's save are simulated; the simulated API keeps the grant.",
      steps: [
        "The section says Secret access grants could not be confirmed. Select Retry Secret access again; if it is refused, ask an Installation administrator.",
        "Select Retry Secret access: another browser changed the Configuration, so the section asks for Reload draft.",
        "Select Reload draft. Once the grant read lands, the section says Secret access confirmed. This Agent can use its bound Secrets. Deploy the new version to deliver them. Focus is on that message, and Deploy new version is available; do not deploy.",
      ],
    },
    credentialsSlackGrantReadPending: {
      group: "Components/Credentials",
      name: "Slack grant read in progress",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackGrantMissing: "SLACK_APP_TOKEN",
      rules: [{ suffix: "/iam/access-bindings", method: "GET", delayMs: 4000 }],
      description:
        "An Installation administrator opens an Agent while the console still reads the Namespace IAM policy for the bound Slack Secrets' grants. Deploy waits for that read, then stays blocked because the app token Secret has no Agent grant.",
      gap: "The slow policy read is simulated.",
      steps: [
        "While the read is held, Prepare says Checking this Agent's credential access before deploying. and Deploy new version is disabled.",
        "After the read lands, the Slack app token reads Bound · Agent access not confirmed and Deploy stays disabled until Retry Secret access grants it.",
      ],
    },
    credentialsSlackSigningSecretMissing: {
      group: "Components/Credentials",
      name: "Slack signing secret without a binding",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackTokens: {
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        signingSecret: "${SLACK_SIGNING_SECRET}",
      },
      description:
        "Both token pickers are bound, but the signing secret reads SLACK_SIGNING_SECRET, which has no binding. Save and deployment refuse that, so the tab lists the key as Missing below the pickers and Deploy waits until it is bound through the Configuration API.",
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
    authSecretGrantParked: {
      group: "Components/Credentials",
      name: "Parked authentication grant",
      path: `${draft}&tab=credentials`,
      harnessGrantMissing: true,
      rules: [
        { suffix: "/iam/roles", delayMs: 4000 },
        { suffix: "/iam/access-bindings", delayMs: 4000 },
      ],
      actions: [
        { selector: "#harness-auth-method" },
        click("Configuration"),
        click("Set up credentials"),
        { selector: 'p.status[data-tone="warning"][role="alert"]' },
      ],
      description:
        "An Installation administrator opens Credentials while Namespace IAM is still answering, switches to Configuration, and returns after the read finds no operate grant. The warning is written on the parked form, so Credentials still names Save authentication source. Deploy stays disabled.",
      steps: [
        "Credentials shows the saved API-key Secret with Save authentication source enabled. The missing-grant warning is absent while Namespace IAM is delayed.",
        "The story selects Configuration before that read finishes. Deploy new version becomes disabled and says to confirm authentication and Secret access in Credentials.",
        "Set up credentials returns to the same form. The warning says deploying would be refused and names Save authentication source. The authentication source control stays enabled.",
      ],
      gap: "The IAM delay is simulated. The browser test holds the controller's real Namespace IAM read across the same tab change.",
    },
    authSecretGrantMemberUnverified: {
      group: "Components/Credentials",
      name: "Member authentication saved, access checked at deploy",
      path: `${draft}&tab=credentials`,
      observabilityDenied: true,
      extraSecrets: [{ id: "sec_demo_replacement", name: "Replacement model token" }],
      actions: [
        { selector: "#harness-auth-method", value: "codex_pat" },
        { selector: "#harness-auth-secret", value: "sec_demo_replacement" },
        click("Save authentication source"),
      ],
      description:
        "A member saves a new model Secret. The session already knows this member does not administer the Installation, so the form sends no IAM request for the Agent's grant. The card settles to one saved status: deploying checks that the Agent can use the selected Secret, and an Installation administrator gives the Agent Secret operate on it if it cannot. It offers no Retry credential access.",
      steps: [
        "Read the status: the source saved, the deploy checks the Agent's access, and an Installation administrator gives it.",
        "The method select, the Secret picker and Save authentication source stay enabled. Pick another Secret: the staged hint replaces the saved status.",
        "Deploy new version stays available, since the API checks the Agent's access when it deploys. The request log shows the Agent PATCH and no /iam/ request.",
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
        {
          suffix: "/agents/agt_00000000-0000-4000-8000-000000000001",
          method: "PATCH",
          status: 503,
        },
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
        "Tab to the account select. It takes focus and looks unavailable, its description is the feedback, and Enter, Space, a click or an arrow key changes nothing.",
      ],
    },
  } satisfies Record<string, CredentialScenario>;
}
