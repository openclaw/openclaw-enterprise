import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createPostgresAuthBinding } from "../../packages/occ/src/auth-persistence/postgres-auth-binding.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "PostgreSQL auth binding pins transactions, rolls back failures, and preserves caller pool ownership",
  requiresPostgres,
  async (context) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const id = `binding-${randomUUID()}`;
    context.after(async () => {
      try {
        await pool.query("DELETE FROM occ.verification WHERE id = $1", [id]);
      } finally {
        await pool.end();
      }
    });
    const { database, schema } = await createPostgresAuthBinding(pool);
    const now = new Date();
    const verification = {
      id,
      identifier: `operator-${randomUUID()}@example.test`,
      value: randomUUID(),
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    };
    const insertVerification = (transaction) =>
      transaction.insert(schema.verification).values(verification);
    const rowsVisibleOutside = async () =>
      (await pool.query("SELECT id FROM occ.verification WHERE id = $1", [id])).rowCount;
    const failure = new Error("abort this transaction");
    await assert.rejects(
      database.transaction(async (transaction) => {
        await insertVerification(transaction);
        const ownRows = await transaction.select().from(schema.verification);
        assert.ok(ownRows.some((row) => row.id === id));
        // The pool's other connection cannot observe the pending insert. This
        // distinguishes a pinned transaction from BEGIN/writes via pool.query.
        assert.equal(await rowsVisibleOutside(), 0);
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(await rowsVisibleOutside(), 0);
    // The caller still owns a usable pool after rollback; a subsequent auth
    // transaction commits and becomes visible outside its checked-out client.
    await database.transaction(insertVerification);
    assert.equal(await rowsVisibleOutside(), 1);
  },
);
