import pg from "pg";
import { parseIntoClientConfig } from "pg-connection-string";

/** Shared connection authentication for the API, worker, bootstrap, and migrator. */
export async function createPostgresPool(
  databaseUrl: string,
  options: PostgresPoolOptions = {},
): Promise<pg.Pool> {
  const pool = await constructPostgresPool(databaseUrl, options);
  // pg-pool re-emits an idle client's error (failover, pg_terminate_backend,
  // idle_session_timeout, a proxy reset) on the Pool and discards the client.
  // Without a listener EventEmitter throws it and the process exits. Log only
  // the code: messages can carry hosts or other connection details.
  pool.on("error", (error: Error & { code?: unknown }) => {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        event: "database.idle-client-error",
        code: typeof error.code === "string" ? error.code : undefined,
      })}\n`,
    );
  });
  return pool;
}

type PostgresPoolOptions = Pick<
  pg.PoolConfig,
  | "max"
  | "connectionTimeoutMillis"
  | "statement_timeout"
  | "query_timeout"
  | "options"
  | "keepAlive"
  | "keepAliveInitialDelayMillis"
> & { readonly authMode?: string };

async function constructPostgresPool(
  databaseUrl: string,
  { authMode = process.env.OCC_DATABASE_AUTH ?? "password", ...limits }: PostgresPoolOptions,
): Promise<pg.Pool> {
  if (authMode === "password") {
    return new pg.Pool({ connectionString: databaseUrl, ...limits });
  }
  if (authMode !== "azure-workload-identity") {
    throw new Error("Unsupported OCC_DATABASE_AUTH mode.");
  }

  // Passing connectionString alongside password would let pg's URL parser
  // replace the token callback with an empty password. Parse before overriding.
  const connection = parseIntoClientConfig(databaseUrl);
  if (connection.connectionString !== undefined) {
    throw new Error("Azure workload identity does not allow nested connection strings.");
  }
  if (connection.password) {
    throw new Error("Azure workload identity requires a password-free database URL.");
  }
  if (
    !connection.ssl ||
    (typeof connection.ssl === "object" &&
      (connection.ssl.rejectUnauthorized === false ||
        connection.ssl.checkServerIdentity !== undefined))
  ) {
    // libpq-compatible modes may trust a CA without checking the hostname.
    throw new Error(
      "Azure workload identity requires certificate- and hostname-verified PostgreSQL TLS.",
    );
  }

  const { WorkloadIdentityCredential } = await import("@azure/identity");
  const credential = new WorkloadIdentityCredential();
  return new pg.Pool({
    ...connection,
    ...limits,
    ssl: {
      ...(typeof connection.ssl === "object" ? connection.ssl : {}),
      rejectUnauthorized: true,
    },
    // pg calls this for each new connection; the SDK owns token caching and
    // renewal. Never fall back to an operator identity or a fixed access token.
    password: async () =>
      (await credential.getToken("https://ossrdbms-aad.database.windows.net/.default")).token,
  });
}
