import { story } from "./story.mjs";

export default { title: "Pages/Settings" };

export const Settings = { ...story("settings"), name: "Account" };
export const SettingsNameIsEmail = {
  ...story("settingsNameIsEmail"),
  name: "Account without a display name",
};
export const SignOutFailure = { ...story("settingsSignOutFailure"), name: "Sign-out unconfirmed" };
export const SettingsConnectionTemplates = {
  ...story("settingsConnectionTemplates"),
  name: "Connection templates",
};
export const SettingsConnectionTemplateCreate = {
  ...story("settingsConnectionTemplateCreate"),
  name: "New connection template",
};
