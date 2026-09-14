import { unlink, writeFile } from "node:fs/promises";
import { createPostgresPool } from "@openclaw-enterprise/occ";
import {
  loadInstallationConfiguration,
  loadOperationalLoggingConfiguration,
  loadStartupConfigurationSnapshot,
} from "./composition/installation-config.ts";
import { createOccLogger, createWorkerLogEmitter, emitOccLogEvent } from "./logging.ts";
import { createControllerWorker } from "./worker.ts";

function positiveEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function configuration() {
  const mode = process.env.NODE_ENV;
  if (mode !== "development" && mode !== "production")
    throw new Error("The controller worker requires development or production mode.");

  const databaseUrl = process.env.OCC_DATABASE_URL;
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("A valid PostgreSQL connection URL must be explicitly configured.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:")
    throw new Error("A valid PostgreSQL connection URL must be explicitly configured.");

  return {
    mode,
    databaseUrl,
    pollIntervalMs: positiveEnvironment("OCC_WORKER_POLL_INTERVAL_MS", 250),
    leaseDurationMs: positiveEnvironment("OCC_WORKER_LEASE_DURATION_MS", 5_000),
    maxAttempts: positiveEnvironment("OCC_WORKER_MAX_ATTEMPTS", 5),
    convergenceTimeoutMs: positiveEnvironment("OCC_WORKER_CONVERGENCE_TIMEOUT_MS", 900_000),
  };
}

function workerStartupFailureCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (/PostgreSQL connection URL/.test(message)) return "DATABASE_CONFIGURATION_INVALID";
  if (/platform persistence repository|ECONNREFUSED|ECONNRESET|connect /i.test(message)) {
    return "PERSISTENCE_UNAVAILABLE";
  }
  return "WORKER_STARTUP_FAILED";
}

let worker;
let pool;
let readinessPath;
let logger;
let logging;
let startupConfiguration;
try {
  const { databaseUrl, mode, ...options } = configuration();
  startupConfiguration = await loadStartupConfigurationSnapshot({ mode });
  logging = startupConfiguration.logging;
  logger = createOccLogger({ component: "occ-worker", level: logging.level });
  readinessPath = process.env.OCC_WORKER_READINESS_PATH;
  if (readinessPath !== undefined) {
    if (!readinessPath.startsWith("/"))
      throw new Error("OCC_WORKER_READINESS_PATH must identify an absolute writable path.");
    try {
      await unlink(readinessPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const drivers = await loadInstallationConfiguration({ mode, startupConfiguration });
  let computeDriver;
  if (drivers === undefined && mode === "development") {
    const { createDevelopmentDockerComputeDriver } =
      await import("./composition/development-postgres.ts");
    computeDriver = createDevelopmentDockerComputeDriver();
    if (typeof computeDriver.preflight === "function") await computeDriver.preflight();
  }
  pool = await createPostgresPool(databaseUrl);
  worker = createControllerWorker({
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
  });
  await worker.start();

  async function shutdown() {
    try {
      if (readinessPath !== undefined) await unlink(readinessPath).catch(() => {});
      await worker.stop();
      process.exitCode = 0;
    } catch {
      emitOccLogEvent(logger, { event: "worker.error", code: "SHUTDOWN_FAILED" });
      process.exitCode = 1;
    }
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  if (readinessPath !== undefined) await unlink(readinessPath).catch(() => {});
  if (worker !== undefined) await worker.stop().catch(() => {});
  else if (pool !== undefined) await pool.end();
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
    code: workerStartupFailureCode(error),
  });
  process.exitCode = 1;
}
