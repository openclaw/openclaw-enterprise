export const managedCredentialEnvironment = "OPENCLAW_MANAGED_CREDENTIAL_ENV";
export const managedCredentialAliasesEnvironment = "OCE_STAGED_PLUGIN_CREDENTIAL_ALIASES";

// The adapter owns placeholder syntax; shared worker bootstrap consumes this helper.
export const MANAGED_PLUGIN_CREDENTIAL_HELPER = String.raw`
const managedPluginCredentialAliases = (() => {
  const text = process.env[${JSON.stringify(managedCredentialAliasesEnvironment)}];
  delete process.env[${JSON.stringify(managedCredentialAliasesEnvironment)}];
  if (text === undefined) return {};
  const aliases = JSON.parse(text);
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases) ||
      Object.entries(aliases).some(([environment, native]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(environment) || typeof native !== "string" ||
        !/^[A-Z][A-Z0-9_]*$/.test(native))) {
    throw new Error("The staged plugin credential aliases are invalid.");
  }
  return aliases;
})();
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
  return match !== null && (match[1] === environment ||
    (Object.hasOwn(managedPluginCredentialAliases, environment) &&
      managedPluginCredentialAliases[environment] === match[1]));
}
`;
