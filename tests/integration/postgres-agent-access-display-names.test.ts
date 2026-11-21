import assert from "node:assert/strict";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { Agent, request } from "node:http";
import { createServer } from "node:https";
import test from "node:test";
import { chromium } from "playwright";

import { authenticatedHeaders } from "../helpers/auth-session.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  createApi,
  ensureBootstrap,
  listen,
  requiresPostgres,
  signIn,
} from "../helpers/native-admin-postgres.ts";
import { record, recordData, text } from "../helpers/postgres-sign-in-test-boundaries.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test(
  "Agent roster names come only from exact direct human bindings under current account authority",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    await ensureBootstrap(t);
    const directory = await temporaryDirectory(t, "oce-agent-roster-");
    const host = "console.example.test";
    const tls = await selfSigned(directory, { commonName: host, subjectAltName: `DNS:${host}` });
    const loopback = new Agent();
    // Serve the real Console and Controller behind the fixture's one loopback HTTPS origin.
    const ingress = createServer({ key: tls.key, cert: tls.cert }, (incoming, outgoing) => {
      const proxy = request(
        {
          agent: loopback,
          hostname: "127.0.0.1",
          port: apiPort,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      proxy.on("error", (error) => outgoing.destroy(error));
      incoming.pipe(proxy);
    });
    ingress.listen(0, "127.0.0.1");
    await once(ingress, "listening");
    t.after(
      () =>
        new Promise<void>((resolve) => {
          loopback.destroy();
          ingress.close(() => resolve());
          ingress.closeAllConnections();
        }),
    );
    const address = ingress.address();
    assert.ok(address && typeof address !== "string");
    const origin = `https://${host}:${address.port}`;
    const { app, controller, iamDriver, auth, state } = await createApi(t, "roster-names", 0, {
      origin,
      nativeAdminEnabled: false,
    });
    const apiPort = await listen(app);
    t.after(() => app.close());
    const admin = await signIn(app, undefined, origin);
    const adminHeaders = { ...authenticatedHeaders(admin), host: new URL(origin).host, origin };
    async function create(url: string, payload: object) {
      const reply = await app.inject({ method: "POST", url, headers: adminHeaders, payload });
      assert.equal(reply.statusCode, 201, reply.body);
      return recordData(reply.json<unknown>());
    }
    async function person(name?: string, roleId?: string) {
      const suffix = randomUUID();
      const credentials = {
        email: `roster-${suffix}@example.test`,
        password: `local-roster-test-${suffix}`,
      };
      const account = await create("/api/auth/accounts", {
        ...credentials,
        ...(name === undefined ? {} : { name }),
        ...(roleId === undefined ? {} : { roleId }),
      });
      return { ...credentials, id: text(account.id), principalId: text(account.principalId) };
    }
    const sessionReply = await app.inject({ url: "/api/auth/session", headers: adminHeaders });
    assert.equal(sessionReply.statusCode, 200);
    const user = record(recordData(sessionReply.json<unknown>()).user);
    const actor = await iamDriver.lookupIdentity({ issuer: auth.issuer, subject: text(user.id) });
    assert.ok(actor);
    const namespaceId = text(
      (await create("/namespaces", { name: `Display names ${randomUUID()}` })).id,
    );
    await controller.handleNamespaceLifecycle(actor.id, namespaceId, "ready");
    const namespacePath = `/namespaces/${namespaceId}`;
    const configuration = await create(`${namespacePath}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    const secret = await create(`${namespacePath}/secrets`, {
      name: "Roster fixture",
      value: `local-roster-secret-${randomUUID()}`,
    });
    async function agent(name: string) {
      return text(
        (
          await create(`${namespacePath}/agents`, {
            name,
            configurationId: text(configuration.id),
            harnessAuth: { method: "api_key", source: secret.ref },
            gatewayManagedMode: false,
          })
        ).id,
      );
    }
    const agentId = await agent("Research Agent");
    const siblingId = await agent("Unrelated Agent");
    const first = await person("Morgan Chen");
    const second = await person("Morgan Chen");
    const unnamed = await person();
    const unrelated = await person("Unrelated Person");
    const policy = `${namespacePath}/iam`;
    async function role(
      name: string,
      actions: readonly ("read" | "operate" | "administer" | "read_logs")[],
    ) {
      return text(
        (
          await create(`${policy}/roles`, {
            name,
            permissions: actions.map((action) => ({ action, resourceKind: "agent" })),
          })
        ).id,
      );
    }
    const readRole = await role("Research support", ["read"]);
    const chatRole = await role("Research chat", ["read", "operate"]);
    const adminRole = await role("Agent native administration", [
      "read",
      "administer",
      "read_logs",
    ]);
    const service = await create(`${policy}/service-principals`, {});
    async function bind(principalId: string, resourceId: string, roleId = readRole) {
      return text(
        (
          await create(`${policy}/access-bindings`, {
            subjectKind: "identity",
            subjectId: principalId,
            roleId,
            resourceKind: "agent",
            resourceId,
          })
        ).id,
      );
    }
    const readBinding = await bind(first.principalId, agentId);
    const chatBinding = await bind(second.principalId, agentId, chatRole);
    const adminBinding = await bind(second.principalId, agentId, adminRole);
    await bind(unnamed.principalId, agentId);
    await bind(unrelated.principalId, siblingId);
    await bind(text(service.id), agentId);

    const url = `${namespacePath}/agents/${agentId}/access-display-names`;
    const browserHeaders = {
      host: new URL(origin).host,
      cookie: admin.cookie,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    async function readNames() {
      const reply = await app.inject({ url, headers: browserHeaders });
      assert.equal(reply.statusCode, 200, reply.body);
      assert.equal(reply.headers["cache-control"], "no-store");
      return record(reply.json<unknown>()).data;
    }
    const expected = [first, second]
      .map(({ principalId }) => ({ principalId, displayName: "Morgan Chen" }))
      .sort((a, b) => a.principalId.localeCompare(b.principalId));
    assert.deepEqual(await readNames(), expected);
    const reader = await signIn(app, first, origin);
    const denied = await app.inject({ url, headers: { ...browserHeaders, cookie: reader.cookie } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.includes("Morgan Chen"), false);
    const untrusted = await app.inject({
      url,
      headers: { ...browserHeaders, "sec-fetch-site": "same-site" },
    });
    assert.equal(untrusted.statusCode, 403);
    assert.equal(untrusted.body.includes("Morgan Chen"), false);

    // An exact Installation administrator is not automatically a reader of Namespace resources.
    const installationRole = (await state.loadNativeIAMState()).roles.find(
      (role) =>
        role.namespaceId === undefined &&
        role.permissions.some(
          (permission) =>
            permission.resourceKind === "installation" && permission.action === "administer",
        ),
    );
    assert.ok(installationRole);
    const limited = await signIn(
      app,
      await person("Scoped administrator", installationRole.id),
      origin,
    );
    const outOfScope = await app.inject({
      url,
      headers: { ...browserHeaders, cookie: limited.cookie },
    });
    assert.equal(outOfScope.statusCode, 403);
    assert.equal(outOfScope.body.includes("Morgan Chen"), false);

    const publicKey = new X509Certificate(tls.cert).publicKey.export({
      type: "spki",
      format: "der",
    });
    const pin = createHash("sha256").update(publicKey).digest("base64");
    const executablePath = process.env.OCC_TEST_BROWSER_EXECUTABLE;
    // Trust only the disposable server's own key without changing host certificate policy.
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--no-proxy-server",
        `--host-resolver-rules=MAP ${host} 127.0.0.1,MAP * ~NOTFOUND`,
        `--ignore-certificate-errors-spki-list=${pin}`,
      ],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    // Reuse the current guarded session admitted by the real password route.
    const [cookie] = admin.cookie.split(";");
    assert.ok(cookie);
    const equals = cookie.indexOf("=");
    assert.ok(equals > 0);
    await page.context().addCookies([
      {
        name: cookie.slice(0, equals),
        value: cookie.slice(equals + 1),
        url: origin,
        secure: true,
        httpOnly: true,
      },
    ]);
    await page.goto(
      `${origin}/console/agents/${agentId}?namespace=${namespaceId}&revision=draft&tab=access`,
    );
    const roster = page.getByRole("list", { name: "Principal grants" });
    const namedRows = roster.locator("summary").filter({ hasText: "Morgan Chen" });
    await namedRows.nth(1).waitFor();
    assert.equal(await namedRows.count(), 2, "equal names must not merge Principal rows");
    await roster.locator("summary").getByText(unnamed.principalId, { exact: true }).waitFor();
    assert.equal(await page.getByText(unrelated.principalId, { exact: true }).count(), 0);
    for (const row of await namedRows.all()) {
      await row.click();
    }
    const ids = roster.locator("details[open] .agent-access-subject-id code");
    assert.deepEqual(
      (await ids.allTextContents()).sort(),
      [first.principalId, second.principalId].sort(),
    );
    const firstId = ids.getByText(first.principalId, { exact: true });
    assert.equal(
      await firstId.isVisible(),
      true,
      "show the entire prefixed Principal UUID in visible text",
    );
    assert.equal(await firstId.evaluate((element) => getComputedStyle(element).userSelect), "text");

    const rowFor = (principalId: string) =>
      roster.locator(":scope > li > details").filter({
        has: page.locator(".agent-access-subject-id code").getByText(principalId, { exact: true }),
      });
    const firstRow = rowFor(first.principalId);
    await firstRow
      .locator(":scope > summary")
      .getByText("View Agent in OCC", { exact: true })
      .waitFor();
    const support = firstRow.getByRole("listitem").filter({ hasText: "Research support" });
    await support.getByText("View Agent in OCC", { exact: true }).waitFor();
    assert.equal(await support.getByText("agent: read", { exact: true }).isVisible(), false);
    assert.equal(await support.getByText(readBinding, { exact: true }).isVisible(), false);
    await support.getByText("Technical details", { exact: true }).click();
    await support.getByText("agent: read", { exact: true }).waitFor();
    await support.getByText(readRole, { exact: true }).waitFor();
    await support.getByText(readBinding, { exact: true }).waitFor();
    const removeReadBinding = support.getByRole("button", { name: "Remove binding", exact: true });
    assert.equal(
      await removeReadBinding.evaluate(
        (button) =>
          document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
      ),
      "Research support",
    );

    const secondRow = rowFor(second.principalId);
    await secondRow
      .locator(":scope > summary")
      .getByText("Open Agent UI · administer", { exact: true })
      .waitFor();
    const chat = secondRow.getByRole("listitem").filter({ hasText: "Research chat" });
    const adminGrant = secondRow
      .getByRole("listitem")
      .filter({ hasText: "Agent native administration" });
    await chat.getByText("View Agent in OCC · Chat access", { exact: true }).waitFor();
    await adminGrant
      .getByText("View Agent in OCC · Administer Agent · Other permissions", { exact: true })
      .waitFor();
    assert.equal(await chat.getByRole("link").count(), 0);
    assert.equal(await chat.getByText(chatBinding, { exact: true }).isVisible(), false);
    assert.equal(await adminGrant.getByText(adminBinding, { exact: true }).isVisible(), false);
    await chat.getByText("Technical details", { exact: true }).click();
    await chat.getByText("agent: read, agent: operate", { exact: true }).waitFor();
    await chat.getByText(chatRole, { exact: true }).waitFor();
    await chat.getByText(chatBinding, { exact: true }).waitFor();
    await adminGrant.getByText("Technical details", { exact: true }).click();
    await adminGrant
      .getByText("agent: read, agent: administer, agent: read_logs", { exact: true })
      .waitFor();
    await adminGrant.getByText(adminRole, { exact: true }).waitFor();
    await adminGrant.getByText(adminBinding, { exact: true }).waitFor();

    // A failure of the second (name-only) read must not discard bindings or disable removal.
    await page.route(`${origin}${url}`, (route) => route.fulfill({ status: 503 }));
    const failed = page.waitForResponse(
      (response) => response.url() === `${origin}${url}` && response.status() === 503,
    );
    await page.getByRole("button", { name: "Refresh sharing" }).click();
    await failed;
    await roster.locator("summary").getByText(first.principalId, { exact: true }).waitFor();
    await support.getByText(readBinding, { exact: true }).waitFor();
    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url() === `${origin}${policy}/access-bindings/${readBinding}`,
    );
    await removeReadBinding.click();
    assert.equal((await removed).status(), 204);
    await chat.getByText(chatBinding, { exact: true }).waitFor();
    await adminGrant.getByText(adminBinding, { exact: true }).waitFor();
    assert.deepEqual(await readNames(), [
      { principalId: second.principalId, displayName: "Morgan Chen" },
    ]);
  },
);
