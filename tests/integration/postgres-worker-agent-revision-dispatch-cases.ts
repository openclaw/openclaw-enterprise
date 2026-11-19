import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import {
  admitRepositoryNetworkPolicy,
  isSecretHarnessAuth,
  type Agent,
  type AgentRevision,
  type ComputeDriver,
  type RepositoryNetworkGrant,
  type SandboxPolicySnapshot,
} from "../../packages/contracts/src/index.ts";
import { PostgresWorkQueue, type OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import type {
  RevisionFixture,
  WorkIdentity,
} from "../helpers/postgres-worker-refused-candidate.ts";
import type { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { waitFor, waitUntil } from "../helpers/wait-for.ts";

interface DispatchFixture {
  admitInitialRevision: RevisionFixture["admitInitialRevision"];
  agent: RevisionFixture["agent"];
  revision: RevisionFixture["revision"];
  actor: RevisionFixture["actor"];
  compute: RevisionFixture["compute"];
  currentAgent: RevisionFixture["currentAgent"];
  expireClaim: RevisionFixture["expireClaim"];
  namespace: RevisionFixture["namespace"];
  observerPool: RevisionFixture["observerPool"];
  productionHarness: RevisionFixture["productionHarness"];
  start: RevisionFixture["start"];
  state: RevisionFixture["state"];
  stop: RevisionFixture["stop"];
  deploymentStatus(
    owner: Pick<Agent, "id">,
    candidate: Pick<AgentRevision, "id">,
  ): ReturnType<OpenClawController["getDeploymentStatus"]>;
  secretDriver: Pick<ReturnType<typeof createTestSecretDriver>, "setResolveOverride">;
  work: RevisionFixture["work"];
}

interface DispatchFixtures {
  revisionTest(name: string, run: (fixture: DispatchFixture) => Promise<void>): void;
  setup(
    context: Pick<TestContext, "after">,
    options: { secretAuthMethod?: "api_key" | "codex_pat"; leaseDurationMs?: number },
  ): Promise<DispatchFixture>;
}

type DispatchContext = Parameters<ComputeDriver["prepareRevision"]>[1];
type ComputeEffect = "bind" | "prepare";

function harnessSecretId(owner: Readonly<Agent>): string {
  assert.ok(
    isSecretHarnessAuth(owner.harnessAuth),
    `Agent ${owner.id} has a Harness Secret binding`,
  );
  return owner.harnessAuth.source.id;
}

function observeComputeEffects(compute: ComputeDriver, effects: ComputeEffect[]): ComputeDriver {
  return {
    ...compute,
    async bindAgent() {
      effects.push("bind");
    },
    async prepareRevision(revision) {
      effects.push("prepare");
      return compute.prepareRevision(revision);
    },
  };
}

async function saveRepositoryPolicy(
  fixture: DispatchFixture,
  owner: Pick<Agent, "id">,
  grants: readonly RepositoryNetworkGrant[],
) {
  // The frozen revision uses the same list and version as the Agent's saved policy.
  const desired = await fixture.state.transact(async (unit) => {
    await unit.namespaces.lockNamespace(fixture.namespace.id);
    await unit.agents.lockAgent(fixture.namespace.id, owner.id);
    const current = await unit.sandboxPolicies.find(fixture.namespace.id, owner.id);
    assert.ok(current);
    return unit.sandboxPolicies.save(
      { ...current, version: current.version + 1, repositoryNetworkPolicy: grants },
      current.version,
    );
  });
  assert.ok(desired);
  const repositoryNetworkPolicy = admitRepositoryNetworkPolicy(grants, grants);
  assert.ok(repositoryNetworkPolicy);
  const sandboxPolicy: SandboxPolicySnapshot = {
    driverId: "repository-policy-test-sandbox",
    implementation: "test",
    version: desired.version,
    additions: [],
    defaults: {},
    repositoryNetworkPolicy,
  };
  return { id: desired.id, options: { sandboxDriverId: sandboxPolicy.driverId, sandboxPolicy } };
}

async function settledRevision(fixture: DispatchFixture, revision: WorkIdentity) {
  const queue = new PostgresWorkQueue(fixture.observerPool);
  return waitFor("repository policy candidate settles", async () => {
    const work = await queue.findWork(revision.idempotencyKey);
    return work?.state === "failed_permanent" || work?.state === "succeeded" ? work : undefined;
  });
}

function computeSupportingRepositoryPolicy(compute: ComputeDriver): ComputeDriver {
  return { ...compute, validateProtectedRepositoryNetworkPolicy() {} };
}

export function registerRevisionDispatchCases({ revisionTest, setup }: DispatchFixtures): void {
  revisionTest(
    "a restarted worker refuses explicit deny-all before preparing an ordinary revision",
    async (fixture) => {
      const owner = await fixture.agent("repository-policy-worker-restart", {
        executionMode: "dedicated",
      });
      const { options } = await saveRepositoryPolicy(fixture, owner, []);
      const previous = await fixture.revision(owner, 1, options);
      const supportingCompute = computeSupportingRepositoryPolicy(fixture.compute);
      await fixture.start(supportingCompute);
      await fixture.work(previous, "succeeded");
      await fixture.stop();

      // Preserve the admitted Compute identity while its restarted configuration refuses the policy.
      const candidate = await fixture.revision(owner, 2, options);
      assert.equal(candidate.executionAdmission.mode, "unprotected");
      const { owner: control, candidate: ordinary } = await fixture.admitInitialRevision(
        "no-explicit-repository-policy",
      );
      const checked: string[] = [];
      const prepared: string[] = [];
      await fixture.start({
        ...supportingCompute,
        validateProtectedRepositoryNetworkPolicy(revision) {
          assert.ok("id" in revision && typeof revision.id === "string");
          checked.push(revision.id);
          return Promise.reject(
            new Error("Compute no longer admits this repository network policy."),
          );
        },
        async prepareRevision(revision, context) {
          prepared.push(revision.id);
          return supportingCompute.prepareRevision(revision, context);
        },
      });
      await fixture.work(ordinary, "succeeded");
      const terminal = await settledRevision(fixture, candidate);
      assert.deepEqual(
        {
          state: terminal.state,
          reason: terminal.reasonCode,
          candidateWasPrepared: prepared.includes(candidate.id),
          keptPredecessor: (await fixture.currentAgent(owner))?.activeRevisionId === previous.id,
        },
        {
          state: "failed_permanent",
          reason: "EXECUTION_ADMISSION_UNAVAILABLE",
          candidateWasPrepared: false,
          keptPredecessor: true,
        },
      );
      assert.deepEqual(checked, [candidate.id]);
      assert.deepEqual(prepared, [ordinary.id]);
      assert.equal((await fixture.currentAgent(control))?.activeRevisionId, ordinary.id);
    },
  );

  for (const [commitTiming, activationOrder] of [
    ["before commit", "beforeCommit"],
    ["after commit", "afterCommit"],
  ] as const) {
    test(
      `a successor claim prevents activation ${commitTiming} before the stale signal aborts`,
      requiresPostgres,
      async (context) => {
        // Leave time before the next heartbeat so the database can transfer the claim
        // while the old Worker's local cancellation signal is still clear.
        const fixture = await setup(context, { leaseDurationMs: 60_000 });
        const owner = await fixture.agent("repository-policy-stale-claim", {
          executionMode: "dedicated",
        });
        const { options } = await saveRepositoryPolicy(fixture, owner, []);
        const candidate = await fixture.revision(owner, 1, options);
        const release = Promise.withResolvers<void>();
        const activations: string[] = [];
        let prepared = false;
        let activationSignal: AbortSignal | undefined;
        let claimLost = false;
        await fixture.start(
          {
            ...fixture.compute,
            activationOrder,
            validateProtectedRepositoryNetworkPolicy() {
              if (prepared) {
                activationSignal = currentComputeAbortSignal();
                // Validation can return successfully even after the claim expires.
                return release.promise;
              }
            },
            async prepareRevision(revision, deploymentContext) {
              const observation = await fixture.compute.prepareRevision(
                revision,
                deploymentContext,
              );
              prepared = true;
              return observation;
            },
            async activateRevision(revision) {
              activations.push(revision.id);
            },
          },
          {
            emit: ({ event, code, workId }) => {
              if (
                event === "worker.error" &&
                code === "CLAIM_LOST" &&
                workId === candidate.idempotencyKey
              ) {
                claimLost = true;
              }
            },
          },
        );
        const recoveryQueue = new PostgresWorkQueue(fixture.observerPool, {
          leaseDurationMs: 30_000,
          maxAttempts: 5,
          random: () => 0,
        });
        let recovered;
        try {
          const signal = await waitFor(
            "activation-time repository policy validation",
            () => activationSignal,
          );
          assert.equal(signal.aborted, false);
          const activeRevisionId = activationOrder === "afterCommit" ? candidate.id : undefined;
          assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, activeRevisionId);
          const original = await fixture.work(candidate, "claimed");
          assert.ok(original.claim_token);
          await fixture.expireClaim(candidate, original.claim_token);
          assert.equal((await recoveryQueue.recoverStale()).recovered, 1);
          recovered = await recoveryQueue.claim();
          assert.equal(recovered?.idempotencyKey, candidate.idempotencyKey);
          assert.equal(recovered.attemptCount, original.attempt_count + 1);
          assert.notEqual(recovered.claimToken, original.claim_token);
          assert.equal(signal.aborted, false, "validation must resume before local cancellation");
        } finally {
          release.resolve();
        }
        await waitUntil(
          "claim loss or a stale activation after validation",
          () => claimLost || activations.length > 0,
        );
        assert.deepEqual(activations, [], "the stale worker must never call the activation Driver");
        await fixture.stop();
        assert.equal((await fixture.work(candidate, "claimed")).claim_token, recovered.claimToken);
      },
    );
  }

  for (const { action, kind, grants } of [
    {
      action: "read",
      kind: "sandbox_policy",
      grants: [{ repository: "example/project", access: "read" }],
    },
    {
      action: "update",
      kind: "sandbox_policy",
      grants: [{ repository: "example/project", access: "write" }],
    },
    { action: "manage_policy", kind: "agent", grants: [] },
  ] as const) {
    revisionTest(
      `queued repository policy refuses revoked ${kind} ${action} before Compute`,
      async (fixture) => {
        const owner = await fixture.agent(`repository-policy-${action}`, {
          executionMode: "dedicated",
        });
        const { id: policyId, options } = await saveRepositoryPolicy(fixture, owner, grants);
        const previous = await fixture.revision(owner, 1, options);
        const supportingCompute = computeSupportingRepositoryPolicy(fixture.compute);
        await fixture.start(supportingCompute);
        await fixture.work(previous, "succeeded");
        await fixture.stop();

        const candidate = await fixture.revision(owner, 2, options);
        const { owner: control, candidate: ordinary } = await fixture.admitInitialRevision(
          "ordinary-after-policy-revocation",
        );
        const controlPolicy = await fixture.state.read((view) =>
          view.sandboxPolicies.find(fixture.namespace.id, control.id),
        );
        assert.ok(controlPolicy);
        const resourceId = kind === "agent" ? owner.id : policyId;
        const controlResourceId = kind === "agent" ? control.id : controlPolicy.id;

        // Revoke the same exact permission on both Agents after admission. Only the
        // queued revision that will deploy an explicit policy needs that permission.
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
           VALUES ($1, $2, $3, $4, $5, 'deny'), ($6, $2, $3, $4, $7, 'deny')`,
          [
            `restriction-${randomUUID()}`,
            fixture.namespace.id,
            action,
            kind,
            resourceId,
            `restriction-${randomUUID()}`,
            controlResourceId,
          ],
        );
        const checked: string[] = [];
        const prepared: string[] = [];
        let backendSecretReads = 0;
        fixture.secretDriver.setResolveOverride(() => {
          backendSecretReads++;
          throw new Error("Worker cannot read backend Secrets.");
        });
        await fixture.start({
          ...supportingCompute,
          validateProtectedRepositoryNetworkPolicy(revision) {
            assert.ok("id" in revision && typeof revision.id === "string");
            checked.push(revision.id);
          },
          async prepareRevision(revision, context) {
            prepared.push(revision.id);
            return supportingCompute.prepareRevision(revision, context);
          },
        });
        await fixture.work(ordinary, "succeeded");
        const terminal = await settledRevision(fixture, candidate);
        assert.deepEqual(
          {
            state: terminal.state,
            reason: terminal.reasonCode,
            candidateWasPrepared: prepared.includes(candidate.id),
            keptPredecessor: (await fixture.currentAgent(owner))?.activeRevisionId === previous.id,
          },
          {
            state: "failed_permanent",
            reason: "AUTHORIZATION_DENIED",
            candidateWasPrepared: false,
            keptPredecessor: true,
          },
        );
        assert.deepEqual(checked, []);
        assert.deepEqual(prepared, [ordinary.id]);
        assert.equal(backendSecretReads, 0);
        assert.equal((await fixture.currentAgent(control))?.activeRevisionId, ordinary.id);

        // Audit the denied authorization itself, not merely the enclosing deploy action.
        const denied = await fixture.observerPool.query<{ authorization: unknown }>(
          `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
           FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
          [fixture.namespace.id],
        );
        assert.deepEqual(denied.rows, [
          {
            authorization: {
              principalId: fixture.actor.id,
              action,
              resource: { kind, id: resourceId, namespaceId: fixture.namespace.id },
            },
          },
        ]);
      },
    );
  }
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

      const active = await fixture.observerPool.query<{
        id: string;
        active_revision_id: string | null;
      }>(
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
      // The deployment status provides recovery guidance for the rejected Harness (finding 828).
      assert.deepEqual((await fixture.deploymentStatus(unsupported, unsupportedRevision)).error, {
        code: "HARNESS_DESCRIPTOR_MISMATCH",
        message:
          "This revision's Harness or Harness version is no longer approved, for example after a controller upgrade. Deploy again to admit a revision with the approved version.",
      });
    },
  );

  for (const secretAuthMethod of ["api_key", "codex_pat"] as const) {
    test(
      `${secretAuthMethod} revision dispatch rechecks Configuration and exact harness Secret grants without backend Secret reads`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, { secretAuthMethod });
        const executionMode = secretAuthMethod === "codex_pat" ? "dedicated" : "embedded";
        const [allowed, configurationDenied, actorSecretDenied, agentSecretUngranted] =
          await Promise.all([
            fixture.agent("allowed", { executionMode }),
            fixture.agent("configuration-denied", { executionMode }),
            fixture.agent("actor-secret-denied", { executionMode }),
            fixture.agent("agent-secret-ungranted", { executionMode, grantHarnessSecret: false }),
          ]);
        const [
          allowedRevision,
          configurationDeniedRevision,
          actorSecretDeniedRevision,
          agentSecretUngrantedRevision,
        ] = await Promise.all([
          fixture.revision(allowed, 1),
          fixture.revision(configurationDenied, 1),
          fixture.revision(actorSecretDenied, 1),
          fixture.revision(agentSecretUngranted, 1),
        ]);
        const actorDeniedSecret = harnessSecretId(actorSecretDenied);
        const ungrantedSecret = harnessSecretId(agentSecretUngranted);
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
            configurationDenied.configurationId,
            `restriction-${randomUUID()}`,
            actorDeniedSecret,
          ],
        );
        const prepared: { id: AgentRevision["id"]; operationContext: DispatchContext }[] = [];
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
        await Promise.all([
          fixture.work(allowedRevision, "succeeded"),
          fixture.work(configurationDeniedRevision, "failed_permanent"),
          fixture.work(actorSecretDeniedRevision, "failed_permanent"),
          fixture.work(agentSecretUngrantedRevision, "failed_permanent"),
        ]);
        const { harnessAuth } = allowedRevision;
        assert.ok(isSecretHarnessAuth(harnessAuth), "the admitted Harness uses a Secret");
        const source = await fixture.state.read((view) =>
          view.secrets.findSecret(fixture.namespace.id, harnessAuth.source.id),
        );
        assert.ok(source, "the admitted Secret is still stored");
        assert.deepEqual(
          prepared,
          [
            {
              id: allowedRevision.id,
              operationContext: {
                secretEnvironment: [],
                harnessAuth: { ...harnessAuth, backendRef: source.backendRef },
              },
            },
          ],
          "only the independently authorized binding reaches Compute, outside gateway environment projections",
        );
        const denied = await fixture.observerPool.query<{ authorization: unknown }>(
          `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
         FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
          [fixture.namespace.id],
        );
        const deniedResources = denied.rows
          .map(({ authorization }) => {
            const decision = asRecord(authorization);
            const resource = asRecord(decision?.resource);
            assert.ok(typeof decision?.principalId === "string", "denial has a principal");
            assert.ok(
              typeof resource?.kind === "string" && typeof resource.id === "string",
              "denial has an exact resource",
            );
            return `${decision.principalId}:${resource.kind}:${resource.id}`;
          })
          .sort();
        assert.deepEqual(
          deniedResources,
          [
            `${fixture.actor.id}:configuration:${configurationDenied.configurationId}`,
            `${fixture.actor.id}:secret:${actorDeniedSecret}`,
            `${agentSecretUngranted.servicePrincipalId}:secret:${ungrantedSecret}`,
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
      const effects: ComputeEffect[] = [];
      await fixture.start(observeComputeEffects(fixture.compute, effects), {
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
      });
      await fixture.work(candidate, "failed_permanent");
      assert.deepEqual(effects, []);
      const current = await fixture.currentAgent(owner);
      assert.ok(current, "the Agent is still stored");
      assert.equal(current.activeRevisionId, undefined);
      const work = await fixture.observerPool.query<{ reason_code: string | null }>(
        "SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'",
        [candidate.id],
      );
      const [failure] = work.rows;
      assert.ok(failure, "the failed reconciliation is audited");
      assert.equal(failure.reason_code, "SECRET_DRIVER_MISMATCH");
      // The deployment status provides recovery guidance without exposing Driver IDs (finding 828).
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
      const effects: ComputeEffect[] = [];
      await fixture.start({
        ...observeComputeEffects(fixture.compute, effects),
        id: "compute-replacement",
      });
      await fixture.work(candidate, "failed_permanent");
      await fixture.stop();
      assert.deepEqual(effects, []);
      const current = await fixture.currentAgent(owner);
      assert.ok(current, "the Agent is still stored");
      assert.equal(current.activeRevisionId, undefined);
      assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
        code: "COMPUTE_DRIVER_MISMATCH",
        message:
          "The Installation no longer selects the Compute Driver this revision was admitted with. Deploy again to admit a revision for the selected driver.",
      });
    },
  );
}
