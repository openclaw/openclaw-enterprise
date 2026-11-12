import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { redactQaError } from "./qa-secrets.mjs";

export function createQaReport(path, metadata) {
  const outcomes = [];
  let writing = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify({ ...metadata, outcomes }, null, 2) + "\n";
    // Workers finish independently. Serialize immutable snapshots and publish
    // each complete file atomically so observers never see partial JSON. A
    // failed write is reported only to its own caller; later snapshots still run.
    writing = writing
      .catch(() => {})
      .then(async () => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, snapshot, { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    return writing;
  }
  async function stage(parent, cell, name, work, scenario, { reportCleanup = false } = {}) {
    let value;
    await parent.test(name, { timeout: 1_800_000 }, async (context) => {
      const start = performance.now();
      const outcome = {
        cell,
        ...(scenario ? { scenario } : {}),
        stage: name,
        startedAt: new Date().toISOString(),
      };
      const finish = async () => {
        outcome.durationMs = Math.round(performance.now() - start);
        // A cancelled body's late completion must not mutate an already published row.
        outcomes.push(reportCleanup ? { ...outcome } : outcome);
        await save();
      };
      let workContext = context;
      let workPromise;
      if (reportCleanup) {
        const { boundedTeardown, teardownStepLimitMs } = await import("./bounded-teardown.ts");
        let cleanupOutcome = "incomplete";
        // Observe the existing teardown's one final hook; do not create another
        // cleanup queue or change the native fixture's reverse registration order.
        const owner = new Proxy(context, {
          get(target, property) {
            if (property === "after") {
              return (hook) =>
                target.after(async () => {
                  let cleanupError;
                  let retained = false;
                  try {
                    // Cancellation starts after-hooks before the test body necessarily
                    // settles. Do not dispose dependencies under an in-flight mutation.
                    let timer;
                    let settled;
                    try {
                      settled = await Promise.race([
                        workPromise.then(
                          () => true,
                          () => true,
                        ),
                        new Promise((resolve) => {
                          timer = setTimeout(() => resolve(false), teardownStepLimitMs);
                        }),
                      ]);
                    } finally {
                      clearTimeout(timer);
                    }
                    if (!settled) {
                      retained = true;
                      throw new Error(
                        `QA work did not settle within ${teardownStepLimitMs} ms; cleanup retained`,
                      );
                    }
                    await hook();
                  } catch (thrown) {
                    cleanupError = redactQaError(thrown);
                    cleanupOutcome = retained ? "incomplete" : "failed";
                    throw cleanupError;
                  } finally {
                    if (!outcome.assertions || context.signal.aborted) {
                      outcome.assertions =
                        outcome.assertions && outcome.assertions.outcome !== "passed"
                          ? outcome.assertions
                          : {
                              outcome: "incomplete",
                              reason: "QA stage cancelled before completion",
                            };
                    }
                    outcome.cleanup = {
                      outcome: cleanupOutcome,
                      ...(cleanupError === undefined
                        ? {}
                        : {
                            reason: String(cleanupError?.message ?? cleanupError),
                          }),
                    };
                    outcome.outcome =
                      outcome.assertions.outcome === "passed" && cleanupOutcome === "passed"
                        ? "passed"
                        : "failed";
                    const reasons = [outcome.assertions.reason, outcome.cleanup.reason].filter(
                      Boolean,
                    );
                    if (reasons.length > 0) {
                      outcome.reason = reasons.join("; ");
                    }
                    await finish();
                  }
                });
            }
            const result = Reflect.get(target, property, target);
            return typeof result === "function" ? result.bind(target) : result;
          },
        });
        workContext = boundedTeardown(owner, {
          label: `${name} teardown`,
          onOutcome: (result) => {
            cleanupOutcome = result;
          },
        }).context;
      }
      try {
        if (reportCleanup) {
          workPromise = Promise.resolve().then(() => {
            workContext.signal.throwIfAborted();
            return work(workContext);
          });
          value = await workPromise;
        } else {
          value = await work(workContext);
        }
        if (reportCleanup) {
          outcome.assertions = { outcome: "passed" };
        } else {
          outcome.outcome = "passed";
        }
      } catch (thrown) {
        // A replacement error when the original's text can't be redacted in place.
        const error = redactQaError(thrown);
        // A thrown non-Error (a string, undefined) still gets a reason.
        const reason = String(error?.message ?? error);
        const result = /blocked by/.test(reason) ? "blocked" : "failed";
        if (reportCleanup) {
          outcome.assertions = { outcome: result, reason };
        } else {
          outcome.outcome = result;
          outcome.reason = reason;
        }
        throw error;
      } finally {
        if (!reportCleanup) {
          await finish();
        }
      }
    });
    return value;
  }
  return { stage, save };
}
