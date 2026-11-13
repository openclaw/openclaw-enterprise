import assert from "node:assert/strict";
import test from "node:test";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { protocol, serverError } from "./postgres-transaction-protocol-fixture.ts";

// The transaction reports an unknown COMMIT outcome, sends nothing after COMMIT
// and discards its client.
async function assertCommitUnknown(p: ReturnType<typeof protocol>) {
  await assert.rejects(
    p.state.transact(async () => 1),
    PostgresCommitOutcomeUnknownError,
  );
  assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
  assert.equal(p.releases.at(-1), true);
}

export function registerInitialTransactionOutcomeCases(): void {
  test("known outer acknowledgment returns the original value after cleanup", async () => {
    const p = protocol();
    const value = Object.freeze({ result: "unchanged" });
    assert.equal(await p.state.transact(async () => value), value);
    assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
    assert.equal(p.releases.length, 1);
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
    const p = protocol({
      commit: () => {
        throw failure;
      },
    });
    await assert.rejects(
      p.state.transact(async () => 1),
      (error) => error instanceof DependencyUnavailableError && /conflict/.test(error.message),
    );
    assert.deepEqual(p.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
    assert.equal(p.releases.at(-1), false);
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
          (error: unknown) => error,
        );
      assert.ok(rejection instanceof DependencyUnavailableError);
      assert.match(rejection.message, /conflict/);
      assert.deepEqual(p.calls.at(-1), "ROLLBACK");
      const response = requestFailure(rejection);
      assert.equal(response.status, 503);
      assert.equal(response.code, "DEPENDENCY_UNAVAILABLE");
    });
  }

  const checkoutFailures: readonly (readonly [string, Error])[] = [
    ["DNS ENOTFOUND", Object.assign(new Error("getaddrinfo ENOTFOUND db"), { code: "ENOTFOUND" })],
    ["DNS EAI_AGAIN", Object.assign(new Error("getaddrinfo EAI_AGAIN db"), { code: "EAI_AGAIN" })],
    ["EHOSTUNREACH", Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" })],
    ["a password callback failure", new Error("workload identity token request failed")],
    ["a rejected credential", serverError("28P01")],
  ];
  for (const [name, failure] of checkoutFailures) {
    test(`a connection checkout failure from ${name} is unavailable`, async () => {
      const state = new PostgresPlatformState({
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
          (error: unknown) => error,
        );
      assert.equal(ran, false);
      assert.ok(rejection instanceof DependencyUnavailableError);
      const response = requestFailure(rejection);
      assert.equal(response.status, 503);
      assert.equal(response.code, "DEPENDENCY_UNAVAILABLE");
    });
  }

  test("a client error with a server-looking code leaves COMMIT unknown", async () => {
    const p = protocol({
      commit: () => {
        throw Object.assign(new Error("client failure"), { code: "23514" });
      },
    });
    await assertCommitUnknown(p);
  });

  test("a transport failure during COMMIT leaves even a server-looking rejection unknown", async () => {
    const p: ReturnType<typeof protocol> = protocol({
      commit: () => {
        p.emitTransportError(new Error("transport failure"));
        throw serverError("40001");
      },
    });
    await assertCommitUnknown(p);
  });
}

export function registerCommitCleanupOutcomeCases(): void {
  test("observed client error during resolved COMMIT remains unknown", async () => {
    const p: ReturnType<typeof protocol> = protocol({
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
    assert.equal(p.releases.length, 1);
  });

  test("observed client error during release after acknowledged COMMIT remains unknown", async () => {
    const p: ReturnType<typeof protocol> = protocol({
      release: () => {
        p.emitTransportError(new Error("release transport failure"));
      },
    });
    await assert.rejects(
      p.state.transact(async () => 1),
      PostgresCommitOutcomeUnknownError,
    );
    assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
    p.assertReleaseAttemptThenListenerRemoval();
  });

  test("observed client error during release preserves an earlier callback failure", async () => {
    const failure = new Error("callback failed");
    const p: ReturnType<typeof protocol> = protocol({
      release: () => {
        p.emitTransportError(new Error("release transport failure"));
      },
    });
    await assert.rejects(
      p.state.transact(async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(p.calls, ["BEGIN", "ROLLBACK"]);
    p.assertReleaseAttemptThenListenerRemoval();
  });

  test("40003 statement completion unknown does not issue a follow-up query", async () => {
    const p = protocol({
      commit: () => {
        throw serverError("40003");
      },
    });
    await assertCommitUnknown(p);
  });

  test("an unclassified valid SQLSTATE does not establish no commit", async () => {
    const p = protocol({
      commit: () => {
        throw serverError("XX000");
      },
    });
    await assertCommitUnknown(p);
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
    const p = protocol({
      commit: () => ({ rows: [], rowCount: 0 }),
    });
    await assertCommitUnknown(p);
  });

  test("a throwing acknowledgment projection remains unknown even with a definite SQLSTATE", async () => {
    const p = protocol({
      commit: () => ({
        rows: [],
        rowCount: 0,
        get command(): never {
          throw Object.assign(new Error("invalid acknowledgment"), { code: "40001" });
        },
      }),
    });
    await assertCommitUnknown(p);
  });

  test("release failure after acknowledged COMMIT is unknown and cleanup continues", async () => {
    const p = protocol({
      release: () => {
        throw new Error("release failed");
      },
    });
    await assert.rejects(
      p.state.transact(async () => 1),
      PostgresCommitOutcomeUnknownError,
    );
    assert.deepEqual(p.calls, ["BEGIN", "COMMIT"]);
    p.assertReleaseAttemptThenListenerRemoval();
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
}
