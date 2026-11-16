import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RepositoryRevisionState } from "@openclaw-enterprise/contracts";
import type { Pool, PoolClient } from "pg";
import type {
  RepositorySessionPhase,
  RepositorySessionRepository,
} from "../../packages/occ/src/ports/repository-sessions.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  seedSessionRevision,
  sessionAttempt,
  verifyRepositorySessions,
} from "../conformance/repository-sessions.contract.ts";
import {
  repositoryBinding,
  repositoryCredentials,
  repositoryGrant,
} from "../fixtures/repository-credentials/session-state.ts";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { waitForLockHolder } from "../helpers/postgres-locks.ts";

type AttemptInput = Parameters<RepositorySessionRepository["createAttempt"]>[0];

// PostgreSQL can receive integers beyond the State contract's safe numeric range.
type RawAttempt = Omit<AttemptInput, "durationSeconds"> & {
  readonly durationSeconds: number | `${bigint}`;
};

function insertAttempt(
  pool: Pool | PoolClient,
  input: RawAttempt,
  phase: RepositorySessionPhase | "unknown" = "opening",
  sessionId: string | null = null,
  updatedAt: string = input.createdAt,
) {
  return pool.query<
    never,
    [
      namespaceId: string,
      agentId: string,
      revisionId: string,
      repositoryRef: string,
      admissionId: string,
      durationSeconds: RawAttempt["durationSeconds"],
      deadlineWallMs: number,
      phase: RepositorySessionPhase | "unknown",
      sessionId: string | null,
      createdAt: string,
      updatedAt: string,
    ]
  >(
    `INSERT INTO occ.repository_session_attempts
       (namespace_id, agent_id, revision_id, repository_ref, admission_id,
        duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.namespaceId,
      input.agentId,
      input.revisionId,
      input.repositoryRef,
      input.admissionId,
      input.durationSeconds,
      input.deadlineWallMs,
      phase,
      sessionId,
      input.createdAt,
      updatedAt,
    ],
  );
}

test(
  "PostgreSQL repository sessions enforce durable admission boundaries",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const pool: Pool = testPool(t, { connectionString: databaseUrl, max: 4 });
    const store = new PostgresPlatformState(pool);
    await verifyRepositorySessions(t, store);

    await t.test(
      "SQL rejects owner mismatches, unadmitted repositories and altered deadlines",
      async (t) => {
        const { revision } = await seedSessionRevision(store);
        const other = await seedSessionRevision(store);
        const foreignOwners = {
          "namespace belongs to another revision": { namespaceId: other.namespace.id },
          "agent belongs to another revision": { agentId: other.agent.id },
          "revision does not exist": { revisionId: `rev_${randomUUID()}` },
        } satisfies Record<string, Partial<RawAttempt>>;
        for (const [name, override] of Object.entries(foreignOwners)) {
          await t.test(name, async () => {
            await assert.rejects(insertAttempt(pool, sessionAttempt(revision, override)), {
              code: "23503",
            });
          });
        }
        const invalidAttempts = {
          "repository was not admitted": { repositoryRef: "unadmitted" },
          "deadline differs from the admitted deadline": {
            deadlineWallMs: revision.repositoryCredentials.deadlineWallMs + 1,
          },
          "duration is zero": { durationSeconds: 0 },
          "duration is negative": { durationSeconds: -1 },
          "duration exceeds the safe integer range": { durationSeconds: "9007199254740992" },
          "admission identity contains a space": { admissionId: "bad admission" },
          "admission identity ends with a newline": { admissionId: "admission\n" },
          "admission identity exceeds 128 characters": { admissionId: "a".repeat(129) },
        } satisfies Record<string, Partial<RawAttempt>>;
        for (const [name, override] of Object.entries(invalidAttempts)) {
          await t.test(name, async () => {
            await assert.rejects(
              insertAttempt(pool, { ...sessionAttempt(revision), ...override }),
              {
                code: "23514",
              },
            );
          });
        }
        await t.test("phase is unknown", async () => {
          await assert.rejects(insertAttempt(pool, sessionAttempt(revision), "unknown"), {
            code: "23514",
          });
        });
        await t.test("opening attempt already has a session identity", async () => {
          await assert.rejects(
            insertAttempt(pool, sessionAttempt(revision), "opening", "session-present"),
            { code: "23514" },
          );
        });
        await t.test("creation time is infinite", async () => {
          await assert.rejects(
            insertAttempt(pool, sessionAttempt(revision, { createdAt: "infinity" })),
            { code: "23514" },
          );
        });
        await t.test("update time precedes creation", async () => {
          await assert.rejects(
            insertAttempt(
              pool,
              sessionAttempt(revision),
              "opening",
              null,
              "2030-03-17T17:46:39.000Z",
            ),
            { code: "23514" },
          );
        });
        const {
          rows: [row],
        } = await pool.query<{ count: number }, [revisionId: string]>(
          "SELECT count(*)::integer AS count FROM occ.repository_session_attempts WHERE revision_id = $1",
          [revision.id],
        );
        assert.ok(row);
        assert.equal(row.count, 0);
      },
    );

    await t.test(
      "SQL uniqueness and lifecycle retain one active admission and immutable session IDs",
      async () => {
        const { revision } = await seedSessionRevision(store);
        const input = sessionAttempt(revision);
        await insertAttempt(pool, input);
        await assert.rejects(insertAttempt(pool, input), { code: "23505" });
        await assert.rejects(insertAttempt(pool, sessionAttempt(revision)), { code: "23505" });
        await assert.rejects(
          pool.query<never, [admissionId: string]>(
            "UPDATE occ.repository_session_attempts SET phase = 'open' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
        const sessionId = `session-${randomUUID()}`;
        await assert.rejects(
          pool.query<never, [admissionId: string, sessionId: string]>(
            "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
            [input.admissionId, "session\n"],
          ),
          { code: "23514" },
        );
        await pool.query<never, [admissionId: string, sessionId: string]>(
          "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
          [input.admissionId, sessionId],
        );
        await assert.rejects(
          pool.query<never, [admissionId: string]>(
            "UPDATE occ.repository_session_attempts SET phase = 'disposed' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query<never, [admissionId: string]>(
            "UPDATE occ.repository_session_attempts SET session_id = NULL WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "55000" },
        );
        await assert.rejects(
          pool.query<never, [admissionId: string]>(
            "UPDATE occ.repository_session_attempts SET phase = 'closing', session_id = 'replacement' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "55000" },
        );
        await pool.query<never, [admissionId: string]>(
          "UPDATE occ.repository_session_attempts SET phase = 'closing' WHERE admission_id = $1",
          [input.admissionId],
        );
        // Cleanup evidence remains while a replacement admission can be persisted.
        const replacement = sessionAttempt(revision);
        await insertAttempt(pool, replacement);
        await assert.rejects(
          pool.query<never, [admissionId: string, sessionId: string]>(
            "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
            [replacement.admissionId, sessionId],
          ),
          { code: "23505" },
        );
        await pool.query<never, [admissionId: string]>(
          "UPDATE occ.repository_session_attempts SET phase = 'disposed' WHERE admission_id = $1",
          [input.admissionId],
        );
        await assert.rejects(
          pool.query<never, [admissionId: string]>(
            "UPDATE occ.repository_session_attempts SET phase = 'open' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
      },
    );

    await t.test(
      "application grants permit lifecycle changes while protecting identity and history",
      async () => {
        const {
          rows: [role],
        } = await pool.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }, []>(
          "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        assert.ok(role);
        assert.equal(role.name, "occ_app");
        assert.equal(role.rolsuper, false);
        assert.equal(role.rolbypassrls, false);
        const { revision } = await seedSessionRevision(store);
        const input = sessionAttempt(revision);
        await insertAttempt(pool, input);
        for (const column of [
          "namespace_id",
          "agent_id",
          "revision_id",
          "live_revision_id",
          "cleanup_context",
          "repository_ref",
          "admission_id",
          "duration_seconds",
          "deadline_wall_ms",
          "created_at",
        ]) {
          await assert.rejects(
            pool.query<never, [admissionId: string]>(
              `UPDATE occ.repository_session_attempts SET ${column} = ${column} WHERE admission_id = $1`,
              [input.admissionId],
            ),
            { code: "42501" },
          );
        }
        await assert.rejects(
          pool.query<never, [admissionId: string]>(
            "DELETE FROM occ.repository_session_attempts WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "42501" },
        );
        await pool.query<never, [admissionId: string, updatedAt: string]>(
          "UPDATE occ.repository_session_attempts SET phase = 'invalidated', updated_at = $2 WHERE admission_id = $1",
          [input.admissionId, "2030-03-17T17:46:41.000Z"],
        );
        const attempt = await store.read((view) =>
          view.repositorySessions.findAttempt(input.admissionId),
        );
        assert.ok(attempt);
        assert.equal(attempt.phase, "invalidated");
      },
    );

    await t.test("session admission serializes behind deleting ownership", async () => {
      const { namespace, agent, revision } = await seedSessionRevision(store);
      const deleting = await pool.connect();
      const admission = await pool.connect();
      try {
        const {
          rows: [backend],
        } = await admission.query<{ pid: number }, []>("SELECT pg_backend_pid() AS pid");
        assert.ok(backend);
        await deleting.query<never, []>("BEGIN");
        await deleting.query<never, [namespaceId: string]>(
          "SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE",
          [namespace.id],
        );
        await deleting.query<never, [agentId: string]>(
          "UPDATE occ.agents SET desired_runtime_state = 'stopped', status = 'deleting' WHERE id = $1",
          [agent.id],
        );
        const pending = insertAttempt(admission, sessionAttempt(revision));
        const refused = assert.rejects(pending, { code: "23514" });
        await waitForLockHolder(pool, backend.pid, "admission to wait on its Namespace owner", {
          timeoutMs: 5_000,
          intervalMs: 10,
        });
        // The owner commits deletion before the waiting INSERT may validate admission.
        await deleting.query<never, []>("COMMIT");
        await refused;
        assert.deepEqual(
          await store.read((view) =>
            view.repositorySessions.listRevisionAttempts({
              namespaceId: namespace.id,
              agentId: agent.id,
              revisionId: revision.id,
            }),
          ),
          [],
        );
      } finally {
        await deleting.query<never, []>("ROLLBACK");
        deleting.release();
        admission.release();
      }
    });

    await t.test(
      "SQL validates canonical draft and immutable revision repository snapshots",
      async (t) => {
        const { agent, revision } = await seedSessionRevision(store);
        const invalidDrafts = {
          "bindings are empty": [],
          "repository reference ends with a newline": [
            { repositoryRef: "source\n", profile: "git-read" },
          ],
          "profile ends with a newline": [{ repositoryRef: "source", profile: "git-read\n" }],
          "binding contains an extra field": [
            { repositoryRef: "source", profile: "read", bearer: "extra" },
          ],
          "repository reference appears twice": [
            { repositoryRef: "source", profile: "read" },
            { repositoryRef: "source", profile: "write" },
          ],
        };
        for (const [name, bindings] of Object.entries(invalidDrafts)) {
          await t.test(`draft: ${name}`, async () => {
            await assert.rejects(
              pool.query<never, [agentId: string, bindings: string]>(
                "UPDATE occ.agents SET repository_bindings = $2::jsonb WHERE id = $1",
                [agent.id, JSON.stringify(bindings)],
              ),
              { code: "23514" },
            );
          });
        }
        // Build malformed JSON separately from the typed, valid credential fixtures.
        const invalidSnapshots = {
          "snapshot is null": null,
          "bindings are empty": repositoryCredentials({ bindings: [] }),
          "bindings are an object": { ...repositoryCredentials(), bindings: {} },
          "driver contains an extra field": {
            ...repositoryCredentials(),
            driver: { ...revision.repositoryCredentials.driver, bearer: "unexpected" },
          },
          "binding contains an extra field": {
            ...repositoryCredentials(),
            bindings: [{ ...repositoryBinding(), bearer: "unexpected" }],
          },
          "grant is null": {
            ...repositoryCredentials(),
            bindings: [{ ...repositoryBinding(), grant: null }],
          },
          "grant contains an extra field": {
            ...repositoryCredentials(),
            bindings: [
              { ...repositoryBinding(), grant: { ...repositoryGrant(), bearer: "unexpected" } },
            ],
          },
          "deadline is fractional": repositoryCredentials({ deadlineWallMs: 1.5 }),
          "driver identity contains a newline": repositoryCredentials({
            driver: { id: "bad\nidentity", implementation: "native" },
          }),
          "driver identity exceeds 512 UTF-8 bytes": repositoryCredentials({
            driver: { id: `${"é".repeat(256)}x`, implementation: "github" },
          }),
          "provider identity contains surrounding spaces": repositoryCredentials({
            bindings: [repositoryBinding({ backendId: " provider " })],
          }),
          "provider identity exceeds 200 UTF-16 code units": repositoryCredentials({
            bindings: [repositoryBinding({ backendId: "😀".repeat(101) })],
          }),
          "provider identity starts with a nonbreaking space": repositoryCredentials({
            bindings: [repositoryBinding({ backendId: "\u00a0provider" })],
          }),
          "grant identity is empty": repositoryCredentials({
            bindings: [repositoryBinding({ grant: repositoryGrant({ grantId: "" }) })],
          }),
          "snapshot contains an extra field": { ...repositoryCredentials(), bearer: "extra" },
        };
        // Insert variants of a real admitted row so the repository snapshot is the only invalid input.
        for (const [name, credentials] of Object.entries(invalidSnapshots)) {
          await t.test(`snapshot: ${name}`, async () => {
            await assert.rejects(
              pool.query<
                never,
                [sourceRevisionId: string, newRevisionId: string, credentials: string]
              >(
                `INSERT INTO occ.agent_revisions (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
         SELECT $2, namespace_id, agent_id, 2,
           jsonb_set(admitted_spec, '{repository_credentials}', $3::jsonb), admitted_at
         FROM occ.agent_revisions WHERE id = $1`,
                [revision.id, `rev_${randomUUID()}`, JSON.stringify(credentials)],
              ),
              { code: "23514" },
            );
          });
        }
        const {
          rows: [row],
        } = await pool.query<{ credentials: RepositoryRevisionState | null }, [revisionId: string]>(
          "SELECT admitted_spec->'repository_credentials' AS credentials FROM occ.agent_revisions WHERE id = $1",
          [revision.id],
        );
        assert.ok(row);
        assert.deepEqual(row.credentials, revision.repositoryCredentials);
      },
    );
  },
);
