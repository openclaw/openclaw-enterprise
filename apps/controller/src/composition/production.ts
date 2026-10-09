import type { AuditEvent } from "@openclaw-enterprise/contracts";
import {
  validateAuthAccountPrincipalSeed,
  validatePersistedNativeIAMState,
  type AuthPrincipalSeed,
} from "@openclaw-enterprise/iam";
import {
  createPostgresPool,
  OpenClawController,
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "@openclaw-enterprise/occ";
import {
  betterAuthIssuer,
  createPostgresControllerAuth,
  type ClientAddressConfiguration,
  type GitHubLoginConfiguration,
  type GoogleSignInConfiguration,
  type OidcSignInConfiguration,
  type PasswordSlowLaneFloors,
  type PreparedAuthAccount,
} from "../auth/index.ts";
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
import { emitOccLogEvent, skippedUserLogFields, type OccLogger } from "../logging.ts";
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
  readonly github?: GitHubLoginConfiguration;
  readonly google?: GoogleSignInConfiguration;
  readonly oidc?: OidcSignInConfiguration;
  /** OCC_AUTH_PASSWORD_SIGN_IN=recovery-only; requires GitHub, Google or OIDC sign-in. */
  readonly passwordSignIn?: "recovery-only";
  readonly clientAddress?: ClientAddressConfiguration;
  /** Test seam: shortens or observes sign-in pacing; unset in the server (see auth/index.ts). */
  readonly passwordSlowLaneFloors?: PasswordSlowLaneFloors;
  readonly poolMax?: number;
  readonly drivers: InstallationRuntimeDrivers;
  readonly logger?: OccLogger;
  readonly serviceAccountDriverFactory?: ServiceAccountDriverFactory;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly gatewayApiKeyPath?: string;
  readonly channelDirectoryProxyUrl?: string;
  readonly channelDirectoryManagedProxyHost?: string;
  readonly nativeAdmin?: NativeAdminAccessConfig;
  /** Default: enabled. `false` makes both runtime routes answer 501. */
  readonly agentRuntimeLogsEnabled?: boolean;
  /** Receives each composition phase's wall-clock duration, in order, for the startup log. */
  readonly onStartupPhase?: (phase: ProductionStartupPhase, durationMs: number) => void;
}

export type ProductionStartupPhase =
  "database" | "authentication" | "identity" | "computePreflight" | "controller" | "routes";

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
    credentialRefreshDriver,
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
  if (config.github !== undefined && config.nativeAdmin?.enabled === true) {
    throw new Error("GitHub sign-in does not support native administration.");
  }
  if (config.google !== undefined && config.nativeAdmin?.enabled === true) {
    throw new Error("Google sign-in does not support native administration.");
  }
  if (config.oidc !== undefined && config.nativeAdmin?.enabled === true) {
    throw new Error("OIDC sign-in does not support native administration.");
  }

  let phaseStartedAt = performance.now();
  const phaseCompleted = (phase: ProductionStartupPhase) => {
    const now = performance.now();
    config.onStartupPhase?.(phase, Math.round(now - phaseStartedAt));
    phaseStartedAt = now;
  };

  const pool = await createPostgresPool(config.databaseUrl, {
    ...(config.poolMax === undefined ? {} : { max: config.poolMax }),
  });

  try {
    const state = new PostgresPlatformState(pool);
    const persistedInstallation = await state.loadInstallation();
    if (persistedInstallation === undefined) {
      throw new Error("The singleton Installation must be bootstrapped before production startup.");
    }

    const iamState = await state.loadNativeIAMState(persistedInstallation.id);
    validatePersistedNativeIAMState(iamState);
    phaseCompleted("database");
    const iamDriver = createIAMDriver(state);
    const auth = await createPostgresControllerAuth({
      mode: config.mode,
      installationId: persistedInstallation.id,
      secret: config.authSecret,
      baseURL: config.authBaseURL,
      ...(config.nativeAdmin?.enabled === true
        ? { sharedCookieDomain: config.nativeAdmin.sharedCookieDomain }
        : {}),
      pool,
      state,
      iamDriver,
      ...(config.github === undefined ? {} : { github: config.github }),
      ...(config.google === undefined ? {} : { google: config.google }),
      ...(config.oidc === undefined ? {} : { oidc: config.oidc }),
      ...(config.passwordSignIn === undefined ? {} : { passwordSignIn: config.passwordSignIn }),
      ...(config.logger === undefined
        ? {}
        : { onWarning: (warning) => emitOccLogEvent(config.logger!, warning) }),
      ...(config.clientAddress === undefined ? {} : { clientAddress: config.clientAddress }),
      ...(config.passwordSlowLaneFloors === undefined
        ? {}
        : { passwordSlowLaneFloors: config.passwordSlowLaneFloors }),
      ...(config.logger === undefined
        ? {}
        : { onOperationalEvent: (event) => emitOccLogEvent(config.logger!, event) }),
      ...(config.metrics === undefined
        ? {}
        : {
            onUnmatchedCallback: (provider) =>
              config.metrics!.observeUnmatchedSignInCallback(provider),
          }),
    });
    if (config.clientAddress === undefined && config.logger !== undefined) {
      // No trusted proxy: every browser behind the ingress shares its address, so failed
      // password sign-ins are limited per email only, and with external sign-in the start
      // step has no per-client limit (callback and result key on browser cookies).
      emitOccLogEvent(config.logger, {
        event: "authentication.sign-in-limit-warning",
        code: "TRUSTED_PROXY_NOT_CONFIGURED",
      });
    }
    if (auth.activationSkipped !== undefined && config.logger !== undefined) {
      emitOccLogEvent(config.logger, {
        event: "authentication.activation-warning",
        reason: "Accounts without a Principal or exactly one password were not enrolled.",
        ...skippedUserLogFields(auth.activationSkipped),
      });
    }
    if (auth.withoutExternalIdentity !== undefined && config.logger !== undefined) {
      // Recovery-only password sign-in: these accounts cannot sign in until an
      // administrator attaches a GitHub, Google or OIDC identity.
      emitOccLogEvent(config.logger, {
        event: "authentication.password-sign-in-warning",
        code: "EXTERNAL_IDENTITY_MISSING",
        ...skippedUserLogFields(auth.withoutExternalIdentity),
      });
    }
    phaseCompleted("authentication");
    const humanAuthentication = new PostgresHumanAuthentication(
      state,
      persistedInstallation.id,
      betterAuthIssuer(persistedInstallation.id),
    );
    const provisionAuthAccount = async (
      seed: AuthPrincipalSeed,
      auditEvent: AuditEvent,
      prepared: PreparedAuthAccount,
      external?: { readonly providerId: string; readonly subject: string },
    ) => {
      const current = await state.loadNativeIAMState(persistedInstallation.id);
      validateAuthAccountPrincipalSeed(seed, current, persistedInstallation.id);
      // The account, its Principal and bindings, and its enrolment commit together.
      await humanAuthentication.provisionPasswordAccount(prepared, seed, auditEvent, external);
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
    phaseCompleted("identity");

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

    phaseCompleted("computePreflight");
    const controller = new OpenClawController(persistedInstallation, {
      state,
      recordOperations: true,
      backends: installation.backend,
      defaultPresets: config.drivers.defaultPresets ?? [],
      bundledPresetVersions: config.drivers.bundledPresetVersions ?? [],
      refreshBundledDefaultPresets: config.drivers.installation.presets?.includeDefaults === true,
      loggingLevel: config.drivers.installation.logging.level,
      ...(installation.runtime === undefined
        ? {}
        : { nativeWorkerSupport: installation.runtime.nativeWorkerSupport }),
    });
    controller.registerDriver(iamDriver);
    controller.selectDriver("iam", driverId);
    controller.registerDriver(computeDriver);
    controller.selectDriver("compute", computeDriver.id);
    controller.registerDriver(secretDriver);
    controller.selectDriver("secret", secretDriver.id);
    {
      const channelDriver = new SlackChannelDriver(
        globalThis.fetch,
        config.channelDirectoryProxyUrl,
        {
          managedProxyHosts:
            config.channelDirectoryManagedProxyHost === undefined
              ? []
              : [config.channelDirectoryManagedProxyHost],
        },
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
    if (credentialRefreshDriver !== undefined) {
      controller.registerDriver(credentialRefreshDriver);
      controller.selectDriver("credential_refresh", credentialRefreshDriver.id);
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
    if (config.logger !== undefined) {
      for (const shadowed of config.drivers.shadowedDefaultPresets ?? []) {
        emitOccLogEvent(config.logger, { event: "presets.bundled-default-shadowed", ...shadowed });
      }
    }
    await initializeInstallationPresets(
      controller,
      iamDriver,
      iamState.identities,
      config.drivers.defaultPresets ?? [],
      config.logger === undefined
        ? undefined
        : (warning) => emitOccLogEvent(config.logger!, warning),
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

    phaseCompleted("controller");
    const app = createFastifyApp({
      ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
      controller,
      iamDriver,
      computeDriver,
      configurationDriver,
      secretDriver,
      publicOrigin: config.authBaseURL,
      ...(config.nativeAdmin === undefined ? {} : { nativeAdmin: config.nativeAdmin }),
      agentRuntimeLogs: {
        enabled: config.agentRuntimeLogsEnabled !== false,
        cursorSecret: config.authSecret,
      },
      ...(config.nativeAdmin?.enabled === true && config.gatewayApiKeyPath !== undefined
        ? { nativeAdminGatewayApiKey: () => readWorkspaceFilesApiKey(config.gatewayApiKeyPath!) }
        : {}),
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      resolveHarness: resolveApprovedProductionHarness,
      auditSink: state.auditSink,
      backendSummaries: backendSummariesFromDefinitions(installation.backend),
      ...(installation.observability === undefined
        ? {}
        : { observabilityUrl: installation.observability.url }),
      auth,
      ...(config.logger === undefined ? {} : { logger: config.logger }),
      provisionAuthAccount,
      development: {
        enabled: false,
        installationId: persistedInstallation.id,
      },
      ...(config.clientAddress === undefined ? {} : { trustedProxies: config.clientAddress }),
      ...(workspaceFilesAccess === undefined ? {} : { workspaceFilesAccess }),
    });
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async () => {
      await pool.query("SELECT 1");
      return { status: "ready" };
    });
    app.addHook("onClose", async () => state.close());
    phaseCompleted("routes");
    return app;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
