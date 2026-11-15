import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { betterAuthIssuer } from "../apps/controller/src/auth/configuration.ts";
import {
  BootstrapOutputPreflightError,
  bootstrapOutputPath,
  requireAbsentBootstrapOutput,
  writeProtectedBootstrapFile,
  writeProtectedBootstrapJson,
} from "../apps/controller/src/composition/bootstrap-output.ts";
import { createBootstrapAdministratorSeed, NativeIAMDriver } from "../packages/iam/src/index.ts";
import {
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  createPostgresPool,
  OpenClawController,
  PostgresPlatformState,
} from "../packages/occ/src/index.ts";
import { InstallationId, isName, NAME_RULE } from "../packages/contracts/src/index.ts";
import { createOccLogger, emitOccLogEvent } from "../apps/controller/src/logging.ts";
import { loadOperationalLoggingConfiguration } from "../apps/controller/src/composition/startup-file.ts";
import {
  bootstrapConfiguration,
  bootstrapFailureCode,
  optional,
  required,
} from "./lib/bootstrap-configuration.ts";

const DEFAULT_DEV_ADMIN_PASSWORD = "openclaw-development-password";
const DEFAULT_DEV_INSTALLATION_NAME = "OpenClaw Local Development";

class BootstrapVerificationError extends Error {}

function parseCommand(mode, args) {
  if (mode !== "development" && mode !== "production") {
    throw new Error("NODE_ENV must explicitly select development or production mode.");
  }
  if (args.length === 0) {
    return { mode };
  }
  if (
    mode === "production" &&
    args.length === 2 &&
    args[0] === "--verify-existing" &&
    new RegExp(InstallationId.pattern).test(args[1])
  ) {
    return { mode, expectedInstallationId: args[1] };
  }
  throw new BootstrapVerificationError(
    "Usage: node scripts/bootstrap-installation.mjs (production also accepts --verify-existing <incumbent-installation-id>).",
  );
}

// The Installation name skips the API schema, so check its Name rule before anything is created.
function installationName(value, name) {
  if (!isName(value)) {
    throw new Error(`${name} breaks the Name rule: ${NAME_RULE}.`);
  }
  return value;
}

function passwordOutputPath(raw) {
  return bootstrapOutputPath(raw, "OCC_BOOTSTRAP_PASSWORD_FILE");
}

function serviceKeyOutputPath(raw, passwordPath) {
  const path = bootstrapOutputPath(raw, "OCC_BOOTSTRAP_SERVICE_KEY_FILE");
  if (
    passwordPath !== undefined &&
    (path === passwordPath || dirname(path) !== dirname(passwordPath))
  ) {
    throw new Error(
      "OCC_BOOTSTRAP_SERVICE_KEY_FILE must be a distinct sibling of OCC_BOOTSTRAP_PASSWORD_FILE.",
    );
  }
  return path;
}

function randomPassword() {
  return randomBytes(32).toString("base64url");
}

function freshBootstrapConfig(config, environment) {
  if (config.mode === "production") {
    const passwordPath = passwordOutputPath(required(environment, "OCC_BOOTSTRAP_PASSWORD_FILE"));
    return {
      installationName: installationName(
        required(environment, "OCC_BOOTSTRAP_INSTALLATION_NAME"),
        "OCC_BOOTSTRAP_INSTALLATION_NAME",
      ),
      passwordPath,
      serviceKeyPath: serviceKeyOutputPath(
        required(environment, "OCC_BOOTSTRAP_SERVICE_KEY_FILE"),
        passwordPath,
      ),
    };
  }
  return {
    password: optional(environment, "OPENCLAW_DEV_PASSWORD", DEFAULT_DEV_ADMIN_PASSWORD),
    installationName: installationName(
      optional(environment, "OPENCLAW_DEV_INSTALLATION_NAME", DEFAULT_DEV_INSTALLATION_NAME),
      "OPENCLAW_DEV_INSTALLATION_NAME",
    ),
    serviceKeyPath: serviceKeyOutputPath(required(environment, "OCC_BOOTSTRAP_SERVICE_KEY_FILE")),
  };
}

async function createAuth(pool, config, installationId) {
  // Better Auth and Drizzle cost seconds to load, which an already-bootstrapped
  // Installation skips on every upgrade (see verifyExistingAdministrator).
  const { createPostgresControllerAuth } = await import("../apps/controller/src/auth/index.ts");
  return createPostgresControllerAuth({
    mode: config.mode,
    installationId,
    baseURL: config.auth.baseURL,
    agentDomain: config.auth.agentDomain,
    secret: config.auth.secret,
    pool,
  });
}

async function findCredentialUser(controllerAuth, email) {
  const context = await controllerAuth.auth.$context;
  return context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
}

async function createCredentialUser(controllerAuth, email, password) {
  const existing = await findCredentialUser(controllerAuth, email);
  if (existing !== null) {
    throw new Error("The configured bootstrap administrator email already exists.");
  }
  const user = await controllerAuth.createAccount({
    email,
    password,
    name: "OpenClaw Administrator",
  });
  return Object.freeze({ id: user.id, email: user.email, name: user.name });
}

function authorizationFor(controllerAuth, installationId, userId) {
  const seed = createBootstrapAdministratorSeed(installationId, controllerAuth.issuer, {
    id: userId,
  });
  return {
    state: {
      identities: [seed.principal, seed.servicePrincipal],
      groups: [],
      memberships: [],
      roles: seed.roles,
      bindings: seed.bindings,
      restrictions: [],
    },
    servicePrincipal: seed.servicePrincipal,
    principal: seed.principal,
  };
}

function includesPermission(role, action, resourceKind) {
  return role.permissions.some(
    (permission) => permission.action === action && permission.resourceKind === resourceKind,
  );
}

function administratorPrincipal(state, issuer, userId) {
  const principal = state.identities.find(
    (identity) =>
      identity.kind === "principal" && identity.issuer === issuer && identity.subject === userId,
  );
  if (principal === undefined || principal.kind !== "principal") {
    return undefined;
  }
  const administratorRoles = new Set(
    state.roles
      .filter(
        (role) =>
          includesPermission(role, "administer", "installation") &&
          includesPermission(role, "read", "installation"),
      )
      .map((role) => role.id),
  );
  return state.bindings.some(
    (binding) =>
      binding.subjectKind === "identity" &&
      binding.subjectId === principal.id &&
      administratorRoles.has(binding.roleId),
  )
    ? principal
    : undefined;
}

/**
 * Check the stored target, administrator account and IAM binding in one read-only
 * snapshot. The regular bootstrap may fall back to Better Auth on a miss; the
 * verification command must never fall through to initialization or repair.
 */
async function verifyExistingAdministrator(state, expectedId, email) {
  await state.transact(async (unit) => {
    await state.queryInTransaction(
      unit,
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    const installation = await unit.installations.getInstallation();
    if (installation === undefined) {
      throw new BootstrapVerificationError("No existing Installation to verify.");
    }
    if (installation.id !== expectedId) {
      throw new BootstrapVerificationError(
        "The database does not match the expected Installation ID.",
      );
    }
    const { rows } = await state.queryInTransaction(
      unit,
      'SELECT id FROM occ."user" WHERE email = $1',
      [email],
    );
    if (rows.length === 1) {
      const persisted = await state.loadNativeIAMStateInTransaction(unit, expectedId);
      if (
        administratorPrincipal(persisted, betterAuthIssuer(expectedId), rows[0].id) !== undefined
      ) {
        return;
      }
    }
    throw new BootstrapVerificationError(
      "The existing Installation does not contain the configured bootstrap administrator.",
    );
  });
}

/**
 * The initialization Job: create the Installation, or verify the existing one. It reads its
 * settings from `environment` and its arguments from `args`, never from process.env or argv, so
 * tests can call it in process with their own settings. It writes its result line to `stdout`,
 * fixed diagnostics to `stderr` and log events to `logDestination` ("stderr" for the Job), and
 * returns the exit status: 0, or 1 on any failure. A failure's status also goes to `onFailure`
 * before the database pool closes, so the Job keeps its exit status even if closing the pool
 * never settles.
 *
 * Dependencies still read a few process-wide settings themselves, such as OCC_DATABASE_AUTH in
 * the database pool and NODE_ENV in Better Auth's defaults (OCC sets the options that matter).
 */
export async function bootstrapInstallation({
  environment,
  args,
  stdout = process.stdout,
  stderr = process.stderr,
  logDestination = "stderr",
  onFailure = () => {},
}) {
  let bootstrapAttempt;
  let pool;
  let logging;
  let logger = createOccLogger({
    component: "occ-bootstrap",
    level: "info",
    destination: logDestination,
  });
  let status = 0;

  try {
    const { mode, expectedInstallationId } = parseCommand(environment.NODE_ENV, args);
    logging = await loadOperationalLoggingConfiguration({ mode, environment });
    logger = createOccLogger({
      component: "occ-bootstrap",
      level: logging.level,
      destination: logDestination,
    });
    const config = bootstrapConfiguration(mode, environment);
    pool = await createPostgresPool(config.databaseUrl);
    const state = new PostgresPlatformState(pool);
    if (expectedInstallationId !== undefined) {
      await verifyExistingAdministrator(state, expectedInstallationId, config.adminEmail);
      const event = {
        event: "installation.bootstrap-verified",
        installationId: expectedInstallationId,
      };
      stdout.write(`${JSON.stringify(event)}\n`);
      emitOccLogEvent(logger, event);
      return 0;
    }
    const existing = await state.loadInstallation();
    let verified = false;
    if (existing !== undefined) {
      try {
        await verifyExistingAdministrator(state, existing.id, config.adminEmail);
        verified = true;
      } catch {
        // An ordinary rerun retains its existing full Better Auth verification on a miss.
      }
    }
    if (verified) {
      stdout.write(`${JSON.stringify({ event: "installation.already-bootstrapped" })}\n`);
      emitOccLogEvent(logger, {
        event: "installation.already-bootstrapped",
        installationId: existing.id,
        step: "fast-path",
      });
    } else if (existing !== undefined) {
      emitOccLogEvent(logger, { event: "installation.fast-path-skipped" });
      const auth = await createAuth(pool, config, existing.id);
      const user = await findCredentialUser(auth, config.adminEmail);
      if (user === null) {
        throw new Error(
          "The existing Installation does not contain the configured administrator account.",
        );
      }
      const persisted = await state.loadNativeIAMState(existing.id);
      const principal = administratorPrincipal(persisted, auth.issuer, user.user.id);
      if (principal === undefined) {
        throw new Error(
          "The existing Installation does not contain the exact configured administrator Principal.",
        );
      }
      stdout.write(`${JSON.stringify({ event: "installation.already-bootstrapped" })}\n`);
      emitOccLogEvent(logger, {
        event: "installation.already-bootstrapped",
        installationId: existing.id,
      });
    } else {
      const freshConfig = freshBootstrapConfig(config, environment);
      if (freshConfig.passwordPath !== undefined) {
        await requireAbsentBootstrapOutput(freshConfig.passwordPath);
      }
      await requireAbsentBootstrapOutput(freshConfig.serviceKeyPath);
      const password = freshConfig.password ?? randomPassword();
      const installation = {
        id: `ins_${randomUUID()}`,
        name: freshConfig.installationName,
        createdAt: new Date().toISOString(),
      };
      bootstrapAttempt = {
        installationId: installation.id,
        ...(freshConfig.passwordPath === undefined
          ? {}
          : { passwordFile: freshConfig.passwordPath }),
        serviceKeyFile: freshConfig.serviceKeyPath,
      };
      const auth = await createAuth(pool, config, installation.id);
      const user = await createCredentialUser(auth, config.adminEmail, password);
      bootstrapAttempt = { ...bootstrapAttempt, authAccountId: user.id };
      const authorization = authorizationFor(auth, installation.id, user.id);
      bootstrapAttempt = {
        ...bootstrapAttempt,
        principalId: authorization.principal.id,
        servicePrincipalId: authorization.servicePrincipal.id,
      };
      const serviceKey = await auth.createServiceKey({
        principal: authorization.servicePrincipal,
        name: "bootstrap-admin",
      });
      bootstrapAttempt = {
        ...bootstrapAttempt,
        serviceKeyId: serviceKey.id,
        serviceKeyExpiresAt: serviceKey.expiresAt,
      };
      if (freshConfig.passwordPath !== undefined) {
        await writeProtectedBootstrapFile(freshConfig.passwordPath, `${password}\n`);
      }
      await writeProtectedBootstrapJson(freshConfig.serviceKeyPath, {
        data: serviceKey,
        meta: { installationId: installation.id },
      });
      state.setBootstrapNativeIAM(authorization.state);
      const controller = new OpenClawController(installation, {
        state,
        recordOperations: true,
        loggingLevel: logging.level,
      });
      const iam = new NativeIAMDriver(state, { id: "native-iam", implementation: "native" });
      controller.registerDriver(iam);
      controller.selectDriver("iam", iam.id);
      await controller.transact(async (unit) => {
        const defaultNamespace = await controller.createNamespace(authorization.principal.id, {
          name: BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
        });
        await unit.audit.append({
          id: `aud_${randomUUID()}`,
          installationId: installation.id,
          occurredAt: new Date().toISOString(),
          kind: "bootstrap",
          actorId: authorization.principal.id,
          source: "occ",
          action: "administer",
          resource: { kind: "installation", id: installation.id },
          outcome: "success",
          details: {
            kind: "bootstrap",
            source:
              config.mode === "production"
                ? "production-installation-job"
                : "development-installation-job",
            servicePrincipalId: authorization.servicePrincipal.id,
            serviceKeyId: serviceKey.id,
            defaultNamespaceId: defaultNamespace.id,
          },
        });
      });
      stdout.write(
        `${JSON.stringify({ event: "installation.bootstrapped", ...bootstrapAttempt })}\n`,
      );
      emitOccLogEvent(logger, {
        event: "installation.bootstrapped",
        installationId: installation.id,
      });
    }
  } catch (error) {
    const preflightFailure = error instanceof BootstrapOutputPreflightError;
    if (preflightFailure || error instanceof BootstrapVerificationError) {
      // This message is fixed; filesystem causes may contain private paths.
      stderr.write(`${error.message}\n`);
    }
    emitOccLogEvent(logger, {
      event: "installation.bootstrap-failed",
      code: preflightFailure ? error.code : bootstrapFailureCode(error),
      attempt: bootstrapAttempt,
    });
    status = 1;
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
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    // No argv[1], or not a file (node --eval with arguments): this module was imported.
    return false;
  }
}
if (import.meta.main ?? startedAsEntryPoint()) {
  await bootstrapInstallation({
    environment: process.env,
    args: process.argv.slice(2),
    onFailure: (status) => {
      process.exitCode = status;
    },
  });
}
