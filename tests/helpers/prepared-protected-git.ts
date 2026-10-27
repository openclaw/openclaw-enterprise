import assert from "node:assert/strict";
import type { PreparedGitHubUseRequest } from "../../packages/contracts/src/index.ts";
import type { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import type { TestContext } from "node:test";
import {
  admitProtectedVersion,
  baseFixture,
  startProtectedOwner,
  withdrawRepositorySession,
} from "../fixtures/prepared-repository-git.mjs";

/** Real custody and State with a controlled, released recipient snapshot. This does
 * not prove supervisor enforcement; the standing transfer test exercises release. */
export async function coldProtectedGit(
  t: TestContext,
  options: Parameters<typeof baseFixture>[1] = {},
) {
  const f = await baseFixture(t, options);
  const owner: Awaited<ReturnType<typeof startPreparedGitHubGitOwner>> =
    await startProtectedOwner(f);
  const version = await admitProtectedVersion(f, f.revision, true);
  return {
    ...f,
    owner,
    version,
    familyId: version.familyId,
    withdraw: () => withdrawRepositorySession(f, version.admissionId),
    request: (changes: Record<string, unknown> = {}) =>
      f.request({ sessionId: version.sessionId, ...changes }) as PreparedGitHubUseRequest,
  };
}

export async function preparedProtectedGit(
  t: TestContext,
  options: Parameters<typeof baseFixture>[1] = {},
) {
  const f = await coldProtectedGit(t, options);
  const { owner, version } = f;
  const authority = owner.protectedGit!.online;
  assert.deepEqual(await authority.readMaterial(version.route, t.signal), { absent: "unprepared" });
  assert.equal(f.gh.issuesOfTokens.length, 0, "a cold fenced read must not issue");
  assert.equal(
    (
      await f.pool.query("SELECT FROM occ.prepared_github_families WHERE source_id=$1", [
        version.familyId,
      ])
    ).rowCount,
    0,
    "a cold fenced read must not enroll a family",
  );
  await owner.maintain();
  const material = await authority.readMaterial(version.route, t.signal);
  assert.ok(material && "value" in material);
  // Persist the independently controlled install observation under its exact binding.
  await f.pool.query(
    `UPDATE occ.credential_deliveries SET
       desired=desired || jsonb_build_object('credentialState','active','expiresAt',$2::text),
       preparation_attempt_id=$3, material_version=$4
     WHERE revision_id=$1 AND binding_id=$5`,
    [
      version.revisionId,
      material.expiresAt,
      material.preparationAttemptId,
      material.materialVersion,
      version.executionId,
    ],
  );
  return {
    ...f,
    authority,
    material,
    installed: {
      route: version.route,
      preparationAttemptId: material.preparationAttemptId,
      materialVersion: material.materialVersion,
    },
  };
}
