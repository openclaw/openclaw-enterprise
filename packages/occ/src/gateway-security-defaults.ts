// OCE confines apply_patch to the workspace by default. OCE provides the Agent's isolation,
// so OpenClaw's own sandbox stays off. configuration-settings.ts rejects other sandbox modes.
// OCE has no Gateway approval screen. Exec therefore defaults to "full" without a separate
// prompt for each inline program. Preserve explicit exec policies, including the older
// security/ask pair, which an explicit mode would override.
// scripts/first-agent-model.mjs runs this module without installed workspace packages: keep it
// free of imports and of TypeScript syntax that type stripping cannot erase.

type ConfigurationObject = Readonly<Record<string, unknown>>;

const always = () => true;
// No legacy exec policy beside the setting: OpenClaw reads a mode over `security` and `ask`.
const noExecPolicy = (exec: ConfigurationObject) =>
  exec.security === undefined && exec.ask === undefined;

// Each setting's path and value, and whether its parent object admits the fill. In order: the
// inline-program rule reads the mode filled before it.
const GATEWAY_SECURITY_DEFAULTS: readonly (readonly [
  readonly string[],
  boolean | string,
  (parent: ConfigurationObject) => boolean,
])[] = [
  [["tools", "exec", "applyPatch", "workspaceOnly"], true, always],
  [["agents", "defaults", "sandbox", "mode"], "off", always],
  [["tools", "exec", "mode"], "full", noExecPolicy],
  [
    ["tools", "exec", "strictInlineEval"],
    false,
    (exec) => exec.mode === "full" && noExecPolicy(exec),
  ],
];

function isObject(value: unknown): value is ConfigurationObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fill(
  parent: ConfigurationObject,
  path: readonly string[],
  value: boolean | string,
  admits: (parent: ConfigurationObject) => boolean,
): ConfigurationObject {
  const [key, ...rest] = path;
  const current = parent[key!];
  if (rest.length === 0) {
    return current === undefined && admits(parent) ? { ...parent, [key!]: value } : parent;
  }
  if (current === undefined) {
    const created = fill({}, rest, value, admits);
    return Object.keys(created).length === 0 ? parent : { ...parent, [key!]: created };
  }
  if (!isObject(current)) {
    return parent;
  }
  const next = fill(current, rest, value, admits);
  return next === current ? parent : { ...parent, [key!]: next };
}

/**
 * Deployment admission fills unset settings for every Compute Driver and execution mode.
 * It preserves explicit values, including invalid values for the Gateway to reject at startup.
 * Returns the original document when no setting needs a default.
 */
export function admitGatewaySecurityDefaults<T extends object>(values: Readonly<T>): T {
  let admitted = values as ConfigurationObject;
  for (const [path, value, admits] of GATEWAY_SECURITY_DEFAULTS) {
    admitted = fill(admitted, path, value, admits);
  }
  return admitted as T;
}
