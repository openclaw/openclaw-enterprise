import type { ChannelProviderDriver, DriverImplementation } from "@openclaw-enterprise/contracts";
import { match } from "ts-pattern";

import { SlackChannelDriver } from "./slack.ts";

export type BundledChannelDriverId = "slack-channel";

/** Bundled `drivers.channel` selections and the provider each one serves. */
export const BUNDLED_CHANNEL_DRIVERS: Readonly<
  Record<
    BundledChannelDriverId,
    {
      readonly provider: string;
      readonly implementation: string;
      readonly definition: DriverImplementation;
    }
  >
> = Object.freeze({
  "slack-channel": {
    provider: "slack",
    implementation: "occ/slack-channel",
    definition: SlackChannelDriver,
  },
});

export function isBundledChannelDriverId(value: unknown): value is BundledChannelDriverId {
  return typeof value === "string" && Object.hasOwn(BUNDLED_CHANNEL_DRIVERS, value);
}

/** A validated `drivers.channel` entry. */
export interface ChannelDriverSelection {
  readonly id: BundledChannelDriverId;
  readonly configuration: Readonly<Record<string, unknown>>;
}

/** Omitting `drivers.channel` installs every bundled Channel Driver with default settings. */
export const DEFAULT_CHANNEL_DRIVER_SELECTIONS: readonly ChannelDriverSelection[] = Object.freeze(
  (Object.keys(BUNDLED_CHANNEL_DRIVERS) as BundledChannelDriverId[]).map((id) =>
    Object.freeze({ id, configuration: {} }),
  ),
);

/** The OCC provider listener shared by every bundled Channel Driver. */
export interface ChannelProviderTransport {
  readonly proxyUrl?: string;
  readonly managedProxyHosts?: readonly string[];
  /** Production refuses provider requests when the managed OCC listener is absent. */
  readonly expectProxy?: boolean;
}

/** Build the provider-to-Driver set that trusted composition gives to OCC and Compute. */
export function createChannelProviders(
  selections: readonly ChannelDriverSelection[] = DEFAULT_CHANNEL_DRIVER_SELECTIONS,
  transport: ChannelProviderTransport = {},
): readonly ChannelProviderDriver[] {
  return Object.freeze(
    selections.map(({ id }) =>
      Object.freeze({
        provider: BUNDLED_CHANNEL_DRIVERS[id].provider,
        driver: match(id)
          .with(
            "slack-channel",
            () =>
              new SlackChannelDriver(globalThis.fetch, transport.proxyUrl, {
                ...(transport.managedProxyHosts === undefined
                  ? {}
                  : { managedProxyHosts: transport.managedProxyHosts }),
                expectProxy: transport.expectProxy === true,
              }),
          )
          .exhaustive(),
      }),
    ),
  );
}
