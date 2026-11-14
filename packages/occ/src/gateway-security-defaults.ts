// OCE confines apply_patch to the workspace by default. OCE provides the Agent's isolation,
// so OpenClaw's own sandbox stays off. configuration-settings.ts rejects other sandbox modes.
// OCE has no Gateway approval screen. Exec therefore defaults to "full" without a separate
// prompt for each inline program. Preserve explicit exec policies, including the older
// security/ask pair, which an explicit mode would override.
// With a channel enabled, direct messages get a session per account, channel and sender.
// OpenClaw's "main" scope would put every external sender in the conversation browser chat opens
// (finding 3191). OCE channels accept named accounts (`channels.slack.accounts`), so the scope
// includes the account. Without a channel there is nothing to isolate, and "main" keeps recall
// across a browser-only Agent's conversations.
// scripts/first-agent-model.mjs runs this module without installed workspace packages: keep it
// free of imports and of TypeScript syntax that type stripping cannot erase.

type ConfigurationObject = Readonly<Record<string, unknown>>;

const always = () => true;
// The rule of enabledChannelEntries (channel-secret-bindings.ts), which decides the channel
// runtime and the channel Secret bindings: any `channels` key but the shared settings, unless its
// `enabled` is false. This module cannot import it. Keep the two the same.
const SHARED_CHANNEL_KEYS = ["defaults", "modelByChannel"];
const channelEnabled = (_parent: ConfigurationObject, root: ConfigurationObject) =>
  isObject(root.channels) &&
  Object.entries(root.channels).some(
    ([provider, channel]) =>
      !SHARED_CHANNEL_KEYS.includes(provider) && !(isObject(channel) && channel.enabled === false),
  );
// No legacy exec policy beside the setting: OpenClaw reads a mode over `security` and `ask`.
const noExecPolicy = (exec: ConfigurationObject) =>
  exec.security === undefined && exec.ask === undefined;

// Each setting's path and value, and whether the fill is admitted, given the object that would
// hold the setting and the document root. In order: the inline-program rule reads the mode filled
// before it.
const GATEWAY_SECURITY_DEFAULTS: readonly (readonly [
  readonly string[],
  boolean | string,
  (parent: ConfigurationObject, root: ConfigurationObject) => boolean,
])[] = [
  [["tools", "exec", "applyPatch", "workspaceOnly"], true, always],
  [["session", "dmScope"], "per-account-channel-peer", channelEnabled],
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
    const root = admitted;
    admitted = fill(admitted, path, value, (parent) => admits(parent, root));
  }
  return admitted as T;
}
