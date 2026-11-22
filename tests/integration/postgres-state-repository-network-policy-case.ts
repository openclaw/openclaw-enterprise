import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { createBackendWorkerDrivers } from "../helpers/postgres-backend-state.mjs";
import pg from "pg";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { waitFor, waitUntil } from "../helpers/wait-for.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  type AgentRevision,
  type ComputeDriver,
  type SandboxDriver,
  type RepositoryNetworkGrant,
  type SandboxNetworkGrant,
  type SandboxPolicy,
  type SandboxPolicyApplication,
  type SandboxPolicySnapshot,
} from "../../packages/contracts/src/index.ts";
import {
  AuthorizationDeniedError,
  InMemoryPlatformState,
  ScopeViolationError,
  type PlatformStateStore,
} from "../../packages/occ/src/index.ts";
import { seedPlatformState } from "../conformance/platform-state-contract-fixture.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";

type PolicyApp = Awaited<ReturnType<typeof createPostgresAgentApp>>;

function storedRevisionWriter(pool: PolicyApp["pool"], originalId: string) {
  return (candidate: Pick<AgentRevision, "id" | "revision">, spec: Record<string, unknown>) =>
    pool.query(
      `INSERT INTO occ.agent_revisions
        (id,namespace_id,agent_id,revision_number,backend_id,admitted_spec,gateway_managed_mode,admitted_at)
       SELECT $1,namespace_id,agent_id,$2,backend_id,
         admitted_spec || $3::jsonb,gateway_managed_mode,now()
       FROM occ.agent_revisions WHERE id=$4`,
      [candidate.id, candidate.revision, JSON.stringify(spec), originalId],
    );
}

function snapshotPolicy(grants: readonly RepositoryNetworkGrant[]) {
  const version = 1 as const;
  return { version, grants, identity: JSON.stringify({ version, grants }) };
}

async function verifyLiveApplicationSnapshot(
  state: PlatformStateStore,
  namespaceId: string,
  agentId: string,
  revisionId: string,
): Promise<void> {
  const readPolicy = () => state.read((view) => view.sandboxPolicies.find(namespaceId, agentId));
  const savePolicy = (policy: SandboxPolicy) =>
    state.transact((unit) => unit.sandboxPolicies.save(policy, policy.version));
  const original = await readPolicy();
  const revision = await state.read((view) =>
    view.revisions.findRevision(namespaceId, agentId, revisionId),
  );
  assert.ok(original);
  assert.ok(revision);
  assert.equal(original.repositoryNetworkPolicy, undefined);
  assert.equal(revision.sandboxPolicy?.repositoryNetworkPolicy, undefined);

  const application: SandboxPolicyApplication = {
    id: randomUUID(),
    revisionId,
    policyVersion: original.version,
    snapshot: {
      driverId: "test-sandbox",
      implementation: "test",
      version: original.version,
      defaults: {},
      additions: original.additions,
    },
    state: "pending",
    requestedBy: "test-administrator",
    requestedAt: new Date().toISOString(),
  };

  // An explicit deny-all list in the application alone must require a new deployment.
  const denyAll = snapshotPolicy([]);
  await assert.rejects(
    savePolicy({
      ...original,
      application: {
        ...application,
        snapshot: { ...application.snapshot, repositoryNetworkPolicy: denyAll },
      },
    }),
    ScopeViolationError,
  );
  assert.deepEqual(await readPolicy(), original);

  // The same application can settle when its snapshot carries ordinary network policy.
  const pending = { ...original, application };
  assert.deepEqual(await savePolicy(pending), pending);
  const providerVersion = "sandbox-policy-version-1";
  const applied: SandboxPolicy = {
    ...pending,
    application: { ...application, state: "applied", providerVersion },
    applied: {
      revisionId,
      policyVersion: original.version,
      providerVersion,
      appliedAt: new Date().toISOString(),
    },
  };
  assert.deepEqual(await savePolicy(applied), applied);
  assert.deepEqual(await readPolicy(), applied);
}

function protectedSuccessor(revision: AgentRevision, installationId: string): AgentRevision {
  const id = `rev_${randomUUID()}`;
  assert.ok(revision.sandboxDriverId);
  return {
    ...revision,
    id,
    revision: revision.revision + 1,
    executionAdmission: { version: 3, mode: "protected" },
    egressPlan: {
      id: "repository-policy-protected-plan",
      generation: 1,
      execution: {
        installationId,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: id,
        servicePrincipalId: revision.servicePrincipalId,
        executionId: randomUUID(),
      },
      sandboxDriverId: revision.sandboxDriverId,
      egressDriverId: "test-egress",
      driver: {
        id: "test-egress",
        implementation: "test",
        configurationId: "a".repeat(64),
      },
      routes: [],
    },
  };
}

export async function verifyMemoryRepositoryPolicyPersistence(): Promise<void> {
  const state = new InMemoryPlatformState();
  const { installation, namespace, agent, revision } = await seedPlatformState(state);
  await verifyLiveApplicationSnapshot(state, namespace.id, agent.id, revision.id);

  const nextRevision = { ...revision, id: `rev_${randomUUID()}`, revision: revision.revision + 1 };
  const denyAll = snapshotPolicy([]);
  const original = await state.read((view) => view.sandboxPolicies.find(namespace.id, agent.id));
  assert.ok(original);
  const { application: _application, ...current } = original;
  const desired = { ...current, version: original.version + 1, repositoryNetworkPolicy: [] };
  const snapshot = {
    driverId: "test-sandbox",
    implementation: "test",
    version: desired.version,
    defaults: {},
    additions: [],
    repositoryNetworkPolicy: denyAll,
  };
  assert.deepEqual(
    await state.transact((unit) => unit.sandboxPolicies.save(desired, original.version)),
    desired,
  );

  const createRevision = (input: AgentRevision) =>
    state.transact((unit) => unit.revisions.createRevision(input));
  const readRevision = (id: string) =>
    state.read((view) => view.revisions.findRevision(namespace.id, agent.id, id));

  // An empty grant list still requires a scoped snapshot and enforcement.
  await assert.rejects(createRevision(nextRevision), ScopeViolationError);
  assert.equal(await readRevision(nextRevision.id), undefined);
  const scoped = { ...nextRevision, sandboxDriverId: snapshot.driverId, sandboxPolicy: snapshot };
  const created = await createRevision(scoped);
  assert.deepEqual(await readRevision(scoped.id), created);
  assert.deepEqual(created.sandboxPolicy?.repositoryNetworkPolicy, denyAll);

  const protectedRevision = protectedSuccessor(scoped, installation.id);
  const createdProtected = await createRevision(protectedRevision);
  assert.deepEqual(await readRevision(protectedRevision.id), createdProtected);
  assert.deepEqual(createdProtected.sandboxPolicy?.repositoryNetworkPolicy, denyAll);
  assert.deepEqual(createdProtected.egressPlan, protectedRevision.egressPlan);
}

export async function persistRepositoryNetworkPolicy(t: TestContext): Promise<void> {
  const { deployAgent, inject, state, pool } = await createPostgresAgentApp(t, {
    label: "repository-network-policy",
    authSecret: "repository-network-policy-fixture-session-secret",
  });
  const live = await deployAgent("Live sandbox policy");
  await verifyLiveApplicationSnapshot(state, live.namespace.id, live.agent.id, live.revision.id);
  const ordinary = await inject(
    "POST",
    `/namespaces/${live.namespace.id}/agents/${live.agent.id}/deploy`,
  );
  assert.equal(ordinary.statusCode, 202, ordinary.body);
  const { namespace, agent, revision } = await deployAgent("Repository network policy");
  const readPolicy = () => state.read((view) => view.sandboxPolicies.find(namespace.id, agent.id));
  const readRevision = (revisionId: string) =>
    state.read((view) => view.revisions.findRevision(namespace.id, agent.id, revisionId));
  const savePolicy = (policy: SandboxPolicy, expectedVersion: number) =>
    state.transact((unit) => unit.sandboxPolicies.save(policy, expectedVersion));
  const original = await readPolicy();
  assert.ok(original);
  assert.equal(Object.hasOwn(original, "repositoryNetworkPolicy"), false);

  const readStoredSpec = async (id: string) => {
    const {
      rows: [row],
    } = await pool.query<{
      admitted_spec: {
        execution_admission: unknown;
        harness_auth: Record<string, unknown>;
        egress_plan?: unknown;
      };
    }>("SELECT admitted_spec FROM occ.agent_revisions WHERE id=$1", [id]);
    assert.ok(row);
    return row.admitted_spec;
  };
  const stored = await readStoredSpec(revision.id);
  assert.deepEqual(stored.execution_admission, revision.executionAdmission);
  const insertStoredRevision = (
    candidate: Pick<AgentRevision, "id" | "revision">,
    spec: Record<string, unknown>,
  ) =>
    pool.query(
      `INSERT INTO occ.agent_revisions
        (id,namespace_id,agent_id,revision_number,backend_id,admitted_spec,gateway_managed_mode,admitted_at)
       SELECT $1,namespace_id,agent_id,$2,backend_id,
         admitted_spec || $3::jsonb,gateway_managed_mode,now()
       FROM occ.agent_revisions WHERE id=$4`,
      [candidate.id, candidate.revision, JSON.stringify(spec), revision.id],
    );
  const readerVersionConstraint = "agent_revisions_repository_policy_reader_version";
  await assert.rejects(
    insertStoredRevision(
      { id: `rev_${randomUUID()}`, revision: revision.revision + 1 },
      {
        execution_admission: { ...revision.executionAdmission, repositoryNetworkPolicyVersion: 1 },
      },
    ),
    { code: "23514", constraint: readerVersionConstraint },
  );

  const grants: readonly RepositoryNetworkGrant[] = [
    { repository: "example/project-a", access: "read" },
    { repository: "example/project-b", access: "write" },
  ];
  const desired = { ...original, version: original.version + 1, repositoryNetworkPolicy: grants };
  await assert.rejects(
    savePolicy({ ...desired, version: original.version }, original.version),
    ScopeViolationError,
  );
  await assert.rejects(
    savePolicy({ ...desired, repositoryNetworkPolicy: [...grants].reverse() }, original.version),
    ScopeViolationError,
  );
  assert.deepEqual(await savePolicy(desired, original.version), desired);
  assert.equal(
    await savePolicy(desired, original.version),
    undefined,
    "a stale version cannot save",
  );

  // The ordinary deployment endpoint cannot enqueue an unscoped successor.
  const revisions = () =>
    pool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2 ORDER BY revision_number",
      [namespace.id, agent.id],
    );
  const deployed = await inject("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`);
  assert.equal(deployed.statusCode, 409, deployed.body);
  assert.equal(deployed.json().error.code, "RESOURCE_CONFLICT");
  assert.deepEqual((await revisions()).rows, [{ id: revision.id }]);
  assert.deepEqual(await readPolicy(), desired);

  const legacyWrite = { ...original, version: desired.version + 1 };
  await assert.rejects(savePolicy(legacyWrite, desired.version), ScopeViolationError);
  assert.deepEqual(await readPolicy(), desired);

  const baseSnapshot: SandboxPolicySnapshot = {
    driverId: "test-sandbox",
    implementation: "test",
    version: desired.version,
    defaults: {},
    additions: [],
  };
  await assert.rejects(
    savePolicy(
      {
        ...desired,
        application: {
          id: randomUUID(),
          revisionId: revision.id,
          policyVersion: desired.version,
          snapshot: baseSnapshot,
          state: "pending",
          requestedBy: "test-administrator",
          requestedAt: new Date().toISOString(),
        },
      },
      desired.version,
    ),
    ScopeViolationError,
  );

  const nextRevision: AgentRevision = {
    ...revision,
    id: `rev_${randomUUID()}`,
    revision: revision.revision + 1,
  };
  const admitted = snapshotPolicy(grants);
  const scopedUnprotectedRevision: AgentRevision = {
    ...nextRevision,
    sandboxDriverId: baseSnapshot.driverId,
    sandboxPolicy: { ...baseSnapshot, repositoryNetworkPolicy: admitted },
  };
  const createRevision = (input: AgentRevision) =>
    state.transact((unit) => unit.revisions.createRevision(input));
  await assert.rejects(createRevision(nextRevision), ScopeViolationError);
  assert.equal(await readRevision(nextRevision.id), undefined);
  await assert.rejects(
    createRevision({
      ...scopedUnprotectedRevision,
      sandboxPolicy: {
        ...baseSnapshot,
        repositoryNetworkPolicy: { ...admitted, identity: "stale" },
      },
    }),
    ScopeViolationError,
  );

  const marker = { repositoryNetworkPolicyVersion: admitted.version };
  const storedAdmission = { ...scopedUnprotectedRevision.executionAdmission, ...marker };
  // The storage-only marker must never become part of the public execution admission.
  await assert.rejects(
    createRevision({ ...scopedUnprotectedRevision, executionAdmission: storedAdmission }),
    ScopeViolationError,
  );
  const scoped = await createRevision(scopedUnprotectedRevision);
  assert.deepEqual((await readStoredSpec(scoped.id)).execution_admission, storedAdmission);
  assert.deepEqual(await readRevision(scoped.id), scoped);
  assert.deepEqual(scoped.executionAdmission, revision.executionAdmission);
  assert.deepEqual(scoped.sandboxPolicy?.repositoryNetworkPolicy, admitted);

  const installation = await state.loadInstallation();
  assert.ok(installation);
  const protectedRevision = protectedSuccessor(scopedUnprotectedRevision, installation.id);

  const scope = { sandbox_driver_id: baseSnapshot.driverId, sandbox_policy: scoped.sandboxPolicy };
  const protectedSpec: Record<string, unknown> = {
    ...scope,
    egress_plan: protectedRevision.egressPlan,
    harness_auth: {
      ...stored.harness_auth,
      protectedExecutionVersion: protectedRevision.executionAdmission.version,
    },
  };
  // Both scoped modes require the marker even when a row comes from a newer writer.
  const ordinarySpec = { ...scope, execution_admission: scoped.executionAdmission };
  const ordinaryProbe = { id: `rev_${randomUUID()}`, revision: protectedRevision.revision + 1 };
  await assert.rejects(insertStoredRevision(ordinaryProbe, ordinarySpec), {
    code: "23514",
    constraint: readerVersionConstraint,
  });
  await assert.rejects(
    insertStoredRevision(protectedRevision, {
      ...protectedSpec,
      execution_admission: protectedRevision.executionAdmission,
    }),
    { code: "23514", constraint: readerVersionConstraint },
  );
  for (const repositoryNetworkPolicyVersion of [2, null, "1"]) {
    await assert.rejects(
      insertStoredRevision(ordinaryProbe, {
        ...ordinarySpec,
        execution_admission: { ...storedAdmission, repositoryNetworkPolicyVersion },
      }),
      { code: "23514", constraint: readerVersionConstraint },
    );
  }
  await assert.rejects(
    insertStoredRevision(ordinaryProbe, {
      ...ordinarySpec,
      execution_admission: { ...storedAdmission, unexpected: true },
    }),
    { code: "23514", constraint: "agent_revisions_execution_admission" },
  );
  // Protected admission preserves the egress plan and both storage reader markers.
  await createRevision(protectedRevision);
  const storedProtected = await readStoredSpec(protectedRevision.id);
  assert.deepEqual(storedProtected.execution_admission, {
    ...protectedRevision.executionAdmission,
    ...marker,
  });
  assert.equal(
    storedProtected.harness_auth.protectedExecutionVersion,
    protectedRevision.executionAdmission.version,
  );
  assert.deepEqual(storedProtected.egress_plan, protectedRevision.egressPlan);
  const protectedRead = await readRevision(protectedRevision.id);
  assert.deepEqual(protectedRead?.executionAdmission, protectedRevision.executionAdmission);
  assert.deepEqual(protectedRead?.egressPlan, protectedRevision.egressPlan);
  assert.deepEqual(protectedRead?.sandboxPolicy?.repositoryNetworkPolicy, admitted);

  const denyAll = { ...desired, version: desired.version + 1, repositoryNetworkPolicy: [] };
  // The user can withdraw existing grants even after losing the Sandbox Driver.
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
  const enabled = await inject("PATCH", path + "/editing", { enabled: true });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const withdrawal = await inject("PUT", path, {
    expectedVersion: desired.version,
    additions: [],
    repositoryNetworkPolicy: [],
  });
  assert.equal(withdrawal.statusCode, 200, withdrawal.body);
  assert.deepEqual(await readPolicy(), denyAll);
  assert.deepEqual((await readPolicy())?.repositoryNetworkPolicy, []);
  assert.deepEqual(
    (await readRevision(revision.id))?.executionAdmission,
    revision.executionAdmission,
  );
  assert.equal(
    (await readRevision(revision.id))?.sandboxPolicy?.repositoryNetworkPolicy,
    undefined,
  );
  assert.deepEqual(
    (await readRevision(scoped.id))?.sandboxPolicy?.repositoryNetworkPolicy,
    admitted,
  );

  const admittedDenyAll = snapshotPolicy([]);
  assert.ok(admittedDenyAll);
  const denyAllRevision: AgentRevision = {
    ...scopedUnprotectedRevision,
    id: `rev_${randomUUID()}`,
    revision: protectedRevision.revision + 1,
    sandboxPolicy: { ...baseSnapshot, repositoryNetworkPolicy: admittedDenyAll },
  };
  // Even with the correct grants and identity, admission must use the saved version.
  await assert.rejects(createRevision(denyAllRevision), ScopeViolationError);
  const denied = await createRevision({
    ...denyAllRevision,
    sandboxPolicy: {
      ...baseSnapshot,
      version: denyAll.version,
      repositoryNetworkPolicy: admittedDenyAll,
    },
  });
  assert.deepEqual((await readStoredSpec(denied.id)).execution_admission, storedAdmission);
  assert.deepEqual(
    (await readRevision(denied.id))?.sandboxPolicy?.repositoryNetworkPolicy,
    admittedDenyAll,
  );
}

async function policyEditor({ deployAgent, inject, state, pool }: PolicyApp) {
  const { namespace, agent, revision } = await deployAgent("Edit stored repository grants");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
  const view = async () => {
    const response = await inject("GET", path);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  const stored = async () => {
    const { rows } = await pool.query<{ document: SandboxPolicy }>(
      "SELECT document FROM occ.sandbox_policies WHERE namespace_id=$1 AND agent_id=$2",
      [namespace.id, agent.id],
    );
    assert.equal(rows.length, 1);
    return rows[0]!.document;
  };
  const enabled = await inject("PATCH", path + "/editing", { enabled: true });
  assert.equal(enabled.statusCode, 200, enabled.body);

  const original = await stored();
  const grants = [{ repository: "example/project", access: "write" }] as const;
  const read = async () => (await view()).policy;
  const seed = async () => {
    // Begin with a policy persisted by an installation supporting grant creation.
    const existing = {
      ...original,
      version: original.version + 1,
      repositoryNetworkPolicy: grants,
    };
    await state.transact((unit) => unit.sandboxPolicies.save(existing, original.version));
    return existing;
  };
  const deny = (action: "read" | "update") =>
    pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,$3,'sandbox_policy',$4,'deny')",
      ["restriction-" + randomUUID(), namespace.id, action, original.id],
    );
  return { namespace, agent, revision, path, original, grants, stored, view, read, seed, deny };
}

async function verifyUpdateWithoutRead(fixture: PolicyApp, addition: SandboxNetworkGrant) {
  const { path, stored, seed, deny } = await policyEditor(fixture);
  const policy = await seed();
  await deny("read");
  const { inject } = fixture;
  const get = await inject("GET", path);
  assert.equal(get.statusCode, 403, get.body);
  const put = await inject("PUT", path, { expectedVersion: policy.version, additions: [addition] });
  assert.equal(put.statusCode, 200, put.body);
  const { repositoryNetworkPolicy: grants, ...ordinary } = policy;
  const updated = { ...ordinary, version: policy.version + 1, additions: [addition] };
  assert.deepEqual(put.json().data, updated);
  const retained = { ...updated, repositoryNetworkPolicy: grants };
  assert.deepEqual(await stored(), retained);
  const clear = await inject("PUT", path, {
    expectedVersion: retained.version,
    additions: [],
    repositoryNetworkPolicy: [],
  });
  assert.equal(clear.statusCode, 403, clear.body);
  assert.deepEqual(await stored(), retained);
}

export async function editStoredRepositoryGrants(
  fixture: PolicyApp,
  addition: SandboxNetworkGrant,
): Promise<void> {
  await verifyUpdateWithoutRead(fixture, addition);
  const { inject, pool, state } = fixture;
  const { namespace, agent, revision, path, original, grants, stored, view, read, seed, deny } =
    await policyEditor(fixture);
  assert.equal(Object.hasOwn(await read(), "repositoryNetworkPolicy"), false);

  for (const repositoryNetworkPolicy of [[], grants]) {
    const first = await inject("PUT", path, {
      expectedVersion: original.version,
      additions: [],
      repositoryNetworkPolicy,
    });
    assert.equal(first.statusCode, 409, first.body);
    assert.deepEqual(await stored(), original);
  }

  const existing = await seed();
  assert.deepEqual(await read(), existing);

  const saved = await inject("PUT", path, {
    expectedVersion: existing.version,
    additions: [addition],
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const preserved = { ...existing, version: existing.version + 1, additions: [addition] };
  assert.deepEqual(await stored(), preserved);
  assert.deepEqual(await read(), preserved);

  // Model a compatible controller having admitted a repository policy in unprotected execution.
  assert.equal(revision.executionAdmission.mode, "unprotected");
  const id = `rev_${randomUUID()}`;
  const insert = storedRevisionWriter(pool, revision.id);
  assert.ok(revision.sandboxPolicy);
  await insert(
    { id, revision: revision.revision + 1 },
    {
      sandbox_policy: {
        ...revision.sandboxPolicy,
        version: preserved.version,
        additions: preserved.additions,
        repositoryNetworkPolicy: snapshotPolicy(grants),
      },
      execution_admission: { ...revision.executionAdmission, repositoryNetworkPolicyVersion: 1 },
    },
  );
  const activated = await pool.query(
    "UPDATE occ.agents SET active_revision_id=$1, desired_runtime_state='running' WHERE namespace_id=$2 AND id=$3",
    [id, namespace.id, agent.id],
  );
  assert.equal(activated.rowCount, 1);
  const revisionRead = () =>
    state.read((view) => view.revisions.findRevision(namespace.id, agent.id, id));
  assert.deepEqual(
    (await revisionRead())?.sandboxPolicy?.repositoryNetworkPolicy,
    snapshotPolicy(grants),
  );
  const observed = await view();
  assert.deepEqual(observed.policy, preserved);
  assert.equal(observed.repositoryNetworkPolicySaveSupported, true);
  assert.deepEqual(observed.defaults, revision.sandboxPolicy.defaults);
  assert.equal(observed.protectedExecution, false);
  assert.equal(observed.defaultsRevisionId, id);
  assert.equal(observed.deployedPolicyVersion, preserved.version);
  const apply = await inject("POST", path + "/apply", {
    expectedVersion: preserved.version,
    revisionId: id,
  });
  assert.equal(apply.statusCode, 409, apply.body);
  assert.ok(
    apply
      .json()
      .error.message.includes(
        "Use a controller and Worker that support the active revision to stop the Agent and confirm its workload has stopped.",
      ),
  );
  assert.deepEqual(await stored(), preserved);

  const withdrawal = {
    expectedVersion: preserved.version,
    additions: [],
    repositoryNetworkPolicy: [],
  };
  const stale = await inject("PUT", path, { ...withdrawal, expectedVersion: existing.version });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.deepEqual(await stored(), preserved);
  const updated = await inject("PUT", path, withdrawal);
  assert.equal(updated.statusCode, 200, updated.body);
  const cleared = {
    ...preserved,
    additions: [],
    version: preserved.version + 1,
    repositoryNetworkPolicy: [],
  };
  assert.deepEqual(await stored(), cleared);
  assert.deepEqual(await read(), cleared);
  assert.deepEqual(
    (await revisionRead())?.sandboxPolicy?.repositoryNetworkPolicy,
    snapshotPolicy(grants),
  );
  const regrant = await inject("PUT", path, {
    ...withdrawal,
    expectedVersion: cleared.version,
    repositoryNetworkPolicy: grants,
  });
  assert.equal(regrant.statusCode, 409, regrant.body);
  assert.deepEqual(await stored(), cleared);

  await deny("update");
  const forbidden = await inject("PUT", path, { ...withdrawal, expectedVersion: cleared.version });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.deepEqual(await stored(), cleared);
}

export async function rejectStaleRepositoryPolicySave(
  t: TestContext,
  fixture: PolicyApp,
  label: string,
): Promise<void> {
  const { pool, inject, controller, principal } = fixture;
  const {
    rows: [settings],
  } = await pool.query<{ isolation: string }>(
    "SELECT current_setting('default_transaction_isolation') AS isolation",
  );
  assert.equal(settings?.isolation, "repeatable read");

  for (const route of ["HTTP PUT", "direct OCC"] as const) {
    await t.test(route, async (caseContext) => {
      const { namespace, agent, path, seed, stored } = await policyEditor(fixture);
      const original = await seed();
      const save = async () => {
        if (route === "HTTP PUT") {
          const reply = await inject("PUT", path, {
            expectedVersion: original.version,
            additions: [],
            repositoryNetworkPolicy: [],
          });
          if (reply.statusCode === 403) {
            assert.equal(reply.json().error.code, "FORBIDDEN");
          }
          return reply.statusCode;
        }
        try {
          await controller.updateAgentSandboxPolicy(
            principal.id,
            namespace.id,
            agent.id,
            "networking",
            original.version,
            [],
            [],
          );
          return 200;
        } catch (error) {
          if (error instanceof AuthorizationDeniedError) {
            assert.deepEqual(error.authorization, {
              action: "update",
              resource: { kind: "sandbox_policy", id: original.id, namespaceId: namespace.id },
            });
            return 403;
          }
          throw error;
        }
      };
      const auditCount = async () => {
        const { rows } = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM occ.audit_events
           WHERE namespace_id=$1 AND resource_kind='sandbox_policy'
             AND resource_id=$2 AND outcome='success'`,
          [namespace.id, original.id],
        );
        return rows[0]!.count;
      };
      const beforeAudit = await auditCount();
      const writer = await pool.connect();
      let pending: ReturnType<typeof save> | undefined;
      try {
        await writer.query("BEGIN");
        const {
          rows: [blocker],
        } = await writer.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid, pg_advisory_xact_lock(hashtextextended($1, 0))",
          ["occ:iam-configuration"],
        );
        assert.ok(blocker);

        // A request blocked behind a real IAM writer must see the committed restriction.
        pending = save();
        void pending.catch(() => {});
        await waitUntil("the scoped save waits for the IAM configuration writer", async () => {
          const result = await pool.query(
            `SELECT 1 FROM pg_locks locks JOIN pg_stat_activity activity USING (pid)
             WHERE locks.locktype='advisory' AND NOT locks.granted
               AND activity.application_name=$1 AND $2=ANY(pg_blocking_pids(locks.pid))`,
            [label, blocker.pid],
          );
          return result.rowCount === 1;
        });
        await writer.query(
          `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
           VALUES ($1, $2, 'update', 'sandbox_policy', $3, 'deny')`,
          [`restriction-${randomUUID()}`, namespace.id, original.id],
        );
        await writer.query("COMMIT");
      } catch (error) {
        await writer.query("ROLLBACK");
        throw error;
      } finally {
        writer.release();
      }

      const outcome = await pending;
      const observed = await stored();
      const afterAudit = await auditCount();
      caseContext.diagnostic(
        `${route}: outcome=${outcome}, persisted version ${original.version} → ${observed.version}, success audits added=${afterAudit - beforeAudit}`,
      );
      assert.equal(outcome, 403);
      assert.deepEqual(observed, original);
      assert.equal(afterAudit, beforeAudit);
    });
  }
}

export async function verifyScopedDeploymentTransition(
  fixture: PolicyApp & { sandboxDriver: SandboxDriver },
) {
  const { namespace, agent, revision, original } = await policyEditor(fixture);
  const { inject, state } = fixture;
  const next = { ...original, version: original.version + 1, repositoryNetworkPolicy: [] };
  await state.transact((unit) => unit.sandboxPolicies.save(next, original.version));
  Object.assign(fixture.sandboxDriver, { admitRepositoryNetworkPolicy: () => ({}) });
  Object.assign(fixture.computeDriver, {
    validateProtectedRepositoryNetworkPolicy: async () => {},
  });
  const deploy = () => inject("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`);
  const denied = async () => {
    const result = await deploy();
    assert.equal(result.statusCode, 409, result.body);
    assert.match(result.json().error.message, /Create a new Agent/);
    const rows = await state.read((view) =>
      view.revisions.listRevisionMetadata(namespace.id, agent.id),
    );
    assert.deepEqual(
      rows.map(({ id }) => id),
      [revision.id],
    );
  };
  // A legacy Worker may still claim a queued unscoped revision without an active pointer.
  await denied();
  const stopped: string[] = [];
  Object.assign(fixture.computeDriver, {
    async stopRevision(old: Readonly<AgentRevision>) {
      stopped.push(old.id);
    },
  });
  const readWork = () =>
    state.read((view) => view.operations.findWork(`agent_revision:${revision.id}:reconcile`));
  const release = Promise.withResolvers<void>();
  const compute: ComputeDriver = fixture.computeDriver;
  const prepare = compute.prepareRevision.bind(compute);
  let delayed = false;
  compute.prepareRevision = async (...args) => {
    if (!delayed) {
      delayed = true;
      await release.promise;
    }
    return prepare(...args);
  };
  assert.equal(compute.requiresStoppedPredecessors, undefined);
  const create = () =>
    createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      drivers: createBackendWorkerDrivers(fixture.computeDriver, [], {
        secretDriver: fixture.controller.selectedDriver("secret"),
      }),
      maxAttempts: 4,
      leaseDurationMs: 90000,
      pollIntervalMs: 20,
      emit() {},
    });
  const worker = create();
  const replacement = create();
  try {
    await worker.start();
    await waitFor("an unscoped write is in flight", async () => delayed || undefined);
    const expired = await fixture.pool.query(
      "UPDATE occ.controller_work SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE revision_id=$1 AND state='claimed'",
      [revision.id],
    );
    assert.equal(expired.rowCount, 1);
    await replacement.start();
    await waitFor("legacy deployment is active", async () => {
      const old = await state.read((view) => view.agents.findAgent(namespace.id, agent.id));
      const work = await readWork();
      if (work?.state === "failed_permanent") {
        throw new Error(String(work.reasonCode));
      }
      return old?.activeRevisionId === revision.id && work?.state === "succeeded"
        ? true
        : undefined;
    });
    await denied();
    const request = await inject("POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`);
    assert.equal(request.statusCode, 202, request.body);

    await waitFor("legacy stop has retired the active revision", async () => {
      const old = await state.read((view) => view.agents.findAgent(namespace.id, agent.id));
      return old && !old.activeRevisionId ? true : undefined;
    });
    assert.ok(stopped.includes(revision.id));
    // The claim was recovered and Stop completed while the old Driver call is parked.
    // Its write could still reach the same Gateway, so no scoped revision may be created.
    await denied();
  } finally {
    release.resolve();
    await Promise.all([worker.stop(), replacement.stop()]);
  }
}

async function createScopedDeployment(fixture: PolicyApp) {
  const { inject, state } = fixture;
  const starter = await fixture.deployAgent("setup");
  const { namespace, secretRef } = starter;
  const root = "/namespaces/" + namespace.id;
  const config = await inject("GET", root + "/configurations/" + starter.agent.configurationId);
  assert.equal(config.statusCode, 200);
  const credential = await inject("POST", root + "/secrets", {
    name: "synthetic-channel",
    value: "synthetic",
  });
  assert.equal(credential.statusCode, 201);
  const source = credential.json().data.ref;
  const bound = await inject("POST", root + "/configurations", {
    kind: "agent",
    values: config.json().data.values,
    secretBindings: { CHANNEL_TOKEN: { source, delivery: { type: "env" } } },
  });
  assert.equal(bound.statusCode, 201);
  const created = await inject("POST", root + "/agents", {
    name: "scoped channel",
    executionMode: "dedicated",
    configurationId: bound.json().data.id,
    harnessAuth: { method: "api_key", source: secretRef },
  });
  assert.equal(created.statusCode, 201);
  const agent = created.json().data;
  await state.transact(async (unit) => {
    const p = await unit.sandboxPolicies.find(namespace.id, agent.id);
    assert.ok(p);
    await unit.sandboxPolicies.save(
      { ...p, repositoryNetworkPolicy: [], version: p.version + 1 },
      p.version,
    );
  });
  return {
    namespace,
    agent,
    source,
    deploy: () => inject("POST", root + "/agents/" + agent.id + "/deploy"),
  };
}

export async function verifyChannelPolicyHandoff(
  fixture: PolicyApp & { sandboxDriver: SandboxDriver },
) {
  const { state, computeDriver, sandboxDriver, controller } = fixture;
  const { namespace, agent, source, deploy } = await createScopedDeployment(fixture);
  const { pool } = fixture;
  const writer = await pool.connect();
  const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  let revocation: Promise<void> | undefined;
  let revoked = false;
  const calls: string[] = [];
  const revoke = async () => {
    await writer.query("BEGIN");
    try {
      await writer.query("SET LOCAL lock_timeout = '10s'");
      await writer.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [namespace.id]);
      await writer.query(
        "INSERT INTO occ.iam_restrictions(id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'operate','secret',$3,'deny')",
        ["restriction-" + randomUUID(), namespace.id, source.id],
      );
      await writer.query("COMMIT");
      revoked = true;
    } catch (error) {
      await writer.query("ROLLBACK");
      throw error;
    }
  };
  const channel = new SlackChannelDriver(async () => assert.fail("Unexpected provider request"));
  channel.validateCredentials = async (_values, use) => {
    await use("CHANNEL_TOKEN", "channel", async () => {
      calls.push(revoked ? "after revocation" : "before revocation");
      // A provider waiting on this writer must not keep the Namespace locked.
      await revocation;
    });
  };
  controller.registerDriver(channel);
  controller.selectDriver("channel", channel.id);
  Object.assign(sandboxDriver, { admitRepositoryNetworkPolicy: () => ({}) });
  Object.assign(computeDriver, {
    validateProtectedRepositoryNetworkPolicy: async () => {
      if (revocation) {
        return;
      }
      revocation = revoke();
      await waitFor("the permission change is waiting on the admission lock", async () => {
        const result = await pool.query<{ waiting: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS waiting",
          [pid],
        );
        return result.rows[0]?.waiting || undefined;
      });
    },
  });
  // Hold the controller's continuation after rollback until the waiting writer
  // commits. This exposes any credential handoff performed in the unlocked gap.
  const tx = state.transact.bind(state);
  state.transact = async (work) => {
    try {
      return await tx(work);
    } catch (error) {
      await revocation;
      throw error;
    }
  };
  try {
    const reply = await deploy();
    assert.ok(revoked);
    assert.equal(reply.statusCode, 403, reply.body);
    assert.deepEqual(calls, ["before revocation"]);
    const denied = await deploy();
    assert.equal(denied.statusCode, 403, denied.body);
    assert.deepEqual(calls, ["before revocation"]);
    const revisions = await state.read((view) =>
      view.revisions.listRevisionMetadata(namespace.id, agent.id),
    );
    assert.deepEqual(revisions, []);
  } finally {
    state.transact = tx;
    try {
      await revocation;
    } finally {
      writer.release();
    }
  }
}

export async function verifyDeploymentAuthorityAfterWait(
  fixture: PolicyApp,
  boundary: "channel" | "admission",
): Promise<void> {
  const { state, pool, controller, computeDriver } = fixture;
  const { namespace, agent, source, deploy } = await createScopedDeployment(fixture);
  const writer = await pool.connect();
  let response: ReturnType<typeof deploy> | undefined;
  let channelCalls = 0;
  let computeChecks = 0;
  try {
    const {
      rows: [session],
    } = await writer.query<{ pid: number; isolation: string }>(
      "SELECT pg_backend_pid() AS pid, current_setting('default_transaction_isolation') AS isolation",
    );
    assert.ok(session);
    assert.equal(session.isolation, "repeatable read");
    await writer.query("BEGIN");
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      "occ:iam-configuration",
    ]);

    if (boundary === "channel") {
      const channel = new SlackChannelDriver(async () =>
        assert.fail("Unexpected provider request"),
      );
      channel.validateCredentials = async (_values, use) => {
        await use("CHANNEL_TOKEN", "channel", async () => {
          channelCalls += 1;
        });
      };
      controller.registerDriver(channel);
      controller.selectDriver("channel", channel.id);
    }
    Object.assign(computeDriver, {
      validateProtectedRepositoryNetworkPolicy: async () => {
        computeChecks += 1;
      },
    });
    response = deploy();
    // The reader must already be blocked by this exact writer before the revocation commits.
    await waitFor("deployment waits for the IAM writer", async () => {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
           AND $1 = ANY(pg_blocking_pids(pid))`,
        [session.pid],
      );
      return rowCount === 1 || undefined;
    });
    const [action, kind, id] =
      boundary === "channel" ? ["operate", "secret", source.id] : ["deploy", "agent", agent.id];
    await writer.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, $3, $4, $5, 'deny')`,
      [`restriction-${randomUUID()}`, namespace.id, action, kind, id],
    );
    await writer.query("COMMIT");
    const result = await response;
    const revisions = await state.read((view) =>
      view.revisions.listRevisionMetadata(namespace.id, agent.id),
    );
    assert.deepEqual(
      { channelCalls, computeChecks, status: result.statusCode, revisionCount: revisions.length },
      { channelCalls: 0, computeChecks: 0, status: 403, revisionCount: 0 },
    );
    assert.equal(result.json().error.code, "FORBIDDEN");
  } finally {
    try {
      await writer.query("ROLLBACK");
    } finally {
      writer.release();
      await response;
    }
  }
}
