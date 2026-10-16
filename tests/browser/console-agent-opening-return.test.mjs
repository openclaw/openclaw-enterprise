import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";

// Holds the first read matching path until release(); later matches go straight through.
// A hand-written one-shot flag, not Playwright's { times: 1 }: that turns interception off once
// no routes remain, which would silently release any other held read.
async function holdFirstRead(t, page, path) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let taken = false;
  let requestedResolve;
  let timer;
  const requested = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`No ${path} read was requested`)), 10_000);
    requestedResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  requested.catch(() => {});
  await page.route(path, async (route) => {
    if (taken) {
      await route.continue().catch(() => {});
      return;
    }
    taken = true;
    requestedResolve();
    await held;
    await route.continue().catch(() => {});
  });
  t.after(() => {
    clearTimeout(timer);
    release();
  });
  return { requested, release, wasRequested: () => taken };
}

const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';
const activeView = '.content [aria-live="polite"]:not([inert])';

// Signs in to a loaded Agents list and pauses the page clock, so timers run only when a test
// runs the clock.
async function openPausedList(t, name, agentName) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const agent = await fixture.createAgent(namespace.id, agentName, nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await page.clock.install();
  const listUrl = `/console/agents?namespace=${namespace.id}`;
  await login(page, fixture, listUrl);
  await page.locator(settledView).getByRole("link", { name: agentName }).waitFor();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 1000));
  return { fixture, namespace, agent, page, listUrl };
}

// Opens the Agent from the list while its first read is held, so the pending panel stays.
async function openPendingAgent(t, page, namespace, agent, agentName) {
  const read = await holdFirstRead(t, page, `**/namespaces/${namespace.id}/agents/${agent.id}`);
  const link = page.locator(settledView).getByRole("link", { name: agentName });
  await link.focus();
  await link.press("Enter");
  await read.requested;
  const main = page.getByRole("main");
  await main.getByText("Loading agent details…", { exact: true }).waitFor();
  return { read, main };
}

test("Refocusing the window keeps the pending Agent panel and its way back", async (t) => {
  const { namespace, agent, page } = await openPausedList(t, "Pending refocus", "Pending Agent");
  const { read, main } = await openPendingAgent(t, page, namespace, agent, "Pending Agent");
  // A refocus check would read the session again; hold it so a swap would stay on screen.
  const session = await holdFirstRead(t, page, "**/api/auth/session");

  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await page.evaluate(() => globalThis.document.dispatchEvent(new Event("visibilitychange")));
  await page.clock.runFor(1500);
  assert.equal(await main.getByText("Loading agent details…", { exact: true }).isVisible(), true);
  assert.equal(await main.getByRole("button", { name: "Back to Agents" }).isVisible(), true);
  assert.equal(await main.getByText("Checking Namespace access.").count(), 0);
  assert.equal(await main.getByText("Reading this Agent.").count(), 0);
  assert.equal(await page.locator('.content [aria-live="polite"][inert]').count(), 0);
  assert.equal(
    await main
      .getByRole("heading", { name: "Agent details" })
      .evaluate((node) => node === globalThis.document.activeElement),
    true,
  );

  // The opening load is the access check: it finishes and shows the Agent.
  read.release();
  session.release();
  await page.locator(activeView).getByRole("region", { name: "Agent state at a glance" }).waitFor();
  await page.getByRole("heading", { name: "Pending Agent" }).waitFor();
  assert.equal(session.wasRequested(), false);

  // Once the Agent is shown, a refocus checks it again as before.
  const recheck = await holdFirstRead(t, page, "**/api/auth/session");
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await recheck.requested;
  recheck.release();
});

test("A double press on Back to Agents goes back once and stays in the console", async (t) => {
  const { namespace, agent, page, listUrl } = await openPausedList(
    t,
    "Double back",
    "Double Agent",
  );
  const { read, main } = await openPendingAgent(t, page, namespace, agent, "Double Agent");
  const back = main.getByRole("button", { name: "Back to Agents" });
  // Both presses land before the first traversal does, as a fast double click can.
  await back.evaluate((node) => {
    node.click();
    node.click();
  });
  await page.waitForURL(`**${listUrl}`);
  await page.locator(activeView).getByRole("link", { name: "Double Agent" }).waitFor();
  // A second traversal, if queued, lands within a few frames; give it real time to show.
  await delay(750);
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, listUrl);
  assert.equal(
    await page.locator(activeView).getByRole("link", { name: "Double Agent" }).isVisible(),
    true,
  );
  read.release();
});

test("A chat link that cannot be resolved says so on the Agents list, once", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Chat link", { ready: true });
  await fixture.createAgent(namespace.id, "Listed Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).getByRole("link", { name: "Listed Agent" }).waitFor();
  const notice = page.getByText(
    "This Agent chat link could not be opened. It may have expired, or your access may not include its Agent.",
    { exact: true },
  );
  assert.equal(await notice.count(), 0);

  // A copied chat link opened in this tab; the key resolves to nothing (404).
  const lookup = page.waitForResponse((response) =>
    response.url().includes(`/native-admin/return/${"c".repeat(32)}`),
  );
  await page.evaluate((value) => {
    globalThis.history.pushState(null, "", `/console#native-agent=${value}`);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, "c".repeat(32));
  assert.equal((await lookup).status(), 404);
  await page.waitForURL(/\/console\/agents/);
  await notice.waitFor();
  assert.equal(await notice.getAttribute("role"), "status");
  await page.locator(settledView).getByRole("link", { name: "Listed Agent" }).waitFor();

  // The notice belongs to that landing only.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.locator(settledView).getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.locator(settledView).getByRole("link", { name: "Listed Agent" }).waitFor();
  assert.equal(await notice.count(), 0);
});
