import { story } from "./story.ts";

export default { title: "Pages/Sign in" };

export const Login = { ...story("login"), name: "Signed out" };
export const LoginError = { ...story("loginError"), name: "Invalid credentials" };
export const PasswordSignInUnconfirmed = { ...story("passwordSignInUnconfirmed") };
export const Expired = { ...story("expired"), name: "Session expired" };
export const FirstVisit = { ...story("firstVisit"), name: "Deep link, first visit" };
export const SessionUnavailable = { ...story("sessionUnavailable"), name: "Session unavailable" };
export const MissingSessionBindingRetry = {
  ...story("missingSessionBindingRetry", { openInNewTab: true }),
  name: "Missing session binding, retry",
};
export const Loading = { ...story("loading"), name: "Checking session" };
export const LogoutFailure = { ...story("logoutFailure"), name: "Sign-out unconfirmed" };
export const OIDCLogin = { ...story("oidcLogin") };
export const OIDCUnavailable = { ...story("oidcUnavailable") };
export const OIDCRateLimited = { ...story("oidcRateLimited") };
export const RecoveryOnlyLogin = { ...story("recoveryOnlyLogin") };
export const RecoveryOnlyForm = { ...story("recoveryOnlyForm") };
export const RecoveryOnlyCallbackRejected = { ...story("recoveryOnlyCallbackRejected") };
export const OIDCCallbackRejected = { ...story("oidcCallbackRejected") };
export const OIDCResultRejected = { ...story("oidcResultRejected") };
export const GoogleLogin = { ...story("googleLogin") };
export const GoogleUnavailable = { ...story("googleUnavailable") };
export const GoogleCallbackRejected = { ...story("googleCallbackRejected") };
export const GoogleResultRejected = { ...story("googleResultRejected") };
export const GoogleAccountDisabled = { ...story("googleAccountDisabled") };
export const RecoveryOnlyAccountDisabled = { ...story("recoveryOnlyAccountDisabled") };
export const RecoveryOnlyProviderUnavailable = { ...story("recoveryOnlyProviderUnavailable") };
export const ProviderDiscoveryUnavailable = { ...story("providerDiscoveryUnavailable") };
