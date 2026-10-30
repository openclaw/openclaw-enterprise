import assert from "node:assert/strict";
import test from "node:test";
import type {
  SecretDetailResponse,
  SecretListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { liftRestriction, restrict } from "../helpers/iam-grants.mjs";
import {
  apiRequests,
  detailUrl,
  hasFocus,
  holdRequests,
  login,
  MEMBER_WRITE,
  nativeValues,
  newPage,
  revokeMemberGrant,
  selectSecret,
  settlePageRequests,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";
import { slackAgentValues, slackTokenBindings } from "./console-slack-agent.mjs";

test("refreshing a Secret picker keeps staged choices and finds a Secret created in another tab", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Picker refresh", {
    secretDriver: createTestSecretDriver(),
  });
  const app = await fixture.createSecret(namespace.id, "Original app", "synthetic-app");
  const bot = await fixture.createSecret(namespace.id, "Original bot", "synthetic-bot");
  const staged = await fixture.createSecret(namespace.id, "Staged app", "synthetic-staged");
  const agent = await fixture.createAgent(
    namespace.id,
    "Picker draft",
    slackAgentValues("picker", { channels: {} }),
    slackTokenBindings(app, bot),
  );
  const member = await fixture.createNamespaceMember("picker-member", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const collection = `${fixture.origin}/namespaces/${namespace.id}/secrets`;
  const listRead = () =>
    page.waitForResponse((r) => r.url() === collection && r.request().method() === "GET");
  const initial = listRead();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
    member.credentials,
  );
  assert.equal((await initial).status(), 200);
  // Verify the logged-in member against the real administrator-only endpoint.
  const probe = await page.request.get(`${fixture.origin}/observability`);
  assert.equal(probe.status(), 403);
  const appField = page.getByLabel("Slack app token", { exact: true });
  const botField = page.getByLabel("Slack bot token", { exact: true });
  await waitForInputValue(botField, bot.name);
  await settlePageRequests(page);
  // Observe only this editor after login settles; the other tab owns its intentional create.
  const writes: { method: string; path: string }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === fixture.origin && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push({ method: request.method(), path: url.pathname });
    }
  });
  await selectSecret(page, "Slack app token", staged);
  const laterName = "Later library Secret";
  await botField.fill(laterName);
  const originalInput = await botField.elementHandle();
  assert.ok(originalInput);

  const other = await page.context().newPage();
  await other.bringToFront();
  await other.goto(`${fixture.origin}/console/secrets?namespace=${namespace.id}`);
  await other.getByRole("button", { name: "Create Secret", exact: true }).click();
  const dialog = other.getByRole("dialog", { name: "Create Secret", exact: true });
  await dialog.getByLabel("Secret name", { exact: true }).fill(laterName);
  await dialog.getByLabel("Value", { exact: true }).fill("synthetic-later");
  const created = other.waitForResponse(
    (r) => r.url() === collection && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const { data: later }: SecretDetailResponse = await response.json();
  assert.equal(later.name, laterName);
  await other
    .getByRole("dialog", { name: "Secret created" })
    .getByRole("button", { name: "Close" })
    .click();

  await page.bringToFront();
  assert.equal(await botField.inputValue(), laterName);
  await botField.focus();
  await page.getByText("No matching Secrets.", { exact: true }).waitFor();
  await settlePageRequests(page);
  assert.deepEqual(writes, []);
  // Use the combobox keyboard, preserving its query and DOM focus through the read.
  const refresh = page.getByRole("option", { name: "Refresh Secret list", exact: true });
  await refresh.waitFor({ timeout: 5000 });
  const create = page.getByRole("option", { name: "Create new Secret...", exact: true });
  await botField.press("ArrowDown");
  assert.equal(
    await botField.getAttribute("aria-activedescendant"),
    await create.getAttribute("id"),
  );
  await botField.press("ArrowDown");
  assert.equal(
    await botField.getAttribute("aria-activedescendant"),
    await refresh.getAttribute("id"),
  );
  const refreshed = listRead();
  await botField.press("Enter");
  const read = await refreshed;
  assert.equal(read.status(), 200);
  const { data: listed }: SecretListResponse = await read.json();
  assert.ok(listed.some((s) => s.id === later.id));
  const option = page.getByRole("option", { name: laterName, exact: true });
  await option.waitFor();
  assert.equal(await botField.inputValue(), laterName);
  assert.equal(await appField.inputValue(), staged.name);
  assert.equal(await hasFocus(originalInput), true);
  await settlePageRequests(page);
  assert.deepEqual(writes, []);
  // Create keeps its established position before Refresh.
  await botField.press("ArrowUp");
  assert.equal(
    await botField.getAttribute("aria-activedescendant"),
    await create.getAttribute("id"),
  );
  await botField.press("ArrowUp");
  const optionId = await option.getAttribute("id");
  assert.ok(optionId);
  assert.equal(await botField.getAttribute("aria-activedescendant"), optionId);
  await botField.press("Enter");
  await waitForInputValue(botField, laterName);
  assert.equal(await botField.getAttribute("aria-expanded"), "false");
  const metadata = page.locator(`a[href*="secret=${encodeURIComponent(later.id)}"]`);
  await metadata.waitFor();
  assert.equal(await metadata.count(), 1);
  assert.equal(
    new URL((await metadata.getAttribute("href"))!, fixture.origin).searchParams.get("secret"),
    later.id,
  );
  assert.equal(await appField.inputValue(), staged.name);
  await settlePageRequests(page);
  assert.deepEqual(writes, []);

  const configuration = `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const saved = page.waitForResponse(
    (r) => r.url() === configuration && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save channel Secrets", exact: true }).click();
  const save = await saved;
  assert.equal(save.status(), 200);
  const expected = { SLACK_APP_TOKEN: staged.id, SLACK_BOT_TOKEN: later.id };
  for (const [key, id] of Object.entries(expected)) {
    assert.equal(save.request().postDataJSON().secretBindings[key].source.id, id);
    assert.equal((await save.json()).data.secretBindings[key].source.id, id);
  }
  const warning = page
    .getByRole("alert")
    .filter({ hasText: "this session did not verify that this Agent can use" });
  await warning.waitFor();
  assert.match(await warning.innerText(), /Installation administrator.*Retry Secret access/);
  assert.equal(await page.getByRole("button", { name: "Retry Secret access" }).count(), 0);
  await settlePageRequests(page);
  const checked = await page.context().request.get(configuration);
  assert.equal(checked.status(), 200);
  const final = (await checked.json()).data.secretBindings;
  for (const [key, id] of Object.entries(expected)) {
    assert.equal(final[key].source.id, id);
  }
  assert.deepEqual(writes, [{ method: "PATCH", path: new URL(configuration).pathname }]);
  t.diagnostic(
    "Two tabs; later create 201; refresh 200; no editor writes before Save; one exact PATCH and independent GET confirm both exact IDs.",
  );
});

test("a real list refusal clears readable metadata but preserves staged references through retry", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Picker read revoked", {
    secretDriver: createTestSecretDriver(),
  });
  const app = await fixture.createSecret(namespace.id, "Original app", "synthetic-app");
  const bot = await fixture.createSecret(namespace.id, "Token original", "synthetic-bot");
  const staged = await fixture.createSecret(namespace.id, "Staged app", "synthetic-staged");
  const replacement = await fixture.createSecret(
    namespace.id,
    "Token replacement",
    "synthetic-next",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Revoked list draft",
    slackAgentValues("revoked-list", { channels: {} }),
    slackTokenBindings(app, bot),
  );
  const member = await fixture.createNamespaceMember("revoked-picker", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const collection = `${fixture.origin}/namespaces/${namespace.id}/secrets`;
  const listRead = () =>
    page.waitForResponse((r) => r.url() === collection && r.request().method() === "GET");
  const initial = listRead();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
    member.credentials,
  );
  const initialResponse = await initial;
  assert.equal(initialResponse.status(), 200);
  const initialIds = ((await initialResponse.json()) as SecretListResponse).data.map((s) => s.id);
  assert.ok(initialIds.includes(app.id));
  assert.equal((await page.request.get(`${fixture.origin}/observability`)).status(), 403);
  const appField = page.getByLabel("Slack app token", { exact: true });
  const input = page.getByLabel("Slack bot token", { exact: true });
  await waitForInputValue(input, bot.name);
  await settlePageRequests(page);
  const requests = apiRequests(page, fixture.origin);
  await selectSecret(page, "Slack app token", staged);
  const inputId = await input.getAttribute("id");
  assert.ok(inputId);
  const listbox = page.locator(`#${await input.getAttribute("aria-controls")}`);
  await input.fill("");
  await listbox.getByRole("option", { name: app.name, exact: true }).waitFor();
  const linkName = "View bot token Secret metadata (opens in new tab)";
  const link = page.getByText(linkName, { exact: true });
  const status = page.locator(`#${await input.getAttribute("aria-describedby")}`);

  // Repeat with a newer choice while the real refusal is in flight: status ownership
  // must never prevent invalidation of the old authorization knowledge.
  for (const chooseWhilePending of [false, true]) {
    await input.fill("Token");
    await listbox.getByRole("option", { name: bot.name, exact: true }).waitFor();
    await page.getByRole("link", { name: linkName, exact: true }).waitFor();
    const restore = revokeMemberGrant(fixture, "revoked-picker", ["read", "namespace"]);
    let release!: () => void;
    let observed!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      observed = resolve;
    });
    await page.route(collection, async (route) => {
      assert.equal(route.request().method(), "GET");
      const response = await route.fetch();
      assert.equal(response.status(), 403);
      observed();
      await gate;
      await route.fulfill({ response });
    });
    try {
      const refused = listRead();
      await listbox.getByRole("option", { name: "Refresh Secret list", exact: true }).click();
      await requested;
      if (chooseWhilePending) {
        assert.equal(
          new URL((await link.getAttribute("href"))!, fixture.origin).searchParams.get("secret"),
          bot.id,
        );
        await selectSecret(page, "Slack bot token", replacement);
        await waitForInputValue(input, replacement.name);
        assert.equal(
          new URL((await link.getAttribute("href"))!, fixture.origin).searchParams.get("secret"),
          replacement.id,
        );
        await input.fill("Token");
        assert.equal(
          await listbox
            .getByRole("option", { name: "Loading Secrets...", exact: true })
            .getAttribute("aria-disabled"),
          "true",
        );
      }
      const hint = await status.innerText();
      await input.press("ArrowDown");
      const activeId = await input.getAttribute("aria-activedescendant");
      assert.equal(
        activeId,
        await listbox.getByRole("option", { name: bot.name, exact: true }).getAttribute("id"),
      );
      release();
      assert.equal((await refused).status(), 403);
      await listbox.getByRole("option", { name: "Refresh Secret list", exact: true }).waitFor();
      if (chooseWhilePending) {
        assert.equal(await status.innerText(), hint);
      } else {
        assert.match(await status.innerText(), /Secrets unavailable/);
      }
      assert.equal(await input.getAttribute("aria-activedescendant"), null);
      assert.equal(await page.locator(`[id="${activeId}"]`).count(), 0);
      for (const secret of [app, bot, staged, replacement]) {
        assert.equal((await listbox.textContent())?.includes(secret.name), false);
      }
      assert.equal(await page.getByRole("link", { name: linkName, exact: true }).count(), 0);
      assert.equal(await link.getAttribute("href"), null);
      assert.equal(await input.inputValue(), "Token");
      assert.equal(await hasFocus(input), true);
      assert.equal(await appField.inputValue(), staged.name);
      await input.press("Enter");
      assert.equal(await input.inputValue(), "Token");
      await input.press("Escape");
      assert.equal(await input.inputValue(), "Bound Secret");
      assert.equal(await input.getAttribute("aria-expanded"), "false");
      assert.equal((await listbox.textContent())?.includes(bot.name), false);
    } finally {
      release();
      restore();
      await page.unroute(collection);
    }
    const deniedRead = restrict(fixture.policy, "read", "secret", {
      namespaceId: namespace.id,
      resourceId: app.id,
    });
    try {
      await input.fill("Token");
      const retry = listRead();
      await listbox.getByRole("option", { name: "Refresh Secret list", exact: true }).click();
      const response = await retry;
      assert.equal(response.status(), 200);
      const allowedIds = ((await response.json()) as SecretListResponse).data.map((s) => s.id);
      assert.deepEqual(allowedIds.sort(), initialIds.filter((id) => id !== app.id).sort());
      await listbox.getByRole("option", { name: replacement.name, exact: true }).waitFor();
      assert.equal(await input.inputValue(), "Token");
      assert.equal(await hasFocus(input), true);
      assert.equal(
        new URL((await link.getAttribute("href"))!, fixture.origin).searchParams.get("secret"),
        chooseWhilePending ? replacement.id : bot.id,
      );
      // Clear the filter to inspect the complete menu, not merely a hidden denied row.
      await input.fill("");
      const menuIds = await listbox
        .locator('[role="option"]')
        .evaluateAll((options) =>
          options.map((option) => option.id).filter((id) => id.includes("-option-secret%3A")),
        );
      assert.deepEqual(
        menuIds.sort(),
        allowedIds
          .map((id): string => `${inputId}-option-${encodeURIComponent(`secret:${id}`)}`)
          .sort(),
      );
      assert.equal((await listbox.textContent())?.includes(app.name), false);
      await input.press("Escape");
      await waitForInputValue(input, chooseWhilePending ? replacement.name : bot.name);
      assert.equal(await appField.inputValue(), staged.name);
      const appLink = page.getByRole("link", {
        name: "View app token Secret metadata (opens in new tab)",
      });
      assert.equal(
        new URL((await appLink.getAttribute("href"))!, fixture.origin).searchParams.get("secret"),
        staged.id,
      );
    } finally {
      liftRestriction(fixture.policy, deniedRead);
    }
  }
  await settlePageRequests(page);
  assert.deepEqual(
    requests.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method)),
    [],
  );
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(saved.data.secretBindings.SLACK_APP_TOKEN.source.id, app.id);
  assert.equal(saved.data.secretBindings.SLACK_BOT_TOKEN.source.id, bot.id);
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
