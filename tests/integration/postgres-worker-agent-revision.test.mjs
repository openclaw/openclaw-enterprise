import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { OpenShellAdmissionLimitError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import {
  ActivationFailedError,
  ActivationPendingError,
  CredentialSourceRevisionError,
  ComputePreparationFailedError,
  DependencyUnavailableError,
  PostgresMetricsSnapshot,
  SandboxGatewayUnavailableError,
  SandboxRevisionUnsupportedError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import {
  createAccessTokenServiceAccount,
  createBackendController,
  poolWithOneBackendBindingReadFault,
  backendDefinition,
  requiresPostgres,
  seedBackendBinding,
} from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { withNamespaceLockHeld } from "../helpers/postgres-namespace-lock.mjs";
import {
  assertFailedDeployment,
  runPreparationFailureCase,
  runRuntimeFailureCases,
} from "../helpers/postgres-worker-revision-scenarios.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  advanceCleanupRetries,
  completion,
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";

// Deployment, dispatch, convergence and the persisted lifecycle. Credential-source withdrawals and
// listed sources that lose their grant or readiness are in the -credential-sources sibling; the
// lane runs the revision files at once.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

function codexPluginRevisionState(pluginId) {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {
      [pluginId]: {
        enabled: true,
        toolDefaults: { approval: "provider_default" },
      },
    },
  };
}

revisionTest(
  "worker revalidates admitted repository selections through the concrete GitHub Driver and Unix control",
  async (fixture, context) => {
    const [
      { GitHubRepoDriver },
      { UnixRepositoryCredentialControlClient },
      { startRegistryCredentialServiceFixture },
    ] = await Promise.all([
      import("../../apps/controller/src/drivers/repo/github/driver.ts"),
      import("../../apps/controller/src/backends/repository-credentials/control-client.ts"),
      import("../fixtures/repository-credentials/registry.mjs"),
    ]);
    const clock = createControlledClock();
    const startedWall = clock.wallNow();
    const credentials = await startRegistryCredentialServiceFixture(context, {
      namespaceId: fixture.namespace.id,
      autoOpen: false,
      // Worker admission IDs use real wall time. Preserve that progress while
      // allowing this fixture's provider-retirement expiry to advance explicitly.
      clock: { ...clock, wallNow: () => Date.now() + clock.wallNow() - startedWall },
      gateway: { listen: "127.0.0.1:0" },
    });
    const driver = new GitHubRepoDriver(
      {
        id: credentials.backendId,
        client: new UnixRepositoryCredentialControlClient({
          controlSocket: credentials.config.gateway.controlSocket,
        }),
        drivers: { repo: "repository-credentials" },
      },
      credentials.registry,
      { sessionDurationSeconds: 60, publicCa: credentials.tls.ca },
    );
    // The real resolver admits selection fields and returns the richer frozen
    // binding. Worker revalidation must project that snapshot back to selections;
    // the strict registry parser rejects backendId/grant as caller input.
    const resolution = driver.resolve({
      namespaceId: fixture.namespace.id,
      bindings: [{ repositoryRef: "repo-a", profile: "git-read" }],
    });
    // Bound admissions require the worker-owned receipt transport and its real
    // PostgreSQL state; without it the broker correctly refuses the session.
    const { startRepositoryReceiptServer } =
      await import("../../apps/controller/src/backends/repository-credentials/receipt-server.ts");
    const receiptServer = await startRepositoryReceiptServer({
      state: fixture.state,
      controlSocket: credentials.config.gateway.controlSocket,
      driverId: driver.id,
      implementation: driver.implementation,
      backendId: credentials.backendId,
    });
    context.after(() => receiptServer.close());
    const { owner, candidate } = await fixture.admitInitialRevision("repository-concrete-driver", {
      revision: {
        repositoryCredentials: {
          driver: { id: driver.id, implementation: driver.implementation },
          deadlineWallMs: Date.now() + 120_000,
          bindings: resolution.bindings,
        },
      },
    });
    const open = driver.open.bind(driver);
    const close = driver.close.bind(driver);
    let lostSessionId;
    const closures = [];
    // Lose only the first response. The real service owns CLOSED -> DISPOSED,
    // and the real worker must wait before delivering replacement material.
    driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (lostSessionId === undefined && result.kind === "created") {
        lostSessionId = result.session.sessionId;
        throw new Error("repository admission response lost after creation");
      }
      return result;
    };
    driver.close = async (sessionId, signal) => {
      const status = await close(sessionId, signal);
      closures.push(status?.state);
      return status;
    };
    const material = [];
    const events = [];
    const retired = [];
    await fixture.start(
      {
        ...fixture.compute,
        validateRepositoryCredentials(harness, sandboxDriverId) {
          assert.equal(harness.mode, "embedded");
          assert.equal(sandboxDriverId, undefined);
        },
        async prepareRevision(revision, deploymentContext) {
          material.push(...deploymentContext.repositoryCredentials);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
        async retireRevision(revision) {
          retired.push(revision.id);
          return fixture.compute.retireRevision(revision);
        },
      },
      {
        emit: (event) => events.push(event),
        pool: fixture.workerPool,
        transformDrivers: (drivers) => ({ ...drivers, repoDriver: driver }),
      },
    );
    const terminal = await waitFor(
      "the concrete repository revision's terminal result",
      async () => {
        const result = await fixture.observerPool.query(
          "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        return ["succeeded", "failed_permanent"].includes(result.rows[0]?.state)
          ? result.rows[0]
          : undefined;
      },
    );
    assert.equal(
      terminal.state,
      "succeeded",
      JSON.stringify(events.filter(({ workId }) => workId === candidate.idempotencyKey)),
    );
    assert.ok(terminal.attempt_count >= 2);
    assert.equal(material.length, 1);
    assert.equal(material[0].kind, "new");
    assert.equal(material[0].repositoryRef, "repo-a");
    assert.equal(JSON.parse(material[0].files["client.json"]).sessionId, material[0].sessionId);
    assert.equal(material[0].files["ca.pem"], credentials.tls.ca.toString("utf8"));
    const status = await driver.status(material[0].sessionId, new AbortController().signal);
    assert.equal(status.state, "OPEN");
    assert.deepEqual(status.binding, resolution.bindings[0].grant);
    const attempts = await repositoryAttempts(fixture, candidate);
    assert.equal(attempts.length, 2);
    assert.equal(attempts.find(({ sessionId }) => sessionId === lostSessionId).phase, "disposed");
    assert.ok(closures.includes("CLOSED"));
    const attempt = attempts.find(({ phase }) => phase === "open");
    assert.equal(attempt.phase, "open");
    assert.equal(attempt.sessionId, status.sessionId);
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    // Both the lost admission and the delivered session must settle even when
    // their cleanup requests share one durable work item.
    await waitFor("both concrete repository sessions to settle", async () => {
      const settled = await repositoryAttempts(fixture, candidate);
      return settled.length === 2 && settled.every(({ phase }) => phase === "disposed")
        ? true
        : undefined;
    });
    await waitFor("the concrete session's cleanup work to complete", async () => {
      const cleanup = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      return cleanup.rowCount === 1 && cleanup.rows[0].state === "succeeded" ? true : undefined;
    });
    await fixture.requestDeletion(owner);
    await waitFor("disposed repository evidence to outlive its Agent", async () =>
      (await fixture.currentAgent(owner)) === undefined ? true : undefined,
    );
    const retained = await fixture.state.read((view) =>
      view.repositorySessions.findAttempt(attempt.admissionId),
    );
    assert.equal(retained.phase, "disposed");
    assert.equal(retained.liveRevisionId, null);
    assert.equal(retained.revisionId, candidate.id);
    assert.equal(retained.agentId, owner.id);
    assert.deepEqual(retained.cleanupContext, {
      driver: candidate.repositoryCredentials.driver,
      binding: resolution.bindings[0],
    });

    // A provider retirement response can be lost after the remote effect. Only
    // the service's eventual DISPOSED observation settles retained cleanup.
    const { owner: pendingOwner, candidate: pendingRevision } = await fixture.admitInitialRevision(
      "repository-pending-deletion",
      { revision: { repositoryCredentials: candidate.repositoryCredentials } },
    );
    await fixture.work(pendingRevision, "succeeded");
    const pendingMaterial = material.at(-1);
    const responseStatus = await new Promise((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: credentials.listeners.address.port,
          path: "/fixture/repository.git/info/refs?service=git-upload-pack",
          method: "GET",
          ca: credentials.tls.ca,
          agent: false,
          headers: {
            host: "credentials.example.test",
            authorization: `Basic ${Buffer.from(`gateway-session:${pendingMaterial.files.bearer}`).toString("base64")}`,
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
          incoming.once("error", reject);
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(responseStatus, 200);
    const provider = credentials.repositories[0].github;
    assert.equal(provider.issuesOfTokens.length, 1);
    provider.disconnectAfterMutation("DELETE", "/installation/token");
    await fixture.requestDeletion(pendingOwner);
    await waitFor(
      "Agent deletion to complete while repository cleanup remains pending",
      async () =>
        retired.includes(pendingRevision.id) &&
        (await fixture.currentAgent(pendingOwner)) === undefined
          ? true
          : undefined,
    );
    await waitFor("independent cleanup to close the deleted Agent's broker session", async () => {
      const status = await driver.status(pendingMaterial.sessionId, new AbortController().signal);
      return status?.state === "CLOSED" ? true : undefined;
    });
    const [pendingAttempt] = await repositoryAttempts(fixture, pendingRevision);
    assert.equal(pendingAttempt.phase, "closing");
    assert.equal(pendingAttempt.liveRevisionId, null);
    // Unsettled provider authority must retain durable cleanup without using
    // the foreground readiness cadence and repeatedly occupying the worker.
    const deferredCleanup = await waitFor("pending cleanup to release its claim", async () => {
      const result = await fixture.observerPool.query(
        `SELECT idempotency_key, state, claim_token, lease_expires_at,
           EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
         FROM occ.controller_work WHERE idempotency_key LIKE $1 AND state = 'queued'`,
        [`agent_revision:${pendingRevision.id}:repository_cleanup:%`],
      );
      return events.some(
        (event) =>
          event.workId === result.rows[0]?.idempotency_key &&
          event.code === "REPOSITORY_CLEANUP_PENDING",
      )
        ? result.rows[0]
        : undefined;
    });
    assert.ok(Number(deferredCleanup.delay_ms) >= driver.maintenanceIntervalMs - 1_000);
    assert.equal(deferredCleanup.claim_token, null);
    assert.equal(deferredCleanup.lease_expires_at, null);
    const { candidate: nextRevision } = await fixture.admitInitialRevision(
      "repository-cleanup-neighbor",
      { revision: { repositoryCredentials: candidate.repositoryCredentials } },
    );
    await fixture.work(nextRevision, "succeeded");
    const scheduled = await fixture.observerPool.query(
      "SELECT state, available_at > clock_timestamp() AS deferred FROM occ.controller_work WHERE idempotency_key = $1",
      [deferredCleanup.idempotency_key],
    );
    assert.deepEqual(scheduled.rows, [{ state: "queued", deferred: true }]);
    assert.equal(
      (
        await fixture.state.read((view) =>
          view.repositorySessions.findAttempt(pendingAttempt.admissionId),
        )
      ).phase,
      "closing",
    );
    assert.equal(
      (
        await fixture.observerPool.query(
          "SELECT count(*)::integer AS count FROM occ.controller_work WHERE idempotency_key LIKE $1",
          [`agent_revision:${pendingRevision.id}:repository_cleanup:%`],
        )
      ).rows[0].count,
      1,
    );
    await clock.advance(3_600_001);
    // Advance this exact retry after provider expiry instead of waiting for
    // the real 30-second interval. The worker still claims and settles it.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1 AND state = 'queued'",
      [deferredCleanup.idempotency_key],
    );
    const settled = await waitFor(
      "settled provider cleanup to dispose retained evidence",
      async () => {
        const attempt = await fixture.state.read((view) =>
          view.repositorySessions.findAttempt(pendingAttempt.admissionId),
        );
        return attempt?.phase === "disposed" ? attempt : undefined;
      },
    );
    assert.equal(settled.phase, "disposed");
    assert.equal(settled.liveRevisionId, null);
    assert.equal(settled.deadlineWallMs, pendingAttempt.deadlineWallMs);
    assert.deepEqual(settled.cleanupContext, pendingAttempt.cleanupContext);
    assert.equal(provider.issuesOfTokens.length, 1, "deletion must never mint a replacement token");
    assert.equal(
      provider.trace.filter(
        ({ method, target }) => method === "DELETE" && target === "/installation/token",
      ).length,
      1,
      "uncertain provider retirement must not be replayed",
    );
  },
  // First in its file, so it also absorbs the file's cold start (finding 1171):
  // about 12.5 s typically, 31.7 s once on a slow runner.
  { timeout: 60_000 },
);

revisionTest(
  "Agent deploy, stop, and deletion complete as one persisted lifecycle",
  async (fixture) => {
    const owner = await fixture.agent("complete-lifecycle");
    const effects = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        effects.push(`prepare:${revision.id}`);
        return fixture.compute.prepareRevision(revision);
      },
      async stopRevision(revision) {
        effects.push(`stop:${revision.id}`);
      },
      async retireRevision(revision) {
        effects.push(`retire:${revision.id}`);
      },
      async deleteAgentRuntimeCredentials({ agent }) {
        effects.push(`credentials:${agent.id}`);
      },
    });

    const revision = await fixture.revision(owner, 1);
    await fixture.work(revision, "succeeded");
    const running = await fixture.currentAgent(owner);
    assert.equal(running?.desiredRuntimeState, "running");
    assert.equal(running?.activeRevisionId, revision.id);

    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    const [stopped, retainedRevision] = await fixture.state.read(async (view) =>
      Promise.all([
        view.agents.findAgent(fixture.namespace.id, owner.id),
        view.revisions.findRevision(fixture.namespace.id, owner.id, revision.id),
      ]),
    );
    assert.equal(stopped?.desiredRuntimeState, "stopped");
    assert.equal(stopped?.activeRevisionId, undefined);
    assert.equal(retainedRevision?.id, revision.id);

    await fixture.requestDeletion(owner);
    await waitFor(`Agent ${owner.id} lifecycle deletion to complete`, async () => {
      const deleted = await fixture.currentAgent(owner);
      return deleted === undefined ? true : undefined;
    });
    const [deletedRevision, deletedIdentity, remainingWork] = await Promise.all([
      fixture.state.read((view) =>
        view.revisions.findRevision(fixture.namespace.id, owner.id, revision.id),
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.iam_identities WHERE id = $1",
        [owner.servicePrincipalId],
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.controller_work WHERE agent_id = $1",
        [owner.id],
      ),
    ]);
    assert.equal(deletedRevision, undefined);
    assert.deepEqual(deletedIdentity.rows, [{ count: 0 }]);
    assert.deepEqual(remainingWork.rows, [{ count: 0 }]);
    assert.deepEqual(effects, [
      `prepare:${revision.id}`,
      `stop:${revision.id}`,
      `retire:${revision.id}`,
      `credentials:${owner.id}`,
    ]);

    const lifecycleAudit = await fixture.observerPool.query(
      `SELECT action, outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND action IN (
           'openclaw.agents.lifecycle.stop',
           'openclaw.agents.lifecycle.delete'
         )
       ORDER BY occurred_at`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(lifecycleAudit.rows, [
      {
        action: "openclaw.agents.lifecycle.stop",
        outcome: "success",
        reason_code: "AGENT_STOPPED",
      },
      {
        action: "openclaw.agents.lifecycle.delete",
        outcome: "success",
        reason_code: "AGENT_DELETED",
      },
    ]);
  },
);

revisionTest(
  "maintenance completion takes the Namespace lock before the Agent, like deployment admission",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("maintenance-lock-order");
    await fixture.start({ ...fixture.compute, maintenanceIntervalMs: 200 });
    await fixture.work(candidate, "succeeded");
    const succeededMaintenance = async () =>
      Number(
        (
          await fixture.observerPool.query(
            `SELECT count(*) AS count FROM occ.controller_work
             WHERE revision_id = $1 AND idempotency_key LIKE '%:maintenance:%'
               AND state = 'succeeded'`,
            [candidate.id],
          )
        ).rows[0].count,
      );
    await waitFor("one completed maintenance pass", async () =>
      (await succeededMaintenance()) > 0 ? true : undefined,
    );

    // Deployment admission locks the Namespace, then the Agent. Hold the Namespace
    // until the worker waits on it; the waiting worker must not hold the Agent, or
    // admission and maintenance completion deadlock.
    const before = await withNamespaceLockHeld(
      fixture.observerPool,
      fixture.namespace.id,
      async (lock) => {
        await lock.waitForBlocked("the worker's real wait on the Namespace lock");
        const succeeded = await succeededMaintenance();
        await lock.assertNotHeld(
          "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2 FOR UPDATE NOWAIT",
          [fixture.namespace.id, owner.id],
          "a worker waiting for the Namespace must not already hold the Agent",
        );
        return succeeded;
      },
    );
    await waitFor("the maintenance chain to continue", async () =>
      (await succeededMaintenance()) > before ? true : undefined,
    );
  },
);

revisionTest(
  "development workers run supplied after-commit activation hooks and retry incomplete finalization",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("development-after-commit", {
      agent: { executionMode: "dedicated" },
    });
    const activations = [];
    let failed = false;

    async function activeRevision() {
      const current = await fixture.activePointer(owner);
      assert.equal(current.rowCount, 1);
      return current.rows[0].active_revision_id;
    }

    await fixture.start({
      ...fixture.compute,
      async activateRevision(revision, activationContext) {
        activations.push({
          revisionId: revision.id,
          activeRevisionId: await activeRevision(),
          secretEnvironment: activationContext?.secretEnvironment ?? null,
        });
        if (!failed) {
          failed = true;
          throw new Error("route publication failed");
        }
      },
    });

    const completed = await fixture.work(candidate, "succeeded");
    // Incomplete finalization requeues the same claim without spending an
    // attempt, but the second activation call proves the recovery pass ran.
    assert.equal(completed.attempt_count, 1);
    assert.equal(await activeRevision(), candidate.id);
    assert.deepEqual(
      activations.filter(({ revisionId }) => revisionId === candidate.id),
      [
        { revisionId: candidate.id, activeRevisionId: candidate.id, secretEnvironment: [] },
        { revisionId: candidate.id, activeRevisionId: candidate.id, secretEnvironment: [] },
      ],
    );

    const activation = await fixture.observerPool.query(
      `SELECT resource_id
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(activation.rows, [{ resource_id: candidate.id }]);
  },
);

revisionTest(
  "the revision worker activates admitted candidates, retires predecessors, and rejects revoked, malformed, and wrong-owner effects",
  async (fixture) => {
    const [normal, denied, malformedAdmission, wrongOwner] = await Promise.all([
      fixture.agent("normal"),
      fixture.agent("denied"),
      fixture.agent("malformed-admission"),
      fixture.agent("wrong-owner"),
    ]);
    const [first, revoked, malformed] = await Promise.all([
      fixture.revision(normal, 1),
      fixture.revision(denied, 1),
      fixture.revision(wrongOwner, 1),
    ]);
    assert.equal(first.servicePrincipalId, normal.servicePrincipalId);
    assert.notEqual(normal.servicePrincipalId, denied.servicePrincipalId);
    // Missing its pinned Configuration, Harness, and Compute, so persistence must reject admission.
    await assert.rejects(
      fixture.state.transact((unit) =>
        unit.revisions.createRevision({
          id: `rev_${randomUUID()}`,
          namespaceId: fixture.namespace.id,
          agentId: malformedAdmission.id,
          revision: 1,
          backendId: null,
          configuration: {},
          servicePrincipalId: malformedAdmission.servicePrincipalId,
          createdAt: new Date().toISOString(),
        }),
      ),
      ({ name, message }) =>
        name === "ScopeViolationError" &&
        /harness authentication is invalid or legacy/.test(message),
      "the PostgreSQL adapter rejects incomplete snapshots before persistence",
    );
    // Configuration metadata is valid, but the incomplete Harness and missing Compute are rejected.
    await assert.rejects(
      fixture.observerPool.query(
        `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
         VALUES ($1, $2, $3, 1, $4::jsonb, clock_timestamp())`,
        [
          `rev_${randomUUID()}`,
          fixture.namespace.id,
          malformedAdmission.id,
          JSON.stringify({
            draft_spec: {},
            configuration_id: malformedAdmission.configurationId,
            configuration_kind: "agent",
            configuration_generation: 1,
            harness: { id: "incomplete" },
          }),
        ],
      ),
      ({ code, constraint }) =>
        code === "23514" && constraint === "agent_revisions_admitted_snapshot",
      "PostgreSQL must reject malformed revision snapshots before they can become controller work",
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, denied.id],
    );

    const effects = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(candidate) {
        effects.push({ action: "prepare", revisionId: candidate.id });
        const observation = await fixture.compute.prepareRevision(candidate);
        return candidate.id === malformed.id ? { ...observation, agentId: normal.id } : observation;
      },
      async retireRevision(candidate) {
        // The serving predecessor must survive until its replacement is durably active.
        const current = await fixture.observerPool.query(
          "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
          [candidate.namespaceId, candidate.agentId],
        );
        assert.notEqual(current.rows[0].active_revision_id, candidate.id);
        effects.push({ action: "retire", revisionId: candidate.id });
        return fixture.compute.retireRevision(candidate);
      },
    });

    await Promise.all([
      fixture.work(first, "succeeded"),
      fixture.work(revoked, "failed_permanent"),
      fixture.work(malformed, "failed_permanent"),
    ]);
    assert.deepEqual(
      effects.filter(({ revisionId }) => revisionId === revoked.id),
      [],
      "denied revisions must never invoke Compute",
    );
    const firstActive = await fixture.activePointer(normal);
    assert.equal(firstActive.rows[0].active_revision_id, first.id);
    const unchanged = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = ANY($2::text[])",
      [fixture.namespace.id, [denied.id, malformedAdmission.id, wrongOwner.id]],
    );
    assert.ok(unchanged.rows.every(({ active_revision_id: active }) => active === null));

    const second = await fixture.revision(normal, 2);
    assert.equal(second.servicePrincipalId, first.servicePrincipalId);
    await fixture.work(second, "succeeded");
    const normalEffects = effects.filter(({ revisionId }) =>
      [first.id, second.id].includes(revisionId),
    );
    assert.deepEqual(normalEffects, [
      { action: "prepare", revisionId: first.id },
      { action: "prepare", revisionId: second.id },
      { action: "retire", revisionId: first.id },
    ]);
    const secondActive = await fixture.activePointer(normal);
    assert.equal(secondActive.rows[0].active_revision_id, second.id);

    const denial = await fixture.observerPool.query(
      `SELECT kind, action, resource_id, outcome
       FROM occ.audit_events
       WHERE resource_id = $1 AND kind = 'authorization_denial'`,
      [denied.id],
    );
    assert.deepEqual(denial.rows, [
      {
        kind: "authorization_denial",
        action: "openclaw.agents.deploy",
        resource_id: denied.id,
        outcome: "denied",
      },
    ]);
    const activation = await fixture.observerPool.query(
      `SELECT resource_id, details->>'previousRevisionId' AS previous
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'
       ORDER BY occurred_at`,
      [fixture.namespace.id],
    );
    assert.deepEqual(activation.rows, [
      { resource_id: first.id, previous: null },
      { resource_id: second.id, previous: first.id },
    ]);
  },
);

revisionTest(
  "the revision worker rejects associated-account access revoked after admission before invoking Compute",
  async (fixture) => {
    const provider = backendDefinition();
    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "revoked-account",
    );
    await seedBackendBinding(fixture.observerPool, account);
    const { owner, candidate } = await fixture.admitInitialRevision("revoked-service-account", {
      agent: { executionMode: "dedicated", serviceAccountId: account.id, backendId: provider.id },
    });

    // Admission captured a readable account, but its exact read permission is revoked before dispatch.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'service_account', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, account.id],
    );

    const effects = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        effects.push({ action: "prepare", revisionId: revision.id });
        return fixture.compute.prepareRevision(revision);
      },
      async retireRevision(revision) {
        effects.push({ action: "retire", revisionId: revision.id });
        return fixture.compute.retireRevision(revision);
      },
    });

    const failed = await fixture.work(candidate, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    assert.deepEqual(
      effects.filter(({ revisionId }) => revisionId === candidate.id),
      [],
      "revoked account access must prevent Compute effects for its admitted revision",
    );

    const active = await fixture.activePointer(owner);
    assert.equal(active.rows[0].active_revision_id, null);

    // The outer deployment denial names its Agent while retaining the failed exact account decision.
    const denial = await fixture.observerPool.query(
      `SELECT action, resource_kind, resource_id, outcome,
              details->'__occAuditMetadata'->'authorization' AS authorization,
              details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE resource_id = $1 AND kind = 'authorization_denial'`,
      [owner.id],
    );
    assert.deepEqual(denial.rows, [
      {
        action: "openclaw.agents.deploy",
        resource_kind: "agent",
        resource_id: owner.id,
        outcome: "denied",
        authorization: {
          principalId: fixture.actor.id,
          action: "read",
          resource: {
            kind: "service_account",
            id: account.id,
            namespaceId: fixture.namespace.id,
          },
        },
        reason_code: "AUTHORIZATION_DENIED",
      },
    ]);
  },
);

revisionTest(
  "the revision worker rejects managed ServiceAccount issuance revoked after admission before Compute",
  async (fixture, context) => {
    // The shared worker must drain another Namespace without including its
    // Compute effects in this Namespace's issuance-revocation assertions.
    const foreign = await setup(context, { database: fixture.database });
    const foreignOwner = await foreign.agent("issuance-foreign");
    const foreignRevision = await foreign.revision(foreignOwner, 1);
    const provider = backendDefinition();
    const accounts = await Promise.all(
      ["valid", "issuance-revoked"].map((label) =>
        createAccessTokenServiceAccount(fixture.state, fixture.namespace.id, label),
      ),
    );
    await Promise.all(accounts.map((account) => seedBackendBinding(fixture.observerPool, account)));
    const owners = await Promise.all(
      accounts.map((account) =>
        fixture.agent(account.name, {
          executionMode: "dedicated",
          serviceAccountId: account.id,
          backendId: provider.id,
        }),
      ),
    );
    const candidates = await Promise.all(owners.map((owner) => fixture.revision(owner, 1)));
    // Only issuance metadata is mutable; private Backend/account ownership
    // remains protected by PostgreSQL grants and the immutable snapshot.
    await fixture.observerPool.query(
      "UPDATE occ.service_account_driver_bindings SET external_credential_id = NULL WHERE namespace_id = $1 AND service_account_id = $2",
      [fixture.namespace.id, accounts[1].id],
    );
    const effects = [];
    await fixture.start(
      {
        ...fixture.compute,
        async bindAgent({ agent }) {
          if (agent.namespaceId === fixture.namespace.id) {
            effects.push({ action: "bind", agentId: agent.id });
          }
        },
        async prepareRevision(revision) {
          if (revision.namespaceId === fixture.namespace.id) {
            effects.push({ action: "prepare", revisionId: revision.id });
          }
          return fixture.compute.prepareRevision(revision);
        },
      },
      { providers: [provider] },
    );
    await Promise.all(
      candidates.map((candidate, index) =>
        fixture.work(candidate, index === 0 ? "succeeded" : "failed_permanent"),
      ),
    );
    await foreign.work(foreignRevision, "succeeded");
    assert.deepEqual(effects, [
      { action: "bind", agentId: owners[0].id },
      { action: "prepare", revisionId: candidates[0].id },
    ]);
    const current = await fixture.currentAgent(owners[1]);
    assert.equal(current.activeRevisionId, undefined);
    const failures = await fixture.observerPool.query(
      "SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'",
      [candidates[1].id],
    );
    assert.deepEqual(failures.rows, [{ reason_code: "SERVICE_ACCOUNT_BACKEND_MISMATCH" }]);
    // The status names the fix instead of the generic failure text (finding 828).
    assert.deepEqual((await fixture.deploymentStatus(owners[1], candidates[1])).error, {
      code: "SERVICE_ACCOUNT_BACKEND_MISMATCH",
      message:
        "The ServiceAccount's Backend binding no longer matches the Agent's Backend, or its credential is no longer issued. Bind a ServiceAccount created and issued under the Agent's current Backend, then deploy again.",
    });
  },
);

test(
  "the revision worker retries transient Backend binding read failures without activating",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const events = [];
    const releaseRetry = Promise.withResolvers();
    const fixture = await setup(context, {
      async onHealthy() {
        if (
          events.some(
            ({ event, code, namespaceId }) =>
              event === "worker.completed" &&
              code === "DEPENDENCY_UNAVAILABLE" &&
              namespaceId === fixture.namespace.id,
          )
        ) {
          // Hold the next pass while inspecting the failed attempt, regardless
          // of how much of the retry backoff the observer has already consumed.
          await releaseRetry.promise;
        }
      },
    });
    const provider = backendDefinition();

    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "transient-provider-read",
    );
    await seedBackendBinding(fixture.observerPool, account);
    const owner = await fixture.agent("transient-provider-read", {
      executionMode: "dedicated",
      serviceAccountId: account.id,
      backendId: provider.id,
    });

    const effects = [];
    try {
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision) {
            effects.push({ action: "prepare", revisionId: revision.id });
            return fixture.compute.prepareRevision(revision);
          },
        },
        {
          emit: (event) => events.push(event),
          providers: [provider],
          pool: poolWithOneBackendBindingReadFault(fixture.workerPool),
        },
      );

      const candidate = await fixture.revision(owner, 1);

      // A different connection can see the committed retry before the worker
      // receives COMMIT's acknowledgment and emits its completion event.
      const completion = await waitFor("transient Provider read failure completion", async () =>
        events.find(
          ({ event, code, revisionId }) =>
            event === "worker.completed" &&
            code === "DEPENDENCY_UNAVAILABLE" &&
            revisionId === candidate.id,
        ),
      );
      assert.equal(completion.outcome, "retry");
      const retried = await waitFor(
        "transient Backend binding read failure retry evidence",
        async () => {
          const result = await fixture.observerPool.query(
            `SELECT work.state, work.attempt_count,
                    count(audit.id)::integer AS dependency_failures
             FROM occ.controller_work AS work
             LEFT JOIN occ.audit_events AS audit
               ON audit.namespace_id = work.namespace_id
              AND audit.resource_id = work.revision_id
              AND audit.action = 'reconcile'
              AND audit.details->>'reasonCode' = 'DEPENDENCY_UNAVAILABLE'
             WHERE work.idempotency_key = $1
             GROUP BY work.state, work.attempt_count`,
            [candidate.idempotencyKey],
          );
          const row = result.rows[0];
          if (row?.dependency_failures >= 1 && row.state !== "failed_permanent") {
            return row;
          }
          return undefined;
        },
      );
      assert.deepEqual(retried, { state: "queued", attempt_count: 1, dependency_failures: 1 });
      assert.deepEqual(effects, [], "transient binding read failures must not invoke Compute");
      const inactive = await fixture.activePointer(owner);
      assert.equal(inactive.rows[0].active_revision_id, null);

      releaseRetry.resolve();
      await fixture.work(candidate, "succeeded");
      assert.deepEqual(effects, [{ action: "prepare", revisionId: candidate.id }]);
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, candidate.id);
    } finally {
      releaseRetry.resolve();
      await fixture.stop();
    }
  },
);

test(
  "an older revision retry is superseded without preparing or retiring a newer active revision",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
    const { owner, candidate: older } = await fixture.admitInitialRevision("superseded-retry");
    const newer = await fixture.revision(owner, 2);
    const effects = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(candidate) {
          effects.push({ action: "prepare", revisionId: candidate.id });
          const observation = await fixture.compute.prepareRevision(candidate);
          return candidate.id === older.id ? { ...observation, ready: false } : observation;
        },
        async retireRevision(candidate) {
          effects.push({ action: "retire", revisionId: candidate.id });
          return fixture.compute.retireRevision(candidate);
        },
      },
      { emit: (event) => events.push(event) },
    );

    await Promise.all([fixture.work(newer, "succeeded"), fixture.work(older, "succeeded")]);
    // The deploy duration is observed just before the newer revision's completion
    // event; the older retry's supersession completes without a deploy observation.
    await completion(
      events,
      "the newer revision's successful completion",
      ({ event, workId, outcome }) =>
        event === "worker.completed" && workId === newer.idempotencyKey && outcome === "success",
    );
    await completion(
      events,
      "the older revision's REVISION_SUPERSEDED completion",
      ({ event, code, revisionId }) =>
        event === "worker.completed" && code === "REVISION_SUPERSEDED" && revisionId === older.id,
    );
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 1(?:\n|$)/,
    );
    // Newer publication retires every older candidate. The later superseded retry
    // must contribute no preparation or retirement against the active revision.
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: older.id },
      { action: "prepare", revisionId: newer.id },
      { action: "retire", revisionId: older.id },
    ]);
    const active = await fixture.activePointer(owner);
    assert.equal(active.rows[0].active_revision_id, newer.id);
    const superseded = await fixture.observerPool.query(
      `SELECT action, outcome, details->>'activeRevisionId' AS active_revision_id,
              details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.supersede'`,
      [older.id],
    );
    assert.deepEqual(superseded.rows, [
      {
        action: "openclaw.agents.lifecycle.supersede",
        outcome: "success",
        active_revision_id: newer.id,
        reason_code: "REVISION_SUPERSEDED",
      },
    ]);
  },
);

revisionTest(
  "deployment progress distinguishes deferred work and isolates each work item's evidence",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("deployment-progress");
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool);
    const readStatus = () => fixture.deploymentStatus(owner, candidate);

    const initial = await readStatus();
    assert.equal(initial.status, "queued");
    assert.equal(initial.progress.lastAttempt, null);

    const evidenceCodes = async () =>
      (
        await fixture.observerPool.query(
          `SELECT details->>'reasonCode' AS code FROM occ.audit_events
           WHERE details->>'workId' = $1 AND action = 'reconcile' ORDER BY occurred_at, id`,
          [candidate.idempotencyKey],
        )
      ).rows.map(({ code }) => code);
    const makeDue = () =>
      fixture.observerPool.query(
        "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );

    // A normal pending observation restores the failure budget to zero. It must
    // still be distinguishable from a deployment that has never been checked.
    const first = await queue.claim();
    assert.equal(first.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(first, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const firstDeferred = await readStatus();
    assert.deepEqual(await evidenceCodes(), ["REVISION_INCOMPLETE"]);

    // Repeating the same pending result is not a state transition: it adds no audit row,
    // and progress keeps reporting when that result was first recorded.
    await makeDue();
    const claim = await queue.claim();
    assert.equal(claim.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(claim, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const deferred = await readStatus();
    assert.deepEqual(await evidenceCodes(), ["REVISION_INCOMPLETE"]);
    assert.deepEqual(deferred.progress.lastAttempt, firstDeferred.progress.lastAttempt);
    assert.equal(deferred.status, "queued");
    assert.equal((await queue.findWork(candidate.idempotencyKey)).attemptCount, 0);
    assert.equal(deferred.progress.lastAttempt.code, "REVISION_INCOMPLETE");
    assert.equal(deferred.progress.lastAttempt.message, "Waiting for the runtime to become ready.");
    assert.ok(Number.isFinite(Date.parse(deferred.progress.lastAttempt.at)));
    assert.equal(
      deferred.progress.nextAttemptAt,
      (await queue.findWork(candidate.idempotencyKey)).availableAt.toISOString(),
    );

    // Maintenance shares the revision and actor, but cannot overwrite the
    // original deployment's progress. Both transitions use the real queue.
    const maintenanceKey = `agent_revision:${candidate.id}:maintenance:0`;
    await queue.enqueue({
      idempotencyKey: maintenanceKey,
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: candidate.id,
      actorId: fixture.actor.id,
    });
    const maintenance = await queue.claim();
    assert.equal(maintenance.idempotencyKey, maintenanceKey);
    await queue.defer(maintenance, { code: "DEPENDENCY_UNAVAILABLE" }, { delayMs: 60_000 });
    assert.deepEqual((await readStatus()).progress, deferred.progress);

    // Rescheduling only our fixture work lets a new claim exercise retry output.
    await makeDue();
    const retry = await queue.claim();
    assert.equal(retry.idempotencyKey, candidate.idempotencyKey);
    const running = await readStatus();
    assert.equal(running.status, "running");
    assert.equal(running.progress.nextAttemptAt, null);
    assert.deepEqual(running.progress.lastAttempt, deferred.progress.lastAttempt);
    await queue.retry(retry, { code: "PRIVATE_PROVIDER_DETAIL_DO_NOT_EXPOSE" });
    const retrying = await readStatus();
    assert.equal(retrying.progress.lastAttempt.code, "RECONCILIATION_PENDING");
    assert.doesNotMatch(JSON.stringify(retrying), /PRIVATE_PROVIDER/);

    // Returning to the pending result after a failure is a transition and is recorded again.
    await makeDue();
    const recovered = await queue.claim();
    assert.equal(recovered.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(recovered, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const codes = await evidenceCodes();
    assert.equal(codes.length, 3);
    assert.equal(codes[0], "REVISION_INCOMPLETE");
    assert.equal(codes[2], "REVISION_INCOMPLETE");
    assert.equal((await readStatus()).progress.lastAttempt.code, "REVISION_INCOMPLETE");

    // Let the real worker finish this admitted revision; completion must remove
    // the pending explanation rather than retain an obsolete readiness warning.
    await makeDue();
    await fixture.start(fixture.compute);
    await fixture.work(candidate, "succeeded");
    const completed = await readStatus();
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.progress, null);
  },
);

revisionTest(
  "deployment status judges claim liveness by the database clock, not the controller clock",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("deployment-clock");
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { leaseDurationMs: 60_000 });
    // Both controllers read the same durable work with clocks skewed far from PostgreSQL's.
    const statusFrom = (instant) => {
      const controller = createBackendController(fixture, {
        backends: [],
        now: () => new Date(instant),
      });
      return async () =>
        (
          await controller.getDeploymentStatus(
            fixture.actor.id,
            fixture.namespace.id,
            owner.id,
            candidate.id,
          )
        ).status;
    };
    const statusAhead = statusFrom("2999-01-01T00:00:00Z");
    const statusBehind = statusFrom("1970-01-01T00:00:00Z");

    const claim = await queue.claim();
    assert.equal(claim.idempotencyKey, candidate.idempotencyKey);
    // A controller clock ahead of the lease still reports the live claim.
    assert.equal(await statusAhead(), "running");

    await fixture.expireClaim(candidate, claim.claimToken);
    // A controller clock behind the lease still reports the expired claim as waiting.
    assert.equal(await statusBehind(), "queued");
  },
);

revisionTest(
  "real PostgreSQL preserves the failure budget while an Agent runtime converges",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("slow-runtime");
    let observations = 0;
    const events = [];

    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          const observation = await fixture.compute.prepareRevision(revision);
          observations += 1;
          // Image pulls and app-server startup remain ordinary pending observations, not failures.
          return observations <= 7 ? { ...observation, ready: false } : observation;
        },
      },
      { emit: (event) => events.push(event) },
    );

    const completed = await fixture.work(candidate, "succeeded");
    assert.equal(observations, 8);
    assert.equal(completed.attempt_count, 1);

    // Each pass reports its deployment phase timing; the successful pass carries
    // the totals across all eight passes of this one work item.
    const passes = await waitFor("the successful deployment pass to be reported", () => {
      const reported = events.filter(
        (event) => event.event === "worker.completed" && event.workId === candidate.idempotencyKey,
      );
      return reported.at(-1)?.outcome === "success" ? reported : undefined;
    });
    assert.deepEqual(
      passes.map(({ outcome, code, deployPasses }) => ({ outcome, code, deployPasses })),
      [
        ...Array.from({ length: 7 }, (_, index) => ({
          outcome: "pending",
          code: "REVISION_INCOMPLETE",
          deployPasses: index + 1,
        })),
        { outcome: "success", code: "REVISION_ACTIVATED", deployPasses: 8 },
      ],
    );
    for (const pass of passes.slice(0, 7)) {
      assert.equal(pass.activationMs, undefined, "an unready pass has no activation phase");
    }
    const success = passes.at(-1);
    // Seven jittered readiness retries separate the first unready and the ready observation.
    assert.ok(success.readinessWaitMs > 0);
    assert.ok(success.readinessWaitMs >= passes[6].readinessWaitMs);
    assert.ok(success.elapsedMs >= success.readinessWaitMs);
    assert.ok(success.prepareMs >= 0 && success.prepareMs <= success.elapsedMs);
    assert.ok(success.activationMs >= 0 && success.activationMs <= success.durationMs);
    assert.ok(success.durationMs <= success.elapsedMs);

    // The pending state is durable and attributable, but seven identical deferrals are one
    // state transition: the audit log records it once, then the activation.
    const evidence = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' ORDER BY occurred_at, id`,
      [candidate.id],
    );
    assert.deepEqual(evidence.rows, [
      { outcome: "success", reason_code: "REVISION_INCOMPLETE" },
      { outcome: "success", reason_code: "REVISION_ACTIVATED" },
    ]);
    const active = await fixture.activePointer(owner);
    assert.equal(active.rows[0].active_revision_id, candidate.id);
  },
);

revisionTest(
  "real PostgreSQL rechecks a not-ready runtime on a short fixed delay after transient failures",
  async (fixture) => {
    const { candidate } = await fixture.admitInitialRevision("readiness-recheck");
    const recheckDelays = [];
    let observations = 0;

    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          if (revision.id !== candidate.id) {
            return fixture.compute.prepareRevision(revision);
          }
          observations += 1;
          // Two dependency failures raise the attempt count, so the queue's
          // exponential retry backoff would now allow up to 4 s per recheck.
          if (observations <= 2) {
            throw new Error("transient Compute dependency failure");
          }
          const observation = await fixture.compute.prepareRevision(revision);
          return observations <= 5 ? { ...observation, ready: false } : observation;
        },
      },
      {
        emit: (event) => {
          if (
            event.event === "worker.completed" &&
            event.workId === candidate.idempotencyKey &&
            event.outcome === "pending"
          ) {
            // The deferral sets the due time and updated_at in one statement, and the
            // row stays queued until that due time, about 500 ms after this event.
            recheckDelays.push(
              fixture.observerPool
                .query(
                  `SELECT state, EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
                 FROM occ.controller_work WHERE idempotency_key = $1`,
                  [candidate.idempotencyKey],
                )
                .then(({ rows }) => rows[0]),
            );
          }
        },
      },
    );

    const completed = await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(observations, 6);
    // Failures consumed two attempts; readiness rechecks refunded theirs.
    assert.equal(completed.attempt_count, 3);
    const recheckDelaysMs = [];
    for (const { state, delay_ms } of await Promise.all(recheckDelays)) {
      assert.equal(state, "queued");
      recheckDelaysMs.push(Number(delay_ms));
    }
    assert.equal(recheckDelaysMs.length, 3);
    for (const delayMs of recheckDelaysMs) {
      assert.ok(
        delayMs > 450 && delayMs <= 500,
        `readiness recheck must wait about 500 ms, not the retry backoff (${delayMs} ms)`,
      );
    }
  },
);

revisionTest(
  "deployment progress names Compute's pending reason and old pending work rechecks less often",
  async (fixture) => {
    const unscheduled = await fixture.agent("pending-unschedulable");
    const unpaired = await fixture.agent("pending-node");
    const overQuota = await fixture.agent("pending-pod-quota");
    const setupRetrying = await fixture.agent("pending-workspace-setup");
    const imagePull = await fixture.agent("pending-image-pull");
    const unscheduledRevision = await fixture.revision(unscheduled, 1);
    const overQuotaRevision = await fixture.revision(overQuota, 1);
    const setupRetryingRevision = await fixture.revision(setupRetrying, 1);
    const imagePullRevision = await fixture.revision(imagePull, 1);
    // Admitted five minutes ago by PostgreSQL's clock, which judges work age (finding 1187),
    // and still inside the 900-second deadline.
    const unpairedRevision = await fixture.revision(unpaired, 1, { workAge: "300 seconds" });
    const reasons = new Map([
      [unscheduledRevision.id, "WORKLOAD_UNSCHEDULABLE"],
      [unpairedRevision.id, "WORKSPACE_NODE_PENDING"],
      [overQuotaRevision.id, "NAMESPACE_POD_QUOTA_EXCEEDED"],
      [setupRetryingRevision.id, "WORKSPACE_SETUP_RETRYING"],
      [imagePullRevision.id, "WORKLOAD_IMAGE_PULL_FAILED"],
    ]);
    const delays = new Map([
      [unscheduledRevision.idempotencyKey, []],
      [unpairedRevision.idempotencyKey, []],
    ]);
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            pendingReason: reasons.get(revision.id),
          };
        },
      },
      {
        emit: (event) => {
          if (
            event.event === "worker.completed" &&
            delays.has(event.workId) &&
            event.outcome === "pending"
          ) {
            delays.get(event.workId).push(
              fixture.observerPool
                .query(
                  `SELECT EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
                 FROM occ.controller_work WHERE idempotency_key = $1`,
                  [event.workId],
                )
                .then(({ rows }) => Number(rows[0].delay_ms)),
            );
          }
        },
      },
    );
    const progress = async (owner, revision) => {
      const lastAttempt = await waitFor(`pending progress for ${revision.id}`, async () => {
        const status = await fixture.deploymentStatus(owner, revision);
        return status.progress?.lastAttempt ?? undefined;
      });
      return { code: lastAttempt.code, message: lastAttempt.message };
    };
    assert.deepEqual(await progress(unscheduled, unscheduledRevision), {
      code: "REVISION_UNSCHEDULABLE",
      message:
        "The cluster has no room for this Agent's Pods yet; they are waiting to be scheduled.",
    });
    assert.deepEqual(await progress(unpaired, unpairedRevision), {
      code: "WORKSPACE_NODE_PENDING",
      message: "Workloads are ready; waiting for the workspace node to connect to the Gateway.",
    });
    // Finding 1617: a full Namespace Pod quota is named, without its numbers.
    assert.deepEqual(await progress(overQuota, overQuotaRevision), {
      code: "NAMESPACE_POD_QUOTA_EXCEEDED",
      message:
        "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an administrator to raise the quota.",
    });
    // Finding 1677: Kubernetes is restarting a failed workspace setup that may still pass.
    assert.deepEqual(await progress(setupRetrying, setupRetryingRevision), {
      code: "WORKSPACE_SETUP_RETRYING",
      message:
        "Workspace setup failed; Kubernetes is retrying it. If it keeps failing, ask an admin to check the Agent's workspace storage and runtime image.",
    });
    // Finding 1762: the kubelet cannot pull an image; fixed copy, never the image reference.
    assert.deepEqual(await progress(imagePull, imagePullRevision), {
      code: "REVISION_IMAGE_PULL_FAILED",
      message:
        "Kubernetes cannot pull a container image for this Agent and keeps retrying. Ask an administrator to check the runtime image reference and that the cluster's nodes can pull from its registry.",
    });
    const firstDelay = async (revision) => {
      const recorded = delays.get(revision.idempotencyKey);
      await waitFor(`a recheck of ${revision.id}`, async () => recorded.length > 0 || undefined);
      return recorded[0];
    };
    const fresh = await firstDelay(unscheduledRevision);
    assert.ok(fresh > 450 && fresh <= 500, `a new deployment rechecks in 500 ms (${fresh} ms)`);

    // A runtime that stays unready for five minutes is rechecked every 5 s, so
    // one stuck Agent cannot take most of the serial worker (D223).
    const old = await firstDelay(unpairedRevision);
    assert.ok(old > 4_500 && old <= 5_000, `an old deployment rechecks in 5 s (${old} ms)`);
  },
);

test(
  "the revision worker emits bounded Driver diagnostics for failed Compute preparation",
  requiresPostgres,
  async (context) => {
    const events = [];
    const fixture = await setup(context, { maxAttempts: 1 });
    const { owner, candidate } = await fixture.admitInitialRevision(
      "compute-preparation-diagnostic",
    );
    const failure = new Error("opaque provider response that must not be logged");

    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          if (revision.id === candidate.id) {
            throw failure;
          }
          return fixture.compute.prepareRevision(revision);
        },
        describePrepareRevisionFailure(error) {
          assert.equal(error, failure);
          return {
            code: "KUBERNETES_API_REJECTED",
            stage: "gateway_deployment",
            errorClass: "KubernetesApiError",
            message: "The Kubernetes API rejected revision preparation.",
            status: 422,
          };
        },
      },
      { emit: (event) => events.push(event) },
    );

    await fixture.work(candidate, "failed_permanent");
    await completion(
      events,
      "the failed preparation's completion",
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === candidate.id &&
        event.code === "DEPENDENCY_UNAVAILABLE" &&
        event.outcome === "retry",
    );
    const diagnostic = events.find(
      (event) =>
        event.event === "worker.compute-prepare-failed" && event.revisionId === candidate.id,
    );
    assert.deepEqual(diagnostic, {
      event: "worker.compute-prepare-failed",
      workId: candidate.idempotencyKey,
      attempt: 1,
      operation: "agent_revision.reconcile",
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: candidate.id,
      computeDriverId: fixture.compute.id,
      code: "KUBERNETES_API_REJECTED",
      step: "gateway_deployment",
      errorClass: "KubernetesApiError",
      message: "The Kubernetes API rejected revision preparation.",
      status: 422,
    });
    assert.equal(JSON.stringify(events).includes(failure.message), false);
  },
);

test(
  "a graceful shutdown during Compute preparation logs the interrupted pass, not errors",
  requiresPostgres,
  async (context) => {
    // Finding 1040: stopping the worker aborts the pass in flight. Its claim is recovered when
    // the lease expires, so no compute-prepare-failed or CLAIM_LOST error is logged.
    const events = [];
    const lines = [];
    const logged = createWorkerLogEmitter(
      createOccLogger({
        component: "occ-worker",
        level: "debug",
        destination: {
          write(chunk) {
            for (const line of String(chunk).split("\n")) {
              if (line.length > 0) {
                lines.push(JSON.parse(line));
              }
            }
            return true;
          },
        },
      }),
    );
    const fixture = await setup(context);
    const { candidate } = await fixture.admitInitialRevision("compute-preparation-shutdown");
    let entered;
    const preparing = new Promise((resolve) => {
      entered = resolve;
    });
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (revision.id !== candidate.id) {
            return fixture.compute.prepareRevision(revision, revisionContext);
          }
          const signal = currentComputeAbortSignal();
          entered();
          await new Promise((resolve) => {
            signal.addEventListener("abort", resolve, { once: true });
          });
          throw new Error("Kubernetes request aborted by the worker");
        },
        describePrepareRevisionFailure() {
          return { code: "KUBERNETES_PREPARATION_FAILED", stage: "prepare_revision" };
        },
      },
      {
        emit: (event) => {
          events.push(event);
          logged(event);
        },
      },
    );
    await preparing;
    await fixture.stop();

    assert.deepEqual(
      events.filter(({ event }) => event !== "worker.health").map(({ event }) => event),
      ["worker.started", "worker.pass-interrupted", "worker.stopped"],
    );
    assert.deepEqual(
      events.find(({ event }) => event === "worker.pass-interrupted"),
      {
        event: "worker.pass-interrupted",
        workId: candidate.idempotencyKey,
        attempt: 1,
        operation: "agent_revision.reconcile",
        cause: "WorkerStopping",
      },
    );
    assert.deepEqual(
      lines
        .filter(({ event }) => event !== "worker.health")
        .map(({ event, severity }) => ({ event, severity })),
      [
        { event: "worker.started", severity: "INFO" },
        { event: "worker.pass-interrupted", severity: "INFO" },
        { event: "worker.stopped", severity: "INFO" },
      ],
    );
    // The work keeps its claim until the lease expires; then another worker resumes it.
    const work = await fixture.observerPool.query(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [candidate.idempotencyKey],
    );
    assert.deepEqual(work.rows, [{ state: "claimed", attempt_count: 1 }]);
  },
);

revisionTest(
  "terminal Compute preparation persists failure and resumes exact cleanup after worker restart",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("bootstrap-failure");
    let preparations = 0;
    let cleanupAllowed = false;
    let cleanups = 0;
    const preparation = {
      workload: {
        kind: "Job",
        name: "oauth-bootstrap-fixture",
        uid: randomUUID(),
        namespace: "tenant-fixture",
      },
      reason: "retry_limit",
      observedAt: "2026-10-12T12:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      pods: [],
    };
    const compute = {
      ...fixture.compute,
      async prepareRevision() {
        preparations += 1;
        throw new ComputePreparationFailedError("HARNESS_CREDENTIAL_BOOTSTRAP_FAILED", preparation);
      },
      async stopRevision(revision) {
        // Runtime retirement must start only after the deployment is terminal.
        const failed = await fixture.workResult(candidate);
        assert.equal(failed.rows[0].reason_code, "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED");
        assert.equal(revision.id, candidate.id);
        cleanups += 1;
        if (!cleanupAllowed) {
          throw new DependencyUnavailableError("Temporary cleanup outage.");
        }
        await fixture.compute.stopRevision(revision);
      },
    };
    await fixture.start(compute);
    await assertFailedDeployment(
      fixture,
      { owner, candidate },
      {
        error: {
          code: "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED",
          message: "Harness credential initialization failed. Correct the cause and deploy again.",
          data: { preparation },
        },
        resultData: { preparation },
      },
    );
    const cleanupRow = async () =>
      (
        await fixture.observerPool.query(
          "SELECT state, reason_code FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE '%:repository_cleanup:retire:%'",
          [candidate.id],
        )
      ).rows[0];
    await waitFor("failed preparation to retain its cleanup obligation", async () => {
      const row = await cleanupRow();
      return cleanups > 0 && row?.state === "queued" ? row : undefined;
    });
    await fixture.stop();

    const pendingStatus = await fixture.deploymentStatus(owner, candidate);
    assert.equal(pendingStatus.cleanup.status, "queued");
    assert.equal(typeof pendingStatus.cleanup.nextAttemptAt, "string");
    // The database must reject raw provider output even if a writer bypasses
    // the controller's public evidence validator.
    await assert.rejects(
      fixture.observerPool.query(
        "UPDATE occ.controller_work SET result_data = $2::jsonb WHERE idempotency_key = $1",
        [
          candidate.idempotencyKey,
          JSON.stringify({ preparation: { ...preparation, rawOutput: "provider detail" } }),
        ],
      ),
      (error) => error.code === "23514" && error.constraint === "controller_work_result_data_state",
    );

    // The new worker resumes cleanup from PostgreSQL, without invoking
    // preparation again even though the Driver's bootstrap resources are gone.
    cleanupAllowed = true;
    await advanceCleanupRetries(fixture, candidate);
    await fixture.start(compute);
    await waitFor("failed preparation cleanup after restart", async () => {
      const row = await cleanupRow();
      return row?.state === "succeeded" ? row : undefined;
    });
    assert.equal(preparations, 1);
    assert.ok(cleanups >= 2);
    assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "failed");
    const completedStatus = await fixture.deploymentStatus(owner, candidate);
    assert.equal(completedStatus.cleanup.status, "succeeded");
    assert.deepEqual(completedStatus.error.data, { preparation });
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, null);
  },
);

revisionTest(
  "an overdue Agent runtime fails closed without activating its incomplete revision",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("expired-runtime");
    const runtimeFailure = {
      component: "gateway",
      check: "readyz",
      checkedAt: "2026-09-19T20:30:00.000Z",
      code: "STARTUP_FAILED",
    };

    // A real short deadline expires against the durable queued creation timestamp.
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            runtimeFailure,
          };
        },
      },
      { convergenceTimeoutMs: 1 },
    );

    const failed = await fixture.work(candidate, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    const active = await fixture.activePointer(owner);
    assert.equal(active.rows[0].active_revision_id, null);
    const evidence = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
       WHERE resource_id = $1 AND details->>'reasonCode' = 'CONVERGENCE_DEADLINE_EXCEEDED'`,
      [candidate.id],
    );
    assert.deepEqual(evidence.rows, [{ reason: "CONVERGENCE_DEADLINE_EXCEEDED" }]);
    // The Compute observation carried a check and code outside the runtime's vocabulary. They
    // are recorded as UNRECOGNIZED, so neither the stored work nor its status carries them
    // (finding 1660).
    const recordedRuntimeFailure = {
      ...runtimeFailure,
      check: "UNRECOGNIZED",
      code: "UNRECOGNIZED",
    };
    const recorded = await fixture.observerPool.query(
      "SELECT result_data FROM occ.controller_work WHERE idempotency_key = $1",
      [candidate.idempotencyKey],
    );
    assert.deepEqual(recorded.rows[0].result_data, {
      timeoutMs: 1,
      runtimeFailure: recordedRuntimeFailure,
    });
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "CONVERGENCE_DEADLINE_EXCEEDED",
      message:
        "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.",
      data: { timeoutMs: 1, runtimeFailure: recordedRuntimeFailure },
    });
    assert.deepEqual(status.warnings, []);
    // A runtime that failed by itself stays for diagnosis: nothing retires it.
    assert.equal(status.cleanup, null);
  },
);

revisionTest(
  "an OAuth bootstrap still running at the convergence deadline retires its revision with the failure",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("expired-bootstrap");
    const stopped = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            pendingReason: "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING",
          };
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
          await fixture.compute.stopRevision(revision);
        },
      },
      { convergenceTimeoutMs: 1 },
    );

    await fixture.work(candidate, "failed_permanent");
    // The retirement obligation commits with the failure, so the bootstrap Job and its
    // seed Secret (the OAuth token bundle) cannot outlive the failed revision.
    const cleanupRow = async () =>
      (
        await fixture.observerPool.query(
          "SELECT state FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE '%:repository_cleanup:retire:%'",
          [candidate.id],
        )
      ).rows;
    assert.equal((await cleanupRow()).length, 1);
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "CONVERGENCE_DEADLINE_EXCEEDED",
      message:
        "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.",
      data: { timeoutMs: 1 },
    });
    assert.notEqual(status.cleanup, null);
    await waitFor("the expired bootstrap's revision cleanup", async () => {
      const [row] = await cleanupRow();
      return row?.state === "succeeded" ? row : undefined;
    });
    assert.ok(stopped.includes(candidate.id));
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, null);
  },
);

revisionTest(
  "the convergence deadline judges work age by the database clock, not the controller clock",
  async (fixture, context) => {
    // The worker's wall clock disagrees with PostgreSQL's by five minutes, first ahead and then
    // behind. Work's creation time is on the database clock, so its deadline must be too:
    // otherwise skew alone retires a pending OAuth bootstrap early or holds it past the deadline.
    // Each direction has its own deployment, a minute or more from the deadline by the database
    // clock, so neither outcome depends on how soon the worker's first pass runs (finding 1171).
    const timeoutMs = 60_000;
    const skewMs = 300_000;
    let controllerSkewMs = skewMs;
    // The worker reads the global clock. context.mock restores it when this test ends, even on
    // failure, and the file runs one test at a time, so no other test sees the skew.
    const realNow = Date.now;
    const controllerClock = context.mock.method(Date, "now", () => realNow() + controllerSkewMs);
    const outcomes = new Map();
    const passes = ({ idempotencyKey }) => outcomes.get(idempotencyKey) ?? [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            pendingReason: "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING",
          };
        },
      },
      {
        convergenceTimeoutMs: timeoutMs,
        emit: (event) => {
          if (event.event === "worker.completed") {
            outcomes.set(event.workId, [...(outcomes.get(event.workId) ?? []), event.outcome]);
          }
        },
      },
    );
    const workRow = async (candidate) =>
      (
        await fixture.observerPool.query(
          `SELECT state, EXTRACT(EPOCH FROM COALESCE(completed_at, clock_timestamp()) - created_at)
                    * 1000 AS age_ms
           FROM occ.controller_work WHERE idempotency_key = $1`,
          [candidate.idempotencyKey],
        )
      ).rows[0];
    const cleanupRows = async (candidate) =>
      (
        await fixture.observerPool.query(
          "SELECT state FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE '%:repository_cleanup:retire:%'",
          [candidate.id],
        )
      ).rows;

    // Ahead: the controller clock already counts new work as five minutes old, past the deadline,
    // yet by the database clock it is young, so the bootstrap keeps waiting.
    const young = await fixture.admitInitialRevision("deadline-clock-ahead");
    await waitFor(
      "a pass ahead of the database clock",
      async () => passes(young.candidate)[0],
      timeoutMs - 15_000,
    );
    const youngRow = await workRow(young.candidate);
    assert.ok(Number(youngRow.age_ms) < timeoutMs, `work is still young (${youngRow.age_ms} ms)`);
    assert.equal(passes(young.candidate)[0], "pending");
    assert.notEqual(youngRow.state, "failed_permanent");
    assert.deepEqual(await cleanupRows(young.candidate), []);

    // Behind: work admitted two minutes ago by the database clock is past the deadline, though the
    // controller clock would not count it as old for another four minutes. Its first pass fails it.
    controllerSkewMs = -skewMs;
    const old = await fixture.admitInitialRevision("deadline-clock-behind", {
      revision: { workAge: `${(2 * timeoutMs) / 1000} seconds` },
    });
    await fixture.work(old.candidate, "failed_permanent", 30_000);
    await waitFor("the old work's pass", async () => passes(old.candidate)[0]);
    controllerClock.mock.restore();
    const failed = await workRow(old.candidate);
    assert.ok(Number(failed.age_ms) >= timeoutMs, `failed past the deadline (${failed.age_ms} ms)`);
    assert.deepEqual(passes(old.candidate), ["permanent"]);
    const status = await fixture.deploymentStatus(old.owner, old.candidate);
    assert.equal(status.error?.code, "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.deepEqual(status.error?.data, { timeoutMs });
    // The deadline retires the bootstrap with the failure.
    assert.equal((await cleanupRows(old.candidate)).length, 1);
  },
);

revisionTest(
  "a stop orders the running revision by the database clock, not the controller clock",
  async (fixture) => {
    // The controller clock that stamps each admission runs five minutes ahead of PostgreSQL's
    // for one Agent and behind for the other. The stop's creation time is on the database clock,
    // so the admission must be too. Ahead, the running revision would read as admitted after the
    // stop, which would finish STOP_SUPERSEDED and leave the runtime running (finding 1195).
    const stopped = [];
    await fixture.start({
      ...fixture.compute,
      async stopRevision(revision) {
        stopped.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
    });
    for (const [label, controllerSkewMs] of [
      ["ahead", 300_000],
      ["behind", -300_000],
    ]) {
      const owner = await fixture.agent(`stop-clock-${label}`);
      const candidate = await fixture.revision(owner, 1, { controllerSkewMs });
      const admitted = (
        await fixture.observerPool.query(
          `SELECT admitted_at, EXTRACT(EPOCH FROM clock_timestamp() - admitted_at) * 1000 AS age_ms
           FROM occ.agent_revisions WHERE id = $1`,
          [candidate.id],
        )
      ).rows[0];
      // The store stamped admission on its own clock and returned that stamp.
      const ageMs = Number(admitted.age_ms);
      assert.ok(ageMs >= 0 && ageMs < 60_000, `${label}: admitted ${ageMs} ms ago`);
      assert.equal(candidate.createdAt, admitted.admitted_at.toISOString(), label);
      await fixture.work(candidate, "succeeded");
      assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id, label);

      const stop = await fixture.requestStop(owner);
      await fixture.work(stop, "succeeded");
      const audit = await fixture.observerPool.query(
        `SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events
         WHERE namespace_id = $1 AND resource_id = $2 AND action = 'openclaw.agents.lifecycle.stop'`,
        [fixture.namespace.id, owner.id],
      );
      assert.deepEqual(audit.rows, [{ reason_code: "AGENT_STOPPED" }], label);
      assert.ok(stopped.includes(candidate.id), `${label}: the running revision was stopped`);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.desiredRuntimeState, "stopped", label);
      assert.equal(current.activeRevisionId, undefined, label);
    }
  },
);

revisionTest(
  "a transient failure at the convergence deadline still retires an OAuth bootstrap last seen running",
  async (fixture) => {
    // Three OAuth deployments see their bootstrap running, then the Kubernetes API fails on every
    // pass until the deadline. The pass that expires sees only the outage, so the work's latest
    // readiness evidence decides: a bootstrap last seen running is retired with the failure
    // (finding 1165), a deployment that got past it keeps its runtime for diagnosis, and a
    // revision published since (only its activation fails) is never retired.
    const running = await fixture.admitInitialRevision("expired-bootstrap-outage");
    const progressed = await fixture.admitInitialRevision("expired-runtime-outage");
    const published = await fixture.admitInitialRevision("expired-activation-outage");
    // Readiness each pass reports, in order; once exhausted, every pass fails transiently,
    // except that the published revision's later passes are ready and its activation fails.
    const script = new Map([
      [running.candidate.id, ["HARNESS_CREDENTIAL_BOOTSTRAP_PENDING"]],
      [progressed.candidate.id, ["HARNESS_CREDENTIAL_BOOTSTRAP_PENDING", undefined]],
      [published.candidate.id, ["HARNESS_CREDENTIAL_BOOTSTRAP_PENDING"]],
    ]);
    const passes = new Map(
      [running, progressed, published].map(({ candidate }) => [candidate.idempotencyKey, []]),
    );
    const outage = () =>
      new TransientDependencyError(
        "kubernetes_api",
        "unavailable",
        "The Kubernetes API answered HTTP 503.",
      );
    // The scripted passes must all run before the deadline, so it is real time from admission.
    // 30 s leaves a stalled runner room for them; the outage then fills the rest (finding 1171).
    const timeoutMs = 30_000;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          const steps = script.get(revision.id);
          if (steps === undefined) {
            return fixture.compute.prepareRevision(revision);
          }
          if (steps.length === 0) {
            if (revision.id === published.candidate.id) {
              return fixture.compute.prepareRevision(revision);
            }
            throw outage();
          }
          const pendingReason = steps.shift();
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            ...(pendingReason === undefined ? {} : { pendingReason }),
          };
        },
        async activateRevision(revision, revisionContext) {
          if (revision.id === published.candidate.id) {
            throw outage();
          }
          return fixture.compute.activateRevision?.(revision, revisionContext);
        },
      },
      {
        convergenceTimeoutMs: timeoutMs,
        emit: (event) => {
          if (event.event === "worker.completed" && passes.has(event.workId)) {
            passes.get(event.workId).push({ outcome: event.outcome, code: event.code });
          }
        },
      },
    );
    const cleanupRows = async (candidate) =>
      (
        await fixture.observerPool.query(
          "SELECT state FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE '%:repository_cleanup:retire:%'",
          [candidate.id],
        )
      ).rows;

    for (const { candidate } of [running, progressed, published]) {
      await fixture.work(candidate, "failed_permanent", timeoutMs + 60_000);
      // The pass that ended it ran at the deadline, by the database clock, not before it.
      const { rows } = await fixture.observerPool.query(
        `SELECT EXTRACT(EPOCH FROM completed_at - created_at) * 1000 AS age_ms
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [candidate.idempotencyKey],
      );
      assert.ok(Number(rows[0].age_ms) >= timeoutMs, `failed at ${rows[0].age_ms} ms`);
    }
    // The scripted readiness came before the deadline (a starved runner fails here), and the
    // outage, not the deadline, ends each deployment.
    for (const [{ candidate }, readiness] of [
      [running, ["HARNESS_CREDENTIAL_BOOTSTRAP_PENDING"]],
      [progressed, ["HARNESS_CREDENTIAL_BOOTSTRAP_PENDING", "REVISION_INCOMPLETE"]],
      [published, ["HARNESS_CREDENTIAL_BOOTSTRAP_PENDING"]],
    ]) {
      const seen = passes.get(candidate.idempotencyKey);
      assert.deepEqual(
        seen.slice(0, readiness.length),
        readiness.map((code) => ({ outcome: "pending", code })),
        `scripted passes of ${candidate.id} ran before the deadline`,
      );
      assert.ok(seen.length > readiness.length + 1, "the outage spans several passes");
      assert.deepEqual(seen.at(-1), {
        outcome: "permanent",
        code: "KUBERNETES_API_UNAVAILABLE",
      });
    }
    const failedStatus = await fixture.deploymentStatus(running.owner, running.candidate);
    assert.equal(failedStatus.status, "failed");
    assert.equal(failedStatus.error?.code, "KUBERNETES_API_UNAVAILABLE");
    // The bootstrap last seen running goes with the failure: its Job and seed Secret (the OAuth
    // token bundle) cannot outlive the failed revision.
    assert.equal((await cleanupRows(running.candidate)).length, 1);
    assert.notEqual(failedStatus.cleanup, null);
    await waitFor("the expired bootstrap's revision cleanup", async () => {
      const [row] = await cleanupRows(running.candidate);
      return row?.state === "succeeded" ? row : undefined;
    });
    // A deployment whose bootstrap finished keeps its runtime, as at a plain deadline.
    assert.deepEqual(await cleanupRows(progressed.candidate), []);
    const keptStatus = await fixture.deploymentStatus(progressed.owner, progressed.candidate);
    assert.equal(keptStatus.error?.code, "KUBERNETES_API_UNAVAILABLE");
    assert.equal(keptStatus.cleanup, null);
    // A published revision recorded no readiness code after its bootstrap, yet stays published
    // and running.
    assert.deepEqual(await cleanupRows(published.candidate), []);
    assert.equal(
      (await fixture.activePointer(published.owner)).rows[0].active_revision_id,
      published.candidate.id,
    );
  },
);

// The default 900-second deadline stays in force: an unready runtime without
// failure evidence remains pending, and the held rejection ends the deployment.
for (const scenario of [
  {
    name: "rejected runtime credentials fail deployment before the convergence deadline",
    label: "rejected-runtime",
    pendingPasses: 1,
    runtimeFailure: {
      component: "agent",
      check: "model-probe",
      checkedAt: "2026-09-29T08:00:00.000Z",
      code: "AUTHENTICATION_FAILED",
    },
    expected: {
      preparations: 2,
      activeRevisionId: null,
      error: {
        code: "RUNTIME_AUTHENTICATION_FAILED",
        message:
          "The model provider rejected this version's credential (HTTP 401 or 403). Check that the key or token is valid and can use the selected model, update or replace the Agent's model credential, then deploy a new version.",
      },
    },
  },
  {
    name: "a CPU-starved startup model probe fails deployment before the convergence deadline",
    label: "cpu-starved-runtime",
    pendingPasses: 1,
    runtimeFailure: {
      component: "gateway",
      check: "model-probe",
      checkedAt: "2026-09-30T08:00:00.000Z",
      code: "MODEL_PROBE_CPU_STARVED",
    },
    expected: {
      preparations: 2,
      activeRevisionId: null,
      error: {
        code: "RUNTIME_CPU_STARVED",
        message:
          "Deployment runtime did not get enough CPU to finish its startup model check, because of a CPU limit below one core or a busy node. Ask an admin to raise the limit or free node capacity, then deploy a new version.",
      },
    },
  },
  {
    // Finding 1677: the kubelet restarts the init container, but a refusal repeats.
    name: "a refused workspace setup fails deployment before the convergence deadline",
    label: "refused-workspace-setup",
    pendingPasses: 1,
    runtimeFailure: {
      component: "agent",
      check: "workspace-setup",
      checkedAt: "2026-10-17T08:00:00.000Z",
      code: "WORKSPACE_SETUP_REFUSED",
    },
    expected: {
      preparations: 2,
      activeRevisionId: null,
      error: {
        code: "WORKSPACE_SETUP_REFUSED",
        message:
          "Initial workspace setup refused this version's workspace, and every retry would refuse it again: the workspace files or setup record, or the runtime's default files, do not match what the Agent was created with. Ask an admin to check the Agent's workspace storage and runtime image; do not delete the setup record to force a replay.",
      },
    },
  },
]) {
  revisionTest(scenario.name, async (fixture) => {
    const [{ candidate }] = await runRuntimeFailureCases(fixture, [scenario]);
    if (scenario.label === "rejected-runtime") {
      const evidence = await fixture.observerPool.query(
        `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
         WHERE resource_id = $1 AND details->>'reasonCode' IN
           ('REVISION_INCOMPLETE', 'RUNTIME_AUTHENTICATION_FAILED')
         ORDER BY occurred_at`,
        [candidate.id],
      );
      assert.deepEqual(
        evidence.rows.map(({ reason }) => reason),
        ["REVISION_INCOMPLETE", "RUNTIME_AUTHENTICATION_FAILED"],
      );
    }
  });
}

revisionTest(
  "held runtime probe and login failures fail deployment before the convergence deadline",
  async (fixture) => {
    // Runtime entrypoints publish these codes only after their own retries end
    // and then hold the container unready with nothing to restart it, so the
    // default 900-second deadline could only report the same failure later.
    const probeStatusFailure = {
      component: "gateway",
      check: "model-probe",
      checkedAt: "2026-10-01T08:00:00.000Z",
      code: "MODEL_PROBE_FAILED",
      cause: { kind: "PROBE_STATUS", detail: "format" },
    };
    const wrapperFailure = {
      ...probeStatusFailure,
      component: "agent",
      cause: { kind: "WRAPPER_ERROR" },
    };
    // Only failed model probes retain evidence in both persisted and public errors.
    const expectedProbeFailure = (runtimeFailure) => ({
      resultData: { runtimeFailure },
      error: {
        code: "RUNTIME_MODEL_PROBE_FAILED",
        message:
          "The startup model check failed for a reason other than a rejected credential, such as an unknown model, invalid provider settings, a provider or TLS error, a rate limit or quota, or, with Codex, a provider the runtime cannot reach. Check the model and its provider settings (such as baseUrl and api) in the Configuration, the provider account, and that the runtime can reach the provider, then deploy a new version.",
        data: { runtimeFailure },
      },
    });
    const cases = [
      {
        label: "held-runtime-0",
        runtimeFailure: {
          component: "agent",
          check: "model-probe",
          checkedAt: "2026-10-01T08:00:00.000Z",
          code: "MODEL_PROBE_TIMEOUT",
        },
        expected: {
          error: {
            code: "RUNTIME_MODEL_PROBE_TIMEOUT",
            message:
              "The startup model check did not get a reply from the model provider in time. With OpenClaw this includes a provider the runtime cannot reach (refused connection or unknown host). Check that the runtime can reach the provider (network egress, proxy, or a custom baseUrl in the Configuration) and that the provider is responding, then deploy a new version.",
          },
        },
      },
      {
        label: "held-runtime-1",
        runtimeFailure: probeStatusFailure,
        expected: expectedProbeFailure(probeStatusFailure),
      },
      {
        label: "held-runtime-2",
        runtimeFailure: wrapperFailure,
        expected: expectedProbeFailure(wrapperFailure),
      },
      {
        label: "held-runtime-3",
        runtimeFailure: {
          component: "agent",
          check: "login",
          checkedAt: "2026-10-01T08:00:00.000Z",
          code: "LOGIN_FAILED",
        },
        expected: {
          error: {
            code: "RUNTIME_LOGIN_FAILED",
            message:
              "Deployment runtime could not sign in to the model provider. Check the Agent's model credential (for an OAuth login, sign in again) and that the runtime can reach the provider, then deploy a new version.",
          },
        },
      },
      {
        label: "held-runtime-4",
        runtimeFailure: {
          component: "gateway",
          check: "plugin-approvers",
          checkedAt: "2026-10-01T08:00:00.000Z",
          code: "INCOMPATIBLE_RESPONSE",
        },
        expected: {
          error: {
            code: "RUNTIME_STARTUP_FAILED",
            message:
              "Deployment runtime failed a startup check. Check this version's logs for the failed check and correct its cause, then deploy a new version.",
          },
        },
      },
    ];
    const scenarios = await runRuntimeFailureCases(fixture, cases, 10_000);

    // The database admits only the classified shape: no extra fields, no
    // unknown kind, no free text in the detail, and no cause on another code.
    const [{ candidate: probeFailed, runtimeFailure: evidence }] = scenarios.slice(1, 2);
    for (const invalid of [
      {},
      { runtimeFailure: { ...evidence, cause: { kind: "PROBE_STATUS", detail: "HTTP 404 body" } } },
      { runtimeFailure: { ...evidence, cause: { kind: "PROVIDER_TEXT", detail: "format" } } },
      { runtimeFailure: { ...evidence, cause: { detail: "format" } } },
      { runtimeFailure: { ...evidence, cause: { kind: "PROBE_STATUS", message: "raw" } } },
      { runtimeFailure: { ...evidence, error: "raw provider response" } },
      { runtimeFailure: { ...evidence, code: "AUTHENTICATION_FAILED" } },
      { runtimeFailure: evidence, timeoutMs: 1 },
    ]) {
      await assert.rejects(
        fixture.observerPool.query(
          "UPDATE occ.controller_work SET result_data = $2::jsonb WHERE idempotency_key = $1",
          [probeFailed.idempotencyKey, JSON.stringify(invalid)],
        ),
        (error) =>
          error.code === "23514" && error.constraint === "controller_work_result_data_state",
        JSON.stringify(invalid),
      );
    }
  },
);

revisionTest(
  "a replacement that fails after pointer publication stays the Agent's active revision",
  async (fixture) => {
    // Kubernetes embedded replacement reports a new revision ready while its
    // predecessor serves, publishes it, and only then replaces the shared
    // gateway. When the replacement's startup model probe then rejects the
    // credential, the predecessor no longer runs: the failed revision owns the
    // only runtime, so it stays active for stop, deletion, and diagnostics
    // until a later revision replaces it. OCC never rolls back automatically.
    const { owner, candidate: healthy } = await fixture.admitInitialRevision(
      "failed-published-replacement",
    );
    let rejectCredential = false;
    const activations = [];
    const retired = [];
    const compute = {
      ...fixture.compute,
      async prepareRevision(revision) {
        const observation = await fixture.compute.prepareRevision(revision);
        // The first observation of a replacement reflects the serving predecessor.
        if (!rejectCredential || !activations.includes(revision.id)) {
          return observation;
        }
        return {
          ...observation,
          ready: false,
          runtimeFailure: {
            component: "gateway",
            check: "model-probe",
            checkedAt: "2026-09-30T17:14:54.000Z",
            code: "AUTHENTICATION_FAILED",
          },
        };
      },
      async activateRevision(revision) {
        activations.push(revision.id);
        if (rejectCredential) {
          throw new Error("The exact AgentRevision gateway is not ready.");
        }
      },
      async retireRevision(revision) {
        retired.push(revision.id);
        return fixture.compute.retireRevision(revision);
      },
    };
    await fixture.start(compute);
    await fixture.work(healthy, "succeeded");
    const activeRevision = async () =>
      (await fixture.activePointer(owner)).rows[0].active_revision_id;
    assert.equal(await activeRevision(), healthy.id);

    rejectCredential = true;
    const rejected = await fixture.revision(owner, 2);
    await fixture.work(rejected, "failed_permanent");
    const codes = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' ORDER BY occurred_at`,
      [rejected.id],
    );
    assert.deepEqual(
      [...new Set(codes.rows.map(({ reason }) => reason))],
      ["REVISION_FINALIZATION_INCOMPLETE", "RUNTIME_AUTHENTICATION_FAILED"],
    );
    const status = await fixture.deploymentStatus(owner, rejected);
    assert.equal(status.status, "failed");
    assert.equal(status.error.code, "RUNTIME_AUTHENTICATION_FAILED");
    assert.equal(await activeRevision(), rejected.id);
    assert.deepEqual(retired, []);

    // Recovery is a new, higher revision; it replaces the failed one.
    rejectCredential = false;
    const repaired = await fixture.revision(owner, 3);
    await fixture.work(repaired, "succeeded");
    assert.equal(await activeRevision(), repaired.id);
    assert.deepEqual(retired.toSorted(), [healthy.id, rejected.id].toSorted());
  },
);

revisionTest(
  "a Sandbox Driver that cannot run the revision fails deployment without retrying",
  async (fixture) => {
    // The OpenShell SandboxDriver cannot project secretKeyRef environment. The
    // same revision fails the same way on every attempt, so it is terminal.
    const preparations = await runPreparationFailureCase(fixture, {
      label: "sandbox-unsupported",
      failure: () =>
        new SandboxRevisionUnsupportedError(
          "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
          "OpenShell v0.1.5 cannot receive secretKeyRef environment APP_SERVER_TOKEN.",
        ),
      expected: {
        error: {
          code: "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
          message:
            "The Sandbox Driver cannot deliver Secret-backed environment variables to the Harness.",
        },
      },
    });
    assert.equal(preparations, 1);
  },
);

revisionTest(
  "credential sources that share an environment variable fail deployment without retrying",
  async (fixture) => {
    // Two bound sources would place their placeholders in one Sandbox variable. The revision's
    // source list and each source's config are fixed, so every attempt fails the same way.
    const preparations = await runPreparationFailureCase(fixture, {
      label: "credential-env-conflict",
      failure: () =>
        new CredentialSourceRevisionError(
          "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT",
          "Two credential sources bound to the revision use the same environment variable.",
        ),
      expected: {
        error: {
          code: "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT",
          message:
            "Two credential sources the Agent binds use the same environment variable. Bind only one source per variable, for example one openai source and bearer-token sources with distinct env_var values, then deploy again.",
        },
      },
    });
    assert.equal(preparations, 1);
  },
);

revisionTest(
  "a revision whose Credential Gateway is no longer selected fails with a fixed status message",
  async (fixture) => {
    // The Installation dropped the Credential Gateway after admission, so dispatch fails the
    // revision at once. The status names the cause and the fix, without IDs, instead of the
    // generic "Deployment reconciliation failed." (D549).
    const { owner, candidate } = await fixture.admitInitialRevision("credential-gateway-removed", {
      agent: { auth: "credential_source" },
    });
    const prepared = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, revisionContext) {
        prepared.push(revision.id);
        return fixture.compute.prepareRevision(revision, revisionContext);
      },
    });
    await fixture.work(candidate, "failed_permanent");
    await fixture.stop();
    assert.deepEqual(prepared, []);
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "CREDENTIAL_GATEWAY_MISMATCH",
      message:
        "The Installation no longer selects the Credential Gateway this revision was admitted with. Bind sources registered through the selected gateway, or remove them and change harnessAuth, then deploy again.",
    });
  },
);

revisionTest(
  "a Gateway route that lags its Ready Pod is retried within the deadline, not the attempt budget",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("gateway-route-lag");
    const events = [];
    const progress = [];
    let failures = 0;

    // D28: the worker reaches a new Gateway through its private route as soon as
    // the Pod is Ready. Until Envoy programs the new HTTPRoute the upgrade answers
    // 404, for longer than five quick retries last. Fail more passes than the
    // attempt budget allows, then let the route converge.
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (failures < 8) {
            failures += 1;
            if (failures === 3) {
              const status = await fixture.deploymentStatus(owner, candidate);
              progress.push(status.progress?.lastAttempt);
            }
            throw new TransientDependencyError(
              "agent_gateway",
              "unavailable",
              "The Agent Gateway route answered HTTP 404 to the connection upgrade.",
            );
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
      },
      { emit: (event) => events.push(event) },
    );

    const succeeded = await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(failures, 8);
    assert.equal(succeeded.attempt_count, 1);
    assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "succeeded");
    assert.equal(progress.length, 1);
    assert.equal(progress[0]?.code, "AGENT_GATEWAY_UNAVAILABLE");
    assert.equal(
      progress[0]?.message,
      "The Agent Gateway was not reachable through its route yet. The controller will retry until the deployment deadline.",
    );
    const passes = events.filter(
      (event) => event.event === "worker.completed" && event.revisionId === candidate.id,
    );
    assert.deepEqual(
      passes.slice(0, 8).map(({ outcome, code, dependency, cause }) => ({
        outcome,
        code,
        dependency,
        cause,
      })),
      Array.from({ length: 8 }, () => ({
        outcome: "pending",
        code: "AGENT_GATEWAY_UNAVAILABLE",
        dependency: "agent_gateway",
        cause: "unavailable",
      })),
    );
  },
);

revisionTest(
  "a Sandbox gateway outage longer than the attempt budget waits, then the deployment activates",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("sandbox-gateway-outage");
    const events = [];
    // Finding 2040 (D28, finding 1658): while the OpenShell gateway is scaled down or restarting,
    // every request of the pass answers gRPC UNAVAILABLE, which the gateway client raises as a
    // SandboxGatewayUnavailableError. The outage holds until the test has seen more passes than
    // the attempt budget (5), whatever their backoff, and only then does the gateway come back.
    let held = true;
    let passes = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (held) {
            passes += 1;
            throw new SandboxGatewayUnavailableError(
              "OpenShell CreateSandbox failed with gRPC status 14.",
            );
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
      },
      { emit: (event) => events.push(event) },
    );

    const waited = await waitFor(
      "more passes against the stopped gateway than the attempt budget",
      async () => {
        const work = await fixture.observerPool.query(
          "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        assert.notEqual(work.rows[0]?.state, "failed_permanent", "the outage spent the budget");
        return passes > 7 && work.rows[0]?.state === "queued" ? work.rows[0] : undefined;
      },
      30_000,
    );
    assert.equal(waited.attempt_count, 0);
    // A pass's live lease reads as `running`; read the status between passes.
    const during = await waitFor("the deployment status between outage passes", async () => {
      const status = await fixture.deploymentStatus(owner, candidate);
      return status.status === "queued" ? status : undefined;
    });
    held = false;
    assert.deepEqual(
      {
        code: during.progress?.lastAttempt?.code,
        message: during.progress?.lastAttempt?.message,
      },
      {
        code: "SANDBOX_GATEWAY_UNAVAILABLE",
        message:
          "The Sandbox gateway did not answer the controller yet. The controller will retry until the deployment deadline.",
      },
    );

    const succeeded = await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(succeeded.attempt_count, 1);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
    const outagePasses = events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === candidate.id &&
        event.outcome !== "success",
    );
    assert.ok(outagePasses.length > 7, `saw ${outagePasses.length} outage passes`);
    assert.deepEqual(
      new Set(
        outagePasses.map(({ outcome, code, dependency, cause }) =>
          JSON.stringify({ outcome, code, dependency, cause }),
        ),
      ),
      new Set([
        JSON.stringify({
          outcome: "pending",
          code: "SANDBOX_GATEWAY_UNAVAILABLE",
          dependency: "sandbox_gateway",
          cause: "unavailable",
        }),
      ]),
    );
  },
);

revisionTest(
  "an activation wait or a lagging Gateway route keeps its own code, not REVISION_FINALIZATION_INCOMPLETE",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("activation-wait-codes");
    const events = [];
    const progress = [];
    const readProgress = async () =>
      (await fixture.deploymentStatus(owner, candidate)).progress?.lastAttempt;
    let activations = 0;

    // D330: dedicated activation runs after the pointer is published. It waits
    // for the Gateway to apply its workspace node, for the Harness node to
    // connect, and reaches the Gateway through its route, which can answer 404
    // while Envoy converges. Each pass must name what it waits on.
    await fixture.start(
      {
        ...fixture.compute,
        async activateRevision(revision, revisionContext) {
          activations += 1;
          if (activations > 1) {
            progress.push(await readProgress());
          }
          if (activations <= 2) {
            throw new ActivationPendingError(
              "WORKSPACE_NODE_BINDING_PENDING",
              "The exact AgentRevision gateway has not applied its workspace node.",
            );
          }
          if (activations === 3) {
            throw new ActivationPendingError(
              "WORKSPACE_NODE_PENDING",
              "The exact AgentRevision Harness node is not ready.",
            );
          }
          if (activations === 4) {
            throw new TransientDependencyError(
              "agent_gateway",
              "unavailable",
              "The Agent Gateway route answered HTTP 404 to the connection upgrade.",
            );
          }
          if (activations === 5) {
            throw new RangeError("unexpected activation failure");
          }
          return fixture.compute.activateRevision?.(revision, revisionContext);
        },
      },
      { emit: (event) => events.push(event) },
    );

    await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(activations, 6);
    assert.deepEqual(
      progress.map((attempt) => [attempt?.code, attempt?.message]),
      [
        [
          "WORKSPACE_NODE_BINDING_PENDING",
          "Workloads are ready; waiting for the Gateway to apply the workspace node.",
        ],
        [
          "WORKSPACE_NODE_BINDING_PENDING",
          "Workloads are ready; waiting for the Gateway to apply the workspace node.",
        ],
        [
          "WORKSPACE_NODE_PENDING",
          "Workloads are ready; waiting for the workspace node to connect to the Gateway.",
        ],
        [
          "AGENT_GATEWAY_UNAVAILABLE",
          "The Agent Gateway was not reachable through its route yet. The controller will retry until the deployment deadline.",
        ],
        [
          "RECONCILIATION_PENDING",
          "Deployment has not completed. Another reconciliation is pending.",
        ],
      ],
    );
    const passes = events
      .filter(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === candidate.id &&
          event.outcome === "pending",
      )
      .slice(-5)
      .map(({ code, dependency, cause }) => ({ code, dependency, cause }));
    assert.deepEqual(passes, [
      {
        code: "WORKSPACE_NODE_BINDING_PENDING",
        dependency: undefined,
        cause: "ActivationPendingError",
      },
      {
        code: "WORKSPACE_NODE_BINDING_PENDING",
        dependency: undefined,
        cause: "ActivationPendingError",
      },
      { code: "WORKSPACE_NODE_PENDING", dependency: undefined, cause: "ActivationPendingError" },
      { code: "AGENT_GATEWAY_UNAVAILABLE", dependency: "agent_gateway", cause: "unavailable" },
      { code: "REVISION_FINALIZATION_INCOMPLETE", dependency: undefined, cause: "RangeError" },
    ]);
    const succeeded = await fixture.work(candidate, "succeeded");
    assert.equal(succeeded.attempt_count, 1);
  },
);

revisionTest(
  "an activation pass that a failed private Secret write ends logs the API status and reason",
  async (fixture) => {
    const { candidate } = await fixture.admitInitialRevision("activation-private-write-status");
    const events = [];
    let activations = 0;
    const { ApiException } = createRequire(
      new URL("../../apps/controller/package.json", import.meta.url),
    )("@kubernetes/client-node");

    // The Kubernetes Driver writes a revision's private Secrets on activation too. When the
    // API server refuses such a write, it raises its own DependencyUnavailableError rather
    // than the client error, whose message and body echo the Secret, and keeps only the HTTP
    // status and Status reason as the cause. tests/conformance/kubernetes-compute.test.mjs
    // pins that Driver shape; this case proves the worker's side: its log must carry that
    // status and reason, not only the class. A 429 or 5xx answer is transient instead and
    // keeps the same evidence as its cause. Any other 4xx client error, which the Driver
    // passes on unchanged, carries the status in its own code.
    const refused = new DependencyUnavailableError(
      "Workspace setup private delivery is unavailable.",
    );
    refused.cause = Object.assign(new Error("The Kubernetes API answered HTTP 403 (Forbidden)."), {
      code: 403,
      reason: "Forbidden",
    });
    const unavailable = new TransientDependencyError(
      "kubernetes_api",
      "unavailable",
      "The Kubernetes API answered HTTP 503.",
      {
        cause: Object.assign(
          new Error("The Kubernetes API answered HTTP 503 (ServiceUnavailable)."),
          { code: 503, reason: "ServiceUnavailable" },
        ),
      },
    );
    await fixture.start(
      {
        ...fixture.compute,
        async activateRevision(revision, revisionContext) {
          activations += 1;
          if (activations === 1) {
            throw refused;
          }
          if (activations === 2) {
            throw unavailable;
          }
          if (activations === 3) {
            throw new ApiException(409, "conflict", "{}", {});
          }
          return fixture.compute.activateRevision?.(revision, revisionContext);
        },
      },
      { emit: (event) => events.push(event) },
    );

    await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(activations, 4);
    const pending = events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === candidate.id &&
        event.outcome === "pending",
    );
    assert.deepEqual(
      pending.map(({ code, dependency, cause, status, reason }) => ({
        code,
        dependency,
        cause,
        status,
        reason,
      })),
      [
        {
          code: "REVISION_FINALIZATION_INCOMPLETE",
          dependency: undefined,
          cause: "DependencyUnavailableError",
          status: 403,
          reason: "Forbidden",
        },
        {
          code: "KUBERNETES_API_UNAVAILABLE",
          dependency: "kubernetes_api",
          cause: "unavailable",
          status: 503,
          reason: "ServiceUnavailable",
        },
        {
          code: "REVISION_FINALIZATION_INCOMPLETE",
          dependency: undefined,
          cause: "ApiException",
          status: 409,
          reason: undefined,
        },
      ],
    );
  },
);

revisionTest(
  "an activation failure logs only an HTTP status and a one-word Status reason",
  async (fixture) => {
    const { candidate } = await fixture.admitInitialRevision("activation-status-filter");
    const events = [];
    let activations = 0;
    // The worker filters what any Driver hands it, not only the Kubernetes Driver's shapes.
    // An HTTP status text is free text, so a reason with a space is dropped while the
    // status stays. A gRPC client error carries its own numeric status code (14 is
    // UNAVAILABLE), which is not an HTTP status and must not be logged as one.
    const statusText = new TransientDependencyError(
      "kubernetes_api",
      "unavailable",
      "The Kubernetes API answered HTTP 503.",
      {
        cause: Object.assign(new Error("HTTP 503 Service Unavailable"), {
          code: 503,
          reason: "Service Unavailable",
        }),
      },
    );
    const grpc = Object.assign(new Error("14 UNAVAILABLE: connection refused"), { code: 14 });
    await fixture.start(
      {
        ...fixture.compute,
        async activateRevision(revision, revisionContext) {
          activations += 1;
          if (activations === 1) {
            throw statusText;
          }
          if (activations === 2) {
            throw grpc;
          }
          return fixture.compute.activateRevision?.(revision, revisionContext);
        },
      },
      { emit: (event) => events.push(event) },
    );

    await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(activations, 3);
    const pending = events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === candidate.id &&
        event.outcome === "pending",
    );
    assert.deepEqual(
      pending.map(({ code, dependency, cause, status, reason }) => ({
        code,
        dependency,
        cause,
        status,
        reason,
      })),
      [
        {
          code: "KUBERNETES_API_UNAVAILABLE",
          dependency: "kubernetes_api",
          cause: "unavailable",
          status: 503,
          reason: undefined,
        },
        {
          code: "REVISION_FINALIZATION_INCOMPLETE",
          dependency: undefined,
          cause: "Error",
          status: undefined,
          reason: undefined,
        },
      ],
    );
  },
);

// D381 follow-up: a dedicated Gateway that refuses its own in-Pod CLI as unauthorized
// can never apply its workspace node for this revision, so activation must fail the
// deployment with a named code instead of staying pending until the convergence
// deadline. Both activation paths are covered: the pass that publishes the active
// pointer, and a later pass that finds the pointer already published.
for (const pendingPasses of [0, 1]) {
  revisionTest(
    `an activation the Gateway refuses as unauthorized fails deployment at once (after ${pendingPasses} pending passes)`,
    async (fixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision(
        `gateway-unauthorized-${pendingPasses}`,
      );
      const events = [];
      let activations = 0;
      const stopped = [];

      await fixture.start(
        {
          ...fixture.compute,
          // Exclusive Compute stops a refused candidate, but never the published revision.
          requiresStoppedPredecessors: () => true,
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
          async activateRevision() {
            activations += 1;
            if (activations <= pendingPasses) {
              throw new ActivationPendingError(
                "WORKSPACE_NODE_BINDING_PENDING",
                "The exact AgentRevision gateway has not applied its workspace node.",
              );
            }
            throw new ActivationFailedError(
              "AGENT_GATEWAY_UNAUTHORIZED",
              "The exact AgentRevision gateway refused its own CLI as unauthorized.",
            );
          },
        },
        { emit: (event) => events.push(event) },
      );

      await assertFailedDeployment(
        fixture,
        { owner, candidate },
        {
          error: {
            code: "AGENT_GATEWAY_UNAUTHORIZED",
            message:
              "The Agent Gateway refused its own CLI as unauthorized. Check that the Agent's Configuration sets gateway.auth.password to OPENCLAW_GATEWAY_PASSWORD (Enable gateway password access), then deploy again.",
          },
        },
        30_000,
      );
      // No retry after the refusal: the first refused pass ends the deployment.
      assert.equal(activations, pendingPasses + 1);
      assert.deepEqual(stopped, [], "the published revision keeps its workload");
      await completion(
        events,
        "the refused activation's terminal completion",
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === candidate.id &&
          event.outcome === "permanent",
      );
      const last = events
        .filter((event) => event.event === "worker.completed" && event.revisionId === candidate.id)
        .at(-1);
      assert.deepEqual(
        { outcome: last?.outcome, code: last?.code, cause: last?.cause },
        {
          outcome: "permanent",
          code: "AGENT_GATEWAY_UNAUTHORIZED",
          cause: "ActivationFailedError",
        },
      );
    },
  );
}

// The admission-limit case uses the real OpenShellAdmissionLimitError class, thrown from a
// stubbed Compute prepareRevision; the gateway wire test proves the client raises it. The
// limit frees up as completed admissions age out, so it must wait like any other dependency
// instead of spending the attempt budget.
for (const { label, failure, code, message } of [
  {
    label: "Kubernetes API",
    failure: () =>
      new TransientDependencyError(
        "kubernetes_api",
        "timeout",
        "A Kubernetes API request timed out.",
      ),
    code: "KUBERNETES_API_UNAVAILABLE",
    message: "The Kubernetes API was still unavailable at the deployment deadline.",
  },
  {
    label: "OpenShell admission limit",
    failure: () =>
      new OpenShellAdmissionLimitError("CreateSandbox", {
        code: 8,
        details:
          "caller has reached the durable mutation admission limit; unresolved requests require reconciliation",
      }),
    code: "SANDBOX_ADMISSION_LIMIT_REACHED",
    message:
      "The Sandbox gateway still refused new requests from the controller (request admission limit reached) at the deployment deadline.",
  },
  {
    // Finding 2040: a gateway that never comes back is bounded by the deadline too.
    label: "Sandbox gateway",
    failure: () =>
      new SandboxGatewayUnavailableError("OpenShell CreateSandbox failed with gRPC status 14."),
    code: "SANDBOX_GATEWAY_UNAVAILABLE",
    message: "The Sandbox gateway still did not answer the controller at the deployment deadline.",
  },
]) {
  test(
    `a dependency still failing at the convergence deadline fails deployment with its own code (${label})`,
    requiresPostgres,
    async (context) => {
      // The 2.5 s deadline fits only four to six passes on a loaded runner, too close
      // to the default budget of five; with one attempt, more passes than the budget
      // means two.
      const fixture = await setup(context, { maxAttempts: 1 });
      const observations = await runPreparationFailureCase(
        fixture,
        {
          label: "dependency-down",
          failure,
          convergenceTimeoutMs: 2_500,
          expected: { error: { code, message } },
        },
        30_000,
      );
      assert.ok(
        observations > 1,
        `expected more passes than the attempt budget, saw ${observations}`,
      );
    },
  );
}

revisionTest(
  "plugin startup warnings complete deployment and remain visible in status",
  async (fixture) => {
    const pluginId = "codex-plugin:linear@openai-curated-remote";
    const otherPluginId = "codex-plugin:calendar@openai-curated-remote";
    const warnings = [
      { code: "PLUGIN_AUTH_REQUIRED", pluginId },
      { code: "PLUGIN_INSTALL_FAILED", pluginId: otherPluginId },
    ];
    const pluginState = codexPluginRevisionState(pluginId);
    pluginState.plugins[otherPluginId] = {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
    };
    const { owner, candidate } = await fixture.admitInitialRevision("plugin-warning", {
      agent: { executionMode: "dedicated" },
      revision: { plugins: pluginState },
    });
    const prepared = [];

    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        prepared.push(revision.id);
        if (revision.id !== candidate.id) {
          return fixture.compute.prepareRevision(revision);
        }
        return {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          ready: true,
          warnings,
        };
      },
    });

    await fixture.work(candidate, "succeeded");
    const terminal = await fixture.observerPool.query(
      `SELECT state, reason_code, result_data
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    assert.deepEqual(terminal.rows, [
      {
        state: "succeeded",
        reason_code: "REVISION_ACTIVATED",
        result_data: { warnings },
      },
    ]);
    const active = await fixture.currentAgent(owner);
    assert.equal(active.activeRevisionId, candidate.id);
    assert.deepEqual(prepared, [candidate.id]);
    // The public status projection reads the persisted result through OCC;
    // individual plugin failures must not turn a successful deployment into an error.
    assert.deepEqual(await fixture.deploymentStatus(owner, candidate), {
      deploymentId: candidate.id,
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      status: "succeeded",
      error: null,
      warnings,
      progress: null,
      cleanup: null,
    });
  },
);

revisionTest(
  "plugin warnings after active-pointer publication still activate the ready revision",
  async (fixture) => {
    const pluginId = "codex-plugin:github@openai-curated-remote";
    const { owner, candidate } = await fixture.admitInitialRevision("plugin-post-pointer-warning", {
      agent: { executionMode: "dedicated" },
      revision: { plugins: codexPluginRevisionState(pluginId) },
    });
    const published = await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(
        fixture.namespace.id,
        owner.id,
        undefined,
        candidate.id,
      ),
    );
    assert.equal(published.activeRevisionId, candidate.id);

    let prepareCount = 0;
    const activations = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        prepareCount += 1;
        return {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          ready: true,
          warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }],
        };
      },
      async activateRevision(revision) {
        activations.push(revision.id);
      },
    });

    await fixture.work(candidate, "succeeded");
    assert.equal(prepareCount, 1);
    assert.deepEqual(activations, [candidate.id]);
    const terminal = await fixture.observerPool.query(
      `SELECT state, reason_code, result_data
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    assert.deepEqual(terminal.rows, [
      {
        state: "succeeded",
        reason_code: "REVISION_ALREADY_ACTIVE",
        result_data: { warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }] },
      },
    ]);
  },
);

revisionTest(
  "foreign plugin warnings remain generic invalid Compute observations",
  async (fixture) => {
    const pluginId = "codex-plugin:slack@openai-curated-remote";
    const { owner, candidate } = await fixture.admitInitialRevision("foreign-plugin-diagnostic", {
      agent: { executionMode: "dedicated" },
      revision: { plugins: codexPluginRevisionState(pluginId) },
    });
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        return {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          ready: true,
          warnings: [
            {
              code: "PLUGIN_INSTALL_FAILED",
              pluginId: "codex-plugin:foreign@openai-curated-remote",
            },
          ],
        };
      },
    });

    await fixture.work(candidate, "failed_permanent");
    const generic = await fixture.observerPool.query(
      `SELECT state, reason_code, result_data
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    assert.deepEqual(generic.rows, [
      {
        state: "failed_permanent",
        reason_code: "INVALID_DRIVER_OBSERVATION",
        result_data: null,
      },
    ]);
    const inactive = await fixture.currentAgent(owner);
    assert.equal(inactive.activeRevisionId, undefined);
  },
);

test(
  "repository convergence exhaustion durably retires a returned incomplete runtime",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { owner, candidate } = await fixture.admitInitialRevision(
      "repository-convergence-retirement",
      { revision: { repositoryCredentials: repository.snapshot } },
    );
    let stops = 0;
    const close = repository.driver.close;
    repository.driver.close = async (sessionId, signal) => {
      if (stops === 0) {
        throw new Error("repository close temporarily unavailable");
      }
      return close(sessionId, signal);
    };
    await delay(5);
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          return {
            ...(await fixture.compute.prepareRevision(revision, deploymentContext)),
            ready: false,
          };
        },
        async stopRevision(revision) {
          assert.equal(revision.id, candidate.id);
          const source = await fixture.observerPool.query(
            "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
            [candidate.idempotencyKey],
          );
          assert.deepEqual(source.rows, [{ state: "failed_permanent", attempt_count: 1 }]);
          stops += 1;
          if (stops === 1) {
            // A credential-service outage must not delay the independent Compute stop.
            assert.equal((await repositoryAttempts(fixture, candidate))[0].phase, "closing");
            throw new Error("Compute termination still pending");
          }
          return fixture.compute.stopRevision(revision);
        },
      },
      { convergenceTimeoutMs: 1 },
    );
    await fixture.work(candidate, "failed_permanent");
    await waitFor("the incomplete runtime's durable retirement to finish", async () => {
      await advanceCleanupRetries(fixture, candidate);
      const cleanup = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      return cleanup.rowCount === 1 && cleanup.rows[0].state === "succeeded" ? true : undefined;
    });
    assert.equal(stops, 2);
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
    assert.deepEqual(
      (await repositoryAttempts(fixture, candidate)).map(({ phase }) => phase),
      ["disposed"],
    );
    const active = await fixture.currentAgent(owner);
    assert.equal(active.activeRevisionId, undefined);
    const evidence = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS code FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'`,
      [candidate.id],
    );
    assert.ok(evidence.rows.some(({ code }) => code === "CONVERGENCE_DEADLINE_EXCEEDED"));
  },
);

test(
  "a deploy denial during repository admission leaves a first deployment's runtime untouched",
  requiresPostgres,
  async (context) => {
    // On Compute that does not declare exclusive replacement, a refused candidate without an
    // active revision is stopped only if Compute may have prepared it. Here the actor loses
    // deploy while the first pass opens its repository session; the repository lifecycle's
    // authority recheck, as it records the opened session, refuses it before Compute is asked to
    // prepare, with no earlier evidence: nothing may stop it.
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { owner, candidate } = await fixture.admitInitialRevision("repository-denied", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const open = repository.driver.open;
    repository.driver.open = async (input, signal) => {
      const result = await open(input, signal);
      await fixture.observerPool.query(
        `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
        [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
      );
      return result;
    };
    const effects = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        effects.push("prepare");
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
      async stopRevision(revision) {
        // The failed work's repository cleanup retires the runtime afterwards. Only a stop while
        // the deployment work is unfinished would be the refused-candidate stop.
        const work = await fixture.observerPool.query(
          "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        effects.push(`stop:${work.rows[0].state}`);
        return fixture.compute.stopRevision(revision);
      },
    });
    await fixture.work(candidate, "failed_permanent");
    const failure = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS code FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'`,
      [candidate.id],
    );
    assert.deepEqual(failure.rows, [{ code: "AUTHORIZATION_DENIED" }]);
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
    await waitFor("the repository cleanup to retire the runtime", async () =>
      effects.includes("stop:failed_permanent") ? true : undefined,
    );
    assert.ok(
      effects.every((effect) => effect === "stop:failed_permanent"),
      effects.join(","),
    );
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, undefined);
  },
);

revisionTest(
  "one worker reconciles embedded OpenClaw and dedicated Codex but rejects unapproved pinned Harnesses",
  async (fixture) => {
    const embedded = await fixture.agent("embedded-openclaw");
    const dedicated = await fixture.agent("dedicated-codex", { executionMode: "dedicated" });
    const unsupported = await fixture.agent("unapproved-harness", { executionMode: "dedicated" });
    const mismatched = await fixture.agent("mismatched-placement");
    const embeddedRevision = await fixture.revision(embedded, 1);
    const dedicatedRevision = await fixture.revision(dedicated, 1);
    const unsupportedRevision = await fixture.revision(unsupported, 1, {
      harness: {
        id: "codex",
        version: "unapproved",
        mode: "dedicated",
      },
    });
    const mismatchedRevision = await fixture.revision(mismatched, 1, {
      harness: {
        ...fixture.productionHarness,
        mode: "embedded",
      },
    });

    await fixture.start(fixture.compute);
    await Promise.all([
      fixture.work(embeddedRevision, "succeeded"),
      fixture.work(dedicatedRevision, "succeeded"),
      fixture.work(unsupportedRevision, "failed_permanent"),
      fixture.work(mismatchedRevision, "failed_permanent"),
    ]);

    const active = await fixture.observerPool.query(
      "SELECT id, active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = ANY($2::text[])",
      [fixture.namespace.id, [embedded.id, dedicated.id, unsupported.id, mismatched.id]],
    );
    const activeByAgent = new Map(
      active.rows.map(({ id, active_revision_id }) => [id, active_revision_id]),
    );
    assert.equal(activeByAgent.get(embedded.id), embeddedRevision.id);
    assert.equal(activeByAgent.get(dedicated.id), dedicatedRevision.id);
    assert.equal(activeByAgent.get(unsupported.id), null);
    assert.equal(activeByAgent.get(mismatched.id), null);
    // The status names the way out, not the generic failure text (finding 828).
    assert.deepEqual((await fixture.deploymentStatus(unsupported, unsupportedRevision)).error, {
      code: "HARNESS_DESCRIPTOR_MISMATCH",
      message:
        "This revision's Harness or Harness version is no longer approved, for example after a controller upgrade. Deploy again to admit a revision with the approved version.",
    });
  },
);

test(
  "a lost retirement claim preserves the activated replacement and cannot complete stolen work",
  requiresPostgres,
  async (context) => {
    const releaseRetirement = Promise.withResolvers();
    // Release the held effect before fixture teardown joins the worker on failure.
    context.after(() => releaseRetirement.resolve());
    const fixture = await setup(context);
    const { owner, candidate: first } = await fixture.admitInitialRevision("stale-retirement");
    const effects = [];
    const events = [];
    let retirements = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(candidate) {
          effects.push({ action: "prepare", revisionId: candidate.id });
          return fixture.compute.prepareRevision(candidate);
        },
        async retireRevision(previous) {
          retirements += 1;
          effects.push({ action: "retire", revisionId: previous.id });
          if (retirements === 1) {
            await releaseRetirement.promise;
          }
          return fixture.compute.retireRevision(previous);
        },
      },
      { emit: (event) => events.push(event) },
    );
    await fixture.work(first, "succeeded");
    const skipped = {
      ...first,
      id: `rev_${randomUUID()}`,
      revision: 2,
      createdAt: new Date().toISOString(),
    };
    delete skipped.idempotencyKey;
    // A persisted but never-started intermediate revision must not hide the serving predecessor.
    await fixture.state.transact((unit) => unit.revisions.createRevision(skipped));
    const second = await fixture.revision(owner, 3);
    await waitFor("the real worker to block in predecessor retirement", async () =>
      retirements === 1 ? true : undefined,
    );
    // Publishing success is not attributable until route publication and teardown have finished.
    const prematureActivation = await fixture.observerPool.query(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [second.id],
    );
    assert.equal(prematureActivation.rowCount, 0);

    const original = await fixture.work(second, "claimed");
    assert.equal(original.attempt_count, 1);
    await fixture.expireClaim(second, original.claim_token);
    const recoveryQueue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const recovery = await recoveryQueue.recoverStale();
    assert.ok(recovery.recovered >= 1);
    const recovered = await recoveryQueue.claim();
    assert.ok(recovered, "the recovered revision must receive a fresh active claim");
    assert.equal(recovered.idempotencyKey, second.idempotencyKey);
    assert.notEqual(recovered.claimToken, original.claim_token);

    releaseRetirement.resolve();
    await waitFor("the expired worker to report claim loss", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    // Activation committed before teardown; a stolen claim cannot mark that teardown complete.
    const unchanged = await fixture.observerPool.query(
      `SELECT agent.active_revision_id, work.state, work.claim_token
       FROM occ.agents AS agent
       JOIN occ.controller_work AS work
         ON work.namespace_id = agent.namespace_id AND work.agent_id = agent.id
       WHERE agent.namespace_id = $1 AND agent.id = $2 AND work.idempotency_key = $3`,
      [fixture.namespace.id, owner.id, second.idempotencyKey],
    );
    assert.deepEqual(unchanged.rows, [
      {
        active_revision_id: second.id,
        state: "claimed",
        claim_token: recovered.claimToken,
      },
    ]);
    const staleCompletion = await fixture.observerPool.query(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1
         AND details->>'reasonCode' = 'RECONCILE_SUCCEEDED'`,
      [second.id],
    );
    assert.equal(staleCompletion.rowCount, 0);

    await recoveryQueue.retry(recovered, { code: "TEST_RECOVERY_HANDOFF" });
    await fixture.work(second, "succeeded");
    const converged = await fixture.activePointer(owner);
    assert.equal(converged.rows[0].active_revision_id, second.id);
    assert.equal(retirements, 3);
    assert.equal(
      effects.filter(({ action, revisionId }) => action === "retire" && revisionId === first.id)
        .length,
      2,
    );
    assert.equal(
      effects.filter(({ action, revisionId }) => action === "prepare" && revisionId === second.id)
        .length,
      2,
    );
    const activation = await fixture.observerPool.query(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [second.id],
    );
    assert.equal(activation.rowCount, 1);
  },
);

for (const secretAuthMethod of ["api_key", "codex_pat"]) {
  test(
    `${secretAuthMethod} revision dispatch rechecks Configuration and exact harness Secret grants without backend Secret reads`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { secretAuthMethod });
      const owners = await Promise.all(
        ["allowed", "configuration-denied", "actor-secret-denied", "agent-secret-ungranted"].map(
          (name, index) =>
            fixture.agent(name, {
              executionMode: secretAuthMethod === "codex_pat" ? "dedicated" : "embedded",
              grantHarnessSecret: index !== 3,
            }),
        ),
      );
      const candidates = await Promise.all(owners.map((owner) => fixture.revision(owner, 1)));
      // Revoke actor permissions after admission and independently exercise an
      // Agent lacking its own grant; actor authority never authorizes that Agent.
      await fixture.observerPool.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'configuration', $3, 'deny'),
              ($4, $2, 'operate', 'secret', $5, 'deny')`,
        [
          `restriction-${randomUUID()}`,
          fixture.namespace.id,
          owners[1].configurationId,
          `restriction-${randomUUID()}`,
          owners[2].harnessAuth.source.id,
        ],
      );
      const prepared = [];
      // Production workers have no Secret API permission. Dispatch must project
      // authoritative OCC metadata without asking the backend owner to read values.
      fixture.secretDriver.setResolveOverride(() => {
        throw new Error("Worker cannot read backend Secrets.");
      });
      await fixture.start({
        ...fixture.compute,
        async prepareRevision(revision, operationContext) {
          prepared.push({ id: revision.id, operationContext });
          return fixture.compute.prepareRevision(revision);
        },
      });
      await Promise.all(
        candidates.map((candidate, index) =>
          fixture.work(candidate, index === 0 ? "succeeded" : "failed_permanent"),
        ),
      );
      const source = await fixture.state.read((view) =>
        view.secrets.findSecret(fixture.namespace.id, owners[0].harnessAuth.source.id),
      );
      assert.deepEqual(
        prepared,
        [
          {
            id: candidates[0].id,
            operationContext: {
              secretEnvironment: [],
              harnessAuth: { ...candidates[0].harnessAuth, backendRef: source.backendRef },
            },
          },
        ],
        "only the independently authorized binding reaches Compute, outside gateway environment projections",
      );
      const denied = await fixture.observerPool.query(
        `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
       FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
        [fixture.namespace.id],
      );
      const deniedResources = denied.rows
        .map(
          ({ authorization }) =>
            `${authorization.principalId}:${authorization.resource.kind}:${authorization.resource.id}`,
        )
        .sort();
      assert.deepEqual(
        deniedResources,
        [
          `${fixture.actor.id}:configuration:${owners[1].configurationId}`,
          `${fixture.actor.id}:secret:${owners[2].harnessAuth.source.id}`,
          `${owners[3].servicePrincipalId}:secret:${owners[3].harnessAuth.source.id}`,
        ].sort(),
      );
    },
  );
}

revisionTest(
  "revision dispatch refuses a different selected Secret Driver before binding or activating the Agent",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("changed-secret-owner");
    // Installation composition changed after admission. The revision remains
    // pinned to its admitted Secret Driver and cannot use the replacement.
    const effects = [];
    await fixture.start(
      {
        ...fixture.compute,
        async bindAgent() {
          effects.push("bind");
        },
        async prepareRevision(revision) {
          effects.push("prepare");
          return fixture.compute.prepareRevision(revision);
        },
      },
      {
        transformDrivers: (drivers) => ({
          ...drivers,
          installation: {
            ...drivers.installation,
            drivers: {
              ...drivers.installation.drivers,
              secret: { ...drivers.installation.drivers.secret, id: "secret-replacement" },
            },
          },
          secretDriver: { ...drivers.secretDriver, id: "secret-replacement" },
        }),
      },
    );
    await fixture.work(candidate, "failed_permanent");
    assert.deepEqual(effects, []);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, undefined);
    const work = await fixture.observerPool.query(
      "SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'",
      [candidate.id],
    );
    assert.equal(work.rows[0].reason_code, "SECRET_DRIVER_MISMATCH");
    // The status names the fix, without IDs, instead of the generic failure text (finding 828).
    assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
      code: "SECRET_DRIVER_MISMATCH",
      message:
        "The Installation no longer selects the Secret Driver this revision was admitted with. Bind Secrets created through the selected Secret Driver, or remove the old Secret bindings, then deploy again.",
    });
  },
);

revisionTest(
  "revision dispatch refuses a different selected Compute Driver with a fixed status message",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("changed-compute-owner");
    // Installation composition changed after admission: the revision stays pinned to the
    // Compute Driver it was admitted with, so dispatch refuses it before any Compute effect.
    const effects = [];
    await fixture.start({
      ...fixture.compute,
      id: "compute-replacement",
      async bindAgent() {
        effects.push("bind");
      },
      async prepareRevision(revision) {
        effects.push("prepare");
        return fixture.compute.prepareRevision(revision);
      },
    });
    await fixture.work(candidate, "failed_permanent");
    await fixture.stop();
    assert.deepEqual(effects, []);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, undefined);
    assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
      code: "COMPUTE_DRIVER_MISMATCH",
      message:
        "The Installation no longer selects the Compute Driver this revision was admitted with. Deploy again to admit a revision for the selected driver.",
    });
  },
);

revisionTest(
  "revision dispatch never substitutes a later ChatGPT credential or reconfigured Backend for its admitted snapshot",
  async (fixture) => {
    const provider = backendDefinition();
    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "credential-replaced",
    );
    await seedBackendBinding(fixture.observerPool, account);
    const { owner, candidate } = await fixture.admitInitialRevision("credential-replaced", {
      agent: { executionMode: "dedicated", serviceAccountId: account.id, backendId: provider.id },
    });
    await fixture.state.transact((unit) =>
      unit.serviceAccounts.updateCredential(fixture.namespace.id, account.id, {
        kind: "access_token",
        secretRef: { name: "later-issued-account-credential", key: "access-token" },
      }),
    );
    const changedWorkspace = "22222222-2222-4222-8222-222222222222";
    const workspaceAccount = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "workspace-replaced",
    );
    await seedBackendBinding(fixture.observerPool, workspaceAccount);
    const { candidate: workspaceCandidate } = await fixture.admitInitialRevision(
      "workspace-replaced",
      {
        agent: {
          executionMode: "dedicated",
          serviceAccountId: workspaceAccount.id,
          backendId: provider.id,
        },
      },
    );
    // Reconfiguring the selected Backend cannot move an admitted credential
    // across workspaces; the private source owner remains unchanged.
    const effects = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          effects.push(revision.id);
          return fixture.compute.prepareRevision(revision);
        },
      },
      { providers: [backendDefinition({ workspaceId: changedWorkspace })] },
    );
    await fixture.work(candidate, "failed_permanent");
    await fixture.work(workspaceCandidate, "failed_permanent");
    assert.deepEqual(effects, []);
    const snapshot = await fixture.state.read((view) =>
      view.revisions.findRevision(fixture.namespace.id, owner.id, candidate.id),
    );
    assert.deepEqual(snapshot.harnessAuth.credential, account.credential);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, undefined);
  },
);

revisionTest(
  "runtime auth persists only its method and worker reauthorizes deployment without resolving credentials",
  async (fixture) => {
    const owner = await fixture.agent("runtime-owner", {
      grantHarnessSecret: false,
      auth: "runtime",
    });
    const denied = await fixture.agent("runtime-denied", {
      grantHarnessSecret: false,
      auth: "runtime",
    });
    const admitted = await fixture.revision(owner, 1);
    const deniedRevision = await fixture.revision(denied, 1);
    // Revoke deployment after admission: runtime does not bypass worker reauthorization.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
     VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, denied.id],
    );
    const prepared = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, dispatch) {
          assert.deepEqual(dispatch.harnessAuth, { method: "runtime" });
          assert.deepEqual(dispatch.secretEnvironment, []);
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, dispatch);
        },
      },
      {
        pool: fixture.workerPool,
        transformDrivers: (drivers) => ({
          ...drivers,
          secretDriver: {
            ...drivers.secretDriver,
            resolve() {
              assert.fail("runtime must not resolve an OCC credential");
            },
          },
        }),
      },
    );
    await fixture.work(admitted, "succeeded");
    await fixture.work(deniedRevision, "failed_permanent");
    assert.ok(prepared.includes(admitted.id));
    assert.ok(!prepared.includes(deniedRevision.id));
    const persisted = await fixture.state.read((view) =>
      view.revisions.findRevision(fixture.namespace.id, owner.id, admitted.id),
    );
    assert.deepEqual(persisted.harnessAuth, { method: "runtime" });
    assert.ok(Object.isFrozen(persisted.harnessAuth));
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, admitted.id);
    // The database grammar rejects credential smuggling independently of the API grammar.
    for (const extra of [
      { source: {} },
      { serviceAccountId: "account" },
      { secretDriverId: "driver" },
      { value: "key" },
    ]) {
      await assert.rejects(
        fixture.observerPool.query(
          "UPDATE occ.agents SET harness_auth = $1::jsonb WHERE namespace_id = $2 AND id = $3",
          [JSON.stringify({ method: "runtime", ...extra }), fixture.namespace.id, owner.id],
        ),
        (error) => error.code === "23514",
      );
    }
  },
);
