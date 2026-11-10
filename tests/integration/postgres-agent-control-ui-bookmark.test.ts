import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";
import {
  accountPrincipalId,
  assertConsoleSignIn,
  assertProviderAttached,
  consoleOrigin as origin,
  oidcSignIn,
  oidcUpgradeSettings,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";

type Account = { id: string; email: string; password: string };
type Bookmark = { url: string | null; version: number };

// Exercise the public authenticated workflow against real native IAM and PostgreSQL, not
// repository mocks: bookmark edits must remain independent of saved runtime configuration.
test(
  "shared Agent Control UI bookmarks enforce exact authority, CAS, clearing, and atomic audit without runtime changes",
  requiresPostgres,
  async (context) => {
    const apps: { close(): Promise<void> }[] = [];
    const fixture = await preparePostgresSignInInstallation(context, () => apps, {
      oidc: true,
      email: "bookmark-admin@example.test",
      password: "bookmark-fixture-password",
      secrets: {
        "occ-auth/secret": "bookmark-fixture-cookie-secret-at-least-32-characters",
        "occ-oidc-login/client-id": "bookmark-fixture",
        "occ-oidc-login/client-secret": "bookmark-fixture-client-secret",
      },
    });
    const { pool } = fixture;
    assert.ok(
      process.env.OCC_TEST_AGENT_CONTROL_UI_BOOKMARK_MIGRATION_DATABASE_URL,
      "The audit failure fixture requires its real migrator credential.",
    );
    const migrator = new pg.Pool({
      connectionString: process.env.OCC_TEST_AGENT_CONTROL_UI_BOOKMARK_MIGRATION_DATABASE_URL,
    });
    context.after(() => migrator.end());
    const onboarded = await fixture.onboard({
      accounts: {
        editor: { email: "bookmark-editor@example.test" },
        reader: { email: "bookmark-reader@example.test" },
      },
    });
    const settings = oidcUpgradeSettings((onboarded.admin as Account).id);
    const namespaceId = `ns_${randomUUID()}`;
    await fixture.state.transact(async (unit) => {
      await unit.namespaces.createNamespace({
        id: namespaceId,
        name: "bookmark-namespace",
        status: "ready",
        createdAt: new Date().toISOString(),
      });
    });
    const accounts = onboarded.accounts as Record<string, Account>;
    const app = await fixture.composeApp(settings);
    const otherApp = await fixture.composeApp(settings);
    apps.push(app, otherApp);
    const admin = await signedInHeaders(app, origin, onboarded.admin);
    const memberHeaders: { host: string; cookie: string; origin: string }[] = [];
    for (const [account, subject] of [
      [accounts.editor!, 8201001],
      [accounts.reader!, 8201002],
    ] as const) {
      await assertProviderAttached(app, admin, account.id, "oidc", String(subject));
      const { callback } = await oidcSignIn(app, origin, fixture.oidc, {
        subject: String(subject),
      });
      memberHeaders.push({
        host: new URL(origin).host,
        cookie: await assertConsoleSignIn(app, callback, account.id),
        origin,
      });
    }
    const editor = memberHeaders[0]!;
    const reader = memberHeaders[1]!;
    const editorPrincipalId = await accountPrincipalId(pool, accounts.editor!.id);
    const base = "/namespaces/" + namespaceId;
    const call = (
      method: "GET" | "POST" | "PUT",
      path: string,
      payload?: object,
      headers = admin,
      target = app,
    ) =>
      target.inject({
        method,
        url: base + path,
        headers: { ...headers, origin },
        ...(payload === undefined ? {} : { payload }),
      });
    async function data<T>(response: Awaited<ReturnType<typeof call>>, status = 200): Promise<T> {
      assert.equal(response.statusCode, status, response.body);
      return response.json().data as T;
    }
    const configuration = await data<{ id: string }>(
      await call("POST", "/configurations", { kind: "agent", values: {} }),
      201,
    );
    const agent = await data<{ id: string }>(
      await call("POST", "/agents", { name: "Shared bookmark", configurationId: configuration.id }),
      201,
    );
    const sibling = await data<{ id: string }>(
      await call("POST", "/agents", {
        name: "Sibling bookmark",
        configurationId: configuration.id,
      }),
      201,
    );
    const path = "/agents/" + agent.id + "/control-ui-bookmark";
    async function grant(account: Account, actions: string[], id: string) {
      const role = await data<{ id: string }>(
        await call("POST", "/iam/roles", {
          permissions: actions.map((action) => ({ action, resourceKind: "agent" })),
        }),
        201,
      );
      await data(
        await call("POST", "/iam/access-bindings", {
          subjectKind: "identity",
          subjectId: await accountPrincipalId(pool, account.id),
          roleId: role.id,
          resourceKind: "agent",
          resourceId: id,
        }),
        201,
      );
    }
    await grant(accounts.editor!, ["read", "update"], agent.id);
    await grant(accounts.reader!, ["read"], agent.id);
    assert.deepEqual(await data<Bookmark>(await call("GET", path, undefined, editor)), {
      url: null,
      version: 0,
    });
    assert.equal(
      (await call("GET", "/configurations/" + configuration.id, undefined, editor)).statusCode,
      403,
      "the editor cannot read the saved Configuration",
    );
    const before = (
      await pool.query(
        "SELECT to_jsonb(a) - 'control_ui_bookmark_url' - 'control_ui_bookmark_version' AS record FROM occ.agents a WHERE id = $1",
        [agent.id],
      )
    ).rows[0].record;
    const queueBefore = (await pool.query("SELECT count(*)::int AS count FROM occ.controller_work"))
      .rows[0].count;
    const url = "https://control.example.test/team/agent";
    assert.deepEqual(
      await data<Bookmark>(await call("PUT", path, { url, expectedVersion: 0 }, editor)),
      { url, version: 1 },
    );
    assert.deepEqual(
      await data<Bookmark>(await call("GET", path, undefined, reader, otherApp)),
      { url, version: 1 },
      "another browser and application instance sees the same saved bookmark",
    );
    assert.equal(
      (await call("PUT", path, { url: null, expectedVersion: 1 }, reader)).statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          "PUT",
          "/agents/" + sibling.id + "/control-ui-bookmark",
          { url, expectedVersion: 0 },
          editor,
        )
      ).statusCode,
      403,
    );
    const crossNamespace = await app.inject({
      method: "PUT",
      url: `/namespaces/ns_${randomUUID()}/agents/${agent.id}/control-ui-bookmark`,
      headers: { ...editor, origin },
      payload: { url, expectedVersion: 1 },
    });
    assert.equal(crossNamespace.statusCode, 403);
    for (const invalid of [
      "http://control.example.test",
      "https://control.example.test/?token=private",
      "https://control.example.test/#fragment",
      "https://control.example.test/\npath",
      "https:///missing-host",
      "https://control.example.test:invalid/",
      "https://control.example.test/" + "x".repeat(2048),
    ]) {
      assert.equal(
        (await call("PUT", path, { url: invalid, expectedVersion: 1 }, editor)).statusCode,
        400,
        invalid,
      );
    }
    // Credentials are constructed at runtime so the test does not store a credential-bearing URL.
    const credentialUrl = syntheticCredentialUrl({
      username: "user",
      password: "password",
      host: "control.example.test",
      port: undefined,
      pathname: "/",
    });
    assert.equal(
      (await call("PUT", path, { url: credentialUrl, expectedVersion: 1 }, editor)).statusCode,
      400,
    );
    for (const body of [{ url }, { url, expectedVersion: -1 }, { url, expectedVersion: 1.5 }]) {
      assert.equal((await call("PUT", path, body, editor)).statusCode, 400);
    }
    const racing = await Promise.all([
      call("PUT", path, { url: url + "/one", expectedVersion: 1 }, editor),
      call("PUT", path, { url: url + "/two", expectedVersion: 1 }, editor, otherApp),
    ]);
    assert.deepEqual(racing.map((result) => result.statusCode).sort(), [200, 409]);
    assert.deepEqual(
      await data<Bookmark>(await call("PUT", path, { url: null, expectedVersion: 2 }, editor)),
      { url: null, version: 3 },
    );
    assert.equal(
      (await call("PUT", path, { url, expectedVersion: 2 }, editor)).statusCode,
      409,
      "an editor predating clear cannot resurrect the URL",
    );
    assert.deepEqual(await data<Bookmark>(await call("GET", path, undefined, reader, otherApp)), {
      url: null,
      version: 3,
    });
    const audit = await pool.query(
      "SELECT actor_id, details FROM occ.audit_events WHERE action = 'openclaw.agents.control_ui_bookmark.update' AND resource_id = $1 AND outcome = 'success' ORDER BY occurred_at",
      [agent.id],
    );
    assert.equal(audit.rowCount, 3);
    assert.ok(audit.rows.every((row) => row.actor_id === editorPrincipalId));
    assert.ok(
      audit.rows.every((row) => !JSON.stringify(row.details).includes("control.example.test")),
      "audit records attribution and version, not the operator URL",
    );
    const denials = await pool.query(
      "SELECT count(*)::int AS count FROM occ.audit_events WHERE action = 'openclaw.agents.control_ui_bookmark.update' AND outcome = 'denied'",
    );
    assert.ok(denials.rows[0].count >= 3);
    // A real database trigger rejects audit persistence. The bookmark CAS must roll back too.
    await migrator.query(
      "CREATE FUNCTION occ.reject_bookmark_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'openclaw.agents.control_ui_bookmark.update' AND NEW.outcome = 'success' THEN RAISE EXCEPTION 'bookmark audit failure'; END IF; RETURN NEW; END $$",
    );
    await migrator.query(
      "CREATE TRIGGER reject_bookmark_audit BEFORE INSERT ON occ.audit_events FOR EACH ROW EXECUTE FUNCTION occ.reject_bookmark_audit()",
    );
    try {
      assert.equal((await call("PUT", path, { url, expectedVersion: 3 }, editor)).statusCode, 500);
      assert.deepEqual(await data<Bookmark>(await call("GET", path, undefined, reader)), {
        url: null,
        version: 3,
      });
    } finally {
      await migrator.query(
        "DROP TRIGGER reject_bookmark_audit ON occ.audit_events; DROP FUNCTION occ.reject_bookmark_audit()",
      );
    }
    const after = (
      await pool.query(
        "SELECT to_jsonb(a) - 'control_ui_bookmark_url' - 'control_ui_bookmark_version' AS record FROM occ.agents a WHERE id = $1",
        [agent.id],
      )
    ).rows[0].record;
    assert.deepEqual(
      after,
      before,
      "runtime, generation, Configuration, revision, lifecycle, and allowlist fields are unchanged",
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM occ.controller_work")).rows[0].count,
      queueBefore,
    );
  },
);
