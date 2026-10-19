import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { grantRole } from "../helpers/iam-grants.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  apiRequests,
  detailUrl,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  persistedDeploymentError,
  routeFailedDeployment,
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
async function failedRedeploy(
  t,
  name,
  { viewport, auditSink, code = "DEPENDENCY_UNAVAILABLE" } = {},
) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name, {
    computeDriver: createRuntimeLogComputeDriver(),
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
    ...(auditSink ? { auditSink } : {}),
  });
  const agent = await fixture.createAgent(namespace.id, `${name} Agent`, nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    ...(viewport ? { context: { viewport } } : {}),
  });
  await routeFailedDeployment(page, fixture, {
    namespaceId: namespace.id,
    agentId: agent.id,
    deploymentId: failed.id,
    code,
  });
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

// The failed deployment's own message says to deploy again; the page's 503 answer for a read.
const unavailable = {
  status: 503,
  contentType: "application/json",
  body: JSON.stringify({
    error: { code: "DEPENDENCY_UNAVAILABLE", message: "Try again later." },
    meta: { requestId: "req_test_deploy_again_unavailable" },
  }),
};

// A Namespace member whose role grants Agent deploy and log reading but no Configuration read.
function deployerWithoutConfiguration(fixture, namespace) {
  return fixture.createAccountWithPolicy("deployer-without-configuration", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "role-deployer-without-configuration",
      namespaceId: namespace.id,
      permissions: {
        namespace: ["read"],
        agent: ["read", "deploy", "read_logs"],
        agent_revision: ["read"],
      },
    });
  });
}

// A deployer who cannot read the Configuration lands on the serving version's tabs, where the page
// has no other reason to read it. Recovery used to treat "not yet denied" as readable and offered
// Deploy again as its primary action; the draft it opened then had no Deploy new version (finding
// 1931). The page now reads the Configuration first; the API's 403 keeps Logs as the primary action,
// and the tab remembers the denial, so it is audited once.
for (const tab of ["configuration", "logs", "channels"]) {
  test(`A deployer who cannot read the Configuration gets no Deploy again on v1's ${tab} tab`, async (t) => {
    const auditSink = new InMemoryAuditSink();
    const { fixture, namespace, agent, active, page, configurationUrl } = await failedRedeploy(
      t,
      `Deploy again denied ${tab}`,
      { auditSink },
    );
    const deployer = await deployerWithoutConfiguration(fixture, namespace);
    await page.addInitScript(watchDeployAgain);
    const permissions = page.waitForResponse((response) =>
      response.url().endsWith(`/agents/${agent.id}/permissions`),
    );
    const denied = page.waitForResponse(
      (response) => response.url() === configurationUrl && response.status() === 403,
    );

    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, tab),
      deployer.credentials,
    );
    // The API's own answer: this caller may deploy.
    assert.equal((await (await permissions).json()).data.deploy, true);
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
    const configurationDenials = auditSink
      .list()
      .filter(
        (event) =>
          event.kind === "authorization_denial" && event.action === "openclaw.configurations.read",
      );
    assert.equal(configurationDenials.length, 1);
  });
}

// A read that fails for another reason proves nothing either. The page asks once: switching tabs
// renders recovery again in place without repeating the read.
test("A failed Configuration read leaves Deploy again hidden and is not repeated", async (t) => {
  const { fixture, namespace, agent, active, page, configurationUrl } = await failedRedeploy(
    t,
    "Deploy again unavailable",
  );
  await page.route(configurationUrl, (route) =>
    route.request().method() === "GET" ? route.fulfill(unavailable) : route.fallback(),
  );
  await page.addInitScript(watchDeployAgain);
  const requests = apiRequests(page, fixture.origin);
  const failed = page.waitForResponse(
    (response) => response.url() === configurationUrl && response.status() === 503,
  );

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const recovery = recoveryOf(page);
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  await failed;
  await nextFrames(page);
  assert.equal(await recovery.getByRole("link", { name: "Deploy again" }).count(), 0);

  // Role-agnostic: the tab strip's controls are buttons today and may become tabs.
  await page.locator(".agent-tabs").getByText("Channels", { exact: true }).click();
  await page.waitForURL((next) => next.searchParams.get("tab") === "channels");
  await nextFrames(page);
  await nextFrames(page);
  const configurationPath = new URL(configurationUrl).pathname;
  assert.equal(
    requests.filter((request) => request.method === "GET" && request.path === configurationPath)
      .length,
    1,
  );
  assert.equal(await logs.getAttribute("class"), "overview-primary");
  assert.equal(await page.evaluate(() => globalThis.deployAgainSeen), false);
});

// On the draft, its own Configuration read decides: a read that fails for another reason than a
// denial leaves no Deploy again either.
test("The draft offers no Deploy again when its Configuration read fails", async (t) => {
  const { fixture, namespace, agent, page, configurationUrl } = await failedRedeploy(
    t,
    "Deploy again draft unavailable",
  );
  await page.route(configurationUrl, (route) =>
    route.request().method() === "GET" ? route.fulfill(unavailable) : route.fallback(),
  );
  await page.addInitScript(watchDeployAgain);
  const failed = page.waitForResponse(
    (response) => response.url() === configurationUrl && response.status() === 503,
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = recoveryOf(page);
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  await failed;
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  await nextFrames(page);
  assert.equal(await logs.getAttribute("class"), "overview-primary");
  assert.equal(await recovery.getByRole("link", { name: "Deploy again" }).count(), 0);
  assert.equal(await page.evaluate(() => globalThis.deployAgainSeen), false);
});

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
  const setup = await failedRedeploy(t, name, { viewport: { width: 390, height: 844 } });
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

// A startup model check failure sends the caller to the draft's Configuration. A deployer without
// update gets "Open version draft", whose only step is Deploy new version, and that is built only
// from a readable Configuration. The link used to follow "not yet denied" and opened a draft without
// it (finding 1944); it now waits for the same read as Deploy again.
test("A deployer who cannot read the Configuration gets no Open version draft", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const { fixture, namespace, agent, active, page, configurationUrl } = await failedRedeploy(
    t,
    "Open draft denied",
    { auditSink, code: "RUNTIME_MODEL_PROBE_FAILED" },
  );
  const deployer = await deployerWithoutConfiguration(fixture, namespace);
  await page.addInitScript(() => {
    globalThis.openDraftSeen = false;
    new globalThis.MutationObserver(() => {
      for (const node of globalThis.document.querySelectorAll(".deployment-recovery a")) {
        if (node.textContent === "Open version draft") {
          globalThis.openDraftSeen = true;
        }
      }
    }).observe(globalThis.document, { childList: true, subtree: true, characterData: true });
  });
  const permissions = page.waitForResponse((response) =>
    response.url().endsWith(`/agents/${agent.id}/permissions`),
  );
  const denied = page.waitForResponse(
    (response) => response.url() === configurationUrl && response.status() === 403,
  );

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    deployer.credentials,
  );
  const answer = (await (await permissions).json()).data;
  assert.equal(answer.deploy, true);
  assert.equal(answer.update, false);
  const recovery = recoveryOf(page);
  await recovery.getByText("v2 failed its startup model check.", { exact: false }).waitFor();
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  // The link used to render with Logs, before any Configuration read.
  assert.equal(await page.evaluate(() => globalThis.openDraftSeen), false);
  await denied;
  await nextFrames(page);
  assert.equal(await logs.getAttribute("class"), "overview-primary");
  assert.equal(await recovery.getByRole("link", { name: "Open version draft" }).count(), 0);
  assert.equal(await page.evaluate(() => globalThis.openDraftSeen), false);
  const configurationDenials = auditSink
    .list()
    .filter(
      (event) =>
        event.kind === "authorization_denial" && event.action === "openclaw.configurations.read",
    );
  assert.equal(configurationDenials.length, 1);
});

// A deployer who can read it gets the link once the read succeeds, not before.
test("Open version draft waits for the Configuration read to succeed", async (t) => {
  const { fixture, namespace, agent, active, page, configurationUrl } = await failedRedeploy(
    t,
    "Open draft held",
    { code: "RUNTIME_MODEL_PROBE_FAILED" },
  );
  const deployer = await fixture.createAccountWithPolicy("deployer-reads-configuration", (p) => {
    grantRole(fixture.policy, p.id, {
      id: "role-deployer-reads-configuration",
      namespaceId: namespace.id,
      permissions: {
        namespace: ["read"],
        agent: ["read", "deploy", "read_logs"],
        agent_revision: ["read"],
        configuration: ["read"],
      },
    });
  });
  const read = await holdRequests(t, page, configurationUrl, { method: "GET", once: true });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "logs"),
    deployer.credentials,
  );
  const recovery = recoveryOf(page);
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  const openDraft = recovery.getByRole("link", { name: "Open version draft" });
  assert.equal(await openDraft.count(), 0);
  await read.requested;
  await nextFrames(page);
  assert.equal(await openDraft.count(), 0);
  assert.equal(await logs.getAttribute("class"), "overview-primary");

  read.release();
  await openDraft.waitFor();
});
