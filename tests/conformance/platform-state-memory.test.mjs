import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyPlatformStateStoreContract } from "./platform-state-store.contract.mjs";
import { seedSessionRevision } from "./repository-sessions.contract.mjs";

test("memory policy refuses new grants to an Agent after deletion admission", async () => {
  const human = {
    id: `prn_${randomUUID()}`,
    kind: "principal",
    issuer: "https://identity.example.com",
    subject: randomUUID(),
  };
  const store = new InMemoryPlatformState({ iamIdentities: [human] });
  const { namespace, agent, revision } = await seedSessionRevision(store);
  const role = {
    id: `role_${randomUUID()}`,
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "agent" }],
  };
  const binding = {
    id: `binding_${randomUUID()}`,
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "agent",
    resourceId: agent.id,
  };
  await store.transact(async (unit) => {
    await unit.iamPolicy.createRole(role);
    assert.deepEqual(await unit.iamPolicy.createAccessBinding(binding), binding);
  });
  await store.transact(async (unit) => {
    await unit.agents.transitionAgentDesiredRuntimeState(
      namespace.id,
      agent.id,
      ["running", "stopped"],
      "stopped",
    );
    assert.equal(
      (await unit.agents.transitionAgentStatus(namespace.id, agent.id, "active", "deleting"))
        .status,
      "deleting",
    );
  });
  // Deletion removes bindings on the Agent and its revisions, and bindings for its
  // ServicePrincipal, so none of them admits a new binding.
  for (const target of [
    { resourceKind: "agent", resourceId: agent.id },
    { resourceKind: "agent_revision", resourceId: revision.id },
  ]) {
    await assert.rejects(
      store.transact((unit) =>
        unit.iamPolicy.createAccessBinding({
          ...binding,
          ...target,
          id: `binding_${randomUUID()}`,
          subjectId: human.id,
        }),
      ),
      /target does not exist in this Namespace or is being deleted/,
    );
  }
  await assert.rejects(
    store.transact((unit) =>
      unit.iamPolicy.createAccessBinding({
        ...binding,
        id: `binding_${randomUUID()}`,
      }),
    ),
    /the ServicePrincipal of a live Agent here/,
  );
});

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
