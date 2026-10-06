import test from "node:test";
import { githubUpgradeSettings, startFakeGitHub } from "../helpers/production-sign-in.mjs";
import { proveTabBinding } from "../helpers/tab-binding.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const aliceSubject = "9400001";

// See proveTabBinding: a GitHub tab pins the session its receipt names, so another tab's
// password sign-in signs it out instead of being adopted.
test(
  "a GitHub tab keeps its own session: another tab's password sign-in signs it out",
  requiresPostgres,
  (t) =>
    proveTabBinding(t, databaseUrl, {
      name: "github",
      title: "GitHub",
      start: startFakeGitHub,
      settings: githubUpgradeSettings,
      secrets: {
        "occ-auth/secret": "tabs-binding-auth-test-secret-at-least-32-bytes",
        "occ-github-login/client-id": "tabs-client-id",
        "occ-github-login/client-secret": "tabs-client-secret",
      },
      subject: aliceSubject,
      authorizationUrl: "https://github.com/login/oauth/authorize",
      // The fake GitHub token endpoint answers `subject-<id>` codes for that user.
      code: () => `subject-${aliceSubject}`,
    }),
);
