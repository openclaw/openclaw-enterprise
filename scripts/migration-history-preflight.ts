import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { catalogDigest, initialSchemaState, migrationCatalog } from "./migration-catalog.ts";

type MigrationSession = Parameters<typeof migrationCatalog>[0];

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type ManifestEntry = JournalEntry & { sha256: string };

export type MigrationHistory =
  keyof typeof import("../migrations/meta/_canonical-history.json").catalogs;

export type MigrationManifest = {
  entries: ManifestEntry[];
  catalogs: Partial<Record<MigrationHistory, string>> & { completed: string };
  initialSchemaStates: { absent: unknown; ownerOnly: unknown };
  ledgerCatalogs: { initialized: string; completed: string };
  compatibleLineages?: { providerCompleted?: { entries: ManifestEntry[] } };
  logicalRestoreCatalogs?: Record<string, unknown>;
};

type MigrationMetadata = {
  sql: string[];
  folderMillis: number;
  hash: string;
  bps: boolean;
};

export type MigrationReader = (config: { migrationsFolder: string }) => MigrationMetadata[];

export type MigrationReceipt = {
  id: number;
  hash: string;
  created_at: string | number | null;
};

export function refuse(reason: string): never {
  throw Object.assign(new Error(`Unsupported migration history: ${reason}.`), {
    code: "MIGRATION_HISTORY_UNSUPPORTED",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  return (
    isRecord(value) &&
    typeof value.idx === "number" &&
    typeof value.version === "string" &&
    typeof value.when === "number" &&
    typeof value.tag === "string" &&
    typeof value.breakpoints === "boolean" &&
    typeof value.sha256 === "string"
  );
}

function isManifestEntryList(value: unknown): value is ManifestEntry[] {
  return Array.isArray(value) && value.every(isManifestEntry);
}

function isMigrationManifest(value: Record<string, unknown>): value is MigrationManifest {
  const {
    entries,
    catalogs,
    initialSchemaStates,
    ledgerCatalogs,
    compatibleLineages,
    logicalRestoreCatalogs,
  } = value;
  return (
    isManifestEntryList(entries) &&
    isRecord(catalogs) &&
    typeof catalogs.completed === "string" &&
    Object.values(catalogs).every((catalog) => typeof catalog === "string") &&
    isRecord(initialSchemaStates) &&
    "absent" in initialSchemaStates &&
    "ownerOnly" in initialSchemaStates &&
    isRecord(ledgerCatalogs) &&
    typeof ledgerCatalogs.initialized === "string" &&
    typeof ledgerCatalogs.completed === "string" &&
    (compatibleLineages === undefined ||
      (isRecord(compatibleLineages) &&
        (compatibleLineages.providerCompleted === undefined ||
          (isRecord(compatibleLineages.providerCompleted) &&
            isManifestEntryList(compatibleLineages.providerCompleted.entries))))) &&
    (logicalRestoreCatalogs === undefined || isRecord(logicalRestoreCatalogs))
  );
}

export async function readManifest(
  directory: string,
  readMigrationFiles: MigrationReader,
): Promise<{ manifest: MigrationManifest; migrations: MigrationMetadata[] }> {
  const manifest: unknown = JSON.parse(
    await readFile(join(directory, "meta/_canonical-history.json"), "utf8"),
  );
  const journal: unknown = JSON.parse(
    await readFile(join(directory, "meta/_journal.json"), "utf8"),
  );
  if (!isRecord(manifest) || !Array.isArray(manifest.entries)) {
    refuse(
      "the canonical migration manifest is invalid; preserve the database and run --check with an intact matching release",
    );
  }
  const entries: unknown[] = manifest.entries;
  if (!entries.every(isRecord)) {
    refuse(
      "a canonical migration entry is invalid; preserve the database and run --check with an intact matching release",
    );
  }
  const expected = entries.map(({ sha256: _hash, ...entry }) => entry);
  if (
    manifest.version !== 1 ||
    !isRecord(journal) ||
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !isDeepStrictEqual(journal.entries, expected)
  ) {
    refuse("the journal differs from the reviewed source manifest");
  }
  if (!isRecord(manifest.catalogs) || typeof manifest.catalogs.completed !== "string") {
    refuse("the completed catalog has not been qualified");
  }
  const migrations = readMigrationFiles({ migrationsFolder: directory });
  if (migrations.length !== entries.length) {
    refuse("the migration source set differs");
  }
  let previousTimestamp: number | undefined;
  for (const [index, entry] of entries.entries()) {
    const migration = migrations[index];
    if (
      previousTimestamp !== undefined &&
      typeof entry.when === "number" &&
      entry.when <= previousTimestamp
    ) {
      refuse(`migration timestamp does not advance for ${entry.tag}`);
    }
    if (
      migration === undefined ||
      migration.hash !== entry.sha256 ||
      migration.folderMillis !== entry.when
    ) {
      refuse(`source bytes differ for ${entry.tag}`);
    }
    previousTimestamp = migration.folderMillis;
  }
  if (!isMigrationManifest(manifest)) {
    refuse(
      "the canonical migration manifest is invalid; preserve the database and run --check with an intact matching release",
    );
  }
  return { manifest, migrations };
}

async function requireInitialSchema(
  client: MigrationSession,
  schema: string,
  manifest: MigrationManifest,
): Promise<void> {
  const state = await initialSchemaState(client, schema);
  if (
    !isDeepStrictEqual(state, manifest.initialSchemaStates.absent) &&
    !isDeepStrictEqual(state, manifest.initialSchemaStates.ownerOnly)
  ) {
    refuse(`the initial ${schema} schema state is not reviewed`);
  }
}

async function requireMigrationRoles(client: MigrationSession): Promise<void> {
  const { rows: roles } = await client.query<{ limited: boolean | null }>(`
    SELECT current_user = 'occ_migrator' AND session_user = current_user
      AND pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE')
      AND NOT pg_catalog.has_database_privilege('occ_app', pg_catalog.current_database(), 'CREATE')
      AND NOT pg_catalog.pg_has_role('occ_app', 'occ_migrator', 'MEMBER')
      AND NOT pg_catalog.pg_has_role('occ_migrator', 'occ_app', 'MEMBER')
      AND (SELECT count(*)=2 AND bool_and(rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
        AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
        FROM pg_catalog.pg_roles WHERE rolname IN ('occ_app','occ_migrator')) AS limited`);
  if (roles[0]?.limited !== true) {
    refuse("the application and migration roles are not separated");
  }
  const { rows: schemas } = await client.query<{
    owned: boolean;
    app_create: boolean;
    other_create: boolean;
  }>(`
    SELECT nspowner = current_user::pg_catalog.regrole AS owned,
      pg_catalog.has_schema_privilege('occ_app', oid, 'CREATE') AS app_create,
      EXISTS (SELECT 1 FROM pg_catalog.aclexplode(nspacl) x
        WHERE x.grantee<>nspowner AND x.privilege_type='CREATE') AS other_create
    FROM pg_catalog.pg_namespace WHERE nspname IN ('occ','drizzle')`);
  if (schemas.some((schema) => !schema.owned || schema.app_create || schema.other_create)) {
    refuse("a database schema has unexpected ownership or CREATE grants");
  }
}

export function receiptsMatchEntries(
  receipts: readonly MigrationReceipt[],
  entries: readonly ManifestEntry[],
): boolean {
  let previousId = 0;
  for (const [index, receipt] of receipts.entries()) {
    const entry = entries[index];
    if (
      !Number.isSafeInteger(receipt.id) ||
      receipt.id <= previousId ||
      entry === undefined ||
      receipt.hash !== entry.sha256 ||
      Number(receipt.created_at) !== entry.when
    ) {
      return false;
    }
    previousId = receipt.id;
  }
  return receipts.length <= entries.length;
}

export function requireReceiptsMatchEntries(
  receipts: readonly MigrationReceipt[],
  entries: readonly ManifestEntry[],
): void {
  if (!receiptsMatchEntries(receipts, entries)) {
    refuse(
      "the applied receipts differ from canonical history; pre-merge preview histories are unsupported; preserve the database with its matching release or explicitly reset a disposable preview",
    );
  }
}

async function requireUnambiguousTerminologyData(client: MigrationSession): Promise<void> {
  const { rows } = await client.query<{ compatible: boolean }>(`
    SELECT NOT (
      EXISTS (
        SELECT 1 FROM occ.agents
        WHERE harness_auth ?& ARRAY['providerBinding', 'backendBinding']
      ) OR EXISTS (
        SELECT 1 FROM occ.agent_revisions
        WHERE (admitted_spec #> '{harness_auth}') ?& ARRAY['providerBinding', 'backendBinding']
      ) OR EXISTS (
        SELECT 1
        FROM occ.agent_revisions AS revision
        CROSS JOIN LATERAL jsonb_array_elements(
          revision.admitted_spec #> '{repository_credentials,bindings}'
        ) AS binding
        WHERE jsonb_typeof(revision.admitted_spec #> '{repository_credentials,bindings}') = 'array'
          AND binding ?& ARRAY['providerId', 'backendId']
      ) OR EXISTS (
        SELECT 1 FROM occ.presets
        WHERE (template #> '{agent}') ?& ARRAY['providerId', 'backendId']
      ) OR EXISTS (
        SELECT 1 FROM occ.repository_session_attempts
        WHERE (cleanup_context #> '{binding}') ?& ARRAY['providerId', 'backendId']
      ) OR EXISTS (
        SELECT 1 FROM occ.agent_provisioning_work
        WHERE plan ?& ARRAY['providerId', 'backendId']
      )
    ) AS compatible`);
  if (rows[0]?.compatible !== true) {
    refuse("Provider and Backend terminology data is ambiguous");
  }
}

export async function preflight(
  client: MigrationSession,
  manifest: MigrationManifest,
  classifyReceipts: (receipts: MigrationReceipt[], manifest: MigrationManifest) => MigrationHistory,
): Promise<MigrationHistory> {
  await requireMigrationRoles(client);
  const ledger = catalogDigest(await migrationCatalog(client, "drizzle"));
  let receipts: MigrationReceipt[] = [];
  if (
    ledger === manifest.ledgerCatalogs.initialized ||
    ledger === manifest.ledgerCatalogs.completed
  ) {
    ({ rows: receipts } = await client.query<MigrationReceipt>(
      "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
    ));
  } else {
    await requireInitialSchema(client, "drizzle", manifest);
  }
  const shape = classifyReceipts(receipts, manifest);
  if (shape === "empty") {
    await requireInitialSchema(client, "occ", manifest);
  } else if (ledger !== manifest.ledgerCatalogs.completed) {
    refuse("the Drizzle ledger objects or privileges have changed");
  }
  const native = manifest.catalogs[shape];
  const actual = catalogDigest(await migrationCatalog(client));
  const aliases =
    typeof native === "string" ? manifest.logicalRestoreCatalogs?.[native] : undefined;
  if (actual !== native && !(Array.isArray(aliases) && aliases.includes(actual))) {
    refuse(`catalog objects or effective grants differ for ${shape}`);
  }
  if (shape === "providerCompleted" || shape === "backendCompleted") {
    await requireUnambiguousTerminologyData(client);
  }
  return shape;
}
