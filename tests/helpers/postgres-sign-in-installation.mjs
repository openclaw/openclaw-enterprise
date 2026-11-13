import { databaseUrl } from "./postgres-database.mjs";
import {
  composeProductionSignIn,
  onboardPasswordAccounts,
  postgresSignInState,
  fakeOidc,
} from "./production-sign-in.mjs";

/**
 * Prepare one sign-in installation. Pass () => [app] so teardown reads the current app.
 * `oidc: true` starts the OIDC transport fixture for the supplied client Secret.
 * `onboard` passes `passwordHasher` and `passwordSlowLaneFloors` to onboardPasswordAccounts;
 * `composeApp` passes its options to composeProductionSignIn (they may replace `secrets`).
 */
export async function preparePostgresSignInInstallation(
  context,
  closeFirst,
  { email, password, secrets, oidc = false },
) {
  const { pool, state } = postgresSignInState(context, closeFirst);
  const provider = oidc
    ? fakeOidc(context, {
        clientId: secrets["occ-oidc-login/client-id"],
        clientSecret: secrets["occ-oidc-login/client-secret"],
      })
    : undefined;
  return {
    pool,
    state,
    oidc: provider,
    onboard({ accounts, remoteAddress, passwordHasher, passwordSlowLaneFloors } = {}) {
      return onboardPasswordAccounts(context, {
        databaseUrl,
        state,
        pool,
        email,
        authSecret: secrets["occ-auth/secret"],
        secrets,
        password,
        accounts,
        remoteAddress,
        passwordHasher,
        passwordSlowLaneFloors,
      });
    },
    composeApp(settings, options = {}) {
      return composeProductionSignIn(context, { databaseUrl, settings, secrets, ...options });
    },
  };
}
