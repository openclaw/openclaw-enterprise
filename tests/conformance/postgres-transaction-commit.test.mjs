import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

// A transport protocol fixture for the actual outer owner, not a SQL database
// emulator. No repository reads/writes, authentication, custody or PG evidence.
function protocol({ on, begin, commit, query, release, removeListener } = {}) {
  const calls = [];
  let releases = 0;
  let transportListener;
  const client = {
    on(event, listener) {
      if (event === "error") {
        transportListener = listener;
        on?.(listener);
      }
    },
    removeListener(event, listener) {
      removeListener?.(event, listener);
      if (event === "error" && listener === transportListener) {
        transportListener = undefined;
      }
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
        return begin ? begin() : { command: "", rows: [], rowCount: 0 };
      }
      if (query) {
        return query(statement);
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
    hasTransportListener: () => transportListener !== undefined,
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
    (error) => error instanceof DependencyUnavailableError && /conflict/.test(error.message),
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.equal(discarded, false);
});

for (const code of ["40P01", "40001"]) {
  test(`transaction conflict ${code} in a statement is retryable unavailability`, async () => {
    const p = protocol({
      query: () => {
        throw serverError(code);
      },
    });
    const rejection = await p.state
      .transact(async (unit) => unit.audit.list())
      .then(
        () => assert.fail("expected the statement rejection"),
        (error) => error,
      );
    assert.ok(rejection instanceof DependencyUnavailableError);
    assert.match(rejection.message, /conflict/);
    assert.deepEqual(p.calls.at(-1), "ROLLBACK");
    const response = requestFailure(rejection);
    assert.equal(response.status, 503);
    assert.equal(response.code, "DEPENDENCY_UNAVAILABLE");
  });
}

for (const [name, failure] of [
  ["DNS ENOTFOUND", Object.assign(new Error("getaddrinfo ENOTFOUND db"), { code: "ENOTFOUND" })],
  ["DNS EAI_AGAIN", Object.assign(new Error("getaddrinfo EAI_AGAIN db"), { code: "EAI_AGAIN" })],
  ["EHOSTUNREACH", Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" })],
  ["a password callback failure", new Error("workload identity token request failed")],
  ["a rejected credential", serverError("28P01")],
]) {
  test(`a connection checkout failure from ${name} is unavailable`, async () => {
    const state = new PostgresPlatformState({
      options: { connectionTimeoutMillis: 100 },
      async connect() {
        throw failure;
      },
      async end() {},
    });
    let ran = false;
    const rejection = await state
      .transact(async () => {
        ran = true;
      })
      .then(
        () => assert.fail("expected the checkout failure"),
        (error) => error,
      );
    assert.equal(ran, false);
    assert.ok(rejection instanceof DependencyUnavailableError);
    const response = requestFailure(rejection);
    assert.equal(response.status, 503);
    assert.equal(response.code, "DEPENDENCY_UNAVAILABLE");
  });
}

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
    DependencyUnavailableError,
  );
  assert.deepEqual(p.calls, ["BEGIN"]);
  assert.equal(discarded, true);
});

test("observed client error during listener registration prevents admission", async () => {
  const failure = new Error("registration transport failure");
  const discards = [];
  const p = protocol({
    on: (listener) => listener(failure),
    release: (destroy) => discards.push(destroy),
  });
  let called = false;
  await assert.rejects(
    p.state.transact(async () => {
      called = true;
    }),
    DependencyUnavailableError,
  );
  assert.equal(called, false);
  assert.deepEqual(p.calls, []);
  assert.deepEqual(discards, [true]);
  assert.equal(p.releases(), 1);
});

test("listener registration failure discards the checked-out client exactly once", async () => {
  const failure = new Error("listener registration failed");
  const discards = [];
  const p = protocol({
    on: () => {
      throw failure;
    },
    release: (destroy) => discards.push(destroy),
  });
  let called = false;
  await assert.rejects(
    p.state.transact(async () => {
      called = true;
    }),
    (error) => error === failure,
  );
  assert.equal(called, false);
  assert.deepEqual(p.calls, []);
  assert.deepEqual(discards, [true]);
  assert.equal(p.releases(), 1);
});

test("observed client error during a resolved BEGIN prevents callback and later SQL", async () => {
  const failure = new Error("BEGIN transport failure");
  const discards = [];
  const p = protocol({
    begin: () => {
      p.emitTransportError(failure);
      return { command: "BEGIN", rows: [], rowCount: 0 };
    },
    release: (destroy) => discards.push(destroy),
  });
  let called = false;
  await assert.rejects(
    p.state.transact(async () => {
      called = true;
    }),
    DependencyUnavailableError,
  );
  assert.equal(called, false);
  assert.deepEqual(p.calls, ["BEGIN"]);
  assert.deepEqual(discards, [true]);
  assert.equal(p.releases(), 1);
});

test("an observed client error is unavailable even with a server-looking code", async () => {
  const failure = Object.assign(new Error("client transport failure"), { code: "23514" });
  const p = protocol({ on: (listener) => listener(failure) });
  await assert.rejects(
    p.state.transact(async () => 1),
    (error) =>
      error instanceof DependencyUnavailableError && !(error instanceof ScopeViolationError),
  );
  assert.deepEqual(p.calls, []);
  assert.equal(p.releases(), 1);
  assert.equal(p.hasTransportListener(), false);
});

test("observed client error during a repository query blocks result and subsequent SQL", async () => {
  const failure = new Error("query transport failure");
  const discards = [];
  const p = protocol({
    query: () => {
      p.emitTransportError(failure);
      return { rows: [], rowCount: 0 };
    },
    release: (destroy) => discards.push(destroy),
  });
  let effect = false;
  await assert.rejects(
    p.state.transact(async (unit) => {
      await assert.rejects(unit.audit.list(), (error) => error === failure);
      await assert.rejects(unit.audit.list(), (error) => error === failure);
      effect = true;
    }),
    DependencyUnavailableError,
  );
  // A caller can catch the errors and run external code; the owner still refuses COMMIT.
  assert.equal(effect, true);
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[0], "BEGIN");
  assert.match(p.calls[1], /SELECT id, name, created_at FROM occ\.installation/);
  assert.deepEqual(discards, [true]);
  assert.equal(p.releases(), 1);
});

test("observed client error after a resolved repository query blocks following work", async () => {
  const failure = new Error("query transport failure");
  const p = protocol({
    query: () => {
      p.emitTransportError(failure);
      return { rows: [], rowCount: 0 };
    },
  });
  let effect = false;
  await assert.rejects(
    p.state.transact(async (unit) => {
      await unit.audit.list();
      effect = true;
    }),
    DependencyUnavailableError,
  );
  assert.equal(effect, false);
  assert.equal(p.calls.length, 2);
  assert.equal(p.releases(), 1);
});

test("a coded transport error that also rejects the active query is unavailable", async () => {
  // pg rejects the active query with the same object it emits on "error".
  const failure = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  const discards = [];
  const p = protocol({
    query: () => {
      p.emitTransportError(failure);
      throw failure;
    },
    release: (destroy) => discards.push(destroy),
  });
  await assert.rejects(
    p.state.transact(async (unit) => unit.audit.list()),
    DependencyUnavailableError,
  );
  assert.equal(p.calls.length, 2);
  assert.deepEqual(discards, [true]);
  assert.equal(p.releases(), 1);
});

test("a healthy repository query still returns before the ordinary COMMIT", async () => {
  const discards = [];
  const p = protocol({
    query: () => ({ rows: [], rowCount: 0 }),
    release: (destroy) => discards.push(destroy),
  });
  const result = await p.state.transact(async (unit) => unit.audit.list());
  assert.deepEqual(result, []);
  assert.equal(p.calls.length, 3);
  assert.equal(p.calls[0], "BEGIN");
  assert.match(p.calls[1], /SELECT id, name, created_at FROM occ\.installation/);
  assert.equal(p.calls[2], "COMMIT");
  assert.deepEqual(discards, [false]);
  assert.equal(p.releases(), 1);
});

test("observed client error during resolved COMMIT remains unknown", async () => {
  const p = protocol({
    commit: () => {
      p.emitTransportError(new Error("COMMIT transport failure"));
      return { command: "COMMIT", rows: [], rowCount: 0 };
    },
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(p.releases(), 1);
});

test("observed client error during release after acknowledged COMMIT remains unknown", async () => {
  const order = [];
  const p = protocol({
    release: () => {
      order.push("release");
      p.emitTransportError(new Error("release transport failure"));
    },
    removeListener: () => order.push("removeListener"),
  });
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.deepEqual(order, ["release", "removeListener"]);
  assert.equal(p.releases(), 1);
  assert.equal(p.hasTransportListener(), false);
});

test("observed client error during release preserves an earlier callback failure", async () => {
  const failure = new Error("callback failed");
  const order = [];
  const p = protocol({
    release: () => {
      order.push("release");
      p.emitTransportError(new Error("release transport failure"));
    },
    removeListener: () => order.push("removeListener"),
  });
  await assert.rejects(
    p.state.transact(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(p.calls, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(order, ["release", "removeListener"]);
  assert.equal(p.releases(), 1);
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
  const original = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "fixture",
    password: "fixture",
    host: "127.0.0.1",
    port: 1,
    pathname: "/example",
    search:
      "?host=127.0.0.1&port=55432&user=override&password=override&application_name=commit-fixture&sslmode=disable",
  });
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
      syntheticCredentialUrl({
        protocol: "postgresql",
        username: "fixture",
        password: "fixture",
        host: "127.0.0.1",
        pathname: "/example",
        search: "?host=remote.invalid&sslmode=disable",
      }),
    ),
    /loopback/,
  );
  await assert.rejects(
    commitAckProxy(
      syntheticCredentialUrl({
        protocol: "postgresql",
        username: "fixture",
        password: "fixture",
        host: "127.0.0.1",
        pathname: "/example",
        search: "?ssl=true",
      }),
    ),
    /non-TLS/,
  );
});

test("a single read statement runs outside any transaction on one pooled connection", async () => {
  const destroyed = [];
  const p = protocol({
    query: () => ({ rows: [{ user_id: "u" }], rowCount: 1 }),
    release: (destroy) => destroyed.push(destroy),
  });
  assert.deepEqual(await p.state.readStatement("SELECT 1", []), [{ user_id: "u" }]);
  assert.deepEqual(p.calls, ["SELECT 1"]);
  assert.deepEqual(destroyed, [false]);
  assert.equal(p.hasTransportListener(), false);
});

test("a rejected read statement is classified and discards its connection", async () => {
  const destroyed = [];
  const p = protocol({
    query: () => {
      throw serverError("55P03");
    },
    release: (destroy) => destroyed.push(destroy),
  });
  await assert.rejects(p.state.readStatement("SELECT 1"), DependencyUnavailableError);
  assert.deepEqual(p.calls, ["SELECT 1"]);
  assert.deepEqual(destroyed, [true]);
  assert.equal(p.hasTransportListener(), false);
});

test("a client error during a read statement is unavailable and discards the connection", async () => {
  const destroyed = [];
  let p;
  p = protocol({
    query: () => {
      p.emitTransportError(serverError("23514"));
      return { rows: [{ leaked: true }], rowCount: 1 };
    },
    release: (destroy) => destroyed.push(destroy),
  });
  await assert.rejects(
    p.state.readStatement("SELECT 1"),
    (error) =>
      error instanceof DependencyUnavailableError &&
      error.message === "The platform persistence repository is unavailable.",
  );
  assert.deepEqual(destroyed, [true]);
  assert.equal(p.hasTransportListener(), false);
});

test("a failed checkout for a read statement is unavailable", async () => {
  const state = new PostgresPlatformState({
    async connect() {
      throw new Error("connect ECONNREFUSED");
    },
    async end() {},
  });
  await assert.rejects(state.readStatement("SELECT 1"), DependencyUnavailableError);
});
