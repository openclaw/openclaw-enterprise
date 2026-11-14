import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { ControllerAuth, ServiceKey } from "../apps/controller/src/auth/index.ts";
import { betterAuthIssuer } from "../apps/controller/src/auth/configuration.ts";
import {
  BootstrapOutputPreflightError,
  bootstrapOutputPath,
  requireAbsentBootstrapOutput,
  writeProtectedBootstrapFile,
  writeProtectedBootstrapJson,
} from "../apps/controller/src/composition/bootstrap-output.ts";
import {
  createBootstrapAdministratorSeed,
  NativeIAMDriver,
  type NativeIAMState,
} from "../packages/iam/src/index.ts";
import {
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  createPostgresPool,
  OpenClawController,
  PostgresPlatformState,
} from "../packages/occ/src/index.ts";
import {
  InstallationId,
  isName,
  NAME_RULE,
  type PermissionAction,
  type Principal,
  type ResourceKind,
  type Role,
  type ServicePrincipal,
} from "../packages/contracts/src/index.ts";
import {
  createOccLogger,
  emitOccLogEvent,
  type OccLogDestination,
} from "../apps/controller/src/logging.ts";
import { loadOperationalLoggingConfiguration } from "../apps/controller/src/composition/startup-file.ts";
import {
  bootstrapConfiguration,
  bootstrapFailureCode,
  optional,
  required,
} from "./lib/bootstrap-configuration.ts";

const DEFAULT_DEV_ADMIN_PASSWORD = "openclaw-development-password";
const DEFAULT_DEV_INSTALLATION_NAME = "OpenClaw Local Development";

type BootstrapConfiguration = ReturnType<typeof bootstrapConfiguration>;
type BootstrapEnvironment = Parameters<typeof bootstrapConfiguration>[1];
type BootstrapPool = Awaited<ReturnType<typeof createPostgresPool>>;

type BootstrapCommand =
  | { readonly kind: "initialize"; readonly mode: BootstrapConfiguration["mode"] }
  | {
      readonly kind: "verify-existing";
      readonly mode: "production";
      readonly expectedInstallationId: InstallationId;
    };

type FreshBootstrapConfiguration = {
  readonly installationName: string;
  readonly serviceKeyPath: string;
} & (
  | { readonly mode: "production"; readonly passwordPath: string }
  | { readonly mode: "development"; readonly password: string }
);

interface BootstrapAttempt {
  readonly installationId: InstallationId;
  readonly passwordFile?: string;
  readonly serviceKeyFile: string;
  readonly authAccountId?: string;
  readonly principalId?: Principal["id"];
  readonly servicePrincipalId?: ServiceKey["servicePrincipalId"];
  readonly serviceKeyId?: ServiceKey["id"];
  readonly serviceKeyExpiresAt?: ServiceKey["expiresAt"];
}

interface TextSink {
  write(text: string): void;
}

interface BootstrapInstallationOptions {
  readonly environment: BootstrapEnvironment;
  readonly args: readonly string[];
  readonly stdout?: TextSink;
  readonly stderr?: TextSink;
  readonly logDestination?: OccLogDestination;
  readonly onFailure?: (status: 1) => void;
}

class BootstrapVerificationError extends Error {}

function parseCommand(mode: string | undefined, args: readonly string[]): BootstrapCommand {
  if (mode !== "development" && mode !== "production") {
    throw new Error("NODE_ENV must explicitly select development or production mode.");
  }
  if (args.length === 0) {
    return { kind: "initialize", mode };
  }
  const [flag, expectedInstallationId] = args;
  if (
    mode === "production" &&
    args.length === 2 &&
    flag === "--verify-existing" &&
    expectedInstallationId !== undefined &&
    "pattern" in InstallationId &&
    typeof InstallationId.pattern === "string" &&
    new RegExp(InstallationId.pattern).test(expectedInstallationId)
  ) {
    return { kind: "verify-existing", mode, expectedInstallationId };
  }
  throw new BootstrapVerificationError(
    "Usage: node scripts/bootstrap-installation.ts (production also accepts --verify-existing <incumbent-installation-id>).",
  );
}

// The Installation name skips the API schema, so check its Name rule before anything is created.
function installationName(value: string, name: string): string {
  if (!isName(value)) {
    throw new Error(`${name} breaks the Name rule: ${NAME_RULE}.`);
  }
  return value;
}

function serviceKeyOutputPath(raw: string, passwordPath?: string): string {
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

function freshBootstrapConfig(
  config: BootstrapConfiguration,
  environment: BootstrapEnvironment,
): FreshBootstrapConfiguration {
  if (config.mode === "production") {
    const passwordPath = bootstrapOutputPath(
      required(environment, "OCC_BOOTSTRAP_PASSWORD_FILE"),
      "OCC_BOOTSTRAP_PASSWORD_FILE",
    );
    return {
      mode: config.mode,
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
    mode: config.mode,
    password: optional(environment, "OPENCLAW_DEV_PASSWORD", DEFAULT_DEV_ADMIN_PASSWORD),
    installationName: installationName(
      optional(environment, "OPENCLAW_DEV_INSTALLATION_NAME", DEFAULT_DEV_INSTALLATION_NAME),
      "OPENCLAW_DEV_INSTALLATION_NAME",
    ),
    serviceKeyPath: serviceKeyOutputPath(required(environment, "OCC_BOOTSTRAP_SERVICE_KEY_FILE")),
  };
}

async function createAuth(
  pool: BootstrapPool,
  config: BootstrapConfiguration,
  installationId: InstallationId,
): Promise<ControllerAuth> {
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

async function findCredentialUser(controllerAuth: ControllerAuth, email: string) {
  const context = await controllerAuth.auth.$context;
  return context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
}

async function createCredentialUser(
  controllerAuth: ControllerAuth,
  email: string,
  password: string,
) {
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

function authorizationFor(
  controllerAuth: ControllerAuth,
  installationId: InstallationId,
  userId: string,
): { state: NativeIAMState; servicePrincipal: ServicePrincipal; principal: Principal } {
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

function includesPermission(role: Role, action: PermissionAction, resourceKind: ResourceKind) {
  return role.permissions.some(
    (permission) => permission.action === action && permission.resourceKind === resourceKind,
  );
}

function administratorPrincipal(
  state: NativeIAMState,
  issuer: string,
  userId: string,
): Principal | undefined {
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
async function verifyExistingAdministrator(
  state: PostgresPlatformState,
  expectedId: InstallationId,
  email: string,
): Promise<void> {
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
    const [user] = rows;
    if (
      rows.length === 1 &&
      typeof user === "object" &&
      user !== null &&
      "id" in user &&
      typeof user.id === "string"
    ) {
      const persisted = await state.loadNativeIAMStateInTransaction(unit, expectedId);
      if (administratorPrincipal(persisted, betterAuthIssuer(expectedId), user.id) !== undefined) {
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
}: BootstrapInstallationOptions): Promise<0 | 1> {
  let bootstrapAttempt: BootstrapAttempt | undefined;
  let pool: BootstrapPool | undefined;
  let logger = createOccLogger({
    component: "occ-bootstrap",
    level: "info",
    destination: logDestination,
  });
  let status: 0 | 1 = 0;

  try {
    const command = parseCommand(environment.NODE_ENV, args);
    const { mode } = command;
    const logging = await loadOperationalLoggingConfiguration({ mode, environment });
    logger = createOccLogger({
      component: "occ-bootstrap",
      level: logging.level,
      destination: logDestination,
    });
    const config = bootstrapConfiguration(mode, environment);
    pool = await createPostgresPool(config.databaseUrl);
    const state = new PostgresPlatformState(pool);
    if (command.kind === "verify-existing") {
      const { expectedInstallationId } = command;
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
    if (existing !== undefined) {
      let step: "fast-path" | undefined;
      try {
        await verifyExistingAdministrator(state, existing.id, config.adminEmail);
        step = "fast-path";
      } catch {
        // An ordinary rerun retains its existing full Better Auth verification on a miss.
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
      }
      stdout.write(`${JSON.stringify({ event: "installation.already-bootstrapped" })}\n`);
      emitOccLogEvent(logger, {
        event: "installation.already-bootstrapped",
        installationId: existing.id,
        ...(step === undefined ? {} : { step }),
      });
    } else {
      const freshConfig = freshBootstrapConfig(config, environment);
      if (freshConfig.mode === "production") {
        await requireAbsentBootstrapOutput(freshConfig.passwordPath);
      }
      await requireAbsentBootstrapOutput(freshConfig.serviceKeyPath);
      const password = freshConfig.mode === "production" ? randomPassword() : freshConfig.password;
      const installation = {
        id: `ins_${randomUUID()}`,
        name: freshConfig.installationName,
        createdAt: new Date().toISOString(),
      };
      bootstrapAttempt = {
        installationId: installation.id,
        ...(freshConfig.mode === "production" ? { passwordFile: freshConfig.passwordPath } : {}),
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
      if (freshConfig.mode === "production") {
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

if (import.meta.main) {
  await bootstrapInstallation({
    environment: process.env,
    args: process.argv.slice(2),
    onFailure: (status) => {
      process.exitCode = status;
    },
  });
}
