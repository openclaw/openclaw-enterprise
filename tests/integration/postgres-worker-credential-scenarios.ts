import assert from "node:assert/strict";
import test, { type TestContext, type TestOptions } from "node:test";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type { Agent, HarnessAuthBinding } from "../../packages/contracts/src/index.ts";
import type { RevisionFixture } from "../helpers/postgres-worker-refused-candidate.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

export type RuntimeDrivers = NonNullable<ControllerWorkerOptions["drivers"]>;
export type FixtureRevision = Awaited<ReturnType<RevisionFixture["revision"]>>;
export type CredentialSourceAgent = Readonly<Agent> & {
  harnessAuth: Extract<HarnessAuthBinding, { method: "credential_source" }>;
};
export type Identified = { id: string };
export type WithdrawalCall = [revisionId: string, sourceId: string];

export function createCredentialSourceRevisionCases(testFile: string) {
  const { setup, cleanup } = createWorkerRevisionFixtures(testFile);

  function revisionTest(
    name: string,
    run: (fixture: RevisionFixture, context: TestContext) => Promise<void>,
    options?: TestOptions,
  ) {
    test(name, { ...requiresPostgres, ...options }, async (context) =>
      run(await setup(context), context),
    );
  }

  return { setup, cleanup, revisionTest };
}

// Removes the Agent principal's exact grant on one credential source.
export async function removeSourceGrant(
  fixture: RevisionFixture,
  owner: Pick<Agent, "servicePrincipalId">,
  credentialSourceId: string,
) {
  const { rowCount } = await fixture.observerPool.query<never>(
    `DELETE FROM occ.iam_access_bindings
     WHERE identity_subject_id = $1 AND resource_kind = 'credential_source'
       AND resource_id = $2`,
    [owner.servicePrincipalId, credentialSourceId],
  );
  assert.equal(rowCount, 1);
}
