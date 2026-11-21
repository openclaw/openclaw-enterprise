import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";

test(
  "PostgreSQL automation reservations retain exact ownership and commit admission audit atomically",
  requiresPostgres,
  async (t) => {
    const f = await createPostgresAgentApp(t, {
      label: "automation-ownership",
      authSecret: "automation-ownership-postgres-session-secret",
    });
    const { agent, namespace, revision } = await f.deployAgent("Automation reservation");
    // Activate the admitted revision for this storage scenario. Compute is the existing fixture;
    // this proves OCC ownership/persistence, not a native Gateway or model turn.
    await f.state.transact(async (unit) => {
      assert.ok(
        await unit.agents.compareAndSetActiveRevision(
          namespace.id,
          agent.id,
          undefined,
          revision.id,
        ),
      );
    });
    const factory = new AuditEventFactory();
    const resource = { kind: "agent" as const, id: agent.id, namespaceId: namespace.id };
    const input = {
      namespaceId: namespace.id,
      agentId: agent.id,
      revisionId: revision.id,
      nativeAgentId: "main",
    };
    const audit = (id: string) =>
      factory.create({
        installationId: f.controller.installation.id,
        namespaceId: namespace.id,
        actorId: f.principal.id,
        kind: "mutation",
        action: "openclaw.agents.automations.create.admitted",
        resource,
        details: { jobId: id, revisionId: revision.id },
      });
    let ownership = await f.controller.reserveAgentAutomation(f.principal.id, input, (record) =>
      audit(record.id),
    );
    const observer = testPool(t, { connectionString: databaseUrl });
    const reopened = new PostgresPlatformState(observer);
    assert.deepEqual(
      await reopened.read((unit) =>
        unit.agentAutomations.find(namespace.id, agent.id, ownership.id),
      ),
      ownership,
    );
    assert.deepEqual(
      await f.controller.listAgentAutomationOwnership(f.principal.id, namespace.id, agent.id),
      [ownership],
    );
    assert.equal(
      await reopened.read((unit) =>
        unit.agentAutomations.find(`ns_${randomUUID()}`, agent.id, ownership.id),
      ),
      undefined,
    );
    assert.equal(
      await reopened.read((unit) =>
        unit.agentAutomations.find(namespace.id, `agt_${randomUUID()}`, ownership.id),
      ),
      undefined,
    );
    assert.deepEqual(
      await reopened.read((unit) =>
        unit.agentAutomations.list(namespace.id, agent.id, "another-creator"),
      ),
      [],
    );
    const evidence = await f.pool.query(
      "SELECT details FROM occ.audit_events WHERE action=$1 AND details->>'jobId'=$2",
      ["openclaw.agents.automations.create.admitted", ownership.id],
    );
    assert.equal(evidence.rowCount, 1);

    const rejected = await f.controller.reserveAgentAutomation(f.principal.id, input, (record) =>
      audit(record.id),
    );
    const discardedInput = { namespaceId: namespace.id, agentId: agent.id, id: rejected.id };
    const discardAudit = (id: string) =>
      factory.create({
        installationId: f.controller.installation.id,
        namespaceId: namespace.id,
        actorId: f.principal.id,
        kind: "mutation",
        action: "openclaw.agents.automations.create.discarded",
        resource,
        outcome: "failure",
        details: { jobId: id },
      });
    // Completion cleanup is conditional and atomic with its audit. Direct deletion
    // remains unavailable to the application role, and admission evidence survives.
    await assert.rejects(
      f.pool.query("DELETE FROM occ.agent_automations WHERE id=$1", [rejected.id]),
      { code: "42501" },
    );
    await assert.rejects(
      f.controller.discardUnboundAgentAutomation(f.principal.id, discardedInput, () => {
        throw new Error("discard audit failed");
      }),
      /discard audit failed/u,
    );
    assert.deepEqual(
      await reopened.read((unit) =>
        unit.agentAutomations.find(namespace.id, agent.id, rejected.id),
      ),
      rejected,
    );
    assert.equal(
      await f.controller.discardUnboundAgentAutomation("another-creator", discardedInput, () =>
        discardAudit(rejected.id),
      ),
      false,
    );
    assert.equal(
      await f.controller.discardUnboundAgentAutomation(f.principal.id, discardedInput, () =>
        discardAudit(rejected.id),
      ),
      true,
    );
    assert.equal(
      await f.controller.discardUnboundAgentAutomation(f.principal.id, discardedInput, () =>
        discardAudit(rejected.id),
      ),
      false,
    );
    assert.equal(
      await reopened.read((unit) =>
        unit.agentAutomations.find(namespace.id, agent.id, rejected.id),
      ),
      undefined,
    );
    const retainedAudit = await f.pool.query(
      "SELECT action FROM occ.audit_events WHERE details->>'jobId'=$1 ORDER BY action",
      [rejected.id],
    );
    assert.deepEqual(
      retainedAudit.rows.map((row: { action: string }) => row.action),
      [
        "openclaw.agents.automations.create.admitted",
        "openclaw.agents.automations.create.discarded",
      ],
    );

    // An actual row-lock race proves cleanup cannot erase a native identity that
    // becomes bound after cleanup reads the reservation but before its DELETE.
    const raced = await f.controller.reserveAgentAutomation(f.principal.id, input, (record) =>
      audit(record.id),
    );
    const nativeRaceId = randomUUID();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const bindingRace = f.state.transact(async (unit) => {
      const result = await unit.agentAutomations.bind(
        namespace.id,
        agent.id,
        raced.id,
        nativeRaceId,
      );
      assert.ok(result?.changed);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const discardRace = f.controller.discardUnboundAgentAutomation(
      f.principal.id,
      { namespaceId: namespace.id, agentId: agent.id, id: raced.id },
      () => discardAudit(raced.id),
    );
    try {
      await waitFor("reservation cleanup to wait for native binding", async () => {
        const result = await observer.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%discard_unbound_agent_automation%') AS waiting",
        );
        return result.rows[0]?.waiting === true ? true : undefined;
      });
    } finally {
      release.resolve();
    }
    await bindingRace;
    assert.equal(await discardRace, false);
    assert.equal(
      (await reopened.read((unit) => unit.agentAutomations.find(namespace.id, agent.id, raced.id)))
        ?.nativeJobId,
      nativeRaceId,
    );

    // A failed admission audit rolls back the reservation before any native create can run.
    let failedId: string | undefined;
    await assert.rejects(
      f.controller.reserveAgentAutomation(f.principal.id, input, (record) => {
        failedId = record.id;
        throw new Error("admission audit construction failed");
      }),
      /admission audit construction failed/u,
    );
    assert.ok(failedId);
    assert.equal(
      await reopened.read((unit) => unit.agentAutomations.find(namespace.id, agent.id, failedId!)),
      undefined,
    );

    // Native IDs are fixture values here; the native protocol case proves their real producer.
    const nativeJobId = randomUUID();
    const binding = {
      namespaceId: namespace.id,
      agentId: agent.id,
      id: ownership.id,
      nativeJobId,
      requireOperate: true,
    };
    await assert.rejects(
      f.controller.bindAgentAutomation(f.principal.id, binding, () => {
        throw new Error("binding audit failed");
      }),
      /binding audit failed/u,
    );
    assert.equal(
      (
        await reopened.read((unit) =>
          unit.agentAutomations.find(namespace.id, agent.id, ownership.id),
        )
      )?.nativeJobId,
      null,
    );
    ownership = await f.controller.bindAgentAutomation(f.principal.id, binding, (record) =>
      factory.create({
        installationId: f.controller.installation.id,
        namespaceId: namespace.id,
        actorId: f.principal.id,
        kind: "mutation",
        action: "openclaw.agents.automations.create.bound",
        resource,
        details: { jobId: record.id, nativeJobId: record.nativeJobId },
      }),
    );
    assert.equal(ownership.nativeJobId, nativeJobId);
    assert.equal(
      await f.controller.discardUnboundAgentAutomation(
        f.principal.id,
        {
          namespaceId: namespace.id,
          agentId: agent.id,
          id: ownership.id,
        },
        () => discardAudit(ownership.id),
      ),
      false,
    );
    assert.deepEqual(
      await f.controller.bindAgentAutomation(f.principal.id, binding, () => {
        throw new Error("duplicate binding audit");
      }),
      ownership,
    );
    await assert.rejects(
      f.controller.bindAgentAutomation(
        f.principal.id,
        { ...binding, nativeJobId: randomUUID() },
        (record) => audit(record.id),
      ),
      { name: "ResourceStateConflictError" },
    );
    await assert.rejects(
      f.pool.query("UPDATE occ.agent_automations SET native_job_id=$2 WHERE id=$1", [
        ownership.id,
        randomUUID(),
      ]),
      { code: "55000" },
    );
    const otherReservation = await f.controller.reserveAgentAutomation(
      f.principal.id,
      input,
      (record) => audit(record.id),
    );
    await assert.rejects(
      f.controller.bindAgentAutomation(
        f.principal.id,
        { ...binding, id: otherReservation.id },
        (record) => audit(record.id),
      ),
      { name: "ResourceConflictError" },
    );

    // The application role cannot change the creator, reuse an ID, or delete retained evidence.
    await assert.rejects(
      f.pool.query("UPDATE occ.agent_automations SET creator_principal_id=$2 WHERE id=$1", [
        ownership.id,
        "another-creator",
      ]),
      { code: "42501" },
    );
    await assert.rejects(
      f.pool.query("DELETE FROM occ.agent_automations WHERE id=$1", [ownership.id]),
      { code: "42501" },
    );
    await assert.rejects(
      f.state.transact((unit) => unit.agentAutomations.create(ownership)),
      { name: "ResourceConflictError" },
    );
    const other = await f.deployAgent("Other automation parent");
    await assert.rejects(
      f.state.transact((unit) =>
        unit.agentAutomations.create({
          ...ownership,
          id: randomUUID(),
          namespaceId: other.namespace.id,
        }),
      ),
      { name: "ScopeViolationError" },
    );
    await assert.rejects(
      f.state.transact((unit) =>
        unit.agentAutomations.create({ ...ownership, id: randomUUID(), nativeAgentId: "../other" }),
      ),
      { name: "ScopeViolationError" },
    );

    // A stop preserves management evidence for later history and blocks fresh reservations.
    await f.controller.stopAgent(f.principal.id, namespace.id, agent.id);
    await assert.rejects(
      f.controller.reserveAgentAutomation(f.principal.id, input, (record) => audit(record.id)),
      { name: "ResourceStateConflictError" },
    );
    assert.deepEqual(
      (
        await f.controller.getAgentAutomationOwnership(
          f.principal.id,
          namespace.id,
          agent.id,
          ownership.id,
        )
      ).record,
      ownership,
    );
  },
);
