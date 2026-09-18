import type { OpenClawConfigurationDocument, OpenClawConfigurationValue } from "./index.ts";

export const LOGGING_LEVELS = Object.freeze(["debug", "info", "warn", "error"] as const);

export type LoggingLevel = (typeof LOGGING_LEVELS)[number];

type ConfigurationRecord = Readonly<Record<string, OpenClawConfigurationValue>>;

function record(value: OpenClawConfigurationValue | undefined): ConfigurationRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ConfigurationRecord)
    : Object.freeze({});
}

function requiredLevel(input: unknown, description: string): LoggingLevel {
  if (typeof input !== "string") {
    throw new Error(`${description} must be one of debug, info, warn, or error.`);
  }
  return normalizeLoggingLevel(input, description);
}

export function normalizeLoggingLevel(
  input: unknown = "info",
  description = "logging.level",
): LoggingLevel {
  if (LOGGING_LEVELS.some((level) => level === input)) {
    return input as LoggingLevel;
  }
  throw new Error(`${description} must be one of debug, info, warn, or error.`);
}

export function admitLoggingConfiguration(
  configuration: OpenClawConfigurationDocument,
  level: LoggingLevel,
): OpenClawConfigurationDocument {
  const logging = record(configuration.logging);
  const admittedLogging: Record<string, OpenClawConfigurationValue> = { ...logging };
  // Native OpenClaw owns redaction; admitted read-only runtime config must omit this retired setting.
  delete admittedLogging.redactSensitive;
  const diagnostics = record(configuration.diagnostics);
  const otel = record(diagnostics.otel);
  return Object.freeze({
    ...configuration,
    logging: Object.freeze({
      ...admittedLogging,
      level,
      consoleLevel: level,
      consoleStyle: "json",
    }),
    diagnostics: Object.freeze({
      ...diagnostics,
      otel: Object.freeze({
        ...otel,
        logs: false,
      }),
    }),
  });
}

export function admittedLoggingLevel(configuration: OpenClawConfigurationDocument): LoggingLevel {
  const logging = record(configuration.logging);
  const level = requiredLevel(logging.level, "admitted logging.level");
  const consoleLevel = requiredLevel(logging.consoleLevel, "admitted logging.consoleLevel");
  if (consoleLevel !== level) {
    throw new Error("Admitted logging levels must agree before workload rendering.");
  }
  if (logging.consoleStyle !== "json") {
    throw new Error("Admitted logging.consoleStyle must be json before workload rendering.");
  }
  if (Object.hasOwn(logging, "redactSensitive")) {
    throw new Error("Admitted logging.redactSensitive is retired before workload rendering.");
  }
  const diagnostics = record(configuration.diagnostics);
  const otel = record(diagnostics.otel);
  if (otel.logs !== false) {
    throw new Error("Admitted diagnostics.otel.logs must be false before workload rendering.");
  }
  return level;
}
