import test from "node:test";

import { runPluginInstallCase } from "../helpers/openshell-plugin-install-reporter.ts";

test(
  "OpenShell Agent workflow installs and retains selected Codex plugins",
  { skip: process.env.OCC_TEST_OPENSHELL_K3D_REAL !== "1", timeout: 2_700_000 },
  async () => {
    // Reuse the production API/worker fixture with this case's isolated database.
    // The child selects installation/restart/removal, not unrelated model-tool scenarios.
    await runPluginInstallCase(
      "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
      2_650_000,
    );
  },
);
