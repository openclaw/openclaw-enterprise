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

// Deployment admission keeps OpenClaw's earlier values for the settings its personal security
// preset would otherwise fill: another participant cannot steer a running turn, and apply_patch
// stays in the workspace. Like the preset, it fills only unset settings.
export function withGatewaySecurityDefaults(values) {
  return withUnset(
    withUnset(values, ["messages", "queue", "allowCollaborativeSteering"], false),
    ["tools", "exec", "applyPatch", "workspaceOnly"],
    true,
  );
}

// The document deployment admission freezes into an AgentRevision when OCC owns native logging.
export function admittedConfiguration(values, level = "info") {
  return admitLoggingConfiguration(withGatewaySecurityDefaults(values), level);
}
