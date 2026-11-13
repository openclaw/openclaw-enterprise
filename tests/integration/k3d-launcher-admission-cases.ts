import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { preparedState, repositoryRoot } from "./k3d-launcher-fixture.ts";

const execute = promisify(execFile);

export function registerNativePreparationCases() {
  test("native OpenClaw preparation requires its API key instead of a Codex token", async (context) => {
    const root = await temporaryDirectory(context, "oce-k3d-native-inputs-");
    const nativeFile = "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs";
    const firstAgentFile = "tests/integration/local-first-agent-openshell-k3d-real.test.mjs";
    for (const [harness, apiKey, file, helperHarness, expected] of [
      ["openclaw", "test-only-value", nativeFile, "", /requires a prior prepareLane/],
      ["openclaw", "", nativeFile, "", /Missing required CI input\(s\): OPENAI_API_KEY/],
      ["", "test-only-value", nativeFile, "", /Missing required CI input\(s\): CODEX_ACCESS_TOKEN/],
      ["openclaw", "test-only-value", firstAgentFile, "", /requires a prior prepareLane/],
      ["openclaw", "test-only-value", firstAgentFile, "openclaw", /requires a prior prepareLane/],
    ] as const) {
      // Native selection and the ordinary API-key installer can reach the owned-state
      // check without a PAT; an unselected Sandbox test still requires its PAT.
      await assert.rejects(
        execute(
          process.execPath,
          [
            "scripts/ci/prepare.mjs",
            "--lane",
            "openshell",
            "--file",
            file,
            "--state",
            join(root, "missing-state.json"),
          ],
          {
            env: {
              ...process.env,
              GITHUB_ENV: "",
              GITHUB_OUTPUT: "",
              CODEX_ACCESS_TOKEN: "",
              OPENAI_API_KEY: apiKey,
              OCC_TEST_OPENAI_MODEL: "vendor/model",
              OCC_TEST_OPENSHELL_HARNESS: harness,
              OCC_K3D_HARNESS: helperHarness,
            },
          },
        ),
        expected,
      );
    }

    const existingState = join(root, "existing-state.json");
    await writeFile(
      existingState,
      JSON.stringify(preparedState(repositoryRoot, 1, undefined, "openshell")),
      { mode: 0o600 },
    );
    for (const [helperHarness, apiKey, expected] of [
      ["", "test-only-value", /Missing required CI input\(s\): CODEX_ACCESS_TOKEN/],
      ["openclaw", "test-only-value", /CI state already exists/],
      ["openclaw", "", /Missing required CI input\(s\): OPENAI_API_KEY/],
    ] as const) {
      // An existing owned state stops bootstrap before infrastructure effects. The
      // native helper selects its single workflow to avoid unrelated PAT requirements.
      await assert.rejects(
        execute(
          process.execPath,
          [
            "scripts/ci/prepare.mjs",
            "--lane",
            "openshell",
            ...(helperHarness === "openclaw" ? ["--selected-file", nativeFile] : []),
            "--state",
            existingState,
          ],
          {
            env: {
              ...process.env,
              GITHUB_ENV: "",
              GITHUB_OUTPUT: "",
              CODEX_ACCESS_TOKEN: "",
              OPENAI_API_KEY: apiKey,
              OCC_TEST_OPENAI_MODEL: "vendor/model",
              OCC_TEST_OPENSHELL_HARNESS: "openclaw",
              OCC_K3D_HARNESS: helperHarness,
            },
          },
        ),
        expected,
      );
    }
  });
}
