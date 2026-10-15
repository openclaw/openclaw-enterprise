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
