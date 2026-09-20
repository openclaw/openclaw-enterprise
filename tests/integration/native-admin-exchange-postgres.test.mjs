import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  MemoryNativeAdminExchangeStore,
  NativeAdminExchangeLimitExceededError,
  NativeAdminExchangeValidationError,
  NATIVE_ADMIN_EXCHANGE_MAX_ACTIVE_CODES_PER_PARENT_SESSION,
  PostgresNativeAdminExchangeStore,
} from "../../apps/controller/src/auth/native-admin-exchange.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.",
};
const testSessionPrefix = `native-admin-test-${randomUUID()}`;

function future(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function launchRecord(overrides = {}) {
  return {
    parentSessionId: `${testSessionPrefix}-session-${randomUUID()}`,
    parentUserId: `user-${randomUUID()}`,
    actorId: `identity-${randomUUID()}`,
    actorIssuer: `issuer-${randomUUID()}`,
    actorSubject: `subject-${randomUUID()}`,
    parentExpiresAt: future(5 * 60_000),
    namespaceId: `ns_${randomUUID()}`,
    agentId: `agt_${randomUUID()}`,
    revisionId: `rev_${randomUUID()}`,
    host: `agent-${randomUUID().replaceAll("-", "")}.native.example.com`,
    state: randomUUID(),
    challenge: randomUUID(),
    expiresAt: future(45_000),
    ...overrides,
  };
}

async function deleteNativeAdminRows(pool, parentSessionIds) {
  const ids = Array.from(parentSessionIds);
  if (ids.length === 0) {
    return;
  }
  await pool.query(
    `DELETE FROM occ.verification
      WHERE identifier LIKE 'native-admin:%'
        AND value::jsonb ->> 'parentSessionId' = ANY($1::text[])`,
    [ids],
  );
}

function scopedLaunchRecord(parentSessionIds, overrides = {}) {
  const record = launchRecord(overrides);
  parentSessionIds.add(record.parentSessionId);
  return record;
}

test("memory native admin exchange mirrors one-use, expiry, and issuance bounds", async () => {
  const store = new MemoryNativeAdminExchangeStore();
  const record = launchRecord();

  const code = await store.issue(record);
  assert.deepEqual(await store.consume(code), record);
  assert.equal(await store.consume(code), undefined);

  const expiring = await store.issue({
    ...record,
    state: randomUUID(),
    expiresAt: future(100),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await store.consume(expiring), undefined);

  const parentSessionId = `session-${randomUUID()}`;
  const parentExpiresAt = future(5 * 60_000);
  for (
    let index = 0;
    index < NATIVE_ADMIN_EXCHANGE_MAX_ACTIVE_CODES_PER_PARENT_SESSION;
    index += 1
  ) {
    await store.issue(
      launchRecord({
        parentSessionId,
        parentExpiresAt,
        state: randomUUID(),
        expiresAt: future(45_000),
      }),
    );
  }
  await assert.rejects(
    store.issue(
      launchRecord({
        parentSessionId,
        parentExpiresAt,
        state: randomUUID(),
        expiresAt: future(45_000),
      }),
    ),
    NativeAdminExchangeLimitExceededError,
  );
});

test(
  "PostgreSQL native admin exchange consumes one-use codes across store instances",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const parentSessionIds = new Set();
    t.after(async () => {
      await deleteNativeAdminRows(pool, parentSessionIds);
      await pool.end();
    });
    const issuer = new PostgresNativeAdminExchangeStore(pool);
    const consumer = new PostgresNativeAdminExchangeStore(pool);
    const record = scopedLaunchRecord(parentSessionIds);
    await deleteNativeAdminRows(pool, parentSessionIds);

    const code = await issuer.issue(record);
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    const stored = await pool.query(
      "SELECT identifier, value FROM occ.verification WHERE identifier LIKE 'native-admin:%'",
    );
    assert.equal(stored.rowCount, 1);
    assert.match(stored.rows[0].identifier, /^native-admin:[0-9a-f]{64}$/);
    assert.doesNotMatch(stored.rows[0].identifier, new RegExp(code));
    assert.doesNotMatch(stored.rows[0].value, new RegExp(code));

    assert.deepEqual(await consumer.consume(code), record);
    assert.equal(await issuer.consume(code), undefined);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM occ.verification WHERE identifier LIKE 'native-admin:%'",
        )
      ).rows[0].count,
      0,
    );
  },
);

test(
  "PostgreSQL native admin exchange expires and rejects malformed exchanges",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const parentSessionIds = new Set();
    t.after(async () => {
      await deleteNativeAdminRows(pool, parentSessionIds);
      await pool.end();
    });
    const store = new PostgresNativeAdminExchangeStore(pool);

    await assert.rejects(
      store.issue(scopedLaunchRecord(parentSessionIds, { parentSessionId: "x".repeat(513) })),
      NativeAdminExchangeValidationError,
    );
    await assert.rejects(
      store.issue(scopedLaunchRecord(parentSessionIds, { expiresAt: future(61_000) })),
      NativeAdminExchangeValidationError,
    );
    await assert.rejects(
      store.issue(
        scopedLaunchRecord(parentSessionIds, {
          parentExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      ),
      NativeAdminExchangeValidationError,
    );
    assert.equal(await store.consume("not-a-valid-code"), undefined);

    // Expired redemption deletes the stored exchange and never reveals launch state.
    const expiringCode = await store.issue(
      scopedLaunchRecord(parentSessionIds, { expiresAt: future(100) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await store.consume(expiringCode), undefined);
    assert.equal(await store.consume(expiringCode), undefined);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM occ.verification WHERE identifier LIKE 'native-admin:%'",
        )
      ).rows[0].count,
      0,
    );
  },
);

test(
  "PostgreSQL native admin exchange bounds concurrent issuance per parent session",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    const parentSessionIds = new Set();
    t.after(async () => {
      await deleteNativeAdminRows(pool, parentSessionIds);
      await pool.end();
    });
    const issuerA = new PostgresNativeAdminExchangeStore(pool);
    const issuerB = new PostgresNativeAdminExchangeStore(pool);
    const parentSessionId = `${testSessionPrefix}-session-${randomUUID()}`;
    parentSessionIds.add(parentSessionId);
    await deleteNativeAdminRows(pool, parentSessionIds);
    const parentExpiresAt = future(5 * 60_000);

    const attempts = Array.from(
      { length: NATIVE_ADMIN_EXCHANGE_MAX_ACTIVE_CODES_PER_PARENT_SESSION + 1 },
      (_, index) =>
        (index % 2 === 0 ? issuerA : issuerB)
          .issue(
            launchRecord({
              parentSessionId,
              parentExpiresAt,
              state: randomUUID(),
              expiresAt: future(45_000),
            }),
          )
          .then(
            (code) => ({ status: "fulfilled", code }),
            (error) => ({ status: "rejected", error }),
          ),
    );
    const results = await Promise.all(attempts);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      NATIVE_ADMIN_EXCHANGE_MAX_ACTIVE_CODES_PER_PARENT_SESSION,
    );
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.ok(
      results.find((result) => result.status === "rejected")?.error instanceof
        NativeAdminExchangeLimitExceededError,
    );
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::integer AS count
             FROM occ.verification
            WHERE identifier LIKE 'native-admin:%'
              AND value::jsonb ->> 'parentSessionId' = $1`,
          [parentSessionId],
        )
      ).rows[0].count,
      NATIVE_ADMIN_EXCHANGE_MAX_ACTIVE_CODES_PER_PARENT_SESSION,
    );

    const redeemed = results.find((result) => result.status === "fulfilled");
    assert.ok(redeemed);
    assert.ok(await issuerB.consume(redeemed.code));
    await issuerA.issue(
      launchRecord({
        parentSessionId,
        parentExpiresAt,
        state: randomUUID(),
        expiresAt: future(45_000),
      }),
    );
  },
);
