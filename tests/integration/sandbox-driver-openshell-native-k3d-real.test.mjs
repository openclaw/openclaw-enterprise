// Run the shared production-Driver proof with native authority checks in its own
// test process; the ordinary Sandbox entry selects Codex and cannot cover these.
process.env.OCC_TEST_OPENSHELL_HARNESS = "openclaw";
await import("./sandbox-driver-openshell-k3d-real.test.mjs");
