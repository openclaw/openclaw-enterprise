import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import {
  loadInstallationConfiguration,
  type InstallationRuntimeDrivers,
} from "../../apps/controller/src/composition/installation-config.ts";
import { bootstrapInstallation } from "../../scripts/bootstrap-installation.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const origin = "https://console.oce.localhost";

async function productionDrivers(): Promise<InstallationRuntimeDrivers> {
  const configuration = {
    ...createInstallationDriverConfiguration(),
    presets: { includeDefaults: false },
  };
  configuration.drivers.compute.id = "compute-production-wireup";
  const runtime = await loadInstallationConfiguration({
    mode: "production",
    environment: {},
    startupConfiguration: { configuration, logging: { level: "info" } },
  });
  assert.ok(runtime);
  return {
    ...runtime,
    computeDriver: createReadyComputeDriver("compute-production-wireup", {
      implementation: "production-wireup-memory-compute",
      async preflight() {
        return { warnings: [] };
      },
    }),
    createIAMDriver(state) {
      return new NativeIAMDriver(state, {
        id: runtime.installation.drivers.iam.id,
        implementation: runtime.installation.drivers.iam.implementation,
      });
    },
  };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate() && performance.now() < deadline) {
    await delay(5);
  }
  assert.ok(predicate(), message);
}

test(
  "PostgreSQL readiness shares only in-flight application-pool work",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    assert.ok(databaseUrl);
    const secret = randomBytes(32).toString("hex");
    const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
    const directory = await mkdtemp(
      join(statePath === undefined ? tmpdir() : dirname(statePath), "readiness-capacity-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const initialKeyPath = join(directory, "initial-service-key.json");

    // The normal initialization Job supplies the real Native IAM grants and
    // service key. No State, authentication, or pool result is substituted.
    assert.equal(
      await bootstrapInstallation({
        environment: {
          NODE_ENV: "production",
          OCC_DATABASE_URL: databaseUrl,
          OCC_AUTH_SECRET: secret,
          OCC_AUTH_BASE_URL: origin,
          OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
          OCC_BOOTSTRAP_ADMIN_EMAIL: `readiness-${randomUUID()}@example.test`,
          OCC_BOOTSTRAP_PASSWORD_FILE: join(directory, "initial-password"),
          OCC_BOOTSTRAP_SERVICE_KEY_FILE: initialKeyPath,
          OCC_BOOTSTRAP_INSTALLATION_NAME: "Readiness capacity test",
        },
        args: [],
      }),
      0,
    );
    const bootstrap = JSON.parse(await readFile(initialKeyPath, "utf8")) as {
      data: { key: string };
    };
    assert.equal(typeof bootstrap.data.key, "string");

    const originalQuery = pg.Pool.prototype.query;
    const originalConnect = pg.Pool.prototype.connect;
    let applicationPool: pg.Pool | undefined;
    let readinessQueries = 0;
    let arrived = 0;
    let measuredRequests = 0;
    let liveSockets = 0;
    let peakSockets = 0;
    const identify = (pool: pg.Pool) => {
      if (pool.options.max === 1 && pool.options.connectionString === databaseUrl) {
        applicationPool ??= pool;
      }
    };
    // These observers delegate unchanged arguments and return the actual pg
    // result. They neither replace the pool nor decide the query outcome.
    pg.Pool.prototype.connect = new Proxy(originalConnect, {
      apply(target, receiver: pg.Pool, args: unknown[]) {
        identify(receiver);
        return Reflect.apply(target, receiver, args);
      },
    });
    pg.Pool.prototype.query = new Proxy(originalQuery, {
      apply(target, receiver: pg.Pool, args: unknown[]) {
        identify(receiver);
        if (receiver === applicationPool && args[0] === "SELECT 1") {
          readinessQueries += 1;
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    let app: Awaited<ReturnType<typeof composeProduction>> | undefined;
    let heldClient: pg.PoolClient | undefined;
    const requests: Promise<unknown>[] = [];
    try {
      app = await composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl,
        authSecret: secret,
        authBaseURL: origin,
        nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
        poolMax: 1,
        drivers: await productionDrivers(),
      });
      assert.ok(applicationPool, "observe the genuine composition-owned pool");
      const pool = applicationPool;
      const server = app;
      server.addHook("onRequest", async (incoming) => {
        if (incoming.url === "/readyz") {
          arrived += 1;
        }
      });
      const send = (method: "GET" | "HEAD", authenticated = false) => {
        measuredRequests += 1;
        const pending = Promise.resolve(
          server.inject({
            method,
            url: authenticated ? "/namespaces" : "/readyz",
            headers: {
              host: new URL(origin).host,
              ...(authenticated ? { "x-api-key": bootstrap.data.key } : {}),
            },
          }),
        );
        requests.push(pending);
        return pending;
      };
      const ready = await send("GET");
      assert.equal(ready.statusCode, 200);
      assert.deepEqual(ready.json(), { status: "ready" });
      const head = await send("HEAD");
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, "");
      const authorized = await send("GET", true);
      assert.equal(authorized.statusCode, 200);
      assert.ok("data" in authorized.json());
      assert.equal(pool.waitingCount, 0);

      // An occupied real client and queued authenticated read reproduce the
      // capacity boundary without introducing extra database connections.
      heldClient = await pool.connect();
      const busy = heldClient.query("SELECT pg_sleep(0.05)");
      const benign = send("GET", true);
      await waitUntil(() => pool.waitingCount === 1, "authorized read reaches the same pool");
      const before = readinessQueries;
      const enteredBefore = arrived;
      const methods = ["GET", "HEAD", "GET", "HEAD", "GET", "HEAD"] as const;
      const probes = methods.map((method) => send(method));
      await waitUntil(() => arrived === enteredBefore + methods.length, "all six routes entered");
      assert.equal(readinessQueries - before, 1, "one readiness query is admitted");
      assert.equal(pool.waitingCount, 2, "only authentication and readiness wait for the client");
      await busy;
      heldClient.release();
      heldClient = undefined;
      const replies = await Promise.all([benign, ...probes]);
      assert.equal(replies[0]!.statusCode, 200);
      assert.ok("data" in replies[0]!.json());
      for (const [index, reply] of replies.slice(1).entries()) {
        assert.equal(reply.statusCode, 200);
        assert.equal(reply.body, methods[index] === "HEAD" ? "" : ready.body);
      }
      assert.equal(readinessQueries - before, 1);
      const afterSuccess = readinessQueries;
      assert.equal((await send("GET")).statusCode, 200);
      assert.equal(readinessQueries, afterSuccess + 1, "settled success is not cached");

      // PostgreSQL itself rejects SELECT 1 in an aborted transaction. Returning
      // that real client to this disposable pool exercises the existing HTTP
      // error mapper, then ROLLBACK restores its normal behavior.
      heldClient = await pool.connect();
      await heldClient.query("BEGIN");
      await assert.rejects(heldClient.query("SELECT 1 / 0"), { code: "22012" });
      const failureBefore = readinessQueries;
      const failureEntered = arrived;
      const failures = methods.map((method) => send(method));
      await waitUntil(() => arrived === failureEntered + methods.length, "failure callers entered");
      assert.equal(readinessQueries - failureBefore, 1);
      assert.equal(pool.waitingCount, 1);
      heldClient.release();
      heldClient = undefined;
      const failed = await Promise.all(failures);
      const failure = failed[0]!;
      assert.equal(failure.statusCode, 500);
      const failureError = {
        code: "INTERNAL_ERROR",
        message: "The platform request could not be completed.",
      };
      for (const [index, reply] of failed.entries()) {
        assert.equal(reply.statusCode, failure.statusCode);
        if (methods[index] === "HEAD") {
          assert.equal(reply.body, "");
        } else {
          assert.match(String(reply.headers["x-request-id"]), /^req_/);
          assert.deepEqual(reply.json(), {
            error: failureError,
            meta: { requestId: reply.headers["x-request-id"] },
          });
        }
      }
      assert.equal(readinessQueries - failureBefore, 1);
      context.diagnostic(
        JSON.stringify({
          failureStatus: failure.statusCode,
          failureBody: failure.json(),
          contendedReadinessQueries: 1,
          contendedPoolWaiters: 2,
        }),
      );
      heldClient = await pool.connect();
      await heldClient.query("ROLLBACK");
      heldClient.release();
      heldClient = undefined;
      const afterFailure = readinessQueries;
      assert.equal((await send("GET")).statusCode, 200);
      assert.equal(readinessQueries, afterFailure + 1, "settled failure admits a fresh check");

      // Exercise a real client disconnect while the database query is queued.
      // A later route must still join that query, even though its first caller
      // has gone away. The short caller-side deadline also cannot detach it.
      const address = new URL(await server.listen({ host: "127.0.0.1", port: 0 }));
      heldClient = await pool.connect();
      const disconnectBefore = readinessQueries;
      measuredRequests += 1;
      const disconnected = new Promise<void>((resolve, reject) => {
        const outgoing = request({
          host: "127.0.0.1",
          port: Number(address.port),
          path: "/readyz",
          method: "GET",
          agent: false,
          headers: { host: new URL(origin).host, connection: "close" },
        });
        outgoing.once("socket", (socket) => {
          liveSockets += 1;
          peakSockets = Math.max(peakSockets, liveSockets);
          socket.once("close", () => {
            liveSockets -= 1;
          });
        });
        outgoing.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNRESET") {
            resolve();
          } else {
            reject(error);
          }
        });
        outgoing.once("response", () => reject(new Error("disconnected request completed early")));
        outgoing.end();
        void waitUntil(() => readinessQueries === disconnectBefore + 1, "network request queues")
          .then(() => outgoing.destroy())
          .catch(reject);
      });
      requests.push(disconnected);
      await disconnected;
      const timedWait = send("HEAD");
      assert.equal(
        await Promise.race([timedWait.then(() => "completed"), delay(25, "expired")]),
        "expired",
      );
      const later = send("GET");
      await waitUntil(() => pool.waitingCount >= 1, "shared query remains queued");
      await delay(25);
      assert.equal(
        readinessQueries,
        disconnectBefore + 1,
        "departed callers cannot release admission",
      );
      assert.equal(pool.waitingCount, 1);
      heldClient.release();
      heldClient = undefined;
      assert.equal((await timedWait).statusCode, 200);
      assert.equal((await later).statusCode, 200);
      const afterDisconnect = readinessQueries;
      assert.equal((await send("GET")).statusCode, 200);
      assert.equal(readinessQueries, afterDisconnect + 1);
      assert.equal(pool.waitingCount, 0);
    } finally {
      if (heldClient !== undefined) {
        await heldClient.query("ROLLBACK").catch(() => undefined);
        heldClient.release();
      }
      await Promise.allSettled(requests);
      pg.Pool.prototype.query = originalQuery;
      pg.Pool.prototype.connect = originalConnect;
      await app?.close();
      context.diagnostic(JSON.stringify({ measuredRequests, peakSockets, liveSockets }));
      assert.ok(measuredRequests <= 32);
      assert.ok(peakSockets <= 4);
      assert.equal(liveSockets, 0);
    }
  },
);
