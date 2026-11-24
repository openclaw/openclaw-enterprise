import { Check } from "typebox/value";
import { ErrorDetail } from "@openclaw-enterprise/contracts";
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
// `github_pat_`), GitLab (`glpat-`) or Slack key, a private key, an AWS access key ID (`AKIA`,
// or `ASIA` for a temporary one), or a Google OAuth access token (`ya29.`) or API key (`AIza`).
const SECRET_VALUE =
  /\bBearer\s+[A-Za-z0-9._~-]+|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[oprsu]|github_pat)_[A-Za-z0-9_]{12,}|\bglpat-[A-Za-z0-9_-]{20,}|\bxox[abeoprs]-[A-Za-z0-9-]{10,}|\bA[KS]IA[0-9A-Z]{16}\b|\bya29\.[A-Za-z0-9_-]{20,}|\bAIza[A-Za-z0-9_-]{35}/i;
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
  "attemptId",
  "admissionCurrent",
  "inBounds",
  "stale",
  "clockTolerance",
  "stage",
  "firstFailureStage",
  "httpStatus",
  "responseComplete",
  "candidateIdentified",
  "requestEndCalled",
  "validationKind",
  "validationCode",
  "publication",
  "candidatePreparationReached",
  "cause",
  "cleanupCause",
  "code",
  "computeDriverId",
  "deployPasses",
  "dependency",
  "details",
  "durationMs",
  "elapsedMs",
  "errorClass",
  "event",
  "grpcStatus",
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
  "repositoryRef",
  "requestId",
  "restrictionIds",
  "result",
  "revisionId",
  "route",
  "sandboxDriverId",
  "sandboxId",
  "signal",
  "skippedUserCount",
  "skippedUserIds",
  "skippedUserIdsTruncated",
  "status",
  "step",
  "stopYields",
  "validationCategory",
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
  if (!SAFE_STRING.test(value) || resemblesCredential(value)) {
    return undefined;
  }
  return value;
}

// Names whose value is a credential. A longer name that ends in one counts too: `DB_PASSWORD`,
// `refresh_token`, `X-Amz-Signature`, `AccountKey`, `SharedAccessKey`, `x-api-key`.
const CREDENTIAL_NAME =
  "(?:access[-_]?key|account[-_]?key|api[-_]?key|authorization|cookie|passw(?:or)?d|private[-_]?key|pwd|secret|sig|signature|token)";
// A credential behind a name: a URL with user information (`postgres://user:pa/ss@host`; a
// password may hold an unescaped `/`; the scheme is not matched, `://` anchors the search); a
// query parameter that carries a credential only in a URL; a named credential with a value, as
// `name=value` (query, form body, connection string; one space may follow `=`, where a newline or
// format character collapsed) or as a JSON or dictionary pair (`"name": "value"`, quotes possibly
// escaped); or an HTTP header: Authorization with any scheme and a value with a digit or `=`, a
// cookie pair (a cookie name has no `:`), or an API key or session token.
const NAMED_CREDENTIAL = new RegExp(
  [
    String.raw`:\/\/[^\s/?#@:]*(?::[^\s?#@]*)?@`,
    String.raw`[?&](?:code|key|x-amz-credential)=`,
    String.raw`${CREDENTIAL_NAME}(?:=\s?[^\s&;]|\\?["']\s*:\s*\\?["'][^"'\\])`,
    String.raw`\b(?:authorization:\s*[\w-]+\s+[\w.~+/-]*[0-9=]|cookie:\s*[^\s=;:]+=[^\s;]|(?:api-key|x-amz-security-token):\s*[\w.~+/-]*[0-9])`,
  ].join("|"),
  "i",
);
export const WITHHELD_ERROR_TEXT = "The message was withheld because it resembles a credential.";
const LOGGED_ERROR_TEXT_CHARACTERS = 512;
// How much of the collapsed error text is checked: the logged cut (at most 1024 code units) plus
// a margin for a credential that straddles it. The bound caps what the patterns cost.
const CHECKED_ERROR_TEXT_UNITS = 4 * LOGGED_ERROR_TEXT_CHARACTERS;

/**
 * Whether text resembles a credential (a bearer, basic or API token, a JWT, a private key, a URL,
 * query, form, JSON or connection-string secret, or a credential header). Its cost grows with the
 * text, so bound long text first.
 */
export function resemblesCredential(text: string): boolean {
  return resemblesToken(text) || NAMED_CREDENTIAL.test(text);
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
  // Collapsed first (a linear pass), so padding cannot push a credential past the bound. Format
  // characters (bidi overrides, zero-width spaces) go too: they could change how a line reads.
  const line = value
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
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

// Fields that name a fixed code, from any emitter: for example an OpenShell Git expiry check, a
// failure class, the reason code an Agent is shown, a Harness lifecycle state or the operator
// guidance a refusal names. Only a short identifier passes, never free text. `command` passes
// only on auth:maintain events, whose commands are a fixed list (AUTH_MAINTAIN_COMMANDS).
const CODE_FIELDS = new Set([
  "check",
  "command",
  "failure",
  "harnessState",
  "hintCode",
  "reasonCode",
]);
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// Identifiers OCC assigns, kept only in their own format: the Installation a bootstrap or
// maintenance run names, and a Configuration a refused provisioning job left behind.
const INSTALLATION_ID = new RegExp(`^ins_${UUID_V4}$`);
// A repository token Source's delivery and refusal name the Source and its TokenService custody
// version: a random UUID written with the value, never derived from it.
const IDENTIFIER_FIELDS: ReadonlyMap<string, RegExp> = new Map([
  ["installationId", INSTALLATION_ID],
  ["orphanedConfigurationId", new RegExp(`^cfg_${UUID_V4}$`)],
  ["credentialSourceId", new RegExp(`^cs_${UUID_V4}$`)],
  ["credentialSourceVersion", new RegExp(`^${UUID_V4}$`)],
  // The class a refused Source's token was read as, from its documented prefix only.
  ["tokenClass", /^(?:fine-grained|classic|oauth|app-user|app-installation|unknown)$/],
]);
// On authentication events, the ID the API gives a request and answers with (`req_<UUID>`, or
// `nar_<UUID>` for a native admin check), so a line matches the response a caller saw. Other
// events keep their own rule for `requestId`.
const AUTHENTICATION_REQUEST_ID = new RegExp(`^(?:req|nar)_${UUID_V4}$`);
// A bootstrap attempt names the same Installation, and the administrator Principal and service
// Principal OCC assigns for it, each kept only in its own format (finding 2246). The auth account
// and service key IDs come from the auth library, not OCC, so they keep the generic string check.
const ATTEMPT_IDENTIFIER_FIELDS: ReadonlyMap<string, RegExp> = new Map([
  ["installationId", INSTALLATION_ID],
  ["principalId", new RegExp(`^prn_${UUID_V4}$`)],
  ["servicePrincipalId", new RegExp(`^spn_${UUID_V4}$`)],
]);

function safeIdentifier(format: RegExp, value: unknown): string | undefined {
  return typeof value === "string" && format.test(value) ? value : undefined;
}

// On authentication events, a route pattern such as `/agents/:agentId/chat`: no query, fragment
// or percent-encoding. The shape alone cannot tell a pattern from a raw path, so a value with a
// token shape is dropped too, and anything else that is not a route pattern is dropped.
const ROUTE_PATTERN = /^\/[A-Za-z0-9_.~:*/{}-]{0,255}$/;

function safeRoute(value: unknown): string | undefined {
  return typeof value === "string" && ROUTE_PATTERN.test(value) && !resemblesToken(value)
    ? value
    : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE.test(value) && !resemblesToken(value)
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
  if (key === "elapsedMs") {
    return value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
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
  if (
    [
      "admissionCurrent",
      "inBounds",
      "stale",
      "clockTolerance",
      "responseComplete",
      "candidateIdentified",
      "requestEndCalled",
    ].includes(key)
  ) {
    return typeof value === "boolean" ? value : undefined;
  }
  if (key === "httpStatus") {
    return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
      ? value
      : undefined;
  }
  if (
    ["stage", "firstFailureStage", "validationKind", "validationCode", "publication"].includes(key)
  ) {
    return safeCode(value);
  }
  if (key === "stopYields") {
    return typeof value === "number" && value >= 0 ? safeNumber(key, value) : undefined;
  }
  if (key === "grpcStatus") {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 16
      ? value
      : undefined;
  }
  if (key === "validationCategory") {
    return value === "POLICY_SAFETY" ||
      value === "POLICY_MIDDLEWARE_VALIDATION" ||
      value === "PVC_ADMISSION_LABELS" ||
      value === "CLASS_ADMISSION_LABELS" ||
      value === "CALLER_DRIVER_CONFIG_DISABLED" ||
      value === "RESOURCE_METADATA_FORBIDDEN" ||
      value === "UNKNOWN"
      ? value
      : undefined;
  }
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
    const identifier = ATTEMPT_IDENTIFIER_FIELDS.get(key);
    const safe =
      identifier === undefined ? safeScalar(key, field) : safeIdentifier(identifier, field);
    if (safe !== undefined) {
      result[key] = safe;
    }
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

/** Filter startup diagnostics for logs and operator checks. */
export function configurationLogDetails(value: readonly unknown[]) {
  return value
    .slice(0, 32)
    .filter(
      (detail): detail is ErrorDetail =>
        Check(ErrorDetail, detail) &&
        !resemblesCredential(`${detail.path} ${detail.message ?? ""}`) &&
        !/\p{Cc}/u.test(`${detail.path}${detail.message ?? ""}`),
    )
    .map((detail) => ({ path: detail.path, code: detail.code, message: detail.message }));
}

// Events whose `message` is a Compute Driver's diagnostic for the operator: a preparation
// failure and a preflight warning.
const MESSAGE_EVENTS = new Set(["worker.compute-prepare-failed", "compute.preflight-warning"]);

function sanitizedEvent(
  event: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rawEvent = event.event;
  const eventName =
    typeof rawEvent === "string" ? (safeString(rawEvent) ?? "occ.event") : "occ.event";
  const result: Record<string, unknown> = { event: eventName };
  for (const [key, value] of Object.entries(event)) {
    if (CODE_FIELDS.has(key)) {
      const code = safeCode(value);
      if (code !== undefined && (key !== "command" || eventName.startsWith("auth-maintain."))) {
        result[key] = code;
      }
      continue;
    }
    if (key === "requestId" && eventName.startsWith("authentication.")) {
      const id = safeIdentifier(AUTHENTICATION_REQUEST_ID, value);
      if (id !== undefined) {
        result[key] = id;
      }
      continue;
    }
    const identifier = IDENTIFIER_FIELDS.get(key);
    if (identifier !== undefined) {
      const id = safeIdentifier(identifier, value);
      if (id !== undefined) {
        result[key] = id;
      }
      continue;
    }
    if (key === "fence") {
      // A route generation, such as the OpenShell Git fence a worker holds: a non-negative integer.
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        result.fence = value;
      }
      continue;
    }
    if (key === "event" || !ALLOWED_FIELDS.has(key)) {
      continue;
    }
    if (key === "details") {
      if (
        (eventName === "startup-error" || eventName === "worker.startup-error") &&
        (event.code === "DRIVER_CONFIGURATION_INVALID" ||
          event.code === "CHART_LISTENER_MISMATCH") &&
        Array.isArray(value)
      ) {
        result.details = configurationLogDetails(value);
      }
      continue;
    }
    if (key === "message") {
      // Only these events keep a message: operator prose ("Stop Agent; wait") as one line, left
      // out when it resembles a credential. A closed OpenShell Git route can say why (its
      // GitHub origin is one the route never reaches).
      const text =
        typeof value === "string" &&
        (MESSAGE_EVENTS.has(eventName) ||
          (eventName === "worker.error" && event.code === "OPENSHELL_GIT_RECONCILIATION_REQUIRED"))
          ? loggedErrorText(value)
          : undefined;
      if (text !== undefined && text !== WITHHELD_ERROR_TEXT) {
        result.message = text;
      }
      continue;
    }
    if (
      key === "candidatePreparationReached" &&
      (eventName !== "worker.compute-prepare-failed" || typeof value !== "boolean")
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
            : key === "route" && eventName.startsWith("authentication.")
              ? safeRoute(value)
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
