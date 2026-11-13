import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { OPENSHELL_GIT_EXPIRY_CHECKS } from "../../apps/controller/src/drivers/egress-proxy/openshell-expired-git.ts";
import { occLogLine } from "../helpers/occ-log-line.ts";
import { captureLogs, logAt } from "./common-logging-output.ts";

export function registerWorkerCases(): void {
  test("worker emitter reports health at debug and failures at error", () => {
    const output = captureLogs("occ-worker", "debug");
    const emit = createWorkerLogEmitter(output.logger);

    emit({ event: "worker.health", pending: 0 });
    emit({
      event: "worker.completed",
      workId: "namespace:ns_test:reconcile:ready",
      attempt: 1,
      operation: "namespace.ensure",
      namespaceId: "ns_test",
      outcome: "success",
    });
    const deploymentCompletion = {
      event: "worker.completed",
      workId: "agent_revision:rev_test:reconcile",
      attempt: 1,
      operation: "agent_revision.reconcile",
      namespaceId: "ns_test",
      agentId: "agt_test",
      revisionId: "rev_test",
      result: "success",
      outcome: "success",
      code: "REVISION_ACTIVATED",
      durationMs: 125.25,
      deployPasses: 3,
      prepareMs: 450,
      readinessWaitMs: 2100,
      activationMs: 80,
      elapsedMs: 2900.123456,
    };
    emit(deploymentCompletion);
    emit({
      event: "worker.error",
      code: "DEPENDENCY_UNAVAILABLE",
      method: "CreateSandbox",
      grpcStatus: 9,
      validationCategory: "PVC_ADMISSION_LABELS",
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
    assert.equal(logAt(output.lines, -1).cause, "WorkerStopping");
    const failure = output.lines.find((line) => line.event === "worker.error");
    assert.ok(failure);
    assert.equal(failure.method, "CreateSandbox");
    assert.equal(failure.grpcStatus, 9);
    assert.equal(failure.validationCategory, "PVC_ADMISSION_LABELS");
    const completed = output.lines.find((line) => line.event === "worker.completed");
    assert.ok(completed);
    assert.equal(completed.workId, "namespace:ns_test:reconcile:ready");
    assert.equal(completed.attempt, 1);
    assert.equal(completed.operation, "namespace.ensure");
    // Deployment phase timing survives sanitization for operators and log queries.
    const deployed = output.lines.find(
      (line) => line.workId === "agent_revision:rev_test:reconcile",
    );
    assert.ok(deployed);
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
        durationMs: 125.25,
        deployPasses: 3,
        prepareMs: 450,
        readinessWaitMs: 2100,
        activationMs: 80,
        elapsedMs: 2900.123456,
      },
    );

    // Work age advances on the monotonic clock and can retain sub-millisecond precision.
    for (const elapsedMs of [2900, 0, Number.MAX_SAFE_INTEGER]) {
      emit({ ...deploymentCompletion, elapsedMs });
      assert.equal(logAt(output.lines, -1).elapsedMs, elapsedMs);
      assert.equal(typeof logAt(output.lines, -1).elapsedMs, "number");
    }
    for (const elapsedMs of [-1, -0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      emit({ ...deploymentCompletion, elapsedMs });
      assert.equal(
        Object.hasOwn(logAt(output.lines, -1), "elapsedMs"),
        false,
        `elapsedMs: ${String(elapsedMs)}`,
      );
    }

    // Allowing fractional work ages must not allow fractional attempt or deployment counts.
    emit({ ...deploymentCompletion, attempt: 1.5, deployPasses: 3.5, stopYields: 1.5 });
    const fractionalCounts = logAt(output.lines, -1);
    assert.equal(Object.hasOwn(fractionalCounts, "attempt"), false);
    assert.equal(Object.hasOwn(fractionalCounts, "deployPasses"), false);
    assert.equal(Object.hasOwn(fractionalCounts, "stopYields"), false);
    assert.equal(fractionalCounts.elapsedMs, 2900.123456);
    assert.equal(fractionalCounts.durationMs, 125.25);
  });

  test("worker stop-yield counts survive local JSON logging on pending and completed passes", () => {
    const output = captureLogs("occ-worker");
    const emit = createWorkerLogEmitter(output.logger);

    // These are the completion shapes emitted when a predecessor drain yields,
    // then finishes. Keep the count visible after the production sanitizer runs.
    for (const [code, outcome, stopYields] of [
      ["PREDECESSOR_STOP_YIELDED", "pending", 1],
      ["REVISION_ACTIVATED", "success", 3],
    ] as const) {
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
      assert.equal(logAt(output.lines, -1).stopYields, stopYields);
      assert.equal(typeof logAt(output.lines, -1).stopYields, "number");
    }
    for (const stopYields of [-1, "3", true, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      emit({ event: "worker.completed", stopYields });
      assert.equal(Object.hasOwn(logAt(output.lines, -1), "stopYields"), false);
    }
  });

  test("worker log keeps fixed codes and route fences, and drops anything shaped otherwise", () => {
    const output = captureLogs("occ-worker");
    const emit = createWorkerLogEmitter(output.logger);

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
      {
        event: "worker.error",
        code: "PREPARED_GITHUB_ISSUANCE_DIAGNOSTIC",
        attemptId: randomUUID(),
        stage: "publication",
        firstFailureStage: "validation",
        errorClass: "validation-failed",
        httpStatus: 401,
        responseComplete: true,
        candidateIdentified: false,
        requestEndCalled: true,
        admissionCurrent: true,
        inBounds: true,
        stale: false,
        clockTolerance: true,
        validationKind: "reauthorization-required",
        validationCode: "authority-unavailable",
        publication: "unknown",
      },
    ];
    for (const event of kept) {
      emit(event);
      const line = logAt(output.lines, -1);
      for (const [key, value] of Object.entries(event)) {
        assert.equal(line[key], value, `${event.event} keeps ${key}`);
      }
    }

    // Every expiry step the runtime can report passes as a code.
    for (const check of OPENSHELL_GIT_EXPIRY_CHECKS) {
      emit({ event: "worker.openshell-git-expiry", outcome: "pending", check });
      assert.equal(logAt(output.lines, -1).check, check);
    }

    // Free text, a credential shape, an overlong value or a non-string never passes as a code;
    // a fence is a non-negative safe integer.
    const rejected: ReadonlyArray<readonly [field: string, value: unknown]> = [
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
      ["httpStatus", "401"],
      ["httpStatus", 99],
      ["httpStatus", 600],
      ["responseComplete", "true"],
      ["candidateIdentified", "sentinel-secret"],
      ["requestEndCalled", 1],
      ["firstFailureStage", "sentinel private message"],
      ["validationCode", "sentinel private message"],
    ];
    for (const [key, value] of rejected) {
      emit({ event: "worker.openshell-git-expiry", outcome: "pending", [key]: value });
      assert.equal(Object.hasOwn(logAt(output.lines, -1), key), false, `${key}: ${String(value)}`);
    }
  });
}

export function registerBootstrapAttemptCase(): void {
  test("a bootstrap attempt keeps OCC-assigned IDs only in their own format", () => {
    // The IDs a failed bootstrap names (finding 2246): the Installation and the administrator
    // Principal and service Principal OCC assigns for it.
    const ids = {
      installationId: `ins_${randomUUID()}`,
      principalId: `prn_${randomUUID()}`,
      servicePrincipalId: `spn_${randomUUID()}`,
    };
    const failed = (attempt: Readonly<Record<string, unknown>>) =>
      occLogLine({ event: "installation.bootstrap-failed", code: "X", attempt }).attempt;
    const attempt = { ...ids, authAccountId: "abc123", serviceKeyId: "key123" };
    assert.deepEqual(failed(attempt), attempt);

    const rejected: ReadonlyArray<readonly [field: keyof typeof ids, value: unknown]> = [
      ["installationId", "ins_production"],
      ["installationId", ids.principalId],
      ["installationId", ids.installationId.toUpperCase()],
      ["installationId", `${ids.installationId}\n`],
      ["installationId", 7],
      ["principalId", "prn_admin"],
      ["principalId", ids.servicePrincipalId],
      ["principalId", `${ids.principalId}-extra`],
      ["servicePrincipalId", "spn_bootstrap"],
      ["servicePrincipalId", ids.installationId],
    ];
    for (const [key, value] of rejected) {
      const { [key]: _dropped, ...kept } = attempt;
      assert.deepEqual(
        failed({ ...attempt, [key]: value }),
        kept,
        `${key}: ${JSON.stringify(value)}`,
      );
    }
  });
}
