import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { OpenClawController, PostgresWorkQueue } from "../../packages/occ/src/index.ts";
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
  const providerRefusalGrant = {
    ...grant,
    id: "wide-ports",
    host: "ports.example.org",
    ports: [{ from: 1, to: 2048 }],
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
    controllerOptions: {
      sandboxNetworkPolicyCeiling: [grant, providerRefusalGrant],
      recordOperations,
      driverConfigurations: [
        {
          capability: "sandbox",
          driverId: sandboxDriver.id,
          implementation: sandboxDriver.implementation,
          definition: OpenShellSandboxDriver,
        },
      ],
    },
  });
  return { ...fixture, grant, providerRefusalGrant, sandboxDriver };
}

test(
  "Agent policy HTTP admission persists bounded grants without changing an admitted revision",
  requiresPostgres,
  async (t) => {
    const { pool, state, inject, deployAgent, grant, providerRefusalGrant } =
      await createPolicyApp(t);
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
    // Discovery returns owner URLs and schema only, with exact-resource authorization.
    const discoveryPath = `/namespaces/${namespace.id}/agents/${agent.id}/driver-configurations`;
    const discovery = await inject("GET", discoveryPath);
    assert.equal(discovery.statusCode, 200, discovery.body);
    const descriptor = discovery.json().data.configurations[0];
    assert.equal(descriptor.driverId, "policy-openshell");
    assert.equal(descriptor.key, "sandbox-network-policy");
    assert.equal(descriptor.actions.validate.href, `${base}/validate`);
    assert.equal(descriptor.actions.save.available, true);
    assert.deepEqual((await inject("GET", base)).json().data.configuration, descriptor);
    const installationDiscovery = await inject("GET", "/installation/driver-configurations");
    assert.equal(installationDiscovery.statusCode, 200, installationDiscovery.body);
    assert.equal(installationDiscovery.json().data.configurations[0].key, "startup");
    assert.deepEqual(installationDiscovery.json().data.configurations[0].actions, {});
    assert.equal(
      Object.hasOwn(installationDiscovery.json().data.configurations[0], "configuration"),
      false,
    );
    const beforePreview = await pool.query(
      "SELECT count(*) AS count FROM occ.controller_work WHERE namespace_id=$1",
      [namespace.id],
    );
    const invalid = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [{ ...grant, ports: [{ from: 70000, to: "bad" }], host: "bad..host" }],
    });
    assert.equal(invalid.statusCode, 200, invalid.body);
    assert.equal(invalid.json().data.success, false);
    assert.ok(
      invalid.json().data.error.details.some(({ path }) => path === "/additions/0/ports/0/from"),
    );
    assert.ok(
      invalid.json().data.error.details.some(({ path }) => path === "/additions/0/ports/0/to"),
    );
    const invalidEnvelope = await inject("POST", `${base}/validate`, {
      expectedVersion: "wrong",
      additions: [],
    });
    assert.equal(invalidEnvelope.statusCode, 400, invalidEnvelope.body);
    const providerRefusal = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [providerRefusalGrant],
    });
    assert.equal(providerRefusal.statusCode, 200, providerRefusal.body);
    assert.equal(providerRefusal.json().data.success, false);
    assert.equal(providerRefusal.json().data.error.details[0].path, "/additions");
    const preview = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [grant],
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().data, { success: true, data: { additions: [grant] } });
    const range = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [{ ...grant, ports: [{ from: 444, to: 443 }] }],
    });
    assert.equal(range.json().data.error.details[0].code, "INVALID_RANGE");
    assert.equal((await inject("GET", base)).json().data.policy.version, 1);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT count(*) AS count FROM occ.controller_work WHERE namespace_id=$1",
          [namespace.id],
        )
      ).rows,
      beforePreview.rows,
    );

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
    assert.equal(
      (await inject("POST", `${base}/validate`, { expectedVersion: 1, additions: [grant] }))
        .statusCode,
      409,
    );
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
    assert.equal(
      (await inject("POST", `${base}/validate`, { expectedVersion: 2, additions: [grant] }))
        .statusCode,
      403,
    );
    const withoutEdit = (await inject("GET", discoveryPath)).json().data.configurations[0];
    assert.equal(withoutEdit.actions.save.available, false);
    // Owner read denial filters discovery without weakening the policy read endpoint.
    const readRestriction = `restriction-${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'read','sandbox_policy',$3,'deny')",
      [readRestriction, namespace.id, original.id],
    );
    assert.deepEqual((await inject("GET", discoveryPath)).json().data.configurations, []);
    assert.equal((await inject("GET", base)).statusCode, 403);
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

test(
  "restarted controller rechecks a reduced ceiling before saving, applying, or deploying",
  requiresPostgres,
  async (t) => {
    const fixture = await createPolicyApp(t);
    const { state, controller, pool, inject, deployAgent, grant, sandboxDriver } = fixture;
    const { namespace, agent, revision } = await deployAgent("Ceiling restart");
    // The fixture activates a real admitted revision; this test proves HTTP admission, not provider effects.
    await state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(namespace.id);
      await unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id);
    });
    const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
    assert.equal((await inject("PATCH", `${path}/editing`, { enabled: true })).statusCode, 200);
    const preview = await inject("POST", `${path}/validate`, {
      expectedVersion: 1,
      additions: [grant],
    });
    assert.equal(preview.json().data.success, true);
    assert.equal(
      (await inject("PUT", path, { expectedVersion: 1, additions: [grant] })).statusCode,
      200,
    );
    const previous = (await inject("GET", path)).json().data.policy;
    const jobs = await pool.query(
      "SELECT count(*) AS count FROM occ.controller_work WHERE namespace_id=$1",
      [namespace.id],
    );
    // Startup is the owner of the ceiling. A new controller uses the same database and real IAM,
    // with a smaller operator delegation; no mutable test hook changes the running controller.
    const restarted = new OpenClawController(controller.installation, {
      state,
      recordOperations: false,
      sandboxNetworkPolicyCeiling: [],
      driverConfigurations: [
        {
          capability: "sandbox",
          driverId: sandboxDriver.id,
          implementation: sandboxDriver.implementation,
          definition: OpenShellSandboxDriver,
        },
      ],
    });
    for (const capability of ["iam", "configuration", "compute", "secret", "sandbox"]) {
      const driver = controller.selectedDriver(capability);
      restarted.registerDriver(driver);
      restarted.selectDriver(capability, driver.id);
    }
    const app = fixture.createApp(restarted);
    const revisions = await state.read((view) =>
      view.revisions.listRevisions(namespace.id, agent.id),
    );
    for (const [method, url, body] of [
      ["PUT", path, { expectedVersion: 2, additions: [grant] }],
      ["POST", `${path}/apply`, { expectedVersion: 2, revisionId: revision.id }],
      ["POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`, undefined],
    ]) {
      const refused = await inject(method, url, body, app);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(
        refused.json().error.message,
        "The requested network policy exceeds the Installation delegation ceiling.",
      );
      assert.deepEqual(refused.json().error.details, [
        {
          path: "/additions/0",
          code: "OUTSIDE_CEILING",
          message: "The grant exceeds the Installation delegation ceiling.",
        },
      ]);
    }
    assert.deepEqual(
      await state.read((view) => view.revisions.listRevisions(namespace.id, agent.id)),
      revisions,
    );
    assert.deepEqual((await inject("GET", path)).json().data.policy, previous);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT count(*) AS count FROM occ.controller_work WHERE namespace_id=$1",
          [namespace.id],
        )
      ).rows,
      jobs.rows,
    );
  },
);
