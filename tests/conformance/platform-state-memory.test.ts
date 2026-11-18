import assert from "node:assert/strict";
import test from "node:test";
import type { RequestCredentialInput } from "../../packages/contracts/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import {
  completeAgentDeletion,
  isolateRevisionHistory,
  refuseGrantsAfterDeletion,
  refuseInvalidBackendIds,
} from "./platform-state-memory-cases.ts";
import { verifyPlatformStateStoreContract } from "./platform-state-store.contract.ts";
import { seedSessionRevision } from "./repository-sessions.contract.ts";

test(
  "memory policy refuses new grants to an Agent after deletion admission",
  refuseGrantsAfterDeletion,
);
test(
  "memory Agent deletion completion removes the AccessBindings the PostgreSQL finalizer removes",
  completeAgentDeletion,
);
test("the memory platform state adapter satisfies the shared ownership and atomicity contract", async () => {
  await verifyPlatformStateStoreContract(new InMemoryPlatformState());
});
test(
  "memory revision histories stay isolated across committed and rolled-back appends",
  isolateRevisionHistory,
);
test(
  "memory state refuses an Agent backendId outside the API's Backend ID rule",
  refuseInvalidBackendIds,
);

test("concurrent memory approval operations reserve, approve and consume one request once", async () => {
  const store = new InMemoryPlatformState();
  const { namespace, agent, revision } = await seedSessionRevision(store);
  const driver = { id: "model", implementation: "fixture", configurationId: "a".repeat(64) };
  const execution = { namespaceId: namespace.id, agentId: agent.id, revisionId: revision.id };
  const now = "2026-01-01T00:00:00.000Z";
  const deadlineAt = "2026-01-01T00:00:10.000Z";
  const replayUntilAt = "2026-01-01T00:00:20.000Z";
  const grant = { recipientId: "sandbox", requestId: "request", bindingId: "binding", deadlineAt };
  const request: RequestCredentialInput = {
    ...grant,
    recipient: { id: grant.recipientId },
    execution,
    replayUntilAt,
    http: {
      target: {
        reportedScheme: "https",
        host: "example.com",
        port: 443,
        path: "/v1/responses",
        query: "",
        method: "POST",
      },
      headers: [],
      body: new Uint8Array(),
    },
  };
  const policyDigest = "b".repeat(64);
  const approval = { ...grant, execution, driver, replayUntilAt, policyDigest };
  await store.transactReadCommitted(async ({ requestCredentialApprovals: approvals }) => {
    const insert = () => approvals.insert(approval, now, { requestIds: 3, sandboxRequestIds: 3 });
    assert.deepEqual((await Promise.all([insert(), insert()])).sort(), ["refused", "reserved"]);
    assert.equal(await approvals.consume(grant, driver, now), undefined);
    const approve = () => approvals.approve(request, driver, policyDigest, now);
    assert.deepEqual((await Promise.all([approve(), approve()])).sort(), [false, true]);
    const consume = () => approvals.consume(grant, driver, now);
    assert.equal((await Promise.all([consume(), consume()])).filter(Boolean).length, 1);
    assert.equal(await insert(), "refused");
  });
});
