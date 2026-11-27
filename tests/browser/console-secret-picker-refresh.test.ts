import assert from "node:assert/strict";
import test from "node:test";
import type { SecretListResponse } from "../../packages/contracts/src/api/resources.ts";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  apiRequests,
  createSlackSourceConsoleFixture,
  asksBeforeUnload,
  detailUrl,
  grantSecretOperate,
  hasFocus,
  holdRequests,
  login,
  MEMBER_WRITE,
  memberWriteWithout,
  nativeValues,
  newPage,
  revokeMemberGrant,
  selectSecret,
  settlePageRequests,
  waitForEnabled,
  waitForInputValue,
  writeRequests,
} from "./console-agents-browser-helpers.ts";
import { responseTo } from "./console-action-helpers.ts";
import { slackAgentValues } from "./console-slack-agent.ts";

test("refreshing a Slack Source picker preserves staged choices and discovers a newly enrolled Source", async (t) => {
  const { fixture, namespace, enroll } = await createSlackSourceConsoleFixture(
    t,
    "Slack Source refresh",
  );
  const app = (await enroll("Original app", "xapp")).source;
  const bot = (await enroll("Original bot", "xoxb")).source;
  const staged = (await enroll("Staged app", "xapp")).source;
  const agent = await fixture.createAgent(
    namespace.id,
    "Source picker draft",
    slackAgentValues("picker", { channels: {} }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const appField = page.getByLabel("Slack app token", { exact: true });
  const botField = page.getByLabel("Slack bot token", { exact: true });
  await appField.selectOption(staged.id);

  // Another authorized session enrolls a Source after this picker loaded its inventory.
  const later = (await enroll("Later bot", "xoxb")).source;
  const refreshed = responseTo(
    page,
    "GET",
    `${fixture.origin}/namespaces/${namespace.id}/credential-sources`,
  );
  await botField
    .locator("..")
    .getByRole("button", { name: "Refresh Source list", exact: true })
    .click();
  assert.equal((await refreshed).status(), 200);
  await botField.locator(`option[value="${later.id}"]`).waitFor({ state: "attached" });
  assert.equal(
    await appField.inputValue(),
    staged.id,
    "refresh must preserve another picker's staged Source",
  );
  await botField.selectOption(later.id);

  const configuration = `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const saved = responseTo(page, "PATCH", configuration);
  await page.getByRole("button", { name: "Save channel credentials", exact: true }).click();
  assert.equal((await saved).status(), 200);
  const current = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(current.data.secretBindings.SLACK_APP_TOKEN.source, staged.ref);
  assert.deepEqual(current.data.secretBindings.SLACK_BOT_TOKEN.source, later.ref);
});

test("a refused refresh clears its loading hint while a choice awaits permission", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Pending picker permission", {
    secretDriver: createTestSecretDriver(),
  });
  const first = await fixture.createSecret(namespace.id, "First credential", "synthetic-first");
  const second = await fixture.createSecret(namespace.id, "Second credential", "synthetic-second");
  const agent = await fixture.createAgent(
    namespace.id,
    "Pending draft",
    nativeValues("pending", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: first.ref },
    },
  );
  const member = await fixture.createNamespaceMember("pending-picker", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const collection = `${fixture.origin}/namespaces/${namespace.id}/secrets`;
  const permission = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions/secrets`,
    {
      once: true,
      afterServer: true,
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
    member.credentials,
  );
  const input = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(input, first.name);
  await input.fill("");
  await page.getByRole("option", { name: second.name, exact: true }).waitFor();
  await permission.requested;
  const restore = revokeMemberGrant(fixture, "pending-picker", ["read", "namespace"]);
  const refresh = await holdRequests(t, page, collection, { once: true, afterServer: true });
  try {
    await page.getByRole("option", { name: "Refresh Secret list", exact: true }).click();
    await refresh.requested;
    await page.getByRole("option", { name: second.name, exact: true }).click();
    assert.equal(await input.isDisabled(), true);
    const refused = page.waitForResponse((r) => r.url() === collection);
    refresh.release();
    assert.equal((await refused).status(), 403);
    const permissionResponse = page.waitForResponse((r) =>
      r.url().endsWith(`/agents/${agent.id}/permissions/secrets`),
    );
    permission.release();
    assert.equal((await permissionResponse).status(), 200);
    const inputId = await input.getAttribute("id");
    assert.ok(inputId, "Secret input must have an id");
    await page.waitForFunction(
      (id) => !(document.getElementById(id) as HTMLInputElement).disabled,
      inputId,
    );
    const status = page.locator(`#${await input.getAttribute("aria-describedby")}`);
    assert.doesNotMatch(await status.innerText(), /Loading available Secrets/);
    await input.fill("");
    assert.equal(await page.getByRole("option", { name: second.name, exact: true }).count(), 0);
    assert.equal(
      await page
        .getByRole("link", {
          name: "View harness authentication Secret metadata (opens in new tab)",
        })
        .count(),
      0,
    );
  } finally {
    refresh.release();
    permission.release();
    restore();
  }
});

// A list failure must be retryable without rebuilding a dirty editor. A late failure must
// not replace the hint for a choice made while that request was pending.
test("a Secret-list retry preserves the query and staged binding through failures", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Picker retry", {
    secretDriver: createTestSecretDriver(),
  });
  const first = await fixture.createSecret(namespace.id, "First credential", "synthetic-first");
  const second = await fixture.createSecret(namespace.id, "Second credential", "synthetic-second");
  const agent = await fixture.createAgent(
    namespace.id,
    "Retry draft",
    nativeValues("retry", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: first.ref },
    },
  );
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
  );
  const input = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(input, first.name);
  await selectSecret(page, "API key Secret", second);
  const statusId = await input.getAttribute("aria-describedby");
  assert.ok(statusId);
  const status = page.locator(`#${statusId}`);
  const stagedHint = await status.innerText();
  assert.match(stagedHint, /staged|Save/);
  const requests = apiRequests(page, fixture.origin);
  const collection = `${fixture.origin}/namespaces/${namespace.id}/secrets`;
  const failure = {
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "UNAVAILABLE", message: "List temporarily unavailable" },
    }),
  };
  const held = await holdRequests(t, page, collection, {
    once: true,
    method: "GET",
    fulfill: failure,
  });
  await input.fill("Missing credential");
  await page.getByRole("option", { name: "Refresh Secret list", exact: true }).click();
  await held.requested;
  const loading = page.getByRole("option", { name: "Loading Secrets...", exact: true });
  assert.equal(await loading.getAttribute("aria-disabled"), "true");
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  assert.equal(await input.getAttribute("aria-activedescendant"), await loading.getAttribute("id"));
  await input.press("Enter");
  await settlePageRequests(page);
  assert.equal(requests.filter((r) => r.method === "GET" && r.path.endsWith("/secrets")).length, 1);
  assert.equal(await hasFocus(input), true);
  const failed = page.waitForResponse((r) => r.url() === collection);
  held.release();
  assert.equal((await failed).status(), 503);
  await status.filter({ hasText: "Secrets unavailable." }).waitFor();
  assert.ok((await status.innerText()).startsWith(stagedHint));
  assert.equal(await input.inputValue(), "Missing credential");
  const retry = page.waitForResponse((r) => r.url() === collection);
  await page.getByRole("option", { name: "Refresh Secret list", exact: true }).click();
  assert.equal((await retry).status(), 200);
  await page.waitForFunction(({ id, hint }) => document.getElementById(id)?.textContent === hint, {
    id: statusId,
    hint: stagedHint,
  });
  assert.equal(await input.inputValue(), "Missing credential");
  await input.press("Escape");
  await waitForInputValue(input, second.name);

  const late = await holdRequests(t, page, collection, {
    once: true,
    method: "GET",
    fulfill: failure,
  });
  await input.fill("");
  await page.getByRole("option", { name: "Refresh Secret list", exact: true }).click();
  await late.requested;
  await selectSecret(page, "API key Secret", first);
  const lateResponse = page.waitForResponse((r) => r.url() === collection);
  late.release();
  assert.equal((await lateResponse).status(), 503);
  await input.fill("");
  await page.getByRole("option", { name: "Refresh Secret list", exact: true }).waitFor();
  assert.equal(await status.innerText(), stagedHint);
  await input.press("Escape");
  assert.equal(await input.inputValue(), first.name);
  assert.equal(requests.filter((r) => r.method === "PATCH").length, 0);
});

for (const change of ["remove before", "insert before", "remove active", "keep action"] as const) {
  test(`a pending Secret refresh preserves keyboard identity: ${change}`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, `Keyboard ${change}`, {
      secretDriver: createTestSecretDriver(),
    });
    const a = await fixture.createSecret(
      namespace.id,
      change === "remove active" ? "Match" : "Match A",
      "synthetic-a",
    );
    const b = await fixture.createSecret(namespace.id, "Match B", "synthetic-b");
    const c = await fixture.createSecret(namespace.id, "Match C", "synthetic-c");
    const agent = await fixture.createAgent(
      namespace.id,
      "Keyboard draft",
      nativeValues("keyboard", { harnessId: "codex" }),
      {
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: c.ref },
      },
    );
    const { page } = await newPage(t, fixture);
    const collection = `${fixture.origin}/namespaces/${namespace.id}/secrets`;
    const initial = change === "insert before" || change === "keep action" ? [b, c] : [a, b, c];
    const final =
      change === "remove before" ? [b, c] : change === "remove active" ? [a] : [a, b, c];
    // Valid metadata from this Controller; only list membership/order is controlled.
    await page.route(collection, async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const body: SecretListResponse = await response.json();
      assert.ok([a, b, c].every((secret) => body.data.some((item) => item.id === secret.id)));
      await route.fulfill({ response, json: { ...body, data: initial } });
    });
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
    );
    const input = page.getByLabel("API key Secret", { exact: true });
    await waitForInputValue(input, c.name);
    const requests = apiRequests(page, fixture.origin);
    const held = await holdRequests(t, page, collection, {
      once: true,
      method: "GET",
      fulfill: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: final }),
      },
    });
    await input.fill("Match");
    for (let i = 0; i < initial.length + 2; i++) {
      await input.press("ArrowDown");
    }
    const activeText = () =>
      input.evaluate(
        (el) =>
          document.getElementById(el.getAttribute("aria-activedescendant") ?? "")?.textContent ??
          null,
      );
    assert.equal(await activeText(), "Refresh Secret list");
    assert.equal(
      await input.getAttribute("aria-activedescendant"),
      await page
        .getByRole("option", { name: "Refresh Secret list", exact: true })
        .getAttribute("id"),
    );
    await input.press("Enter");
    await held.requested;
    if (change !== "keep action") {
      await input.press("ArrowUp");
      assert.equal(
        await input.getAttribute("aria-activedescendant"),
        await page
          .getByRole("option", { name: "Create new Secret...", exact: true })
          .getAttribute("id"),
      );
      await input.press("ArrowUp");
      await input.press("ArrowUp");
      assert.equal(await activeText(), b.name);
      assert.equal(
        await input.getAttribute("aria-activedescendant"),
        await page.getByRole("option", { name: b.name, exact: true }).getAttribute("id"),
      );
    } else {
      assert.equal(await activeText(), "Loading Secrets...");
    }
    const activeId = await input.getAttribute("aria-activedescendant");
    const refreshed = page.waitForResponse((r) => r.url() === collection);
    held.release();
    const response = await refreshed;
    assert.equal(response.status(), 200);
    assert.deepEqual(
      (await response.json()).data.map((s: { id: string }) => s.id),
      final.map((s) => s.id),
    );
    await page.getByRole("option", { name: "Refresh Secret list", exact: true }).waitFor();
    assert.equal(await hasFocus(input), true);
    assert.equal(await input.inputValue(), "Match");
    if (change === "remove active") {
      assert.equal(await input.getAttribute("aria-activedescendant"), null);
      assert.equal(await page.locator(`[id="${activeId}"]`).count(), 0);
      const listReads = requests.filter(
        (r) => r.method === "GET" && r.path.endsWith("/secrets"),
      ).length;
      await input.press("Enter");
      await settlePageRequests(page);
      assert.equal(
        requests.filter((r) => r.method === "GET" && r.path.endsWith("/secrets")).length,
        listReads,
      );
      assert.equal(await input.inputValue(), "Match");
      assert.equal(await input.getAttribute("aria-activedescendant"), null);
      assert.equal(await hasFocus(input), true);
      assert.equal(await page.getByRole("dialog").count(), 0);
      await input.press("Escape");
      await waitForInputValue(input, "Bound Secret");
      await input.fill("Match");
      await input.press("ArrowDown");
      const survivor = page.getByRole("option", { name: a.name, exact: true });
      assert.equal(
        await input.getAttribute("aria-activedescendant"),
        await survivor.getAttribute("id"),
      );
      await input.press("Enter");
      await waitForInputValue(input, a.name);
      const link = page.getByRole("link", {
        name: "View harness authentication Secret metadata (opens in new tab)",
      });
      assert.equal(
        new URL((await link.getAttribute("href"))!, fixture.origin).searchParams.get("secret"),
        a.id,
      );
    } else {
      assert.equal(await activeText(), change === "keep action" ? "Refresh Secret list" : b.name);
      assert.equal(await input.getAttribute("aria-activedescendant"), activeId);
      if (change === "keep action") {
        const next = page.waitForResponse((r) => r.url() === collection);
        await input.press("Enter");
        assert.equal((await next).status(), 200);
        assert.equal(await input.inputValue(), "Match");
      } else {
        await input.press("Enter");
        await waitForInputValue(input, b.name);
        const link = page.getByRole("link", {
          name: "View harness authentication Secret metadata (opens in new tab)",
        });
        assert.equal(
          new URL((await link.getAttribute("href"))!, fixture.origin).searchParams.get("secret"),
          b.id,
        );
      }
    }
    await settlePageRequests(page);
    assert.deepEqual(
      requests.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method)),
      [],
    );
    const persisted = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
    );
    assert.deepEqual(persisted.data.harnessAuth, { method: "api_key", source: c.ref });
  });
}

test("Create Agent discards a pending model Secret even after switching providers and back", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Provider change");
  const original = await fixture.createSecret(
    namespace.id,
    "Original choice",
    "synthetic-original",
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const submit = page.getByRole("button", { name: "Create Agent", exact: true });
  await waitForEnabled(submit);
  const key = page.getByLabel("API key Secret", { exact: true });
  const provider = page.getByLabel("Provider", { exact: true });
  const permission = `${fixture.origin}/namespaces/${namespace.id}/permissions/secrets`;
  const held = await holdRequests(t, page, permission, { once: true });
  const requests = apiRequests(page, fixture.origin);

  await selectSecret(page, "API key Secret", original);
  await held.requested;
  await provider.selectOption("anthropic");
  await provider.selectOption("openai");
  const answer = responseTo(page, "GET", permission);
  held.release();
  assert.equal((await answer).status(), 200);
  await waitForEnabled(key);
  await settlePageRequests(page);
  assert.equal(await key.inputValue(), "");
  assert.equal(await page.getByRole("link", { name: /View model credential Secret/ }).count(), 0);
  const staged = page.getByText("Secret selected. Create Agent binds it.", { exact: true });
  assert.equal(await staged.count(), 0);

  // Only a new choice applies. Changing the authentication method clears its success hint too.
  await selectSecret(page, "API key Secret", original);
  await staged.waitFor();
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  assert.equal(await staged.count(), 0);
  assert.equal(await page.getByLabel("Service account token Secret").inputValue(), "");
  assert.deepEqual(writeRequests(requests), []);
});

test("Create Agent waits for the replacement model Secret before validating", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Model replacement");
  const first = await fixture.createSecret(namespace.id, "First choice", "synthetic-first");
  const second = await fixture.createSecret(namespace.id, "Second choice", "synthetic-second");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const submit = page.getByRole("button", { name: "Create Agent", exact: true });
  await waitForEnabled(submit);
  const key = page.getByLabel("API key Secret", { exact: true });
  const base = `${fixture.origin}/namespaces/${namespace.id}`;
  const permission = `${base}/permissions/secrets`;
  const requests = apiRequests(page, fixture.origin);
  // A failed read leaves no cached answer, so the replacement waits for a fresh check.
  await page.route(permission, (route) => route.abort(), { times: 1 });
  const beforeSearch = await asksBeforeUnload(page);
  await key.fill(first.name);
  await page.getByRole("option", { name: first.name }).waitFor();
  const searching = await asksBeforeUnload(page);
  await key.press("Enter");
  await waitForEnabled(key);
  assert.equal(await key.inputValue(), first.name);
  const selected = await asksBeforeUnload(page);
  const name = page.getByLabel("Agent name");
  await name.fill("Replacement");
  await page.getByLabel("Model", { exact: true }).selectOption({ index: 1 });

  // Let the Controller validate the selected reference, but stop before the first write.
  await page.route(`${base}/configurations`, (route) => route.abort());
  const held = await holdRequests(t, page, permission, { once: true });
  await selectSecret(page, "API key Secret", second);
  await held.requested;
  assert.equal(await key.isDisabled(), true);
  assert.equal(await submit.isDisabled(), true);
  const reason = page.getByText("Checking Secret access…", { exact: true });
  assert.equal(await submit.getAttribute("aria-describedby"), await reason.getAttribute("id"));
  await submit.click({ force: true });
  await name.press("Enter");
  await submit.evaluate((button: HTMLButtonElement) => button.form!.requestSubmit());
  await settlePageRequests(page);
  assert.deepEqual(writeRequests(requests), []);
  held.release();

  await waitForInputValue(key, second.name);
  const validation = responseTo(page, "POST", `${base}/agents/validate`);
  await submit.click();
  const validated = await validation;
  assert.equal(validated.status(), 204);
  assert.deepEqual(validated.request().postDataJSON().harnessAuth.source, second.ref);
  assert.equal(searching, beforeSearch, "searching does not add a draft edit");
  assert.equal(selected, true);
});

test("a late Secret refusal cannot replace the current authentication method's choice", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Method change");
  const denied = await fixture.createSecret(namespace.id, "Old key", "synthetic-key");
  const allowed = await fixture.createSecret(namespace.id, "Current token", "synthetic-token");
  const member = await fixture.createNamespaceMember(
    "method-change",
    namespace.id,
    memberWriteWithout(["operate", "secret"]),
  );
  grantSecretOperate(fixture, namespace.id, member.principal, [allowed.id]);
  const { page } = await newPage(t, fixture);
  const permission = `${fixture.origin}/namespaces/${namespace.id}/permissions/secrets`;
  const held = await holdRequests(t, page, permission, { once: true });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const requests = apiRequests(page, fixture.origin);
  await selectSecret(page, "API key Secret", denied);
  await held.requested;
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  const token = page.getByLabel("Service account token Secret");
  // Both choices share one permission read. Only the newer one may use the answer.
  assert.equal(await token.isEnabled(), true);
  await selectSecret(page, "Service account token Secret", allowed);
  assert.equal(await token.isDisabled(), true);
  const answer = responseTo(page, "GET", permission);
  held.release();
  const response = await answer;
  assert.equal(response.status(), 200);
  assert.deepEqual((await response.json()).data.operateDenied, [denied.id]);
  await waitForInputValue(token, allowed.name);
  await page.getByText("Secret selected. Create Agent binds it.").waitFor();
  assert.equal(await page.getByText(/Old key cannot be chosen/).count(), 0);
  assert.deepEqual(writeRequests(requests), []);
});
