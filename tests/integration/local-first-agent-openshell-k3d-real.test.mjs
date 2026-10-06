// Runs the shared first-Agent proof with dedicated Codex in OpenShell and the
// Kubernetes-only control plane, so the API, worker, and PostgreSQL run in k3d.
process.env.OCC_TEST_LOCAL_FIRST_AGENT_HARNESS = "codex";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "openshell";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "kubernetes";
await import("./local-first-agent-real.test.mjs");
