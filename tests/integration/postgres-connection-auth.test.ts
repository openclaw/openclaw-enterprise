import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createServer as createTlsServer,
  rootCertificates,
  type SecureContextOptions,
} from "node:tls";
import { promisify } from "node:util";
import pg from "pg";
import { startupDependencyFailure } from "../../apps/controller/src/startup-failure.ts";
import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { certificateAuthority, signedLeaf } from "../helpers/certificates.mjs";
import { setEnvironment, withEnvironment } from "../helpers/environment.ts";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

const { Client } = pg;
const execute = promisify(execFile);

function passwordUrl(password: string, host = "localhost", search = ""): string {
  return syntheticCredentialUrl({
    protocol: "postgresql",
    username: "occ_app",
    password,
    host,
    port: undefined,
    pathname: "/occ",
    search,
  });
}

function clientParameters(client: pg.Client): { application_name?: unknown; host?: unknown } {
  assert.ok("connectionParameters" in client);
  const parameters = client.connectionParameters;
  assert.ok(typeof parameters === "object" && parameters !== null);
  return parameters;
}

function configuredClient(options: pg.Pool["options"]): pg.Client {
  const PoolClient: (new (options: pg.PoolConfig) => pg.ClientBase) | undefined = options.Client;
  assert.ok(typeof PoolClient === "function");
  const client = new PoolClient(options);
  assert.ok(client instanceof Client);
  return client;
}

function rootCertificate(): string {
  const [certificate] = rootCertificates;
  assert.ok(certificate !== undefined);
  return certificate;
}

function captureStderr() {
  const writes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    writes.push(String(chunk));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  };
  return {
    writes,
    restore: () => {
      process.stderr.write = write;
    },
  };
}

test("password authentication preserves the existing pg connection configuration", async () => {
  const pool = await createPostgresPool(passwordUrl("test-only"), {
    authMode: "password",
    max: 3,
  });
  try {
    const client = new Client(pool.options);
    assert.equal(client.user, "occ_app");
    assert.equal(client.password, "test-only");
    assert.equal(pool.options.max, 3);
  } finally {
    await pool.end();
  }
});

test(
  "the password pool authenticates to the selected real PostgreSQL database",
  {
    skip: process.env.OCC_TEST_DATABASE_URL
      ? false
      : "Set OCC_TEST_DATABASE_URL for real application-role password authentication.",
  },
  async () => {
    const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
    assert.ok(databaseUrl);
    const url = new URL(databaseUrl);
    const pool = await createPostgresPool(url.toString(), { authMode: "password", max: 1 });
    try {
      // Exercise the shared connection factory against PostgreSQL, not only
      // pg's constructor. Database selection must survive the factory refactor.
      const { rows } = await pool.query<{ username: unknown; database: unknown }, []>(
        "SELECT current_user AS username, current_database() AS database",
      );
      assert.deepEqual(rows, [
        {
          username: decodeURIComponent(url.username),
          database: decodeURIComponent(url.pathname.slice(1)),
        },
      ]);
    } finally {
      await pool.end();
    }
  },
);

test("the real pg client retains the Azure token callback and verified TLS after URL parsing", async (context) => {
  // Construction does not acquire a token. These are SDK configuration inputs,
  // not working credentials or evidence of live Azure authentication.
  const environment = {
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000001",
    AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000002",
    AZURE_FEDERATED_TOKEN_FILE: "/unused-in-construction-test",
  };
  setEnvironment(context, environment);
  let pool: pg.Pool | undefined;
  try {
    pool = await createPostgresPool(
      "postgresql://occ_app@localhost/occ?sslmode=verify-full&application_name=occ-worker",
      { authMode: "azure-workload-identity", max: 2 },
    );
    const client = new Client(pool.options);
    assert.equal(client.user, "occ_app");
    assert.equal(client.database, "occ");
    assert.equal(typeof client.password, "function");
    assert.equal(clientParameters(client).application_name, "occ-worker");
    const ssl: unknown = client.ssl;
    assert.notEqual(ssl, false);
    assert.ok(typeof ssl === "object" && ssl !== null && "rejectUnauthorized" in ssl);
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(pool.options.max, 2);

    // pg reparses this reserved option after the factory's checks, which would
    // overwrite both the token callback and verified TLS configuration.
    const nested = new URL("postgresql://occ_app@localhost/occ?sslmode=verify-full");
    nested.searchParams.set(
      "connectionString",
      passwordUrl("fixed-password", "localhost", "?sslmode=disable"),
    );
    await assert.rejects(
      createPostgresPool(nested.toString(), { authMode: "azure-workload-identity" }),
      /nested connection strings/,
    );

    // libpq-compatible require/verify-ca can trust a CA while disabling hostname
    // checks. Reject those parsed options before acquiring a bearer token.
    const directory = await temporaryDirectory(context, "occ-postgres-ca-");
    const certificate = join(directory, "root.crt");
    await writeFile(certificate, rootCertificate());
    for (const sslmode of ["require", "verify-ca"]) {
      const url = new URL("postgresql://occ_app@localhost/occ");
      url.searchParams.set("sslmode", sslmode);
      url.searchParams.set("uselibpqcompat", "true");
      url.searchParams.set("sslrootcert", certificate);
      await assert.rejects(
        createPostgresPool(url.toString(), { authMode: "azure-workload-identity" }),
        /verified PostgreSQL TLS/,
      );
    }
  } finally {
    if (pool) {
      await pool.end();
    }
  }
});

test("workload authentication rejects password fallback and unverified TLS", async () => {
  await assert.rejects(
    createPostgresPool(passwordUrl("fixed-password", "localhost", "?sslmode=verify-full"), {
      authMode: "azure-workload-identity",
    }),
    /password-free database URL/,
  );
  for (const url of [
    "postgresql://occ_app@localhost/occ",
    "postgresql://occ_app@localhost/occ?sslmode=no-verify",
    "postgresql://occ_app@localhost/occ?sslmode=disable",
    "postgresql://occ_app@localhost/occ?sslmode=require&uselibpqcompat=true",
  ]) {
    await assert.rejects(
      createPostgresPool(url, { authMode: "azure-workload-identity" }),
      /verified PostgreSQL TLS/,
    );
  }
  await assert.rejects(
    createPostgresPool("postgresql://localhost/occ", { authMode: "unsupported" }),
    /Unsupported OCC_DATABASE_AUTH/,
  );
});

test("an idle pooled client error is logged instead of crashing the process", async () => {
  const pool = await createPostgresPool(passwordUrl("test-only"), {
    authMode: "password",
  });
  const stderr = captureStderr();
  try {
    // pg-pool re-emits an idle client's socket error on the Pool. Without a
    // listener, EventEmitter throws it and Node exits.
    const error = Object.assign(new Error("terminating connection host=db.internal"), {
      code: "57P01",
    });
    assert.doesNotThrow(() => pool.emit("error", error));
  } finally {
    stderr.restore();
    await pool.end();
  }
  const records = stderr.writes.map((line): unknown => JSON.parse(line));
  assert.deepEqual(records, [
    { level: "warn", event: "database.idle-client-error", code: "57P01" },
  ]);
});

test(
  "the pool survives PostgreSQL terminating an idle backend",
  {
    skip: process.env.OCC_TEST_DATABASE_URL
      ? false
      : "Set OCC_TEST_DATABASE_URL to terminate a real idle PostgreSQL backend.",
  },
  async () => {
    const url = process.env.OCC_TEST_DATABASE_URL;
    assert.ok(url);
    const pool = await createPostgresPool(url, { authMode: "password", max: 1 });
    const killer = new Client({ connectionString: url });
    const stderr = captureStderr();
    try {
      const {
        rows: [backend],
      } = await pool.query<{ pid: unknown }, []>("SELECT pg_backend_pid() AS pid");
      const pid = backend?.pid;
      assert.ok(typeof pid === "number");
      assert.equal(pool.idleCount, 1);
      await killer.connect();
      const { rows } = await killer.query<{ ok: unknown }, [number]>(
        "SELECT pg_terminate_backend($1) AS ok",
        [pid],
      );
      assert.equal(rows[0]?.ok, true);
      // pg-pool discards the broken idle client after emitting its error.
      await waitUntil("the terminated idle client to be discarded", () => pool.idleCount === 0, {
        timeoutMs: 5000,
      });
      const next = await pool.query<{ pid: unknown }, []>("SELECT pg_backend_pid() AS pid");
      const nextPid = next.rows[0]?.pid;
      assert.ok(typeof nextPid === "number");
      assert.notEqual(nextPid, pid);
    } finally {
      stderr.restore();
      await killer.end();
      await pool.end();
    }
    assert.ok(
      stderr.writes.some((line) => {
        const record: unknown = JSON.parse(line);
        return (
          typeof record === "object" &&
          record !== null &&
          "code" in record &&
          record.code === "57P01"
        );
      }),
    );
  },
);

test("verify-full checks the server certificate against an IP database host", async (context) => {
  const directory = await temporaryDirectory(context, "occ-postgres-ip-tls-");
  const pki = await databaseCertificates(directory);
  const caPath = join(directory, "ca.pem");
  const v4 = await tlsServer(context, "127.0.0.1", pki.dnsLocalhost);
  const v6 = await tlsServer(context, "::1", pki.dnsLocalhost).catch(() => undefined);
  const verified = `sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`;
  // Direct negotiation starts TLS on connect; the server closes after the handshake,
  // so no SQL, authentication or token is involved.
  const url = (host: string, port: number, search = verified) =>
    `postgresql://occ_app@${host}:${port}/occ?sslnegotiation=direct&${search}`;
  const handshake = async (
    server: Awaited<ReturnType<typeof tlsServer>>,
    connectionUrl: string,
    authMode = "password",
  ) => {
    const before = server.accepted;
    const pool = await createPostgresPool(connectionUrl, {
      authMode,
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    try {
      const client = await pool.connect();
      client.release(true);
      return { code: "CONNECTED", accepted: server.accepted - before };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      return { code: code ?? null, accepted: server.accepted - before };
    } finally {
      await pool.end();
    }
  };
  const refused = { code: "ERR_TLS_CERT_ALTNAME_INVALID", accepted: 0 };

  // pg sends no servername for an IP host, so Node used to check "localhost":
  // a database-CA-signed DNS:localhost leaf passed verify-full for any IP.
  assert.deepEqual(await handshake(v4, url("127.0.0.1", v4.port)), refused);
  // API and worker startup name the refusal, without the address or the certificate.
  const statePool = await createPostgresPool(url("127.0.0.1", v4.port), { max: 1 });
  const startupError: unknown = await new PostgresPlatformState(statePool)
    .loadInstallation()
    .then(
      () => assert.fail("loadInstallation must fail"),
      (error: unknown) => error,
    )
    .finally(() => statePool.end());
  const startupFields = startupDependencyFailure(startupError);
  assert.deepEqual(startupFields, {
    code: "DATABASE_TLS_CERTIFICATE_INVALID",
    reason: "ERR_TLS_CERT_ALTNAME_INVALID",
  });
  assert.doesNotMatch(JSON.stringify(startupFields), /127\.0\.0\.1|BEGIN CERTIFICATE/);
  // A host= override selects the IP even when the URL authority is a DNS name.
  assert.deepEqual(
    await handshake(v4, url("localhost", v4.port, `${verified}&host=127.0.0.1`)),
    refused,
  );
  assert.deepEqual(
    await withEnvironment({ PGHOST: "127.0.0.1", PGPORT: String(v4.port) }, () =>
      handshake(v4, `postgresql://occ_app@/occ?sslnegotiation=direct&${verified}`),
    ),
    refused,
  );
  const environment = {
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000001",
    AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000002",
    AZURE_FEDERATED_TOKEN_FILE: join(directory, "unused-token"),
  };
  assert.deepEqual(
    await withEnvironment(environment, () =>
      handshake(v4, url("127.0.0.1", v4.port), "azure-workload-identity"),
    ),
    refused,
  );

  // DNS hosts keep pg's servername-based check and an unchanged configuration.
  assert.deepEqual(await handshake(v4, url("localhost", v4.port)), {
    code: null,
    accepted: 1,
  });
  // The matching iPAddress SAN is accepted, as with libpq.
  v4.use(pki.ipLoopback);
  assert.deepEqual(await handshake(v4, url("127.0.0.1", v4.port)), { code: null, accepted: 1 });
  // Another IP's SAN is not.
  v4.use(pki.ipOther);
  assert.deepEqual(await handshake(v4, url("127.0.0.1", v4.port)), refused);

  if (v6) {
    assert.deepEqual(
      await handshake(v6, url("localhost", v6.port, `${verified}&host=::1`)),
      refused,
    );
    v6.use(pki.ipLoopback);
    assert.deepEqual(await handshake(v6, url("localhost", v6.port, `${verified}&host=::1`)), {
      code: null,
      accepted: 1,
    });
  } else {
    context.diagnostic("IPv6 loopback unavailable; skipped the ::1 handshake");
  }
});

test("the IP host identity check leaves other connection configurations unchanged", async (context) => {
  const directory = await temporaryDirectory(context, "occ-postgres-ip-config-");
  const certificate = join(directory, "root.crt");
  await writeFile(certificate, rootCertificate());
  const unchanged = [
    "postgresql://occ_app@db.internal/occ?sslmode=verify-full",
    "postgresql://occ_app@127.0.0.1/occ",
    "postgresql://occ_app@127.0.0.1/occ?sslmode=disable",
    "postgresql://occ_app@127.0.0.1/occ?sslmode=no-verify",
    `postgresql://occ_app@127.0.0.1/occ?sslmode=verify-ca&uselibpqcompat=true&sslrootcert=${encodeURIComponent(certificate)}`,
    `postgresql://occ_app@localhost/occ?sslmode=verify-full&host=${encodeURIComponent("/var/run/postgresql")}`,
  ];
  for (const url of unchanged) {
    const pool = await createPostgresPool(url, { authMode: "password", max: 2 });
    try {
      assert.equal(pool.options.connectionString, url);
      assert.equal(pool.options.Client, undefined, url);
      assert.equal(pool.options.ssl, undefined, url);
    } finally {
      await pool.end();
    }
  }
  const ip = passwordUrl("test-only", "127.0.0.1", "?sslmode=verify-full&application_name=a");
  const pool = await createPostgresPool(ip, { authMode: "password", max: 2 });
  try {
    assert.equal(pool.options.connectionString, ip);
    assert.equal(typeof pool.options.Client, "function");
    const client = configuredClient(pool.options);
    assert.equal(client.user, "occ_app");
    assert.equal(client.password, "test-only");
    const parameters = clientParameters(client);
    assert.equal(parameters.application_name, "a");
    assert.equal(parameters.host, "127.0.0.1");
    assertIpIdentityCheck(client);
  } finally {
    await pool.end();
  }
  // pg reads sslrootcert per connection, so a file that is unreadable now is
  // checked when a connection reads it; pool construction still succeeds.
  const missing = `postgresql://occ_app@127.0.0.1/occ?sslmode=verify-full&sslrootcert=${encodeURIComponent(join(directory, "later.pem"))}`;
  const deferred = await createPostgresPool(missing, { authMode: "password" });
  try {
    await writeFile(join(directory, "later.pem"), rootCertificate());
    const client = configuredClient(deferred.options);
    assertIpIdentityCheck(client);
  } finally {
    await deferred.end();
  }
  const nested = new URL("postgresql://occ_app@127.0.0.1/occ?sslmode=verify-full");
  nested.searchParams.set("connectionString", "postgresql://occ_app@127.0.0.1/occ?sslmode=disable");
  await assert.rejects(
    createPostgresPool(nested.toString(), { authMode: "password" }),
    /IP host does not allow nested connection strings/,
  );
});

function assertIpIdentityCheck(client: pg.Client): void {
  const ssl: unknown = client.ssl;
  assert.ok(typeof ssl === "object" && ssl !== null && "checkServerIdentity" in ssl);
  assert.equal(typeof ssl.checkServerIdentity, "function");
}

async function databaseCertificates(directory: string) {
  // The certificate helpers only call run with the executable and its argument list.
  const run = ((command: string, args: readonly string[]) =>
    execute(command, args, { timeout: 10000 })) as typeof execute;
  const ca = await certificateAuthority(directory, {
    caName: "occ-test-database-ca",
    caKeyPem: undefined,
    run,
  });
  const leaf = async (name: string, subjectAltName: string) => {
    const { key, cert } = await signedLeaf(directory, ca, {
      name,
      commonName: "localhost",
      subjectAltName,
      keyPem: undefined,
      run,
    });
    return { key, cert };
  };
  return {
    dnsLocalhost: await leaf("dns-localhost", "DNS:localhost"),
    ipLoopback: await leaf("ip-loopback", "IP:127.0.0.1,IP:::1"),
    ipOther: await leaf("ip-other", "IP:192.0.2.10"),
  };
}

async function tlsServer(context: TestContext, host: string, identity: SecureContextOptions) {
  const state = { accepted: 0 };
  const server = createTlsServer(identity, (socket) => {
    state.accepted++;
    socket.once("data", () => socket.destroy());
  });
  server.on("tlsClientError", () => {});
  return Object.assign(state, {
    port: await listen(context, server, host),
    use: (next: SecureContextOptions) => server.setSecureContext(next),
  });
}
