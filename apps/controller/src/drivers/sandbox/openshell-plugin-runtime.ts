/** The currently qualified adapter pair for managed plugin credential injection. */
export function supportsManagedPluginRuntime(sandbox?: string, gateway?: string): boolean {
  return sandbox === "openshell" && gateway === "openshell";
}

export const managedCredentialEnvironment = "OPENCLAW_MANAGED_CREDENTIAL_ENV";

// The adapter owns placeholder syntax; shared worker bootstrap consumes this helper.
export const MANAGED_PLUGIN_CREDENTIAL_HELPER = String.raw`
function isManagedPluginPlaceholder(environment, value, kind) {
  if (typeof environment !== "string" || typeof value !== "string") return false;
  let match;
  if (kind === "cli") {
    match = /^openshell:resolve:env:s[0-9a-f]{64}_([A-Z][A-Z0-9_]*)$/.exec(value);
  } else if (kind === "mcp") {
    match = /^openshell:resolve:env:(?:v[0-9]+|s[0-9a-f]{64})_([A-Z][A-Z0-9_]*)$/.exec(value);
  } else {
    return false;
  }
  return match !== null && match[1] === environment;
}
`;
