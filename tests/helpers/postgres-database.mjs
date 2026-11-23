import pg from "pg";

// Real PostgreSQL tests run only when OCC_TEST_DATABASE_URL selects a migrated disposable
// database (docs/testing/postgresql.md); otherwise they skip with this reason.
export const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
export const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database (docs/testing/postgresql.md).",
};

// Pool.end() resolves once its idle clients are removed, before their sessions close. This
// ends `pool` and then waits for each client's own end, so the server holds none of its sessions
// when it returns: maintenance commands that refuse while another client is connected can run
// right after, and a database drop cannot end a session still closing, whose 57P01 would reach
// the pool with no error listener and fail the test in its teardown (finding 2379).
//
// Pool.end() also waits for every checked-out client, and after hooks run in the order they were
// registered: a client released in a hook registered after the pool's would never be returned.
// The close is bounded so that such a leak fails the test with this message, not at the lane
// deadline.
const closeTimeoutMs = 30_000;
function closer(pool) {
  const clients = [];
  const closed = [];
  pool.on("connect", (client) => {
    clients.push(client);
    closed.push(new Promise((resolve) => client.once("end", resolve)));
  });
  return async () => {
    let timer;
    const stuck = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const held = pool.totalCount - pool.idleCount;
        // End the leaked sessions too, so that the test process can still exit.
        for (const client of clients) {
          client.end().catch(() => {});
        }
        reject(
          new Error(
            `the test pool did not close within ${closeTimeoutMs} ms; ${held} client(s) were still checked out`,
          ),
        );
      }, closeTimeoutMs);
    });
    try {
      await Promise.race([pool.end().then(() => Promise.all(closed)), stuck]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Runs work on a short-lived pool, then closes it (see closer).
 * @template T
 * @param {string | undefined} url
 * @param {(pool: import("pg").Pool) => Promise<T>} work
 * @param {{max?: number}} [options]
 * @returns {Promise<T>}
 */
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
// with `after`) closes it in an after hook registered now (see `closer`), so release the
// pool's clients in the test itself.
export function testPool(context, config) {
  const pool = new pg.Pool(config);
  context.after(closer(pool));
  return pool;
}
