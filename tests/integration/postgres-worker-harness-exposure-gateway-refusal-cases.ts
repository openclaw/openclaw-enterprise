import assert from "node:assert/strict";
import test from "node:test";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type { Agent, AgentRevision, ComputeDriver } from "../../packages/contracts/src/index.ts";
import { SandboxGatewayUnauthorizedError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { occLogLine } from "../helpers/occ-log-line.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

type WorkerRevisionFixtures = ReturnType<typeof createWorkerRevisionFixtures>;
type RevisionFixture = Awaited<ReturnType<WorkerRevisionFixtures["setup"]>>;
type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];
type WorkIdentity = { id: string; idempotencyKey: string };

async function assertWorkAttempts(
  fixture: RevisionFixture,
  work: WorkIdentity,
  state: "succeeded" | "failed_permanent",
  attempts: number,
  timeoutMs?: number,
): Promise<void> {
  assert.ok(typeof work.id === "string" && typeof work.idempotencyKey === "string");
  const row = asRecord(await fixture.work(work, state, timeoutMs));
  assert.ok(row, `missing Work row for ${work.idempotencyKey}`);
  assert.equal(row.attempt_count, attempts, work.idempotencyKey);
}

async function assertGatewayRefusal(
  fixture: RevisionFixture,
  work: WorkIdentity,
  attempts: number,
  timeoutMs?: number,
): Promise<void> {
  await assertWorkAttempts(fixture, work, "failed_permanent", attempts, timeoutMs);
  const { rows }: { rows: readonly unknown[] } = await fixture.workResult(work);
  const row = asRecord(rows[0]);
  assert.ok(row, `missing Work result for ${work.idempotencyKey}`);
  assert.equal(row.reason_code, "SANDBOX_GATEWAY_UNAUTHORIZED", work.idempotencyKey);
}

async function activeRevision(
  fixture: RevisionFixture,
  owner: Pick<Agent, "id">,
): Promise<string | undefined> {
  const agent = asRecord(await fixture.currentAgent(owner));
  assert.ok(agent, `missing Agent ${owner.id}`);
  const { activeRevisionId } = agent;
  assert.ok(activeRevisionId === undefined || typeof activeRevisionId === "string");
  return activeRevisionId;
}

function gatewayRefusal(revisionId: string, transient: boolean): SandboxGatewayUnauthorizedError {
  return new SandboxGatewayUnauthorizedError(
    `OpenShell refused the controller gateway identity in Workspace w, so Sandbox ${revisionId} cannot be confirmed removed.`,
    { transient },
  );
}

export function registerHarnessExposureGatewayRefusalCases({
  revisionTest,
  setup,
}: WorkerRevisionFixtures): void {
  // Finding 1676: a stop or deletion records a revision's Sandbox gone only once the Sandbox
  // gateway confirms it. When the gateway refuses the controller's own identity, retrying cannot
  // help until an operator restores its Workspace role, so the work fails with that code instead of
  // spending its attempts as a generic failure, and the Agent keeps its active revision.
  revisionTest(
    "a stop or deletion the Sandbox gateway refuses to confirm fails with SANDBOX_GATEWAY_UNAUTHORIZED",
    async (fixture: RevisionFixture) => {
      const { owner: stopped, candidate: stopping } = await fixture.admitInitialRevision("stop");
      const { owner: deleted, candidate: deleting } = await fixture.admitInitialRevision("delete");
      const refusals = new Set<string>();
      const refuseUnauthorized = ({ id }: Pick<AgentRevision, "id">) => {
        if (refusals.has(id)) {
          throw gatewayRefusal(id, false);
        }
      };
      const compute: ComputeDriver = fixture.compute;
      await fixture.start({
        ...compute,
        async stopRevision(revision) {
          refuseUnauthorized(revision);
          return compute.stopRevision(revision);
        },
        async retireRevision(revision) {
          refuseUnauthorized(revision);
          return compute.retireRevision(revision);
        },
      } satisfies ComputeDriver);
      await Promise.all([fixture.work(stopping, "succeeded"), fixture.work(deleting, "succeeded")]);
      refusals.add(stopping.id).add(deleting.id);
      const stop = await fixture.requestStop(stopped);
      await assertGatewayRefusal(fixture, stop, 1);
      const deletion = await fixture.requestDeletion(deleted);
      await assertGatewayRefusal(fixture, deletion, 1);
      // Nothing was recorded stopped or removed.
      assert.equal(await activeRevision(fixture, stopped), stopping.id);
      assert.equal(await activeRevision(fixture, deleted), deleting.id);
    },
  );

  // Finding 1694: OpenShell also answers UNAUTHENTICATED while the controller's token file or the
  // gateway's signing keys are between refreshes. The refusal keeps its code but retries within
  // the attempt budget, on stops, deletions and deployments alike; a refusal that outlasts the
  // budget fails with the code and the worker logs the same guidance the deployment status shows.
  test(
    "a stop, deletion or deployment refused as unauthenticated retries before failing with the code",
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 2 });
      const { owner: stopped, candidate: stopping } = await fixture.admitInitialRevision("stop-t");
      const { owner: deleted, candidate: deleting } =
        await fixture.admitInitialRevision("delete-t");
      const { owner: recovered, candidate: recovering } =
        await fixture.admitInitialRevision("stop-r");
      const { owner: refusedDeployOwner, candidate: refusedDeploy } =
        await fixture.admitInitialRevision("deploy-t");
      const { owner: recoveredDeployOwner, candidate: recoveredDeploy } =
        await fixture.admitInitialRevision("deploy-r");
      // Refusals left per revision (every Compute call on it); Infinity never clears.
      const refusals = new Map<string, number>([
        [refusedDeploy.id, Number.POSITIVE_INFINITY],
        [recoveredDeploy.id, 1],
      ]);
      const refuseUnauthenticated = ({ id }: Pick<AgentRevision, "id">) => {
        const remaining = refusals.get(id) ?? 0;
        if (remaining > 0) {
          refusals.set(id, remaining - 1);
          throw gatewayRefusal(id, true);
        }
      };
      const compute: ComputeDriver = fixture.compute;
      const events: WorkerEvent[] = [];
      await fixture.start(
        {
          ...compute,
          async prepareRevision(revision, deploymentContext) {
            refuseUnauthenticated(revision);
            return compute.prepareRevision(revision, deploymentContext);
          },
          async stopRevision(revision) {
            refuseUnauthenticated(revision);
            return compute.stopRevision(revision);
          },
          async retireRevision(revision) {
            refuseUnauthenticated(revision);
            return compute.retireRevision(revision);
          },
        } satisfies ComputeDriver,
        { emit: (event) => events.push(event) },
      );
      await Promise.all(
        [stopping, deleting, recovering].map((candidate) => fixture.work(candidate, "succeeded")),
      );
      // Deployments: one refusal is retried and the second attempt activates; a persistent one
      // spends the budget and fails with the code.
      await assertWorkAttempts(fixture, recoveredDeploy, "succeeded", 2, 30_000);
      await assertGatewayRefusal(fixture, refusedDeploy, 2, 30_000);
      // Stops and deletions: the same, on the Compute calls that confirm the Sandbox gone.
      refusals.set(stopping.id, Number.POSITIVE_INFINITY);
      refusals.set(deleting.id, Number.POSITIVE_INFINITY);
      refusals.set(recovering.id, 1);
      const stop = await fixture.requestStop(stopped);
      await assertGatewayRefusal(fixture, stop, 2, 30_000);
      const deletion = await fixture.requestDeletion(deleted);
      await assertGatewayRefusal(fixture, deletion, 2, 30_000);
      const recovery = await fixture.requestStop(recovered);
      await assertWorkAttempts(fixture, recovery, "succeeded", 2, 30_000);
      // Nothing was recorded stopped or removed for the refused ones; the recovered one stopped.
      assert.equal(await activeRevision(fixture, stopped), stopping.id);
      assert.equal(await activeRevision(fixture, deleted), deleting.id);
      assert.notEqual(await activeRevision(fixture, recovered), recovering.id);
      // The guidance code is logged with the failed stop and deletion only, not with their
      // retries. These are the lines the worker log keeps (finding 2245).
      const completed = events
        .filter(
          ({ event, code }) =>
            event === "worker.completed" && code === "SANDBOX_GATEWAY_UNAUTHORIZED",
        )
        .map(occLogLine);
      const terminal = completed.filter(({ hintCode }) => hintCode !== undefined);
      assert.deepEqual(
        terminal.map(({ agentId }) => agentId).sort(),
        [stopped.id, deleted.id].sort(),
      );
      // Attempt 1 is the Driver's retry and the queue's; attempt 2 is still the Driver's retry
      // but the queue's permanent failure, which is what the line reports with the guidance.
      for (const agent of [stopped, deleted]) {
        assert.deepEqual(
          completed
            .filter(({ agentId }) => agentId === agent.id)
            .map(({ attempt, result, outcome, hintCode }) => ({
              attempt,
              result,
              outcome,
              hintCode,
            })),
          [
            { attempt: 1, result: "retry", outcome: "retry", hintCode: undefined },
            {
              attempt: 2,
              result: "retry",
              outcome: "permanent",
              hintCode: "sandbox-gateway-identity",
            },
          ],
        );
      }
      // Every retried attempt was logged without it (the deployments never get it: their status
      // shows the guidance).
      const retried = completed.filter(
        ({ outcome, hintCode }) => outcome === "retry" && hintCode === undefined,
      );
      assert.deepEqual(
        new Set(retried.map(({ agentId }) => agentId)),
        new Set([
          stopped.id,
          deleted.id,
          recovered.id,
          refusedDeployOwner.id,
          recoveredDeployOwner.id,
        ]),
      );
    },
  );
}
