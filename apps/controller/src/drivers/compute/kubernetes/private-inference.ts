import type { V1Service } from "@kubernetes/client-node";
import {
  normalizeInferenceBaseUrl,
  type InferencePrivatePeer,
  type InferencePrivatePeerInput,
} from "@openclaw-enterprise/contracts";
import { ResourceStateConflictError } from "@openclaw-enterprise/occ";
import { isIP } from "node:net";
import { isKubernetesNamespaceName } from "./resource-name.ts";

function checkAddress(address: string, infrastructure: readonly (string | undefined)[]): void {
  if (
    isIP(address) !== 4 ||
    !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address) ||
    infrastructure.includes(address)
  ) {
    throw new ResourceStateConflictError(
      "Private inference needs a dedicated RFC 1918 IPv4 address outside the Installation's infrastructure.",
    );
  }
}

/** Resolve the API object's reviewed Service identity, never a DNS answer or an ExternalName. */
export async function resolvePrivateInferencePeer(
  input: InferencePrivatePeerInput,
  baseUrl: string,
  options: {
    readonly service: (namespace: string, name: string) => Promise<V1Service>;
    readonly infrastructureAddresses: readonly (string | undefined)[];
    readonly infrastructureNamespaces: readonly (string | undefined)[];
  },
): Promise<InferencePrivatePeer> {
  const endpoint = new URL(normalizeInferenceBaseUrl(baseUrl));
  if (input.kind === "private_ipv4") {
    if (/(?:^|\.)(?:svc|pod)(?:\.|$)|\.(?:localhost|localdomain)$/.test(endpoint.hostname)) {
      throw new ResourceStateConflictError(
        "Choose a Kubernetes Service for a cluster endpoint, or use the private server's DNS name.",
      );
    }
    checkAddress(input.address, options.infrastructureAddresses);
    return { kind: "private_ipv4", address: input.address };
  }
  const { namespace, name } = input;
  if (
    !isKubernetesNamespaceName(name) ||
    !isKubernetesNamespaceName(namespace) ||
    namespace.startsWith("kube-") ||
    (namespace === "default" && name === "kubernetes") ||
    options.infrastructureNamespaces.includes(namespace) ||
    endpoint.hostname !== `${name}.${namespace}.svc.cluster.local`
  ) {
    throw new ResourceStateConflictError(
      "Select the model Service by its full service.namespace.svc.cluster.local DNS name outside platform infrastructure.",
    );
  }
  const service = await options.service(namespace, name);
  const metadata = service.metadata;
  const spec = service.spec;
  const address = spec?.clusterIP;
  const selector = spec?.selector;
  const ports = spec?.ports?.filter(
    (entry) => entry.port === Number(endpoint.port || 443) && (entry.protocol ?? "TCP") === "TCP",
  );
  const port = ports?.length === 1 ? ports[0] : undefined;
  const targetPort = port?.targetPort ?? port?.port;
  if (
    metadata?.name !== name ||
    metadata.namespace !== namespace ||
    !metadata.uid ||
    metadata.deletionTimestamp ||
    !spec ||
    spec.type !== "ClusterIP" ||
    spec.externalIPs?.length ||
    spec.externalName ||
    !address ||
    spec.clusterIPs?.some((ip) => ip !== address) ||
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
      "Private inference requires a live IPv4 ClusterIP Service with a model Pod selector and a matching TCP port with a numeric target port.",
    );
  }
  checkAddress(address, options.infrastructureAddresses);
  return {
    kind: "kubernetes_service",
    namespace,
    name,
    uid: metadata.uid,
    address,
    podSelector: { ...selector },
    targetPort,
  };
}
