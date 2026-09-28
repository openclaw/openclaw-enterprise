import type { AuditEvent, ComputeDriver } from "@openclaw-enterprise/contracts";
import {
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
import { createFastifyApp } from "../index.ts";
import { SlackChannelDriver } from "../drivers/channel/slack.ts";
import type {
  InstallationRuntimeDrivers,
  ServiceAccountDriverFactory,
} from "./installation-config.ts";
import {
  initializeInstallationPresets,
  backendSummariesFromDefinitions,
} from "./installation-config.ts";
import { emitOccLogEvent, type OccLogger } from "../logging.ts";
import { resolveApprovedProductionHarness } from "./production-harness.ts";
import type { ControllerWorkspaceFilesAccess } from "../gateway/contracts.ts";
import type { NativeAdminAccessConfig } from "../gateway/native-admin.ts";
import {
  createWorkspaceFilesAccess,
  readWorkspaceFilesApiKey,
  validateWorkspaceFilesApiKeyPath,
} from "./workspace-files.ts";

export interface ProductionConfig {
  readonly metrics?: import("../metrics/index.ts").OccMetrics;
  readonly mode: "production";
  readonly host: string;
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly authBaseURL: string;
  readonly poolMax?: number;
  readonly drivers: InstallationRuntimeDrivers;
  readonly logger?: OccLogger;
  readonly serviceAccountDriverFactory?: ServiceAccountDriverFactory;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly gatewayApiKeyPath?: string;
  readonly channelDirectoryProxyUrl?: string;
  readonly nativeAdmin?: NativeAdminAccessConfig;
}

export async function composeProduction(config: ProductionConfig) {
  if (config.mode !== "production") {
    throw new Error("Production OCC composition requires explicit production mode.");
  }
  const {
    installation,
    computeDriver,
    configurationDriver,
    secretDriver,
    sandboxDriver,
    credentialGatewayDriver,
    pluginDriver,
    repoDriver,
    createIAMDriver,
  } = config.drivers;
  if (
    (installation.drivers.service_account === undefined) !==
    (config.serviceAccountDriverFactory === undefined)
  ) {
    throw new Error(
      "The selected ServiceAccount Driver requires API-only PostgreSQL initialization.",
    );
  }

  const driverId = installation.drivers.iam.id;
  const pool = await createPostgresPool(config.databaseUrl, {
    ...(config.poolMax === undefined ? {} : { max: config.poolMax }),
  });

  try {
    const state = new PostgresPlatformState(pool);
    const persistedInstallation = await state.loadInstallation();
    if (persistedInstallation === undefined) {
      throw new Error("The singleton Installation must be bootstrapped before production startup.");
    }
    const auth = await createPostgresControllerAuth({
      mode: config.mode,
      installationId: persistedInstallation.id,
      secret: config.authSecret,
      baseURL: config.authBaseURL,
      ...(config.nativeAdmin?.enabled === true
        ? { sharedCookieDomain: config.nativeAdmin.sharedCookieDomain }
        : {}),
      pool,
    });

    const iamState = await state.loadNativeIAMState(persistedInstallation.id);
    validatePersistedNativeIAMState(iamState);
    const iamDriver = createIAMDriver(state);
    const provisionAuthAccount = async (seed: AuthPrincipalSeed, auditEvent: AuditEvent) => {
      const current = await state.loadNativeIAMState(persistedInstallation.id);
      validateAuthAccountPrincipalSeed(seed, current, persistedInstallation.id);
      await state.appendNativeIAMPrincipal(seed, auditEvent);
    };

    const principal = iamState.identities.find((identity) => identity.kind === "principal");
    if (
      principal === undefined ||
      principal.kind !== "principal" ||
      principal.issuer.trim().length === 0 ||
      principal.subject.trim().length === 0
    ) {
      throw new Error("Production startup requires at least one persisted IAM Principal.");
    }

    const resolved = await iamDriver.lookupIdentity({
      issuer: principal.issuer,
      subject: principal.subject,
    });
    if (!resolved || resolved.kind !== "principal" || resolved.id !== principal.id) {
      throw new Error("The persisted IAM Principal cannot be resolved uniquely.");
    }

    const preflight = computeDriver.preflight;
    if (preflight !== undefined && typeof preflight !== "function") {
      throw new Error("The selected Compute Driver exposes an invalid production preflight.");
    }
    if (
      config.drivers.installation.drivers.compute.package === undefined &&
      preflight === undefined
    ) {
      throw new Error("The bundled Kubernetes Compute Driver requires production preflight.");
    }
    if (preflight !== undefined) {
      const result = await preflight.call(computeDriver);
      if (result !== undefined && config.logger !== undefined) {
        for (const warning of result.warnings) {
          emitOccLogEvent(config.logger, {
            event: "compute.preflight-warning",
            computeDriverId: computeDriver.id,
            ...warning,
          });
        }
      }
    }

    const controller = new OpenClawController(persistedInstallation, {
      state,
      recordOperations: true,
      backends: installation.backend,
      defaultPresets: config.drivers.defaultPresets ?? [],
      loggingLevel: config.drivers.installation.logging.level,
    });
    controller.registerDriver(iamDriver);
    controller.selectDriver("iam", driverId);
    controller.registerDriver(computeDriver);
    controller.selectDriver("compute", computeDriver.id);
    controller.registerDriver(secretDriver);
    controller.selectDriver("secret", secretDriver.id);
    if (config.channelDirectoryProxyUrl !== undefined) {
      const channelDriver = new SlackChannelDriver(
        globalThis.fetch,
        config.channelDirectoryProxyUrl,
      );
      controller.registerDriver(channelDriver);
      controller.selectDriver("channel", channelDriver.id);
    }
    if (sandboxDriver !== undefined) {
      controller.registerDriver(sandboxDriver);
      controller.selectDriver("sandbox", sandboxDriver.id);
    }
    if (credentialGatewayDriver !== undefined) {
      controller.registerDriver(credentialGatewayDriver);
      controller.selectDriver("credential_gateway", credentialGatewayDriver.id);
    }
    controller.registerDriver(configurationDriver);
    controller.selectDriver("configuration", configurationDriver.id);
    config.serviceAccountDriverFactory?.(controller, state);
    if (pluginDriver !== undefined) {
      controller.registerDriver(pluginDriver);
      controller.selectDriver("plugin", pluginDriver.id);
    }
    if (repoDriver !== undefined) {
      controller.registerDriver(repoDriver);
      controller.selectDriver("repo", repoDriver.id);
    }
    await controller.validateBackendConfiguration();
    await initializeInstallationPresets(
      controller,
      iamDriver,
      iamState.identities,
      config.drivers.defaultPresets ?? [],
    );

    let workspaceFilesAccess = config.workspaceFilesAccess;
    if (workspaceFilesAccess === undefined && config.gatewayApiKeyPath !== undefined) {
      const gatewayApiKeyPath = config.gatewayApiKeyPath;
      await validateWorkspaceFilesApiKeyPath(gatewayApiKeyPath);
      workspaceFilesAccess = createWorkspaceFilesAccess(computeDriver, gatewayApiKeyPath);
    }
    if (config.nativeAdmin?.enabled === true && config.gatewayApiKeyPath === undefined) {
      throw new Error("Native admin UI access requires OCC_GATEWAY_API_KEY_PATH.");
    }

    const app = createFastifyApp({
      ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
      controller,
      iamDriver,
      computeDriver,
      configurationDriver,
      secretDriver,
      publicOrigin: config.authBaseURL,
      ...(config.nativeAdmin === undefined ? {} : { nativeAdmin: config.nativeAdmin }),
      ...(config.nativeAdmin?.enabled === true && config.gatewayApiKeyPath !== undefined
        ? { nativeAdminGatewayApiKey: () => readWorkspaceFilesApiKey(config.gatewayApiKeyPath!) }
        : {}),
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      resolveHarness: resolveApprovedProductionHarness,
      auditSink: state.auditSink,
      backendSummaries: backendSummariesFromDefinitions(installation.backend),
      auth,
      ...(config.logger === undefined ? {} : { logger: config.logger }),
      provisionAuthAccount,
      development: {
        enabled: false,
        installationId: persistedInstallation.id,
      },
      maxBodyBytes: 64 * 1024,
      ...(workspaceFilesAccess === undefined ? {} : { workspaceFilesAccess }),
    });
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async () => {
      await pool.query("SELECT 1");
      return { status: "ready" };
    });
    app.addHook("onClose", async () => state.close());
    return app;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
