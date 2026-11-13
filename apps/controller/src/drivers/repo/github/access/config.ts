import { isAbsolute } from "node:path";
import type { GitHubTokenConfiguration } from "./types.ts";
import { parseGitHubNumericId } from "./repository-grant.ts";
import { hasControlCharacter, normalizePushRefAllowlist } from "../../access/client-contracts.ts";

const tokenStringFields = [
  "kind",
  "providerInstanceId",
  "configVersion",
  "repositoryId",
  "repository",
  "tokenFile",
] as const;
const tokenFields = [
  ...tokenStringFields,
  "developmentOnly",
  "pushRefAllowlist",
  "allowGraphql",
  "leaseSeconds",
];
export const defaultTokenLeaseSeconds = 3600;

export function validateGitHubConfiguration(value: unknown): GitHubTokenConfiguration {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (kind !== "github-token") {
    throw new Error("invalid-backend");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-backend");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !tokenFields.includes(key))) {
    throw new Error("invalid-backend");
  }
  for (const key of tokenStringFields) {
    const field = input[key];
    if (
      typeof field !== "string" ||
      field.length < 1 ||
      field.length > 4096 ||
      hasControlCharacter(field)
    ) {
      throw new Error("invalid-backend");
    }
  }
  const { providerInstanceId, configVersion, repositoryId, repository } = input as Record<
    string,
    string
  >;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerInstanceId!) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(configVersion!) ||
    parseGitHubNumericId(repositoryId) === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository!)
  ) {
    throw new Error("invalid-backend");
  }
  const leaseSeconds = input.leaseSeconds ?? defaultTokenLeaseSeconds;
  // The literal is one of two explicit development opt-ins; the process flag is the other.
  if (
    input.developmentOnly !== true ||
    !isAbsolute(input.tokenFile as string) ||
    (input.allowGraphql !== undefined && typeof input.allowGraphql !== "boolean") ||
    typeof leaseSeconds !== "number" ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 900 ||
    leaseSeconds > 86400
  ) {
    throw new Error("invalid-backend");
  }
  let pushRefAllowlist: readonly string[];
  try {
    pushRefAllowlist = normalizePushRefAllowlist(input.pushRefAllowlist);
  } catch {
    throw new Error("invalid-backend");
  }
  return Object.freeze({
    kind: "github-token",
    providerInstanceId: providerInstanceId!,
    configVersion: configVersion!,
    repositoryId: repositoryId!,
    repository: repository!,
    tokenFile: input.tokenFile as string,
    developmentOnly: true,
    pushRefAllowlist,
    allowGraphql: input.allowGraphql === true,
    leaseSeconds,
  });
}
