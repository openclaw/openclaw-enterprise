import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";

// This is a protocol fault at the actual transaction owner, not a database test.
test("lost COMMIT response returns unknown without waiting for a hung rollback", async () => {
  const calls = [];
  const releases = [];
  const client = {
    on() {},
    removeListener() {},
    async query(statement) {
      calls.push(statement);
      if (statement === "BEGIN") {
        return { command: "BEGIN", rows: [], rowCount: 0 };
      }
      if (statement === "COMMIT") {
        throw Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
      }
      if (statement === "ROLLBACK") {
        return new Promise(() => {});
      }
      throw new Error("Unexpected query");
    },
    release(discard) {
      releases.push(discard);
    },
  };
  const state = new PostgresPlatformState({
    async connect() {
      return client;
    },
    async end() {},
  });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("unknown outcome did not settle")), 1000);
  });
  try {
    await assert.rejects(
      Promise.race([state.transact(async () => 1), deadline]),
      PostgresCommitOutcomeUnknownError,
    );
    assert.deepEqual(calls, ["BEGIN", "COMMIT"]);
    assert.deepEqual(releases, [true]);
  } finally {
    clearTimeout(timer);
  }
});
