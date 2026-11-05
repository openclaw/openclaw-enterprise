import { withEnvironment } from "../helpers/environment.ts";

await withEnvironment(
  { OCC_TEST_OPENSHELL_HARNESS: "openclaw", OCC_TEST_OPENSHELL_SCENARIO: "plugin-import-mcp" },
  async () => {
    const { registerProviderLifecycleTest } =
      await import("../helpers/openshell-sandbox-workflows.mjs");
    await registerProviderLifecycleTest("import");
  },
);
