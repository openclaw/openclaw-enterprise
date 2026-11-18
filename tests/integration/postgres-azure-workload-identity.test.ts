import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";

const databaseUrl = process.env.OCC_TEST_AZURE_DATABASE_URL;

test(
  "Azure workload identity opens successive real PostgreSQL TLS connections",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_AZURE_DATABASE_URL and a real projected Azure workload identity; configuration tests do not prove authentication or renewal.",
  },
  async () => {
    assert.ok(databaseUrl);
    const pool = await createPostgresPool(databaseUrl, {
      authMode: "azure-workload-identity",
      max: 1,
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const client = await pool.connect();
        try {
          const { rows } = await client.query<{ username: unknown; ssl: unknown }, []>(
            "SELECT current_user AS username, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
          );
          assert.equal(rows.length, 1);
          const row = rows[0];
          assert.ok(row);
          assert.ok(typeof row.username === "string" && row.username.length > 0);
          assert.equal(row.ssl, true);
        } finally {
          // Discard the socket so the next iteration must authenticate again.
          client.release(true);
        }
      }
    } finally {
      await pool.end();
    }
  },
);
