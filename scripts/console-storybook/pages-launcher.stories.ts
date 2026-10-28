import { story } from "./story.ts";

export default { title: "Pages/Launcher" };

export const Administrator = { ...story("launcherAdmin"), name: "Administrator chooser" };
export const MultipleClaws = { ...story("launcherMultiple"), name: "Multiple Claws" };
export const SingleClaw = { ...story("launcherSingle"), name: "One Claw chooser-only mode" };
export const Unavailable = { ...story("launcherUnavailable"), name: "One stopped Claw" };
export const NoAccess = { ...story("launcherEmpty"), name: "No access assigned" };
export const DiscoveryFailure = { ...story("launcherFailure"), name: "Discovery unavailable" };
export const Loading = { ...story("launcherLoading"), name: "Checking access" };
export const SignIn = { ...story("launcherLogin"), name: "Sign in and continue" };
export const DefaultSignIn = {
  ...story("launcherDefaultLogin"),
  name: "Default sign-in after Sign out",
};
