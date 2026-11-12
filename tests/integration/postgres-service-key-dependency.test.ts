import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { bootstrapInstallation } from "../../scripts/bootstrap-installation.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown): string {
  assert.ok(typeof value === "string" && value.length > 0);
  return value;
}

function closedPoolFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (/Cannot use a pool after calling end/.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function blockedKeyUpdate(
  pool: pg.Pool,
  applicationName: string,
  blockerPid: number,
): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $1
         AND $2::integer = ANY(pg_blocking_pids(pid))
         AND query LIKE 'update "occ"."apikey"%'`,
      [applicationName, blockerPid],
    );
    if (result.rows.length === 1) {
      return result.rows[0]!.pid;
    }
    await delay(10);
  }
  assert.fail("the real key-store update must wait for its owned row lock");
}

test(
  "PostgreSQL service-key admission distinguishes invalid credentials from a key-store outage",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    assert.ok(databaseUrl);
    const origin = "https://console.oce.localhost";
    const secret = randomBytes(32).toString("hex");
    const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
    const directory = await mkdtemp(
      join(statePath === undefined ? tmpdir() : dirname(statePath), "service-key-dependency-"),
    );
    const initialKeyPath = join(directory, "initial-service-key.json");
    context.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    // Use the normal initialization Job so IAM grants and both bootstrap identities
    // are persisted with the same invariants as a newly installed controller.
    assert.equal(
      await bootstrapInstallation({
        environment: {
          NODE_ENV: "production",
          OCC_DATABASE_URL: databaseUrl,
          OCC_AUTH_SECRET: secret,
          OCC_AUTH_BASE_URL: origin,
          OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
          OCC_BOOTSTRAP_ADMIN_EMAIL: `service-key-${randomUUID()}@example.test`,
          OCC_BOOTSTRAP_PASSWORD_FILE: join(directory, "initial-password"),
          OCC_BOOTSTRAP_SERVICE_KEY_FILE: initialKeyPath,
          OCC_BOOTSTRAP_INSTALLATION_NAME: "Service key dependency test",
        },
        args: [],
      }),
      0,
      "the supported installation bootstrap must succeed",
    );
    const bootstrap = object(JSON.parse(await readFile(initialKeyPath, "utf8")) as unknown);
    const initial = object(bootstrap.data);
    const initialKey = nonemptyString(initial.key);
    const servicePrincipalId = nonemptyString(initial.servicePrincipalId);

    // The production auth binding owns authPool. State and Native IAM use a
    // separate real pool, so closing authPool cannot manufacture an IAM outage.
    const authApplicationName = `service-key-dependency-${randomUUID()}`;
    const authPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: authApplicationName,
    });
    const lockPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const statePool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    let authPoolEnded = false;
    const resources: { app?: ReturnType<typeof createFastifyApp> } = {};
    context.after(async () => {
      try {
        await resources.app?.close();
      } finally {
        try {
          if (!authPoolEnded) {
            await authPool.end();
          }
        } finally {
          await Promise.all([statePool.end(), lockPool.end()]);
        }
      }
    });
    const state = new PostgresPlatformState(statePool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const iam = new NativeIAMDriver(state);
    const controller = new OpenClawController(installation, { state, recordOperations: true });
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    const auth = await createPostgresControllerAuth({
      mode: "production",
      installationId: installation.id,
      baseURL: origin,
      agentDomain: "agents.oce.localhost",
      secret,
      pool: authPool,
      state,
      iamDriver: iam,
    });
    const server = createFastifyApp({
      controller,
      iamDriver: iam,
      resolveHarness: resolveApprovedProductionHarness,
      auditSink: state.auditSink,
      auth,
      development: { enabled: false, installationId: installation.id },
    });
    resources.app = server;
    const createKey = async (name: string) => {
      const response = await server.inject({
        method: "POST",
        url: "/api/auth/service-keys",
        headers: {
          host: new URL(origin).host,
          "content-type": "application/json",
          "x-api-key": initialKey,
        },
        payload: JSON.stringify({ servicePrincipalId, name }),
      });
      assert.equal(
        response.statusCode,
        201,
        "the authorized key-management route must issue a key",
      );
      const data = object(object(response.json() as unknown).data);
      return { id: nonemptyString(data.id), key: nonemptyString(data.key) };
    };
    const readNamespaces = (key: string) =>
      server.inject({
        method: "GET",
        url: "/namespaces",
        headers: { host: new URL(origin).host, "x-api-key": key },
      });
    const key = await createKey("dependency-control");
    const revoked = await createKey("revoked-control");
    const concurrent = await createKey("concurrent-control");
    const expired = await createKey("expired-control");
    const authContext = await auth.auth.$context;

    const valid = await readNamespaces(key.key);
    assert.equal(valid.statusCode, 200, "a warm, authorized service key must read through OCC");
    const invalid = await readNamespaces(`occ_${randomBytes(48).toString("base64url")}`);
    assert.equal(invalid.statusCode, 401, "an ordinary invalid key remains unauthenticated");
    const revoke = await server.inject({
      method: "DELETE",
      url: `/api/auth/service-keys/${encodeURIComponent(revoked.id)}`,
      headers: { host: new URL(origin).host, "x-api-key": initialKey },
    });
    assert.equal(revoke.statusCode, 200, "the supported key-revocation route must succeed");
    const revokedResponse = await readNamespaces(revoked.key);
    assert.equal(revokedResponse.statusCode, 401, "a revoked key remains unauthenticated");

    await authContext.adapter.update({
      model: "apikey",
      where: [{ field: "id", value: expired.id }],
      update: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expiredResponse = await readNamespaces(expired.key);
    assert.equal(expiredResponse.statusCode, 401, "an expired key remains unauthenticated");

    // Hold two real key rows so the same verifier has two overlapping updates.
    // Cancelling only the first app-role backend must not poison the other request.
    const failureLock = await lockPool.connect();
    const healthyLock = await lockPool.connect();
    let failingRequest: ReturnType<typeof readNamespaces> | undefined;
    let healthyRequest: ReturnType<typeof readNamespaces> | undefined;
    let updateOutageStatus: number | undefined;
    let concurrentStatus: number | undefined;
    try {
      await failureLock.query("BEGIN");
      await healthyLock.query("BEGIN");
      await failureLock.query("SELECT id FROM occ.apikey WHERE id = $1 FOR UPDATE", [key.id]);
      await healthyLock.query("SELECT id FROM occ.apikey WHERE id = $1 FOR UPDATE", [
        concurrent.id,
      ]);
      const failureBlocker = await failureLock.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const healthyBlocker = await healthyLock.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      failingRequest = readNamespaces(key.key);
      const failingPid = await blockedKeyUpdate(
        statePool,
        authApplicationName,
        failureBlocker.rows[0]!.pid,
      );
      healthyRequest = readNamespaces(concurrent.key);
      const healthyPid = await blockedKeyUpdate(
        statePool,
        authApplicationName,
        healthyBlocker.rows[0]!.pid,
      );
      assert.notEqual(failingPid, healthyPid);
      const cancelled = await statePool.query<{ cancelled: boolean }>(
        "SELECT pg_cancel_backend($1) AS cancelled",
        [failingPid],
      );
      assert.equal(cancelled.rows[0]?.cancelled, true, "cancel only the owned blocked update");
      const updateOutage = await failingRequest;
      updateOutageStatus = updateOutage.statusCode;
      assert.equal(updateOutageStatus, 503, "a failed key-use update is a dependency outage");
      assert.equal(
        object(object(updateOutage.json() as unknown).error).code,
        "DEPENDENCY_UNAVAILABLE",
      );
      await healthyLock.query("ROLLBACK");
      const concurrentHealthy = await healthyRequest;
      concurrentStatus = concurrentHealthy.statusCode;
      assert.equal(concurrentStatus, 200, "another in-flight verification keeps its own result");
    } finally {
      await Promise.all([failureLock.query("ROLLBACK"), healthyLock.query("ROLLBACK")]);
      await Promise.allSettled(
        [failingRequest, healthyRequest].filter((request) => request !== undefined),
      );
      failureLock.release();
      healthyLock.release();
    }

    // End the exact Pool already used by the live Drizzle adapter. Prove that
    // this adapter now fails while State and the selected IAM Driver still work.
    await authPool.end();
    authPoolEnded = true;
    await assert.rejects(
      authContext.adapter.findOne({
        model: "apikey",
        where: [{ field: "id", value: key.id }],
      }),
      closedPoolFailure,
      "the actual key-store adapter must reject because its owning pool ended",
    );
    assert.equal((await statePool.query("SELECT 1 AS healthy")).rows[0]?.healthy, 1);
    assert.equal((await state.loadInstallation())?.id, installation.id);
    const authorization = await iam.authorize({
      principalId: servicePrincipalId,
      action: "administer",
      resource: { kind: "installation", id: installation.id },
    });
    assert.equal(authorization.allowed, true, "the independent IAM dependency must remain healthy");

    const outage = await readNamespaces(key.key);
    const outageCode = object(object(outage.json() as unknown).error).code;
    context.diagnostic(
      JSON.stringify({
        proof: "service-key-dependency",
        validStatus: valid.statusCode,
        invalidStatus: invalid.statusCode,
        revokeStatus: revoke.statusCode,
        revokedStatus: revokedResponse.statusCode,
        expiredStatus: expiredResponse.statusCode,
        updateOutageStatus,
        concurrentStatus,
        concurrencyIsolation: true,
        knownStoreFailure: true,
        stateHealthy: true,
        iamHealthy: authorization.allowed,
        observedStatus: outage.statusCode,
        observedCode: typeof outageCode === "string" ? outageCode : null,
        expectedStatus: 503,
      }),
    );
    assert.equal(
      outage.statusCode,
      503,
      "a failed service-key store is an authentication dependency outage",
    );
    assert.equal(outageCode, "DEPENDENCY_UNAVAILABLE");
  },
);
