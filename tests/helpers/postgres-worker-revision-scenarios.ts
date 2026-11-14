import assert from "node:assert/strict";
import type {
  Agent,
  ComputeDriver,
  RuntimeFailureEvidence,
} from "../../packages/contracts/src/index.ts";
import type { ControllerWork, DeploymentStatusError } from "../../packages/occ/src/index.ts";
import type { RevisionFixture, WorkIdentity } from "./postgres-worker-refused-candidate.ts";
import type { waitFor } from "./wait-for.mjs";

type PollingOptions = Parameters<typeof waitFor>[2];

interface AdmittedRevision {
  owner: Readonly<Agent>;
  candidate: WorkIdentity;
}
export interface WorkResultRow {
  reason_code: string | null;
  result_data: NonNullable<ControllerWork["resultData"]> | null;
}

interface FailureExpectation {
  error: DeploymentStatusError;
  resultData?: WorkResultRow["result_data"];
}

interface RuntimeFailureCase {
  label: string;
  runtimeFailure: RuntimeFailureEvidence;
  pendingPasses?: number;
  expected: FailureExpectation & { preparations?: number; activeRevisionId?: string | null };
}

interface PreparationFailureCase {
  label: string;
  failure: () => Error;
  convergenceTimeoutMs?: number;
  expected: FailureExpectation;
}

// These runners exercise specific worker workflows. New ordering, cancellation or
// claim-loss scenarios belong in explicit tests, not another option on a runner.
export async function assertFailedDeployment(
  fixture: RevisionFixture,
  { owner, candidate }: AdmittedRevision,
  { error, resultData = null }: FailureExpectation,
  timeoutMs?: PollingOptions,
) {
  const failed: { attempt_count: number } = await fixture.work(
    candidate,
    "failed_permanent",
    timeoutMs,
  );
  assert.equal(failed.attempt_count, 1);
  const result: { rows: WorkResultRow[] } = await fixture.workResult(candidate);
  assert.deepEqual(result.rows, [{ reason_code: error.code, result_data: resultData }]);
  const status = await fixture.deploymentStatus(owner, candidate);
  assert.equal(status.status, "failed");
  assert.deepEqual(status.error, error);
}

// A boundary Compute Driver reports the supplied evidence; the real worker decides
// whether it is terminal, and PostgreSQL persists the result. Expectations are case data.
export async function runRuntimeFailureCases(
  fixture: RevisionFixture,
  cases: readonly RuntimeFailureCase[],
  timeoutMs?: PollingOptions,
) {
  const scenarios: (RuntimeFailureCase & AdmittedRevision & { preparations: number })[] = [];
  for (const scenario of cases) {
    const admitted: AdmittedRevision = await fixture.admitInitialRevision(scenario.label);
    scenarios.push({ ...scenario, ...admitted, preparations: 0 });
  }
  const byRevision = new Map(scenarios.map((scenario) => [scenario.candidate.id, scenario]));
  const compute: ComputeDriver = {
    ...fixture.compute,
    async prepareRevision(revision) {
      const scenario = byRevision.get(revision.id);
      assert.ok(scenario, `unexpected revision ${revision.id}`);
      scenario.preparations += 1;
      const observation = await fixture.compute.prepareRevision(revision);
      return {
        ...observation,
        ready: false,
        ...(scenario.preparations <= (scenario.pendingPasses ?? 0)
          ? {}
          : { runtimeFailure: scenario.runtimeFailure }),
      };
    },
  };
  await fixture.start(compute);
  for (const scenario of scenarios) {
    await assertFailedDeployment(fixture, scenario, scenario.expected, timeoutMs);
    if (scenario.expected.preparations !== undefined) {
      assert.equal(scenario.preparations, scenario.expected.preparations);
    }
    if (scenario.expected.activeRevisionId !== undefined) {
      const active = await fixture.activePointer(scenario.owner);
      const row: { active_revision_id: string | null } | undefined = active.rows[0];
      assert.ok(row, "missing active revision pointer");
      assert.equal(row.active_revision_id, scenario.expected.activeRevisionId);
    }
  }
  return scenarios;
}

// Preparation throws a Driver failure on every pass. The worker owns retries,
// deadline accounting and terminalization; the case specifies the expected error.
export async function runPreparationFailureCase(
  fixture: RevisionFixture,
  { label, failure, convergenceTimeoutMs, expected }: PreparationFailureCase,
  timeoutMs?: PollingOptions,
) {
  const admitted: AdmittedRevision = await fixture.admitInitialRevision(label);
  let preparations = 0;
  const compute: ComputeDriver = {
    ...fixture.compute,
    async prepareRevision() {
      preparations += 1;
      throw failure();
    },
  };
  const startOptions: NonNullable<Parameters<RevisionFixture["start"]>[1]> & {
    convergenceTimeoutMs: number | undefined;
  } = { convergenceTimeoutMs };
  await fixture.start(compute, startOptions);
  await assertFailedDeployment(fixture, admitted, expected, timeoutMs);
  return preparations;
}
