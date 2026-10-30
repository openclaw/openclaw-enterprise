/**
 * Role permissions from `{ resourceKind: [action, ...] }`, in the order listed.
 * `permissionsFor({ namespace: ["read"], agent: ["read", "operate"] })`
 */
export function permissionsFor(actionsByKind) {
  return Object.entries(actionsByKind).flatMap(([resourceKind, actions]) =>
    actions.map((action) => ({ action, resourceKind })),
  );
}

/**
 * Binds `roleId` to one identity in a mutable Native IAM policy (fixtures that load it live).
 * `namespaceId` scopes the binding and `resource` ({ kind, id }) narrows it to one resource.
 */
export function bindRole(policy, subjectId, { id, roleId, namespaceId, resource }) {
  if (typeof roleId !== "string" || roleId.length === 0) {
    throw new TypeError(`binding ${id} needs a roleId`);
  }
  const binding = {
    id,
    ...(namespaceId === undefined ? {} : { namespaceId }),
    subjectKind: "identity",
    subjectId,
    roleId,
    ...(resource === undefined ? {} : { resourceKind: resource.kind, resourceId: resource.id }),
  };
  policy.bindings.push(binding);
  return binding;
}

/**
 * Adds Role `id` with `permissions` (a list, or `{ resourceKind: [actions] }`) and binds it to one
 * identity. The Role and its binding share `namespaceId`; the binding id defaults to the Role id.
 */
export function grantRole(
  policy,
  subjectId,
  { id, bindingId = id, namespaceId, permissions, resource },
) {
  const role = {
    id,
    ...(namespaceId === undefined ? {} : { namespaceId }),
    permissions: Array.isArray(permissions) ? [...permissions] : permissionsFor(permissions),
  };
  policy.roles.push(role);
  const binding = bindRole(policy, subjectId, { id: bindingId, roleId: id, namespaceId, resource });
  return { role, binding };
}

/**
 * Adds a deny Restriction on `action` over `resourceKind` to a mutable Native IAM policy and returns
 * it. Without `namespaceId` it applies Installation-wide; `resourceId` narrows it to one resource.
 * The id defaults to one derived from the scope. Fixtures that read the policy on each request
 * apply it from the next request on.
 */
export function restrict(policy, action, resourceKind, { id, namespaceId, resourceId } = {}) {
  const restriction = {
    id: id ?? ["deny", action, resourceKind, resourceId ?? namespaceId ?? "installation"].join("-"),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    resourceKind,
    ...(resourceId === undefined ? {} : { resourceId }),
    action,
    effect: "deny",
  };
  policy.restrictions.push(restriction);
  return restriction;
}

/** Removes `restriction` from the policy; it must still be there. */
export function liftRestriction(policy, restriction) {
  const index = policy.restrictions.indexOf(restriction);
  if (index === -1) {
    throw new Error(`Restriction ${restriction.id} is not in the policy`);
  }
  policy.restrictions.splice(index, 1);
}

/**
 * An empty, mutable Native IAM state holding one `principal` identity per id (its subject is the
 * id), for fixtures that hand `{ loadNativeIAMState: async () => state }` to a NativeIAMDriver.
 */
export function principalIAMState(principalIds, issuer) {
  return {
    identities: principalIds.map((id) => ({ kind: "principal", id, issuer, subject: id })),
    groups: [],
    memberships: [],
    roles: [],
    bindings: [],
    restrictions: [],
  };
}
