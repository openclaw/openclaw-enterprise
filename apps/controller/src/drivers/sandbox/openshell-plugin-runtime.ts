/** The currently qualified adapter pair for managed plugin credential injection. */
export function supportsManagedPluginRuntime(
  sandbox?: string,
  gateway?: string,
  savedAccountMiddleware = false,
): boolean {
  return sandbox === "openshell" && (gateway === "openshell" || savedAccountMiddleware);
}

// The adapter owns placeholder syntax; shared worker bootstrap consumes this helper.
export const MANAGED_PLUGIN_CREDENTIAL_HELPER = String.raw`
function managedPluginPlaceholderEnvironment(value, kind) {
  if (typeof value !== "string") return undefined;
  const saved = /^oce:saved-account:([A-Z][A-Z0-9_]*):[a-f0-9]{64}$/.exec(value);
  if (saved) return saved[1];
  let match;
  if (kind === "cli") {
    match = /^openshell:resolve:env:s[0-9a-f]{64}_([A-Z][A-Z0-9_]*)$/.exec(value);
  } else if (kind === "mcp") {
    match = /^openshell:resolve:env:(?:v[0-9]+|s[0-9a-f]{64})_([A-Z][A-Z0-9_]*)$/.exec(value);
  } else {
    return undefined;
  }
  return match?.[1];
}
function isManagedPluginPlaceholder(environment, value, kind) {
  return typeof environment === "string" && managedPluginPlaceholderEnvironment(value, kind) === environment;
}
`;
