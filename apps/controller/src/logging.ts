import { normalizeLoggingLevel, type LoggingLevel } from "@openclaw-enterprise/contracts";
import pino, { type Logger } from "pino";

export interface LoggingConfiguration {
  readonly level: LoggingLevel;
}

export type OccLogger = Logger;

export const DEFAULT_LOGGING_CONFIGURATION: LoggingConfiguration = Object.freeze({
  level: "info",
});

export type OccLogDestination = "stdout" | "stderr" | pino.DestinationStream;

export interface OccLoggerOptions {
  readonly component: string;
  readonly level?: LoggingLevel;
  readonly destination?: OccLogDestination;
}

const SAFE_STRING = /^[A-Za-z0-9][A-Za-z0-9._: /@-]{0,511}$/;
const SAFE_PATH = /^\/[ -~]{0,1023}$/;
const SECRET_VALUE =
  /\bBearer\s+[A-Za-z0-9._~-]+|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,}|\bAKIA[0-9A-Z]{16}\b/i;
const ALLOWED_ATTEMPT_FIELDS = new Set([
  "authAccountId",
  "installationId",
  "passwordFile",
  "principalId",
  "serviceKeyExpiresAt",
  "serviceKeyFile",
  "serviceKeyId",
  "servicePrincipalId",
]);

const ALLOWED_FIELDS = new Set([
  "activationMs",
  "agentId",
  "attempt",
  "cause",
  "code",
  "computeDriverId",
  "deployPasses",
  "dependency",
  "durationMs",
  "elapsedMs",
  "event",
  "host",
  "keyHash",
  "lane",
  "message",
  "method",
  "namespaceId",
  "operation",
  "outcome",
  "pending",
  "port",
  "prepareMs",
  "provider",
  "providerId",
  "readinessWaitMs",
  "requestId",
  "result",
  "revisionId",
  "route",
  "sandboxDriverId",
  "signal",
  "skippedUserCount",
  "skippedUserIds",
  "skippedUserIdsTruncated",
  "status",
  "step",
  "workId",
]);

export function operationalLoggingConfiguration(value: unknown): LoggingConfiguration {
  if (value === undefined) {
    return DEFAULT_LOGGING_CONFIGURATION;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("logging must be one object.");
  }
  for (const [key] of Object.entries(value)) {
    if (key !== "level") {
      throw new Error("logging contains an unsupported option.");
    }
  }
  const level = Object.hasOwn(value, "level")
    ? (value as Record<string, unknown>).level
    : DEFAULT_LOGGING_CONFIGURATION.level;
  return Object.freeze({ level: normalizeLoggingLevel(level) });
}

function loggerOptions(level: LoggingLevel, component: string): pino.LoggerOptions {
  return {
    level,
    base: { service: component },
    formatters: {
      level(label) {
        return { severity: label.toUpperCase() };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "message",
  };
}

function destinationStream(destination: OccLogDestination | undefined): pino.DestinationStream {
  if (destination === undefined || destination === "stdout") {
    return pino.destination(1);
  }
  if (destination === "stderr") {
    return pino.destination(2);
  }
  return destination;
}

export function createOccLogger(options: OccLoggerOptions): OccLogger {
  return pino(
    loggerOptions(options.level ?? DEFAULT_LOGGING_CONFIGURATION.level, options.component),
    destinationStream(options.destination),
  );
}

function safeString(value: string): string | undefined {
  if (!SAFE_STRING.test(value) || SECRET_VALUE.test(value)) {
    return undefined;
  }
  return value;
}

function safeNumber(key: string, value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (key === "durationMs") {
    return value >= 0 ? Math.round(value * 1000) / 1000 : undefined;
  }
  if (!Number.isSafeInteger(value)) {
    return undefined;
  }
  if (key === "attempt") {
    return value >= 0 ? value : undefined;
  }
  return value;
}

function safeScalar(key: string, value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    return safeString(value);
  }
  if (typeof value === "number") {
    return safeNumber(key, value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

// One log record carries at most this many account identifiers.
export const MAX_LOGGED_IDENTIFIERS = 100;

// Fields for a warning about accounts an operator must repair, such as users
// skipped at GitHub activation. The identifier list is capped; the total count
// and the truncation flag say when the record does not name every account.
export function skippedUserLogFields(userIds: readonly string[]): {
  readonly skippedUserIds: readonly string[];
  readonly skippedUserCount: number;
  readonly skippedUserIdsTruncated: boolean;
} {
  return {
    skippedUserIds: userIds.slice(0, MAX_LOGGED_IDENTIFIERS),
    skippedUserCount: userIds.length,
    skippedUserIdsTruncated: userIds.length > MAX_LOGGED_IDENTIFIERS,
  };
}

// Account identifiers an operator must repair, such as users skipped at GitHub activation.
function safeIdentifiers(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const identifiers = value
    .slice(0, MAX_LOGGED_IDENTIFIERS)
    .filter((entry): entry is string => typeof entry === "string" && safeString(entry) === entry);
  return identifiers.length === 0 ? undefined : Object.freeze(identifiers);
}

function safeAttempt(
  value: unknown,
): number | Readonly<Record<string, string | number | boolean>> | undefined {
  if (typeof value === "number") {
    return safeNumber("attempt", value);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!ALLOWED_ATTEMPT_FIELDS.has(key)) {
      continue;
    }
    if ((key === "passwordFile" || key === "serviceKeyFile") && typeof field === "string") {
      if (SAFE_PATH.test(field) && !SECRET_VALUE.test(field)) {
        result[key] = field;
      }
      continue;
    }
    const safe = safeScalar(key, field);
    if (safe !== undefined) {
      result[key] = safe;
    }
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

function sanitizedEvent(
  event: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rawEvent = event.event;
  const eventName =
    typeof rawEvent === "string" ? (safeString(rawEvent) ?? "occ.event") : "occ.event";
  const result: Record<string, unknown> = { event: eventName };
  for (const [key, value] of Object.entries(event)) {
    if (key === "event" || !ALLOWED_FIELDS.has(key)) {
      continue;
    }
    if (key === "message" && eventName !== "compute.preflight-warning") {
      continue;
    }
    const safe =
      key === "attempt"
        ? safeAttempt(value)
        : key === "skippedUserIds"
          ? safeIdentifiers(value)
          : safeScalar(key, value);
    if (safe !== undefined) {
      result[key] = safe;
    }
  }
  return Object.freeze(result);
}

// Events that warn although their names carry no warning suffix.
const WARNING_EVENTS = new Set(["authentication.sign-in-limited"]);

export function emitOccLogEvent(logger: OccLogger, event: Readonly<Record<string, unknown>>): void {
  const record = sanitizedEvent(event);
  const eventName = String(record.event);
  if (
    eventName.endsWith(".error") ||
    eventName.endsWith("-error") ||
    eventName.endsWith(".failed") ||
    eventName.endsWith("-failed")
  ) {
    logger.error(record);
    return;
  }
  if (
    eventName.endsWith(".warning") ||
    eventName.endsWith("-warning") ||
    WARNING_EVENTS.has(eventName)
  ) {
    logger.warn(record);
    return;
  }
  logger.info(record);
}

export function createWorkerLogEmitter(
  logger: OccLogger,
): (event: Readonly<Record<string, unknown>>) => void {
  return (event) => {
    const eventName = typeof event.event === "string" ? event.event : "worker.event";
    if (eventName === "worker.health") {
      logger.debug(sanitizedEvent({ ...event, event: eventName }));
      return;
    }
    emitOccLogEvent(logger, { ...event, event: eventName });
  };
}
