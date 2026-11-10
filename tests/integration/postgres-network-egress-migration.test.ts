import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { Client } from "pg";
import {
  assertCompletedHistory,
  assertUpgradedRevisionReadable,
  canonicalData,
  seedCanonicalData,
} from "../helpers/postgres-migration-data.mjs";
import {
  historyDatabase,
  historyReceipts,
  installCanonicalPrefix,
  migrationHistoryFixtureFor,
  requiresHistoryPostgres,
  runHistoryMigration,
} from "../helpers/postgres-migration-history.mjs";

const migrationHistoryFixture = migrationHistoryFixtureFor(after);

const histories = [
  { name: "legacy saved Harness", prefix: 71, harnessSettings: false },
  { name: "current saved Harness", prefix: 76, harnessSettings: true },
] as const;

interface StoredRevision {
  id: string;
  admitted_spec: Record<string, unknown> & {
    harness: Record<string, unknown>;
  };
}

interface RevisionWriteCase {
  readonly mode: string;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly constraint?: "agent_revisions_network_egress_mode" | "agent_revisions_admitted_snapshot";
}

async function assertRevisionWrites(app: Client, { id, admitted_spec }: StoredRevision) {
  const { configuration: _configuration, ...harnessWithoutConfiguration } = admitted_spec.harness;
  const current = {
    ...admitted_spec,
    harness: { ...harnessWithoutConfiguration, overrides: {}, configuration: {} },
  };

  // An older writer can still insert a current snapshot without a mode.
  const legacy = await app.query<{ network_egress_mode: null }>(
    `INSERT INTO occ.agent_revisions
       (id, namespace_id, agent_id, revision_number, admitted_spec, backend_id, admitted_at)
     SELECT $1, namespace_id, agent_id, 2, $2::jsonb, backend_id, now()
     FROM occ.agent_revisions WHERE id = $3
     RETURNING network_egress_mode`,
    [`rev_${randomUUID()}`, current, id],
  );
  assert.deepEqual(legacy.rows, [{ network_egress_mode: null }]);

  // The mode column has its own constraint. Saved Harness and snapshot shape
  // checks continue to apply independently of the mode.
  const cases: readonly RevisionWriteCase[] = [
    { mode: "public", spec: current },
    { mode: "restricted", spec: current },
    { mode: "unknown", spec: current, constraint: "agent_revisions_network_egress_mode" },
    {
      mode: "public",
      spec: { ...current, harness: { ...harnessWithoutConfiguration, overrides: {} } },
      constraint: "agent_revisions_admitted_snapshot",
    },
    {
      mode: "public",
      spec: { ...current, network_egress_mode: "restricted" },
      constraint: "agent_revisions_admitted_snapshot",
    },
  ];
  for (const [index, { mode, spec, constraint }] of cases.entries()) {
    const inserted = app.query<{ network_egress_mode: string }>(
      `INSERT INTO occ.agent_revisions
         (id, namespace_id, agent_id, revision_number, admitted_spec, backend_id,
          admitted_at, network_egress_mode)
       SELECT $1, namespace_id, agent_id, $2, $3::jsonb, backend_id, now(), $4
       FROM occ.agent_revisions WHERE id = $5
       RETURNING network_egress_mode`,
      [`rev_${randomUUID()}`, index + 3, spec, mode, id],
    );
    if (constraint === undefined) {
      assert.deepEqual((await inserted).rows, [{ network_egress_mode: mode }]);
    } else {
      await assert.rejects(inserted, { code: "23514", constraint });
    }
  }
}

test(
  "Canonical network egress migration preserves admitted revisions",
  requiresHistoryPostgres,
  async (context) => {
    const fixture = await migrationHistoryFixture();
    for (const { name, prefix, harnessSettings } of histories) {
      await context.test(name, async (child) => {
        const db = await historyDatabase(child, fixture, "network_egress", { prefix });
        await seedCanonicalData(db, {
          preset: true,
          computeAdmission: true,
          executionAdmission: true,
          harnessSettings,
        });
        // Migration 0072 enforced Harness settings on new writes. Keep one row
        // admitted before that constraint to exercise preservation of archived data.
        if (!harnessSettings) {
          await installCanonicalPrefix(db, 76);
        }
        const before = await canonicalData(db);
        const snapshots = await db.app.query<StoredRevision>(
          "SELECT id, admitted_spec FROM occ.agent_revisions ORDER BY id",
        );
        assert.equal(snapshots.rows.length, 1);
        const [snapshot] = snapshots.rows;
        assert.ok(snapshot);
        assert.equal(Object.hasOwn(snapshot.admitted_spec, "network_egress_mode"), false);
        const receipts = await historyReceipts(db.migrator);

        for (const flag of ["--check", undefined] as const) {
          assert.deepEqual(await runHistoryMigration(db, "production", flag), {
            ok: true,
            history: "preNetworkEgressMode",
          });
        }
        await assertCompletedHistory(db, receipts);
        await assertUpgradedRevisionReadable(db);
        assert.deepEqual(await canonicalData(db), before);
        assert.deepEqual(
          (
            await db.app.query(
              "SELECT id, admitted_spec, network_egress_mode FROM occ.agent_revisions ORDER BY id",
            )
          ).rows,
          [{ ...snapshot, network_egress_mode: null }],
        );
        assert.deepEqual(
          (
            await db.migrator.query(
              `SELECT conname, convalidated FROM pg_catalog.pg_constraint
             WHERE conrelid = 'occ.agent_revisions'::regclass
               AND conname IN ('agent_revisions_admitted_snapshot', 'agent_revisions_network_egress_mode')
             ORDER BY conname`,
            )
          ).rows,
          [
            { conname: "agent_revisions_admitted_snapshot", convalidated: false },
            { conname: "agent_revisions_network_egress_mode", convalidated: true },
          ],
        );
        await assertRevisionWrites(db.app, snapshot);
        // The existing immutability trigger also guards the dedicated column.
        await assert.rejects(
          db.migrator.query(
            "UPDATE occ.agent_revisions SET network_egress_mode = 'restricted' WHERE network_egress_mode = 'public'",
          ),
          { code: "55000" },
        );
      });
    }
  },
);
