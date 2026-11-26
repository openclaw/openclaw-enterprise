import test from "node:test";

import { verifyNativeGitAgent } from "../helpers/openshell-token-service-git-agent.ts";

test(
  "Dedicated Codex Agents enforce Contributor and Read access on a shared Git Source and keep serving the model after Git withdrawal",
  {
    skip:
      process.env.OCC_TEST_OPENSHELL_TOKEN_SERVICE_GIT_AGENT_REAL !== "1" &&
      "requires an owned prepared OCC TokenService Installation",
    timeout: 45 * 60_000,
  },
  (t) => verifyNativeGitAgent(t, "codex"),
);

if (process.env.OCC_TEST_OPENSHELL_TOKEN_SERVICE_GIT_AGENT_PUBLIC_METADATA_REAL === "1") {
  test(
    "Dedicated Codex Agent reads public metadata only for its selected Repository",
    { timeout: 20 * 60_000 },
    (t) => verifyNativeGitAgent(t, "codex", { publicMetadata: true }),
  );
}
