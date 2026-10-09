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
import {
  ActivationFailedError,
  ActivationPendingError,
  CredentialSourceRevisionError,
  CredentialWithdrawalRefusedError,
  DependencyUnavailableError,
  PostgresMetricsSnapshot,
  ResourceStateConflictError,
  SandboxRevisionUnsupportedError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import {
  createAccessTokenServiceAccount,
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
import {
  CREDENTIAL_GATEWAY_FIXTURE_ID,
  createWorkerRevisionFixtures,
} from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  advanceCleanupRetries,
  completion,
  removeAccessBindings,
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

// Selects a paired Sandbox and Credential Gateway so the worker admits credential-source
// revisions. Compute stands in for the gateway calls; these doubles only identify the pair.
function withCredentialGateway(drivers) {
  const sandboxDriver = {
    id: "sandbox-worker-fixture",
    capability: "sandbox",
    implementation: "sandbox-worker-fixture",
    facets: ["networking"],
    async cleanup() {},
  };
  const credentialGatewayDriver = {
    id: CREDENTIAL_GATEWAY_FIXTURE_ID,
    capability: "credential_gateway",
    implementation: "credential-gateway-worker-fixture",
    async listSourceTypes() {
      return [];
    },
    async registerSource() {
      return { state: "ready" };
    },
    async updateSource() {
      return { state: "ready" };
    },
    async rotateSource() {
      return { state: "ready" };
    },
    async sourceStatus() {
      return { state: "ready" };
    },
    async removeSource() {},
    async attachForRevision() {
      return [];
    },
    async attachmentStatus() {
      return [];
    },
    async withdraw(context) {
      return { sourceId: context.sourceId, state: "pending" };
    },
  };
  return {
    ...drivers,
    installation: {
      ...drivers.installation,
      drivers: {
        ...drivers.installation.drivers,
        sandbox: { id: sandboxDriver.id, configuration: {} },
        credential_gateway: { id: credentialGatewayDriver.id, configuration: {} },
      },
    },
    sandboxDriver,
    credentialGatewayDriver,
  };
}

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

// The Agent's list starts with its Harness source; the remaining entries are tool sources.
function toolSources(owner) {
  return owner.credentialSources.filter(({ sourceId }) => sourceId !== owner.harnessAuth?.sourceId);
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
  { timeout: 30_000 },
);

revisionTest(
  "credential withdrawal work revokes from the active revision without redeploying it",
  async (fixture) => {
    const { owner, candidate: active } = await fixture.admitInitialRevision("withdraw-target", {
      agent: { auth: "credential_source" },
    });
    const prepared = [];
    const withdrawn = [];
    let pendingOnce = true;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (revision.namespaceId === fixture.namespace.id) {
            prepared.push(revision.id);
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(revision, source) {
          withdrawn.push([revision.id, source.id]);
          // The first observation is still pending, so the worker must retry, not report success.
          if (pendingOnce) {
            pendingOnce = false;
            return { sourceId: source.id, state: "pending" };
          }
          return { sourceId: source.id, state: "revoked" };
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "succeeded");
    const deployments = prepared.length;

    // Record the withdrawal the way the API does: a pending row plus revision-scoped work.
    const source = { id: owner.harnessAuth.sourceId };
    const operationId = randomUUID();
    await fixture.state.transact(async (unit) => {
      await unit.credentialSources.requestCredentialWithdrawal({
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: active.id,
        credentialSourceId: source.id,
        state: "pending",
        requestedBy: fixture.actor.id,
        requestedAt: new Date().toISOString(),
      });
      await unit.operations.append({
        kind: "agent_revision",
        action: "reconcile",
        target: "credentials_withdrawn",
        operationId,
        namespaceId: fixture.namespace.id,
        resourceId: active.id,
        actorId: fixture.actor.id,
      });
    });
    const withdrawal = {
      idempotencyKey: `agent_revision:${active.id}:reconcile:credentials_withdrawn:${operationId}`,
      id: active.id,
    };
    const completed = await fixture.work(withdrawal, "succeeded");
    assert.equal(completed.attempt_count, 2, "a pending revocation retries until confirmed");
    assert.deepEqual(withdrawn, [
      [active.id, source.id],
      [active.id, source.id],
    ]);

    // Withdrawal never redeploys or replaces the active revision.
    assert.equal(prepared.length, deployments);
    const [agent, recorded] = await fixture.state.read(async (view) =>
      Promise.all([
        view.agents.findAgent(fixture.namespace.id, owner.id),
        view.credentialSources.findCredentialWithdrawal(fixture.namespace.id, active.id, source.id),
      ]),
    );
    assert.equal(agent.activeRevisionId, active.id);
    assert.equal(recorded.state, "revoked");
    assert.ok(recorded.completedAt);
    const deployment = await fixture.observerPool.query(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [active.idempotencyKey],
    );
    assert.deepEqual(deployment.rows[0], { state: "succeeded", attempt_count: 1 });
    const audit = await fixture.observerPool.query(
      `SELECT resource_id, outcome, details->>'reasonCode' AS reason_code,
              details->>'revisionId' AS revision_id, details->'credentialSourceIds' AS sources
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [
      {
        resource_id: owner.id,
        outcome: "success",
        reason_code: "CREDENTIALS_WITHDRAWN",
        revision_id: active.id,
        sources: [source.id],
      },
    ]);
  },
);

// The revision's queued withdrawal series (the request's, or a scheduled retry) and how long
// until the worker may claim it.
async function queuedWithdrawal(fixture, revision) {
  const { rows } = await fixture.observerPool.query(
    `SELECT idempotency_key,
            EXTRACT(EPOCH FROM (available_at - clock_timestamp())) * 1000 AS delay_ms
     FROM occ.controller_work
     WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn' AND state = 'queued'`,
    [revision.id],
  );
  assert.equal(rows.length, 1, "a revision has at most one withdrawal series queued");
  return {
    id: revision.id,
    idempotencyKey: rows[0].idempotency_key,
    delayMs: Number(rows[0].delay_ms),
  };
}

// A scheduled retry waits `expectedMs` from the failure that queued it, never less.
function assertRetryDelay(series, expectedMs) {
  assert.ok(
    series.delayMs > expectedMs - 5_000 && series.delayMs <= expectedMs + 1_000,
    `expected a retry about ${expectedMs} ms away, got ${series.delayMs} ms`,
  );
}

// Lets a scheduled retry run now instead of waiting out its delay. The worker still claims it.
async function runScheduledRetryNow(fixture, series) {
  const updated = await fixture.observerPool.query(
    `UPDATE occ.controller_work SET available_at = clock_timestamp()
     WHERE idempotency_key = $1 AND state = 'queued'`,
    [series.idempotencyKey],
  );
  assert.equal(updated.rowCount, 1);
}

// The withdrawal audit events in order; with `fields`, only those columns, in that key order.
async function withdrawalAudit(fixture, ...fields) {
  const { rows } = await fixture.observerPool.query(
    `SELECT kind, actor_id, outcome, details->>'reasonCode' AS reason_code,
            details->'credentialSourceIds' AS sources
     FROM occ.audit_events
     WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
     ORDER BY occurred_at, kind DESC`,
    [fixture.namespace.id],
  );
  return fields.length === 0
    ? rows
    : rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
}

// A Compute double for a gateway outage: each withdrawal fails as unreachable while
// `gateway.down` is true and is revoked once it is false. `gateway.withdrawn` lists the source
// of every call, and `beforeAnswer` runs with the call count before the gateway answers.
function gatewayOutage(fixture, beforeAnswer = async () => {}) {
  const gateway = { down: true, withdrawn: [] };
  const compute = {
    ...fixture.compute,
    async withdrawCredentialSource(_revision, source) {
      gateway.withdrawn.push(source.id);
      await beforeAnswer(gateway.withdrawn.length);
      if (gateway.down) {
        throw new DependencyUnavailableError("The OpenShell gateway is unreachable.");
      }
      return { sourceId: source.id, state: "revoked" };
    },
  };
  return { gateway, compute };
}

function startWithGateway(fixture, compute) {
  return fixture.start(compute, {
    convergenceTimeoutMs: 50,
    transformDrivers: withCredentialGateway,
  });
}

test(
  "a withdrawal that outlasts its attempts in a gateway outage is retried later and revoked without a replay",
  requiresPostgres,
  async (context) => {
    // Kubernetes Compute has no maintenance interval, and neither has this Compute double.
    const fixture = await setup(context, { maxAttempts: 2 });
    const { owner, candidate: active } = await fixture.admitInitialRevision("withdraw-outage", {
      agent: { auth: "credential_source" },
    });
    const { gateway, compute } = gatewayOutage(fixture);
    await startWithGateway(fixture, compute);
    await fixture.work(active, "succeeded");
    const sourceId = owner.harnessAuth.sourceId;
    const request = withdrawalRequest(fixture, owner, sourceId);
    await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
    const read = () => fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    const [first] = await withdrawalAttempts(fixture, active);
    await fixture.work(first, "failed_permanent");

    // The outage outlasted the attempt budget. The withdrawal stays pending with its reason, and
    // the failing pass already queued a retry for 30 s later, so the read still reports an
    // attempt coming rather than asking for a replay.
    const waiting = await read();
    assert.equal(waiting.state, "pending");
    assert.equal(waiting.lastReason, "DEPENDENCY_UNAVAILABLE");
    assert.equal(waiting.withdrawalInProgress, true);
    const retry = await queuedWithdrawal(fixture, active);
    assert.equal(retry.idempotencyKey, `${first.idempotencyKey}:recovery:1`);
    assertRetryDelay(retry, 30_000);
    assert.equal(gateway.withdrawn.length, 2);

    // The gateway is back. Nobody replays: the scheduled retry revokes the source.
    gateway.down = false;
    await runScheduledRetryNow(fixture, retry);
    await fixture.work(retry, "succeeded");
    const revoked = await read();
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.lastReason, "CREDENTIALS_WITHDRAWN");
    assert.equal(revoked.withdrawalInProgress, false);
    assert.equal(gateway.withdrawn.length, 3);
    assert.deepEqual(
      (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
      ["failed_permanent", "succeeded"],
    );
    // The audit shows the failed series and the revocation that followed it.
    assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
      { outcome: "failure", reason_code: "DEPENDENCY_UNAVAILABLE" },
      { outcome: "success", reason_code: "CREDENTIALS_WITHDRAWN" },
    ]);
  },
);

test(
  "a source that only a queued withdrawal series blocks is refused with its own 409, not the redeploy advice",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const owner = await fixture.agent("withdraw-delete", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
    const { gateway: outage, compute } = gatewayOutage(fixture);
    const first = await fixture.revision(owner, 1);
    await startWithGateway(fixture, compute);
    await fixture.work(first, "succeeded");
    await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      withdrawalRequest(fixture, owner, tool),
    );
    const [attempt] = await withdrawalAttempts(fixture, first);
    await fixture.work(attempt, "failed_permanent");

    // Redeploy without the tool source. Its withdrawal series stays queued for the first revision.
    const withoutTool = await fixture.state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(fixture.namespace.id);
      await unit.agents.lockAgent(fixture.namespace.id, owner.id);
      return unit.agents.updateConfiguration(
        fixture.namespace.id,
        owner.id,
        owner.configurationId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ sourceId: owner.harnessAuth.sourceId }],
      );
    });
    const second = await fixture.revision(withoutTool, 2);
    await fixture.work(second, "succeeded");
    await fixture.stop();
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, second.id);
    const retry = await queuedWithdrawal(fixture, first);

    const gateway = withCredentialGateway({
      installation: { drivers: {} },
    }).credentialGatewayDriver;
    fixture.controller.registerDriver(gateway);
    fixture.controller.selectDriver("credential_gateway", gateway.id);
    const deleteSource = (sourceId) =>
      fixture.controller.deleteCredentialSource(fixture.actor.id, fixture.namespace.id, sourceId);
    // Redeploying again cannot help, so the refusal names the wait and Agent deletion instead.
    await assert.rejects(deleteSource(tool), (error) => {
      assert.ok(error instanceof ResourceStateConflictError);
      assert.equal(error.name, "CredentialWithdrawalInProgressError");
      assert.match(error.message, /^A credential withdrawal is still queued or running/);
      return true;
    });
    // The Harness source the active revision still uses keeps the reference refusal.
    await assert.rejects(deleteSource(owner.harnessAuth.sourceId), (error) => {
      assert.equal(error.name, "ResourceStateConflictError");
      assert.match(error.message, /^An Agent, active revision, or pending deployment/);
      return true;
    });
    const blocking = (sourceId) =>
      fixture.state.transact((unit) =>
        unit.credentialSources.findBlockingReference(fixture.namespace.id, sourceId),
      );
    assert.equal(await blocking(tool), "withdrawal_work");
    assert.equal(
      (
        await fixture.state.read((view) =>
          view.credentialSources.findCredentialSource(fixture.namespace.id, tool),
        )
      )?.state,
      "ready",
      "a refused deletion leaves the source as it was",
    );

    // Once the series confirms, nothing blocks the deletion.
    outage.down = false;
    await startWithGateway(fixture, compute);
    await runScheduledRetryNow(fixture, retry);
    await fixture.work(retry, "succeeded");
    await fixture.stop();
    assert.equal(await blocking(tool), undefined);
  },
);

test(
  "a withdrawal in a long outage backs off to 5 minutes, stops after its last retry, and a replay starts again",
  requiresPostgres,
  async (context) => {
    // One attempt per series, so each series is one gateway call.
    const fixture = await setup(context, { maxAttempts: 1 });
    const { owner, candidate: active } = await fixture.admitInitialRevision(
      "withdraw-long-outage",
      {
        agent: { auth: "credential_source" },
      },
    );
    const { gateway, compute } = gatewayOutage(fixture);
    const calls = () => gateway.withdrawn.length;
    await startWithGateway(fixture, compute);
    await fixture.work(active, "succeeded");
    const request = withdrawalRequest(fixture, owner, owner.harnessAuth.sourceId);
    await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
    const read = () => fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    const [first] = await withdrawalAttempts(fixture, active);
    await fixture.work(first, "failed_permanent");

    // A scheduled retry does not run before it is due, so a gateway that stays down is not
    // called in a loop.
    await delay(1_000);
    assert.equal(calls(), 1);
    // Each retry waits twice as long as the one before, up to 5 minutes, about an hour in all.
    const delays = [30_000, 60_000, 120_000, 240_000, ...Array(11).fill(300_000)];
    for (const [index, delayMs] of delays.entries()) {
      const retry = await queuedWithdrawal(fixture, active);
      assert.equal(retry.idempotencyKey, `${first.idempotencyKey}:recovery:${index + 1}`);
      assertRetryDelay(retry, delayMs);
      assert.equal(calls(), index + 1);
      await runScheduledRetryNow(fixture, retry);
      await fixture.work(retry, "failed_permanent");
    }

    // After the last retry nothing is queued, and the read says only a replay retries it.
    assert.deepEqual(
      (await withdrawalAttempts(fixture, active)).filter(
        ({ state }) => state !== "failed_permanent",
      ),
      [],
    );
    const exhausted = await read();
    assert.equal(exhausted.state, "pending");
    assert.equal(exhausted.lastReason, "DEPENDENCY_UNAVAILABLE");
    assert.equal(exhausted.withdrawalInProgress, false);
    assert.equal(calls(), delays.length + 1);
    // One failure audit per series: the record shows every retry and nothing more.
    const audit = await withdrawalAudit(fixture);
    assert.equal(audit.length, delays.length + 1);
    assert.ok(
      audit.every(
        ({ outcome, reason_code }) =>
          outcome === "failure" && reason_code === "DEPENDENCY_UNAVAILABLE",
      ),
    );

    // A replay is a new request with its own retries; with the gateway back it revokes the source.
    gateway.down = false;
    const replayed = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      request,
    );
    assert.equal(replayed.withdrawalInProgress, true);
    const replay = await queuedWithdrawal(fixture, active);
    assert.ok(!replay.idempotencyKey.startsWith(first.idempotencyKey));
    await fixture.work(replay, "succeeded");
    const revoked = await read();
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.withdrawalInProgress, false);
  },
);

test(
  "a withdrawal retried after an outage leaves one denied to its requester for a replay",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const owner = await fixture.agent("withdraw-outage-denied", {
      auth: "credential_source",
      nonModelSources: 2,
    });
    const active = await fixture.revision(owner, 1);
    const [allowed, deniedSource] = toolSources(owner).map(({ sourceId }) => sourceId);
    const { gateway, compute } = gatewayOutage(fixture);
    await startWithGateway(fixture, compute);
    await fixture.work(active, "succeeded");
    await fixture.stop();

    // The actor withdraws one tool source, and an operator who is then offboarded the other.
    // Both share the actor's claim.
    const offboarded = `withdraw-outage-offboarded-${randomUUID()}`;
    await fixture.copyActorGrants(offboarded);
    await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      withdrawalRequest(fixture, owner, allowed),
    );
    await fixture.controller.withdrawAgentCredentialSource(
      offboarded,
      withdrawalRequest(fixture, owner, deniedSource),
    );
    await removeAccessBindings(fixture, offboarded);
    const [first, ...others] = await withdrawalAttempts(fixture, active);
    assert.deepEqual(others, []);

    // The authorized withdrawal runs out of attempts in the outage, so a retry is queued for it.
    await startWithGateway(fixture, compute);
    await fixture.work(first, "failed_permanent");
    const retry = await queuedWithdrawal(fixture, active);
    assert.equal(retry.idempotencyKey, `${first.idempotencyKey}:recovery:1`);

    // With the gateway back, the retry revokes the authorized source. The denied one still never
    // reaches the gateway, and nothing queues it again: only an authorized replay can.
    gateway.down = false;
    await runScheduledRetryNow(fixture, retry);
    await fixture.work(retry, "failed_permanent");
    const read = (credentialSourceId) =>
      fixture.controller.readAgentCredentialWithdrawal(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, credentialSourceId),
      );
    assert.equal((await read(allowed)).state, "revoked");
    const denied = await read(deniedSource);
    assert.equal(denied.state, "pending");
    assert.equal(denied.lastReason, "AUTHORIZATION_DENIED");
    assert.equal(denied.withdrawalInProgress, false);
    assert.deepEqual(
      (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
      ["failed_permanent", "failed_permanent"],
    );
    await fixture.stop();
    assert.ok(gateway.withdrawn.every((sourceId) => sourceId === allowed));
    // Each series audits the denial once; the outage failure and the revocation once each.
    // Events of one series share a transaction, so compare them as a set.
    const entries = (rows) => rows.map((row) => JSON.stringify(row)).sort();
    assert.deepEqual(
      entries(await withdrawalAudit(fixture, "outcome", "actor_id", "sources")),
      entries([
        { outcome: "failure", actor_id: fixture.actor.id, sources: [allowed] },
        { outcome: "denied", actor_id: offboarded, sources: [deniedSource] },
        { outcome: "success", actor_id: fixture.actor.id, sources: [allowed] },
        { outcome: "denied", actor_id: offboarded, sources: [deniedSource] },
      ]),
    );
  },
);

test(
  "a withdrawal whose last attempt outlives its lease is retried later and revoked without a replay",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const { owner, candidate: active } = await fixture.admitInitialRevision("withdraw-lost-lease", {
      agent: { auth: "credential_source" },
    });
    const lastAttempt = Promise.withResolvers();
    const lastAttemptReleased = Promise.withResolvers();
    context.after(() => lastAttemptReleased.resolve());
    const { gateway, compute } = gatewayOutage(fixture, async (calls) => {
      // The series' last gateway call hangs past the claim's lease.
      if (calls === 2) {
        lastAttempt.resolve();
        await lastAttemptReleased.promise;
      }
    });
    await startWithGateway(fixture, compute);
    await fixture.work(active, "succeeded");
    const request = withdrawalRequest(fixture, owner, owner.harnessAuth.sourceId);
    await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
    const read = () => fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    const [first] = await withdrawalAttempts(fixture, active);

    // The lease runs out during the last attempt, so stale-claim recovery fails the work, not
    // the worker's final pass. It still queues the next series.
    await lastAttempt.promise;
    const claimed = await fixture.work(first, "claimed");
    assert.equal(claimed.attempt_count, 2);
    assert.equal((await fixture.expireClaim(first, claimed.claim_token)).rowCount, 1);
    lastAttemptReleased.resolve();
    await fixture.work(first, "failed_permanent");
    assert.equal((await fixture.workResult(first)).rows[0].reason_code, "LEASE_EXPIRED");
    const retry = await waitFor("the next series after a lost lease", async () => {
      const { rowCount } = await fixture.observerPool.query(
        `SELECT 1 FROM occ.controller_work
         WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn' AND state = 'queued'`,
        [active.id],
      );
      return rowCount === 1 ? queuedWithdrawal(fixture, active) : undefined;
    });
    assert.equal(retry.idempotencyKey, `${first.idempotencyKey}:recovery:1`);
    assertRetryDelay(retry, 30_000);
    const waiting = await read();
    assert.equal(waiting.state, "pending");
    assert.equal(waiting.withdrawalInProgress, true);

    // The gateway is back. Nobody replays: the scheduled retry revokes the source.
    gateway.down = false;
    await runScheduledRetryNow(fixture, retry);
    await fixture.work(retry, "succeeded");
    const revoked = await read();
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.withdrawalInProgress, false);
    assert.equal(gateway.withdrawn.length, 3);
    assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
      { outcome: "success", reason_code: "CREDENTIALS_WITHDRAWN" },
    ]);
  },
);

test(
  "a replay while a withdrawal series waits takes it over from a requester who lost access and runs it now",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 1 });
    const { owner, candidate: active } = await fixture.admitInitialRevision(
      "withdraw-replay-series",
      { agent: { auth: "credential_source" } },
    );
    const { gateway, compute } = gatewayOutage(fixture);
    await startWithGateway(fixture, compute);
    await fixture.work(active, "succeeded");

    // An operator withdraws the source. The first series fails in a gateway outage and queues
    // the next one for 30 s later; then the operator is offboarded.
    const offboarded = `withdraw-replay-offboarded-${randomUUID()}`;
    await fixture.copyActorGrants(offboarded);
    const request = withdrawalRequest(fixture, owner, owner.harnessAuth.sourceId);
    await fixture.controller.withdrawAgentCredentialSource(offboarded, request);
    const [first] = await withdrawalAttempts(fixture, active);
    await fixture.work(first, "failed_permanent");
    const series = await queuedWithdrawal(fixture, active);
    assertRetryDelay(series, 30_000);
    await fixture.stop();
    await removeAccessBindings(fixture, offboarded);

    // With the gateway back, another operator replays. The replay takes the withdrawal over and
    // lets the waiting series run now, without starting a second chain, so the series is not
    // denied to the offboarded operator and no second replay is needed.
    gateway.down = false;
    const replayed = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      request,
    );
    assert.equal(replayed.requestedBy, fixture.actor.id);
    assert.equal(replayed.withdrawalInProgress, true);
    const due = await queuedWithdrawal(fixture, active);
    assert.equal(due.idempotencyKey, series.idempotencyKey);
    assert.ok(due.delayMs <= 0, `expected the series to be due now, got ${due.delayMs} ms`);
    assert.equal((await withdrawalAttempts(fixture, active)).length, 2);

    await startWithGateway(fixture, compute);
    await fixture.work(due, "succeeded");
    const revoked = await fixture.controller.readAgentCredentialWithdrawal(
      fixture.actor.id,
      request,
    );
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.requestedBy, fixture.actor.id);
    // The offboarded operator's failed series stays theirs; the revocation is the replaying
    // operator's.
    assert.deepEqual(await withdrawalAudit(fixture, "actor_id", "outcome", "reason_code"), [
      { actor_id: offboarded, outcome: "failure", reason_code: "DEPENDENCY_UNAVAILABLE" },
      { actor_id: fixture.actor.id, outcome: "success", reason_code: "CREDENTIALS_WITHDRAWN" },
    ]);
  },
);

test(
  "a replay during a running attempt takes over a withdrawal it denied, and the attempt retries instead of failing",
  requiresPostgres,
  async (context) => {
    // Registered before the fixture's cleanup so a failed assertion cannot leave the worker's
    // stop waiting on the held gateway call.
    const gatewayCall = Promise.withResolvers();
    const gatewayReleased = Promise.withResolvers();
    context.after(() => gatewayReleased.resolve());
    const fixture = await setup(context, { maxAttempts: 2 });
    const owner = await fixture.agent("withdraw-replay-running", {
      auth: "credential_source",
      nonModelSources: 2,
    });
    const active = await fixture.revision(owner, 1);
    const [allowed, deniedSource] = toolSources(owner).map(({ sourceId }) => sourceId);
    const withdrawn = [];
    const compute = {
      ...fixture.compute,
      async withdrawCredentialSource(_revision, source) {
        withdrawn.push(source.id);
        if (withdrawn.length === 1) {
          gatewayCall.resolve();
          await gatewayReleased.promise;
        }
        return { sourceId: source.id, state: "revoked" };
      },
    };
    await startWithGateway(fixture, compute);
    await fixture.work(active, "succeeded");
    await fixture.stop();

    // The actor withdraws one tool source and an operator, offboarded before the worker runs,
    // the other. Both share one claim.
    const offboarded = `withdraw-running-offboarded-${randomUUID()}`;
    await fixture.copyActorGrants(offboarded);
    await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      withdrawalRequest(fixture, owner, allowed),
    );
    const deniedRequest = withdrawalRequest(fixture, owner, deniedSource);
    await fixture.controller.withdrawAgentCredentialSource(offboarded, deniedRequest);
    await removeAccessBindings(fixture, offboarded);
    const [work, ...others] = await withdrawalAttempts(fixture, active);
    assert.deepEqual(others, []);

    // The attempt has denied the offboarded requester and is revoking the authorized source
    // when the actor replays the denied withdrawal. The running attempt is its only work.
    await startWithGateway(fixture, compute);
    await gatewayCall.promise;
    const replayed = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      deniedRequest,
    );
    assert.equal(replayed.requestedBy, fixture.actor.id);
    assert.equal(replayed.withdrawalInProgress, true);
    assert.equal((await withdrawalAttempts(fixture, active)).length, 1);

    // The denial no longer stands, so the attempt retries on the actor's authority.
    gatewayReleased.resolve();
    const completed = await fixture.work(work, "succeeded");
    await fixture.stop();
    assert.equal(completed.attempt_count, 2);
    assert.deepEqual(withdrawn, [allowed, deniedSource]);
    const denied = await fixture.controller.readAgentCredentialWithdrawal(
      fixture.actor.id,
      deniedRequest,
    );
    assert.equal(denied.state, "revoked");
    assert.equal(denied.requestedBy, fixture.actor.id);
    assert.deepEqual(await withdrawalAudit(fixture, "actor_id", "outcome", "sources"), [
      { actor_id: fixture.actor.id, outcome: "success", sources: [allowed] },
      { actor_id: fixture.actor.id, outcome: "success", sources: [deniedSource] },
    ]);
  },
);

test(
  "a withdrawal Compute refuses as misconfigured fails once and queues no later series",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const { owner, candidate: active } = await fixture.admitInitialRevision("withdraw-refused", {
      agent: { auth: "credential_source" },
    });
    let calls = 0;
    await fixture.start(
      {
        ...fixture.compute,
        // What the Kubernetes Compute Driver throws for a SandboxDriver that cannot name the
        // revision's Sandbox.
        async withdrawCredentialSource() {
          calls += 1;
          throw new CredentialWithdrawalRefusedError(
            "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
            "Credential withdrawal requires a SandboxDriver that identifies the revision's Harness.",
          );
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "succeeded");
    const request = withdrawalRequest(fixture, owner, owner.harnessAuth.sourceId);
    await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
    const [first] = await withdrawalAttempts(fixture, active);

    // One attempt, no retry series: retrying cannot change a refusal.
    const failed = await fixture.work(first, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    assert.equal(calls, 1);
    assert.equal(
      (await fixture.workResult(first)).rows[0].reason_code,
      "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
    );
    assert.deepEqual(
      (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
      ["failed_permanent"],
    );
    const read = await fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    assert.equal(read.state, "pending");
    assert.equal(read.lastReason, "CREDENTIAL_WITHDRAWAL_MISCONFIGURED");
    assert.equal(read.withdrawalInProgress, false);
    assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
      { outcome: "failure", reason_code: "CREDENTIAL_WITHDRAWAL_MISCONFIGURED" },
    ]);
  },
);

test(
  "a terminally failing credential withdrawal takes the Namespace and Agent before its withdrawal rows",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const { owner, candidate: active } = await fixture.admitInitialRevision("withdraw-lock-order", {
      agent: { auth: "credential_source" },
    });
    let calls = 0;
    const lastAttempt = Promise.withResolvers();
    const lastAttemptReleased = Promise.withResolvers();
    await fixture.start(
      {
        ...fixture.compute,
        async withdrawCredentialSource(_revision, source) {
          // The last attempt stays pending, so the worker fails the work permanently.
          if (++calls === 2) {
            lastAttempt.resolve();
            await lastAttemptReleased.promise;
          }
          return { sourceId: source.id, state: "pending" };
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "succeeded");
    const sourceId = owner.harnessAuth.sourceId;
    await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      withdrawalRequest(fixture, owner, sourceId),
    );
    const work = await withdrawalAttempts(fixture, active);
    assert.equal(work.length, 1);
    const [withdrawal] = work;

    // A withdrawal request locks the Namespace, then the Agent, then the withdrawal row. Hold
    // the Namespace until the worker's final pass waits on it; that pass must not hold the
    // withdrawal row or the Agent yet, or the two transactions deadlock.
    try {
      await lastAttempt.promise;
      await withNamespaceLockHeld(fixture.observerPool, fixture.namespace.id, async (lock) => {
        lastAttemptReleased.resolve();
        // The worker has one connection, and its next transaction is the final pass's.
        await lock.waitForBlocked("the worker's real wait on the Namespace lock");
        await lock.assertNotHeld(
          `SELECT state FROM occ.credential_withdrawals
           WHERE namespace_id = $1 AND revision_id = $2 AND credential_source_id = $3
           FOR UPDATE NOWAIT`,
          [fixture.namespace.id, active.id, sourceId],
          "a worker waiting for the Namespace must not already hold the withdrawal row",
        );
        await lock.assertNotHeld(
          "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2 FOR UPDATE NOWAIT",
          [fixture.namespace.id, owner.id],
          "a worker waiting for the Namespace must not already hold the Agent",
        );
      });
      await fixture.work(withdrawal, "failed_permanent");
    } finally {
      lastAttemptReleased.resolve();
    }
    const recorded = await findWithdrawal(fixture, active, sourceId);
    assert.equal(recorded.state, "pending");
    assert.equal(recorded.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
  },
);

test(
  "maintenance of a withdrawn revision retries the withdrawal and stops once it is revoked",
  requiresPostgres,
  async (context) => {
    // Two attempts, so the withdrawal runs out after one retry backoff of at most 1 s.
    const fixture = await setup(context, { maxAttempts: 2 });
    const { owner, candidate: active } = await fixture.admitInitialRevision(
      "withdraw-maintenance",
      { agent: { auth: "credential_source" } },
    );
    const prepared = [];
    let revoke = false;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "succeeded");
    const deployments = prepared.length;
    const sourceId = owner.harnessAuth.sourceId;

    await recordPendingWithdrawal(fixture, owner, active, sourceId);
    const queuedWork = async (pattern) =>
      (
        await fixture.observerPool.query(
          `SELECT idempotency_key FROM occ.controller_work
           WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
          [active.id, pattern],
        )
      ).rows;

    // Maintenance never re-attaches the source; it queues a withdrawal attempt and keeps going.
    const first = await runMaintenancePass(fixture, active);
    const withdrawal = await withdrawalAttempts(fixture, active);
    assert.equal(withdrawal.length, 1);
    assert.equal(withdrawal[0].actorId, fixture.actor.id);
    await fixture.work(withdrawal[0], "failed_permanent");
    const [next] = await queuedWork(`agent_revision:${active.id}:maintenance:%`);
    assert.notEqual(next.idempotency_key, first.idempotencyKey);
    assert.equal(prepared.length, deployments);

    // The next pass queues another attempt, which is revoked; after that maintenance stops.
    revoke = true;
    await runMaintenancePass(fixture, active);
    await waitFor("the withdrawal to be revoked", async () => {
      const found = await findWithdrawal(fixture, active, sourceId);
      return found.state === "revoked" ? found : undefined;
    });
    await runMaintenancePass(fixture, active);
    assert.deepEqual(await queuedWork(`agent_revision:${active.id}:%`), []);
    assert.equal(prepared.length, deployments);
  },
);

revisionTest(
  "a deployment retry never re-attaches a source withdrawn while it was finishing",
  async (fixture) => {
    const { owner, candidate: active } = await fixture.admitInitialRevision(
      "withdraw-during-activation",
      { agent: { auth: "credential_source" } },
    );
    const sourceId = owner.harnessAuth.sourceId;
    const request = withdrawalRequest(fixture, owner, sourceId);
    const prepared = [];
    const withdrawn = [];
    const events = [];
    let interruptActivation = true;
    await fixture.start(
      {
        ...fixture.compute,
        // The Harness receives the source's attachment only through a prepare.
        async prepareRevision(revision, revisionContext) {
          if (revision.namespaceId === fixture.namespace.id) {
            prepared.push(revision.id);
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async activateRevision(revision) {
          if (revision.id === active.id && interruptActivation) {
            interruptActivation = false;
            // The active pointer is already published, so admission accepts the withdrawal
            // while this deployment still has to be retried.
            await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
            throw new Error("activation interrupted");
          }
        },
        async withdrawCredentialSource(revision, source) {
          withdrawn.push([revision.id, source.id]);
          return { sourceId: source.id, state: "revoked" };
        },
      },
      { emit: (event) => events.push(event), transformDrivers: withCredentialGateway },
    );
    await waitFor(
      "the deployment retry to stop at the withdrawal",
      async () =>
        events.some(
          (event) =>
            event.event === "worker.completed" &&
            event.revisionId === active.id &&
            event.operation === "agent_revision.reconcile" &&
            event.code === "CREDENTIAL_WITHDRAWN",
        )
          ? true
          : undefined,
      30_000,
    );
    await waitFor(
      "the withdrawal to be revoked",
      async () => {
        const found = await findWithdrawal(fixture, active, sourceId);
        return found?.state === "revoked" ? found : undefined;
      },
      30_000,
    );
    await fixture.stop();

    // Only the first attempt prepared the revision; the retry stopped before re-attaching.
    assert.deepEqual(prepared, [active.id]);
    const deployment = await fixture.deploymentStatus(owner, active);
    assert.notEqual(deployment.status, "succeeded");
    assert.deepEqual(withdrawn, [[active.id, sourceId]]);
    const agent = await fixture.currentAgent(owner);
    assert.equal(agent.activeRevisionId, active.id);
    // Keep the deferred deployment from being claimed by a later test's worker.
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent', claim_token = NULL, lease_expires_at = NULL,
           completed_at = now(), reason_code = 'WITHDRAWN_DEPLOYMENT_TEST_CLEANUP',
           result_data = NULL, updated_at = now()
       WHERE idempotency_key = $1 AND state = 'queued'`,
      [active.idempotencyKey],
    );
  },
);

revisionTest(
  "non-model sources reach Compute at dispatch and a retry omits the ones withdrawn meanwhile",
  async (fixture) => {
    const owner = await fixture.agent("withdraw-tool-sources", {
      auth: "credential_source",
      nonModelSources: 2,
    });
    const active = await fixture.revision(owner, 1);
    const [first, second] = toolSources(owner).map(({ sourceId }) => sourceId);
    const dispatched = [];
    const withdrawn = [];
    const rechecked = [];
    let interruptActivation = true;
    await fixture.start(
      {
        ...fixture.compute,
        // Compute attaches the model source and each resolved non-model source.
        async prepareRevision(revision, revisionContext) {
          if (revision.namespaceId === fixture.namespace.id) {
            dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async activateRevision(revision) {
          if (revision.id === active.id && interruptActivation) {
            interruptActivation = false;
            // Withdraw both non-model sources while this deployment must still be retried. The
            // second request queues no work while the first attempt is outstanding.
            for (const credentialSourceId of [first, second]) {
              await fixture.controller.withdrawAgentCredentialSource(
                fixture.actor.id,
                withdrawalRequest(fixture, owner, credentialSourceId),
              );
            }
            throw new Error("activation interrupted");
          }
        },
        async withdrawCredentialSource(revision, source, _signal, options = {}) {
          (options.recheck === true ? rechecked : withdrawn).push([revision.id, source.id]);
          return { sourceId: source.id, state: "revoked" };
        },
      },
      { transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "succeeded", 30_000);
    await waitFor(
      "both withdrawals to be revoked",
      async () => {
        const found = await fixture.state.read((view) =>
          view.credentialSources.listCredentialWithdrawals(fixture.namespace.id, active.id),
        );
        return found.length === 2 && found.every(({ state }) => state === "revoked")
          ? found
          : undefined;
      },
      30_000,
    );
    await fixture.stop();

    // Unlike a withdrawn model source, withdrawn tool sources do not stop the revision: the
    // retry prepares it again without them and the deployment succeeds.
    assert.deepEqual(dispatched, [[first, second], []]);
    // One withdrawal pass revoked every pending source, in admission order.
    assert.deepEqual(withdrawn, [
      [active.id, first],
      [active.id, second],
    ]);
    // The retry rechecks both revoked sources before it prepares the Sandbox again.
    assert.deepEqual(rechecked, [
      [active.id, first],
      [active.id, second],
    ]);
    const audit = await fixture.observerPool.query(
      `SELECT details->'credentialSourceIds' AS sources
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
         AND outcome = 'success'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [{ sources: [first, second] }]);
  },
);

revisionTest(
  "a withdrawal reaches a deployment admitted before it, which activates without the source",
  async (fixture) => {
    const owner = await fixture.agent("withdraw-successor", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const first = await fixture.revision(owner, 1);
    const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
    const dispatched = [];
    const withdrawn = [];
    const compute = {
      ...fixture.compute,
      async prepareRevision(revision, revisionContext) {
        if (revision.namespaceId === fixture.namespace.id) {
          dispatched.push([
            revision.id,
            (revisionContext?.credentialSources ?? []).map(({ id }) => id),
          ]);
        }
        return fixture.compute.prepareRevision(revision, revisionContext);
      },
      async withdrawCredentialSource(revision, source) {
        withdrawn.push([revision.id, source.id]);
        return { sourceId: source.id, state: "revoked" };
      },
    };
    await fixture.start(compute, { transformDrivers: withCredentialGateway });
    await fixture.work(first, "succeeded");
    await fixture.stop();

    // The next deployment was admitted with the source; the withdrawal arrives before it runs.
    const second = await fixture.revision(owner, 2);
    const request = withdrawalRequest(fixture, owner, tool);
    const requested = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      request,
    );
    assert.equal(requested.revisionId, first.id);
    const recorded = () => findWithdrawals(fixture, [first, second], tool);
    assert.deepEqual(
      (await recorded()).map((withdrawal) => withdrawal?.state),
      ["pending", "pending"],
    );

    await fixture.start(compute, { transformDrivers: withCredentialGateway });
    await fixture.work(second, "succeeded", 30_000);
    await waitFor(
      "both withdrawals to be revoked",
      async () => {
        const found = await recorded();
        return found.every((withdrawal) => withdrawal?.state === "revoked") ? found : undefined;
      },
      30_000,
    );
    await fixture.stop();

    // The successor was prepared without the source and is now the active revision.
    assert.deepEqual(
      dispatched.filter(([revisionId]) => revisionId === first.id),
      [[first.id, [tool]]],
    );
    const successorDispatches = dispatched.filter(([revisionId]) => revisionId === second.id);
    assert.ok(successorDispatches.length > 0);
    assert.ok(successorDispatches.every(([, sources]) => !sources.includes(tool)));
    assert.deepEqual(
      [...withdrawn].sort(),
      [
        [first.id, tool],
        [second.id, tool],
      ].sort(),
    );
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, second.id);
    // The read follows the active revision to its own withdrawal instead of answering 404.
    const read = await fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    assert.equal(read.revisionId, second.id);
    assert.equal(read.state, "revoked");
    const audit = await fixture.observerPool.query(
      `SELECT outcome, details->>'revisionId' AS revision_id
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
       ORDER BY details->>'revisionId'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(
      audit.rows,
      [first.id, second.id]
        .sort()
        .map((revisionId) => ({ outcome: "success", revision_id: revisionId })),
    );
  },
);

revisionTest(
  "a withdrawal reaches the predecessor that runs until its successor's deployment activates",
  async (fixture) => {
    const owner = await fixture.agent("withdraw-predecessor", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
    const withdrawn = [];
    const compute = {
      ...fixture.compute,
      async withdrawCredentialSource(revision, source) {
        withdrawn.push([revision.id, source.id]);
        return { sourceId: source.id, state: "revoked" };
      },
    };
    const first = await fixture.revision(owner, 1);
    await fixture.start(compute, { transformDrivers: withCredentialGateway });
    await fixture.work(first, "succeeded");
    const second = await fixture.revision(owner, 2);
    await fixture.work(second, "succeeded", 30_000);
    await fixture.stop();

    // A worker published the third revision as active but has not yet activated it or retired
    // the second, whose Sandbox still runs with the source.
    const third = await fixture.revision(owner, 3);
    await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(fixture.namespace.id, owner.id, second.id, third.id),
    );
    const requested = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      withdrawalRequest(fixture, owner, tool),
    );
    assert.equal(requested.revisionId, third.id);
    const recorded = () => findWithdrawals(fixture, [first, second, third], tool);
    // The second deployment's activation retired the first, so only the second gets a row.
    assert.deepEqual(
      (await recorded()).map((withdrawal) => withdrawal?.state),
      [undefined, "pending", "pending"],
    );

    await fixture.start(compute, { transformDrivers: withCredentialGateway });
    await fixture.work(third, "succeeded", 30_000);
    await waitFor(
      "both withdrawals to be revoked",
      async () => {
        const found = await recorded();
        return found[1]?.state === "revoked" && found[2]?.state === "revoked" ? found : undefined;
      },
      30_000,
    );
    await fixture.stop();

    assert.deepEqual(
      [...withdrawn].sort(),
      [
        [second.id, tool],
        [third.id, tool],
      ].sort(),
    );
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, third.id);
  },
);

// Admits `number` for `owner` with its deployment held back, as one that has not run yet.
async function admitHeldRevision(fixture, owner, number) {
  const revision = await fixture.revision(owner, number);
  await fixture.observerPool.query(
    `UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 day'
     WHERE idempotency_key = $1`,
    [revision.idempotencyKey],
  );
  return revision;
}

// The withdrawal request API's target: one of the Agent's credential sources.
function withdrawalRequest(fixture, owner, credentialSourceId) {
  return { namespaceId: fixture.namespace.id, agentId: owner.id, credentialSourceId };
}

// The revision's withdrawal work rows, oldest first, each ready for fixture.work. Each row is
// one queued withdrawal; the worker may run it up to maxAttempts times (its attempt_count).
async function withdrawalAttempts(fixture, revision) {
  const { rows } = await fixture.observerPool.query(
    `SELECT idempotency_key, actor_id, state FROM occ.controller_work
     WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn'
     ORDER BY created_at`,
    [revision.id],
  );
  return rows.map(({ idempotency_key: idempotencyKey, actor_id: actorId, state }) => ({
    id: revision.id,
    idempotencyKey,
    actorId,
    state,
  }));
}

// Each revision's withdrawal of the source (or undefined), read in one State view.
function findWithdrawals(fixture, revisions, credentialSourceId) {
  return fixture.state.read((view) =>
    Promise.all(
      revisions.map((revision) =>
        view.credentialSources.findCredentialWithdrawal(
          fixture.namespace.id,
          revision.id,
          credentialSourceId,
        ),
      ),
    ),
  );
}

// The revision's withdrawal of the source, or undefined.
async function findWithdrawal(fixture, revision, credentialSourceId) {
  const [withdrawal] = await findWithdrawals(fixture, [revision], credentialSourceId);
  return withdrawal;
}

// A pending withdrawal with no attempt outstanding, as exhausted attempts leave it.
function recordPendingWithdrawal(fixture, owner, revision, credentialSourceId) {
  return fixture.state.transact((unit) =>
    unit.credentialSources.requestCredentialWithdrawal({
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: revision.id,
      credentialSourceId,
      state: "pending",
      requestedBy: fixture.actor.id,
      requestedAt: new Date().toISOString(),
    }),
  );
}

// Makes the revision's one queued maintenance pass due and waits for it to succeed.
async function runMaintenancePass(fixture, revision, message) {
  const due = await fixture.advanceMaintenance(revision);
  assert.equal(due.rowCount, 1, message);
  const pass = { id: revision.id, idempotencyKey: due.rows[0].idempotency_key };
  await fixture.work(pass, "succeeded");
  return pass;
}

// Removes the Agent principal's exact grant on one credential source.
async function removeSourceGrant(fixture, owner, credentialSourceId) {
  const removed = await fixture.observerPool.query(
    `DELETE FROM occ.iam_access_bindings
     WHERE identity_subject_id = $1 AND resource_kind = 'credential_source'
       AND resource_id = $2`,
    [owner.servicePrincipalId, credentialSourceId],
  );
  assert.equal(removed.rowCount, 1);
}

test(
  "the read reports an unretired predecessor's pending withdrawal once the active one is revoked, until its scheduled retry revokes it",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const owner = await fixture.agent("withdraw-predecessor-exhausted", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
    let third;
    let revoke = false;
    const compute = {
      ...fixture.compute,
      // The published revision has no Sandbox yet. The predecessor's still runs, and the gateway
      // cannot confirm its withdrawal until the outage ends.
      async withdrawCredentialSource(revision, source) {
        return {
          sourceId: source.id,
          state: revision.id === third?.id || revoke ? "revoked" : "pending",
        };
      },
    };
    const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
    const first = await fixture.revision(owner, 1);
    await fixture.start(compute, options);
    await fixture.work(first, "succeeded");
    const second = await fixture.revision(owner, 2);
    await fixture.work(second, "succeeded", 30_000);
    await fixture.stop();

    // A worker published the third revision as active; its deployment has not activated it or
    // retired the second (nor will it, if it fails), and no maintenance runs for either.
    third = await admitHeldRevision(fixture, owner, 3);
    await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(fixture.namespace.id, owner.id, second.id, third.id),
    );
    const request = withdrawalRequest(fixture, owner, tool);
    const requested = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      request,
    );
    assert.equal(requested.revisionId, third.id);
    assert.equal(requested.withdrawalInProgress, true);
    const read = () => fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    await fixture.start(compute, options);
    const [secondAttempt] = await withdrawalAttempts(fixture, second);
    await fixture.work(secondAttempt, "failed_permanent", 30_000);
    const [thirdAttempt] = await withdrawalAttempts(fixture, third);
    await fixture.work(thirdAttempt, "succeeded");

    // The active revision's withdrawal is revoked, but the second revision still runs with the
    // source, so the read reports its withdrawal instead of `revoked`, with its retry queued.
    const waiting = await read();
    assert.equal(waiting.revisionId, second.id);
    assert.equal(waiting.state, "pending");
    assert.equal(waiting.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
    assert.equal(waiting.withdrawalInProgress, true);
    const retry = await queuedWithdrawal(fixture, second);
    assert.equal(retry.idempotencyKey, `${secondAttempt.idempotencyKey}:recovery:1`);

    // A replay while the retry is queued queues nothing more, reports it in progress, and lets
    // the retry run now instead of at its scheduled time.
    revoke = true;
    const replayed = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      request,
    );
    assert.equal(replayed.revisionId, second.id);
    assert.equal(replayed.state, "pending");
    assert.equal(replayed.withdrawalInProgress, true);
    assert.equal((await withdrawalAttempts(fixture, third)).length, 1);
    assert.equal((await withdrawalAttempts(fixture, second)).length, 2);
    await fixture.work(retry, "succeeded");
    await fixture.stop();
    const revoked = await read();
    assert.equal(revoked.revisionId, third.id);
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.withdrawalInProgress, false);
  },
);

for (const harness of [false, true]) {
  test(
    `maintenance of the active revision re-queues an admitted successor's exhausted ${harness ? "Harness" : "tool"} source withdrawal`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await fixture.agent(`withdraw-successor-maintenance-${harness}`, {
        auth: "credential_source",
        nonModelSources: 1,
      });
      const sourceId = harness ? owner.harnessAuth.sourceId : toolSources(owner)[0].sourceId;
      let second;
      let revoke = false;
      const compute = {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        // The successor's Sandbox runs; the gateway cannot confirm its withdrawal yet.
        async withdrawCredentialSource(revision, source) {
          return {
            sourceId: source.id,
            state: revision.id !== second?.id || revoke ? "revoked" : "pending",
          };
        },
      };
      const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
      const first = await fixture.revision(owner, 1);
      await fixture.start(compute, options);
      await fixture.work(first, "succeeded");
      await fixture.stop();
      second = await admitHeldRevision(fixture, owner, 2);
      const request = withdrawalRequest(fixture, owner, sourceId);
      const read = () =>
        fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
      await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
      await fixture.start(compute, options);
      const [attempt] = await withdrawalAttempts(fixture, second);
      await fixture.work(attempt, "failed_permanent", 30_000);
      await waitFor("the active revision's withdrawal to be revoked", async () => {
        const [work] = await withdrawalAttempts(fixture, first);
        return work?.state === "succeeded" ? work : undefined;
      });
      const exhausted = await read();
      assert.equal(exhausted.revisionId, second.id);
      assert.equal(exhausted.state, "pending");
      assert.equal(exhausted.withdrawalInProgress, false);

      const runMaintenance = () =>
        runMaintenancePass(fixture, first, "the active revision's maintenance chain must continue");
      // The next maintenance pass of the active revision queues the successor's attempt again.
      revoke = true;
      await runMaintenance();
      const work = await withdrawalAttempts(fixture, second);
      assert.equal(work.length, 2, "maintenance must queue the successor's withdrawal again");
      assert.equal((await withdrawalAttempts(fixture, first)).length, 1);
      await fixture.work(work[1], "succeeded");
      const revoked = await read();
      assert.equal(revoked.revisionId, first.id);
      assert.equal(revoked.state, "revoked");

      // Revoked everywhere: nothing is queued again. A Harness-withdrawn revision's maintenance
      // then ends; a tool withdrawal leaves it running.
      await runMaintenance();
      if (harness) {
        assert.equal(
          (await fixture.advanceMaintenance(first)).rowCount,
          0,
          "maintenance stops once every withdrawal is revoked",
        );
      }
      await fixture.stop();
      assert.equal((await withdrawalAttempts(fixture, second)).length, 2);
      assert.equal((await withdrawalAttempts(fixture, first)).length, 1);
    },
  );
}

for (const successor of [false, true]) {
  test(
    `maintenance stops re-queuing ${successor ? "an admitted successor's Harness" : "a tool"} source withdrawal denied to its requester until an authorized replay`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await fixture.agent(`withdraw-denied-maintenance-${successor}`, {
        auth: "credential_source",
        nonModelSources: 1,
      });
      const sourceId = successor ? owner.harnessAuth.sourceId : toolSources(owner)[0].sourceId;
      let revoke = false;
      let iamUnavailable = false;
      const compute = {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        // The gateway cannot confirm a revocation until the outage ends.
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      };
      const options = {
        convergenceTimeoutMs: 50,
        transformDrivers: (drivers) => {
          const withGateway = withCredentialGateway(drivers);
          const createIAMDriver = withGateway.createIAMDriver;
          return {
            ...withGateway,
            createIAMDriver(state) {
              const iam = createIAMDriver(state);
              return {
                id: iam.id,
                implementation: iam.implementation,
                capability: iam.capability,
                lookupIdentity: iam.lookupIdentity.bind(iam),
                async authorize(request) {
                  if (iamUnavailable) {
                    throw new Error("IAM is temporarily unavailable");
                  }
                  return iam.authorize(request);
                },
              };
            },
          };
        },
      };
      const first = await fixture.revision(owner, 1);
      await fixture.start(compute, options);
      await fixture.work(first, "succeeded");
      await fixture.stop();
      // The withdrawal reaches the active revision and, in the successor case, a deployment
      // admitted before it that has not run yet.
      const withdrawing = successor ? [first, await admitHeldRevision(fixture, owner, 2)] : [first];

      // Another operator requests the withdrawal and is offboarded before the worker runs it,
      // so each attempt of that request is denied.
      const requester = `withdraw-denied-requester-${randomUUID()}`;
      await fixture.copyActorGrants(requester);
      const request = withdrawalRequest(fixture, owner, sourceId);
      await fixture.controller.withdrawAgentCredentialSource(requester, request);
      await removeAccessBindings(fixture, requester);
      await fixture.start(compute, options);
      for (const revision of withdrawing) {
        const [attempt] = await withdrawalAttempts(fixture, revision);
        await fixture.work(attempt, "failed_permanent");
      }
      const denials = async () =>
        (
          await fixture.observerPool.query(
            `SELECT count(*)::int AS count FROM occ.audit_events
             WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
               AND kind = 'authorization_denial'`,
            [fixture.namespace.id],
          )
        ).rows[0].count;
      assert.equal(await denials(), withdrawing.length);
      const runMaintenance = () =>
        runMaintenancePass(fixture, first, "the active revision's maintenance chain must continue");
      const attemptCounts = () =>
        Promise.all(
          withdrawing.map(async (revision) => (await withdrawalAttempts(fixture, revision)).length),
        );
      const read = () =>
        fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);

      // Only an operator who still holds operate can complete the withdrawal, so maintenance
      // queues no further denied attempt and audits no further denial, pass after pass, and
      // the read reports a withdrawal that needs a replay.
      for (let pass = 0; pass < 3; pass += 1) {
        await runMaintenance();
      }
      assert.deepEqual(
        await attemptCounts(),
        withdrawing.map(() => 1),
      );
      assert.equal(await denials(), withdrawing.length);
      const waiting = await read();
      assert.equal(waiting.state, "pending");
      assert.equal(waiting.withdrawalInProgress, false);
      assert.equal(waiting.requestedBy, requester);
      assert.equal(waiting.lastReason, "AUTHORIZATION_DENIED");

      // An authorized replay takes the withdrawal over. Its attempts run out while IAM is
      // unavailable; they record that outage, not the earlier denial, so the next maintenance
      // pass queues them again.
      iamUnavailable = true;
      const replayed = await fixture.controller.withdrawAgentCredentialSource(
        fixture.actor.id,
        request,
      );
      assert.equal(replayed.requestedBy, fixture.actor.id);
      assert.equal(replayed.withdrawalInProgress, true);
      const exhaustAttempts = async () => {
        for (const revision of withdrawing) {
          const latest = (await withdrawalAttempts(fixture, revision)).at(-1);
          await fixture.work(latest, "failed_permanent", 30_000);
        }
      };
      await exhaustAttempts();
      const iamOutage = await read();
      assert.equal(iamOutage.lastReason, "DEPENDENCY_UNAVAILABLE");
      assert.equal(iamOutage.withdrawalInProgress, false);
      iamUnavailable = false;
      await runMaintenance();
      assert.deepEqual(
        await attemptCounts(),
        withdrawing.map(() => 3),
      );

      // Those attempts run out during a gateway outage, and the next pass queues them again.
      await exhaustAttempts();
      const gatewayOutage = await read();
      assert.equal(gatewayOutage.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
      assert.equal(gatewayOutage.withdrawalInProgress, false);
      revoke = true;
      await runMaintenance();
      assert.deepEqual(
        await attemptCounts(),
        withdrawing.map(() => 4),
      );
      for (const revision of withdrawing) {
        const recovered = (await withdrawalAttempts(fixture, revision)).at(-1);
        await fixture.work(recovered, "succeeded");
      }
      await fixture.stop();
      const revoked = await read();
      assert.equal(revoked.state, "revoked");
      assert.equal(revoked.requestedBy, fixture.actor.id);
      assert.equal(await denials(), withdrawing.length);
    },
  );
}

test(
  "maintenance leaves a withdrawal Compute refused for a replay after the cause is corrected",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const owner = await fixture.agent("withdraw-refused-maintenance", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
    let refuse = true;
    let calls = 0;
    const compute = {
      ...fixture.compute,
      maintenanceIntervalMs: 3_600_000,
      // What the Kubernetes Compute Driver throws when the gateway reports another source.
      async withdrawCredentialSource(_revision, source) {
        calls += 1;
        if (refuse) {
          throw new CredentialWithdrawalRefusedError(
            "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT",
            "The Credential Gateway withdrew another credential source.",
          );
        }
        return { sourceId: source.id, state: "revoked" };
      },
    };
    const active = await fixture.revision(owner, 1);
    await fixture.start(compute, {
      convergenceTimeoutMs: 50,
      transformDrivers: withCredentialGateway,
    });
    await fixture.work(active, "succeeded");
    const request = withdrawalRequest(fixture, owner, tool);
    await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
    const [attempt] = await withdrawalAttempts(fixture, active);
    await fixture.work(attempt, "failed_permanent");

    // Retrying cannot help, so maintenance queues no further attempt, pass after pass.
    for (let pass = 0; pass < 2; pass += 1) {
      await runMaintenancePass(fixture, active, "the revision's maintenance chain must continue");
    }
    assert.equal((await withdrawalAttempts(fixture, active)).length, 1);
    assert.equal(calls, 1);
    const read = () => fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    const waiting = await read();
    assert.equal(waiting.lastReason, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
    assert.equal(waiting.withdrawalInProgress, false);

    // Once the cause is corrected, a replay revokes the source.
    refuse = false;
    await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
    const replay = (await withdrawalAttempts(fixture, active)).at(-1);
    await fixture.work(replay, "succeeded");
    await fixture.stop();
    assert.equal((await read()).state, "revoked");
  },
);

revisionTest(
  "a withdrawn Harness source fails a deployment admitted before the withdrawal",
  async (fixture) => {
    const { owner, candidate: first } = await fixture.admitInitialRevision(
      "withdraw-harness-successor",
      { agent: { auth: "credential_source" } },
    );
    const sourceId = owner.harnessAuth.sourceId;
    const prepared = [];
    const compute = {
      ...fixture.compute,
      async prepareRevision(revision, revisionContext) {
        if (revision.namespaceId === fixture.namespace.id) {
          prepared.push(revision.id);
        }
        return fixture.compute.prepareRevision(revision, revisionContext);
      },
      async withdrawCredentialSource(_revision, source) {
        return { sourceId: source.id, state: "revoked" };
      },
    };
    await fixture.start(compute, { transformDrivers: withCredentialGateway });
    await fixture.work(first, "succeeded");
    await fixture.stop();

    const second = await fixture.revision(owner, 2);
    const request = withdrawalRequest(fixture, owner, sourceId);
    await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
    await fixture.start(compute, { transformDrivers: withCredentialGateway });
    // The successor never re-attaches the model source, so its deployment cannot succeed.
    await fixture.work(second, "failed_permanent", 30_000);
    await waitFor(
      "both withdrawals to be revoked",
      async () => {
        const found = await findWithdrawals(fixture, [first, second], sourceId);
        return found.every((withdrawal) => withdrawal?.state === "revoked") ? found : undefined;
      },
      30_000,
    );
    await fixture.stop();

    assert.equal((await fixture.workResult(second)).rows[0].reason_code, "CREDENTIAL_WITHDRAWN");
    // The status names the withdrawal and the way out, not the generic failure text (D549).
    assert.deepEqual((await fixture.deploymentStatus(owner, second)).error, {
      code: "CREDENTIAL_WITHDRAWN",
      message:
        "The Harness credential source was withdrawn from this revision, so the revision cannot start. Bind a replacement source or another authentication method, then deploy again.",
    });
    assert.deepEqual(prepared, [first.id]);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, first.id);
    const read = await fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    assert.equal(read.revisionId, first.id);
    assert.equal(read.state, "revoked");
  },
);

revisionTest(
  "a withdrawal whose requester lost Agent operate fails once with a denial, and another operator's replay completes it",
  async (fixture) => {
    const { owner, candidate: active } = await fixture.admitInitialRevision("withdraw-denied", {
      agent: { auth: "credential_source" },
    });
    const withdrawn = [];
    const compute = {
      ...fixture.compute,
      async withdrawCredentialSource(revision, source) {
        withdrawn.push([revision.id, source.id]);
        return { sourceId: source.id, state: "revoked" };
      },
    };
    const startWorker = () =>
      fixture.start(compute, { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway });
    await startWorker();
    await fixture.work(active, "succeeded");
    await fixture.stop();

    // A second operator requests the withdrawal and is offboarded before the worker runs it.
    const requester = `withdraw-requester-${randomUUID()}`;
    await fixture.copyActorGrants(requester);
    const request = withdrawalRequest(fixture, owner, owner.harnessAuth.sourceId);
    const read = () => fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    await fixture.controller.withdrawAgentCredentialSource(requester, request);
    await removeAccessBindings(fixture, requester);
    const work = await withdrawalAttempts(fixture, active);
    assert.equal(work.length, 1);
    assert.equal(work[0].actorId, requester);

    await startWorker();
    const failed = await fixture.work(work[0], "failed_permanent");
    // A denial is final on the first attempt and never reaches the gateway.
    assert.equal(failed.attempt_count, 1);
    assert.deepEqual(withdrawn, []);
    const recorded = await read();
    assert.equal(recorded.state, "pending");
    assert.equal(recorded.requestedBy, requester);
    assert.equal(recorded.lastReason, "AUTHORIZATION_DENIED");
    assert.ok(recorded.lastAttemptAt);
    const audit = await fixture.observerPool.query(
      `SELECT kind, actor_id, outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [
      {
        kind: "authorization_denial",
        actor_id: requester,
        outcome: "denied",
        reason_code: "AUTHORIZATION_DENIED",
      },
    ]);

    // An authorized operator's replay queues the next attempt on its own authority, so the
    // offboarded requester cannot leave the source usable until a redeploy.
    await fixture.stop();
    const replayed = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      request,
    );
    assert.equal(replayed.state, "pending");
    assert.equal(replayed.requestedBy, fixture.actor.id);
    assert.equal(replayed.requestedAt, recorded.requestedAt);
    assert.equal(replayed.withdrawalInProgress, true);
    const retry = (await withdrawalAttempts(fixture, active)).filter(
      ({ state }) => state === "queued",
    );
    assert.equal(retry.length, 1);
    assert.equal(retry[0].actorId, fixture.actor.id);
    await startWorker();
    await fixture.work(retry[0], "succeeded");
    assert.deepEqual(withdrawn, [[active.id, owner.harnessAuth.sourceId]]);
    const revoked = await read();
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.requestedBy, fixture.actor.id);
    const revocations = await fixture.observerPool.query(
      `SELECT actor_id FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
         AND kind = 'mutation' AND outcome = 'success'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(revocations.rows, [{ actor_id: fixture.actor.id }]);

    // A revoked withdrawal is final: a replay, by another operator too, returns it unchanged
    // and queues nothing.
    await fixture.stop();
    const operator = `withdraw-operator-${randomUUID()}`;
    await fixture.copyActorGrants(operator);
    for (const principalId of [operator, fixture.actor.id]) {
      const final = await fixture.controller.withdrawAgentCredentialSource(principalId, request);
      assert.equal(final.state, "revoked");
      assert.equal(final.requestedBy, fixture.actor.id);
      assert.equal(final.withdrawalInProgress, false);
    }
    // Only the denied attempt and the replay that completed it.
    assert.equal((await withdrawalAttempts(fixture, active)).length, 2);
  },
);

revisionTest(
  "each batched withdrawal is authorized by its own requester, never the claim's actor",
  async (fixture) => {
    const withdrawn = [];
    const compute = {
      ...fixture.compute,
      async withdrawCredentialSource(revision, source) {
        withdrawn.push([revision.id, source.id]);
        return { sourceId: source.id, state: "revoked" };
      },
    };
    const startWorker = () =>
      fixture.start(compute, { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway });
    // A second operator with the actor's grants, offboarded after requesting a withdrawal.
    const offboarded = `withdraw-offboarded-${randomUUID()}`;
    const owners = [];
    for (const label of ["claim-by-offboarded", "claim-by-authorized"]) {
      const owner = await fixture.agent(label, { auth: "credential_source", nonModelSources: 2 });
      owners.push({ owner, active: await fixture.revision(owner, 1), label });
    }
    await startWorker();
    for (const { active } of owners) {
      await fixture.work(active, "succeeded");
    }
    await fixture.stop();
    // Copy the grants only now, so they include the actor's grants on both new Agents.
    await fixture.copyActorGrants(offboarded);
    // Each Agent gets one withdrawal per requester on one revision-scoped claim. The first
    // request owns the claim: the offboarded operator's for one Agent, the actor's for the other.
    const expectations = [];
    for (const { owner, active, label } of owners) {
      const [first, second] = toolSources(owner).map(({ sourceId }) => sourceId);
      const order =
        label === "claim-by-offboarded"
          ? [
              [offboarded, first],
              [fixture.actor.id, second],
            ]
          : [
              [fixture.actor.id, first],
              [offboarded, second],
            ];
      for (const [requester, credentialSourceId] of order) {
        await fixture.controller.withdrawAgentCredentialSource(
          requester,
          withdrawalRequest(fixture, owner, credentialSourceId),
        );
      }
      const work = await withdrawalAttempts(fixture, active);
      assert.equal(work.length, 1, "both requests share one revision-scoped claim");
      assert.equal(work[0].actorId, order[0][0]);
      const allowed = order.find(([requester]) => requester === fixture.actor.id)[1];
      const deniedSource = order.find(([requester]) => requester === offboarded)[1];
      expectations.push({ owner, active, work: work[0], allowed, deniedSource });
    }
    await removeAccessBindings(fixture, offboarded);

    await startWorker();
    for (const { owner, work, allowed, deniedSource } of expectations) {
      // The denied requester fails the claim, but only after the authorized one was revoked.
      await fixture.work(work, "failed_permanent");
      const read = (credentialSourceId) =>
        fixture.controller.readAgentCredentialWithdrawal(
          fixture.actor.id,
          withdrawalRequest(fixture, owner, credentialSourceId),
        );
      assert.equal((await read(allowed)).state, "revoked");
      const denied = await read(deniedSource);
      assert.equal(denied.state, "pending");
      assert.equal(denied.lastReason, "AUTHORIZATION_DENIED");
    }
    await fixture.stop();
    // No claim, whoever owned it, detached the offboarded operator's source.
    assert.deepEqual(
      withdrawn,
      expectations.map(({ active, allowed }) => [active.id, allowed]),
    );
    const audit = await fixture.observerPool.query(
      `SELECT kind, actor_id, outcome, details->>'revisionId' AS revision_id,
              details->'credentialSourceIds' AS sources
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
       ORDER BY kind DESC`,
      [fixture.namespace.id],
    );
    // Both events commit in one transaction and can share a timestamp, so order by kind.
    for (const { active, allowed, deniedSource } of expectations) {
      const rows = audit.rows.filter(({ revision_id }) => revision_id === active.id);
      assert.deepEqual(
        rows.map(({ kind, actor_id, outcome, sources }) => ({ kind, actor_id, outcome, sources })),
        [
          { kind: "mutation", actor_id: fixture.actor.id, outcome: "success", sources: [allowed] },
          {
            kind: "authorization_denial",
            actor_id: offboarded,
            outcome: "denied",
            sources: [deniedSource],
          },
        ],
      );
    }
  },
);

revisionTest(
  "a withdrawal counts an absent credential as revoked, keeps confirmed revocations through a failure, and never withdraws through another Compute",
  async (fixture) => {
    const partial = await fixture.agent("withdraw-partial", {
      auth: "credential_source",
      nonModelSources: 2,
    });
    const moved = await fixture.agent("withdraw-moved", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const partialRevision = await fixture.revision(partial, 1);
    const movedRevision = await fixture.revision(moved, 1);
    const [first, second] = toolSources(partial).map(({ sourceId }) => sourceId);
    const [movedSource] = toolSources(moved).map(({ sourceId }) => sourceId);
    const withdrawn = [];
    let failSecond = true;
    const compute = {
      ...fixture.compute,
      async withdrawCredentialSource(revision, source) {
        withdrawn.push([revision.id, source.id]);
        if (source.id === second && failSecond) {
          failSecond = false;
          throw new Error("Sandbox unreachable");
        }
        // A Sandbox that no longer holds the credential reports it absent.
        return { sourceId: source.id, state: source.id === first ? "absent" : "revoked" };
      },
    };
    const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
    await fixture.start(compute, options);
    await fixture.work(partialRevision, "succeeded");
    await fixture.work(movedRevision, "succeeded");
    await fixture.stop();

    const withdraw = async (owner, revision, credentialSourceIds) => {
      for (const credentialSourceId of credentialSourceIds) {
        await fixture.controller.withdrawAgentCredentialSource(
          fixture.actor.id,
          withdrawalRequest(fixture, owner, credentialSourceId),
        );
      }
      const work = await withdrawalAttempts(fixture, revision);
      assert.equal(work.length, 1);
      return work[0];
    };
    const read = (owner, credentialSourceId) =>
      fixture.controller.readAgentCredentialWithdrawal(
        fixture.actor.id,
        withdrawalRequest(fixture, owner, credentialSourceId),
      );

    // The first source is revoked (reported absent) before the second one fails. The retry
    // withdraws only the unconfirmed source and leaves the confirmed revocation alone.
    const partialWork = await withdraw(partial, partialRevision, [first, second]);
    await fixture.start(compute, options);
    const completed = await fixture.work(partialWork, "succeeded", 30_000);
    await fixture.stop();
    assert.equal(completed.attempt_count, 2);
    assert.deepEqual(withdrawn, [
      [partialRevision.id, first],
      [partialRevision.id, second],
      [partialRevision.id, second],
    ]);
    // Both sources end revoked, each with the reason of the pass that confirmed it.
    assert.deepEqual(
      [await read(partial, first), await read(partial, second)].map(({ state, lastReason }) => ({
        state,
        lastReason,
      })),
      [
        { state: "revoked", lastReason: "CREDENTIALS_WITHDRAWN" },
        { state: "revoked", lastReason: "CREDENTIALS_WITHDRAWN" },
      ],
    );

    // A worker for another Compute never withdraws, or confirms, a revision it does not run.
    const movedWork = await withdraw(moved, movedRevision, [movedSource]);
    await fixture.start({ ...compute, id: `${fixture.compute.id}-other` }, options);
    await fixture.work(movedWork, "failed_permanent", 30_000);
    await fixture.stop();
    assert.equal(withdrawn.length, 3);
    const pending = await read(moved, movedSource);
    assert.equal(pending.state, "pending");
    assert.equal(pending.lastReason, "COMPUTE_DRIVER_MISMATCH");
  },
);

revisionTest(
  "maintenance re-queues an exhausted non-model withdrawal and keeps repairing the revision",
  async (fixture) => {
    const owner = await fixture.agent("withdraw-tool-maintenance", {
      auth: "credential_source",
      nonModelSources: 2,
    });
    const active = await fixture.revision(owner, 1);
    const [toolSourceId, remainingToolSourceId] = toolSources(owner).map(
      ({ sourceId }) => sourceId,
    );
    const dispatched = [];
    let revoke = false;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          if (revision.id === active.id) {
            dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "succeeded");
    assert.deepEqual(dispatched, [[toolSourceId, remainingToolSourceId]]);

    // A pending tool-source withdrawal with no attempt outstanding, as an outage that
    // exhausted every attempt leaves it.
    await recordPendingWithdrawal(fixture, owner, active, toolSourceId);
    const runMaintenance = () => runMaintenancePass(fixture, active);

    // Maintenance queues a withdrawal attempt and still repairs the revision, without the tool.
    await runMaintenance();
    const [queued] = await withdrawalAttempts(fixture, active);
    assert.ok(queued, "maintenance must queue the pending withdrawal again");
    assert.deepEqual(dispatched.at(-1), [remainingToolSourceId]);

    // After the gateway recovers, that attempt revokes the source and the chain continues.
    revoke = true;
    await fixture.work(queued, "succeeded");
    const recorded = await findWithdrawal(fixture, active, toolSourceId);
    assert.equal(recorded.state, "revoked");
    await runMaintenance();
    assert.equal(
      (await withdrawalAttempts(fixture, active)).length,
      1,
      "a revoked withdrawal is not queued again",
    );

    // A revoked model source must stop preparation, but an exhausted tool withdrawal still
    // needs maintenance to recover after a gateway outage.
    const modelRequest = withdrawalRequest(fixture, owner, owner.harnessAuth.sourceId);
    const modelWithdrawal = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      modelRequest,
    );
    await waitFor("model source withdrawal to be revoked", async () => {
      const withdrawal = await fixture.controller.readAgentCredentialWithdrawal(
        fixture.actor.id,
        modelRequest,
      );
      return withdrawal.state === "revoked" ? withdrawal : undefined;
    });
    assert.equal(modelWithdrawal.state, "pending");
    const preparedBeforeWithdrawalRecovery = dispatched.length;
    await fixture.stop();
    await recordPendingWithdrawal(fixture, owner, active, remainingToolSourceId);
    revoke = false;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await runMaintenance();
    const recovered = (await withdrawalAttempts(fixture, active)).at(-1);
    assert.equal(
      (await withdrawalAttempts(fixture, active)).length,
      3,
      "maintenance must recover the remaining tool withdrawal",
    );
    assert.equal(
      dispatched.length,
      preparedBeforeWithdrawalRecovery,
      "a model-withdrawn revision must not be prepared",
    );
    revoke = true;
    await fixture.work(recovered, "succeeded");
    await runMaintenance();
    assert.equal(
      (await withdrawalAttempts(fixture, active)).length,
      3,
      "revoked tool sources must not be queued again",
    );
    assert.equal(dispatched.length, preparedBeforeWithdrawalRecovery);
    const maintenance = await fixture.observerPool.query(
      `SELECT count(*)::integer AS count FROM occ.controller_work
       WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
      [active.id, `agent_revision:${active.id}:maintenance:%`],
    );
    assert.equal(
      maintenance.rows[0].count,
      0,
      "maintenance stops only after all withdrawals are revoked",
    );
  },
);

test(
  "maintenance re-queues a withdrawal past one awaiting a replay, and never beside an outstanding attempt",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const owner = await fixture.agent("withdraw-maintenance-preference", {
      auth: "credential_source",
      nonModelSources: 2,
    });
    // Withdrawals are listed by source ID, so the one that will await a replay comes first.
    const [denied, outage] = toolSources(owner)
      .map(({ sourceId }) => sourceId)
      .sort();
    let revoke = false;
    const compute = {
      ...fixture.compute,
      maintenanceIntervalMs: 3_600_000,
      async withdrawCredentialSource(_revision, source) {
        return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
      },
    };
    const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
    const active = await fixture.revision(owner, 1);
    await fixture.start(compute, options);
    await fixture.work(active, "succeeded");
    await fixture.stop();

    // An operator who is offboarded before the worker runs requests the first withdrawal. Its
    // attempt is held back, so the second request queues none.
    const requester = `withdraw-preference-requester-${randomUUID()}`;
    await fixture.copyActorGrants(requester);
    await fixture.controller.withdrawAgentCredentialSource(
      requester,
      withdrawalRequest(fixture, owner, denied),
    );
    await removeAccessBindings(fixture, requester);
    const [held] = await withdrawalAttempts(fixture, active);
    const holdUntil = (interval) =>
      fixture.observerPool.query(
        `UPDATE occ.controller_work SET available_at = clock_timestamp() + $2::interval
         WHERE idempotency_key = $1`,
        [held.idempotencyKey, interval],
      );
    await holdUntil("1 day");
    await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      withdrawalRequest(fixture, owner, outage),
    );
    const listed = await fixture.state.read((view) =>
      view.credentialSources.listCredentialWithdrawals(fixture.namespace.id, active.id),
    );
    assert.deepEqual(
      listed.map(({ credentialSourceId }) => credentialSourceId),
      [denied, outage],
    );
    await fixture.start(compute, options);
    const runMaintenance = () =>
      runMaintenancePass(fixture, active, "the active revision's maintenance chain must continue");

    // While an attempt is outstanding, maintenance queues no other.
    await runMaintenance();
    assert.equal(
      (await withdrawalAttempts(fixture, active)).length,
      1,
      "maintenance must not queue an attempt beside an outstanding one",
    );

    // The attempts are denied for the first withdrawal, which then awaits a replay, and run out
    // during the gateway outage for the second. Maintenance still re-queues the second.
    await holdUntil("0 seconds");
    await fixture.work(held, "failed_permanent", 30_000);
    assert.equal(
      (await findWithdrawal(fixture, active, denied)).lastReason,
      "AUTHORIZATION_DENIED",
    );
    revoke = true;
    await runMaintenance();
    const attempts = await withdrawalAttempts(fixture, active);
    assert.equal(
      attempts.length,
      2,
      "maintenance must re-queue the withdrawal not awaiting a replay",
    );
    // That attempt revokes the second; the first still awaits an authorized replay.
    await fixture.work(attempts[1], "failed_permanent");
    const waiting = await findWithdrawal(fixture, active, denied);
    assert.equal(waiting.state, "pending");
    assert.equal(waiting.lastReason, "AUTHORIZATION_DENIED");
    assert.equal((await findWithdrawal(fixture, active, outage)).state, "revoked");
  },
);

test(
  "a source withdrawn before a lost repair's accepted Sandbox create lands is detached by the next pass",
  requiresPostgres,
  async (context) => {
    // A short lease, so the worker notices the expired claim on its next renewal.
    const fixture = await setup(context, { leaseDurationMs: 3_000 });
    const owner = await fixture.agent("withdraw-late-create", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const active = await fixture.revision(owner, 1);
    const [toolSourceId] = toolSources(owner).map(({ sourceId }) => sourceId);
    // The tool sources OpenShell lists on the revision's Sandbox; undefined while none exists.
    let sandbox;
    let holdCreate = false;
    let accepted;
    const attachedAtPrepare = [];
    const withdrawals = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          if (revision.id === active.id) {
            const requested = (revisionContext?.credentialSources ?? []).map(({ id }) => id);
            if (sandbox === undefined && holdCreate) {
              // OpenShell accepts this create, but the worker loses its claim before the answer.
              holdCreate = false;
              accepted = requested;
              const signal = currentComputeAbortSignal();
              await new Promise((resolve) => {
                signal.addEventListener("abort", resolve, { once: true });
              });
              throw signal.reason;
            }
            sandbox ??= new Set(requested);
            attachedAtPrepare.push([...sandbox]);
            // Like the OpenShell Sandbox Driver, adopt only a Sandbox with the requested providers.
            if (sandbox.size !== requested.length || requested.some((id) => !sandbox.has(id))) {
              throw new Error("Refusing a Sandbox without the revision's exact providers.");
            }
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source, _signal, options = {}) {
          withdrawals.push({ sourceId: source.id, recheck: options.recheck === true });
          if (sandbox === undefined) {
            // The withdrawal finds no Sandbox. The accepted create lands right after.
            sandbox = new Set(accepted);
            return { sourceId: source.id, state: "absent" };
          }
          const listed = sandbox.delete(source.id);
          if (options.recheck === true) {
            withdrawals.at(-1).listed = listed;
            // OpenShell confirms a fresh detach only once the supervisor applies it.
            return { sourceId: source.id, state: listed ? "pending" : "revoked" };
          }
          return { sourceId: source.id, state: "revoked" };
        },
      },
      {
        convergenceTimeoutMs: 50,
        transformDrivers: withCredentialGateway,
        emit: (event) => events.push(event),
      },
    );
    await fixture.work(active, "succeeded");
    assert.deepEqual([...sandbox], [toolSourceId]);
    const prepared = attachedAtPrepare.length;

    // The Sandbox is lost; the maintenance repair's create is accepted but its claim then lapses.
    sandbox = undefined;
    holdCreate = true;
    const due = await fixture.advanceMaintenance(active);
    assert.equal(due.rowCount, 1);
    const repair = { id: active.id, idempotencyKey: due.rows[0].idempotency_key };
    await waitFor("the repair's create to be accepted", async () => accepted);
    assert.deepEqual(accepted, [toolSourceId]);
    const claimed = await fixture.work(repair, "claimed");

    // The withdrawal is queued while the repair still holds the Agent, so it runs first once
    // the expired claim is recovered.
    await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      withdrawalRequest(fixture, owner, toolSourceId),
    );
    await fixture.expireClaim(repair, claimed.claim_token);
    await waitFor("the repair to lose its claim", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    const withdrawal = await waitFor("the withdrawal to record the source revoked", async () => {
      const found = await findWithdrawal(fixture, active, toolSourceId);
      return found?.state === "revoked" ? found : undefined;
    });
    assert.equal(withdrawal.lastReason, "CREDENTIALS_WITHDRAWN");

    // The late create brought the withdrawn source back. The recovered repair must detach it
    // again before it prepares, or the withdrawn credential stays usable in the Sandbox.
    await waitFor("the recovered repair to prepare", async () =>
      attachedAtPrepare.length > prepared ? true : undefined,
    );
    assert.deepEqual(attachedAtPrepare.at(-1), [], "the withdrawn source is still attached");
    assert.deepEqual(withdrawals, [
      { sourceId: toolSourceId, recheck: false },
      { sourceId: toolSourceId, recheck: true, listed: true },
    ]);
    await fixture.work(repair, "succeeded");
    // The row stays revoked and no new withdrawal attempt is queued.
    assert.equal((await findWithdrawal(fixture, active, toolSourceId)).state, "revoked");
    assert.deepEqual(
      (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
      ["succeeded"],
    );
  },
);

revisionTest(
  "a model-withdrawn revision's maintenance rechecks every revoked source, and a failed recheck keeps the chain",
  async (fixture) => {
    const owner = await fixture.agent("withdrawn-model-recheck", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const active = await fixture.revision(owner, 1);
    const modelSourceId = owner.harnessAuth.sourceId;
    const [toolSourceId] = toolSources(owner).map(({ sourceId }) => sourceId);
    const rechecked = [];
    let recheckFailure;
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async withdrawCredentialSource(revision, source, _signal, options = {}) {
          if (options.recheck === true) {
            rechecked.push([revision.id, source.id]);
            if (recheckFailure !== undefined) {
              throw recheckFailure;
            }
          }
          return { sourceId: source.id, state: "revoked" };
        },
      },
      {
        convergenceTimeoutMs: 50,
        transformDrivers: withCredentialGateway,
        emit: (event) => events.push(event),
      },
    );
    await fixture.work(active, "succeeded");
    for (const credentialSourceId of [toolSourceId, modelSourceId]) {
      const target = withdrawalRequest(fixture, owner, credentialSourceId);
      await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, target);
      await waitFor(`withdrawal of ${credentialSourceId} to be revoked`, async () => {
        const withdrawal = await fixture.controller.readAgentCredentialWithdrawal(
          fixture.actor.id,
          target,
        );
        return withdrawal.state === "revoked" ? withdrawal : undefined;
      });
    }

    // A gateway outage during the recheck ends only this pass, as REVISION_FINALIZATION_INCOMPLETE
    // (DependencyUnavailableError carries no dependency code); the chain queues the next pass
    // instead of stopping with a revoked source maybe still attached.
    recheckFailure = new DependencyUnavailableError("The Credential Gateway did not answer.");
    rechecked.length = 0;
    const due = await fixture.advanceMaintenance(active);
    assert.equal(due.rowCount, 1, "one maintenance pass is queued");
    const failed = { id: active.id, idempotencyKey: due.rows[0].idempotency_key };
    const pending = await completion(
      events,
      "the failed recheck's pass to end pending",
      (event) =>
        event.event === "worker.completed" &&
        event.workId === failed.idempotencyKey &&
        event.outcome === "pending",
    );
    assert.equal(pending.code, "REVISION_FINALIZATION_INCOMPLETE");
    assert.deepEqual(rechecked, [[active.id, modelSourceId]]);

    // The next pass rechecks every revoked source in admission order, then the chain stops:
    // all withdrawals are revoked.
    recheckFailure = undefined;
    rechecked.length = 0;
    await runMaintenancePass(fixture, active, "one maintenance pass is queued");
    assert.deepEqual(rechecked, [
      [active.id, modelSourceId],
      [active.id, toolSourceId],
    ]);
    assert.equal((await fixture.advanceMaintenance(active)).rowCount, 0);
  },
);

revisionTest(
  "maintenance keeps re-queuing withdrawals after a withdrawn source loses its Agent grant",
  async (fixture) => {
    const owner = await fixture.agent("withdrawn-grant-revoked", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const active = await fixture.revision(owner, 1);
    const toolSourceId = toolSources(owner)[0].sourceId;
    const modelSourceId = owner.harnessAuth.sourceId;
    const dispatched = [];
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          if (revision.id === active.id) {
            dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: "revoked" };
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "succeeded");
    assert.deepEqual(dispatched, [[toolSourceId]]);

    // A pending withdrawal whose attempts ran out, after which the Agent principal's grant on
    // the withdrawn source is removed. The source never attaches again either way.
    const strandWithdrawal = async (credentialSourceId) => {
      await recordPendingWithdrawal(fixture, owner, active, credentialSourceId);
      await removeSourceGrant(fixture, owner, credentialSourceId);
    };
    const runMaintenance = async () => {
      const due = await fixture.advanceMaintenance(active);
      assert.equal(due.rowCount, 1, "the maintenance chain must continue");
      const settled = await waitFor("the maintenance pass to settle", async () => {
        const rows = await fixture.observerPool.query(
          `SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1`,
          [due.rows[0].idempotency_key],
        );
        return ["succeeded", "failed_permanent"].includes(rows.rows[0]?.state)
          ? rows.rows[0]
          : undefined;
      });
      assert.equal(settled.state, "succeeded", `maintenance ended ${settled.reason_code}`);
    };
    const withdrawalState = async (credentialSourceId) =>
      (await findWithdrawal(fixture, active, credentialSourceId)).state;

    // A tool source: maintenance re-queues its withdrawal and repairs the revision without it.
    await strandWithdrawal(toolSourceId);
    await runMaintenance();
    const [toolWithdrawal, ...extra] = await withdrawalAttempts(fixture, active);
    assert.ok(toolWithdrawal, "maintenance must queue the pending tool withdrawal again");
    assert.deepEqual(extra, []);
    assert.deepEqual(dispatched.at(-1), []);
    await fixture.work(toolWithdrawal, "succeeded");
    assert.equal(await withdrawalState(toolSourceId), "revoked");

    // The model source: maintenance re-queues its withdrawal without preparing the revision.
    await strandWithdrawal(modelSourceId);
    const prepared = dispatched.length;
    await runMaintenance();
    const work = await withdrawalAttempts(fixture, active);
    assert.equal(work.length, 2, "maintenance must queue the pending model withdrawal again");
    const modelWithdrawal = work[1];
    await fixture.work(modelWithdrawal, "succeeded");
    assert.equal(await withdrawalState(modelSourceId), "revoked");
    await runMaintenance();
    assert.equal(dispatched.length, prepared, "a model-withdrawn revision must not be prepared");
  },
);

revisionTest(
  "an Agent that loses operate on a non-model source after admission never attaches it",
  async (fixture) => {
    const owner = await fixture.agent("tool-grant-revoked", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const toolSourceId = toolSources(owner)[0].sourceId;
    const active = await fixture.revision(owner, 1);
    // The Agent principal's exact grant is removed between admission and dispatch.
    await removeSourceGrant(fixture, owner, toolSourceId);
    const prepared = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "failed_permanent");
    const failed = await fixture.observerPool.query(
      "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [active.idempotencyKey],
    );
    assert.equal(failed.rows[0].reason_code, "AUTHORIZATION_DENIED");
    // Compute never prepared the revision, so the gateway never attached the source.
    assert.deepEqual(prepared, []);
  },
);

revisionTest(
  "maintenance still rechecks the grants on every source that is not withdrawn",
  async (fixture) => {
    const owner = await fixture.agent("withdrawn-other-grant", {
      auth: "credential_source",
      nonModelSources: 1,
    });
    const active = await fixture.revision(owner, 1);
    const toolSourceId = toolSources(owner)[0].sourceId;
    const modelSourceId = owner.harnessAuth.sourceId;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: "revoked" };
        },
      },
      { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway },
    );
    await fixture.work(active, "succeeded");

    // The tool source has a pending withdrawal. The Agent principal then loses its grant on the
    // model source, which is not withdrawn and still attaches, so maintenance must refuse.
    await recordPendingWithdrawal(fixture, owner, active, toolSourceId);
    await removeSourceGrant(fixture, owner, modelSourceId);
    const due = await fixture.advanceMaintenance(active);
    assert.equal(due.rowCount, 1);
    const settled = await waitFor("the maintenance pass to settle", async () => {
      const rows = await fixture.observerPool.query(
        `SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1`,
        [due.rows[0].idempotency_key],
      );
      return ["succeeded", "failed_permanent"].includes(rows.rows[0]?.state)
        ? rows.rows[0]
        : undefined;
    });
    assert.deepEqual(settled, { state: "failed_permanent", reason_code: "AUTHORIZATION_DENIED" });
  },
);

revisionTest(
  "a withdrawal finds a Harness source on a revision admitted before credential source lists",
  async (fixture) => {
    // Revisions admitted before migration 0050 hold their Harness credential source only as
    // harnessAuth: their admitted spec has no credential_sources key, and 0050 backfilled only
    // Agents. Withdrawal must still find the source there.
    const owner = await fixture.agent("withdraw-legacy", { auth: "credential_source" });
    const sourceId = owner.harnessAuth.sourceId;
    const listed = await fixture.revision(owner, 1);
    const legacyRevision = async (number) => {
      const id = `rev_${randomUUID()}`;
      await fixture.observerPool.query(
        `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
         SELECT $2, namespace_id, agent_id, $3, backend_id, admitted_spec - 'credential_sources',
                clock_timestamp()
         FROM occ.agent_revisions WHERE id = $1`,
        [listed.id, id, number],
      );
      const revision = await fixture.state.read((view) =>
        view.revisions.findRevision(fixture.namespace.id, owner.id, id),
      );
      assert.equal(revision.harnessAuth.sourceId, sourceId);
      assert.equal(revision.credentialSources, undefined);
      return revision;
    };
    const legacy = await legacyRevision(2);
    const successor = await legacyRevision(3);
    assert.ok(
      await fixture.state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          fixture.namespace.id,
          owner.id,
          undefined,
          legacy.id,
        ),
      ),
      "the fixture Agent must have no active revision yet",
    );

    const requested = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      withdrawalRequest(fixture, owner, sourceId),
    );
    assert.equal(requested.revisionId, legacy.id);
    assert.equal(requested.state, "pending");
    // The admitted legacy successor gets its own withdrawal too. So does the older revision:
    // no deployment has activated the legacy revision yet, so nothing has retired it.
    const recorded = await findWithdrawals(fixture, [listed, legacy, successor], sourceId);
    assert.deepEqual(
      recorded.map((withdrawal) => withdrawal?.state),
      ["pending", "pending", "pending"],
    );
  },
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
  async (fixture, context) => {
    const unscheduled = await fixture.agent("pending-unschedulable");
    const unpaired = await fixture.agent("pending-node");
    const unscheduledRevision = await fixture.revision(unscheduled, 1);
    const unpairedRevision = await fixture.revision(unpaired, 1);
    const reasons = new Map([
      [unscheduledRevision.id, "WORKLOAD_UNSCHEDULABLE"],
      [unpairedRevision.id, "WORKSPACE_NODE_PENDING"],
    ]);
    const delays = [];
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
            event.workId === unpairedRevision.idempotencyKey &&
            event.outcome === "pending"
          ) {
            delays.push(
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
    const fresh = await delays[0];
    assert.ok(fresh > 450 && fresh <= 500, `a new deployment rechecks in 500 ms (${fresh} ms)`);

    // Five minutes later, still inside the 900-second deadline, a runtime that
    // stays unready is rechecked every 5 s, so one stuck Agent cannot take most
    // of the serial worker (D223). Only the worker's wall clock moves.
    const realNow = Date.now;
    Date.now = () => realNow() + 300_000;
    context.after(() => {
      Date.now = realNow;
    });
    const seen = delays.length;
    await waitFor("a recheck after five minutes", async () => delays.length > seen || undefined);
    const old = await delays[seen];
    Date.now = realNow;
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
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "CONVERGENCE_DEADLINE_EXCEEDED",
      message: "Deployment convergence deadline exceeded.",
      data: { timeoutMs: 1, runtimeFailure },
    });
    assert.deepEqual(status.warnings, []);
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
        message: "Deployment runtime credentials were rejected.",
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
        message: "Deployment runtime did not get enough CPU to start.",
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
            message: "Deployment runtime startup model check timed out.",
          },
        },
      },
      {
        label: "held-runtime-1",
        runtimeFailure: probeStatusFailure,
        // Only failed model probes retain their classified runtime evidence.
        expected: {
          resultData: { runtimeFailure: probeStatusFailure },
          error: {
            code: "RUNTIME_MODEL_PROBE_FAILED",
            message: "Deployment runtime startup model check failed.",
            data: { runtimeFailure: probeStatusFailure },
          },
        },
      },
      {
        label: "held-runtime-2",
        runtimeFailure: wrapperFailure,
        expected: {
          resultData: { runtimeFailure: wrapperFailure },
          error: {
            code: "RUNTIME_MODEL_PROBE_FAILED",
            message: "Deployment runtime startup model check failed.",
            data: { runtimeFailure: wrapperFailure },
          },
        },
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
            message: "Deployment runtime could not sign in to the model provider.",
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
            message: "Deployment runtime failed a startup check.",
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
          "OpenShell v0.1.3-pre.2 cannot receive secretKeyRef environment APP_SERVER_TOKEN.",
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
  "a revision whose Harness or listed credential source is no longer ready fails with a fixed status message",
  async (fixture) => {
    // Admission saw ready sources; each was marked deleting before dispatch, so the worker fails
    // the revision without preparing it. The status names the cause and the fix, without IDs,
    // instead of the generic "Deployment reconciliation failed." (D549).
    const harness = await fixture.admitInitialRevision("harness-source-deleting", {
      agent: { auth: "credential_source" },
    });
    const listed = await fixture.admitInitialRevision("listed-source-deleting", {
      agent: { auth: "credential_source", nonModelSources: 1 },
    });
    const [tool] = toolSources(listed.owner);
    await fixture.state.transact(async (unit) => {
      for (const sourceId of [harness.owner.harnessAuth.sourceId, tool.sourceId]) {
        assert.ok(
          await unit.credentialSources.markCredentialSourceDeleting(fixture.namespace.id, sourceId),
        );
      }
    });
    const prepared = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
      },
      { transformDrivers: withCredentialGateway },
    );
    await fixture.work(harness.candidate, "failed_permanent");
    await fixture.work(listed.candidate, "failed_permanent");
    await fixture.stop();
    assert.deepEqual(prepared, []);
    for (const [{ owner, candidate }, error] of [
      [
        harness,
        {
          code: "HARNESS_AUTH_SOURCE_UNAVAILABLE",
          message:
            "The Harness authentication source this revision was admitted with is missing, being deleted, or changed since admission. Bind an available source, then deploy again.",
        },
      ],
      [
        listed,
        {
          code: "CREDENTIAL_SOURCE_UNAVAILABLE",
          message:
            "A credential source this revision lists is missing, being deleted, or changed since admission. Bind available sources, then deploy again.",
        },
      ],
    ]) {
      const status = await fixture.deploymentStatus(owner, candidate);
      assert.equal(status.status, "failed", error.code);
      assert.deepEqual(status.error, error);
    }
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

      await fixture.start(
        {
          ...fixture.compute,
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
