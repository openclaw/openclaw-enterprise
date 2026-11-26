import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { ChannelEgressOptions } from "../../apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts";

/** Configuration fixture only; this does not assert that an Envoy fleet is installed. */
export const channelEgressOptions: ChannelEgressOptions = {
  gatewayName: "channel-egress",
  gatewayNamespace: "openclaw-system",
  envoyNamespace: "envoy-gateway-system",
  serviceName: "channel-egress",
  listenerPortStart: 10001,
  listenerPortEnd: 10062,
  occListenerPort: 10000,
  inspectionPort: 19004,
  excludedCidrs: ["10.0.0.0/8", "172.16.0.0/12"],
};

export const slackChannelDrivers = [{ provider: "slack", driver: new SlackChannelDriver() }];

export function createChannelTestCompute(
  options: KubernetesComputeDriverOptions,
): KubernetesComputeDriver {
  return new KubernetesComputeDriver(options, { channelDrivers: slackChannelDrivers });
}
