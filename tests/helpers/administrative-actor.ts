import { NativeIAMDriver, type NativeIAMStateStore } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  type HumanAuthenticationActor,
} from "../../packages/occ/src/index.ts";

/** Supply real IAM authorization to direct authentication-persistence tests. */
export function administrativeActor(
  state: NativeIAMStateStore,
  installationId: string,
  actor: Pick<HumanAuthenticationActor, "userId" | "sessionId" | "principalId">,
): HumanAuthenticationActor {
  const driver = new NativeIAMDriver(state);
  return {
    ...actor,
    authorize: async ({ targetPrincipalId, successorPrincipalId }) => {
      const administrators =
        successorPrincipalId === undefined
          ? [actor.principalId]
          : [actor.principalId, successorPrincipalId];
      for (const principalId of administrators) {
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
