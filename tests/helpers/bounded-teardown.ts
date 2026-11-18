import { AsyncLocalStorage, executionAsyncResource } from "node:async_hooks";
import { tracingChannel } from "node:diagnostics_channel";
import { setTimeout as delay } from "node:timers/promises";

type Cleanup = () => unknown;

type TeardownContext = {
  after(hook: () => Promise<void>): unknown;
  readonly signal?: { readonly aborted: boolean } | undefined;
};

type BoundedContext<Context extends TeardownContext> = Omit<Context, "after"> & {
  after(cleanup: Cleanup): void;
};

type Teardown<Context> = {
  context: Context;
  readonly started: boolean;
};

type TeardownOptions = {
  label?: string;
  stepLimitMs?: number;
  exitGraceMs?: number;
  log?: (message: string) => void;
  exit?: () => unknown;
  failFile?: () => void;
  settled?: (quietMs: number) => PromiseLike<unknown>;
  onOutcome?: (outcome: "failed" | "incomplete" | "passed") => void;
};

type CleanupStep = { cleanup: Cleanup; site: string };

type UnsettledSetup = {
  label: string;
  limitMs: number;
  deadline: number;
  log: (message: string) => void;
};

// node:test runs a test's after hooks in registration order and skips the rest once one throws
// (finding 1711). A test that registers a Namespace delete first and its worker stop last deletes
// the worker's ServiceAccount under a running worker, and an early hook that fails skips the stop:
// the worker, its pools and port-forwards then hold the file until the runner's file timeout.
// A bounded teardown runs the cleanups registered through its `context.after` last-registered
// first, each within `stepLimitMs`, and runs every one after a failure. It logs each cleanup by
// the line that registered it. A cleanup past its limit is left running and fails the teardown,
// and the process exits once the file's tests have settled for `exitGraceMs`, so what it holds
// cannot keep the file alive (the revision fixture's rule, finding 1223). The limit covers the
// 120 s Namespace deletes.
export const teardownStepLimitMs = 180_000;
export const abandonedTeardownExitGraceMs = 2_000;

// node:test publishes, on this channel (Node 24.16), each test's start once its parent's before
// hooks ran and its end after its own hooks, and the file root's start and end around the root's
// after hooks, once every test has finished (even while a handle holds the process). Suites
// publish only around their build, a test skipped by name publishes neither, and one whose
// parent's before hook failed publishes only its end. Without the channel (an older Node), the
// exit waits out the grace alone. Subscribing makes node:test call each test function with its
// internal Test as `this`.
const runningTests = new Set<object>();
// The root's events, told from a test's by the Test that publishes them (the async resource it
// runs in has no parent), not by its display name, which a test can share.
const rootEvents = new WeakSet<object>();
let testEventsSeen = false;
let fileFinished = false;
let lateCleanupsRunning = 0;
let lastActivity = performance.now();
const markActivity = () => {
  lastActivity = performance.now();
};
function publishedByRoot(test: object): boolean {
  const publisher: unknown = executionAsyncResource();
  return publisher !== null && typeof publisher === "object" && "parent" in publisher
    ? publisher.parent === null
    : // Only for a Node whose tests are not published from their Test.
      Reflect.get(test, "name") === "<root>";
}
tracingChannel("node.test").subscribe({
  start(test: object) {
    testEventsSeen = true;
    if (publishedByRoot(test)) {
      rootEvents.add(test);
    }
    runningTests.add(test);
    markActivity();
  },
  end(test: object) {
    runningTests.delete(test);
    if (rootEvents.has(test)) {
      fileFinished = true;
    }
    markActivity();
  },
});

// Setup that may still run after its test's teardown, because a node:test timeout or
// cancellation does not stop a test's body: the label it is logged by, and when the exit stops
// waiting for it. The exit waits for it to reach its next cleanup registration, where it is
// stopped, so setup must register an idempotent rollback for each acquisition before it starts
// the next one, and run its acquisitions one at a time: a parallel branch's acquisition still in
// flight when another branch is stopped is not waited for. Setup that ends without registering
// again holds a pending exit to its limit, while anything else holds the process.
const unsettledSetups = new Map<(cleanup: Cleanup) => void, UnsettledSetup>();
// Set while a cleanup runs, so one that registers another is not taken for setup.
const runningCleanup = new AsyncLocalStorage<true>();

function setupsSettled(now: number) {
  for (const [setup, { label, limitMs, deadline, log }] of unsettledSetups) {
    if (now < deadline) {
      return false;
    }
    log(`${label}: setup still ran ${limitMs} ms after its test ended; exiting without it`);
    unsettledSetups.delete(setup);
  }
  return true;
}

// Resolves once the file's tests, root hooks, late cleanups and timed-out setups have all finished
// (a setup within its limit) and nothing has run for `quietMs`. An abandoned cleanup then ends the
// process after the file's last test, not under the next one (finding 1723), and not under setup
// that has yet to register a cleanup for what it holds. A later test that hangs holds the file to
// its own timeout, or the runner's. The poll is unref'd, so it never holds the process itself.
async function testsSettled(quietMs: number) {
  for (;;) {
    const now = performance.now();
    const idle =
      runningTests.size === 0 &&
      lateCleanupsRunning === 0 &&
      (fileFinished || !testEventsSeen) &&
      setupsSettled(now);
    const quietFor = now - lastActivity;
    if (idle && quietFor >= quietMs) {
      return;
    }
    await delay(idle ? quietMs - quietFor : Math.min(quietMs, 1_000), undefined, { ref: false });
  }
}

// The teardown boundedTeardown made first for each node:test context, so every caller and helper
// given that context shares it, and the contexts it returned, so a helper does not nest a second
// teardown inside one.
const teardownFor = new WeakMap<TeardownContext, Teardown<TeardownContext>>();
const boundedContexts = new WeakSet<TeardownContext>();

function registrationSite(stack: string | undefined) {
  // Frame 0 is the message, 1 is `after` here, 2 is its caller.
  const frame = String(stack).split("\n")[2] ?? "";
  const [, path, line] = /\(?([^\s()]+):(\d+):\d+\)?$/.exec(frame.trim()) ?? [];
  return path === undefined || line === undefined
    ? "an unknown line"
    : `${path.split("/").at(-1)}:${line}`;
}

function formatCleanupError(error: unknown): string {
  try {
    const box: (value: unknown) => object = Object;
    const message: unknown =
      error === null || error === undefined ? undefined : Reflect.get(box(error), "message", error);
    return String(message ?? error);
  } catch {
    return "unprintable thrown value";
  }
}

export function boundedTeardown<Context extends TeardownContext>(
  testContext: Context,
  options?: TeardownOptions,
): Teardown<BoundedContext<Context>>;
export function boundedTeardown(
  testContext: TeardownContext,
  {
    label = "teardown",
    stepLimitMs = teardownStepLimitMs,
    exitGraceMs = abandonedTeardownExitGraceMs,
    log = (message) => process.stderr.write(`${message}\n`),
    // The exit follows a failure, so its code is a failure's.
    exit = () => process.exit(process.exitCode || 1),
    // Fails the file once its test has been reported, should the process still end by itself.
    failFile = () => {
      process.exitCode ||= 1;
    },
    settled = testsSettled,
    onOutcome,
  }: TeardownOptions = {},
): Teardown<TeardownContext> {
  // A second call for one context, in either order with withBoundedTeardown, shares the first
  // teardown, so all their cleanups keep one newest-first order (finding 1725); its options apply.
  const existing = teardownFor.get(testContext);
  if (existing !== undefined) {
    return existing;
  }
  const cleanups: CleanupStep[] = [];
  let started = false;
  let finished = false;
  let exiting = false;
  // Late cleanups waiting to run, drained newest-first like the teardown.
  const late: CleanupStep[] = [];
  // Whether this teardown's queue has a drainer; the file-wide count only decides the exit.
  let drainingLate = false;
  const endProcess = (reason: string) => {
    log(`${label}: exiting once the file's tests settle for ${exitGraceMs} ms; ${reason}`);
    markActivity();
    if (!exiting) {
      exiting = true;
      // node:test reports the test once its hook returns.
      settled(exitGraceMs).then(exit);
    }
  };
  // Runs one cleanup within the limit. Resolves to its error, if any, and whether it was left
  // running.
  const run = async ({ cleanup, site }: CleanupStep) => {
    log(`${label}: cleanup ${site}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;
    try {
      await Promise.race([
        runningCleanup.run(true, () => Promise.resolve().then(cleanup)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abandoned = true;
            reject(new Error(`did not finish within ${stepLimitMs} ms`));
          }, stepLimitMs);
        }),
      ]);
      return { abandoned };
    } catch (error) {
      const message = formatCleanupError(error);
      log(`${label}: cleanup ${site} failed: ${message}`);
      return {
        abandoned,
        error: new Error(`cleanup ${site}: ${message}`, { cause: error }),
      };
    } finally {
      clearTimeout(timer);
    }
  };
  const after = (cleanup: Cleanup) => {
    // A named cleanup is logged by its name too.
    const site = `registered at ${registrationSite(new Error().stack)}`;
    const step = { cleanup, site: cleanup?.name ? `${cleanup.name} ${site}` : site };
    if (!finished) {
      cleanups.push(step);
      return;
    }
    // A node:test timeout fails the test and runs its hooks but does not stop its body, so setup
    // can register a cleanup (a worker stop) after the teardown ran (finding 1722). Run it now,
    // bounded, fail the file and end the process: the test has been reported. Then stop the setup
    // by throwing to it, so it starts nothing more that no cleanup would undo.
    log(`${label}: cleanup ${step.site} came after the teardown ran; running it now`);
    lateCleanupsRunning += 1;
    late.push(step);
    // Registrations in the same turn (a cleanup list) all queue before the first runs, and one
    // a running cleanup makes runs next.
    if (!drainingLate) {
      drainingLate = true;
      queueMicrotask(async () => {
        for (let next = late.pop(); next !== undefined; next = late.pop()) {
          try {
            await run(next);
          } finally {
            lateCleanupsRunning -= 1;
            markActivity();
          }
          failFile();
          endProcess(`cleanup ${next.site} came after its test's teardown`);
        }
        drainingLate = false;
      });
    }
    // A cleanup may register another, as during the teardown; only setup is stopped. The flag
    // also reaches listeners a cleanup triggers synchronously, so setup must not go on in one.
    if (runningCleanup.getStore() !== true) {
      unsettledSetups.delete(after);
      throw new Error(
        `${label}: setup outlived its test; cleanup ${step.site} runs now and setup stops here`,
      );
    }
  };
  testContext.after(async () => {
    started = true;
    const failures: Error[] = [];
    const abandoned: string[] = [];
    // A cleanup may register another; it runs next.
    for (let step = cleanups.pop(); step !== undefined; step = cleanups.pop()) {
      const result = await run(step);
      if (result.abandoned) {
        abandoned.push(step.site);
      }
      if (result.error !== undefined) {
        failures.push(result.error);
      }
    }
    finished = true;
    // A timed-out or cancelled test's signal aborts before its hooks run; its setup may still run.
    // An exit waits for it to reach its next cleanup registration, where it stops, within the limit.
    // The exit then also bounds that setup, should it hold the process (finding 1722).
    const aborted = testContext.signal?.aborted === true;
    if (aborted) {
      const deadline = performance.now() + stepLimitMs;
      unsettledSetups.set(after, { label, limitMs: stepLimitMs, deadline, log });
      endProcess("its test timed out or was cancelled with setup that may still run");
    }
    if (abandoned.length > 0) {
      endProcess(`abandoned cleanups ${abandoned.join(", ")}`);
    }
    // An aborted test may still register late cleanup after this hook.
    onOutcome?.(failures.length > 0 ? "failed" : aborted ? "incomplete" : "passed");
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `${label}: ${failures.length} cleanups failed`);
    }
  });
  const context = new Proxy(testContext, {
    get(target, property): unknown {
      if (property === "after") {
        return after;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  boundedContexts.add(context);
  const teardown = {
    context,
    // Whether teardown has begun, for failure diagnostics.
    get started() {
      return started;
    },
  };
  teardownFor.set(testContext, teardown);
  return teardown;
}

// A helper that registers several cleanups gets them run newest-first and bounded whatever context
// its caller passes: a raw node:test context gets its one bounded teardown, shared with every other
// helper and caller given that context, and one from boundedTeardown is used as is.
export function withBoundedTeardown<Context extends TeardownContext>(
  testContext: Context,
  options?: TeardownOptions,
): BoundedContext<Context>;
export function withBoundedTeardown(
  testContext: TeardownContext,
  options?: TeardownOptions,
): TeardownContext {
  return boundedContexts.has(testContext)
    ? testContext
    : boundedTeardown(testContext, options).context;
}
