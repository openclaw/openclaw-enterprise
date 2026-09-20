import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "@openclaw-enterprise/occ";

export interface NativeAdminLaunchRecord {
  readonly parentSessionId: string;
  readonly parentUserId: string;
  readonly actorId: string;
  readonly actorIssuer: string;
  readonly actorSubject: string;
  readonly parentExpiresAt: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly host: string;
  readonly state: string;
  readonly challenge: string;
  readonly expiresAt: string;
}

export interface NativeAdminExchangeStore {
  issue(record: NativeAdminLaunchRecord): Promise<string>;
  consume(code: string): Promise<NativeAdminLaunchRecord | undefined>;
}

export const NATIVE_ADMIN_EXCHANGE_CODE_TTL_MS = 60_000;
export const NATIVE_ADMIN_EXCHANGE_MAX_ACTIVE_CODES_PER_PARENT_SESSION = 8;

const CODE_BYTES = 32;
const CODE_PREFIX = "native-admin:";
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_RECORD_JSON_BYTES = 4096;
const MAX_TEXT_LENGTH = {
  parentSessionId: 512,
  parentUserId: 512,
  actorId: 512,
  actorIssuer: 512,
  actorSubject: 512,
  parentExpiresAt: 64,
  namespaceId: 200,
  agentId: 200,
  revisionId: 200,
  host: 253,
  state: 512,
  challenge: 512,
  expiresAt: 64,
} satisfies Record<keyof NativeAdminLaunchRecord, number>;

export class NativeAdminExchangeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeAdminExchangeValidationError";
  }
}

export class NativeAdminExchangeLimitExceededError extends Error {
  constructor() {
    super("The parent session has too many active native admin launch exchanges.");
    this.name = "NativeAdminExchangeLimitExceededError";
  }
}

interface PostgresQueryResult {
  readonly rows: unknown[];
  readonly rowCount: number | null;
}

function urlSafeRandom(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function codeIdentifier(code: string): string | undefined {
  if (!CODE_PATTERN.test(code)) {
    return undefined;
  }
  return `${CODE_PREFIX}${createHash("sha256").update(code).digest("hex")}`;
}

function requireBoundedString(
  record: Partial<NativeAdminLaunchRecord>,
  field: keyof NativeAdminLaunchRecord,
): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_TEXT_LENGTH[field]
  ) {
    throw new NativeAdminExchangeValidationError(`${field} must be a bounded nonempty string.`);
  }
  if (value !== value.trim() || hasControlCharacter(value)) {
    throw new NativeAdminExchangeValidationError(`${field} must be normalized text.`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function requireTimestamp(value: string, field: keyof NativeAdminLaunchRecord): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new NativeAdminExchangeValidationError(`${field} must be a valid timestamp.`);
  }
  return timestamp;
}

function validateRecord(
  value: unknown,
  now: Date,
  {
    enforceActive,
    enforceFreshExchange,
  }: { enforceActive: boolean; enforceFreshExchange: boolean },
): NativeAdminLaunchRecord {
  if (typeof value !== "object" || value === null) {
    throw new NativeAdminExchangeValidationError("Native admin launch exchange is required.");
  }
  const candidate = value as Partial<NativeAdminLaunchRecord>;
  const record: NativeAdminLaunchRecord = {
    parentSessionId: requireBoundedString(candidate, "parentSessionId"),
    parentUserId: requireBoundedString(candidate, "parentUserId"),
    actorId: requireBoundedString(candidate, "actorId"),
    actorIssuer: requireBoundedString(candidate, "actorIssuer"),
    actorSubject: requireBoundedString(candidate, "actorSubject"),
    parentExpiresAt: requireBoundedString(candidate, "parentExpiresAt"),
    namespaceId: requireBoundedString(candidate, "namespaceId"),
    agentId: requireBoundedString(candidate, "agentId"),
    revisionId: requireBoundedString(candidate, "revisionId"),
    host: requireBoundedString(candidate, "host"),
    state: requireBoundedString(candidate, "state"),
    challenge: requireBoundedString(candidate, "challenge"),
    expiresAt: requireBoundedString(candidate, "expiresAt"),
  };
  const parentExpiresAt = requireTimestamp(record.parentExpiresAt, "parentExpiresAt");
  const expiresAt = requireTimestamp(record.expiresAt, "expiresAt");
  const nowMs = now.getTime();
  if (enforceActive && parentExpiresAt <= nowMs) {
    throw new NativeAdminExchangeValidationError("parentExpiresAt must be in the future.");
  }
  if (enforceActive && expiresAt <= nowMs) {
    throw new NativeAdminExchangeValidationError("expiresAt must be in the future.");
  }
  if (expiresAt > parentExpiresAt) {
    throw new NativeAdminExchangeValidationError("expiresAt must not outlive the parent session.");
  }
  if (enforceFreshExchange && expiresAt - nowMs > NATIVE_ADMIN_EXCHANGE_CODE_TTL_MS) {
    throw new NativeAdminExchangeValidationError("expiresAt must be within 60 seconds.");
  }
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_RECORD_JSON_BYTES) {
    throw new NativeAdminExchangeValidationError("Native admin launch exchange is too large.");
  }
  return Object.freeze(record);
}

function parsePersistedRecord(value: unknown): NativeAdminLaunchRecord | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return validateRecord(parsed, new Date(0), {
      enforceActive: false,
      enforceFreshExchange: false,
    });
  } catch {
    return undefined;
  }
}

export class MemoryNativeAdminExchangeStore implements NativeAdminExchangeStore {
  readonly #records = new Map<string, NativeAdminLaunchRecord>();

  async issue(record: NativeAdminLaunchRecord): Promise<string> {
    const now = new Date();
    const validated = validateRecord(record, now, {
      enforceActive: true,
      enforceFreshExchange: true,
    });
    this.#deleteExpired(now);
    const active = Array.from(this.#records.values()).filter(
      (entry) => entry.parentSessionId === validated.parentSessionId,
    ).length;
    if (active >= NATIVE_ADMIN_EXCHANGE_MAX_ACTIVE_CODES_PER_PARENT_SESSION) {
      throw new NativeAdminExchangeLimitExceededError();
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const code = urlSafeRandom(CODE_BYTES);
      const identifier = codeIdentifier(code)!;
      if (!this.#records.has(identifier)) {
        this.#records.set(identifier, validated);
        return code;
      }
    }
    throw new NativeAdminExchangeValidationError("Unable to create a unique native admin code.");
  }

  async consume(code: string): Promise<NativeAdminLaunchRecord | undefined> {
    const identifier = codeIdentifier(code);
    if (identifier === undefined) {
      return undefined;
    }
    const record = this.#records.get(identifier);
    this.#records.delete(identifier);
    if (record === undefined) {
      return undefined;
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      return undefined;
    }
    return parsePersistedRecord(record);
  }

  #deleteExpired(now: Date): void {
    const nowMs = now.getTime();
    for (const [identifier, record] of this.#records) {
      if (Date.parse(record.expiresAt) <= nowMs) {
        this.#records.delete(identifier);
      }
    }
  }
}

export class PostgresNativeAdminExchangeStore implements NativeAdminExchangeStore {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async issue(record: NativeAdminLaunchRecord): Promise<string> {
    const now = new Date();
    const validated = validateRecord(record, now, {
      enforceActive: true,
      enforceFreshExchange: true,
    });
    const code = urlSafeRandom(CODE_BYTES);
    const identifier = codeIdentifier(code)!;
    const client = await this.#pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${CODE_PREFIX}${validated.parentSessionId}`,
      ]);
      await deleteExpired(client);
      const active = await client.query(
        `SELECT count(*)::integer AS count
           FROM occ.verification
          WHERE identifier LIKE $1
            AND expires_at > statement_timestamp()
            AND value::jsonb ->> 'parentSessionId' = $2`,
        [`${CODE_PREFIX}%`, validated.parentSessionId],
      );
      if (rowCount(active.rows[0]) >= NATIVE_ADMIN_EXCHANGE_MAX_ACTIVE_CODES_PER_PARENT_SESSION) {
        throw new NativeAdminExchangeLimitExceededError();
      }
      await client.query(
        `INSERT INTO occ.verification (id, identifier, value, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [
          `nav_${randomUUID()}`,
          identifier,
          JSON.stringify(validated),
          new Date(validated.expiresAt),
          now,
        ],
      );
      await client.query("COMMIT");
      committed = true;
      return code;
    } finally {
      let discard = false;
      if (!committed) {
        discard = await rollback(client);
      }
      client.release(discard);
    }
  }

  async consume(code: string): Promise<NativeAdminLaunchRecord | undefined> {
    const identifier = codeIdentifier(code);
    if (identifier === undefined) {
      return undefined;
    }
    const result = await withClient<PostgresQueryResult>(this.#pool, (client) =>
      client.query(
        `DELETE FROM occ.verification
          WHERE identifier = $1
          RETURNING value, expires_at > statement_timestamp() AS active`,
        [identifier],
      ),
    );
    const row = result.rows[0] as { value?: unknown; active?: unknown } | undefined;
    if (row?.active !== true) {
      return undefined;
    }
    return parsePersistedRecord(row.value);
  }
}

async function deleteExpired(client: PostgresClient): Promise<void> {
  await client.query(
    "DELETE FROM occ.verification WHERE identifier LIKE $1 AND expires_at <= statement_timestamp()",
    [`${CODE_PREFIX}%`],
  );
}

async function rollback(client: PostgresClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}

async function withClient<T>(
  pool: PostgresPool,
  fn: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function rowCount(row: unknown): number {
  if (typeof row !== "object" || row === null || !("count" in row)) {
    return 0;
  }
  const value = (row as { count?: unknown }).count;
  return typeof value === "number" ? value : Number(value);
}
