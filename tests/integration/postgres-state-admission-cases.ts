import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { Check } from "typebox/value";

import {
  NamespaceListResponse,
  NamespaceResponse,
  type Agent,
  type AgentRevision,
  type Namespace,
} from "../../packages/contracts/src/index.ts";
import type { PlatformOperation, PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  adminEmail,
  createDurableController,
  databaseUrl,
  parseJsonLines,
  request,
  spawnWorker,
  startController,
} from "../helpers/postgres-platform-state.ts";

export async function refuseUninitializedInstallation(context: TestContext): Promise<void> {
  const [{ Pool }, { PostgresPlatformState }] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/state/postgres-state.ts"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  const state = new PostgresPlatformState(pool);
  if ((await state.loadInstallation()) !== undefined) {
    context.skip("The configured PostgreSQL database has already been bootstrapped.");
    return;
  }

  const prematureWorker = await spawnWorker(context);
  const [prematureExit]: unknown[] = await once(prematureWorker.child, "exit", {
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(typeof prematureExit === "number");
  assert.notEqual(prematureExit, 0);
  const workerLogs: unknown[] = parseJsonLines(prematureWorker.output());
  const startupFailure = workerLogs
    .map(asRecord)
    .find((line) => line?.event === "worker.startup-error");
  assert.ok(startupFailure, prematureWorker.output());
  assert.deepEqual(
    {
      severity: startupFailure.severity,
      service: startupFailure.service,
      event: startupFailure.event,
      code: startupFailure.code,
    },
    {
      severity: "ERROR",
      service: "occ-worker",
      event: "worker.startup-error",
      code: "WORKER_STARTUP_FAILED",
    },
  );

  const namespaceId = `ns_${randomUUID()}`;
  const agentId = `agt_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const namespace: Namespace = {
    id: namespaceId,
    name: "Uninitialized",
    status: "provisioning",
    createdAt,
  };
  const agent: Agent = {
    id: agentId,
    namespaceId,
    name: "Uninitialized agent",
    configurationId: `cfg_${randomUUID()}`,
    backendId: null,
    harnessAuth: null,
    gatewayManagedMode: true,
    desiredRuntimeState: "stopped",
    status: "active",
    executionMode: "embedded",
    servicePrincipalId: `service-agent-${randomUUID()}`,
    createdAt,
  };
  const revision: AgentRevision = {
    id: `rev_${randomUUID()}`,
    namespaceId,
    agentId,
    revision: 1,
    backendId: null,
    gatewayManagedMode: agent.gatewayManagedMode,
    configurationId: `cfg_${randomUUID()}`,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {},
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    },
    compute: {
      id: "compute-local-development",
      implementation: "deterministic-local-development",
    },
    executionAdmission: { version: 2, mode: "unprotected" },
    harnessAuth: { method: "runtime" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt,
  };
  const operation: PlatformOperation = {
    kind: "namespace",
    action: "reconcile",
    target: "ready",
    namespaceId,
    resourceId: namespaceId,
    actorId: "principal-uninitialized",
  };
  const stateCounts = `SELECT
     (SELECT count(*)::integer FROM occ.installation) AS installations,
     (SELECT count(*)::integer FROM occ.namespaces) AS namespaces,
     (SELECT count(*)::integer FROM occ.agents) AS agents,
     (SELECT count(*)::integer FROM occ.agent_revisions) AS revisions,
     (SELECT count(*)::integer FROM occ.controller_work) AS work`;
  const baseline = await pool.query<{ installations: number }>(stateCounts);
  assert.equal(baseline.rows[0]?.installations, 0);

  const operations: ((unit: PlatformUnitOfWork) => Promise<unknown>)[] = [
    (transaction) => transaction.namespaces.createNamespace(namespace),
    (transaction) => transaction.agents.createAgent(agent),
    (transaction) => transaction.revisions.createRevision(revision),
    (transaction) => transaction.operations.append(operation),
    (transaction) => transaction.operations.list(),
  ];
  for (const operation of operations) {
    await assert.rejects(state.transact(operation), { name: "ScopeViolationError" });
  }

  const persisted = await pool.query(stateCounts);
  assert.deepEqual(persisted.rows[0], baseline.rows[0]);
}

export async function persistNamespaceLifecycle(context: TestContext): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  const process = await startController(context);
  const installation = await request(process, "GET", "/installation");
  if (installation.status === 404) {
    const bootstrapped = await request(process, "POST", "/installation/bootstrap", {
      name: "PostgreSQL namespace lifecycle integration",
    });
    assert.equal(bootstrapped.status, 201);
  } else {
    assert.equal(installation.status, 200);
  }
  const { controller, state } = await createDurableController(pool);
  const actor = await pool.query<{ id: string }>(
    `SELECT identity.id
   FROM occ.iam_identities AS identity
   JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
   WHERE auth_user.email = $1`,
    [adminEmail],
  );
  assert.equal(actor.rowCount, 1);
  const principalId = actor.rows[0]?.id;
  assert.ok(typeof principalId === "string");

  const created = await request(process, "POST", "/namespaces", {
    name: `durable-lifecycle-${randomUUID()}`,
  });
  assert.equal(created.status, 201);
  assert.ok(Check(NamespaceResponse.properties.data, created.data));
  assert.equal(created.data.status, "provisioning");
  const namespaceId = created.data.id;

  const ledger = await state.transact((unit) => unit.audit.list());
  const creation = ledger.find(
    (event) => event.action === "openclaw.namespaces.create" && event.resource.id === namespaceId,
  );
  assert.ok(creation?.requestId);
  assert.deepEqual(
    ledger
      .filter((event) => event.kind === "api_request" && event.requestId === creation.requestId)
      .map(({ action }) => action)
      .sort(),
    ["openclaw.api.request.admitted", "openclaw.api.request.result"],
  );

  const provisioning = await request(process, "GET", `/namespaces/${namespaceId}`);
  assert.equal(provisioning.status, 200);
  assert.deepEqual(provisioning.data, created.data);

  const persistedProvisioning = await pool.query(
    "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
    [namespaceId],
  );
  assert.deepEqual(persistedProvisioning.rows, [{ status: "provisioning", deleted_at: null }]);
  const provisionWork = await pool.query(
    "SELECT namespace_target FROM occ.controller_work WHERE namespace_id = $1",
    [namespaceId],
  );
  assert.deepEqual(provisionWork.rows, [{ namespace_target: "ready" }]);

  const reconciled = await controller.handleNamespaceLifecycle(principalId, namespaceId, "ready");
  assert.equal(reconciled?.status, "ready");
  const ready = await request(process, "GET", `/namespaces/${namespaceId}`);
  assert.equal(ready.status, 200);
  assert.ok(Check(NamespaceResponse.properties.data, ready.data));
  assert.equal(ready.data.status, "ready");
  const persistedReady = await pool.query(
    "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
    [namespaceId],
  );
  assert.deepEqual(persistedReady.rows, [{ status: "ready", deleted_at: null }]);

  const deleting = await request(process, "DELETE", `/namespaces/${namespaceId}`);
  assert.equal(deleting.status, 202);
  assert.ok(Check(NamespaceResponse.properties.data, deleting.data));
  assert.equal(deleting.data.status, "deleting");
  const visibleDeletion = await request(process, "GET", `/namespaces/${namespaceId}`);
  assert.equal(visibleDeletion.status, 200);
  assert.ok(Check(NamespaceResponse.properties.data, visibleDeletion.data));
  assert.equal(visibleDeletion.data.status, "deleting");
  const persistedDeleting = await pool.query(
    "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
    [namespaceId],
  );
  assert.deepEqual(persistedDeleting.rows, [{ status: "deleting", deleted_at: null }]);

  const lifecycleWork = await pool.query<{ idempotency_key: string; namespace_target: string }>(
    `SELECT idempotency_key, namespace_target
   FROM occ.controller_work WHERE namespace_id = $1 ORDER BY namespace_target`,
    [namespaceId],
  );
  assert.deepEqual(
    lifecycleWork.rows.map(({ namespace_target }) => namespace_target),
    ["deleted", "ready"],
  );
  const [deletedWork, readyWork] = lifecycleWork.rows;
  assert.ok(deletedWork && readyWork);
  assert.notEqual(deletedWork.idempotency_key, readyWork.idempotency_key);

  const tombstoned = await controller.handleNamespaceLifecycle(principalId, namespaceId, "deleted");
  assert.ok(tombstoned);
  assert.equal(tombstoned.status, "deleting");
  assert.ok("deletedAt" in tombstoned && typeof tombstoned.deletedAt === "string");
  const persistedTombstone = await pool.query<{ status: string; deleted_at: unknown }>(
    "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
    [namespaceId],
  );
  assert.equal(persistedTombstone.rowCount, 1);
  const [tombstone] = persistedTombstone.rows;
  assert.equal(tombstone?.status, "deleting");
  assert.ok(tombstone.deleted_at instanceof Date);
  assert.equal(tombstone.deleted_at.toISOString(), tombstoned.deletedAt);

  const hidden = await request(process, "GET", `/namespaces/${namespaceId}`);
  assert.equal(hidden.status, 404);
  const listed = await request(process, "GET", "/namespaces");
  assert.equal(listed.status, 200);
  assert.ok(Check(NamespaceListResponse.properties.data, listed.data));
  assert.ok(listed.data.every(({ id }) => id !== namespaceId));

  const audits = await pool.query<{
    kind: string;
    action: string;
    outcome: string;
    details: unknown;
  }>("SELECT kind, action, outcome, details FROM occ.audit_events WHERE resource_id = $1", [
    namespaceId,
  ]);
  const namespaceAudits = audits.rows
    .filter(({ kind, action }) => kind === "mutation" && action.startsWith("openclaw.namespaces."))
    .map(({ action, details }) => {
      const record = asRecord(details);
      assert.ok(record, `expected details for ${action}`);
      return { action, details: record };
    });
  assert.deepEqual(
    namespaceAudits
      .filter(({ details }) => details.registrationId === undefined)
      .map(({ action }) => action)
      .sort(),
    [
      "openclaw.namespaces.create",
      "openclaw.namespaces.delete",
      "openclaw.namespaces.lifecycle.delete",
      "openclaw.namespaces.lifecycle.ensure",
    ].sort(),
  );
  // Driver-step evidence is separate from the existing lifecycle transition audit.
  assert.deepEqual(
    namespaceAudits
      .filter(({ details }) => details.registrationId !== undefined)
      .map(({ details }) => {
        const { registrationId, phase, outcome } = details;
        assert.ok(typeof phase === "string");
        return { registrationId, phase, outcome };
      })
      .sort((a, b) => a.phase.localeCompare(b.phase)),
    ["delete", "ensure"].map((phase) => ({
      registrationId: controller.selectedDriver("compute").id,
      phase,
      outcome: "complete",
    })),
  );
  // Each HTTP write commits a queued record with the exact job ID and the same request ID.
  const queued = audits.rows.filter(({ action }) => action === "openclaw.controller_work.queued");
  assert.equal(queued.length, lifecycleWork.rowCount);
  for (const { idempotency_key: workId, namespace_target: target } of lifecycleWork.rows) {
    const action = target === "ready" ? "openclaw.namespaces.create" : "openclaw.namespaces.delete";
    const mutation = namespaceAudits.find((event) => event.action === action);
    const requestId = asRecord(mutation?.details.__occAuditMetadata)?.requestId;
    assert.ok(typeof requestId === "string" && requestId.length > 0);
    const work = queued
      .map(({ details }) => asRecord(details))
      .find((details) => details?.workId === workId);
    assert.equal(asRecord(work?.__occAuditMetadata)?.requestId, requestId);
  }
  assert.deepEqual(
    audits.rows
      .filter(({ kind }) => kind === "api_request")
      .map(({ action, details }) => {
        const record = asRecord(details);
        return { action, operation: record?.operationId, status: record?.statusCode };
      }),
    Array.from({ length: 3 }, () => ({
      action: "openclaw.api.request.result",
      operation: "getNamespace",
      status: 200,
    })),
  );
  assert.ok(audits.rows.every(({ outcome }) => outcome === "success"));
}
