import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
  IAMPermissionSchema,
  type AccessBinding,
  type Permission,
  type Restriction,
  type Role,
} from "../../packages/contracts/src/index.ts";
import type { NativeIAMState } from "../../packages/iam/src/index.ts";

export type ActionsByKind = Partial<
  Record<Permission["resourceKind"], readonly Permission["action"][]>
>;
type FixtureRole = Omit<Role, "permissions"> & { permissions: Permission[] };
type MutableIAMState = { -readonly [K in keyof NativeIAMState]: NativeIAMState[K][number][] };
type BindingOptions = {
  id: string;
  roleId: string;
  namespaceId?: string | undefined;
  resource?: { kind: Permission["resourceKind"]; id: string } | undefined;
};
type GrantOptions = Omit<BindingOptions, "roleId"> & {
  bindingId?: string | undefined;
  permissions: readonly Permission[] | ActionsByKind;
};
type RestrictionOptions = {
  id?: string | undefined;
  namespaceId?: string | undefined;
  resourceId?: string | undefined;
};

const isPermissionList: (
  value: readonly Permission[] | ActionsByKind,
) => value is readonly Permission[] = Array.isArray;

/** Orders permissions by the supplied resource keys and their action lists. */
export function permissionsFor(actionsByKind: ActionsByKind): Permission[] {
  return Object.entries<readonly unknown[]>(actionsByKind).flatMap(([resourceKind, actions]) =>
    actions.map((action) => {
      const permission = { action, resourceKind };
      assert.ok(
        Check(IAMPermissionSchema, permission),
        "expected a known IAM action and resource kind",
      );
      return permission;
    }),
  );
}

/** Binds an existing Role to one identity, optionally within a Namespace or exact resource. */
export function bindRole(
  policy: Pick<MutableIAMState, "bindings">,
  subjectId: string,
  { id, roleId, namespaceId, resource }: BindingOptions,
): AccessBinding {
  if (typeof roleId !== "string" || roleId.length === 0) {
    throw new TypeError(`binding ${id} needs a roleId`);
  }
  const binding: AccessBinding = {
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

/** Creates a Role and binds it to the identity at the same Namespace scope. */
export function grantRole(
  policy: Pick<MutableIAMState, "roles" | "bindings">,
  subjectId: string,
  { id, bindingId = id, namespaceId, permissions, resource }: GrantOptions,
): { role: FixtureRole; binding: AccessBinding } {
  const role: FixtureRole = {
    id,
    ...(namespaceId === undefined ? {} : { namespaceId }),
    permissions: isPermissionList(permissions) ? [...permissions] : permissionsFor(permissions),
  };
  policy.roles.push(role);
  const binding = bindRole(policy, subjectId, { id: bindingId, roleId: id, namespaceId, resource });
  return { role, binding };
}

/** Appends a deny Restriction scoped to the supplied Namespace and resource, if any. */
export function restrict(
  policy: Pick<MutableIAMState, "restrictions">,
  action: Permission["action"],
  resourceKind: Permission["resourceKind"],
  { id, namespaceId, resourceId }: RestrictionOptions = {},
): Restriction {
  const restriction: Restriction = {
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

/** Removes the exact Restriction object from the policy. */
export function liftRestriction(
  policy: Pick<MutableIAMState, "restrictions">,
  restriction: Restriction,
): void {
  const index = policy.restrictions.indexOf(restriction);
  if (index === -1) {
    throw new Error(`Restriction ${restriction.id} is not in the policy`);
  }
  policy.restrictions.splice(index, 1);
}

/** Creates a mutable Native IAM state with one Principal per ID, using its ID as its subject. */
export function principalIAMState(
  principalIds: readonly string[],
  issuer: string,
): MutableIAMState {
  return {
    identities: principalIds.map((id) => ({ kind: "principal", id, issuer, subject: id })),
    groups: [],
    memberships: [],
    roles: [],
    bindings: [],
    restrictions: [],
  };
}
