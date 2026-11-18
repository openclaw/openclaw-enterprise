import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";

function requireDatabaseUrl(value: string | undefined): string {
  const url = value === undefined ? undefined : URL.parse(value);
  if (
    value === undefined ||
    !url?.hostname ||
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
  ) {
    throw new Error("OIDC CA fixture requires a PostgreSQL URL");
  }
  return value;
}

// The rendered preload must succeed before this entrypoint can execute. The
// loopback server closes after reading the TLS-protected PostgreSQL startup bytes.
process.stdout.write("entrypoint\n");
const pool = await createPostgresPool(requireDatabaseUrl(process.env.OCC_DATABASE_URL), {
  connectionTimeoutMillis: 1500,
});
try {
  const client = await pool.connect();
  client.release();
} catch (error) {
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  process.stdout.write(`${JSON.stringify({ code })}\n`);
} finally {
  await pool.end();
}
