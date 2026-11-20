import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  admitRepositoryNetworkPolicy,
  type AgentRevision,
  type RepositoryNetworkGrant,
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
  const denyAll = admitRepositoryNetworkPolicy([], []);
  assert.ok(denyAll);
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
  const denyAll = admitRepositoryNetworkPolicy([], []);
  assert.ok(denyAll);
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
  const { deployAgent, state, pool } = await createPostgresAgentApp(t, {
    label: "repository-network-policy",
    authSecret: "repository-network-policy-fixture-session-secret",
  });
  const live = await deployAgent("Live sandbox policy");
  await verifyLiveApplicationSnapshot(state, live.namespace.id, live.agent.id, live.revision.id);
  const { namespace, agent, revision } = await deployAgent("Repository network policy");
  assert.equal(
    await state.read(async (view) => view.sandboxPolicies.supportsRepositoryNetworkPolicy),
    true,
  );
  assert.equal(
    await state.transact(async (unit) => unit.sandboxPolicies.supportsRepositoryNetworkPolicy),
    true,
  );
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
  const admitted = admitRepositoryNetworkPolicy(grants, grants);
  assert.ok(admitted);
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
  assert.deepEqual(await savePolicy(denyAll, desired.version), denyAll);
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

  const admittedDenyAll = admitRepositoryNetworkPolicy([], []);
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
