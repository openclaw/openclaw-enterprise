// The Gateway security setting OCE keeps at the value OpenClaw used before its `security.preset`
// (default `personal`, openclaw/openclaw#185477), which fills it only when unset: without it,
// apply_patch could write outside the workspace. The preset's other defaults apply, including
// `messages.queue.allowCollaborativeSteering: true`: another participant with access to the
// Gateway can steer a running turn, which keeps the first requester's authority. An explicit
// `false` in the Configuration still turns it off.
// scripts/first-agent-model.mjs runs this module without installed workspace packages: keep it
// free of imports and of TypeScript syntax that type stripping cannot erase.

const GATEWAY_SECURITY_DEFAULTS: readonly (readonly [readonly string[], boolean])[] = [
  [["tools", "exec", "applyPatch", "workspaceOnly"], true],
];

type ConfigurationObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is ConfigurationObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fill(
  parent: ConfigurationObject,
  path: readonly string[],
  value: boolean,
): ConfigurationObject {
  const [key, ...rest] = path;
  const current = parent[key!];
  if (current === undefined) {
    return { ...parent, [key!]: rest.length === 0 ? value : fill({}, rest, value) };
  }
  if (rest.length === 0 || !isObject(current)) {
    return parent;
  }
  const next = fill(current, rest, value);
  return next === current ? parent : { ...parent, [key!]: next };
}

/**
 * Deployment admission fills each unset GATEWAY_SECURITY_DEFAULTS setting, for every Compute
 * Driver and execution mode, the way the preset does (OpenClaw's mergeMissing): a value the
 * Configuration sets is kept, and so is a non-object on the path. The Gateway refuses a
 * non-boolean value or a non-object there at startup, so neither can loosen the setting.
 * Returns `values` itself when nothing is unset, and never changes it.
 */
export function admitGatewaySecurityDefaults<T extends object>(values: Readonly<T>): T {
  let admitted = values as ConfigurationObject;
  for (const [path, value] of GATEWAY_SECURITY_DEFAULTS) {
    admitted = fill(admitted, path, value);
  }
  return admitted as T;
}
