// @ts-check

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { InstallationId } from "../packages/contracts/src/index.ts";
import {
  preflight,
  readManifest,
  receiptsMatchEntries,
  refuse,
  requireReceiptsMatchEntries,
} from "./migration-history-preflight.ts";

const directory = fileURLToPath(new URL("../migrations", import.meta.url));
const dependency = createRequire(new URL("../packages/occ/package.json", import.meta.url));
const { drizzle } = dependency("drizzle-orm/node-postgres");
/** @type {{ readMigrationFiles: import("./migration-history-preflight.ts").MigrationReader }} */
const { readMigrationFiles } = dependency("drizzle-orm/migrator");
const lock = [1868785005, 1835624306];
const installationIdPattern =
  "pattern" in InstallationId && typeof InstallationId.pattern === "string"
    ? new RegExp(InstallationId.pattern, "u")
    : undefined;

export class UnsupportedPostgresVersionError extends Error {
  constructor() {
    super(
      "PostgreSQL versions before 17 cannot run OCE migration catalog checks (MAINTAIN privilege required). " +
        "Stopped before migration. Use the validated PostgreSQL 18.6 baseline, preserve any existing database, and rerun --check before installing or upgrading.",
    );
  }
}

/**
 * @param {import("./migration-history-preflight.ts").MigrationReceipt[]} receipts
 * @param {import("./migration-history-preflight.ts").MigrationManifest} manifest
 * @returns {import("./migration-history-preflight.ts").MigrationHistory}
 */
function classifyReceipts(receipts, manifest) {
  const expected = manifest.entries;
  const providerCompleted = manifest.compatibleLineages?.providerCompleted;
  const providerCount = providerCompleted?.entries.length ?? 0;
  const providerLineage =
    providerCompleted !== undefined &&
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

/**
 * @param {number} count
 * @param {number} completedCount
 * @returns {import("./migration-history-preflight.ts").MigrationHistory}
 */
function catalogAtMigrationCount(count, completedCount) {
  if (count === 0) {
    return "empty";
  }
  if (count === 24) {
    return "prePresetsMain";
  }
  if (count === 25) {
    return "main";
  }
  if (count === 65 && completedCount > 65) {
    return "preAgentDeployIntent";
  }
  if (count === 66 && completedCount > 66) {
    return "preAgentCredentialSourceLimit";
  }
  if (count === 67 && completedCount > 67) {
    return "preAgentPluginDriver";
  }
  if (count === 68 && completedCount > 68) {
    return "preConnectionTemplates";
  }
  if (count === 69 && completedCount > 69) {
    return "preSavedConnections";
  }
  if (count === 70 && completedCount > 70) {
    return "preDefaultUsers";
  }
  if (count === 71 && completedCount > 71) {
    return "preHarnessOverrides";
  }
  if (count === 72 && completedCount > 72) {
    return "preAccountAdministrationPolicy";
  }
  if (count === 73 && completedCount > 73) {
    return "preFiniteRepositorySessionWithdrawal";
  }
  if (count === 74 && completedCount > 74) {
    return "preHumanAuthenticationResults";
  }
  if (count === 75 && completedCount > 75) {
    return "preNativeBrowserAccess";
  }
  if (count === 76 && completedCount > 76) {
    return "preControlPlaneAudit";
  }
  if (count === 77 && completedCount > 77) {
    return "prePendingSandboxPolicyApplication";
  }
  if (count === 78 && completedCount > 78) {
    return "prePredecessorReplacement";
  }
  if (count === 79 && completedCount > 79) {
    return "preRevisionRuntimeInputs";
  }
  if (count === 80 && completedCount > 80) {
    return "preRestartContinuation";
  }
  if (count === 81 && completedCount > 81) {
    return "preAuthenticationStates";
  }
  if (count === 82 && completedCount > 82) {
    return "preNativeRestartRecovery";
  }
  if (count === completedCount) {
    return "completed";
  }
  if (count === 27) {
    return "repositoryCredentials";
  }
  if (count === 28) {
    return "repositoryRetention";
  }
  if (count === 29) {
    return "workspaceSetup";
  }
  if (count === 30) {
    return "agentProvisioning";
  }
  if (count === 31) {
    return "backendCompleted";
  }
  if (count === 32) {
    return "backendTerminology";
  }
  if (count === 33) {
    return "prePluginApprovers";
  }
  if (count === 34) {
    return "preBrokerReceipts";
  }
  if (count === 36) {
    return "preDeploymentProgress";
  }
  if (count === 35) {
    return "preAgentDeletion";
  }
  if (count === 37) {
    return "preHumanAuthentication";
  }
  if (count === 38) {
    return "preAgentDeletionTakeover";
  }
  if (count === 39) {
    return "preNamespaceDeletionTakeover";
  }
  if (count === 40) {
    return "preRepositoryAccess";
  }
  if (count === 41) {
    return "preRestrictionReadLogs";
  }
  if (count === 42) {
    return "preOAuth";
  }
  if (count === 43) {
    return "preCredentialWithdrawals";
  }
  if (count === 44) {
    return "preBrokerReceiptFence";
  }
  if (count === 45) {
    return "preModelProbeFailureCause";
  }
  if (count === 46) {
    return "preProvisioningConfigurationRelease";
  }
  if (count === 47) {
    return "preAdministratorCredentialSourceGrants";
  }
  if (count === 48) {
    return "preCodexPatSources";
  }
  if (count === 49) {
    return "preAgentCredentialSources";
  }
  if (count === 50) {
    return "preCredentialWithdrawalRequester";
  }
  if (count === 51) {
    return "preProvisioningDeploymentOutcome";
  }
  if (count === 52) {
    return "preComputePreparationFailureEvidence";
  }
  if (count === 53) {
    return "preCredentialSourcePat";
  }
  if (count === 54) {
    return "preComputeRevisionAdmission";
  }
  if (count === 55) {
    return "preHeldAuthenticationSession";
  }
  if (count === 56) {
    return "preCanonicalHarnessAuth";
  }
  if (count === 57) {
    return "preSandboxPolicies";
  }
  if (count === 58) {
    return "preSandboxPolicyAdministrator";
  }
  if (count === 59) {
    return "preCredentialProxy";
  }
  if (count === 62) {
    return "prePreparedAttemptSettlement";
  }
  if (count === 64) {
    return "preSelectedRepositorySet";
  }
  if (count === 63) {
    return "preGatewayManagedMode";
  }
  refuse("an incomplete or unsupported development history is installed");
}

/**
 * @param {Pick<import("pg").Pool, "connect">} pool
 * @param {{ checkOnly?: boolean; expectEmpty?: boolean; requireCurrent?: boolean; installationId?: string | undefined }} [options]
 */
export async function migrateWithHistory(
  pool,
  { checkOnly = false, expectEmpty = false, requireCurrent = false, installationId } = {},
) {
  if (installationId !== undefined && !installationIdPattern?.test(installationId)) {
    refuse("an expected Installation ID is invalid");
  }
  const { manifest, migrations } = await readManifest(directory, readMigrationFiles);
  const client = await pool.connect();
  let locked = false;
  try {
    /** @type {{ rows: { compatible: boolean }[] }} */
    const { rows } = await client.query(
      "SELECT pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >= 170000 AS compatible",
    );
    if (rows[0]?.compatible !== true) {
      throw new UnsupportedPostgresVersionError();
    }
    await client.query("SELECT pg_catalog.pg_advisory_lock($1, $2)", lock);
    locked = true;
    const history = await preflight(client, manifest, classifyReceipts);
    // Check first-install intent while holding the migration lock. A separate --check
    // could observe empty history and then lose a race to another installer.
    if (expectEmpty && history !== "empty") {
      throw Object.assign(
        new Error(
          "First installation requires empty migration history; this database already has recognized OCE migrations. " +
            "Preserve the database, inspect the original installation attempt, and use --check to inspect migration history without applying changes.",
        ),
        { code: "MIGRATION_HISTORY_NOT_EMPTY" },
      );
    }
    if (installationId !== undefined) {
      if (history === "empty") {
        refuse("the selected migration database has empty Installation history");
      }
      // Read the actual ledger owner before applying SQL, on the same client
      // and under the same advisory lock used by the stock migrator.
      const { rows: installations } = await client.query(
        "SELECT id = $1 AS matches FROM occ.installation LIMIT 2",
        [installationId],
      );
      if (installations.length !== 1 || installations[0]?.matches !== true) {
        refuse("the selected migration database does not own the expected Installation");
      }
    }
    if (requireCurrent) {
      if (history !== "completed") {
        throw Object.assign(
          new Error(
            "The separate database deployment has not completed the candidate migration history. " +
              "Keep writers stopped, reconcile the migration, and retry the service deployment.",
          ),
          { code: "MIGRATION_HISTORY_PENDING" },
        );
      }
      return history;
    }
    if (!checkOnly) {
      if (history === "completed") {
        // Keep Drizzle's refusal on read-only sessions, including standbys,
        // without overriding the operator's transaction mode.
        /** @type {{ rows: { transaction_read_only: string }[] }} */
        const { rows } = await client.query("SHOW transaction_read_only");
        if (rows[0]?.transaction_read_only === "off") {
          return history;
        }
      }
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
