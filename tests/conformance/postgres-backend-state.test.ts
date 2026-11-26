import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresClient } from "../../packages/occ/src/index.ts";
import {
  cleanupNamespaces,
  poolWithOneBackendBindingReadFault,
} from "../helpers/postgres-backend-state.ts";

test("Backend cleanup releases its client and preserves the write failure when rollback also fails", async () => {
  const failure = new Error("agent update refused");
  const events: string[] = [];
  const pool = {
    async connect(): Promise<PostgresClient> {
      events.push("connect");
      return {
        async query(text) {
          const statement = text.trim().split("\n")[0];
          assert.ok(statement);
          events.push(statement);
          if (statement === "UPDATE occ.agents") {
            throw failure;
          }
          if (statement === "ROLLBACK") {
            throw new Error("lost connection");
          }
          return { rows: [], rowCount: 0 };
        },
        release() {
          events.push("release");
        },
      };
    },
  };
  await cleanupNamespaces(pool, []);
  assert.deepEqual(events, []);
  await assert.rejects(cleanupNamespaces(pool, ["namespace"]), (error) => error === failure);
  assert.deepEqual(events, [
    "connect",
    "BEGIN",
    "UPDATE occ.controller_work",
    "UPDATE occ.agents",
    "ROLLBACK",
    "release",
  ]);
});

test("Backend binding fault applies once across leases and never to a direct pool query", async () => {
  const table = "SELECT * FROM occ.service_account_driver_bindings AS b";
  const predicate = "WHERE b.namespace_id = $1 AND b.service_account_id = $2";
  const lookup = `${table} ${predicate}`;
  const values = ["namespace", "account"];
  const result = { rows: [{ id: "account" }], rowCount: 1 };
  const calls: string[] = [];
  const pool = poolWithOneBackendBindingReadFault({
    async connect() {
      return {
        async query(text, parameters) {
          calls.push(text);
          assert.equal(parameters, values);
          return result;
        },
        release() {
          calls.push("release");
        },
      };
    },
    async query(text, parameters) {
      assert.equal(text, lookup);
      assert.equal(parameters, values);
      calls.push("direct");
      return result;
    },
    async end() {
      calls.push("end");
    },
  });
  assert.equal(await pool.query(lookup, values), result);
  const first = await pool.connect();
  await first.query(table, values);
  await first.query(`SELECT 1 ${predicate}`, values);
  await assert.rejects(
    first.query(lookup, values),
    /simulated transient Backend binding metadata read failure/,
  );
  first.release();
  const second = await pool.connect();
  assert.equal(await second.query(lookup, values), result);
  second.release();
  await pool.end();
  assert.deepEqual(calls, [
    "direct",
    table,
    `SELECT 1 ${predicate}`,
    "release",
    lookup,
    "release",
    "end",
  ]);
});
