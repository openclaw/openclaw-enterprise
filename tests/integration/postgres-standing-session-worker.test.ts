import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import {
  CREDENTIAL_GATEWAY_FIXTURE_ID,
  createWorkerRevisionFixtures,
} from "../helpers/postgres-worker-revision-fixture.mjs";
import { requiresPostgres, databaseUrl } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { ensurePostgresAgentBootstrap } from "../helpers/postgres-agent-app.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import type {
  ComputeDriver,
  ComputeRevisionContext,
  CredentialGatewayDriver,
  SandboxHarnessObservation,
  RepositoryCredentialRuntimeBinding,
} from "../../packages/contracts/src/index.ts";
import type { ControllerWorker } from "../../apps/controller/src/worker.ts";
import type { Pool } from "pg";
import { permissionsForProfile } from "../../apps/controller/src/drivers/repo/github/credentials/profiles.ts";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/index.ts";

// The worker reaches model withdrawal through Compute. This registration supplies only
// the paired gateway identity; the test does not claim real provider attachment or chat.
function observationGateway(): CredentialGatewayDriver {
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected direct gateway effect");
  };
  return {
    id: CREDENTIAL_GATEWAY_FIXTURE_ID,
    implementation: "credential-gateway-worker-fixture",
    capability: "credential_gateway",
    validateSourceConfig() {},
    listSourceTypes: async () => [],
    registerSource: unused,
    updateSource: unused,
    sourceStatus: unused,
    removeSource: unused,
    attachForRevision: unused,
    attachmentStatus: unused,
    withdraw: unused,
  };
}

// Real queue, worker, State, Repo/Unix receipt protocol and HTTPS provider. Compute is a
// controlled observation adapter; this does not claim an OpenShell process or actual chat.
const cases = {
  stop: "stopping the registered execution denies a new provider issuance while cleanup is paused",
  remove:
    "registered worker renews the same standing execution across both expired horizons and removal immediately fences use",
  missing:
    "standing maintenance supervises missing Git evidence across restart and still withdraws model authority",
};
for (const [action, name] of Object.entries(cases)) {
  test(name, { ...requiresPostgres, timeout: 240_000 }, async (t) => {
    await ensurePostgresAgentBootstrap(t, {
      label: "standing-worker-" + action,
      authSecret: "standing-worker-fixture-auth-secret-32",
    });
    const database = {
      url: databaseUrl!,
      pools: new Set<Pool>(),
      workers: new Set<ControllerWorker>(),
    };
    // Close database pools after broker shutdown has persisted its final receipts.
    t.after(() =>
      t.after(async () => {
        for (const worker of database.workers) {
          await worker.stop();
        }
        for (const pool of database.pools) {
          if (!("ending" in pool && pool.ending)) {
            await pool.end();
          }
        }
      }),
    );
    const setupOptions = { database, leaseDurationMs: 30_000 };
    const f = await createWorkerRevisionFixtures(import.meta.url).setup(t, setupOptions);
    try {
      const credentials = await startRegistryCredentialServiceFixture(t, {
        namespaceId: f.namespace.id,
        autoOpen: false,
        clock: createSystemClock(),
        tokenLifetimeMs: 80_000,
        limits: { exchangeMs: 5_000, credentialMarginMs: 1_000 },
        gateway: { listen: "127.0.0.1:0" },
      });
      assert.ok(credentials);
      const { tls, listeners } = credentials;
      const registry = structuredClone(credentials.registry);
      registry.allowStandingApprovals = true;
      for (const r of registry.repositories) {
        for (const p of r.namespaces) {
          p.allowStandingApproval = true;
        }
      }
      const backend = {
        id: credentials.backendId,
        client: new UnixRepositoryCredentialControlClient({
          controlSocket: credentials.config.gateway.controlSocket,
        }),
        drivers: { repo: "repository-credentials" },
      };
      const driver = new GitHubRepositoryPolicy(backend, registry, { sessionDurationSeconds: 90 });
      const sender = new GitHubNativeRepositorySender(backend, { publicCa: credentials.tls.ca });
      const receipt = await startRepositoryReceiptServer({
        state: f.state,
        controlSocket: credentials.config.gateway.controlSocket,
        driverId: driver.id,
        implementation: driver.implementation,
        backendId: credentials.backendId,
      });
      t.after(() => receipt.close());
      const owner = await f.agent(
        "standing-runtime",
        action === "missing" ? { auth: "credential_source" } : {},
      );
      const modelSourceId =
        owner.harnessAuth?.method === "credential_source" ? owner.harnessAuth.sourceId : undefined;
      const [selected] = driver.resolve({
        namespaceId: f.namespace.id,
        bindings: [{ repositoryRef: "repo-a", profile: "git-write" }],
      }).bindings;
      const binding = selected!;
      await f.observerPool.query("UPDATE occ.agents SET repository_bindings=$1 WHERE id=$2", [
        JSON.stringify([{ repositoryRef: binding.repositoryRef, profile: binding.profile }]),
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
      const originalBoundary = Date.now() + 90_000;
      const revisionOptions = {
        actorId: f.actor.id,
        repositoryCredentials: {
          driver: { id: driver.id, implementation: driver.implementation },
          bindings: [binding],
          deadlineWallMs: originalBoundary,
          standingApprovalId: approval.id,
          standingApprovalGeneration: approval.generation,
          standingApprovalScopeFingerprint: fingerprint,
        },
      };
      const revision = await f.revision(owner, 1, revisionOptions);
      const execution = {
        executionId: randomUUID(),
        fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      };
      type Delivered = Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>;
      const deliveries: Delivered[] = [];
      type WorkerEvent = {
        event?: string;
        revisionId?: string;
        code?: string;
        outcome?: string;
        harnessState?: SandboxHarnessObservation["state"];
      };
      const events: WorkerEvent[] = [];
      let created = false;
      let executionCreates = 0;
      let stopped = 0;
      let withdrawalReads = 0;
      let evidenceMissing = false;
      let prepares = 0;
      let activations = 0;
      let observations = 0;
      let modelWithdrawals = 0;
      let harness: SandboxHarnessObservation = { state: "running" };
      const compute = {
        ...f.compute,
        validateRepositoryCredentials() {},
        async prepareRevision(
          r: Parameters<ComputeDriver["prepareRevision"]>[0],
          context?: ComputeRevisionContext,
        ) {
          prepares++;
          if (!created) {
            created = true;
            executionCreates++;
          }
          for (const value of context?.repositoryCredentials ?? []) {
            if (value.kind === "new") {
              deliveries.push(value);
            }
          }
          return f.compute.prepareRevision(r);
        },
        async verifyRepositoryExecution(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          return !evidenceMissing && created && r.id === revision.id ? execution : undefined;
        },
        async observeRevision(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          assert.equal(r.id, revision.id);
          assert.equal(created, true);
          observations++;
          return harness;
        },
        ...(action === "missing"
          ? {
              async activateRevision() {
                activations++;
              },
            }
          : {}),
        async withdrawCredentialSource(
          r: Parameters<ComputeDriver["prepareRevision"]>[0],
          source: { id: string },
        ) {
          assert.equal(r.id, revision.id);
          assert.equal(source.id, modelSourceId);
          modelWithdrawals++;
          return { sourceId: source.id, state: "revoked" as const };
        },
        async retireExpiredRepositoryAccess(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          assert.equal(r.id, revision.id);
          assert.equal(created, true);
          withdrawalReads++;
          return "withdrawn" as const;
        },
        async stopRevision(r: Parameters<ComputeDriver["stopRevision"]>[0]) {
          assert.equal(
            r.id,
            revision.id,
            "stopping a different revision cannot change this execution",
          );
          stopped++;
          created = false;
        },
      };
      const start = () =>
        f.start(compute, {
          emit: (e?: WorkerEvent) => {
            if (e) {
              events.push(e);
            }
          },
          transformDrivers: (d: { installation: { drivers: object } }) => {
            if (action !== "missing") {
              return { ...d, repositoryPolicy: driver, nativeRepositorySender: sender };
            }
            const gateway = observationGateway();
            const sandbox = {
              id: "sandbox-worker-fixture",
              capability: "sandbox" as const,
              implementation: "sandbox-worker-fixture",
              facets: ["networking"],
              async cleanup() {},
            };
            return {
              ...d,
              repositoryPolicy: driver,
              nativeRepositorySender: sender,
              credentialGatewayDriver: gateway,
              sandboxDriver: sandbox,
              installation: {
                ...d.installation,
                drivers: {
                  ...d.installation.drivers,
                  sandbox: { id: sandbox.id, configuration: {} },
                  credential_gateway: { id: gateway.id, configuration: {} },
                },
              },
            };
          },
        });
      await start();
      await f.work(revision, "succeeded");
      await waitFor(
        "durable execution observation",
        () =>
          f.state.read((v) =>
            v.repositorySessions.findStandingExecution({
              namespaceId: f.namespace.id,
              agentId: owner.id,
              revisionId: revision.id,
            }),
          ),
        15_000,
      );
      const first = await waitFor("first session", async () => deliveries[0]);
      async function read(material: Delivered) {
        return new Promise<number | undefined>((resolve, reject) => {
          const req = httpsRequest(
            {
              hostname: "127.0.0.1",
              port: listeners.address.port,
              path: "/fixture/repository.git/info/refs?service=git-upload-pack",
              method: "GET",
              ca: tls.ca,
              agent: false,
              headers: {
                host: "credentials.example.test",
                authorization: `Basic ${Buffer.from(`gateway-session:${material.files.bearer}`).toString("base64")}`,
              },
            },
            (res) => {
              res.resume();
              res.once("end", () => resolve(res.statusCode));
              res.once("error", reject);
            },
          );
          req.once("error", reject);
          req.end();
        });
      }
      const provider = credentials.repositories[0]!.github;
      if (action === "missing") {
        assert.ok(modelSourceId);
        // The first observation can precede completion of the claim that schedules maintenance.
        await waitFor("active maintenance established", async () =>
          events.find((e) => e.revisionId === revision.id && e.code === "REVISION_ALREADY_ACTIVE"),
        );
        await f.stop();
        const before = { prepares, activations, deliveries: deliveries.length };
        const ownerRef = {
          namespaceId: f.namespace.id,
          agentId: owner.id,
          revisionId: revision.id,
        };
        const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
        const key = (await queue.latestRevisionMaintenanceKey(ownerRef))!;
        evidenceMissing = true;
        for (const state of ["running", "unknown"] as const) {
          // The Driver may return fields outside its declared type; they must not enter logs.
          harness = { state, ...{ diagnostic: "driver-only-observation-data" } };
          events.length = 0;
          // Only advance queue due time. Keep the real approval, session, execution and
          // model source unchanged; restart creates a fresh worker and database pool.
          await f.advanceMaintenance(revision);
          await start();
          await waitFor("pending Git evidence observation", async () =>
            events.find(
              (e) => e.revisionId === revision.id && e.code === "REPOSITORY_EXECUTION_UNVERIFIED",
            ),
          );
          await f.stop();
          const pending = await queue.findWork(key);
          assert.equal(pending?.state, "queued");
          assert.equal(pending?.attemptCount, 0, "missing evidence does not spend retry budget");
          assert.ok(pending!.availableAt.getTime() <= Date.now() + 5_000);
          assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
          assert.deepEqual({ prepares, activations, deliveries: deliveries.length }, before);
          assert.equal(provider.issuesOfTokens.length, 0);
          assert.equal(stopped, 0);
          assert.ok(events.some((e) => e.outcome === "pending" && e.harnessState === state));
          assert.ok(!JSON.stringify(events).includes("driver-only-observation-data"));
          assert.ok(!events.some((e) => e.code === "REVISION_ALREADY_ACTIVE"));
        }
        assert.equal(observations, 2);
        // Genuine evidence recovery may enter ordinary preparation again. It must not be
        // reported by either unknown pass, nor require a replacement Agent execution.
        evidenceMissing = false;
        await f.advanceMaintenance(revision);
        await start();
        await waitFor("verified execution recovered", async () =>
          events.find((e) => e.revisionId === revision.id && e.code === "REVISION_ALREADY_ACTIVE"),
        );
        await f.stop();
        assert.ok(prepares > before.prepares);
        assert.equal(executionCreates, 1);
        evidenceMissing = true;
        const recoveredPrepares = prepares;
        const recoveredActivations = activations;
        // The normal API records model withdrawal while Git evidence is missing. The next
        // worker must deliver that withdrawal, never prepare the Agent to observe it.
        await f.controller.withdrawAgentCredentialSource(f.actor.id, {
          namespaceId: f.namespace.id,
          agentId: owner.id,
          credentialSourceId: modelSourceId,
        });
        await f.advanceMaintenance(revision);
        await start();
        await waitFor("model withdrawal acknowledged", async () => {
          const row = await f.state.read((v) =>
            v.credentialSources.findCredentialWithdrawal(
              f.namespace.id,
              revision.id,
              modelSourceId,
            ),
          );
          return row?.state === "revoked" ? row : undefined;
        });
        await f.stop();
        assert.ok(modelWithdrawals > 0);
        assert.equal(prepares, recoveredPrepares);
        assert.equal(activations, recoveredActivations);
        assert.equal(provider.issuesOfTokens.length, 0);
        return;
      }
      if (action === "stop") {
        await f.stop();
        // Keep the real receipt service and broker alive; no worker can clean up this session yet.
        assert.equal(provider.issuesOfTokens.length, 0);
        await f.controller.stopAgent(f.actor.id, f.namespace.id, owner.id);
        assert.equal(await read(first), 503);
        assert.ok(first.deadlineWallMs > Date.now());
        assert.equal(
          provider.issuesOfTokens.length,
          0,
          "stop prevented even the first provider issuance",
        );
        assert.equal(
          (
            await f.state.read((v) =>
              v.repositorySessions.findBrokerReceiptBySession(first.sessionId),
            )
          )?.state,
          "active",
        );
        // Finish this revision's pending stop before the next worker can claim it.
        await start();
        await waitFor("stopped revision released", async () => {
          const current = await f.currentAgent(owner);
          return stopped > 0 && current?.activeRevisionId === undefined ? true : undefined;
        });
        await f.stop();
        return;
      }
      assert.equal(await read(first), 200);
      assert.equal(provider.issuesOfTokens.length, 1);
      const firstIssue = provider.issuesOfTokens[0]!;
      assert.deepEqual(firstIssue.permissions, scope.apiPermissions);
      assert.deepEqual(firstIssue.permissions, permissionsForProfile("git-write"));
      assert.deepEqual(firstIssue.repositoryIds.map(String), [scope.repositoryId]);
      // No manufactured DB clock: wait for the shortened, real wall-clock session horizon.
      await waitFor(
        "successor delivery",
        async () => deliveries.find((d) => d.sessionId !== first.sessionId),
        120_000,
      );
      await waitFor(
        "both first finite horizons",
        async () =>
          Date.now() > Math.max(originalBoundary, firstIssue.expires) + 250 ? true : undefined,
        120_000,
      );
      const second = deliveries.at(-1)!;
      assert.notEqual(second.sessionId, first.sessionId);
      assert.ok(Date.now() > first.deadlineWallMs);
      assert.notEqual(await read(first), 200, "old session cannot use the successor");
      const observedAfter = Date.now();
      assert.equal(await read(second), 200);
      assert.equal(provider.issuesOfTokens.length, 2);
      assert.notEqual(provider.issuesOfTokens.at(-1)!.index, firstIssue.index);
      assert.ok(Date.now() > firstIssue.expires, "first provider token really expired");
      const attempts = await f.state.read((v) =>
        v.repositorySessions.listRevisionAttempts({
          namespaceId: f.namespace.id,
          agentId: owner.id,
          revisionId: revision.id,
        }),
      );
      const old = attempts.find((a) => a.sessionId === first.sessionId)!;
      const next = attempts.find((a) => a.sessionId === second.sessionId)!;
      assert.equal(old.deadlineWallMs, originalBoundary);
      assert.equal(old.phase, "disposed");
      assert.equal(next.predecessorAdmissionId, old.admissionId);
      assert.equal(next.executionFingerprint, execution.fingerprint);
      assert.ok(next.deadlineWallMs > originalBoundary);
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
      assert.equal(executionCreates, 1);
      assert.equal(stopped, 0);
      const ownerRef = { namespaceId: f.namespace.id, agentId: owner.id, revisionId: revision.id };
      await assert.rejects(
        f.observerPool.query(
          "UPDATE occ.repository_session_attempts SET deadline_wall_ms=deadline_wall_ms+1000 WHERE admission_id=$1",
          [old.admissionId],
        ),
        { code: "42501" },
      );
      await assert.rejects(
        f.state.transact((u) =>
          u.repositorySessions.recordStandingExecution(ownerRef, {
            ...execution,
            fingerprint: "0".repeat(64),
          }),
        ),
        { name: "ScopeViolationError" },
      );
      // Pause only reconciliation. The receipt owner, broker, and provider remain live:
      // denial cannot be explained by a cleanup pass or an expired replacement.
      await f.stop();
      const secondIssue = provider.issuesOfTokens.at(-1)!;
      const beforeRemoval = provider.tokenState();
      assert.equal(beforeRemoval.length, 2);
      assert.deepEqual(
        beforeRemoval.map((t: { index: number; uses: number }) => [t.index, t.uses]),
        [
          [firstIssue.index, 1],
          [secondIssue.index, 1],
        ],
      );
      assert.ok(
        secondIssue.expires > Date.now(),
        "second provider token is still within its own lifetime",
      );
      await f.controller.removeAgentStandingApproval(f.actor.id, {
        namespaceId: f.namespace.id,
        agentId: owner.id,
        approvalId: approval.id,
        expectedGeneration: 1,
      });
      await assert.rejects(
        f.state.transact((u) => u.repositorySessions.recordStandingExecution(ownerRef, execution)),
        { name: "ScopeViolationError" },
      );
      const removedRequest = await read(second);
      assert.equal(removedRequest, 503, "subsequent Git request denied while cleanup is paused");
      assert.ok(Date.now() < Math.min(secondIssue.expires, second.deadlineWallMs));
      assert.deepEqual(
        provider.tokenState(),
        beforeRemoval,
        "no provider authentication, issuance, or token use after removal",
      );
      await start();
      await waitFor(
        "repository-only removal completed",
        async () =>
          events.find(
            (e) =>
              e.event === "worker.completed" &&
              e.revisionId === revision.id &&
              e.code === "REPOSITORY_STANDING_APPROVAL_REMOVED",
          ),
        20_000,
      );
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
      assert.equal(executionCreates, 1);
      assert.equal(stopped, 0, "repository removal does not stop Compute");
      await waitFor(
        "replacement session disposed",
        async () =>
          (await f.state.read((v) => v.repositorySessions.findAttempt(next.admissionId)))?.phase ===
          "disposed"
            ? true
            : undefined,
        // The real driver checks a CLOSED receipt again at its normal cleanup interval.
        sender.maintenanceIntervalMs + 15_000,
      );
      const failedWork = await f.observerPool.query(
        "SELECT reason_code FROM occ.controller_work WHERE revision_id=$1 AND state='failed_permanent'",
        [revision.id],
      );
      assert.deepEqual(
        failedWork.rows,
        [],
        "ordinary turnover must not permanently fail maintenance",
      );
      assert.equal(provider.issuesOfTokens.length, 2);
      assert.equal(provider.tokenState().at(-1)?.revoked, true);
      await waitFor(
        "withdrawal and successor maintenance committed",
        async () =>
          events.some(
            (event) =>
              event.revisionId === revision.id && event.code === "REPOSITORY_ACCESS_WITHDRAWN",
          ) || undefined,
      );
      await f.stop();
      // The receiving worker confirmed withdrawal through Compute and committed a successor.
      // Lose that maintenance's final lease, then restart the worker after the first deadline.
      const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
      assert.equal(await queue.repositoryExpiryState(ownerRef), "expiry");
      const key = (await queue.latestRevisionMaintenanceKey(ownerRef))!;
      const scheduled = await queue.findWork(key);
      assert.equal(scheduled?.state, "queued");
      assert.ok(
        scheduled!.availableAt.getTime() <= Date.now() + sender.maintenanceIntervalMs + 1000,
        "switching from renewal to ordinary maintenance did not postpone the next observation",
      );
      const beforeRestart = withdrawalReads;
      assert.ok(beforeRestart >= 1, "Compute observed Git withdrawn on the authorized execution");
      const deliveredBeforeRestart = deliveries.length;
      await f.observerPool.query(
        "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key=$1",
        [key],
      );
      const interrupted = await queue.claim();
      assert.equal(interrupted?.idempotencyKey, key);
      await f.observerPool.query(
        "UPDATE occ.controller_work SET lease_expires_at=clock_timestamp() WHERE idempotency_key=$1",
        [key],
      );
      await queue.recoverStale();
      assert.equal((await queue.findWork(key))?.reasonCode, "LEASE_EXPIRED");
      const resumed = (await queue.latestRevisionMaintenanceKey(ownerRef))!;
      assert.notEqual(resumed, key, "recovery continued supervision without restoring the grant");
      await f.observerPool.query(
        "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE idempotency_key=$1",
        [resumed],
      );
      await start();
      await waitFor(
        "new worker supervised the reduced execution",
        async () =>
          (await queue.findWork(resumed))?.reasonCode === "REPOSITORY_ACCESS_WITHDRAWN" ||
          undefined,
      );
      await f.stop();
      assert.ok(withdrawalReads > beforeRestart);
      const subsequent = (await queue.latestRevisionMaintenanceKey(ownerRef))!;
      assert.notEqual(subsequent, resumed);
      assert.equal((await queue.findWork(subsequent))?.state, "queued");
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
      assert.equal(stopped, 0);
      assert.equal(deliveries.length, deliveredBeforeRestart, "maintenance did not restore Git");
      assert.equal(provider.issuesOfTokens.length, 2);
      assert.equal(
        await f.state.read((v) =>
          v.repositorySessions.findStandingApproval(
            f.namespace.id,
            owner.id,
            binding.repositoryRef,
          ),
        ),
        undefined,
      );
      t.diagnostic(
        JSON.stringify({
          sourceProof: "registered-worker-concrete-repo",
          sessions: attempts.map((a) => ({
            admissionId: a.admissionId,
            sessionId: a.sessionId,
            phase: a.phase,
            deadlineWallMs: a.deadlineWallMs,
            predecessorAdmissionId: a.predecessorAdmissionId,
          })),
          approvalId: approval.id,
          generation: 1,
          revisionId: revision.id,
          executionId: execution.executionId,
          executionCreates,
          stopped,
          firstBoundary: originalBoundary,
          observedAfter,
          firstProviderExpiry: firstIssue.expires,
          secondProviderExpiry: secondIssue.expires,
          removedRequest,
          cleanupPausedAtDenial: true,
          providerIssuances: provider.issuesOfTokens.length,
          limits:
            "controlled Compute; private broker read; no OpenShell wire, object transfer or chat proof",
        }),
      );
    } catch (error) {
      t.diagnostic("registered standing session proof stopped before all assertions completed");
      throw error;
    }
  });
}
