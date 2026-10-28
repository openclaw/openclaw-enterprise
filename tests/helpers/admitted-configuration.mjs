import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

// Fills `value` at an unset `path`, unless a setting named in `beside` is set next to it.
function withUnset(parent, [key, ...rest], value, beside = []) {
  const current = parent[key];
  if (rest.length === 0) {
    return current === undefined && beside.every((name) => parent[name] === undefined)
      ? { ...parent, [key]: value }
      : parent;
  }
  if (current === undefined) {
    return { ...parent, [key]: withUnset({}, rest, value, beside) };
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    return parent;
  }
  return { ...parent, [key]: withUnset(current, rest, value, beside) };
}

// Deployment admission fills three settings ahead of OpenClaw's security preset, which fills only
// what is still unset: apply_patch stays in the workspace (OpenClaw's earlier value), OpenClaw's
// own sandbox stays off (its Docker backend cannot run in the OCE runtime, finding 2767), and exec
// runs without per-command approval, the personal preset's mode, unless tools.exec sets a mode,
// security or ask (the corporate "ask" needs an approval client OCE does not have, finding 2771).
// Collaborative steering keeps the preset's default (on) unless the Configuration sets it.
export function withGatewaySecurityDefaults(values) {
  return withUnset(
    withUnset(
      withUnset(values, ["tools", "exec", "applyPatch", "workspaceOnly"], true),
      ["agents", "defaults", "sandbox", "mode"],
      "off",
    ),
    ["tools", "exec", "mode"],
    "full",
    ["security", "ask"],
  );
}

// The document deployment admission freezes into an AgentRevision when OCC owns native logging.
export function admittedConfiguration(values, level = "info") {
  return admitLoggingConfiguration(withGatewaySecurityDefaults(values), level);
}
