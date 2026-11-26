import assert from "node:assert/strict";
import test from "node:test";

import { verifyNativeGitAgent } from "../helpers/openshell-token-service-git-agent.ts";

test(
  "A Dedicated Agent opens a draft GitHub pull request from a goal-only turn",
  {
    skip:
      process.env.OCC_TEST_OPENSHELL_TOKEN_SERVICE_GIT_AGENT_PR_REAL !== "1" &&
      "requires an approved disposable GitHub repository and prepared Installation",
    timeout: 45 * 60_000,
  },
  async (t) => {
    const harness = process.env.OCC_TEST_OPENSHELL_TOKEN_SERVICE_GIT_AGENT_PR_HARNESS;
    assert.ok(
      harness === "codex" || harness === "openclaw",
      "Select codex or openclaw for the proof.",
    );
    await verifyNativeGitAgent(t, harness, "pull-request");
  },
);
