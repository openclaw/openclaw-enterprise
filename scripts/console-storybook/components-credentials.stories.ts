import { story } from "./story.ts";

export default { title: "Components/Credentials" };

export const Credentials = { ...story("credentials"), name: "Model authentication" };
export const CredentialsSecretCreateNotPermitted = {
  ...story("credentialsSecretCreateNotPermitted"),
  name: "Model authentication, Secret creation not permitted",
};
export const CredentialsUpdateDenied = story("credentialsUpdateDenied");
export const CredentialsSourcesOperateDenied = {
  ...story("credentialsSourcesOperateDenied"),
  name: "Model authentication, editor cannot operate a bound source",
};
export const CredentialsServiceAccountReadDenied = {
  ...story("credentialsServiceAccountReadDenied"),
  name: "Model authentication, editor may lack read on the ChatGPT service account",
};
export const CredentialsSlack = { ...story("credentialsSlack"), name: "Slack tokens missing" };
export const CredentialsSlackOtherKeys = {
  ...story("credentialsSlackOtherKeys"),
  name: "Slack tokens on other keys",
};
export const CredentialsSlackHttp = {
  ...story("credentialsSlackHttp"),
  name: "Slack HTTP mode, bot token only",
};
export const CredentialsSlackReader = {
  ...story("credentialsSlackReader"),
  name: "Slack tokens, viewer can only read",
};
export const CredentialsSlackSecretsOperateDenied = {
  ...story("credentialsSlackSecretsOperateDenied"),
  name: "Slack tokens, editor cannot operate the bound Secrets",
};
export const CredentialsSlackReplaceDenied = {
  ...story("credentialsSlackReplaceDenied"),
  name: "Slack tokens, editor must replace the bot token Secret",
};
export const CredentialsSlackOperateDenied = {
  ...story("credentialsSlackOperateDenied"),
  name: "Slack tokens, editor cannot operate one readable Secret",
};
export const CredentialsSlackStored = {
  ...story("credentialsSlackStored"),
  name: "Slack tokens stored",
};
export const CredentialsSlackReplacement = {
  ...story("credentialsSlackReplacement"),
  name: "Slack token switch",
};
export const DiscardSecretChoice = {
  ...story("credentialsDiscardSecretChoice"),
  name: "Discard an unsaved Secret choice",
};
export const CredentialsSlackCarried = {
  ...story("credentialsSlackCarried"),
  name: "Slack token choice carried through a conflict",
};
export const CredentialsSaveProvisioningReserved = {
  ...story("credentialsSaveProvisioningReserved"),
  name: "Secret choices after a refused save",
};
export const CredentialsSaveChannelRefused = {
  ...story("credentialsSaveChannelRefused"),
  name: "Channel Secret save refused for a channel setting",
};
export const CredentialsSaveChannelBindingRefused = {
  ...story("credentialsSaveChannelBindingRefused"),
  name: "Channel Secret save refused for a missing binding",
};
export const CredentialsSaveConflict = {
  ...story("credentialsSaveConflict"),
  name: "Secret choices after a conflict",
};
export const CredentialsSecretListDenied = {
  ...story("credentialsSecretListDenied"),
  name: "Secret list denied",
};
export const CredentialsSecretListRefresh = {
  ...story("credentialsSecretListRefresh"),
  name: "Refresh Secret list without saving",
};
export const CredentialsSecretListRetry = {
  ...story("credentialsSecretListRetry"),
  name: "Retry Secret list without losing a choice",
};
export const CredentialsSecretListScrolling = {
  ...story("credentialsSecretListScrolling"),
  name: "Scrolling Secret list",
};
export const CredentialsSecretListFailsAfterStaging = {
  ...story("credentialsSecretListFailsAfterStaging"),
  name: "Secret list fails after a staged Secret",
};
export const CredentialsSlackGrantDenied = {
  ...story("credentialsSlackGrantDenied"),
  name: "Slack grant denied",
};
export const CredentialsSlackGrantMissing = {
  ...story("credentialsSlackGrantMissing"),
  name: "Slack Secret bound without an Agent grant",
};
export const CredentialsBindingReadDenied = story("credentialsBindingReadDenied");
export const CredentialsSlackLeftoverGrantMissing = {
  ...story("credentialsSlackLeftoverGrantMissing"),
  name: "Slack key left bound without an Agent grant",
};
export const CredentialsSlackGrantReadPending = {
  ...story("credentialsSlackGrantReadPending"),
  name: "Slack grant read in progress",
};
export const CredentialsSlackSigningSecretMissing = {
  ...story("credentialsSlackSigningSecretMissing"),
  name: "Slack signing secret without a binding",
};
export const CredentialsSavePending = {
  ...story("credentialsSavePending"),
  name: "Channel Secret save pending",
};
export const CredentialsSaveUnknown = {
  ...story("credentialsSaveUnknown"),
  name: "Channel Secret save outcome unknown",
};
export const CredentialsSlackPartial = {
  ...story("credentialsSlackPartial"),
  name: "One Slack token missing",
};
export const AuthMissing = { ...story("authMissing"), name: "No authentication source" };
export const AuthApiKeySwitch = {
  ...story("authApiKeySwitch"),
  name: "API key Secret switch",
};
export const AuthRuntime = { ...story("authRuntime"), name: "Operator-managed authentication" };
export const AuthService = { ...story("authService"), name: "ChatGPT service account" };
export const AuthServiceEmpty = story("authServiceEmpty");
export const AuthServiceDenied = story("authServiceDenied");
export const AuthOAuthReconnect = story("authOAuthReconnect");

export const AuthSecretReplacement = {
  ...story("authSecretReplacement"),
  name: "Replace model Secret",
};
export const AuthSaveRefused = {
  ...story("authSaveRefused"),
  name: "Authentication save refused",
};
export const AuthSecretGrantDenied = {
  ...story("authSecretGrantDenied"),
  name: "Authentication saved, grant denied",
};
export const AuthSecretGrantMissing = {
  ...story("authSecretGrantMissing"),
  name: "Authentication Secret without an Agent grant",
};
export const AuthSecretGrantParked = {
  ...story("authSecretGrantParked"),
  name: "Parked authentication grant",
};
export const AuthSecretGrantMemberUnverified = {
  ...story("authSecretGrantMemberUnverified"),
  name: "Member authentication saved, access not verified",
};
export const AuthSecretGrantLoading = {
  ...story("authSecretGrantLoading"),
  name: "Checking model Secret access",
};
export const AuthSaveHoldsNavigation = {
  ...story("authSaveHoldsNavigation"),
  name: "Authentication save holds navigation",
};
export const AuthSaveUnknown = { ...story("authSaveUnknown"), name: "Authentication save unknown" };
export const AuthenticationNavigation = story("authenticationNavigation");

export const CredentialsSavedRetryReadDenied = {
  ...story("credentialsSavedRetryReadDenied"),
  name: "Saved channel bindings, retry read denied",
};

export const AuthOAuthStartNavigation = story("authOAuthStartNavigation");

export const AuthOAuthStartTabSwitch = story("authOAuthStartTabSwitch");

export const AuthOAuthStartTabSwitchRefused = story("authOAuthStartTabSwitchRefused");

export const AuthOAuthRestartTabSwitch = story("authOAuthRestartTabSwitch");
