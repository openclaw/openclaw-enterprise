import type {
  CoreV1Api,
  NetworkingV1Api,
  V1NetworkPolicyPeer,
  V1NetworkPolicySpec,
} from "@kubernetes/client-node";
import { numericErrorStatus } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import type { KubernetesWorkloadPeer } from "./index.ts";
import { isKubernetesNamespaceName } from "./resource-name.ts";
import { ordinaryNetworkPolicySelector } from "./resources/network.ts";

const policyName = "openclaw-enterprise-prepared-repository-ingress";
const namespaceLabel = "kubernetes.io/metadata.name";
const brokerPort = 8443;

export interface PreparedRepositoryIngressOwner {
  readonly namespace: string;
  readonly namespaceId: string;
  /** Omitted only when pruning the entire owned Namespace. */
  readonly revision?: {
    readonly id: string;
    readonly agentId: string;
    readonly servicePrincipalId: string;
  };
}

function harnessPeer({ namespace, namespaceId, revision }: PreparedRepositoryIngressOwner) {
  const identities = {
    "openclaw.dev/namespace": namespaceId,
    "openclaw.dev/revision": revision?.id ?? "",
    "openclaw.dev/agent": revision?.agentId ?? "",
    "openclaw.dev/service-principal": revision?.servicePrincipalId ?? "",
  };
  if (
    !isKubernetesNamespaceName(namespace) ||
    !Object.values(identities).every((value) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(value),
    )
  ) {
    throw new Error(
      "Prepared repository ingress requires the exact Compute-owned Harness revision.",
    );
  }
  return {
    namespaceSelector: { matchLabels: { [namespaceLabel]: namespace } },
    podSelector: ordinaryNetworkPolicySelector({
      ...identities,
      "openclaw.dev/workload-role": "agent",
    }),
  };
}

/** Fail closed if any stored peer is broader than an exact Compute Harness revision. */
function canonicalPeer(peer: V1NetworkPolicyPeer) {
  const labels = peer.podSelector?.matchLabels ?? {};
  return harnessPeer({
    namespace: peer.namespaceSelector?.matchLabels?.[namespaceLabel] ?? "",
    namespaceId: labels["openclaw.dev/namespace"] ?? "",
    revision: {
      id: labels["openclaw.dev/revision"] ?? "",
      agentId: labels["openclaw.dev/agent"] ?? "",
      servicePrincipalId: labels["openclaw.dev/service-principal"] ?? "",
    },
  });
}

/**
 * Helm owns an initially closed policy. Compute updates only that policy using resourceVersion.
 * The peer list is the state; no parallel annotation or process-local source of truth.
 * This is transport admission, not authentication or withdrawal of a Git session.
 */
export async function reconcilePreparedRepositoryIngress(input: {
  readonly clients: {
    readonly core: Pick<CoreV1Api, "readNamespacedService">;
    readonly networking: Pick<
      NetworkingV1Api,
      "readNamespacedNetworkPolicy" | "replaceNamespacedNetworkPolicy"
    >;
  };
  readonly broker: KubernetesWorkloadPeer & { readonly port: number };
  readonly owner: PreparedRepositoryIngressOwner;
  /** Only admission supplies the HTTPS hostname from the actual resolved session material. */
  readonly brokerHostname?: string;
}): Promise<void> {
  const {
    clients: { core, networking },
    broker,
    owner,
    brokerHostname,
  } = input;
  const at = { namespace: broker.namespace, name: policyName };
  if (broker.port !== brokerPort || broker.podLabels["app.kubernetes.io/component"] !== "worker") {
    throw new Error("Prepared repository ingress requires the selected broker worker.");
  }
  const podSelector = { matchLabels: { ...broker.podLabels } };
  const spec = (peers: V1NetworkPolicyPeer[]): V1NetworkPolicySpec => ({
    podSelector,
    policyTypes: ["Ingress"],
    // An empty 'from' would admit every source; no peers must mean no ingress rules.
    ingress: peers.length ? [{ _from: peers, ports: [{ port: brokerPort, protocol: "TCP" }] }] : [],
  });
  if (brokerHostname !== undefined) {
    const [name, ns, svc] = brokerHostname.split(".");
    if (!name || ns !== at.namespace || svc !== "svc" || !owner.revision) {
      throw new Error("Prepared repository origin must name the selected broker Service.");
    }
    const service = await core.readNamespacedService({ name, namespace: ns });
    if (
      service.metadata?.name !== name ||
      service.metadata.namespace !== ns ||
      service.metadata.deletionTimestamp != null ||
      service.metadata.annotations?.["openclaw.dev/repository-credentials-hostname"] !==
        brokerHostname ||
      service.spec?.type !== "ClusterIP" ||
      !isDeepStrictEqual(service.spec.selector, podSelector.matchLabels) ||
      !service.spec.ports?.some(
        (p) => p.port === 443 && p.targetPort === brokerPort && p.protocol === "TCP",
      )
    ) {
      throw new Error(
        "Prepared repository Service must bind the selected broker hostname and TLS port.",
      );
    }
  }
  for (let conflicts = 0; ; conflicts++) {
    const policy = await networking.readNamespacedNetworkPolicy(at);
    const { metadata } = policy;
    const current = policy.spec?.ingress?.[0]?._from?.map(canonicalPeer) ?? [];
    if (
      metadata?.name !== at.name ||
      metadata.namespace !== at.namespace ||
      !metadata.uid ||
      !metadata.resourceVersion ||
      metadata.deletionTimestamp != null ||
      !isDeepStrictEqual(
        JSON.parse(JSON.stringify({ ...policy.spec, ingress: policy.spec?.ingress ?? [] })),
        spec(current),
      )
    ) {
      throw new Error(
        "Prepared repository policy no longer describes only its admitted Harness peers.",
      );
    }
    const exact = owner.revision === undefined ? undefined : harnessPeer(owner);
    const other = current.filter((peer) =>
      exact !== undefined
        ? !isDeepStrictEqual(exact, peer)
        : peer.namespaceSelector.matchLabels[namespaceLabel] !== owner.namespace ||
          peer.podSelector.matchLabels["openclaw.dev/namespace"] !== owner.namespaceId,
    );
    if (
      brokerHostname !== undefined
        ? other.length !== current.length
        : other.length === current.length
    ) {
      return;
    }
    const desired = spec(brokerHostname !== undefined && exact ? [...current, exact] : other);
    try {
      const applied = await networking.replaceNamespacedNetworkPolicy({
        ...at,
        body: { ...policy, spec: desired },
      });
      if (
        applied.metadata?.uid !== metadata.uid ||
        !isDeepStrictEqual(
          JSON.parse(JSON.stringify({ ...applied.spec, ingress: applied.spec?.ingress ?? [] })),
          desired,
        )
      ) {
        throw new Error(
          "Prepared repository policy update did not preserve the exact admitted peers.",
        );
      }
      return;
    } catch (error) {
      // Recompute only on a definite conflict. An unknown write outcome is observed on reconciliation.
      if (numericErrorStatus(error) !== 409 || conflicts >= 2) {
        throw error;
      }
    }
  }
}
