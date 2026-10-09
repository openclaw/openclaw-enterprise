import { story } from "./story.mjs";

export default { title: "Pages/Sign in" };

export const Login = { ...story("login"), name: "Signed out" };
export const LoginError = { ...story("loginError"), name: "Invalid credentials" };
export const Expired = { ...story("expired"), name: "Session expired" };
export const SessionUnavailable = { ...story("sessionUnavailable"), name: "Session unavailable" };
export const Loading = { ...story("loading"), name: "Checking session" };
export const LogoutFailure = { ...story("logoutFailure"), name: "Logout unconfirmed" };
export const GitHubLogin = { ...story("githubLogin") };
export const GitHubUnavailable = { ...story("githubUnavailable") };
export const GitHubRateLimited = { ...story("githubRateLimited") };
export const RecoveryOnlyLogin = { ...story("recoveryOnlyLogin") };
export const RecoveryOnlyForm = { ...story("recoveryOnlyForm") };
export const RecoveryOnlyCallbackRejected = { ...story("recoveryOnlyCallbackRejected") };
export const GitHubCallbackRejected = { ...story("githubCallbackRejected") };
export const GitHubResultRejected = { ...story("githubResultRejected") };
export const GoogleLogin = { ...story("googleLogin") };
export const GoogleUnavailable = { ...story("googleUnavailable") };
export const GoogleCallbackRejected = { ...story("googleCallbackRejected") };
export const GoogleResultRejected = { ...story("googleResultRejected") };
export const GoogleAccountDisabled = { ...story("googleAccountDisabled") };
export const RecoveryOnlyAccountDisabled = { ...story("recoveryOnlyAccountDisabled") };
export const ProviderDiscoveryUnavailable = { ...story("providerDiscoveryUnavailable") };
