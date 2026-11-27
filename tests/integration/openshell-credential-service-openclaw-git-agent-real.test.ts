import test from "node:test";

import { verifyNativeGitAgent } from "../helpers/openshell-credential-service-git-agent.ts";

test(
  "Dedicated OpenClaw executes Git on its native worker for the selected private repository and denies the omitted repository",
  {
    skip:
      process.env.OCC_TEST_OPENSHELL_CREDENTIAL_SERVICE_OPENCLAW_GIT_AGENT_REAL !== "1" &&
      "requires an owned prepared OCC CredentialService Installation",
    timeout: 45 * 60_000,
  },
  (t) => verifyNativeGitAgent(t, "openclaw"),
);
