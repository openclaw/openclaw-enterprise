import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

// Production Fastify, OCC, filesystem Configuration and Native IAM. This does not claim
// PostgreSQL uniqueness, Kubernetes reconciliation or runtime deployment proof.
test("external ownership adopts once, freezes settings, preserves safety stop and releases by version", async (t) => {
  const f = await createConsoleAppFixture(t);
  await f.bootstrap();
  const ns = await f.createNamespace("managed-agents", { ready: true });
  const agent = await f.createAgent(ns.id, "managed-agent", {
    messages: { visibleReplies: "automatic" },
  });
  const path = `/namespaces/${ns.id}/agents/${agent.id}/management`;
  const observed = await f.request("GET", path);
  assert.equal(observed.status, 200);
  assert.equal(observed.data.management, null);
  const input = {
    sourceId: "controller-registration/resource-uid",
    expectedConfigurationId: observed.data.adoption.configurationId,
    expectedConfigurationGeneration: observed.data.adoption.configurationGeneration,
    expectedFingerprint: observed.data.adoption.fingerprint,
    expectedManagementVersion: 0,
  };

  // Retrying a request whose response was lost must not reacquire or increment ownership.
  const [first, replay] = await Promise.all([
    f.request("PUT", path, { body: input }),
    f.request("PUT", path, { body: input }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(first.data.management.version, 1);
  assert.deepEqual(first.data.management, replay.data.management);
  const unchanged = await f.request("GET", `/namespaces/${ns.id}/agents/${agent.id}`);
  assert.equal(unchanged.data.configurationId, agent.configurationId);
  assert.equal(unchanged.data.activeRevisionId, undefined);

  const config = `/namespaces/${ns.id}/configurations/${agent.configurationId}`;
  const conflicting = await f.request("PATCH", config, {
    body: { values: { messages: { visibleReplies: "message_tool" } }, expectedGeneration: 1 },
  });
  assert.equal(conflicting.status, 409);
  const otherOwner = await f.request("PUT", path, {
    body: { ...input, sourceId: "other-controller/resource-uid" },
  });
  assert.equal(otherOwner.status, 409);

  // Normal operate authority can stop the Agent; a reconciler must not undo that safety action.
  const stopped = await f.request("POST", `/namespaces/${ns.id}/agents/${agent.id}/stop`);
  assert.equal(stopped.status, 202);
  const paused = await f.request("GET", path);
  assert.equal(paused.data.management.suspended, true);
  assert.equal(paused.data.management.version, 2);
  const staleRelease = await f.request("DELETE", path, {
    body: { sourceId: input.sourceId, expectedVersion: 1 },
  });
  assert.equal(staleRelease.status, 409);
  const release = { sourceId: input.sourceId, expectedVersion: 2 };
  assert.equal((await f.request("DELETE", path, { body: release })).status, 200);
  assert.equal((await f.request("DELETE", path, { body: release })).status, 200);
  assert.equal((await f.request("PUT", path, { body: input })).status, 409);
  const editable = await f.request("PATCH", config, {
    body: { values: { messages: { visibleReplies: "automatic" } }, expectedGeneration: 1 },
  });
  assert.equal(editable.status, 200);
  assert.ok(f.auditSink.events.some((event) => event.kind === "mutation"));
});

test("adoption refuses an outdated reviewed Configuration and cannot bind another Namespace's Agent", async (t) => {
  const f = await createConsoleAppFixture(t);
  await f.bootstrap();
  const ns = await f.createNamespace("adoption-source", { ready: true });
  const other = await f.createNamespace("adoption-other", { ready: true });
  const agent = await f.createAgent(ns.id, "reviewed-agent");
  const path = `/namespaces/${ns.id}/agents/${agent.id}/management`;
  const snapshot = (await f.request("GET", path)).data.adoption;
  const input = {
    sourceId: "controller-registration/reviewed-uid",
    expectedConfigurationId: snapshot.configurationId,
    expectedConfigurationGeneration: snapshot.configurationGeneration,
    expectedFingerprint: snapshot.fingerprint,
    expectedManagementVersion: 0,
  };
  const write = await f.request(
    "PATCH",
    `/namespaces/${ns.id}/configurations/${agent.configurationId}`,
    { body: { values: { agents: { defaults: { skipBootstrap: true } } }, expectedGeneration: 1 } },
  );
  assert.equal(write.status, 200);
  assert.equal((await f.request("PUT", path, { body: input })).status, 409);
  const crossTenant = await f.request(
    "PUT",
    `/namespaces/${other.id}/agents/${agent.id}/management`,
    { body: input },
  );
  assert.equal(crossTenant.status, 404);
  assert.equal((await f.request("GET", path)).data.management, null);
});

test("an owned apply saves one Configuration generation and one deployment despite a repeated request", async (t) => {
  const f = await createConsoleAppFixture(t);
  await f.bootstrap();
  const ns = await f.createNamespace("apply-managed", { ready: true });
  const agent = await f.createAgent(ns.id, "apply-managed-agent");
  const path = `/namespaces/${ns.id}/agents/${agent.id}/management`;
  const adoption = (await f.request("GET", path)).data.adoption;
  const claim = await f.request("PUT", path, {
    body: {
      sourceId: "controller-registration/apply-uid",
      expectedConfigurationId: adoption.configurationId,
      expectedConfigurationGeneration: adoption.configurationGeneration,
      expectedFingerprint: adoption.fingerprint,
      expectedManagementVersion: 0,
    },
  });
  assert.equal(claim.status, 200);
  const apply = {
    sourceGeneration: 2,
    sourceId: "controller-registration/apply-uid",
    expectedVersion: 1,
    requestKey: "generation-2",
    desiredRuntimeState: "running",
    configuration: {
      values: {
        ...createHarnessConfiguration("openclaw", "gpt-5.1"),
        messages: { visibleReplies: "automatic" },
      },
    },
  };
  const first = await f.request("POST", `${path}/apply`, { body: apply });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await f.request("POST", `${path}/apply`, { body: apply });
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, first.data);
  assert.equal(first.data.adoption.configurationGeneration, 2);
  assert.equal(first.data.management.version, 2);
  const revisions = await f.request("GET", `/namespaces/${ns.id}/agents/${agent.id}/revisions`);
  assert.equal(revisions.status, 200);
  assert.equal(revisions.data.length, 1);
  const changedKey = await f.request("POST", `${path}/apply`, {
    body: { ...apply, configuration: { values: {} } },
  });
  assert.equal(changedKey.status, 409);
});
