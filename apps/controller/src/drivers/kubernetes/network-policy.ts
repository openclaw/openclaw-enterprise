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
