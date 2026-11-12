import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { waitFor } from "./qa-utils.mjs";

/** Existing real Agent workflow; this proves OCC management, not Argo or Operator watches. */
export async function verifyQaExternalManagement(f, agent) {
  if (f.controlPlane === "kubernetes" && agent.preset === "Codex") {
    await verifyManagedCreation(f, agent);
  }
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

/** Create through the shipped provisioning caller; keep the source Agent's channels untouched. */
async function verifyManagedCreation(f, original) {
  const namespaceId = original.namespaceId;
  const namespace = `/namespaces/${namespaceId}`;
  const current = await f.api("GET", `${namespace}/agents/${original.id}`);
  const configuration = await f.api(
    "GET",
    `${namespace}/configurations/${current.configurationId}`,
  );
  const values = structuredClone(configuration.values);
  delete values.channels;
  // A second Agent must not start another poller/listener with the source bot's credentials.
  for (const channel of ["telegram", "slack"]) {
    if (values.plugins?.entries) {
      delete values.plugins.entries[channel];
    }
    if (Array.isArray(values.plugins?.allow)) {
      values.plugins.allow = values.plugins.allow.filter((id) => id !== channel);
    }
  }
  const requestId = `req_${randomUUID()}`;
  const sourceId = `qa-created/${randomUUID()}`;
  const recovery = `${namespace}/agents/provision/requests/${requestId}`;
  let created;
  try {
    await f.api("POST", `${namespace}/agents/provision`, {
      requestId,
      name: `managed-created-${randomUUID().slice(0, 8)}`,
      executionMode: "dedicated",
      nativeAdmin: true,
      externalManagement: { sourceId, sourceGeneration: 1 },
      configuration: { kind: "agent", values },
      harnessAuth: current.harnessAuth,
    });
    const first = await f.api("GET", recovery);
    const status = await waitFor(
      "managed creation and its first real deployment",
      async () => {
        const job = await f.api("GET", recovery);
        assert.equal(job.workId, first.workId);
        assert.notEqual(job.status, "failed", "managed creation failed");
        return job.status === "succeeded" ? job : false;
      },
      600_000,
    );
    const live = await f.api("GET", `${namespace}/agents/${status.agentId}`);
    assert.equal(live.activeRevisionId, status.revisionId);
    created = { ...live, revision: { id: status.revisionId } };
    f.agents.push(created);
    const revisions = await f.api("GET", `${namespace}/agents/${created.id}/revisions`);
    assert.equal(revisions.length, 1, "creation admits only the initial revision");
    const owner = await f.api("GET", `${namespace}/agents/${created.id}/management`);
    assert.equal(owner.management.sourceId, sourceId);
    assert.equal(owner.management.requestedRevisionId, status.revisionId);
    const nonce = `CREATED_${randomUUID()}`;
    await original.native.normalGatewayTurn({
      agent: created,
      prompt: `Reply with exactly ${nonce}`,
      expectedPatterns: [new RegExp(nonce)],
    });
    assert.equal((await f.api("GET", recovery)).agentId, created.id);
  } catch (error) {
    if (created === undefined) {
      f.retained = true;
    }
    throw error;
  } finally {
    if (created !== undefined) {
      const base = `${namespace}/agents/${created.id}`;
      const owner = await f.api("GET", `${base}/management`);
      await f.api("DELETE", `${base}/management`, {
        sourceId,
        expectedVersion: owner.management.version,
      });
      await f.api("POST", `${base}/stop`);
      await waitFor(
        "created Agent cleanup to stop its runtime",
        async () => !(await f.api("GET", base)).activeRevisionId,
        600_000,
      );
      created.stopped = true;
    }
  }
}
