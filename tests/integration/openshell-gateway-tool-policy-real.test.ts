// Select the API-key path before the shared workflow reads its model inputs.
if (process.env.OCC_TEST_OPENSHELL_K3D_REAL === "1") {
  if (process.env.OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE) {
    throw new Error("The API-key workflow does not accept native provider overrides");
  }
  process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL =
    process.env.OCC_TEST_OPENSHELL_MODEL_BASE_URL?.trim() || "https://api.openai.com/v1";
}
const { registerGatewayToolPolicyTest } =
  await import("../helpers/openshell-sandbox-workflows.mjs");

// CI gives this workflow its own database and, in advisory QA, its own runner/cluster.
registerGatewayToolPolicyTest();
