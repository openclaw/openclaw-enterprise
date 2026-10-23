import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createOccLogger,
  createWorkerLogEmitter,
  emitOccLogEvent,
  MAX_LOGGED_IDENTIFIERS,
  operationalLoggingConfiguration,
  skippedUserLogFields,
} from "../../apps/controller/src/logging.ts";
import { OPENSHELL_GIT_EXPIRY_CHECKS } from "../../apps/controller/src/drivers/egress-proxy/openshell-expired-git.ts";
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
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

async function fixture(t, contents) {
  const directory = await temporaryDirectory(t, "occ-common-logging-");
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

test("a limited sign-in lane logs a warning with its lane and hashed key only", () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: output.destination,
  });

  emitOccLogEvent(logger, {
    event: "authentication.sign-in-limited",
    lane: "email",
    keyHash: "0123456789abcdef",
    email: "victim@example.test",
    clientAddress: "203.0.113.7",
  });

  assert.equal(output.lines.length, 1);
  const { time, ...line } = output.lines[0];
  assert.ok(time);
  assert.deepEqual(line, {
    severity: "WARN",
    service: "occ-api",
    event: "authentication.sign-in-limited",
    lane: "email",
    keyHash: "0123456789abcdef",
  });
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
    grpcStatus: "3",
    validationCategory: "arbitrary-supplier-category",
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
  assert.equal(Object.hasOwn(output.lines[0], "grpcStatus"), false);
  assert.equal(Object.hasOwn(output.lines[0], "validationCategory"), false);
  assert.equal(JSON.stringify(output.lines).includes("token-that-must-not-log"), false);
  assert.equal(JSON.stringify(output.lines).includes("arbitrary"), false);
});

test("Compute preparation diagnostics keep reviewed context and reject secret-bearing text", () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-worker",
    level: "info",
    destination: output.destination,
  });

  emitOccLogEvent(logger, {
    event: "worker.compute-prepare-failed",
    workId: "agent_revision:rev_test:reconcile",
    attempt: 1,
    operation: "agent_revision.reconcile",
    namespaceId: "ns_test",
    agentId: "agt_test",
    revisionId: "rev_test",
    computeDriverId: "compute-kubernetes",
    code: "KUBERNETES_API_REJECTED",
    step: "gateway_deployment",
    candidatePreparationReached: false,
    errorClass: "KubernetesApiError",
    status: 422,
    message: "The Kubernetes API rejected revision preparation.",
  });
  emitOccLogEvent(logger, {
    event: "worker.compute-prepare-failed",
    code: "KUBERNETES_PREPARATION_FAILED",
    step: "sandbox_provision",
    candidatePreparationReached: "token-that-must-not-log",
    message: "Bearer token-that-must-not-log",
  });

  assert.equal(output.lines.length, 2);
  const { time, ...diagnostic } = output.lines[0];
  assert.ok(time);
  assert.deepEqual(diagnostic, {
    severity: "ERROR",
    service: "occ-worker",
    event: "worker.compute-prepare-failed",
    workId: "agent_revision:rev_test:reconcile",
    attempt: 1,
    operation: "agent_revision.reconcile",
    namespaceId: "ns_test",
    agentId: "agt_test",
    revisionId: "rev_test",
    computeDriverId: "compute-kubernetes",
    code: "KUBERNETES_API_REJECTED",
    step: "gateway_deployment",
    candidatePreparationReached: false,
    errorClass: "KubernetesApiError",
    status: 422,
    message: "The Kubernetes API rejected revision preparation.",
  });
  assert.equal(Object.hasOwn(output.lines[1], "message"), false);
  assert.equal(Object.hasOwn(output.lines[1], "candidatePreparationReached"), false);
  assert.equal(JSON.stringify(output.lines).includes("token-that-must-not-log"), false);
});

test("activation warning caps skipped account IDs and reports the total and truncation", () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: output.destination,
  });
  const ids = (count) =>
    Array.from({ length: count }, (_, index) => `user_${String(index).padStart(4, "0")}`);

  for (const skipped of [ids(1), ids(MAX_LOGGED_IDENTIFIERS), ids(MAX_LOGGED_IDENTIFIERS + 1)]) {
    emitOccLogEvent(logger, {
      event: "authentication.activation-warning",
      ...skippedUserLogFields(skipped),
    });
  }

  assert.equal(output.lines.length, 3);
  assert.deepEqual(
    output.lines.map(({ severity, skippedUserIds, skippedUserCount, skippedUserIdsTruncated }) => ({
      severity,
      ids: skippedUserIds.length,
      skippedUserCount,
      skippedUserIdsTruncated,
    })),
    [
      { severity: "WARN", ids: 1, skippedUserCount: 1, skippedUserIdsTruncated: false },
      {
        severity: "WARN",
        ids: MAX_LOGGED_IDENTIFIERS,
        skippedUserCount: MAX_LOGGED_IDENTIFIERS,
        skippedUserIdsTruncated: false,
      },
      {
        severity: "WARN",
        ids: MAX_LOGGED_IDENTIFIERS,
        skippedUserCount: MAX_LOGGED_IDENTIFIERS + 1,
        skippedUserIdsTruncated: true,
      },
    ],
  );
  assert.deepEqual(output.lines[2].skippedUserIds, ids(MAX_LOGGED_IDENTIFIERS));
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

test("a refused forwarded API call names the trusted-proxy cause once a minute", async () => {
  const cases = [
    { trustedProxies: undefined, code: "TRUSTED_PROXY_NOT_CONFIGURED" },
    {
      trustedProxies: { trusts: (address) => address === "10.0.0.9" },
      code: "TRUSTED_PROXY_PEER_UNTRUSTED",
    },
  ];
  for (const { trustedProxies, code } of cases) {
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
      development: { enabled: false, installationId: `ins_${randomUUID()}` },
      auth: authStub(),
      logger,
      ...(trustedProxies === undefined ? {} : { trustedProxies }),
    });
    for (let index = 0; index < 3; index += 1) {
      const refused = await app.inject({
        method: "GET",
        url: "/namespaces/ns_00000000-0000-4000-8000-000000000001",
        remoteAddress: "192.0.2.7",
        headers: { "x-forwarded-for": `198.51.100.${index}` },
      });
      assert.equal(refused.statusCode, 403, refused.body);
      assert.match(refused.json().error.message, /configured trusted proxy/);
    }
    await app.close();
    const warnings = output.lines.filter(
      (line) => line.event === "authentication.forwarded-refused-warning",
    );
    assert.deepEqual(
      warnings.map(({ severity, code: logged }) => ({ severity, code: logged })),
      [{ severity: "WARN", code }],
    );
    assert.doesNotMatch(JSON.stringify(warnings), /192\.0\.2\.7|198\.51\.100/);
  }
});

test("Fastify contract errors drop the request values that verbose validation attached", async () => {
  const output = memoryDestination();
  const logger = createOccLogger({
    component: "occ-api",
    level: "debug",
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
  // The app's own Ajv options (verbose, so each failure carries its value) and error handler
  // judge this body. onError keeps a reference to the error; after the response it holds what
  // any later log of the error would see.
  const seen = [];
  app.addHook("onError", async (_request, _reply, error) => {
    seen.push(error);
  });
  app.post(
    "/validated",
    {
      schema: {
        body: {
          type: "object",
          properties: { token: { type: "string", maxLength: 4 } },
          required: ["token"],
          additionalProperties: false,
        },
      },
    },
    async () => ({}),
  );

  const token = "sensitive-validation-token";
  const invalid = await app.inject({ method: "POST", url: "/validated", payload: { token } });
  await app.close();

  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json().error.details, [{ path: "/token", code: "TOO_LONG" }]);
  assert.equal(seen.length, 1);
  assert.equal(Array.isArray(seen[0].validation), true);
  for (const entry of seen[0].validation) {
    assert.deepEqual(
      ["data", "schema", "parentSchema"].filter((key) => Object.hasOwn(entry, key)),
      [],
    );
  }
  assert.equal(JSON.stringify(seen[0]).includes(token), false);
  assert.equal(invalid.body.includes(token), false);
  assert.equal(JSON.stringify(output.lines).includes(token), false);
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
  emit({
    event: "worker.completed",
    workId: "agent_revision:rev_test:reconcile",
    attempt: 1,
    outcome: "success",
    durationMs: 120,
    deployPasses: 3,
    prepareMs: 450,
    readinessWaitMs: 2100,
    activationMs: 80,
    elapsedMs: 2900,
  });
  emit({
    event: "worker.error",
    code: "DEPENDENCY_UNAVAILABLE",
    method: "CreateSandbox",
    grpcStatus: 3,
    validationCategory: "UNKNOWN",
  });
  // A graceful shutdown that aborts a pass is no failure (finding 1040).
  emit({
    event: "worker.pass-interrupted",
    workId: "agent_revision:rev_test:reconcile",
    attempt: 1,
    operation: "agent_revision.reconcile",
    cause: "WorkerStopping",
  });

  assert.deepEqual(
    output.lines.map(({ event, severity }) => ({ event, severity })),
    [
      { event: "worker.health", severity: "DEBUG" },
      { event: "worker.completed", severity: "INFO" },
      { event: "worker.completed", severity: "INFO" },
      { event: "worker.error", severity: "ERROR" },
      { event: "worker.pass-interrupted", severity: "INFO" },
    ],
  );
  assert.equal(output.lines.at(-1).cause, "WorkerStopping");
  const failure = output.lines.find((line) => line.event === "worker.error");
  assert.equal(failure.method, "CreateSandbox");
  assert.equal(failure.grpcStatus, 3);
  assert.equal(failure.validationCategory, "UNKNOWN");
  const completed = output.lines.find((line) => line.event === "worker.completed");
  assert.equal(completed.workId, "namespace:ns_test:reconcile:ready");
  assert.equal(completed.attempt, 1);
  assert.equal(completed.operation, "namespace.ensure");
  // Deployment phase timing survives sanitization for operators and log queries.
  const deployed = output.lines.find((line) => line.workId === "agent_revision:rev_test:reconcile");
  assert.deepEqual(
    {
      durationMs: deployed.durationMs,
      deployPasses: deployed.deployPasses,
      prepareMs: deployed.prepareMs,
      readinessWaitMs: deployed.readinessWaitMs,
      activationMs: deployed.activationMs,
      elapsedMs: deployed.elapsedMs,
    },
    {
      durationMs: 120,
      deployPasses: 3,
      prepareMs: 450,
      readinessWaitMs: 2100,
      activationMs: 80,
      elapsedMs: 2900,
    },
  );
});

test("worker stop-yield counts survive local JSON logging on pending and completed passes", () => {
  const output = memoryDestination();
  const emit = createWorkerLogEmitter(
    createOccLogger({ component: "occ-worker", destination: output.destination }),
  );

  // These are the completion shapes emitted when a predecessor drain yields,
  // then finishes. Keep the count visible after the production sanitizer runs.
  for (const [code, outcome, stopYields] of [
    ["PREDECESSOR_STOP_YIELDED", "pending", 1],
    ["REVISION_ACTIVATED", "success", 3],
  ]) {
    emit({
      event: "worker.completed",
      workId: "agent_revision:rev_test:reconcile",
      attempt: 1,
      operation: "agent_revision.reconcile",
      code,
      outcome,
      stopYields,
    });
  }
  assert.deepEqual(
    output.lines.map(({ code, outcome, stopYields }) => ({ code, outcome, stopYields })),
    [
      { code: "PREDECESSOR_STOP_YIELDED", outcome: "pending", stopYields: 1 },
      { code: "REVISION_ACTIVATED", outcome: "success", stopYields: 3 },
    ],
  );

  for (const stopYields of [0, 1, 3, Number.MAX_SAFE_INTEGER]) {
    emit({ event: "worker.completed", stopYields });
    assert.equal(output.lines.at(-1).stopYields, stopYields);
    assert.equal(typeof output.lines.at(-1).stopYields, "number");
  }
  for (const stopYields of [-1, "3", true, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    emit({ event: "worker.completed", stopYields });
    assert.equal(Object.hasOwn(output.lines.at(-1), "stopYields"), false);
  }
});

test("worker log keeps fixed codes and route fences, and drops anything shaped otherwise", () => {
  const output = memoryDestination();
  const emit = createWorkerLogEmitter(
    createOccLogger({ component: "occ-worker", destination: output.destination }),
  );

  // The shapes the OpenShell Git runtime and the worker emit (finding 2244). The runtime's own
  // events go through its fixture logger in openshell-git-runtime.test.mjs.
  const kept = [
    {
      event: "worker.openshell-git-expiry",
      outcome: "pending",
      check: "reduced-generation-moved-across-provider-check",
      failure: "admission_limit",
    },
    {
      event: "worker.openshell-git-denied",
      reason: "ref_not_allowed",
      reasonCode: "route_blocked",
    },
    { event: "worker.openshell-git-route", status: "adopted", fence: 7 },
    { event: "worker.completed", code: "REPOSITORY_EXECUTION_UNVERIFIED", harnessState: "lost" },
  ];
  for (const event of kept) {
    emit(event);
    const line = output.lines.at(-1);
    for (const [key, value] of Object.entries(event)) {
      assert.equal(line[key], value, `${event.event} keeps ${key}`);
    }
  }

  // Every expiry step the runtime can report passes as a code.
  for (const check of OPENSHELL_GIT_EXPIRY_CHECKS) {
    emit({ event: "worker.openshell-git-expiry", outcome: "pending", check });
    assert.equal(output.lines.at(-1).check, check);
  }

  // Free text, a credential shape, an overlong value or a non-string never passes as a code;
  // a fence is a non-negative safe integer.
  const rejected = [
    ["check", "the detach is still pending"],
    ["failure", "connect ECONNREFUSED 10.0.0.1:443"],
    ["reasonCode", "sk-proj-abcdefghijklmnopqrstuvwx"],
    ["reasonCode", `r${"x".repeat(64)}`],
    ["harnessState", { state: "lost" }],
    ["failure", 14],
    ["fence", -1],
    ["fence", 1.5],
    ["fence", "3"],
    ["fence", Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [key, value] of rejected) {
    emit({ event: "worker.openshell-git-expiry", outcome: "pending", [key]: value });
    assert.equal(Object.hasOwn(output.lines.at(-1), key), false, `${key}: ${String(value)}`);
  }
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
