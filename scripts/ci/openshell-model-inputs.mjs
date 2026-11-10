import { isOpenShellLane } from "./openshell-full-integration.ts";

const gatewayFiles = [
  "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
  "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.mjs",
  "tests/integration/openshell-gateway-tool-policy-real.test.ts",
  "tests/integration/openshell-refresh-real.test.ts",
  "tests/integration/openshell-upstream-real.test.ts",
  "tests/integration/openshell-credentials-real.test.ts",
  "tests/integration/openshell-withdrawal-real.test.ts",
];
const pluginFile = "tests/integration/openshell-plugin-install-real.test.ts";

export function openShellFocusedEnv(lane, file, names) {
  if (!isOpenShellLane(lane) || gatewayFiles.includes(file)) {
    return names;
  }
  // The plugin wrapper fixes the harness to Codex but forwards its model endpoint.
  return names.filter((name) =>
    name === "OCC_TEST_OPENSHELL_MODEL_BASE_URL"
      ? file === pluginFile
      : name !== "OCC_TEST_OPENSHELL_HARNESS",
  );
}

// Preparation and execution must agree on the credential consumed by the selected test.
export function openShellRequiredEnv(lane, file, requiredEnv, env) {
  const gatewayFile = gatewayFiles.includes(file);
  const endpointFile = gatewayFile || file === pluginFile;
  const apiKey =
    isOpenShellLane(lane) &&
    ((env.OCC_TEST_OPENSHELL_HARNESS === "openclaw" &&
      (gatewayFile || (file === undefined && env.OCC_K3D_HARNESS === "openclaw"))) ||
      (endpointFile && Boolean(env.OCC_TEST_OPENSHELL_MODEL_BASE_URL?.trim())));
  return [
    ...new Set(
      requiredEnv.map((name) =>
        apiKey && name === "CODEX_ACCESS_TOKEN" ? "OPENAI_API_KEY" : name,
      ),
    ),
  ];
}
