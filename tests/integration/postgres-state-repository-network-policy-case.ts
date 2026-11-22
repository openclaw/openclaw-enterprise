import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  type AgentRevision,
  type RepositoryNetworkGrant,
  type SandboxNetworkGrant,
  type SandboxPolicy,
  type SandboxPolicyApplication,
  type SandboxPolicySnapshot,
} from "../../packages/contracts/src/index.ts";
import {
  InMemoryPlatformState,
  PersistedStateInvalidError,
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
  await assert.rejects(createRevision(protectedRevision), {
    name: ScopeViolationError.name,
    message: /Repository network policy requires unprotected execution/,
  });
  assert.equal(await readRevision(protectedRevision.id), undefined);
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
  await assert.rejects(createRevision(protectedRevision), {
    name: ScopeViolationError.name,
    message: /Repository network policy requires unprotected execution/,
  });
  assert.equal(await readRevision(protectedRevision.id), undefined);

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
  // A valid future row passes the database constraints but remains unreadable
  // to this State adapter until Worker can enforce scoped protected execution.
  const result = await insertStoredRevision(protectedRevision, {
    ...protectedSpec,
    execution_admission: { ...protectedRevision.executionAdmission, ...marker },
  });
  assert.equal(result.rowCount, 1);
  await assert.rejects(readRevision(protectedRevision.id), (error: unknown) => {
    assert.ok(error instanceof PersistedStateInvalidError);
    assert.match(error.message, /Persisted AgentRevision execution admission/);
    return true;
  });

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
