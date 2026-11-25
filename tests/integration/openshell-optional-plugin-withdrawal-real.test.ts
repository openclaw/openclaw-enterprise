import test from "node:test";
import { verifyOpenShellOptionalPluginWithdrawal } from "../helpers/openshell-optional-plugin-withdrawal.ts";

const selected = process.env.OCC_TEST_OPENSHELL_K3D_REAL === "1";

test(
  "OpenShell optional Slack withdrawal preserves model, Google, independent policy, and Source custody",
  {
    skip: selected ? false : "Select the prepared OpenShell Kubernetes integration fixture.",
    timeout: 20 * 60_000,
  },
  verifyOpenShellOptionalPluginWithdrawal,
);
