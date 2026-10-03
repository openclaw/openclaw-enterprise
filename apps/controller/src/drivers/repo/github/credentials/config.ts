import { isAbsolute } from "node:path";
import type { GitHubConfiguration } from "./types.ts";
import { hasControlCharacter } from "../../credentials/client-contracts.ts";

const fields = [
  "kind",
  "providerInstanceId",
  "configVersion",
  "appId",
  "installationId",
  "repositoryId",
  "repository",
  "privateKeyFile",
] as const;
type ConfigurationFields = Record<(typeof fields)[number], string>;

function parseConfigurationFields(value: unknown): ConfigurationFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-backend");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.some((field) => field === key))) {
    throw new Error("invalid-backend");
  }
  for (const key of fields) {
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
  return input as ConfigurationFields;
}

function validNumericId(value: string): boolean {
  return /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

export function validateGitHubConfiguration(value: unknown): GitHubConfiguration {
  const input = parseConfigurationFields(value);
  if (
    input.kind !== "github-app" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.providerInstanceId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.configVersion)
  ) {
    throw new Error("invalid-backend");
  }
  if (![input.appId, input.installationId, input.repositoryId].every(validNumericId)) {
    throw new Error("invalid-backend");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.repository) ||
    !isAbsolute(input.privateKeyFile)
  ) {
    throw new Error("invalid-backend");
  }
  return Object.freeze({
    kind: input.kind,
    providerInstanceId: input.providerInstanceId,
    configVersion: input.configVersion,
    appId: input.appId,
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    repository: input.repository,
    privateKeyFile: input.privateKeyFile,
  });
}
