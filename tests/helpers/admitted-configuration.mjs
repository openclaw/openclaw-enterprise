import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

// Fills `value` at an unset `path` when `admits` accepts the object that would hold it.
function withUnset(parent, [key, ...rest], value, admits = () => true) {
  const current = parent[key];
  if (rest.length === 0) {
    return current === undefined && admits(parent) ? { ...parent, [key]: value } : parent;
  }
  if (current === undefined) {
    return { ...parent, [key]: withUnset({}, rest, value, admits) };
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    return parent;
  }
  return { ...parent, [key]: withUnset(current, rest, value, admits) };
}

// Deployment admission fills four settings ahead of OpenClaw's security preset, which fills only
// what is still unset: apply_patch stays in the workspace (OpenClaw's earlier value), OpenClaw's
// own sandbox stays off (its Docker backend cannot run in the OCE runtime, finding 2767), and exec
// runs without per-command approval, the personal preset's mode, unless tools.exec sets a mode,
// security or ask (the corporate "ask" needs an approval client OCE does not have, finding 2771).
// In mode "full" with no security or ask, inline programs need no approval either (the personal
// preset's strictInlineEval; corporate's `true` needs the same approval client).
// Collaborative steering keeps the preset's default (on) unless the Configuration sets it.
export function withGatewaySecurityDefaults(values) {
  const noPolicy = (exec) => exec.security === undefined && exec.ask === undefined;
  return [
    [["tools", "exec", "applyPatch", "workspaceOnly"], true],
    [["agents", "defaults", "sandbox", "mode"], "off"],
    [["tools", "exec", "mode"], "full", noPolicy],
    [
      ["tools", "exec", "strictInlineEval"],
      false,
      (exec) => exec.mode === "full" && noPolicy(exec),
    ],
  ].reduce((filled, [path, value, admits]) => withUnset(filled, path, value, admits), values);
}

// The document deployment admission freezes into an AgentRevision when OCC owns native logging.
export function admittedConfiguration(values, level = "info") {
  return admitLoggingConfiguration(withGatewaySecurityDefaults(values), level);
}
