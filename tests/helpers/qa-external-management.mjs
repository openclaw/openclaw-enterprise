import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { waitFor } from "./qa-utils.mjs";

/** Existing real Agent workflow; this proves OCC management, not Argo or Operator watches. */
export async function verifyQaExternalManagement(f, agent) {
  const base = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  const path = `${base}/management`;
  const sourceId = `qa-controller/${randomUUID()}`;
  const reviewed = await f.api("GET", path);
  const snapshot = reviewed.adoption;
  await f.api("PUT", path, {
    sourceId,
    expectedConfigurationId: snapshot.configurationId,
    expectedConfigurationGeneration: snapshot.configurationGeneration,
    expectedActiveRevisionId: snapshot.activeRevisionId,
    expectedFingerprint: snapshot.fingerprint,
    expectedManagementVersion: 0,
  });
  try {
    const configuration = await f.api(
      "GET",
      `/namespaces/${agent.namespaceId}/configurations/${snapshot.configurationId}`,
    );
    const visibleReplies =
      configuration.values.messages?.visibleReplies === "automatic" ? "message_tool" : "automatic";
    const input = {
      sourceId,
      sourceGeneration: 2,
      expectedVersion: 1,
      requestKey: "generation-2",
      desiredRuntimeState: "running",
      configuration: {
        values: {
          ...configuration.values,
          messages: { ...configuration.values.messages, visibleReplies },
        },
        secretBindings: configuration.secretBindings ?? {},
      },
    };
    const changed = await f.api("POST", `${path}/apply`, input);
    assert.equal(changed.adoption.configurationGeneration, snapshot.configurationGeneration + 1);
    const revisionId = changed.management.requestedRevisionId;
    assert.ok(revisionId);
    assert.notEqual(revisionId, snapshot.activeRevisionId);
    const replay = await f.api("POST", `${path}/apply`, input);
    assert.deepEqual(replay, changed);
    // Wait on the real worker and exact revision, not on the successful apply receipt.
    await waitFor(
      "managed Agent revision and runtime",
      async () => {
        const status = await f.api("GET", `${base}/deployments/${revisionId}`);
        assert.notEqual(status.status, "failed", "managed deployment failed");
        if (status.status !== "succeeded") {
          return false;
        }
        const runtime = await f.api("GET", `${base}/deployments/${revisionId}/runtime`);
        return (
          runtime.revisionId === revisionId &&
          runtime.pods.some((pod) => pod.role === "gateway") &&
          runtime.pods.some((pod) => pod.role === "agent") &&
          runtime.pods.every((pod) => pod.ready && pod.phase === "Running")
        );
      },
      600_000,
    );
    agent.revision = { ...agent.revision, id: revisionId };
    const nonce = `MANAGED_${randomUUID()}`;
    await agent.native.normalGatewayTurn({
      agent,
      prompt: `Reply with exactly ${nonce}`,
      expectedPatterns: [new RegExp(nonce)],
    });
    const current = await f.api("GET", base);
    assert.equal(current.activeRevisionId, revisionId);
    const denied = await fetch(
      f.apiUrl + `/namespaces/${agent.namespaceId}/configurations/${configuration.id}`,
      {
        method: "PATCH",
        headers: { "x-api-key": f.serviceKey, "content-type": "application/json" },
        body: JSON.stringify({
          values: configuration.values,
          expectedGeneration: changed.adoption.configurationGeneration,
        }),
      },
    );
    assert.equal(denied.status, 409, "ordinary writes must not compete with external management");
  } finally {
    const current = await f.api("GET", path);
    await f.api("DELETE", path, { sourceId, expectedVersion: current.management.version });
  }
}
