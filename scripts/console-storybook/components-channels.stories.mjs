import { story } from "./story.mjs";

export default { title: "Components/Channels" };

export const Slack = { ...story("slack"), name: "Slack configured" };
export const SlackDrawer = { ...story("slackDrawer"), name: "Slack editor" };
export const SlackSecretMenu = { ...story("slackSecretMenu"), name: "Slack Secret menu" };
export const SlackCreateSecretModal = {
  ...story("slackCreateSecretModal"),
  name: "Slack create Secret modal",
};
export const SlackSecretStaged = {
  ...story("slackSecretStaged"),
  name: "Slack staged Secret binding",
};
export const SlackOpen = { ...story("slackOpen"), name: "Slack open policy" };
export const SlackDisabled = { ...story("slackDisabled"), name: "Slack disabled policy" };
export const SlackUnsupported = { ...story("slackUnsupported"), name: "Slack unsupported shape" };
export const ChannelsEmpty = { ...story("channelsEmpty"), name: "Not configured" };
export const ChannelsReadOnly = { ...story("channelsReadOnly"), name: "Revision read only" };
export const ChannelConflict = { ...story("channelConflict"), name: "Save conflict" };
