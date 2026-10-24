// Keep this expectation independent of the gate and workflow definitions the tests check.
export const expectedFullLanes = [
  "checks-baseline-1",
  "checks-baseline-2",
  "checks-browser",
  "checks-browser-2",
  "postgres",
  "postgres-application",
  "postgres-auth",
  "postgres-platform",
  "images-packaging",
  "images-model-probes",
  "images-runtime-startup",
  "images-runtime-startup-2",
  "images-runtime-startup-3",
  "runtime-image-fixture",
  "k3d-fixture-configuration",
  "k3d-fixture-state",
  "k3d-fixture-plugins",
  "k3d-observability",
  "logging-collector",
  "repository-credentials-container",
  "keycloak-oidc",
];

export function passingGateNeeds(mode) {
  return {
    impact: { result: "success", outputs: { mode } },
    audit: { result: "success", outputs: {} },
    "static-checks": { result: "success", outputs: {} },
    "pr-safe": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
    "runtime-image-fixture": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
  };
}
