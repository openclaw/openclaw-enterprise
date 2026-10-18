import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  detailUrl,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  persistedDeploymentError,
} from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// Failed-version recovery's Deploy again: the API's DEPENDENCY_UNAVAILABLE message says to deploy
// again, and the link opens the draft at its Deploy new version. That button is built only from a
// readable Configuration and only for a caller who may deploy, so the link is offered only once
// both are known (findings 1931, 1933).

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

// Resolves after the page has painted twice more and run a task after that, so work that has
// already settled has rendered.
const nextFrames = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(() => setTimeout(resolve)),
        );
      }),
  );

// An Agent whose v1 keeps serving while its v2 redeploy failed with DEPENDENCY_UNAVAILABLE.
async function failedRedeploy(t, name, viewport) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name, {
    computeDriver: createRuntimeLogComputeDriver(),
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  const agent = await fixture.createAgent(namespace.id, `${name} Agent`, nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    ...(viewport ? { context: { viewport } } : {}),
  });
  const record = {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        deploymentId: failed.id,
        namespaceId: namespace.id,
        agentId: agent.id,
        status: "failed",
        error: persistedDeploymentError("DEPENDENCY_UNAVAILABLE"),
        warnings: [],
        progress: null,
      },
      meta: { requestId: "req_test_deploy_again" },
    }),
  };
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${failed.id}`,
    (route) => route.fulfill(record),
  );
  const configurationUrl = `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  return { fixture, namespace, agent, active, page, configurationUrl };
}

const recoveryOf = (page) => page.getByRole("region", { name: "Deployment needs attention" });

// Records whether a Deploy again link was ever in the page, so a link shown and then withdrawn
// still fails. Install it before the page loads.
function watchDeployAgain() {
  globalThis.deployAgainSeen = false;
  const check = () => {
    for (const node of globalThis.document.querySelectorAll(".deployment-recovery a")) {
      if (node.textContent === "Deploy again") {
        globalThis.deployAgainSeen = true;
      }
    }
  };
  new globalThis.MutationObserver(check).observe(globalThis.document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// A deployer who cannot read the Configuration lands on the serving version's tabs, where the page
// has no other reason to read it. Recovery used to treat "not yet denied" as readable and offered
// Deploy again as its primary action; the draft it opened then had no Deploy new version (finding
// 1931). The page now reads the Configuration first, and the 403 keeps Logs as the primary action.
for (const tab of ["configuration", "logs", "channels"]) {
  test(`Recovery on v1's ${tab} tab offers no Deploy again when the Configuration read is denied`, async (t) => {
    const { fixture, namespace, agent, active, page, configurationUrl } = await failedRedeploy(
      t,
      `Deploy again denied ${tab}`,
    );
    await page.route(configurationUrl, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "FORBIDDEN", message: "Access denied." },
              meta: { requestId: "req_test_deploy_again_configuration_denied" },
            }),
          })
        : route.fallback(),
    );
    await page.addInitScript(watchDeployAgain);
    const denied = page.waitForResponse(
      (response) => response.url() === configurationUrl && response.status() === 403,
    );

    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, active.revision.id, tab));
    const recovery = recoveryOf(page);
    await recovery
      .getByText(persistedDeploymentError("DEPENDENCY_UNAVAILABLE").message, { exact: false })
      .waitFor();
    const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
    await logs.waitFor();
    // Only a successful read shows the Configuration is readable, so the page asks.
    await denied;
    await nextFrames(page);
    assert.equal(await logs.getAttribute("class"), "overview-primary");
    assert.equal(await recovery.getByRole("link", { name: "Deploy again" }).count(), 0);
    assert.equal(await page.evaluate(() => globalThis.deployAgainSeen), false);
  });
}

// Deploy again waits for that read: while it is held the banner offers Logs, and only its success
// adds Deploy again as the primary action.
test("Recovery on another version offers Deploy again only after the Configuration read succeeds", async (t) => {
  const { fixture, namespace, agent, active, page, configurationUrl } = await failedRedeploy(
    t,
    "Deploy again held",
  );
  const read = await holdRequests(t, page, configurationUrl, { method: "GET", once: true });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const recovery = recoveryOf(page);
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  await read.requested;
  await nextFrames(page);
  assert.equal(await recovery.getByRole("link", { name: "Deploy again" }).count(), 0);
  assert.equal(await logs.getAttribute("class"), "overview-primary");

  read.release();
  const again = recovery.getByRole("link", { name: "Deploy again" });
  await again.waitFor();
  assert.equal(await again.getAttribute("class"), "overview-primary");
});

// Opens Deploy again from v1's Configuration tab with the draft's own Configuration read held, and
// waits until the draft page shows while that read is still out: its Deploy new version card does
// not exist yet, so the link's focus waits for it.
async function deployAgainWithHeldDraft(t, name) {
  const setup = await failedRedeploy(t, name, { width: 390, height: 844 });
  const { fixture, namespace, agent, active, page, configurationUrl } = setup;
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const again = recoveryOf(page).getByRole("link", { name: "Deploy again" });
  await again.waitFor();
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  // The v1 page's read has settled; hold the draft page's.
  const draftRead = await holdRequests(t, page, configurationUrl, { method: "GET", once: true });
  await again.click();
  await page.waitForURL((next) => next.searchParams.get("revision") === "draft");
  await draftRead.requested;
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(".agent-detail-pending") === null &&
      globalThis.document.activeElement?.closest(".agent-tabs") &&
      globalThis.document.activeElement.textContent === "Configuration",
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).count(), 0);
  return { ...setup, draftRead };
}

// The draft page can show before its Configuration read lands (finding 1933). The link's focus
// then waits for that read and lands on Deploy new version, in view at phone width.
test("Deploy again focuses Deploy new version once a held draft read lands", async (t) => {
  const { page, draftRead } = await deployAgainWithHeldDraft(t, "Deploy again deferred");

  draftRead.release();
  await page.waitForFunction(() => {
    const active = globalThis.document.activeElement;
    const box = active?.getBoundingClientRect();
    return (
      active?.textContent === "Deploy new version" &&
      box.top >= 0 &&
      box.bottom <= globalThis.innerHeight
    );
  });
});

// A reader who moved focus elsewhere while the draft read was out is not pulled to Deploy new
// version when it lands.
test("Deploy again leaves focus the reader moved while the draft read was held", async (t) => {
  const { page, draftRead } = await deployAgainWithHeldDraft(t, "Deploy again moved on");
  const agents = page.getByRole("link", { name: "← Agents" });
  await agents.focus();

  draftRead.release();
  await page.getByRole("button", { name: "Deploy new version" }).waitFor();
  await nextFrames(page);
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.textContent),
    "← Agents",
  );
});

// Deploy again leads to Deploy new version, so it needs a positive deploy answer. A permission read
// that fails leaves that unknown, and the banner offers Logs only (finding 1933), even on the draft
// whose Configuration read succeeded.
test("Recovery offers no Deploy again when the caller's permission answer fails", async (t) => {
  const { fixture, namespace, agent, page } = await failedRedeploy(
    t,
    "Deploy again unknown permission",
  );
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "DEPENDENCY_UNAVAILABLE", message: "Try again later." },
          meta: { requestId: "req_test_deploy_again_permissions_failed" },
        }),
      }),
  );
  await page.addInitScript(watchDeployAgain);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = recoveryOf(page);
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  // The draft's Configuration read succeeded, so only the permission answer withholds the link.
  await page.getByRole("button", { name: "Deploy new version" }).waitFor();
  await nextFrames(page);
  assert.equal(await logs.getAttribute("class"), "overview-primary");
  assert.equal(await recovery.getByRole("link", { name: "Deploy again" }).count(), 0);
  assert.equal(await page.evaluate(() => globalThis.deployAgainSeen), false);
});
