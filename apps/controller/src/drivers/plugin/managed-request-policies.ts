import { createHash } from "node:crypto";
import type { OpenShellOnlineHttpRequest } from "../egress-proxy/openshell-online-authority.ts";
import { googleWorkspaceRequestPolicy } from "./google-workspace/request-policy.ts";

interface PluginRequestPolicy {
  acceptsScope(scope: string): boolean;
  allows(request: OpenShellOnlineHttpRequest): boolean;
}

// The guard loads reviewed policies from this image. The signed supervisor selects one
// by its release digest and supplies the source envelope admitted for that deployment.
const releasedPolicies = new Map<string, PluginRequestPolicy>([
  [googleWorkspaceRequestPolicy.releaseSha256, googleWorkspaceRequestPolicy],
]);

// The Gateway advertises one implementation version per registration. Pin the whole set
// at admission and each individual release in the Sandbox's binding.
const releases = [...releasedPolicies.keys()].sort();
export const managedPluginGuardVersion =
  releases.length === 1
    ? releases[0]!
    : createHash("sha256").update(releases.join("\n")).digest("hex");

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
