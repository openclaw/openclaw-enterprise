// Shared Installation value validation. File loading, environment access and
// Driver binding remain in their owning composition modules.
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";

export type ConfigurationRecord = Readonly<Record<string, unknown>>;

export function object(value: unknown, path: string): ConfigurationRecord {
  const result = asRecord(value);
  if (result === undefined) {
    throw new Error(`${path} must be one object.`);
  }
  return result;
}

export function closed(value: ConfigurationRecord, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`${path} contains unsupported option ${key}.`);
    }
  }
}

export function nonempty(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a nonempty string.`);
  }
  return value;
}

export interface EgressAuthorityConfiguration {
  readonly host: string;
  readonly port: number;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly issuerPublicKeyPath: string;
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
}

export function egressAuthorityConfiguration(
  input: unknown,
  mode: "development" | "production",
): EgressAuthorityConfiguration {
  const value = asRecord(input);
  const fields = [
    "host",
    "port",
    "certificatePath",
    "privateKeyPath",
    "issuerPublicKeyPath",
    "issuer",
    "audience",
    "keyId",
  ];
  if (
    !value ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => key !== "port" && (typeof value[key] !== "string" || !value[key])) ||
    !Number.isSafeInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65535 ||
    !["certificatePath", "privateKeyPath", "issuerPublicKeyPath"].every((key) =>
      isAbsolute(String(value[key])),
    ) ||
    (mode === "development" && !["127.0.0.1", "::1"].includes(String(value.host)))
  ) {
    throw new Error(
      "Protected egress requires explicit TLS, issuer identity and a loopback development listener.",
    );
  }
  return value as unknown as EgressAuthorityConfiguration;
}

export function openShellRepositoryConfiguration(
  input: unknown,
  mode: "development" | "production",
) {
  if (input === undefined) {
    return undefined;
  }
  const value = object(input, "repository.openShell");
  closed(value, ["registrationName", "authority"], "repository.openShell");
  return {
    registrationName: nonempty(value.registrationName, "repository.openShell.registrationName"),
    authority: egressAuthorityConfiguration(value.authority, mode),
  };
}
