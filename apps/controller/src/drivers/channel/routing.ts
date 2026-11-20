import {
  normalizeNetworkDestinationRules,
  type ChannelDriver,
  type NetworkDestinationRule,
} from "@openclaw-enterprise/contracts";

/** Installed by trusted composition, never supplied through Agent configuration. */
export interface ChannelProviderDriver {
  readonly provider: string;
  readonly driver: ChannelDriver;
}

export interface ChannelRoutingRequirements {
  readonly providers: readonly string[];
  readonly drivers: readonly { readonly id: string; readonly implementation: string }[];
  readonly destinations: readonly NetworkDestinationRule[];
}

export function resolveChannelRouting(
  enabled: readonly string[],
  installed: readonly ChannelProviderDriver[],
): ChannelRoutingRequirements {
  const providers = [...new Set(enabled)].sort();
  const drivers: { id: string; implementation: string }[] = [];
  const destinations: NetworkDestinationRule[] = [];
  for (const provider of providers) {
    const matches = installed.filter((entry) => entry.provider === provider);
    if (matches.length !== 1) {
      throw new Error("An enabled channel must resolve to exactly one installed Channel Driver.");
    }
    const driver = matches[0]!.driver;
    if (driver.capability !== "channel" || typeof driver.enableRouting !== "function") {
      throw new Error("The selected Channel Driver does not declare routing requirements.");
    }
    drivers.push(Object.freeze({ id: driver.id, implementation: driver.implementation }));
    destinations.push(...normalizeNetworkDestinationRules(driver.enableRouting()));
  }
  const unique = new Map(destinations.map((rule) => [JSON.stringify(rule), rule]));
  return Object.freeze({
    providers: Object.freeze(providers),
    drivers: Object.freeze(drivers),
    destinations: Object.freeze(
      [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, rule]) => rule),
    ),
  });
}
