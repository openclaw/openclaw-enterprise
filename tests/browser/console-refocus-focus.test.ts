import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Locator, Page } from "playwright";

import type { NamespaceWire } from "../../packages/contracts/src/api/resources.ts";

import {
  apiRequests,
  detailUrl,
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  secretOptionLabel,
  selectSecret,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { restrict } from "../helpers/iam-grants.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';
const heldView = '.content [aria-live="polite"][inert]';
// Refocusing the window rechecks the session and Namespace access.
const refocus = (page: Page) => page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));

// A navigation that holds the shown page keeps focus on its heading (findings 1626, 1636), but a
// refocus recheck does not: the list stays inert while we check access, then the reader can
// continue from the same link. Moving to the navigation during the check is a new focus choice.
test("refocusing the Agents list restores its focused link unless the reader moved on", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refocus focus");
  await fixture.createAgent(namespace.id, "Refocus Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const link = page.locator(settledView).getByRole("link", { name: "Refocus Agent" });
  await link.waitFor();
  const onHeading = () =>
    page.evaluate(
      () => globalThis.document.activeElement === globalThis.document.querySelector(".content h1"),
    );
  const navigation = page.getByRole("link", { name: "Namespaces", exact: true });
  for (const expectedFocus of [link, navigation]) {
    // Let the row reads finish so the held check is the session's, not a deployment's.
    await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
    await link.focus();
    assert.equal(await hasFocus(link), true);
    const read = await holdRequests(t, page, "**/api/auth/session", { once: true });
    await refocus(page);
    await read.requested;
    await page.locator(heldView).waitFor();
    assert.equal(await onHeading(), false, "the held list leaves focus off its heading");
    if (expectedFocus === navigation) {
      await navigation.focus();
    }
    read.release();
    await link.waitFor();
    assert.equal(await hasFocus(expectedFocus), true, "keep the reader's place after the check");
  }
});

// Holds the recheck's session read so the held list can be observed, then lets it finish.
async function refocusHeld(t: TestContext, page: Page, during?: () => Promise<void>) {
  const read = await holdRequests(t, page, "**/api/auth/session", { once: true });
  await refocus(page);
  await read.requested;
  await page.locator(heldView).waitFor();
  await during?.();
  read.release();
  await page.locator(settledView).waitFor();
}

const deploymentsRead = (namespace: NamespaceWire) =>
  `**/namespaces/${namespace.id}/agents/*/deployments/*`;
const deploymentRecord = (namespace: NamespaceWire) => ({
  json: {
    data: {
      namespaceId: namespace.id,
      status: "succeeded",
      error: null,
      warnings: [],
      progress: null,
    },
    meta: { requestId: "req_test_refocus_focus" },
  },
});
const holdDeploymentRead = (t: TestContext, page: Page, namespace: NamespaceWire) =>
  holdRequests(t, page, deploymentsRead(namespace), {
    once: true,
    fulfill: deploymentRecord(namespace),
  });
// Marks the shown list, so a reused list can be told from a rebuilt one.
const tagList = (page: Page) =>
  page.locator(settledView).evaluate((node) => node.setAttribute("data-kept", "true"));
const listKept = async (page: Page) =>
  (await page.locator(`${settledView}[data-kept]`).count()) === 1;

async function openDeployedList(t: TestContext, name: string) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const agent = await fixture.createAgent(namespace.id, "Refocus Agent", nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  await page.route(deploymentsRead(namespace), (route) =>
    route.fulfill(deploymentRecord(namespace)),
  );
  return { fixture, namespace, page };
}

// A row's deployment read is reread whenever the list resumes, so one still running, or one the
// recheck aborted, doesn't make a refocus rebuild the list, which dropped focus to the body
// (finding 1663).
test("refocusing the Agents list while a row reads its deployment keeps the reader's place", async (t) => {
  const { fixture, namespace, page } = await openDeployedList(t, "Refocus row read");
  const row = await holdDeploymentRead(t, page, namespace);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const link = page.locator(settledView).getByRole("link", { name: "Refocus Agent" });
  await link.waitFor();
  await row.requested;
  await link.focus();
  await tagList(page);
  const cell = page.locator(".content .agent-deployment");
  await refocusHeld(t, page, async () => {
    // The recheck aborted the row's read; the held list doesn't show that as its answer.
    assert.equal(await cell.textContent(), "Reading deployment…");
  });
  assert.equal(await hasFocus(link), true, "keep focus on the Agent link");
  assert.equal(await listKept(page), true, "reuse the list");
  // The resumed list's reread fills the row; the held answer goes to the aborted request.
  row.release();
  const deployment = page.locator(settledView).locator(".agent-deployment a");
  await deployment.waitFor();
  assert.match(await deployment.innerText(), /^v1 · Completed/);
  assert.equal(await hasFocus(link), true);
  // The aborted read did not make the list one a later refocus rebuilds.
  await refocusHeld(t, page);
  assert.equal(await hasFocus(link), true, "keep focus on a later refocus");
  assert.equal(await listKept(page), true, "reuse the list on a later refocus");
});

// Refocusing again while a refocus's reread runs keeps focus on the pending deployment, which
// carries the deployment's address until a reread settles.
test("refocusing during a deployment reread keeps focus on that deployment", async (t) => {
  const { fixture, namespace, page } = await openDeployedList(t, "Refocus reread");
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const cell = page.locator(settledView).locator(".agent-deployment");
  const deployment = cell.getByRole("link", { name: "v1 · Completed", exact: true });
  await deployment.waitFor();
  await deployment.focus();
  await tagList(page);
  const pending = cell.locator("[data-return-focus-href]");
  let reread;
  for (const refocusing of ["first", "second", "third"]) {
    reread = await holdDeploymentRead(t, page, namespace);
    await refocusHeld(t, page);
    await reread.requested;
    assert.equal(
      await hasFocus(pending),
      true,
      `the ${refocusing} refocus focuses the pending cell`,
    );
    assert.equal(await listKept(page), true, `the ${refocusing} refocus reuses the list`);
  }
  assert.ok(reread, "Deployment reread was held");
  reread.release();
  await deployment.waitFor();
  assert.equal(await hasFocus(deployment), true, "the fresh link takes focus");
});

// A row read that failed is reread on resume too, so it doesn't make a refocus rebuild the list.
test("refocusing the Agents list after a row read failed keeps the reader's place", async (t) => {
  const { fixture, namespace, page } = await openDeployedList(t, "Refocus failed row");
  const failed = await holdRequests(t, page, deploymentsRead(namespace), {
    once: true,
    fulfill: apiErrorResponse(500, "INTERNAL_ERROR", "Unavailable."),
  });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await failed.requested;
  failed.release();
  const cell = page.locator(settledView).locator(".agent-deployment");
  await cell.getByText("Deployment unavailable").waitFor();
  const link = page.locator(settledView).getByRole("link", { name: "Refocus Agent" });
  await link.focus();
  await tagList(page);
  await refocusHeld(t, page);
  assert.equal(await hasFocus(link), true, "keep focus on the Agent link");
  assert.equal(await listKept(page), true, "reuse the list");
  await cell.getByRole("link", { name: "v1 · Completed", exact: true }).waitFor();
});

// Shell controls outside the page are replaced by the recheck's shells; focus returns to the
// same control once the list is reused (finding 1662). An account menu item, whose new menu
// starts closed, gives it to the menu's toggle.
test("refocusing the Agents list restores focus on sidebar and header controls", async (t) => {
  const { fixture, namespace, page } = await openDeployedList(t, "Refocus shell");
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).locator(".agent-deployment a").waitFor();
  const toggle = page.locator(".account-toggle");
  for (const [control, restored = control] of [
    [page.locator(".sidebar").getByRole("link", { name: "Namespaces", exact: true })],
    [toggle],
    [page.getByRole("menuitem", { name: "Settings" }), toggle],
    [page.locator("#namespace-selector")],
    [page.getByRole("button", { name: "Refresh", exact: true })],
  ] satisfies [Locator, Locator?][]) {
    if (restored !== control) {
      await toggle.click();
    }
    await control.focus();
    assert.equal(await hasFocus(control), true);
    await refocusHeld(t, page);
    assert.equal(await hasFocus(restored), true, "focus returns to the same control");
  }
  // At phone width the navigation toggle sits outside the sidebar and header.
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = page.getByRole("button", { name: "Open navigation" });
  await navigation.focus();
  assert.equal(await hasFocus(navigation), true);
  await refocusHeld(t, page);
  assert.equal(await hasFocus(navigation), true, "focus returns to the navigation toggle");
});

// At phone width the recheck's new shell starts with its navigation drawer closed, so a control
// that was focused in the open drawer is hidden. Focus goes to the drawer's toggle, as an account
// menu item gives it to the account toggle, instead of falling to the body (finding 1680).
test("refocusing at phone width with the navigation drawer open focuses the drawer toggle", async (t) => {
  const { fixture, namespace, page } = await openDeployedList(t, "Refocus drawer");
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).locator(".agent-deployment a").waitFor();
  const navigation = page.getByRole("button", { name: "Open navigation" });
  const drawer = page.locator("#navigation-drawer");
  const toggle = drawer.locator(".account-toggle");
  for (const [name, control, openMenu] of [
    ["a navigation link", drawer.getByRole("link", { name: "Namespaces", exact: true })],
    ["the account toggle", toggle],
    ["an account menu item", drawer.getByRole("menuitem", { name: "Settings" }), true],
    ["the drawer's close button", drawer.getByRole("button", { name: "Close navigation" })],
  ] satisfies [string, Locator, boolean?][]) {
    await navigation.click();
    await drawer.waitFor({ state: "visible" });
    if (openMenu) {
      await toggle.click();
    }
    await control.focus();
    assert.equal(await hasFocus(control), true, `focus ${name}`);
    await refocusHeld(t, page);
    assert.equal(await hasFocus(navigation), true, `${name} gives focus to the drawer toggle`);
    assert.equal(await navigation.getAttribute("aria-expanded"), "false");
    assert.equal(await drawer.isVisible(), false, "the drawer is closed");
  }
});

// Initial admission allows Agent metadata without Configuration read. Refocus must preserve
// that same partial view instead of replacing the accessible Agent with a page-wide denial.
test("mounted Agent refocus preserves a stable Configuration denial", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Partial Agent refocus");
  const agent = await fixture.createAgent(
    namespace.id,
    "Partial Agent",
    nativeValues("private-model"),
  );
  const { page } = await newPage(t, fixture, { browser });
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  restrict(fixture.policy, "read", "configuration", {
    namespaceId: namespace.id,
    resourceId: agent.configurationId,
  });
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=configuration`,
  );
  const unavailable = page.getByRole("heading", { name: "Configuration unavailable", exact: true });
  await unavailable.waitFor();
  await page.locator(settledView).waitFor();
  // Reload admits the partial view from the same owner's remembered exact-path refusal.
  // Refocus must still ask the server again when this new view has no read signature.
  await page.reload();
  await unavailable.waitFor();
  await page.locator(settledView).waitFor();
  await page
    .locator(settledView)
    .evaluate((node) => node.setAttribute("data-partial-agent", "true"));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const checked = page.waitForResponse((response) => response.url().endsWith(configurationPath));
    await refocus(page);
    assert.equal((await checked).status(), 403);
    await page.locator(settledView).waitFor();
    assert.equal(await unavailable.isVisible(), true);
    assert.equal(await page.locator('[data-partial-agent="true"]').count(), 1);
    assert.equal(
      await page.getByRole("heading", { name: "Partial Agent", exact: true }).isVisible(),
      true,
    );
  }
});

for (const revoked of ["configuration", "agent"] as const) {
  test(`Credentials preflight scrubs bindings when ${revoked} read is revoked`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(
      t,
      `Revoked ${revoked} preflight`,
    );
    const appSecret = await fixture.createSecret(
      namespace.id,
      "Original app binding",
      "xapp-original",
    );
    const botSecret = await fixture.createSecret(
      namespace.id,
      "Original bot binding",
      "xoxb-original",
    );
    const replacement = await fixture.createSecret(
      namespace.id,
      "Replacement app binding",
      "xapp-replacement",
    );
    const agent = await fixture.createAgent(
      namespace.id,
      "Credential refocus Agent",
      nativeValues("binding-review", {
        harnessId: "codex",
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            dmPolicy: "allowlist",
            groupPolicy: "allowlist",
            allowFrom: ["U123"],
            channels: { C123: { requireMention: true } },
          },
        },
      }),
      {
        executionMode: "dedicated",
        secretBindings: {
          SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
          SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
        },
      },
    );
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
    await waitForInputValue(page.getByLabel("Slack bot token"), secretOptionLabel(botSecret));
    await page.locator(settledView).waitFor();

    // A granted administrator keeps the readable form on refocus. Only the later exact
    // read restriction changes admission; Configuration update and Secret operate stay granted.
    await refocusHeld(t, page);
    await waitForInputValue(page.getByLabel("Slack bot token"), secretOptionLabel(botSecret));
    await selectSecret(page, "Slack app token", replacement);
    restrict(fixture.policy, "read", revoked, {
      namespaceId: namespace.id,
      resourceId: revoked === "agent" ? agent.id : agent.configurationId,
    });
    await page.getByRole("button", { name: "Save channel Secrets", exact: true }).click();
    await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
    const assertScrubbed = async () => {
      assert.equal(await page.getByLabel("Slack bot token").count(), 0);
      const html = await page.content();
      for (const secret of [appSecret, botSecret, replacement]) {
        assert.equal(html.includes(secret.name), false, "no cached binding name remains");
        assert.equal(html.includes(secret.id), false, "no cached binding reference remains");
      }
      assert.deepEqual(nonAuthWriteRequests(requests), [], "denied preflight sends no write");
    };
    await assertScrubbed();

    // Re-admission and history must not recover the now-revoked form from a retained view.
    const sessionRead = page.waitForResponse("**/api/auth/session");
    await refocus(page);
    await sessionRead;
    const heading = revoked === "agent" ? "Access denied" : "Configuration unavailable";
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await assertScrubbed();
    await page.reload();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    const deniedPath = `/namespaces/${namespace.id}/${revoked === "agent" ? "agents" : "configurations"}/${revoked === "agent" ? agent.id : agent.configurationId}`;
    const deniedRead = page.waitForResponse((response) => response.url().endsWith(deniedPath));
    await refocus(page);
    assert.equal((await deniedRead).status(), 403);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await assertScrubbed();
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
    await page.goBack();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await assertScrubbed();
  });
}
