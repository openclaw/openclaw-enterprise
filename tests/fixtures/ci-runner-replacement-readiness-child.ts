import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";

import {
  observeWorkspaceNodeRead,
  recordWorkspaceNodeObservation,
} from "../../apps/controller/src/gateway/workspace-node-observation.ts";
import { createKubernetesClient, diagnosticDeadlinePassed } from "../helpers/kubernetes-real.ts";
import { waitForReplacementActivation } from "../helpers/openshell-sandbox-workflows.mjs";
import { createReplacementNodeObservation } from "../helpers/openshell-workspace-node-observation.ts";

test("long failure", async (t) => {
  const receipt = createReplacementNodeObservation();
  let reads = 0;
  const driver = receipt.wrap({
    async prepareRevision(
      revision: { id: string },
      observation: Parameters<typeof recordWorkspaceNodeObservation>[0],
    ) {
      const ready = await observeWorkspaceNodeRead(revision.id, async () => {
        reads++;
        recordWorkspaceNodeObservation(observation);
        return observation === "accepted";
      });
      return { ready, pendingReason: ready ? undefined : "WORKSPACE_NODE_PENDING" };
    },
  });
  const replacement = { id: "replacement" };
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  syncBuiltinESMExports();
  const client = createKubernetesClient({
    selection: {},
    kubectl: () => assert.fail("unexpected cluster call"),
  });
  let agentReads = 0;
  let deploymentReads = 0;
  let timeout: unknown;
  let originalStack: string | undefined;
  const descriptions: unknown[] = [];
  const namespaceId = "ns";
  const agent = { id: "agent" };
  const agentPath = `/namespaces/${namespaceId}/agents/${agent.id}`;
  const deploymentPath = `${agentPath}/deployments/${replacement.id}`;
  const topology = {
    namespaceId,
    agent,
    replacementNode: receipt,
    async request(method: "GET", path: string) {
      assert.equal(method, "GET");
      if (path === deploymentPath) {
        assert.equal(agentReads, deploymentReads + 1);
        // Temporary deployment read failures must use the same activation deadline.
        const transientStatus = [408, 429, 503][deploymentReads];
        deploymentReads++;
        if (transientStatus !== undefined) {
          return { status: transientStatus };
        }
        return { status: 200, data: { status: "running" } };
      }
      assert.equal(path, agentPath);
      agentReads++;
      return { status: 200, data: { activeRevisionId: "previous" } };
    },
    async diagnoseRevision() {
      await driver.prepareRevision(replacement, "no confirmed device");
      // This worker finishes just after its deadline. Its late result cannot delay description.
      await delay(60_001);
      return {};
    },
  };

  const poll: typeof client.waitFor = async (description, operation, timeoutMs) => {
    // Only the last pending decision from the exact replacement belongs in the diagnostic.
    await driver.prepareRevision(replacement, "no confirmed device");
    await driver.prepareRevision(replacement, "disconnected");
    await driver.prepareRevision({ id: "other" }, "no confirmed device");
    await driver.prepareRevision(replacement, "accepted");
    try {
      return await client.waitFor(description, operation, timeoutMs);
    } catch (error) {
      assert.ok(error instanceof Error);
      originalStack = error.stack;
      timeout = error;
      throw error;
    }
  };
  const completion = waitForReplacementActivation(
    topology,
    { data: replacement },
    t,
    poll,
    async (_topology, _revision, worker: unknown) => {
      descriptions.push({ at: Date.now(), expired: diagnosticDeadlinePassed(), worker });
      await turn();
      return "\nWorker read timed out.";
    },
  ).catch((error: unknown) => error);
  await turn();
  for (let interval = 0; interval < 320; interval++) {
    t.mock.timers.tick(750);
    await turn();
  }
  assert.deepEqual([Date.now(), agentReads, deploymentReads, reads], [240_000, 321, 321, 5]);
  t.mock.timers.tick(60_000);
  await turn();
  t.mock.timers.tick(1);
  const failure: unknown = await completion;
  assert.deepEqual(descriptions, [{ at: 300_000, expired: false, worker: undefined }]);
  assert.equal(failure, timeout);
  assert.ok(failure instanceof Error);
  assert.equal(failure.stack, originalStack);
  throw failure;
});
