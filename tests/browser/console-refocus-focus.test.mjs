import assert from "node:assert/strict";
import test from "node:test";

import {
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';
const heldView = '.content [aria-live="polite"][inert]';
// Refocusing the window rechecks the session and Namespace access.
const refocus = (page) => page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));

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
  const isFocused = (control) =>
    control.evaluate((node) => node === globalThis.document.activeElement);
  const navigation = page.getByRole("link", { name: "Namespaces", exact: true });
  for (const expectedFocus of [link, navigation]) {
    // Let the row reads finish so the held check is the session's, not a deployment's.
    await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
    await link.focus();
    assert.equal(await isFocused(link), true);
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
    assert.equal(await isFocused(expectedFocus), true, "keep the reader's place after the check");
  }
});

// Holds the recheck's session read so the held list can be observed, then lets it finish.
async function refocusHeld(t, page, during = async () => {}) {
  const read = await holdRequests(t, page, "**/api/auth/session", { once: true });
  await refocus(page);
  await read.requested;
  await page.locator(heldView).waitFor();
  await during();
  read.release();
  await page.locator(settledView).waitFor();
}

const isFocused = (control) =>
  control.evaluate((node) => node === globalThis.document.activeElement);
const deploymentsRead = (namespace) => `**/namespaces/${namespace.id}/agents/*/deployments/*`;
const deploymentRecord = (namespace, status) => ({
  json: {
    data: { namespaceId: namespace.id, status, error: null, warnings: [], progress: null },
    meta: { requestId: "req_test_refocus_focus" },
  },
});
const holdDeploymentRead = (t, page, namespace) =>
  holdRequests(t, page, deploymentsRead(namespace), {
    once: true,
    fulfill: deploymentRecord(namespace, "succeeded"),
  });
// Marks the shown list, so a reused list can be told from a rebuilt one.
const tagList = (page) =>
  page.evaluate(() => {
    globalThis.document.querySelector('.content [aria-live="polite"]').dataset.kept = "true";
  });
const listKept = async (page) => (await page.locator(`${settledView}[data-kept]`).count()) === 1;

async function openDeployedList(t, name) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const agent = await fixture.createAgent(namespace.id, "Refocus Agent", nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  await page.route(deploymentsRead(namespace), (route) =>
    route.fulfill(deploymentRecord(namespace, "succeeded")),
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
  assert.equal(await isFocused(link), true, "keep focus on the Agent link");
  assert.equal(await listKept(page), true, "reuse the list");
  // The resumed list's reread fills the row; the held answer goes to the aborted request.
  row.release();
  const deployment = page.locator(settledView).locator(".agent-deployment a");
  await deployment.waitFor();
  assert.match(await deployment.textContent(), /^v1 · succeeded/);
  assert.equal(await isFocused(link), true);
  // The aborted read did not make the list one a later refocus rebuilds.
  await refocusHeld(t, page);
  assert.equal(await isFocused(link), true, "keep focus on a later refocus");
  assert.equal(await listKept(page), true, "reuse the list on a later refocus");
});

// Refocusing again while a refocus's reread runs keeps focus on the pending deployment, which
// carries the deployment's address until a reread settles.
test("refocusing during a deployment reread keeps focus on that deployment", async (t) => {
  const { fixture, namespace, page } = await openDeployedList(t, "Refocus reread");
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const cell = page.locator(settledView).locator(".agent-deployment");
  const deployment = cell.getByRole("link", { name: "v1 · succeeded", exact: true });
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
      await isFocused(pending),
      true,
      `the ${refocusing} refocus focuses the pending cell`,
    );
    assert.equal(await listKept(page), true, `the ${refocusing} refocus reuses the list`);
  }
  reread.release();
  await deployment.waitFor();
  assert.equal(await isFocused(deployment), true, "the fresh link takes focus");
});

// A row read that failed is reread on resume too, so it doesn't make a refocus rebuild the list.
test("refocusing the Agents list after a row read failed keeps the reader's place", async (t) => {
  const { fixture, namespace, page } = await openDeployedList(t, "Refocus failed row");
  const failed = await holdRequests(t, page, deploymentsRead(namespace), {
    once: true,
    fulfill: { status: 500, json: { error: { code: "INTERNAL", message: "Unavailable." } } },
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
  assert.equal(await isFocused(link), true, "keep focus on the Agent link");
  assert.equal(await listKept(page), true, "reuse the list");
  await cell.getByRole("link", { name: "v1 · succeeded", exact: true }).waitFor();
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
  ]) {
    if (restored !== control) {
      await toggle.click();
    }
    await control.focus();
    assert.equal(await isFocused(control), true);
    await refocusHeld(t, page);
    assert.equal(await isFocused(restored), true, "focus returns to the same control");
  }
  // At phone width the navigation toggle sits outside the sidebar and header.
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = page.getByRole("button", { name: "Open navigation" });
  await navigation.focus();
  assert.equal(await isFocused(navigation), true);
  await refocusHeld(t, page);
  assert.equal(await isFocused(navigation), true, "focus returns to the navigation toggle");
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
  for (const [name, control, openMenu = false] of [
    ["a navigation link", drawer.getByRole("link", { name: "Namespaces", exact: true })],
    ["the account toggle", toggle],
    ["an account menu item", drawer.getByRole("menuitem", { name: "Settings" }), true],
    ["the drawer's close button", drawer.getByRole("button", { name: "Close navigation" })],
  ]) {
    await navigation.click();
    await drawer.waitFor({ state: "visible" });
    if (openMenu) {
      await toggle.click();
    }
    await control.focus();
    assert.equal(await isFocused(control), true, `focus ${name}`);
    await refocusHeld(t, page);
    assert.equal(await isFocused(navigation), true, `${name} gives focus to the drawer toggle`);
    assert.equal(await navigation.getAttribute("aria-expanded"), "false");
    assert.equal(await drawer.isVisible(), false, "the drawer is closed");
  }
});
