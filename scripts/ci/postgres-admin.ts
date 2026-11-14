// Administrative SQL on a lane's PostgreSQL server (scripts/ci/prepare.mjs and cleanup.mjs):
// creating, copying and dropping databases and the server's settings. It connects straight
// to the port the server publishes on 127.0.0.1, as the superuser compose.postgres.yaml
// creates. Each test's database copy and drop used to run `docker compose exec -T postgres
// psql`: two CLI processes, a Docker API exec and a psql start, about 0.2-0.4 s per call
// and around 1000 calls per postgres-application run.

// compose.postgres.yaml's POSTGRES_USER and POSTGRES_PASSWORD. The server publishes only on
// 127.0.0.1 and cleanup removes it with its volume.
export const postgresSuperuser = "postgres";
export const postgresSuperuserPassword = "openclaw-local-admin";

// The fixture tests' fake servers (tests/helpers/ci-prepare-fixture-command.ts) listen on a
// Unix socket in this directory (".s.PGSQL.<port>") instead: their fake `compose up` cannot
// claim the TCP port preparation reserved once another process's connection holds it.
function adminHost() {
  return process.env.OPENCLAW_CI_POSTGRES_SOCKET_DIR || "127.0.0.1";
}

type PostgresAdminOptions = {
  port: unknown;
  database?: string;
  statements: string[];
  timeoutMs?: number;
};

type AdminFailure = "connect" | "query" | "timeout";
type AdminErrorProperties = { cause?: unknown; timedOut?: boolean; sqlState?: string | undefined };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

// Runs each statement as its own request on one connection to `database`, in order, and
// stops at the first error, as `psql -v ON_ERROR_STOP=1 -c ... -c ...` did: CREATE DATABASE
// refuses a transaction block, and a statement string holding several statements runs as
// one implicit transaction. Past `timeoutMs` (none when omitted) the connection is
// destroyed and the call fails with `timedOut: true`; a statement the server already
// received may still complete there.
//
// Errors carry `failure`: "connect" (no session), "query" (the server refused a statement),
// or "timeout". Messages name the statement, never the password.
export async function runPostgresAdmin({
  port,
  database = "postgres",
  statements,
  timeoutMs,
}: PostgresAdminOptions): Promise<void> {
  if (!Number.isSafeInteger(Number(port)) || Number(port) <= 0) {
    throw new Error(`Invalid lane PostgreSQL port: ${port}`);
  }
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new Error("runPostgresAdmin needs at least one statement.");
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    host: adminHost(),
    port: Number(port),
    user: postgresSuperuser,
    password: postgresSuperuserPassword,
    database,
    application_name: "openclaw-ci-admin",
  });
  // A dropped connection must not crash the process; the pending call reports it.
  client.on("error", () => {});
  const where = `PostgreSQL ${adminHost()}:${Number(port)}/${database}`;
  let current = "connect";
  let timer: NodeJS.Timeout | undefined;
  const deadline =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              adminError(`${where}: ${current} timed out after ${timeoutMs} ms`, "timeout", {
                timedOut: true,
              }),
            );
            client.connection?.stream?.destroy();
          }, timeoutMs);
        })
      : undefined;
  const work = (async () => {
    try {
      await client.connect();
    } catch (error) {
      throw adminError(`${where}: connect failed: ${errorMessage(error)}`, "connect", {
        cause: error,
      });
    }
    for (const statement of statements) {
      current = statement;
      try {
        await client.query(statement);
      } catch (error) {
        throw adminError(`${where}: ${statement} failed: ${errorMessage(error)}`, "query", {
          cause: error,
          sqlState: errorCode(error),
        });
      }
    }
    // Inside the deadline too, so a server that never closes the session cannot hold the
    // caller. Every statement has succeeded by now; a failed close changes nothing.
    current = "closing the session";
    await client.end().catch(() => {});
  })();
  // A late rejection of abandoned work is already reported as the timeout.
  work.catch(() => {});
  try {
    await (deadline ? Promise.race([work, deadline]) : work);
  } catch (error) {
    // A failed or abandoned session is closed at once, never waited for.
    client.connection?.stream?.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function adminError(
  message: string,
  failure: AdminFailure,
  { cause, ...properties }: AdminErrorProperties = {},
) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  return Object.assign(error, { failure, timedOut: false }, properties);
}
