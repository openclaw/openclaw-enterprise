import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Locator, Page } from "playwright";

import type { NamespaceWire } from "../../packages/contracts/src/api/resources.ts";
import type { InMemoryPlatformState } from "../../packages/occ/src/index.ts";

import {
  AGENT_READ,
  apiRequests,
  detailUrl,
  fileBrowser,
  grantMember,
  hasFocus,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  secretOptionLabel,
  selectSecret,
  settledView,
  waitForEnabled,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";
import {
  focusedLabel,
  fulfillMethod,
  heldView,
  refocus,
  refocusHeld,
  tagView,
  viewTag,
} from "./console-refocus-helpers.mjs";
import { slackAgentValues, slackTokenBindings } from "./console-slack-agent.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.mjs";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { deleteRefused } from "../helpers/refusal-text.mjs";
import { restrict } from "../helpers/iam-grants.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

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
  await tagView(page);
  const cell = page.locator(".content .agent-deployment");
  await refocusHeld(t, page, async () => {
    // The recheck aborted the row's read; the held list doesn't show that as its answer.
    assert.equal(await cell.textContent(), "Reading deployment…");
  });
  assert.equal(await hasFocus(link), true, "keep focus on the Agent link");
  assert.equal(await viewTag(page), "kept", "reuse the list");
  // The resumed list's reread fills the row; the held answer goes to the aborted request.
  row.release();
  const deployment = page.locator(settledView).locator(".agent-deployment a");
  await deployment.waitFor();
  assert.match(await deployment.innerText(), /^v1 · Completed/);
  assert.equal(await hasFocus(link), true);
  // The aborted read did not make the list one a later refocus rebuilds.
  await refocusHeld(t, page);
  assert.equal(await hasFocus(link), true, "keep focus on a later refocus");
  assert.equal(await viewTag(page), "kept", "reuse the list on a later refocus");
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
  await tagView(page);
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
    assert.equal(await viewTag(page), "kept", `the ${refocusing} refocus reuses the list`);
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
  await tagView(page);
  await refocusHeld(t, page);
  assert.equal(await hasFocus(link), true, "keep focus on the Agent link");
  assert.equal(await viewTag(page), "kept", "reuse the list");
  await cell.getByRole("link", { name: "v1 · Completed", exact: true }).waitFor();
});

// A row write makes the list one a refocus never reuses, so the refocus after a refused Delete
// rebuilds it, and keyboard focus on the row's icon fell to the body, though the re-grant the
// recheck picked up made the icon usable again (finding D814). Focus now returns to the same
// icon in the rebuilt row.
test("refocusing an Agents list that rebuilds keeps focus on the row's icon", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refocus rebuilt row");
  const agent = await fixture.createAgent(namespace.id, "Regranted Row", nativeValues("row"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = "refocus-row-reader";
  const { credentials } = await fixture.createNamespaceMember(member, namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture, { browser });
  // The row's first permission answer is held, so Delete stays available and the API refuses it.
  await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    { once: true, method: "GET" },
  );
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, credentials);
  const remove = page
    .locator(settledView)
    .getByRole("button", { name: "Delete Regranted Row", exact: true });
  await waitForEnabled(remove);
  await remove.click();
  await page
    .getByRole("dialog", { name: "Delete Regranted Row?" })
    .getByRole("button", { name: "Permanently delete Agent", exact: true })
    .click();
  const alert = page.getByRole("alert").filter({ hasText: deleteRefused("Regranted Row") });
  await alert.waitFor();
  assert.equal(await hasFocus(remove), true);
  assert.equal(await remove.getAttribute("aria-disabled"), "true");
  await tagView(page);
  grantMember(fixture, member, [["delete", "agent"]]);
  await refocusHeld(t, page);
  assert.equal(await viewTag(page), null, "the refocus rebuilds the list");
  // The rebuilt row's permission answer can replace its icons at any moment, keeping focus on the
  // new Delete. A locator resolved before that replacement names the old, detached icon, so the
  // check reads the focused control in one step (finding 2970: 2 of 50 runs failed that way).
  assert.equal(
    await focusedLabel(page),
    "Delete Regranted Row",
    "focus returns to the row's Delete",
  );
  // That answer, read after the grant, keeps Delete usable and focused. The reader still lacks
  // operate, so the row's note names it once the answer applies.
  const row = page.locator(settledView).getByRole("row").filter({ hasText: "Regranted Row" });
  await row.getByText("Needs Agent operate", { exact: true }).waitFor();
  await waitForEnabled(remove);
  assert.equal(await alert.count(), 0);
  assert.equal(await hasFocus(remove), true);
});

// A rebuilt row whose focused control is gone dropped focus to the body (finding 2967). Here
// another session stops an Agent whose first deployment had not started a version: with no
// selected version, the rebuilt row has no Stop. Focus now goes to the same row's name.
test("refocusing a rebuilt Agents list whose focused Stop is gone focuses the row's name", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refocus stopped row");
  const agent = await fixture.createAgent(namespace.id, "Stopped Row", nativeValues("stopped"));
  // Requested to run, with no version selected yet: the row offers Stop.
  await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const view = page.locator(settledView);
  const stop = view.getByRole("button", { name: "Stop Stopped Row", exact: true });
  await waitForEnabled(stop);
  await stop.focus();
  await tagView(page);
  // Another session stops the Agent, so the recheck's list read changes and the list rebuilds.
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  assert.equal((await fixture.request("POST", `${agentPath}/stop`)).status, 202);
  await refocusHeld(t, page);
  assert.equal(await viewTag(page), null, "the refocus rebuilds the list");
  assert.equal(await stop.count(), 0, "a stopped Agent with no version has no Stop");
  const name = view.getByRole("link", { name: "Stopped Row", exact: true });
  assert.equal(await hasFocus(name), true, "focus goes to the row's name");
});

// A refusal that is not about grants is kept through a refocus that rebuilds the list (finding
// D812), but only for an Agent the rebuilt list still shows. When another session's deletion
// removed the row, the refocus drops the refusal, and focus on its icon goes to the page heading,
// not to the body (findings 2967, 2968).
test("refocusing after a refused row's Agent was deleted elsewhere drops the refusal", async (t) => {
  // The fixture's own State completes the deletion work the controller records, as the
  // worker's finalizer does.
  const kept: { state?: InMemoryPlatformState } = {};
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refocus removed row", {
    recordOperations: true,
    wrapState: (base: InMemoryPlatformState) => (kept.state = base),
  });
  await fixture.createAgent(namespace.id, "Listed Row", nativeValues("listed"));
  const removed = await fixture.createAgent(namespace.id, "Removed Row", nativeValues("removed"));
  await fixture.seedActiveAgentRevision(namespace.id, removed.id);
  const { page } = await newPage(t, fixture, { browser });
  const agentPath = `/namespaces/${namespace.id}/agents/${removed.id}`;
  // A caller-state denial any authorized request can get; the in-memory app has no disabled
  // identity, so the API's answer is fulfilled.
  const message = "The acting identity is unavailable.";
  await fulfillMethod(
    page,
    `${fixture.origin}${agentPath}/stop`,
    "POST",
    apiErrorResponse(403, "FORBIDDEN", message),
  );
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const view = page.locator(settledView);
  const stop = view.getByRole("button", { name: "Stop Removed Row", exact: true });
  await waitForEnabled(stop);
  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop Removed Row?" })
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  const alert = page.getByRole("alert").filter({ hasText: message });
  await alert.waitFor();
  assert.equal(await hasFocus(stop), true);
  // Another session deletes the Agent, and its deletion completes.
  const { state } = kept;
  assert.ok(state, "the fixture's State");
  assert.equal((await fixture.request("DELETE", agentPath)).status, 202);
  assert.equal(await state.completeAgentDeletion(namespace.id, removed.id), true);
  await tagView(page);
  await refocusHeld(t, page);
  assert.equal(await viewTag(page), null, "the refocus rebuilds the list");
  await view.getByRole("link", { name: "Listed Row", exact: true }).waitFor();
  assert.equal(await view.getByRole("link", { name: "Removed Row", exact: true }).count(), 0);
  assert.equal(await alert.count(), 0, "no refusal for an Agent the list no longer shows");
  assert.equal(await hasFocus(page.locator(".content h1")), true, "focus goes to the heading");
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

// Tab past a page's last control moves focus to the browser's own controls, and the next Tab
// brings it back to the page's first. That lap is not the reader coming back: the refocus recheck
// it started held the page inert, so the next lap went from the header straight back to the
// sidebar (finding 2879). Each recheck's session read is held here, so a held page stays held
// while the lap runs. A refocus from elsewhere still rechecks.
for (const view of ["Agent page", "Create Agent"] as const) {
  test(`a Tab lap past the end of ${view} reaches its content again, and a refocus still rechecks`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, `Tab lap ${view}`);
    const agent = await fixture.createAgent(namespace.id, "Tab lap Agent", nativeValues("v1"));
    const { page } = await newPage(t, fixture, { browser });
    await login(
      page,
      fixture,
      view === "Agent page"
        ? detailUrl(fixture, namespace.id, agent.id)
        : `/console/agents/new?namespace=${namespace.id}`,
    );
    await page.locator(settledView).waitFor();
    await page
      .getByRole("heading", { name: view === "Agent page" ? "Tab lap Agent" : view })
      .waitFor();
    let releaseSession = () => {};
    let sessionHeld = Promise.resolve();
    const holdSession = () => {
      sessionHeld = new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
    };
    holdSession();
    t.after(() => releaseSession());
    let sessionReads = 0;
    await page.route("**/api/auth/session", async (route) => {
      sessionReads += 1;
      await sessionHeld;
      await route.fallback();
    });
    const focusIn = () =>
      page.evaluate(() => {
        const active = globalThis.document.activeElement;
        if (!active || active === globalThis.document.body) {
          return "outside";
        }
        return globalThis.document.querySelector('.content [aria-live="polite"]')?.contains(active)
          ? "content"
          : "shell";
      });
    // Tab until focus is in `where`, at most 150 presses.
    const tabUntil = async (where: "content" | "outside") => {
      for (let presses = 0; presses < 150; presses += 1) {
        await page.keyboard.press("Tab");
        if ((await focusIn()) === where) {
          return true;
        }
      }
      return false;
    };
    // Two laps: Tab until focus leaves the page, then on until it reaches the page's content.
    // Each lap stops at a bound, so a page whose content Tab skips fails here.
    for (const lap of [1, 2]) {
      assert.equal(await tabUntil("content"), true, `lap ${lap} reaches the page content`);
      assert.equal(await tabUntil("outside"), true, `lap ${lap} leaves the page`);
    }
    // One more Tab brings focus back, which ends the lap.
    await page.keyboard.press("Tab");
    assert.equal(await focusIn(), "shell");
    assert.equal(sessionReads, 0, "a Tab lap starts no recheck");
    assert.equal(await page.locator(heldView).count(), 0);

    // A refocus that no Tab started is the reader coming back: it rechecks and holds the page.
    await refocus(page);
    await page.locator(heldView).waitFor();
    assert.equal(sessionReads, 1);
    releaseSession();
    await page.locator(settledView).waitFor();

    // Focus that leaves the window with no Tab just before it, such as a click on another
    // window, is not a lap either: its return rechecks. The wait puts that blur over 1 s past the
    // last Tab press.
    holdSession();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await page.evaluate(() => globalThis.dispatchEvent(new Event("blur")));
    await refocus(page);
    await page.locator(heldView).waitFor();
    assert.equal(sessionReads, 2, "a return from a blur no Tab started rechecks");
    releaseSession();
    await page.locator(settledView).waitFor();

    // Nor is a Tab out that comes back after the lap window (10 s): the reader may have been
    // elsewhere meanwhile, so the return rechecks. One page is enough for this shared handler.
    if (view === "Agent page") {
      holdSession();
      assert.equal(await tabUntil("outside"), true, "Tab leaves the page");
      await new Promise((resolve) => setTimeout(resolve, 10_500));
      await page.keyboard.press("Tab");
      await page.locator(heldView).waitFor();
      assert.equal(sessionReads, 3, "a return after the lap window rechecks");
      releaseSession();
      await page.locator(settledView).waitFor();
    }
  });
}

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
      slackAgentValues("binding-review"),
      slackTokenBindings(appSecret, botSecret),
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
