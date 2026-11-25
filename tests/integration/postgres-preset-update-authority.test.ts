import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { Pool, PoolClient } from "pg";

import type { Preset, PresetTemplate } from "../../packages/contracts/src/index.ts";
import { createConsoleFixtureTransport } from "../helpers/console-fixture-transport.ts";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.ts";
import {
  accountPrincipalId,
  consoleOrigin,
  defaultInstallSettings,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { waitFor } from "../helpers/wait-for.ts";

interface StoredPreset {
  readonly id: string;
  readonly namespace_id: string;
  readonly name: string;
  readonly template: PresetTemplate;
  readonly created_at: Date;
}

interface ResourceResponse<T> {
  readonly data?: T;
  readonly error?: { readonly code: string };
}

function resource<T>(response: { status: number; body: unknown }, status: number): T {
  const body = response.body as ResourceResponse<T> | undefined;
  assert.equal(response.status, status, JSON.stringify(body?.error));
  assert.ok(body?.data);
  return body.data;
}

function waitForNamespaceLock(
  pool: Pool,
  blockerPid: number,
  description: string,
): Promise<number> {
  return waitFor(
    description,
    async () => {
      const { rows } = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND $1::int = ANY(pg_blocking_pids(pid))
           AND query LIKE '%FROM occ.namespaces%FOR UPDATE%'`,
        [blockerPid],
      );
      assert.ok(rows.length <= 1, `Ambiguous Namespace lock wait for ${description}`);
      return rows[0]?.pid;
    },
    5_000,
  );
}

test(
  "Preset PATCH refuses an exact grant withdrawn while waiting for its Namespace lock",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const apps: { close(): Promise<void> }[] = [];
    const fixture = await preparePostgresSignInInstallation(t, () => apps, {
      email: "preset-update-admin@example.test",
      password: "preset-update-fixture-password",
      secrets: { "occ-auth/secret": "preset-update-fixture-cookie-secret" },
    });
    const { pool, state } = fixture;
    // The fixture pool and API use the same database URL. The API's write transaction
    // inherits the session default, so require READ COMMITTED for this case.
    const isolation = await pool.query<{ default_transaction_isolation: string }>(
      "SHOW default_transaction_isolation",
    );
    assert.equal(isolation.rows[0]?.default_transaction_isolation, "read committed");
    const {
      admin,
      accounts: { member },
    } = await fixture.onboard({
      accounts: { member: { email: "preset-update-member@example.test" } },
    });
    const app = await fixture.composeApp(defaultInstallSettings);
    apps.push(app);
    const adminHeaders = await signedInHeaders(app, consoleOrigin, admin);
    const memberHeaders = await signedInHeaders(app, consoleOrigin, member);
    const memberPrincipal = await accountPrincipalId(pool, member.id);

    // Ready Namespace fixtures keep this test independent of Compute provisioning.
    const namespaceId = `ns_${randomUUID()}`;
    const otherNamespaceId = `ns_${randomUUID()}`;
    await state.transact(async (unit) => {
      for (const id of [namespaceId, otherNamespaceId]) {
        await unit.namespaces.createNamespace({
          id,
          name: `Preset authority ${id}`,
          status: "ready",
          createdAt: new Date().toISOString(),
        });
      }
    });
    const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    const { rawRequest } = createConsoleFixtureTransport(consoleOrigin, endpoint);
    async function request(method: string, path: string, body?: object, headers = adminHeaders) {
      const { response, text } = await rawRequest(method, path, { body, headers, timeout: 20_000 });
      const payload: unknown = response.status === 204 ? undefined : JSON.parse(text);
      return { status: response.status, body: payload };
    }
    async function createPreset(ownerId: string, name: string): Promise<Preset> {
      return resource<Preset>(
        await request("POST", `/namespaces/${ownerId}/presets`, { name, template: {} }),
        201,
      );
    }
    const target = await createPreset(namespaceId, "Target Preset");
    const sibling = await createPreset(namespaceId, "Sibling Preset");
    const foreign = await createPreset(otherNamespaceId, "Other Namespace Preset");
    const namespacePath = `/namespaces/${namespaceId}`;
    const targetPath = `${namespacePath}/presets/${target.id}`;
    const bindingPath = `${namespacePath}/iam/access-bindings`;

    // The member starts with Installation read. Give it only the target Preset's update grant.
    const role = resource<{ id: string }>(
      await request("POST", `${namespacePath}/iam/roles`, {
        permissions: [{ action: "update", resourceKind: "preset" }],
      }),
      201,
    );
    const binding = resource<{ id: string }>(
      await request("POST", bindingPath, {
        subjectKind: "identity",
        subjectId: memberPrincipal,
        roleId: role.id,
        resourceKind: "preset",
        resourceId: target.id,
      }),
      201,
    );

    // Observe all three exact rows in one snapshot independent of the API transactions.
    async function readPresets(): Promise<StoredPreset[]> {
      const { rows } = await pool.query<StoredPreset>(
        `SELECT id, namespace_id, name, template, created_at
         FROM occ.presets WHERE (namespace_id, id) IN (($1, $2), ($1, $3), ($4, $5))
         ORDER BY id`,
        [namespaceId, target.id, sibling.id, otherNamespaceId, foreign.id],
      );
      assert.equal(
        rows.length,
        3,
        "expected the target, its sibling, and the other Namespace's Preset",
      );
      return rows;
    }
    const original = await readPresets();
    const control = { name: "Allowed update", template: { agent: { name: "Allowed draft" } } };
    const allowed = resource<Preset>(
      await request("PATCH", targetPath, control, memberHeaders),
      200,
    );
    assert.equal(allowed.id, target.id);
    assert.equal(allowed.namespaceId, namespaceId);
    const beforeRace = await readPresets();
    assert.deepEqual(
      beforeRace,
      original.map((row) => (row.id === target.id ? { ...row, ...control } : row)),
    );

    // Queue revocation first. PATCH reaches its Namespace lock only after the early grant checks.
    const blocker = await pool.connect();
    let withdrawal: ReturnType<typeof request> | undefined;
    let update: ReturnType<typeof request> | undefined;
    let discardBlocker = true;
    try {
      await blocker.query("BEGIN");
      const { rows } = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id = $1 FOR UPDATE NOWAIT",
        [namespaceId],
      );
      const lockOwner = rows[0];
      assert.ok(lockOwner);
      withdrawal = request("DELETE", `${bindingPath}/${binding.id}`);
      void withdrawal.catch(() => {});
      const withdrawalPid = await waitForNamespaceLock(pool, lockOwner.pid, "AccessBinding DELETE");
      update = request(
        "PATCH",
        targetPath,
        { name: "Revoked update", template: { agent: { name: "Revoked draft" } } },
        memberHeaders,
      );
      void update.catch(() => {});
      await waitForNamespaceLock(pool, withdrawalPid, "Preset PATCH behind AccessBinding DELETE");
    } finally {
      try {
        await blocker.query("ROLLBACK");
        discardBlocker = false;
      } finally {
        blocker.release(discardBlocker);
        await Promise.allSettled([withdrawal, update]);
      }
    }
    const deleted = await withdrawal;
    const raced = await update;
    const remainingBinding = await pool.query(
      "SELECT id FROM occ.iam_access_bindings WHERE namespace_id = $1 AND id = $2",
      [namespaceId, binding.id],
    );
    const afterRace = await readPresets();
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
    assert.deepEqual(remainingBinding.rows, [], "revocation must remove the exact AccessBinding");

    // Include storage in the same assertion as status so a pre-fix run reports the persisted marker.
    assert.deepEqual(
      {
        status: raced.status,
        error: (raced.body as ResourceResponse<Preset> | undefined)?.error?.code,
        presets: afterRace,
      },
      { status: 403, error: "FORBIDDEN", presets: beforeRace },
      "the withdrawn grant must be rechecked before any Preset changes",
    );

    async function checkDeletes() {
      // Use the same Installation and a separate member connection default. Keep the
      // administrator's revocations on the original app and its own session.
      assert.ok(databaseUrl);
      const url = new URL(databaseUrl);
      const applicationName = `preset-delete-${randomUUID()}`;
      url.searchParams.set("application_name", applicationName);
      url.searchParams.set(
        "options",
        [url.searchParams.get("options"), "-c default_transaction_isolation=repeatable\\ read"]
          .filter(Boolean)
          .join(" "),
      );
      const observer = testPool(t, { connectionString: url.href });
      const defaults = await observer.query("SHOW default_transaction_isolation");
      assert.equal(defaults.rows[0]?.default_transaction_isolation, "repeatable read");
      const memberApp = await fixture.composeApp(defaultInstallSettings, { databaseUrl: url.href });
      apps.push(memberApp);
      const headers = await signedInHeaders(memberApp, consoleOrigin, member);
      const deleteRole = resource<{ id: string }>(
        await request("POST", `${namespacePath}/iam/roles`, {
          permissions: [{ action: "delete", resourceKind: "preset" }],
        }),
        201,
      );
      const grant = async (preset: Preset, roleId = deleteRole.id) =>
        resource<{ id: string }>(
          await request("POST", bindingPath, {
            subjectKind: "identity",
            subjectId: memberPrincipal,
            roleId,
            resourceKind: "preset",
            resourceId: preset.id,
          }),
          201,
        ).id;
      const snapshot = () =>
        state.read(async (view) => ({
          presets: await view.presets.listPresets(namespaceId),
          bindings: await view.iamPolicy.listAccessBindings(namespaceId),
          foreign: await view.presets.findPreset(otherNamespaceId, foreign.id),
          foreignBindings: await view.iamPolicy.listAccessBindings(otherNamespaceId),
        }));

      async function race(
        preset: Preset,
        bindingId: string,
        order: "revoke" | "delete" | "unrelated",
      ) {
        const before = await snapshot();
        const targeted = before.bindings.filter(
          (binding) => binding.resourceKind === "preset" && binding.resourceId === preset.id,
        );
        assert.ok(targeted.some((binding) => binding.subjectId === memberPrincipal));
        assert.equal(
          targeted.some((binding) => binding.id === bindingId),
          order !== "unrelated",
        );
        const denied = order === "revoke";
        if (denied) {
          assert.ok(targeted.some((binding) => binding.id === retained));
        }
        const gate = await pool.connect();
        let guard: PoolClient | undefined;
        const deletePreset = async () =>
          memberApp.inject({
            method: "DELETE",
            url: `${namespacePath}/presets/${preset.id}`,
            headers,
          });
        let removal: ReturnType<typeof deletePreset> | undefined;
        let revoke: ReturnType<typeof request> | undefined;
        let signOut: ReturnType<typeof request> | undefined;
        let requestId: string;
        try {
          // Order the two real HTTP writers on the same Namespace row. In the denial
          // case also hold the Preset independently: even a rolled-back delete would block.
          if (denied) {
            guard = await observer.connect();
            await guard.query("BEGIN");
            const locked = await guard.query(
              "SELECT id FROM occ.presets WHERE namespace_id = $1 AND id = $2 FOR UPDATE NOWAIT",
              [namespaceId, preset.id],
            );
            assert.equal(locked.rowCount, 1);
          }
          await gate.query("BEGIN");
          const lock = await gate.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id = $1 FOR UPDATE NOWAIT",
            [namespaceId],
          );
          assert.ok(lock.rows[0]);
          let predecessor = lock.rows[0].pid;
          for (const writer of order === "delete" ? ["delete", "revoke"] : ["revoke", "delete"]) {
            if (writer === "delete") {
              removal = deletePreset();
              void removal.catch(() => {});
            } else {
              revoke = request("DELETE", `${bindingPath}/${bindingId}`);
              void revoke.catch(() => {});
            }
            predecessor = await waitForNamespaceLock(pool, predecessor, writer);
            if (writer === "delete") {
              const backend = await pool.query(
                "SELECT application_name FROM pg_stat_activity WHERE pid = $1",
                [predecessor],
              );
              assert.equal(backend.rows[0]?.application_name, applicationName);
            }
          }
          assert.ok(removal);
          assert.ok(revoke);
          if (order === "unrelated") {
            // On a second Controller, sign-out of the assigning session must wait
            // for the admitted DELETE, even while it is waiting for the Namespace.
            signOut = request("POST", "/api/auth/sign-out", undefined, headers);
            void signOut.catch(() => {});
            await waitFor(
              "sign-out blocked by the Preset writer",
              async () => {
                const result = await pool.query(
                  `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                 AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
                  [predecessor],
                );
                assert.ok(result.rows.length <= 1);
                return result.rows[0];
              },
              5_000,
            );
          }
          await gate.query("ROLLBACK");
          if (guard) {
            const rowLock = guard;
            let done = false;
            void removal
              .finally(() => {
                done = true;
              })
              .catch(() => {});
            await waitFor(
              "refusal while the Preset row remains locked",
              async () => {
                const result = await rowLock.query(
                  "SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS attempted",
                  [predecessor],
                );
                assert.equal(
                  result.rows[0]?.attempted,
                  false,
                  "revoked DELETE reached the protected Preset row",
                );
                return done ? true : undefined;
              },
              5_000,
            );
          }
          const response = await removal;
          const withdrawal = await revoke;
          // A successful DELETE already removes its exact grant, so a later revoker
          // cannot delete that binding again. An unrelated withdrawal must allow deletion.
          assert.equal(
            withdrawal.status,
            order === "delete" ? 404 : 204,
            JSON.stringify(withdrawal.body),
          );
          assert.equal(response.statusCode, denied ? 403 : 204, response.body);
          const responseId = response.headers["x-request-id"];
          assert.ok(typeof responseId === "string" && responseId.length > 0);
          requestId = responseId;
          if (denied) {
            assert.equal(response.json().error.code, "FORBIDDEN");
          }
          if (signOut) {
            assert.equal((await signOut).status, 200);
            const stale = await memberApp.inject({ method: "DELETE", url: targetPath, headers });
            assert.equal(stale.statusCode, 401, stale.body);
          }
        } finally {
          // Discard the lock sessions on every path before draining outstanding requests.
          guard?.release(true);
          gate.release(true);
          await Promise.allSettled([removal, revoke, signOut]);
        }

        const removed = denied ? [] : targeted.map((binding) => binding.id);
        assert.deepEqual(await snapshot(), {
          ...before,
          presets: before.presets.filter((row) => denied || row.id !== preset.id),
          bindings: before.bindings.filter(
            (row) => row.id !== bindingId && !removed.includes(row.id),
          ),
        });
        const { rows } = await pool.query(
          `SELECT actor_id, kind, outcome, action, resource_kind, resource_id,
                  details #>> '{__occAuditMetadata,authorization,principalId}' AS principal,
                  details #>> '{__occAuditMetadata,requestId}' AS request_id,
                  details #>> '{__occAuditMetadata,authorization,action}' AS permission,
                  details #> '{__occAuditMetadata,authorization,resource}' AS target,
                  jsonb_path_query_array(details, '$.removedAccessBindings[*].id') AS removed
           FROM occ.audit_events
           WHERE namespace_id = $1 AND details #>> '{__occAuditMetadata,requestId}' = $2
             AND kind IN ('mutation', 'authorization_denial')`,
          [namespaceId, requestId],
        );
        assert.deepEqual(rows, [
          {
            actor_id: memberPrincipal,
            principal: memberPrincipal,
            action: "openclaw.presets.delete",
            resource_kind: "preset",
            resource_id: preset.id,
            request_id: requestId,
            permission: "delete",
            kind: denied ? "authorization_denial" : "mutation",
            outcome: denied ? "denied" : "success",
            target: { kind: "preset", id: preset.id, namespaceId },
            removed,
          },
        ]);
      }

      // Withdrawal of delete must leave an independent update binding on the target.
      const retained = await grant(target, role.id);
      const siblingGrant = await grant(sibling);
      await race(target, await grant(target), "revoke");
      const first = await createPreset(namespaceId, "Writer first");
      await race(first, await grant(first), "delete");
      const healthy = await createPreset(namespaceId, "Grant retained");
      await grant(healthy);
      await race(healthy, siblingGrant, "unrelated");
    }
    await checkDeletes();
  },
);
