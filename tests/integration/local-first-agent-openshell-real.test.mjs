// Runs the shared first-Agent proof with dedicated Codex in OpenShell and the
// Compose control plane; the k3d-model lane runs it with the defaults.
process.env.OCC_TEST_LOCAL_FIRST_AGENT_HARNESS = "codex";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "openshell";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "compose";
await import("./local-first-agent-real.test.mjs");
