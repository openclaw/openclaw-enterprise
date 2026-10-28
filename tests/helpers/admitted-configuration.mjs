import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

function withUnset(parent, [key, ...rest], value) {
  const current = parent[key];
  if (current === undefined) {
    return { ...parent, [key]: rest.length === 0 ? value : withUnset({}, rest, value) };
  }
  if (
    rest.length === 0 ||
    current === null ||
    typeof current !== "object" ||
    Array.isArray(current)
  ) {
    return parent;
  }
  return { ...parent, [key]: withUnset(current, rest, value) };
}

// Deployment admission fills two settings ahead of OpenClaw's security preset, which fills only
// what is still unset: apply_patch stays in the workspace (OpenClaw's earlier value), and OpenClaw's
// own sandbox stays off (its Docker backend cannot run in the OCE runtime, finding 2767).
// Collaborative steering keeps the preset's default (on) unless the Configuration sets it.
export function withGatewaySecurityDefaults(values) {
  return withUnset(
    withUnset(values, ["tools", "exec", "applyPatch", "workspaceOnly"], true),
    ["agents", "defaults", "sandbox", "mode"],
    "off",
  );
}

// The document deployment admission freezes into an AgentRevision when OCC owns native logging.
export function admittedConfiguration(values, level = "info") {
  return admitLoggingConfiguration(withGatewaySecurityDefaults(values), level);
}
