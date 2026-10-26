import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { standingExecutionFixture } from "../helpers/postgres-standing-execution.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

// Durable execution fence only. No claim of a restored OpenShell process or model turn.
test(
  "standing execution survives a State restart but stop cannot be undone by run intent",
  requiresPostgres,
  async (t) => {
    const { f, key, owner, revision, revisionOptions, credentials, binding } =
      await standingExecutionFixture(t, import.meta.url);
    const execution = {
      executionId: randomUUID(),
      fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
    };
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
