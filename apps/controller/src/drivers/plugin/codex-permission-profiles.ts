import { ConfigurationValidationError, type JSONSchema } from "@openclaw-enterprise/contracts";
import { asRecord, deepFreeze, immutableCopy } from "@openclaw-enterprise/utils";

export type CodexPermissionProfiles = Readonly<
  Record<string, { readonly extends: string; readonly network: { readonly enabled: boolean } }>
>;

export const CODEX_PERMISSION_PROFILES_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: {
    type: "object",
    additionalProperties: false,
    required: ["extends", "network"],
    properties: {
      extends: { type: "string", minLength: 1 },
      network: {
        type: "object",
        additionalProperties: false,
        required: ["enabled"],
        properties: { enabled: { type: "boolean" } },
      },
    },
  },
});

function refuseProfiles(): never {
  // Names and inheritance targets can identify an operator's private policy.
  throw new ConfigurationValidationError([
    {
      path: "/permissionProfiles",
      code: "INVALID_VALUE",
      message: "Permission profiles must contain supported definitions and acyclic inheritance.",
    },
  ]);
}

function validProfileName(name: string): boolean {
  // Quoted TOML keys can contain punctuation and Unicode, but not controls or lone surrogates.
  return (
    name.trim().length > 0 &&
    !name.startsWith(":") &&
    [...name].every((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127 && (code < 0xd800 || code > 0xdfff);
    })
  );
}

export function validateCodexPermissionProfiles(value: unknown): CodexPermissionProfiles | undefined {
  if (value === undefined) {
    return undefined;
  }
  const profiles = asRecord(value);
  if (profiles === undefined) {
    return refuseProfiles();
  }
  for (const [name, definition] of Object.entries(profiles)) {
    const profile = asRecord(definition);
    const network = asRecord(profile?.network);
    if (
      !validProfileName(name) ||
      profile === undefined ||
      Object.keys(profile).some((key) => key !== "extends" && key !== "network") ||
      typeof profile.extends !== "string" ||
      network === undefined ||
      Object.keys(network).some((key) => key !== "enabled") ||
      typeof network.enabled !== "boolean"
    ) {
      return refuseProfiles();
    }
  }
  const definitions = profiles as CodexPermissionProfiles;
  const resolved = new Set<string>();
  for (const name of Object.keys(definitions)) {
    const visiting = new Set<string>();
    let parent = name;
    while (parent !== ":read-only" && parent !== ":workspace" && !resolved.has(parent)) {
      if (!Object.hasOwn(definitions, parent) || visiting.has(parent)) {
        return refuseProfiles();
      }
      visiting.add(parent);
      parent = definitions[parent]!.extends;
    }
    for (const entry of visiting) {
      resolved.add(entry);
    }
  }
  return immutableCopy(definitions);
}

export function codexRevisionPermissionProfiles(
  configuration: Readonly<Record<string, unknown>> | undefined,
): CodexPermissionProfiles | undefined {
  if (
    configuration !== undefined &&
    Object.keys(configuration).some((key) => key !== "permissionProfiles")
  ) {
    return refuseProfiles();
  }
  return validateCodexPermissionProfiles(configuration?.permissionProfiles);
}

export function codexPermissionProfilesToml(value: CodexPermissionProfiles | undefined): string {
  const profiles = validateCodexPermissionProfiles(value) ?? {};
  return Object.keys(profiles)
    .sort()
    .map((name) => {
      const profile = profiles[name]!;
      return `\n[permissions.${JSON.stringify(name)}]\nextends = ${JSON.stringify(profile.extends)}\n\n[permissions.${JSON.stringify(name)}.network]\nenabled = ${profile.network.enabled}\n`;
    })
    .join("");
}
