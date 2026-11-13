import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthMaintainRunner,
  logsFailedCommands,
  rejectsUndeclaredCommands,
  requiresWritersStopped,
} from "./auth-maintain-command-cases.ts";
import { runAuthMaintenanceLifecycle } from "./auth-maintain-lifecycle-case.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const migrationUrl = process.env.OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL;
const runner = createAuthMaintainRunner(migrationUrl);

test(
  "auth:maintain requires an explicit writers-stopped claim for every change",
  requiresWritersStopped,
);
test("auth:maintain rejects undeclared commands before configuration", () =>
  rejectsUndeclaredCommands(runner));
test("a failed auth:maintain run logs its command", () => logsFailedCommands(runner));
test(
  "stopped maintenance activates, repairs, resets, purges and returns to the legacy profile",
  {
    skip:
      databaseUrl && migrationUrl
        ? false
        : "Set OCC_TEST_DATABASE_URL and OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL for the same fresh database.",
  },
  (context) => {
    assert.ok(databaseUrl && migrationUrl);
    return runAuthMaintenanceLifecycle(context, databaseUrl, runner);
  },
);
