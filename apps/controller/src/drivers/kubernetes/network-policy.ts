import { V1NetworkPolicyIngressRule, type V1NetworkPolicySpec } from "@kubernetes/client-node";

/** Restore the SDK ingress alias without dropping fields from the equality check. */
export function networkPolicySpecToJson(spec: V1NetworkPolicySpec | undefined): unknown {
  return JSON.parse(
    JSON.stringify({
      ...spec,
      ...(spec?.ingress === undefined
        ? {}
        : {
            ingress: spec.ingress.map((rule) => {
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
          }),
    }),
  );
}

/**
 * Map a wire NetworkPolicy manifest to the SDK shape. `KubernetesObjectApi` serializes ingress
 * peers only from `_from` and silently drops a wire `from`, so the rule would be applied without
 * its source restriction (finding 3110).
 */
export function networkPolicyToSdk<T extends { readonly kind?: string }>(resource: T): T {
  const spec = (resource as { readonly spec?: { readonly ingress?: unknown } }).spec;
  if (resource.kind !== "NetworkPolicy" || !Array.isArray(spec?.ingress)) {
    return resource;
  }
  return {
    ...resource,
    spec: {
      ...spec,
      ingress: spec.ingress.map((rule: Readonly<Record<string, unknown>>) => {
        if (!Object.hasOwn(rule, "from")) {
          return rule;
        }
        const { from, ...rest } = rule;
        return { ...rest, _from: from };
      }),
    },
  };
}
