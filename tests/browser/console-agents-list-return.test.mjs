import assert from "node:assert/strict";
import test from "node:test";

import {
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  nativeValues,
  newPage,
  persistedDeploymentError,
  trackSettledFetches,
  waitForCondition,
  waitForIdleFetches,
} from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

// Returning to the Agents list held the Agent page, inert, until the retained list had read
// every row's /revisions and /deployments again: two reads per Agent, so the hold grew with the
// Namespace (283-517 ms for 12 Agents on oce-dogfood-b, finding 1644). The list now reveals once
// its own reads revalidate, and the rows read their deployments again in place.
const AGENTS = 12;
const READING = "Reading deployment…";
const activeView = '.content [aria-live="polite"]:not([inert])';
const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';
const revisionsRead = (namespace) => `**/namespaces/${namespace.id}/agents/*/revisions`;
const deploymentsRead = (namespace) => `**/namespaces/${namespace.id}/agents/*/deployments/*`;

// A deployment record read; the list shows its status and, for a failure, its error.
function deploymentRecord(namespace, status) {
  return {
    json: {
      data: {
        namespaceId: namespace.id,
        status,
        error: status === "failed" ? persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED") : null,
        warnings: [],
        progress: null,
      },
      meta: { requestId: "req_test_list_return" },
    },
  };
}

// `newer` names the Agents (by index) with a second version deployed after the active one, so their
// Latest deployment link differs from their Current version link.
async function openTeamList(t, name, { newer = [] } = {}) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const agents = [];
  for (let index = 1; index <= AGENTS; index += 1) {
    const label = `Team Agent ${String(index).padStart(2, "0")}`;
    const agent = await fixture.createAgent(namespace.id, label, nativeValues(label));
    let { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    if (newer.includes(index - 1)) {
      revision = await fixture.deployAgent(namespace.id, agent.id);
    }
    agents.push({ ...agent, name: label, revisionId: revision.id });
  }
  const { page } = await newPage(t, fixture, { browser });
  // The fixture runs no worker, so each deployment record is served as it would read once its
  // deployment succeeded.
  await page.route(deploymentsRead(namespace), (route) =>
    route.fulfill(deploymentRecord(namespace, "succeeded")),
  );
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).getByRole("link", { name: agents[0].name }).waitFor();
  // Every row's deployment has landed, so the list is reusable when the reader leaves.
  await page.getByText(READING).first().waitFor({ state: "detached" });
  return { fixture, namespace, agents, page };
}

// The text of each row's Latest deployment cell, by Agent name.
const deploymentCells = (page) =>
  page
    .locator(activeView)
    .evaluate((view) =>
      Object.fromEntries(
        [...view.querySelectorAll(".agent-table tbody tr")].map((row) => [
          row.querySelector("td a").textContent,
          row.querySelector(".agent-deployment").textContent,
        ]),
      ),
    );

// Records, after every DOM change, how many rows of the active (revealed) view show a deployment
// other than "Reading deployment…", and every Agent it shows, so a stale value painted for even
// one frame before a row's fresh read is caught.
function recordRevealed(reading) {
  const document = globalThis.document;
  const seen = { deployments: 0, agents: new Set() };
  globalThis.__revealed = seen;
  const record = () => {
    const view = document.querySelector('.content [aria-live="polite"]:not([inert])');
    const table = view?.querySelector(".agent-table");
    if (!table) {
      return;
    }
    seen.deployments = Math.max(
      seen.deployments,
      [...table.querySelectorAll(".agent-deployment")].filter(
        (cell) => cell.textContent !== reading,
      ).length,
    );
    for (const link of table.querySelectorAll("tbody tr td:first-child a")) {
      seen.agents.add(link.textContent);
    }
  };
  globalThis.__revealedObserver?.disconnect();
  globalThis.__revealedObserver = new globalThis.MutationObserver(record);
  globalThis.__revealedObserver.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
}
const startRecording = (page) => page.evaluate(recordRevealed, READING);
const revealed = (page) =>
  page.evaluate(() => ({
    deployments: globalThis.__revealed.deployments,
    agents: [...globalThis.__revealed.agents].sort(),
  }));

function tagView(page) {
  return page.evaluate(() => {
    globalThis.document.querySelector('.content [aria-live="polite"]').dataset.listTag = "kept";
  });
}
const viewTag = (page) =>
  page.evaluate(
    () =>
      globalThis.document.querySelector('.content [aria-live="polite"]')?.dataset.listTag ?? null,
  );

async function openAgent(page, agent) {
  await page.locator(settledView).getByRole("link", { name: agent.name, exact: true }).click();
  await page
    .locator(settledView)
    .getByRole("region", { name: "Agent state at a glance" })
    .waitFor();
}

async function goBackToList(page, how) {
  if (how === "Browser Back") {
    await page.goBack();
  } else {
    await page.getByRole("link", { name: "Agents", exact: true }).click();
  }
}

// Holds every row's deployment reads; only the Agents list's own reads may decide the reveal.
async function holdRowReads(t, page, namespace) {
  const revisions = await holdRequests(t, page, revisionsRead(namespace));
  const deployments = await holdRequests(t, page, deploymentsRead(namespace), {
    fulfill: deploymentRecord(namespace, "succeeded"),
  });
  return {
    revisions,
    release() {
      revisions.release();
      deployments.release();
    },
  };
}

for (const how of ["Browser Back", "Agents navigation"]) {
  test(`${how} to a list of ${AGENTS} Agents reveals without waiting on row reads, then fills each row`, async (t) => {
    const { namespace, agents, page } = await openTeamList(t, `Team return ${how}`);
    const before = await deploymentCells(page);
    assert.equal(Object.keys(before).length, AGENTS);
    for (const text of Object.values(before)) {
      assert.match(text, /^v1 · /);
    }
    await tagView(page);
    const [opened, changed] = agents;
    await openAgent(page, opened);

    // Every row read is held, and one Agent's deployment failed while the reader was away.
    const rows = await holdRowReads(t, page, namespace);
    const failed = await holdRequests(
      t,
      page,
      `**/namespaces/${namespace.id}/agents/${changed.id}/deployments/${changed.revisionId}`,
      { fulfill: deploymentRecord(namespace, "failed") },
    );
    await startRecording(page);
    await goBackToList(page, how);

    // The retained list is back and usable while every row read is still outstanding.
    await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
    await rows.revisions.requested;
    assert.equal(await viewTag(page), "kept", "the retained list was reused, not rebuilt");
    assert.equal(
      await page.locator(activeView).getByRole("link", { name: opened.name, exact: true }).count(),
      1,
    );
    // No row presents the deployment it showed before leaving as current.
    assert.deepEqual(
      await deploymentCells(page),
      Object.fromEntries(Object.keys(before).map((name) => [name, READING])),
    );
    assert.equal((await revealed(page)).deployments, 0, "no stale deployment was revealed");

    // The rows fill in place from their fresh reads.
    rows.release();
    failed.release();
    await page.getByText(READING).first().waitFor({ state: "detached" });
    const after = await deploymentCells(page);
    assert.match(after[changed.name], /^v1 · Failed/);
    assert.deepEqual(
      Object.fromEntries(Object.entries(after).filter(([name]) => name !== changed.name)),
      Object.fromEntries(Object.entries(before).filter(([name]) => name !== changed.name)),
    );
    assert.equal(await viewTag(page), "kept");
  });
}

test("A return whose list read dropped an Agent never reveals that Agent, with row reads held", async (t) => {
  const { namespace, agents, page } = await openTeamList(t, "Team return removed");
  await tagView(page);
  const [opened, removed] = agents;
  await openAgent(page, opened);

  const rows = await holdRowReads(t, page, namespace);
  // The Agent was deleted while the reader was away: the fresh list read no longer has it.
  await page.route(`**/namespaces/${namespace.id}/agents`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, data: body.data.filter((item) => item.id !== removed.id) },
    });
  });
  await startRecording(page);
  await page.goBack();

  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  await rows.revisions.requested;
  assert.equal(await viewTag(page), null, "the list was rebuilt from the fresh read");
  assert.equal(await page.getByRole("link", { name: removed.name, exact: true }).count(), 0);
  const shown = await revealed(page);
  assert.equal(shown.agents.includes(removed.name), false, "the removed Agent was never revealed");
  assert.equal(shown.agents.length, AGENTS - 1);
  rows.release();
  await page.getByText(READING).first().waitFor({ state: "detached" });
});

test("A return rereads only the rows the search shows", async (t) => {
  const { namespace, agents, page } = await openTeamList(t, "Team return search");
  const [, , target] = agents;
  await page.getByRole("searchbox", { name: "Search Agents" }).fill(target.name);
  await page.locator(settledView).getByRole("row").nth(1).waitFor();
  assert.equal(await page.locator(activeView).locator(".agent-table tbody tr").count(), 1);
  await page.getByText(READING).first().waitFor({ state: "detached" });
  await tagView(page);
  await openAgent(page, target);

  const revisions = [];
  page.on("request", (request) => {
    if (/\/agents\/[^/]+\/revisions(\?|$)/.test(new URL(request.url()).pathname)) {
      revisions.push(new URL(request.url()).pathname);
    }
  });
  await goBackToList(page, "Browser Back");
  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  assert.equal(await viewTag(page), "kept");
  await page.getByText(READING).first().waitFor({ state: "detached" });
  // The Agent page may still read its own history as it closes; no other row is read.
  assert.deepEqual(
    [...new Set(revisions)],
    [`/namespaces/${namespace.id}/agents/${target.id}/revisions`],
  );
});

// Back from a deployment link restores focus in that cell, not a link to the old revision.
// Enter does nothing until the reread supplies a link; a refusal returns focus to the Agent.
for (const outcome of ["fills", "is refused"]) {
  test(`Back from a row's deployment link keeps focus on that row while its reread ${outcome}`, async (t) => {
    const { namespace, agents, page } = await openTeamList(t, `Team return focus ${outcome}`, {
      newer: [1],
    });
    const [, target] = agents;
    await tagView(page);
    const row = page.locator(activeView).getByRole("row").filter({ hasText: target.name });
    const deploymentLink = row.locator(".agent-deployment a");
    await deploymentLink.focus();
    await deploymentLink.press("Enter");
    await page.waitForURL(`**/console/agents/${target.id}?**revision=${target.revisionId}**`);
    await page
      .locator(settledView)
      .getByRole("region", { name: "Agent state at a glance" })
      .waitFor();

    const rows = await holdRowReads(t, page, namespace);
    const refused = outcome === "is refused";
    const own = await holdRequests(
      t,
      page,
      `**/namespaces/${namespace.id}/agents/${target.id}/deployments/${target.revisionId}`,
      {
        fulfill: refused
          ? {
              status: 403,
              json: {
                error: { code: "PERMISSION_DENIED", message: "Access denied." },
                meta: { requestId: "req_test_list_return" },
              },
            }
          : deploymentRecord(namespace, "succeeded"),
      },
    );
    await page.goBack();
    await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
    await rows.revisions.requested;
    assert.equal(await viewTag(page), "kept");
    // The pending cell's text is blank for its first 250 ms (finding 1656); its holder has focus.
    const loading = row.locator(".agent-deployment [data-return-focus-href]");
    assert.equal(await loading.textContent(), READING);
    assert.equal(await hasFocus(loading), true, "Back focused the pending deployment");
    // Blank on screen, the focused holder's text still reaches a screen reader.
    assert.match(await loading.ariaSnapshot(), /Reading deployment…/);
    const listUrl = page.url();
    await page.keyboard.press("Enter");
    assert.equal(page.url(), listUrl, "Enter must not open the previous deployment");
    assert.equal(await deploymentLink.count(), 0, "the old deployment is not a link");

    rows.release();
    own.release();
    await page.getByText(READING).first().waitFor({ state: "detached" });
    if (refused) {
      assert.equal(
        await row.locator(".agent-deployment").textContent(),
        "Deployment access denied",
      );
      assert.equal(
        await hasFocus(row.getByRole("link", { name: target.name, exact: true })),
        true,
        "focus moved to the row's Agent link",
      );
    } else {
      assert.match(await deploymentLink.textContent(), /^v2 · Completed/);
      assert.equal(await hasFocus(deploymentLink), true, "the fresh link kept focus");
    }
    assert.equal(await viewTag(page), "kept");
  });
}

// Sample the first frame, then seek the actual CSS animations. A busy browser may deliver
// its first animation frame late; elapsed time between two callbacks is not the loading delay.
function measureReadingDelay(reading) {
  const sample = () => {
    const table = globalThis.document.querySelector(
      '.content [aria-live="polite"]:not([inert]) .agent-table',
    );
    const labels = [...(table?.querySelectorAll(".agent-deployment span") ?? [])].filter(
      (node) => node.textContent === reading && node.childElementCount === 0,
    );
    if (!labels.length) {
      globalThis.requestAnimationFrame(sample);
      return;
    }
    const visible = () =>
      labels.filter((node) => {
        const { visibility, opacity } = globalThis.getComputedStyle(node);
        return visibility === "visible" && opacity !== "0";
      }).length;
    const firstFrame = visible();
    const animations = labels.flatMap((label) => label.getAnimations());
    const visibleAt = (ms) => {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = ms;
      }
      return visible();
    };
    globalThis.__readingVisibility = {
      labels: labels.length,
      firstFrame,
      at249: visibleAt(249),
      at250: visibleAt(250),
    };
  };
  globalThis.requestAnimationFrame(sample);
}

// After #2717 a return to a retained list painted "Reading deployment…" in every row for a frame
// or more (60-142 ms) before the rereads filled them (finding 1656). The text now follows the
// 250 ms rule: blank at first, shown only if the read is still pending, and the old value is
// never shown either way. A first visit's rows follow the same rule.
for (const visit of ["a first visit", "a return"]) {
  test(`Rows read on ${visit} paint no "Reading deployment…" until the read is slow`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, `Quiet rows ${visit}`);
    const agents = [];
    for (const label of ["Quiet Agent 1", "Quiet Agent 2", "Quiet Agent 3"]) {
      const agent = await fixture.createAgent(namespace.id, label, nativeValues(label));
      await fixture.seedActiveAgentRevision(namespace.id, agent.id);
      agents.push({ ...agent, name: label });
    }
    const { page } = await newPage(t, fixture, { browser });
    await page.route(deploymentsRead(namespace), (route) =>
      route.fulfill(deploymentRecord(namespace, "succeeded")),
    );
    const first = visit === "a first visit";
    if (!first) {
      // A row whose read failed has no link to keep: its reread on return is delayed too.
      await page.route(
        `**/namespaces/${namespace.id}/agents/${agents[2].id}/deployments/*`,
        (route) =>
          route.fulfill({
            status: 500,
            json: { error: { code: "INTERNAL", message: "Unavailable." } },
          }),
        { times: 1 },
      );
    }
    let rows = first ? await holdRowReads(t, page, namespace) : null;
    if (first) {
      await page.addInitScript(`(${measureReadingDelay})(${JSON.stringify(READING)})`);
    }
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
    if (!first) {
      await page.getByText(READING).first().waitFor({ state: "detached" });
      await page.getByText("Deployment unavailable").waitFor();
      await tagView(page);
      await openAgent(page, agents[0]);
      rows = await holdRowReads(t, page, namespace);
      await page.evaluate(measureReadingDelay, READING);
      await page.goBack();
      await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
      assert.equal(await viewTag(page), "kept", "the retained list was reused");
    }
    await rows.revisions.requested;
    const observation = await page.waitForFunction(() => globalThis.__readingVisibility);
    assert.deepEqual(await observation.jsonValue(), {
      labels: 3,
      firstFrame: 0,
      at249: 0,
      at250: 3,
    });
    rows.release();
    await page.getByText(READING).first().waitFor({ state: "detached" });
    for (const text of Object.values(await deploymentCells(page))) {
      assert.match(text, /^v1 · Completed/);
    }
  });
}

// Opens a list of three Agents, leaves it for an Agent, and goes Back with every row's reread
// held, the page clock paused and the rows' 250 ms delay animations paused, so the test decides
// when the rereads land and when "Reading deployment…" shows.
async function returnWithHeldRows(t, name) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const agents = [];
  for (const label of ["Steady Agent 1", "Steady Agent 2", "Steady Agent 3"]) {
    const agent = await fixture.createAgent(namespace.id, label, nativeValues(label));
    await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    agents.push({ ...agent, name: label });
  }
  const { page } = await newPage(t, fixture, { browser });
  await page.route(deploymentsRead(namespace), (route) =>
    route.fulfill(deploymentRecord(namespace, "succeeded")),
  );
  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  await page.getByText(READING).first().waitFor({ state: "detached" });
  await tagView(page);
  await openAgent(page, agents[0]);
  const rows = await holdRowReads(t, page, namespace);
  let landed = 0;
  page.on("response", (response) => {
    if (/\/agents\/[^/]+\/deployments\/[^/]+$/u.test(new URL(response.url()).pathname)) {
      landed += 1;
    }
  });
  // The page clock does not drive CSS animations: hold the delay until the test ends it. The
  // console's CSP refuses an inline style, not a constructed sheet.
  await page.evaluate(() => {
    const sheet = new globalThis.CSSStyleSheet();
    sheet.replaceSync(
      ".agent-deployment :is(.delayed-status, .delayed-text) { animation-play-state: paused; }",
    );
    globalThis.document.adoptedStyleSheets = [...globalThis.document.adoptedStyleSheets, sheet];
  });
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1_000);
  await page.goBack();
  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  assert.equal(await viewTag(page), "kept", "the retained list was reused");
  await rows.revisions.requested;
  const readingCells = async () =>
    Object.values(await deploymentCells(page)).filter((text) => text === READING).length;
  assert.equal(await readingCells(), agents.length);
  return {
    namespace,
    page,
    readingCells,
    // Ends every row's delay animation `ms` after the last step, so "Reading deployment…" shows,
    // and waits until the page has handled the animations' end.
    async reveal(ms) {
      await page.clock.runFor(ms);
      const ended = await page.evaluate(() => {
        const document = globalThis.document;
        globalThis.__readingShown = 0;
        document.addEventListener("animationend", (event) => {
          if (event.target.closest(".agent-deployment")) {
            globalThis.__readingShown += 1;
          }
        });
        const animations = [
          ...document.querySelectorAll(
            '.content [aria-live="polite"]:not([inert]) .agent-deployment :is(.delayed-status, .delayed-text)',
          ),
        ].flatMap((label) => label.getAnimations());
        for (const animation of animations) {
          animation.finish();
        }
        return animations.length;
      });
      assert.equal(ended, agents.length);
      await page.waitForFunction((count) => globalThis.__readingShown >= count, ended, {
        timeout: 5_000,
      });
    },
    // Lets the held rereads land `ms` after the last step and waits until the page has handled
    // them.
    async land(ms) {
      await page.clock.runFor(ms);
      const before = landed;
      rows.release();
      await waitForCondition(
        () => landed === before + agents.length,
        "every row's deployment read lands",
      );
      await waitForIdleFetches(page);
    },
  };
}

// With a dozen rows, rereads that landed just past the 250 ms delay replaced "Reading
// deployment…" a frame or a few after it showed (16-133 ms on oce-dogfood-b, finding 1683). Once
// shown, it now stays 150 ms; reads that land before it shows, or after that, fill the rows at
// once. The 150 ms count from the frame the text shows in, which can be a frame or two either
// side of render time plus 250 ms: counted from that estimate, a reread landing between the two
// filled a row one frame after its text painted, or after 117-133 ms (finding 1716). The page
// clock decides when each read lands and when the rows fill; the test ends the delay animations.
for (const [shownAt, landsAt, fillsAt] of [
  [undefined, 100, 100],
  [250, 300, 400],
  [250, 450, 450],
  [230, 240, 380],
  [280, 300, 430],
]) {
  test(`Rows shown at ${shownAt ?? "no"} ms whose reread lands at ${landsAt} ms fill at ${fillsAt} ms`, async (t) => {
    const { page, readingCells, reveal, land } = await returnWithHeldRows(
      t,
      `Steady rows ${shownAt ?? "hidden"} ${landsAt}`,
    );
    if (shownAt === undefined) {
      await land(landsAt);
    } else {
      await reveal(shownAt);
      await land(landsAt - shownAt);
    }
    if (fillsAt > landsAt) {
      assert.equal(await readingCells(), 3, "the shown text stays");
      await page.clock.runFor(fillsAt - landsAt - 1);
      assert.equal(await readingCells(), 3, "the shown text stays 150 ms");
      await page.clock.runFor(1);
    }
    for (const text of Object.values(await deploymentCells(page))) {
      assert.match(text, /^v1 · Completed/);
    }
    assert.equal(await viewTag(page), "kept");
  });
}

// A refocus that resumes the list while a landed reread waits out those 150 ms starts the rows
// reading again; the earlier answer never fills a row that reads again.
test("A list resumed while its rows wait to fill shows only the new rereads", async (t) => {
  const { namespace, page, readingCells, reveal, land } = await returnWithHeldRows(
    t,
    "Steady resume",
  );
  await reveal(250);
  await land(50);
  assert.equal(await readingCells(), 3);
  const rereads = await holdRowReads(t, page, namespace);
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await rereads.revisions.requested;
  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  await page.clock.runFor(200);
  assert.equal(await readingCells(), 3, "the earlier answers stay unpainted");
  rereads.release();
  await page.getByText(READING).first().waitFor({ state: "detached" });
  assert.equal(await viewTag(page), "kept");
});

// Until the resume's list read revalidates, the refocus holds the same list on screen, inert,
// with its rows' text still connected but the view no longer current: a landed reread waiting
// out those 150 ms must not fill a row of the held page either (finding 1877).
test("A list held by a refocus while its rows wait to fill paints no earlier answer", async (t) => {
  const { namespace, page, reveal, land } = await returnWithHeldRows(t, "Steady held resume");
  await reveal(250);
  await land(50);
  const listRead = `/namespaces/${namespace.id}/agents`;
  const list = await holdRequests(t, page, (url) => url.pathname.endsWith(listRead), {
    once: true,
  });
  const rereads = await holdRowReads(t, page, namespace);
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await list.requested;
  await page.clock.runFor(200);
  // The held view is inert, so read it directly: deploymentCells reads only the active view.
  const held = await page.evaluate((reading) => {
    const view = globalThis.document.querySelector('.content [aria-live="polite"]');
    const cells = [...view.querySelectorAll(".agent-deployment")];
    return {
      inert: view.inert,
      reading: cells.filter((cell) => cell.textContent === reading).length,
    };
  }, READING);
  assert.deepEqual(held, { inert: true, reading: 3 }, "the held rows stay unfilled");
  list.release();
  await rereads.revisions.requested;
  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  assert.equal(await viewTag(page), "kept");
  rereads.release();
  await page.getByText(READING).first().waitFor({ state: "detached" });
});

// A list left again before its rows' rereads land is reused on the next return too: rows read
// again whenever the list resumes, so unfinished ones don't count against it (finding 1663).
// No row shows the answer it had, or an aborted read's failure, as current.
test("A list left again during its rows' rereads is reused on the next return and rereads them", async (t) => {
  const { namespace, agents, page } = await openTeamList(t, "Team return again");
  const [opened] = agents;
  await tagView(page);
  await openAgent(page, opened);

  const rows = await holdRowReads(t, page, namespace);
  await page.goBack();
  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  await rows.revisions.requested;
  assert.equal(await viewTag(page), "kept");
  await page.locator(settledView).getByRole("link", { name: opened.name, exact: true }).click();
  await page.waitForURL(`**/console/agents/${opened.id}**`);
  rows.release();
  await page
    .locator(settledView)
    .getByRole("region", { name: "Agent state at a glance" })
    .waitFor();

  const rereads = await holdRowReads(t, page, namespace);
  await startRecording(page);
  await page.goBack();
  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  await rereads.revisions.requested;
  assert.equal(await viewTag(page), "kept", "the list was reused");
  const cells = await deploymentCells(page);
  assert.equal(Object.keys(cells).length, AGENTS);
  assert.deepEqual(new Set(Object.values(cells)), new Set([READING]));
  assert.equal((await revealed(page)).deployments, 0, "no stale deployment was revealed");
  rereads.release();
  await page.getByText(READING).first().waitFor({ state: "detached" });
  for (const text of Object.values(await deploymentCells(page))) {
    assert.match(text, /^v1 · Completed/);
  }
});

// On a phone the Agents table scrolled sideways: 5 columns, the deployment one a fixed 14 rem, so
// 2.5 columns showed and IDs broke after every character (UX plan C5). Under 760 px each Agent is
// a stacked row: name and ID, then each cell beside its column's name. A dozen Agents with
// 60-character names fit down to 320 px, every column name shows, IDs break only after a hyphen
// or underscore, and the row still opens its Agent. At 1440 the table is unchanged.
// Two names are the longest allowed with no break in them (200 characters, one joined by no-break
// spaces): each wraps inside its row at every width, and above 760 px within its ID's 310 px, so
// it does not widen the table. The other names wrap as before, only between words (findings 1955,
// 1956).
test("On a phone the Agents list stacks each row, fits the screen and still opens the Agent", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Phone Agents list");
  const agents = [];
  for (let index = 1; index <= AGENTS; index += 1) {
    // Two names are the longest allowed with no break in them: one in a single run, one joined
    // by no-break spaces, which do not let a line wrap either.
    const unbroken = index >= AGENTS - 1;
    const name = unbroken
      ? index === AGENTS
        ? "W".repeat(200)
        : `W${"WWWW\u00a0".repeat(39)}WWWW`
      : `Phone Agent ${String(index).padStart(2, "0")} documentation for the quarterly release review and sign-off`.slice(
          0,
          60,
        );
    // The default harness Secret is named after its Agent, so it would exceed the name limit.
    const agent = await fixture.createAgent(
      namespace.id,
      name,
      nativeValues(name),
      unbroken
        ? {
            harnessAuth: {
              method: "api_key",
              source: (
                await fixture.createSecret(namespace.id, `Unbroken auth ${index}`, "test-key")
              ).ref,
            },
          }
        : {},
    );
    // Half the Agents have a current version, so both forms of that cell are shown.
    if (index % 2 === 0) {
      await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    }
    agents.push({ ...agent, name });
  }
  assert.equal(agents[0].name.length, 60);
  const columns = [
    "Agent",
    "Execution mode",
    "Current version",
    "Latest deployment",
    "Created",
    "Actions",
  ];
  for (const width of [390, 360, 320, 600, 760, 761, 1024, 1440]) {
    const desktop = width > 760;
    const { page } = await newPage(t, fixture, {
      browser,
      context: { viewport: { width, height: desktop ? 900 : 844 } },
    });
    // Each row keeps its height when its deployment read lands (finding 1488).
    const rows = await holdRowReads(t, page, namespace);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    const table = page.locator(settledView).getByRole("table", { name: "Agents" });
    await table.getByRole("link", { name: agents[0].name }).waitFor();
    await rows.revisions.requested;
    const heights = () =>
      table.evaluate((node) =>
        [...node.querySelectorAll("tbody tr")].map((row) => row.getBoundingClientRect().height),
      );
    const reading = await heights();
    assert.equal(await table.getByText(READING).count(), AGENTS);
    rows.release();
    await page.getByText(READING).first().waitFor({ state: "detached" });
    assert.deepEqual(await heights(), reading, `${width}: a row grew when its read landed`);
    // Every row is still a table row with its cells, for screen readers.
    assert.equal(await table.getByRole("row").count(), AGENTS + 1, `${width}: rows`);
    assert.equal(await table.getByRole("columnheader").count(), columns.length, `${width}`);
    const layout = await table.evaluate((node) => {
      const document = globalThis.document;
      const view = document.documentElement;
      const scroll = node.closest(".table-scroll");
      const tableBox = node.getBoundingClientRect();
      // Where each line of a text starts: the character before it ends the previous line.
      const lineBreaks = (text) => {
        const breaks = [];
        let top = null;
        for (let index = 0; index < text.length; index += 1) {
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          const rect = range.getBoundingClientRect();
          if (top !== null && rect.top > top + 1) {
            breaks.push(text.data[index - 1]);
          }
          top = rect.top;
        }
        return breaks;
      };
      const rows = [...node.querySelectorAll("tbody tr")].map((row) => {
        const cells = [...row.cells];
        const breaks = lineBreaks(cells[0].querySelector(".resource-id").firstChild);
        const link = cells[0].querySelector("a");
        const name = link.getBoundingClientRect();
        const first = cells[0].getBoundingClientRect();
        return {
          // A name with no line-breaking space (a no-break space does not count).
          unbroken: !/[ ]/.test(link.textContent),
          name: {
            width: name.width,
            inside: name.left >= first.left - 0.5 && name.right <= first.right + 0.5,
            breaks: lineBreaks(link.firstChild),
            wrap: (({ display, overflowWrap }) => `${display} ${overflowWrap}`)(
              globalThis.getComputedStyle(link),
            ),
          },
          overflows: cells.some((cell) => {
            const box = cell.getBoundingClientRect();
            return box.left < tableBox.left - 0.5 || box.right > tableBox.right + 0.5;
          }),
          labels: cells.slice(1).map((cell) => {
            const before = globalThis.getComputedStyle(cell, "::before");
            const range = document.createRange();
            range.selectNodeContents(cell);
            const content = range.getBoundingClientRect();
            const box = cell.getBoundingClientRect();
            return {
              label: cell.dataset.label,
              shown:
                before.display !== "none" &&
                before.visibility === "visible" &&
                before.content.startsWith(JSON.stringify(cell.dataset.label)),
              // The value starts beside its label (760 px and under) or below it (520 and under).
              beside: content.left - box.left > 40,
              below: content.top - box.top >= 12,
            };
          }),
          breaks,
          display: globalThis.getComputedStyle(row).display,
          revision: {
            text: cells[2].querySelector("a")?.textContent,
            ...(({ fontFamily, color }) => ({ fontFamily, color }))(
              globalThis.getComputedStyle(cells[2].querySelector("a") ?? cells[2]),
            ),
          },
        };
      });
      // The table's width without the unbroken names' rows, which must not widen it.
      const unbroken = [...node.tBodies[0].rows].filter((_, index) => rows[index].unbroken);
      const width = scroll.scrollWidth;
      unbroken.forEach((row) => row.style.setProperty("display", "none"));
      const ordinaryWidth = scroll.scrollWidth;
      unbroken.forEach((row) => row.style.removeProperty("display"));
      // An ID drawn on one line in a row's ID style: "ff" must take two characters' width. A
      // monospace font with ligatures (Nimbus Mono PS) drew it as one glyph, so an ID with two
      // "ff" pairs was 14.4 px narrower and fit one line at 360 px (finding 2114).
      const idWidth = (text) => {
        const probe = document.createElement("span");
        probe.className = "resource-id";
        probe.style.setProperty("display", "inline");
        probe.style.setProperty("white-space", "nowrap");
        probe.textContent = text;
        node.tBodies[0].rows[0].cells[0].append(probe);
        const box = probe.getBoundingClientRect();
        probe.remove();
        return box.width;
      };
      return {
        width,
        ordinaryWidth,
        idWidths: [
          idWidth("agt_ffffffff-ffff-4fff-bfff-ffffffffffff"),
          idWidth("agt_00000000-0000-4000-8000-000000000000"),
        ],
        pageFits: view.scrollWidth <= view.clientWidth,
        tableFits: scroll.scrollWidth <= scroll.clientWidth,
        headerShown: node.tHead.getBoundingClientRect().height > 1,
        linkColor: globalThis.getComputedStyle(node.querySelector("tbody a")).color,
        rows,
      };
    });
    assert.equal(layout.pageFits, true, `${width}: the page scrolls sideways`);
    // At 761 and 1024 px these rows' six columns still scroll inside their card (finding 1907),
    // but the unbroken name makes the table no wider than its other rows do.
    if (width !== 761 && width !== 1024) {
      assert.equal(layout.tableFits, true, `${width}: the table scrolls sideways`);
    }
    assert.ok(
      layout.width <= layout.ordinaryWidth + 2,
      `${width}: the unbroken name widens the table from ${layout.ordinaryWidth} to ${layout.width} px`,
    );
    assert.ok(
      Math.abs(layout.idWidths[0] - layout.idWidths[1]) < 0.5,
      `${width}: an ID with "ff" is ${layout.idWidths[0]} px, one without ${layout.idWidths[1]} px`,
    );
    assert.equal(layout.rows.length, AGENTS);
    assert.equal(layout.rows.filter((row) => row.unbroken).length, 2, `${width}: unbroken rows`);
    for (const [index, row] of layout.rows.entries()) {
      assert.equal(row.overflows, false, `${width}: row ${index} overflows the table`);
      assert.equal(row.name.inside, true, `${width}: row ${index} name overflows its cell`);
      if (desktop && row.unbroken) {
        assert.ok(row.name.width <= 310.5, `${width}: the unbroken name is ${row.name.width} px`);
      }
      // A stacked row gives every name its full width.
      if (width >= 600 && !desktop && row.unbroken) {
        assert.ok(row.name.width > 400, `${width}: the unbroken name is ${row.name.width} px`);
      }
      // Ordinary names wrap as they did before, only between words.
      if (!row.unbroken) {
        assert.equal(
          row.name.wrap,
          desktop ? "inline normal" : "inline anywhere",
          `${width}: row ${index} name wrap`,
        );
        for (const character of row.name.breaks) {
          assert.equal(character, " ", `${width}: row ${index} name breaks inside a word`);
        }
      }
      assert.deepEqual(
        row.labels.map(({ label }) => label),
        columns.slice(1),
        `${width}: row ${index} labels`,
      );
      for (const { label, shown, beside, below } of row.labels) {
        if (desktop) {
          // The desktop table names its columns in the header row instead.
          assert.equal(shown, false, `${width}: ${label} labelled in the cell`);
        } else {
          assert.equal(shown, true, `${width}: row ${index} hides ${label}`);
          assert.deepEqual(
            { beside, below },
            width > 520 ? { beside: true, below: false } : { beside: false, below: true },
            `${width}: row ${index} ${label} value overlaps its label`,
          );
        }
      }
      for (const character of row.breaks) {
        assert.match(character, /[-_]/, `${width}: row ${index} ID breaks inside a segment`);
      }
      // A whole ID can fit at 360 px. At 320 px it must wrap, exercising the break check above.
      if (width === 320) {
        assert.ok(row.breaks.length > 0, `${width}: row ${index} ID fits one line`);
      }
      // The current version is a link like the Agent name, labelled by version rather than revision ID.
      if (index % 2 === 1) {
        assert.equal(row.revision.text, "v1", `${width}: row ${index} revision`);
        assert.doesNotMatch(row.revision.fontFamily, /monospace/, `${width}: row ${index} font`);
        assert.equal(
          row.revision.color,
          layout.linkColor,
          `${width}: row ${index} revision colour`,
        );
      }
      assert.equal(row.display, desktop ? "table-row" : "grid", `${width}: row display`);
    }
    assert.equal(layout.headerShown, desktop, `${width}: header row`);
    // The row's name still opens its Agent.
    const target = agents[1];
    await table.getByRole("link", { name: target.name, exact: true }).click();
    await page.waitForURL(`**/console/agents/${target.id}**`);
    await page
      .locator(settledView)
      .getByRole("region", { name: "Agent state at a glance" })
      .waitFor();
  }
});

// A name the browser cannot wrap sets the desktop table's width unless it is marked to break
// anywhere (finding 1955). Each row is a break point Chromium was measured to use (finding 1982),
// and the test measures it again: each name is marked exactly when the longest run the browser
// keeps on one line (spaces aside) has 21 or more characters. A hyphen-minus between ASCII digits is
// a break ("1000-1001"); a hyphen, dash, soft hyphen or wide space before closing punctuation is
// not, nor is a hyphen-minus before most other digits or a dash that starts a word. A run of em dashes breaks only at its
// ends (finding 1971).
const groups = (part, separator, count = 6) =>
  Array.from({ length: count }, () => part).join(separator);
const unbrokenNameCases = [
  {
    name: Array.from({ length: 40 }, (_, index) => String(1000 + index))
      .join("-")
      .slice(0, 200),
    unbroken: false,
  },
  { name: "\u2014".repeat(200), unbroken: true },
  { name: `Release ${"\u2013".repeat(40)}`, unbroken: true },
  // The threshold: 21 characters with no break are marked, 20 are not (finding 1974), and a
  // mid-length run (about 600 px unmarked) stays within the column too.
  { name: `Run ${"W".repeat(21)}`, unbroken: true },
  { name: `Run ${"W".repeat(20)}`, unbroken: false },
  { name: `Run ${"W".repeat(40)}`, unbroken: true },
  { name: "nightly-build-2026-10-19-release-candidate", unbroken: false },
  // Closing punctuation after a break character holds the run together.
  { name: groups("abc", "-.5", 30), unbroken: true },
  { name: groups("abcdefgh", "-)"), unbroken: true },
  { name: groups("abcdefgh", "\u2013,"), unbroken: true },
  { name: groups("abcdefgh", "\u2010\u2019"), unbroken: true },
  { name: groups("abcdefgh", "\u2009!"), unbroken: true },
  { name: groups("abcdefgh", "\u3000/"), unbroken: true },
  { name: groups("abcdefgh", "-("), unbroken: false },
  { name: groups("abcdefgh", "-\u201d"), unbroken: true },
  // A hyphen-minus that starts a word holds a digit, not a letter; a hyphen or dash holds a letter.
  { name: `x ${groups(`-${"1".repeat(20)}`, " ", 3)}`, unbroken: true },
  { name: `x ${groups(`-${"a".repeat(20)}`, " ", 3)}`, unbroken: false },
  { name: `x ${groups(`\u2010${"a".repeat(20)}`, " ", 3)}`, unbroken: true },
  { name: `x ${groups(`\u2010${"a".repeat(19)}`, " ", 3)}`, unbroken: false },
  // The hyphen a line breaks after stays on it; hyphen-minus pairs break between them.
  { name: `${"a".repeat(20)}-b`, unbroken: true },
  { name: `${"a".repeat(19)}-b`, unbroken: false },
  { name: `Run ${"-".repeat(40)}`, unbroken: false },
  { name: groups("ab", "-\u0661", 10), unbroken: true },
  { name: groups("ab", "-\uff11", 10), unbroken: false },
  // Combining marks share their letter's place; ideographs, kana, Hangul and emoji each break.
  { name: "e\u0301".repeat(15), unbroken: false },
  { name: "\u4e2d\u6587\u540d\u5b57".repeat(8), unbroken: false },
  { name: "\u30ab\u30bf\u30ab\u30ca".repeat(8), unbroken: false },
  { name: "\ud55c\uad6d\uc5b4".repeat(10), unbroken: false },
  { name: "\u{1F680}".repeat(25), unbroken: false },
  { name: `${"a".repeat(15)}\u4e2d${"b".repeat(15)}`, unbroken: false },
  // A word joiner or zero-width joiner holds the ideograph or emoji before it.
  { name: "\u4e2d\u2060".repeat(100), unbroken: true },
  { name: "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}".repeat(8), unbroken: false },
  // A combining mark before a joiner shares its letter's place too (finding 1999).
  { name: "e\u0301\u2060".repeat(10), unbroken: false },
  { name: `${"e\u0301\u2060".repeat(10)}a`, unbroken: true },
  // Emoji whose line-break class is AL hold like letters (finding 2001); others still break.
  {
    name: "\u23e9\u23ec\u25fd\u25fe\u2648\u2653\u2693\u26a1\u26aa\u26ab\u26ce\u2705\u2728\u274c\u274e\u2753\u2755\u2757\u2795\u2797\u27b0",
    unbroken: true,
  },
  {
    name: "\u27bf\u2b1b\u2b1c\u2b50\u2b55\u{1f18e}\u{1f191}\u{1f19a}\u{1f3b5}\u{1f3b6}\u{1f3bc}\u{1f4a0}\u{1f4a2}\u{1f4a4}\u{1f4af}\u{1f4b1}\u{1f4b2}\u{1f500}\u{1f506}\u{1f517}\u{1f524}",
    unbroken: true,
  },
  { name: `${"a".repeat(18)}\u{1f532}\u{1f53d}b`, unbroken: true },
  { name: "build\u26a1deploy\u26a1monitor\u26a1agent", unbroken: true },
  // Opening quotes, separators and closing punctuation stay after a hyphen, soft hyphen, dash or
  // wide space (finding 2001).
  { name: "a-\u00aba-\u037ea-\u0589a-\u060ca-\u2018a-\u201ca-\u2039", unbroken: true },
  { name: "a-\u203aa-\u2044a-\ufeffa-$aaaaaaaaa", unbroken: true },
  { name: `${"a".repeat(19)}-\u2012`, unbroken: true },
  { name: `${"a".repeat(19)}-\u2013`, unbroken: true },
  { name: `${"a".repeat(19)}-\u2010`, unbroken: true },
  {
    name: "a\u00ad\u00aba\u00ad\u037ea\u00ad\u0589a\u00ad\u060ca\u00ad\u2018a\u00ad\u201ca\u00ad\u2039",
    unbroken: true,
  },
  {
    name: "a\u2009\u203aa\u2009\u2044a\u2009\ufeffa\u2009\u00aba\u2009\u2018a\u2009\u201ca\u2009\u2039",
    unbroken: true,
  },
  {
    name: "a-\u0301\u00aba-\u0301\u037ea-\u0301\u0589a-\u0301\u060ca-\u0301\u2018a-\u0301\u201ca-\u0301\u2039",
    unbroken: true,
  },
  {
    name: "a\u00ad\u0301]a\u00ad\u0301}a\u00ad\u0301\u00bba\u00ad\u0301\u2019a\u00ad\u0301\u201da\u00ad\u0301\u2060a\u00ad\u0301\u200d",
    unbroken: true,
  },
  { name: "aaaaa\u00ad\"aaaaa\u00ad'aaaaa\u00ad|", unbroken: true },
  { name: "a-!a-)a-,a-.a-/a-:a-;", unbroken: true },
  { name: "a-]a-}a-\u00bba-\u2019a-\u201da-\u2060a-\u200d", unbroken: true },
  // A hyphen-minus before a digit breaks only between an ASCII letter or digit and an ASCII digit,
  // or before a fullwidth digit. After Cyrillic letters, and before Devanagari or Arabic-Indic
  // digits, it holds, and so does one with a mark on it (finding 2000).
  {
    name: "\u0435\u0436\u0435\u043a\u0432\u0430\u0440\u0442\u0430\u043b\u044c\u043d\u044b\u0439\u043e\u0442\u0447\u0451\u0442-2026",
    unbroken: true,
  },
  {
    name: "\u0930\u093f\u0932\u0940\u091c\u093c\u0915\u093e\u092e\u0938\u094c\u0926\u093e-\u0968\u0966\u0968\u096c-\u0967\u0966-\u0967\u096f-\u0966\u096f-\u0969\u0966",
    unbroken: true,
  },
  { name: `${"x".repeat(18)}A-1`, unbroken: false },
  { name: `${"x".repeat(18)}a-1`, unbroken: false },
  { name: `${"x".repeat(18)}A-\u0663`, unbroken: true },
  { name: `${"x".repeat(18)}a-\u0663`, unbroken: true },
  { name: `${"x".repeat(18)}0-\u0967`, unbroken: true },
  { name: `${"x".repeat(18)}\u00e9-\u0301\u0663`, unbroken: true },
  { name: `${"x".repeat(18)}a-\u03011`, unbroken: true },
  { name: `${"x".repeat(18)}\u00e9-\u0301\uff11`, unbroken: false },
  { name: `${"x".repeat(18)}a-\u0301\uff11`, unbroken: false },
  { name: `x -\uff11y${"a".repeat(18)}`, unbroken: false },
  // Dashes held before other dashes, and a dash that starts a word after a no-break space.
  { name: `${"a".repeat(19)}\u2010-`, unbroken: true },
  { name: `${"a".repeat(19)}\u2010\u2010`, unbroken: true },
  { name: `${"a".repeat(19)}\u2010\u2012`, unbroken: true },
  { name: `x\u00a0\u2012${"a".repeat(20)}`, unbroken: true },
  { name: `x\u2007\u2010${"b".repeat(20)}`, unbroken: true },
  { name: `x\u2011\u2010${"a".repeat(20)}`, unbroken: true },
  { name: `x\u202f\u2010${"c".repeat(20)}`, unbroken: true },
  { name: `x\u200b\u2013${"a".repeat(20)}`, unbroken: true },
  { name: `x \u2010(${"a".repeat(19)}`, unbroken: false },
  // Each of these ends a run: ten letters either side of it are not marked.
  {
    name: Array.from(
      "\u1680\u2000\u2008\u205f\u3000\u200b\u00ad\u2010\u2012\u2013\u2014\u3041\u30a1\uac00\u4e2d\u{1f680}",
      (separator) => `aaaaaaaaaa${separator}`,
    )
      .join("")
      .concat("aaaaaaaaaa"),
    unbroken: false,
  },
  // A wide space, dash or hyphen a line breaks after stays on it.
  { name: `${"a".repeat(20)}\u1680b`, unbroken: true },
  { name: `${"a".repeat(20)}\u00adb`, unbroken: true },
  // Thresholds: an em-dash run of 21 is marked, 20 is not; marks share their letter's place.
  { name: "\u2014".repeat(21), unbroken: true },
  { name: "\u2014".repeat(20), unbroken: false },
  { name: "e\u0301".repeat(21), unbroken: true },
  { name: `${"\u30a2\u0301\u200d".repeat(10)}a`, unbroken: true },
  // No-break characters and underscores keep a run (finding 2002).
  { name: groups("abcdefgh", "_"), unbroken: true },
  { name: groups("abcdefgh", "\u2011"), unbroken: true },
  { name: groups("abcdefgh", "\u202f"), unbroken: true },
  { name: groups("ijklmnop", "\u2007"), unbroken: true },
  { name: groups("qrstuvwx", "\ufeff"), unbroken: true },
];

test("Agents list marks names with no break opportunity, hyphen and dash runs included", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Unbroken Agent names");
  const cases = unbrokenNameCases;
  for (const [index, entry] of cases.entries()) {
    // The default harness Secret is named after its Agent, so it would exceed the name limit.
    const secret = await fixture.createSecret(namespace.id, `Unbroken name ${index}`, "test-key");
    await fixture.createAgent(namespace.id, entry.name, nativeValues(`unbroken-${index}`), {
      harnessAuth: { method: "api_key", source: secret.ref },
    });
  }
  for (const width of [1024, 1440]) {
    const { page } = await newPage(t, fixture, {
      browser,
      context: { viewport: { width, height: 900 } },
    });
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    const table = page.locator(settledView).getByRole("table", { name: "Agents" });
    await table.getByRole("link", { name: cases.at(-1).name, exact: true }).waitFor();
    // Every listed name, measured in one pass: whether it is marked, its width, and the longest
    // run the browser keeps on one line, set in the link's font in a box too narrow for any word.
    // Combining marks share their letter's place, and a space hangs at the end of its line, so
    // neither counts.
    const measured = await table.getByRole("link").evaluateAll((links) =>
      links.map((link) => {
        const box = globalThis.document.createElement("div");
        const style = globalThis.getComputedStyle(link);
        box.style.cssText = `position:absolute;width:1px;font:${style.font}`;
        box.textContent = link.textContent;
        link.closest("table").after(box);
        const range = globalThis.document.createRange();
        let longest = 0;
        let run = 0;
        let top = null;
        let offset = 0;
        for (const character of Array.from(link.textContent)) {
          range.setStart(box.firstChild, offset);
          range.setEnd(box.firstChild, offset + character.length);
          offset += character.length;
          const rect = range.getClientRects()[0];
          if (!rect || /[\p{M} ]/u.test(character)) {
            continue;
          }
          run = Math.round(rect.top) === top ? run + 1 : 1;
          top = Math.round(rect.top);
          longest = Math.max(longest, run);
        }
        box.remove();
        return {
          name: link.textContent,
          marked: link.classList.contains("agent-name-unbroken"),
          width: link.getBoundingClientRect().width,
          longest,
        };
      }),
    );
    for (const entry of cases) {
      const label = `${width}: ${JSON.stringify(entry.name.slice(0, 24))}…`;
      const matches = measured.filter((link) => link.name === entry.name);
      assert.equal(matches.length, 1, `${label} is listed once as a link`);
      const [shown] = matches;
      assert.equal(shown.marked, entry.unbroken, `${label} marked`);
      assert.equal(shown.longest >= 21, entry.unbroken, `${label} longest run ${shown.longest}`);
      if (entry.unbroken) {
        assert.ok(shown.width <= 310.5, `${label} the unbroken name is ${shown.width} px`);
      }
    }
    if (width === 1440) {
      const fits = await table.evaluate((node) => {
        const scroll = node.closest(".table-scroll");
        return scroll.scrollWidth <= scroll.clientWidth;
      });
      assert.equal(fits, true, `${width}: the table scrolls sideways`);
    }
  }
});

// A name of word-joiner or zero-width-joiner runs made the long-name check backtrack
// exponentially: seconds per name, so the list froze on load and on each search keystroke that
// kept such an Agent listed (finding 1999). Each name here is several runs of 20 that just fail
// to be marked, the worst case. A keystroke re-renders the rows it keeps synchronously, so the
// page times that work itself.
test("Agents list search stays responsive with joiner-run names", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Joiner Agent names");
  const names = [
    `Joiners ${`${"\u2060".repeat(20)} `.repeat(9)}`.trimEnd(),
    `Joiners ${`a${"\u200d".repeat(19)} `.repeat(9)}`.trimEnd(),
  ];
  for (const [index, name] of names.entries()) {
    const secret = await fixture.createSecret(namespace.id, `Joiner name ${index}`, "test-key");
    await fixture.createAgent(namespace.id, name, nativeValues(`joiners-${index}`), {
      harnessAuth: { method: "api_key", source: secret.ref },
    });
  }
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 1440, height: 900 } },
  });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const table = page.locator(settledView).getByRole("table", { name: "Agents" });
  await table.getByRole("link", { name: names[1], exact: true }).waitFor();
  const search = page.getByRole("searchbox", { name: "Search Agents" });
  for (const text of ["J", "Jo", "Joi", "Joiners"]) {
    const elapsed = await search.evaluate((node, value) => {
      const started = globalThis.performance.now();
      node.value = value;
      node.dispatchEvent(new globalThis.Event("input", { bubbles: true }));
      return globalThis.performance.now() - started;
    }, text);
    assert.ok(elapsed < 250, `typing ${JSON.stringify(text)} blocked the page for ${elapsed} ms`);
  }
  for (const name of names) {
    const link = table.getByRole("link", { name, exact: true });
    await link.waitFor();
    assert.equal(
      await link.evaluate((node) => node.classList.contains("agent-name-unbroken")),
      false,
    );
  }
});

// The Agents list showed the current version as a raw revision ID beside "v122 · succeeded", and
// the Agent page called the same outcome "Completed" (finding 2093). The list now names the
// current version by number, read with the row's versions, and shares the page's outcome words.
test("Agents list names the current version by number in the page's outcome words", async (t) => {
  const { fixture, namespace, agents, page } = await openTeamList(t, "Version numbers", {
    newer: [0],
  });
  const row = (agent) => page.locator(activeView).getByRole("row").filter({ hasText: agent.name });
  const cells = (agent) =>
    row(agent).evaluate((node) => ({
      current: node.querySelector('[data-label="Current version"]').textContent,
      href: new URL(node.querySelector('[data-label="Current version"] a').href).searchParams.get(
        "revision",
      ),
      deployment: node.querySelector(".agent-deployment a").textContent,
    }));
  const active = (agent) =>
    fixture
      .request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)
      .then((body) => body.data);
  const [newer, plain] = [agents[0], agents[1]];
  // A second version deployed after the current one: v1 is current, v2 is the latest.
  assert.deepEqual(await cells(newer), {
    current: "v1",
    href: (await active(newer)).activeRevisionId,
    deployment: "v2 · Completed",
  });
  assert.deepEqual(await cells(plain), {
    current: "v1",
    href: (await active(plain)).activeRevisionId,
    deployment: "v1 · Completed",
  });
  assert.equal(await page.locator(".agent-table").getByText(/rev_/).count(), 0);

  // A current version older than the first page of versions is read on its own.
  const { page: paged } = await newPage(t, fixture, { browser });
  await paged.route(`**/namespaces/${namespace.id}/agents/${newer.id}/revisions`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data = body.data.filter((revision) => revision.revision !== 1);
    await route.fulfill({ response, json: body });
  });
  await paged.route(deploymentsRead(namespace), (route) =>
    route.fulfill(deploymentRecord(namespace, "succeeded")),
  );
  const activeId = (await active(newer)).activeRevisionId;
  const direct = paged.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith(`/agents/${newer.id}/revisions/${activeId}`),
  );
  await login(paged, fixture, `/console/agents?namespace=${namespace.id}`);
  await direct;
  const pagedRow = paged.locator(settledView).getByRole("row").filter({ hasText: newer.name });
  await pagedRow.getByRole("link", { name: "v2 · Completed", exact: true }).waitFor();
  await pagedRow.getByRole("link", { name: "v1", exact: true }).waitFor();

  // A current version the reader cannot read keeps its ID, and its audited 403 is asked once per
  // tab, not on every list view.
  const { page: denied } = await newPage(t, fixture, { browser });
  await denied.route(
    `**/namespaces/${namespace.id}/agents/${newer.id}/revisions`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data = body.data.filter((revision) => revision.revision !== 1);
      await route.fulfill({ response, json: body });
    },
  );
  let deniedReads = 0;
  await denied.route(`**/agents/${newer.id}/revisions/${activeId}`, (route) => {
    deniedReads += 1;
    return route.fulfill({
      status: 403,
      json: {
        error: { code: "FORBIDDEN", message: "The exact platform operation was not authorized." },
        meta: {},
      },
    });
  });
  await denied.route(deploymentsRead(namespace), (route) =>
    route.fulfill(deploymentRecord(namespace, "succeeded")),
  );
  await login(denied, fixture, `/console/agents?namespace=${namespace.id}`);
  const deniedRow = () =>
    denied.locator(settledView).getByRole("row").filter({ hasText: newer.name });
  const idLink = `${activeId.slice(0, 12)}…${activeId.slice(-6)}`;
  await deniedRow().getByRole("link", { name: idLink, exact: true }).waitFor();
  await denied.reload();
  await deniedRow().getByRole("link", { name: "v2 · Completed", exact: true }).waitFor();
  await deniedRow().getByRole("link", { name: idLink, exact: true }).waitFor();
  assert.equal(deniedReads, 1);
});
