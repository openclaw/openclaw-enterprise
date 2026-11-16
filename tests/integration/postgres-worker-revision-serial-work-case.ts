import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import { setTimeout as delay } from "node:timers/promises";
import { waitFor } from "../helpers/wait-for.mjs";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

type Setup = ReturnType<typeof createWorkerRevisionFixtures>["setup"];

// Runs a test's steps within `budgetMs`, kept under the test's own timeout. Each step waits only
// for what is left of the budget, so a step that never ends fails by name, with the steps before
// it, their times, and `describe()`, instead of the test timeout naming nothing (finding 1945).
// A step's own failure (a waitFor limit or an assertion) keeps its message and gains the same.
function stepBudget(budgetMs: number, describe: () => string) {
  const started = Date.now();
  const done: string[] = [];
  const where = (name: string, stepStarted: number) => {
    return [
      `step "${name}" after ${Date.now() - stepStarted} ms (${Date.now() - started} ms into the budget)`,
      `earlier steps: ${done.length > 0 ? done.join(", ") : "none"}`,
      describe(),
    ].join("; ");
  };
  return async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
    const stepStarted = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let budgetError: Error | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          budgetError = new Error(
            `Timed out within the ${budgetMs} ms step budget at ${where(name, stepStarted)}.`,
          );
          reject(budgetError);
        },
        Math.max(0, started + budgetMs - stepStarted),
      );
    });
    try {
      const value = await Promise.race([Promise.resolve().then(run), expired]);
      done.push(`${name} ${Date.now() - stepStarted} ms`);
      return value;
    } catch (error) {
      if (error === budgetError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} (${where(name, stepStarted)})`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  };
}

// The worker is serial. A Compute wait that only saves a later pass asks whether
// other Work is waiting and ends early when it is, so another Agent's deploy
// runs next instead of queuing behind the wait (D221).
export async function yieldSerialWorkToOtherAgent(context: TestContext, setup: Setup) {
  const { computeWorkWaiting } =
    await import("../../apps/controller/src/drivers/compute/operation-context.ts");
  // Where the first Agent's pass is, for a step that runs out of time.
  let pass = "not started";
  const step = stepBudget(27_000, () => `first pass: ${pass}`);
  const fixture = await step("revision fixture setup", () => setup(context));
  const first = await step("the first Agent's creation", () =>
    fixture.agent("waiting-first", { executionMode: "dedicated" }),
  );
  const second = await step("the second Agent's creation", () =>
    fixture.agent("waiting-second", { executionMode: "dedicated" }),
  );
  const prepared: string[] = [];
  let admittedSecond: Awaited<ReturnType<typeof fixture.revision>> | undefined;
  let wait: { before: boolean; endedEarly: boolean; ms: number } | undefined;
  const compute: ComputeDriver = {
    ...fixture.compute,
    async prepareRevision(revision, deploymentContext) {
      prepared.push(revision.agentId);
      if (revision.agentId !== first.id || wait !== undefined) {
        return fixture.compute.prepareRevision(revision, deploymentContext);
      }
      // The first Agent's pass waits, as for its node to pair; nothing else is
      // queued yet, so nothing is waiting for the worker.
      pass = "asking whether Work waits before the second Agent's revision";
      const before = await computeWorkWaiting();
      pass = "admitting the second Agent's revision";
      admittedSecond = await fixture.revision(second, 1);
      const started = Date.now();
      let endedEarly = false;
      let checks = 0;
      while (Date.now() - started < 10_000) {
        checks += 1;
        pass = `waiting for other Work (check ${checks}, ${Date.now() - started} ms)`;
        if (await computeWorkWaiting()) {
          endedEarly = true;
          break;
        }
        await delay(25);
      }
      wait = { before, endedEarly, ms: Date.now() - started };
      pass = `preparing after a ${wait.ms} ms wait (ended early: ${endedEarly})`;
      const result = {
        ...(await fixture.compute.prepareRevision(revision, deploymentContext)),
        ready: false,
      };
      pass = `ended pending after a ${wait.ms} ms wait (ended early: ${endedEarly})`;
      return result;
    },
  };
  await step("worker start", () => fixture.start(compute));
  const firstRevision = await step("the first Agent's revision admission", () =>
    fixture.revision(first, 1),
  );
  const secondRevision = await step("the second Agent's revision during the first pass", () =>
    waitFor("the second Agent to deploy during the first pass", async () => admittedSecond),
  );
  await step("the second Agent's Work to succeed", () => fixture.work(secondRevision, "succeeded"));
  await step("the first Agent's Work to succeed", () => fixture.work(firstRevision, "succeeded"));
  assert.ok(wait, "the first pass recorded its wait for other Work");
  assert.equal(wait.before, false, "the pass's own Agent is not other Work");
  assert.equal(wait.endedEarly, true);
  assert.ok(wait.ms < 5_000, `the wait ended early (${wait.ms} ms)`);
  // The pending first pass ended and the second Agent's pass ran next.
  assert.deepEqual(prepared.slice(0, 2), [first.id, second.id]);
}
