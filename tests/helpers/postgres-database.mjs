import pg from "pg";

// Real PostgreSQL tests run only when OCC_TEST_DATABASE_URL selects a migrated disposable
// database (docs/testing/postgresql.md); otherwise they skip with this reason.
export const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
export const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database (docs/testing/postgresql.md).",
};

// Runs `work(pool)` on a short-lived pool, then closes it. Pool.end() does not wait for its
// connections to close, so this also waits for each client's own end: maintenance commands
// that refuse while another client is connected can run right after it returns.
export async function withPool(url, work, { max = 4 } = {}) {
  const pool = new pg.Pool({ connectionString: url, max });
  const closed = [];
  pool.on("connect", (client) =>
    closed.push(new Promise((resolve) => client.once("end", resolve))),
  );
  try {
    return await work(pool);
  } finally {
    await pool.end();
    await Promise.all(closed);
  }
}
