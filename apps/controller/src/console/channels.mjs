import { slack } from "./channels/slack.mjs";
import { teams } from "./channels/teams.mjs";
import { renderChannelSection } from "./channels/shared-ui.mjs";

export function renderChannels(options) {
  return renderChannelSection(options, [slack, teams]);
}
