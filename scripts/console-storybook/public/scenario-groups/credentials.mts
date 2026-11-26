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
import { click, modelCredentialSourceTypes } from "../create-agent-form-data.mts";

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
  deviceAuthorization?: true;
  credentialSources?: readonly AgentCredentialSourceBinding[];
  extraSecrets?: readonly Pick<SecretMetadata, "id" | "name">[];
  // These authored permission snapshots omit readLogs; preserve the fixture response.
  agentPermissionSummary?: Omit<NonNullable<Parameters<typeof agentSaveGap>[0]>, "readLogs">;
  auth?: "api-source" | "oauth" | "runtime" | "service" | null;
  configurationChangedElsewhere?: boolean | { afterReads: number; values: Configuration["values"] };
  deployed?: boolean;
  harnessGrantMissing?: boolean;
  oauthPending?: boolean;
  oauthPollCreateDenied?: boolean;
  observabilityDenied?: boolean;
  readOnlyPermissionSummary?: boolean;
  secretCreateNotPermitted?: boolean;
  secretOperateDenied?: readonly string[];
  serviceAccountsEmpty?: boolean;
  slackBindings?: false | "app" | readonly string[];
  unreadableSecretId?: string;
};

type CredentialDependencies = {
  draft: string;
  reservedConfigurationWrite: Parameters<typeof createFixtureFetch>[0][number];
};

export const credentialsThemeScenario = [
  "themeCredentials",
  "authMissing",
  "Custom missing credentials",
  "custom",
] satisfies [string, keyof ReturnType<typeof credentialsScenarios>, string, "custom"];

export function credentialsOAuthScenarios({ draft }: Pick<CredentialDependencies, "draft">) {
  return {
    authOAuthStartNavigation: {
      group: "Components/Credentials",
      name: "ChatGPT replacement interrupted by navigation (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: modelCredentialSourceTypes,
      deviceAuthorization: true,
      deployed: true,
      auth: "oauth",
      actions: [{ selector: "#harness-auth-method", value: "device_login" }],
      rules: [{ suffix: "/device-authorizations", method: "POST", hold: true }],
      description:
        "Start a replacement sign-in, navigate to Secrets, and return with Back. The saved authentication remains; the unconfirmed replacement cannot start twice.",
    },
    authOAuthStartTabSwitch: {
      group: "Components/Credentials",
      name: "ChatGPT sign-in answered on another tab (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: modelCredentialSourceTypes,
      deviceAuthorization: true,
      deployed: true,
      auth: "oauth",
      actions: [{ selector: "#harness-auth-method", value: "device_login" }],
      oauthPending: true,
      rules: [{ suffix: "/device-authorizations", method: "POST", delayMs: 3000, once: true }],
      description:
        "Start a replacement sign-in and open Configuration within 3 s. The reply arrives while Configuration shows; Credentials keeps it, so returning shows the code and Cancel login. The fixture delays the reply; it does not prove provider persistence.",
    },
    authOAuthPollDenied: {
      group: "Components/Credentials",
      name: "ChatGPT login poll denied (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: modelCredentialSourceTypes,
      deviceAuthorization: true,
      deployed: true,
      auth: "oauth",
      actions: [{ selector: "#harness-auth-method", value: "device_login" }],
      oauthPollCreateDenied: true,
      description:
        "Choose Sign in with OAuth. The first poll refuses Source creation and cancels the attempt. Choose Cancel login, then start a new login after access is restored. The fixture simulates the restored grant.",
    },
    authOAuthStartTabSwitchRefused: {
      group: "Components/Credentials",
      name: "ChatGPT sign-in refused on another tab (Experimental)",
      path: `${draft}&tab=credentials`,
      credentialSourceTypes: modelCredentialSourceTypes,
      deviceAuthorization: true,
      deployed: true,
      auth: "oauth",
      actions: [{ selector: "#harness-auth-method", value: "device_login" }],
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
      credentialSourceTypes: modelCredentialSourceTypes,
      deviceAuthorization: true,
      deployed: true,
      auth: "oauth",
      actions: [{ selector: "#harness-auth-method", value: "device_login" }],
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
      credentialSourceTypes: modelCredentialSourceTypes,
      deviceAuthorization: true,
      deployed: true,
      auth: "oauth",
      actions: [{ selector: "#harness-auth-method", value: "device_login" }],
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
    credentialsExistingSource: {
      group: "Components/Credentials",
      name: "Existing Credential Source",
      path: `${draft}&tab=credentials`,
      auth: "api-source",
      description:
        "The Agent retains its saved static Credential Source. ChatGPT sign-in is a separate optional replacement, not the current Source's authentication type.",
      steps: [
        "Confirm Authentication source shows Credential Source and no device-login guidance appears. Select ChatGPT OAuth to review the separate replacement flow.",
      ],
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
        "The Agent uses a Source enrolled from a ChatGPT service account. Agent updates require ordinary Source operate permission.",
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
        "The bot token reads ACME_SLACK_BOT. The Credentials tab offers a Source picker for that exact key, and deployment waits until it is bound.",
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
      name: "Slack Sources, viewer can only read",
      path: `${draft}&tab=credentials`,
      slack: true,
      readOnlyPermissionSummary: true,
      description:
        "The viewer can read the saved Slack Source bindings but cannot edit the Configuration. Each unavailable selector remains in the keyboard Tab order and names that editing restriction.",
      steps: [
        "Tab to Slack app token and Slack bot token. Each selector receives focus and is described by the Configuration read-only reason.",
        "Press an arrow key or Enter. The saved Source selection does not change, and Save channel credentials is not offered.",
      ],
      gap: "This preview simulates the permission answer and Source metadata; it does not prove API authorization or credential delivery.",
    },
    credentialsSlackSwappedKeys: {
      group: "Components/Credentials",
      name: "Slack credential roles use swapped environment keys",
      path: `${draft}&tab=credentials`,
      slack: true,
      slackTokens: {
        appToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        botToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      },
      description:
        "The app setting reads SLACK_BOT_TOKEN and the bot setting reads SLACK_APP_TOKEN. The Source selectors show the exact environment keys instead of assigning the wrong app or bot role to either binding.",
      gap: "This preview simulates Source metadata and Configuration values; it does not validate token roles with Slack.",
    },
    credentialsSlackSourceOperateDenied: {
      group: "Components/Credentials",
      name: "Slack Credential Source operate denied",
      path: `${draft}&tab=credentials`,
      slack: true,
      rules: [
        {
          suffix: "/configurations/cfg_00000000-0000-4000-8000-000000000001",
          method: "PATCH",
          status: 403,
          code: "FORBIDDEN",
          message:
            "Not authorized: this needs CredentialSource operate on cs_00000000-0000-4000-8000-000000000043.",
        },
      ],
      actions: [
        { selector: "#runtime-slack-app-token", value: "cs_00000000-0000-4000-8000-000000000043" },
        click("Save channel credentials"),
      ],
      description:
        "The simulated Configuration save refuses exact operate on the selected Source. The existing binding remains saved and the replacement remains an unsaved choice.",
      gap: "This preview simulates the refusal; it does not prove the backend authorization boundary.",
    },
    credentialsSlackStored: {
      group: "Components/Credentials",
      name: "Slack tokens stored",
      path: `${draft}&tab=credentials`,
      slack: true,
      description:
        "Readable Credential Source names show existing bindings. The console does not retrieve stored token values.",
      steps: [
        "Tab to Save channel credentials. It takes focus, looks unavailable and is described by No channel credential changes to save.; Enter submits nothing.",
      ],
    },
    credentialsSlackReplacement: {
      group: "Components/Credentials",
      name: "Slack token switch",
      path: `${draft}&tab=credentials`,
      slack: true,
      actions: [
        { selector: "#runtime-slack-app-token", value: "cs_00000000-0000-4000-8000-000000000043" },
      ],
      description:
        "A different app Credential Source is selected but not saved. Deploy would use the saved Credential Source, not the one shown in the picker.",
      steps: [
        "Deploy new version is disabled. Choose the saved Slack app token again; Deploy becomes available without a save.",
        "Choose the Slack backup token, then Save channel credentials. Deploy becomes available when the save succeeds; do not deploy.",
      ],
    },
    credentialsSaveProvisioningReserved: {
      group: "Components/Credentials",
      name: "Credential Source choices after a refused save",
      path: `${draft}&tab=credentials`,
      slack: true,
      rules: [reservedConfigurationWrite],
      actions: [
        { selector: "#runtime-slack-app-token", value: "cs_00000000-0000-4000-8000-000000000043" },
      ],
      description:
        "Provisioning has reserved the Configuration. The app token selection is an unsaved choice, not a new binding.",
      steps: [
        "Press Save channel credentials. The Console explains why the Configuration cannot be saved.",
        "The unsaved choice stays selected and Deploy stays disabled. Choose the saved Slack app token again to make Deploy available; no retry or reload is needed.",
      ],
    },
    credentialsSaveChannelRefused: {
      group: "Components/Credentials",
      name: "Channel credential save refused for a channel setting",
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
      actions: [
        { selector: "#runtime-slack-app-token", value: "cs_00000000-0000-4000-8000-000000000043" },
      ],
      description:
        "The stored Configuration holds a Slack token form that save now refuses, so saving channel credentials, which resends the stored values, is refused for that setting.",
      gap: "The refusal is simulated; the API refuses the stored form on the bundled Kubernetes Compute.",
      steps: [
        "Press Save channel credentials. The Console shows the API's message, which names the setting, and says to fix it in the Configuration JSON on the Configuration tab.",
      ],
    },
    credentialsSaveConflict: {
      group: "Components/Credentials",
      name: "Credential Source choices after a conflict",
      path: `${draft}&tab=credentials`,
      slack: true,
      rules: [
        {
          ...reservedConfigurationWrite,
          message: "The requested platform resource already exists.",
        },
      ],
      actions: [
        { selector: "#runtime-slack-app-token", value: "cs_00000000-0000-4000-8000-000000000043" },
      ],
      description:
        "A save meets a generic conflict. The Console explains that the Credential Source choices conflict with saved state, without claiming a duplicate or a stale generation.",
      steps: [
        "Press Save channel credentials. The backup token stays selected, Deploy stays disabled, and no second save is sent. The message does not say the Secret already exists or offer Reload draft.",
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
        { selector: "#runtime-slack-app-token", value: "cs_00000000-0000-4000-8000-000000000043" },
        click("Save channel credentials"),
        click("Reload draft"),
      ],
      description:
        "Another browser saved this Configuration first. The chosen app token stays shown, and Reload draft applies it over the reread bindings for Save channel credentials.",
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
        "The app and bot Source bindings are saved. Select a ready static Credential Source for the additional SLACK_SIGNING_SECRET key before saving channel credentials and deploying.",
    },
    credentialsSavePending: {
      group: "Components/Credentials",
      name: "Channel credential save pending",
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
        { selector: "#runtime-slack-app-token", value: "cs_00000000-0000-4000-8000-000000000043" },
        click("Save channel credentials"),
      ],
      description:
        "Saving and deployment stay blocked while the channel Credential Source binding save is pending. After the 15-second timeout, select Reload draft and inspect the saved app token binding before retrying.",
    },
    credentialsSaveUnknown: {
      group: "Components/Credentials",
      name: "Channel credential save outcome unknown",
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
      actions: [
        { selector: "#runtime-slack-app-token", value: "cs_00000000-0000-4000-8000-000000000043" },
      ],
      description:
        "Press Save channel credentials to simulate an uncertain save. Select Reload draft and inspect the saved app token binding before deploying or retrying; the Console does not retry automatically.",
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
      actions: [
        { selector: "#harness-auth-method", value: "service_account" },
        { selector: "#service-account-id", value: "sa_demo" },
      ],
      description:
        "Select a freshly issued service account. Saving binds its canonical TokenService Source and uses ordinary Source permissions.",
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
      actions: [{ selector: "#harness-auth-method", value: "service_account" }],
      rules: [{ suffix: "/service-accounts", method: "GET", status: 403 }],
      description:
        "A failed account list leaves the saved Source unchanged and explains the refusal only while issued-account selection is open.",
      steps: [
        "Switch Authentication source to API key, Service Accounts, and Operator-managed credentials. The issued-account error disappears; each source shows its own fields with consistent styling.",
        "Return to Issued ChatGPT service account. The unavailable-account feedback and saved account return; the failed lookup does not change its selection.",
        "Tab to the account select. It takes focus and looks unavailable, its description is the feedback, and Enter, Space, a click or an arrow key changes nothing.",
      ],
    },
  } satisfies Record<string, CredentialScenario>;
}
