import assert from "node:assert/strict";
import pg from "pg";
import {
  PostgresPlatformState,
  type PostgresClient,
  type PostgresPool,
} from "../../packages/occ/src/state/postgres-state.ts";

type QueryResult = Awaited<ReturnType<PostgresClient["query"]>>;

// The port requires rows and rowCount. The transaction owner inspects the
// separate command metadata, which can be absent or throw on access.
interface ProtocolResult extends QueryResult {
  readonly command?: string;
}

type HookResult = ProtocolResult | Promise<ProtocolResult>;
type TransportListener = (error: Error) => void;

interface ProtocolHooks {
  on?: (listener: TransportListener) => void;
  begin?: () => HookResult;
  commit?: () => HookResult;
  query?: (statement: string) => HookResult;
  release?: (discard: boolean | undefined) => void;
}

// A transport protocol fixture for the actual outer owner, not a SQL database
// emulator. No repository reads/writes, authentication, custody or PG evidence.
export function protocol({ on, begin, commit, query, release }: ProtocolHooks = {}) {
  const calls: string[] = [];
  const releases: (boolean | undefined)[] = [];
  const cleanupAttempts: ("release" | "removeListener")[] = [];
  let transportListener: TransportListener | undefined;
  const client: PostgresClient = {
    on(event, listener) {
      if (event === "error") {
        transportListener = listener;
        on?.(listener);
      }
    },
    removeListener(event, listener) {
      cleanupAttempts.push("removeListener");
      if (event === "error" && listener === transportListener) {
        transportListener = undefined;
      }
    },
    async query(statement): Promise<ProtocolResult> {
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
      releases.push(destroy);
      cleanupAttempts.push("release");
      release?.(destroy);
    },
  };
  const pool: PostgresPool = {
    async connect() {
      return client;
    },
    async end() {},
  };
  return {
    state: new PostgresPlatformState(pool),
    calls,
    releases,
    emitTransportError: (error: Error) => transportListener?.(error),
    hasTransportListener: () => transportListener !== undefined,
    assertReleaseAttemptThenListenerRemoval() {
      assert.deepEqual(cleanupAttempts, ["release", "removeListener"]);
      assert.equal(transportListener, undefined);
    },
  };
}

export function serverError(code: string) {
  return Object.assign(new pg.DatabaseError("server rejection", 0, "error"), { code });
}
