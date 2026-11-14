import assert from "node:assert/strict";
import test from "node:test";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
  type PersistedNativeIAMState,
  type PostgresClient,
  type PostgresPool,
} from "../../packages/occ/src/state/postgres-state.ts";
import { within } from "../helpers/wait-for.mjs";

type QueryResult = Awaited<ReturnType<PostgresClient["query"]>> & { command: string };

function transactionFixture(query: (statement: string) => Promise<QueryResult>) {
  const calls: string[] = [];
  const releases: Array<boolean | undefined> = [];
  const client: PostgresClient = {
    async query(statement) {
      calls.push(statement);
      return query(statement);
    },
    release(discard) {
      releases.push(discard);
    },
  };
  let connects = 0;
  const pool: PostgresPool = {
    async connect() {
      connects += 1;
      return client;
    },
    async end() {},
  };
  return {
    state: new PostgresPlatformState(pool),
    calls,
    releases,
    get connects() {
      return connects;
    },
  };
}

async function acknowledgeBeginOrHangRollback(statement: string): Promise<QueryResult> {
  if (statement === "BEGIN") {
    return { command: "BEGIN", rows: [], rowCount: 0 };
  }
  if (statement === "ROLLBACK") {
    return new Promise(() => {});
  }
  throw new Error("Unexpected query");
}

// Inject a protocol fault through the transaction owner's PostgreSQL client.
test("lost COMMIT response returns unknown without waiting for a hung rollback", async () => {
  const { state, calls, releases } = transactionFixture(async (statement) => {
    if (statement === "COMMIT") {
      throw Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
    }
    return acknowledgeBeginOrHangRollback(statement);
  });
  await assert.rejects(
    within(
      state.transact(async () => 1),
      "unknown outcome did not settle",
      1_000,
    ),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(calls, ["BEGIN", "COMMIT"]);
  assert.deepEqual(releases, [true]);
});

for (const outcome of ["commit", "rollback", "unknown"]) {
  test(`IAM work escaped from a ${outcome} transaction cannot acquire another client`, async () => {
    const fixture = transactionFixture(async (statement) => {
      if (statement === "COMMIT" && outcome === "unknown") {
        throw Object.assign(new Error("lost response"), { code: "ETIMEDOUT" });
      }
      return { command: statement, rows: [], rowCount: 0 };
    });
    const { state, calls, releases } = fixture;
    const { promise: later, resolve: resume } = Promise.withResolvers<void>();
    let escaped: Promise<PersistedNativeIAMState> | undefined;
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
        outcome === "unknown" ? PostgresCommitOutcomeUnknownError : /business rejection/,
      );
    }
    assert.ok(escaped);
    const rejected = assert.rejects(escaped, /platform transaction is closed/);
    resume();
    await rejected;
    assert.equal(fixture.connects, 1);
    assert.deepEqual(calls, ["BEGIN", outcome === "rollback" ? "ROLLBACK" : "COMMIT"]);
    assert.deepEqual(releases, [outcome === "unknown"]);
  });
}

// pg's client-side query_timeout leaves the statement running on the connection; any later
// statement on it (including ROLLBACK) would queue behind it until the same timeout again.
for (const abandonedStatement of ["BEGIN", "SELECT"]) {
  test(`a ${abandonedStatement} abandoned by the client query timeout discards the connection`, async () => {
    const { state, calls, releases } = transactionFixture(async (statement) => {
      if (statement === abandonedStatement) {
        throw new Error("Query read timeout");
      }
      return acknowledgeBeginOrHangRollback(statement);
    });
    await assert.rejects(
      within(
        state.transact((unit) => state.queryInTransaction(unit, "SELECT")),
        "the abandoned statement did not settle",
        1_000,
      ),
      {
        name: DependencyUnavailableError.name,
        message: "The platform persistence query timeout expired.",
      },
    );
    assert.deepEqual(calls, abandonedStatement === "BEGIN" ? ["BEGIN"] : ["BEGIN", "SELECT"]);
    assert.deepEqual(releases, [true]);
  });
}
