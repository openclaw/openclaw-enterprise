import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import {
  migrateWithHistory as executeMigration,
  UnsupportedPostgresVersionError,
} from "./migration-history.mjs";
import { createPostgresPool } from "../packages/occ/src/state/postgres-pool.ts";
import { createOccLogger, emitOccLogEvent } from "../apps/controller/src/logging.ts";
// Not installation-config.ts: it loads every Driver, and this command runs once per migrated database.
import { loadOperationalLoggingConfiguration } from "../apps/controller/src/composition/startup-file.ts";

// Give the still-JavaScript executor a typed pool at this command's call boundary.
const migrateWithHistory: (
  pool: Pool,
  options?: Parameters<typeof executeMigration>[1],
) => ReturnType<typeof executeMigration> = executeMigration;

const databaseUrl = process.env.OCC_MIGRATION_DATABASE_URL;
let pool: Pool | undefined;
let cancellation: Promise<void> | undefined;
let interrupted = false;
let migrationFinished = false;
let onInterrupt: (() => void) | undefined;
let onTerminate: (() => void) | undefined;
let logger = createOccLogger({ component: "occ-migration", level: "info", destination: "stderr" });

try {
  const [option, ...extra] = process.argv.slice(2);
  const guardedCheck = option === "--check-for-installation";
  const guarded =
    guardedCheck ||
    option === "--apply-for-installation" ||
    option === "--require-current-for-installation";
  const requireCurrent =
    option === "--require-current" || option === "--require-current-for-installation";
  const checkOnly = option === "--check" || guardedCheck || requireCurrent;
  const expectEmpty = option === "--expect-empty";
  if (
    guarded
      ? extra.length !== 1
      : extra.length || (option !== undefined && !checkOnly && !expectEmpty)
  ) {
    throw new Error(
      "The migration command accepts no arguments, --check, --check-for-installation ID, --require-current, --expect-empty, --apply-for-installation ID, or --require-current-for-installation ID.",
    );
  }
  const installationId = guarded ? extra[0] : undefined;
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

  const applicationName = "oce-migration-" + randomUUID();
  parsed.searchParams.set("application_name", applicationName);
  pool = await createPostgresPool(parsed.toString(), { max: 1 });
  // pg-pool removes its idle error listener during checkout. Terminating the
  // backend can both reject a query and emit a separate socket error on the client.
  let connectionFailed = false;
  pool.on("connect", (client) => {
    client.on("error", () => {
      connectionFailed = true;
    });
  });
  const interrupt = (signal: NodeJS.Signals) => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    cancellation = (async () => {
      const control = await createPostgresPool(databaseUrl, {
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      try {
        // PostgreSQL can keep a disconnected backend waiting on an advisory lock.
        // Terminate only this command's uniquely named session and wait for it to exit.
        while (!migrationFinished) {
          await control.query(
            "SELECT pg_catalog.pg_terminate_backend(pid, 5000) FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND usename = current_user AND application_name = $1",
            [applicationName],
          );
          await delay(25);
        }
      } finally {
        await control.end();
      }
    })().catch(() => {
      emitOccLogEvent(logger, { event: "migration.cancellation-failed", code: "MIGRATION_FAILED" });
    });
  };
  onInterrupt = () => interrupt("SIGINT");
  onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let history: Awaited<ReturnType<typeof migrateWithHistory>>;
  try {
    history = await migrateWithHistory(pool, {
      checkOnly,
      expectEmpty,
      requireCurrent,
      installationId,
    });
  } finally {
    migrationFinished = true;
    await cancellation;
  }
  if (interrupted || connectionFailed) {
    throw new Error("Migration interrupted or connection lost.");
  }
  const checkedEvent = guardedCheck ? "migration.checked-for-installation" : "migration.checked";
  const event = checkOnly ? checkedEvent : "migration.completed";
  process.stdout.write(`${JSON.stringify({ event, history })}\n`);
  emitOccLogEvent(logger, { event });
} catch (error) {
  let code = "MIGRATION_FAILED";
  let operatorMessage: string | undefined;
  if (error instanceof UnsupportedPostgresVersionError) {
    code = "MIGRATION_SERVER_UNSUPPORTED";
    operatorMessage = error.message;
  } else if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "MIGRATION_HISTORY_UNSUPPORTED" ||
      error.code === "MIGRATION_HISTORY_NOT_EMPTY" ||
      error.code === "MIGRATION_HISTORY_PENDING" ||
      error.code === "MIGRATION_REGISTRATION_PENDING")
  ) {
    code = error.code;
    operatorMessage = error.message;
  }
  if (operatorMessage !== undefined) {
    process.stderr.write(`${operatorMessage}\n`);
  }
  emitOccLogEvent(logger, {
    event: "migration.failed",
    code,
  });
  if (!interrupted) {
    process.exitCode = 1;
  }
} finally {
  try {
    if (pool !== undefined) {
      await pool.end();
    }
    await cancellation;
  } finally {
    if (onInterrupt) {
      process.removeListener("SIGINT", onInterrupt);
    }
    if (onTerminate) {
      process.removeListener("SIGTERM", onTerminate);
    }
  }
}
