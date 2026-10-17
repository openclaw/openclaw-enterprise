/** Additional authority belongs to the OCE Agent, never native plugin configuration. */
export type GatewayOutboundSelection =
  | { readonly mode: "channelsOnly" }
  | { readonly mode: "restricted"; readonly hosts: readonly string[] }
  | { readonly mode: "publicHttps" };

export interface GatewayOutboundDestination {
  readonly host: string;
  readonly includeSubdomains: boolean;
}

/** Requirements are supplied by a trusted Driver, not caller-authored URLs. */
export interface GatewayOutboundRequirement {
  readonly source: string;
  readonly destinations: readonly GatewayOutboundDestination[];
}

export interface GatewayOutboundSnapshot {
  readonly selection: GatewayOutboundSelection;
  readonly requirements: readonly GatewayOutboundRequirement[];
  readonly denyCidrs: readonly string[];
}

export const GATEWAY_OUTBOUND_HOST_PATTERN =
  "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$";

const hostPattern = new RegExp(GATEWAY_OUTBOUND_HOST_PATTERN);

export function validGatewayOutboundSelection(value: unknown): value is GatewayOutboundSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "channelsOnly" || record.mode === "publicHttps") {
    return Object.keys(record).length === 1;
  }
  return (
    record.mode === "restricted" &&
    Object.keys(record).length === 2 &&
    Array.isArray(record.hosts) &&
    record.hosts.length > 0 &&
    record.hosts.length <= 64 &&
    new Set(record.hosts).size === record.hosts.length &&
    record.hosts.every(
      (host) => typeof host === "string" && host.length <= 253 && hostPattern.test(host),
    )
  );
}

export function validGatewayOutboundSnapshot(value: unknown): value is GatewayOutboundSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    Array.isArray(record.denyCidrs) &&
    record.denyCidrs.length <= 64 &&
    record.denyCidrs.every(
      (cidr) => typeof cidr === "string" && cidr.length > 0 && cidr.length <= 128,
    ) &&
    validGatewayOutboundSelection(record.selection) &&
    Array.isArray(record.requirements) &&
    record.requirements.length <= 32 &&
    record.requirements.every((requirement) => {
      if (typeof requirement !== "object" || requirement === null || Array.isArray(requirement)) {
        return false;
      }
      return (
        Object.keys(requirement).length === 2 &&
        typeof requirement.source === "string" &&
        /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(requirement.source) &&
        Array.isArray(requirement.destinations) &&
        requirement.destinations.length > 0 &&
        requirement.destinations.length <= 64 &&
        requirement.destinations.every(
          (destination: unknown) =>
            typeof destination === "object" &&
            destination !== null &&
            !Array.isArray(destination) &&
            Object.keys(destination).length === 2 &&
            "host" in destination &&
            typeof destination.host === "string" &&
            destination.host.length <= 253 &&
            hostPattern.test(destination.host) &&
            "includeSubdomains" in destination &&
            typeof destination.includeSubdomains === "boolean",
        )
      );
    })
  );
}
