import { SlackChannelDriver } from "../drivers/channel/slack.ts";

/** Select provider operations and their pure outbound requirements together. */
export function createBundledChannelCapabilities(
  options: {
    readonly proxyUrl?: string;
    readonly managedProxyHost?: string;
  } = {},
) {
  const driver = new SlackChannelDriver(globalThis.fetch, options.proxyUrl, {
    managedProxyHosts: options.managedProxyHost === undefined ? [] : [options.managedProxyHost],
  });
  return { driver, channelNetworkRequirements: driver.gatewayNetworkRequirements.bind(driver) };
}
