import type {
  KubernetesComputeDriverOptions,
  KubernetesGatewayRoutingOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "./kubernetes-compute.mjs";

type OptionsOverrides = Partial<KubernetesComputeDriverOptions>;
type RoutedOptionsOverrides = Omit<OptionsOverrides, "network"> & {
  network?: Partial<KubernetesComputeDriverOptions["network"]>;
};

export const gatewayRouting = {
  hostname: "agents.example.internal",
  gatewayName: "oce-agent-gateways",
  gatewayNamespace: "openclaw-system",
  envoyNamespace: "envoy-gateway-system",
} satisfies KubernetesGatewayRoutingOptions;

export function options(overrides: OptionsOverrides = {}): KubernetesComputeDriverOptions {
  return {
    ...conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["10.42.0.0/16"] }),
    ...overrides,
    ...(overrides.runtime === undefined
      ? {}
      : {
          runtime: { gatewayNodeSelector: { "oce-role": "control-plane" }, ...overrides.runtime },
        }),
  };
}

export function routedOptions(
  overrides: RoutedOptionsOverrides = {},
): KubernetesComputeDriverOptions {
  const configured = options();
  const { gatewayClients, ...network } = configured.network;
  return options({
    ...overrides,
    gatewayRouting: overrides.gatewayRouting ?? gatewayRouting,
    network: {
      ...network,
      ...(overrides.network ?? {}),
    },
  });
}
