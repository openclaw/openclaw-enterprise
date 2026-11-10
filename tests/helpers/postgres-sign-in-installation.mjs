import { databaseUrl } from "./postgres-database.mjs";
import {
  composeProductionSignIn,
  onboardPasswordAccounts,
  postgresSignInState,
  startFakeGitHub,
} from "./production-sign-in.mjs";

/**
 * Prepare one sign-in installation. Pass () => [app] so teardown reads the current app.
 * `github: false` skips the fake GitHub, for suites that start it later or never.
 * `onboard` passes `passwordHasher` and `passwordSlowLaneFloors` to onboardPasswordAccounts;
 * `composeApp` passes its options to composeProductionSignIn (they may replace `secrets`).
 */
export async function preparePostgresSignInInstallation(
  context,
  closeFirst,
  { email, password, secrets, github = true },
) {
  const { pool, state } = postgresSignInState(context, closeFirst);
  const fakeGitHub = github ? await startFakeGitHub(context) : undefined;
  return {
    pool,
    state,
    github: fakeGitHub,
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
