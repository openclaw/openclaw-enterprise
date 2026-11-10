import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";

export class RecordingContext {
  #name = "recorded test";
  readonly hooks: Array<() => Promise<void>> = [];

  get name() {
    return this.#name;
  }

  diagnostic(message: string) {
    return `${this.#name}: ${message}`;
  }

  after(hook: () => Promise<void>) {
    this.hooks.push(hook);
  }
}

export function recordTeardown(
  options: Parameters<typeof boundedTeardown>[1] = {},
  events: string[] = [],
) {
  const testContext = new RecordingContext();
  const logs: string[] = [];
  const teardown = boundedTeardown(testContext, {
    ...options,
    log: (message) => logs.push(message),
    exit: () => {
      events.push("exit");
      return options.exit?.();
    },
  });
  return { testContext, teardown, logs, events };
}

export const shortTeardownOptions = {
  stepLimitMs: 50,
  exitGraceMs: 10,
  // The test is still running; the stand-in waits for the grace period.
  settled: (quietMs: number) => delay(quietMs),
};

export function registerBoundedTeardownRejectionCases() {
  test(
    "a bounded teardown reports a Symbol rejection and runs older cleanup",
    { timeout: 5_000 },
    async () => {
      const rejection = Symbol("role delete rejected");
      const outcomes: string[] = [];
      const {
        testContext,
        teardown,
        logs,
        events: exits,
      } = recordTeardown({
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      const ran: string[] = [];
      teardown.context.after(() => ran.push("namespace delete"));
      teardown.context.after(async () => {
        ran.push("role delete");
        throw rejection;
      });

      const [hook] = testContext.hooks;
      assert.ok(hook);
      await assert.rejects(hook(), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, rejection);
        assert.match(
          error.message,
          /^cleanup registered at kubernetes-teardown-cases\.ts:\d+: Symbol\(role delete rejected\)$/,
        );
        return true;
      });
      assert.deepEqual(ran, ["role delete", "namespace delete"]);
      assert.ok(
        logs.some((line) =>
          /^teardown: cleanup registered at kubernetes-teardown-cases\.ts:\d+ failed: Symbol\(role delete rejected\)$/.test(
            line,
          ),
        ),
      );
      assert.deepEqual(outcomes, ["failed"]);
      assert.deepEqual(exits, []);
    },
  );

  test(
    "late cleanup continues after a Symbol rejection and exits after both cleanups",
    { timeout: 2_000 },
    async () => {
      const rejection = Symbol("late cleanup rejected");
      const events: string[] = [];
      const exited = Promise.withResolvers<void>();
      const { testContext, teardown, logs } = recordTeardown(
        { ...shortTeardownOptions, failFile: () => events.push("fail"), exit: exited.resolve },
        events,
      );
      const { context } = teardown;
      const [hook] = testContext.hooks;
      assert.ok(hook);
      await hook();

      const stopsSetup =
        /^teardown: setup outlived its test; cleanup registered at kubernetes-teardown-cases\.ts:\d+ runs now and setup stops here$/;
      assert.throws(() => context.after(() => events.push("older cleanup")), {
        message: stopsSetup,
      });
      assert.throws(
        () =>
          context.after(async () => {
            events.push("rejecting cleanup");
            throw rejection;
          }),
        { message: stopsSetup },
      );

      await exited.promise;
      assert.deepEqual(events, ["rejecting cleanup", "fail", "older cleanup", "fail", "exit"]);
      assert.ok(
        logs.some((line) =>
          /^teardown: cleanup registered at kubernetes-teardown-cases\.ts:\d+ failed: Symbol\(late cleanup rejected\)$/.test(
            line,
          ),
        ),
      );
    },
  );
}
