import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createBackendWorkerDrivers } from "../helpers/postgres-backend-state.mjs";
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
      controllerOptions: { recordOperations: true },
    });
    const grant = { tools: [{ name: "reports__read", binding: "a".repeat(64) }] };
    let candidateGrant: import("../../packages/contracts/src/index.ts").AgentAutomationToolGrant =
      grant;
    Object.assign(f.computeDriver, {
      async evaluateAgentAutomationPolicy(
        candidate: import("../../packages/contracts/src/index.ts").AgentRevision,
      ) {
        return { grant: candidate.revision > 1 ? candidateGrant : grant, bindings: [] };
      },
    });
    const { agent, namespace, revision } = await f.deployAgent("Automation reservation");
    const other = await f.deployAgent("Other automation parent");
    // Complete the real queued deployment through the worker. A pointer alone does not prove
    // predecessor retirement or the completed runtime cutover required for reservation.
    const workerPool = new pg.Pool({ connectionString: databaseUrl });
    const drivers = createBackendWorkerDrivers(f.computeDriver, [], {
      secretDriver: f.controller.selectedDriver("secret"),
    });
    const worker = createControllerWorker({
      pool: workerPool,
      drivers,
      pollIntervalMs: 15,
      emit() {},
    });
    await worker.start();
    try {
      await waitFor("the automation Agent deployment to complete", async () => {
        const work = await f.state.read((unit) =>
          unit.operations.findWork(`agent_revision:${revision.id}:reconcile`),
        );
        const otherWork = await f.state.read((unit) =>
          unit.operations.findWork(`agent_revision:${other.revision.id}:reconcile`),
        );
        return work?.state === "succeeded" && otherWork?.state === "succeeded" ? true : undefined;
      });
    } finally {
      await worker.stop();
    }
    // Public IDs are UUIDs. Invalid text must be refused by the actual HTTP
    // schema before PostgreSQL attempts UUID coercion; valid absent IDs stay 404.
    const path = `/namespaces/${namespace.id}/agents/${agent.id}/automations`;
    for (const id of ["missing-job", "1234", "00000000-0000-0000-0000-not-a-uuid00"]) {
      for (const [method, suffix, payload] of [
        ["GET", `/${id}`, undefined],
        ["PATCH", `/${id}`, { enabled: false, expectedConfigRevision: "observed" }],
        ["DELETE", `/${id}?expectedConfigRevision=observed`, undefined],
        ["GET", `/${id}/runs`, undefined],
      ] as const) {
        const response = await f.inject(method, path + suffix, payload);
        assert.equal(
          response.statusCode,
          400,
          "malformed automation ID must be an HTTP input error",
        );
        assert.equal(response.json().error.code, "INVALID_REQUEST");
      }
    }
    assert.equal((await f.inject("GET", `${path}/${randomUUID()}`)).statusCode, 404);

    const factory = new AuditEventFactory();
    const resource = { kind: "agent" as const, id: agent.id, namespaceId: namespace.id };
    const input = {
      namespaceId: namespace.id,
      agentId: agent.id,
      revisionId: revision.id,
      nativeAgentId: "main",
      toolGrant: grant,
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
    // Competing reservation and replacement deployment must serialize on the same Namespace
    // and Agent locks. Exactly one may commit when the successor changes a captured binding.
    candidateGrant = { tools: [{ name: "reports__read", binding: "b".repeat(64) }] };
    const locked = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    const lockHolder = f.state.transact(async (unit) => {
      assert.ok(await unit.namespaces.lockNamespace(other.namespace.id));
      assert.ok(await unit.agents.lockAgent(other.namespace.id, other.agent.id));
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    const competingDeploy = f.controller.deployAgent(
      f.principal.id,
      { namespaceId: other.namespace.id, agentId: other.agent.id },
      resolveApprovedHarness,
    );
    const competingReserve = f.controller.reserveAgentAutomation(
      f.principal.id,
      {
        ...input,
        namespaceId: other.namespace.id,
        agentId: other.agent.id,
        revisionId: other.revision.id,
      },
      (record) =>
        factory.create({
          installationId: f.controller.installation.id,
          namespaceId: other.namespace.id,
          actorId: f.principal.id,
          kind: "mutation",
          action: "openclaw.agents.automations.create.admitted",
          resource: { kind: "agent", id: other.agent.id, namespaceId: other.namespace.id },
          details: { jobId: record.id, revisionId: other.revision.id },
        }),
    );
    const competingResults = Promise.allSettled([competingDeploy, competingReserve]);
    try {
      await waitFor("both competing operations to wait on the held lifecycle lock", async () => {
        const result = await f.pool.query(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'",
        );
        return result.rows[0]?.waiting >= 2 ? true : undefined;
      });
    } finally {
      unlock.resolve();
    }
    await lockHolder;
    const [deploymentResult, reservationResult] = await competingResults;
    assert.equal(
      [deploymentResult, reservationResult].filter((result) => result.status === "fulfilled")
        .length,
      1,
    );
    for (const result of [deploymentResult, reservationResult]) {
      if (result.status === "rejected") {
        assert.equal(result.reason.name, "ResourceStateConflictError");
      }
    }
    if (reservationResult.status === "fulfilled") {
      const record = reservationResult.value;
      assert.equal(
        await f.controller.discardUnboundAgentAutomation(
          f.principal.id,
          { namespaceId: other.namespace.id, agentId: other.agent.id, id: record.id },
          () =>
            factory.create({
              installationId: f.controller.installation.id,
              namespaceId: other.namespace.id,
              actorId: f.principal.id,
              kind: "mutation",
              action: "openclaw.agents.automations.create.discarded",
              resource: { kind: "agent", id: other.agent.id, namespaceId: other.namespace.id },
              details: { jobId: record.id },
            }),
        ),
        true,
      );
    }
    candidateGrant = grant;

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
    // The application role must reject malformed grants at the database boundary, even if a
    // future caller bypasses OCC validation. These are independent persisted-data constraints.
    const malformedGrants = [
      1,
      [],
      { tools: [null] },
      { tools: [{ name: "reports__read", binding: "bad" }] },
      { tools: [{ name: "reports__read", binding: "a".repeat(64), extra: true }] },
      { tools: [grant.tools[0], grant.tools[0]] },
      {
        tools: [
          { name: "z", binding: "a".repeat(64) },
          { name: "a", binding: "b".repeat(64) },
        ],
      },
    ];
    for (const malformed of malformedGrants) {
      await assert.rejects(
        f.pool.query(
          "INSERT INTO occ.agent_automations (id,namespace_id,agent_id,creator_principal_id,native_agent_id,tool_grant,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,now())",
          [randomUUID(), namespace.id, agent.id, f.principal.id, "main", JSON.stringify(malformed)],
        ),
        { code: "23514" },
      );
    }
    await assert.rejects(
      f.pool.query("UPDATE occ.agent_automations SET tool_grant=$2::jsonb WHERE id=$1", [
        ownership.id,
        JSON.stringify({ tools: [] }),
      ]),
      { code: "42501" },
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
    const { nativeJobId: _nativeJobId, retiredAt: _retiredAt, ...createInput } = ownership;
    await assert.rejects(
      f.state.transact((unit) => unit.agentAutomations.create(createInput)),
      { name: "ResourceConflictError" },
    );
    await assert.rejects(
      f.state.transact((unit) =>
        unit.agentAutomations.create({
          ...createInput,
          id: randomUUID(),
          namespaceId: other.namespace.id,
        }),
      ),
      { name: "ScopeViolationError" },
    );
    await assert.rejects(
      f.state.transact((unit) =>
        unit.agentAutomations.create({
          ...createInput,
          id: randomUUID(),
          nativeAgentId: "../other",
        }),
      ),
      { name: "ScopeViolationError" },
    );

    // Deployment admission must not drop or rebind a captured alias while any standing job
    // can still run. The selected fixture Compute supplies policy; PostgreSQL and OCC own
    // the reservation/deployment lock and comparison being exercised.
    const deploySuccessor = () =>
      f.controller.deployAgent(
        f.principal.id,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedHarness,
      );
    candidateGrant = { tools: [{ name: "reports__read", binding: "b".repeat(64) }] };
    await assert.rejects(deploySuccessor(), { name: "ResourceStateConflictError" });
    candidateGrant = { tools: [] };
    await assert.rejects(deploySuccessor(), { name: "ResourceStateConflictError" });

    // A native outcome that is still unknown keeps its grant active. Only a positively bound
    // deletion can retire a record; retirement and its audit must commit together.
    const retireInput = { namespaceId: namespace.id, agentId: agent.id, id: ownership.id };
    const retireAudit = (id: string) =>
      factory.create({
        installationId: f.controller.installation.id,
        namespaceId: namespace.id,
        actorId: f.principal.id,
        kind: "mutation",
        action: "openclaw.agents.automations.delete.retired",
        resource,
        details: { jobId: id },
      });
    await assert.rejects(
      f.controller.retireAgentAutomation(
        f.principal.id,
        { ...retireInput, id: otherReservation.id },
        (record) => retireAudit(record.id),
      ),
      { name: "ResourceStateConflictError" },
    );
    await assert.rejects(
      f.controller.retireAgentAutomation(f.principal.id, retireInput, () => {
        throw new Error("retirement audit failed");
      }),
      /retirement audit failed/u,
    );
    assert.equal(
      (
        await reopened.read((unit) =>
          unit.agentAutomations.find(namespace.id, agent.id, ownership.id),
        )
      )?.retiredAt,
      null,
    );
    ownership = await f.controller.retireAgentAutomation(f.principal.id, retireInput, (record) =>
      retireAudit(record.id),
    );
    assert.ok(ownership.retiredAt);
    assert.deepEqual(
      await f.controller.retireAgentAutomation(f.principal.id, retireInput, () => {
        throw new Error("duplicate retirement audit");
      }),
      ownership,
    );
    await assert.rejects(
      f.pool.query("UPDATE occ.agent_automations SET retired_at=NULL WHERE id=$1", [ownership.id]),
      { code: "55000" },
    );
    await f.controller.retireAgentAutomation(
      f.principal.id,
      { ...retireInput, id: raced.id },
      (record) => retireAudit(record.id),
    );
    // The unbound reservation represents an unknown native outcome and still blocks narrowing.
    await assert.rejects(deploySuccessor(), { name: "ResourceStateConflictError" });
    assert.equal(
      await f.controller.discardUnboundAgentAutomation(
        f.principal.id,
        { ...retireInput, id: otherReservation.id },
        () => discardAudit(otherReservation.id),
      ),
      true,
    );
    const successor = await deploySuccessor();
    assert.equal(successor.revision, 2, "retired history must not block a narrower deployment");

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
