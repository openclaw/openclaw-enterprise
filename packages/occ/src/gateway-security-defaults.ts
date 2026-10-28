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
// - `tools.exec.strictInlineEval: false`, the `personal` preset's value, where exec runs in mode
//   "full" (filled or explicit) beside no `security` or `ask`: `corporate` fills `true`, which
//   asks for an explicit approval of each inline program (`python3 -c`, `node -e`, an awk program)
//   even in mode "full", so those commands still failed without an approval client. An explicit
//   `true` stays. An Agent entry's own exec policy (`agents.entries.<id>.tools.exec`) replaces the
//   mode but inherits this value, so where admission fills it and the preset is `corporate`, an
//   entry with a policy other than mode "full" and no `strictInlineEval` of its own gets the
//   preset's `true`, as it would without the fill.
// The preset's other defaults apply, including `messages.queue.allowCollaborativeSteering: true`:
// another participant with access to the Gateway can steer a running turn, which keeps the first
// requester's authority. An explicit `false` in the Configuration still turns it off.
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

function child(parent: unknown, key: string): ConfigurationObject | undefined {
  const value = isObject(parent) ? parent[key] : undefined;
  return isObject(value) ? value : undefined;
}

// OpenClaw resolves an Agent's strictInlineEval as its entry's value, else the top-level one,
// while the entry's mode, or its security or ask, replaces the top-level mode.
function keepEntryInlineEvalRule(
  values: ConfigurationObject,
  admitted: ConfigurationObject,
): ConfigurationObject {
  const filled =
    child(child(values, "tools"), "exec")?.strictInlineEval === undefined &&
    child(child(admitted, "tools"), "exec")?.strictInlineEval === false;
  const entries = child(child(admitted, "agents"), "entries");
  if (!filled || child(admitted, "security")?.preset !== "corporate" || entries === undefined) {
    return admitted;
  }
  let changed = false;
  const kept = Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => {
      const tools = child(entry, "tools");
      const exec = child(tools, "exec");
      // No policy of its own, mode "full" (which OpenClaw reads over security and ask), or its
      // own value: the entry keeps what it has.
      if (
        exec === undefined ||
        exec.strictInlineEval !== undefined ||
        (exec.mode === undefined ? noExecPolicy(exec) : exec.mode === "full")
      ) {
        return [id, entry];
      }
      changed = true;
      return [
        id,
        { ...(entry as object), tools: { ...tools, exec: { ...exec, strictInlineEval: true } } },
      ];
    }),
  );
  return changed
    ? { ...admitted, agents: { ...child(admitted, "agents"), entries: kept } }
    : admitted;
}

/**
 * Deployment admission fills each unset GATEWAY_SECURITY_DEFAULTS setting, for every Compute
 * Driver and execution mode, the way the preset does (OpenClaw's mergeMissing): a value the
 * Configuration sets is kept, and so is a non-object on the path. The Gateway refuses a value of
 * the wrong type or a non-object there at startup, so neither can loosen the setting; Configuration
 * save and deploy admission refuse an explicit sandbox mode other than "off". An Agent entry
 * with its own exec policy keeps the `corporate` preset's strictInlineEval (see above).
 * Returns `values` itself when nothing is unset, and never changes it.
 */
export function admitGatewaySecurityDefaults<T extends object>(values: Readonly<T>): T {
  let admitted = values as ConfigurationObject;
  for (const [path, value, admits] of GATEWAY_SECURITY_DEFAULTS) {
    admitted = fill(admitted, path, value, admits);
  }
  return keepEntryInlineEvalRule(values as ConfigurationObject, admitted) as T;
}
