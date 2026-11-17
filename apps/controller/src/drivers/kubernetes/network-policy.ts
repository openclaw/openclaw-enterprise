import { V1NetworkPolicyIngressRule, type V1NetworkPolicySpec } from "@kubernetes/client-node";
import { asRecord } from "@openclaw-enterprise/utils";

/** Restore SDK aliases and Kubernetes empty-rule serialization for spec comparison. */
export function networkPolicySpecToJson(spec: V1NetworkPolicySpec | undefined): unknown {
  const ingress = spec?.ingress;
  const projected = {
    ...spec,
    // JSON null is a nil list, not a list of rules. Only arrays have rules to map.
    ...(Array.isArray(ingress)
      ? {
          ingress: ingress.map((rule) => {
            // Preserve ambiguous input so a wire field cannot hide a changed SDK field.
            if (
              !(rule instanceof V1NetworkPolicyIngressRule) ||
              rule._from === undefined ||
              Object.hasOwn(rule, "from")
            ) {
              return rule;
            }
            const { _from, ...rest } = rule;
            return { ...rest, from: _from };
          }),
        }
      : {}),
  };
  // Kubernetes omits empty lists and stores JSON null as that nil list. Only equate
  // them when the direction is explicit; never infer policyTypes or erase a nonempty
  // (possibly allow-all) rule. A non-list stays, so it cannot match an omitted field.
  const directions = spec?.policyTypes;
  const selects = (direction: string) =>
    Array.isArray(directions) && directions.includes(direction);
  if (
    selects("Ingress") &&
    (ingress === null || (Array.isArray(ingress) && ingress.length === 0))
  ) {
    delete projected.ingress;
  }
  const egress = spec?.egress;
  if (selects("Egress") && (egress === null || (Array.isArray(egress) && egress.length === 0))) {
    delete projected.egress;
  }
  return JSON.parse(JSON.stringify(projected));
}

/** True for the only NetworkPolicy type the SDK serializer models; custom resources pass through. */
export function isCoreNetworkPolicy(resource: {
  readonly apiVersion?: unknown;
  readonly kind?: unknown;
}): boolean {
  return resource.apiVersion === "networking.k8s.io/v1" && resource.kind === "NetworkPolicy";
}

/**
 * Map a wire NetworkPolicy manifest to the SDK shape. `KubernetesObjectApi` serializes ingress
 * peers only from `_from` and silently drops a wire `from`, so the rule would be applied without
 * its source restriction (finding 3110). Other kinds, including custom resources named
 * NetworkPolicy, go through the client's pass-through serializer and keep `from` as written.
 */
export function networkPolicyToSdk<
  T extends { readonly apiVersion?: string; readonly kind?: string },
>(resource: T): T {
  const spec = (resource as { readonly spec?: { readonly ingress?: unknown } }).spec;
  if (!isCoreNetworkPolicy(resource) || !Array.isArray(spec?.ingress)) {
    return resource;
  }
  return {
    ...resource,
    spec: {
      ...spec,
      ingress: spec.ingress.map((rule: unknown) => {
        const fields = asRecord(rule);
        // Startup refuses non-object rules; never fail on them here.
        if (fields === undefined || !Object.hasOwn(fields, "from")) {
          return rule;
        }
        const { from, ...rest } = fields;
        return { ...rest, _from: from };
      }),
    },
  };
}
