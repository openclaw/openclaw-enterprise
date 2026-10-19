import { story } from "./story.mjs";

export default { title: "Components/Plugins" };

export const Available = story("pluginsAvailable");
export const UnavailableReasonPopover = story("pluginsUnavailableReasonPopover");
export const Selected = story("pluginsSelected");
export const UnsupportedToolReviewer = story("pluginsUnsupportedToolReviewer");
export const UnknownTools = story("pluginsUnknownTools");
export const Empty = story("pluginsEmpty");
export const Loading = story("pluginsLoading");
const toolsLoading = story("createPluginsToolsLoading");
const keyboardFocusTitle = "Keyboard focus while plugin details settle";
export const KeyboardFocusWhileToolsLoad = {
  ...toolsLoading,
  name: keyboardFocusTitle,
  render() {
    const preview = toolsLoading.render();
    preview.querySelector("h1").textContent = keyboardFocusTitle;
    const instructions = preview.ownerDocument.createElement("p");
    instructions.textContent =
      "While Calendar details load, Tab to another plugin without selecting it. Keep focus there until loading settles.";
    preview.querySelector("iframe").before(instructions);
    return preview;
  },
};
export const Denied = story("pluginsDenied");
export const Error = story("pluginsError");
export const Unavailable = story("pluginsUnavailable");
export const CapabilitiesUnavailable = story("pluginsCapabilitiesUnavailable");
export const NativeLimited = story("pluginsNativeLimited");
