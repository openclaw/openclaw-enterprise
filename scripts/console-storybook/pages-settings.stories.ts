import { story } from "./story.ts";

export default { title: "Pages/Settings" };

export const Settings = { ...story("settings"), name: "Account" };
export const SettingsNameIsEmail = {
  ...story("settingsNameIsEmail"),
  name: "Account without a display name",
};
export const SignOutFailure = { ...story("settingsSignOutFailure"), name: "Sign-out unconfirmed" };

export const DriverValuesUnavailable = {
  ...story("settingsDriverValuesUnavailable"),
  name: "Driver values unavailable",
};
export const NoDriverConfigurations = {
  ...story("settingsDriverConfigurationsEmpty"),
  name: "No Driver configurations",
};
export const DriverConfigurationLoading = {
  ...story("settingsDriverConfigurationsLoading"),
  name: "Driver configuration loading",
};
export const DriverConfigurationFailure = {
  ...story("settingsDriverConfigurationsFailure"),
  name: "Driver configuration unavailable",
};
export const DriverConfigurationDenied = {
  ...story("settingsDriverConfigurationsDenied"),
  name: "Read-only account: no Driver query",
};
export const DriverConfigurationEndpointRefused = {
  ...story("settingsDriverConfigurationsEndpointRefused"),
  name: "Driver configuration endpoint refused",
};

export const NestedDriverValues = {
  ...story("settingsDriverNestedValues"),
  name: "Nested Driver values",
};

export const SharedModelProvider = {
  ...story("settingsModelProvider"),
  name: "Shared model provider",
};
