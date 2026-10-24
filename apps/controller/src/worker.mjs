import { unlink, writeFile } from "node:fs/promises";
import { createPostgresPool, PostgresPlatformState } from "@openclaw-enterprise/occ";
import { startRepositoryReceiptServer } from "./backends/repository-credentials/receipt-server.ts";
import {
  PreparedGitHubAppKeyError,
  startPreparedGitHubGitOwner,
} from "./backends/repository-credentials/prepared-git-owner.ts";
import {
  bindRepositoryGitTransport,
  repositoryGitAuthority,
} from "./composition/repository-credentials/transport.ts";
import {
  loadInstallationConfiguration,
  loadOperationalLoggingConfiguration,
  loadStartupConfigurationSnapshot,
  readPublicCaBundle,
} from "./composition/installation-config.ts";
import { PresetFileError } from "./composition/installation-presets.ts";
import { createOccLogger, createWorkerLogEmitter, emitOccLogEvent } from "./logging.ts";
import { createControllerWorker, workerDatabasePoolOptions } from "./worker.ts";
import { PostgresMetricsSnapshot } from "@openclaw-enterprise/occ";
import { createOccMetrics } from "./metrics/index.ts";
import {
  startupDependencyFailure,
  startupConfigurationFailure,
  startupListenerFailure,
} from "./startup-failure.ts";
import { metricsConfiguration, startMetricsListener } from "./metrics/listener.ts";

function positiveEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function configuration() {
  const mode = process.env.NODE_ENV;
  if (mode !== "development" && mode !== "production") {
    throw new Error("The controller worker requires development or production mode.");
  }

  const databaseUrl = process.env.OCC_DATABASE_URL;
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("A valid PostgreSQL connection URL must be explicitly configured.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("A valid PostgreSQL connection URL must be explicitly configured.");
  }

  return {
    mode,
    databaseUrl,
    pollIntervalMs: positiveEnvironment("OCC_WORKER_POLL_INTERVAL_MS", 250),
    leaseDurationMs: positiveEnvironment("OCC_WORKER_LEASE_DURATION_MS", 5_000),
    maxAttempts: positiveEnvironment("OCC_WORKER_MAX_ATTEMPTS", 5),
    convergenceTimeoutMs: positiveEnvironment("OCC_WORKER_CONVERGENCE_TIMEOUT_MS", 900_000),
    databaseTimeoutMs: positiveEnvironment("OCC_WORKER_DATABASE_TIMEOUT_MS", 60_000),
  };
}

function workerStartupFailureCode(error) {
  if (error instanceof PresetFileError) {
    return "PRESET_FILE_INVALID";
  }
  const message = error instanceof Error ? error.message : "";
  if (/stored Installation name breaks the Name rule/.test(message)) {
    return "INSTALLATION_NAME_INVALID";
  }
  if (/PostgreSQL connection URL/.test(message)) {
    return "DATABASE_CONFIGURATION_INVALID";
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
  if (/platform persistence repository|ECONNREFUSED|ECONNRESET|connect /i.test(message)) {
    return "PERSISTENCE_UNAVAILABLE";
  }
  return "WORKER_STARTUP_FAILED";
}

let worker;
let pool;
let readinessPath;
let livenessPath;
let logger;
let logging;
let startupConfiguration;
let metricsPool;
let metricsListener;
let metricsClosing;
let receiptServer;
let repositoryGitTransport;
let preparedRepositoryGit;
let preparedGitHub;
async function closeMetrics() {
  metricsClosing ??= (async () => {
    try {
      await metricsListener?.close();
    } finally {
      await metricsPool?.end();
    }
  })();
  return metricsClosing;
}
try {
  const { databaseUrl, mode, databaseTimeoutMs, ...options } = configuration();
  const metricsSettings = metricsConfiguration(process.env, mode);
  startupConfiguration = await loadStartupConfigurationSnapshot({ mode });
  logging = startupConfiguration.logging;
  logger = createOccLogger({ component: "occ-worker", level: logging.level });
  readinessPath = process.env.OCC_WORKER_READINESS_PATH;
  livenessPath = process.env.OCC_WORKER_LIVENESS_PATH;
  for (const [name, marker] of [
    ["OCC_WORKER_READINESS_PATH", readinessPath],
    ["OCC_WORKER_LIVENESS_PATH", livenessPath],
  ]) {
    if (marker === undefined) {
      continue;
    }
    if (!marker.startsWith("/")) {
      throw new Error(`${name} must identify an absolute writable path.`);
    }
    try {
      await unlink(marker);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  // Startup (Installation and IAM load, Compute preflight) counts against the liveness
  // bound, and an unwritable path fails here rather than as a restart loop later.
  if (livenessPath !== undefined) {
    await writeFile(livenessPath, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 });
  }
  const drivers = await loadInstallationConfiguration({ mode, startupConfiguration });
  let computeDriver;
  if (drivers === undefined && mode === "development") {
    const { createDevelopmentDockerComputeDriver } =
      await import("./composition/development-postgres.ts");
    computeDriver = createDevelopmentDockerComputeDriver();
    if (typeof computeDriver.preflight === "function") {
      await computeDriver.preflight();
    }
  }
  pool = await createPostgresPool(databaseUrl, workerDatabasePoolOptions(databaseTimeoutMs));
  const repositoryOwner = drivers?.repositoryOwner;
  if (repositoryOwner?.controlSocket !== undefined) {
    receiptServer = await startRepositoryReceiptServer({
      ...repositoryOwner,
      state: new PostgresPlatformState(pool),
    });
  }
  if (repositoryOwner && drivers.preparedRepositoryGit) {
    const { issuerCaPath, ...owner } = drivers.preparedRepositoryGit;
    preparedRepositoryGit = await startPreparedGitHubGitOwner({
      ...repositoryOwner,
      ...owner,
      ...(issuerCaPath ? { ca: Buffer.from(await readPublicCaBundle(issuerCaPath)) } : {}),
      pool,
      registry: drivers.repositoryRegistry,
      ...repositoryGitAuthority(drivers),
      report: (code, context) =>
        emitOccLogEvent(logger, { event: "worker.error", code, ...context }),
    });
    repositoryGitTransport = await bindRepositoryGitTransport(
      drivers,
      preparedRepositoryGit,
      pool,
      (event) => emitOccLogEvent(logger, event),
    );
  } else if (drivers?.repositoryGitDriver || drivers?.openShellGit) {
    throw new Error("The repository Git transport requires its selected prepared owner.");
  }
  let metrics;
  if (metricsSettings !== undefined) {
    metricsPool = await createPostgresPool(databaseUrl, {
      max: 1,
      connectionTimeoutMillis: 500,
      statement_timeout: 1500,
      query_timeout: 1500,
      options: "-c default_transaction_read_only=on",
    });
    metricsPool.on("error", () =>
      emitOccLogEvent(logger, { event: "worker.error", code: "METRICS_DATABASE_UNAVAILABLE" }),
    );
    const snapshot = new PostgresMetricsSnapshot(metricsPool);
    metrics = createOccMetrics("worker", () => snapshot.collect());
    metricsListener = await startMetricsListener(metrics, metricsSettings);
  }
  worker = createControllerWorker({
    metrics,
    pool,
    mode,
    ...options,
    emit: createWorkerLogEmitter(logger),
    ...(drivers === undefined ? { computeDriver } : { drivers }),
    ...(readinessPath === undefined
      ? {}
      : {
          onHealthy: () =>
            writeFile(readinessPath, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 }),
        }),
    ...(livenessPath === undefined
      ? {}
      : {
          onProgress: () =>
            writeFile(livenessPath, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 }),
        }),
  });
  preparedGitHub = drivers?.preparedGitHub;
  await preparedGitHub?.connect(pool);
  await worker.start();
  preparedGitHub?.startWorker((code) => emitOccLogEvent(logger, { event: "worker.error", code }));

  let closing = false;
  async function shutdown() {
    if (closing) {
      return;
    }
    closing = true;
    try {
      if (readinessPath !== undefined) {
        await unlink(readinessPath).catch(() => {});
      }
      try {
        try {
          try {
            await repositoryGitTransport?.close();
          } finally {
            await preparedRepositoryGit?.close();
          }
          await receiptServer?.close();
        } finally {
          await closeMetrics();
        }
      } finally {
        await preparedGitHub?.close();
        await worker.stop();
      }
      process.exitCode = 0;
    } catch {
      emitOccLogEvent(logger, { event: "worker.error", code: "SHUTDOWN_FAILED" });
      process.exitCode = 1;
    }
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  await preparedGitHub?.close().catch(() => {});
  await repositoryGitTransport?.close().catch(() => {});
  await preparedRepositoryGit?.close().catch(() => {});
  await receiptServer?.close().catch(() => {});
  await closeMetrics().catch(() => {});
  if (readinessPath !== undefined) {
    await unlink(readinessPath).catch(() => {});
  }
  if (worker !== undefined) {
    await worker.stop().catch(() => {});
  } else if (pool !== undefined) {
    await pool.end();
  }
  try {
    const mode = process.env.NODE_ENV === "production" ? "production" : "development";
    logging =
      logging ??
      startupConfiguration?.logging ??
      (await loadOperationalLoggingConfiguration({ mode }));
    logger = createOccLogger({
      component: "occ-worker",
      level: logging.level,
      destination: "stderr",
    });
  } catch {
    logger = createOccLogger({ component: "occ-worker", level: "info", destination: "stderr" });
  }
  emitOccLogEvent(logger, {
    event: "worker.startup-error",
    ...((error instanceof PreparedGitHubAppKeyError
      ? { code: error.code, reason: error.reason }
      : undefined) ??
      startupDependencyFailure(error) ??
      startupConfigurationFailure(error) ??
      startupListenerFailure(error) ?? { code: workerStartupFailureCode(error) }),
  });
  process.exitCode = 1;
}
