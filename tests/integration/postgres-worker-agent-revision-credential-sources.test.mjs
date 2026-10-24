import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import {
  CredentialWithdrawalRefusedError,
  DependencyUnavailableError,
  ResourceStateConflictError,
  SandboxGatewayUnauthorizedError,
} from "../../packages/occ/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { occLogLine } from "../helpers/occ-log-line.ts";
import { withNamespaceLockHeld } from "../helpers/postgres-namespace-lock.mjs";
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
  withUnavailableIAM,
} from "../helpers/postgres-worker-revision-support.mjs";
import { gitCommandBodies, gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import { openShellOnlineGitWire } from "../helpers/openshell-online-git-wire.mjs";
import { invoke, token } from "../helpers/openshell-online-wire.mjs";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";

// Credential sources on revision work: withdrawals (retries, replays, denials and maintenance
// re-queues), and listed sources that lose their grant or readiness after admission. Deployment,
// dispatch, convergence and the persisted lifecycle are in postgres-worker-agent-revision.test.mjs;
// the lane runs the revision files at once.

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
    validateSourceConfig() {},
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

function admitInitialRevisionWithHarnessSource(fixture, label) {
  return fixture.admitInitialRevision(label, { agent: { auth: "credential_source" } });
}

function agentWithHarnessAndToolSources(fixture, label, nonModelSources) {
  return fixture.agent(label, { auth: "credential_source", nonModelSources });
}

// The Agent's list starts with its Harness source; the remaining entries are tool sources.
function toolSources(owner) {
  return owner.credentialSources.filter(({ sourceId }) => sourceId !== owner.harnessAuth?.sourceId);
}

revisionTest(
  "credential withdrawal work revokes from the active revision without redeploying it",
  async (fixture) => {
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-target",
    );
    const prepared = [];
    const withdrawn = [];
    let pendingOnce = true;
    await startWithGateway(fixture, {
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
    });
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

function revokingCompute(fixture, withdrawn) {
  return {
    ...fixture.compute,
    async withdrawCredentialSource(revision, source) {
      withdrawn.push([revision.id, source.id]);
      return { sourceId: source.id, state: "revoked" };
    },
  };
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
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-outage",
    );
    const { gateway, compute } = gatewayOutage(fixture);
    await startWithGateway(fixture, compute);
    await fixture.work(active, "succeeded");
    const sourceId = owner.harnessAuth.sourceId;
    const withdrawal = await requestWithdrawal(fixture, owner, sourceId, fixture.actor.id);
    const [first] = await withdrawalAttempts(fixture, active);
    await fixture.work(first, "failed_permanent");

    // The outage outlasted the attempt budget. The withdrawal stays pending with its reason, and
    // the failing pass already queued a retry for 30 s later, so the read still reports an
    // attempt coming rather than asking for a replay.
    const waiting = await withdrawal.read(fixture.actor.id);
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
    const revoked = await withdrawal.read(fixture.actor.id);
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-delete", 1);
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
      assert.match(
        error.message,
        /^An Agent, active revision, pending deployment, or provisioning request/,
      );
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
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-long-outage",
    );
    const { gateway, compute } = gatewayOutage(fixture);
    const calls = () => gateway.withdrawn.length;
    await startWithGateway(fixture, compute);
    const { withdrawal, firstAttempt } = await startHarnessWithdrawal(fixture, owner, active);
    await fixture.work(firstAttempt, "failed_permanent");

    // A scheduled retry does not run before it is due, so a gateway that stays down is not
    // called in a loop.
    await delay(1_000);
    assert.equal(calls(), 1);
    // Each retry waits twice as long as the one before, up to 5 minutes, about an hour in all.
    const delays = [30_000, 60_000, 120_000, 240_000, ...Array(11).fill(300_000)];
    for (const [index, delayMs] of delays.entries()) {
      const retry = await queuedWithdrawal(fixture, active);
      assert.equal(retry.idempotencyKey, `${firstAttempt.idempotencyKey}:recovery:${index + 1}`);
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
    const exhausted = await withdrawal.read(fixture.actor.id);
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
    // The replay's series is due at once, so the worker stops first: a running worker could claim
    // it before it is read here.
    await fixture.stop();
    gateway.down = false;
    const replayed = await withdrawal.replay(fixture.actor.id);
    assert.equal(replayed.withdrawalInProgress, true);
    const replay = await queuedWithdrawal(fixture, active);
    assert.ok(!replay.idempotencyKey.startsWith(firstAttempt.idempotencyKey));
    await startWithGateway(fixture, compute);
    await fixture.work(replay, "succeeded");
    const revoked = await withdrawal.read(fixture.actor.id);
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.withdrawalInProgress, false);
  },
);

test(
  "a withdrawal retried after an outage leaves one denied to its requester for a replay",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-outage-denied", 2);
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
    const allowedWithdrawal = await requestWithdrawal(fixture, owner, allowed, fixture.actor.id);
    const deniedWithdrawal = await requestWithdrawal(fixture, owner, deniedSource, offboarded);
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
    assert.equal((await allowedWithdrawal.read(fixture.actor.id)).state, "revoked");
    const denied = await deniedWithdrawal.read(fixture.actor.id);
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
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-lost-lease",
    );
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
    const { withdrawal, firstAttempt } = await startHarnessWithdrawal(fixture, owner, active);

    // The lease runs out during the last attempt, so stale-claim recovery fails the work, not
    // the worker's final pass. It still queues the next series.
    await lastAttempt.promise;
    const claimed = await fixture.work(firstAttempt, "claimed");
    assert.equal(claimed.attempt_count, 2);
    assert.equal((await fixture.expireClaim(firstAttempt, claimed.claim_token)).rowCount, 1);
    lastAttemptReleased.resolve();
    await fixture.work(firstAttempt, "failed_permanent");
    assert.equal((await fixture.workResult(firstAttempt)).rows[0].reason_code, "LEASE_EXPIRED");
    const retry = await waitFor("the next series after a lost lease", async () => {
      const { rowCount } = await fixture.observerPool.query(
        `SELECT 1 FROM occ.controller_work
         WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn' AND state = 'queued'`,
        [active.id],
      );
      return rowCount === 1 ? queuedWithdrawal(fixture, active) : undefined;
    });
    assert.equal(retry.idempotencyKey, `${firstAttempt.idempotencyKey}:recovery:1`);
    assertRetryDelay(retry, 30_000);
    const waiting = await withdrawal.read(fixture.actor.id);
    assert.equal(waiting.state, "pending");
    assert.equal(waiting.withdrawalInProgress, true);

    // The gateway is back. Nobody replays: the scheduled retry revokes the source.
    gateway.down = false;
    await runScheduledRetryNow(fixture, retry);
    await fixture.work(retry, "succeeded");
    const revoked = await withdrawal.read(fixture.actor.id);
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
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-replay-series",
    );
    const { gateway, compute } = gatewayOutage(fixture);
    await startWithGateway(fixture, compute);
    await fixture.work(active, "succeeded");

    // An operator withdraws the source. The first series fails in a gateway outage and queues
    // the next one for 30 s later; then the operator is offboarded.
    const offboarded = `withdraw-replay-offboarded-${randomUUID()}`;
    await fixture.copyActorGrants(offboarded);
    const withdrawal = await requestWithdrawal(
      fixture,
      owner,
      owner.harnessAuth.sourceId,
      offboarded,
    );
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
    const replayed = await withdrawal.replay(fixture.actor.id);
    assert.equal(replayed.requestedBy, fixture.actor.id);
    assert.equal(replayed.withdrawalInProgress, true);
    const due = await queuedWithdrawal(fixture, active);
    assert.equal(due.idempotencyKey, series.idempotencyKey);
    assert.ok(due.delayMs <= 0, `expected the series to be due now, got ${due.delayMs} ms`);
    assert.equal((await withdrawalAttempts(fixture, active)).length, 2);

    await startWithGateway(fixture, compute);
    await fixture.work(due, "succeeded");
    const revoked = await withdrawal.read(fixture.actor.id);
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-replay-running", 2);
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
    const deniedWithdrawal = await requestWithdrawal(fixture, owner, deniedSource, offboarded);
    await removeAccessBindings(fixture, offboarded);
    const [work, ...others] = await withdrawalAttempts(fixture, active);
    assert.deepEqual(others, []);

    // The attempt has denied the offboarded requester and is revoking the authorized source
    // when the actor replays the denied withdrawal. The running attempt is its only work.
    await startWithGateway(fixture, compute);
    await gatewayCall.promise;
    const replayed = await deniedWithdrawal.replay(fixture.actor.id);
    assert.equal(replayed.requestedBy, fixture.actor.id);
    assert.equal(replayed.withdrawalInProgress, true);
    assert.equal((await withdrawalAttempts(fixture, active)).length, 1);

    // The denial no longer stands, so the attempt retries on the actor's authority.
    gatewayReleased.resolve();
    const completed = await fixture.work(work, "succeeded");
    await fixture.stop();
    assert.equal(completed.attempt_count, 2);
    assert.deepEqual(withdrawn, [allowed, deniedSource]);
    const denied = await deniedWithdrawal.read(fixture.actor.id);
    assert.equal(denied.state, "revoked");
    assert.equal(denied.requestedBy, fixture.actor.id);
    assert.deepEqual(await withdrawalAudit(fixture, "actor_id", "outcome", "sources"), [
      { actor_id: fixture.actor.id, outcome: "success", sources: [allowed] },
      { actor_id: fixture.actor.id, outcome: "success", sources: [deniedSource] },
    ]);
  },
);

// Each refusal runs twice. Without a maintenance interval, a permanent failure queues no
// recovery series (only a retryable one does). With one, the refusals differ once the attempt
// fails: an operator must correct a misconfiguration and then replay, so maintenance leaves it;
// a gateway refusal ends once the controller identity's Workspace role is restored, so
// maintenance queues it again (finding 1874).
for (const { name, maintenanceName, fixtureName, createRefusal, expectedReason, requeued } of [
  {
    name: "a withdrawal Compute refuses as misconfigured fails once and queues no later series",
    maintenanceName:
      "maintenance leaves a withdrawal Compute refused as misconfigured for a replay",
    fixtureName: "withdraw-refused",
    // Simulate a SandboxDriver that cannot name the revision's Sandbox.
    createRefusal: () =>
      new CredentialWithdrawalRefusedError(
        "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
        "Credential withdrawal requires a SandboxDriver that identifies the revision's Harness.",
      ),
    expectedReason: "CREDENTIAL_WITHDRAWAL_MISCONFIGURED",
    requeued: false,
  },
  {
    name: "a withdrawal the Sandbox gateway refuses to confirm fails once with SANDBOX_GATEWAY_UNAUTHORIZED",
    maintenanceName: "maintenance queues a withdrawal the Sandbox gateway refused to confirm again",
    fixtureName: "withdraw-unauthorized",
    // Simulate OpenShell refusing the controller identity, making a missing Sandbox
    // indistinguishable from a hidden one (finding 1676).
    createRefusal: () =>
      new SandboxGatewayUnauthorizedError(
        "OpenShell refused the controller gateway identity in Workspace oce-test, so the credential of Sandbox sb-test cannot be confirmed withdrawn.",
      ),
    expectedReason: "SANDBOX_GATEWAY_UNAUTHORIZED",
    requeued: true,
  },
]) {
  for (const maintenance of [false, true]) {
    test(maintenance ? maintenanceName : name, requiresPostgres, async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
        fixture,
        maintenance ? `${fixtureName}-maintenance` : fixtureName,
      );
      let calls = 0;
      await startWithGateway(fixture, {
        ...fixture.compute,
        ...(maintenance ? { maintenanceIntervalMs: 3_600_000 } : {}),
        async withdrawCredentialSource() {
          calls += 1;
          throw createRefusal();
        },
      });
      const { withdrawal, firstAttempt } = await startHarnessWithdrawal(fixture, owner, active);

      // A terminal refusal cannot be fixed by retrying, and withdrawal remains unconfirmed.
      const failed = await fixture.work(firstAttempt, "failed_permanent");
      assert.equal(failed.attempt_count, 1);
      assert.equal(calls, 1);
      assert.equal((await fixture.workResult(firstAttempt)).rows[0].reason_code, expectedReason);
      assert.deepEqual(
        (await withdrawalAttempts(fixture, active)).map(({ state }) => state),
        ["failed_permanent"],
      );
      const read = await withdrawal.read(fixture.actor.id);
      assert.equal(read.state, "pending");
      assert.equal(read.lastReason, expectedReason);
      assert.equal(read.withdrawalInProgress, false);
      assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
        { outcome: "failure", reason_code: expectedReason },
      ]);
      if (!maintenance) {
        return;
      }

      // The revision's next maintenance pass decides whether the refusal is attempted again.
      await runMaintenancePass(fixture, active);
      const attempts = await withdrawalAttempts(fixture, active);
      if (requeued) {
        assert.equal(attempts.length, 2, "maintenance must queue the refused withdrawal again");
        assert.equal(attempts[1].actorId, fixture.actor.id);
        await fixture.work(attempts[1], "failed_permanent");
        assert.equal(calls, 2);
        assert.equal((await fixture.workResult(attempts[1])).rows[0].reason_code, expectedReason);
      } else {
        assert.deepEqual(
          attempts.map(({ state }) => state),
          ["failed_permanent"],
          "maintenance must leave the refused withdrawal for a replay",
        );
        assert.equal(calls, 1);
        assert.equal((await withdrawal.read(fixture.actor.id)).withdrawalInProgress, false);
      }
    });
  }
}

// Finding 1694: OpenShell also answers UNAUTHENTICATED while the controller's token file or
// the gateway's signing keys are between refreshes. That refusal keeps its reason but retries
// within the attempt budget, as an outage does, and a persistent one fails with the code only
// once the budget is spent.
test(
  "a withdrawal refused as unauthenticated retries before it settles or fails with the code",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-unauthenticated",
    );
    const { gateway, compute } = gatewayOutage(fixture);
    const events = [];
    let refusals = 1;
    await fixture.start(
      {
        ...compute,
        async withdrawCredentialSource(revision, source, signal) {
          if (refusals > 0) {
            refusals -= 1;
            throw new SandboxGatewayUnauthorizedError(
              "OpenShell refused the controller gateway identity in Workspace oce-test, so the credential of Sandbox sb-test cannot be confirmed withdrawn.",
              { transient: true },
            );
          }
          return compute.withdrawCredentialSource(revision, source, signal);
        },
      },
      {
        convergenceTimeoutMs: 50,
        transformDrivers: withCredentialGateway,
        emit: (event) => events.push(event),
      },
    );
    gateway.down = false;
    const { withdrawal, firstAttempt } = await startHarnessWithdrawal(fixture, owner, active);
    // The first attempt is refused and retried with its reason; the second revokes.
    const settled = await fixture.work(firstAttempt, "succeeded");
    assert.equal(settled.attempt_count, 2);
    assert.equal(gateway.withdrawn.length, 1);
    const revoked = await withdrawal.read(fixture.actor.id);
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.lastReason, "CREDENTIALS_WITHDRAWN");
    const completed = events
      .filter(
        ({ event, code }) =>
          event === "worker.completed" && code === "SANDBOX_GATEWAY_UNAUTHORIZED",
      )
      .map(occLogLine);
    assert.deepEqual(
      completed.map(({ outcome, hintCode }) => [outcome, hintCode]),
      [["retry", undefined]],
    );

    // A refusal that outlasts the budget fails with the code, logged with the operator guidance,
    // and nothing is recorded revoked.
    const other = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-unauthenticated-persistent",
    );
    refusals = Number.POSITIVE_INFINITY;
    const { withdrawal: otherWithdrawal, firstAttempt: persistent } = await startHarnessWithdrawal(
      fixture,
      other.owner,
      other.candidate,
    );
    const failed = await fixture.work(persistent, "failed_permanent");
    assert.equal(failed.attempt_count, 2);
    assert.equal(
      (await fixture.workResult(persistent)).rows[0].reason_code,
      "SANDBOX_GATEWAY_UNAUTHORIZED",
    );
    const pending = await otherWithdrawal.read(fixture.actor.id);
    assert.equal(pending.state, "pending");
    assert.equal(pending.lastReason, "SANDBOX_GATEWAY_UNAUTHORIZED");
    // Like any withdrawal that ran out of attempts, it enters the recovery series, which is why
    // one failure audit and one guidance line are enough here: the series logs its own.
    const recovery = await queuedWithdrawal(fixture, other.candidate);
    assert.equal(recovery.idempotencyKey, `${persistent.idempotencyKey}:recovery:1`);
    assertRetryDelay(recovery, 30_000);
    // The lines the worker log keeps (finding 2245).
    const terminal = events
      .map(occLogLine)
      .filter(
        ({ event, code, hintCode }) =>
          event === "worker.completed" &&
          code === "SANDBOX_GATEWAY_UNAUTHORIZED" &&
          hintCode !== undefined,
      );
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].hintCode, "sandbox-gateway-identity");
    // The Driver's retry, the queue's permanent failure (with the recovery series queued).
    assert.deepEqual(
      [terminal[0].attempt, terminal[0].result, terminal[0].outcome],
      [2, "retry", "permanent"],
    );
    assert.deepEqual(await withdrawalAudit(fixture, "outcome", "reason_code"), [
      { outcome: "success", reason_code: "CREDENTIALS_WITHDRAWN" },
      { outcome: "failure", reason_code: "SANDBOX_GATEWAY_UNAUTHORIZED" },
    ]);
  },
);

test(
  "a terminally failing credential withdrawal takes the Namespace and Agent before its withdrawal rows",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-lock-order",
    );
    let calls = 0;
    const lastAttempt = Promise.withResolvers();
    const lastAttemptReleased = Promise.withResolvers();
    await startWithGateway(fixture, {
      ...fixture.compute,
      async withdrawCredentialSource(_revision, source) {
        // The last attempt stays pending, so the worker fails the work permanently.
        if (++calls === 2) {
          lastAttempt.resolve();
          await lastAttemptReleased.promise;
        }
        return { sourceId: source.id, state: "pending" };
      },
    });
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
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-maintenance",
    );
    const prepared = [];
    let revoke = false;
    await startWithGateway(fixture, {
      ...fixture.compute,
      maintenanceIntervalMs: 3_600_000,
      async prepareRevision(revision, revisionContext) {
        prepared.push(revision.id);
        return fixture.compute.prepareRevision(revision, revisionContext);
      },
      async withdrawCredentialSource(_revision, source) {
        return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
      },
    });
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
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-during-activation",
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-tool-sources", 2);
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-successor", 1);
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
    const withdrawal = await requestWithdrawal(fixture, owner, tool, fixture.actor.id);
    assert.equal(withdrawal.initial.revisionId, first.id);
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
    const read = await withdrawal.read(fixture.actor.id);
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-predecessor", 1);
    const [tool] = toolSources(owner).map(({ sourceId }) => sourceId);
    const withdrawn = [];
    const compute = revokingCompute(fixture, withdrawn);
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

// Request one Agent source; reads and replays keep that target while naming their own principal.
async function requestWithdrawal(fixture, owner, credentialSourceId, requester) {
  const target = withdrawalRequest(fixture, owner, credentialSourceId);
  const initial = await fixture.controller.withdrawAgentCredentialSource(requester, target);
  return {
    initial,
    read: (reader) => fixture.controller.readAgentCredentialWithdrawal(reader, target),
    replay: (requester) => fixture.controller.withdrawAgentCredentialSource(requester, target),
  };
}

async function startHarnessWithdrawal(fixture, owner, active) {
  await fixture.work(active, "succeeded");
  const withdrawal = await requestWithdrawal(
    fixture,
    owner,
    owner.harnessAuth.sourceId,
    fixture.actor.id,
  );
  const [firstAttempt] = await withdrawalAttempts(fixture, active);
  return { withdrawal, firstAttempt };
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

// Makes the revision's one queued maintenance pass due without waiting for it to run.
async function makeMaintenancePassDue(fixture, revision) {
  const due = await fixture.advanceMaintenance(revision);
  assert.equal(due.rowCount, 1, "one maintenance pass is queued");
  return { id: revision.id, idempotencyKey: due.rows[0].idempotency_key };
}

function waitForMaintenancePass(fixture, pass) {
  return waitFor("the maintenance pass to settle", async () => {
    const { rows } = await fixture.observerPool.query(
      `SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1`,
      [pass.idempotencyKey],
    );
    return ["succeeded", "failed_permanent"].includes(rows[0]?.state) ? rows[0] : undefined;
  });
}

async function runMaintenancePass(fixture, revision) {
  const pass = await makeMaintenancePassDue(fixture, revision);
  const settled = await waitForMaintenancePass(fixture, pass);
  assert.equal(settled.state, "succeeded", `maintenance ended ${settled.reason_code}`);
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
    const owner = await agentWithHarnessAndToolSources(
      fixture,
      "withdraw-predecessor-exhausted",
      1,
    );
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
    const withdrawal = await requestWithdrawal(fixture, owner, tool, fixture.actor.id);
    assert.equal(withdrawal.initial.revisionId, third.id);
    assert.equal(withdrawal.initial.withdrawalInProgress, true);
    await fixture.start(compute, options);
    const [secondAttempt] = await withdrawalAttempts(fixture, second);
    await fixture.work(secondAttempt, "failed_permanent", 30_000);
    const [thirdAttempt] = await withdrawalAttempts(fixture, third);
    await fixture.work(thirdAttempt, "succeeded");

    // The active revision's withdrawal is revoked, but the second revision still runs with the
    // source, so the read reports its withdrawal instead of `revoked`, with its retry queued.
    const waiting = await withdrawal.read(fixture.actor.id);
    assert.equal(waiting.revisionId, second.id);
    assert.equal(waiting.state, "pending");
    assert.equal(waiting.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
    assert.equal(waiting.withdrawalInProgress, true);
    const retry = await queuedWithdrawal(fixture, second);
    assert.equal(retry.idempotencyKey, `${secondAttempt.idempotencyKey}:recovery:1`);

    // A replay while the retry is queued queues nothing more, reports it in progress, and lets
    // the retry run now instead of at its scheduled time.
    revoke = true;
    const replayed = await withdrawal.replay(fixture.actor.id);
    assert.equal(replayed.revisionId, second.id);
    assert.equal(replayed.state, "pending");
    assert.equal(replayed.withdrawalInProgress, true);
    assert.equal((await withdrawalAttempts(fixture, third)).length, 1);
    assert.equal((await withdrawalAttempts(fixture, second)).length, 2);
    await fixture.work(retry, "succeeded");
    await fixture.stop();
    const revoked = await withdrawal.read(fixture.actor.id);
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
      const owner = await agentWithHarnessAndToolSources(
        fixture,
        `withdraw-successor-maintenance-${harness}`,
        1,
      );
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
      const withdrawal = await requestWithdrawal(fixture, owner, sourceId, fixture.actor.id);
      await fixture.start(compute, options);
      const [attempt] = await withdrawalAttempts(fixture, second);
      await fixture.work(attempt, "failed_permanent", 30_000);
      await waitFor("the active revision's withdrawal to be revoked", async () => {
        const [work] = await withdrawalAttempts(fixture, first);
        return work?.state === "succeeded" ? work : undefined;
      });
      const exhausted = await withdrawal.read(fixture.actor.id);
      assert.equal(exhausted.revisionId, second.id);
      assert.equal(exhausted.state, "pending");
      assert.equal(exhausted.withdrawalInProgress, false);

      // The next maintenance pass of the active revision queues the successor's attempt again.
      revoke = true;
      await runMaintenancePass(fixture, first);
      const work = await withdrawalAttempts(fixture, second);
      assert.equal(work.length, 2, "maintenance must queue the successor's withdrawal again");
      assert.equal((await withdrawalAttempts(fixture, first)).length, 1);
      await fixture.work(work[1], "succeeded");
      const revoked = await withdrawal.read(fixture.actor.id);
      assert.equal(revoked.revisionId, first.id);
      assert.equal(revoked.state, "revoked");

      // Revoked everywhere: nothing is queued again. A Harness-withdrawn revision's maintenance
      // then ends; a tool withdrawal leaves it running.
      await runMaintenancePass(fixture, first);
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

revisionTest(
  "a candidate's withdrawal refused until it is active settles when its deployment activates it, without a replay",
  async (fixture) => {
    const owners = [];
    for (const label of ["activates", "other-refusal", "outstanding", "active-retirement"]) {
      owners.push(await agentWithHarnessAndToolSources(fixture, `withdraw-activation-${label}`, 1));
    }
    const firsts = [];
    for (const owner of owners) {
      firsts.push(await fixture.revision(owner, 1));
    }
    // Revisions whose withdrawal Compute refuses for another cause, whichever is active.
    const refusals = new Map();
    const withdrawn = [];
    const compute = {
      ...fixture.compute,
      maintenanceIntervalMs: 3_600_000,
      // Like reduceCredentialPolicy, reduce only the Agent's active revision (finding 2235).
      async withdrawCredentialSource(revision, source) {
        withdrawn.push(revision.id);
        const agent = await fixture.state.read((view) =>
          view.agents.findAgent(revision.namespaceId, revision.agentId),
        );
        const code =
          refusals.get(revision.id) ??
          (agent?.activeRevisionId === revision.id
            ? undefined
            : "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
        if (code !== undefined) {
          throw new CredentialWithdrawalRefusedError(code, "Compute refused the withdrawal.");
        }
        return { sourceId: source.id, state: "revoked" };
      },
    };
    const options = { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway };
    await fixture.start(compute, options);
    for (const first of firsts) {
      await fixture.work(first, "succeeded");
    }
    await fixture.stop();

    // The first three Agents have a later candidate still deploying when the withdrawal is
    // requested. The last one has none; its active revision refuses retirement itself.
    const seconds = [];
    for (const owner of owners.slice(0, 3)) {
      seconds.push(await admitHeldRevision(fixture, owner, 2));
    }
    refusals.set(seconds[1].id, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
    refusals.set(firsts[3].id, "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
    // Another operator requests the first Agent's withdrawal; its attempts run as that operator.
    const requester = `withdraw-activation-requester-${randomUUID()}`;
    await fixture.copyActorGrants(requester);
    const withdrawals = [];
    for (const [index, owner] of owners.entries()) {
      const sourceId = toolSources(owner)[0].sourceId;
      withdrawals.push(
        await requestWithdrawal(
          fixture,
          owner,
          sourceId,
          index === 0 ? requester : fixture.actor.id,
        ),
      );
    }
    await fixture.start(compute, options);
    for (const [index, second] of seconds.entries()) {
      await fixture.work((await withdrawalAttempts(fixture, second))[0], "failed_permanent");
      await fixture.work((await withdrawalAttempts(fixture, firsts[index]))[0], "succeeded");
    }
    await fixture.work((await withdrawalAttempts(fixture, firsts[3]))[0], "failed_permanent");
    await fixture.stop();
    const refused = await withdrawals[0].read(fixture.actor.id);
    assert.equal(refused.revisionId, seconds[0].id);
    assert.equal(refused.state, "pending");
    assert.equal(refused.lastReason, "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
    assert.equal(refused.withdrawalInProgress, false, "the refusal awaits a replay or activation");

    // The third Agent's operator replays while its candidate still deploys. That attempt would
    // fail the same way; hold it, so it is still queued when the candidate activates.
    await withdrawals[2].replay(fixture.actor.id);
    const replay = (await withdrawalAttempts(fixture, seconds[2]))[1];
    assert.equal(replay.state, "queued");
    const hold = (work, at) =>
      fixture.observerPool.query(
        `UPDATE occ.controller_work SET available_at = ${at} WHERE idempotency_key = $1`,
        [work.idempotencyKey],
      );
    await hold(replay, "clock_timestamp() + interval '1 day'");
    for (const second of seconds) {
      await hold(second, "clock_timestamp()");
    }
    await fixture.start(compute, options);
    for (const second of seconds) {
      await fixture.work(second, "succeeded", 30_000);
    }

    // Activation queues one attempt for the refused withdrawal, as its requester, and that
    // attempt reduces the now-active revision. Nobody replayed it.
    const activated = await withdrawalAttempts(fixture, seconds[0]);
    assert.equal(activated.length, 2, "activation queues exactly one attempt");
    const activation = activated[1];
    assert.equal(
      activation?.idempotencyKey,
      `agent_revision:${seconds[0].id}:reconcile:credentials_withdrawn:activation`,
    );
    assert.equal(activation.actorId, requester);
    await fixture.work(activation, "succeeded");
    const settled = await withdrawals[0].read(fixture.actor.id);
    assert.equal(settled.revisionId, seconds[0].id);
    assert.equal(settled.state, "revoked");
    assert.equal(withdrawn.filter((id) => id === seconds[0].id).length, 2);

    // Activation queues nothing for a refusal it does not change, nor beside an attempt that
    // is still queued; that attempt then settles the withdrawal.
    assert.equal((await withdrawalAttempts(fixture, seconds[1])).length, 1);
    const other = await withdrawals[1].read(fixture.actor.id);
    assert.equal(other.state, "pending");
    assert.equal(other.lastReason, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
    assert.equal((await withdrawalAttempts(fixture, seconds[2])).length, 2);
    await hold(replay, "clock_timestamp()");
    await fixture.work(replay, "succeeded");
    assert.equal((await withdrawals[2].read(fixture.actor.id)).state, "revoked");

    // An active revision's own retirement refusal still waits for a replay: its maintenance
    // passes, which complete the activated revision too, queue no attempt.
    await runMaintenancePass(fixture, firsts[3]);
    await fixture.stop();
    assert.equal((await withdrawalAttempts(fixture, firsts[3])).length, 1);
    const retirement = await withdrawals[3].read(fixture.actor.id);
    assert.equal(retirement.state, "pending");
    assert.equal(retirement.withdrawalInProgress, false);
  },
);

for (const successor of [false, true]) {
  test(
    `maintenance stops re-queuing ${successor ? "an admitted successor's Harness" : "a tool"} source withdrawal denied to its requester until an authorized replay`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const owner = await agentWithHarnessAndToolSources(
        fixture,
        `withdraw-denied-maintenance-${successor}`,
        1,
      );
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
        transformDrivers: (drivers) =>
          withUnavailableIAM(() => iamUnavailable)(withCredentialGateway(drivers)),
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
      const withdrawal = await requestWithdrawal(fixture, owner, sourceId, requester);
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
      const attemptCounts = () =>
        Promise.all(
          withdrawing.map(async (revision) => (await withdrawalAttempts(fixture, revision)).length),
        );

      // Only an operator who still holds operate can complete the withdrawal, so maintenance
      // queues no further denied attempt and audits no further denial, pass after pass, and
      // the read reports a withdrawal that needs a replay.
      for (let pass = 0; pass < 3; pass += 1) {
        await runMaintenancePass(fixture, first);
      }
      assert.deepEqual(
        await attemptCounts(),
        withdrawing.map(() => 1),
      );
      assert.equal(await denials(), withdrawing.length);
      const waiting = await withdrawal.read(fixture.actor.id);
      assert.equal(waiting.state, "pending");
      assert.equal(waiting.withdrawalInProgress, false);
      assert.equal(waiting.requestedBy, requester);
      assert.equal(waiting.lastReason, "AUTHORIZATION_DENIED");

      // An authorized replay takes the withdrawal over. Its attempts run out while IAM is
      // unavailable; they record that outage, not the earlier denial, so the next maintenance
      // pass queues them again.
      iamUnavailable = true;
      const replayed = await withdrawal.replay(fixture.actor.id);
      assert.equal(replayed.requestedBy, fixture.actor.id);
      assert.equal(replayed.withdrawalInProgress, true);
      const exhaustAttempts = async () => {
        for (const revision of withdrawing) {
          const latest = (await withdrawalAttempts(fixture, revision)).at(-1);
          await fixture.work(latest, "failed_permanent", 30_000);
        }
      };
      await exhaustAttempts();
      const iamOutage = await withdrawal.read(fixture.actor.id);
      assert.equal(iamOutage.lastReason, "DEPENDENCY_UNAVAILABLE");
      assert.equal(iamOutage.withdrawalInProgress, false);
      iamUnavailable = false;
      await runMaintenancePass(fixture, first);
      assert.deepEqual(
        await attemptCounts(),
        withdrawing.map(() => 3),
      );

      // Those attempts run out during a gateway outage, and the next pass queues them again.
      await exhaustAttempts();
      const gatewayOutage = await withdrawal.read(fixture.actor.id);
      assert.equal(gatewayOutage.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
      assert.equal(gatewayOutage.withdrawalInProgress, false);
      revoke = true;
      await runMaintenancePass(fixture, first);
      assert.deepEqual(
        await attemptCounts(),
        withdrawing.map(() => 4),
      );
      for (const revision of withdrawing) {
        const recovered = (await withdrawalAttempts(fixture, revision)).at(-1);
        await fixture.work(recovered, "succeeded");
      }
      await fixture.stop();
      const revoked = await withdrawal.read(fixture.actor.id);
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-refused-maintenance", 1);
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
    const withdrawal = await requestWithdrawal(fixture, owner, tool, fixture.actor.id);
    const [attempt] = await withdrawalAttempts(fixture, active);
    await fixture.work(attempt, "failed_permanent");

    // Retrying cannot help, so maintenance queues no further attempt, pass after pass.
    for (let pass = 0; pass < 2; pass += 1) {
      await runMaintenancePass(fixture, active);
    }
    assert.equal((await withdrawalAttempts(fixture, active)).length, 1);
    assert.equal(calls, 1);
    const waiting = await withdrawal.read(fixture.actor.id);
    assert.equal(waiting.lastReason, "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT");
    assert.equal(waiting.withdrawalInProgress, false);

    // Once the cause is corrected, a replay revokes the source.
    refuse = false;
    await withdrawal.replay(fixture.actor.id);
    const replay = (await withdrawalAttempts(fixture, active)).at(-1);
    await fixture.work(replay, "succeeded");
    await fixture.stop();
    assert.equal((await withdrawal.read(fixture.actor.id)).state, "revoked");
  },
);

revisionTest(
  "a withdrawn Harness source fails a deployment admitted before the withdrawal",
  async (fixture) => {
    const { owner, candidate: first } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-harness-successor",
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
    const withdrawal = await requestWithdrawal(fixture, owner, sourceId, fixture.actor.id);
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
    const read = await withdrawal.read(fixture.actor.id);
    assert.equal(read.revisionId, first.id);
    assert.equal(read.state, "revoked");
  },
);

revisionTest(
  "a withdrawal whose requester lost Agent operate fails once with a denial, and another operator's replay completes it",
  async (fixture) => {
    const { owner, candidate: active } = await admitInitialRevisionWithHarnessSource(
      fixture,
      "withdraw-denied",
    );
    const withdrawn = [];
    const compute = revokingCompute(fixture, withdrawn);
    const startWorker = () =>
      fixture.start(compute, { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway });
    await startWorker();
    await fixture.work(active, "succeeded");
    await fixture.stop();

    // A second operator requests the withdrawal and is offboarded before the worker runs it.
    const requester = `withdraw-requester-${randomUUID()}`;
    await fixture.copyActorGrants(requester);
    const withdrawal = await requestWithdrawal(
      fixture,
      owner,
      owner.harnessAuth.sourceId,
      requester,
    );
    await removeAccessBindings(fixture, requester);
    const work = await withdrawalAttempts(fixture, active);
    assert.equal(work.length, 1);
    assert.equal(work[0].actorId, requester);

    await startWorker();
    const failed = await fixture.work(work[0], "failed_permanent");
    // A denial is final on the first attempt and never reaches the gateway.
    assert.equal(failed.attempt_count, 1);
    assert.deepEqual(withdrawn, []);
    const recorded = await withdrawal.read(fixture.actor.id);
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
    const replayed = await withdrawal.replay(fixture.actor.id);
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
    const revoked = await withdrawal.read(fixture.actor.id);
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
      const final = await withdrawal.replay(principalId);
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
    const compute = revokingCompute(fixture, withdrawn);
    const startWorker = () =>
      fixture.start(compute, { convergenceTimeoutMs: 50, transformDrivers: withCredentialGateway });
    // A second operator with the actor's grants, offboarded after requesting a withdrawal.
    const offboarded = `withdraw-offboarded-${randomUUID()}`;
    const owners = [];
    for (const label of ["claim-by-offboarded", "claim-by-authorized"]) {
      const owner = await agentWithHarnessAndToolSources(fixture, label, 2);
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
    const partial = await agentWithHarnessAndToolSources(fixture, "withdraw-partial", 2);
    const moved = await agentWithHarnessAndToolSources(fixture, "withdraw-moved", 1);
    const retirement = await agentWithHarnessAndToolSources(fixture, "withdraw-retirement", 2);
    const partialRevision = await fixture.revision(partial, 1);
    const movedRevision = await fixture.revision(moved, 1);
    const retirementRevision = await fixture.revision(retirement, 1);
    const [first, second] = toolSources(partial).map(({ sourceId }) => sourceId);
    const [movedSource] = toolSources(moved).map(({ sourceId }) => sourceId);
    const [refusedSource, reducibleSource] = toolSources(retirement).map(
      ({ sourceId }) => sourceId,
    );
    const withdrawn = [];
    let failSecond = true;
    const compute = {
      ...fixture.compute,
      async withdrawCredentialSource(revision, source) {
        withdrawn.push([revision.id, source.id]);
        if (source.id === refusedSource) {
          throw new CredentialWithdrawalRefusedError(
            "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT",
            "The selected Credential Proxy cannot verify a reduced policy.",
          );
        }
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
    await fixture.work(retirementRevision, "succeeded");
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

    // A per-source retirement refusal must not suppress a later, independently reducible source.
    const retirementWork = await withdraw(retirement, retirementRevision, [
      refusedSource,
      reducibleSource,
    ]);
    await fixture.start(compute, options);
    await fixture.work(retirementWork, "failed_permanent", 30_000);
    await fixture.stop();
    assert.deepEqual(withdrawn.slice(3), [
      [retirementRevision.id, refusedSource],
      [retirementRevision.id, reducibleSource],
    ]);
    const refused = await read(retirement, refusedSource);
    assert.equal(refused.state, "pending");
    assert.equal(refused.lastReason, "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
    assert.equal((await read(retirement, reducibleSource)).state, "revoked");
  },
);

revisionTest(
  "maintenance re-queues an exhausted non-model withdrawal and keeps repairing the revision",
  async (fixture) => {
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-tool-maintenance", 2);
    const active = await fixture.revision(owner, 1);
    const [toolSourceId, remainingToolSourceId] = toolSources(owner).map(
      ({ sourceId }) => sourceId,
    );
    const dispatched = [];
    let revoke = false;
    await startWithGateway(fixture, {
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
    });
    await fixture.work(active, "succeeded");
    assert.deepEqual(dispatched, [[toolSourceId, remainingToolSourceId]]);

    // A pending tool-source withdrawal with no attempt outstanding, as an outage that
    // exhausted every attempt leaves it.
    await recordPendingWithdrawal(fixture, owner, active, toolSourceId);

    // Maintenance queues a withdrawal attempt and still repairs the revision, without the tool.
    await runMaintenancePass(fixture, active);
    const [queued] = await withdrawalAttempts(fixture, active);
    assert.ok(queued, "maintenance must queue the pending withdrawal again");
    assert.deepEqual(dispatched.at(-1), [remainingToolSourceId]);

    // After the gateway recovers, that attempt revokes the source and the chain continues.
    revoke = true;
    await fixture.work(queued, "succeeded");
    const recorded = await findWithdrawal(fixture, active, toolSourceId);
    assert.equal(recorded.state, "revoked");
    await runMaintenancePass(fixture, active);
    assert.equal(
      (await withdrawalAttempts(fixture, active)).length,
      1,
      "a revoked withdrawal is not queued again",
    );

    // A revoked model source must stop preparation, but an exhausted tool withdrawal still
    // needs maintenance to recover after a gateway outage.
    const modelWithdrawal = await requestWithdrawal(
      fixture,
      owner,
      owner.harnessAuth.sourceId,
      fixture.actor.id,
    );
    await waitFor("model source withdrawal to be revoked", async () => {
      const withdrawal = await modelWithdrawal.read(fixture.actor.id);
      return withdrawal.state === "revoked" ? withdrawal : undefined;
    });
    assert.equal(modelWithdrawal.initial.state, "pending");
    const preparedBeforeWithdrawalRecovery = dispatched.length;
    await fixture.stop();
    await recordPendingWithdrawal(fixture, owner, active, remainingToolSourceId);
    revoke = false;
    await startWithGateway(fixture, {
      ...fixture.compute,
      maintenanceIntervalMs: 3_600_000,
      async prepareRevision(revision, revisionContext) {
        dispatched.push((revisionContext?.credentialSources ?? []).map(({ id }) => id));
        return fixture.compute.prepareRevision(revision, revisionContext);
      },
      async withdrawCredentialSource(_revision, source) {
        return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
      },
    });
    await runMaintenancePass(fixture, active);
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
    await runMaintenancePass(fixture, active);
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
    const owner = await agentWithHarnessAndToolSources(
      fixture,
      "withdraw-maintenance-preference",
      2,
    );
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

    // While an attempt is outstanding, maintenance queues no other.
    await runMaintenancePass(fixture, active);
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
    await runMaintenancePass(fixture, active);
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdraw-late-create", 1);
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
    const repair = await makeMaintenancePassDue(fixture, active);
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
    const settled = await waitForMaintenancePass(fixture, repair);
    assert.equal(settled.state, "succeeded", `maintenance ended ${settled.reason_code}`);
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdrawn-model-recheck", 1);
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
      const requestedWithdrawal = await requestWithdrawal(
        fixture,
        owner,
        credentialSourceId,
        fixture.actor.id,
      );
      await waitFor(`withdrawal of ${credentialSourceId} to be revoked`, async () => {
        const withdrawal = await requestedWithdrawal.read(fixture.actor.id);
        return withdrawal.state === "revoked" ? withdrawal : undefined;
      });
    }

    // A gateway outage during the recheck ends only this pass, as REVISION_FINALIZATION_INCOMPLETE
    // (DependencyUnavailableError carries no dependency code); the chain queues the next pass
    // instead of stopping with a revoked source maybe still attached.
    recheckFailure = new DependencyUnavailableError("The Credential Gateway did not answer.");
    rechecked.length = 0;
    const failed = await makeMaintenancePassDue(fixture, active);
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
    await runMaintenancePass(fixture, active);
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdrawn-grant-revoked", 1);
    const active = await fixture.revision(owner, 1);
    const toolSourceId = toolSources(owner)[0].sourceId;
    const modelSourceId = owner.harnessAuth.sourceId;
    const dispatched = [];
    await startWithGateway(fixture, {
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
    });
    await fixture.work(active, "succeeded");
    assert.deepEqual(dispatched, [[toolSourceId]]);

    // A pending withdrawal whose attempts ran out, after which the Agent principal's grant on
    // the withdrawn source is removed. The source never attaches again either way.
    const strandWithdrawal = async (credentialSourceId) => {
      await recordPendingWithdrawal(fixture, owner, active, credentialSourceId);
      await removeSourceGrant(fixture, owner, credentialSourceId);
    };
    const withdrawalState = async (credentialSourceId) =>
      (await findWithdrawal(fixture, active, credentialSourceId)).state;

    // A tool source: maintenance re-queues its withdrawal and repairs the revision without it.
    await strandWithdrawal(toolSourceId);
    await runMaintenancePass(fixture, active);
    const [toolWithdrawal, ...extra] = await withdrawalAttempts(fixture, active);
    assert.ok(toolWithdrawal, "maintenance must queue the pending tool withdrawal again");
    assert.deepEqual(extra, []);
    assert.deepEqual(dispatched.at(-1), []);
    await fixture.work(toolWithdrawal, "succeeded");
    assert.equal(await withdrawalState(toolSourceId), "revoked");

    // The model source: maintenance re-queues its withdrawal without preparing the revision.
    await strandWithdrawal(modelSourceId);
    const prepared = dispatched.length;
    await runMaintenancePass(fixture, active);
    const work = await withdrawalAttempts(fixture, active);
    assert.equal(work.length, 2, "maintenance must queue the pending model withdrawal again");
    const modelWithdrawal = work[1];
    await fixture.work(modelWithdrawal, "succeeded");
    assert.equal(await withdrawalState(modelSourceId), "revoked");
    await runMaintenancePass(fixture, active);
    assert.equal(dispatched.length, prepared, "a model-withdrawn revision must not be prepared");
  },
);

revisionTest(
  "an Agent that loses operate on a non-model source after admission never attaches it",
  async (fixture) => {
    const owner = await agentWithHarnessAndToolSources(fixture, "tool-grant-revoked", 1);
    const toolSourceId = toolSources(owner)[0].sourceId;
    const active = await fixture.revision(owner, 1);
    // The Agent principal's exact grant is removed between admission and dispatch.
    await removeSourceGrant(fixture, owner, toolSourceId);
    const prepared = [];
    await startWithGateway(fixture, {
      ...fixture.compute,
      async prepareRevision(revision, revisionContext) {
        prepared.push(revision.id);
        return fixture.compute.prepareRevision(revision, revisionContext);
      },
    });
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
    const owner = await agentWithHarnessAndToolSources(fixture, "withdrawn-other-grant", 1);
    const active = await fixture.revision(owner, 1);
    const toolSourceId = toolSources(owner)[0].sourceId;
    const modelSourceId = owner.harnessAuth.sourceId;
    await startWithGateway(fixture, {
      ...fixture.compute,
      maintenanceIntervalMs: 3_600_000,
      async withdrawCredentialSource(_revision, source) {
        return { sourceId: source.id, state: "revoked" };
      },
    });
    await fixture.work(active, "succeeded");

    // The tool source has a pending withdrawal. The Agent principal then loses its grant on the
    // model source, which is not withdrawn and still attaches, so maintenance must refuse.
    await recordPendingWithdrawal(fixture, owner, active, toolSourceId);
    await removeSourceGrant(fixture, owner, modelSourceId);
    const pass = await makeMaintenancePassDue(fixture, active);
    const settled = await waitForMaintenancePass(fixture, pass);
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
  "a revision whose Harness or listed credential source is no longer ready fails with a fixed status message",
  async (fixture) => {
    // Admission saw ready sources; each was marked deleting before dispatch, so the worker fails
    // the revision without preparing it. The status names the cause and the fix, without IDs,
    // instead of the generic "Deployment reconciliation failed." (D549).
    const harness = await admitInitialRevisionWithHarnessSource(fixture, "harness-source-deleting");
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

// Keep a real admitted Git session and its attachment through the deadline. This joins the
// actual worker, PostgreSQL, Git supplier and gateway client. The gateway, workload, issuer and
// middleware caller are fixtures: the model READY below is not a model turn or a Kubernetes run.
test(
  "attached Git expires under ordinary maintenance; a moving Sandbox version and lost detach reply preserve the Agent",
  { ...requiresPostgres, timeout: 60_000 },
  attachedGitExpires({ newHost: "inference.example.test" }),
);
test(
  "attached Git expires; a retained model profile that now covers GitHub retires the revision",
  { ...requiresPostgres, timeout: 60_000 },
  attachedGitExpires({ newHost: "uploads.github.com" }),
);

test(
  "attached Git expires; an overlapping platform profile behind a benign workspace namesake retires the revision",
  { ...requiresPostgres, timeout: 60_000 },
  attachedGitExpires({ newHost: "uploads.github.com", platformProfile: true }),
);
test(
  "attached Git expires; a safe platform profile preserves the Agent until ordinary maintenance loses permission to read it",
  { ...requiresPostgres, timeout: 60_000 },
  attachedGitExpires({ newHost: "service-2.example.test", platformProfile: true }),
);

function attachedGitExpires({ newHost, platformProfile = false }) {
  return async (t) => {
    const backendId = "github-primary";
    const repository = repositoryBoundary({ backendId });
    const f = await setup(t, { repoDriver: repository.driver });
    const routes = new PostgresOpenShellGitRouteStore(f.observerPool);
    const namespaceId = f.namespace.id;
    const pushRef = "refs/heads/review/task";
    const project = "example/application";
    const registry = validateGitHubRepositoryRegistry(
      {
        version: 1,
        backendId,
        providerInstanceId: "github-com-primary",
        appId: "12345",
        githubInstallationId: "67890",
        maximumDurationSeconds: 86400,
        repositories: [
          {
            repositoryRef: "application",
            repositoryId: "34567",
            repository: project,
            namespaces: [
              {
                namespaceId,
                profiles: ["git-write"],
                pushRefAllowlist: [pushRef],
                transport: "git-only",
              },
            ],
          },
        ],
      },
      backendId,
    );
    const binding = resolveGitHubRepositoryBinding(registry, {
      namespaceId,
      repositoryRef: "application",
      profile: "git-write",
    });
    // Repository and Compute must resolve the same registry grant throughout this test.
    repository.driver.resolve = (input) => ({
      bindings: input.bindings.map((item) =>
        resolveGitHubRepositoryBinding(registry, { namespaceId: input.namespaceId, ...item }),
      ),
      sessionDurationSeconds: 60,
    });
    const registrationName = "oce-prepared-git";
    const sandboxId = "fixture-original";
    const workspace = "git-expiry";
    const sandbox = "git-agent";
    const events = [];
    const approved = [];
    const stopped = [];
    let sessionId;
    let identity;
    let runtime;
    let senderRuntime;
    const bodies = await gitCommandBodies(t, pushRef);
    const { client: middleware, keys } = await openShellOnlineGitWire(t, {
      registrationName,
      budgetMs: 3000,
      async lookupBinding(id, signal) {
        let refused;
        const found = await senderRuntime.lookup(id, signal, (reason) => {
          refused = reason;
        });
        return found ?? (refused && { refused });
      },
      async approve(request) {
        assert.equal(request.sessionId, sessionId);
        approved.push(request.operation);
        return true;
      },
    });
    // Allocate the Agent and independent model grant before starting the short Git clock.
    const agent = await f.agent("attached-git-expires", {
      auth: "credential_source",
      executionMode: "dedicated",
    });
    const model = agent.harnessAuth.sourceId;
    const continuity = { model, workload: async () => "original-workload-and-supervisor" };
    const deadlineWallMs = Date.now() + 6_000;
    const revision = await f.revision(agent, 1, {
      sandboxDriverId: "sandbox-worker-fixture",
      repositoryCredentials: { ...repository.snapshot, deadlineWallMs, bindings: [binding] },
    });
    const { client, world } = await gitExpiryGateway(t, {
      model,
      workspace,
      sandbox,
      revisionId: revision.id,
      platformProfile,
      deadline: deadlineWallMs,
    });
    const material = {
      ...binding.grant,
      value: "synthetic-installation-token",
      expiresAt: new Date(deadlineWallMs + 600_000).toISOString(),
      repository: project,
      pushRef,
      preparationAttemptId: randomUUID(),
      materialVersion: randomUUID(),
      apiOrigin: "https://api.github.com",
    };
    function releaseRuntime() {
      const git = new OpenShellGitRuntime(
        { registrationName, authority: {} },
        createGitHubRepositoryDeliveryResolver(registry),
      );
      // The authority has a real TLS socket; only custody and the external installation are doubles.
      git.routes = routes;
      git.owner = { readOpenShellMaterial: async () => ({ ...material, sessionId }) };
      git.emit = (e) => events.push(e);
      return git;
    }
    senderRuntime = runtime = releaseRuntime();
    const compute = {
      ...f.compute,
      validateRepositoryCredentials(harness, selected) {
        assert.equal(harness.id, "codex");
        assert.equal(harness.mode, "dedicated");
        assert.equal(selected, "sandbox-worker-fixture");
      },
      async prepareRevision(r, context) {
        assert.equal(r.harnessAuth.sourceId, model);
        assert.equal(
          world.id,
          undefined,
          "the worker must not prepare or replace the running revision after expiry",
        );
        const [open] = await repositoryAttempts(f, r);
        assert.equal(open.phase, "open");
        sessionId = open.sessionId;
        const signal = AbortSignal.timeout(4000);
        const git = await runtime.prepare(
          r,
          client,
          workspace,
          sandbox,
          signal,
          world.retainedProviders,
        );
        world.id = sandboxId;
        identity = git.middlewares[registrationName].config;
        await runtime.bind(r.id, (box) => assert.equal(box.id, sandboxId), continuity);
        const entry = await runtime.entries.get(r.id);
        await runtime.reconcile(entry);
        return f.compute.prepareRevision(r, context);
      },
      retireExpiredRepositoryAccess: (r, signal) =>
        runtime.retireExpiredRepositoryAccess(r, client, workspace, sandbox, continuity, signal),
      stopRevision(r) {
        stopped.push(r.id);
        return f.compute.stopRevision(r);
      },
    };
    const start = () =>
      f.start(compute, { emit: (e) => events.push(e), transformDrivers: withCredentialGateway });
    let originRequests = 0;
    let originBytes = 0;
    async function fetchFromPrivateOrigin() {
      const result = await invoke(
        middleware,
        "EvaluateHttpRequest",
        {
          phase: 1,
          middleware_name: registrationName,
          config: identity,
          context: { request_id: randomUUID(), sandbox_id: sandboxId, workspace },
          target: {
            scheme: "https",
            host: "github.com",
            port: 443,
            method: "POST",
            path: "/" + project + ".git/git-upload-pack",
          },
          headers: [{ name: "content-type", value: "application/x-git-upload-pack-request" }],
          body: bodies.fetch,
        },
        token(keys, "supervisor", sandboxId),
      );
      if (result.decision !== 1) {
        return result;
      }
      originRequests++;
      originBytes += bodies.fetch.length;
      assert.ok(
        bodies.uploadPack(bodies.fetch).includes(Buffer.from("PACK")),
        "Git returned the requested pack",
      );
      return result;
    }
    await start();
    await f.work(revision, "succeeded").catch(async (cause) => {
      const {
        rows: [work],
      } = await f.workResult(revision);
      throw Error("Git-enabled revision did not activate: " + work?.reason_code, { cause });
    });
    assert.deepEqual(await fetchFromPrivateOrigin(), { decision: 1 });
    assert.deepEqual(approved, ["upload-pack"]);
    const remaining = deadlineWallMs - Date.now();
    assert.ok(remaining > 0, "use Git before its legitimately admitted deadline");
    // Await the real grant deadline; move only queue due times. Neither the binding nor its
    // live session is removed by the test, and no expiry or cleanup work is inserted by it.
    await delay(remaining + 10);
    const nextExpiry = async (code) => {
      const event = await completion(
        events,
        code,
        (e) =>
          e.event === "worker.completed" &&
          e.revisionId === revision.id &&
          e.workId?.includes(":repository_cleanup:"),
      );
      assert.equal(event.code, code);
      if (code !== "REPOSITORY_RUNTIME_RETIREMENT_QUEUED") {
        assert.equal((await f.currentAgent(agent)).activeRevisionId, revision.id);
        assert.deepEqual(stopped, []);
      }
      events.length = 0;
    };
    assert.equal((await f.advanceMaintenance(revision)).rowCount, 1);
    await nextExpiry("REPOSITORY_CLEANUP_PENDING");
    assert.equal(world.version, 14);
    assert.deepEqual(world.detaches, [], "no detach at the stale resource version");
    const refused = await fetchFromPrivateOrigin();
    assert.deepEqual(refused, { decision: 2, reason_code: "access_withdrawn" });
    assert.deepEqual(
      [originRequests, originBytes, approved, world.writes],
      [1, bodies.fetch.length, ["upload-pack"], 1],
    );
    const attempts = await repositoryAttempts(f, revision);
    assert.deepEqual(
      attempts.map((a) => [a.phase, a.sessionId]),
      [["disposed", sessionId]],
    );
    await advanceCleanupRetries(f, revision);
    await nextExpiry("REPOSITORY_CLEANUP_PENDING");
    assert.equal(
      world.detaches.length,
      1,
      "one conditional detach committed, but its reply was lost",
    );
    await f.stop();
    world.addRetainedEndpoint(newHost);
    runtime = releaseRuntime(); // empty in-process route, same PostgreSQL and gateway
    await advanceCleanupRetries(f, revision);
    await start();
    if (newHost === "uploads.github.com") {
      await nextExpiry("REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
      if (platformProfile) {
        assert.deepEqual(
          world.profileReads,
          ["platform"],
          "read the effective profile, not its workspace namesake",
        );
      }
      await waitFor("retained GitHub endpoint retires the exact revision", async () =>
        (await f.currentAgent(agent)).activeRevisionId === undefined ? true : undefined,
      );
      assert.deepEqual(stopped, [revision.id]);
      assert.deepEqual(await fetchFromPrivateOrigin(), refused);
      assert.deepEqual(
        [originRequests, originBytes, approved],
        [1, bodies.fetch.length, ["upload-pack"]],
      );
      assert.deepEqual([world.detaches.length, world.writes], [1, 1], "no replay or replacement");
      return;
    }
    await nextExpiry("REPOSITORY_ACCESS_WITHDRAWN");
    assert.deepEqual(
      world.reports.slice(-2).map(([, state, receipt]) => [state, receipt]),
      [
        ["REVOKED", "OBSERVE"],
        ["READY", "OBSERVE"],
      ],
    );
    const {
      rows: [next],
    } = await f.advanceMaintenance(revision);
    const maintenance = { ...revision, idempotencyKey: next.idempotency_key };
    await f.work(maintenance, "succeeded");
    assert.equal(
      (await f.workResult(maintenance)).rows[0].reason_code,
      "REPOSITORY_ACCESS_WITHDRAWN",
    );
    assert.equal((await f.currentAgent(agent)).activeRevisionId, revision.id);
    assert.deepEqual(stopped, []);
    // The original sender remains fenced, and the cold worker cannot supply a replacement.
    assert.deepEqual(await fetchFromPrivateOrigin(), refused);
    senderRuntime = runtime;
    assert.equal((await fetchFromPrivateOrigin()).decision, 2);
    assert.equal(originBytes, bodies.fetch.length, "neither late fetch reached the Git origin");
    assert.deepEqual(approved, ["upload-pack"]);
    assert.equal(repository.calls.filter((c) => c.operation === "open").length, 1);
    assert.deepEqual(
      [world.detaches.length, world.writes],
      [1, 1],
      "no replay or replacement Git material",
    );
    // Losing the evidence for safe retention on the next ordinary maintenance retires this revision.
    if (platformProfile) {
      assert.deepEqual(
        world.profileReads,
        ["platform", "platform"],
        "rechecked after confirming withdrawal",
      );
      world.profileReads.length = 0;
      world.denyPlatformProfile = true;
    } else {
      world.modelFailed = true;
    }
    await f.advanceMaintenance(revision);
    await waitFor("loss of verified provider access retires the revision", async () =>
      (await f.currentAgent(agent)).activeRevisionId === undefined ? true : undefined,
    );
    assert.deepEqual(stopped, [revision.id]);
    if (platformProfile) {
      assert.deepEqual(
        world.profileReads,
        ["platform"],
        "permission denied; never try the workspace namesake",
      );
      assert.equal((await fetchFromPrivateOrigin()).decision, 2);
      assert.deepEqual([originRequests, world.detaches.length, world.writes], [1, 1, 1]);
    }
  };
}
