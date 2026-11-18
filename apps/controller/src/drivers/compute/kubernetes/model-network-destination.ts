import type { V1Service } from "@kubernetes/client-node";
import { DependencyUnavailableError, ResourceStateConflictError } from "@openclaw-enterprise/occ";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { isKubernetesNamespaceName } from "./resource-name.ts";

export interface ModelNetworkDestination {
  readonly addresses: readonly string[];
  readonly port: number;
  readonly service?: {
    readonly namespace: string;
    readonly podSelector: Readonly<Record<string, string>>;
    readonly targetPort: number;
  };
}

const unusable = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  unusable.addSubnet(address, prefix, "ipv4");
}

function usable(address: string, infrastructure: readonly (string | undefined)[]): boolean {
  return (
    isIP(address) === 4 && !unusable.check(address, "ipv4") && !infrastructure.includes(address)
  );
}

/** Compute resolves a named provider's endpoint when it reconciles the Agent network policy. */
export async function resolveModelNetworkDestination(
  baseUrl: string,
  options: {
    readonly service: (namespace: string, name: string) => Promise<V1Service>;
    readonly infrastructureAddresses: readonly (string | undefined)[];
    readonly infrastructureNamespaces: readonly (string | undefined)[];
  },
): Promise<ModelNetworkDestination> {
  const endpoint = new URL(baseUrl);
  const port = Number(endpoint.port || 443);
  const match = /^([^.]+)\.([^.]+)\.svc\.cluster\.local$/.exec(endpoint.hostname);
  if (match) {
    const [, name, namespace] = match;
    if (
      !isKubernetesNamespaceName(name!) ||
      !isKubernetesNamespaceName(namespace!) ||
      namespace!.startsWith("kube-") ||
      (namespace === "default" && name === "kubernetes") ||
      options.infrastructureNamespaces.includes(namespace)
    ) {
      throw new ResourceStateConflictError(
        "The model endpoint cannot select platform infrastructure.",
      );
    }
    const service = await options.service(namespace!, name!);
    const metadata = service.metadata;
    const spec = service.spec;
    const mapping = spec?.ports?.filter(
      (entry) => entry.port === port && (entry.protocol ?? "TCP") === "TCP",
    );
    const targetPort =
      mapping?.length === 1 ? (mapping[0]!.targetPort ?? mapping[0]!.port) : undefined;
    const selector = spec?.selector;
    if (
      !metadata ||
      metadata.name !== name ||
      metadata.namespace !== namespace ||
      metadata.deletionTimestamp ||
      spec?.type !== "ClusterIP" ||
      !spec.clusterIP ||
      !usable(spec.clusterIP, options.infrastructureAddresses) ||
      spec.externalName ||
      spec.externalIPs?.length ||
      !selector ||
      Object.keys(selector).length === 0 ||
      Object.keys(selector).some(
        (key) => key.startsWith("openclaw.dev/") || key.startsWith("openshell.ai/"),
      ) ||
      typeof targetPort !== "number" ||
      !Number.isInteger(targetPort) ||
      targetPort < 1 ||
      targetPort > 65535
    ) {
      throw new ResourceStateConflictError(
        "The model endpoint does not resolve to a usable ClusterIP Service and TCP port.",
      );
    }
    return {
      addresses: [spec.clusterIP],
      port,
      service: { namespace: namespace!, podSelector: { ...selector }, targetPort },
    };
  }
  let addresses: string[];
  if (isIP(endpoint.hostname) === 4) {
    addresses = [endpoint.hostname];
  } else {
    try {
      addresses = [
        ...new Set(
          (await lookup(endpoint.hostname, { family: 4, all: true })).map(({ address }) => address),
        ),
      ];
    } catch {
      throw new DependencyUnavailableError(
        "Compute could not resolve the model endpoint's IPv4 addresses.",
      );
    }
  }
  if (
    !addresses.length ||
    addresses.length > 32 ||
    addresses.some((address) => !usable(address, options.infrastructureAddresses))
  ) {
    throw new ResourceStateConflictError(
      "The model endpoint resolved to an unusable or infrastructure address.",
    );
  }
  return { addresses, port };
}
