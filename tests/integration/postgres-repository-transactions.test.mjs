import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { verifyRepositoryLifetime } from "../conformance/repository-lifetime.contract.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "PostgreSQL repository ownership, lifetime, and atomicity",
  { ...requiresPostgres, timeout: 60000 },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    (await store.loadInstallation()) ??
      (await store.transact((unit) =>
        unit.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: "Repository tests",
          createdAt: new Date().toISOString(),
        }),
      ));
    await t.test("audit metadata preserves the original PostgreSQL ledger envelope", async (t) => {
      const installation = await store.loadInstallation();
      const occurredAt = "2026-09-24T10:00:00.123Z";
      const baseline = {
        installationId: installation.id,
        occurredAt,
        kind: "mutation",
        actorId: "audit-reader",
        action: "update",
        resource: { kind: "installation", id: installation.id },
        outcome: "success",
      };

      async function withRolledBackEvent(details, verify) {
        const id = `aud_${randomUUID()}`;
        const rollback = new Error("Roll back the audit regression row");
        try {
          await assert.rejects(
            store.transact(async (unit) => {
              // Raw persistence exercises the receiving decoder without letting
              // append sanitize or reject the hostile reserved metadata first.
              await store.queryInTransaction(
                unit,
                `INSERT INTO occ.audit_events
                 (id, occurred_at, kind, actor_id, action, namespace_id,
                  resource_kind, resource_id, outcome, details)
                 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9::jsonb)`,
                [
                  id,
                  occurredAt,
                  baseline.kind,
                  baseline.actorId,
                  baseline.action,
                  baseline.resource.kind,
                  baseline.resource.id,
                  baseline.outcome,
                  details === null ? null : JSON.stringify(details),
                ],
              );
              await verify(unit, { id, ...baseline });
              throw rollback;
            }),
            (error) => {
              if (error !== rollback) {
                throw error;
              }
              return true;
            },
          );
        } finally {
          // These append-only rows must disappear on assertion failure as well
          // as success; no DELETE or trigger bypass is needed for cleanup.
          assert.deepEqual(
            (await pool.query("SELECT id FROM occ.audit_events WHERE id = $1", [id])).rows,
            [],
          );
        }
      }

      async function assertDecoded(unit, expected) {
        const event = (await unit.audit.list()).find((event) => event.id === expected.id);
        assert.deepEqual(event, expected);
      }

      const forgedEnvelope = {
        id: `aud_${randomUUID()}`,
        installationId: `ins_${randomUUID()}`,
        namespaceId: `ns_${randomUUID()}`,
        occurredAt: "2000-01-01T00:00:00.000Z",
        kind: "authorization_denial",
        actorId: "forged-actor",
        action: "delete",
        resource: { kind: "installation", id: `ins_${randomUUID()}` },
        outcome: "denied",
        details: { forged: true },
      };
      const forbidden = {
        ...forgedEnvelope,
        history: { eventId: forgedEnvelope.id },
        unexpected: "unsupported metadata",
      };
      for (const [key, value] of Object.entries(forbidden)) {
        await t.test(`reserved ${key} cannot replace or extend the event`, async () => {
          await withRolledBackEvent({ __occAuditMetadata: { [key]: value } }, assertDecoded);
        });
      }
      await t.test("null unknown metadata cannot create an event property", async () => {
        await withRolledBackEvent({ __occAuditMetadata: { history: null } }, assertDecoded);
      });

      for (const [name, details, retainedDetails] of [
        ["SQL NULL details", null, undefined],
        ["absent metadata", {}, undefined],
        ["empty metadata", { __occAuditMetadata: {} }, undefined],
        ["ordinary details", { reason: "ordinary deletion" }, { reason: "ordinary deletion" }],
        [
          "ordinary details with forged details",
          { count: 2, __occAuditMetadata: { details: { forged: true } } },
          { count: 2 },
        ],
        ["object encoded as metadata text", { __occAuditMetadata: "{}" }, undefined],
      ]) {
        await t.test(name, async () => {
          await withRolledBackEvent(details, async (unit, expected) => {
            await assertDecoded(unit, {
              ...expected,
              ...(retainedDetails === undefined ? {} : { details: retainedDetails }),
            });
          });
        });
      }

      await t.test(
        "known metadata retains current values without stricter validation",
        async () => {
          const metadata = {
            schemaVersion: null,
            source: "legacy-source",
            requestId: null,
            admissionDecisionId: 7,
            actor: { principalId: "recorded-principal" },
            iamDriverId: null,
            authorization: false,
            decisionReason: "ordinary free-form reason",
            reasonCode: "legacy mixed-case reason",
          };
          await withRolledBackEvent(
            { reason: "recorded", __occAuditMetadata: { ...metadata, ...forbidden } },
            async (unit, expected) => {
              await assertDecoded(unit, {
                ...expected,
                ...metadata,
                details: { reason: "recorded" },
              });
            },
          );
          const nullMetadata = Object.fromEntries(Object.keys(metadata).map((key) => [key, null]));
          await withRolledBackEvent(
            { __occAuditMetadata: nullMetadata },
            async (unit, expected) => {
              await assertDecoded(unit, { ...expected, ...nullMetadata });
            },
          );
        },
      );
      await t.test("metadata text retains parsed known fields", async () => {
        await withRolledBackEvent(
          { __occAuditMetadata: '{"requestId":"recorded-request","history":null}' },
          async (unit, expected) => {
            await assertDecoded(unit, { ...expected, requestId: "recorded-request" });
          },
        );
      });
      for (const [name, metadata, expectedError] of [
        ["null", null, DependencyUnavailableError],
        ["array", [], DependencyUnavailableError],
        ["number", 3, DependencyUnavailableError],
        ["boolean", false, DependencyUnavailableError],
        ["text encoding null", "null", DependencyUnavailableError],
        ["text encoding an array", "[]", DependencyUnavailableError],
        ["invalid JSON text", "{", SyntaxError],
      ]) {
        await t.test(`malformed ${name} retains its rejection`, async () => {
          await withRolledBackEvent({ __occAuditMetadata: metadata }, async (unit) => {
            await assert.rejects(unit.audit.list(), expectedError);
          });
        });
      }

      await t.test(
        "append and list roundtrip all nine fields and reject reserved details",
        async () => {
          const { AuditEventFactory } = await import("../../packages/audit/src/index.ts");
          const factory = new AuditEventFactory({ clock: () => occurredAt });
          const event = factory.create({
            ...baseline,
            requestId: "recorded-request",
            admissionDecisionId: "recorded-admission",
            iamDriverId: "recorded-iam",
            authorization: {
              principalId: baseline.actorId,
              action: "update",
              resource: baseline.resource,
            },
            decisionReason: "authorized update",
            reasonCode: "AUTHORIZED_UPDATE",
            details: { count: 1 },
          });
          const minimal = { ...baseline, id: `aud_${randomUUID()}` };
          const rejected = {
            ...event,
            id: `aud_${randomUUID()}`,
            details: { __occAuditMetadata: {} },
          };
          const rollback = new Error("Roll back appended audit regression rows");
          try {
            await assert.rejects(
              store.transact(async (unit) => {
                await unit.audit.append(event);
                await unit.audit.append(minimal);
                await assert.rejects(unit.audit.append(rejected), ScopeViolationError);
                await assertDecoded(unit, event);
                await assertDecoded(unit, minimal);
                assert.equal(
                  (await unit.audit.list()).some((row) => row.id === rejected.id),
                  false,
                );
                throw rollback;
              }),
              (error) => {
                if (error !== rollback) {
                  throw error;
                }
                return true;
              },
            );
          } finally {
            assert.deepEqual(
              (
                await pool.query("SELECT id FROM occ.audit_events WHERE id = ANY($1::text[])", [
                  [event.id, minimal.id, rejected.id],
                ])
              ).rows,
              [],
            );
          }
        },
      );
    });
    await verifyRepositoryLifetime(t, store);
    await t.test(
      "accepted raw SQL drains and queue/query handles close before connection reuse",
      async () => {
        let retainedUnit;
        let retainedQueue;
        let accepted;
        let completed = false;
        await store.transactWithQueue(async (unit, queue) => {
          retainedUnit = unit;
          retainedQueue = queue;
          accepted = store
            .queryInTransaction(unit, "SELECT pg_sleep(0.02), 1 AS value")
            .then((result) => {
              completed = true;
              return result;
            });
        });
        assert.equal(completed, true);
        assert.equal((await accepted).rows[0].value, 1);
        await assert.rejects(retainedQueue.pending(), ScopeViolationError);
        assert.throws(
          () => store.queryInTransaction(retainedUnit, "SELECT 1"),
          DependencyUnavailableError,
        );
        assert.equal((await pool.query("SELECT 1 AS value")).rows[0].value, 1);
      },
    );
  },
);
