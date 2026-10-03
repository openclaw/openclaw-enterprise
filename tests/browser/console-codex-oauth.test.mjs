import assert from "node:assert/strict";
import test from "node:test";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  expectNoText,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";

test("Codex OAuth console creates an Agent and keeps plugin editing separate from credential replacement", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("OAuth console", { ready: true });
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const originalFetch = globalThis.fetch;
  let approved = false;
  const providerRequests = [];
  const idToken = `e30.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "oauth-workspace-fixture" },
    }),
  ).toString("base64url")}.signature`;
  const plugin = {
    id: "plugin-oauth-fixture",
    name: "calendar",
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: "Calendar",
      description: "Calendar tools",
      interface: {},
      requires_local_executor: false,
      app_ids: ["connector_calendar"],
      skills: [],
      mcp_servers: [],
    },
  };
  // Only the external provider boundary is simulated; console, API, IAM and Secret storage run.
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://auth.openai.com/") && !url.startsWith("https://chatgpt.com/")) {
      return originalFetch(input, init);
    }
    providerRequests.push(url);
    if (url.endsWith("/deviceauth/usercode")) {
      return Response.json({
        device_auth_id: "private-device-id",
        user_code: "CODE-1234",
        interval: "1",
      });
    }
    if (url.endsWith("/deviceauth/token")) {
      return approved
        ? Response.json({ authorization_code: "private-code", code_verifier: "private-verifier" })
        : new Response(null, { status: 403 });
    }
    if (url.endsWith("/oauth/token")) {
      return Response.json({
        id_token: idToken,
        access_token: "oauth-access-browser",
        refresh_token: "oauth-refresh-browser",
      });
    }
    assert.equal(init.headers.Authorization, "Bearer oauth-access-browser");
    assert.equal(init.headers["ChatGPT-Account-ID"], "oauth-workspace-fixture");
    if (url.includes("/ps/plugins/list?") || url.includes("/ps/plugins/search?")) {
      return Response.json({ plugins: [plugin], pagination: { next_page_token: null } });
    }
    if (url.includes("/ps/plugins/plugin-oauth-fixture?")) {
      return Response.json(plugin);
    }
    assert.equal(url, "https://chatgpt.com/backend-api/ps/apps/batch");
    return Response.json({
      apps: [
        {
          id: "connector_calendar",
          status: "ENABLED",
          tools: [
            { name: "search", title: "Search calendar", is_read_only: true, is_enabled: true },
          ],
        },
      ],
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("oauth");
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).isVisible(), false);
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await page.getByText("CODE-1234", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open Codex sign-in" }).getAttribute("href"),
    "https://auth.openai.com/codex/device",
  );
  const cancelled = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes("/device-authorizations/"),
  );
  await page.getByRole("button", { name: "Cancel login", exact: true }).click();
  assert.equal((await cancelled).status(), 204);
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).waitFor();

  // A fresh login becomes the Agent credential; the browser receives only its Secret reference.
  approved = true;
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await page
    .getByText("ChatGPT login ready. Credentials are stored on the server.", { exact: true })
    .waitFor();
  const started = requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/device-authorizations"),
  );
  assert.equal(started.length, 2);
  assert.deepEqual(started[1].body, { harnessId: "codex" });
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Add Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const discovery = requests.find(
    (request) =>
      request.method === "POST" && request.path === `/namespaces/${namespace.id}/agents/plugins`,
  );
  assert.equal(discovery.body.oauthLogin.kind, "secret");
  await page.getByLabel("Agent name", { exact: true }).fill("OAuth Agent");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("heading", { name: "OAuth Agent", exact: true }).waitFor();
  const creation = requests.find(
    (request) => request.method === "POST" && request.path === `/namespaces/${namespace.id}/agents`,
  );
  assert.deepEqual(creation.body.harnessAuth, {
    method: "oauth",
    source: discovery.body.oauthLogin,
  });
  assert.ok(creation.body.plugins["codex-plugin:calendar@openai-curated-remote"]);
  const agentId = new URL(page.url()).pathname.split("/").at(-1);
  const agentPath = `/namespaces/${namespace.id}/agents/${agentId}`;
  const originalAuth = (await fixture.request("GET", agentPath)).data.harnessAuth;
  assert.deepEqual(originalAuth, creation.body.harnessAuth);

  // Browsing from the draft uses another grant and must not patch the Agent's authentication.
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  approved = false;
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await page.getByText("CODE-1234", { exact: true }).waitFor();
  // The start mutation rebuilds the tab once; a second visit reuses its DOM and pending timer.
  for (let visit = 0; visit < 2; visit += 1) {
    await page.getByRole("button", { name: "Credentials", exact: true }).click();
    if (visit === 1) {
      const polls = requests.filter((request) => request.path.endsWith("/poll")).length;
      await page.clock.runFor(3_000);
      assert.equal(requests.filter((request) => request.path.endsWith("/poll")).length, polls);
    }
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page.getByText("CODE-1234", { exact: true }).waitFor();
  }
  const resumedPoll = page.waitForResponse(
    (response) =>
      response.url().startsWith(`${fixture.origin}${agentPath}/device-authorizations/`) &&
      response.url().endsWith("/poll"),
  );
  await page.clock.runFor(1_000);
  assert.equal((await resumedPoll).status(), 200);
  approved = true;
  await page.clock.resume();
  await page
    .getByText("ChatGPT login ready. Credentials are stored on the server.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const independent = requests.find(
    (request) => request.method === "POST" && request.path === `${agentPath}/plugins`,
  );
  assert.notEqual(independent.body.oauthLogin.id, originalAuth.source.id);
  assert.deepEqual((await fixture.request("GET", agentPath)).data.harnessAuth, originalAuth);
  await page.locator(".plugin-json > summary").click();
  await page.locator("#agent-plugins").fill("{}");
  const pluginsSaved = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  assert.equal((await pluginsSaved).status(), 200);
  await page.getByRole("button", { name: "Discard staged login", exact: true }).waitFor();
  const edited = (await fixture.request("GET", agentPath)).data;
  assert.deepEqual(edited.harnessAuth, originalAuth);
  assert.deepEqual(edited.plugins, {});
  const discarded = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes(independent.body.oauthLogin.id),
  );
  await page.getByRole("button", { name: "Discard staged login", exact: true }).click();
  assert.equal((await discarded).status(), 204);

  // Reconnection is a separate, explicit authentication save with a newly completed login.
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "oauth");
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await page
    .getByText("ChatGPT login ready. Credentials are stored on the server.", { exact: true })
    .waitFor();
  assert.deepEqual((await fixture.request("GET", agentPath)).data.harnessAuth, originalAuth);
  const saved = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await saved).status(), 200);
  const replaced = (await fixture.request("GET", agentPath)).data.harnessAuth;
  assert.equal(replaced.method, "oauth");
  assert.notEqual(replaced.source.id, originalAuth.source.id);
  assert.notEqual(replaced.source.id, independent.body.oauthLogin.id);

  // Discard withdraws a staged login before the server confirms it, so a save racing the
  // request keeps the saved credential instead of binding a source about to be cancelled.
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await page
    .getByText("ChatGPT login ready. Credentials are stored on the server.", { exact: true })
    .waitFor();
  const releaseDiscard = Promise.withResolvers();
  await page.route("**/device-authorizations/*", async (route) => {
    if (route.request().method() === "DELETE") {
      await releaseDiscard.promise;
    }
    await route.fallback();
  });
  const slowDiscard = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes("/device-authorizations/"),
  );
  await page.getByRole("button", { name: "Discard staged login", exact: true }).click();
  const racedSave = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await racedSave).status(), 200);
  releaseDiscard.resolve();
  assert.equal((await slowDiscard).status(), 204);
  assert.deepEqual((await fixture.request("GET", agentPath)).data.harnessAuth, replaced);
  assert.doesNotMatch(
    JSON.stringify(requests),
    /oauth-access-browser|oauth-refresh-browser|private-device-id|private-verifier/,
  );
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /oauth-access-browser|oauth-refresh-browser|private-device-id|private-verifier/,
  );
  assert.equal(
    providerRequests.some((url) => url.includes("revoke") || url.includes("whoami")),
    false,
  );
});

test("saving ChatGPT OAuth before sign-in names the missing step and sends nothing", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("OAuth save guard", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "OAuth save guard",
    nativeValues("oauth-save-guard", { harnessId: "codex" }),
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  const save = page.getByRole("button", { name: "Save authentication source", exact: true });
  await save.waitFor();
  await page.getByLabel("Authentication source").selectOption("oauth");
  await save.click();
  await page.getByText("Complete ChatGPT sign-in before saving.", { exact: true }).waitFor();
  await expectNoText(page, /Service unavailable/);
  assert.equal(await save.isEnabled(), true);
  assert.equal(
    requests.some((request) => request.method === "PATCH" && request.path === agentPath),
    false,
  );
  assert.equal((await fixture.request("GET", agentPath)).data.harnessAuth.method, "api_key");
});

test("sign-in that cannot reach the sign-in service shows the API's cause once", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("OAuth egress", { ready: true });
  const originalFetch = globalThis.fetch;
  // The chart's default network policy: the API Pod cannot connect to auth.openai.com.
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://auth.openai.com/")) {
      return originalFetch(input, init);
    }
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
  });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("oauth");
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await page
    .getByText(
      "Codex sign-in failed. OCC could not reach the sign-in service at auth.openai.com. An operator must allow HTTPS egress from the API Pods to it (Helm api.modelDiscoveryCidrs or the cluster's egress policy), then try again.",
      { exact: true },
    )
    .waitFor();
  await expectNoText(page, /Service unavailable|The read could not be completed/);
  assert.equal(
    await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).isEnabled(),
    true,
  );
});
