import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkerLogEmitter,
  emitOccLogEvent,
  MAX_LOGGED_IDENTIFIERS,
  skippedUserLogFields,
} from "../../apps/controller/src/logging.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { captureLogs, logAt } from "./common-logging-output.ts";

// The JavaScript fixture defaults the protocol and path but takes raw credential parts.
const preparationCredentialUrl: (options: {
  protocol?: string;
  username: string;
  password: string;
  host: string;
  port: undefined;
  pathname?: string;
}) => string = syntheticCredentialUrl;

export function registerEventCases(): void {
  test("OCC logger emits structured severity and filters below the configured level", () => {
    const output = captureLogs("occ-test", "warn");
    const { logger } = output;

    logger.info({ event: "dropped.info" });
    logger.warn({ event: "kept.warn", requestId: "req_test" });

    assert.equal(output.lines.length, 1);
    assert.equal(logAt(output.lines, 0).event, "kept.warn");
    assert.equal(logAt(output.lines, 0).severity, "WARN");
    assert.equal(logAt(output.lines, 0).service, "occ-test");
    assert.equal(Object.hasOwn(logAt(output.lines, 0), "level"), false);
  });

  test("OCC event severity mapping treats failed diagnostics as errors and warnings as warnings", () => {
    const output = captureLogs("occ-script", "info");
    const { logger } = output;

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
      logAt(output.lines, 2).message,
      "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
    );
  });

  test("a limited sign-in lane logs a warning with its lane and hashed key only", () => {
    const output = captureLogs("occ-api", "info");
    const { logger } = output;

    emitOccLogEvent(logger, {
      event: "authentication.sign-in-limited",
      lane: "email",
      keyHash: "0123456789abcdef",
      email: "victim@example.test",
      clientAddress: "203.0.113.7",
    });

    assert.equal(output.lines.length, 1);
    const { time, ...line } = logAt(output.lines, 0);
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
    const output = captureLogs("occ-worker", "info");
    const { logger } = output;

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
        installationId: "ins_2c7a3b6e-41f0-4d1b-9a8e-5f3c2d1e0b9a",
        serviceKeyFile: "/tmp/common-otel-swarm/occ/service-key.json",
        passwordFile: "/tmp/common-otel-swarm/occ/password.txt",
        serviceKeyId: "key_safe",
        arbitrary: "dropped",
        unsafe: "Bearer token-that-must-not-log",
      },
    });

    assert.equal(output.lines.length, 2);
    assert.equal(logAt(output.lines, 0).attempt, 2);
    assert.equal(logAt(output.lines, 0).code, "WORKER_UNAVAILABLE");
    assert.deepEqual(logAt(output.lines, 1).attempt, {
      installationId: "ins_2c7a3b6e-41f0-4d1b-9a8e-5f3c2d1e0b9a",
      serviceKeyFile: "/tmp/common-otel-swarm/occ/service-key.json",
      passwordFile: "/tmp/common-otel-swarm/occ/password.txt",
      serviceKeyId: "key_safe",
    });
    assert.equal(Object.hasOwn(logAt(output.lines, 0), "error"), false);
    assert.equal(Object.hasOwn(logAt(output.lines, 0), "message"), false);
    assert.equal(Object.hasOwn(logAt(output.lines, 0), "secret"), false);
    assert.equal(Object.hasOwn(logAt(output.lines, 0), "grpcStatus"), false);
    assert.equal(Object.hasOwn(logAt(output.lines, 0), "validationCategory"), false);
    assert.equal(JSON.stringify(output.lines).includes("token-that-must-not-log"), false);
    assert.equal(JSON.stringify(output.lines).includes("arbitrary"), false);
  });

  test("Compute preparation diagnostics keep reviewed context and reject secret-bearing text", () => {
    const output = captureLogs("occ-worker", "info");

    const emit = createWorkerLogEmitter(output.logger);

    emit({
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
    emit({
      event: "worker.compute-prepare-failed",
      code: "KUBERNETES_PREPARATION_FAILED",
      step: "sandbox_provision",
      candidatePreparationReached: "token-that-must-not-log",
      message: "Bearer token-that-must-not-log",
    });

    assert.equal(output.lines.length, 2);
    const { time, ...diagnostic } = logAt(output.lines, 0);
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
    assert.equal(Object.hasOwn(logAt(output.lines, 1), "message"), false);
    assert.equal(Object.hasOwn(logAt(output.lines, 1), "candidatePreparationReached"), false);
    assert.equal(JSON.stringify(output.lines).includes("token-that-must-not-log"), false);

    // A trusted Driver can accidentally return a printable URI in a preparation
    // diagnostic. The real worker emitter must contain it before writing stdout.
    const messages = [
      preparationCredentialUrl({
        protocol: "postgres",
        username: "fixture-user",
        password: ["invented", "fixture"].join("/"),
        host: "database.invalid",
        port: undefined,
        pathname: "/fixture",
      }),
      preparationCredentialUrl({
        username: "fixture-user",
        password: "invented-fixture",
        host: "service.invalid",
        port: undefined,
      }),
    ];
    for (const message of messages) {
      const recordCount: number = output.lines.length;
      emit({
        event: "worker.compute-prepare-failed",
        workId: "agent_revision:rev_test:reconcile",
        operation: "agent_revision.reconcile",
        namespaceId: "ns_test",
        agentId: "agt_test",
        revisionId: "rev_test",
        code: "KUBERNETES_API_REJECTED",
        step: "gateway_deployment",
        message,
      });
      assert.equal(output.lines.length, recordCount + 1);
      const line = logAt(output.lines, recordCount);
      assert.equal(line.event, "worker.compute-prepare-failed");
      assert.equal(line.severity, "ERROR");
      assert.equal(line.service, "occ-worker");
      assert.equal(line.workId, "agent_revision:rev_test:reconcile");
      assert.equal(line.operation, "agent_revision.reconcile");
      assert.equal(line.namespaceId, "ns_test");
      assert.equal(line.agentId, "agt_test");
      assert.equal(line.revisionId, "rev_test");
      assert.equal(line.code, "KUBERNETES_API_REJECTED");
      assert.equal(line.step, "gateway_deployment");
      assert.equal(Object.hasOwn(line, "message"), false, "unsafe URI diagnostic is absent");
      assert.equal(JSON.stringify(output.lines).includes(message), false);
    }
  });

  test("activation warning caps skipped account IDs and reports the total and truncation", () => {
    const output = captureLogs("occ-api", "info");
    const { logger } = output;
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `user_${String(index).padStart(4, "0")}`);

    for (const skipped of [ids(1), ids(MAX_LOGGED_IDENTIFIERS), ids(MAX_LOGGED_IDENTIFIERS + 1)]) {
      emitOccLogEvent(logger, {
        event: "authentication.activation-warning",
        ...skippedUserLogFields(skipped),
      });
    }

    assert.equal(output.lines.length, 3);
    assert.deepEqual(
      output.lines.map(
        ({ severity, skippedUserIds, skippedUserCount, skippedUserIdsTruncated }) => {
          const loggedIds: unknown = skippedUserIds;
          assert.ok(Array.isArray(loggedIds));
          const entries: readonly unknown[] = loggedIds;
          return { severity, ids: entries.length, skippedUserCount, skippedUserIdsTruncated };
        },
      ),
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
    assert.deepEqual(logAt(output.lines, 2).skippedUserIds, ids(MAX_LOGGED_IDENTIFIERS));
  });
}
