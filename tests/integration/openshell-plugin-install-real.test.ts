import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { pluginInstallOutcome } from "../helpers/openshell-plugin-install-reporter.ts";

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
        "--test-reporter=./tests/helpers/openshell-plugin-install-reporter.ts",
        "--test-name-pattern=^OpenShell installs selected Codex plugins before WebSocket startup$",
        "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
      ],
      { env, timeout: 2_650_000, maxBuffer: 32 * 1024 * 1024 },
    ).then(
      ({ stdout }) => ({ stdout, cleanExit: true, killedByTimeout: false }),
      (error: unknown) => {
        const details = error !== null && typeof error === "object" ? error : {};
        return {
          stdout: "stdout" in details && typeof details.stdout === "string" ? details.stdout : "",
          cleanExit: false,
          // execFile owns this kill marker: its only kill paths are timeout and
          // maxBuffer. A nested runner may drain SIGTERM and close with exit 1.
          killedByTimeout:
            "killed" in details &&
            details.killed === true &&
            !("code" in details && details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"),
        };
      },
    );
    const failure = pluginInstallOutcome(result.stdout, result.cleanExit, result.killedByTimeout);
    if (failure !== undefined) {
      throw new Error(failure);
    }
  },
);
