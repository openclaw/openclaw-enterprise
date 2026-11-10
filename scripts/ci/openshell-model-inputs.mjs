import { isOpenShellLane } from "./openshell-full-integration.ts";

// Preparation and execution must agree on the credential consumed by the selected test.
export function openShellRequiredEnv(lane, file, requiredEnv, env) {
  const gatewayFile = [
    "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
    "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.mjs",
    "tests/integration/openshell-gateway-tool-policy-real.test.ts",
    "tests/integration/openshell-refresh-real.test.ts",
    "tests/integration/openshell-upstream-real.test.ts",
    "tests/integration/openshell-credentials-real.test.ts",
    "tests/integration/openshell-withdrawal-real.test.ts",
  ].includes(file);
  const apiKey =
    isOpenShellLane(lane) &&
    ((env.OCC_TEST_OPENSHELL_HARNESS === "openclaw" &&
      (gatewayFile || (file === undefined && env.OCC_K3D_HARNESS === "openclaw"))) ||
      (gatewayFile && Boolean(env.OCC_TEST_OPENSHELL_MODEL_BASE_URL?.trim())));
  return [
    ...new Set(
      requiredEnv.map((name) =>
        apiKey && name === "CODEX_ACCESS_TOKEN" ? "OPENAI_API_KEY" : name,
      ),
    ),
  ];
}
