import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

// The expected Gateway security defaults and OpenClaw sandbox refusals, spelled once for every
// test that builds an admitted document or exercises the rules. Kept independent of
// packages/occ/src/gateway-security-defaults.ts and configuration-settings.ts, so a change there
// that drops a default or accepts a refused value fails a test.

// No legacy exec policy beside the setting: OpenClaw reads a mode over `security` and `ask`.
const noExecPolicy = (exec) => exec.security === undefined && exec.ask === undefined;

// Deployment admission fills these settings when the Configuration leaves them unset, ahead of
// OpenClaw's security preset, which fills only what is still unset. Each row: the setting's path,
// the value admission fills, whether the object that would hold it admits the fill (in order: the
// inline-program rule reads the mode filled before it), and an explicit value of another kind,
// which admission keeps.
// - apply_patch stays in the workspace (OpenClaw's earlier value).
// - OpenClaw's own sandbox stays off: its Docker backend cannot run in the OCE runtime (finding
//   2767).
// - exec runs without per-command approval, the personal preset's mode, unless tools.exec sets a
//   security or ask: the corporate "ask" needs an approval client OCE does not have (finding 2771).
// - In mode "full" with no security or ask, inline programs need no approval either (the personal
//   preset's strictInlineEval; corporate's `true` needs the same approval client).
// Collaborative steering keeps the preset's default (on) unless the Configuration sets it.
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

const objectAt = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

// An Agent entry's own exec policy replaces the top-level mode but inherits the top-level
// strictInlineEval. Where admission filled `false` there under the corporate preset, an entry
// whose policy is not mode "full" and that sets no strictInlineEval keeps the preset's `true`.
function withEntryInlineEvalRule(values, filled) {
  const entries = objectAt(filled.agents?.entries);
  if (
    values.tools?.exec?.strictInlineEval !== undefined ||
    filled.tools?.exec?.strictInlineEval !== false ||
    values.security?.preset !== "corporate" ||
    entries === undefined
  ) {
    return filled;
  }
  const kept = Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => {
      const exec = objectAt(entry?.tools?.exec);
      const ownPolicy =
        exec !== undefined &&
        exec.strictInlineEval === undefined &&
        (exec.mode === undefined ? !noExecPolicy(exec) : exec.mode !== "full");
      return [
        id,
        ownPolicy
          ? { ...entry, tools: { ...entry.tools, exec: { ...exec, strictInlineEval: true } } }
          : entry,
      ];
    }),
  );
  return { ...filled, agents: { ...filled.agents, entries: kept } };
}

// `values` with each of `defaults` (every GATEWAY_SECURITY_DEFAULTS row unless given) it leaves
// unset filled, as deployment admission fills it: a value of any type, or a non-object on the
// path, is kept.
export function withGatewaySecurityDefaults(values, defaults = GATEWAY_SECURITY_DEFAULTS) {
  return withEntryInlineEvalRule(
    values,
    defaults.reduce(
      (filled, { path, value, admits }) => withUnset(filled, path, value, admits),
      values,
    ),
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
