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
  name: "Slack Sources, viewer can only read",
};
export const CredentialsSlackSwappedKeys = story("credentialsSlackSwappedKeys");
export const CredentialsSlackSourceOperateDenied = story("credentialsSlackSourceOperateDenied");
export const CredentialsSlackStored = {
  ...story("credentialsSlackStored"),
  name: "Slack tokens stored",
};
export const CredentialsSlackReplacement = {
  ...story("credentialsSlackReplacement"),
  name: "Slack token switch",
};
export const CredentialsSlackCarried = {
  ...story("credentialsSlackCarried"),
  name: "Slack token choice carried through a conflict",
};
export const CredentialsSaveProvisioningReserved = {
  ...story("credentialsSaveProvisioningReserved"),
  name: "Credential Source choices after a refused save",
};
export const CredentialsSaveChannelRefused = {
  ...story("credentialsSaveChannelRefused"),
  name: "Channel credential save refused for a channel setting",
};
export const CredentialsSaveConflict = {
  ...story("credentialsSaveConflict"),
  name: "Credential Source choices after a conflict",
};
export const CredentialsSlackSigningSecretMissing = {
  ...story("credentialsSlackSigningSecretMissing"),
  name: "Slack signing secret without a binding",
};
export const CredentialsSavePending = {
  ...story("credentialsSavePending"),
  name: "Channel credential save pending",
};
export const CredentialsSaveUnknown = {
  ...story("credentialsSaveUnknown"),
  name: "Channel credential save outcome unknown",
};
export const CredentialsSlackPartial = {
  ...story("credentialsSlackPartial"),
  name: "One Slack token missing",
};
export const AuthMissing = { ...story("authMissing"), name: "No authentication source" };
export const ReplaceExistingCredentialSource = story("credentialsReplaceExistingSource");
export const FirstManagedCredentialSource = story("credentialsFirstManagedSource");
export const CodexPatFixedDestination = story("credentialsCodexPatFixedDestination");
export const CodexOAuthFixedDestination = story("credentialsCodexOAuthFixedDestination");
export const UnsupportedModelCredentialSource = story("credentialsUnsupportedModelSource");
export const ReplaceCredentialSourceDenied = story("credentialsReplaceSourceDenied");
export const ExistingCredentialSource = story("credentialsExistingSource");
export const AuthApiKeySwitch = {
  ...story("authApiKeySwitch"),
  name: "API key Secret switch",
};
export const AuthRuntime = { ...story("authRuntime"), name: "Operator-managed authentication" };
export const AuthService = { ...story("authService"), name: "ChatGPT service account" };
export const AuthServiceEmpty = story("authServiceEmpty");
export const AuthServiceDenied = story("authServiceDenied");
export const AuthOAuthPollDenied = story("authOAuthPollDenied");

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

export const AuthOAuthStartNavigation = story("authOAuthStartNavigation");

export const AuthOAuthStartTabSwitch = story("authOAuthStartTabSwitch");

export const AuthOAuthStartTabSwitchRefused = story("authOAuthStartTabSwitchRefused");

export const AuthOAuthRestartTabSwitch = story("authOAuthRestartTabSwitch");
