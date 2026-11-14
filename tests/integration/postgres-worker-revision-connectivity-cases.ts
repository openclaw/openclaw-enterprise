import assert from "node:assert/strict";
import { connect, createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { waitFor } from "../helpers/wait-for.mjs";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

type Setup = ReturnType<typeof createWorkerRevisionFixtures>["setup"];

export async function reportReadinessWithoutRepositoryCredentials(
  context: TestContext,
  setup: Setup,
) {
  let healthy = false;
  const fixture = await setup(context, {
    onHealthy: async () => {
      healthy = true;
    },
  });
  const { candidate } = await fixture.admitInitialRevision("no-repository-capability");
  await fixture.start(fixture.compute);
  await fixture.work(candidate, "succeeded");
  await waitFor("repository-disabled worker readiness", async () => (healthy ? true : undefined));
}

/**
 * Relay PostgreSQL connections through a local proxy that can go silent: it stops relaying on
 * every open connection without closing it, as a client sees after a failover or partition
 * that sent no RST. New connections still reach the server.
 */
async function startSilenceableProxy(context: TestContext, databaseUrl: string) {
  const target = new URL(databaseUrl);
  const pairs = new Set<{ client: Socket; upstream: Socket }>();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    const pair = { client, upstream };
    pairs.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on("error", close);
      socket.on("close", close);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    }));
  context.after(close);
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "the relay bound a TCP port");
  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    silence() {
      for (const { client, upstream } of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    close,
  };
}

export async function resumeWorkAfterSilentConnection(context: TestContext, setup: Setup) {
  const [{ Pool }, { workerDatabasePoolOptions }] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/worker.ts"),
  ]);
  const fixture = await setup(context);
  assert.ok(typeof fixture.database.url === "string", "the fixture prepared a database URL");
  const proxy = await startSilenceableProxy(context, fixture.database.url);
  const pool = new Pool({
    connectionString: proxy.url,
    ...workerDatabasePoolOptions(3_000),
    max: 2,
  });
  fixture.database.pools.add(pool);
  const { candidate: before } = await fixture.admitInitialRevision("before-silence");
  await fixture.start(fixture.compute, { pool });
  await fixture.work(before, "succeeded");

  // Every pooled connection now swallows queries without an answer or an error.
  proxy.silence();
  const { candidate: after } = await fixture.admitInitialRevision("after-silence");
  await fixture.work(after, "succeeded", 30_000);
  await fixture.stop();
  await proxy.close();
}

export async function reportProgressThroughOutage(context: TestContext, setup: Setup) {
  const { Pool } = await import("pg");
  let progressed = 0;
  const fixture = await setup(context, {
    onProgress: async () => {
      progressed += 1;
    },
  });
  assert.ok(typeof fixture.database.url === "string", "the fixture prepared a database URL");
  const proxy = await startSilenceableProxy(context, fixture.database.url);
  // No query timeout: this isolates the liveness signal from the timeout that would unstick it.
  const pool = new Pool({ connectionString: proxy.url, max: 1 });
  fixture.database.pools.add(pool);
  pool.on("error", () => {});
  await fixture.start(fixture.compute, { pool });
  await waitFor("idle worker progress", async () => (progressed >= 2 ? true : undefined));

  proxy.silence();
  // A negative check needs a fixed window. Progress is reported at most once per second
  // here (pollIntervalMs 15), so 1.5 s lets an in-flight pass settle and 3 s spans three
  // reports a moving loop would have made.
  await delay(1_500);
  const stuck = progressed;
  await delay(3_000);
  assert.equal(progressed, stuck, "a worker stuck on a silent query must stop reporting progress");

  // Refused connections fail each pass fast; the loop still moves, so liveness holds.
  await proxy.close();
  await waitFor("progress through a database outage", async () =>
    progressed >= stuck + 2 ? true : undefined,
  );
  await fixture.stop();
}
