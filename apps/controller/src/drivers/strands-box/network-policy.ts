import { isDeepStrictEqual } from "node:util";
import { hash, owner, type Resource } from "./kubernetes.ts";

type Direction = "ingress" | "egress";
type Labels = Readonly<Record<string, string>>;
type Selector = {
  matchLabels?: Labels;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
};

/** Match metav1.LabelSelectorAsSelector and labels.Requirement.Matches, including key presence. */
export function strandsPolicySelectsPod(selector: Selector, labels: Labels): boolean {
  if (
    !selector ||
    Object.keys(selector).some((k) => !["matchLabels", "matchExpressions"].includes(k))
  ) {
    throw new Error("Unsupported Strands NetworkPolicy pod selector.");
  }
  let selected = Object.entries(selector.matchLabels ?? {}).every(
    ([key, value]) => Object.hasOwn(labels, key) && labels[key] === value,
  );
  for (const { key, operator, values = [] } of selector.matchExpressions ?? []) {
    const present = Object.hasOwn(labels, key);
    let matches: boolean;
    if (values.length && (operator === "In" || operator === "NotIn")) {
      // In requires a present key. NotIn also selects a *missing* key, even for values: [""].
      const member = present && values.includes(labels[key]!);
      matches = operator === "In" ? member : !member;
    } else if (!values.length && (operator === "Exists" || operator === "DoesNotExist")) {
      matches = operator === "Exists" ? present : !present;
    } else {
      // Validate every expression. Never treat an unrecognized selector as a harmless non-match.
      throw new Error("Unsupported Strands NetworkPolicy label requirement: " + operator);
    }
    selected &&= matches;
  }
  return selected;
}

/** All selecting NetworkPolicies contribute grants. Return the exact fence UID or refuse the installation. */
export function exactStrandsNetworkFence(
  policies: readonly Resource[],
  labels: Labels,
  expected: { podSelector: unknown; egress?: unknown; ingress?: unknown },
  executionId: string,
  policyHash: string,
  computeControlEgress: readonly unknown[],
): string | undefined {
  const directions: Direction[] = expected.ingress ? ["ingress", "egress"] : ["egress"];
  let uid: string | undefined;
  for (const { metadata, spec } of policies) {
    if (!spec) {
      return undefined;
    }
    if (!strandsPolicySelectsPod(spec.podSelector as Selector, labels)) {
      continue;
    }
    if (
      isDeepStrictEqual(spec, expected) &&
      metadata.labels?.[owner] === executionId &&
      metadata.annotations?.[hash] === policyHash &&
      !metadata.deletionTimestamp &&
      metadata.uid
    ) {
      uid = metadata.uid;
      continue;
    }
    for (const direction of directions) {
      const rules = spec[direction] as unknown[] | undefined;
      if (rules === undefined || (Array.isArray(rules) && !rules.length)) {
        continue; // A deny-only or other-direction policy adds no grants in this direction.
      }
      if (
        !expected.ingress &&
        computeControlEgress.length &&
        metadata.name === "allow-node-gateway" &&
        isDeepStrictEqual(rules, computeControlEgress)
      ) {
        continue; // Workload only: Compute's exact admitted workspace enrollment route.
      }
      return undefined; // In particular [{}] is an allow-all grant, not an empty rule list.
    }
  }
  return uid;
}
