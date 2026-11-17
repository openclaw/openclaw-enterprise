import { createHash } from "node:crypto";
import type { OpenShellOnlineHttpRequest } from "../egress-proxy/openshell-online-authority.ts";
import { googleWorkspaceRequestPolicies } from "./google-workspace/request-policy.ts";

interface PluginRequestPolicy {
  readonly releaseSha256: string;
  acceptsScope(scope: string): boolean;
  allows(request: OpenShellOnlineHttpRequest): boolean;
}

// The guard loads reviewed policies from this image. The signed supervisor selects one
// by evaluator ID and supplies the source envelope admitted for that deployment.
const releasedPolicies = new Map<string, PluginRequestPolicy>(
  Object.values(googleWorkspaceRequestPolicies).map((policy) => [policy.id, policy]),
);

// Describe and Sandbox admission use the same fingerprint. Sort the serialized
// [evaluator ID, release digest] pairs so registry insertion order has no effect.
const evaluators = Array.from(releasedPolicies, ([id, policy]) =>
  JSON.stringify([id, policy.releaseSha256]),
).sort();
export const managedPluginGuardVersion = createHash("sha256")
  .update(evaluators.join("\n"))
  .digest("hex");

export function acceptsPluginRequestScope(id: string, scope: string): boolean {
  return releasedPolicies.get(id)?.acceptsScope(scope) === true;
}

export function allowsPluginRequest(request: OpenShellOnlineHttpRequest): boolean {
  try {
    return releasedPolicies.get(request.bindingId)?.allows(request) === true;
  } catch {
    // Reject malformed requests even if a connector throws while evaluating them.
    return false;
  }
}
