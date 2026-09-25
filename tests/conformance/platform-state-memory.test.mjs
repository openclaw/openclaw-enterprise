import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyPlatformStateStoreContract } from "./platform-state-store.contract.mjs";
import { seedSessionRevision } from "./repository-sessions.contract.mjs";

test("the memory platform state adapter satisfies the shared ownership and atomicity contract", async () => {
  await verifyPlatformStateStoreContract(new InMemoryPlatformState());
});

test("memory revision histories stay isolated across committed and rolled-back appends", async () => {
  const store = new InMemoryPlatformState();
  const { namespace, agent, revision } = await seedSessionRevision(store);
  const committed = { ...revision, id: `rev_${randomUUID()}`, revision: 2 };
  const rejected = { ...revision, id: `rev_${randomUUID()}`, revision: 3 };
  const failure = new Error("revision transaction failed");

  await store.read(async (view) => {
    assert.deepEqual(await view.revisions.listRevisions(namespace.id, agent.id), [revision]);

    // An already-open read keeps its history after another transaction publishes an append.
    await store.transact((unit) => unit.revisions.createRevision(committed));
    assert.deepEqual(await view.revisions.listRevisions(namespace.id, agent.id), [revision]);

    await assert.rejects(
      store.transact(async (unit) => {
        await unit.revisions.createRevision(rejected);
        assert.deepEqual(await unit.revisions.listRevisions(namespace.id, agent.id), [
          revision,
          committed,
          rejected,
        ]);
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(await view.revisions.listRevisions(namespace.id, agent.id), [revision]);
  });

  assert.deepEqual(
    await store.read((view) => view.revisions.listRevisions(namespace.id, agent.id)),
    [revision, committed],
  );
});
