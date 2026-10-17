import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  holdRequests,
  login,
  nativeValues,
  newPage,
  persistedDeploymentError,
} from "./console-agents-browser-helpers.mjs";

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
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
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
    const loading = row.getByText(READING, { exact: true });
    assert.equal(await isFocused(loading), true, "Back focused the pending deployment");
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

// A list left again before its rows' rereads land is not reused: the next return rebuilds it.
test("A list left again during its rows' rereads is rebuilt on the next return", async (t) => {
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

  await page.goBack();
  await page.locator(settledView).getByRole("table", { name: "Agents" }).waitFor();
  assert.equal(await viewTag(page), null, "the list was rebuilt");
  await page.getByText(READING).first().waitFor({ state: "detached" });
  assert.equal(await page.locator(activeView).locator(".agent-table tbody tr").count(), AGENTS);
});
