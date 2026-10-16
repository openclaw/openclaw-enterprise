import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { FIRST_ACTIVITY_WAIT_MS } from "../../apps/controller/src/console/agents/detail.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
  holdRequests,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";

const SESSION = "**/api/auth/session";
const activeView = '.content [aria-live="polite"]:not([inert])';
const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';
const heldView = '.content [aria-live="polite"][inert]';
const NAMESPACES = { name: "Namespaces", exact: true };
const SUMMARY = { name: "Agent state at a glance" };
const isFocused = (locator) =>
  locator.evaluate((node) => node === globalThis.document.activeElement);
// Refocusing the window rechecks the session and Namespace access.
const refocus = (page) => page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));

async function showNamespaces(page) {
  await page.getByRole("link", NAMESPACES).click();
  await page.locator(settledView).getByRole("list", NAMESPACES).waitFor();
}

// Names the page in the content view after every DOM change, marking a held (inert) page.
function recordShownPages() {
  const seen = [];
  globalThis.__shownPages = seen;
  const record = () => {
    const view = globalThis.document.querySelector('.content [aria-live="polite"]');
    const startup = globalThis.document.querySelector("#app > .startup");
    const openingAgent =
      view?.querySelector('[role="status"]')?.textContent === "Loading agent details…";
    const kind = startup
      ? "startup"
      : !view
        ? "no page"
        : view.querySelector(".agent-current-summary")
          ? "Agent"
          : view.querySelector(".agent-table")
            ? "Agents"
            : view.querySelector('ul.collection[aria-label="Namespaces"]')
              ? "Namespaces"
              : openingAgent
                ? "Opening Agent"
                : `other: ${view.textContent.replace(/\s+/g, " ").trim().slice(0, 80)}`;
    const state = view?.inert ? `${kind} (held)` : kind;
    if (seen.at(-1) !== state) {
      seen.push(state);
    }
  };
  record();
  new globalThis.MutationObserver(record).observe(globalThis.document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
}

// Stops page timers, so the loading delay passes only when a test runs the clock.
async function pauseClock(page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 1000));
}

// Signs in to a loaded Agents list. Unless `running`, the page clock is installed and paused once
// the list loads, so timers run only when a test runs it, and every page shown is recorded.
async function openList(t, name, agentNames, { deploy = false, running = false } = {}) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const agents = [];
  for (const agentName of agentNames) {
    const agent = await fixture.createAgent(namespace.id, agentName, nativeValues("v1"));
    agents.push(
      deploy ? (await fixture.seedActiveAgentRevision(namespace.id, agent.id)).agent : agent,
    );
  }
  const { page } = await newPage(t, fixture);
  if (!running) {
    await page.clock.install();
  }
  const listUrl = `/console/agents?namespace=${namespace.id}`;
  await login(page, fixture, listUrl);
  await page.locator(settledView).getByRole("link", { name: agentNames[0] }).waitFor();
  // The list reads each row's latest deployment after it settles; let those finish, so the
  // list is reusable and no test's held read catches one of them.
  await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
  if (!running) {
    await pauseClock(page);
    await page.evaluate(recordShownPages);
  }
  return { fixture, namespace, agents, agent: agents[0], page, listUrl };
}

// A copied Agent chat link opened in this tab.
function openChatLink(page, key) {
  return page.evaluate((value) => {
    globalThis.history.pushState(null, "", `/console#native-agent=${value}`);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, key);
}

function revokeNamespace(fixture, namespace, id) {
  fixture.policy.restrictions.push({
    id,
    namespaceId: namespace.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
}

// Marks the content view node, so a test can tell a remounted retained node from a rebuild.
function tagView(page, tag) {
  return page.evaluate((value) => {
    globalThis.document.querySelector('.content [aria-live="polite"]').dataset.navTag = value;
  }, tag);
}

function viewTag(page) {
  return page.evaluate(
    () =>
      globalThis.document.querySelector('.content [aria-live="polite"]')?.dataset.navTag ?? null,
  );
}

const shownPages = (page) => page.evaluate(() => globalThis.__shownPages.splice(0));

test("Refocusing a loaded page keeps it steady while access is rechecked", async (t) => {
  const { namespace, page } = await openList(t, "Steady return", ["Steady Agent"], {
    running: true,
  });
  const selector = page.locator("#namespace-selector");
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  const create = page.getByRole("button", { name: "Create Agent" });
  const lookOf = (node) => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return { opacity: style.opacity, color: style.color, background: style.backgroundColor };
  };
  const createLook = await create.evaluate(lookOf);

  const session = await holdRequests(t, page, SESSION);
  // Refocusing the window rechecks the session and Namespace access before the page is reused.
  await refocus(page);
  await session.requested;
  await page.locator(heldView).waitFor();
  // The selector hides its choices until access is confirmed, but keeps naming the Namespace
  // instead of flashing a placeholder, and the inert page keeps its look.
  assert.equal(await selector.isDisabled(), true);
  assert.equal(await selector.locator('option:not([value=""])').count(), 0);
  assert.equal(
    await selector.evaluate((node) => node.selectedOptions[0]?.textContent),
    "Steady return",
  );
  assert.deepEqual(await create.evaluate(lookOf), createLook);

  session.release();
  await page.locator(activeView).waitFor();
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(await selector.locator(`option[value="${namespace.id}"]`).count(), 1);
  await create.click();
  await page.waitForURL("**/console/agents/new**");
});

test("Back after switching Namespace keeps the shown page until the return is admitted", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const first = await fixture.createNamespace("First scope", { ready: true });
  const second = await fixture.createNamespace("Second scope", { ready: true });
  const firstRow = "First scope Agent";
  const secondRow = "Second scope Agent";
  await fixture.createAgent(first.id, firstRow, nativeValues("v1"));
  await fixture.createAgent(second.id, secondRow, nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${first.id}`);
  await page.locator(activeView).waitFor();
  const selector = page.locator("#namespace-selector");
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  await page.locator(activeView).getByText(firstRow, { exact: true }).waitFor();
  await selector.selectOption(second.id);
  await page.waitForURL(`**/console/agents?namespace=${second.id}`);
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  await page.locator(activeView).getByText(secondRow, { exact: true }).waitFor();
  const scope = page.locator(".content .scope");
  const held = page.locator(heldView);

  const session = await holdRequests(t, page, SESSION);
  const collection = await holdRequests(t, page, `**/namespaces/${first.id}/agents`);
  await page.goBack();
  await session.requested;
  await held.waitFor();
  // The shown page keeps its scope; the disabled selector already names the destination.
  assert.equal(await scope.textContent(), "Namespace · Second scope");
  assert.equal(
    await selector.evaluate((node) => node.selectedOptions[0]?.textContent),
    "First scope",
  );
  assert.equal(await selector.locator('option:not([value=""])').count(), 0);

  // Admission enables the destination selector before its collection read finishes.
  // Until the rows change, the content's scope must still describe the rows on screen.
  session.release();
  await collection.requested;
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(await selector.inputValue(), first.id);
  await held.getByText(secondRow, { exact: true }).waitFor();
  assert.equal(await scope.textContent(), "Namespace · Second scope");
  assert.equal(await held.getByText(firstRow, { exact: true }).count(), 0);

  collection.release();
  const visibleView = page.locator(activeView);
  await visibleView.getByText(firstRow, { exact: true }).waitFor();
  assert.equal(await scope.textContent(), "Namespace · First scope");
  assert.equal(await visibleView.getByText(secondRow, { exact: true }).count(), 0);
});

test("Back to a retained Agent page after access was revoked never shows the cached page", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked scope", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Revoked Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.getByRole("region", SUMMARY);
  await summary.waitFor();
  await page.locator(activeView).waitFor();
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("link", { name: "Revoked Agent" }).waitFor();
  await page.locator(activeView).waitFor();

  revokeNamespace(fixture, namespace, "revoke-retained-agent-namespace");
  // Record every DOM state and painted frame from Back until the refusal.
  await page.evaluate((configurationId) => {
    const seen = [];
    globalThis.__cachedAgentSeen = seen;
    const check = (when) => {
      const document = globalThis.document;
      if (
        document.querySelector(".agent-current-summary, .deployment-status, .agent-tabs") ||
        document.body.textContent.includes(configurationId)
      ) {
        seen.push(when);
      }
    };
    new globalThis.MutationObserver(() => check("mutation")).observe(globalThis.document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const frame = () => {
      check("frame");
      globalThis.requestAnimationFrame(frame);
    };
    globalThis.requestAnimationFrame(frame);
  }, agent.configurationId);
  await page.goBack();
  await page.getByRole("heading", { name: "Namespace unavailable" }).waitFor();
  await page.locator(activeView).waitFor();
  assert.deepEqual(
    await page.evaluate(() => globalThis.__cachedAgentSeen.slice(0, 5)),
    [],
    "the retained Agent page was painted or mounted after its access was revoked",
  );
  assert.equal(await page.locator(".agent-current-summary").count(), 0);
});

test("Back during an Agent refocus check keeps the held page inert until the return is admitted", async (t) => {
  const { namespace, page } = await openList(t, "Interrupted check", ["Interrupted Agent"], {
    running: true,
  });
  await page.getByRole("link", { name: "Interrupted Agent" }).click();
  await page.getByRole("region", SUMMARY).waitFor();
  // Only a finished detail rechecks in place on refocus.
  await page.locator(settledView).waitFor();

  const session = await holdRequests(t, page, SESSION);
  // Refocusing Agent detail rechecks access in place; Back cuts that check short.
  await refocus(page);
  await session.requested;
  await page.goBack();
  await page.waitForURL(`**/console/agents?namespace=${namespace.id}`);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
      }),
  );
  assert.equal(await page.locator(heldView).count(), 1);
  assert.equal(await page.locator(activeView).count(), 0);

  session.release();
  await page.locator(activeView).getByRole("link", { name: "Interrupted Agent" }).waitFor();
});

test("Opening Agent details acknowledges navigation immediately; other first visits still swap once", async (t) => {
  const { page } = await openList(t, "Single swap", ["Swap Agent"]);

  // Time stays paused: the destination appears immediately and has no minimum loading time.
  await page.getByRole("link", { name: "Swap Agent" }).click();
  await page.locator(activeView).getByRole("region", SUMMARY).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.__shownPages.splice(0)), [
    "Agents",
    "Opening Agent",
    "Agent",
  ]);

  await page.locator(settledView).waitFor();
  await page.evaluate(() => globalThis.__shownPages.splice(0, Infinity, "Agent"));
  await page.getByRole("link", NAMESPACES).click();
  await page.locator(activeView).getByRole("list", NAMESPACES).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.__shownPages), [
    "Agent",
    "Agent (held)",
    "Namespaces",
  ]);
});

// On a slow link the opening panel's heading had focus, the Agent page rendered with focus on
// body, and its heading took focus only once the tab's reads settled, 0.5-0.9 s later at 400 ms
// (finding 1483). It now takes focus as the title renders.
test("Opening an Agent focuses its heading before the tab's reads settle", async (t) => {
  const { namespace, agent, page } = await openList(t, "Opening focus", ["Opening Focus"], {
    running: true,
  });
  const link = page.locator(settledView).getByRole("link", { name: "Opening Focus" });
  // The Configuration tab's read is slow.
  const configuration = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { once: true },
  );
  await link.focus();
  await link.press("Enter");
  await configuration.requested;
  const heading = page.getByRole("heading", { level: 1, name: "Opening Focus" });
  await heading.waitFor();
  await page.waitForFunction(() => globalThis.document.activeElement?.tagName === "H1", null, {
    timeout: 1000,
  });
  assert.equal(await isFocused(heading), true);
  configuration.release();
  await page.locator(settledView).getByRole("region", SUMMARY).waitFor();
  assert.equal(await isFocused(heading), true);
});

for (const back of ["Browser Back", "Back to Agents"]) {
  test(`${back} during a pending Agent visit restores the list and wins over the late read`, async (t) => {
    const { namespace, agent, page, listUrl } = await openList(
      t,
      "Slow first visit",
      ["Slow Agent"],
      {
        running: true,
      },
    );
    const link = page.locator(settledView).getByRole("link", { name: "Slow Agent" });

    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const read = await holdRequests(t, page, `**${path}`);
    await link.focus();
    await link.press("Enter");
    await read.requested;
    assert.equal(new URL(page.url()).pathname, `/console/agents/${agent.id}`);
    const main = page.getByRole("main");
    assert.equal(await main.getByRole("heading", { name: "Agent details" }).isVisible(), true);
    assert.equal(await main.getByText("Loading agent details…", { exact: true }).isVisible(), true);
    assert.equal(await main.getByText("Slow Agent", { exact: true }).count(), 0);

    const abandoned = page.waitForEvent("requestfailed", (request) => request.url().endsWith(path));
    if (back === "Browser Back") {
      await page.goBack();
    } else {
      await main.getByRole("button", { name: back }).click();
    }
    await page.waitForURL(`**${listUrl}`);
    await link.waitFor();
    assert.equal(await isFocused(link), true);
    read.release();
    await abandoned;
    assert.equal(await link.isVisible(), true);
    assert.equal(await page.locator(".agent-current-summary").count(), 0);
  });
}

for (const focusTarget of [
  "the Agent link",
  "newer sidebar focus",
  "the heading if the Agent is gone",
]) {
  test(`Back to a rebuilt Agents list restores ${focusTarget}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Rebuilt list", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Opening Agent", nativeValues("v1"));
    const list = `**/namespaces/${namespace.id}/agents`;
    const { page } = await newPage(t, fixture);

    // Leaving while a row is still loading means Back must build a fresh list, not reuse its DOM.
    const revision = await holdRequests(t, page, `${list}/${agent.id}/revisions`, { once: true });
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await revision.requested;
    await tagView(page, "original-list");
    const link = page.locator(settledView).getByRole("link", { name: agent.name });
    const detail = await holdRequests(t, page, `${list}/${agent.id}`, { once: true });
    await link.focus();
    await link.press("Enter");
    await detail.requested;
    revision.release();

    const removed = focusTarget === "the heading if the Agent is gone";
    const collection = await holdRequests(t, page, list, {
      once: true,
      fulfill: removed ? { json: { data: [] } } : null,
    });
    await page.goBack();
    await collection.requested;
    assert.equal(
      await link.count(),
      0,
      "no interactive Agent link while the admitted list is still loading",
    );
    const movedFocus = focusTarget === "newer sidebar focus";
    const sidebar = page.getByRole("link", NAMESPACES);
    if (movedFocus) {
      await sidebar.focus();
    }
    collection.release();
    await page.locator(settledView).getByRole("searchbox", { name: "Search Agents" }).waitFor();
    assert.equal(await viewTag(page), null, "the list was rebuilt");
    const expected = movedFocus
      ? sidebar
      : removed
        ? page.getByRole("heading", { name: "Agents", exact: true })
        : link;
    assert.equal(await isFocused(expected), true);
    detail.release();
  });
}

for (const [outcome, failsAgain, leaveFocus] of [
  ["opens the Agent", false, false],
  ["fails a second time", true, false],
  ["succeeds after focus moved to the sidebar", false, true],
  ["fails after focus moved to the sidebar", true, true],
]) {
  test(`Retry from Agent details preserves keyboard focus when it ${outcome}`, async (t) => {
    const { namespace, agent, page } = await openList(t, "Failed first visit", ["Retry Agent"], {
      running: true,
    });
    const link = page.locator(settledView).getByRole("link", { name: "Retry Agent" });

    await page.route(
      `**/namespaces/${namespace.id}/agents/${agent.id}`,
      (route) => route.fulfill({ status: 503, body: "{}" }),
      { times: failsAgain ? 2 : 1 },
    );
    await link.click();
    const main = page.getByRole("main");
    const retry = main.getByRole("button", { name: "Try again" });
    await main.getByRole("heading", { name: "Could not load agent details" }).waitFor();
    assert.equal(await main.getByRole("button", { name: "Back to Agents" }).isVisible(), true);

    const historyLength = await page.evaluate(() => globalThis.history.length);
    const session = await holdRequests(t, page, SESSION, { once: true });
    await retry.focus();
    await retry.press("Enter");
    await session.requested;
    assert.equal(await main.getByText("Loading agent details…").isVisible(), true);
    const loading = main.getByRole("heading", { name: "Agent details" });
    assert.equal(await isFocused(loading), true);
    const sidebar = page.getByRole("link", NAMESPACES);
    if (leaveFocus) {
      await sidebar.focus();
    }
    session.release();
    const result = main.getByRole("heading", {
      name: failsAgain ? "Could not load agent details" : "Retry Agent",
    });
    await result.waitFor();
    // Focus moves to the result once the load settles, after the heading has rendered.
    await page.locator(settledView).waitFor();
    assert.equal(await isFocused(leaveFocus ? sidebar : result), true);
    assert.equal(
      await page.evaluate(() => globalThis.history.length),
      historyLength,
      "retry did not add history",
    );
    await page.goBack();
    await link.waitFor();
  });
}

test("A full load whose session check outlasts the loading delay shows no navigation before it", async (t) => {
  const { page } = await openList(t, "Slow session", ["Session Agent"]);
  const session = await holdRequests(t, page, SESSION);

  await page.reload();
  await session.requested;
  await page.clock.runFor(400);
  await page.locator("#app > .startup", { hasText: "Checking session…" }).waitFor();
  assert.equal(await page.locator(".content, nav").count(), 0);
  session.release();
  await page.locator(settledView).getByRole("link", { name: "Session Agent" }).waitFor();
});

test("A full load replaces the startup status once when its reads settle in time", async (t) => {
  const { page } = await openList(t, "Single load", ["Loaded Agent"]);
  // Record from before the console's module runs, which takes over the startup status.
  await page.addInitScript(
    `document.addEventListener("readystatechange", () => {
      if (document.readyState === "interactive") (${recordShownPages})();
    });`,
  );

  await page.reload();
  await page.locator(settledView).getByRole("link", { name: "Loaded Agent" }).waitFor();
  // The shell's static status is there from the first parse (finding 1444).
  assert.deepEqual(await page.evaluate(() => globalThis.__shownPages), ["startup", "Agents"]);
});

test("Forward during a return's recheck keeps the returning page for the next Back", async (t) => {
  const { namespace, agents, page } = await openList(t, "Forward during return", [
    "Listed Agent",
    "Opened Agent",
  ]);
  const opened = agents[1];
  await tagView(page, "list");
  // The first read is held, so the destination shows its loading status.
  const firstRead = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/agents/${opened.id}`,
    {
      once: true,
    },
  );
  await page.getByRole("link", { name: "Opened Agent" }).click();
  await firstRead.requested;
  // Back returns to the list; its recheck waits on the session read.
  const recheck = await holdRequests(t, page, SESSION, { once: true });
  await page.goBack();
  await page.waitForURL(`**/console/agents?namespace=${namespace.id}`);
  await recheck.requested;
  // Keep the pending destination inert until Back is admitted, not the retained private list.
  await page.locator(heldView).getByText("Loading agent details…", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-nav-tag="list"]').count(), 0);
  // Forward abandons the return before it mounts the list.
  await page.goForward();
  await page.waitForURL(`**/console/agents/${opened.id}**`);
  recheck.release();
  firstRead.release();
  await page.locator(settledView).getByRole("region", SUMMARY).waitFor();

  // The next Back rechecks the retained list and remounts that same node, with no loading
  // state. Before the recheck passes, the cached list is not in the page at all.
  const listRead = await holdRequests(t, page, `**/namespaces/${namespace.id}/agents`, {
    once: true,
  });
  await page.goBack();
  await listRead.requested;
  await page.clock.runFor(300);
  assert.equal(await page.locator(heldView).getByRole("region", SUMMARY).count(), 1);
  assert.equal(await page.locator('[data-nav-tag="list"]').count(), 0);
  assert.equal(await page.getByText("Reading agents.", { exact: true }).count(), 0);
  listRead.release();
  await page.locator(settledView).getByRole("link", { name: "Opened Agent" }).waitFor();
  assert.equal(await viewTag(page), "list", "the retained list was rebuilt instead of remounted");
});

// A slow recheck must not look stuck (finding 1442). Refresh rebuilds the page, so it shows
// loading after the usual delay and returns focus to Refresh. Returns and refocus checks keep the
// page, which they may remount unchanged, and say they are still checking after 1 s.
const slowRecheckCases = [
  {
    name: "Refresh",
    hold: (namespace) => `**/namespaces/${namespace.id}/agents`,
    act: (page) => page.getByRole("button", { name: "Refresh", exact: true }).click(),
    shows: "loading",
    focus: "Refresh",
  },
  {
    name: "Refresh, then moving focus to navigation,",
    hold: (namespace) => `**/namespaces/${namespace.id}/agents`,
    async act(page) {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByRole("link", NAMESPACES).focus();
    },
    shows: "loading",
    // Focus the person moved during the load stays there through both re-renders.
    focus: "nav: namespaces",
  },
  {
    name: "Back to a loaded page",
    async prepare(page) {
      await showNamespaces(page);
    },
    act: (page) => page.goBack(),
    shows: "checking",
  },
  {
    name: "Refocusing a loaded page",
    act: (page) => refocus(page),
    shows: "checking",
  },
  {
    name: "Refocusing Agent detail",
    async prepare(page) {
      await page.getByRole("link", { name: "Slow Agent" }).click();
      await page.locator(settledView).getByRole("region", SUMMARY).waitFor();
    },
    act: (page) => refocus(page),
    shows: "checking",
  },
];

for (const c of slowRecheckCases) {
  test(`${c.name} with a slow read says it is ${c.shows === "loading" ? "loading" : "still checking"}`, async (t) => {
    const { namespace, page } = await openList(t, c.name, ["Slow Agent"]);
    await c.prepare?.(page);
    const read = await holdRequests(t, page, c.hold?.(namespace) ?? SESSION, {
      once: true,
    });
    await c.act(page);
    await read.requested;
    const held = page.locator(heldView);
    const loading = page.getByText("Loading…", { exact: true });
    const checking = page.getByRole("status").filter({ hasText: "Still checking…" });
    const delay = c.shows === "loading" ? 250 : 1000;
    await page.clock.runFor(delay - 1);
    assert.equal(await held.count(), 1);
    assert.equal((await loading.count()) + (await checking.count()), 0);

    await page.clock.runFor(1);
    if (c.shows === "loading") {
      await loading.waitFor();
      assert.equal(await held.count(), 0);
    } else {
      // The page stays held: a recheck that passes remounts it without a loading flash.
      await checking.waitFor();
      assert.equal(await held.count(), 1);
      assert.equal(await loading.count(), 0);
    }
    read.release();
    await page.locator(settledView).waitFor();
    assert.equal(await checking.count(), 0);
    if (c.focus) {
      assert.equal(
        await page.evaluate(() => {
          const focused = globalThis.document.activeElement;
          const nav = focused?.getAttribute("data-nav");
          return nav ? `nav: ${nav}` : focused?.textContent.trim();
        }),
        c.focus,
      );
    }
  });
}

// A held page stayed inert with no busy cue: at 400 ms latency a return sat 1.7-2.2 s with
// clicks doing nothing and nothing saying why (finding 1447). Past 300 ms a navigation's held
// page now dims, with a progress cursor, and nothing moves; a fast hold never shows the cue.
// A refocus recheck keeps the page's look and says Still checking after 1 s instead.
for (const c of [
  {
    name: "A held return",
    cue: true,
    async act(page, t) {
      await showNamespaces(page);
      const read = await holdRequests(t, page, SESSION, { once: true });
      await page.goBack();
      return read;
    },
  },
  {
    name: "A held first visit",
    cue: true,
    async act(page, t) {
      const read = await holdRequests(t, page, "**/namespaces", { once: true });
      await page.getByRole("link", NAMESPACES).click();
      return read;
    },
  },
  {
    name: "A held refocus recheck",
    cue: false,
    async act(page, t) {
      const read = await holdRequests(t, page, SESSION, { once: true });
      await refocus(page);
      return read;
    },
  },
]) {
  test(`${c.name} ${c.cue ? "shows a delayed busy cue" : "keeps its look"} without moving`, async (t) => {
    const { page } = await openList(t, c.name, ["Busy Agent"]);
    const read = await c.act(page, t);
    await read.requested;
    const held = page.locator(heldView);
    await held.waitFor();
    const look = () =>
      held.evaluate((view) => {
        const style = view.ownerDocument.defaultView.getComputedStyle(view);
        const main = view.ownerDocument.defaultView.getComputedStyle(view.parentElement);
        const box = view.getBoundingClientRect();
        return {
          opacity: Number(style.opacity),
          cursor: main.cursor,
          delay: view.getAnimations()[0]?.effect.getTiming().delay ?? null,
          box: [box.x, box.y, box.width, box.height],
        };
      });
    const first = await look();
    // The cue waits 300 ms, so a fast hold never flashes it. CSS animations run on real time,
    // not the paused page clock.
    assert.equal(first.delay, c.cue ? 300 : null);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const later = await look();
    if (c.cue) {
      assert.ok(later.opacity < 0.7, `the held page dims: ${later.opacity}`);
      assert.equal(later.cursor, "progress");
    } else {
      assert.equal(later.opacity, 1);
      assert.equal(later.cursor, "auto");
    }
    assert.deepEqual(later.box, first.box);
    read.release();
    await page.locator(settledView).waitFor();
    assert.deepEqual(
      await page.locator(settledView).evaluate((view) => {
        const window = view.ownerDocument.defaultView;
        return [
          window.getComputedStyle(view).opacity,
          window.getComputedStyle(view.parentElement).cursor,
        ];
      }),
      ["1", "auto"],
    );
  });
}

test("Back after an abandoned Refresh rebuilds the page instead of restoring it", async (t) => {
  const { namespace, page } = await openList(t, "Abandoned Refresh", ["Refreshed Agent"]);
  await tagView(page, "before-refresh");
  const read = await holdRequests(t, page, `**/namespaces/${namespace.id}/agents`, { once: true });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await read.requested;
  // Leave before the Refresh finishes; the page it was replacing must not come back.
  await showNamespaces(page);
  read.release();
  await page.goBack();
  await page.locator(settledView).getByRole("link", { name: "Refreshed Agent" }).waitFor();
  assert.equal(await viewTag(page), null);
});

test("A first visit's read that answers after a second navigation paints nothing", async (t) => {
  const { namespace, agents, page } = await openList(t, "Superseded visit", ["Late Agent"]);
  const agentRead = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/agents/${agents[0].id}`,
    {
      once: true,
    },
  );
  await page.getByRole("link", { name: "Late Agent" }).click();
  await agentRead.requested;
  // A second navigation within the loading delay; its admission read is held.
  await page.clock.runFor(100);
  const admission = await holdRequests(t, page, "**/namespaces", { once: true });
  await page.getByRole("link", NAMESPACES).click();
  await admission.requested;
  agentRead.release();
  await page.clock.runFor(200);
  admission.release();
  await page.locator(settledView).getByRole("list", NAMESPACES).waitFor();
  // The destination acknowledged the click; the superseded read never painted Agent details.
  assert.deepEqual(await shownPages(page), [
    "Agents",
    "Opening Agent",
    "Opening Agent (held)",
    "Namespaces",
  ]);
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.textContent),
    "Namespaces",
  );
});

test("Logout during a first visit's hold leaves nothing private, even after Back", async (t) => {
  const { namespace, agents, page } = await openList(t, "Logout during hold", ["Held Agent"]);
  const agentRead = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/agents/${agents[0].id}`,
    {
      once: true,
    },
  );
  await page.getByRole("link", { name: "Held Agent" }).click();
  await agentRead.requested;
  await page.getByRole("button", { name: /OpenClaw Enterprise/ }).click();
  await page.getByRole("menuitem", { name: "Logout" }).click();
  await page.getByRole("button", { name: "Login" }).waitFor();
  agentRead.release();
  await page.clock.runFor(400);
  assert.equal(await page.locator(".content, nav").count(), 0);
  // Back reloads the list's URL: the session is gone, so sign-in shows again.
  await page.goBack();
  await page.clock.runFor(400);
  await page.getByRole("button", { name: "Login" }).waitFor();
  assert.equal(await page.locator(".content, nav").count(), 0);
  assert.ok(
    !(await shownPages(page)).some((shown) => shown.startsWith("Agent ") || shown === "Agent"),
    "the held Agent page showed after logout",
  );
});

test("A Stop that lands after leaving the Agent closes its dialog, and Back rebuilds the page", async (t) => {
  const { namespace, agents, page } = await openList(t, "Stop after leaving", ["Stopping Agent"], {
    deploy: true,
  });
  await page.getByRole("link", { name: "Stopping Agent" }).click();
  await page.locator(settledView).getByRole("region", SUMMARY).waitFor();
  await tagView(page, "before-stop");
  // The server applies the Stop, but its answer reaches the page only after the user leaves.
  const stop = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/agents/${agents[0].id}/stop`,
    {
      once: true,
      afterServer: true,
    },
  );
  await page.getByRole("button", { name: "Stop Agent", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Stop Stopping Agent?" });
  await dialog.getByRole("button", { name: "Stop Agent" }).click();
  await stop.requested;
  // The dialog is modal, so leave through the navigation link's own handler.
  await page.evaluate(() => globalThis.document.querySelector('a[data-nav="agents"]').click());
  await page.waitForURL(`**/console/agents?namespace=${namespace.id}`);
  stop.release();
  await page.locator(settledView).getByRole("link", { name: "Stopping Agent" }).waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 0);

  // The write invalidated the cached Agent page: Back reads and rebuilds it as stopped.
  await page.goBack();
  await page.locator(settledView).getByRole("region", SUMMARY).waitFor();
  assert.notEqual(await viewTag(page), "before-stop");
  assert.equal(
    await page.getByRole("button", { name: "Stop Agent", exact: true }).first().isDisabled(),
    true,
  );
});

// The case above trusts holdRequests() to send a held write exactly once. A loopback origin
// counts each POST and drops the first answer on /lost.
test("holdRequests sends a held write once, and fails it when its answer is lost", async (t) => {
  const posts = new Map([
    ["/lost", 0],
    ["/after", 0],
    ["/before", 0],
  ]);
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.end("<!doctype html><title>holds</title>");
      return;
    }
    if (!posts.has(request.url)) {
      response.writeHead(404).end();
      return;
    }
    posts.set(request.url, posts.get(request.url) + 1);
    if (request.url === "/lost" && posts.get("/lost") === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(202).end("applied");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixture = await createConsoleAppFixture(t);
  const { page } = await newPage(t, fixture);
  await page.goto(`${origin}/`);
  const post = (path) =>
    page.evaluate(
      (url) =>
        fetch(url, { method: "POST" }).then(
          async (response) => `${response.status} ${await response.text()}`,
          () => "failed",
        ),
      `${origin}${path}`,
    );

  const lost = await holdRequests(t, page, `${origin}/lost`, { afterServer: true });
  const lostAnswer = post("/lost");
  // The hold caught the POST: the waiter gets the lost answer, not the no-request deadline.
  await assert.rejects(lost.requested, (error) => !/was held/.test(error.message));
  assert.equal(await lostAnswer, "failed");
  assert.equal(posts.get("/lost"), 1);

  for (const [path, options] of [
    ["/after", { afterServer: true }],
    ["/before", {}],
  ]) {
    const hold = await holdRequests(t, page, `${origin}${path}`, { once: true, ...options });
    const answer = post(path);
    await hold.requested;
    assert.equal(posts.get(path), options.afterServer ? 1 : 0);
    hold.release();
    assert.equal(await answer, "202 applied");
    assert.equal(posts.get(path), 1);
  }
});

test("Leaving a new Agent page before its reveal does not leave it hidden on return", async (t) => {
  const {
    namespace,
    agents: [agent],
    page,
  } = await openList(t, "Early leave", ["Revealed Agent"], { deploy: true });
  const record = `**/namespaces/${namespace.id}/agents/${agent.id}/deployments/*`;
  // Until the reveal, the detail shows only its toolbar.
  const pendingDetail = page.locator(".agent-detail-pending");
  const shownDetail = page.locator(`${activeView}.agent-detail-pending`);
  // Deployment record reads are held (Deployment activity's and the version panel's, in either
  // order), so the page shows only its toolbar until the bounded reveal.
  const firstRecord = await holdRequests(t, page, record);
  await page.getByRole("link", { name: "Revealed Agent" }).click();
  await shownDetail.waitFor({ state: "attached" });
  await firstRecord.requested;
  // Leave before the reveal and let its timer pass while the page is away.
  await page.clock.runFor(300);
  await page.goBack();
  await page.locator(settledView).getByRole("link", { name: "Revealed Agent" }).waitFor();
  await page.clock.runFor(FIRST_ACTIVITY_WAIT_MS);
  firstRecord.release();

  // Forward rebuilds the page, held again on its record read; it reveals at the bound as on a
  // first visit.
  const returnRecord = await holdRequests(t, page, record);
  await page.goForward();
  await returnRecord.requested;
  await shownDetail.waitFor({ state: "attached" });
  await page.clock.runFor(FIRST_ACTIVITY_WAIT_MS - 1);
  assert.equal(await pendingDetail.count(), 1);
  await page.clock.runFor(1);
  assert.equal(await pendingDetail.count(), 0);
  await page.locator(activeView).getByRole("region", SUMMARY).waitFor();
  returnRecord.release();
  await page.locator(settledView).waitFor();
});

test("A chat link's Agent lookup that answers after a manual navigation is ignored", async (t) => {
  const { namespace, agents, page } = await openList(t, "Chat link race", ["Linked Agent"]);
  const key = "b".repeat(32);
  // The lookup answers as the API would for this Agent, but only after the user navigates.
  const lookup = await holdRequests(t, page, `**/native-admin/return/${key}`, {
    once: true,
    fulfill: {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { namespaceId: namespace.id, agentId: agents[0].id },
        meta: { requestId: "chat-link-race" },
      }),
    },
  });
  // A chat link opened in this tab: the console resolves its key after the session check.
  await openChatLink(page, key);
  await lookup.requested;
  await showNamespaces(page);
  lookup.release();
  await page.clock.runFor(400);
  await page.locator(settledView).getByRole("list", NAMESPACES).waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/namespaces");
  assert.ok(
    !(await shownPages(page)).some((shown) => shown.startsWith("Agent ") || shown === "Agent"),
    "the stale chat-link lookup opened its Agent",
  );
  // The abandoned link no longer blocks refocus checks.
  const session = await holdRequests(t, page, SESSION, { once: true });
  await refocus(page);
  await session.requested;
  session.release();
});

test("A Namespace revoked during a first visit's admission is not repainted by Back", async (t) => {
  const { fixture, namespace, page } = await openList(t, "Revoked during visit", ["Revoked Agent"]);
  await tagView(page, "list");
  revokeNamespace(fixture, namespace, "revoke-during-first-visit");
  // The first visit's admission read drops the Namespace, so its retained list is discarded.
  await page.getByRole("link", NAMESPACES).click();
  await page.locator(settledView).waitFor();
  await page.goBack();
  await page.waitForURL(`**/console/agents?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Namespace unavailable" }).waitFor();
  await page.locator(settledView).waitFor();
  assert.equal(await page.locator('[data-nav-tag="list"]').count(), 0);
  assert.ok(
    // Only the first entry, before the click, may show the list active.
    !(await shownPages(page)).slice(1).includes("Agents"),
    "the revoked Namespace's list was shown again",
  );
});

// Opens the Agent from the list while its first read is held, so the pending panel stays.
async function openPendingAgent(t, page, namespace, agent) {
  const read = await holdRequests(t, page, `**/namespaces/${namespace.id}/agents/${agent.id}`, {
    once: true,
  });
  const link = page.locator(settledView).getByRole("link", { name: agent.name });
  await link.focus();
  await link.press("Enter");
  await read.requested;
  const main = page.getByRole("main");
  await main.getByText("Loading agent details…", { exact: true }).waitFor();
  return { read, main };
}

test("Refocusing the window keeps the pending Agent panel and its way back", async (t) => {
  const { namespace, agent, page } = await openList(t, "Pending refocus", ["Pending Agent"]);
  const { read, main } = await openPendingAgent(t, page, namespace, agent);
  // A refocus check would read the session again; hold it so a swap would stay on screen.
  const session = await holdRequests(t, page, SESSION, { once: true });

  await refocus(page);
  await page.evaluate(() => globalThis.document.dispatchEvent(new Event("visibilitychange")));
  await page.clock.runFor(1500);
  assert.equal(await main.getByText("Loading agent details…", { exact: true }).isVisible(), true);
  assert.equal(await main.getByRole("button", { name: "Back to Agents" }).isVisible(), true);
  assert.equal(await main.getByText("Checking Namespace access.").count(), 0);
  assert.equal(await main.getByText("Reading this Agent.").count(), 0);
  assert.equal(await page.locator(heldView).count(), 0);
  assert.equal(await isFocused(main.getByRole("heading", { name: "Agent details" })), true);

  // The opening load is the access check: it finishes and shows the Agent.
  read.release();
  session.release();
  await page.locator(activeView).getByRole("region", SUMMARY).waitFor();
  await page.getByRole("heading", { name: "Pending Agent" }).waitFor();
  assert.equal(session.wasRequested(), false);

  // Once the opening load has finished, a refocus checks the Agent again as before.
  await page.locator(settledView).getByRole("region", SUMMARY).waitFor();
  const recheck = await holdRequests(t, page, SESSION, { once: true });
  await refocus(page);
  await recheck.requested;
  recheck.release();
});

test("A double press on Back to Agents goes back once and stays in the console", async (t) => {
  const { namespace, agent, page, listUrl } = await openList(t, "Double back", ["Double Agent"]);
  const { read, main } = await openPendingAgent(t, page, namespace, agent);
  const back = main.getByRole("button", { name: "Back to Agents" });
  // Both presses land before the first traversal does, as a fast double click can.
  await back.evaluate((node) => {
    node.click();
    node.click();
  });
  await page.waitForURL(`**${listUrl}`);
  await page.locator(activeView).getByRole("link", { name: "Double Agent" }).waitFor();
  // A second traversal, if queued, lands within a few frames; give it real time to show.
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, listUrl);
  assert.equal(
    await page.locator(activeView).getByRole("link", { name: "Double Agent" }).isVisible(),
    true,
  );
  read.release();
});

test("A chat link that cannot be resolved says so on the Agents list, once", async (t) => {
  const { page } = await openList(t, "Chat link", ["Listed Agent"], { running: true });
  const notice = page.getByText(
    "This Agent chat link could not be opened. It may have expired, or your access may not include its Agent.",
    { exact: true },
  );
  assert.equal(await notice.count(), 0);

  // The key resolves to nothing (404).
  const lookup = page.waitForResponse((response) =>
    response.url().includes(`/native-admin/return/${"c".repeat(32)}`),
  );
  await openChatLink(page, "c".repeat(32));
  assert.equal((await lookup).status(), 404);
  await page.waitForURL(/\/console\/agents/);
  await notice.waitFor();
  assert.equal(await notice.getAttribute("role"), "status");
  await page.locator(settledView).getByRole("link", { name: "Listed Agent" }).waitFor();

  // The notice belongs to that landing only.
  await showNamespaces(page);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.locator(settledView).getByRole("link", { name: "Listed Agent" }).waitFor();
  assert.equal(await notice.count(), 0);

  // A lookup that fails for another reason (here 503) asks to try again instead.
  const key = "d".repeat(32);
  await page.route(`**/native-admin/return/${key}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable." },
        meta: { requestId: "req_test_chat_link" },
      }),
    }),
  );
  await openChatLink(page, key);
  await page.getByText("This Agent chat link could not be opened. Try the link again.").waitFor();
  assert.equal(await notice.count(), 0);
});

const firstContentfulPaint = () =>
  globalThis.performance.getEntriesByName("first-contentful-paint").length > 0;

// On a slow link the console's module graph takes seconds. The shell's static status paints
// before any script runs, so the page is never blank, and it names nothing signed-in. The
// console then takes that status over in place: it never blanks, moves or flashes navigation
// (finding 1444, a regression from removing the static status for chat links).
test("the console shell paints a neutral status before any script runs and keeps it in place", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  const key = "0123456789abcdef0123456789abcdef";
  for (const path of ["/console/agents", "/console/login", `/console/#native-agent=${key}`]) {
    const script = await holdRequests(t, page, "**/console/console.mjs");
    const session = await holdRequests(t, page, SESSION);
    await page.goto(`${fixture.origin}${path}`, { waitUntil: "commit" });
    await script.requested;
    const status = page.locator("#app > p.startup[role='status']");
    // Text paints while the entry script is still held, after the loading delay.
    await page.waitForFunction(firstContentfulPaint, null, { timeout: 5_000 });
    await status.getByText("Loading OpenClaw Enterprise…", { exact: true }).waitFor();
    assert.equal(await page.locator("nav, .content, #namespace-selector").count(), 0, path);
    assert.equal(await page.getByLabel("Username").count(), 0, path);
    const box = await status.boundingBox();
    await status.evaluate((node) => {
      node.dataset.staticShell = "kept";
    });

    // The script runs; the session check is still pending. The same node becomes the session
    // status without moving, and no signed-in chrome or sign-in form is drawn before it settles.
    script.release();
    await session.requested;
    await status.getByText("Checking session…", { exact: true }).waitFor();
    assert.equal(await status.getAttribute("data-static-shell"), "kept", path);
    assert.deepEqual(await status.boundingBox(), box, path);
    assert.equal(await page.locator("nav, .content, #namespace-selector").count(), 0, path);
    assert.equal(await page.getByLabel("Username").count(), 0, path);
    session.release();
    await page.getByLabel("Username").waitFor();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

// The web font is fetched alongside the stylesheet, so it is ready before the console's first
// view renders instead of arriving 1.6-2 s after first paint and reflowing text (finding 1448).
test("the console web font is ready before the entry script runs, fetched once", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  const fonts = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".woff2")) {
      fonts.push(request.url());
    }
  });
  const script = await holdRequests(t, page, "**/console/console.mjs");
  const stylesheet = await holdRequests(t, page, "**/console/console.css");
  const fontLoaded = page.waitForResponse("**/console/fonts/instrument-sans-latin.woff2");
  await page.goto(`${fixture.origin}/console/agents`, { waitUntil: "commit" });
  await script.requested;
  // The font arrives while the stylesheet that declares it is still held.
  await stylesheet.requested;
  assert.equal((await fontLoaded).status(), 200);
  stylesheet.release();
  await page.waitForFunction(
    () =>
      globalThis.document.fonts.check('14px "Instrument Sans"') &&
      [...globalThis.document.fonts].some(
        (face) => face.family.replaceAll('"', "") === "Instrument Sans" && face.status === "loaded",
      ),
    null,
    { timeout: 5_000 },
  );
  script.release();
  await page.getByLabel("Username").waitFor();
  assert.deepEqual(fonts, [`${fixture.origin}/console/fonts/instrument-sans-latin.woff2`]);
});
