import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import type { AuthorizationRequest, Configuration } from "../../packages/contracts/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.ts";
import {
  accountPrincipalId,
  assertConsoleSignIn,
  assertProviderAttached,
  consoleOrigin as origin,
  oidcSignIn,
  oidcUpgradeSettings,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { waitFor } from "../helpers/wait-for.ts";

interface ResourceResponse<T> {
  readonly data?: T;
  readonly error?: { readonly code: string };
  readonly meta?: { readonly requestId: string };
}

async function responseBody<T>(response: Response, status: number) {
  const body = (await response.json()) as ResourceResponse<T>;
  assert.equal(response.status, status, JSON.stringify(body.error));
  return body;
}

async function resource<T extends { readonly id: string } = { readonly id: string }>(
  response: Response,
  status: number,
): Promise<T> {
  const body = await responseBody<T>(response, status);
  assert.ok(body.data);
  return body.data;
}

async function waitForNamespaceLock(pool: Pool, blockerPid: number): Promise<number> {
  return waitFor(
    "the Configuration authority Namespace lock waiter behind session " + blockerPid,
    async () => {
      const result = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND $1::int = ANY(pg_blocking_pids(pid))
           AND query LIKE '%FROM occ.namespaces%' AND query LIKE '%FOR UPDATE%'`,
        [blockerPid],
      );
      assert.ok(result.rows.length <= 1, "ambiguous Namespace lock waiter");
      return result.rows[0]?.pid;
    },
    { timeoutMs: 5_000 },
  );
}

test(
  "Configuration update refuses an exact grant withdrawn while waiting for its Namespace lock",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const apps: { close(): Promise<void> }[] = [];
    const fixture = await preparePostgresSignInInstallation(t, () => apps, {
      oidc: true,
      email: "configuration-update-admin@example.test",
      password: "configuration-update-fixture-password",
      secrets: {
        "occ-auth/secret": "configuration-update-fixture-cookie-secret",
        "occ-oidc-login/client-id": "configuration-update-fixture",
        "occ-oidc-login/client-secret": "configuration-update-fixture-client-secret",
      },
    });
    const { pool, state } = fixture;
    const {
      admin,
      accounts: { first, second },
    } = await fixture.onboard({
      accounts: {
        first: { email: "configuration-update-first@example.test" },
        second: { email: "configuration-update-second@example.test" },
      },
    });
    const app = await fixture.composeApp(oidcUpgradeSettings(admin.id));
    apps.push(app);
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const principalIds: string[] = [];
    const memberHeaders: { cookie: string; origin: string }[] = [];
    for (const [account, subject] of [
      [first, 8_103_001],
      [second, 8_103_002],
    ] as const) {
      await assertProviderAttached(app, adminHeaders, account.id, "oidc", String(subject));
      const { callback } = await oidcSignIn(app, origin, fixture.oidc, {
        subject: String(subject),
      });
      memberHeaders.push({ cookie: await assertConsoleSignIn(app, callback, account.id), origin });
      principalIds.push(await accountPrincipalId(pool, account.id));
    }
    const [firstHeaders, secondHeaders] = memberHeaders;
    const [firstPrincipalId] = principalIds;
    assert.ok(firstHeaders && secondHeaders && firstPrincipalId);
    const namespaceId = "ns_" + randomUUID();
    await state.transact(async (unit) => {
      await unit.namespaces.createNamespace({
        id: namespaceId,
        name: "configuration-update-" + randomUUID(),
        status: "ready",
        createdAt: new Date().toISOString(),
      });
    });
    const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    const namespace = "/namespaces/" + namespaceId;
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
      return fetch(endpoint + namespace + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
    }
    const originalValues = {
      agents: { defaults: { skipBootstrap: true } },
      plugins: { allow: [] },
    };
    const replacementValues = { agents: { defaults: { skipBootstrap: false } } };
    const configuration = await resource<Configuration>(
      await request("POST", "/configurations", { kind: "agent", values: originalValues }),
      201,
    );
    const path = "/configurations/" + configuration.id;
    const bindingPath = "/iam/access-bindings";
    const updateRole = await resource(
      await request("POST", "/iam/roles", {
        permissions: [{ action: "update", resourceKind: "configuration" }],
      }),
      201,
    );
    const readRole = await resource(
      await request("POST", "/iam/roles", {
        permissions: [{ action: "read", resourceKind: "configuration" }],
      }),
      201,
    );
    async function bind(subjectId: string, roleId: string) {
      return resource(
        await request("POST", bindingPath, {
          subjectKind: "identity",
          subjectId,
          roleId,
          resourceKind: "configuration",
          resourceId: configuration.id,
        }),
        201,
      );
    }
    const bindings = [];
    for (const principalId of principalIds) {
      bindings.push(await bind(principalId, updateRole.id));
      await bind(principalId, readRole.id);
    }
    const [withdrawn] = bindings;
    assert.ok(withdrawn);
    const originalEdit = { values: originalValues };
    const replacementEdit = { values: replacementValues };

    // Each independent session proves its own exact update grant before withdrawal.
    for (const headers of [firstHeaders, secondHeaders]) {
      const updated = await resource<Configuration>(
        await request("PATCH", path, originalEdit, headers),
        200,
      );
      assert.deepEqual(updated.values, originalValues);
    }
    async function snapshot() {
      const current = await resource<Configuration>(await request("GET", path), 200);
      const metadata = await pool.query<{ metadata: unknown }>(
        "SELECT to_jsonb(c) AS metadata FROM occ.configurations AS c WHERE id = $1",
        [configuration.id],
      );
      assert.equal(metadata.rowCount, 1);
      const audits = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM occ.audit_events
         WHERE action = 'openclaw.configurations.update' AND kind = 'mutation'
           AND outcome = 'success' AND resource_kind = 'configuration' AND resource_id = $1`,
        [configuration.id],
      );
      assert.ok(audits.rows[0]);
      return {
        configuration: current,
        metadata: metadata.rows[0]?.metadata,
        successAudits: audits.rows[0].count,
      };
    }
    const before = await snapshot();
    assert.deepEqual(before.configuration.values, originalValues);

    // The administrator's genuine IAM deletion queues first. The wait chain,
    // rather than HTTP completion order, proves PATCH is behind that withdrawal.
    const blocker = await pool.connect();
    let withdrawal: Promise<Response> | undefined;
    let update: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      const holder = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id = $1 FOR UPDATE",
        [namespaceId],
      );
      assert.ok(holder.rows[0]);
      withdrawal = request("DELETE", bindingPath + "/" + withdrawn.id);
      const withdrawalPid = await waitForNamespaceLock(pool, holder.rows[0].pid);
      update = request("PATCH", path, replacementEdit, firstHeaders);
      await waitForNamespaceLock(pool, withdrawalPid);
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
        await Promise.allSettled([withdrawal, update]);
      }
    }
    assert.ok(withdrawal !== undefined && update !== undefined);
    assert.equal((await withdrawal).status, 204);
    const raced = await update;
    const denied = (await raced.json()) as ResourceResponse<Configuration>;
    if (raced.status === 200) {
      // On the unfixed source, establish the actual unauthorized replacement
      // before failing the required refusal assertion below.
      assert.deepEqual(denied.data, {
        ...before.configuration,
        generation: before.configuration.generation + 1,
        values: replacementValues,
      });
      const staleWrite = await snapshot();
      assert.deepEqual(staleWrite.configuration, denied.data);
      assert.equal(staleWrite.successAudits, before.successAudits + 1);
    }
    assert.equal(
      raced.status,
      403,
      "the withdrawn grant must be rechecked before Configuration replacement",
    );
    assert.equal(denied.error?.code, "FORBIDDEN");
    assert.ok(denied.meta?.requestId);
    assert.deepEqual(await snapshot(), before);
    const denial = await pool.query<{ authorization: AuthorizationRequest }>(
      `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
       FROM occ.audit_events WHERE actor_id = $1 AND action = 'openclaw.configurations.update'
         AND kind = 'authorization_denial' AND outcome = 'denied'
         AND details->'__occAuditMetadata'->>'requestId' = $2`,
      [firstPrincipalId, denied.meta.requestId],
    );
    assert.deepEqual(denial.rows, [
      {
        authorization: {
          principalId: firstPrincipalId,
          action: "update",
          resource: { kind: "configuration", id: configuration.id, namespaceId },
        },
      },
    ]);

    // Read remains separately granted, and the other session still has update.
    // Neither a broken session nor a blanket refusal can satisfy these controls.
    assert.deepEqual(
      await resource<Configuration>(await request("GET", path, undefined, firstHeaders), 200),
      before.configuration,
    );
    const later = await responseBody<never>(
      await request("PATCH", path, replacementEdit, firstHeaders),
      403,
    );
    assert.equal(later.error?.code, "FORBIDDEN");
    const accepted = await resource<Configuration>(
      await request("PATCH", path, replacementEdit, secondHeaders),
      200,
    );
    assert.deepEqual(accepted, {
      ...before.configuration,
      generation: before.configuration.generation + 1,
      values: replacementValues,
    });
    const after = await snapshot();
    assert.deepEqual(after.configuration, accepted);
    assert.equal(after.successAudits, before.successAudits + 1);
  },
);
