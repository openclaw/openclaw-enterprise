import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";

// A transport protocol fixture for the actual outer owner, not a SQL database
// emulator. No repository reads/writes, authentication, custody or PG evidence.
function protocol({ commit, release, removeListener } = {}) {
  const calls = [];
  let releases = 0;
  let transportListener;
  const client = {
    on(event, listener) {
      if (event === "error") {
        transportListener = listener;
      }
    },
    removeListener() {
      removeListener?.();
    },
    async query(statement) {
      calls.push(statement);
      if (statement === "COMMIT") {
        return commit ? commit() : { command: "COMMIT", rows: [], rowCount: 0 };
      }
      if (statement === "ROLLBACK") {
        return { command: "ROLLBACK", rows: [], rowCount: 0 };
      }
      if (statement === "BEGIN" || statement.startsWith("BEGIN ISOLATION")) {
        return { command: "", rows: [], rowCount: 0 };
      }
      throw new Error("This fixture does not simulate persistence queries.");
    },
    release(destroy) {
      releases++;
      release?.(destroy);
    },
  };
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      return client;
    },
    async end() {},
  });
  return {
    state,
    calls,
    releases: () => releases,
    emitTransportError: (error) => transportListener?.(error),
  };
}

function serverError(code) {
  return Object.assign(new pg.DatabaseError("server rejection", 0, "error"), { code });
}

test("known outer acknowledgment returns the original value after cleanup", async () => {
  const p = protocol();
  const value = Object.freeze({ result: "unchanged" });
  assert.equal(await p.state.transact(async () => value), value);
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(p.releases(), 1);
});

test("definite server rejection at COMMIT remains a known no-commit failure", async () => {
  const p = protocol({
    commit: () => {
      throw serverError("23514");
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    ScopeViolationError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
});

test("serialization failure at COMMIT rolls back as a definite failure", async () => {
  const failure = serverError("40001");
  let discarded;
  const p = protocol({
    commit: () => {
      throw failure;
    },
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    (error) => error === failure,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.equal(discarded, false);
});

test("a client error with a server-looking code leaves COMMIT unknown", async () => {
  let discarded;
  const p = protocol({
    commit: () => {
      throw Object.assign(new Error("client failure"), { code: "23514" });
    },
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(discarded, true);
});

test("a transport failure during COMMIT leaves even a server-looking rejection unknown", async () => {
  let discarded;
  const p = protocol({
    commit: () => {
      p.emitTransportError(new Error("transport failure"));
      throw serverError("40001");
    },
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(discarded, true);
});

test("a known-bad client is discarded without attempting pre-COMMIT rollback", async () => {
  let discarded;
  const failure = new Error("transport failure");
  const p = protocol({
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => {
      p.emitTransportError(failure);
    }),
    (error) => error === failure,
  );
  assert.deepEqual(p.calls, ["BEGIN"]);
  assert.equal(discarded, true);
});

test("lost acknowledgment remains unknown without a follow-up query", async () => {
  const p = protocol({
    commit: () => {
      throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
});

test("40003 statement completion unknown does not issue a follow-up query", async () => {
  let discarded;
  const p = protocol({
    commit: () => {
      throw serverError("40003");
    },
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(discarded, true);
});

test("an unclassified valid SQLSTATE does not establish no commit", async () => {
  let discarded;
  const p = protocol({
    commit: () => {
      throw serverError("XX000");
    },
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(discarded, true);
});

test("actual ROLLBACK command acknowledgment establishes no commit", async () => {
  const p = protocol({ commit: () => ({ command: "ROLLBACK", rows: [], rowCount: 0 }) });
  await assert.rejects(
    p.state.transact(async () => 1),
    (error) =>
      error instanceof DependencyUnavailableError &&
      !(error instanceof PostgresCommitOutcomeUnknownError),
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
});

test("unrecognized acknowledgment does not establish rollback", async () => {
  let discarded;
  const p = protocol({
    commit: () => ({ rows: [], rowCount: 0 }),
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(discarded, true);
});

test("a throwing acknowledgment projection remains unknown even with a definite SQLSTATE", async () => {
  let discarded;
  const p = protocol({
    commit: () => ({
      get command() {
        throw Object.assign(new Error("invalid acknowledgment"), { code: "40001" });
      },
    }),
    release: (destroy) => {
      discarded = destroy;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(discarded, true);
});

test("release failure after acknowledged COMMIT is unknown and cleanup continues", async () => {
  let detached = false;
  const p = protocol({
    release: () => {
      throw new Error("release failed");
    },
    removeListener: () => {
      detached = true;
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.equal(detached, true);
  assert.equal(p.releases(), 1);
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
});

test("cleanup failure cannot replace an earlier callback failure", async () => {
  const failure = new Error("original callback failure");
  const p = protocol({
    release: () => {
      throw new Error("cleanup failure");
    },
  });
  await assert.rejects(
    p.state.transact(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(p.calls, ["BEGIN", "ROLLBACK"]);
});

test("commit fault URL routes the actual pg client through the proxy", async () => {
  const original =
    "postgresql://fixture:fixture@127.0.0.1:1/example?host=127.0.0.1&port=55432&user=override&password=override&application_name=commit-fixture&sslmode=disable";
  const before = new pg.Client({ connectionString: original });
  const proxy = await commitAckProxy(original);
  try {
    const routed = new URL(proxy.url);
    const client = new pg.Client({ connectionString: proxy.url });
    assert.equal(client.host, "127.0.0.1");
    assert.equal(client.port, Number(routed.port));
    assert.equal(routed.searchParams.has("host"), false);
    assert.equal(routed.searchParams.has("port"), false);
    assert.equal(client.user, before.user);
    assert.equal(client.password, before.password);
    assert.equal(client.database, before.database);
    assert.equal(client.ssl, before.ssl);
    assert.equal(routed.searchParams.get("application_name"), "commit-fixture");
  } finally {
    await proxy.close();
  }
});

test("commit fault rejects an effective remote override and preserves TLS intent", async () => {
  await assert.rejects(
    commitAckProxy(
      "postgresql://fixture:fixture@127.0.0.1/example?host=remote.invalid&sslmode=disable",
    ),
    /loopback/,
  );
  await assert.rejects(
    commitAckProxy("postgresql://fixture:fixture@127.0.0.1/example?ssl=true"),
    /non-TLS/,
  );
});
