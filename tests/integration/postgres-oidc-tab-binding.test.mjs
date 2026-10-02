import test from "node:test";
import {
  fakeOidc,
  fixtureOidcIssuer,
  oidcUpgradeSettings,
} from "../helpers/production-sign-in.mjs";
import { proveTabBinding } from "../helpers/tab-binding.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const clientId = "tabs-oidc-client";
const clientSecret = "tabs-oidc-client-secret";
const aliceSubject = "auth0|tabs-alice";
const label = "Acme SSO";

// The GitHub proof with only OIDC configured: discovery must report sessionBinding, so the
// Console exchanges the receipt and pins its own session rather than adopting the cookie
// another tab's sign-in replaced.
test(
  "an OIDC tab keeps its own session: another tab's password sign-in signs it out",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof." },
  async (t) => {
    let idp;
    await proveTabBinding(t, databaseUrl, {
      name: "oidc",
      title: label,
      start: (context) => {
        idp = fakeOidc(context, { clientId, clientSecret });
      },
      settings: (recoveryUserId) =>
        oidcUpgradeSettings(recoveryUserId, fixtureOidcIssuer, { displayName: label }),
      secrets: {
        "occ-auth/secret": "tabs-oidc-binding-auth-test-secret-at-least-32-bytes",
        "occ-oidc-login/client-id": clientId,
        "occ-oidc-login/client-secret": clientSecret,
      },
      subject: aliceSubject,
      authorizationUrl: fixtureOidcIssuer.authorizationUrl,
      code: (url) => idp.authorize(url, { subject: aliceSubject }),
    });
  },
);
