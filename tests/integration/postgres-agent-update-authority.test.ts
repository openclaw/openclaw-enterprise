import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import type { Pool } from "pg";

import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";
import {
  accountPrincipalId,
  assertConsoleSignIn,
  assertProviderAttached,
  consoleOrigin as origin,
  githubSignIn,
  githubUpgradeSettings,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";

interface Account {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

interface ResourceResponse {
  readonly data?: { readonly id: string; readonly configurationId?: string };
  readonly error?: { readonly code: string };
}

async function resource(response: Response, status: number) {
  const body = (await response.json()) as ResourceResponse;
  assert.equal(response.status, status, JSON.stringify(body.error));
  assert.ok(body.data);
  return body.data;
}

async function waitForNamespaceLock(pool: Pool, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND $1::int = ANY(pg_blocking_pids(pid))
         AND query LIKE '%FROM occ.namespaces%' AND query LIKE '%FOR UPDATE%'`,
      [blockerPid],
    );
    assert.ok(result.rows.length <= 1, "ambiguous Namespace lock waiter");
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) {
      return pid;
    }
    await setTimeout(20);
  } while (Date.now() < deadline);
  assert.fail(`no Namespace lock waiter blocked by PostgreSQL session ${blockerPid}`);
}

test(
  "Agent update refuses an exact grant withdrawn while waiting for its Namespace lock",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const apps: { close(): Promise<void> }[] = [];
    const fixture = await preparePostgresSignInInstallation(t, () => apps, {
      email: "agent-update-admin@example.test",
      password: "agent-update-fixture-password",
      secrets: {
        "occ-auth/secret": "agent-update-fixture-cookie-secret",
        "occ-github-login/client-id": "agent-update-fixture",
        "occ-github-login/client-secret": "agent-update-fixture-client-secret",
      },
    });
    const { pool, state } = fixture;
    const onboarded = await fixture.onboard({
      accounts: {
        first: { email: "agent-update-first@example.test" },
        second: { email: "agent-update-second@example.test" },
      },
    });
    const admin = onboarded.admin as Account;
    const { first, second } = onboarded.accounts as Record<"first" | "second", Account>;
    const app = await fixture.composeApp(githubUpgradeSettings(admin.id));
    apps.push(app);
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const principalIds: string[] = [];
    const memberHeaders: { cookie: string; origin: string }[] = [];
    for (const [account, subject] of [
      [first, 8_102_001],
      [second, 8_102_002],
    ] as const) {
      await assertProviderAttached(app, adminHeaders, account.id, "github", String(subject));
      const { callback } = await githubSignIn(app, origin, subject);
      memberHeaders.push({ cookie: await assertConsoleSignIn(app, callback, account.id), origin });
      principalIds.push(await accountPrincipalId(pool, account.id));
    }
    const [firstHeaders, secondHeaders] = memberHeaders;
    assert.ok(firstHeaders && secondHeaders);
    const namespaceId = `ns_${randomUUID()}`;
    await state.transact(async (unit) => {
      await unit.namespaces.createNamespace({
        id: namespaceId,
        name: `agent-update-${randomUUID()}`,
        status: "ready",
        createdAt: new Date().toISOString(),
      });
    });
    const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    const namespace = `/namespaces/${namespaceId}`;
    async function request(
      method: string,
      path: string,
      body?: object,
      auth: HeadersInit = adminHeaders,
    ) {
      const headers = new Headers(auth);
      if (body !== undefined) {
        headers.set("content-type", "application/json");
      }
      return fetch(`${endpoint}${namespace}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
    }
    const configuration = { kind: "agent", values: {} };
    const original = await resource(await request("POST", "/configurations", configuration), 201);
    const replacement = await resource(
      await request("POST", "/configurations", configuration),
      201,
    );
    const agent = await resource(
      await request("POST", "/agents", { name: "Shared draft", configurationId: original.id }),
      201,
    );
    const agentPath = `/agents/${agent.id}`;
    const bindingPath = "/iam/access-bindings";
    const updateRole = await resource(
      await request("POST", "/iam/roles", {
        permissions: [{ action: "update", resourceKind: "agent" }],
      }),
      201,
    );
    const readConfigurationRole = await resource(
      await request("POST", "/iam/roles", {
        permissions: [{ action: "read", resourceKind: "configuration" }],
      }),
      201,
    );
    async function bind(
      subjectId: string,
      roleId: string,
      resourceKind: string,
      resourceId: string,
    ) {
      return resource(
        await request("POST", bindingPath, {
          subjectKind: "identity",
          subjectId,
          roleId,
          resourceKind,
          resourceId,
        }),
        201,
      );
    }
    const bindings = [];
    for (const principalId of principalIds) {
      bindings.push(await bind(principalId, updateRole.id, "agent", agent.id));
      for (const { id } of [original, replacement]) {
        await bind(principalId, readConfigurationRole.id, "configuration", id);
      }
    }
    const [withdrawn] = bindings;
    assert.ok(withdrawn);
    const originalEdit = { configurationId: original.id };
    const replacementEdit = { configurationId: replacement.id };
    // Both sessions can edit through their own grants before one is withdrawn.
    assert.equal(
      (await resource(await request("PATCH", agentPath, originalEdit, firstHeaders), 200))
        .configurationId,
      original.id,
    );
    assert.equal(
      (await resource(await request("PATCH", agentPath, originalEdit, secondHeaders), 200))
        .configurationId,
      original.id,
    );

    // Queue the real IAM withdrawal first, then the Agent update. PostgreSQL's
    // wait chain establishes the order independently of either HTTP response.
    const blocker = await pool.connect();
    let withdrawal: Promise<Response> | undefined;
    let update: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      const { rows } = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id = $1 FOR UPDATE",
        [namespaceId],
      );
      const lockOwner = rows[0];
      assert.ok(lockOwner);
      withdrawal = request("DELETE", `${bindingPath}/${withdrawn.id}`);
      const withdrawalPid = await waitForNamespaceLock(pool, lockOwner.pid);
      update = request("PATCH", agentPath, replacementEdit, firstHeaders);
      await waitForNamespaceLock(pool, withdrawalPid);
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
        await Promise.allSettled([withdrawal, update]);
      }
    }
    assert.equal((await withdrawal).status, 204);
    const raced = await update;
    assert.equal(raced.status, 403, "the withdrawn grant must be rechecked under the lock");
    assert.equal(
      (await resource(await request("GET", agentPath), 200)).configurationId,
      original.id,
    );

    // The same signed-in caller still reads the independent Configuration grant.
    assert.equal(
      (
        await resource(
          await request("GET", `/configurations/${replacement.id}`, undefined, firstHeaders),
          200,
        )
      ).id,
      replacement.id,
    );
    assert.equal((await request("PATCH", agentPath, replacementEdit, firstHeaders)).status, 403);
    assert.equal(
      (await resource(await request("PATCH", agentPath, replacementEdit, secondHeaders), 200))
        .configurationId,
      replacement.id,
    );
  },
);
