import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import type { Preset, PresetTemplate } from "../../packages/contracts/src/index.ts";
import { createConsoleFixtureTransport } from "../helpers/console-fixture-transport.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
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
  },
);
