import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import {
  loadWorkerNativeRepositoryAccess,
  observationGateway,
  setupStandingWorkerAuthority,
  setupStandingWorkerDatabase,
} from "../helpers/postgres-standing-worker-fixture.ts";
import type {
  ComputeDriver,
  ComputeRevisionContext,
  SandboxHarnessObservation,
  RepositoryCredentialRuntimeBinding,
} from "../../packages/contracts/src/index.ts";

type StandingAuthority = Awaited<ReturnType<typeof setupStandingWorkerAuthority>>;

function standingDrivers({ native }: Pick<StandingAuthority, "native">) {
  return (d: { computeDriver: ComputeDriver; installation: { drivers: object } }) => {
    const gateway = observationGateway();
    const sandbox = {
      id: "sandbox-worker-fixture",
      capability: "sandbox" as const,
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      implementation: "sandbox-worker-fixture",
      facets: ["networking"],
      async cleanup() {},
    };
    return {
      ...d,
      repositoryRuntime: native.access.bindCompute(d.computeDriver),
      tokenService: native.access.tokenService,
      credentialGatewayDriver: gateway,
      sandboxDriver: sandbox,
      installation: {
        ...d.installation,
        repository: native.selection,
        backend: [native.backend],
        drivers: {
          ...d.installation.drivers,
          sandbox: { id: sandbox.id, configuration: {} },
          credential_gateway: { id: gateway.id, configuration: {} },
        },
      },
    };
  };
}

// Real queue, worker, State and prepared native sender; Compute is a controlled
// observation adapter. This does not prove an OpenShell process or actual chat.
test(
  "standing maintenance supervises missing Git evidence across restart and still withdraws model authority",
  { ...requiresPostgres, timeout: 240_000 },
  async (t) => {
    const f = await setupStandingWorkerDatabase(t, import.meta.url);
    try {
      const plugin = new OCCPluginDriver();
      const { credentials, native, owner, modelSourceId, revision, execution } =
        await setupStandingWorkerAuthority(t, f, {
          plugins: {
            driver: { id: plugin.id, implementation: plugin.implementation },
            plugins: { "occ-plugin:diffs": { enabled: true } },
          },
        });
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
        async activateRevision() {
          activations++;
        },
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
      const start = async (pluginInstalled = true) => {
        const access = await native.load();
        return f.start(compute, {
          emit: (e?: WorkerEvent) => {
            if (e) {
              events.push(e);
            }
          },
          transformDrivers: (drivers: {
            computeDriver: ComputeDriver;
            installation: { drivers: object };
          }) => ({
            ...standingDrivers({ native: { ...native, access } })(drivers),
            pluginDrivers: pluginInstalled ? [plugin] : [],
          }),
        });
      };
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
      const provider = credentials.repositories[0]!.github;
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
        // The second restart also drops the admitted plugin. It must still supervise Git.
        await start(state === "running");
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
          v.credentialSources.findCredentialWithdrawal(f.namespace.id, revision.id, modelSourceId),
        );
        return row?.state === "revoked" ? row : undefined;
      });
      await f.stop();
      assert.ok(modelWithdrawals > 0);
      assert.equal(prepares, recoveredPrepares);
      assert.equal(activations, recoveredActivations);
      assert.equal(provider.issuesOfTokens.length, 0);
    } catch (error) {
      t.diagnostic("registered standing session proof stopped before all assertions completed");
      throw error;
    }
  },
);

// Registry opt-in and durable approval are independent authority checks. An
// immutable policy reload requires a restart; only durable approval can race a lock.
for (const change of ["registry", "durable approval"] as const) {
  test(
    change === "registry"
      ? "standing maintenance refuses withdrawn eligibility with unchanged scope"
      : "standing maintenance rechecks durable approval after Namespace lock wait",
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await setupStandingWorkerDatabase(t, import.meta.url);
      try {
        const { credentials, driver, native, owner, approval, revision, execution } =
          await setupStandingWorkerAuthority(t, f);
        const deliveries: Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>[] = [];
        let retainedBindings = 0;
        const events: { event?: string; code?: string; revisionId?: string; workId?: string }[] =
          [];
        const compute = {
          ...f.compute,
          validateRepositoryCredentials() {},
          async prepareRevision(
            r: Parameters<ComputeDriver["prepareRevision"]>[0],
            context?: ComputeRevisionContext,
          ) {
            for (const binding of context?.repositoryCredentials ?? []) {
              if (binding.kind === "new") {
                deliveries.push(binding);
              } else {
                retainedBindings++;
              }
            }
            return f.compute.prepareRevision(r);
          },
          async verifyRepositoryExecution() {
            return execution;
          },
          async observeRevision() {
            return { state: "running" as const };
          },
          async activateRevision() {},
        };
        const start = async (selected = native) => {
          const access = await selected.load();
          return f.start(compute, {
            emit: (event: (typeof events)[number]) => {
              if (event.revisionId === revision.id) {
                events.push(event);
              }
            },
            transformDrivers: standingDrivers({ native: { ...selected, access } }),
          });
        };
        const key = { namespaceId: f.namespace.id, agentId: owner.id, revisionId: revision.id };
        const attempts = () => f.state.read((v) => v.repositorySessions.listRevisionAttempts(key));
        await start();
        await f.work(revision, "succeeded");
        await waitFor("standing maintenance established", async () =>
          events.find(
            (e) => e.event === "worker.completed" && e.code === "REVISION_ALREADY_ACTIVE",
          ),
        );
        await f.stop();
        const before = await attempts();
        assert.equal(before.length, 1, "explicit permission allowed one initial session");
        assert.equal(before[0]!.phase, "open");
        assert.equal(deliveries.length, 1, "initial preparation delivered NEW credential bytes");
        assert.equal(deliveries[0]!.admissionId, before[0]!.admissionId);
        assert.equal(deliveries[0]!.sessionId, before[0]!.sessionId);
        assert.ok(deliveries[0]!.files.bearer.length > 0, "NEW delivery includes credential bytes");
        const deliveredBefore = deliveries.length;
        const retainedBefore = retainedBindings;
        const binding = revision.repositoryCredentials!.bindings[0]!;
        const request = {
          namespaceId: f.namespace.id,
          bindings: [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
        };
        const resolution = driver.resolveBindings(request);
        assert.deepEqual(resolution.bindings, [binding]);
        const readApproval = () =>
          f.state.read((v) =>
            v.repositorySessions.findStandingApproval(
              f.namespace.id,
              owner.id,
              binding.repositoryRef,
            ),
          );
        assert.deepEqual(await readApproval(), approval);
        // Registry opt-in is independent of the durable approval and finite grant. The
        // immutable policy changes only on a new Worker start, never during a lock wait.
        const registry = structuredClone(credentials.registry);
        delete registry.allowStandingApprovals;
        for (const repository of registry.repositories) {
          for (const policy of repository.namespaces) {
            delete policy.allowStandingApproval;
          }
        }
        const withdrawn = await loadWorkerNativeRepositoryAccess(t, credentials, { registry });
        const withdrawnPolicy = withdrawn.access.repositoryAdmission.policy;
        assert.deepEqual(withdrawnPolicy.resolveBindings(request), resolution);
        assert.equal(driver.allowsStandingApproval({ namespaceId: f.namespace.id, binding }), true);
        assert.equal(
          withdrawnPolicy.allowsStandingApproval({ namespaceId: f.namespace.id, binding }),
          false,
        );
        assert.equal(
          withdrawnPolicy.standingApprovalScope({ namespaceId: f.namespace.id, binding }),
          undefined,
        );
        events.length = 0;
        const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
        const maintenanceKey = await queue.latestRevisionMaintenanceKey(key);
        assert.ok(maintenanceKey);
        await f.advanceMaintenance(revision);
        if (change === "registry") {
          await start(withdrawn);
        } else {
          const writer = await f.observerPool.connect();
          let committed = false;
          let removal: Promise<unknown> | undefined;
          try {
            await writer.query("BEGIN");
            const locked = await writer.query(
              "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id=$1 FOR UPDATE",
              [f.namespace.id],
            );
            assert.equal(locked.rowCount, 1);
            // The API waits first. PostgreSQL must let it commit withdrawal before
            // the later Worker waiter can revalidate the same durable generation.
            removal = f.controller.removeAgentStandingApproval(f.actor.id, {
              namespaceId: f.namespace.id,
              agentId: owner.id,
              approvalId: approval.id,
              expectedGeneration: approval.generation,
            });
            void removal.catch(() => {});
            const removalPid = await waitForLockWaiter(
              f.observerPool,
              locked.rows[0].pid,
              "approval removal Namespace lock",
              { queryLike: "%FROM occ.namespaces%FOR UPDATE%", timeoutMs: 10_000 },
            );
            await start();
            await waitFor(
              "standing worker Namespace lock",
              async () => {
                // PostgreSQL can report the first waiter as a soft blocker of the second.
                const { rows } = await f.observerPool.query<{ pid: number }>(
                  `SELECT pid FROM pg_stat_activity
                   WHERE pid <> $1 AND query LIKE $2
                     AND pg_blocking_pids(pid) && ARRAY[$1, $3]::int[]`,
                  [removalPid, "%FROM occ.namespaces%FOR UPDATE%", locked.rows[0].pid],
                );
                return rows[0]?.pid;
              },
              { timeoutMs: 10_000 },
            );
            assert.ok(
              retainedBindings > retainedBefore,
              "maintenance prepared the retained binding before withdrawal committed",
            );
            assert.deepEqual(await readApproval(), approval);
            await writer.query("COMMIT");
            committed = true;
            await removal;
          } finally {
            if (!committed) {
              await writer.query("ROLLBACK");
            }
            writer.release();
            await removal?.catch(() => {});
          }
        }
        await waitFor("withdrawn standing authority refused", async () =>
          events.find(
            (e) =>
              e.event === "worker.completed" &&
              e.workId === maintenanceKey &&
              e.code ===
                (change === "registry"
                  ? "REPOSITORY_STANDING_POLICY_CHANGED"
                  : "REPOSITORY_STANDING_APPROVAL_REMOVED"),
          ),
        );
        await f.stop();
        if (change === "registry") {
          assert.deepEqual(
            await readApproval(),
            approval,
            "registry reload preserves durable approval",
          );
          assert.equal(
            retainedBindings,
            retainedBefore,
            "ineligible work never reaches preparation",
          );
        } else {
          assert.equal(await readApproval(), undefined);
          assert.equal(
            driver.allowsStandingApproval({ namespaceId: f.namespace.id, binding }),
            true,
          );
          assert.deepEqual(driver.resolveBindings(request), resolution);
        }
        assert.ok(
          credentials.repositories.every(({ github }) => github.issuesOfTokens.length === 0),
        );
        assert.deepEqual(
          (await attempts()).map(({ admissionId, sessionId }) => ({ admissionId, sessionId })),
          before.map(({ admissionId, sessionId }) => ({ admissionId, sessionId })),
          "withdrawn eligibility cannot grant a successor session",
        );
        assert.equal(
          deliveries.length,
          deliveredBefore,
          "withdrawn eligibility cannot deliver more authority",
        );
      } finally {
        await f.stop();
      }
    },
  );
}

// Startup captures the selected runtime before worker.started. Replacing the
// caller's envelope must not select a different policy or sender for queued work.
test(
  "bound worker reconciliation retains the original repository admission policy",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const f = await setupStandingWorkerDatabase(t, import.meta.url);
    const { credentials, native, sender, owner, approval, revision, execution } =
      await setupStandingWorkerAuthority(t, f);
    const alternate = await loadWorkerNativeRepositoryAccess(t, credentials);
    const binding = revision.repositoryCredentials!.bindings[0]!;
    const bindingBefore = structuredClone(binding);
    const request = {
      namespaceId: f.namespace.id,
      bindings: [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
    };
    const originalPolicy = native.access.repositoryAdmission.policy;
    const alternatePolicy = alternate.access.repositoryAdmission.policy;
    // Both resolve the identical finite grant; only the original permits standing
    // authority. This control would fail reconciliation if the runtime were reread.
    assert.deepEqual(originalPolicy.resolveBindings(request).bindings, [binding]);
    assert.deepEqual(
      alternatePolicy.resolveBindings(request),
      originalPolicy.resolveBindings(request),
    );
    assert.equal(
      originalPolicy.allowsStandingApproval({ namespaceId: f.namespace.id, binding }),
      true,
    );
    assert.equal(
      alternatePolicy.allowsStandingApproval({ namespaceId: f.namespace.id, binding }),
      false,
    );
    assert.equal(
      alternatePolicy.standingApprovalScope({ namespaceId: f.namespace.id, binding }),
      undefined,
    );
    const deliveries: Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>[] = [];
    const opened: string[] = [];
    const open = sender.open.bind(sender);
    // Observe only the real sender's instance method; do not replace policy behavior.
    sender.open = async (...args: Parameters<typeof open>) => {
      assert.deepEqual(args[0].binding, bindingBefore);
      const result = await open(...args);
      if (result.kind === "created") {
        opened.push(result.session.sessionId);
      }
      return result;
    };
    const compute = {
      ...f.compute,
      validateRepositoryCredentials() {},
      async prepareRevision(
        r: Parameters<ComputeDriver["prepareRevision"]>[0],
        context?: ComputeRevisionContext,
      ) {
        assert.equal(r.id, revision.id);
        for (const value of context?.repositoryCredentials ?? []) {
          if (value.kind === "new") {
            deliveries.push(value);
          }
        }
        return f.compute.prepareRevision(r);
      },
      async verifyRepositoryExecution() {
        return execution;
      },
      async observeRevision() {
        return { state: "running" as const };
      },
      async activateRevision() {},
    };
    const originalRuntime = native.access.bindCompute(compute);
    const alternateRuntime = alternate.access.bindCompute(compute);
    assert.equal(originalRuntime.nativeSender, sender);
    const alternateSender = alternateRuntime.nativeSender;
    assert.ok(alternateSender);
    assert.notEqual(alternateSender, sender);
    const alternateOpen = alternateSender.open.bind(alternateSender);
    let alternateOpens = 0;
    alternateSender.open = async (...args: Parameters<typeof alternateOpen>) => {
      alternateOpens++;
      return alternateOpen(...args);
    };
    let caller: ReturnType<ReturnType<typeof standingDrivers>> | undefined;
    let replacements = 0;
    try {
      await f.start(compute, {
        emit(event: { event?: string }) {
          if (event.event === "worker.started") {
            assert.ok(caller);
            assert.equal(caller.repositoryRuntime, originalRuntime);
            // Replace only the mutable caller field after valid startup has bound it.
            caller.repositoryRuntime = alternateRuntime;
            replacements++;
          }
        },
        transformDrivers(drivers: {
          computeDriver: ComputeDriver;
          installation: { drivers: object };
        }) {
          caller = {
            ...standingDrivers({ native })(drivers),
            repositoryRuntime: originalRuntime,
          };
          return caller;
        },
      });
      await f.work(revision, "succeeded");
      await f.stop();
      assert.equal(replacements, 1);
      assert.equal(caller?.repositoryRuntime, alternateRuntime);
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
      const attempts = await f.state.read((v) =>
        v.repositorySessions.listRevisionAttempts({
          namespaceId: f.namespace.id,
          agentId: owner.id,
          revisionId: revision.id,
        }),
      );
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]!.phase, "open");
      assert.deepEqual(
        opened,
        [attempts[0]!.sessionId],
        "the original sender opened the persisted session",
      );
      assert.equal(alternateOpens, 0, "replacement sender cannot deliver authority");
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]!.sessionId, opened[0]);
      assert.equal(deliveries[0]!.admissionId, attempts[0]!.admissionId);
      assert.ok(deliveries[0]!.files.bearer.length > 0);
      assert.deepEqual(binding, bindingBefore);
      assert.deepEqual(
        await f.state.read((v) =>
          v.repositorySessions.findStandingApproval(
            f.namespace.id,
            owner.id,
            binding.repositoryRef,
          ),
        ),
        approval,
      );
      assert.ok(credentials.repositories.every(({ github }) => github.issuesOfTokens.length === 0));
    } finally {
      await f.stop();
      sender.open = open;
      alternateSender.open = alternateOpen;
    }
  },
);
