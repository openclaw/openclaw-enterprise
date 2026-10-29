import { databaseUrl } from "./postgres-database.mjs";
import {
  composeProductionSignIn,
  onboardPasswordAccounts,
  postgresSignInState,
  startFakeGitHub,
} from "./production-sign-in.mjs";

/** Prepare one sign-in installation. Pass () => [app] so teardown reads the current app. */
export async function preparePostgresSignInInstallation(
  context,
  closeFirst,
  { email, password, secrets },
) {
  const { pool, state } = postgresSignInState(context, closeFirst);
  const github = await startFakeGitHub(context);
  return {
    pool,
    state,
    github,
    onboard({ accounts, remoteAddress }) {
      return onboardPasswordAccounts(context, {
        databaseUrl,
        state,
        pool,
        email,
        authSecret: secrets["occ-auth/secret"],
        secrets,
        password,
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
        accounts,
      });
    },
    composeApp(settings, { logger, passwordSlowLaneFloors } = {}) {
      return composeProductionSignIn(context, {
        databaseUrl,
        settings,
        secrets,
        ...(logger === undefined ? {} : { logger }),
        ...(passwordSlowLaneFloors === undefined ? {} : { passwordSlowLaneFloors }),
      });
    },
  };
}
