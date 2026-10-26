import { migrateWithHistory } from "./migration-history.mjs";
import { createPostgresPool } from "../packages/occ/src/state/postgres-pool.ts";
import { createOccLogger, emitOccLogEvent } from "../apps/controller/src/logging.ts";
// Not installation-config.ts: it loads every Driver, and this command runs once per migrated database.
import { loadOperationalLoggingConfiguration } from "../apps/controller/src/composition/startup-file.ts";

const databaseUrl = process.env.OCC_MIGRATION_DATABASE_URL;
let pool;
let logger = createOccLogger({ component: "occ-migration", level: "info", destination: "stderr" });

try {
  const [option, ...extra] = process.argv.slice(2);
  const checkOnly = option === "--check";
  const expectEmpty = option === "--expect-empty";
  if (extra.length || (option !== undefined && !checkOnly && !expectEmpty)) {
    throw new Error("The migration command accepts no arguments, --check, or --expect-empty.");
  }
  const logging = await loadOperationalLoggingConfiguration({
    mode: process.env.NODE_ENV === "development" ? "development" : "production",
  });
  logger = createOccLogger({
    component: "occ-migration",
    level: logging.level,
    destination: "stderr",
  });
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error("OCC_MIGRATION_DATABASE_URL must contain the dedicated migrator credential.");
  }
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("The migration connection must identify a PostgreSQL database.");
  }

  pool = await createPostgresPool(databaseUrl, { max: 1 });
  const history = await migrateWithHistory(pool, { checkOnly, expectEmpty });
  const event = checkOnly ? "migration.checked" : "migration.completed";
  process.stdout.write(`${JSON.stringify({ event, history })}\n`);
  emitOccLogEvent(logger, { event });
} catch (error) {
  const code = ["MIGRATION_HISTORY_UNSUPPORTED", "MIGRATION_HISTORY_NOT_EMPTY"].includes(
    error?.code,
  )
    ? error.code
    : "MIGRATION_FAILED";
  if (code !== "MIGRATION_FAILED") {
    process.stderr.write(`${error.message}\n`);
  }
  emitOccLogEvent(logger, {
    event: "migration.failed",
    code,
  });
  process.exitCode = 1;
} finally {
  if (pool !== undefined) {
    await pool.end();
  }
}
