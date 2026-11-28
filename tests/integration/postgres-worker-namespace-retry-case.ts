import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import pg from "pg";
import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, withPool } from "../helpers/postgres-database.mjs";
import { waitUntil } from "../helpers/wait-for.ts";

const retryAction = "openclaw.namespaces.provision.retry";

export async function provisioningRetryCase(context: TestContext, migrationUrl: string) {
  const { pool, principal, controller, app, inject, state } = await createPostgresAgentApp(
    context,
    {
      label: "namespace-retry",
      authSecret: "namespace-retry-fixture-signing-secret",
      requestAudit: true,
      controllerOptions: { recordOperations: true },
      appOptions: {
        provisionAuthAccount: (
          ...args: Parameters<ReturnType<typeof createPostgresAuthAccountProvisioner>>
        ) => provision(...args),
      },
    },
  );
  const provision = createPostgresAuthAccountProvisioner({
    state,
    installationId: controller.installation.id,
  });
  // Adoption admission inspects the bundled Driver selection; no Kubernetes client runs here.
  const admissionDriver = createTestKubernetesComputeDriver("namespace-retry-admission");
  controller.registerDriver(admissionDriver);
  controller.selectDriver("compute", admissionDriver.id);

  async function create(name: string, adopted = false): Promise<string> {
    const response = await inject("POST", "/namespaces", {
      name,
      ...(adopted ? { existingNamespace: "existing-retry-target" } : {}),
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().data.id;
  }
  const repaired = await create("Repaired");
  const revoked = await create("Revoked");
  const deleting = await create("Deleting");
  const adopted = await create("Adopted", true);
  const key = (id: string) => `namespace:${id}:reconcile:ready`;
  const path = (id: string) => `/namespaces/${id}`;
  const retry = (id: string) => inject("POST", `${path(id)}/provision/retry`);
  const status = async (id: string) => {
    const response = await inject("GET", path(id));
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data.status;
  };
  const work = async (id: string) =>
    (await pool.query("SELECT * FROM occ.controller_work WHERE idempotency_key = $1", [key(id)]))
      .rows[0];

  // Two creators hold Installation-wide create and read; neither owns the other's retry.
  const credentials = { email: `retry-${randomUUID()}@example.test`, password: randomUUID() };
  const role = `role-${randomUUID()}`;
  await pool.query("INSERT INTO occ.iam_roles (id,name,permissions) VALUES ($1,$2,$3::jsonb)", [
    role,
    "Namespace creators",
    JSON.stringify(["create", "read"].map((action) => ({ action, resourceKind: "namespace" }))),
  ]);
  // Both keys authenticate the same Installation-scoped provisioning actor.
  const servicePrincipalId = `spn_${randomUUID()}`;
  await pool.query("INSERT INTO occ.iam_identities (id, kind) VALUES ($1, 'service_principal')", [
    servicePrincipalId,
  ]);
  await pool.query(
    "INSERT INTO occ.iam_access_bindings (id,identity_subject_id,role_id) VALUES ($1,$2,$3)",
    [`binding-${randomUUID()}`, servicePrincipalId, role],
  );
  async function issueKey(name: string): Promise<{ id: string; key: string }> {
    const issued = await inject("POST", "/api/auth/service-keys", { servicePrincipalId, name });
    assert.equal(issued.statusCode, 201);
    return issued.json().data;
  }
  const first = await issueKey("namespace-create");
  const second = await issueKey("namespace-retry");
  const serviceCreate = await app.inject({
    method: "POST",
    url: "/namespaces",
    headers: { host: "127.0.0.1", "x-api-key": first.key },
    payload: { name: "Still pending" },
  });
  assert.equal(serviceCreate.statusCode, 201);
  const pending: string = serviceCreate.json().data.id;

  const account = await inject("POST", "/api/auth/accounts", {
    ...credentials,
    name: "Another creator",
    roleId: role,
  });
  assert.equal(account.statusCode, 201, account.body);
  const binding = `binding-${randomUUID()}`;
  await pool.query(
    "INSERT INTO occ.iam_access_bindings (id,identity_subject_id,role_id) VALUES ($1,$2,$3)",
    [binding, account.json().data.principalId, role],
  );
  const session = await signInToControllerApp(app, credentials, {
    origin: "https://console.oce.localhost",
  });
  const otherHeaders = authenticatedHeaders(session, { host: "127.0.0.1" });
  const otherCreation = await app.inject({
    method: "POST",
    url: "/namespaces",
    headers: otherHeaders,
    payload: { name: "Delegate tenant" },
  });
  assert.equal(otherCreation.statusCode, 201, otherCreation.body);
  const delegateNamespace: string = otherCreation.json().data.id;

  const compute = createDevelopmentComputeDriver();
  const calls = new Map<string, number>();
  let repairedAt: number | undefined;
  const budget = 5000;
  function newWorker() {
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      pollIntervalMs: 20,
      convergenceTimeoutMs: budget,
      mode: "development",
      computeDriver: {
        ...compute,
        async ensureNamespace(ns) {
          const count = (calls.get(ns.id) ?? 0) + 1;
          calls.set(ns.id, count);
          if (ns.id === repaired || ns.id === pending) {
            // The repaired runtime still needs one pending pass before it is ready.
            return {
              namespaceId: ns.id,
              namespaceReady:
                ns.id === repaired && repairedAt !== undefined && count > repairedAt + 1,
            };
          }
          if ([revoked, deleting, adopted, delegateNamespace].includes(ns.id)) {
            return { namespaceId: ns.id, namespaceReady: false, failure: "permanent" };
          }
          return compute.ensureNamespace(ns);
        },
      },
    });
    context.after(() => worker.stop());
    return worker;
  }
  let worker = newWorker();
  await worker.start();
  for (const id of [repaired, pending, revoked, deleting, adopted, delegateNamespace]) {
    await waitUntil(
      "worker to fail Namespace provisioning",
      async () => (await status(id)) === "failed",
    );
  }
  await worker.stop();
  const terminal = await work(repaired);
  assert.equal(terminal.reason_code, "CONVERGENCE_DEADLINE_EXCEEDED");

  const other = await app.inject({
    method: "POST",
    url: `${path(repaired)}/provision/retry`,
    headers: otherHeaders,
  });
  assert.equal(other.statusCode, 403, other.body);
  assert.deepEqual(await work(repaired), terminal);

  // Withdraw the delegate's collection binding after its own provisioning failed.
  const delegateTerminal = await work(delegateNamespace);
  await withPool(migrationUrl, (migrator: pg.Pool) =>
    migrator.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [binding]),
  );
  const withdrawn = await app.inject({
    method: "POST",
    url: `${path(delegateNamespace)}/provision/retry`,
    headers: otherHeaders,
  });
  assert.equal(withdrawn.statusCode, 403, withdrawn.body);
  assert.deepEqual(await work(delegateNamespace), delegateTerminal);

  // A direct status write by the application role is not an alternative retry path.
  await assert.rejects(
    pool.query("UPDATE occ.namespaces SET status='provisioning' WHERE id=$1", [repaired]),
    { code: "23514" },
  );

  async function restrict(action: string, kind: string, id?: string) {
    const restriction = `restriction-${randomUUID()}`;
    await pool.query(
      `INSERT INTO occ.iam_restrictions (id, action, resource_kind, namespace_id, resource_id, effect)
      VALUES ($1,$2,$3,$4,$4,'deny')`,
      [restriction, action, kind, id ?? null],
    );
    // Restrictions cannot be deleted by the application role. Remove only this fixture row.
    return () =>
      withPool(migrationUrl, (migrator: pg.Pool) =>
        migrator.query("DELETE FROM occ.iam_restrictions WHERE id=$1", [restriction]),
      );
  }
  for (const [action, kind, exact, target] of [
    ["administer", "installation", undefined, adopted],
    ["create", "namespace", undefined, repaired],
    ["create", "namespace", repaired, repaired],
    ["read", "namespace", repaired, repaired],
  ] as const) {
    const before = await work(target);
    const restore = await restrict(action, kind, exact);
    try {
      assert.equal((await retry(target)).statusCode, 403);
      assert.deepEqual(await work(target), before);
    } finally {
      await restore();
    }
  }
  // The last write in admission is required evidence. A rejected insert must undo both resets.
  await withPool(migrationUrl, async (migrator: pg.Pool) => {
    await migrator.query(`ALTER TABLE occ.audit_events ADD CONSTRAINT reject_namespace_retry
      CHECK (action <> '${retryAction}') NOT VALID`);
    try {
      const failed = await retry(repaired);
      assert.ok(failed.statusCode >= 500, failed.body);
      assert.equal(await status(repaired), "failed");
      assert.deepEqual(await work(repaired), terminal);
    } finally {
      await migrator.query("ALTER TABLE occ.audit_events DROP CONSTRAINT reject_namespace_retry");
    }
  });

  const race = await Promise.all([retry(repaired), retry(repaired)]);
  assert.deepEqual(
    race.map((r) => r.statusCode).sort(),
    [202, 409],
    race.map((r) => r.body).join("\n"),
  );
  const accepted = race.find((r) => r.statusCode === 202)!;
  assert.equal(accepted.json().data.status, "provisioning");
  assert.equal(accepted.json().data.id, repaired);
  const requeued = await work(repaired);
  assert.equal(requeued.created_at.getTime(), terminal.created_at.getTime());
  assert.equal(requeued.actor_id, terminal.actor_id);
  assert.equal(requeued.state, "queued");
  assert.equal(requeued.attempt_count, 0);
  assert.equal(requeued.reason_code, null);
  assert.equal((await retry(repaired)).statusCode, 409);
  assert.deepEqual(await work(repaired), requeued);
  const audits = await pool.query(
    `SELECT actor_id, details FROM occ.audit_events
    WHERE action=$1 AND namespace_id=$2 AND outcome='success' AND kind='mutation'`,
    [retryAction, repaired],
  );
  assert.equal(audits.rowCount, 1);
  const audit = audits.rows[0];
  assert.equal(audit.actor_id, principal.id);
  assert.equal(Object.hasOwn(audit.details, "actorServiceKeyId"), false);
  assert.equal(audit.details.workId, key(repaired));
  assert.equal(audit.details.previousAttemptCount, terminal.attempt_count);
  assert.equal(audit.details.previousReasonCode, terminal.reason_code);
  assert.equal(audit.details.__occAuditMetadata.requestId, accepted.headers["x-request-id"]);

  const [racingRetry, removal] = await Promise.all([
    retry(deleting),
    inject("DELETE", path(deleting)),
  ]);
  assert.ok([202, 409].includes(racingRetry.statusCode), racingRetry.body);
  assert.equal(removal.statusCode, 202, removal.body);
  assert.equal(await status(deleting), "deleting");
  assert.equal((await retry(deleting)).statusCode, 409);
  assert.equal((await retry(revoked)).statusCode, 202);
  const beforeRevocation = calls.get(revoked);
  const restore = await restrict("read", "namespace", revoked);
  try {
    repairedAt = calls.get(repaired);
    worker = newWorker();
    await worker.start();
    await waitUntil(
      "repaired Namespace to become ready",
      async () => (await status(repaired)) === "ready",
    );
    await waitUntil(
      "dispatch to refuse revoked read",
      async () => (await work(revoked)).reason_code === "AUTHORIZATION_DENIED",
    );
    assert.equal(calls.get(revoked), beforeRevocation);
    await waitUntil(
      "deleting Namespace to be tombstoned",
      async () => (await inject("GET", path(deleting))).statusCode === 404,
    );
  } finally {
    await worker.stop();
    await restore();
  }
  assert.equal(await status(revoked), "failed");
  assert.equal((await retry(deleting)).statusCode, 404);

  // A different key may retry for the original actor. The committed mutation must identify
  // the key used for retry, not the creation key or either credential's secret value.
  const serviceRetry = await app.inject({
    method: "POST",
    url: `${path(pending)}/provision/retry`,
    headers: { host: "127.0.0.1", "x-api-key": second.key },
  });
  assert.equal(serviceRetry.statusCode, 202);
  const keyedAudits = await pool.query(
    `SELECT actor_id, details FROM occ.audit_events WHERE action=$1 AND namespace_id=$2
       AND kind='mutation' AND outcome='success'`,
    [retryAction, pending],
  );
  assert.equal(keyedAudits.rowCount, 1);
  const keyed = keyedAudits.rows[0];
  const serialized = JSON.stringify(keyed);
  assert.ok(
    !serialized.includes(first.key) && !serialized.includes(second.key),
    "retry audit contains credential material",
  );
  assert.equal(keyed.actor_id, servicePrincipalId);
  assert.notEqual(first.id, second.id);
  assert.ok(
    keyed.details.actorServiceKeyId === second.id,
    "retry audit must name the second key's verified ID",
  );
  assert.equal(keyed.details.__occAuditMetadata.requestId, serviceRetry.headers["x-request-id"]);
  const start = (await work(pending)).provisioning_retry_at;
  const previous = calls.get(pending)!;
  worker = newWorker();
  await worker.start();
  await waitUntil(
    "retried work to be deferred after a pending pass",
    async () => calls.get(pending)! > previous && (await work(pending)).state === "queued",
  );
  await worker.stop();
  // Downtime consumes the new budget. The first observation on restart must settle the failure.
  await pool.query(
    "SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM $1::timestamptz - clock_timestamp()) + $2::double precision))",
    [start, budget / 1000],
  );
  const beforeRestart = calls.get(pending)!;
  worker = newWorker();
  await worker.start();
  await waitUntil(
    "unrepaired Namespace to expire",
    async () => (await status(pending)) === "failed",
  );
  assert.equal(calls.get(pending), beforeRestart + 1);
  assert.equal((await work(pending)).reason_code, "CONVERGENCE_DEADLINE_EXCEEDED");
  await worker.stop();
}
