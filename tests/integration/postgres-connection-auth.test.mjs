import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rootCertificates } from "node:tls";
import { createPostgresPool } from "../../packages/occ/src/state/postgres-pool.ts";

const requireOcc = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
const { Client } = requireOcc("pg");

test("password authentication preserves the existing pg connection configuration", async () => {
  const pool = await createPostgresPool("postgresql://occ_app:test-only@localhost/occ", {
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
    const url = new URL(process.env.OCC_TEST_DATABASE_URL);
    const pool = await createPostgresPool(url.toString(), { authMode: "password", max: 1 });
    try {
      // Exercise the shared connection factory against PostgreSQL, not only
      // pg's constructor. Database selection must survive the factory refactor.
      const { rows } = await pool.query(
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
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  let pool;
  try {
    Object.assign(process.env, environment);
    pool = await createPostgresPool(
      "postgresql://occ_app@localhost/occ?sslmode=verify-full&application_name=occ-worker",
      { authMode: "azure-workload-identity", max: 2 },
    );
    const client = new Client(pool.options);
    assert.equal(client.user, "occ_app");
    assert.equal(client.database, "occ");
    assert.equal(typeof client.password, "function");
    assert.equal(client.connectionParameters.application_name, "occ-worker");
    assert.notEqual(client.ssl, false);
    assert.equal(client.ssl?.rejectUnauthorized, true);
    assert.equal(pool.options.max, 2);

    // pg reparses this reserved option after the factory's checks, which would
    // overwrite both the token callback and verified TLS configuration.
    const nested = new URL("postgresql://occ_app@localhost/occ?sslmode=verify-full");
    nested.searchParams.set(
      "connectionString",
      "postgresql://occ_app:fixed-password@localhost/occ?sslmode=disable",
    );
    await assert.rejects(
      createPostgresPool(nested.toString(), { authMode: "azure-workload-identity" }),
      /nested connection strings/,
    );

    // libpq-compatible require/verify-ca can trust a CA while disabling hostname
    // checks. Reject those parsed options before acquiring a bearer token.
    const directory = await mkdtemp(join(tmpdir(), "occ-postgres-ca-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const certificate = join(directory, "root.crt");
    await writeFile(certificate, rootCertificates[0]);
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
    if (pool) await pool.end();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("workload authentication rejects password fallback and unverified TLS", async () => {
  await assert.rejects(
    createPostgresPool("postgresql://occ_app:fixed-password@localhost/occ?sslmode=verify-full", {
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
