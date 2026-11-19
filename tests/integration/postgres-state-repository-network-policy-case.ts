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

export async function verifyMemoryRepositoryPolicyLiveApplication(): Promise<void> {
  const state = new InMemoryPlatformState();
  const { namespace, agent, revision } = await seedPlatformState(state);
  await verifyLiveApplicationSnapshot(state, namespace.id, agent.id, revision.id);
}

export async function persistRepositoryNetworkPolicy(t: TestContext): Promise<void> {
  const { deployAgent, state } = await createPostgresAgentApp(t, {
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
  const createRevision = (input: AgentRevision) =>
    state.transact((unit) => unit.revisions.createRevision(input));
  await assert.rejects(createRevision(nextRevision), ScopeViolationError);

  const admitted = admitRepositoryNetworkPolicy(grants, grants);
  assert.ok(admitted);
  const restrictedRevision = {
    ...nextRevision,
    sandboxDriverId: baseSnapshot.driverId,
    sandboxPolicy: { ...baseSnapshot, repositoryNetworkPolicy: admitted },
  };
  await assert.rejects(
    createRevision({
      ...restrictedRevision,
      sandboxPolicy: {
        ...baseSnapshot,
        repositoryNetworkPolicy: { ...admitted, identity: "stale" },
      },
    }),
    ScopeViolationError,
  );
  await createRevision(restrictedRevision);

  const denyAll = { ...desired, version: desired.version + 1, repositoryNetworkPolicy: [] };
  assert.deepEqual(await savePolicy(denyAll, desired.version), denyAll);
  assert.deepEqual((await readPolicy())?.repositoryNetworkPolicy, []);
  const retained = await readRevision(nextRevision.id);
  assert.deepEqual(retained?.sandboxPolicy?.repositoryNetworkPolicy, admitted);
  assert.equal(
    (await readRevision(revision.id))?.sandboxPolicy?.repositoryNetworkPolicy,
    undefined,
  );

  const newestRevision = {
    ...restrictedRevision,
    revision: restrictedRevision.revision + 1,
    id: `rev_${randomUUID()}`,
  };
  await assert.rejects(createRevision(newestRevision), ScopeViolationError);
  const admittedDenyAll = admitRepositoryNetworkPolicy([], []);
  assert.ok(admittedDenyAll);

  // Matching grants and identity still require the current saved policy version.
  const staleVersionRevision = {
    ...newestRevision,
    sandboxPolicy: {
      ...baseSnapshot,
      version: desired.version,
      repositoryNetworkPolicy: admittedDenyAll,
    },
  };
  await assert.rejects(createRevision(staleVersionRevision), ScopeViolationError);
  assert.equal(await readRevision(newestRevision.id), undefined);

  await createRevision({
    ...staleVersionRevision,
    sandboxPolicy: { ...staleVersionRevision.sandboxPolicy, version: denyAll.version },
  });
  const savedSnapshot = (await readRevision(newestRevision.id))?.sandboxPolicy;
  assert.equal(savedSnapshot?.version, denyAll.version);
  assert.deepEqual(savedSnapshot?.repositoryNetworkPolicy, admittedDenyAll);
}
