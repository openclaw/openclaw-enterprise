import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { accessBindingsRemovedWithAgent } from "../../packages/occ/src/iam-policy-cleanup.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyPlatformStateStoreContract } from "./platform-state-store.contract.mjs";
import { seedSessionRevision, sessionAttempt } from "./repository-sessions.contract.mjs";

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

test("memory Agent deletion completion removes the AccessBindings the PostgreSQL finalizer removes", async () => {
  const human = {
    id: `prn_${randomUUID()}`,
    kind: "principal",
    issuer: "https://identity.example.com",
    subject: randomUUID(),
  };
  const store = new InMemoryPlatformState({ iamIdentities: [human] });
  const { namespace, configuration, agent, revision } = await seedSessionRevision(store);
  const other = await seedSessionRevision(store);
  // A second Agent in the same Namespace keeps its bindings, live session and work.
  const sibling = {
    ...agent,
    id: `agt_${randomUUID()}`,
    name: `Sibling ${randomUUID()}`,
    servicePrincipalId: `service-agent-${randomUUID()}`,
  };
  const siblingRevision = {
    ...revision,
    id: `rev_${randomUUID()}`,
    agentId: sibling.id,
    servicePrincipalId: sibling.servicePrincipalId,
  };
  await store.transact(async (unit) => {
    await unit.agents.createAgent(sibling);
    await unit.revisions.createRevision(siblingRevision);
    await unit.agents.transitionAgentDesiredRuntimeState(
      namespace.id,
      sibling.id,
      "stopped",
      "running",
    );
  });
  const role = {
    id: `role_${randomUUID()}`,
    namespaceId: namespace.id,
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action: "read", resourceKind: "agent_revision" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  const binding = (subjectId, resourceKind, resourceId) => ({
    id: `binding_${randomUUID()}`,
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId,
    roleId: role.id,
    resourceKind,
    resourceId,
  });
  // The three groups occ.finalize_agent_deletion (migrations/0035) deletes: bindings on the
  // Agent, on its AgentRevisions, and for its ServicePrincipal.
  const removed = [
    binding(human.id, "agent", agent.id),
    binding(human.id, "agent_revision", revision.id),
    binding(agent.servicePrincipalId, "configuration", configuration.id),
  ];
  const surviving = binding(human.id, "configuration", configuration.id);
  // Their own Role, so the final deleteRole(role) still proves no removed binding holds role.
  const siblingRole = { ...role, id: `role_${randomUUID()}` };
  const siblingBindings = [
    binding(human.id, "agent", sibling.id),
    binding(human.id, "agent_revision", siblingRevision.id),
    binding(sibling.servicePrincipalId, "configuration", configuration.id),
  ].map((created) => ({ ...created, roleId: siblingRole.id }));
  const otherRole = { ...role, id: `role_${randomUUID()}`, namespaceId: other.namespace.id };
  const otherBinding = {
    ...binding(human.id, "agent", other.agent.id),
    namespaceId: other.namespace.id,
    roleId: otherRole.id,
  };
  await store.transact(async (unit) => {
    await unit.iamPolicy.createRole(role);
    await unit.iamPolicy.createRole(otherRole);
    await unit.iamPolicy.createRole(siblingRole);
    for (const created of [...removed, surviving, otherBinding, ...siblingBindings]) {
      await unit.iamPolicy.createAccessBinding(created);
    }
  });
  // Repository sessions the Agent's runtime opened before deletion, and an unfinished
  // workspace setup.
  const opening = sessionAttempt(revision);
  const closing = sessionAttempt(revision);
  const siblingSession = sessionAttempt(siblingRevision);
  await store.transact(async (unit) => {
    // One repository has at most one active attempt, so the first moves on before the next.
    await unit.repositorySessions.createAttempt(closing);
    await unit.repositorySessions.advanceAttempt({
      admissionId: closing.admissionId,
      expectedPhase: "opening",
      phase: "closing",
      updatedAt: "2030-03-17T17:46:41.000Z",
    });
    await unit.repositorySessions.createAttempt(opening);
    await unit.repositorySessions.createAttempt(siblingSession);
    await unit.workspaceSetups.create({
      id: `setup_${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: agent.id,
      files: { "AGENTS.md": "# Agent" },
      completed: false,
    });
  });
  const sorted = (bindings) => [...bindings].sort((left, right) => left.id.localeCompare(right.id));

  // Nothing completes before deletion is admitted.
  assert.equal(await store.completeAgentDeletion(namespace.id, agent.id), false);
  const actorId = `prn_${randomUUID()}`;
  const promised = await store.transact(async (unit) => {
    // Stop, then Delete: the Agent's stop work stays pending, because memory never runs work.
    await unit.operations.append({
      kind: "agent",
      action: "reconcile",
      target: "stopped",
      namespaceId: namespace.id,
      resourceId: agent.id,
      operationId: `op_${randomUUID()}`,
      actorId,
    });
    await unit.agents.transitionAgentDesiredRuntimeState(
      namespace.id,
      agent.id,
      ["running", "stopped"],
      "stopped",
    );
    const deleting = await unit.agents.transitionAgentStatus(
      namespace.id,
      agent.id,
      "active",
      "deleting",
    );
    // The admission audit's accessBindingsRemovedOnCompletion list.
    return accessBindingsRemovedWithAgent(unit, deleting);
  });
  assert.deepEqual(
    sorted(promised),
    sorted(removed.map(({ namespaceId: _namespaceId, ...listed }) => listed)),
  );
  // A deleting Agent without its recorded teardown work is not an admitted deletion; the stop
  // work recorded before admission is not that work.
  assert.equal(await store.completeAgentDeletion(namespace.id, agent.id), false);
  const work = {
    kind: "agent",
    action: "reconcile",
    target: "deleted",
    namespaceId: namespace.id,
    resourceId: agent.id,
    actorId,
  };
  const revisionWork = {
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: namespace.id,
    resourceId: revision.id,
    actorId,
  };
  // Other Agent work in the Namespace, which completion leaves pending.
  const siblingWork = [
    { ...work, target: "stopped", resourceId: sibling.id, operationId: `op_${randomUUID()}` },
    { ...revisionWork, resourceId: siblingRevision.id },
  ];
  await store.transact(async (unit) => {
    for (const appended of [work, revisionWork, ...siblingWork]) {
      await unit.operations.append(appended);
    }
  });

  assert.equal(await store.completeAgentDeletion(namespace.id, agent.id), true);
  // As in PostgreSQL (migrations/0035), completion does not wait for repository cleanup:
  // each attempt stays as evidence in its phase, without its deleted live revision.
  await store.transact(async (unit) => {
    for (const [attempt, phase] of [
      [opening, "opening"],
      [closing, "closing"],
    ]) {
      const kept = await unit.repositorySessions.findAttempt(attempt.admissionId);
      assert.equal(kept.phase, phase);
      assert.equal(kept.liveRevisionId, null);
    }
    assert.equal(await unit.workspaceSetups.find(namespace.id, agent.id), undefined);
    const live = await unit.repositorySessions.findAttempt(siblingSession.admissionId);
    assert.equal(live.liveRevisionId, siblingRevision.id);
  });
  await store.read(async (view) => {
    assert.deepEqual(
      sorted(await view.iamPolicy.listAccessBindings(namespace.id)),
      sorted([surviving, ...siblingBindings]),
    );
    assert.deepEqual(await view.iamPolicy.listAccessBindings(other.namespace.id), [otherBinding]);
    assert.equal(await view.agents.findAgent(namespace.id, agent.id), undefined);
    assert.deepEqual(await view.revisions.listRevisions(namespace.id, agent.id), []);
    assert.deepEqual(
      (await view.revisions.listRevisions(namespace.id, sibling.id)).map(({ id }) => id),
      [siblingRevision.id],
    );
    assert.equal(
      (await view.agents.findAgent(other.namespace.id, other.agent.id))?.id,
      other.agent.id,
    );
  });
  // The audit is readable only inside a transaction.
  await store.transact(async (unit) => {
    const events = (await unit.audit.list()).filter(
      (event) => event.action === "openclaw.agents.lifecycle.delete",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].actorId, actorId);
    assert.equal(events[0].outcome, "success");
    assert.deepEqual(events[0].resource, {
      kind: "agent",
      id: agent.id,
      namespaceId: namespace.id,
    });
    assert.deepEqual(events[0].details, { reasonCode: "AGENT_DELETED", attemptCount: 1 });
  });
  assert.deepEqual(
    store
      .pendingOperations()
      .filter((operation) => [agent.id, revision.id].includes(operation.resourceId)),
    [],
  );
  assert.deepEqual(
    store
      .pendingOperations()
      .filter((operation) => [sibling.id, siblingRevision.id].includes(operation.resourceId))
      .map(({ kind, resourceId }) => ({ kind, resourceId })),
    siblingWork.map(({ kind, resourceId }) => ({ kind, resourceId })),
  );
  // Completion is one-shot, and no removed binding still holds the Role.
  assert.equal(await store.completeAgentDeletion(namespace.id, agent.id), false);
  await store.transact(async (unit) => {
    assert.equal(await unit.iamPolicy.deleteAccessBinding(namespace.id, surviving.id), true);
    assert.equal(await unit.iamPolicy.deleteRole(namespace.id, role.id), true);
  });
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

test("memory state refuses an Agent backendId outside the API's Backend ID rule", async () => {
  const store = new InMemoryPlatformState();
  const { namespace, configuration, agent, revision } = await seedSessionRevision(store);
  // The API schema refuses each of these, so the state store does too: a C1 control, a line
  // separator and 201 code points.
  for (const backendId of ["open\u0085ai", "open\u2028ai", "😀".repeat(201)]) {
    const label = JSON.stringify(backendId);
    await assert.rejects(
      store.transact((unit) =>
        unit.agents.createAgent({ ...agent, id: `agt_${randomUUID()}`, backendId }),
      ),
      { message: "The Agent Backend identity is invalid." },
      label,
    );
    await assert.rejects(
      store.transact((unit) =>
        unit.agents.updateConfiguration(
          namespace.id,
          agent.id,
          configuration.id,
          undefined,
          undefined,
          backendId,
        ),
      ),
      { message: "The Agent Backend identity is invalid." },
      label,
    );
    await assert.rejects(
      store.transact((unit) =>
        unit.revisions.createRevision({
          ...revision,
          id: `rev_${randomUUID()}`,
          revision: 2,
          backendId,
        }),
      ),
      { message: /^An AgentRevision requires valid Configuration metadata/ },
      label,
    );
  }
});
