import type { Permission, Principal } from "../../packages/contracts/src/index.ts";
import type {
  AuthPrincipalSeed,
  BootstrapAdministratorSeed,
} from "../../packages/iam/src/index.ts";
import type { PersistedNativeIAMState } from "../../packages/occ/src/index.ts";

export function createDevelopmentIAMState(
  seed: AuthPrincipalSeed | BootstrapAdministratorSeed,
): PersistedNativeIAMState {
  const servicePrincipals = "servicePrincipal" in seed ? [seed.servicePrincipal] : [];
  return Object.freeze({
    identities: Object.freeze([seed.principal, ...servicePrincipals]),
    groups: Object.freeze([]),
    memberships: Object.freeze([]),
    roles: Object.freeze([...seed.roles]),
    bindings: Object.freeze([...seed.bindings]),
    restrictions: Object.freeze([]),
  });
}

/** Finds the first persisted Principal whose direct unscoped binding grants every required permission from one Role. */
export function authorizedPrincipal(
  iam: PersistedNativeIAMState,
  required: readonly (readonly [Permission["action"], Permission["resourceKind"]])[] = [
    ["deploy", "agent"],
  ],
): Principal | undefined {
  const roles = new Set(
    iam.roles
      .filter(({ permissions }) =>
        required.every(([action, resourceKind]) =>
          permissions.some(
            (permission) =>
              permission.action === action && permission.resourceKind === resourceKind,
          ),
        ),
      )
      .map(({ id }) => id),
  );
  return iam.identities.find(
    (identity): identity is Principal =>
      identity.kind === "principal" &&
      iam.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === identity.id &&
          binding.namespaceId === undefined &&
          binding.resourceKind === undefined &&
          roles.has(binding.roleId),
      ),
  );
}
