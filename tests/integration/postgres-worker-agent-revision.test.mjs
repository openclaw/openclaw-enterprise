import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import { createResourceScope } from "../fixtures/repository-credentials/resources.ts";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import {
  ActivationFailedError,
  ActivationPendingError,
  CredentialSourceRevisionError,
  DependencyUnavailableError,
  KubernetesSecretWriteForbiddenError,
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
import { waitFor } from "../helpers/wait-for.ts";
import {
  assertFailedDeployment,
  runPreparationFailureCase,
  runRuntimeFailureCases,
} from "../helpers/postgres-worker-revision-scenarios.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  advanceCleanupRetries,
  completion,
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";
import {
  DEPLOYMENT_FAILED,
  IMAGE_PULL_FAILING,
  MODEL_CREDENTIAL_REJECTED_RECORDED,
  POD_QUOTA_FULL,
  WORKSPACE_SETUP_RETRYING,
} from "../helpers/refusal-text.mjs";
import { registerRevisionDispatchCases } from "./postgres-worker-agent-revision-dispatch-cases.ts";

// Deployment admission and dispatch. The -lifecycle sibling covers persisted deploy, Stop and
// delete, worker shutdown and claim fencing. The -convergence sibling
// covers deployment progress, readiness retries, deadlines and cleanup after failed preparation.
// The -credential-sources sibling covers withdrawals and lost grants or readiness.

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

test(
  "worker revalidates admitted repository selections through the concrete GitHub Driver and Unix control",
  // First in its file, so it also absorbs the file's cold start (finding 1171):
  // about 12.5 s typically, 31.7 s once on a slow runner.
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    // An interrupted worker retains its lease. Keep its expiry inside the observation window.
    const fixture = await setup(context, { leaseDurationMs: 5_000 });
    const [
      { GitHubRepositoryPolicy },
      { UnixRepositoryCredentialControlClient },
      { startRegistryCredentialServiceFixture },
    ] = await Promise.all([
      import("../../apps/controller/src/drivers/repo/github/policy.ts"),
      import("../../apps/controller/src/backends/repository-credentials/control-client.ts"),
      import("../fixtures/repository-credentials/registry.ts"),
    ]);
    const resources = createResourceScope();
    const credentialResources = createResourceScope();
    let receiptServer;
    let releaseLostResponse;
    resources.after(() => receiptServer?.close());
    resources.after(() => credentialResources.close());
    resources.after(() => fixture.stop());
    try {
      const clock = createControlledClock();
      const startedWall = clock.wallNow();
      const credentials = await startRegistryCredentialServiceFixture(credentialResources, {
        namespaceId: fixture.namespace.id,
        autoOpen: false,
        // Worker admission IDs use real wall time. Preserve that progress while
        // allowing this fixture's provider-retirement expiry to advance explicitly.
        clock: { ...clock, wallNow: () => Date.now() + clock.wallNow() - startedWall },
        gateway: { listen: "127.0.0.1:0" },
      });
      const repositoryBackend = {
        id: credentials.backendId,
        client: new UnixRepositoryCredentialControlClient({
          controlSocket: credentials.config.gateway.controlSocket,
        }),
        drivers: { repo: "repository-credentials" },
      };
      const sender = new GitHubNativeRepositorySender(repositoryBackend, {
        publicCa: credentials.tls.ca,
      });
      const driver = new GitHubRepositoryPolicy(
        { driverId: repositoryBackend.drivers.repo, backendId: repositoryBackend.id },
        credentials.registry,
        {
          sessionDurationSeconds: 60,
        },
      );
      // The real resolver admits selection fields and returns the richer frozen
      // binding. Worker revalidation must project that snapshot back to selections;
      // the strict registry parser rejects backendId/grant as caller input.
      const resolution = driver.resolve({
        namespaceId: fixture.namespace.id,
        bindings: [{ repositoryRef: "repo-a", profile: "git-write" }],
      });
      // Bound admissions require the worker-owned receipt transport and its real
      // PostgreSQL state; without it the broker correctly refuses the session.
      const { startRepositoryReceiptServer } =
        await import("../../apps/controller/src/backends/repository-credentials/receipt-server.ts");
      receiptServer = await startRepositoryReceiptServer({
        state: fixture.state,
        controlSocket: credentials.config.gateway.controlSocket,
        driverId: driver.id,
        implementation: driver.implementation,
        backendId: credentials.backendId,
      });
      const { owner, candidate } = await fixture.admitInitialRevision(
        "repository-concrete-driver",
        {
          revision: {
            repositoryCredentials: {
              driver: { id: driver.id, implementation: driver.implementation },
              deadlineWallMs: Date.now() + 120_000,
              bindings: resolution.bindings,
            },
          },
        },
      );
      const open = sender.open.bind(sender);
      const opens = [];
      const successorChecks = [];
      let lost;
      const lostResponse = new Promise((resolve) => {
        releaseLostResponse = resolve;
      });
      // Hold the first response until this worker stops. Its successor must recover
      // the original admission and settle it before opening another session.
      sender.open = async (input, signal) => {
        opens.push({ admissionId: input.admissionId, recoverOnly: input.recoverOnly === true });
        if (lost && input.recoverOnly !== true) {
          const original = await fixture.state.read(async (view) => ({
            attempt: await view.repositorySessions.findAttempt(lost.admissionId),
            receipt: await view.repositorySessions.findBrokerReceipt(lost.admissionId),
          }));
          successorChecks.push({
            admissionId: input.admissionId,
            originalPhase: original.attempt?.phase,
            originalReceiptState: original.receipt?.state,
            originalReceiptSessionId: original.receipt?.sessionId,
            originalReceiptGeneration: original.receipt?.generation,
          });
        }
        const result = await open(input, signal);
        if (!lost && result.kind === "created") {
          lost = { admissionId: input.admissionId, sessionId: result.session.sessionId };
          await lostResponse;
          throw new Error("repository admission response lost after creation");
        }
        return result;
      };
      const material = [];
      const events = [];
      const startWorker = () =>
        fixture.start(
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
          },
          {
            emit: (event) => events.push(event),
            transformDrivers: (drivers) => ({
              ...drivers,
              repositoryPolicy: driver,
              nativeRepositorySender: sender,
            }),
          },
        );
      await startWorker();
      await waitFor("the first concrete session to open", async () => lost);
      const stopping = fixture.stop();
      releaseLostResponse();
      await stopping;
      assert.equal(material.length, 0);
      const first = await fixture.state.read(async (view) => ({
        attempt: await view.repositorySessions.findAttempt(lost.admissionId),
        receipt: await view.repositorySessions.findBrokerReceipt(lost.admissionId),
      }));
      assert.equal(first.attempt?.phase, "opening");
      assert.equal(first.receipt?.state, "active");
      assert.equal(first.receipt?.sessionId, lost.sessionId);
      const claim = await fixture.observerPool.query(
        "SELECT state, lease_expires_at > clock_timestamp() AS lease_live FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
      assert.deepEqual(claim.rows, [{ state: "claimed", lease_live: true }]);
      await startWorker();
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
        15_000,
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
      const status = await sender.status(material[0].sessionId, new AbortController().signal);
      assert.equal(status.state, "OPEN");
      assert.deepEqual(status.binding, resolution.bindings[0].grant);
      const attempts = await repositoryAttempts(fixture, candidate);
      assert.equal(attempts.length, 2);
      const original = attempts.find(({ admissionId }) => admissionId === lost.admissionId);
      assert.equal(original?.sessionId, lost.sessionId);
      assert.equal(original?.phase, "disposed");
      assert.equal(
        opens.filter(
          ({ admissionId, recoverOnly }) => admissionId === lost.admissionId && !recoverOnly,
        ).length,
        1,
      );
      assert.ok(
        opens.some(
          ({ admissionId, recoverOnly }) => admissionId === lost.admissionId && recoverOnly,
        ),
      );
      assert.notEqual(material[0].sessionId, lost.sessionId);
      const attempt = attempts.find(({ phase }) => phase === "open");
      assert.equal(attempt.phase, "open");
      assert.equal(attempt.sessionId, status.sessionId);
      assert.deepEqual(successorChecks, [
        {
          admissionId: attempt.admissionId,
          originalPhase: "disposed",
          originalReceiptState: "disposed",
          originalReceiptSessionId: lost.sessionId,
          originalReceiptGeneration: first.receipt.generation,
        },
      ]);
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
    } finally {
      releaseLostResponse?.();
      await resources.close();
    }
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
          gatewayManagedMode: malformedAdmission.gatewayManagedMode,
          configuration: {},
          executionAdmission: first.executionAdmission,
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
            execution_admission: first.executionAdmission,
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
      message: POD_QUOTA_FULL,
    });
    // Finding 1677: Kubernetes is restarting a failed workspace setup that may still pass.
    assert.deepEqual(await progress(setupRetrying, setupRetryingRevision), {
      code: "WORKSPACE_SETUP_RETRYING",
      message: WORKSPACE_SETUP_RETRYING,
    });
    // Finding 1762: the kubelet cannot pull an image; fixed copy, never the image reference.
    assert.deepEqual(await progress(imagePull, imagePullRevision), {
      code: "REVISION_IMAGE_PULL_FAILED",
      message: IMAGE_PULL_FAILING,
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
  "the revision worker logs closed diagnostics from genuine OpenShell gRPC failures",
  requiresPostgres,
  async (context) => {
    const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
    const grpc = require("@grpc/grpc-js");
    const loader = require("@grpc/proto-loader");
    const proto = await loader.load(
      new URL("../fixtures/openshell-v0.1.5-wire.proto", import.meta.url).pathname,
      { keepCase: true, enums: String },
    );
    const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
    const secret = `synthetic-reflected-${randomUUID()}`;
    const labelRefusal = "': external resource not admitted by required labels";
    const cases = [
      { prefix: "policy contains unsafe content: ", category: "POLICY_SAFETY" },
      { prefix: "policy middleware validation failed: ", category: "POLICY_MIDDLEWARE_VALIDATION" },
      { prefix: "unrecognized supplier validation: ", category: "UNKNOWN" },
      // Similar or embedded strings must not claim a supplier validation stage.
      { prefix: "reflected policy contains unsafe content: ", category: "UNKNOWN" },
      { prefix: " policy contains unsafe content: ", category: "UNKNOWN" },
      { prefix: "Policy contains unsafe content: ", category: "UNKNOWN" },
      { prefix: "policy contains unsafe content:", category: "UNKNOWN" },
      {
        prefix: "policy contains unsafe content: ",
        status: grpc.status.INTERNAL,
        category: "UNKNOWN",
      },
      { prefix: "policy contains unsafe content: ", method: "Health", category: "UNKNOWN" },
      {
        prefix: "PersistentVolumeClaim 'fixture/",
        suffix: labelRefusal,
        status: grpc.status.FAILED_PRECONDITION,
        category: "PVC_ADMISSION_LABELS",
      },
      {
        prefix: "RuntimeClass '",
        suffix: labelRefusal,
        status: grpc.status.FAILED_PRECONDITION,
        category: "CLASS_ADMISSION_LABELS",
      },
      {
        prefix: "reflected PersistentVolumeClaim 'fixture/",
        suffix: labelRefusal,
        status: grpc.status.FAILED_PRECONDITION,
        category: "UNKNOWN",
      },
      {
        prefix:
          "create sandbox failed: gateway is forbidden from reading metadata for RuntimeClass '",
        suffix: "' (Kubernetes 403); check gateway RBAC",
        status: grpc.status.INTERNAL,
        category: "RESOURCE_METADATA_FORBIDDEN",
      },
    ].map((scenario, index) => ({
      name: `diagnostic-${index}`,
      method: "CreateSandbox",
      status: grpc.status.INVALID_ARGUMENT,
      ...scenario,
    }));
    const calls = [];
    const reflected = [];
    const server = new grpc.Server();
    let client;
    let fixture;
    context.after(async () => {
      try {
        await fixture?.stop();
      } finally {
        client?.close();
        server.forceShutdown();
      }
    });
    server.addService(OpenShell.service, {
      CreateSandbox(call, callback) {
        const scenario = cases.find(({ name }) => name === call.request.name);
        calls.push(scenario.name);
        reflected.push(call.request.annotations["fixture-reflection"]);
        // Reflect request material over the real wire. The production client, worker and
        // logger must discard it, even though it has no recognizable credential shape.
        callback({
          code: scenario.status,
          details:
            scenario.prefix +
            call.request.annotations["fixture-reflection"] +
            (scenario.suffix ?? ""),
        });
      },
      Health(_call, callback) {
        const scenario = cases.find(({ method }) => method === "Health");
        calls.push(scenario.name);
        callback({ code: scenario.status, details: scenario.prefix + secret });
      },
    });
    const port = await new Promise((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    fixture = await setup(context, { maxAttempts: 1 });
    const admitted = new Map();
    for (const scenario of cases) {
      const { owner, candidate } = await fixture.admitInitialRevision(scenario.name);
      admitted.set(candidate.id, { ...scenario, owner, candidate });
    }
    const events = [];
    const lines = [];
    const requestFailures = [];
    const emit = createWorkerLogEmitter(
      createOccLogger({
        component: "occ-worker",
        level: "debug",
        destination: {
          write(chunk) {
            lines.push(
              ...String(chunk)
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line)),
            );
            return true;
          },
        },
      }),
    );
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          const scenario = admitted.get(revision.id);
          if (scenario !== undefined) {
            // The fixture Compute boundary uses the real client; no error or worker method
            // is patched. PostgreSQL dispatch, retry accounting and log emission are real.
            const signal = currentComputeAbortSignal();
            assert.ok(signal, "the worker must own the Compute cancellation signal");
            try {
              if (scenario.method === "Health") {
                await client.health(signal);
              } else {
                await client.createSandbox(
                  {
                    name: scenario.name,
                    workspace: "diagnostic-workspace",
                    requestId: revision.id.slice("rev_".length),
                    labels: {},
                    annotations: { "fixture-reflection": secret },
                    spec: { template: { image: "fixture.invalid/diagnostic:never-started" } },
                    serviceExposures: [],
                  },
                  signal,
                );
              }
            } catch (error) {
              requestFailures.push(error);
              throw error;
            }
          }
          return fixture.compute.prepareRevision(revision);
        },
      },
      {
        emit(event) {
          events.push(event);
          emit(event);
        },
      },
    );
    for (const { owner, candidate, method, status, category } of admitted.values()) {
      await fixture.work(candidate, "failed_permanent");
      await completion(
        events,
        "the gRPC failure's completion",
        (event) => event.event === "worker.completed" && event.revisionId === candidate.id,
      );
      const [line] = lines.filter(
        (entry) => entry.event === "worker.completed" && entry.revisionId === candidate.id,
      );
      assert.ok(line);
      assert.deepEqual(
        {
          method: line.method,
          grpcStatus: line.grpcStatus,
          validationCategory: line.validationCategory,
        },
        { method, grpcStatus: status, validationCategory: category },
      );
      // A one-attempt fixture becomes terminal by exhaustion; the classification itself
      // still asks the queue to retry and never makes all INVALID_ARGUMENT errors permanent.
      assert.equal(line.outcome, "retry");
      assert.equal(line.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(line.cause, "DependencyUnavailableError");
      assert.equal((await fixture.currentAgent(owner)).activeRevisionId, undefined);
      assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "failed");
    }
    await fixture.stop();
    assert.deepEqual(calls.sort(), cases.map(({ name }) => name).sort());
    assert.deepEqual(
      reflected,
      cases.filter(({ method }) => method === "CreateSandbox").map(() => secret),
    );
    // HTTP dependency logging also emits this message: sanitizing only worker fields
    // would still expose reflected values there.
    assert.deepEqual(
      requestFailures.map(({ message }) => message).sort(),
      cases
        .map(({ method, status }) => `OpenShell ${method} failed with gRPC status ${status}.`)
        .sort(),
    );
    for (const output of [JSON.stringify(events), JSON.stringify(lines)]) {
      assert.equal(output.includes(secret), false);
      for (const { prefix } of cases) {
        assert.equal(output.includes(prefix), false);
      }
      for (const field of [
        "details",
        "request",
        "spec",
        "annotations",
        "stack",
        "requestDiagnostic",
      ]) {
        assert.equal(output.includes(`"${field}":`), false);
      }
    }
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
      candidatePreparationReached: true,
      errorClass: "KubernetesApiError",
      message: "The Kubernetes API rejected revision preparation.",
      status: 422,
    });
    assert.equal(JSON.stringify(events).includes(failure.message), false);
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
    // The scripted passes must all run before the deadline, so it is real time from admission
    // (finding 1171). Each work is admitted 20 s old by the database clock, which the worker judges
    // the deadline by: 10 s of real time leaves a stalled runner room for those few passes (they
    // take about 1 s), and the outage then fills the rest without waiting out all 30 s.
    const timeoutMs = 30_000;
    const remainingMs = 10_000;
    const aged = { revision: { workAge: `${(timeoutMs - remainingMs) / 1000} seconds` } };
    const running = await fixture.admitInitialRevision("expired-bootstrap-outage", aged);
    const progressed = await fixture.admitInitialRevision("expired-runtime-outage", aged);
    const published = await fixture.admitInitialRevision("expired-activation-outage", aged);
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
      await fixture.work(candidate, "failed_permanent", remainingMs + 15_000);
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
        message: MODEL_CREDENTIAL_REJECTED_RECORDED,
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
        message: DEPLOYMENT_FAILED.RUNTIME_CPU_STARVED,
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
        message: DEPLOYMENT_FAILED.WORKSPACE_SETUP_REFUSED,
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
      component: "agent",
      check: "model-probe",
      checkedAt: "2026-10-01T08:00:00.000Z",
      code: "MODEL_PROBE_FAILED",
      cause: { kind: "PROBE_STATUS", detail: "model_not_found" },
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
          "The startup model check failed, but not for a rejected credential: for example an unknown model, bad provider settings, a TLS error, a rate limit, or, with Codex, an unreachable provider. Check these and the provider account, then deploy a new version.",
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
              "The startup model check got no reply from the provider in time. With OpenClaw this includes an unreachable provider (refused connection or unknown host). Check egress, proxy or a custom baseUrl and that the provider responds, then deploy a new version.",
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
      // An unverifiable state lock holder keeps the same UNAVAILABLE code as other held
      // checks, but the record keeps no check, so the deployment code itself must name it
      // and point to the log that quotes the holder (finding 3348).
      ...["gateway", "agent"].map((component, index) => ({
        label: `held-runtime-${5 + index}`,
        runtimeFailure: {
          component,
          check: "gateway-state-lock",
          checkedAt: "2026-10-01T08:00:00.000Z",
          code: "UNAVAILABLE",
        },
        expected: {
          error: {
            code: "RUNTIME_STATE_LOCK_UNVERIFIED",
            message:
              'Deployment runtime failed the startup check gateway-state-lock: it cannot verify that an earlier process holding its state lock stopped, so it waits unready. Run "occ agent logs AGENT_ID --source gateway" for a Gateway, or "--source agent" for a Harness, to see the holder. Stop the Agent, recover the lock as the Agent troubleshooting guide describes, then deploy a new version.',
          },
        },
      })),
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
          "OpenShell cannot receive secretKeyRef environment APP_SERVER_TOKEN.",
        ),
      expected: {
        error: {
          code: "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
          message:
            "The Sandbox Driver cannot deliver Secret-backed environment variables to the Harness. Use credential sources instead of Secret bindings, or ask an Installation administrator for a Sandbox Driver that supports them, then deploy again.",
        },
      },
    });
    assert.equal(preparations, 1);
  },
);

revisionTest(
  "a Sandbox gateway that refuses the Harness Pod labels fails deployment without retrying",
  async (fixture) => {
    // The OpenShell gateway rejects label keys missing from its allowed_pod_labels on every
    // CreateSandbox, so retrying cannot help until an operator changes its configuration.
    // The gateway wire test proves the client raises this error for the gateway's refusal.
    const preparations = await runPreparationFailureCase(fixture, {
      label: "sandbox-pod-labels",
      failure: () =>
        new SandboxRevisionUnsupportedError(
          "SANDBOX_POD_LABELS_NOT_PERMITTED",
          "OpenShell refused the Harness Pod labels app.kubernetes.io/managed-by; add them to the gateway's Kubernetes driver allowed_pod_labels.",
        ),
      expected: {
        error: {
          code: "SANDBOX_POD_LABELS_NOT_PERMITTED",
          message:
            "The Sandbox gateway refuses this revision's Harness Pod labels. Ask an admin to allow them in the gateway configuration, then deploy again.",
        },
      },
    });
    assert.equal(preparations, 1);
  },
);

revisionTest(
  "a Kubernetes 403 on a private Secret write fails deployment on the first attempt",
  async (fixture) => {
    // Finding 1770 (D503): an RBAC grant, admission policy or quota that refuses the write
    // refuses every retry too, so the deployment fails at once with a status that names the
    // refusal and the grant to check, instead of five DEPENDENCY_UNAVAILABLE retries and
    // "Deployment reconciliation failed.". The Driver keeps only the HTTP status and Status
    // reason as the cause (tests/conformance/kubernetes-compute.test.mjs pins that shape), and
    // the worker log keeps both. A 429, 5xx or timeout stays a TransientDependencyError, which
    // waits for the convergence deadline (the KUBERNETES_API_UNAVAILABLE case below).
    const admitted = await fixture.admitInitialRevision("private-secret-write-forbidden");
    const events = [];
    let preparations = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision() {
          preparations += 1;
          const refused = new KubernetesSecretWriteForbiddenError();
          refused.cause = Object.assign(
            new Error("The Kubernetes API answered HTTP 403 (Forbidden)."),
            { code: 403, reason: "Forbidden" },
          );
          throw refused;
        },
      },
      { emit: (event) => events.push(event) },
    );
    await assertFailedDeployment(fixture, admitted, {
      error: {
        code: "KUBERNETES_SECRET_WRITE_FORBIDDEN",
        message:
          "Kubernetes refused access to a Secret this version needs (HTTP 403 Forbidden), so the controller did not retry. Ask a platform operator to check the worker's tenant RoleBindings for secrets and any admission policy or ResourceQuota, then deploy again.",
      },
    });
    assert.equal(preparations, 1);
    const completed = events.filter(
      (event) => event.event === "worker.completed" && event.revisionId === admitted.candidate.id,
    );
    assert.deepEqual(
      completed.map(({ outcome, code, cause, status, reason }) => ({
        outcome,
        code,
        cause,
        status,
        reason,
      })),
      [
        {
          outcome: "permanent",
          code: "KUBERNETES_SECRET_WRITE_FORBIDDEN",
          cause: "KubernetesSecretWriteForbiddenError",
          status: 403,
          reason: "Forbidden",
        },
      ],
    );
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
// deadline. Finding 2265: so must a private Secret write (the workspace setup Secret that
// activation delivers) that Kubernetes refuses with 403, as it does during preparation
// (finding 1770). Both activation paths are covered: the pass that publishes the active
// pointer, and a later pass that finds the pointer already published.
for (const refusal of [
  {
    label: "the Gateway refuses as unauthorized",
    slug: "gateway-unauthorized",
    failure: () =>
      new ActivationFailedError(
        "AGENT_GATEWAY_UNAUTHORIZED",
        "The exact AgentRevision gateway refused its own CLI as unauthorized.",
      ),
    error: {
      code: "AGENT_GATEWAY_UNAUTHORIZED",
      message:
        "The Agent Gateway refused its own CLI as unauthorized. Check that the Agent's Configuration sets gateway.auth.password to OPENCLAW_GATEWAY_PASSWORD (Enable gateway password access), then deploy again.",
    },
    cause: "ActivationFailedError",
  },
  {
    label: "that discovers incompatible Codex permission policy",
    slug: "activation-codex-permission-policy",
    failure: () =>
      new ActivationFailedError(
        "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE",
        "The Codex Harness reports managed permission requirements incompatible with activation.",
        ["named-profile-denied", "reviewer-denied"],
      ),
    error: {
      code: "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE",
      message:
        "This Codex runtime’s managed permission policy does not allow the sandbox mode, named profile or human reviewer required by OpenShell. Ask the policy owner to verify compatibility, then deploy a new version.",
    },
    cause: "ActivationFailedError",
    diagnosticFailure: "named-profile-denied_reviewer-denied",
  },
  {
    label: "whose private Secret write Kubernetes refuses with 403",
    slug: "activation-secret-forbidden",
    failure: () =>
      Object.assign(new KubernetesSecretWriteForbiddenError(), {
        cause: Object.assign(new Error("The Kubernetes API answered HTTP 403 (Forbidden)."), {
          code: 403,
          reason: "Forbidden",
        }),
      }),
    error: {
      code: "KUBERNETES_SECRET_WRITE_FORBIDDEN",
      message:
        "Kubernetes refused access to a Secret this version needs (HTTP 403 Forbidden), so the controller did not retry. Ask a platform operator to check the worker's tenant RoleBindings for secrets and any admission policy or ResourceQuota, then deploy again.",
    },
    cause: "KubernetesSecretWriteForbiddenError",
  },
]) {
  for (const pendingPasses of [0, 1]) {
    revisionTest(
      `an activation ${refusal.label} fails deployment at once (after ${pendingPasses} pending passes)`,
      async (fixture) => {
        const { owner, candidate } = await fixture.admitInitialRevision(
          `${refusal.slug}-${pendingPasses}`,
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
              throw refusal.failure();
            },
          },
          { emit: (event) => events.push(event) },
        );

        await assertFailedDeployment(
          fixture,
          { owner, candidate },
          { error: refusal.error },
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
          .filter(
            (event) => event.event === "worker.completed" && event.revisionId === candidate.id,
          )
          .at(-1);
        assert.deepEqual(
          {
            outcome: last?.outcome,
            code: last?.code,
            cause: last?.cause,
            failure: last?.failure,
          },
          {
            outcome: "permanent",
            code: refusal.error.code,
            cause: refusal.cause,
            failure: refusal.diagnosticFailure,
          },
        );
      },
    );
  }
}

// Finding 2265: a maintenance pass of a running revision is no deployment anyone waits on. A
// 403 on a private Secret write there, in preparation or activation, fails only that bounded
// pass, as an outage does, and keeps the maintenance chain, so the Agent keeps its runtime and
// recovers by itself once an operator fixes the grant instead of needing a new deployment.
for (const [step, label] of [
  ["prepareRevision", "preparation"],
  ["activateRevision", "activation"],
]) {
  revisionTest(
    `a Kubernetes 403 on a private Secret write during maintenance ${label} keeps the maintenance chain`,
    async (fixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision(
        `maintenance-secret-forbidden-${label}`,
      );
      const events = [];
      let refuse = false;
      await fixture.start(
        {
          ...fixture.compute,
          maintenanceIntervalMs: 200,
          async [step](...args) {
            if (refuse) {
              throw new KubernetesSecretWriteForbiddenError();
            }
            // The fixture's Compute has no activation step of its own.
            return fixture.compute[step]?.(...args);
          },
        },
        { emit: (event) => events.push(event) },
      );
      await fixture.work(candidate, "succeeded");
      refuse = true;
      const maintenance = `agent_revision:${candidate.id}:maintenance:`;
      const refused = await completion(
        events,
        "a maintenance pass refused with 403",
        (event) =>
          event.event === "worker.completed" &&
          event.workId?.startsWith(maintenance) &&
          event.cause === "KubernetesSecretWriteForbiddenError",
      );
      assert.deepEqual(
        { outcome: refused.outcome, code: refused.code },
        { outcome: "pending", code: "REVISION_FINALIZATION_INCOMPLETE" },
      );
      refuse = false;
      await completion(
        events,
        "a later maintenance pass to succeed",
        (event, index) =>
          index > events.indexOf(refused) &&
          event.event === "worker.completed" &&
          event.workId?.startsWith(maintenance) &&
          event.outcome === "success",
      );
      assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
      assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "succeeded");
    },
  );
}

function withBothPluginDrivers(drivers) {
  return { ...drivers, pluginDrivers: [new OCCPluginDriver(), new CodexPluginDriver()] };
}

revisionTest(
  "a worker with a missing pinned Plugin Driver keeps the previous revision active",
  async (fixture) => {
    const { owner, candidate: previous } = await fixture.admitInitialRevision("plugin-cutover", {
      agent: { executionMode: "dedicated" },
    });
    await fixture.start(
      {
        ...fixture.compute,
        requiresStoppedPredecessors: () => true,
        maintenanceIntervalMs: 3_600_000,
        async stopRevision(revision) {
          assert.notEqual(
            revision.id,
            previous.id,
            "a rejected plugin pin cannot stop the active revision",
          );
          return fixture.compute.stopRevision(revision);
        },
      },
      { transformDrivers: (drivers) => ({ ...drivers, pluginDrivers: [new OCCPluginDriver()] }) },
    );
    await fixture.work(previous, "succeeded");
    // The admitted revision pins Codex, but this worker no longer has that Driver.
    const next = await fixture.revision(owner, 2, {
      plugins: codexPluginRevisionState("codex-plugin:linear@openai-curated-remote"),
    });
    await fixture.work(next, "failed_permanent");
    assert.equal((await fixture.workResult(next)).rows[0].reason_code, "PLUGIN_DRIVER_MISMATCH");
    const {
      rows: [nextMaintenance],
    } = await fixture.advanceMaintenance(previous);
    const maintenance = { ...previous, idempotencyKey: nextMaintenance.idempotency_key };
    await fixture.work(maintenance, "succeeded");
    assert.equal(
      (await fixture.workResult(maintenance)).rows[0].reason_code,
      "REVISION_ALREADY_ACTIVE",
    );
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, previous.id);
  },
);

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

    await fixture.start(
      {
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
      },
      { transformDrivers: withBothPluginDrivers },
    );

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
    await fixture.start(
      {
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
      },
      { transformDrivers: withBothPluginDrivers },
    );

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
    await fixture.start(
      {
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
      },
      { transformDrivers: withBothPluginDrivers },
    );

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

// Finding 2415: native prepared Git issues a version's first token only after its active pointer
// is published, so a ready runtime reported success while every Git request answered 503. The
// deployment now waits for the token. Owner decision 2026-10-28 (finding 2425) for a version
// whose token GitHub's answer quarantined: a new Agent's deployment fails and its version is
// retired; an existing Agent's deployment fails but the version keeps running without Git, so
// the Agent can still chat and report it. A token still pending at the convergence deadline
// (finding 2894: no attempt finished, for example an unreadable App key) ends the same way: a new
// Agent's version is retired, an existing Agent's is kept and gets Git if the token arrives.
for (const { agent, material } of [
  { agent: "new", material: "ready" },
  { agent: "new", material: "quarantined" },
  { agent: "new", material: "pending" },
  { agent: "existing", material: "quarantined" },
  { agent: "existing", material: "pending" },
  // The earlier version's deployment completed without activation: still a new Agent.
  { agent: "stopped-before-activation", material: "quarantined" },
]) {
  test(
    `a ${agent} Agent's native repository deployment waits for its first GitHub token, ` +
      `then handles a ${material} token`,
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const revisionOptions = { repositoryCredentials: repository.snapshot };
      // A stopped repository version fails its deployment (REPOSITORY_REVISION_STOPPED), so the
      // version stopped before activation binds no repository.
      const { owner, candidate: first } = await fixture.admitInitialRevision(
        `repository-token-${agent}-${material}`,
        { revision: agent === "stopped-before-activation" ? {} : revisionOptions },
      );
      const ready = async () => "ready";
      if (agent === "existing") {
        await fixture.start(fixture.compute, { repositoryGitMaterial: ready });
        await fixture.work(first, "succeeded");
        await fixture.stop();
      } else if (agent === "stopped-before-activation") {
        // The Agent is stopped while its first version prepares: that deployment completes
        // REVISION_STOPPED, a succeeded work row that never activated anything.
        let release;
        const released = new Promise((resolve) => {
          release = resolve;
        });
        let preparing;
        const started = new Promise((resolve) => {
          preparing = resolve;
        });
        await fixture.start(
          {
            ...fixture.compute,
            async prepareRevision(revision) {
              preparing();
              await released;
              return fixture.compute.prepareRevision(revision);
            },
          },
          { repositoryGitMaterial: ready },
        );
        await started;
        const stop = await fixture.requestStop(owner);
        release();
        await fixture.work(first, "succeeded");
        await fixture.work(stop, "succeeded");
        await fixture.stop();
        assert.equal((await fixture.workResult(first)).rows[0].reason_code, "REVISION_STOPPED");
      }
      const candidate = agent === "new" ? first : await fixture.revision(owner, 2, revisionOptions);
      const checked = [];
      const stopped = [];
      const retired = [];
      let published = 0;
      let waiting;
      const compute = {
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
        async retireRevision(revision) {
          retired.push(revision.id);
          return fixture.compute.retireRevision(revision);
        },
      };
      const events = [];
      await fixture.start(compute, {
        emit: (event) => events.push(event),
        // A pending token ends at the convergence deadline.
        ...(material === "pending" ? { convergenceTimeoutMs: 3_000 } : {}),
        async repositoryGitMaterial(revisionId) {
          // A later version (below) gets its token at once.
          if (revisionId !== candidate.id) {
            return "ready";
          }
          checked.push(revisionId);
          // In production the worker's prepared owner reports the token state; this returns the
          // states its store returns (postgres-prepared-github-git-use test). Like the owner,
          // nothing is issued before the pointer is published. The first check after it
          // records the wait; GitHub answers before the next one.
          const pointer = (await fixture.activePointer(owner)).rows[0]?.active_revision_id;
          if (pointer !== candidate.id || published++ === 0) {
            return "pending";
          }
          waiting ??= await fixture.deploymentStatus(owner, candidate);
          return material;
        },
      });
      await fixture.work(candidate, material === "ready" ? "succeeded" : "failed_permanent");
      assert.ok(checked.length >= 2 && checked.every((id) => id === candidate.id), checked.join());
      // The wait is visible as progress, never as success.
      assert.notEqual(waiting.status, "succeeded");
      assert.equal(waiting.progress?.lastAttempt?.code, "REPOSITORY_GIT_MATERIAL_PENDING");
      const status = await fixture.deploymentStatus(owner, candidate);
      const pointer = async () => (await fixture.activePointer(owner)).rows[0].active_revision_id;
      if (material === "ready") {
        assert.equal(status.status, "succeeded");
        assert.equal(status.error, null);
        assert.equal(await pointer(), candidate.id);
        assert.deepEqual(stopped, []);
        return;
      }
      // A quarantined version is never prepared again, so its deployment fails at once instead
      // of at the convergence deadline, and names the cause and the recovery. A token still
      // pending ends at the deadline: a new Agent's deployment names the deadline, an existing
      // Agent's names the missing token and keeps the version.
      assert.equal(status.status, "failed");
      assert.equal(
        status.error.code,
        material === "quarantined"
          ? "REPOSITORY_GIT_TOKEN_QUARANTINED"
          : agent === "existing"
            ? "REPOSITORY_GIT_TOKEN_PENDING"
            : "CONVERGENCE_DEADLINE_EXCEEDED",
      );
      assert.match(status.error.message, /deploy a new version\.$/);
      const retirement = () =>
        fixture.observerPool.query(
          `SELECT state FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
        );
      if (agent !== "existing") {
        // A new Agent fails: like any repository version that failed for good, its version is
        // retired, so the Agent has no running version until a deployment succeeds.
        await waitFor("the failed version's runtime retirement", async () =>
          (await retirement()).rows[0]?.state === "succeeded" ? true : undefined,
        );
        assert.deepEqual(stopped, [candidate.id]);
        assert.equal(await pointer(), null);
        return;
      }
      // An existing Agent keeps this version serving without Git and says so. Its predecessor
      // stopped serving when the pointer moved; this deployment neither stops its own version
      // nor retires the predecessor.
      assert.match(status.error.message, /keeps this version running without Git/);
      // The pass ends with its completion event, after any Compute call it makes. A pass that
      // throws after the failure committed (for example a Compute call for a claim it no longer
      // holds) logs worker.error instead.
      const ended = await completion(
        events,
        "the failed deployment's completion",
        ({ event, workId, outcome }) =>
          event === "worker.error" ||
          (event === "worker.completed" &&
            workId === candidate.idempotencyKey &&
            outcome === "permanent"),
      );
      assert.equal(ended.event, "worker.completed", JSON.stringify(ended));
      assert.equal(await pointer(), candidate.id);
      assert.equal((await fixture.currentAgent(owner)).desiredRuntimeState, "running");
      assert.equal((await retirement()).rowCount, 0);
      assert.deepEqual(stopped, []);
      assert.deepEqual(retired, []);
      // A pending token can still commit after the deadline and give the kept version Git: the
      // prepared owner issues a token for an open session of the running Agent's active version
      // (postgres-prepared-github-git-use test), and this version keeps its session open.
      const openSessions = async () => [
        ...new Set(
          (await repositoryAttempts(fixture, candidate)).map(({ phase }) => phase === "open"),
        ),
      ];
      assert.deepEqual(await openSessions(), [true]);
      // The failure starts the version's maintenance chain in the same transaction; its next
      // pass keeps the version active (and retires the superseded predecessor, as any does).
      const [maintenance] = (await fixture.advanceMaintenance(candidate)).rows;
      assert.ok(maintenance, "the failed deployment queued the version's maintenance");
      const passed = await waitFor("the version's maintenance pass", async () => {
        const { rows } = await fixture.observerPool.query(
          "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
          [maintenance.idempotency_key],
        );
        return rows[0]?.state === "succeeded" ? rows[0] : undefined;
      });
      assert.equal(passed.reason_code, "REVISION_ALREADY_ACTIVE");
      assert.equal(await pointer(), candidate.id);
      assert.deepEqual(stopped, []);
      assert.deepEqual(retired, [first.id]);
      assert.deepEqual(await openSessions(), [true]);
      // A later version whose token GitHub issues replaces the kept one as usual: its deployment
      // succeeds, takes the pointer and retires the version that ran without Git.
      const fixed = await fixture.revision(owner, 3, revisionOptions);
      await fixture.work(fixed, "succeeded");
      assert.equal((await fixture.deploymentStatus(owner, fixed)).status, "succeeded");
      assert.equal(await pointer(), fixed.id);
      assert.ok(retired.includes(candidate.id), retired.join());
      assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "failed");
    },
  );
}

// Finding 2894 keeps an existing Agent's version only when the deadline ended its wait for the
// first Git token. A published version whose runtime never activated is a convergence failure
// even when its token is pending, and so is Compute's Sandbox install, which shares the token
// wait's code, once the token is committed: both retire the version as before.
for (const { wait, material } of [
  { wait: "WORKSPACE_NODE_PENDING", material: "pending" },
  { wait: "REPOSITORY_GIT_MATERIAL_PENDING", material: "ready" },
]) {
  test(
    `an existing Agent's native repository version that waits at ${wait} with a ${material} ` +
      "token fails at the convergence deadline and is retired",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const revisionOptions = { repositoryCredentials: repository.snapshot };
      const { owner, candidate: first } = await fixture.admitInitialRevision(
        `repository-deadline-${wait.toLowerCase()}`,
        { revision: revisionOptions },
      );
      await fixture.start(fixture.compute, { repositoryGitMaterial: async () => "ready" });
      await fixture.work(first, "succeeded");
      await fixture.stop();
      const candidate = await fixture.revision(owner, 2, revisionOptions);
      const stopped = [];
      await fixture.start(
        {
          ...fixture.compute,
          async activateRevision(revision, revisionContext) {
            // The published version's activation never completes before the deadline.
            if (revision.id === candidate.id) {
              throw new ActivationPendingError(wait, "The test runtime is not ready.");
            }
            return fixture.compute.activateRevision?.(revision, revisionContext);
          },
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
        },
        {
          convergenceTimeoutMs: 3_000,
          repositoryGitMaterial: async (revisionId) =>
            revisionId === candidate.id ? material : "ready",
        },
      );
      await fixture.work(candidate, "failed_permanent");
      const status = await fixture.deploymentStatus(owner, candidate);
      assert.equal(status.status, "failed");
      assert.equal(status.error.code, "CONVERGENCE_DEADLINE_EXCEEDED");
      await waitFor("the failed version's runtime retirement", async () => {
        const { rows } = await fixture.observerPool.query(
          `SELECT state FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
        );
        return rows[0]?.state === "succeeded" ? true : undefined;
      });
      assert.deepEqual(stopped, [candidate.id]);
      assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, null);
    },
  );
}

test(
  "a running native repository version's maintenance ignores a quarantined token renewal",
  requiresPostgres,
  async (context) => {
    // Finding 2415: only a deployment waits for its version's token. A running version whose
    // renewal GitHub refused keeps its maintenance chain: failing that pass would fail a version
    // nobody deployed just now, and its renewal failure is reported in the worker log instead.
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { owner, candidate } = await fixture.admitInitialRevision("repository-token-renewal", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const events = [];
    let state = "ready";
    await fixture.start(
      { ...fixture.compute, maintenanceIntervalMs: 200 },
      {
        emit: (event) => events.push(event),
        repositoryGitMaterial: async () => state,
      },
    );
    await fixture.work(candidate, "succeeded");
    // The running version's renewal is quarantined from now on.
    state = "quarantined";
    const quarantinedAt = events.length;
    const maintenance = `agent_revision:${candidate.id}:maintenance:`;
    const passes = () =>
      events
        .slice(quarantinedAt)
        .filter(
          (event) => event.event === "worker.completed" && event.workId?.startsWith(maintenance),
        );
    // Two passes, so at least one began after the quarantine.
    await waitFor("two maintenance passes after the quarantine", async () =>
      passes().length >= 2 ? true : undefined,
    );
    const completed = passes();
    assert.ok(
      completed.every(({ outcome }) => outcome === "success"),
      completed.map(({ outcome, code }) => `${outcome}:${code}`).join(),
    );
    assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "succeeded");
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
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

registerRevisionDispatchCases({ revisionTest, setup });

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
