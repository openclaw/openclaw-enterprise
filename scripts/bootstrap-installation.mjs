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
import { isName, NAME_RULE } from "../packages/contracts/src/index.ts";
import { createOccLogger, emitOccLogEvent } from "../apps/controller/src/logging.ts";
import { loadOperationalLoggingConfiguration } from "../apps/controller/src/composition/installation-config.ts";
import {
  bootstrapConfiguration,
  bootstrapFailureCode,
  optional,
  required,
} from "./lib/bootstrap-configuration.mjs";

const DEFAULT_DEV_ADMIN_PASSWORD = "openclaw-development-password";
const DEFAULT_DEV_INSTALLATION_NAME = "OpenClaw Local Development";

function parseMode(mode, args) {
  if (args.length !== 0) {
    throw new Error(
      "Usage: NODE_ENV=development|production node scripts/bootstrap-installation.mjs",
    );
  }
  if (mode !== "development" && mode !== "production") {
    throw new Error("NODE_ENV must explicitly select development or production mode.");
  }
  return mode;
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
  // Installation skips on every upgrade (see verifiedWithoutAuth).
  const { createPostgresControllerAuth } = await import("../apps/controller/src/auth/index.ts");
  return createPostgresControllerAuth({
    mode: config.mode,
    installationId,
    baseURL: config.auth.baseURL,
    secret: config.auth.secret,
    pool,
    secureCookies: config.mode === "production" && !config.auth.baseURL.startsWith("http://"),
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
 * The existing-Installation verification below, without loading Better Auth: the
 * configured administrator's user row (Better Auth stores and looks up the email
 * lowercased, as `adminEmail` already is) and its administrator Principal in the same
 * parsed IAM state. True only when every check passes. Any miss or error returns
 * false, and the full verification then runs and reports exactly as before.
 */
async function verifiedWithoutAuth(pool, state, installation, email) {
  try {
    const users = await pool.query('SELECT id FROM occ."user" WHERE email = $1', [email]);
    if (users.rows.length !== 1) {
      return false;
    }
    const persisted = await state.loadNativeIAMState(installation.id);
    return (
      administratorPrincipal(persisted, betterAuthIssuer(installation.id), users.rows[0].id) !==
      undefined
    );
  } catch {
    // The full verification reproduces and reports the error.
    return false;
  }
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
    const mode = parseMode(environment.NODE_ENV, args);
    logging = await loadOperationalLoggingConfiguration({ mode, environment });
    logger = createOccLogger({
      component: "occ-bootstrap",
      level: logging.level,
      destination: logDestination,
    });
    const config = bootstrapConfiguration(mode, environment);
    pool = await createPostgresPool(config.databaseUrl);
    const state = new PostgresPlatformState(pool);
    const existing = await state.loadInstallation();
    if (
      existing !== undefined &&
      (await verifiedWithoutAuth(pool, state, existing, config.adminEmail))
    ) {
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
    if (preflightFailure) {
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
