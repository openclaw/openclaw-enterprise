import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/index.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

async function createPolicyApp(t, recordOperations = false) {
  const grant = {
    id: "python-demo",
    binary: "/usr/bin/python3.11",
    host: "example.org",
    ports: [{ from: 443, to: 443 }],
  };
  // The real Driver validates and freezes policy; this case proves HTTP/IAM/PostgreSQL admission,
  // while the OpenShell runtime lane proves enforcement and loaded-version application.
  const sandboxDriver = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "python-default",
            binaries: [{ path: grant.binary }],
            endpoints: [{ host: "example.com", ports: [443], tls: "skip" }],
          },
        ],
      },
    },
    {
      id: "policy-openshell",
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: "policy-openshell", credential_gateway: "policy-credentials" },
        client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
      },
    },
  );
  const fixture = await createPostgresAgentApp(t, {
    label: "sandbox-policy",
    authSecret: "sandbox-policy-postgres-session-secret-32-characters",
    sandboxDriver,
    controllerOptions: { sandboxNetworkPolicyCeiling: [grant], recordOperations },
  });
  return { ...fixture, grant, sandboxDriver };
}

test(
  "Agent policy HTTP admission persists bounded grants without changing an admitted revision",
  requiresPostgres,
  async (t) => {
    const { pool, state, inject, deployAgent, grant } = await createPolicyApp(t);
    const { namespace, agent, revision } = await deployAgent("Sandbox policy");
    const base = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
    const read = await inject("GET", base);
    assert.equal(read.statusCode, 200, read.body);
    const original = read.json().data.policy;
    // A facet is mandatory; unsupported facets cannot read or mutate the network policy.
    assert.equal((await inject("GET", base.replace("/networking", ""))).statusCode, 404);
    for (const facet of ["filesystem", "process"]) {
      const unsupported = base.replace("/networking", `/${facet}`);
      assert.equal((await inject("GET", unsupported)).statusCode, 409);
      assert.equal(
        (await inject("PUT", unsupported, { expectedVersion: 1, additions: [grant] })).statusCode,
        409,
      );
    }

    assert.equal(read.json().data.editingEnabled, false);
    assert.deepEqual(original.additions, []);
    assert.deepEqual(revision.sandboxPolicy.additions, []);
    assert.deepEqual(read.json().data.defaults, revision.sandboxPolicy.defaults);

    // The general Agent endpoint cannot bypass the separately administered editing flag.
    const bypass = await inject("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
      sandboxPolicyEditing: true,
    });
    assert.equal(bypass.statusCode, 400, bypass.body);

    const disabled = await inject("PUT", base, { expectedVersion: 1, additions: [grant] });
    assert.equal(disabled.statusCode, 409, disabled.body);
    const enabled = await inject("PATCH", `${base}/editing`, { enabled: true });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const broad = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, host: "*.example.org" }],
    });
    assert.equal(broad.statusCode, 409, broad.body);
    const wrongBinary = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, binary: "/usr/bin/python3" }],
    });
    assert.equal(wrongBinary.statusCode, 409, wrongBinary.body);
    const wrongPort = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, ports: [{ from: 443, to: 444 }] }],
    });
    assert.equal(wrongPort.statusCode, 409, wrongPort.body);

    const changed = await inject("PUT", base, { expectedVersion: 1, additions: [grant] });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().data.version, 2);
    assert.deepEqual(changed.json().data.additions, [grant]);
    const stale = await inject("PUT", base, { expectedVersion: 1, additions: [] });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual(
      (await state.read((view) => view.revisions.findRevision(namespace.id, agent.id, revision.id)))
        .sandboxPolicy.additions,
      [],
      "saving a policy must preserve immutable deployment evidence",
    );

    // Disabling edits preserves approved grants; explicit redeployment consumes the desired policy.
    const off = await inject("PATCH", `${base}/editing`, { enabled: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual((await inject("GET", base)).json().data.policy.additions, [grant]);
    assert.equal(
      (await inject("PUT", base, { expectedVersion: 2, additions: [] })).statusCode,
      409,
    );
    const deployed = await inject("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`);
    assert.equal(deployed.statusCode, 202, deployed.body);
    const saved = await state.read((view) =>
      view.revisions.findRevision(namespace.id, agent.id, deployed.json().data.id),
    );
    assert.deepEqual(saved.sandboxPolicy.additions, [grant]);
    assert.equal(saved.sandboxPolicy.version, 2);
    assert.deepEqual(saved.sandboxPolicy.defaults, revision.sandboxPolicy.defaults);

    // Database ownership and document constraints protect persistence even outside HTTP admission.
    await assert.rejects(
      pool.query(
        "UPDATE occ.sandbox_policies SET document = jsonb_set(document,'{agentId}',to_jsonb($2::text)) WHERE id = $1",
        [original.id, `agt_${randomUUID()}`],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      pool.query(
        "UPDATE occ.sandbox_policies SET document = jsonb_set(document,'{additions}', $2::jsonb) WHERE id = $1",
        [original.id, JSON.stringify([{ ...grant, ports: [{ from: 444, to: 443 }] }])],
      ),
      { code: "23514" },
    );
    await inject("PATCH", `${base}/editing`, { enabled: true });
    // Agent update authority cannot substitute for the independent policy-resource check.
    const restriction = `restriction-${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'update','sandbox_policy',$3,'deny')",
      [restriction, namespace.id, original.id],
    );
    const refused = await inject("PUT", base, { expectedVersion: 2, additions: [grant] });
    assert.equal(refused.statusCode, 403, refused.body);
    const denial = await pool.query(
      "SELECT actor_id FROM occ.audit_events WHERE kind = 'authorization_denial' AND details#>>'{__occAuditMetadata,authorization,resource,id}' = $1",
      [original.id],
    );
    assert.ok(denial.rowCount > 0, "the exact-resource authorization denial must be attributable");

    const other = await deployAgent("Independent policy authority");
    const otherBase = `/namespaces/${other.namespace.id}/agents/${other.agent.id}/sandbox-policy/networking`;
    const crossNamespace = await inject(
      "GET",
      `/namespaces/${namespace.id}/agents/${other.agent.id}/sandbox-policy/networking`,
    );
    assert.equal(crossNamespace.statusCode, 404, crossNamespace.body);
    assert.equal(
      (await inject("PATCH", `${otherBase}/editing`, { enabled: true })).statusCode,
      200,
    );
    // Policy-resource update permission alone cannot replace exact-Agent manage_policy.
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'manage_policy','agent',$3,'deny')",
      [`restriction-${randomUUID()}`, other.namespace.id, other.agent.id],
    );
    const agentRefused = await inject("PUT", otherBase, { expectedVersion: 1, additions: [grant] });
    assert.equal(agentRefused.statusCode, 403, agentRefused.body);
    assert.deepEqual((await inject("GET", otherBase)).json().data.policy.additions, []);
  },
);

test(
  "interrupted terminal policy recovery rolls back queue failure and a restarted worker finalizes it",
  requiresPostgres,
  async (t) => {
    const { pool, state, inject, deployAgent, grant } = await createPolicyApp(t, true);
    const { namespace, agent, revision } = await deployAgent("Interrupted policy recovery");
    await state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(namespace.id);
      await unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id);
    });
    const queue = new PostgresWorkQueue(pool, { maxAttempts: 1, leaseDurationMs: 50 });
    // Prior lifecycle work has completed; the active revision is the exact application target.
    for (let claim = await queue.claim(); claim !== undefined; claim = await queue.claim()) {
      await queue.complete(claim);
    }
    const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
    assert.equal((await inject("PATCH", `${path}/editing`, { enabled: true })).statusCode, 200);
    assert.equal(
      (await inject("PUT", path, { expectedVersion: 1, additions: [grant] })).statusCode,
      200,
    );
    const admitted = await inject("POST", `${path}/apply`, {
      expectedVersion: 2,
      revisionId: revision.id,
    });
    assert.equal(admitted.statusCode, 202, admitted.body);
    const claim = await queue.claim();
    assert.equal(claim.agentTarget, "sandbox_policy");
    await pool.query(
      "UPDATE occ.controller_work SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE idempotency_key=$1",
      [claim.idempotencyKey],
    );

    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM occ.sandbox_policies WHERE agent_id=$1 FOR UPDATE", [
      agent.id,
    ]);
    const workers = [];
    const start = async () => {
      const name = `policy-recovery-${randomUUID()}`;
      const worker = createControllerWorker({
        pool: new pg.Pool({ connectionString: databaseUrl, application_name: name }),
        computeDriver: createDevelopmentComputeDriver(),
        maxAttempts: 1,
        pollIntervalMs: 30_000,
        emit() {},
      });
      workers.push(worker);
      await worker.start();
      return { worker, name };
    };
    try {
      const interrupted = await start();
      // Hold finalization after the terminal queue UPDATE. Terminating that real PostgreSQL
      // session simulates losing the worker between writes, without replacing queue behavior.
      const pid = await waitFor("policy finalization blocked after queue recovery", async () => {
        const result = await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%sandbox_policies%'",
          [interrupted.name],
        );
        return result.rows[0]?.pid;
      });
      await pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await interrupted.worker.stop();
      assert.equal(
        (await queue.findWork(claim.idempotencyKey)).state,
        "claimed",
        "the interrupted transaction must preserve recoverable work",
      );
      assert.equal((await inject("GET", path)).json().data.policy.application.state, "pending");
      await blocker.query("ROLLBACK");

      const recovered = await start();
      await waitFor("restarted worker finalizes abandoned application", async () => {
        const policy = (await inject("GET", path)).json().data.policy;
        return policy.application.state === "failed" ? policy : undefined;
      });
      await recovered.worker.stop();
      assert.equal((await queue.findWork(claim.idempotencyKey)).state, "failed_permanent");
      const audit = await pool.query(
        "SELECT actor_id FROM occ.audit_events WHERE action='openclaw.agents.sandbox_policy.application' AND resource_id=$1",
        [admitted.json().data.id],
      );
      assert.equal(audit.rowCount, 1, "terminal recovery emits one attributable policy failure");
      assert.equal(audit.rows[0].actor_id, claim.actorId);
      const next = await inject("PUT", path, { expectedVersion: 2, additions: [] });
      assert.equal(next.statusCode, 200, next.body);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      for (const worker of workers) {
        await worker.stop();
      }
    }
  },
);
