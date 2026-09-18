import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOccLogger,
  createWorkerLogEmitter,
  emitOccLogEvent,
  operationalLoggingConfiguration,
} from "../../apps/controller/src/logging.ts";
import {
  loadInstallationConfiguration,
  loadOperationalLoggingConfiguration,
  loadStartupConfigurationSnapshot,
} from "../../apps/controller/src/composition/installation-config.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

async function fixture(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), "occ-common-logging-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

function memoryDestination() {
  const lines = [];
  return {
    lines,
    destination: {
      write(chunk) {
        for (const line of String(chunk).split("\n")) {
          if (line.length > 0) {
            lines.push(JSON.parse(line));
          }
        }
        return true;
      },
    },
  };
}

function authStub() {
  return {
    issuer: "occ:installation:ins_test:better-auth",
    admissionVerifier: {
      async verify() {
        throw new Error("test route should not authenticate");
      },
    },
    async createAccount() {
      throw new Error("test route should not create accounts");
    },
    async deleteAccount() {},
    principalSeed() {
      throw new Error("test route should not create principals");
    },
    async signInEmail() {
      throw new Error("test route should not sign in");
    },
    async signOut() {
      throw new Error("test route should not sign out");
    },
    async session() {
      throw new Error("test route should not read sessions");
    },
    async createServiceKey() {
      throw new Error("test route should not create service keys");
    },
    async getServiceKey() {
      return undefined;
    },
    async revokeServiceKey() {},
  };
}

function iamDriver({ allow = false } = {}) {
  return {
    id: "native-iam",
    capability: "iam",
    implementation: "test",
    async lookupIdentity({ subject }) {
      return {
        kind: "principal",
        id: subject,
        issuer: "https://identity.example.com",
        subject,
      };
    },
    async authorize() {
      return allow
        ? {
            allowed: true,
            driverId: "native-iam",
            evidence: { groupIds: [], bindingIds: [], roleIds: [], restrictionIds: [] },
          }
        : {
            allowed: false,
            reason: "test",
            driverId: "native-iam",
            evidence: { groupIds: [], bindingIds: [], roleIds: [], restrictionIds: [] },
          };
    },
  };
}

test("startup logging configuration is closed, defaults to info, and can stand alone in development", async (t) => {
  assert.deepEqual(operationalLoggingConfiguration(undefined), { level: "info" });
  assert.deepEqual(operationalLoggingConfiguration({}), { level: "info" });
  assert.throws(
    () => operationalLoggingConfiguration({ level: "trace" }),
    /logging\.level must be one of debug, info, warn, or error/,
  );
  assert.throws(
    () => operationalLoggingConfiguration({ level: null }),
    /logging\.level must be one of debug, info, warn, or error/,
  );
  assert.throws(
    () => operationalLoggingConfiguration({ level: "info", endpoint: "https://collector" }),
    /unsupported option/,
  );

  const loggingOnly = await fixture(t, "logging:\n  level: debug\n");
  assert.deepEqual(
    await loadOperationalLoggingConfiguration({
      mode: "development",
      environment: { OCC_CONFIG_PATH: loggingOnly },
    }),
    { level: "debug" },
  );
  assert.equal(
    await loadInstallationConfiguration({
      mode: "development",
      environment: { OCC_CONFIG_PATH: loggingOnly },
    }),
    undefined,
  );

  const full = installation();
  full.logging = { level: "warn" };
  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, JSON.stringify(full)) },
  });
  assert.equal(loaded.installation.logging.level, "warn");
  assert.equal(Object.hasOwn(loaded, "logging"), false);
});

test("startup snapshot feeds logging and full Driver configuration without rereading YAML", async (t) => {
  const full = installation();
  full.logging = { level: "warn" };
  full.drivers.compute.configuration.network.gatewayPort = 8082;
  const path = await fixture(t, JSON.stringify(full));
  const startupConfiguration = await loadStartupConfigurationSnapshot({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });

  // API and worker startup parse the trusted YAML once, then pass the same snapshot to logging
  // and Driver construction. A later file change must not affect the running process snapshot.
  await writeFile(path, "drivers: [\n", "utf8");
  assert.deepEqual(startupConfiguration.logging, { level: "warn" });
  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: {},
    startupConfiguration,
  });

  assert.equal(loaded.installation.logging.level, "warn");
  assert.equal(loaded.installation.drivers.compute.configuration.network.gatewayPort, 8082);
});

test("OCC logger emits structured severity and filters below the configured level", () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-test",
    level: "warn",
    destination: output.destination,
  });

  logger.info({ event: "dropped.info" });
  logger.warn({ event: "kept.warn", requestId: "req_test" });

  assert.equal(output.lines.length, 1);
  assert.equal(output.lines[0].event, "kept.warn");
  assert.equal(output.lines[0].severity, "WARN");
  assert.equal(output.lines[0].service, "occ-test");
  assert.equal(Object.hasOwn(output.lines[0], "level"), false);
});

test("OCC event severity mapping treats failed diagnostics as errors and warnings as warnings", () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-script",
    level: "info",
    destination: output.destination,
  });

  emitOccLogEvent(logger, { event: "installation.bootstrap-failed" });
  emitOccLogEvent(logger, { event: "migration.failed" });
  emitOccLogEvent(logger, {
    event: "compute.preflight-warning",
    code: "KUBERNETES_VERSION_BELOW_MINIMUM",
    message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
  });

  assert.deepEqual(
    output.lines.map(({ event, severity }) => ({ event, severity })),
    [
      { event: "installation.bootstrap-failed", severity: "ERROR" },
      { event: "migration.failed", severity: "ERROR" },
      { event: "compute.preflight-warning", severity: "WARN" },
    ],
  );
  assert.equal(
    output.lines[2].message,
    "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
  );
});

test("OCC event sanitizer drops arbitrary fields and unsafe diagnostic text", () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-worker",
    level: "info",
    destination: output.destination,
  });

  emitOccLogEvent(logger, {
    event: "worker.error",
    attempt: 2,
    code: "WORKER_UNAVAILABLE",
    message: "ordinary diagnostic text must not enter operational logs",
    secret: "sk-proj-secret-value-that-must-not-log",
    error: "Bearer token-that-must-not-log",
  });
  emitOccLogEvent(logger, {
    event: "installation.bootstrap-failed",
    code: "COMMIT_OUTCOME_UNKNOWN",
    attempt: {
      installationId: "ins_safe",
      serviceKeyFile: "/tmp/common-otel-swarm/occ/service-key.json",
      passwordFile: "/tmp/common-otel-swarm/occ/password.txt",
      serviceKeyId: "key_safe",
      arbitrary: "dropped",
      unsafe: "Bearer token-that-must-not-log",
    },
  });

  assert.equal(output.lines.length, 2);
  assert.equal(output.lines[0].attempt, 2);
  assert.equal(output.lines[0].code, "WORKER_UNAVAILABLE");
  assert.deepEqual(output.lines[1].attempt, {
    installationId: "ins_safe",
    serviceKeyFile: "/tmp/common-otel-swarm/occ/service-key.json",
    passwordFile: "/tmp/common-otel-swarm/occ/password.txt",
    serviceKeyId: "key_safe",
  });
  assert.equal(Object.hasOwn(output.lines[0], "error"), false);
  assert.equal(Object.hasOwn(output.lines[0], "message"), false);
  assert.equal(Object.hasOwn(output.lines[0], "secret"), false);
  assert.equal(JSON.stringify(output.lines).includes("token-that-must-not-log"), false);
  assert.equal(JSON.stringify(output.lines).includes("arbitrary"), false);
});

test("Fastify app writes one safe HTTP completion record and bounded unexpected-error diagnostics", async () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: output.destination,
  });
  const app = createFastifyApp({
    iamDriver: iamDriver(),
    computeDriver: createDevelopmentComputeDriver(),
    configurationDriver: createTestConfigurationDriver({ id: "configuration-logging-test" }),
    resolveHarness: () => undefined,
    auditSink: new InMemoryAuditSink(),
    development: { enabled: true, installationId: `ins_${randomUUID()}` },
    auth: authStub(),
    logger,
  });
  app.get("/boom", async () => {
    throw new Error("sensitive query token should not be logged");
  });

  const notFound = await app.inject({ method: "GET", url: "/missing?token=secret" });
  assert.equal(notFound.statusCode, 404);
  const failed = await app.inject({ method: "GET", url: "/boom?token=secret" });
  assert.equal(failed.statusCode, 500);
  await app.close();

  const completion = output.lines.filter((line) => line.event === "http.completed");
  assert.equal(completion.length, 2);
  assert.deepEqual(
    completion.map(({ method, route, status }) => ({ method, route, status })),
    [
      { method: "GET", route: "unmatched", status: 404 },
      { method: "GET", route: "/boom", status: 500 },
    ],
  );
  assert.match(completion[0].requestId, /^req_[0-9a-f-]+$/);
  assert.equal(typeof completion[0].durationMs, "number");

  const unexpected = output.lines.find((line) => line.event === "http.unexpected_error");
  assert.ok(unexpected);
  assert.equal(unexpected.code, "INTERNAL_ERROR");
  assert.equal(JSON.stringify(output.lines).includes("token=secret"), false);
  assert.equal(JSON.stringify(output.lines).includes("sensitive query"), false);
});

test("worker emitter reports health at debug and failures at error", () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-worker",
    level: "debug",
    destination: output.destination,
  });
  const emit = createWorkerLogEmitter(logger);

  emit({ event: "worker.health", pending: 0 });
  emit({
    event: "worker.completed",
    workId: "namespace:ns_test:reconcile:ready",
    attempt: 1,
    operation: "namespace.ensure",
    namespaceId: "ns_test",
    outcome: "success",
  });
  emit({ event: "worker.error", code: "CLAIM_LOST" });

  assert.deepEqual(
    output.lines.map(({ event, severity }) => ({ event, severity })),
    [
      { event: "worker.health", severity: "DEBUG" },
      { event: "worker.completed", severity: "INFO" },
      { event: "worker.error", severity: "ERROR" },
    ],
  );
  const completed = output.lines.find((line) => line.event === "worker.completed");
  assert.equal(completed.workId, "namespace:ns_test:reconcile:ready");
  assert.equal(completed.attempt, 1);
  assert.equal(completed.operation, "namespace.ensure");
});

test("worker startup diagnostics honor logging YAML and stay on stderr", async (t) => {
  const path = await fixture(t, "logging:\n  level: debug\n");
  const result = spawnSync(process.execPath, ["apps/controller/src/worker.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      OCC_CONFIG_PATH: path,
      OCC_DATABASE_URL: "not-a-postgres-url",
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const diagnostic = result.stderr
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((line) => line.event === "worker.startup-error");
  assert.ok(diagnostic, result.stderr);
  assert.equal(diagnostic.severity, "ERROR");
  assert.equal(diagnostic.service, "occ-worker");
  assert.equal(diagnostic.code, "DATABASE_CONFIGURATION_INVALID");
  assert.equal(Object.hasOwn(diagnostic, "error"), false);
});
