import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  ProtectedDownloadDestination,
  ProtectedDownloadPolicyFence,
  ProtectedDownloadPolicyWrite,
  SandboxPolicy,
} from "../../packages/contracts/src/index.ts";
import {
  projectProtectedDownloadEdit,
  type PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

test("the policy repository binds a protected operation to its desired scope and retains its confirmation", async (t) => {
  const f = await staticEgressFixture(t);
  const { installation, revision } = f;
  assert.ok(installation.enforcement.peerKeyId);
  assert.ok("policyHash" in f.observed && typeof f.observed.policyHash === "string");
  const destination: ProtectedDownloadDestination = {
    scheme: "https",
    port: 443,
    host: "archives.example.org",
  };
  const expected: ProtectedDownloadPolicyFence = {
    sandboxId: installation.sandboxId,
    instanceId: installation.enforcement.instanceId,
    configurationId: installation.enforcement.configurationId,
    peer: { keyId: installation.enforcement.peerKeyId },
    installationLimitsHash: "f".repeat(64),
    providerResourceVersion: "7",
    policyVersion: installation.plan.generation,
    sourcePolicyHash: f.observed.policyHash,
    effectivePolicyHash: installation.enforcement.policyHash,
  };
  const id = randomUUID();
  await f.controller.transact(async ({ sandboxPolicies: repo, operations }: PlatformUnitOfWork) => {
    const old = await repo.find(f.namespace.id, f.agent.id);
    assert.ok(old);
    const pending = {
      ...old,
      version: old.version + 1,
      approvedDownloadDestinations: [destination],
      downloadDestinations: [destination],
      application: {
        kind: "protected_downloads",
        id,
        revisionId: revision.id,
        policyVersion: old.version + 1,
        requestedBy: "test-admin",
        requestedAt: new Date().toISOString(),
        state: "pending",
        action: "approve-and-enable",
        destination,
        priorDesiredDownloadDestinations: [],
        priorApprovedDownloadDestinations: [],
        previousDownloadDestinations: [],
        desiredDownloadDestinations: [destination],
        expected,
        writeState: "prepared",
        desiredSourcePolicyHash: "b".repeat(64),
      },
    } satisfies SandboxPolicy;
    const { application, ...desired } = pending;
    await assert.rejects(repo.save(desired, old.version), /version transition/);
    const fenceWithSource = { ...expected, source: {} };
    await assert.rejects(
      repo.save(
        { ...pending, application: { ...application, expected: fenceWithSource } },
        old.version,
      ),
      /Invalid protected download application/,
    );
    await assert.rejects(
      repo.save({ ...pending, approvedDownloadDestinations: [] }, old.version),
      /Invalid protected download admission/,
    );
    await assert.rejects(
      repo.save(
        {
          ...pending,
          application: { ...application, priorApprovedDownloadDestinations: [destination] },
        },
        old.version,
      ),
      /Invalid protected download admission/,
    );
    assert.deepEqual(await repo.save(pending, old.version), pending);
    await assert.rejects(
      repo.save(
        {
          ...pending,
          application: { ...application, state: "failed", reason: "AUTHORIZATION_DENIED" },
        },
        pending.version,
        id,
      ),
      /Invalid protected download application/,
    );
    const work = {
      kind: "agent",
      action: "reconcile",
      target: "sandbox_policy",
      namespaceId: f.namespace.id,
      resourceId: f.agent.id,
      operationId: id,
      actorId: application.requestedBy,
    } satisfies Parameters<typeof operations.append>[0];
    await assert.rejects(
      operations.append({ ...work, operationId: randomUUID() }),
      /exact pending application/,
    );
    await assert.rejects(
      operations.append({ ...work, actorId: "other-admin" }),
      /exact pending application/,
    );
    await operations.append(work);
    const save = (next: SandboxPolicy) => repo.save(next, pending.version, id);
    await assert.rejects(save(desired), /version transition/);
    await assert.rejects(
      save({ ...pending, application: { ...application, requestedBy: "other-admin" } }),
      /inputs are immutable/,
    );
    const dispatched = {
      ...pending,
      application: { ...application, writeState: "dispatched" as const },
    } satisfies SandboxPolicy;
    assert.equal(await repo.save(dispatched, pending.version, randomUUID()), undefined);
    assert.deepEqual(await save(dispatched), dispatched);
    const post = {
      ...expected,
      providerResourceVersion: "8",
      configurationId: "new-config",
      policyVersion: expected.policyVersion + 1,
      sourcePolicyHash: "b".repeat(64),
      effectivePolicyHash: "c".repeat(64),
    };
    const receipt = {
      kind: "protected_downloads",
      operationId: id,
      revisionId: revision.id,
      policyVersion: pending.version,
      providerVersion: String(post.policyVersion),
      appliedAt: new Date().toISOString(),
      confirmedDownloadDestinations: [destination],
      fence: post,
    } satisfies NonNullable<SandboxPolicy["applied"]>;
    const committed: ProtectedDownloadPolicyWrite = {
      state: "committed",
      operationId: id,
      sandboxId: expected.sandboxId,
      policyVersion: post.policyVersion,
      sourcePolicyHash: post.sourcePolicyHash,
    };
    for (const acknowledgedWrite of [
      { ...committed, sandboxId: "foreign-sandbox" },
      { ...committed, sourcePolicyHash: expected.sourcePolicyHash },
      { ...committed, rawSource: {} },
    ]) {
      await assert.rejects(
        save({ ...dispatched, application: { ...dispatched.application, acknowledgedWrite } }),
        /Invalid protected download application/,
      );
    }
    const confirmed = {
      ...dispatched,
      application: {
        ...dispatched.application,
        state: "applied" as const,
        acknowledgedWrite: committed,
        providerVersion: receipt.providerVersion,
      },
      applied: receipt,
    } satisfies SandboxPolicy;
    for (const fence of [
      expected,
      { ...post, instanceId: "replaced" },
      { ...post, peer: { keyId: "rotated" } },
      { ...post, installationLimitsHash: "8".repeat(64) },
    ]) {
      await assert.rejects(
        save({ ...confirmed, applied: { ...receipt, fence } }),
        /post-update evidence/,
      );
    }
    const { acknowledgedWrite: _missing, ...withoutCommit } = confirmed.application;
    await assert.rejects(
      save({ ...confirmed, application: withoutCommit }),
      /post-update evidence/,
    );
    assert.deepEqual(await save(confirmed), confirmed);
    assert.equal(await save(dispatched), undefined);
    await assert.rejects(
      repo.save(
        { ...confirmed, applied: { ...receipt, appliedAt: "2030-01-01T00:00:00.000Z" } },
        pending.version,
      ),
      /confirmed application evidence/,
    );
  });

  const metadata = await f.deployAgent(f.namespace.id, f.agent.id);
  await f.controller.transact(
    async ({ sandboxPolicies: repo, agents, revisions, credentialSources }: PlatformUnitOfWork) => {
      const replacement = await revisions.findRevision(f.namespace.id, f.agent.id, metadata.id);
      assert.ok(replacement?.egressPlan);
      const prior = await repo.find(f.namespace.id, f.agent.id);
      assert.ok(prior?.application?.kind === "protected_downloads");
      const sandboxId = randomUUID();
      const instanceId = randomUUID();
      await credentialSources.recordEgressInstallation({
        ...installation,
        sandboxId,
        plan: replacement.egressPlan,
        enforcement: { ...installation.enforcement, instanceId },
      });
      assert.ok(
        await agents.compareAndSetActiveRevision(
          f.namespace.id,
          f.agent.id,
          revision.id,
          replacement.id,
        ),
      );
      const additional = { ...destination, host: "releases.example.org" };
      const durable = [destination, additional];
      const application = {
        ...prior.application,
        id: randomUUID(),
        revisionId: replacement.id,
        policyVersion: prior.version + 1,
        state: "pending" as const,
        writeState: "prepared" as const,
        destination: additional,
        priorApprovedDownloadDestinations: [destination],
        priorDesiredDownloadDestinations: [destination],
        previousDownloadDestinations: [],
        desiredDownloadDestinations: [additional],
        expected: {
          ...expected,
          sandboxId,
          instanceId,
          policyVersion: replacement.egressPlan.generation,
        },
      };
      const {
        acknowledgedWrite: _ack,
        providerVersion: _providerVersion,
        ...prepared
      } = application;
      const pending = {
        ...prior,
        version: prepared.policyVersion,
        application: prepared,
        approvedDownloadDestinations: durable,
        downloadDestinations: durable,
      };
      await assert.rejects(
        repo.save(
          { ...pending, application: { ...prepared, desiredDownloadDestinations: durable } },
          prior.version,
        ),
        /Invalid protected download admission/,
      );
      await assert.rejects(
        repo.save({ ...pending, downloadDestinations: [additional] }, prior.version),
        /Invalid protected download admission/,
      );
      assert.deepEqual(await repo.save(pending, prior.version), pending);
      const failed = {
        ...pending,
        application: { ...prepared, state: "failed" as const, reason: "AUTHORIZATION_DENIED" },
        approvedDownloadDestinations: [destination],
        downloadDestinations: [destination],
      };
      await assert.rejects(
        repo.save({ ...failed, downloadDestinations: [] }, pending.version, prepared.id),
        /Invalid protected download application/,
      );
      assert.deepEqual(await repo.save(failed, pending.version, prepared.id), failed);
      const enable = {
        ...failed,
        version: failed.version + 1,
        application: {
          ...prepared,
          id: randomUUID(),
          policyVersion: failed.version + 1,
          action: "enable" as const,
          destination,
          desiredDownloadDestinations: [destination],
        },
      };
      assert.deepEqual(await repo.save(enable, failed.version), enable);
      // Confirm each edit on the same replacement so durable and live projections
      // both start the withdrawal with the host and its exact object enabled.
      let current: SandboxPolicy = enable;
      const confirm = async () => {
        const app = current.application;
        assert.ok(app?.kind === "protected_downloads");
        const dispatched = { ...app, writeState: "dispatched" as const };
        assert.ok(
          await repo.save({ ...current, application: dispatched }, current.version, app.id),
        );
        const fence = {
          ...app.expected,
          policyVersion: app.expected.policyVersion + 1,
          providerResourceVersion: String(Number(app.expected.providerResourceVersion) + 1),
          sourcePolicyHash: app.desiredSourcePolicyHash,
        };
        const providerVersion = String(fence.policyVersion);
        current = {
          ...current,
          applied: {
            kind: "protected_downloads",
            operationId: app.id,
            revisionId: app.revisionId,
            policyVersion: current.version,
            providerVersion,
            appliedAt: app.requestedAt,
            confirmedDownloadDestinations: app.desiredDownloadDestinations,
            fence,
          },
          application: {
            ...dispatched,
            state: "applied",
            providerVersion,
            acknowledgedWrite: {
              state: "committed" as const,
              operationId: app.id,
              sandboxId: fence.sandboxId,
              policyVersion: fence.policyVersion,
              sourcePolicyHash: fence.sourcePolicyHash,
            },
          },
        };
        assert.ok(await repo.save(current, current.version, app.id));
      };
      const object = { ...destination, path: "/objects/tool.tar" };
      const both = [destination, object];
      const edit = (
        action: "approve-and-enable" | "withdraw-approval",
        scope: ProtectedDownloadDestination,
        delegation: ProtectedDownloadDestination[],
      ) => {
        const receipt = current.applied;
        assert.ok(receipt?.kind === "protected_downloads");
        const change = { action, destination: scope };
        const previous = receipt.confirmedDownloadDestinations;
        const projection = projectProtectedDownloadEdit(current, previous, change, delegation);
        assert.equal(projection.status, "changed");
        return {
          ...projection.policy,
          version: current.version + 1,
          application: {
            ...prepared,
            ...change,
            id: randomUUID(),
            policyVersion: current.version + 1,
            expected: {
              ...receipt.fence,
              installationLimitsHash: delegation.length ? "1".repeat(64) : "2".repeat(64),
            },
            priorDesiredDownloadDestinations: current.downloadDestinations ?? [],
            priorApprovedDownloadDestinations: current.approvedDownloadDestinations ?? [],
            previousDownloadDestinations: previous,
            desiredDownloadDestinations: projection.target,
          },
        } satisfies SandboxPolicy;
      };
      await confirm();
      const exactGrant = edit("approve-and-enable", object, [destination]);
      assert.ok(await repo.save(exactGrant, current.version));
      current = exactGrant;
      await confirm();
      // The retained explicit host approval independently authorizes the object.
      const covered = edit("withdraw-approval", object, []);
      assert.deepEqual(covered.downloadDestinations, both);
      assert.deepEqual(covered.application.desiredDownloadDestinations, both);
      await assert.rejects(
        repo.save({ ...covered, downloadDestinations: [destination] }, current.version),
        /Invalid protected download admission/,
      );
      assert.ok(await repo.save(covered, current.version));
      current = covered;
      await confirm();
      const reapproved = edit("approve-and-enable", object, [destination]);
      assert.ok(await repo.save(reapproved, current.version));
      current = reapproved;
      await confirm();
      const delegated = edit("withdraw-approval", destination, [destination]);
      assert.deepEqual(delegated.downloadDestinations, both);
      assert.deepEqual(delegated.approvedDownloadDestinations, [object]);
      assert.ok(await repo.save(delegated, current.version));
      current = delegated;
      await confirm();
      const withdrawn = edit("withdraw-approval", object, []);
      assert.deepEqual(withdrawn.downloadDestinations, [destination]);
      assert.deepEqual(withdrawn.application.desiredDownloadDestinations, [destination]);
      for (const invalid of [[], both, [destination, { ...object, path: "/unexpected" }]]) {
        await assert.rejects(
          repo.save({ ...withdrawn, downloadDestinations: invalid }, current.version),
          /Invalid protected download admission/,
        );
        await assert.rejects(
          repo.save(
            {
              ...withdrawn,
              application: {
                ...withdrawn.application,
                desiredDownloadDestinations: invalid,
              },
            },
            current.version,
          ),
          /Invalid protected download admission/,
        );
      }
      await assert.rejects(
        repo.save(
          { ...withdrawn, application: { ...withdrawn.application, destination } },
          current.version,
        ),
        /Invalid protected download admission/,
      );
      assert.deepEqual(await repo.save(withdrawn, current.version), withdrawn);
      const restored = {
        ...withdrawn,
        approvedDownloadDestinations: [object],
        downloadDestinations: both,
        application: {
          ...withdrawn.application,
          state: "failed" as const,
          reason: "AUTHORIZATION_DENIED",
        },
      };
      assert.deepEqual(
        await repo.save(restored, withdrawn.version, withdrawn.application.id),
        restored,
      );
    },
  );
});
