import { story } from "./story.ts";

export default { title: "Components/Plugins" };

export const Available = story("pluginsAvailable");
export const UnavailableReasonPopover = story("pluginsUnavailableReasonPopover");
export const Selected = story("pluginsSelected");
export const UnsupportedToolReviewer = story("pluginsUnsupportedToolReviewer");
export const UnknownTools = story("pluginsUnknownTools");
export const Empty = story("pluginsEmpty");
export const Loading = story("pluginsLoading");
export const KeyboardFocusWhileToolsLoad = story("createPluginsToolsLoading", {
  name: "Keyboard focus while plugin details settle",
  instructions:
    "While Calendar details load, Tab to another plugin without selecting it. Keep focus there until loading settles.",
});
export const Denied = story("pluginsDenied");
export const Error = story("pluginsError");
export const Unavailable = story("pluginsUnavailable");
export const CapabilitiesUnavailable = story("pluginsCapabilitiesUnavailable");
export const NativeLimited = story("pluginsNativeLimited");
export const ManagedGoogleInstall = story("managedGoogleInstall");
