import { isAbsolute } from "node:path";
import type {
  GitHubAppConfiguration,
  GitHubConfiguration,
  GitHubTokenConfiguration,
} from "./types.ts";
import {
  hasControlCharacter,
  normalizePushRefAllowlist,
} from "../../credentials/client-contracts.ts";

const commonFields = [
  "kind",
  "providerInstanceId",
  "configVersion",
  "repositoryId",
  "repository",
] as const;
const appFields = [...commonFields, "appId", "installationId", "privateKeyFile"] as const;
const tokenStringFields = [...commonFields, "tokenFile"] as const;
const tokenOptionalFields = ["allowGraphql", "leaseSeconds"];
const tokenFields = [
  ...tokenStringFields,
  "developmentOnly",
  "pushRefAllowlist",
  ...tokenOptionalFields,
];
export const defaultTokenLeaseSeconds = 3600;

function parseFields(value: unknown, allowed: readonly string[], strings: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-backend");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error("invalid-backend");
  }
  for (const key of strings) {
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
  return input;
}

function validNumericId(value: string): boolean {
  return /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

function validateCommon(input: Record<string, unknown>) {
  const { providerInstanceId, configVersion, repositoryId, repository } = input as Record<
    string,
    string
  >;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerInstanceId!) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(configVersion!) ||
    !validNumericId(repositoryId!) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository!)
  ) {
    throw new Error("invalid-backend");
  }
  return {
    providerInstanceId: providerInstanceId!,
    configVersion: configVersion!,
    repositoryId: repositoryId!,
    repository: repository!,
  };
}

function validateAppConfiguration(value: unknown): GitHubAppConfiguration {
  const input = parseFields(value, appFields, appFields) as Record<
    (typeof appFields)[number],
    string
  >;
  const common = validateCommon(input);
  if (
    ![input.appId, input.installationId].every(validNumericId) ||
    !isAbsolute(input.privateKeyFile)
  ) {
    throw new Error("invalid-backend");
  }
  return Object.freeze({
    kind: "github-app",
    providerInstanceId: common.providerInstanceId,
    configVersion: common.configVersion,
    appId: input.appId,
    installationId: input.installationId,
    repositoryId: common.repositoryId,
    repository: common.repository,
    privateKeyFile: input.privateKeyFile,
  });
}

function validateTokenConfiguration(value: unknown): GitHubTokenConfiguration {
  const input = parseFields(value, tokenFields, tokenStringFields);
  const common = validateCommon(input);
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
    ...common,
    tokenFile: input.tokenFile as string,
    developmentOnly: true,
    pushRefAllowlist,
    allowGraphql: input.allowGraphql === true,
    leaseSeconds,
  });
}

export function validateGitHubConfiguration(value: unknown): GitHubConfiguration {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (kind === "github-app") {
    return validateAppConfiguration(value);
  }
  if (kind === "github-token") {
    return validateTokenConfiguration(value);
  }
  throw new Error("invalid-backend");
}
