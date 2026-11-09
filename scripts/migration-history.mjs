import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { catalogDigest, initialSchemaState, migrationCatalog } from "./migration-catalog.mjs";

const directory = fileURLToPath(new URL("../migrations", import.meta.url));
const dependency = createRequire(new URL("../packages/occ/package.json", import.meta.url));
const { drizzle } = dependency("drizzle-orm/node-postgres");
const { readMigrationFiles } = dependency("drizzle-orm/migrator");
const lock = [1868785005, 1835624306];

export class UnsupportedPostgresVersionError extends Error {
  constructor() {
    super(
      "PostgreSQL versions before 17 cannot run OCE migration catalog checks (MAINTAIN privilege required). " +
        "Stopped before migration. Use the validated PostgreSQL 18.6 baseline, preserve any existing database, and rerun --check before installing or upgrading.",
    );
  }
}

function refuse(reason) {
  const error = new Error(`Unsupported migration history: ${reason}.`);
  error.code = "MIGRATION_HISTORY_UNSUPPORTED";
  throw error;
}

async function readManifest() {
  const manifest = JSON.parse(
    await readFile(join(directory, "meta/_canonical-history.json"), "utf8"),
  );
  const journal = JSON.parse(await readFile(join(directory, "meta/_journal.json"), "utf8"));
  const expected = manifest.entries.map(({ sha256: _hash, ...entry }) => entry);
  if (
    manifest.version !== 1 ||
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !isDeepStrictEqual(journal.entries, expected)
  ) {
    refuse("the journal differs from the reviewed source manifest");
  }
  if (typeof manifest.catalogs.completed !== "string") {
    refuse("the completed catalog has not been qualified");
  }
  const migrations = readMigrationFiles({ migrationsFolder: directory });
  if (migrations.length !== manifest.entries.length) {
    refuse("the migration source set differs");
  }
  for (const [index, entry] of manifest.entries.entries()) {
    if (index > 0 && entry.when <= manifest.entries[index - 1].when) {
      refuse(`migration timestamp does not advance for ${entry.tag}`);
    }
    if (migrations[index].hash !== entry.sha256 || migrations[index].folderMillis !== entry.when) {
      refuse(`source bytes differ for ${entry.tag}`);
    }
  }
  return { manifest, migrations };
}

async function requireInitialSchema(client, schema, manifest) {
  const state = await initialSchemaState(client, schema);
  if (
    !isDeepStrictEqual(state, manifest.initialSchemaStates.absent) &&
    !isDeepStrictEqual(state, manifest.initialSchemaStates.ownerOnly)
  ) {
    refuse(`the initial ${schema} schema state is not reviewed`);
  }
}

async function requireMigrationRoles(client) {
  const { rows: roles } = await client.query(`
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
  const { rows: schemas } = await client.query(`
    SELECT nspowner = current_user::pg_catalog.regrole AS owned,
      pg_catalog.has_schema_privilege('occ_app', oid, 'CREATE') AS app_create,
      EXISTS (SELECT 1 FROM pg_catalog.aclexplode(nspacl) x
        WHERE x.grantee<>nspowner AND x.privilege_type='CREATE') AS other_create
    FROM pg_catalog.pg_namespace WHERE nspname IN ('occ','drizzle')`);
  if (schemas.some((schema) => !schema.owned || schema.app_create || schema.other_create)) {
    refuse("a database schema has unexpected ownership or CREATE grants");
  }
}

function receiptsMatchEntries(receipts, entries) {
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

function requireReceiptsMatchEntries(receipts, entries) {
  if (!receiptsMatchEntries(receipts, entries)) {
    refuse(
      "the applied receipts differ from canonical history; pre-merge preview histories are unsupported; preserve the database with its matching release or explicitly reset a disposable preview",
    );
  }
}

function classifyReceipts(receipts, manifest) {
  const expected = manifest.entries;
  const providerCompleted = manifest.compatibleLineages?.providerCompleted;
  const providerCount = providerCompleted?.entries.length ?? 0;
  const providerLineage =
    providerCount > 0 &&
    receipts.length >= providerCount &&
    receiptsMatchEntries(receipts, [
      ...providerCompleted.entries,
      ...expected.slice(providerCount),
    ]);
  if (!providerLineage) {
    requireReceiptsMatchEntries(receipts, expected);
  } else if (receipts.length === providerCount) {
    return "providerCompleted";
  }
  // The Provider and canonical lineages share every subsequent migration and catalog.
  return catalogAtMigrationCount(receipts.length, expected.length);
}

const historicalCatalogs = new Map([
  [27, "repositoryCredentials"],
  [28, "repositoryRetention"],
  [29, "workspaceSetup"],
  [30, "agentProvisioning"],
  [31, "backendCompleted"],
  [32, "backendTerminology"],
  [33, "prePluginApprovers"],
  [34, "preBrokerReceipts"],
  [35, "preAgentDeletion"],
  [36, "preDeploymentProgress"],
  [37, "preHumanAuthentication"],
  [38, "preAgentDeletionTakeover"],
  [39, "preNamespaceDeletionTakeover"],
  [40, "preRepositoryAccess"],
  [41, "preRestrictionReadLogs"],
  [42, "preOAuth"],
  [43, "preCredentialWithdrawals"],
  [44, "preBrokerReceiptFence"],
  [45, "preModelProbeFailureCause"],
  [46, "preProvisioningConfigurationRelease"],
  [47, "preAdministratorCredentialSourceGrants"],
  [48, "preCodexPatSources"],
  [49, "preAgentCredentialSources"],
  [50, "preCredentialWithdrawalRequester"],
  [51, "preProvisioningDeploymentOutcome"],
  [52, "preComputePreparationFailureEvidence"],
  [53, "preCredentialSourcePat"],
  [54, "preComputeRevisionAdmission"],
  [55, "preHeldAuthenticationSession"],
  [56, "preCanonicalHarnessAuth"],
  [57, "preSandboxPolicies"],
  [58, "preSandboxPolicyAdministrator"],
  [59, "preCredentialProxy"],
  [62, "prePreparedAttemptSettlement"],
  [63, "preGatewayManagedMode"],
  [64, "preSelectedRepositorySet"],
  [65, "preAgentDeployIntent"],
  [66, "preAgentCredentialSourceLimit"],
  [67, "preAgentPluginDriver"],
  [68, "preConnectionTemplates"],
  [69, "preSavedConnections"],
  [70, "preDefaultUsers"],
  [71, "preHarnessOverrides"],
  [72, "preAccountAdministrationPolicy"],
  [73, "preFiniteRepositorySessionWithdrawal"],
  [74, "preProxyHarnessSnapshot"],
]);

function catalogAtMigrationCount(count, completedCount) {
  // These three baselines retain their release identity even at the manifest head.
  if (count === 0) {
    return "empty";
  }
  if (count === 24) {
    return "prePresetsMain";
  }
  if (count === 25) {
    return "main";
  }
  if (count === completedCount) {
    return "completed";
  }
  const catalog = historicalCatalogs.get(count);
  if (catalog !== undefined) {
    return catalog;
  }
  refuse("an incomplete or unsupported development history is installed");
}

async function requireUnambiguousTerminologyData(client) {
  const { rows } = await client.query(`
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

async function preflight(client, manifest) {
  await requireMigrationRoles(client);
  const ledger = catalogDigest(await migrationCatalog(client, "drizzle"));
  let receipts = [];
  if (
    ledger === manifest.ledgerCatalogs.initialized ||
    ledger === manifest.ledgerCatalogs.completed
  ) {
    ({ rows: receipts } = await client.query(
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
  const aliases = manifest.logicalRestoreCatalogs?.[native];
  if (actual !== native && !(Array.isArray(aliases) && aliases.includes(actual))) {
    refuse(`catalog objects or effective grants differ for ${shape}`);
  }
  if (shape === "providerCompleted" || shape === "backendCompleted") {
    await requireUnambiguousTerminologyData(client);
  }
  return shape;
}

export async function migrateWithHistory(pool, { checkOnly = false, expectEmpty = false } = {}) {
  const { manifest, migrations } = await readManifest();
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query(
      "SELECT pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >= 170000 AS compatible",
    );
    if (rows[0]?.compatible !== true) {
      throw new UnsupportedPostgresVersionError();
    }
    await client.query("SELECT pg_catalog.pg_advisory_lock($1, $2)", lock);
    locked = true;
    const history = await preflight(client, manifest);
    // Check first-install intent while holding the migration lock. A separate --check
    // could observe empty history and then lose a race to another installer.
    if (expectEmpty && history !== "empty") {
      const error = new Error(
        "First installation requires empty migration history; this database already has recognized OCE migrations. " +
          "Preserve the database, inspect the original installation attempt, and use --check to inspect migration history without applying changes.",
      );
      error.code = "MIGRATION_HISTORY_NOT_EMPTY";
      throw error;
    }
    if (!checkOnly) {
      // Pass the verified SQL to Drizzle's stock migrator without reading mutable
      // source files again. Its receipt read and transaction share this backend.
      const db = drizzle(client);
      await db.dialect.migrate(migrations, db.session, { migrationsFolder: directory });
    }
    return history;
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_catalog.pg_advisory_unlock($1, $2)", lock);
      }
    } finally {
      client.release();
    }
  }
}
