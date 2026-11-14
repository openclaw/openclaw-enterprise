import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SandboxPolicy, SandboxPolicyApplication } from "@openclaw-enterprise/contracts";
import { InMemoryPlatformState, ScopeViolationError } from "../../packages/occ/src/index.ts";
import { seedSessionRevision } from "./repository-sessions.contract.mjs";

test("memory SandboxPolicy keeps pending custody until explicit settlement", async () => {
  const state = new InMemoryPlatformState();
  const { namespace, agent, revision } = await seedSessionRevision(state);
  const read = () => state.read((unit) => unit.sandboxPolicies.find(namespace.id, agent.id));
  const save = (policy: SandboxPolicy, expectedVersion = policy.version) =>
    state.transact((unit) => unit.sandboxPolicies.save(policy, expectedVersion));
  const initial = await read();
  assert.ok(initial);
  const application: SandboxPolicyApplication = {
    id: randomUUID(),
    revisionId: revision.id,
    policyVersion: initial.version,
    snapshot: {
      driverId: "sandbox-persistence",
      implementation: "deterministic-test",
      version: initial.version,
      defaults: {},
      additions: initial.additions,
    },
    state: "pending",
    requestedBy: "principal-policy-test",
    requestedAt: "2030-03-17T17:46:40.000Z",
  };
  const pending = { ...initial, application };
  assert.deepEqual(await save(pending), pending);
  await assert.rejects(save(initial), ScopeViolationError);
  assert.deepEqual(await read(), pending);

  const withProviderCas = {
    ...pending,
    application: { ...application, expectedProviderVersion: "provider-cas-1" },
  };
  assert.deepEqual(await save(withProviderCas), withProviderCas);
  await assert.rejects(save(initial), ScopeViolationError);
  assert.deepEqual(await read(), withProviderCas);
  const failed: SandboxPolicy = {
    ...withProviderCas,
    application: { ...withProviderCas.application, state: "failed", reason: "UNCONFIRMED" },
  };
  assert.deepEqual(await save(failed), failed);
  const next = { ...initial, version: initial.version + 1 };
  assert.deepEqual(await save(next, initial.version), next);

  const nextApplication: SandboxPolicyApplication = {
    ...application,
    id: randomUUID(),
    policyVersion: next.version,
    snapshot: { ...application.snapshot, version: next.version },
  };
  assert.deepEqual(await save({ ...next, application: nextApplication }), {
    ...next,
    application: nextApplication,
  });
  const applied: SandboxPolicy = {
    ...next,
    application: { ...nextApplication, state: "applied", providerVersion: "provider-policy-2" },
    applied: {
      revisionId: revision.id,
      policyVersion: next.version,
      providerVersion: "provider-policy-2",
      appliedAt: "2030-03-17T17:47:00.000Z",
    },
  };
  assert.deepEqual(await save(applied), applied);
  const appliedEvidence = applied.applied;
  assert.ok(appliedEvidence);
  const afterApplied = { ...next, version: next.version + 1, applied: appliedEvidence };
  assert.deepEqual(await save(afterApplied, next.version), afterApplied);
});
