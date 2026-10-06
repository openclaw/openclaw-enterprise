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

for (const outcome of ["commit", "rollback", "unknown"]) {
  test(`IAM work escaped from a ${outcome} transaction cannot acquire another client`, async () => {
    const calls = [];
    const releases = [];
    let connects = 0;
    let resume;
    const later = new Promise((resolve) => {
      resume = resolve;
    });
    const state = new PostgresPlatformState({
      async connect() {
        connects += 1;
        return {
          async query(statement) {
            calls.push(statement);
            if (statement === "COMMIT" && outcome === "unknown") {
              throw Object.assign(new Error("lost response"), { code: "ETIMEDOUT" });
            }
            return { command: statement, rows: [], rowCount: 0 };
          },
          release(discard) {
            releases.push(discard);
          },
        };
      },
      async end() {},
    });
    let escaped;
    const operation = state.transact(async () => {
      // A descendant keeps the original async context after its owner settles.
      escaped = later.then(() => state.loadNativeIAMState());
      if (outcome === "rollback") {
        throw new Error("business rejection");
      }
    });
    if (outcome === "commit") {
      await operation;
    } else {
      await assert.rejects(
        operation,
        outcome === "unknown"
          ? { name: "PostgresCommitOutcomeUnknownError" }
          : /business rejection/,
      );
    }
    const rejected = assert.rejects(escaped, /platform transaction is closed/);
    resume();
    await rejected;
    assert.equal(connects, 1);
    assert.deepEqual(calls, ["BEGIN", outcome === "rollback" ? "ROLLBACK" : "COMMIT"]);
    assert.deepEqual(releases, [outcome === "unknown"]);
  });
}

// pg's client-side query_timeout leaves the statement running on the connection; any later
// statement on it (including ROLLBACK) would queue behind it until the same timeout again.
for (const abandonedStatement of ["BEGIN", "SELECT"]) {
  test(`a ${abandonedStatement} abandoned by the client query timeout discards the connection`, async () => {
    const calls = [];
    const releases = [];
    const client = {
      on() {},
      removeListener() {},
      async query(statement) {
        calls.push(statement);
        if (statement === abandonedStatement) {
          throw new Error("Query read timeout");
        }
        if (statement === "BEGIN") {
          return { command: "BEGIN", rows: [], rowCount: 0 };
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
      timer = setTimeout(() => reject(new Error("the abandoned statement did not settle")), 1000);
    });
    try {
      await assert.rejects(
        Promise.race([
          state.transact((unit) => state.queryInTransaction(unit, "SELECT")),
          deadline,
        ]),
        (error) => !(error instanceof PostgresCommitOutcomeUnknownError),
      );
      assert.deepEqual(calls, abandonedStatement === "BEGIN" ? ["BEGIN"] : ["BEGIN", "SELECT"]);
      assert.deepEqual(releases, [true]);
    } finally {
      clearTimeout(timer);
    }
  });
}
