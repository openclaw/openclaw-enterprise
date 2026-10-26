import {
  DEVELOPMENT_BROWSER_ORIGIN_RULE,
  isDevelopmentBrowserOrigin,
  refuseRewrittenIpv4Host,
  refuseWrittenUserinfo,
} from "./auth/configuration.ts";
import { clientAddressConfiguration, humanLoginConfiguration } from "./auth/index.ts";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { ConsoleThemeError, loadConsoleTheme } from "./composition/console-theme.ts";
import {
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot,
} from "./composition/installation-config.ts";
import { PresetFileError } from "./composition/installation-presets.ts";
import { composeProduction } from "./composition/production.ts";
import { validateWorkspaceFilesApiKeyPath } from "./composition/workspace-files.ts";
import { createOccLogger, emitOccLogEvent } from "./logging.ts";
import { createOccMetrics } from "./metrics/index.ts";
import {
  startupDependencyFailure,
  startupConfigurationFailure,
  startupListenerFailure,
} from "./startup-failure.ts";
import { metricsConfiguration, startMetricsListener } from "./metrics/listener.ts";

const developmentBindHosts = new Set(["127.0.0.1", "::1", "0.0.0.0"]);
const DEFAULT_BETTER_AUTH_BASE_URL = "http://127.0.0.1:3000";

function startupFailureCode(error) {
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
    /OCC_AUTH_BASE_URL|OCC_AUTH_COOKIE_DOMAIN|loopback host|loopback HTTP\(S\) URL/.test(message)
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
  if (
    /observability\.url (?:IPv4 host must be four decimal octets|must not contain user info|must not contain a tab|must be an absolute HTTP)/.test(
      message,
    )
  ) {
    return "OBSERVABILITY_URL_INVALID";
  }
  if (
    /(?:Gateway|Agent) image (?:must use an immutable SHA-256 digest|repository path must be lowercase|must be a container image reference Kubernetes can pull)/.test(
      message,
    )
  ) {
    return "RUNTIME_IMAGE_INVALID";
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
export function startupFailureFields(error) {
  return (
    startupDependencyFailure(error) ??
    startupConfigurationFailure(error) ??
    startupListenerFailure(error) ?? { code: startupFailureCode(error) }
  );
}

function requiredEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function optionalEnvironment(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function optionalBooleanEnvironment(env, name) {
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

function configuration(env) {
  const mode = env.NODE_ENV;
  if (mode !== "development" && mode !== "production") {
    throw new Error("NODE_ENV must explicitly select development or production mode.");
  }

  const host = requiredEnvironment(env, "OCC_HOST");
  const trustedDevelopmentBridgeCidr = env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR;
  const trustedDevelopmentForwarderCidr = env.OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR;
  if (
    mode === "development" &&
    (!developmentBindHosts.has(host) ||
      (host === "0.0.0.0" &&
        (trustedDevelopmentBridgeCidr === undefined ||
          trustedDevelopmentBridgeCidr.trim().length === 0)))
  ) {
    throw new Error(
      "Development OCC_HOST must be 127.0.0.1 or ::1, or 0.0.0.0 with OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR.",
    );
  }
  if (
    mode === "production" &&
    (isIP(host) === 0 ||
      host === "0.0.0.0" ||
      host === "::" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^::ffff:127\./i.test(host))
  ) {
    throw new Error("Production OCC_HOST must identify one explicit Pod interface address.");
  }

  const rawPort = requiredEnvironment(env, "OCC_PORT");
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
  const poolMax = rawPoolMax === undefined ? undefined : Number(rawPoolMax);
  if (
    rawPoolMax !== undefined &&
    (!/^\d+$/.test(rawPoolMax) || !Number.isSafeInteger(poolMax) || poolMax < 1)
  ) {
    throw new Error("OCC_DATABASE_POOL_MAX must be a positive integer.");
  }

  const settings = {
    mode,
    host,
    port,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(poolMax === undefined ? {} : { poolMax }),
  };

  if (env.OCC_WORKSPACE_FILES_CONFIG_PATH !== undefined) {
    throw new Error("OCC_WORKSPACE_FILES_CONFIG_PATH has been removed.");
  }

  const gatewayApiKeyPath = env.OCC_GATEWAY_API_KEY_PATH;
  const channelDirectoryProxyUrl = env.OCC_CHANNEL_DIRECTORY_PROXY_URL;
  const channelDirectoryManagedProxyHost = env.OCC_CHANNEL_DIRECTORY_MANAGED_PROXY_HOST;
  if (gatewayApiKeyPath !== undefined) {
    if (gatewayApiKeyPath.trim().length === 0 || !isAbsolute(gatewayApiKeyPath)) {
      throw new Error("OCC_GATEWAY_API_KEY_PATH must identify an absolute mounted-file path.");
    }
  }

  const nativeAdminEnabled = optionalBooleanEnvironment(env, "OCC_AGENT_NATIVE_ADMIN_ENABLED");
  // Default on: the routes are IAM-gated and audited; the chart value turns them off.
  const agentRuntimeLogsEnabled =
    env.OCC_AGENT_RUNTIME_LOGS_ENABLED === undefined ||
    env.OCC_AGENT_RUNTIME_LOGS_ENABLED.trim().length === 0
      ? true
      : optionalBooleanEnvironment(env, "OCC_AGENT_RUNTIME_LOGS_ENABLED");
  const nativeAdminDomain = env.OCC_AGENT_NATIVE_ADMIN_DOMAIN;
  const authCookieDomain = env.OCC_AUTH_COOKIE_DOMAIN;
  const nativeAdmin =
    nativeAdminEnabled || (nativeAdminDomain !== undefined && nativeAdminDomain.trim().length > 0)
      ? {
          enabled: nativeAdminEnabled,
          ...(nativeAdminDomain === undefined ? {} : { domain: nativeAdminDomain }),
          ...(authCookieDomain === undefined ? {} : { sharedCookieDomain: authCookieDomain }),
        }
      : undefined;

  const configuredAuthBaseURL =
    mode === "production"
      ? requiredEnvironment(env, "OCC_AUTH_BASE_URL")
      : (env.OCC_AUTH_BASE_URL ?? DEFAULT_BETTER_AUTH_BASE_URL);
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

  // { github?, google?, oidc? }: each configured provider carries the recovery user ID.
  const humanLogin = humanLoginConfiguration(env);
  const clientAddress = clientAddressConfiguration(env);
  if (mode === "production") {
    return Object.freeze({
      ...settings,
      authSecret: requiredEnvironment(env, "OCC_AUTH_SECRET"),
      authBaseURL,
      ...humanLogin,
      ...(clientAddress === undefined ? {} : { clientAddress }),
      ...(gatewayApiKeyPath === undefined ? {} : { gatewayApiKeyPath }),
      ...(channelDirectoryProxyUrl === undefined ? {} : { channelDirectoryProxyUrl }),
      ...(channelDirectoryManagedProxyHost === undefined
        ? {}
        : { channelDirectoryManagedProxyHost }),
      ...(nativeAdmin === undefined ? {} : { nativeAdmin }),
      agentRuntimeLogsEnabled,
      // The chart sets it when a sign-in egress rule opens HTTPS to any address (finding 2533).
      apiHttpsEgressOpen: optionalBooleanEnvironment(env, "OCC_API_HTTPS_EGRESS_OPEN"),
    });
  }

  if (clientAddress !== undefined) {
    throw new Error("OCC_AUTH_TRUSTED_PROXY_* settings are production-only.");
  }
  const authSecret = optionalEnvironment(
    env,
    "OCC_AUTH_SECRET",
    "openclaw-development-auth-secret-minimum-32-bytes",
  );
  if (authSecret.length < 32) {
    throw new Error("OCC_AUTH_SECRET must be at least 32 characters.");
  }
  return Object.freeze({
    ...settings,
    authSecret,
    authBaseURL,
    ...humanLogin,
    ...(gatewayApiKeyPath === undefined ? {} : { gatewayApiKeyPath }),
    ...(nativeAdmin === undefined ? {} : { nativeAdmin }),
    agentRuntimeLogsEnabled,
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
export async function startApi(env) {
  // Time since process start: Node bootstrap and loading the module graph before startApi().
  const phasesMs = { modules: Math.round(performance.now()) };
  let phaseStartedAt = performance.now();
  const phaseCompleted = (phase) => {
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
    ...settings,
    ...(consoleTheme === undefined ? {} : { consoleTheme }),
    logger,
    logging,
    metrics,
    ...(startupConfiguration.observability === undefined
      ? {}
      : { observabilityUrl: startupConfiguration.observability.url }),
  };
  const drivers = await loadInstallationConfiguration({
    mode: settings.mode,
    environment: env,
    startupConfiguration,
  });
  let serviceAccountDriverFactory;
  const selectedServiceAccountDriver = drivers?.installation.drivers.service_account;
  if (selectedServiceAccountDriver !== undefined) {
    if (settings.databaseUrl === undefined) {
      throw new Error("Backend-managed ServiceAccounts require PostgreSQL persistence.");
    }
    if (
      typeof drivers.computeDriver.storeServiceAccountCredential !== "function" ||
      typeof drivers.computeDriver.findServiceAccountCredential !== "function" ||
      typeof drivers.computeDriver.deleteServiceAccountCredential !== "function"
    ) {
      throw new Error("The selected Compute Driver cannot manage ServiceAccount credentials.");
    }
    const backendDefinition = drivers.installation.backend.find(
      (backend) =>
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
    serviceAccountDriverFactory = createChatGPTServiceAccountDriverFactory(
      backend,
      drivers.computeDriver,
    );
  }
  if (settings.mode === "development" && settings.databaseUrl === undefined) {
    throw new Error("OCC_DATABASE_URL must be explicitly configured in development.");
  }
  phaseCompleted("configuration");
  let app;
  if (settings.mode === "production") {
    if (drivers === undefined) {
      throw new Error("Production Driver configuration is unavailable.");
    }
    app = await composeProduction({
      ...compositionSettings,
      drivers,
      logger,
      ...(serviceAccountDriverFactory === undefined ? {} : { serviceAccountDriverFactory }),
      onStartupPhase: (phase, durationMs) => {
        phasesMs[phase] = durationMs;
      },
    });
    phaseStartedAt = performance.now();
  } else {
    const { composePostgresDevelopment } = await import("./composition/development-postgres.ts");
    app = await composePostgresDevelopment(
      compositionSettings,
      drivers,
      serviceAccountDriverFactory,
    );
    phaseCompleted("composition");
  }

  let closing = false;
  let metricsListener;
  app.addHook("onClose", async () => {
    await metricsListener?.close();
  });
  async function shutdown(signal) {
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
    if (metrics !== undefined) {
      metricsListener = await startMetricsListener(metrics, metricsSettings);
    }
    await app.listen({ host: settings.host, port: settings.port });
    phaseCompleted("listen");
  } catch (error) {
    await app.close();
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
