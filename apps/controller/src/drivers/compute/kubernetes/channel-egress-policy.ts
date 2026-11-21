import type { JSONSchema, NetworkDestinationRule } from "@openclaw-enterprise/contracts";
import {
  normalizeAgentNetworkProxy,
  normalizeNetworkDestinationRules,
} from "@openclaw-enterprise/contracts";
import { isIP } from "node:net";
import { match } from "ts-pattern";
import {
  CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS,
  proxyAddressForbidden,
} from "./channel-proxy-address.ts";

export { CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS } from "./channel-proxy-address.ts";

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
  readonly upstreamProxies?: readonly ChannelUpstreamProxyEndpoint[];
  readonly proxyTrust?: { readonly caSecretName: string; readonly caKey: string };
}

export interface ChannelUpstreamProxyEndpoint {
  readonly url: string;
  readonly addresses: readonly string[];
}

export interface ChannelProxyPolicy {
  readonly clusterName: string;
  readonly addresses: readonly string[];
  readonly port: number;
  readonly credential?: { readonly filterName: string; readonly sdsName: string };
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
    upstreamProxies: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "addresses"],
        properties: {
          url: { type: "string", minLength: 1, maxLength: 2048 },
          addresses: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } },
        },
      },
    },
    proxyTrust: {
      type: "object",
      additionalProperties: false,
      required: ["caSecretName", "caKey"],
      properties: {
        caSecretName: { type: "string", minLength: 1, maxLength: 63 },
        caKey: { type: "string", minLength: 1, maxLength: 253 },
      },
    },
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
  const endpoints = new Set<string>();
  if ((options.upstreamProxies?.length ?? 0) > 32) {
    throw new Error("Channel upstream proxies accept at most 32 endpoints.");
  }
  for (const endpoint of options.upstreamProxies ?? []) {
    if (
      normalizeAgentNetworkProxy({ url: endpoint.url }).url !== endpoint.url ||
      endpoints.has(endpoint.url) ||
      endpoint.addresses.length < 1 ||
      endpoint.addresses.length > 16 ||
      new Set(endpoint.addresses).size !== endpoint.addresses.length
    ) {
      throw new Error(
        "Channel upstream proxies require unique normalized endpoints and addresses.",
      );
    }
    endpoints.add(endpoint.url);
    for (const cidr of endpoint.addresses) {
      const address = cidr.endsWith("/32") ? cidr.slice(0, -3) : "";
      if (isIP(address) !== 4 || proxyAddressForbidden(address, options.excludedCidrs)) {
        throw new Error(
          "A channel upstream proxy address is outside the permitted endpoint scope.",
        );
      }
    }
  }
  if (
    options.proxyTrust &&
    (options.proxyTrust.caSecretName.length > 63 ||
      !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(options.proxyTrust.caSecretName) ||
      options.proxyTrust.caKey.length > 253 ||
      options.proxyTrust.caKey === "." ||
      options.proxyTrust.caKey.startsWith("..") ||
      !/^[A-Za-z0-9._-]+$/.test(options.proxyTrust.caKey) ||
      endpoints.size === 0)
  ) {
    throw new Error("Channel proxy trust requires an exact public CA Secret and key.");
  }
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
  proxy?: ChannelProxyPolicy,
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
  const upstreamRules = proxy
    ? {
        action: "ALLOW",
        policies: {
          proxy: {
            principals: [{ any: true }],
            permissions: [
              {
                or_rules: {
                  rules: proxy.addresses.map((address) => ({
                    matcher: {
                      name: "envoy.rbac.matchers.upstream_ip_port",
                      typed_config: {
                        "@type":
                          "type.googleapis.com/envoy.extensions.rbac.matchers.upstream_ip_port.v3.UpstreamIpPortMatcher",
                        upstream_ip: { address_prefix: address, prefix_len: 32 },
                        upstream_port_range: {
                          start: String(proxy.port),
                          end: String(proxy.port + 1),
                        },
                      },
                    },
                  })),
                },
              },
            ],
          },
        },
      }
    : permissions(true);
  const credentialFilter = proxy?.credential
    ? [
        {
          name: proxy.credential.filterName,
          typed_config: {
            "@type":
              "type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector",
            overwrite: true,
            credential: {
              name: "envoy.http.injected_credentials.generic",
              typed_config: {
                "@type":
                  "type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic",
                credential: {
                  name: proxy.credential.sdsName,
                  sds_config: { ads: {}, resource_api_version: "V3" },
                },
                header: "Proxy-Authorization",
              },
            },
          },
        },
      ]
    : [];
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
                      cluster: proxy?.clusterName ?? "channel-egress-forward",
                      timeout: "0s",
                      upgrade_configs: [
                        proxy
                          ? { upgrade_type: "CONNECT" }
                          : { upgrade_type: "CONNECT", connect_config: {} },
                      ],
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
            ...(!proxy
              ? [
                  {
                    name: "envoy.filters.http.dynamic_forward_proxy",
                    typed_config: {
                      "@type":
                        "type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig",
                      sub_cluster_config: {},
                    },
                  },
                ]
              : []),
            {
              name: "envoy.filters.http.router",
              typed_config: {
                "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router",
                upstream_http_filters: [
                  {
                    name: "envoy.filters.http.upstream_rbac",
                    typed_config: {
                      "@type": "type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC",
                      rules: upstreamRules,
                    },
                  },
                  ...credentialFilter,
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
