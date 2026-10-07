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

function refuse(reason) {
  const error = new Error(`Unsupported migration history: ${reason}.`);
  error.code = "MIGRATION_HISTORY_UNSUPPORTED";
  throw error;
}

async function readManifest() {
  const manifest = JSON.parse(
    await readFile(join(directory, "meta/canonical-history.json"), "utf8"),
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
    refuse("the applied receipts differ from canonical history");
  }
}

function classifyReceipts(receipts, manifest) {
  const providerCompleted = manifest.compatibleLineages?.providerCompleted;
  if (providerCompleted !== undefined && receipts.length >= providerCompleted.entries.length) {
    const providerEntries = [
      ...providerCompleted.entries,
      ...manifest.entries.slice(providerCompleted.entries.length),
    ];
    if (receiptsMatchEntries(receipts, providerEntries)) {
      if (receipts.length === manifest.entries.length) {
        return "completed";
      }
      if (receipts.length === 32) {
        return "backendTerminology";
      }
      if (receipts.length === 33) {
        return "prePluginApprovers";
      }
      if (receipts.length === 34) {
        return "preBrokerReceipts";
      }
      if (receipts.length === 36) {
        return "preDeploymentProgress";
      }
      if (receipts.length === 35) {
        return "preAgentDeletion";
      }
      if (receipts.length === 37) {
        return "preHumanAuthentication";
      }
      if (receipts.length === 38) {
        return "preAgentDeletionTakeover";
      }
      if (receipts.length === 39) {
        return "preNamespaceDeletionTakeover";
      }
      if (receipts.length === 40) {
        return "preRepositoryAccess";
      }
      if (receipts.length === 41) {
        return "preRestrictionReadLogs";
      }
      if (receipts.length === 42) {
        return "preOAuth";
      }
      if (receipts.length === 43) {
        return "preCredentialWithdrawals";
      }
      if (receipts.length === 44) {
        return "preBrokerReceiptFence";
      }
      if (receipts.length === 45) {
        return "preModelProbeFailureCause";
      }
      if (receipts.length === 46) {
        return "preProvisioningConfigurationRelease";
      }
      if (receipts.length === 47) {
        return "preAdministratorCredentialSourceGrants";
      }
      if (receipts.length === 48) {
        return "preCodexPatSources";
      }
      return "providerCompleted";
    }
    if (!receiptsMatchEntries(receipts, manifest.entries)) {
      refuse("the applied receipts differ from canonical history");
    }
  } else {
    requireReceiptsMatchEntries(receipts, manifest.entries);
  }
  if (receipts.length === 0) {
    return "empty";
  }
  if (receipts.length === 24) {
    return "prePresetsMain";
  }
  if (receipts.length === 25) {
    return "main";
  }
  if (receipts.length === manifest.entries.length) {
    return "completed";
  }
  if (receipts.length === 27) {
    return "repositoryCredentials";
  }
  if (receipts.length === 28) {
    return "repositoryRetention";
  }
  if (receipts.length === 29) {
    return "workspaceSetup";
  }
  if (receipts.length === 30) {
    return "agentProvisioning";
  }
  if (receipts.length === 31) {
    return "backendCompleted";
  }
  if (receipts.length === 32) {
    return "backendTerminology";
  }
  if (receipts.length === 33) {
    return "prePluginApprovers";
  }
  if (receipts.length === 34) {
    return "preBrokerReceipts";
  }
  if (receipts.length === 36) {
    return "preDeploymentProgress";
  }
  if (receipts.length === 35) {
    return "preAgentDeletion";
  }
  if (receipts.length === 37) {
    return "preHumanAuthentication";
  }
  if (receipts.length === 38) {
    return "preAgentDeletionTakeover";
  }
  if (receipts.length === 39) {
    return "preNamespaceDeletionTakeover";
  }
  if (receipts.length === 40) {
    return "preRepositoryAccess";
  }
  if (receipts.length === 41) {
    return "preRestrictionReadLogs";
  }
  if (receipts.length === 42) {
    return "preOAuth";
  }
  if (receipts.length === 43) {
    return "preCredentialWithdrawals";
  }
  if (receipts.length === 44) {
    return "preBrokerReceiptFence";
  }
  if (receipts.length === 45) {
    return "preModelProbeFailureCause";
  }
  if (receipts.length === 46) {
    return "preProvisioningConfigurationRelease";
  }
  if (receipts.length === 47) {
    return "preAdministratorCredentialSourceGrants";
  }
  if (receipts.length === 48) {
    return "preCodexPatSources";
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
  if (catalogDigest(await migrationCatalog(client)) !== manifest.catalogs[shape]) {
    refuse(`catalog objects or effective grants differ for ${shape}`);
  }
  if (shape === "providerCompleted" || shape === "backendCompleted") {
    await requireUnambiguousTerminologyData(client);
  }
  return shape;
}

export async function migrateWithHistory(pool, { checkOnly = false } = {}) {
  const { manifest, migrations } = await readManifest();
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_catalog.pg_advisory_lock($1, $2)", lock);
    locked = true;
    const history = await preflight(client, manifest);
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
