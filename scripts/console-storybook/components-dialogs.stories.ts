import { story } from "./story.ts";

export default { title: "Components/Dialogs" };

// The dialog pattern (one chrome, drawer and phone sheet) across the five modal dialogs. Each
// story reuses the dialog's own scenario; the phone variants frame it at 390 px, where every
// dialog is a bottom sheet. Walk them with dialog-pattern-workflow.md.
const phone = (id: string) => story(id, { frameWidth: "390px" });

export const StopConfirmation = { ...story("stopConfirm"), name: "Stop confirmation" };
export const StopConfirmationPhone = { ...phone("stopConfirm"), name: "Stop confirmation (phone)" };
export const DeleteConfirmation = { ...story("deletionConfirm"), name: "Delete confirmation" };
export const DeleteConfirmationPhone = {
  ...phone("deletionConfirm"),
  name: "Delete confirmation (phone)",
};
export const Plugins = { ...story("pluginsAvailable"), name: "Plugins (wide)" };
export const PluginsPhone = { ...phone("pluginsAvailable"), name: "Plugins (phone)" };
// Up to 1100 px the plugin workspace stacks: the catalog or one plugin's detail, with Back to plugins.
export const PluginsTablet = {
  ...story("pluginsAvailable", { frameWidth: "1024px" }),
  name: "Plugins (tablet)",
};
export const SlackDrawer = { ...story("slackDrawer"), name: "Slack editor (drawer)" };
export const SlackDrawerPhone = { ...phone("slackDrawer"), name: "Slack editor (phone)" };
export const CreateSecret = { ...story("slackCreateSecretModal"), name: "Create Secret" };
export const CreateSecretPhone = {
  ...phone("slackCreateSecretModal"),
  name: "Create Secret (phone)",
};
