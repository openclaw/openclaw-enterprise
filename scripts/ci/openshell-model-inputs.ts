import { isOpenShellLane } from "./openshell-full-integration.ts";

export function normalizeOpenShellModelId(model: string): string {
  return model.replace(/^(?:openai|codex)\//u, "");
}

export function assertOpenShellModelId(modelId: string): void {
  if (modelId.trim() === "") {
    throw new Error("OCC_TEST_OPENAI_MODEL must contain a nonempty model ID.");
  }
}

const codexOnlyFiles = new Set([
  "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts",
  "tests/integration/openshell-refresh-real.test.ts",
  "tests/integration/openshell-upstream-real.test.ts",
  "tests/integration/openshell-credentials-real.test.ts",
  "tests/integration/openshell-withdrawal-real.test.ts",
]);

export function openShellHarnessError(
  lane: string,
  file: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (
    isOpenShellLane(lane) &&
    file !== undefined &&
    codexOnlyFiles.has(file) &&
    (env.OCC_TEST_OPENSHELL_HARNESS ?? "codex") !== "codex"
  ) {
    return `${file} requires OCC_TEST_OPENSHELL_HARNESS=codex. Unset the selector or select codex.`;
  }
}

// Preparation and execution must agree on the credential consumed by the selected test.
export function openShellRequiredEnv(
  lane: string,
  file: string | undefined,
  requiredEnv: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const gatewayFile =
    file !== undefined &&
    (codexOnlyFiles.has(file) ||
      [
        "tests/integration/namespace-driver-openshell-k3d-real.test.ts",
        "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
        "tests/integration/openshell-gateway-tool-policy-real.test.ts",
      ].includes(file));
  const apiKey =
    isOpenShellLane(lane) &&
    ((file !== undefined &&
      [
        "tests/integration/openshell-upstream-real.test.ts",
        "tests/integration/openshell-refresh-real.test.ts",
        "tests/integration/openshell-withdrawal-real.test.ts",
        "tests/integration/openshell-gateway-tool-policy-real.test.ts",
        "tests/integration/openshell-git-retention-real.test.ts",
        "tests/integration/openshell-git-finite-removal-real.test.ts",
        "tests/integration/local-first-agent-openshell-real.test.mjs",
        "tests/integration/local-first-agent-openshell-k3d-real.test.mjs",
        "tests/integration/dev-up-openshell-k3d-real.test.mjs",
      ].includes(file)) ||
      (env.OCC_TEST_OPENSHELL_HARNESS === "openclaw" &&
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
