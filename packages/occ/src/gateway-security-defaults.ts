// The Gateway security settings OCE fills when a Configuration leaves them unset, ahead of
// OpenClaw's `security.preset` (default `personal`, openclaw/openclaw#185477), which fills only
// what is still unset:
// - `tools.exec.applyPatch.workspaceOnly: true`, the value OpenClaw used before the preset:
//   without it, apply_patch could write outside the workspace.
// - `agents.defaults.sandbox.mode: "off"`: the `corporate` preset turns OpenClaw's own sandbox on,
//   and its Docker backend cannot run in the OCE runtime, so every turn failed (finding 2767).
//   OCE isolates each Agent itself; configuration-settings.ts refuses any other explicit value.
// - `tools.exec.mode: "full"`, the `personal` preset's value: the `corporate` preset fills "ask",
//   which needs an approval client connected to the Gateway, and OCE has no approval screen, so
//   every shell command failed (finding 2771). OCE contains commands with its own isolation. Like
//   the preset, admission fills no mode beside an explicit `tools.exec.security` or
//   `tools.exec.ask`: OpenClaw reads a mode over them. An explicit `ask` stays.
// The preset's other defaults apply, including `messages.queue.allowCollaborativeSteering: true`:
// another participant with access to the Gateway can steer a running turn, which keeps the first
// requester's authority. An explicit `false` in the Configuration still turns it off.
// scripts/first-agent-model.mjs runs this module without installed workspace packages: keep it
// free of imports and of TypeScript syntax that type stripping cannot erase.

// Each setting's path and value, and the settings beside it that also leave it unfilled.
const GATEWAY_SECURITY_DEFAULTS: readonly (readonly [
  readonly string[],
  boolean | string,
  readonly string[],
])[] = [
  [["tools", "exec", "applyPatch", "workspaceOnly"], true, []],
  [["agents", "defaults", "sandbox", "mode"], "off", []],
  [["tools", "exec", "mode"], "full", ["security", "ask"]],
];

type ConfigurationObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is ConfigurationObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fill(
  parent: ConfigurationObject,
  path: readonly string[],
  value: boolean | string,
  beside: readonly string[],
): ConfigurationObject {
  const [key, ...rest] = path;
  const current = parent[key!];
  if (rest.length === 0) {
    return current === undefined && beside.every((name) => parent[name] === undefined)
      ? { ...parent, [key!]: value }
      : parent;
  }
  if (current === undefined) {
    return { ...parent, [key!]: fill({}, rest, value, beside) };
  }
  if (!isObject(current)) {
    return parent;
  }
  const next = fill(current, rest, value, beside);
  return next === current ? parent : { ...parent, [key!]: next };
}

/**
 * Deployment admission fills each unset GATEWAY_SECURITY_DEFAULTS setting, for every Compute
 * Driver and execution mode, the way the preset does (OpenClaw's mergeMissing): a value the
 * Configuration sets is kept, and so is a non-object on the path. The Gateway refuses a value of
 * the wrong type or a non-object there at startup, so neither can loosen the setting; Configuration
 * save and deploy admission refuse an explicit sandbox mode other than "off".
 * Returns `values` itself when nothing is unset, and never changes it.
 */
export function admitGatewaySecurityDefaults<T extends object>(values: Readonly<T>): T {
  let admitted = values as ConfigurationObject;
  for (const [path, value, beside] of GATEWAY_SECURITY_DEFAULTS) {
    admitted = fill(admitted, path, value, beside);
  }
  return admitted as T;
}
