import assert from "node:assert/strict";
import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  backendDefinition,
  createAccessTokenServiceAccount,
  createBackendController,
  seedBackendBinding,
} from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import {
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

import { CredentialWithdrawalRefusedError } from "../../packages/occ/src/index.ts";

type WorkerFixture = Awaited<ReturnType<typeof setupStandingWorkerDatabase>>;
// The JavaScript factory accepts a Backend ID; its default null narrows inference.
type BackendAgentFactory = (
  label: string,
  options: Omit<NonNullable<Parameters<WorkerFixture["agent"]>[1]>, "backendId"> & {
    backendId: string | null;
  },
) => ReturnType<WorkerFixture["agent"]>;

function installAuthorityFaults(
  f: WorkerFixture,
  fault: {
    enabled: () => boolean;
    stateUnavailable: boolean;
    missingIdentityId: string | undefined;
    iamFailure: "unavailable" | "invalid" | undefined;
    onStateRead: (() => void) | undefined;
    onIamFailure?: () => void;
  },
) {
  for (const worker of f.workers) {
    const state = Reflect.get(worker, "state") as typeof f.state;
    const read = state.loadNativeIAMState.bind(state);
    state.loadNativeIAMState = async (...args: Parameters<typeof read>) => {
      if (!fault.enabled()) {
        return read(...args);
      }
      fault.onStateRead?.();
      if (fault.stateUnavailable) {
        throw new Error("controlled authoritative State outage");
      }
      const value = await read(...args);
      return fault.missingIdentityId === undefined
        ? value
        : {
            ...value,
            identities: value.identities.filter(
              (i: { id: string }) => i.id !== fault.missingIdentityId,
            ),
          };
    };
    if (fault.iamFailure !== undefined) {
      const iam = Reflect.get(worker, "iam") as {
        authorize: (...args: unknown[]) => Promise<unknown>;
      };
      const authorize = iam.authorize.bind(iam);
      iam.authorize = async (...args) => {
        if (!fault.enabled()) {
          return authorize(...args);
        }
        fault.onIamFailure?.();
        if (fault.iamFailure === "invalid") {
          return { allowed: false };
        }
        throw new Error("controlled IAM outage");
      };
    }
  }
}

type DenialAudit = {
  actor_id: string;
  action: string;
  outcome: string;
  metadata: Record<string, unknown>;
};

async function authorizationDenials(f: WorkerFixture): Promise<DenialAudit[]> {
  return (
    await f.observerPool.query(
      "SELECT actor_id, action, outcome, details->'__occAuditMetadata' AS metadata FROM occ.audit_events WHERE namespace_id=$1 AND kind='authorization_denial'",
      [f.namespace.id],
    )
  ).rows;
}

function assertActorRevocationAudit(
  audit: DenialAudit,
  f: WorkerFixture,
  agentId: string,
  hasDecisionReason: boolean,
) {
  assert.equal(audit.actor_id, f.actor.id);
  assert.equal(audit.action, "openclaw.agents.deploy");
  assert.equal(audit.outcome, "denied");
  assert.equal(audit.metadata.reasonCode, "ACTOR_REVOKED");
  assert.deepEqual(audit.metadata.authorization, {
    principalId: f.actor.id,
    action: "deploy",
    resource: { kind: "agent", id: agentId, namespaceId: f.namespace.id },
  });
  assert.equal(Object.hasOwn(audit.metadata, "decisionReason"), hasDecisionReason);
}

async function withdrawalOwners(f: WorkerFixture) {
  return (
    await f.observerPool.query(
      "SELECT namespace_id, revision_id, credential_source_id, requested_by, requested_at FROM occ.credential_withdrawals WHERE namespace_id=$1 ORDER BY revision_id",
      [f.namespace.id],
    )
  ).rows;
}

async function advanceRetainedCleanup(f: WorkerFixture) {
  await f.observerPool.query(
    "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE namespace_id=$1 AND state='queued' AND idempotency_key LIKE '%:repository_cleanup:%'",
    [f.namespace.id],
  );
}

async function settleDeletedAgentWork(
  t: { diagnostic(message: string): void },
  f: WorkerFixture,
  agentId: string,
  scenario: string,
) {
  await f.observerPool.query(
    "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE namespace_id=$1 AND state='queued'",
    [f.namespace.id],
  );
  await waitFor("owned work settled after Agent deletion", async () => {
    const { rows } = await f.observerPool.query(
      "SELECT count(*)::int AS pending FROM occ.controller_work WHERE namespace_id=$1 AND state IN ('queued','claimed')",
      [f.namespace.id],
    );
    return rows[0].pending === 0 ? true : undefined;
  });
  t.diagnostic(
    JSON.stringify({
      scenario,
      cleanup: { namespaceId: f.namespace.id, agentId, agentAbsent: true, queuedOrClaimed: 0 },
    }),
  );
}

// Real queue, worker, State and prepared native sender; Compute is a controlled
// observation adapter. This does not prove an OpenShell process or actual chat.
for (const scenario of [
  "model withdrawn",
  "IAM denied",
  "unsupported",
  "replacement revision",
  "unknown reply",
  "transport unavailable",
  "optional withdrawn",
  "gateway unavailable",
  "actor absent",
  "principal absent",
  "State unavailable",
  "IAM unavailable",
  "execution admission unavailable",
  "execution admission unavailable IAM unavailable",
  "model withdrawn gateway unavailable",
  "model withdrawn IAM unavailable",
  "actor absent IAM unavailable",
  "optional recovery pending",
  "optional recovery withdrawn",
  "optional manual replay",
  "model withdrawn State unavailable",
  "unsupported IAM unavailable",
  "IAM invalid",
  "handoff actor absent",
  "handoff State unavailable",
  "handoff healthy",
  "handoff admitted exclusive successor",
  "handoff admitted nonexclusive successor",
  "handoff replacement revision",
  "handoff actor absent IAM unavailable",
  "handoff actor absent backend unavailable",
  "handoff healthy backend unavailable",
  "handoff admitted exclusive successor backend unavailable",
  "handoff admitted nonexclusive successor backend unavailable",
  "handoff actor absent service account unavailable",
  "handoff healthy service account unavailable",
] as const) {
  const handoff = scenario.startsWith("handoff ");
  const admittedSuccessor = scenario.startsWith("handoff admitted ");
  const exclusiveSuccessor = scenario.startsWith("handoff admitted exclusive successor");
  const backendUnavailable = scenario.includes("backend unavailable");
  const serviceAccountUnavailable = scenario.includes("service account unavailable");
  const configuredBackend = backendUnavailable || serviceAccountUnavailable;
  const backendRecovery =
    configuredBackend && !scenario.includes("actor absent") && !exclusiveSuccessor;
  const terminal = [
    "model withdrawn",
    "IAM denied",
    "unsupported",
    "replacement revision",
    "actor absent",
    "principal absent",
    "model withdrawn gateway unavailable",
    "model withdrawn IAM unavailable",
    "actor absent IAM unavailable",
    "model withdrawn State unavailable",
    "unsupported IAM unavailable",
    "handoff actor absent",
    "handoff actor absent IAM unavailable",
    "handoff replacement revision",
    "handoff admitted exclusive successor",
    "handoff actor absent backend unavailable",
    "handoff admitted exclusive successor backend unavailable",
    "handoff actor absent service account unavailable",
  ].includes(scenario);
  let cleanupCode = terminal
    ? "REPOSITORY_RUNTIME_RETIREMENT_QUEUED"
    : "REPOSITORY_CLEANUP_PENDING";
  if (
    scenario === "optional recovery withdrawn" ||
    scenario === "handoff healthy" ||
    admittedSuccessor
  ) {
    cleanupCode = "REPOSITORY_ACCESS_WITHDRAWN";
  }
  if (scenario === "handoff replacement revision") {
    cleanupCode = "REPOSITORY_REVISION_SUPERSEDED";
  }
  if (backendRecovery) {
    cleanupCode = "REPOSITORY_CLEANUP_PENDING";
  }
  if (exclusiveSuccessor) {
    cleanupCode = "REVISION_SUPERSEDED";
  }
  let expectedSourceAttempts = 0;
  if (scenario.startsWith("optional recovery")) {
    expectedSourceAttempts = 4;
  }
  if (scenario === "optional manual replay") {
    expectedSourceAttempts = 2;
  }
  test(
    `standing expiry worker distinguishes ${scenario}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await setupStandingWorkerDatabase(t, import.meta.url, { maxAttempts: 1 });
      let disposeAgent: (() => Promise<void>) | undefined;
      try {
        const backend = backendDefinition();
        const account = serviceAccountUnavailable
          ? await createAccessTokenServiceAccount(f.state, f.namespace.id, "expiry")
          : undefined;
        if (account !== undefined) {
          await seedBackendBinding(f.observerPool, account);
        }
        const controller = configuredBackend
          ? createBackendController(f, { backends: [backend] })
          : f.controller;
        let accountCredentialId: string | undefined;
        // Persist the actual Backend selection and, when selected, its service account
        // before admitting r1. The shared fixture still owns standing Git admission.
        const authorityFixture = configuredBackend
          ? {
              ...f,
              agent: (label: string, options: Parameters<typeof f.agent>[1]) =>
                (f.agent as BackendAgentFactory)(label, {
                  ...options,
                  backendId: backend.id,
                  ...(account === undefined
                    ? {}
                    : { auth: "secret", serviceAccountId: account.id }),
                }),
            }
          : f;
        const {
          credentials,
          driver,
          sender,
          owner,
          modelSourceId,
          approval,
          revision,
          revisionOptions,
          execution,
        } = await setupStandingWorkerAuthority(t, authorityFixture, { nonModelSources: 1 });
        type Delivered = Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>;
        const deliveries: Delivered[] = [];
        type WorkerEvent = {
          event?: string;
          workId?: string;
          revisionId?: string;
          code?: string;
          outcome?: string;
          harnessState?: SandboxHarnessObservation["state"];
        };
        const events: WorkerEvent[] = [];
        let created = false;
        const stopped: string[] = [];
        let reductions = 0;
        let unavailableGateway = false;
        let disposing = false;
        let replacementId: string | undefined;
        let admittedSuccessorId: string | undefined;

        let prepares = 0;
        let activations = 0;
        let modelWithdrawals = 0;
        const sourceAttempts: string[] = [];
        let sourceUnavailable = true;
        let authorityFault = false;
        let faultReads = 0;
        let admissionFailures = 0;
        let companionId: string | undefined;
        let initialWithdrawalOwners: unknown[] = [];
        let releaseSourceClaim: (() => Promise<void>) | undefined;
        const recovering = scenario.startsWith("optional recovery");
        const manualReplay = scenario === "optional manual replay";
        const harness: SandboxHarnessObservation = { state: "running" };
        const compute = {
          ...f.compute,
          maintenanceIntervalMs: 60_000,
          requiresStoppedPredecessors(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
            return exclusiveSuccessor && r.id === admittedSuccessorId;
          },
          validateRepositoryCredentials() {},
          async prepareRevision(
            r: Parameters<ComputeDriver["prepareRevision"]>[0],
            context?: ComputeRevisionContext,
          ) {
            prepares++;
            if (!created) {
              created = true;
            }
            for (const value of context?.repositoryCredentials ?? []) {
              if (value.kind === "new") {
                deliveries.push(value);
              }
            }
            return f.compute.prepareRevision(r);
          },
          async verifyRepositoryExecution(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
            return created && r.id === revision.id ? execution : undefined;
          },
          async observeRevision(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
            assert.equal(r.id, revision.id);
            assert.equal(created, true);
            return harness;
          },
          async activateRevision() {
            activations++;
          },
          async withdrawCredentialSource(
            r: Parameters<ComputeDriver["prepareRevision"]>[0],
            source: { id: string },
          ) {
            if (source.id !== modelSourceId) {
              assert.ok(r.id === revision.id || r.id === companionId);
              sourceAttempts.push(r.id);
              if (manualReplay) {
                throw new CredentialWithdrawalRefusedError(
                  "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT",
                  "An unknown policy write requires operator replay",
                );
              }
              if (sourceUnavailable) {
                throw new Error("controlled source transport outage");
              }
              return { sourceId: source.id, state: "revoked" as const };
            }
            assert.equal(r.id, revision.id);
            modelWithdrawals++;
            return { sourceId: source.id, state: "revoked" as const };
          },
          async retireExpiredRepositoryAccess(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
            assert.equal(r.id, revision.id);
            assert.equal(created, true);
            reductions++;
            if (scenario === "transport unavailable") {
              throw new Error("local transport unavailable");
            }
            return handoff || (scenario === "optional recovery withdrawn" && authorityFault)
              ? ("withdrawn" as const)
              : ("pending" as const);
          },
          async stopRevision(r: Parameters<ComputeDriver["stopRevision"]>[0]) {
            if (!disposing) {
              assert.equal(r.id, revision.id, "expiry must never stop the replacement revision");
            }
            stopped.push(r.id);
            created = false;
          },
        };
        const start = async () => {
          const workerOptions: NonNullable<Parameters<typeof f.start>[1]> & {
            providers: ReturnType<typeof backendDefinition>[];
          } = {
            providers: configuredBackend ? [backend] : [],
            emit: (e?: WorkerEvent) => {
              if (e) {
                events.push(e);
              }
            },
            transformDrivers: (d: { installation: { drivers: object } }) => {
              const gateway = {
                ...observationGateway(),
                ...(unavailableGateway && { id: "replacement-gateway" }),
              };
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
                  // Project unavailable configuration into the actual worker composition.
                  ...(backendUnavailable && authorityFault ? { backend: [] } : {}),
                  drivers: {
                    ...d.installation.drivers,
                    sandbox: { id: sandbox.id, configuration: {} },
                    credential_gateway: { id: gateway.id, configuration: {} },
                  },
                },
              };
            },
          };
          await f.start(compute, workerOptions);
          // Inject at the authoritative read boundary; PostgreSQL cannot delete an
          // Agent-owned principal in isolation. The real worker and queue remain in control.
          const stateUnavailable = scenario.includes("State unavailable");
          const missingIdentityId = scenario.includes("actor absent")
            ? f.actor.id
            : scenario === "principal absent"
              ? owner.servicePrincipalId
              : undefined;
          installAuthorityFaults(f, {
            enabled: () => authorityFault,
            stateUnavailable,
            missingIdentityId,
            iamFailure: scenario.includes("IAM unavailable")
              ? "unavailable"
              : scenario === "IAM invalid"
                ? "invalid"
                : undefined,
            onStateRead:
              stateUnavailable || missingIdentityId !== undefined ? () => faultReads++ : undefined,
            onIamFailure: () => faultReads++,
          });
        };
        const stopAfterWorkSettles = async () => {
          // A completion event can precede another already-due claim. Wait for both expiry
          // and maintenance to defer before restart, preserving their actual queue results.
          await waitFor("due work settled before restart", async () => {
            const { rows } = await f.observerPool.query(
              "SELECT count(*)::int AS pending FROM occ.controller_work WHERE namespace_id=$1 AND (state='claimed' OR (state='queued' AND available_at<=clock_timestamp()))",
              [f.namespace.id],
            );
            return rows[0].pending === 0 ? true : undefined;
          });
          await f.stop();
        };
        disposeAgent = async () => {
          await f.stop();
          disposing = true;
          authorityFault = false;
          // All fixture workers are stopped. Expire only their owned claims so teardown
          // can recover an interrupted observation before deleting the Agent.
          await f.observerPool.query(
            "UPDATE occ.controller_work SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE namespace_id=$1 AND state='claimed'",
            [f.namespace.id],
          );
          unavailableGateway = false;
          await f.requestDeletion(owner);
          await start();
          await waitFor("Agent deleted", async () =>
            (await f.currentAgent(owner)) === undefined ? true : undefined,
          );
          await settleDeletedAgentWork(t, f, owner.id, scenario);
        };
        await start();
        await f.work(revision, "succeeded").catch(async (error: unknown) => {
          t.diagnostic(JSON.stringify({ events, work: await f.workResult(revision) }));
          throw error;
        });
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
        if (account === undefined) {
          assert.ok(modelSourceId);
        } else {
          assert.equal(revision.backendId, backend.id);
          assert.equal(revision.harnessAuth.method, "codex_pat");
        }
        // The first observation can precede completion of the claim that schedules maintenance.
        await waitFor("active maintenance established", async () =>
          events.find((e) => e.revisionId === revision.id && e.code === "REVISION_ALREADY_ACTIVE"),
        );
        await stopAfterWorkSettles();
        const before = { prepares, activations, deliveries: deliveries.length };
        const ownerRef = {
          namespaceId: f.namespace.id,
          agentId: owner.id,
          revisionId: revision.id,
        };
        const queue = new f.PostgresWorkQueue(f.observerPool, { maxAttempts: 1 });
        const originalMaintenanceKey = await queue.latestRevisionMaintenanceKey(ownerRef);
        assert.ok(originalMaintenanceKey);
        // Make Git expiry durable through normal maintenance before introducing a second
        // authority outcome. The first worker's unknown reply must never imply runtime loss.
        await f.controller.removeAgentStandingApproval(f.actor.id, {
          namespaceId: f.namespace.id,
          agentId: owner.id,
          approvalId: approval.id,
          expectedGeneration: approval.generation,
        });
        events.length = 0;
        await f.advanceMaintenance(revision);
        await start();
        await waitFor("durable Git expiry", async () =>
          (await queue.repositoryExpiryState(ownerRef)) === "expiry" ? true : undefined,
        );
        await waitFor("first withdrawal committed", async () =>
          reductions > 0
            ? events.find(
                (e) =>
                  e.code ===
                  (handoff ? "REPOSITORY_ACCESS_WITHDRAWN" : "REPOSITORY_CLEANUP_PENDING"),
              )
            : undefined,
        );
        await stopAfterWorkSettles();
        assert.deepEqual(stopped, []);
        if (recovering || manualReplay || scenario === "optional withdrawn") {
          // An admitted successor has no maintenance owner of its own. Its deployment stays
          // queued while source withdrawal must recover through the active revision.
          const companion = await f.revision(owner, 2, revisionOptions);
          companionId = companion.id;
          await f.observerPool.query(
            "UPDATE occ.controller_work SET available_at=clock_timestamp()+interval '1 hour' WHERE idempotency_key=$1",
            [companion.idempotencyKey],
          );
        }
        if (
          scenario.startsWith("model withdrawn") ||
          scenario === "optional withdrawn" ||
          recovering ||
          manualReplay
        ) {
          const sourceId = scenario.startsWith("model withdrawn")
            ? modelSourceId
            : owner.credentialSources!.find(
                (s: { sourceId: string }) => s.sourceId !== modelSourceId,
              )!.sourceId;
          assert.ok(sourceId);
          await f.controller.withdrawAgentCredentialSource(f.actor.id, {
            namespaceId: f.namespace.id,
            agentId: owner.id,
            credentialSourceId: sourceId,
          });
          if (recovering || manualReplay) {
            await start();
            await waitFor("original and companion source work exhausted", async () => {
              const { rows } = await f.observerPool.query(
                "SELECT state FROM occ.controller_work WHERE namespace_id=$1 AND agent_target='credentials_withdrawn'",
                [f.namespace.id],
              );
              return rows.length === 2 &&
                rows.every((r: { state: string }) => r.state === "failed_permanent")
                ? true
                : undefined;
            });
            await stopAfterWorkSettles();
            assert.deepEqual([...sourceAttempts].sort(), [revision.id, companionId].sort());
            sourceUnavailable = false;
          }
          initialWithdrawalOwners = await withdrawalOwners(f);
          // Isolate the maintenance ordering: the separately durable source-withdrawal job
          // remains scheduled, but does not race this expiry claim or issue a detach.
          await f.observerPool.query(
            "UPDATE occ.controller_work SET available_at=clock_timestamp()+interval '1 hour' WHERE namespace_id=$1 AND agent_target='credentials_withdrawn'",
            [f.namespace.id],
          );
        }
        if (scenario === "optional withdrawn") {
          // One parked queued owner and one live companion claim exercise both duplicate
          // guards. Claim through the real queue, after making only this companion due.
          await f.observerPool.query(
            "UPDATE occ.controller_work SET available_at=clock_timestamp()+interval '1 hour' WHERE namespace_id=$1 AND state='queued'",
            [f.namespace.id],
          );
          await f.observerPool.query(
            "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE namespace_id=$1 AND revision_id=$2 AND agent_target='credentials_withdrawn'",
            [f.namespace.id, companionId],
          );
          const sourceQueue = new f.PostgresWorkQueue(f.observerPool, { leaseDurationMs: 120_000 });
          const held = await sourceQueue.claim();
          assert.ok(held);
          assert.equal(held?.revisionId, companionId);
          assert.equal(held?.agentTarget, "credentials_withdrawn");
          releaseSourceClaim = async () => {
            await sourceQueue.defer(
              held,
              { code: "CREDENTIAL_WITHDRAWAL_PENDING" },
              { delayMs: 3_600_000 },
            );
          };
        }
        if (scenario === "IAM denied") {
          await f.observerPool.query(
            "DELETE FROM occ.iam_access_bindings WHERE namespace_id=$1 AND identity_subject_id=$2 AND resource_id=$3",
            [f.namespace.id, owner.servicePrincipalId, modelSourceId],
          );
        }
        if (scenario.startsWith("unsupported")) {
          delete (compute as Partial<ComputeDriver>).retireExpiredRepositoryAccess;
        }
        const admissionUnavailable = scenario.startsWith("execution admission unavailable");
        if (admissionUnavailable) {
          // This Compute cannot confirm admission and has no withdrawal for this execution.
          (compute as Partial<ComputeDriver>).validateExecutionAdmission = () => {
            admissionFailures++;
            throw Object.assign(new Error("admission check temporarily unavailable"), {
              code: "EAGAIN",
            });
          };
        }
        unavailableGateway = scenario.includes("gateway unavailable");
        authorityFault = true;
        if (account !== undefined) {
          // Revoke the issued credential in this real binding after successful activation.
          const { rows } = await f.observerPool.query(
            "SELECT external_credential_id FROM occ.service_account_driver_bindings WHERE namespace_id=$1 AND service_account_id=$2",
            [f.namespace.id, account.id],
          );
          accountCredentialId = rows[0].external_credential_id;
          assert.ok(accountCredentialId);
          await f.observerPool.query(
            "UPDATE occ.service_account_driver_bindings SET external_credential_id=NULL WHERE namespace_id=$1 AND service_account_id=$2",
            [f.namespace.id, account.id],
          );
        }
        if (
          scenario === "replacement revision" ||
          scenario === "handoff replacement revision" ||
          admittedSuccessor
        ) {
          // Admit a real successor and park its deployment. The admitted cases leave r1
          // active; the existing replacement cases project the later pointer cutover.
          await controller.updateAgent(f.actor.id, {
            namespaceId: f.namespace.id,
            agentId: owner.id,
            configurationId: owner.configurationId,
            repositoryBindings: [],
          });
          const successor = await f.revision(owner, 2);
          admittedSuccessorId = successor.id;
          await f.observerPool.query(
            "UPDATE occ.controller_work SET available_at=clock_timestamp()+interval '1 hour' WHERE idempotency_key=$1",
            [successor.idempotencyKey],
          );
          if (!admittedSuccessor) {
            replacementId = successor.id;
            await f.state.transact((u) =>
              u.agents.compareAndSetActiveRevision(
                f.namespace.id,
                owner.id,
                revision.id,
                successor.id,
              ),
            );
          } else {
            assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
            assert.equal((await queue.findWork(successor.idempotencyKey))?.state, "queued");
          }
        }
        const beforeRecovery = reductions;
        const completedCleanup = handoff
          ? (
              await f.observerPool.query(
                "SELECT idempotency_key, state, reason_code, attempt_count FROM occ.controller_work WHERE namespace_id=$1 AND idempotency_key LIKE '%:repository_cleanup:%'",
                [f.namespace.id],
              )
            ).rows
          : undefined;
        if (handoff) {
          assert.ok(completedCleanup);
          assert.equal(completedCleanup.length, 1);
          assert.equal(completedCleanup[0].state, "succeeded");
          assert.equal(completedCleanup[0].reason_code, "REPOSITORY_ACCESS_WITHDRAWN");
        }
        let handoffMaintenanceKey: string | undefined;
        events.length = 0;

        // A replacement process gets both the regular maintenance and the retained expiry
        // obligation. Neither is allowed to prepare or activate the old revision again.
        // Resume the original maintenance ID as a recovered observation. Expiry may have
        // completed it while transferring its obligation to repository cleanup.
        if (recovering || manualReplay || scenario === "optional withdrawn") {
          const resumed = await f.observerPool.query(
            "UPDATE occ.controller_work SET state='queued', attempt_count=0, completed_at=NULL, result_data=NULL, reason_code=NULL, available_at=clock_timestamp() WHERE idempotency_key=$1 AND state='succeeded' RETURNING idempotency_key",
            [originalMaintenanceKey],
          );
          assert.equal(resumed.rowCount, 1);
        }
        const advanced = await f.advanceMaintenance(revision);
        if (handoff) {
          assert.equal(advanced.rowCount, 1, "only the naturally scheduled maintenance is due");
          handoffMaintenanceKey = advanced.rows[0].idempotency_key;
          assert.equal(advanced.rows[0].actor_id, f.actor.id);
        } else {
          await advanceRetainedCleanup(f);
        }
        if (releaseSourceClaim !== undefined) {
          assert.equal(
            await queue.claim(),
            undefined,
            "a live source claim excludes concurrent Agent maintenance",
          );
          await releaseSourceClaim();
          releaseSourceClaim = undefined;
        }
        await start();
        if (handoff) {
          assert.ok(completedCleanup);
          assert.ok(handoffMaintenanceKey);
          await waitFor("scheduled maintenance completes its pass", async () =>
            events.find(
              (e) => e.workId === handoffMaintenanceKey && e.event === "worker.completed",
            ),
          );
          const outcome = (
            await f.observerPool.query(
              "SELECT state, reason_code, claim_token FROM occ.controller_work WHERE idempotency_key=$1",
              [handoffMaintenanceKey],
            )
          ).rows[0];
          const attempt = await queue.findWorkAttempt(handoffMaintenanceKey);
          t.diagnostic(
            JSON.stringify({ scenario, completedCleanup, handoffMaintenanceKey, outcome, attempt }),
          );
          assert.equal(
            attempt?.code,
            cleanupCode,
            "the scheduled ordinary claim must honor retirement or retain expiry supervision",
          );
          let expectedState = "queued";
          if (
            terminal ||
            scenario === "handoff healthy" ||
            (admittedSuccessor && !backendRecovery)
          ) {
            expectedState = "succeeded";
          }
          if (scenario === "handoff replacement revision") {
            expectedState = "failed_permanent";
          }
          assert.equal(outcome.state, expectedState);
          assert.equal(outcome.claim_token, null);
          assert.deepEqual(
            (
              await f.observerPool.query(
                "SELECT idempotency_key, state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key=$1",
                [completedCleanup[0].idempotency_key],
              )
            ).rows,
            completedCleanup,
            "completed cleanup must not be replayed",
          );
        }
        if (scenario !== "handoff replacement revision") {
          await waitFor("replacement cleanup outcome", async () =>
            events.find((e) => e.code === cleanupCode),
          );
        }
        if (terminal) {
          await waitFor("original runtime stopped", async () =>
            stopped.length === 1 ? true : undefined,
          );
          await waitFor("terminal work settled", async () => {
            const rows = (
              await f.observerPool.query(
                "SELECT state FROM occ.controller_work WHERE namespace_id=$1 AND idempotency_key LIKE '%:repository_cleanup:retire:%'",
                [f.namespace.id],
              )
            ).rows;
            return rows.length === 1 && rows[0].state === "succeeded" ? true : undefined;
          });
        }
        if (recovering || manualReplay || scenario === "optional withdrawn") {
          await waitFor("original maintenance work executed", async () =>
            events.find(
              (e) => e.workId === originalMaintenanceKey && e.event === "worker.completed",
            ),
          );
        }
        if (recovering) {
          await waitFor("source recovery for original and companion", async () => {
            const { rows } = await f.observerPool.query(
              "SELECT state FROM occ.credential_withdrawals WHERE namespace_id=$1",
              [f.namespace.id],
            );
            return rows.length === 2 && rows.every((r: { state: string }) => r.state === "revoked")
              ? true
              : undefined;
          });
          assert.deepEqual(
            [...sourceAttempts].sort(),
            [revision.id, revision.id, companionId, companionId].sort(),
          );
        }
        await stopAfterWorkSettles();
        if (!terminal && !handoff) {
          events.length = 0;
          await f.advanceMaintenance(revision);
          await advanceRetainedCleanup(f);
          await start();
          await waitFor("second replacement still pending", async () =>
            events.find(
              (e) =>
                e.code ===
                (scenario === "optional recovery withdrawn"
                  ? "REPOSITORY_ACCESS_WITHDRAWN"
                  : "REPOSITORY_CLEANUP_PENDING"),
            ),
          );
          await stopAfterWorkSettles();
        }
        if (recovering || manualReplay || scenario === "optional withdrawn") {
          const ownersAfter = await withdrawalOwners(f);
          assert.deepEqual(
            ownersAfter,
            initialWithdrawalOwners,
            "recovery preserves the exact withdrawal and requester",
          );
          assert.equal(
            sourceAttempts.length,
            expectedSourceAttempts,
            "no duplicate source writes or automatic manual replay",
          );
          const { rows } = await f.observerPool.query(
            "SELECT revision_id, actor_id, state FROM occ.controller_work WHERE namespace_id=$1 AND agent_target='credentials_withdrawn' ORDER BY revision_id, state",
            [f.namespace.id],
          );
          assert.equal(rows.length, recovering ? 4 : 2);
          assert.ok(rows.every((r: { actor_id: string }) => r.actor_id === f.actor.id));
        }
        if (
          scenario === "principal absent" ||
          scenario.includes("State unavailable") ||
          scenario.includes("IAM unavailable") ||
          scenario === "IAM invalid"
        ) {
          assert.ok(faultReads > 0);
        }
        if (admissionUnavailable && !scenario.includes("IAM unavailable")) {
          assert.ok(admissionFailures > 0, "exercise inconclusive admission after expiry");
        }
        assert.deepEqual(stopped, terminal ? [revision.id] : []);
        assert.equal(
          (await f.currentAgent(owner))?.activeRevisionId,
          replacementId ?? (terminal ? undefined : revision.id),
        );
        assert.deepEqual({ prepares, activations, deliveries: deliveries.length }, before);
        assert.equal(modelWithdrawals, 0, "expiry must not replay a source detach");
        assert.equal(provider.issuesOfTokens.length, 0, "maintenance must not issue Git material");
        if (
          terminal ||
          backendRecovery ||
          scenario === "handoff replacement revision" ||
          unavailableGateway ||
          admissionUnavailable ||
          scenario.includes("State unavailable") ||
          scenario === "IAM unavailable" ||
          scenario === "IAM invalid"
        ) {
          assert.equal(reductions, beforeRecovery);
        } else {
          assert.ok(reductions > beforeRecovery);
        }
        const terminalRows = (
          await f.observerPool.query(
            "SELECT state, revision_id FROM occ.controller_work WHERE namespace_id=$1 AND idempotency_key LIKE '%:repository_cleanup:retire:%'",
            [f.namespace.id],
          )
        ).rows;
        assert.deepEqual(
          terminalRows,
          terminal ? [{ state: "succeeded", revision_id: revision.id }] : [],
          "retirement must settle for the original revision only",
        );
        if (!terminal && !handoff && scenario !== "optional recovery withdrawn") {
          assert.equal(await queue.repositoryExpiryState(ownerRef), "expiry");
          const { rows } = await f.observerPool.query(
            "SELECT state, attempt_count FROM occ.controller_work WHERE namespace_id=$1 AND idempotency_key LIKE '%:repository_cleanup:%'",
            [f.namespace.id],
          );
          assert.deepEqual(rows, [{ state: "queued", attempt_count: 0 }]);
        }
        if (scenario === "handoff State unavailable" || backendRecovery) {
          assert.equal(await queue.repositoryExpiryState(ownerRef), "expiry");
          authorityFault = false;
          if (account !== undefined) {
            await f.observerPool.query(
              "UPDATE occ.service_account_driver_bindings SET external_credential_id=$3 WHERE namespace_id=$1 AND service_account_id=$2",
              [f.namespace.id, account.id, accountCredentialId],
            );
          }
          events.length = 0;
          const retry = await f.advanceMaintenance(revision);
          assert.equal(retry.rowCount, 1);
          assert.equal(retry.rows[0].idempotency_key, handoffMaintenanceKey);
          await start();
          await waitFor("the same ordinary claim recovers after its dependency returns", async () =>
            events.find(
              (e) => e.workId === handoffMaintenanceKey && e.code === "REPOSITORY_ACCESS_WITHDRAWN",
            ),
          );
          await stopAfterWorkSettles();
          assert.equal((await queue.findWork(handoffMaintenanceKey!))?.state, "succeeded");
          assert.deepEqual(stopped, []);
          assert.deepEqual({ prepares, activations, deliveries: deliveries.length }, before);
          assert.equal(provider.issuesOfTokens.length, 0);
        }
        const originalWork = await f.workResult(revision);
        assert.equal((await queue.findWork(revision.idempotencyKey))?.state, "succeeded");
        assert.equal(originalWork.rows[0].reason_code, "REVISION_ACTIVATED");
        if (
          configuredBackend ||
          scenario.includes("actor absent") ||
          scenario.includes("State unavailable") ||
          scenario === "IAM unavailable"
        ) {
          const audits = await authorizationDenials(f);
          if (scenario.includes("actor absent")) {
            assert.ok(audits.length > 0, "cleanup must preserve its authoritative denial evidence");
            if (handoff) {
              assert.equal(audits.length, 1, "the ordinary handoff claim owns this denial");
            }
            for (const audit of audits) {
              assertActorRevocationAudit(audit, f, owner.id, !scenario.includes("IAM unavailable"));
            }
          } else {
            assert.deepEqual(audits, [], "unknown identity is not an authorization denial");
          }
          t.diagnostic(JSON.stringify({ scenario, audits }));
        }
        t.diagnostic(
          JSON.stringify({
            scenario,
            replacementId,
            admittedSuccessorId,
            stopped,
            preparesAfterExpiry: prepares - before.prepares,
            activationsAfterExpiry: activations - before.activations,
            tokenIssues: provider.issuesOfTokens.length,
            sourceDetaches: modelWithdrawals,
            sourceAttempts,
            originalMaintenanceKey: recovering || manualReplay ? originalMaintenanceKey : undefined,
            recoveryObservations: reductions - beforeRecovery,
            terminalRows,
          }),
        );
      } catch (error) {
        t.diagnostic(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        try {
          await disposeAgent?.();
        } finally {
          await f.stop();
        }
      }
    },
  );
}

for (const scenario of [
  "actor absent",
  "actor absent IAM unavailable",
  "State unavailable",
  "IAM unavailable",
  "backend unavailable",
] as const) {
  test(
    `ordinary revision authorization distinguishes ${scenario}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (t) => {
      const f = await setupStandingWorkerDatabase(t, import.meta.url);
      let fault = false;
      let reads = 0;
      let prepares = 0;
      let activations = 0;
      const owner = await (f.agent as BackendAgentFactory)("ordinary-authorization", {
        backendId: scenario === "backend unavailable" ? backendDefinition().id : null,
      });
      // Start without revision work, so the dependency faults are installed before admission.
      await f.start({
        ...f.compute,
        async activateRevision() {
          activations++;
        },
        async prepareRevision(r: Parameters<ComputeDriver["prepareRevision"]>[0]) {
          prepares++;
          return f.compute.prepareRevision(r);
        },
      });
      installAuthorityFaults(f, {
        enabled: () => fault,
        stateUnavailable: scenario === "State unavailable",
        missingIdentityId: scenario.startsWith("actor absent") ? f.actor.id : undefined,
        iamFailure: scenario.includes("IAM unavailable") ? "unavailable" : undefined,
        onStateRead: () => reads++,
      });
      try {
        fault = true;
        const revision = await f.revision(owner, 1);
        const denied = scenario.startsWith("actor absent");
        await waitFor("ordinary revision decision committed", async () => {
          const { rows } = await f.observerPool.query(
            "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key=$1",
            [revision.idempotencyKey],
          );
          return rows[0]?.attempt_count > 0 && rows[0].state !== "claimed" ? rows[0] : undefined;
        });
        await f.stop();
        const work = (
          await f.observerPool.query(
            "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key=$1",
            [revision.idempotencyKey],
          )
        ).rows[0];
        const attempt = await new f.PostgresWorkQueue(f.observerPool).findWorkAttempt(
          revision.idempotencyKey,
        );
        const audits = await authorizationDenials(f);
        t.diagnostic(
          JSON.stringify({
            scenario,
            revisionId: revision.id,
            work,
            attempt,
            audits,
            prepares,
            reads,
          }),
        );
        assert.ok(reads > 0);
        assert.equal(prepares, 0, "fresh revision work requires authorization and its Backend");
        assert.equal(activations, 0);
        assert.equal((await f.currentAgent(owner))?.activeRevisionId, undefined);
        if (denied) {
          assert.deepEqual(work, { state: "failed_permanent", reason_code: "ACTOR_REVOKED" });
          assert.equal(
            audits.length,
            1,
            "definitive State refusal must leave attributable denial evidence",
          );
          assertActorRevocationAudit(audits[0]!, f, owner.id, scenario === "actor absent");
        } else if (scenario === "backend unavailable") {
          assert.deepEqual(work, { state: "failed_permanent", reason_code: "BACKEND_UNAVAILABLE" });
          assert.deepEqual(
            audits,
            [],
            "missing Backend configuration is not an authorization denial",
          );
        } else {
          assert.equal(work.state, "queued", "unavailable evidence remains retryable");
          assert.equal(attempt?.code, "DEPENDENCY_UNAVAILABLE");
          assert.deepEqual(audits, [], "a dependency failure is not an authorization denial");
        }
      } finally {
        fault = false;
        await f.stop();
        await f.requestDeletion(owner);
        await f.start(f.compute);
        await waitFor("ordinary test Agent deleted", async () =>
          (await f.currentAgent(owner)) === undefined ? true : undefined,
        );
        await settleDeletedAgentWork(t, f, owner.id, scenario);
        await f.stop();
      }
    },
  );
}
