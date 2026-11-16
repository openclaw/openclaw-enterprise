import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  ControllerWorker,
  type ControllerWorkerOptions,
} from "../../apps/controller/src/worker.ts";
import {
  closeWorkerComposition,
  type WorkerComposition,
} from "../../apps/controller/src/worker/shutdown.ts";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor, within } from "../helpers/wait-for.ts";

type FixtureSetup = ReturnType<typeof createWorkerRevisionFixtures>["setup"];
type FixtureOptions = NonNullable<Parameters<FixtureSetup>[1]>;
type RevisionFixture = Awaited<ReturnType<FixtureSetup>>;
interface ReadinessOptions {
  leaseDurationMs?: NonNullable<FixtureOptions["leaseDurationMs"]>;
}

// The revision fixture also exposes untyped fields for other scenarios. Only this worker
// collection crosses that boundary here, and its selected value is checked before shutdown.
interface ReadinessFixture {
  compute: RevisionFixture["compute"];
  start: RevisionFixture["start"];
  admitInitialRevision: RevisionFixture["admitInitialRevision"];
  work: RevisionFixture["work"];
  database: { workers: Iterable<unknown, undefined, undefined> };
}

type RevisionSetup = (
  context: Parameters<FixtureSetup>[0],
  options: ReadinessOptions & { onHealthy: NonNullable<FixtureOptions["onHealthy"]> },
) => Promise<ReadinessFixture>;
type WorkerEmit = NonNullable<ControllerWorkerOptions["emit"]>;

interface HealthTick {
  entered: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
}

// Shutdown must join in-flight health before unlinking the marker. Otherwise the check
// can recreate the marker after the worker stops.
async function readinessFixture(
  context: TestContext,
  setup: RevisionSetup,
  options: ReadinessOptions = {},
) {
  const directory = await temporaryDirectory(context, "occ-worker-readiness-");
  const readinessPath = join(directory, "ready");
  const events: string[] = [];
  let held: HealthTick | undefined;
  const fixture = await setup(context, {
    ...options,
    async onHealthy() {
      const tick = held;
      held = undefined;
      if (tick !== undefined) {
        tick.entered.resolve();
        await tick.release.promise;
      }
      await writeFile(readinessPath, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 });
    },
  });

  function holdNextHealth(): HealthTick {
    held = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    return held;
  }

  function recordEvents(onEvent?: WorkerEmit): WorkerEmit {
    return (entry) => {
      if (entry.event === "worker.health" || entry.event === "worker.stopped") {
        events.push(entry.event);
      }
      onEvent?.(entry);
    };
  }

  async function waitForMarker(): Promise<void> {
    await waitFor("the first readiness marker", async () => {
      try {
        return await stat(readinessPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    });
  }

  function shutdown(onTransportClose?: () => void): Promise<void> {
    const worker = Array.from(fixture.database.workers).at(-1);
    assert.ok(worker instanceof ControllerWorker, "expected the fixture's running worker");
    const step = (name: string) => async () => {
      events.push(name);
    };
    const composition: WorkerComposition = {
      readinessPath,
      repositoryGitTransport: {
        async close() {
          onTransportClose?.();
          events.push("transport");
        },
      },
      preparedRepositoryGit: { close: step("prepared") },
      receiptServer: { close: step("receipt") },
      closeMetrics: step("metrics"),
      preparedGitHub: { close: step("github") },
      worker,
    };
    return closeWorkerComposition(composition);
  }

  async function assertHealthEndedBeforeClose(): Promise<void> {
    assert.deepEqual(events, [
      "worker.health",
      "transport",
      "prepared",
      "receipt",
      "metrics",
      "github",
      "worker.stopped",
    ]);
    // The marker written by the held check must be gone after shutdown.
    await assert.rejects(stat(readinessPath), { code: "ENOENT" });
  }

  return {
    fixture,
    events,
    holdNextHealth,
    recordEvents,
    waitForMarker,
    shutdown,
    assertHealthEndedBeforeClose,
  };
}

export async function shutdownDuringIdleHealth(
  context: TestContext,
  setup: RevisionSetup,
): Promise<void> {
  const readiness = await readinessFixture(context, setup);
  await readiness.fixture.start(readiness.fixture.compute, { emit: readiness.recordEvents() });
  await readiness.waitForMarker();

  // Hold the next idle health check before it writes the marker.
  const tick = readiness.holdNextHealth();
  try {
    await within(tick.entered.promise, "the idle health check to reach the marker write");
    readiness.events.length = 0;
    const closing = readiness.shutdown();
    tick.release.resolve();
    await closing;
  } finally {
    tick.release.resolve();
  }
  await readiness.assertHealthEndedBeforeClose();
}

export async function shutdownDuringClaimHealth(
  context: TestContext,
  setup: RevisionSetup,
): Promise<void> {
  // The lease renews every 1.5 s, so the heartbeat can start a new health check.
  const readiness = await readinessFixture(context, setup, { leaseDurationMs: 4_500 });
  const { fixture } = readiness;
  const { candidate } = await fixture.admitInitialRevision("background-health");
  const preparing = Promise.withResolvers<void>();
  const releaseCompute = Promise.withResolvers<void>();
  const passEnded = Promise.withResolvers<void>();
  let tick: HealthTick | undefined;
  let closing: Promise<void> | undefined;

  try {
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          preparing.resolve();
          await releaseCompute.promise;
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      {
        emit: readiness.recordEvents(({ event }) => {
          if (
            event === "worker.pass-interrupted" ||
            event === "worker.completed" ||
            event === "worker.error"
          ) {
            passEnded.resolve();
          }
        }),
      },
    );
    await within(preparing.promise, "Compute to begin preparing the revision");
    await fixture.work(candidate, "claimed");

    // Compute holds the pass, so the claim heartbeat starts this check in the background.
    const claimHealth = readiness.holdNextHealth();
    tick = claimHealth;
    await within(claimHealth.entered.promise, "the claim health check to reach the marker write");
    readiness.events.length = 0;
    // If shutdown misses the pending check, transport closes first and releases the
    // write after marker removal. Give that failure time to occur after the pass ends.
    closing = readiness.shutdown(() => claimHealth.release.resolve());
    releaseCompute.resolve();
    await Promise.all([
      closing,
      within(passEnded.promise, "the worker pass to end during shutdown").then(async () => {
        await delay(250);
        claimHealth.release.resolve();
      }),
    ]);
  } finally {
    tick?.release.resolve();
    releaseCompute.resolve();
    // Join shutdown after releasing the gates, preserving any failure above.
    await closing?.catch(() => {});
  }
  await readiness.assertHealthEndedBeforeClose();
}
