import assert from "node:assert/strict";

// These runners exercise specific worker workflows. New ordering, cancellation or
// claim-loss scenarios belong in explicit tests, not another option on a runner.
export async function assertFailedDeployment(
  fixture,
  { owner, candidate },
  { error, resultData = null },
  timeoutMs,
) {
  const failed = await fixture.work(candidate, "failed_permanent", timeoutMs);
  assert.equal(failed.attempt_count, 1);
  const result = await fixture.workResult(candidate);
  assert.deepEqual(result.rows, [{ reason_code: error.code, result_data: resultData }]);
  const status = await fixture.deploymentStatus(owner, candidate);
  assert.equal(status.status, "failed");
  assert.deepEqual(status.error, error);
}

// A boundary Compute Driver reports the supplied evidence; the real worker decides
// whether it is terminal, and PostgreSQL persists the result. Expectations are case data.
export async function runRuntimeFailureCases(fixture, cases, timeoutMs) {
  const scenarios = [];
  for (const scenario of cases) {
    const admitted = await fixture.admitInitialRevision(scenario.label);
    scenarios.push({ ...scenario, ...admitted, preparations: 0 });
  }
  const byRevision = new Map(scenarios.map((scenario) => [scenario.candidate.id, scenario]));
  await fixture.start({
    ...fixture.compute,
    async prepareRevision(revision) {
      const scenario = byRevision.get(revision.id);
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
  });
  for (const scenario of scenarios) {
    await assertFailedDeployment(fixture, scenario, scenario.expected, timeoutMs);
    if (scenario.expected.preparations !== undefined) {
      assert.equal(scenario.preparations, scenario.expected.preparations);
    }
    if (scenario.expected.activeRevisionId !== undefined) {
      const active = await fixture.activePointer(scenario.owner);
      assert.equal(active.rows[0].active_revision_id, scenario.expected.activeRevisionId);
    }
  }
  return scenarios;
}

// Preparation throws a Driver failure on every pass. The worker owns retries,
// deadline accounting and terminalization; the case specifies the expected error.
export async function runPreparationFailureCase(
  fixture,
  { label, failure, convergenceTimeoutMs, expected },
  timeoutMs,
) {
  const admitted = await fixture.admitInitialRevision(label);
  let preparations = 0;
  await fixture.start(
    {
      ...fixture.compute,
      async prepareRevision() {
        preparations += 1;
        throw failure();
      },
    },
    { convergenceTimeoutMs },
  );
  await assertFailedDeployment(fixture, admitted, expected, timeoutMs);
  return preparations;
}
