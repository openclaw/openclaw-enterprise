import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { type LoggingConfiguration, operationalLoggingConfiguration } from "../logging.ts";

// Reads and admits the Installation startup YAML. The full loader in installation-config.ts and
// loadOperationalLoggingConfiguration share this reader, so both refuse the same files with the same
// errors. Keep Driver, Kubernetes client, and schema imports out of this module's static graph: the
// migration command imports it directly and pays for every module it loads on every run.

export type ConfigurationRecord = Readonly<Record<string, unknown>>;

interface LoadedStartupConfiguration {
  readonly configuration?: ConfigurationRecord;
  readonly path?: string;
}

const FORBIDDEN_SECRET_KEY =
  /(?:password|passwd|api[_-]?key|(?:access[_-]?)?token|private[_-]?key|(?:client[_-]?)?secret|credentials?)$/i;
const FORBIDDEN_SECRET_VALUE =
  /\bBearer\s+[A-Za-z0-9._~-]+|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,}|\bAKIA[0-9A-Z]{16}\b/i;

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

function safe(value: unknown, path: string): void {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error(`${path} must be a safe integer.`);
  }
  if (typeof value === "string" && FORBIDDEN_SECRET_VALUE.test(value)) {
    throw new Error(`${path} must not contain a plaintext credential.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => safe(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "installationId" || key === "installation_id") {
      throw new Error("Installation startup configuration must not contain an Installation ID.");
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`${path} contains an unsafe configuration key.`);
    }
    if (FORBIDDEN_SECRET_KEY.test(key) && typeof entry === "string") {
      throw new Error(`${path}.${key} must not contain a plaintext credential.`);
    }
    if (key === "secretRef") {
      nonempty(entry, `${path}.${key}`);
      throw new Error("Installation-scoped secret references cannot be resolved safely.");
    }
    safe(entry, `${path}.${key}`);
  }
}

export async function startupConfiguration(
  options: {
    readonly mode: "development" | "production";
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  required: boolean,
): Promise<LoadedStartupConfiguration> {
  const environment = options.environment ?? process.env;
  const path = environment.OCC_CONFIG_PATH;
  if (path === undefined) {
    if (!required) {
      return {};
    }
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (!isAbsolute(path)) {
    throw new Error("OCC_CONFIG_PATH must identify an absolute Installation startup YAML path.");
  }

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error("The configured Installation startup YAML is unavailable.");
  }

  // Imported on first use, so commands that run without a startup file (the migration command in CI
  // and in the Helm migration Job) never load the Kubernetes client.
  const { loadYaml } = await import("@kubernetes/client-node");
  let parsed: unknown;
  try {
    parsed = loadYaml(contents);
  } catch {
    throw new Error("The configured Installation startup file must contain valid YAML.");
  }
  const configuration = object(parsed, "Installation startup configuration");
  safe(configuration, "Installation startup configuration");
  if (Object.hasOwn(configuration, "integrations")) {
    throw new Error(
      "integrations is retired; configure ChatGPT with backend[].configuration.apiKeyPath.",
    );
  }
  closed(
    configuration,
    ["occ", "drivers", "backend", "logging", "presets", "observability", "runtime"],
    "Installation startup configuration",
  );
  return { configuration, path };
}

export async function loadOperationalLoggingConfiguration(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<LoggingConfiguration> {
  const { configuration } = await startupConfiguration(options, false);
  return operationalLoggingConfiguration(configuration?.logging);
}
