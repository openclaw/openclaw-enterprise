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
  async function stage(parent, cell, name, work, scenario) {
    let value;
    await parent.test(name, { timeout: 1_800_000 }, async () => {
      const start = performance.now();
      const outcome = {
        cell,
        ...(scenario ? { scenario } : {}),
        stage: name,
        startedAt: new Date().toISOString(),
      };
      try {
        value = await work();
        outcome.outcome = "passed";
      } catch (error) {
        redactQaError(error);
        outcome.outcome = /blocked by/.test(error.message) ? "blocked" : "failed";
        outcome.reason = error.message;
        throw error;
      } finally {
        outcome.durationMs = Math.round(performance.now() - start);
        outcomes.push(outcome);
        await save();
      }
    });
    return value;
  }
  return { stage, save };
}
