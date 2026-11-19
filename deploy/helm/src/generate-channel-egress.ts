import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SlackChannelDriver } from "../../../apps/controller/src/drivers/channel/slack.ts";
import {
  CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS,
  CHANNEL_EGRESS_IMAGE,
  CHANNEL_EGRESS_FORWARD_CLUSTER,
  channelEgressFilterChain,
} from "../../../apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts";

// Packaging consumes the same provider contract as deployment reconciliation.
const destinations = new SlackChannelDriver().enableRouting();
const generation = createHash("sha256")
  .update(JSON.stringify(destinations))
  .digest("hex")
  .slice(0, 24);
const options = {
  gatewayName: "generated",
  gatewayNamespace: "generated",
  envoyNamespace: "generated",
  serviceName: "generated",
  listenerPortStart: 10001,
  listenerPortEnd: 10062,
  occListenerPort: 10000,
  inspectionPort: 19004,
  excludedCidrs: [],
};
const document = {
  image: CHANNEL_EGRESS_IMAGE,
  excludedIpv4Cidrs: CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS,
  occFilterChain: channelEgressFilterChain(`occ-${generation}`, destinations, options),
  forwardCluster: CHANNEL_EGRESS_FORWARD_CLUSTER,
  inspectionCluster: {
    name: "channel-egress-inspection",
    type: "STATIC",
    connect_timeout: "1s",
    load_assignment: {
      cluster_name: "channel-egress-inspection",
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: { socket_address: { address: "127.0.0.1", port_value: 19000 } },
              },
            },
          ],
        },
      ],
    },
  },
  inspectionFilterChain: {
    name: "channel-egress-inspection",
    filters: [
      {
        name: "envoy.filters.network.http_connection_manager",
        typed_config: {
          "@type":
            "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
          stat_prefix: "channel-egress-inspection",
          http_filters: [
            {
              name: "envoy.filters.http.router",
              typed_config: {
                "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router",
              },
            },
          ],
          route_config: {
            name: "inspection",
            virtual_hosts: [
              {
                name: "inspection",
                domains: ["*"],
                routes: [
                  {
                    match: {
                      path: "/config_dump",
                      headers: [{ name: ":method", string_match: { exact: "GET" } }],
                    },
                    route: { cluster: "channel-egress-inspection" },
                  },
                  {
                    match: {
                      path: "/stats",
                      headers: [{ name: ":method", string_match: { exact: "GET" } }],
                    },
                    route: { cluster: "channel-egress-inspection" },
                  },
                  { match: { prefix: "/" }, direct_response: { status: 404 } },
                ],
              },
            ],
          },
        },
      },
    ],
  },
};
const path = new URL("../openclaw-enterprise/files/channel-egress.json", import.meta.url);
const output = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output) {
    throw new Error(
      "Packaged channel egress differs from the current Drivers; run node deploy/helm/src/generate-channel-egress.ts.",
    );
  }
} else {
  await writeFile(path, output);
}
