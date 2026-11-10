import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import pg from "pg";
import { parse, parseIntoClientConfig } from "pg-connection-string";

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
    return new pg.Pool(verifyIpHostIdentity({ connectionString: databaseUrl, ...limits }));
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
  return new pg.Pool(
    verifyIpHostIdentity({
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
    }),
  );
}

/**
 * pg sends a TLS servername only for DNS hosts. For an IP literal it sends none,
 * and Node then checks the certificate against "localhost": any database-CA-signed
 * DNS:localhost certificate would pass verify-full for every IP host. Bind the
 * identity check to the effective IP instead, so an iPAddress SAN must match, as
 * libpq requires. DNS hosts, Unix sockets, plaintext and explicitly unverified
 * modes keep pg's configuration unchanged.
 */
function verifyIpHostIdentity(config: pg.PoolConfig): pg.PoolConfig {
  let address: string | undefined;
  try {
    address = verifiedIpAddress(config);
    if (address === undefined) {
      return config;
    }
  } catch {
    // An unreadable sslrootcert or similar: pg raises the same error on connect.
    // Decide per connection instead, so a file that appears later is still checked.
  }
  if (address !== undefined) {
    // Refuse at construction what every connection would refuse.
    bindIpIdentity(config, address);
  }
  // pg-pool builds every connection through this class. Deciding per connection
  // keeps pg's per-connection reads of sslrootcert/sslcert/sslkey files.
  class IpHostClient extends pg.Client {
    constructor(clientConfig: pg.ClientConfig = config) {
      const address = verifiedIpAddress(clientConfig);
      super(address === undefined ? clientConfig : bindIpIdentity(clientConfig, address));
    }
  }
  return { ...config, Client: IpHostClient };
}

/** The effective host when pg would verify an IP literal against "localhost". */
function verifiedIpAddress(config: pg.ClientConfig): string | undefined {
  const { host, ssl } = resolvedParameters(config);
  const address = typeof host === "string" ? host.replace(/^\[(.*)\]$/, "$1") : "";
  if (!ssl || isIP(address) === 0) {
    return undefined;
  }
  if (ssl !== true && (ssl.rejectUnauthorized === false || ssl.checkServerIdentity !== undefined)) {
    // no-verify, or libpq-compatible require/verify-ca, which skip the identity check.
    return undefined;
  }
  return address;
}

function bindIpIdentity(config: pg.ClientConfig, address: string): pg.ClientConfig {
  let base = config;
  if (config.connectionString !== undefined) {
    // pg reparses connectionString over explicit fields, which would drop the
    // check below. Inline the URL with the same parser and precedence instead.
    const { connectionString, ...explicit } = config;
    const parsed = parse(connectionString) as unknown as pg.ClientConfig;
    if (parsed.connectionString !== undefined) {
      throw new Error("A PostgreSQL URL with an IP host does not allow nested connection strings.");
    }
    base = { ...explicit, ...parsed };
  }
  const { ssl } = resolvedParameters(base);
  if (!ssl) {
    return base;
  }
  const options = ssl === true ? {} : ssl;
  const verified: Exclude<pg.ClientConfig["ssl"], boolean | undefined> = { ...options };
  // pg hides a client key from enumeration; carry it over explicitly.
  if ("key" in options) {
    verified.key = options.key;
  }
  verified.checkServerIdentity = (_servername: string, certificate: PeerCertificate) =>
    checkServerIdentity(address, certificate);
  return { ...base, ssl: verified };
}

/** pg's own resolution: URL, host= override, PGHOST/PGSSLMODE and defaults. */
function resolvedParameters(config: pg.ClientConfig): {
  host?: unknown;
  ssl?: pg.ClientConfig["ssl"];
} {
  // Construction parses and reads TLS files but does not connect.
  return (
    new pg.Client(config) as unknown as {
      connectionParameters: { host?: unknown; ssl?: pg.ClientConfig["ssl"] };
    }
  ).connectionParameters;
}
