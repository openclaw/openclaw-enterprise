import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  PostgresHumanAuthentication,
  type GithubRosterMapping,
  type HumanAuthenticationActor,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";

async function waitForBlocker(pool: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (true) {
    const blocked = await pool.query<{ waiting: boolean }>(
      "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS waiting",
      [pid],
    );
    if (blocked.rows[0]?.waiting) {
      break;
    }
    assert.ok(Date.now() < deadline, "the second transaction must wait for the held authority");
    await delay(10);
  }
}

/** The surrounding guarded-authentication fixture owns an activated Installation and actor. */
export async function assertGithubRosterMemberships(
  state: PostgresPlatformState,
  failingAuditState: PostgresPlatformState,
  pool: Pool,
  installationId: string,
  issuer: string,
  admin: HumanAuthenticationActor,
  userId: string,
  principalId: string,
): Promise<void> {
  const providerId = "github:qualified-test-instance";
  const subject = "451";
  const auth = new PostgresHumanAuthentication(state, installationId, issuer, {
    externalProviderIds: [providerId],
  });
  const version = async () => (await auth.readAccount(userId, admin)).version;
  const attach = async () =>
    (await auth.attachExternal(userId, providerId, subject, admin, await version())).methodId;
  const methodId = await attach();
  const groupId = `group_config_roster-${randomUUID()}`;
  const first: GithubRosterMapping = {
    id: "first",
    providerId,
    organizationId: "22",
    teamId: "44",
    groupId,
  };
  const second: GithubRosterMapping = { ...first, id: "second", teamId: "55" };
  await state.transact(async (unit) => {
    await unit.iamPolicy.createConfiguredGroup({ id: groupId, name: groupId });
  });
  const sync = async (mappings: readonly GithubRosterMapping[]) =>
    state.transact(async (unit) => {
      assert.ok(unit.installations.syncGithubRosterMappings);
      await unit.installations.syncGithubRosterMappings(mappings);
    });
  const begin = async (mapping: GithubRosterMapping) => {
    const snapshot = await auth.snapshotExternal(providerId, subject);
    assert.ok(snapshot && "proof" in snapshot);
    const claim = await auth.beginRosterSignIn(snapshot.proof, mapping);
    assert.ok(claim);
    return { claim, proof: snapshot.proof };
  };
  const finish = async (
    { claim, proof }: Awaited<ReturnType<typeof begin>>,
    result: "present" | "absent",
  ) =>
    auth.issueSession(proof, { id: randomUUID(), token: randomUUID(), userId }, undefined, [
      { claim, result },
    ]);
  const memberships = async () =>
    (await state.loadNativeIAMState(installationId)).memberships.filter(
      (row) => row.groupId === groupId && row.principalId === principalId,
    ).length;
  const manual = async () =>
    pool.query("INSERT INTO occ.iam_group_memberships(group_id,principal_id) VALUES($1,$2)", [
      groupId,
      principalId,
    ]);
  const removeManual = async () =>
    pool.query(
      "DELETE FROM occ.iam_group_memberships WHERE group_id=$1 AND principal_id=$2 AND roster_source_id IS NULL",
      [groupId, principalId],
    );
  const refresh = async (mapping: GithubRosterMapping) => {
    // Advance the fixture's due time without replacing the production claim or clock.
    await pool.query(
      "UPDATE occ.github_roster_mappings SET next_refresh_at=now() WHERE mapping_id=$1 AND generation IS NOT NULL",
      [mapping.id],
    );
    const run = await auth.claimRosterRefresh(mapping);
    assert.ok(run);
    return run;
  };
  const readStatus = async (mapping: GithubRosterMapping) =>
    (await auth.readRosterStatuses([mapping], admin))[0]!;
  const activate = async (mapping: GithubRosterMapping) => {
    const snapshot = await auth.snapshotExternal(providerId, subject);
    assert.ok(snapshot && "proof" in snapshot);
    assert.equal(await auth.beginRosterSignIn(snapshot.proof, mapping), undefined);
    await auth.finishRosterRefresh(await refresh(mapping), { status: "unavailable" });
    assert.equal(await auth.beginRosterSignIn(snapshot.proof, mapping), undefined);
    await auth.finishRosterRefresh(await refresh(mapping), {
      status: "complete",
      presentSubjects: [subject],
      confirmedAbsentSubjects: [],
    });
    assert.equal(await memberships(), 0);
  };
  await sync([first, second]);
  await activate(first);
  await activate(second);
  const initialSuccess = (await readStatus(first)).lastSuccessfulAt;
  for (const manualFirst of [true, false]) {
    if (manualFirst) {
      await manual();
    }
    await finish(await begin(first), "present");
    if (!manualFirst) {
      await manual();
    }
    assert.equal(await memberships(), 1);
    await finish(await begin(first), "absent");
    assert.equal(await memberships(), 1);
    await removeManual();
    assert.equal(await memberships(), 0);
  }
  await finish(await begin(first), "present");
  await finish(await begin(second), "present");
  await finish(await begin(second), "absent");
  assert.equal(await memberships(), 1);

  const run = await refresh(first);
  assert.deepEqual(run.subjects, [subject]);
  const interrupted = await begin(first);
  // The provider failed after the sign-in started, so it has no verified result to settle.
  const departure = {
    status: "complete" as const,
    presentSubjects: ["992"],
    confirmedAbsentSubjects: [subject],
  };
  const failedAudit = new PostgresHumanAuthentication(failingAuditState, installationId, issuer, {
    externalProviderIds: [providerId],
  });
  const withdrawals = async () =>
    (
      await pool.query<{ method_id: string; subject: string }>(
        `SELECT details->>'methodId' AS method_id,details->>'subject' AS subject
    FROM occ.audit_events WHERE action='iam.github_roster.withdraw' AND details->>'groupId'=$1`,
        [groupId],
      )
    ).rows;
  await assert.rejects(failedAudit.finishRosterRefresh(run, departure), {
    name: "ScopeViolationError",
  });
  assert.equal(await memberships(), 1);
  assert.equal((await readStatus(first)).lastSuccessfulAt, initialSuccess);
  assert.deepEqual(await withdrawals(), []);
  assert.equal(await auth.finishRosterRefresh(run, departure), true);
  assert.deepEqual(await withdrawals(), [{ method_id: methodId, subject }]);
  assert.equal(await memberships(), 0);
  await assert.rejects(finish(interrupted, "present"), /changed/);
  const status = await readStatus(first);
  assert.equal(status.status, "complete");
  assert.ok(status.lastSuccessfulAt);

  const firstGrant = await begin(first);
  const noGrants = await refresh(first);
  assert.deepEqual(noGrants.subjects, []);
  await auth.finishRosterRefresh(noGrants, {
    status: "complete",
    presentSubjects: [subject],
    confirmedAbsentSubjects: [],
  });
  assert.equal(await memberships(), 0);
  await assert.rejects(finish(firstGrant, "present"), /changed/);
  await finish(await begin(first), "present");
  const stale = await refresh(first);
  await finish(await begin(first), "absent");
  await finish(await begin(first), "present");
  await auth.finishRosterRefresh(stale, {
    status: "complete",
    presentSubjects: [],
    confirmedAbsentSubjects: [subject],
  });
  assert.equal(await memberships(), 1);
  const lastSuccess = (await readStatus(first)).lastSuccessfulAt;
  const outage = await refresh(first);
  await auth.finishRosterRefresh(outage, { status: "unavailable" });
  assert.equal((await readStatus(first)).lastSuccessfulAt, lastSuccess);
  assert.equal(await memberships(), 1);

  const liveSession = await finish(await begin(first), "present");
  // Make the target account's existing admin Role depend solely on the roster Group.
  // Its session survives a confirmed departure, but the next override may not commit.
  const direct = (
    await pool.query<{
      id: string;
      role_id: string;
      resource_kind: string | null;
      resource_id: string | null;
    }>(
      "SELECT id,role_id,resource_kind,resource_id FROM occ.iam_access_bindings WHERE identity_subject_id=$1 AND namespace_id IS NULL",
      [principalId],
    )
  ).rows;
  assert.equal(direct.length, 1);
  const binding = direct[0]!;
  const groupBinding = `binding_${randomUUID()}`;
  await pool.query(
    "INSERT INTO occ.iam_access_bindings(id,group_subject_id,role_id,resource_kind,resource_id) VALUES($1,$2,$3,$4,$5)",
    [groupBinding, groupId, binding.role_id, binding.resource_kind, binding.resource_id],
  );
  await pool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [binding.id]);
  const rosterAdmin = { principalId, userId, sessionId: liveSession.id };
  const target = await auth.readRosterOverride(userId, methodId, first, rosterAdmin);
  assert.equal(
    (
      await new NativeIAMDriver(state).authorize({
        principalId,
        action: "administer",
        resource: { kind: "installation", id: installationId },
      })
    ).allowed,
    true,
  );
  await auth.finishRosterRefresh(await refresh(first), {
    status: "complete",
    presentSubjects: [],
    confirmedAbsentSubjects: [subject],
  });
  const overrideAudit = () =>
    pool.query(
      "SELECT id FROM occ.audit_events WHERE action='iam.github_roster.override' AND details->>'methodId'=$1",
      [methodId],
    );
  const previousAudit = (await overrideAudit()).rows;
  await assert.rejects(
    auth.setRosterOverride(
      userId,
      methodId,
      first,
      true,
      rosterAdmin,
      target.accountVersion,
      target.version,
    ),
    /cannot administer/,
  );
  assert.deepEqual(await auth.readRosterOverride(userId, methodId, first, admin), target);
  assert.deepEqual((await overrideAudit()).rows, previousAudit);
  assert.equal((await auth.currentSession(liveSession.token))?.id, liveSession.id);
  await pool.query(
    "INSERT INTO occ.iam_access_bindings(id,identity_subject_id,role_id,resource_kind,resource_id) VALUES($1,$2,$3,$4,$5)",
    [binding.id, principalId, binding.role_id, binding.resource_kind, binding.resource_id],
  );
  await pool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [groupBinding]);
  await finish(await begin(first), "present");
  const contending = await pool.connect();
  try {
    await contending.query("BEGIN");
    await contending.query("LOCK TABLE occ.iam_access_bindings IN ROW EXCLUSIVE MODE");
    await assert.rejects(
      auth.setRosterOverride(
        userId,
        methodId,
        first,
        true,
        admin,
        target.accountVersion,
        target.version,
      ),
      /IAM policy is changing/,
    );
    assert.deepEqual(await auth.readRosterOverride(userId, methodId, first, admin), target);
    assert.deepEqual((await overrideAudit()).rows, previousAudit);
  } finally {
    await contending.query("ROLLBACK");
    contending.release();
  }
  const beforeDeny = await begin(first);
  const readOverride = () => auth.readRosterOverride(userId, methodId, first, admin);
  const writeOverride = async (deny: boolean, expected = readOverride()) => {
    const current = await expected;
    return auth.setRosterOverride(
      userId,
      methodId,
      first,
      deny,
      admin,
      current.accountVersion,
      current.version,
    );
  };

  const beforeWrite = await readOverride();
  const otherAuth = new PostgresHumanAuthentication(
    new PostgresPlatformState(pool),
    installationId,
    issuer,
    { externalProviderIds: [providerId] },
  );
  const held = Promise.withResolvers<number>();
  const heldOperation = state.transact(async (unit) => {
    await auth.holdSession(unit, userId, liveSession.id);
    const backend = await state.queryInTransaction(unit, "SELECT pg_backend_pid() AS pid");
    const holderPid = (backend.rows[0] as { pid: number }).pid;
    held.resolve(holderPid);
    await waitForBlocker(pool, holderPid);
    // This is the same order as OCC's ordinary durable authority writer.
    await unit.installations.holdIAMConfiguration("shared");
  });
  void heldOperation.catch(held.reject);
  const override = held.promise.then(() =>
    otherAuth.setRosterOverride(
      userId,
      methodId,
      first,
      true,
      admin,
      beforeWrite.accountVersion,
      beforeWrite.version,
    ),
  );
  for (const result of await Promise.allSettled([heldOperation, override])) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  const superseded = await readOverride();
  await writeOverride(false);
  await writeOverride(true);
  await assert.rejects(writeOverride(false, Promise.resolve(superseded)), /override has changed/);
  const stillSignedIn = await auth.currentSession(liveSession.token);
  assert.equal(stillSignedIn?.id, liveSession.id);
  const independent = await new NativeIAMDriver(state).authorize({
    principalId,
    action: "read",
    resource: { kind: "installation", id: installationId },
  });
  assert.equal(independent.allowed, true);

  assert.equal(await memberships(), 0);
  await assert.rejects(finish(beforeDeny, "present"), /mapping has changed/);
  await sync([]);
  await sync([first]);
  await activate(first);
  await finish(await begin(first), "present");
  assert.equal(await memberships(), 0);
  const beforeRestore = await begin(first);
  await writeOverride(false);
  await assert.rejects(finish(beforeRestore, "present"), /mapping has changed/);
  assert.equal(await memberships(), 0);
  await finish(await begin(first), "present");
  await auth.changeAccount(userId, "disable", admin, await version());
  await auth.changeAccount(userId, "enable", admin, await version());
  assert.equal(await memberships(), 0);
  await finish(await begin(first), "present");
  await auth.detachExternal(userId, methodId, admin, await version());
  const replacement = await attach();
  assert.equal(await memberships(), 0);
  await finish(await begin(first), "present");
  const beforeReplacement = await auth.readRosterOverride(userId, replacement, first, admin);
  await pool.query("UPDATE occ.account SET account_id=$1 WHERE id=$2", ["998", replacement]);
  assert.equal(await memberships(), 0);
  await assert.rejects(
    auth.setRosterOverride(
      userId,
      replacement,
      first,
      true,
      admin,
      beforeReplacement.accountVersion,
      beforeReplacement.version,
    ),
    /override has changed/,
  );
  await pool.query("UPDATE occ.account SET account_id=$1 WHERE id=$2", [subject, replacement]);
  await assert.rejects(
    auth.setRosterOverride(
      userId,
      replacement,
      first,
      true,
      admin,
      beforeReplacement.accountVersion,
      beforeReplacement.version,
    ),
    /override has changed/,
  );
  let rawMethod = replacement;
  const writer = await pool.connect();
  try {
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]!.pid;
    for (const operation of ["replace", "delete"] as const) {
      for (const guardFirst of [true, false]) {
        await finish(await begin(first), "present");
        const change = () =>
          operation === "delete"
            ? writer.query("DELETE FROM occ.account WHERE id=$1", [rawMethod])
            : writer.query("UPDATE occ.account SET account_id='998' WHERE id=$1", [rawMethod]);
        const guarded = async (whileHeld: (pid: number) => Promise<void>) =>
          state.transact(async (unit) => {
            await auth.holdSession(unit, admin.userId, admin.sessionId);
            await unit.installations.holdIAMConfiguration("shared");
            const pid = (await state.queryInTransaction(unit, "SELECT pg_backend_pid() AS pid"))
              .rows[0] as { pid: number };
            const read = async () =>
              (await state.loadNativeIAMStateInTransaction(unit, installationId)).memberships.some(
                (row) => row.groupId === groupId && row.principalId === principalId,
              );
            const initial = await read();
            await whileHeld(pid.pid);
            assert.equal(await read(), initial);
            return initial;
          });
        if (guardFirst) {
          let mutation: ReturnType<typeof change> | undefined;
          assert.equal(
            await guarded(async (pid) => {
              mutation = change();
              await waitForBlocker(pool, pid);
              assert.equal(await memberships(), 1);
            }),
            true,
          );
          await mutation;
        } else {
          await writer.query("BEGIN");
          try {
            await change();
            const incoming = guarded(async () => {});
            await waitForBlocker(pool, writerPid);
            await writer.query("COMMIT");
            assert.equal(await incoming, false);
          } finally {
            await writer.query("ROLLBACK");
          }
        }
        assert.equal(await memberships(), 0);
        if (operation === "delete") {
          rawMethod = await attach();
        } else {
          await writer.query("UPDATE occ.account SET account_id=$2 WHERE id=$1", [
            rawMethod,
            subject,
          ]);
        }
      }
    }
    // The snapshot predates this attachment's first contribution. PostgreSQL must
    // refuse a replacement whose trigger cannot see the newly committed source.
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await writer.query("SELECT id FROM occ.github_roster_sources WHERE method_id=$1", [
        rawMethod,
      ]);
      await finish(await begin(first), "present");
      await assert.rejects(
        writer.query("UPDATE occ.account SET account_id='998' WHERE id=$1", [rawMethod]),
        /foreign key constraint "github_roster_sources_method_id_method_version_fkey"/,
      );
    } finally {
      await writer.query("ROLLBACK");
    }
    assert.equal(await memberships(), 1);
    await writer.query("UPDATE occ.account SET account_id='998' WHERE id=$1", [rawMethod]);
    assert.equal(await memberships(), 0);
  } finally {
    writer.release();
  }
  await sync([]);
}
