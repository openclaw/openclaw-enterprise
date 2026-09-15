import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";

test(
  "Azure workload identity opens successive real PostgreSQL TLS connections",
  {
    skip: process.env.OCC_TEST_AZURE_DATABASE_URL
      ? false
      : "Set OCC_TEST_AZURE_DATABASE_URL and a real projected Azure workload identity; configuration tests do not prove authentication or renewal.",
  },
  async () => {
    const pool = await createPostgresPool(process.env.OCC_TEST_AZURE_DATABASE_URL, {
      authMode: "azure-workload-identity",
      max: 1,
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const client = await pool.connect();
        try {
          const { rows } = await client.query(
            "SELECT current_user AS username, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
          );
          assert.equal(rows.length, 1);
          assert.ok(rows[0].username);
          assert.equal(rows[0].ssl, true);
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
