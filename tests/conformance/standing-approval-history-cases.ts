import assert from "node:assert/strict";
import test from "node:test";
import {
  ResourceConflictError,
  ResourceStateConflictError,
} from "../../packages/occ/src/errors.ts";
import type { RepositoryStandingApproval } from "../../packages/occ/src/ports/repository-sessions.ts";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/repository-approval.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { repositoryBinding } from "../fixtures/repository-credentials/session-state.mjs";

test("in-memory standing approvals retain scoped history across revocation and re-grant", async () => {
  const state = new InMemoryPlatformState();
  const input = {
    id: "approval-original",
    namespaceId: "namespace-a",
    agentId: "agent-a",
    binding: repositoryBinding(),
    scope: { maximumSessionDurationSeconds: 60 },
    approvedBy: "operator-a",
    createdAt: "2030-03-17T17:46:40.000Z",
  };
  const original = {
    ...input,
    scopeFingerprint: repositoryApprovalFingerprint({
      namespaceId: input.namespaceId,
      agentId: input.agentId,
      binding: input.binding,
      scope: input.scope,
    }),
  };
  const later = "2030-03-17T17:46:41.000Z";
  const approve = (value: Omit<RepositoryStandingApproval, "generation" | "revokedAt">) =>
    state.transact((unit) => unit.repositorySessions.approveStanding(value));
  const lookup = () =>
    state.read((view) =>
      view.repositorySessions.findStandingApproval(
        original.namespaceId,
        original.agentId,
        original.binding.repositoryRef,
      ),
    );
  const history = () =>
    state.read((view) =>
      view.repositorySessions.listStandingApprovals(original.namespaceId, original.agentId),
    );
  const conflict = {
    name: ResourceConflictError.name,
    message: "Standing approval identity already used or binding already approved.",
  };

  // Each tuple differs in exactly one dimension; its higher history must not
  // contribute to the original tuple's generation or block its admission.
  for (const [index, tuple] of [
    { ...input, namespaceId: "namespace-b" },
    { ...input, agentId: "agent-b" },
    { ...input, binding: repositoryBinding({ repositoryRef: "other" }) },
  ].entries()) {
    for (let generation = 1; generation <= 5; generation += 2) {
      const unrelated = await approve({
        ...tuple,
        id: `unrelated-${index}-${generation}`,
        scopeFingerprint: repositoryApprovalFingerprint({
          namespaceId: tuple.namespaceId,
          agentId: tuple.agentId,
          binding: tuple.binding,
          scope: tuple.scope,
        }),
      });
      assert.equal(unrelated.generation, generation);
      if (generation < 5) {
        await state.transact((unit) => unit.repositorySessions.revokeStanding(unrelated, later));
      }
    }
  }

  const first = await state.transact(async (unit) => {
    const saved = await unit.repositorySessions.approveStanding(original);
    const replay = await unit.repositorySessions.approveStanding({ ...original, createdAt: later });
    assert.strictEqual(replay, saved, "replay returns the stored object within this transaction");
    assert.equal(replay.createdAt, original.createdAt);
    assert.equal(saved.generation, 1);
    assert.ok(Object.isFrozen(saved));
    assert.ok(Object.isFrozen(saved.binding));
    return saved;
  });
  assert.deepEqual(await lookup(), first);
  assert.deepEqual(await approve({ ...original, createdAt: later }), first);

  const before = await history();
  for (const changed of [
    { ...original, approvedBy: "operator-b" },
    { ...original, namespaceId: "namespace-unused" },
    { ...original, agentId: "agent-unused" },
    { ...original, binding: repositoryBinding({ repositoryRef: "unused" }) },
    { ...original, id: "second-live" },
  ]) {
    await assert.rejects(approve(changed), conflict);
    assert.deepEqual(await history(), before);
    assert.deepEqual(await lookup(), first);
  }
  await assert.rejects(
    state.transact((unit) =>
      unit.repositorySessions.revokeStanding({ ...first, generation: 0 }, later),
    ),
    { name: ResourceStateConflictError.name, message: "Standing approval changed." },
  );
  assert.deepEqual(await history(), before);
  await state.transact((unit) => unit.repositorySessions.revokeStanding(first, later));
  assert.equal(await lookup(), undefined);
  const revokedHistory = await history();
  assert.deepEqual(
    revokedHistory.find((row) => row.id === first.id),
    {
      ...first,
      generation: 2,
      revokedAt: later,
    },
  );
  await assert.rejects(approve(original), conflict);
  assert.deepEqual(await history(), revokedHistory);

  const successor = await approve({ ...original, id: "approval-successor", createdAt: later });
  assert.equal(successor.generation, 3);
  assert.deepEqual(await lookup(), successor);
  const successorHistory = await history();
  assert.equal(successorHistory.length, revokedHistory.length + 1);
  assert.deepEqual(
    successorHistory.filter((row) => row.id !== successor.id),
    revokedHistory,
  );
  // The original tombstone precedes this live successor in insertion order.
  // A scan must continue past history and refuse another live approval.
  await assert.rejects(approve({ ...original, id: "third-live" }), conflict);
  assert.deepEqual(await history(), successorHistory);
  assert.deepEqual(await lookup(), successor);
});
