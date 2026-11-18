import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
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
import { subjectPattern } from "../apps/controller/src/auth/id-token.ts";
import { oidcProviderId, validOidcIssuer } from "../apps/controller/src/auth/oidc.ts";

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

const MAX_MAPPING_BYTES = 256 * 1024;
const MAX_ENTRIES = 500;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(message: string): never {
  throw new HumanAuthenticationMaintenanceRefusedError("OIDC_MAPPING_INVALID", message);
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("The OIDC mapping has an invalid object.");
  }
  const record = Object.fromEntries(Object.entries(value));
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key))
  ) {
    invalid("The OIDC mapping has missing or unsupported fields.");
  }
  return record;
}

function parseMappingJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // JSON.parse validates syntax but discards earlier member values. Scan strings
  // and object boundaries so an escaped spelling cannot hide a repeated name.
  const objects: Set<string>[] = [];
  for (const [token, key] of text.matchAll(
    /("(?:[^"\\]|\\.)*")[ \t\r\n]*:|"(?:[^"\\]|\\.)*"|[{}]/gu,
  )) {
    if (token === "{") {
      objects.push(new Set());
    } else if (token === "}") {
      objects.pop();
    } else if (key !== undefined) {
      const name: string = JSON.parse(key);
      const members = objects.at(-1);
      if (members?.has(name)) {
        invalid("The OIDC mapping contains a repeated JSON field.");
      }
      members?.add(name);
    }
  }
  return value;
}

async function readMapping(path: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_MAPPING_BYTES) {
        invalid("Use a private regular mapping file of at most 256 KiB.");
      }
      const buffer = Buffer.alloc(MAX_MAPPING_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) {
          break;
        }
        length += bytesRead;
      }
      if (length > MAX_MAPPING_BYTES) {
        invalid("The mapping file exceeds 256 KiB.");
      }
      return parseMappingJson(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
      );
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof HumanAuthenticationMaintenanceRefusedError) {
      throw error;
    }
    invalid("The private mapping file could not be read as UTF-8 JSON.");
  }
}

async function loadOidcLinkMapping(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const { operationId, installationId, sourceProviderId, oidcIssuer, oidcClientId, entries } =
    exactObject(await readMapping(path), [
      "operationId",
      "installationId",
      "sourceProviderId",
      "oidcIssuer",
      "oidcClientId",
      "entries",
    ]);
  if (
    typeof operationId !== "string" ||
    !UUID_V4.test(operationId) ||
    typeof installationId !== "string" ||
    !installationId.startsWith("ins_") ||
    !UUID_V4.test(installationId.slice(4)) ||
    typeof sourceProviderId !== "string" ||
    typeof oidcIssuer !== "string" ||
    oidcIssuer.includes("\0") ||
    !validOidcIssuer(oidcIssuer) ||
    typeof oidcClientId !== "string" ||
    oidcClientId.length === 0 ||
    oidcClientId.includes("\0")
  ) {
    invalid("The mapping has an invalid operation, Installation, or provider identity.");
  }
  if (
    oidcIssuer !== environment.OCC_AUTH_OIDC_ISSUER?.trim() ||
    oidcClientId !== environment.OCC_AUTH_OIDC_CLIENT_ID?.trim()
  ) {
    invalid(
      "The mapping issuer and client must match OCC_AUTH_OIDC_ISSUER and OCC_AUTH_OIDC_CLIENT_ID.",
    );
  }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ENTRIES) {
    invalid("The mapping must contain between 1 and 500 entries.");
  }
  const links = entries.map((entry: unknown) => {
    const {
      sourceSubject,
      oidcIssuer: issuer,
      oidcSubject,
      expectedVersion,
    } = exactObject(entry, ["sourceSubject", "oidcIssuer", "oidcSubject", "expectedVersion"]);
    if (
      typeof sourceSubject !== "string" ||
      issuer !== oidcIssuer ||
      typeof oidcSubject !== "string" ||
      !subjectPattern.test(oidcSubject) ||
      typeof expectedVersion !== "number" ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1 ||
      expectedVersion >= 2_147_483_647
    ) {
      invalid(
        "A mapping entry has an invalid source subject, OIDC issuer or subject, or account version.",
      );
    }
    return { sourceSubject, oidcSubject, expectedVersion };
  });
  const oidcId = oidcProviderId({ issuer: oidcIssuer, clientId: oidcClientId });
  return {
    operationId,
    installationId,
    sourceProviderId,
    oidcProviderId: oidcId,
    entries: links,
  };
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
  environment: AuthMaintainOptions["environment"],
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
    case "link-oidc":
      return maintenance.linkOidc(await loadOidcLinkMapping(options.mappingFile, environment), {
        dryRun: !options.mutating,
      });
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
    const result = await run(options, maintenance, state, installation.id, stderr, environment);
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

if (import.meta.main) {
  await authMaintain({
    environment: process.env,
    args: process.argv.slice(2),
    onFailure: (status) => {
      process.exitCode = status;
    },
  });
}
