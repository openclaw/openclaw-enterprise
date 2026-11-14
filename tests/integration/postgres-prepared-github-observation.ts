import assert from "node:assert/strict";
import { callFixture } from "./postgres-prepared-github-wire.ts";
import type { TestContext } from "node:test";
import type { Client, Pool, PoolClient } from "pg";
import type { PostgresClient } from "../../packages/occ/src/state/postgres-state.ts";
import type { PostgresPreparedGitHubLifecycle } from "../../apps/controller/src/drivers/repo/github/access/prepared-lifecycle.ts";

type Repository = NonNullable<PostgresPreparedGitHubLifecycle["repository"]>;
type CustodyMethods = {
  open: Repository["open"];
  seal: Repository["seal"];
  transaction: Repository["transaction"];
};

function hasCustodyMethods(value: object): value is CustodyMethods {
  return (
    "open" in value &&
    typeof value.open === "function" &&
    "seal" in value &&
    typeof value.seal === "function" &&
    "transaction" in value &&
    typeof value.transaction === "function"
  );
}

export function connectedRepository(
  lifecycle: PostgresPreparedGitHubLifecycle,
): Pick<Repository, keyof Repository> & CustodyMethods {
  const repository = lifecycle["repository"];
  assert.ok(repository, "the lifecycle is connected to PostgreSQL");
  assert.ok(hasCustodyMethods(repository));
  return repository;
}

type Query = (
  sql: string,
  values?: readonly unknown[],
) => Promise<{
  rows: unknown[];
  rowCount: number | null;
}>;

// pg overloads include callbacks, Query objects and row-mode configs. Observe only
// this suite's promise SQL calls and forward every other argument list unchanged.
export function mockPgQuery(
  t: TestContext,
  client: Client | PoolClient,
  observe: (sql: string, values: readonly unknown[] | undefined, query: Query) => ReturnType<Query>,
) {
  const original: Query = client.query;
  return t.mock.method(client, "query", function (this: Client, ...args: unknown[]): unknown {
    const [sql, values] = args;
    const query = original.bind(this);
    if (
      typeof sql === "string" &&
      args.length <= 2 &&
      (values === undefined || Array.isArray(values))
    ) {
      return observe(sql, values, query);
    }
    const forwarded: unknown = callFixture(original, this, args);
    return forwarded;
  });
}

export function containsSealedRow(rows: readonly unknown[]) {
  return rows.some(
    (row) => typeof row === "object" && row !== null && "sealed" in row && row.sealed != null,
  );
}

export function observeTransaction(
  t: TestContext,
  repository: ReturnType<typeof connectedRepository>,
  observe: (client: PostgresClient, ...args: Parameters<Query>) => ReturnType<Query>,
) {
  const transaction: (typeof repository)["transaction"] =
    repository["transaction"].bind(repository);
  function observed<T>(work: (client: Pick<PostgresClient, "query">) => Promise<T>): Promise<T> {
    return transaction((client: PostgresClient) =>
      work({
        query: (sql, values) => observe(client, sql, values),
      }),
    );
  }
  t.mock.method(repository, "transaction", observed);
}

// Fault injection owns one checked-out client. Only the first promise-mode
// connection uses it, then the original Pool restores its usual connection path.
export function useCheckedOutClient(t: TestContext, pool: Pool, client: PoolClient): void {
  const promisePool: { connect(): Promise<PoolClient> } = pool;
  t.mock.method(promisePool, "connect", async () => client, { times: 1 });
}
