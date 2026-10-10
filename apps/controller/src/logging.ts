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
// Token shapes: a bearer credential, an OpenAI, GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
// `github_pat_`) or Slack key, a private key, or an AWS access key ID.
const SECRET_VALUE =
  /\bBearer\s+[A-Za-z0-9._~-]+|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[oprsu]|github_pat)_[A-Za-z0-9_]{12,}|\bxox[abeoprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/i;
// Case-sensitive token shapes. A JWT (`eyJ` header and payload). A basic credential: a base64
// token of 8 or more characters with a digit, `+` or `=`, or with two uppercase letters after
// its first character, so prose ("Basic authentication", "basic OpenShell") passes.
const CASE_SENSITIVE_TOKEN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|\b(?:Basic|basic|BASIC)\s+(?=[A-Za-z0-9+/]{8})(?:[A-Za-z0-9+/]*[0-9+=]|[A-Za-z0-9+/][a-z/]*[A-Z][a-z/]*[A-Z])/;
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
  "errorClass",
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
  "presetFile",
  "presetId",
  "presetName",
  "provider",
  "providerId",
  "readinessWaitMs",
  "reason",
  "requestId",
  "restrictionIds",
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
  if (!SAFE_STRING.test(value) || resemblesToken(value)) {
    return undefined;
  }
  return value;
}

// A URL with user information (`postgres://user:pa/ss@host`; a password may hold an unescaped
// `/`), a query parameter that usually carries a credential, or a `password=` or OAuth secret
// pair in a connection string or form body. The scheme is not matched: `://` anchors the search.
const URL_CREDENTIAL =
  /:\/\/[^\s/?#@:]*(?::[^\s?#@]*)?@|[?&](?:access_token|api_key|apikey|client_secret|code|id_token|key|password|refresh_token|secret|sig|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature)=|(?:client_secret|passwd|password|pwd|refresh_token)=[^\s&;]/i;
export const WITHHELD_ERROR_TEXT = "The message was withheld because it resembles a credential.";
const LOGGED_ERROR_TEXT_CHARACTERS = 512;
// How much of the collapsed error text is checked: the logged cut (at most 1024 code units) plus
// a margin for a credential that straddles it. The bound caps what the patterns cost.
const CHECKED_ERROR_TEXT_UNITS = 4 * LOGGED_ERROR_TEXT_CHARACTERS;

/**
 * Whether text resembles a credential (a bearer, basic or API token, a JWT, a private key, or a
 * URL or connection-string secret). Its cost grows with the text, so bound long text first.
 */
export function resemblesCredential(text: string): boolean {
  return resemblesToken(text) || URL_CREDENTIAL.test(text);
}

function resemblesToken(text: string): boolean {
  return SECRET_VALUE.test(text) || CASE_SENSITIVE_TOKEN.test(text);
}

/**
 * Error text for a local operator log: one line of at most 512 characters, or fixed text when it
 * looks like it carries a credential. Most callers log text written by OCC code, but some messages
 * carry upstream text (a driver package's message, OpenShell CreateSandbox detail, a runtime
 * failure code). This is a pattern check, a second line of defense, not a sanitizer: callers must
 * still keep provider and request text out of what they log.
 */
export function loggedErrorText(value: string): string | undefined {
  // Collapsed first (a linear pass), so padding cannot push a credential past the bound.
  const line = value
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .slice(0, CHECKED_ERROR_TEXT_UNITS);
  if (line === "") {
    return undefined;
  }
  // Checked before the cut, so a credential that straddles it is withheld too.
  return resemblesCredential(line)
    ? WITHHELD_ERROR_TEXT
    : [...line].slice(0, LOGGED_ERROR_TEXT_CHARACTERS).join("");
}

function safePath(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_PATH.test(value) && !resemblesToken(value)
    ? value
    : undefined;
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
      const path = safePath(field);
      if (path !== undefined) {
        result[key] = path;
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
    if (
      key === "message" &&
      eventName !== "compute.preflight-warning" &&
      eventName !== "worker.compute-prepare-failed"
    ) {
      continue;
    }
    const safe =
      key === "attempt"
        ? safeAttempt(value)
        : key === "skippedUserIds" || key === "restrictionIds"
          ? safeIdentifiers(value)
          : key === "presetFile"
            ? safePath(value)
            : safeScalar(key, value);
    if (safe !== undefined) {
      result[key] = safe;
    }
  }
  return Object.freeze(result);
}

// Events that warn although their names carry no warning suffix.
const WARNING_EVENTS = new Set([
  "authentication.sign-in-limited",
  "presets.bundled-default-shadowed",
  "presets.default-create-skipped",
  "presets.default-refresh-skipped",
]);

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
