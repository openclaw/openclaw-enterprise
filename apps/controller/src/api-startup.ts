import type { ChatGPTBackendDefinition, ComputeDriver } from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";
import {
  DEVELOPMENT_BROWSER_ORIGIN_RULE,
  isDevelopmentBrowserOrigin,
  validateAuthSecret,
  refuseRewrittenIpv4Host,
  refuseWrittenUserinfo,
} from "./auth/configuration.ts";
import {
  clientAddressConfiguration,
  deriveSharedCookieDomain,
  humanLoginConfiguration,
  type HumanLoginConfiguration,
} from "./auth/index.ts";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { ConsoleThemeError, loadConsoleTheme } from "./composition/console-theme.ts";
import { controlPlaneAuditEnabled } from "./composition/control-plane-audit.ts";
import {
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot,
  type ServiceAccountDriverFactory,
} from "./composition/installation-config.ts";
import { PresetFileError } from "./composition/installation-presets.ts";
import type { PostgresDevelopmentConfig } from "./composition/development-postgres.ts";
import {
  composeProduction,
  type ProductionConfig,
  type ProductionStartupPhase,
} from "./composition/production.ts";
import {
  validateGatewayApiKeyPath,
  validateWorkspaceFilesApiKeyPath,
} from "./composition/workspace-files.ts";
import type { NativeAdminAccessConfig } from "./gateway/native-admin.ts";
import { createOccLogger, emitOccLogEvent } from "./logging.ts";
import { createOccMetrics } from "./metrics/index.ts";
import {
  startupDependencyFailure,
  startupConfigurationFailure,
  startupListenerFailure,
  installationSettingFailureCode,
} from "./startup-failure.ts";
import { metricsConfiguration, startMetricsListener } from "./metrics/listener.ts";

type ApiEnvironment = Readonly<NodeJS.ProcessEnv>;

type SharedApiSettings = HumanLoginConfiguration & {
  readonly port: number;
  readonly databaseUrl?: string;
  readonly poolMax?: number;
  readonly gatewayApiKeyPath?: string;
  readonly authSecret: string;
  readonly authBaseURL: string;
  readonly nativeAdmin: NativeAdminAccessConfig;
  readonly agentRuntimeLogsEnabled: boolean;
  readonly controlPlaneAuditEnabled: boolean;
};

type ApiSettings = SharedApiSettings &
  (
    | Pick<
        ProductionConfig,
        | "mode"
        | "host"
        | "clientAddress"
        | "channelDirectoryProxyUrl"
        | "channelDirectoryManagedProxyHost"
        | "apiHttpsEgressOpen"
      >
    | Pick<
        PostgresDevelopmentConfig,
        "mode" | "host" | "trustedDevelopmentBridgeCidr" | "trustedDevelopmentForwarderCidr"
      >
  );

type MeasuredStartupPhase =
  "modules" | "configuration" | "composition" | "ready" | "listen" | ProductionStartupPhase;

type ServiceAccountCompute = Parameters<
  typeof import("./drivers/service-account/chatgpt.ts").createChatGPTServiceAccountDriverFactory
>[1];

function supportsServiceAccountCredentials(
  compute: ComputeDriver & {
    readonly storeServiceAccountCredential?: unknown;
    readonly findServiceAccountCredential?: unknown;
  },
): compute is ComputeDriver & ServiceAccountCompute {
  return (
    typeof compute.storeServiceAccountCredential === "function" &&
    typeof compute.findServiceAccountCredential === "function" &&
    typeof compute.deleteServiceAccountCredential === "function"
  );
}

function startupFailureCode(error: unknown): string {
  if (error instanceof ConsoleThemeError) {
    return "CONSOLE_THEME_INVALID";
  }
  if (error instanceof PresetFileError) {
    return "PRESET_FILE_INVALID";
  }
  const message = error instanceof Error ? error.message : "";
  if (/stored Installation name breaks the Name rule/.test(message)) {
    return "INSTALLATION_NAME_INVALID";
  }
  if (/OCC_AUTH_SECRET/.test(message)) {
    return "AUTH_SECRET_INVALID";
  }
  if (
    /OCC_AUTH_BASE_URL|OCC_AUTH_COOKIE_DOMAIN|OCC_DEVELOPMENT_AUTH_COOKIE_DOMAIN|OCC_AGENT_NATIVE_ADMIN_DOMAIN|Shared session cookies|Console and Agent hostnames|loopback host|loopback HTTP\(S\) URL/.test(
      message,
    )
  ) {
    return "AUTH_BASE_URL_INVALID";
  }
  if (/OCC_WORKSPACE_FILES_CONFIG_PATH.*removed/.test(message)) {
    return "WORKSPACE_FILES_CONFIG_REMOVED";
  }
  if (/OCC_GATEWAY_API_KEY_PATH|gateway API key file/i.test(message)) {
    return "GATEWAY_API_KEY_UNAVAILABLE";
  }
  // Production composition refuses the combination before any database work; the auth
  // composer's host-only cookie check is the backstop.
  if (
    /sign-in (does not support|supports host-only cookies without shared) native admin/.test(
      message,
    )
  ) {
    return "EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED";
  }
  if (/OCC_AGENT_NATIVE_ADMIN|Native admin UI access|Native admin Agent domain/.test(message)) {
    return "AGENT_NATIVE_ADMIN_INVALID";
  }
  if (/ChatGPT admin-key Secret/.test(message)) {
    return "CHATGPT_ADMIN_KEY_UNAVAILABLE";
  }
  if (/Slack directory proxy/i.test(message)) {
    return "CHANNEL_DIRECTORY_PROXY_INVALID";
  }
  const settingCode = installationSettingFailureCode(message);
  if (settingCode !== undefined) {
    return settingCode;
  }
  if (/ServiceAccounts require PostgreSQL persistence/.test(message)) {
    return "SERVICE_ACCOUNT_REQUIRES_POSTGRES";
  }
  if (/OCC_DATABASE_URL|PostgreSQL connection URL/.test(message)) {
    return "DATABASE_CONFIGURATION_INVALID";
  }
  if (/platform persistence repository|ECONNREFUSED|ECONNRESET|connect /i.test(message)) {
    return "PERSISTENCE_UNAVAILABLE";
  }
  return "STARTUP_FAILED";
}

/** The log fields that name a startup failure: its `code`, and for some causes, more. */
export function startupFailureFields(error: unknown) {
  if (
    error instanceof ScopeViolationError &&
    error.message === "Enrollment requires an existing Installation Role."
  ) {
    return {
      code: "OIDC_ENROLLMENT_ROLE_INVALID",
      reason:
        "Set auth.oidc.enrollment.createAccount.role.id to an Installation-scoped Role from the Installation iam configuration.",
    };
  }
  return (
    startupDependencyFailure(error) ??
    startupConfigurationFailure(error) ??
    startupListenerFailure(error) ?? { code: startupFailureCode(error) }
  );
}

function stringEnvironment(env: ApiEnvironment, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function optionalBooleanEnvironment(env: ApiEnvironment, name: string): boolean {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    return false;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function configuration(env: ApiEnvironment): ApiSettings {
  const mode = env.NODE_ENV;
  if (mode !== "development" && mode !== "production") {
    throw new Error("NODE_ENV must explicitly select development or production mode.");
  }

  const host = stringEnvironment(env, "OCC_HOST");
  const trustedDevelopmentBridgeCidr = env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR;
  const trustedDevelopmentForwarderCidr = env.OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR;
  let listener:
    Pick<ProductionConfig, "mode" | "host"> | Pick<PostgresDevelopmentConfig, "mode" | "host">;
  if (mode === "development") {
    if (
      (host !== "127.0.0.1" && host !== "::1" && host !== "0.0.0.0") ||
      (host === "0.0.0.0" &&
        (trustedDevelopmentBridgeCidr === undefined ||
          trustedDevelopmentBridgeCidr.trim().length === 0))
    ) {
      throw new Error(
        "Development OCC_HOST must be 127.0.0.1 or ::1, or 0.0.0.0 with OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR.",
      );
    }
    listener = { mode, host };
  } else {
    if (
      isIP(host) === 0 ||
      host === "0.0.0.0" ||
      host === "::" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^::ffff:127\./i.test(host)
    ) {
      throw new Error("Production OCC_HOST must identify one explicit Pod interface address.");
    }
    listener = { mode, host };
  }

  const rawPort = stringEnvironment(env, "OCC_PORT");
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("OCC_PORT must be a valid TCP port.");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("OCC_PORT must be a valid TCP port.");
  }

  const databaseUrl = env.OCC_DATABASE_URL;
  if (mode === "production" && databaseUrl === undefined) {
    throw new Error("OCC_DATABASE_URL must be explicitly configured in production.");
  }
  if (databaseUrl !== undefined) {
    let parsed;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new Error("OCC_DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw new Error("OCC_DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
  }

  const rawPoolMax = env.OCC_DATABASE_POOL_MAX;
  let poolMax: number | undefined;
  if (rawPoolMax !== undefined) {
    poolMax = Number(rawPoolMax);
    if (!/^\d+$/.test(rawPoolMax) || !Number.isSafeInteger(poolMax) || poolMax < 1) {
      throw new Error("OCC_DATABASE_POOL_MAX must be a positive integer.");
    }
  }

  if (env.OCC_WORKSPACE_FILES_CONFIG_PATH !== undefined) {
    throw new Error("OCC_WORKSPACE_FILES_CONFIG_PATH has been removed.");
  }

  const gatewayApiKeyPath = env.OCC_GATEWAY_API_KEY_PATH;
  const channelDirectoryProxyUrl = env.OCC_CHANNEL_DIRECTORY_PROXY_URL;
  const channelDirectoryManagedProxyHost = env.OCC_CHANNEL_DIRECTORY_MANAGED_PROXY_HOST;
  if (gatewayApiKeyPath !== undefined) {
    validateGatewayApiKeyPath(gatewayApiKeyPath);
  }

  const nativeAdminEnabled = optionalBooleanEnvironment(env, "OCC_AGENT_NATIVE_ADMIN_ENABLED");
  const auditEnabled = controlPlaneAuditEnabled(mode, env.OCC_CONTROL_PLANE_AUDIT_ENABLED);
  // Default on: the routes are IAM-gated and audited; the chart value turns them off.
  const agentRuntimeLogsEnabled =
    env.OCC_AGENT_RUNTIME_LOGS_ENABLED === undefined ||
    env.OCC_AGENT_RUNTIME_LOGS_ENABLED.trim().length === 0
      ? true
      : optionalBooleanEnvironment(env, "OCC_AGENT_RUNTIME_LOGS_ENABLED");
  for (const removed of ["OCC_AUTH_COOKIE_DOMAIN", "OCC_DEVELOPMENT_AUTH_COOKIE_DOMAIN"]) {
    if (Object.hasOwn(env, removed)) {
      throw new Error(
        `${removed} has been removed; session cookie scope is derived from Console and Agent hostnames.`,
      );
    }
  }
  const nativeAdminDomain = env.OCC_AGENT_NATIVE_ADMIN_DOMAIN;
  const sessionMode = env.OCC_AGENT_NATIVE_ADMIN_SESSION_MODE ?? "shared-cookie";
  if (sessionMode !== "shared-cookie" && sessionMode !== "host-only-exchange") {
    throw new Error(
      "OCC_AGENT_NATIVE_ADMIN_SESSION_MODE must be shared-cookie or host-only-exchange.",
    );
  }
  const nativeAdmin: NativeAdminAccessConfig = {
    enabled: nativeAdminEnabled,
    ...(nativeAdminDomain === undefined ? {} : { domain: nativeAdminDomain }),
    sessionMode,
  };

  const configuredAuthBaseURL = stringEnvironment(env, "OCC_AUTH_BASE_URL");
  let parsedAuthBaseURL;
  try {
    parsedAuthBaseURL = new URL(configuredAuthBaseURL);
  } catch {
    throw new Error("OCC_AUTH_BASE_URL must be a valid absolute URL.");
  }
  refuseWrittenUserinfo("OCC_AUTH_BASE_URL", configuredAuthBaseURL);
  refuseRewrittenIpv4Host("OCC_AUTH_BASE_URL", configuredAuthBaseURL, parsedAuthBaseURL);
  const authBaseURL = parsedAuthBaseURL.toString().replace(/\/$/, "");
  // The same rule createFastifyApp applies to the development browser origin, checked here so
  // startup refuses it as AUTH_BASE_URL_INVALID before loading anything else.
  if (mode === "development" && !isDevelopmentBrowserOrigin(authBaseURL)) {
    throw new Error(`Development OCC_AUTH_BASE_URL must be ${DEVELOPMENT_BROWSER_ORIGIN_RULE}.`);
  }

  deriveSharedCookieDomain(authBaseURL, nativeAdminDomain);

  // { google?, oidc? }: each configured provider carries the recovery user ID.
  const humanLogin = humanLoginConfiguration(env);
  const clientAddress = clientAddressConfiguration(env);
  const authSecret =
    mode === "production"
      ? stringEnvironment(env, "OCC_AUTH_SECRET")
      : stringEnvironment(
          env,
          "OCC_AUTH_SECRET",
          "openclaw-development-auth-secret-minimum-32-bytes",
        );
  validateAuthSecret(authSecret);
  const settings: SharedApiSettings = {
    port,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(poolMax === undefined ? {} : { poolMax }),
    authSecret,
    authBaseURL,
    ...humanLogin,
    ...(gatewayApiKeyPath === undefined ? {} : { gatewayApiKeyPath }),
    nativeAdmin,
    agentRuntimeLogsEnabled,
    controlPlaneAuditEnabled: auditEnabled,
  };
  if (listener.mode === "production") {
    return Object.freeze({
      ...settings,
      ...listener,
      ...(clientAddress === undefined ? {} : { clientAddress }),
      ...(channelDirectoryProxyUrl === undefined ? {} : { channelDirectoryProxyUrl }),
      ...(channelDirectoryManagedProxyHost === undefined
        ? {}
        : { channelDirectoryManagedProxyHost }),
      // The chart sets it when a sign-in egress rule opens HTTPS to any address (finding 2533).
      apiHttpsEgressOpen: optionalBooleanEnvironment(env, "OCC_API_HTTPS_EGRESS_OPEN"),
    });
  }

  if (clientAddress !== undefined) {
    throw new Error("OCC_AUTH_TRUSTED_PROXY_* settings are production-only.");
  }
  return Object.freeze({
    ...settings,
    ...listener,
    ...(trustedDevelopmentBridgeCidr === undefined ? {} : { trustedDevelopmentBridgeCidr }),
    ...(trustedDevelopmentForwarderCidr === undefined || trustedDevelopmentForwarderCidr === ""
      ? {}
      : { trustedDevelopmentForwarderCidr }),
  });
}

/**
 * Starts the API with the settings in `env`: configuration, the Installation's Drivers,
 * production or development composition, then the listener. server.mjs runs it with
 * process.env; tests run it in process with their own environment. Dependencies below it still
 * read process.env for a few process-wide settings, such as OCC_DATABASE_AUTH for the database
 * pool. It throws on a refused setting or an unavailable dependency, and startupFailureFields
 * names the failure.
 */
export async function startApi(env: ApiEnvironment): Promise<void> {
  // Time since process start: Node bootstrap and loading the module graph before startApi().
  const phasesMs: Partial<Record<MeasuredStartupPhase, number>> = {
    modules: Math.round(performance.now()),
  };
  let phaseStartedAt = performance.now();
  const phaseCompleted = (phase: MeasuredStartupPhase) => {
    const now = performance.now();
    phasesMs[phase] = Math.round(now - phaseStartedAt);
    phaseStartedAt = now;
  };
  const settings = configuration(env);
  const consoleTheme = await loadConsoleTheme(env.OCC_CONSOLE_THEME_DIR);
  const metricsSettings = metricsConfiguration(env, settings.mode, settings.port);
  const metrics = metricsSettings === undefined ? undefined : createOccMetrics("api");
  const startupConfiguration = await loadStartupConfigurationSnapshot({
    mode: settings.mode,
    environment: env,
  });
  const logging = startupConfiguration.logging;
  const logger = createOccLogger({ component: "occ-api", level: logging.level });
  if (settings.gatewayApiKeyPath !== undefined) {
    await validateWorkspaceFilesApiKeyPath(settings.gatewayApiKeyPath);
  }
  const compositionSettings = {
    ...(consoleTheme === undefined ? {} : { consoleTheme }),
    logger,
    logging,
    ...(metrics === undefined ? {} : { metrics }),
    ...(startupConfiguration.observability === undefined
      ? {}
      : { observabilityUrl: startupConfiguration.observability.url }),
  };
  const drivers = await loadInstallationConfiguration({
    mode: settings.mode,
    environment: env,
    startupConfiguration,
  });
  let serviceAccountDriverFactory: ServiceAccountDriverFactory | undefined;
  const selectedServiceAccountDriver = drivers?.installation.drivers.service_account;
  if (drivers !== undefined && selectedServiceAccountDriver !== undefined) {
    if (settings.databaseUrl === undefined) {
      throw new Error("Backend-managed ServiceAccounts require PostgreSQL persistence.");
    }
    const compute = drivers.computeDriver;
    if (!supportsServiceAccountCredentials(compute)) {
      throw new Error("The selected Compute Driver cannot manage ServiceAccount credentials.");
    }
    const backendDefinition = drivers.installation.backend.find(
      (backend): backend is ChatGPTBackendDefinition =>
        backend.type === "chatgpt" &&
        backend.drivers.service_account === selectedServiceAccountDriver.id,
    );
    if (backendDefinition === undefined) {
      throw new Error("The selected ServiceAccount Driver requires an owning Backend.");
    }
    const { configuration } = backendDefinition;
    let adminKey;
    try {
      adminKey = (await readFile(configuration.apiKeyPath, "utf8")).trim();
    } catch {
      throw new Error("The configured ChatGPT admin-key Secret is unavailable.");
    }
    if (adminKey.length === 0) {
      throw new Error("The mounted ChatGPT admin key must be nonempty.");
    }
    const { ChatGPTClient } = await import("./backends/chatgpt.ts");
    const { createChatGPTServiceAccountDriverFactory } =
      await import("./drivers/service-account/chatgpt.ts");
    const backend = {
      id: backendDefinition.id,
      drivers: backendDefinition.drivers,
      client: new ChatGPTClient({
        workspaceId: configuration.workspaceId,
        adminKey,
        ...(configuration.credentialTtlSeconds === undefined
          ? {}
          : { credentialTtlSeconds: configuration.credentialTtlSeconds }),
      }),
    };
    serviceAccountDriverFactory = createChatGPTServiceAccountDriverFactory(backend, compute);
  }
  const databaseUrl = settings.databaseUrl;
  if (databaseUrl === undefined) {
    throw new Error("OCC_DATABASE_URL must be explicitly configured in development.");
  }
  phaseCompleted("configuration");
  let app: Awaited<ReturnType<typeof composeProduction>>;
  if (settings.mode === "production") {
    if (drivers === undefined) {
      throw new Error("Production Driver configuration is unavailable.");
    }
    app = await composeProduction({
      ...settings,
      ...compositionSettings,
      databaseUrl,
      drivers,
      ...(serviceAccountDriverFactory === undefined ? {} : { serviceAccountDriverFactory }),
      onStartupPhase: (phase, durationMs) => {
        phasesMs[phase] = durationMs;
      },
    });
    phaseStartedAt = performance.now();
  } else {
    const { composePostgresDevelopment } = await import("./composition/development-postgres.ts");
    app = await composePostgresDevelopment(
      { ...settings, ...compositionSettings, databaseUrl },
      drivers,
      serviceAccountDriverFactory,
    );
    phaseCompleted("composition");
  }

  let closing = false;
  let metricsListener: Awaited<ReturnType<typeof startMetricsListener>> | undefined;
  app.addHook("onClose", async () => {
    await metricsListener?.close();
  });
  async function shutdown(signal: NodeJS.Signals) {
    if (closing) {
      return;
    }
    closing = true;
    // Otherwise nothing marks the start or end of the drain: only the Pod's exit code would
    // tell a completed drain from one the termination grace cut off.
    const startedAt = performance.now();
    emitOccLogEvent(logger, { event: "shutdown.started", signal });
    try {
      await app.close();
      process.exitCode = 0;
      emitOccLogEvent(logger, {
        event: "shutdown.completed",
        durationMs: performance.now() - startedAt,
      });
    } catch {
      process.exitCode = 1;
      emitOccLogEvent(logger, {
        event: "shutdown.failed",
        code: "SHUTDOWN_FAILED",
        durationMs: performance.now() - startedAt,
      });
    }
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  try {
    // Fastify compiles route validators and response serializers here.
    await app.ready();
    phaseCompleted("ready");
    if (metrics !== undefined && metricsSettings !== undefined) {
      metricsListener = await startMetricsListener(metrics, metricsSettings);
    }
    await app.listen({ host: settings.host, port: settings.port });
    phaseCompleted("listen");
  } catch (error) {
    await app.close().catch(() => {
      // Cleanup must finish without replacing the startup failure.
    });
    throw error;
  }
  // One line tells an operator how long the boot took and which phase dominated.
  logger.info({
    event: "listening",
    host: settings.host,
    port: settings.port,
    startupMs: Math.round(performance.now()),
    phasesMs,
  });
}
