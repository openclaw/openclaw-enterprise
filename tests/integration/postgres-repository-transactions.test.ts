import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AuditEvent } from "../../packages/contracts/src/index.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/state/platform-state.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { verifyRepositoryLifetime } from "../conformance/repository-lifetime.contract.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

test(
  "PostgreSQL repository ownership, lifetime, and atomicity",
  { ...requiresPostgres, timeout: 60000 },
  async (t) => {
    const pool = testPool(t, { connectionString: databaseUrl, max: 4 });
    const store = new PostgresPlatformState(pool);
    const installation =
      (await store.loadInstallation()) ??
      (await store.transact((unit) =>
        unit.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: "Repository tests",
          createdAt: new Date().toISOString(),
        }),
      ));
    await t.test("audit metadata preserves the original PostgreSQL ledger envelope", async (t) => {
      const occurredAt = "2026-09-24T10:00:00.123Z";
      const baseline: Omit<AuditEvent, "id"> = {
        installationId: installation.id,
        occurredAt,
        kind: "mutation",
        actorId: "audit-reader",
        action: "update",
        resource: { kind: "installation", id: installation.id },
        outcome: "success",
      };

      async function withRolledBackAudit(
        ids: readonly string[],
        verify: (unit: PlatformUnitOfWork) => Promise<void>,
      ) {
        const rollback = new Error("Roll back the audit regression rows");
        try {
          await assert.rejects(
            store.transact(async (unit) => {
              await verify(unit);
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
          // These append-only rows must disappear even if verification fails.
          const { rows } = await pool.query(
            "SELECT id FROM occ.audit_events WHERE id = ANY($1::text[])",
            [ids],
          );
          assert.deepEqual(rows, []);
        }
      }

      async function withRolledBackEvent(
        details: unknown,
        verify: (unit: PlatformUnitOfWork, expected: AuditEvent) => Promise<void>,
      ) {
        const id = `aud_${randomUUID()}`;
        await withRolledBackAudit([id], async (unit) => {
          // Write the malformed metadata directly so it reaches the decoder.
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
        });
      }

      async function assertDecoded<Expected extends Pick<AuditEvent, "id">>(
        unit: PlatformUnitOfWork,
        expected: Expected,
      ) {
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
      ] as const) {
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
      ] as const) {
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
          await withRolledBackAudit([event.id, minimal.id, rejected.id], async (unit) => {
            await unit.audit.append(event);
            await unit.audit.append(minimal);
            // Redelivery keeps the stored fact and cannot use its ID for different evidence.
            await unit.audit.append({ ...event });
            await assert.rejects(
              unit.audit.append({ ...event, details: { count: 2 } }),
              /audit event ID already identifies different evidence/,
            );
            await assert.rejects(unit.audit.append(rejected), ScopeViolationError);
            await assertDecoded(unit, event);
            await assertDecoded(unit, minimal);
            assert.equal((await unit.audit.list()).filter((row) => row.id === event.id).length, 1);
            assert.equal(
              (await unit.audit.list()).some((row) => row.id === rejected.id),
              false,
            );
          });
        },
      );
    });
    await verifyRepositoryLifetime(t, store);
    await t.test(
      "accepted raw SQL drains and queue/query handles close before connection reuse",
      async () => {
        function assertSelectedValue(row: unknown) {
          assert.ok(row && typeof row === "object" && "value" in row);
          assert.equal(row.value, 1);
        }

        let completed = false;
        const { unit, queue, accepted } = await store.transactWithQueue(async (unit, queue) => {
          // Leave the accepted query pending when the callback returns.
          const accepted = store
            .queryInTransaction(unit, "SELECT pg_sleep(0.02), 1 AS value")
            .then((result) => {
              completed = true;
              return result;
            });
          return { unit, queue, accepted };
        });
        assert.equal(completed, true);
        assertSelectedValue((await accepted).rows[0]);
        await assert.rejects(queue.pending(), ScopeViolationError);
        assert.throws(() => store.queryInTransaction(unit, "SELECT 1"), DependencyUnavailableError);
        assertSelectedValue((await pool.query("SELECT 1 AS value")).rows[0]);
      },
    );
  },
);
