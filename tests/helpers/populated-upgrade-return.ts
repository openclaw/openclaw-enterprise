import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type pg from "pg";
import { temporaryDirectory } from "./temporary-directory.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));

interface Database {
  name: string;
  app: pg.Client;
  migrator: pg.Client;
}

interface Snapshot {
  history: { receipts: unknown; sequence: unknown };
  data: unknown;
  revisions: unknown;
}

export async function assertPopulatedUpgradeReturn(
  context: TestContext,
  container: string,
  candidate: Database,
  archive: Buffer,
  operations: {
    snapshot: (database: Database) => Promise<Snapshot>;
    restore: (archive: Buffer) => Promise<Database>;
    checkHistory: (database: Database) => Promise<unknown>;
  },
) {
  const { snapshot, restore, checkHistory } = operations;
  const { rows: agents } = await candidate.app.query<{
    id: string;
    namespace_id: string;
    active_revision_id: string;
  }>("SELECT id,namespace_id,active_revision_id FROM occ.agents");
  assert.equal(agents.length, 1);
  const agent = agents[0]!;
  assert.ok(agent.active_revision_id);
  const revision = `rev_${randomUUID()}`;
  const audit = `aud_${randomUUID()}`;

  // Admission and selection are committed before the later operator gate. This
  // is a persistence fixture with current Harness fields, not proof of a running gateway or model turn.
  await candidate.app.query("BEGIN");
  try {
    await candidate.app.query(
      `INSERT INTO occ.agent_revisions(id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at)
       SELECT $1,namespace_id,agent_id,revision_number+1,
         jsonb_set(admitted_spec, '{harness}', (admitted_spec->'harness') || '{"overrides":{},"configuration":{}}'::jsonb),backend_id,now()
       FROM occ.agent_revisions WHERE id=$2`,
      [revision, agent.active_revision_id],
    );
    await candidate.app.query("UPDATE occ.agents SET active_revision_id=$1 WHERE id=$2", [
      revision,
      agent.id,
    ]);
    await candidate.app.query(
      `INSERT INTO occ.audit_events(id,occurred_at,kind,actor_id,action,namespace_id,resource_kind,resource_id,outcome,details)
       VALUES($1,now(),'mutation','return-fixture','deploy',$2,'agent',$3,'success',$4)`,
      [audit, agent.namespace_id, agent.id, { revisionId: revision }],
    );
    await candidate.app.query("COMMIT");
  } catch (error) {
    await candidate.app.query("ROLLBACK");
    throw error;
  }
  // An independent connection must observe both writes. Comparing only counts
  // or migration receipts would miss loss of the selected revision or audit.
  const committed = await candidate.migrator.query(
    `SELECT a.active_revision_id,r.id AS revision_id,e.id AS audit_id
     FROM occ.agents a JOIN occ.agent_revisions r ON r.id=a.active_revision_id
     JOIN occ.audit_events e ON e.resource_id=a.id AND e.details->>'revisionId'=r.id
     WHERE a.id=$1 AND e.id=$2`,
    [agent.id, audit],
  );
  assert.deepEqual(committed.rows, [
    { active_revision_id: revision, revision_id: revision, audit_id: audit },
  ]);
  const beforeRefusal = await snapshot(candidate);

  const directory = await temporaryDirectory(context, "upgrade-return-gate-");
  const protectedFile = join(directory, "protected.yaml");
  const observedFile = join(directory, "observed.yaml");
  await writeFile(protectedFile, "controller:\n  replicaCount: 1\n");
  await writeFile(observedFile, '{"controller":{"replicaCount":1}}\n');
  const compare = () =>
    execute(join(repository, "scripts/compare-upgrade-baseline"), [protectedFile, observedFile], {
      timeout: 10_000,
    });
  await compare();
  // The actual comparison primitive refuses configuration drift after commit.
  // These YAML inputs model an operator gate, not a live Helm readback.
  await writeFile(observedFile, "controller:\n  replicaCount: 0\n");
  await assert.rejects(
    compare(),
    (error: { code?: number; stderr?: string }) =>
      error.code === 1 && /Configurations differ/.test(error.stderr ?? ""),
  );

  // Submit the stale archive to the populated database with the same native
  // options as the clean control. Capture the real PostgreSQL refusal, including
  // when it closes stdin before the entire archive has been sent.
  const pending = execute(
    "docker",
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "-U",
      "postgres",
      "--exit-on-error",
      "--single-transaction",
      "--dbname",
      candidate.name,
    ],
    { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );
  pending.child.stdin!.on("error", () => {
    /* The native failure below owns the diagnosis. */
  });
  pending.child.stdin!.end(archive);
  await assert.rejects(
    pending,
    (error: { code?: number; stderr?: string }) =>
      error.code === 1 && /already exists/.test(error.stderr ?? ""),
  );
  assert.deepEqual(await snapshot(candidate), beforeRefusal);

  // Schema conflicts do not protect a switch to a different database. Capture
  // the retained candidate AFTER its commit and failed gate, then restore that
  // fresh archive into another empty database through the existing real helper.
  const { stdout: freshArchive } = await execute(
    "docker",
    ["exec", container, "pg_dump", "-U", "postgres", "-Fc", candidate.name],
    { encoding: "buffer", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const recovered = await restore(freshArchive);
  assert.notEqual(recovered.name, candidate.name);
  const recoveredState = await snapshot(recovered);
  assert.deepEqual(recoveredState.data, beforeRefusal.data);
  assert.deepEqual(recoveredState.revisions, beforeRefusal.revisions);
  assert.deepEqual(recoveredState.history.receipts, beforeRefusal.history.receipts);
  assert.deepEqual(recoveredState.history.sequence, beforeRefusal.history.sequence);
  assert.deepEqual(await checkHistory(recovered), { ok: true, history: "completed" });
  const recoveredWrite = await recovered.app.query(
    `SELECT a.active_revision_id,r.id AS revision_id,e.id AS audit_id
     FROM occ.agents a JOIN occ.agent_revisions r ON r.id=a.active_revision_id
     JOIN occ.audit_events e ON e.resource_id=a.id AND e.details->>'revisionId'=r.id
     WHERE a.id=$1 AND e.id=$2`,
    [agent.id, audit],
  );
  assert.deepEqual(recoveredWrite.rows, committed.rows);

  // The OLD archive also restores successfully into an empty target and passes
  // its own history check, but cannot be selected as lossless recovery: both
  // post-baseline records are absent and its active selection is the old one.
  const stale = await restore(archive);
  assert.notEqual(stale.name, candidate.name);
  assert.notEqual(stale.name, recovered.name);
  assert.deepEqual(
    (await stale.app.query("SELECT id FROM occ.agent_revisions WHERE id=$1", [revision])).rows,
    [],
  );
  assert.deepEqual(
    (await stale.app.query("SELECT id FROM occ.audit_events WHERE id=$1", [audit])).rows,
    [],
  );
  assert.deepEqual(
    (await stale.app.query("SELECT active_revision_id FROM occ.agents WHERE id=$1", [agent.id]))
      .rows,
    [{ active_revision_id: agent.active_revision_id }],
  );
  assert.deepEqual(await checkHistory(stale), {
    ok: true,
    history: "preProvisioningDeploymentOutcome",
  });
  assert.deepEqual(await snapshot(candidate), beforeRefusal);
  context.diagnostic(
    "Populated prefix-51 return: committed revision, selection and audit survive fresh-archive recovery and production history check; old archive restores but lacks the transaction.",
  );
}
