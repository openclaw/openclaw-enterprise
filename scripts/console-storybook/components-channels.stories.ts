import { story } from "./story.ts";

export default { title: "Components/Channels" };

export const Slack = { ...story("slack"), name: "Slack configured" };
export const SlackDmPolicy = { ...story("slackDmPolicy") };
export const SlackEnterpriseDm = { ...story("slackEnterpriseDm") };
export const SlackThreadedDefault = { ...story("slackThreadedDefault") };
export const SlackReplyOverride = { ...story("slackReplyOverride") };
export const SlackDrawer = { ...story("slackDrawer"), name: "Slack editor" };
export const SlackDrawerNoAuthentication = {
  ...story("slackDrawerNoAuthentication"),
  name: "Slack editor, no model authentication",
};
export const SlackDirectoryChannels = story("slackDirectoryChannels");
export const SlackDirectorySavedNames = story("slackDirectorySavedNames");
export const SlackDirectoryQualifiedNames = story("slackDirectoryQualifiedNames");
export const SlackDirectoryUsers = story("slackDirectoryUsers");
export const SlackDirectoryDenied = story("slackDirectoryDenied");
export const SlackDirectoryLoading = story("slackDirectoryLoading");
export const SlackDirectorySearchRace = story("slackDirectorySearchRace");
export const SlackDirectoryMissingSource = story("slackDirectoryMissingSource");
export const SlackEveryone = { ...story("slackEveryone"), name: "Slack everyone in channels" };
export const SlackRestrictedUsers = {
  ...story("slackRestrictedUsers"),
  name: "Slack restricted channel users",
};
export const SlackChannelAccessIncomplete = {
  ...story("slackChannelAccessIncomplete"),
  name: "Slack sender access incomplete",
};
export const SlackTokensMissing = {
  ...story("slackTokensMissing"),
  name: "Slack Credential Sources missing",
};
export const SlackSourceMenu = story("slackSourceMenu");
export const SlackSourceListLoading = story("slackSourceListLoading");
export const SlackSourceListUnavailable = story("slackSourceListUnavailable");
export const SlackSourceOperateDenied = story("slackSourceOperateDenied");
export const SlackSourceStaged = story("slackSourceStaged");
export const SlackOpen = { ...story("slackOpen"), name: "Slack open policy" };
export const SlackDisabled = { ...story("slackDisabled"), name: "Slack disabled policy" };
export const SlackPluginDenied = { ...story("slackPluginDenied"), name: "Slack plugin denied" };
export const SlackUnsupported = { ...story("slackUnsupported"), name: "Slack unsupported shape" };
export const SlackMixedUsersUnsupported = {
  ...story("slackMixedUsersUnsupported"),
  name: "Slack mixed sender lists",
};
export const SlackWildcardUnsupported = {
  ...story("slackWildcardUnsupported"),
  name: "Slack wildcard channel map",
};
export const SlackChannelAccessFlow = {
  ...story("slackChannelAccessFlow"),
  name: "Change Slack channel senders",
};
export const ChannelsEmpty = { ...story("channelsEmpty"), name: "Not configured" };
export const ChannelsReadOnly = { ...story("channelsReadOnly"), name: "Revision read only" };
export const ChannelConflict = { ...story("channelConflict"), name: "Save conflict" };
export const ChannelSaveRejected = { ...story("channelSaveRejected"), name: "Save rejected" };
export const ChannelSaveDenied = { ...story("channelSaveDenied"), name: "Save denied" };
export const ChannelProvisioningReserved = {
  ...story("channelProvisioningReserved"),
  name: "Save refused during provisioning",
};
export const ChannelChangedElsewhere = story("channelChangedElsewhere");
export const ChannelChangedElsewhereWithEdits = story("channelChangedElsewhereWithEdits");
export const ChannelChangedElsewhereMerged = story("channelChangedElsewhereMerged");
export const ChannelSavePending = { ...story("channelSavePending"), name: "Channel save pending" };
export const ChannelSaveUnknown = {
  ...story("channelSaveUnknown"),
  name: "Channel save outcome unknown",
};

export const SlackNavigation = story("slackNavigation");
