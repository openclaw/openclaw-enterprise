import type { AuditEventFactory } from "@openclaw-enterprise/audit";
import type {
  AuditEvent,
  ComputeDriver,
  ConfigurationDriver,
} from "@openclaw-enterprise/contracts";
import {
  NativeIAMDriver,
  validateAuthAccountPrincipalSeed,
  validatePersistedNativeIAMState,
  type AuthPrincipalSeed,
} from "@openclaw-enterprise/iam";
import {
  createPostgresPool,
  OpenClawController,
  PostgresPlatformState,
} from "@openclaw-enterprise/occ";
import { createPostgresControllerAuth } from "../auth/index.ts";
import { createDockerDevelopmentComputeDriverFromEnv } from "../drivers/compute/docker/index.ts";
import { createFilesystemDevelopmentConfigurationDriverFromEnv } from "../drivers/configuration/filesystem/index.ts";
import { createFastifyApp } from "../index.ts";
import type {
  InstallationRuntimeDrivers,
  ServiceAccountDriverFactory,
} from "./installation-config.ts";
import { providerSummariesFromDefinitions } from "./installation-config.ts";
import type { LoggingConfiguration, OccLogger } from "../logging.ts";
import { resolveApprovedHarness } from "./production-harness.ts";
import type { ControllerWorkspaceFilesAccess } from "../gateway/contracts.ts";
import { createWorkspaceFilesAccess, validateWorkspaceFilesApiKeyPath } from "./workspace-files.ts";

export interface PostgresDevelopmentConfig {
  readonly mode: "development";
  readonly host: "127.0.0.1" | "::1" | "0.0.0.0";
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly authBaseURL: string;
  readonly poolMax?: number;
  readonly logger?: OccLogger;
  readonly logging?: LoggingConfiguration;
  readonly trustedDevelopmentBridgeCidr?: string;
  readonly trustedDevelopmentForwarderCidr?: string;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly gatewayApiKeyPath?: string;
}

export type PostgresDevelopmentRuntimeOptions =
  | InstallationRuntimeDrivers
  | {
      readonly computeDriver?: ComputeDriver;
      readonly configurationDriver?: ConfigurationDriver;
      readonly auditEventFactory?: AuditEventFactory;
    };

export function createDevelopmentDockerComputeDriver(
  environment: NodeJS.ProcessEnv = process.env,
): ComputeDriver {
  return createDockerDevelopmentComputeDriverFromEnv(environment);
}

export async function composePostgresDevelopment(
  config: PostgresDevelopmentConfig,
  options: PostgresDevelopmentRuntimeOptions = {},
  serviceAccountDriverFactory?: ServiceAccountDriverFactory,
) {
  const drivers = "installation" in options ? options : undefined;
  const auditEventFactory = "auditEventFactory" in options ? options.auditEventFactory : undefined;
  const driverId = drivers?.installation.drivers.iam.id ?? "native-iam";
  const serviceAccountSelection = drivers?.installation.drivers.service_account;
  if ((serviceAccountSelection === undefined) !== (serviceAccountDriverFactory === undefined)) {
    throw new Error(
      "The selected ServiceAccount Driver requires API-only PostgreSQL initialization.",
    );
  }

  const pool = await createPostgresPool(config.databaseUrl, {
    ...(config.poolMax === undefined ? {} : { max: config.poolMax }),
  });
  let poolClosed = false;

  try {
    const state = new PostgresPlatformState(pool);
    const persistedInstallation = await state.loadInstallation();
    if (persistedInstallation === undefined) {
      throw new Error("The platform Installation must be bootstrapped before development startup.");
    }
    const installationId = persistedInstallation.id;
    const auth = await createPostgresControllerAuth({
      mode: config.mode,
      installationId,
      secret: config.authSecret,
      baseURL: config.authBaseURL,
      pool,
      secureCookies: false,
    });
    const computeDriver = options.computeDriver ?? createDevelopmentDockerComputeDriver();
    const sandboxDriver = drivers?.sandboxDriver;
    const configurationDriver =
      options.configurationDriver ??
      ("installation" in options
        ? options.configurationDriver
        : createFilesystemDevelopmentConfigurationDriverFromEnv());
    const iamState = await state.loadNativeIAMState(installationId);

    validatePersistedNativeIAMState(iamState);
    const iamDriver =
      drivers === undefined
        ? new NativeIAMDriver(state, { id: driverId, implementation: "native" })
        : drivers.createIAMDriver(state);

    const bootstrapPrincipal = iamState.identities.find(
      (identity) => identity.kind === "principal",
    );
    if (bootstrapPrincipal === undefined || bootstrapPrincipal.kind !== "principal") {
      throw new Error("The configured development administrator is absent from native IAM policy.");
    }
    const principal = await iamDriver.lookupIdentity({
      issuer: bootstrapPrincipal.issuer,
      subject: bootstrapPrincipal.subject,
    });
    if (!principal || principal.kind !== "principal" || principal.id !== bootstrapPrincipal.id) {
      throw new Error("The configured development Principal is absent from persisted IAM policy.");
    }
    const provisionAuthAccount = async (seed: AuthPrincipalSeed, auditEvent: AuditEvent) => {
      const current = await state.loadNativeIAMState(installationId);
      validateAuthAccountPrincipalSeed(seed, current, installationId);
      await state.appendNativeIAMPrincipal(seed, auditEvent);
    };

    const loggingLevel = config.logging?.level ?? drivers?.installation.logging.level;
    const controller = new OpenClawController(persistedInstallation, {
      state,
      recordOperations: true,
      ...(loggingLevel === undefined ? {} : { loggingLevel }),
      ...(drivers === undefined ? {} : { providers: drivers.installation.provider }),
    });
    controller.registerDriver(iamDriver);
    const selected = controller.selectDriver("iam", driverId);
    if (selected !== iamDriver || selected.capability !== "iam" || selected.id !== driverId) {
      throw new Error("The server-owned IAM Driver was not selected correctly.");
    }
    controller.registerDriver(computeDriver);
    controller.selectDriver("compute", computeDriver.id);
    if (sandboxDriver !== undefined) {
      controller.registerDriver(sandboxDriver);
      if (controller.selectDriver("sandbox", sandboxDriver.id) !== sandboxDriver) {
        throw new Error("The configured Sandbox Driver was not selected correctly.");
      }
    }
    if (configurationDriver !== undefined) {
      controller.registerDriver(configurationDriver);
      if (
        controller.selectDriver("configuration", configurationDriver.id) !== configurationDriver
      ) {
        throw new Error("The selected Configuration Driver was not selected correctly.");
      }
    }
    if (drivers?.secretDriver !== undefined) {
      controller.registerDriver(drivers.secretDriver);
      if (controller.selectDriver("secret", drivers.secretDriver.id) !== drivers.secretDriver) {
        throw new Error("The selected Secret Driver was not selected correctly.");
      }
    }
    if (drivers?.pluginDriver !== undefined) {
      controller.registerDriver(drivers.pluginDriver);
      if (controller.selectDriver("plugin", drivers.pluginDriver.id) !== drivers.pluginDriver) {
        throw new Error("The configured Plugin Driver was not selected correctly.");
      }
    }
    serviceAccountDriverFactory?.(controller, state);
    await controller.validateProviderConfiguration();

    let workspaceFilesAccess = config.workspaceFilesAccess;
    if (workspaceFilesAccess === undefined && config.gatewayApiKeyPath !== undefined) {
      const gatewayApiKeyPath = config.gatewayApiKeyPath;
      await validateWorkspaceFilesApiKeyPath(gatewayApiKeyPath);
      workspaceFilesAccess = createWorkspaceFilesAccess(computeDriver, gatewayApiKeyPath);
    }

    const app = createFastifyApp({
      controller,
      iamDriver,
      computeDriver,
      publicOrigin: config.authBaseURL,
      ...(configurationDriver === undefined ? {} : { configurationDriver }),
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      resolveHarness: resolveApprovedHarness,
      auditSink: state.auditSink,
      ...(drivers === undefined
        ? {}
        : { providerSummaries: providerSummariesFromDefinitions(drivers.installation.provider) }),
      auth,
      ...(config.logger === undefined ? {} : { logger: config.logger }),
      provisionAuthAccount,
      ...(auditEventFactory === undefined ? {} : { auditEventFactory }),
      development: {
        enabled: true,
        installationId,
        ...(config.trustedDevelopmentBridgeCidr === undefined
          ? {}
          : {
              trustedCidrs: [
                config.trustedDevelopmentBridgeCidr,
                ...(config.trustedDevelopmentForwarderCidr === undefined
                  ? []
                  : [config.trustedDevelopmentForwarderCidr]),
              ],
            }),
      },
      maxBodyBytes: 64 * 1024,
      ...(workspaceFilesAccess === undefined ? {} : { workspaceFilesAccess }),
    });
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async () => {
      await pool.query("SELECT 1");
      return { status: "ready" };
    });
    app.addHook("onClose", async () => {
      poolClosed = true;
      await state.close();
    });
    return app;
  } catch (error) {
    if (!poolClosed) {
      await pool.end();
    }
    throw error;
  }
}
