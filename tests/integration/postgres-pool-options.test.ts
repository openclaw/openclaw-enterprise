import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type pg from "pg";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { createPostgresPool, PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

function conflictingUrl(): string {
  assert.ok(databaseUrl);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-c default_transaction_read_only=off");
  url.searchParams.set("statement_timeout", "60000");
  url.searchParams.set("query_timeout", "60000");
  url.searchParams.set("connectionTimeoutMillis", "60000");
  url.searchParams.set("application_name", "pool-options-regression");
  return url.toString();
}

const metricsOptions = {
  authMode: "password",
  max: 1,
  connectionTimeoutMillis: 500,
  statement_timeout: 1500,
  query_timeout: 1500,
  options: "-c default_transaction_read_only=on",
} as const;

// The normal PostgreSQL lane gives this file its own migrated database. The
// noncredential Installation remains until the lane removes that database.
async function withInstallation(work: (ordinary: pg.Pool) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const ordinary = await createPostgresPool(databaseUrl, { authMode: "password", max: 1 });
  try {
    await ordinary.query(
      "INSERT INTO occ.installation (id, name, created_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING",
      [`ins_${randomUUID()}`, "Pool option regression"],
    );
    await work(ordinary);
  } finally {
    await ordinary.end();
  }
}

test(
  "worker metrics pool rejects writes despite conflicting URL options",
  requiresPostgres,
  async () => {
    assert.ok(databaseUrl);
    const ordinary = await createPostgresPool(databaseUrl, { authMode: "password", max: 1 });
    const metrics = await createPostgresPool(conflictingUrl(), metricsOptions);
    const write = "INSERT INTO occ.namespaces (id, name, created_at) VALUES ($1, $2, now())";
    try {
      const writer = await ordinary.connect();
      try {
        await writer.query("BEGIN");
        assert.equal(
          (await writer.query(write, [`ns_${randomUUID()}`, `Pool options ${randomUUID()}`]))
            .rowCount,
          1,
        );
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
      const reader = await metrics.connect();
      try {
        await reader.query("BEGIN");
        await assert.rejects(
          reader.query(write, [`ns_${randomUUID()}`, `Pool options ${randomUUID()}`]),
          { code: "25006" },
        );
      } finally {
        await reader.query("ROLLBACK");
        reader.release();
      }
      assert.equal(
        (await metrics.query("SHOW default_transaction_read_only")).rows[0]
          .default_transaction_read_only,
        "on",
      );
    } finally {
      await metrics.end();
      await ordinary.end();
    }
  },
);

test(
  "explicit PostgreSQL statement deadline overrides the database URL",
  requiresPostgres,
  async () => {
    const pool = await createPostgresPool(conflictingUrl(), {
      authMode: "password",
      max: 1,
      statement_timeout: 250,
      query_timeout: 3000,
    });
    try {
      const started = performance.now();
      await assert.rejects(pool.query("SELECT pg_sleep(2)"), { code: "57014" });
      assert.ok(
        performance.now() - started < 1800,
        "the server must cancel before the sleep finishes",
      );
      assert.equal((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout, "250ms");
    } finally {
      await pool.end();
    }
  },
);

test(
  "explicit PostgreSQL query deadline overrides the database URL",
  requiresPostgres,
  async () => {
    const pool = await createPostgresPool(conflictingUrl(), {
      authMode: "password",
      max: 1,
      statement_timeout: 3000,
      query_timeout: 250,
    });
    try {
      const started = performance.now();
      await assert.rejects(pool.query("SELECT pg_sleep(2)"), /Query read timeout/);
      assert.ok(
        performance.now() - started < 1800,
        "the client must stop waiting before the sleep finishes",
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "worker metrics collection preserves caller limits and unspecified URL settings",
  requiresPostgres,
  async () => {
    await withInstallation(async (ordinary) => {
      const metrics = await createPostgresPool(conflictingUrl(), metricsOptions);
      const unspecified = await createPostgresPool(conflictingUrl(), {
        authMode: "password",
        max: 1,
        connectionTimeoutMillis: 500,
        statement_timeout: undefined,
        query_timeout: undefined,
        options: undefined,
      });
      try {
        assert.equal(
          (await metrics.query("SHOW statement_timeout")).rows[0].statement_timeout,
          "1500ms",
        );
        assert.equal(
          (await metrics.query("SHOW application_name")).rows[0].application_name,
          "pool-options-regression",
        );
        assert.equal(
          (await unspecified.query("SHOW statement_timeout")).rows[0].statement_timeout,
          "1min",
        );
        assert.equal(
          (await unspecified.query("SHOW default_transaction_read_only")).rows[0]
            .default_transaction_read_only,
          "off",
        );
        const snapshot = new PostgresMetricsSnapshot(metrics);
        assert.deepEqual(
          await snapshot.collect(),
          await new PostgresMetricsSnapshot(ordinary).collect(),
        );
        const exposition = await createOccMetrics("worker", () => snapshot.collect()).exposition();
        assert.match(exposition, /occ_agents\{/);
        assert.match(exposition, /occ_work_pending/);
      } finally {
        await unspecified.end();
        await metrics.end();
      }
    });
  },
);
