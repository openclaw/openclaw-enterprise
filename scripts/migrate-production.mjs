import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPostgresPool } from "../packages/occ/src/state/postgres-pool.ts";
import { createOccLogger, emitOccLogEvent } from "../apps/controller/src/logging.ts";
import { loadOperationalLoggingConfiguration } from "../apps/controller/src/composition/installation-config.ts";

const databaseUrl = process.env.OCC_MIGRATION_DATABASE_URL;
let pool;
let logger = createOccLogger({ component: "occ-migration", level: "info", destination: "stderr" });

try {
  const logging = await loadOperationalLoggingConfiguration({ mode: "production" });
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

  const dependency = createRequire(new URL("../packages/occ/package.json", import.meta.url));
  const { drizzle } = dependency("drizzle-orm/node-postgres");
  const { migrate } = dependency("drizzle-orm/node-postgres/migrator");
  pool = await createPostgresPool(databaseUrl, { max: 1 });
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  process.stdout.write(`${JSON.stringify({ event: "migration.completed" })}\n`);
  emitOccLogEvent(logger, { event: "migration.completed" });
} catch (error) {
  emitOccLogEvent(logger, {
    event: "migration.failed",
    code: "MIGRATION_FAILED",
  });
  process.exitCode = 1;
} finally {
  if (pool !== undefined) await pool.end();
}
