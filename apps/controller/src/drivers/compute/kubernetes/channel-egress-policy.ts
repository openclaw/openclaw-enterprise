import type { JSONSchema, NetworkDestinationRule } from "@openclaw-enterprise/contracts";
import { normalizeNetworkDestinationRules } from "@openclaw-enterprise/contracts";
import { match } from "ts-pattern";

export interface ChannelEgressOptions {
  readonly gatewayName: string;
  readonly gatewayNamespace: string;
  readonly envoyNamespace: string;
  readonly serviceName: string;
  readonly listenerPortStart: number;
  readonly listenerPortEnd: number;
  readonly occListenerPort: number;
  readonly inspectionPort: number;
  /** Administrator-supplied Pod, Service and node ranges, including public node addresses. */
  readonly excludedCidrs: readonly string[];
}

export const CHANNEL_EGRESS_IMAGE =
  "envoyproxy/envoy@sha256:ccb37e93d8274a525fe00d67287716dbe3d58bc4237d7627af9e64fae0fd25c8";

export const CHANNEL_EGRESS_FORWARD_CLUSTER = {
  name: "channel-egress-forward",
  connect_timeout: "5s",
  lb_policy: "CLUSTER_PROVIDED",
  dns_lookup_family: "V4_ONLY",
  cluster_type: {
    name: "envoy.clusters.dynamic_forward_proxy",
    typed_config: {
      "@type":
        "type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig",
      sub_clusters_config: { lb_policy: "ROUND_ROBIN", max_sub_clusters: 256 },
    },
  },
} as const;

export const CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
]);

const portSchema = { type: "integer", minimum: 1024, maximum: 65535 };
export const channelEgressConfigurationSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "gatewayName",
    "gatewayNamespace",
    "envoyNamespace",
    "serviceName",
    "listenerPortStart",
    "listenerPortEnd",
    "occListenerPort",
    "inspectionPort",
    "excludedCidrs",
  ],
  properties: {
    gatewayName: { type: "string", minLength: 1 },
    gatewayNamespace: { type: "string", minLength: 1 },
    envoyNamespace: { type: "string", minLength: 1 },
    serviceName: { type: "string", minLength: 1 },
    listenerPortStart: portSchema,
    listenerPortEnd: portSchema,
    occListenerPort: portSchema,
    inspectionPort: portSchema,
    excludedCidrs: { type: "array", minItems: 1, maxItems: 128, items: { type: "string" } },
  },
};

export function validateChannelEgressOptions(options: ChannelEgressOptions): void {
  for (const name of [
    options.gatewayName,
    options.gatewayNamespace,
    options.envoyNamespace,
    options.serviceName,
  ]) {
    if (name.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(name)) {
      throw new Error("Channel egress requires exact Kubernetes resource names.");
    }
  }
  const ports = [
    options.listenerPortStart,
    options.listenerPortEnd,
    options.occListenerPort,
    options.inspectionPort,
  ];
  if (
    ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) ||
    options.listenerPortEnd < options.listenerPortStart ||
    options.listenerPortEnd - options.listenerPortStart >= 62 ||
    options.occListenerPort === options.inspectionPort ||
    [options.occListenerPort, options.inspectionPort, 19000, 19001, 19003].some(
      (port) => port >= options.listenerPortStart && port <= options.listenerPortEnd,
    ) ||
    [options.occListenerPort, options.inspectionPort].some((port) =>
      [19000, 19001, 19003].includes(port),
    )
  ) {
    throw new Error(
      "Channel egress requires at most 62 distinct Agent ports and separate OCC and inspection ports.",
    );
  }
  if (!Array.isArray(options.excludedCidrs) || options.excludedCidrs.length === 0) {
    throw new Error("Channel egress requires installation Pod, Service and node CIDR exclusions.");
  }
  normalizeNetworkDestinationRules(
    options.excludedCidrs.map((cidr) => ({ destination: { kind: "cidr", cidr }, ports: [1] })),
  );
}

export function requireSupportedChannelDestinations(
  rules: readonly NetworkDestinationRule[],
): void {
  for (const { destination } of normalizeNetworkDestinationRules(rules)) {
    const address = match(destination)
      .with({ kind: "dns" }, () => undefined)
      .with({ kind: "ip" }, ({ address }) => address)
      .with({ kind: "cidr" }, ({ cidr }) => cidr)
      .exhaustive();
    if (address?.includes(":")) {
      throw new Error(
        "IPv6 channel destinations are not qualified; this installation supports IPv4 upstream connections only.",
      );
    }
  }
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const octet = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const ipv4 = `${octet}(?:\\.${octet}){3}`;

function upstreamCidr(cidr: string): Record<string, unknown> {
  const [address, prefix] = cidr.split("/");
  return {
    matcher: {
      name: "envoy.rbac.matchers.upstream_ip_port",
      typed_config: {
        "@type":
          "type.googleapis.com/envoy.extensions.rbac.matchers.upstream_ip_port.v3.UpstreamIpPortMatcher",
        upstream_ip: { address_prefix: address, prefix_len: Number(prefix) },
      },
    },
  };
}

/** A rule must match the CONNECT authority as well as the selected concrete upstream. */
function destinationPermission(
  rule: NetworkDestinationRule,
  upstream: boolean,
): Record<string, unknown> {
  const host = match(rule.destination)
    .with(
      { kind: "dns" },
      ({ name, match: mode }) =>
        `${mode === "subdomains" ? "(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+" : ""}${escapeRegex(name)}`,
    )
    .with({ kind: "ip" }, ({ address }) => escapeRegex(address))
    .with({ kind: "cidr" }, () => ipv4)
    .exhaustive();
  const rules: Record<string, unknown>[] = [
    { header: { name: ":method", string_match: { exact: "CONNECT" } } },
    {
      header: {
        name: ":authority",
        string_match: { safe_regex: { regex: `(?i:${host}):(?:${rule.ports.join("|")})` } },
      },
    },
  ];
  if (upstream && rule.destination.kind !== "dns") {
    rules.push(
      upstreamCidr(
        rule.destination.kind === "ip" ? `${rule.destination.address}/32` : rule.destination.cidr,
      ),
    );
  }
  return { and_rules: { rules } };
}

export function channelEgressFilterChain(
  generation: string,
  destinations: readonly NetworkDestinationRule[],
  options: ChannelEgressOptions,
): Record<string, unknown> {
  requireSupportedChannelDestinations(destinations);
  const permissions = (upstream: boolean): Record<string, unknown> => ({
    action: "ALLOW",
    policies:
      destinations.length === 0
        ? {}
        : {
            destinations: {
              principals: [{ any: true }],
              permissions: [
                {
                  and_rules: {
                    rules: [
                      {
                        or_rules: {
                          rules: destinations.map((rule) => destinationPermission(rule, upstream)),
                        },
                      },
                      ...(upstream
                        ? [
                            upstreamCidr("0.0.0.0/0"),
                            {
                              not_rule: {
                                or_rules: {
                                  rules: [
                                    ...new Set([
                                      ...CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS,
                                      ...options.excludedCidrs,
                                    ]),
                                  ].map(upstreamCidr),
                                },
                              },
                            },
                          ]
                        : []),
                    ],
                  },
                },
              ],
            },
          },
  });
  return {
    name: generation,
    filters: [
      {
        name: "envoy.filters.network.http_connection_manager",
        typed_config: {
          "@type":
            "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
          stat_prefix: generation,
          stream_idle_timeout: "0s",
          upgrade_configs: [{ upgrade_type: "CONNECT" }],
          route_config: {
            name: generation,
            virtual_hosts: [
              {
                name: generation,
                domains: ["*"],
                routes: [
                  {
                    match: { connect_matcher: {} },
                    route: {
                      cluster: "channel-egress-forward",
                      timeout: "0s",
                      upgrade_configs: [{ upgrade_type: "CONNECT", connect_config: {} }],
                    },
                  },
                ],
              },
            ],
          },
          http_filters: [
            {
              name: "envoy.filters.http.rbac",
              typed_config: {
                "@type": "type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC",
                rules: permissions(false),
              },
            },
            {
              name: "envoy.filters.http.dynamic_forward_proxy",
              typed_config: {
                "@type":
                  "type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig",
                sub_cluster_config: {},
              },
            },
            {
              name: "envoy.filters.http.router",
              typed_config: {
                "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router",
                upstream_http_filters: [
                  {
                    name: "envoy.filters.http.upstream_rbac",
                    typed_config: {
                      "@type": "type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC",
                      rules: permissions(true),
                    },
                  },
                  {
                    name: "envoy.filters.http.upstream_codec",
                    typed_config: {
                      "@type":
                        "type.googleapis.com/envoy.extensions.filters.http.upstream_codec.v3.UpstreamCodec",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };
}
