import pg from "pg";

// Real PostgreSQL tests run only when OCC_TEST_DATABASE_URL selects a migrated disposable
// database (docs/testing/postgresql.md); otherwise they skip with this reason.
export const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
export const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database (docs/testing/postgresql.md).",
};

// CI exports the selected application URL, not a migration URL. The disposable local
// fixtures use these provisioned roles; preserve the selected host, dynamic port and database.
export function localMigratorDatabaseUrl(applicationUrl) {
  const selected = new URL(applicationUrl);
  if (
    !["postgres:", "postgresql:"].includes(selected.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(selected.hostname) ||
    selected.username !== "occ_app" ||
    selected.password !== "occ-app-local"
  ) {
    throw new Error("The migrator fixture requires the selected local occ_app database URL.");
  }
  selected.username = "occ_migrator";
  selected.password = "occ-migrator-local";
  return selected.toString();
}

// Pool.end() resolves once its idle clients are removed, before their sessions close. This
// ends `pool` and then waits for each client's own end, so the server holds none of its sessions
// when it returns: maintenance commands that refuse while another client is connected can run
// right after, and a database drop cannot end a session still closing, whose 57P01 would reach
// the pool with no error listener and fail the test in its teardown (finding 2379).
function closer(pool) {
  const closed = [];
  pool.on("connect", (client) =>
    closed.push(new Promise((resolve) => client.once("end", resolve))),
  );
  return async () => {
    await pool.end();
    await Promise.all(closed);
  };
}

// Runs `work(pool)` on a short-lived pool, then closes it (see `closer`).
export async function withPool(url, work, { max = 4 } = {}) {
  const pool = new pg.Pool({ connectionString: url, max });
  const close = closer(pool);
  try {
    return await work(pool);
  } finally {
    await close();
  }
}

// A pg.Pool with `config` for the rest of the test: `context` (a test context, or anything
// with `after`) closes it in an after hook registered now (see `closer`).
export function testPool(context, config) {
  const pool = new pg.Pool(config);
  context.after(closer(pool));
  return pool;
}
