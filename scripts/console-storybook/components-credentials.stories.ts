import { story } from "./story.ts";

export default { title: "Components/Credentials" };

export const Credentials = { ...story("credentials"), name: "Model authentication" };
export const CredentialsUpdateDenied = story("credentialsUpdateDenied");
export const CredentialsSlack = { ...story("credentialsSlack"), name: "Slack tokens missing" };
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
export const CredentialsSaveConflict = {
  ...story("credentialsSaveConflict"),
  name: "Secret choices after a conflict",
};
export const CredentialsSecretListDenied = {
  ...story("credentialsSecretListDenied"),
  name: "Secret list denied",
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
