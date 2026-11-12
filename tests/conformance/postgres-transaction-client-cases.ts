import assert, { type AssertPredicate } from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { protocol, serverError } from "./postgres-transaction-protocol-fixture.ts";

// The transaction refuses before its callback runs, sends only the given SQL
// and discards its client exactly once.
async function assertNotAdmitted(
  p: ReturnType<typeof protocol>,
  rejection: AssertPredicate,
  calls: readonly string[],
) {
  let called = false;
  await assert.rejects(
    p.state.transact(async () => {
      called = true;
    }),
    rejection,
  );
  assert.equal(called, false);
  assert.deepEqual(p.calls, calls);
  assert.deepEqual(p.releases, [true]);
}

function assertInstallationLookup(calls: readonly string[]): void {
  const [begin, lookup] = calls;
  assert.equal(begin, "BEGIN");
  assert.ok(lookup);
  assert.match(lookup, /SELECT id, name, created_at FROM occ\.installation/);
}

export function registerTransactionClientCases(): void {
  test("a known-bad client is discarded without attempting pre-COMMIT rollback", async () => {
    const failure = new Error("transport failure");
    const p = protocol();
    await assert.rejects(
      p.state.transact(async () => {
        p.emitTransportError(failure);
      }),
      DependencyUnavailableError,
    );
    assert.deepEqual(p.calls, ["BEGIN"]);
    assert.equal(p.releases.at(-1), true);
  });

  test("observed client error during listener registration prevents admission", async () => {
    const failure = new Error("registration transport failure");
    const p = protocol({
      on: (listener) => listener(failure),
    });
    await assertNotAdmitted(p, DependencyUnavailableError, []);
  });

  test("listener registration failure discards the checked-out client exactly once", async () => {
    const failure = new Error("listener registration failed");
    const p = protocol({
      on: () => {
        throw failure;
      },
    });
    await assertNotAdmitted(p, (error) => error === failure, []);
  });

  test("observed client error during a resolved BEGIN prevents callback and later SQL", async () => {
    const failure = new Error("BEGIN transport failure");
    const p: ReturnType<typeof protocol> = protocol({
      begin: () => {
        p.emitTransportError(failure);
        return { command: "BEGIN", rows: [], rowCount: 0 };
      },
    });
    await assertNotAdmitted(p, DependencyUnavailableError, ["BEGIN"]);
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
    assert.equal(p.releases.length, 1);
    assert.equal(p.hasTransportListener(), false);
  });

  test("observed client error during a repository query blocks result and subsequent SQL", async () => {
    const failure = new Error("query transport failure");
    const p: ReturnType<typeof protocol> = protocol({
      query: () => {
        p.emitTransportError(failure);
        return { rows: [], rowCount: 0 };
      },
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
    assertInstallationLookup(p.calls);
    assert.deepEqual(p.releases, [true]);
    assert.equal(p.releases.length, 1);
  });

  test("observed client error after a resolved repository query blocks following work", async () => {
    const failure = new Error("query transport failure");
    const p: ReturnType<typeof protocol> = protocol({
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
    assert.equal(p.releases.length, 1);
  });

  test("a coded transport error that also rejects the active query is unavailable", async () => {
    // pg rejects the active query with the same object it emits on "error".
    const failure = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const p: ReturnType<typeof protocol> = protocol({
      query: () => {
        p.emitTransportError(failure);
        throw failure;
      },
    });
    await assert.rejects(
      p.state.transact(async (unit) => unit.audit.list()),
      DependencyUnavailableError,
    );
    assert.equal(p.calls.length, 2);
    assert.deepEqual(p.releases, [true]);
    assert.equal(p.releases.length, 1);
  });

  test("a healthy repository query still returns before the ordinary COMMIT", async () => {
    const p = protocol({
      query: () => ({ rows: [], rowCount: 0 }),
    });
    const result = await p.state.transact(async (unit) => unit.audit.list());
    assert.deepEqual(result, []);
    assert.equal(p.calls.length, 3);
    assertInstallationLookup(p.calls);
    assert.equal(p.calls[2], "COMMIT");
    assert.deepEqual(p.releases, [false]);
    assert.equal(p.releases.length, 1);
  });
}

export function registerProxyAndReadCases(): void {
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
          port: undefined,
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
          port: undefined,
          pathname: "/example",
          search: "?ssl=true",
        }),
      ),
      /non-TLS/,
    );
  });

  test("a single read statement runs outside any transaction on one pooled connection", async () => {
    const p = protocol({
      query: () => ({ rows: [{ user_id: "u" }], rowCount: 1 }),
    });
    assert.deepEqual(await p.state.readStatement("SELECT 1", []), [{ user_id: "u" }]);
    assert.deepEqual(p.calls, ["SELECT 1"]);
    assert.deepEqual(p.releases, [false]);
    assert.equal(p.hasTransportListener(), false);
  });

  test("a rejected read statement is classified and discards its connection", async () => {
    const p = protocol({
      query: () => {
        throw serverError("55P03");
      },
    });
    await assert.rejects(p.state.readStatement("SELECT 1"), DependencyUnavailableError);
    assert.deepEqual(p.calls, ["SELECT 1"]);
    assert.deepEqual(p.releases, [true]);
    assert.equal(p.hasTransportListener(), false);
  });

  test("a client error during a read statement is unavailable and discards the connection", async () => {
    const p: ReturnType<typeof protocol> = protocol({
      query: () => {
        p.emitTransportError(serverError("23514"));
        return { rows: [{ leaked: true }], rowCount: 1 };
      },
    });
    await assert.rejects(
      p.state.readStatement("SELECT 1"),
      (error) =>
        error instanceof DependencyUnavailableError &&
        error.message === "The platform persistence repository is unavailable.",
    );
    assert.deepEqual(p.releases, [true]);
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
}
