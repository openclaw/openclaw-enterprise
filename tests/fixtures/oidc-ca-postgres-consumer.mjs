import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";

// The rendered preload must succeed before this entrypoint can execute. No SQL or
// authentication is emulated: the loopback server closes after the TLS handshake.
process.stdout.write("entrypoint\n");
const pool = await createPostgresPool(process.env.OCC_DATABASE_URL, {
  connectionTimeoutMillis: 1500,
});
try {
  await pool.connect();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ code: error.code ?? null })}\n`);
} finally {
  await pool.end();
}
