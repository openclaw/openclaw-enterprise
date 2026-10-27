import { story } from "./story.ts";

export default { title: "Pages/Settings" };

export const Settings = { ...story("settings"), name: "Account" };
export const SettingsNameIsEmail = {
  ...story("settingsNameIsEmail"),
  name: "Account without a display name",
};
export const SignOutFailure = { ...story("settingsSignOutFailure"), name: "Sign-out unconfirmed" };
