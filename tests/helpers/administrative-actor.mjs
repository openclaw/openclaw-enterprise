import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { AuthorizationDeniedError } from "../../packages/occ/src/index.ts";

/** Supply real IAM authorization to direct authentication-persistence tests. */
export function administrativeActor(state, installationId, actor) {
  const driver = new NativeIAMDriver(state);
  return {
    ...actor,
    authorize: async ({ targetPrincipalId, successorPrincipalId }) => {
      for (const principalId of [actor.principalId, successorPrincipalId].filter(Boolean)) {
        const decision = await driver.authorize({
          principalId,
          action: "administer",
          resource: { kind: "installation", id: installationId },
        });
        if (!decision.allowed) {
          throw new AuthorizationDeniedError();
        }
      }
      if (
        targetPrincipalId !== undefined &&
        !(await driver.coversIdentityAccess({
          principalId: actor.principalId,
          targetIdentityId: targetPrincipalId,
        }))
      ) {
        throw new AuthorizationDeniedError();
      }
    },
  };
}
