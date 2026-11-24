import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { workspaceSetupFixture } from "./kubernetes-workspace-setup.ts";

export type Labels = Record<string, string>;
type FixtureResource = NonNullable<
  ReturnType<ReturnType<typeof workspaceSetupFixture>["objects"]["get"]>
>;
type ResourceSpec = { metadata: object; spec?: unknown };

export type RenderedPolicy = {
  kind: "NetworkPolicy";
  metadata: { name: string; namespace?: string; uid?: string; resourceVersion?: string };
  spec: Record<string, unknown>;
};

export function isNetworkPolicy(value: unknown): value is RenderedPolicy {
  const resource = asRecord(value);
  const metadata = asRecord(resource?.metadata);
  return (
    resource?.kind === "NetworkPolicy" &&
    typeof metadata?.name === "string" &&
    (metadata.namespace === undefined || typeof metadata.namespace === "string") &&
    (metadata.uid === undefined || typeof metadata.uid === "string") &&
    (metadata.resourceVersion === undefined || typeof metadata.resourceVersion === "string") &&
    asRecord(resource.spec) !== undefined
  );
}

export function renderedPolicies(entries: unknown): RenderedPolicy[] {
  assert.ok(Array.isArray(entries));
  return entries.map((entry: unknown) => {
    const resource = resourceRecord(entry, "targeted policy").resource;
    assert.ok(isNetworkPolicy(resource), "expected a rendered NetworkPolicy");
    return resource;
  });
}

export function resourceRecord(value: unknown, field: string) {
  const record = asRecord(value);
  assert.ok(record, `expected ${field} to be an object`);
  return record;
}

export function resourceRecords(value: unknown, field: string) {
  assert.ok(Array.isArray(value), `expected ${field} to be an array`);
  return value.map((entry: unknown) => resourceRecord(entry, field));
}

export function observedResource(resource: FixtureResource | undefined, kind: string) {
  assert.ok(resource, `expected stored ${kind}`);
  assert.equal(resource.kind, kind);
  return resource;
}

function labelValues(value: unknown): value is Labels {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every((label) => typeof label === "string");
}

export function resourceLabels(value: unknown, field: string) {
  assert.ok(labelValues(value), `expected ${field} to contain string labels`);
  return value;
}

export function podSelector(resource: ResourceSpec) {
  return resourceRecord(resourceRecord(resource.spec, "policy spec").podSelector, "pod selector");
}

export function podTemplate(resource: ResourceSpec) {
  return resourceRecord(resourceRecord(resource.spec, "Deployment spec").template, "Pod template");
}

export function templateMetadata(resource: ResourceSpec) {
  return resourceRecord(podTemplate(resource).metadata, "Pod template metadata");
}

export function templateLabels(resource: ResourceSpec) {
  return resourceLabels(templateMetadata(resource).labels, "Pod template labels");
}

export function policyRules(resource: ResourceSpec, direction: "egress" | "ingress") {
  return resourceRecords(resourceRecord(resource.spec, "policy spec")[direction], direction);
}

function policyPeers(rule: Record<string, unknown> | undefined, direction: "to" | "from") {
  assert.ok(rule, `expected policy rule with ${direction} peers`);
  return resourceRecords(rule[direction], direction);
}

export function matchLabels(selector: Record<string, unknown>) {
  return resourceLabels(selector.matchLabels, "selector matchLabels");
}

export function serviceSelector(resource: ResourceSpec) {
  return resourceLabels(resourceRecord(resource.spec, "Service spec").selector, "Service selector");
}

export function firstPeerSelector(resource: ResourceSpec, direction: "ingress" | "egress") {
  const peers = policyPeers(
    policyRules(resource, direction)[0],
    direction === "ingress" ? "from" : "to",
  );
  return resourceRecord(peers[0]?.podSelector, "peer podSelector");
}

export function selectorMatches(
  selector: Record<string, unknown>,
  labels: Readonly<Record<string, string | undefined>>,
) {
  const equalities = resourceRecord(selector.matchLabels ?? {}, "selector matchLabels");
  const labelsMatch = Object.entries(equalities).every(([key, value]) => labels[key] === value);
  const expressions = selector.matchExpressions ?? [];
  assert.ok(Array.isArray(expressions), "expected selector matchExpressions to be an array");
  const expressionsMatch = expressions.every((entry: unknown) => {
    const { key, operator, values } = resourceRecord(entry, "selector expression");
    if (operator === "In" || operator === "NotIn") {
      assert.ok(typeof key === "string", "expected selector expression key to be a string");
      if (labels[key] === undefined) {
        return operator === "NotIn";
      }
      assert.ok(Array.isArray(values), "expected selector expression values to be an array");
      const included = values.includes(labels[key]);
      return operator === "In" ? included : !included;
    }
    if (operator === "Exists" || operator === "DoesNotExist") {
      assert.ok(typeof key === "string", "expected selector expression key to be a string");
      return operator === "Exists" ? labels[key] !== undefined : labels[key] === undefined;
    }
    assert.fail(`unsupported selector operator ${String(operator)}`);
  });
  return labelsMatch && expressionsMatch;
}
