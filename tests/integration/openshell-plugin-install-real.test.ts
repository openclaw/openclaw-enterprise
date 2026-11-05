import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { redactedQaTail } from "../helpers/qa-secrets.mjs";

for (const scenario of [
  {
    name: "OpenShell Agent workflow installs and retains selected Codex plugins",
    harness: "codex",
    scenario: "plugin-install",
    innerName: "OpenShell installs selected Codex plugins before WebSocket startup",
  },
  {
    name: "OpenShell Agent workflow deploys, updates, and removes imported OpenClaw skills",
    harness: "openclaw",
    scenario: "plugin-import",
    innerName: "OpenShell delivers imported plugin skills to dedicated OpenClaw",
  },
  {
    name: "OpenShell Agent workflow enforces imported hosted MCP tool policy",
    harness: "openclaw",
    scenario: "plugin-import-mcp",
    innerName: "OpenShell enforces imported MCP tools on dedicated OpenClaw",
  },
]) {
  test(
    scenario.name,
    { skip: process.env.OCC_TEST_OPENSHELL_K3D_REAL !== "1", timeout: 2_700_000 },
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OCC_TEST_OPENSHELL_HARNESS: scenario.harness,
        OCC_TEST_OPENSHELL_SCENARIO: scenario.scenario,
      };
      delete env.NODE_TEST_CONTEXT;
      // Reuse the production API/worker fixture with this case's isolated database.
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--test",
          "--test-reporter=tap",
          `--test-name-pattern=^${scenario.innerName}$`,
          "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
        ],
        { env, timeout: 2_650_000, maxBuffer: 32 * 1024 * 1024 },
      ).catch((error) => {
        const detail = redactedQaTail(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, env, {
          lines: 100,
          lineChars: 2000,
        }).join("\n");
        throw new Error(`${scenario.name} failed:\n${detail}`);
      });
      assert.ok(result.stdout.includes(`ok 1 - ${scenario.innerName}`));
      assert.match(result.stdout, /# pass 1\b/);
      assert.match(result.stdout, /# skipped 0\b/);
    },
  );
}
