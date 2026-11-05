import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { redactedQaTail } from "../helpers/qa-secrets.mjs";

test(
  "OpenShell Agent workflow installs and retains selected Codex plugins",
  { skip: process.env.OCC_TEST_OPENSHELL_K3D_REAL !== "1", timeout: 2_700_000 },
  async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OCC_TEST_OPENSHELL_HARNESS: "codex",
      OCC_TEST_OPENSHELL_SCENARIO: "plugin-install",
    };
    delete env.NODE_TEST_CONTEXT;
    // Reuse the production API/worker fixture with this case's isolated database.
    // The child selects installation/restart/removal, not unrelated model-tool scenarios.
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=^OpenShell installs selected Codex plugins",
        "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
      ],
      { env, timeout: 2_650_000, maxBuffer: 32 * 1024 * 1024 },
    ).catch((error) => {
      const detail = redactedQaTail(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, env, {
        lines: 100,
        lineChars: 2000,
      }).join("\n");
      throw new Error(`OpenShell plugin installation workflow failed:\n${detail}`);
    });
    assert.match(
      result.stdout,
      /ok 1 - OpenShell installs selected Codex plugins before WebSocket startup/,
    );
    assert.match(result.stdout, /# pass 1\b/);
    assert.match(result.stdout, /# skipped 0\b/);
  },
);
