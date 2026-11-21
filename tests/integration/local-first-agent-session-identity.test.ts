import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { nativeFirstAgentProofDiagnostic } from "../../scripts/ci/reporter.ts";
import {
  nativePlacementReadRetryable,
  nativeWorkerSessionPlacement,
} from "../helpers/local-first-agent-native-placement.ts";
import { collectNativeWorkerFailure } from "../helpers/local-first-agent-native.mjs";

// Exercise the same self-contained function after serialization into a controller.
const placementFromDescription = runInNewContext(
  `(${nativeWorkerSessionPlacement.toString()})`,
) as typeof nativeWorkerSessionPlacement;
const session = { key: "agent:main:identity-proof", sessionId: "owned-session" };
const ownedPlacement = { state: "active", environmentId: "owned-environment" };

test("native model failure reports only the bounded Credential Proxy refusal", () => {
  const project = (stage: string, audit: object) => {
    const diagnostic = nativeFirstAgentProofDiagnostic(stage, {
      credentialProxyAudit: "unsupported-operation",
      credentialProxyRule: 6,
      requestId: "private-fixture-request",
      ...audit,
    });
    assert.ok(diagnostic && "worker" in diagnostic);
    return diagnostic.worker;
  };
  assert.deepEqual(project("model-outcome", {}), {
    credentialProxyAudit: "unsupported-operation",
    credentialProxyRule: 6,
  });
  assert.deepEqual(project("model-outcome", { credentialProxyRule: "private-fixture" }), {
    credentialProxyAudit: "unsupported-operation",
  });
  assert.deepEqual(project("model-outcome", { credentialProxyRule: 256 }), {
    credentialProxyAudit: "unsupported-operation",
  });
  assert.deepEqual(project("model-outcome", { credentialProxyAudit: "ambiguous" }), {
    credentialProxyAudit: "ambiguous",
  });
  assert.deepEqual(project("model-history", {}), {});
});

test("native placement capture rejects foreign or missing identity before reading placement", () => {
  for (const sessionId of ["foreign-session", undefined]) {
    for (const initial of [undefined, ownedPlacement]) {
      let captured = initial;
      let placementReads = 0;
      const description = {
        session: {
          sessionId,
          get placement() {
            placementReads++;
            return { state: "failed", environmentId: "foreign-environment" };
          },
        },
      };

      // Assignment must not replace an earlier verified owner when identity fails.
      assert.throws(() => {
        captured = placementFromDescription(description, session.sessionId);
      }, /session identity mismatch/);
      assert.equal(placementReads, 0);
      assert.equal(captured, initial);
    }
  }
});

test("native placement capture preserves owned failure and later fresh diagnostics", async () => {
  const failedPlacement = {
    state: "failed",
    environmentId: "failed-environment",
    terminalReason: "Device worker bundle installation failed: gateway returned 403",
  };
  for (const refresh of ["foreign", "owned"] as const) {
    const environmentReads: string[] = [];
    const captured = placementFromDescription(
      { session: { sessionId: session.sessionId, placement: failedPlacement } },
      session.sessionId,
    );
    assert.equal(captured, failedPlacement);
    const worker = await collectNativeWorkerFailure({
      session,
      lastPlacement: captured,
      expectedNodeId: "owned-node",
      elapsedMs: 1,
      runId: undefined,
      outcome: undefined,
      error: undefined,
      request: async (method: string, params: { environmentId?: string }) => {
        if (method === "sessions.describe") {
          return {
            session: {
              sessionId: refresh === "owned" ? session.sessionId : "foreign-session",
              placement: ownedPlacement,
            },
          };
        }
        if (method === "environments.status") {
          environmentReads.push(params.environmentId!);
          return { id: params.environmentId };
        }
        assert.equal(method, "node.list");
        return { nodes: [] };
      },
    });

    // A foreign refresh retains the verified failure; an owned refresh supersedes it.
    assert.deepEqual(environmentReads, [
      refresh === "owned" ? "owned-environment" : "failed-environment",
    ]);
    assert.equal(worker.placementLookup, refresh === "owned" ? "fresh" : "fallback");
    assert.equal(worker.placementState, refresh === "owned" ? "active" : "failed");
    if (refresh === "foreign") {
      assert.equal(worker.terminalReason, "bundle-http-403");
    }
  }
});

test("native journal lookup requires a fresh unchanged placement for the acknowledged session", async () => {
  const placement = { ...ownedPlacement, activeOwnerEpoch: 6, generation: 8 };
  const acknowledged = { runId: "acknowledged-run", status: "started" };
  for (const [observedSessionId, observedPlacement, acknowledgement] of [
    [session.sessionId, placement, acknowledged],
    ["foreign-session", placement, acknowledged],
    [session.sessionId, { ...placement, generation: 9 }, acknowledged],
    [session.sessionId, { ...placement, activeOwnerEpoch: 7 }, acknowledged],
    [session.sessionId, placement, { ...acknowledged, runId: "foreign-run" }],
    [session.sessionId, placement, { ...acknowledged, status: "in_flight" }],
  ] as const) {
    const worker = await collectNativeWorkerFailure({
      session,
      lastPlacement: placement,
      expectedNodeId: undefined,
      elapsedMs: 1,
      runId: "acknowledged-run",
      outcome: { status: "error" },
      error: undefined,
      journalTurn: {
        acknowledgement,
        expectedRunId: acknowledged.runId,
        gatewayBootId: "acknowledging-gateway-boot",
      },
      request: async (method: string) => {
        switch (method) {
          case "sessions.describe":
            return { session: { sessionId: observedSessionId, placement: observedPlacement } };
          case "environments.status":
            return { id: placement.environmentId };
          case "node.list":
            return { nodes: [] };
          case "chat.history":
            return { messages: [] };
          default:
            throw new Error("Unexpected fixture read");
        }
      },
    });
    assert.deepEqual(
      worker.journalBinding,
      observedSessionId === session.sessionId &&
        observedPlacement === placement &&
        acknowledgement === acknowledged
        ? {
            gatewayBootId: "acknowledging-gateway-boot",
            sessionId: session.sessionId,
            environmentId: placement.environmentId,
            ownerEpoch: 6,
            generation: 8,
            runId: "acknowledged-run",
          }
        : undefined,
    );
  }
});

test("the native placement failure receipt distinguishes Gateway queue and catalog errors", async () => {
  const stage = "required-placement-describe-rejected";
  const catalog = "Error: Session model catalog is unavailable; refresh and try again.";
  const timeout = {
    code: "UNAVAILABLE",
    retryable: true,
    details: { reason: "request-start-timeout", private: "private-fixture" },
    message: "private-fixture",
  };
  const reportedReason = (worker: object): unknown => {
    const diagnostic = nativeFirstAgentProofDiagnostic(stage, worker);
    assert.ok(diagnostic && "worker" in diagnostic);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-fixture/);
    return "placementReadFailure" in diagnostic.worker
      ? diagnostic.worker.placementReadFailure
      : undefined;
  };
  for (const [error, correlated, expected] of [
    [timeout, true, "request-start-timeout"],
    [{ code: "UNAVAILABLE", message: catalog }, true, "session-model-catalog-unavailable"],
    [{ ...timeout, retryable: false }, true, "other"],
    [{ ...timeout, details: { reason: "private-fixture" } }, true, "other"],
    [{ code: "UNAVAILABLE", message: catalog + " private-fixture" }, true, "other"],
    [{ ...timeout, code: "FORBIDDEN" }, true, undefined],
    [timeout, false, undefined],
  ] as const) {
    assert.equal(nativePlacementReadRetryable(error, correlated), false);
    const worker = await collectNativeWorkerFailure({
      session: undefined,
      lastPlacement: undefined,
      expectedNodeId: undefined,
      elapsedMs: 1,
      runId: undefined,
      outcome: undefined,
      error,
      placementReadResponse: correlated,
      request: async () => ({ nodes: [] }),
    });
    assert.equal(reportedReason(worker), expected);
  }
  assert.equal(reportedReason({ placementReadFailure: "private-fixture" }), "other");
});
