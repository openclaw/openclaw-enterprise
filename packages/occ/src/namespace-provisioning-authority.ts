import type { AuthorizationDecision, AuthorizationRequest } from "@openclaw-enterprise/contracts";

/** Admission and dispatch use the same grants. Exact create is a restriction check:
 * the positive create grant belongs to the Installation's Namespace collection. */
export async function namespaceProvisioningDenial(
  principalId: string,
  installationId: string,
  namespaceId: string,
  options: { readonly retry: boolean; readonly adopted: boolean },
  decide: (request: AuthorizationRequest) => Promise<AuthorizationDecision>,
) {
  const resource = { kind: "namespace", id: namespaceId, namespaceId } as const;
  const grants: AuthorizationRequest[] = [
    { principalId, action: "create", resource: { kind: "namespace", id: installationId } },
  ];
  if (options.retry) {
    grants.push({ principalId, action: "read", resource });
  }
  if (options.adopted) {
    grants.push({
      principalId,
      action: "administer",
      resource: { kind: "installation", id: installationId },
    });
  }
  for (const authorization of grants) {
    const decision = await decide(authorization);
    if (!decision.allowed) {
      return { authorization, decision };
    }
  }
  const authorization = { principalId, action: "create", resource } as const;
  const decision = await decide(authorization);
  return decision.evidence.restrictionIds.length > 0 ? { authorization, decision } : undefined;
}
