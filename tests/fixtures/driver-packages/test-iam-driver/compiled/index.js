export const configurationSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

export function validateConfiguration() {
  return [];
}

export function createDriver({ id, implementation, platformState }) {
  if (typeof platformState?.loadNativeIAMState !== "function") {
    throw new Error("The test IAM Driver requires platform state.");
  }
  async function persistedState() {
    const state = await platformState.loadNativeIAMState();
    if (!state || !Array.isArray(state.identities) || !Array.isArray(state.roles)) {
      throw new Error("The test IAM Driver received invalid persisted policy state.");
    }
    return state;
  }

  return Object.freeze({
    id,
    capability: "iam",
    implementation,
    async lookupIdentity({ issuer, subject }) {
      const state = await persistedState();
      const matches = state.identities.filter(
        (identity) =>
          identity.kind === "principal" &&
          identity.issuer === issuer &&
          identity.subject === subject,
      );
      return matches.length === 1 ? matches[0] : undefined;
    },
    async authorize({ principalId, action, resource }) {
      const state = await persistedState();
      const identity = state.identities.find((candidate) => candidate.id === principalId);
      const matches = state.bindings.flatMap((binding) => {
        if (
          binding.subjectKind !== "identity" ||
          binding.subjectId !== principalId ||
          (binding.namespaceId !== undefined && binding.namespaceId !== resource.namespaceId) ||
          (binding.resourceKind !== undefined && binding.resourceKind !== resource.kind) ||
          (binding.resourceId !== undefined && binding.resourceId !== resource.id)
        ) {
          return [];
        }
        const role = state.roles.find((candidate) => candidate.id === binding.roleId);
        if (
          !role ||
          (role.namespaceId !== undefined && role.namespaceId !== resource.namespaceId) ||
          !role.permissions.some(
            (permission) =>
              permission.action === action && permission.resourceKind === resource.kind,
          )
        ) {
          return [];
        }
        return [{ binding, role }];
      });
      const restrictions = state.restrictions.filter(
        (restriction) =>
          restriction.action === action &&
          restriction.resourceKind === resource.kind &&
          (restriction.namespaceId === undefined ||
            restriction.namespaceId === resource.namespaceId) &&
          (restriction.resourceId === undefined || restriction.resourceId === resource.id),
      );
      const allowed = identity !== undefined && matches.length > 0 && restrictions.length === 0;
      return {
        allowed,
        reason: allowed
          ? "An exact persisted role grants this operation."
          : "No exact persisted role grants this operation.",
        driverId: id,
        evidence: {
          ...(identity === undefined ? {} : { identityId: identity.id }),
          groupIds: [],
          bindingIds: matches.map(({ binding }) => binding.id),
          roleIds: matches.map(({ role }) => role.id),
          restrictionIds: restrictions.map(({ id: restrictionId }) => restrictionId),
        },
      };
    },
  });
}
