import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  collectNativeWorkerFailure,
  nativeWorkerSessionPlacement,
} from "../helpers/local-first-agent-native.mjs";

// Exercise the same self-contained function after serialization into a controller.
const placementFromDescription = runInNewContext(
  `(${nativeWorkerSessionPlacement.toString()})`,
) as typeof nativeWorkerSessionPlacement;
const session = { key: "agent:main:identity-proof", sessionId: "owned-session" };
const ownedPlacement = { state: "active", environmentId: "owned-environment" };

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
