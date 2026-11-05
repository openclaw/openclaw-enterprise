import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NativeIAMDriver } from "../packages/iam/src/index.ts";
import {
  createPostgresPool,
  HumanAuthenticationMaintenanceRefusedError,
  PostgresHumanAuthentication,
  PostgresHumanAuthenticationMaintenance,
  PostgresPlatformState,
  ScopeViolationError,
  WritersNotStoppedError,
} from "../packages/occ/src/index.ts";
import {
  activateRecoveryAccount,
  betterAuthIssuer,
  hashLocalPassword,
} from "../apps/controller/src/auth/index.ts";
import {
  type OccLogDestination,
  createOccLogger,
  emitOccLogEvent,
} from "../apps/controller/src/logging.ts";
import { loadOperationalLoggingConfiguration } from "../apps/controller/src/composition/installation-config.ts";
import {
  AuthMaintainUsageError,
  parseAuthMaintainArguments,
  type AuthMaintainArguments,
} from "./lib/auth-maintain-arguments.ts";

const EXIT_FAILED = 1;
const EXIT_WRITERS_RUNNING = 2;
const EXIT_REFUSED = 3;
const EXIT_USAGE = 64;
const NATIVE_IAM_DRIVER = { id: "native-iam", implementation: "native" };

function outputLine(event: string, fields: object = {}) {
  return `${JSON.stringify({ event, ...fields })}\n`;
}

async function readPassword(path: string) {
  const contents = await readFile(path, "utf8");
  // Secret files conventionally end with one newline; it is not part of the password.
  return contents.replace(/\r?\n$/, "");
}

type OutputDestination = Pick<NodeJS.WritableStream, "write">;

interface AuthMaintainOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly args: readonly string[];
  readonly stdout?: OutputDestination;
  readonly stderr?: OutputDestination;
  readonly logDestination?: OccLogDestination;
  readonly onFailure?: (status: number) => void;
}

async function run(
  options: AuthMaintainArguments,
  maintenance: PostgresHumanAuthenticationMaintenance,
  state: PostgresPlatformState,
  installationId: string,
  stderr: OutputDestination,
) {
  const issuer = betterAuthIssuer(installationId);
  switch (options.command) {
    case "status":
      return maintenance.status();
    case "activate": {
      // Fail fast before waiting on the activation lock; the hooks repeat the check
      // after the lock and again before commit, and audit the designation.
      await maintenance.requireWritersStopped();
      // Controller startup only activates with the bundled native IAM Driver, whose
      // decisions carry its own id; the documented recovery authority is native IAM.
      const iamDriver = new NativeIAMDriver(state, NATIVE_IAM_DRIVER);
      let activation;
      try {
        activation = await activateRecoveryAccount(
          new PostgresHumanAuthentication(state, installationId, issuer),
          iamDriver,
          installationId,
          options.recoveryUserId,
          maintenance.activationHooks(),
        );
      } catch (error) {
        if (error instanceof ScopeViolationError) {
          throw new HumanAuthenticationMaintenanceRefusedError("ACTIVATION_REFUSED", error.message);
        }
        throw error;
      }
      if (activation.seedIgnored) {
        // Like startup: an existing designation (possibly moved online) is kept, not replaced.
        stderr.write(
          "--recovery-user differs from the recorded recovery designation, which is kept.\n",
        );
      }
      const status = await maintenance.status();
      return {
        ...(activation.seedIgnored ? { seedIgnored: true } : {}),
        designation: status.designation,
        enrolled: status.enrolled,
        unenrolled: status.unenrolled,
      };
    }
    case "enrol":
      return maintenance.enrol(options.userId);
    case "reset-recovery-password":
      return maintenance.resetRecoveryPassword(
        await hashLocalPassword(await readPassword(options.passwordFile)),
      );
    case "purge-sessions":
      return maintenance.purgeSessions(options.userId);
    case "deactivate":
      return maintenance.deactivate({ purgeDisabled: options.purgeDisabled === true });
  }
}

/**
 * `pnpm auth:maintain`: run one maintenance command against a stopped Installation. It reads
 * its settings from `environment` and its command from `args`, never from process.env or argv,
 * so tests can call it in process with their own settings. It writes its result line to
 * `stdout`, messages to `stderr` and log events to `logDestination` ("stderr" for the command),
 * and returns the exit status: 0, 1 (failed), 2 (writers running), 3 (refused) or 64 (usage).
 * A failure's status also goes to `onFailure` before the database pool closes, so the command
 * keeps its exit status even if closing the pool never settles.
 *
 * Dependencies still read a few process-wide settings themselves, such as OCC_DATABASE_AUTH in
 * the database pool.
 */
export async function authMaintain({
  environment,
  args,
  stdout = process.stdout,
  stderr = process.stderr,
  logDestination = "stderr",
  onFailure = () => {},
}: AuthMaintainOptions) {
  const output = (event: string, fields: object) => stdout.write(outputLine(event, fields));
  let pool: Awaited<ReturnType<typeof createPostgresPool>> | undefined;
  let options: AuthMaintainArguments | undefined;
  let logger = createOccLogger({
    component: "occ-auth-maintain",
    level: "info",
    destination: logDestination,
  });
  let status = 0;

  try {
    options = parseAuthMaintainArguments(args);
    const logging = await loadOperationalLoggingConfiguration({
      mode: environment.NODE_ENV === "development" ? "development" : "production",
      environment,
    });
    logger = createOccLogger({
      component: "occ-auth-maintain",
      level: logging.level,
      destination: logDestination,
    });
    const databaseUrl = environment.OCC_MIGRATION_DATABASE_URL;
    if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
      throw new Error("OCC_MIGRATION_DATABASE_URL must contain the dedicated migrator credential.");
    }
    // One connection: every check and change runs on the backend excluded from the writer scan.
    pool = await createPostgresPool(databaseUrl, { max: 1 });
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    if (installation === undefined) {
      throw new Error("The database has no Installation.");
    }
    const maintenance = new PostgresHumanAuthenticationMaintenance(
      state,
      installation.id,
      betterAuthIssuer(installation.id),
    );
    await maintenance.assertSchemaOwner();
    const result = await run(options, maintenance, state, installation.id, stderr);
    output(`auth-maintain.${options.command}`, result);
    emitOccLogEvent(logger, {
      event: `auth-maintain.${options.command}`,
      installationId: installation.id,
    });
  } catch (error) {
    if (error instanceof AuthMaintainUsageError) {
      stderr.write(`${error.message}\n`);
      status = EXIT_USAGE;
    } else if (error instanceof WritersNotStoppedError) {
      output("auth-maintain.writers-running", { backends: error.backends });
      stderr.write(`${error.message}\n`);
      status = EXIT_WRITERS_RUNNING;
    } else if (error instanceof HumanAuthenticationMaintenanceRefusedError) {
      output("auth-maintain.refused", { reason: error.reason, ...error.details });
      stderr.write(`${error.message}\n`);
      status = EXIT_REFUSED;
    } else {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      emitOccLogEvent(logger, {
        event: "auth-maintain.failed",
        code: "AUTH_MAINTENANCE_FAILED",
        ...(options === undefined ? {} : { command: options.command }),
      });
      status = EXIT_FAILED;
    }
    onFailure(status);
  } finally {
    await pool?.end();
  }
  return status;
}

// Run the command only when this file is the entry point, not when a test imports it.
// Node before 24.2 lacks import.meta.main; its entry URL is the realpath of argv[1].
function startedAsEntryPoint() {
  try {
    const entry = process.argv[1];
    if (entry === undefined) {
      return false;
    }
    const path = realpathSync(entry);
    return (
      path === fileURLToPath(import.meta.url) ||
      path === fileURLToPath(new URL("./auth-maintain.mjs", import.meta.url))
    );
  } catch {
    // No argv[1], or not a file (node --eval with arguments): this module was imported.
    return false;
  }
}
if (import.meta.main || startedAsEntryPoint()) {
  await authMaintain({
    environment: process.env,
    args: process.argv.slice(2),
    onFailure: (status) => {
      process.exitCode = status;
    },
  });
}
