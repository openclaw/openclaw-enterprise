import test from "node:test";
import { verifyOpenShellProviderReplacement } from "../helpers/openshell-provider-replacement.mjs";

test(
  "OpenShell managed replacement preserves shared sources and updates network policy",
  {
    skip: process.env.OCC_TEST_OPENSHELL_REPLACEMENT_INPUT_FILE
      ? false
      : "Set OCC_TEST_OPENSHELL_REPLACEMENT_INPUT_FILE for a prepared disposable managed installation.",
    timeout: 3_600_000,
  },
  async (context) => {
    await verifyOpenShellProviderReplacement(context);
  },
);
