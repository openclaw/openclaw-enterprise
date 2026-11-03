import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

// The expected Gateway security defaults and OpenClaw sandbox refusals, spelled once for every
// test that builds an admitted document or exercises the rules. Kept independent of
// packages/occ/src/gateway-security-defaults.ts and configuration-settings.ts, so a change there
// that drops a default or accepts a refused value fails a test.

// No legacy exec policy beside the setting: OpenClaw reads a mode over `security` and `ask`.
const noExecPolicy = (exec) => exec.security === undefined && exec.ask === undefined;

// Each row gives an unset setting its OCE default and supplies an explicit value admission
// preserves. The inline-program rule reads the exec mode filled by the preceding row.
export const GATEWAY_SECURITY_DEFAULTS = Object.freeze([
  { path: ["tools", "exec", "applyPatch", "workspaceOnly"], value: true, explicit: false },
  { path: ["agents", "defaults", "sandbox", "mode"], value: "off", explicit: "all" },
  { path: ["tools", "exec", "mode"], value: "full", explicit: "ask", admits: noExecPolicy },
  {
    path: ["tools", "exec", "strictInlineEval"],
    value: false,
    explicit: true,
    admits: (exec) => exec.mode === "full" && noExecPolicy(exec),
  },
]);

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

// `values` with each of `defaults` (every GATEWAY_SECURITY_DEFAULTS row unless given) it leaves
// unset filled, as deployment admission fills it: a value of any type, or a non-object on the
// path, is kept.
export function withGatewaySecurityDefaults(values, defaults = GATEWAY_SECURITY_DEFAULTS) {
  return defaults.reduce(
    (filled, { path, value, admits }) => withUnset(filled, path, value, admits),
    values,
  );
}

// `values` with `value` at `path`, copying each object on the way.
export function withSetting(values, [key, ...rest], value) {
  return {
    ...values,
    [key]: rest.length === 0 ? value : withSetting(values?.[key] ?? {}, rest, value),
  };
}

// The document deployment admission freezes into an AgentRevision when OCC owns native logging.
export function admittedConfiguration(values, level = "info") {
  return admitLoggingConfiguration(withGatewaySecurityDefaults(values), level);
}

const sandboxUnsupported =
  "OCE runs each Agent in its own isolated runtime and does not support OpenClaw's sandbox";

// OpenClaw's own sandbox settings, which Configuration save, Agent save and deploy admission
// refuse for every Agent (`path`) and for one Agent's entry (`agents.entries.<id>.<entry>`), which
// overrides it. Unset is accepted. A sandbox mode other than "off" fails every turn (finding
// 2767); exec host "sandbox" sends each shell command to that sandbox (finding 2773).
export const OPENCLAW_SANDBOX_SETTINGS = Object.freeze([
  {
    path: ["agents", "defaults", "sandbox", "mode"],
    entry: ["sandbox", "mode"],
    accepted: ["off"],
    refused: ["all", "non-main", null],
    requirement: `must be "off" or unset: ${sandboxUnsupported}`,
  },
  {
    path: ["tools", "exec", "host"],
    entry: ["tools", "exec", "host"],
    accepted: ["auto", "gateway", "node"],
    refused: ["sandbox", null],
    requirement: `must be "auto", "gateway" or "node" or unset: ${sandboxUnsupported}`,
  },
]);

// The refusal of `setting` at `path` (an array), as every save path and deployment word it.
export const openClawSandboxRefusal = (setting, path) =>
  `Configuration setting ${path.join(".")} ${setting.requirement}.`;
