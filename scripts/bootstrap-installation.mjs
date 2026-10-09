import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  betterAuthIssuer,
  refuseRewrittenIpv4AuthHost,
  validHttpBaseURL,
} from "../apps/controller/src/auth/configuration.ts";
import {
  bootstrapOutputPath,
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

const DEFAULT_BETTER_AUTH_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_DEV_ADMIN_EMAIL = "admin@openclaw.local";
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

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

// The Installation name skips the API schema, so check its Name rule before anything is created.
function installationName(value, name) {
  if (!isName(value)) {
    throw new Error(`${name} breaks the Name rule: ${NAME_RULE}.`);
  }
  return value;
}

function normalizeEmail(raw, name) {
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`${name} must contain a valid administrator email.`);
  }
  return email;
}

function authBaseURL(raw, mode) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OCC_AUTH_BASE_URL must contain an absolute URL.");
  }
  // Before the loopback exception: Node rewrites 127.1, 0177.0.0.1 and
  // 192.168.010.001, and the rewritten host must not become the published origin.
  refuseRewrittenIpv4AuthHost(raw, parsed);
  if (
    mode === "production" &&
    parsed.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("OCC_AUTH_BASE_URL must be HTTPS except for loopback development tests.");
  }
  if (
    mode === "development" &&
    ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname))
  ) {
    throw new Error("Development OCC_AUTH_BASE_URL must identify a loopback HTTP(S) URL.");
  }
  const baseURL = parsed.toString().replace(/\/$/, "");
  // The auth stack rejects the same values; check here so the already-bootstrapped path,
  // which never loads it, still fails the Job on them.
  if (!validHttpBaseURL(baseURL)) {
    throw new Error("OCC_AUTH_BASE_URL must be an absolute HTTP origin URL.");
  }
  return baseURL;
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

function bootstrapFailureCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (/installation[ _]name breaks the Name rule/i.test(message)) {
    return "INSTALLATION_NAME_INVALID";
  }
  if (/OCC_AUTH_SECRET/.test(message)) {
    return "AUTH_SECRET_INVALID";
  }
  if (/OCC_AUTH_BASE_URL|loopback host|loopback HTTP\(S\) URL/.test(message)) {
    return "AUTH_BASE_URL_INVALID";
  }
  if (/OCC_DATABASE_URL|PostgreSQL database|PostgreSQL connection URL/.test(message)) {
    return "DATABASE_CONFIGURATION_INVALID";
  }
  if (/commit outcome is unknown/i.test(message)) {
    return "COMMIT_OUTCOME_UNKNOWN";
  }
  if (/platform persistence repository|ECONNREFUSED|ECONNRESET|connect /i.test(message)) {
    return "PERSISTENCE_UNAVAILABLE";
  }
  return "BOOTSTRAP_FAILED";
}

function modeConfig(mode) {
  const authConfig = {
    secret: optional(
      "OCC_AUTH_SECRET",
      mode === "development" ? "openclaw-development-auth-secret-minimum-32-bytes" : undefined,
    ),
    baseURL: authBaseURL(
      optional(
        "OCC_AUTH_BASE_URL",
        mode === "development" ? DEFAULT_BETTER_AUTH_BASE_URL : undefined,
      ),
      mode,
    ),
  };
  if (authConfig.secret.length < 32) {
    throw new Error("OCC_AUTH_SECRET must be at least 32 characters.");
  }

  if (mode === "production") {
    return {
      mode,
      databaseUrl: required("OCC_DATABASE_URL"),
      auth: authConfig,
      adminEmail: normalizeEmail(
        required("OCC_BOOTSTRAP_ADMIN_EMAIL"),
        "OCC_BOOTSTRAP_ADMIN_EMAIL",
      ),
    };
  }

  return {
    mode,
    databaseUrl: required("OCC_DATABASE_URL"),
    auth: authConfig,
    adminEmail: normalizeEmail(
      optional("OPENCLAW_DEV_EMAIL", DEFAULT_DEV_ADMIN_EMAIL),
      "OPENCLAW_DEV_EMAIL",
    ),
  };
}

function freshBootstrapConfig(config) {
  if (config.mode === "production") {
    const passwordPath = passwordOutputPath(required("OCC_BOOTSTRAP_PASSWORD_FILE"));
    return {
      password: randomPassword(),
      installationName: installationName(
        required("OCC_BOOTSTRAP_INSTALLATION_NAME"),
        "OCC_BOOTSTRAP_INSTALLATION_NAME",
      ),
      passwordPath,
      serviceKeyPath: serviceKeyOutputPath(
        required("OCC_BOOTSTRAP_SERVICE_KEY_FILE"),
        passwordPath,
      ),
    };
  }
  return {
    password: optional("OPENCLAW_DEV_PASSWORD", DEFAULT_DEV_ADMIN_PASSWORD),
    installationName: installationName(
      optional("OPENCLAW_DEV_INSTALLATION_NAME", DEFAULT_DEV_INSTALLATION_NAME),
      "OPENCLAW_DEV_INSTALLATION_NAME",
    ),
    serviceKeyPath: serviceKeyOutputPath(required("OCC_BOOTSTRAP_SERVICE_KEY_FILE")),
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

let bootstrapAttempt;
let pool;
let logging;
let logger = createOccLogger({ component: "occ-bootstrap", level: "info", destination: "stderr" });

try {
  const mode = parseMode(process.env.NODE_ENV, process.argv.slice(2));
  logging = await loadOperationalLoggingConfiguration({ mode });
  logger = createOccLogger({
    component: "occ-bootstrap",
    level: logging.level,
    destination: "stderr",
  });
  const config = modeConfig(mode);
  pool = await createPostgresPool(config.databaseUrl);
  const state = new PostgresPlatformState(pool);
  const existing = await state.loadInstallation();
  if (
    existing !== undefined &&
    (await verifiedWithoutAuth(pool, state, existing, config.adminEmail))
  ) {
    process.stdout.write(`${JSON.stringify({ event: "installation.already-bootstrapped" })}\n`);
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
    process.stdout.write(`${JSON.stringify({ event: "installation.already-bootstrapped" })}\n`);
    emitOccLogEvent(logger, {
      event: "installation.already-bootstrapped",
      installationId: existing.id,
    });
  } else {
    const freshConfig = freshBootstrapConfig(config);
    const installation = {
      id: `ins_${randomUUID()}`,
      name: freshConfig.installationName,
      createdAt: new Date().toISOString(),
    };
    bootstrapAttempt = {
      installationId: installation.id,
      ...(freshConfig.passwordPath === undefined ? {} : { passwordFile: freshConfig.passwordPath }),
      serviceKeyFile: freshConfig.serviceKeyPath,
    };
    const auth = await createAuth(pool, config, installation.id);
    const user = await createCredentialUser(auth, config.adminEmail, freshConfig.password);
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
      await writeProtectedBootstrapFile(freshConfig.passwordPath, `${freshConfig.password}\n`);
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
    process.stdout.write(
      `${JSON.stringify({ event: "installation.bootstrapped", ...bootstrapAttempt })}\n`,
    );
    emitOccLogEvent(logger, {
      event: "installation.bootstrapped",
      installationId: installation.id,
    });
  }
} catch (error) {
  emitOccLogEvent(logger, {
    event: "installation.bootstrap-failed",
    code: bootstrapFailureCode(error),
    attempt: bootstrapAttempt,
  });
  process.exitCode = 1;
} finally {
  await pool?.end();
}
