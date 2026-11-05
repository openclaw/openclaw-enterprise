import { createHash } from "node:crypto";
import { isAllowedSecretBindingDestination } from "@openclaw-enterprise/contracts";

/** Workers select by saved source ID, independent of the Agent-specific sender profile ID. */
export function accountCredentialEnvironment(name: string, sourceId: string): string {
  const suffix = createHash("sha256").update(sourceId).digest("hex").slice(0, 24).toUpperCase();
  return `${name.slice(0, 39)}_${suffix}`;
}

/** Each reviewed local name receives the same prepared token from one provider. */
export function validPluginCredentialNames(names: readonly string[]): boolean {
  return (
    names.length > 0 &&
    new Set(names).size === names.length &&
    names.every(
      (name) =>
        /^[A-Z][A-Z0-9_]{0,63}$/.test(name) &&
        isAllowedSecretBindingDestination(name) &&
        name !== "LANG" &&
        !/^(?:OCE|OPENSHELL)_/.test(name),
    )
  );
}

export function credentialEnvironmentNames(config: Readonly<Record<string, string>>): string[] {
  if (!config.env_var) {
    return [];
  }
  return config.oauth_owner === "token_service" && config.env_var_aliases !== undefined
    ? [config.env_var, ...config.env_var_aliases.split(",")]
    : [config.env_var];
}

export function credentialEnvironmentsOverlap(
  first: Readonly<Record<string, string>>,
  second: Readonly<Record<string, string>>,
): boolean {
  const secondNames = credentialEnvironmentNames(second);
  return credentialEnvironmentNames(first).some((name) => secondNames.includes(name));
}
