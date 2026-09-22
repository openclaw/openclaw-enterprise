import { story } from "./story.mjs";

export default { title: "Components/Credentials" };

export const Credentials = { ...story("credentials"), name: "Stored" };
export const CredentialsMissing = {
  ...story("credentialsMissing"),
  name: "Missing generated credentials",
};
export const CredentialsSlack = { ...story("credentialsSlack"), name: "Slack token entry" };
export const CredentialsLocked = {
  ...story("credentialsLocked"),
  name: "Generated credentials locked",
};
export const CredentialsError = { ...story("credentialsError"), name: "Metadata unavailable" };
export const AuthMissing = { ...story("authMissing"), name: "No authentication source" };
export const AuthRuntime = { ...story("authRuntime"), name: "Operator-managed authentication" };
export const AuthService = { ...story("authService"), name: "ChatGPT service account" };
