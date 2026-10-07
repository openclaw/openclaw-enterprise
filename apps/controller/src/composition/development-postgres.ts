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
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "@openclaw-enterprise/occ";
import {
  betterAuthIssuer,
  createPostgresControllerAuth,
  type CliSessionSettings,
  type GitHubLoginConfiguration,
  type GoogleSignInConfiguration,
  type OidcSignInConfiguration,
  type PreparedAuthAccount,
} from "../auth/index.ts";
import { createDockerDevelopmentComputeDriverFromEnv } from "../drivers/compute/docker/index.ts";
import { createFilesystemDevelopmentConfigurationDriverFromEnv } from "../drivers/configuration/filesystem/index.ts";
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
import {
  emitOccLogEvent,
  skippedUserLogFields,
  type LoggingConfiguration,
  type OccLogger,
} from "../logging.ts";
import { resolveApprovedHarness } from "./production-harness.ts";
import type { ControllerWorkspaceFilesAccess } from "../gateway/contracts.ts";
import type { NativeAdminAccessConfig } from "../gateway/native-admin.ts";
import {
  createWorkspaceFilesAccess,
  readWorkspaceFilesApiKey,
  validateWorkspaceFilesApiKeyPath,
} from "./workspace-files.ts";

export interface PostgresDevelopmentConfig {
  readonly metrics?: import("../metrics/index.ts").OccMetrics;
  readonly mode: "development";
  readonly host: "127.0.0.1" | "::1" | "0.0.0.0";
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly authBaseURL: string;
  readonly github?: GitHubLoginConfiguration;
  readonly google?: GoogleSignInConfiguration;
  readonly oidc?: OidcSignInConfiguration;
  /** OCC_AUTH_PASSWORD_SIGN_IN=recovery-only; requires GitHub, Google or OIDC sign-in. */
  readonly passwordSignIn?: "recovery-only";
  /** `auth.cliSessions` (OCC_AUTH_CLI_SESSIONS*); RFC-0019 `occ login`. Default: enabled. */
  readonly cliSessions?: CliSessionSettings;
  readonly poolMax?: number;
  readonly logger?: OccLogger;
  readonly logging?: LoggingConfiguration;
  readonly observabilityUrl?: string;
  readonly trustedDevelopmentBridgeCidr?: string;
  readonly trustedDevelopmentForwarderCidr?: string;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly gatewayApiKeyPath?: string;
  readonly nativeAdmin?: NativeAdminAccessConfig;
  /** Default: enabled. `false` makes both runtime routes answer 501. */
  readonly agentRuntimeLogsEnabled?: boolean;
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

  if (config.github !== undefined && config.nativeAdmin?.enabled === true) {
    throw new Error("GitHub sign-in does not support native administration.");
  }
  if (config.google !== undefined && config.nativeAdmin?.enabled === true) {
    throw new Error("Google sign-in does not support native administration.");
  }
  if (config.oidc !== undefined && config.nativeAdmin?.enabled === true) {
    throw new Error("OIDC sign-in does not support native administration.");
  }

  const pool = await createPostgresPool(config.databaseUrl, {
    ...(config.poolMax === undefined ? {} : { max: config.poolMax }),
  });

  try {
    const state = new PostgresPlatformState(pool);
    const persistedInstallation = await state.loadInstallation();
    if (persistedInstallation === undefined) {
      throw new Error("The platform Installation must be bootstrapped before development startup.");
    }
    const installationId = persistedInstallation.id;

    const computeDriver = options.computeDriver ?? createDevelopmentDockerComputeDriver();
    if (drivers !== undefined && computeDriver.preflight !== undefined) {
      const result = await computeDriver.preflight();
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
    const sandboxDriver = drivers?.sandboxDriver;
    const credentialGatewayDriver = drivers?.credentialGatewayDriver;
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
    const auth = await createPostgresControllerAuth({
      mode: config.mode,
      installationId,
      secret: config.authSecret,
      baseURL: config.authBaseURL,
      pool,
      state,
      iamDriver,
      ...(config.github === undefined ? {} : { github: config.github }),
      ...(config.google === undefined ? {} : { google: config.google }),
      ...(config.oidc === undefined ? {} : { oidc: config.oidc }),
      ...(config.passwordSignIn === undefined ? {} : { passwordSignIn: config.passwordSignIn }),
      ...(config.cliSessions === undefined ? {} : { cliSessionSettings: config.cliSessions }),
      ...(config.logger === undefined
        ? {}
        : {
            onWarning: (warning) => emitOccLogEvent(config.logger!, warning),
            onOperationalEvent: (event) => emitOccLogEvent(config.logger!, event),
          }),
      ...(config.metrics === undefined
        ? {}
        : {
            onUnmatchedCallback: (provider) =>
              config.metrics!.observeUnmatchedSignInCallback(provider),
          }),
      secureCookies: config.nativeAdmin?.enabled === true,
      ...(config.nativeAdmin?.enabled === true
        ? { sharedCookieDomain: config.nativeAdmin.sharedCookieDomain }
        : {}),
    });

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
    const humanAuthentication = new PostgresHumanAuthentication(
      state,
      installationId,
      betterAuthIssuer(installationId),
    );
    const provisionAuthAccount = async (
      seed: AuthPrincipalSeed,
      auditEvent: AuditEvent,
      prepared: PreparedAuthAccount,
      external?: { readonly providerId: string; readonly subject: string },
    ) => {
      const current = await state.loadNativeIAMState(installationId);
      validateAuthAccountPrincipalSeed(seed, current, installationId);
      // The account, its Principal and bindings, and its enrolment commit together.
      await humanAuthentication.provisionPasswordAccount(prepared, seed, auditEvent, external);
    };

    const loggingLevel = config.logging?.level ?? drivers?.installation.logging.level;
    const controller = new OpenClawController(persistedInstallation, {
      state,
      recordOperations: true,
      defaultPresets: drivers?.defaultPresets ?? [],
      bundledPresetVersions: drivers?.bundledPresetVersions ?? [],
      refreshBundledDefaultPresets: drivers?.installation.presets?.includeDefaults === true,
      ...(loggingLevel === undefined ? {} : { loggingLevel }),
      ...(drivers === undefined ? {} : { backends: drivers.installation.backend }),
      ...(drivers?.installation.runtime === undefined
        ? {}
        : { nativeWorkerSupport: drivers.installation.runtime.nativeWorkerSupport }),
    });
    controller.registerDriver(iamDriver);
    controller.selectDriver("iam", driverId);
    controller.registerDriver(computeDriver);
    controller.selectDriver("compute", computeDriver.id);
    const channelDriver = new SlackChannelDriver();
    controller.registerDriver(channelDriver);
    controller.selectDriver("channel", channelDriver.id);
    if (sandboxDriver !== undefined) {
      controller.registerDriver(sandboxDriver);
      controller.selectDriver("sandbox", sandboxDriver.id);
    }
    if (credentialGatewayDriver !== undefined) {
      controller.registerDriver(credentialGatewayDriver);
      controller.selectDriver("credential_gateway", credentialGatewayDriver.id);
    }
    if (configurationDriver !== undefined) {
      controller.registerDriver(configurationDriver);
      controller.selectDriver("configuration", configurationDriver.id);
    }
    if (drivers?.secretDriver !== undefined) {
      controller.registerDriver(drivers.secretDriver);
      controller.selectDriver("secret", drivers.secretDriver.id);
    }
    if (drivers?.pluginDriver !== undefined) {
      controller.registerDriver(drivers.pluginDriver);
      controller.selectDriver("plugin", drivers.pluginDriver.id);
    }
    if (drivers?.repoDriver !== undefined) {
      const driver = drivers.repoDriver;
      controller.registerDriver(driver);
      controller.selectDriver("repo", driver.id);
    }
    serviceAccountDriverFactory?.(controller, state);
    await controller.validateBackendConfiguration();
    if (config.logger !== undefined) {
      for (const shadowed of drivers?.shadowedDefaultPresets ?? []) {
        emitOccLogEvent(config.logger, { event: "presets.bundled-default-shadowed", ...shadowed });
      }
    }
    await initializeInstallationPresets(
      controller,
      iamDriver,
      iamState.identities,
      drivers?.defaultPresets ?? [],
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

    const observabilityUrl = config.observabilityUrl ?? drivers?.installation.observability?.url;
    const app = createFastifyApp({
      ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
      controller,
      iamDriver,
      computeDriver,
      publicOrigin: config.authBaseURL,
      ...(config.nativeAdmin === undefined ? {} : { nativeAdmin: config.nativeAdmin }),
      agentRuntimeLogs: {
        enabled: config.agentRuntimeLogsEnabled !== false,
        cursorSecret: config.authSecret,
      },
      ...(config.nativeAdmin?.enabled === true && config.gatewayApiKeyPath !== undefined
        ? { nativeAdminGatewayApiKey: () => readWorkspaceFilesApiKey(config.gatewayApiKeyPath!) }
        : {}),
      ...(configurationDriver === undefined ? {} : { configurationDriver }),
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      resolveHarness: resolveApprovedHarness,
      auditSink: state.auditSink,
      ...(drivers === undefined
        ? {}
        : { backendSummaries: backendSummariesFromDefinitions(drivers.installation.backend) }),
      ...(observabilityUrl === undefined ? {} : { observabilityUrl }),
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
      await state.close();
    });
    return app;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
