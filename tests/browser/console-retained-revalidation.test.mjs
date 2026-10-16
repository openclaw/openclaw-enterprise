import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { detailUrl, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";

// Hold matching reads until release(); requested resolves when the first arrives. With once,
// only the first match is held. With afterServer, the server answers first and the response
// reaches the page on release (a write that landed while the page waits). With fulfill, the
// held request is answered with that response instead.
async function holdRead(
  t,
  page,
  path = "**/api/auth/session",
  { once = false, afterServer = false, fulfill = null } = {},
) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requestedResolve;
  let timer;
  // Fails instead of hanging the run when the page never starts the read.
  const requested = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`No ${path} read was requested`)), 10_000);
    requestedResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  requested.catch(() => {});
  await page.route(
    path,
    async (route) => {
      const response = afterServer ? await route.fetch().catch(() => null) : null;
      requestedResolve();
      await held;
      await (response || fulfill ? route.fulfill(fulfill ?? { response }) : route.continue()).catch(
        () => {},
      );
    },
    once ? { times: 1 } : undefined,
  );
  t.after(() => {
    clearTimeout(timer);
    release();
  });
  return { requested, release };
}

const activeView = '.content [aria-live="polite"]:not([inert])';

test("Refocusing a loaded page keeps it steady while access is rechecked", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady return", { ready: true });
  await fixture.createAgent(namespace.id, "Steady Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Steady Agent" }).waitFor();
  await page.locator(activeView).waitFor();
  const selector = page.locator("#namespace-selector");
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  const create = page.getByRole("button", { name: "Create Agent" });
  const lookOf = (node) => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return { opacity: style.opacity, color: style.color, background: style.backgroundColor };
  };
  const createLook = await create.evaluate(lookOf);

  const session = await holdRead(t, page);
  // Refocusing the window rechecks the session and Namespace access before the page is reused.
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await session.requested;
  await page.locator('.content [aria-live="polite"][inert]').waitFor();
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
  const heldView = page.locator('.content [aria-live="polite"][inert]');

  const session = await holdRead(t, page);
  const collection = await holdRead(t, page, `**/namespaces/${first.id}/agents`);
  await page.goBack();
  await session.requested;
  await heldView.waitFor();
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
  await heldView.getByText(secondRow, { exact: true }).waitFor();
  assert.equal(await scope.textContent(), "Namespace · Second scope");
  assert.equal(await heldView.getByText(firstRow, { exact: true }).count(), 0);

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
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.waitFor();
  await page.locator(activeView).waitFor();
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("link", { name: "Revoked Agent" }).waitFor();
  await page.locator(activeView).waitFor();

  fixture.policy.restrictions.push({
    id: "revoke-retained-agent-namespace",
    namespaceId: namespace.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
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
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Interrupted check", { ready: true });
  await fixture.createAgent(namespace.id, "Interrupted Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(activeView).getByRole("link", { name: "Interrupted Agent" }).waitFor();
  await page.getByRole("link", { name: "Interrupted Agent" }).click();
  await page.getByRole("region", { name: "Agent state at a glance" }).waitFor();
  // Only a finished detail rechecks in place on refocus.
  await page.locator('.content [aria-live="polite"][aria-busy="false"]:not([inert])').waitFor();

  const session = await holdRead(t, page);
  // Refocusing Agent detail rechecks access in place; Back cuts that check short.
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await session.requested;
  await page.goBack();
  await page.waitForURL(`**/console/agents?namespace=${namespace.id}`);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
      }),
  );
  assert.equal(await page.locator('.content [aria-live="polite"][inert]').count(), 1);
  assert.equal(await page.locator(activeView).count(), 0);

  session.release();
  await page.locator(activeView).getByRole("link", { name: "Interrupted Agent" }).waitFor();
});

// Names the page in the content view after every DOM change, marking a held (inert) page.
function recordShownPages() {
  const seen = [];
  globalThis.__shownPages = seen;
  const record = () => {
    const view = globalThis.document.querySelector('.content [aria-live="polite"]');
    const startup = globalThis.document.querySelector("#app > .startup");
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

const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

test("A first visit keeps the shown page until its first read settles, then swaps once", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Single swap", { ready: true });
  await fixture.createAgent(namespace.id, "Swap Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await page.clock.install();
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).getByRole("link", { name: "Swap Agent" }).waitFor();
  await pauseClock(page);
  await page.evaluate(recordShownPages);

  // The list stays, inert, through admission and the Agent read; no loading state shows.
  await page.getByRole("link", { name: "Swap Agent" }).click();
  await page.locator(activeView).getByRole("region", { name: "Agent state at a glance" }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.__shownPages.splice(0)), [
    "Agents",
    "Agents (held)",
    "Agent",
  ]);

  await page.locator(settledView).waitFor();
  await page.evaluate(() => globalThis.__shownPages.splice(0, Infinity, "Agent"));
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.locator(activeView).getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.__shownPages), [
    "Agent",
    "Agent (held)",
    "Namespaces",
  ]);
});

test("A first visit that outlasts the loading delay shows loading only after it", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slow first visit", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Slow Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await page.clock.install();
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).getByRole("link", { name: "Slow Agent" }).waitFor();
  await pauseClock(page);

  const read = await holdRead(t, page, `**/namespaces/${namespace.id}/agents/${agent.id}`);
  await page.getByRole("link", { name: "Slow Agent" }).click();
  await read.requested;
  const held = page.locator('.content [aria-live="polite"][inert]');
  const loading = page.getByText("Reading this Agent.", { exact: true });
  await held.getByRole("link", { name: "Slow Agent" }).waitFor();
  await page.clock.runFor(249);
  assert.equal(await held.count(), 1);
  assert.equal(await loading.count(), 0);

  // Past the delay, loading replaces the held page until the read settles.
  await page.clock.runFor(1);
  await loading.waitFor();
  assert.equal(await held.count(), 0);
  read.release();
  await page.locator(activeView).getByRole("region", { name: "Agent state at a glance" }).waitFor();
  assert.equal(await loading.count(), 0);
});

test("A full load whose session check outlasts the loading delay shows no navigation before it", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slow session", { ready: true });
  await fixture.createAgent(namespace.id, "Session Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await page.clock.install();
  const url = `/console/agents?namespace=${namespace.id}`;
  await login(page, fixture, url);
  await page.locator(settledView).getByRole("link", { name: "Session Agent" }).waitFor();
  await pauseClock(page);
  const session = await holdRead(t, page);

  await page.reload();
  await session.requested;
  await page.clock.runFor(400);
  await page.locator("#app > .startup", { hasText: "Checking session…" }).waitFor();
  assert.equal(await page.locator(".content, nav").count(), 0);
  session.release();
  await page.locator(settledView).getByRole("link", { name: "Session Agent" }).waitFor();
});

test("A full load replaces the startup status once when its reads settle in time", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Single load", { ready: true });
  await fixture.createAgent(namespace.id, "Loaded Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await page.clock.install();
  const url = `/console/agents?namespace=${namespace.id}`;
  await login(page, fixture, url);
  await page.locator(settledView).getByRole("link", { name: "Loaded Agent" }).waitFor();
  await pauseClock(page);
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

const heldView = '.content [aria-live="polite"][inert]';

// Signs in to a loaded Agents list, pauses the page clock and records every page shown.
async function openPausedList(t, name, agentNames, { deploy = false } = {}) {
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
  await page.clock.install();
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).getByRole("link", { name: agentNames[0] }).waitFor();
  // The list reads each row's latest deployment after it settles; let those finish, so the
  // list is reusable and no test's held read catches one of them.
  await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
  await pauseClock(page);
  await page.evaluate(recordShownPages);
  return { fixture, namespace, agents, page };
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

test("Forward during a return's recheck keeps the returning page for the next Back", async (t) => {
  const { namespace, agents, page } = await openPausedList(t, "Forward during return", [
    "Listed Agent",
    "Opened Agent",
  ]);
  const opened = agents[1];
  await tagView(page, "list");
  // The opened Agent's first read is held, so the list stays shown, inert.
  const firstRead = await holdRead(t, page, `**/namespaces/${namespace.id}/agents/${opened.id}`, {
    once: true,
  });
  await page.getByRole("link", { name: "Opened Agent" }).click();
  await firstRead.requested;
  // Back returns to the list; its recheck waits on the session read.
  const recheck = await holdRead(t, page, "**/api/auth/session", { once: true });
  await page.goBack();
  await page.waitForURL(`**/console/agents?namespace=${namespace.id}`);
  await recheck.requested;
  assert.equal(await page.locator(`${heldView}[data-nav-tag="list"]`).count(), 1);
  // Forward abandons the return before it mounts the list.
  await page.goForward();
  await page.waitForURL(`**/console/agents/${opened.id}**`);
  recheck.release();
  firstRead.release();
  await page
    .locator(settledView)
    .getByRole("region", { name: "Agent state at a glance" })
    .waitFor();

  // The next Back rechecks the retained list and remounts that same node, with no loading
  // state. Before the recheck passes, the cached list is not in the page at all.
  const listRead = await holdRead(t, page, `**/namespaces/${namespace.id}/agents`, { once: true });
  await page.goBack();
  await listRead.requested;
  await page.clock.runFor(300);
  assert.equal(
    await page.locator(heldView).getByRole("region", { name: "Agent state at a glance" }).count(),
    1,
  );
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
      await page.getByRole("link", { name: "Namespaces", exact: true }).focus();
    },
    shows: "loading",
    // Focus the person moved during the load stays there through both re-renders.
    focus: "nav: namespaces",
  },
  {
    name: "Back to a loaded page",
    async prepare(page) {
      await page.getByRole("link", { name: "Namespaces", exact: true }).click();
      await page
        .locator(settledView)
        .getByRole("list", { name: "Namespaces", exact: true })
        .waitFor();
    },
    act: (page) => page.goBack(),
    shows: "checking",
  },
  {
    name: "Refocusing a loaded page",
    act: (page) => page.evaluate(() => globalThis.dispatchEvent(new Event("focus"))),
    shows: "checking",
  },
  {
    name: "Refocusing Agent detail",
    async prepare(page) {
      await page.getByRole("link", { name: "Slow Agent" }).click();
      await page
        .locator(settledView)
        .getByRole("region", { name: "Agent state at a glance" })
        .waitFor();
    },
    act: (page) => page.evaluate(() => globalThis.dispatchEvent(new Event("focus"))),
    shows: "checking",
  },
];

for (const c of slowRecheckCases) {
  test(`${c.name} with a slow read says it is ${c.shows === "loading" ? "loading" : "still checking"}`, async (t) => {
    const { namespace, page } = await openPausedList(t, c.name, ["Slow Agent"]);
    await c.prepare?.(page);
    const read = await holdRead(t, page, c.hold?.(namespace) ?? "**/api/auth/session", {
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
// clicks doing nothing and nothing saying why (finding 1447). Past 300 ms it now dims, with a
// progress cursor, and nothing moves; a fast hold never shows the cue.
for (const c of [
  {
    name: "A held return",
    async act(page, t) {
      await page.getByRole("link", { name: "Namespaces", exact: true }).click();
      await page
        .locator(settledView)
        .getByRole("list", { name: "Namespaces", exact: true })
        .waitFor();
      const read = await holdRead(t, page, "**/api/auth/session", { once: true });
      await page.goBack();
      return read;
    },
  },
  {
    name: "A held first visit",
    async act(page, t, namespace, agents) {
      const read = await holdRead(t, page, `**/namespaces/${namespace.id}/agents/${agents[0].id}`, {
        once: true,
      });
      await page.getByRole("link", { name: "Busy Agent" }).click();
      return read;
    },
  },
]) {
  test(`${c.name} shows a delayed busy cue without moving`, async (t) => {
    const { namespace, agents, page } = await openPausedList(t, c.name, ["Busy Agent"]);
    const read = await c.act(page, t, namespace, agents);
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
    assert.equal(first.delay, 300);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const busy = await look();
    assert.ok(busy.opacity < 0.7, `the held page dims: ${busy.opacity}`);
    assert.equal(busy.cursor, "progress");
    assert.deepEqual(busy.box, first.box);
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
  const { namespace, page } = await openPausedList(t, "Abandoned Refresh", ["Refreshed Agent"]);
  await tagView(page, "before-refresh");
  const read = await holdRead(t, page, `**/namespaces/${namespace.id}/agents`, { once: true });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await read.requested;
  // Leave before the Refresh finishes; the page it was replacing must not come back.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.locator(settledView).getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  read.release();
  await page.goBack();
  await page.locator(settledView).getByRole("link", { name: "Refreshed Agent" }).waitFor();
  assert.equal(await viewTag(page), null);
});

test("A first visit's read that answers after a second navigation paints nothing", async (t) => {
  const { namespace, agents, page } = await openPausedList(t, "Superseded visit", ["Late Agent"]);
  const agentRead = await holdRead(
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
  const admission = await holdRead(t, page, "**/namespaces", { once: true });
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await admission.requested;
  agentRead.release();
  await page.clock.runFor(200);
  admission.release();
  await page.locator(settledView).getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  // The list stayed held until Namespaces replaced it; neither the Agent nor loading showed.
  assert.deepEqual(await shownPages(page), ["Agents", "Agents (held)", "Namespaces"]);
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.textContent),
    "Namespaces",
  );
});

test("Logout during a first visit's hold leaves nothing private, even after Back", async (t) => {
  const { namespace, agents, page } = await openPausedList(t, "Logout during hold", ["Held Agent"]);
  const agentRead = await holdRead(
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
  const { namespace, agents, page } = await openPausedList(
    t,
    "Stop after leaving",
    ["Stopping Agent"],
    {
      deploy: true,
    },
  );
  await page.getByRole("link", { name: "Stopping Agent" }).click();
  await page
    .locator(settledView)
    .getByRole("region", { name: "Agent state at a glance" })
    .waitFor();
  await tagView(page, "before-stop");
  // The server applies the Stop, but its answer reaches the page only after the user leaves.
  const stop = await holdRead(
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
  await page
    .locator(settledView)
    .getByRole("region", { name: "Agent state at a glance" })
    .waitFor();
  assert.notEqual(await viewTag(page), "before-stop");
  assert.equal(
    await page.getByRole("button", { name: "Stop Agent", exact: true }).first().isDisabled(),
    true,
  );
});

test("Leaving a new Agent page before its reveal does not leave it hidden on return", async (t) => {
  const {
    namespace,
    agents: [agent],
    page,
  } = await openPausedList(t, "Early leave", ["Revealed Agent"], { deploy: true });
  const record = `**/namespaces/${namespace.id}/agents/${agent.id}/deployments/*`;
  // Until the reveal, the detail shows only its toolbar.
  const pendingDetail = page.locator(".agent-detail-pending");
  const shownDetail = page.locator(`${activeView}.agent-detail-pending`);
  // Deployment record reads are held (Deployment activity's and the version panel's, in either
  // order), so the page shows only its toolbar until the 1 s reveal.
  const firstRecord = await holdRead(t, page, record);
  await page.getByRole("link", { name: "Revealed Agent" }).click();
  await shownDetail.waitFor({ state: "attached" });
  await firstRecord.requested;
  // Leave before the 1 s reveal and let its timer pass while the page is away.
  await page.clock.runFor(300);
  await page.goBack();
  await page.locator(settledView).getByRole("link", { name: "Revealed Agent" }).waitFor();
  await page.clock.runFor(800);
  firstRecord.release();

  // Forward rebuilds the page, held again on its record read; it reveals at 1 s as on a first visit.
  const returnRecord = await holdRead(t, page, record);
  await page.goForward();
  await returnRecord.requested;
  await shownDetail.waitFor({ state: "attached" });
  await page.clock.runFor(999);
  assert.equal(await pendingDetail.count(), 1);
  await page.clock.runFor(1);
  assert.equal(await pendingDetail.count(), 0);
  await page.locator(activeView).getByRole("region", { name: "Agent state at a glance" }).waitFor();
  returnRecord.release();
  await page.locator(settledView).waitFor();
});

test("A chat link's Agent lookup that answers after a manual navigation is ignored", async (t) => {
  const { namespace, agents, page } = await openPausedList(t, "Chat link race", ["Linked Agent"]);
  const key = "b".repeat(32);
  // The lookup answers as the API would for this Agent, but only after the user navigates.
  const lookup = await holdRead(t, page, `**/native-admin/return/${key}`, {
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
  await page.evaluate((value) => {
    globalThis.history.pushState(null, "", `/console#native-agent=${value}`);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, key);
  await lookup.requested;
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.locator(settledView).getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  lookup.release();
  await page.clock.runFor(400);
  await page.locator(settledView).getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/namespaces");
  assert.ok(
    !(await shownPages(page)).some((shown) => shown.startsWith("Agent ") || shown === "Agent"),
    "the stale chat-link lookup opened its Agent",
  );
  // The abandoned link no longer blocks refocus checks.
  const session = await holdRead(t, page, "**/api/auth/session", { once: true });
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await session.requested;
  session.release();
});

test("A Namespace revoked during a first visit's admission is not repainted by Back", async (t) => {
  const { fixture, namespace, page } = await openPausedList(t, "Revoked during visit", [
    "Revoked Agent",
  ]);
  await tagView(page, "list");
  fixture.policy.restrictions.push({
    id: "revoke-during-first-visit",
    namespaceId: namespace.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  // The first visit's admission read drops the Namespace, so its retained list is discarded.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
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
