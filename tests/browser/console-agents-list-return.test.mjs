import assert from "node:assert/strict";
import test from "node:test";

import {
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

// Returning to the Agents list held the Agent page, inert, until the retained list had read
// every row's /revisions and /deployments again: two reads per Agent, so the hold grew with the
// Namespace (283-517 ms for 12 Agents on oce-dogfood-b, finding 1644). The list now reveals once
// its own reads revalidate, and the rows read their deployments again in place.
const AGENTS = 12;
const READING = "Reading deployment…";
const activeView = '.content [aria-live="polite"]:not([inert])';
const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';
const revisionsRead = (namespace) => `**/namespaces/${namespace.id}/agents/*/revisions`;
const isFocused = (locator) =>
  locator.evaluate((node) => node === globalThis.document.activeElement);
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
  const { page } = await newPage(t, fixture);
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
    assert.match(after[changed.name], /^v1 · failed/);
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
    assert.equal(await isFocused(loading), true, "Back focused the pending deployment");
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
        await isFocused(row.getByRole("link", { name: target.name, exact: true })),
        true,
        "focus moved to the row's Agent link",
      );
    } else {
      assert.match(await deploymentLink.textContent(), /^v2 · succeeded/);
      assert.equal(await isFocused(deploymentLink), true, "the fresh link kept focus");
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
    const { page } = await newPage(t, fixture);
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
      assert.match(text, /^v1 · succeeded/);
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
  const { page } = await newPage(t, fixture);
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
      assert.match(text, /^v1 · succeeded/);
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
    assert.match(text, /^v1 · succeeded/);
  }
});
