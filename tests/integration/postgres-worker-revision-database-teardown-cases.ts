import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import { waitFor } from "../helpers/wait-for.mjs";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

type Setup = ReturnType<typeof createWorkerRevisionFixtures>["setup"];
type FixtureDatabase = Awaited<ReturnType<Setup>>["database"];

async function disposeOwnedDatabase(database: FixtureDatabase) {
  assert.ok(
    "dispose" in database && typeof database.dispose === "function",
    "setup owns and can dispose this database",
  );
  await database.dispose();
}

export async function preserveOtherDatabaseClaim(context: TestContext, setup: Setup) {
  const first = await setup(context);
  const firstOwner = await first.agent("isolated-first");
  await first.revision(firstOwner, 1);
  const second = await setup(context);
  const queue = new second.PostgresWorkQueue(second.observerPool);
  assert.equal(await queue.claim(), undefined, "workers cannot claim another fixture's work");

  const owner = await second.agent("isolated-second");
  const candidate = await second.revision(owner, 1);
  const release = Promise.withResolvers<void>();
  let preparing = false;
  try {
    await second.start({
      ...second.compute,
      async prepareRevision(revision, deploymentContext) {
        preparing = true;
        await release.promise;
        return second.compute.prepareRevision(revision, deploymentContext);
      },
    });
    await waitFor("second fixture to hold its claim during preparation", async () =>
      preparing ? true : undefined,
    );
    const before = await second.work(candidate, "claimed");
    assert.ok(typeof before.claim_token === "string", "claimed work has a claim token");

    await disposeOwnedDatabase(first.database);
    const renewed = await queue.heartbeat({
      idempotencyKey: candidate.idempotencyKey,
      claimToken: before.claim_token,
    });
    assert.equal(renewed?.claimToken, before.claim_token);
    release.resolve();
    await second.work(candidate, "succeeded");
    const activated = await second.currentAgent(owner);
    assert.equal(activated?.activeRevisionId, candidate.id);
  } finally {
    // Release Compute before the registered owner teardown joins its worker.
    release.resolve();
  }
}

// Finding 1209: a file hung 22 minutes in teardown, past its job's timeout, naming nothing.
// Node's test timeout does not cover after hooks, and pg's pool.end() waits for every
// checked-out client, so one client a failed test never released hung the file. Each teardown
// step now has a limit: the stuck step is named, and the database drop still runs, ending the
// leaked session.
export async function dropDatabaseWithStuckPool(context: TestContext, setup: Setup) {
  // This test runs the teardown itself and expects it to fail, so the fixture registers its
  // after hooks with this stand-in; the fallback runs them only if the test fails first.
  const hooks: (() => Promise<void>)[] = [];
  let leaked: PoolClient | undefined;
  let disposed = false;
  context.after(async () => {
    leaked?.release(true);
    if (!disposed) {
      for (const hook of hooks) {
        await Promise.resolve()
          .then(hook)
          .catch(() => {});
      }
    }
  });
  const fixture = await setup(
    {
      after: (hook: () => Promise<void>) => {
        hooks.push(hook);
      },
    },
    { disposeLimitsMs: { "pool end": 1_000 } },
  );
  const client = await fixture.observerPool.connect();
  leaked = client;
  // A terminated session errors twice (the server's notice, then the closed socket).
  const terminated = new Promise<unknown>((resolve) => client.on("error", resolve));

  disposed = true;
  await assert.rejects(disposeOwnedDatabase(fixture.database), {
    message: "revision fixture teardown: pool end did not finish within 1000 ms",
  });
  // The drop (WITH (FORCE)) ended the leaked client's session, which nothing else would.
  const ended = await Promise.race([terminated, delay(10_000, undefined, { ref: false })]);
  assert.ok(ended instanceof Error, "the database drop ended the leaked connection");
  leaked.release(true);
  leaked = undefined;
}

// Finding 2379: pg's pool.end() resolves before its idle sessions close, so the database drop
// right after can end one of them. The server's 57P01 reached the pool's idle listener, which
// re-emitted it on the pool, and with no listener that failed the test in its teardown.
export async function ignoreEndedPoolError(context: TestContext, setup: Setup) {
  const fixture = await setup(context);
  const idle = await fixture.observerPool.connect();
  idle.release();
  await disposeOwnedDatabase(fixture.database);
  // What that idle client receives when the drop ends its session before it closed.
  const ended = Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });
  assert.doesNotThrow(() => idle.emit("error", ended));
}
