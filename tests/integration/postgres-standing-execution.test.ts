import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import type { Pool } from "pg";
import {
  PostgresPlatformState,
  repositoryApprovalFingerprint,
} from "../../packages/occ/src/index.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { ensurePostgresAgentBootstrap } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

// Durable execution fence only. No claim of a restored OpenShell process or model turn.
test(
  "standing execution survives a State restart but stop cannot be undone by run intent",
  requiresPostgres,
  async (t) => {
    await ensurePostgresAgentBootstrap(t, {
      label: "standing-execution",
      authSecret: "standing-execution-local-test-secret-32",
    });
    const database = { url: databaseUrl!, pools: new Set<Pool>(), workers: new Set() };
    t.after(async () => {
      for (const pool of database.pools) {
        await pool.end();
      }
    });
    const setupOptions = { database, leaseDurationMs: 30_000 };
    const f = await createWorkerRevisionFixtures(import.meta.url).setup(t, setupOptions);
    const driver = new GitHubRepoDriver(
      {
        id: "execution-proof",
        client: new UnixRepositoryCredentialControlClient({
          controlSocket: "/unused-execution-contract/control.sock",
        }),
        drivers: { repo: "execution-proof" },
      },
      {
        version: 1,
        backendId: "execution-proof",
        providerInstanceId: "local-provider",
        appId: "123",
        githubInstallationId: "456",
        maximumDurationSeconds: 120,
        allowStandingApprovals: true,
        repositories: [
          {
            repositoryRef: "source",
            repositoryId: "789",
            repository: "example/source",
            namespaces: [
              {
                namespaceId: f.namespace.id,
                profiles: ["git-write"],
                allowStandingApproval: true,
                transport: "git-only",
                pushRefAllowlist: ["refs/heads/review"],
              },
            ],
          },
        ],
      },
      { sessionDurationSeconds: 120 },
    );
    const owner = await f.agent("execution-fence");
    const [selected] = driver.resolve({
      namespaceId: f.namespace.id,
      bindings: [{ repositoryRef: "source", profile: "git-write" }],
    }).bindings;
    const binding = selected!;
    await f.observerPool.query("UPDATE occ.agents SET repository_bindings=$1 WHERE id=$2", [
      JSON.stringify([{ repositoryRef: "source", profile: "git-write" }]),
      owner.id,
    ]);
    const scope = driver.standingApprovalScope({ namespaceId: f.namespace.id, binding })!;
    const fingerprint = repositoryApprovalFingerprint({
      namespaceId: f.namespace.id,
      agentId: owner.id,
      binding,
      scope,
    });
    const approval = await f.state.transact((u) =>
      u.repositorySessions.approveStanding({
        id: randomUUID(),
        namespaceId: f.namespace.id,
        agentId: owner.id,
        binding,
        scope,
        scopeFingerprint: fingerprint,
        approvedBy: f.actor.id,
        createdAt: new Date().toISOString(),
      }),
    );
    const credentials = {
      driver: { id: driver.id, implementation: driver.implementation },
      bindings: [binding],
      deadlineWallMs: Date.now() + 120_000,
      standingApprovalId: approval.id,
      standingApprovalGeneration: approval.generation,
      standingApprovalScopeFingerprint: fingerprint,
    };
    const revisionOptions = { actorId: f.actor.id, repositoryCredentials: credentials };
    const revision = await f.revision(owner, 1, revisionOptions);
    const key = { namespaceId: f.namespace.id, agentId: owner.id, revisionId: revision.id };
    const execution = {
      executionId: randomUUID(),
      fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
    };
    await f.state.transact((u) =>
      u.agents.compareAndSetActiveRevision(key.namespaceId, key.agentId, undefined, key.revisionId),
    );
    await f.state.transact((u) => u.repositorySessions.recordStandingExecution(key, execution));
    const cold = new PostgresPlatformState(f.observerPool);
    assert.deepEqual(await cold.read((v) => v.repositorySessions.findStandingExecution(key)), {
      ...execution,
      closed: false,
    });
    await cold.transact((u) => u.repositorySessions.recordStandingExecution(key, execution));
    await assert.rejects(
      cold.transact((u) =>
        u.repositorySessions.recordStandingExecution(key, {
          ...execution,
          executionId: randomUUID(),
        }),
      ),
      { name: "ScopeViolationError" },
    );
    await f.controller.stopAgent(f.actor.id, key.namespaceId, key.agentId);
    assert.equal(
      (await cold.read((v) => v.repositorySessions.findStandingExecution(key)))?.closed,
      true,
    );
    assert.ok(
      await cold.read((v) =>
        v.repositorySessions.findStandingApproval(key.namespaceId, key.agentId, "source"),
      ),
      "stop closes execution, not the standing approval",
    );
    // A low-level run-intent transition is deliberately insufficient. A new admission is needed.
    await cold.transact((u) =>
      u.agents.transitionAgentDesiredRuntimeState(
        key.namespaceId,
        key.agentId,
        "stopped",
        "running",
      ),
    );
    await assert.rejects(
      cold.transact((u) => u.repositorySessions.recordStandingExecution(key, execution)),
      { name: "ScopeViolationError" },
    );
    const next = await f.revision(owner, 2, revisionOptions);
    await cold.transact((u) =>
      u.agents.compareAndSetActiveRevision(key.namespaceId, key.agentId, revision.id, next.id),
    );
    const replacement = { ...key, revisionId: next.id };
    await cold.transact((u) =>
      u.repositorySessions.recordStandingExecution(replacement, {
        ...execution,
        executionId: randomUUID(),
      }),
    );
    await assert.rejects(
      cold.transact((u) => u.repositorySessions.recordStandingExecution(key, execution)),
      { name: "ScopeViolationError" },
    );
    const finiteOwner = await f.agent("finite-execution-fence");
    const finiteOptions = {
      actorId: f.actor.id,
      repositoryCredentials: {
        driver: credentials.driver,
        bindings: [binding],
        deadlineWallMs: credentials.deadlineWallMs,
      },
    };
    const finite = await f.revision(finiteOwner, 1, finiteOptions);
    await cold.transact((u) =>
      u.agents.compareAndSetActiveRevision(key.namespaceId, finiteOwner.id, undefined, finite.id),
    );
    await assert.rejects(
      cold.transact((u) =>
        u.repositorySessions.recordStandingExecution(
          { ...key, agentId: finiteOwner.id, revisionId: finite.id },
          execution,
        ),
      ),
      { name: "ScopeViolationError" },
    );
  },
);
