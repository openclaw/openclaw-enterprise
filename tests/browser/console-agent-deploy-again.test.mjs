import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";
import { apiErrorResponse, proxyErrorResponse } from "../helpers/api-error.mjs";
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
  nextFrames,
  pathRequests,
  persistedDeploymentError,
  routeFailedDeployment,
} from "./console-agents-browser-helpers.mjs";
import {
  deploymentDetailsOpen,
  deploymentRecordUrl,
} from "./console-deployment-activity-helpers.mjs";
import { replyWithDifferentAgentId } from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";
import {
  GENERIC_DENIAL,
  OVERVIEW_REFRESH_FAILED,
  READ_OUTAGE_REASON,
} from "../helpers/refusal-text.mjs";

// Failed-version recovery's Deploy again: the API's DEPENDENCY_UNAVAILABLE message says to deploy
// again, and the link opens the draft at its Deploy new version. That button is built only from a
// readable Configuration and only for a caller who may deploy, so the link is offered only once
// both are known (findings 1931, 1933).

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

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
const unavailable = apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again later.");

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
    assert.equal(await logs.getAttribute("class"), "button button--primary");
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
  assert.equal(pathRequests(requests, "GET", configurationPath).length, 1);
  assert.equal(await logs.getAttribute("class"), "button button--primary");
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
  assert.equal(await logs.getAttribute("class"), "button button--primary");
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
  assert.equal(await logs.getAttribute("class"), "button button--primary");

  read.release();
  const again = recovery.getByRole("link", { name: "Deploy again" });
  await again.waitFor();
  assert.equal(await again.getAttribute("class"), "button button--primary");
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
    (route) => route.fulfill(unavailable),
  );
  await page.addInitScript(watchDeployAgain);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = recoveryOf(page);
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  // The draft's Configuration read succeeded, so only the permission answer withholds the link.
  await page.getByRole("button", { name: "Deploy new version" }).waitFor();
  await nextFrames(page);
  assert.equal(await logs.getAttribute("class"), "button button--primary");
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
  await recovery
    .getByText("v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED).", { exact: false })
    .waitFor();
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  // The link used to render with Logs, before any Configuration read.
  assert.equal(await page.evaluate(() => globalThis.openDraftSeen), false);
  await denied;
  await nextFrames(page);
  assert.equal(await logs.getAttribute("class"), "button button--primary");
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
  assert.equal(await logs.getAttribute("class"), "button button--primary");

  read.release();
  await openDraft.waitFor();
});

// While v2 deploys, v1 is still the current version. Right after Deploy new version the page
// selected v2 and called it "Historical" beside "Selected version v1" until the deployment
// finished (finding 2065). Its notice says it is deploying until it becomes current. `record`
// drives the newest deployment's answer: its status, or an error while `fail` holds an HTTP
// status (503, 403, 429); `agentFail` answers the Agent read with a 503. `recordReads` counts the
// newest deployment's reads, and `warnings` are its startup warnings. With `older`, a version
// admitted before the deploying one is neither current nor deploying.
// The record route sends no 429: that one comes from a rate limit in front of the API.
const failure = (status) =>
  status === 429
    ? proxyErrorResponse(429)
    : status === 403
      ? apiErrorResponse(403, "FORBIDDEN", GENERIC_DENIAL)
      : apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again.");
const UNAVAILABLE = failure(503);

async function deployingVersion(t, name, { status = "running", older = false } = {}) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const agent = await fixture.createAgent(namespace.id, `${name} Agent`, nativeValues("v1"));
  const { revision: current } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const previous = older ? await fixture.deployAgent(namespace.id, agent.id) : null;
  const next = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  const record = { status, fail: false, agentFail: false, recordReads: 0, warnings: [] };
  await page.route(
    (url) => url.pathname === `/namespaces/${namespace.id}/agents/${agent.id}`,
    (route) =>
      record.agentFail && route.request().method() === "GET"
        ? route.fulfill(UNAVAILABLE)
        : route.fallback(),
  );
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, next.id), (route) => {
    record.recordReads += 1;
    return record.fail
      ? route.fulfill(failure(record.fail))
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              deploymentId: next.id,
              namespaceId: namespace.id,
              agentId: agent.id,
              status: record.status,
              error:
                record.status === "failed"
                  ? persistedDeploymentError("DEPENDENCY_UNAVAILABLE")
                  : null,
              warnings: record.warnings,
              progress: null,
            },
            meta: { requestId: "req_test_deploying_label" },
          }),
        });
  });
  await page.clock.install({ time: new Date("2026-10-20T12:00:00Z") });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, next.id, "configuration"));
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  const outcome = { queued: "Queued", running: "In progress", succeeded: "Completed" }[status];
  await summary.getByText(`v${next.revision} · ${outcome}`, { exact: true }).waitFor();
  if (status !== "succeeded") {
    await page
      .getByText(
        "Deploying version · read-only admitted snapshot. It becomes the current version only if its deployment completes.",
        { exact: true },
      )
      .waitFor();
  }
  return { fixture, namespace, agent, current, previous, next, page, record, summary };
}

// Every text the version notice shows, in order, from now on.
const watchNotice = (page) =>
  page.evaluate(() => {
    const seen = [];
    globalThis.noticeTexts = seen;
    const note = () => {
      const text = globalThis.document.querySelector(".version-selection-notice")?.textContent;
      if (text && seen.at(-1) !== text) {
        seen.push(text);
      }
    };
    new globalThis.MutationObserver(note).observe(globalThis.document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });

test("A version that is deploying is labelled Deploying, not Historical, until it becomes current", async (t) => {
  const { fixture, namespace, agent, current, next, page, record, summary } =
    await deployingVersion(t, "Deploying label");
  // v1 is still the version selected for service.
  assert.equal(await summary.getByText("v1", { exact: true }).count(), 1);
  assert.equal(await page.getByText(/^Historical version/).count(), 0);

  // v1 itself is still the current version.
  await page.goto(detailUrl(fixture, namespace.id, agent.id, current.id, "configuration").href);
  await page.getByText(/^Current version · read-only admitted snapshot/).waitFor();
  await page.goBack();
  await page.getByText(/^Deploying version · read-only admitted snapshot/).waitFor();

  // Completion makes v2 current, and the notice goes from Deploying to Current with no
  // Historical in between.
  await watchNotice(page);
  await fixture.activateRevision(namespace.id, agent.id, next.id, current.id);
  record.status = "succeeded";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await page.getByText(/^Current version · read-only admitted snapshot/).waitFor();
  await summary.getByText("v2", { exact: true }).waitFor();
  assert.equal(await page.getByText(/^Deploying version/).count(), 0);
  const labels = (await page.evaluate(() => globalThis.noticeTexts)).map(
    (text) => text.split(" ·")[0],
  );
  assert.equal(labels.at(-1), "Current version");
  assert.equal(labels.includes("Historical version"), false, labels.join(" → "));
});

// A Configuration tab parked while the deployment fails shows Failed when it comes back: a failed
// version that never became current is not history (finding 2403).
test("A deploying version's parked Configuration tab says Failed once the deployment fails", async (t) => {
  const { page, record } = await deployingVersion(t, "Deploying parked");
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("tab", { name: "Plugins", exact: true, selected: true }).waitFor();
  record.status = "failed";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await page.getByText("v2 · Failed", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByText(/^Failed version · read-only admitted snapshot/).waitFor();
  assert.equal(await page.getByText(/^Deploying version/).count(), 0);
  assert.equal(await page.getByText(/^Historical version/).count(), 0);
});

// A queued deployment is deploying too, and only the deploying version is: an older version
// browsed meanwhile is Historical (finding 2088).
test("A queued version is labelled Deploying, and an older version browsed meanwhile Historical", async (t) => {
  const { fixture, namespace, agent, previous, page } = await deployingVersion(t, "Queued label", {
    status: "queued",
    older: true,
  });
  await page.goto(detailUrl(fixture, namespace.id, agent.id, previous.id, "configuration").href);
  await page.getByText(/^Historical version · read-only admitted snapshot/).waitFor();
  assert.equal(await page.getByText(/^Deploying version/).count(), 0);
  await page.goBack();
  await page.getByText(/^Deploying version · read-only admitted snapshot/).waitFor();
});

// A completed deployment whose Agent reread failed kept "Deploying" beside "v2 · Completed"
// (finding 2085). The record says the deployment completed, so the notice says so.
test("A completed deployment whose Agent reread fails is labelled Deployed, not Deploying", async (t) => {
  const { fixture, namespace, agent, current, next, page, record, summary } =
    await deployingVersion(t, "Deployed label");
  await watchNotice(page);
  await fixture.activateRevision(namespace.id, agent.id, next.id, current.id);
  record.status = "succeeded";
  record.agentFail = true;
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await page.getByText(`${OVERVIEW_REFRESH_FAILED} ${READ_OUTAGE_REASON}`).waitFor();
  await summary.getByText("v2 · Completed", { exact: true }).waitFor();
  await page
    .getByText(
      "Deployed version · read-only admitted snapshot. Its deployment completed, but the current version could not be refreshed.",
      { exact: true },
    )
    .waitFor();
  const labels = (await page.evaluate(() => globalThis.noticeTexts)).map(
    (text) => text.split(" ·")[0],
  );
  assert.equal(labels.includes("Historical version"), false, labels.join(" → "));
});

for (const [status, label] of [
  ["succeeded", "Completed"],
  ["failed", "Failed"],
]) {
  test(`A ${status} deployment stays visible when the overview returns another Agent`, async (t) => {
    const { fixture, namespace, agent, page, record, summary } = await deployingVersion(
      t,
      "Mismatched overview",
    );
    const agentUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
    await page.route(agentUrl, (route) => replyWithDifferentAgentId(route, agent.id, 200));
    record.status = status;
    await page.getByRole("button", { name: "Refresh deployment" }).click();

    // Wait for either settled outcome: losing the valid record used to show "Unavailable".
    const result = summary.getByText(`v2 · ${label}`, { exact: true });
    await result.or(summary.getByText("v2 · Unavailable", { exact: true })).waitFor();
    assert.equal(await result.isVisible(), true);
    await page
      .getByText(
        "Current version and version history could not be refreshed. Use the page Refresh control to retry.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await summary.getByText("v1", { exact: true }).isVisible(), true);
  });
}

// One failed status read while v2 still deployed flipped the notice to Historical (the finding
// 2065 mislabel) and stopped polling, so it stayed there after the API recovered (finding 2085).
// The notice keeps the last record's label, polling goes on, and a completion read right after
// the failure still rereads the Agent.
test("One failed status read keeps a deploying version Deploying and polling", async (t) => {
  const { fixture, namespace, agent, current, next, page, record, summary } =
    await deployingVersion(t, "Status blip");
  await watchNotice(page);
  record.fail = 503;
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await summary.getByText("v2 · Unavailable", { exact: true }).waitFor();
  assert.equal(await page.getByText(/^Deploying version · /).count(), 1);
  // The next poll still comes, and it finds the deployment completed.
  record.fail = false;
  await fixture.activateRevision(namespace.id, agent.id, next.id, current.id);
  record.status = "succeeded";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await summary.getByText("v2 · Completed", { exact: true }).waitFor();
  await page.getByText(/^Current version · read-only admitted snapshot/).waitFor();
  const labels = (await page.evaluate(() => globalThis.noticeTexts)).map(
    (text) => text.split(" ·")[0],
  );
  assert.equal(labels.includes("Historical version"), false, labels.join(" → "));
});

// A rate limit is not an answer either: a 429 status read leaves the version Deploying and
// polling goes on, as after a 503.
test("A rate-limited status read keeps a deploying version polling", async (t) => {
  const { page, record, summary } = await deployingVersion(t, "Status rate limit");
  record.fail = 429;
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await summary.getByText("v2 · Unavailable", { exact: true }).waitFor();
  assert.equal(await page.getByText(/^Deploying version · /).count(), 1);
  record.fail = false;
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await summary.getByText("v2 · In progress", { exact: true }).waitFor();
});

// A completed record is not by itself a failed reread: the newest version whose record reads
// completed while the Agent still names v1 current (activation not yet seen, or a stopped Agent
// with no current version) stays Historical, not "Deployed" (internal review of finding 2085).
test("A completed record with no failed Agent reread leaves the newest version Historical", async (t) => {
  const { page } = await deployingVersion(t, "Completed unseen", { status: "succeeded" });
  await page.getByText(/^Historical version · read-only admitted snapshot/).waitFor();
  // The tab is built again from what the page knows now.
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("tab", { name: "Plugins", exact: true, selected: true }).waitFor();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByText(/^Historical version · read-only admitted snapshot/).waitFor();
  assert.equal(await page.getByText(/^Deployed version/).count(), 0);
});

// v3 is current but this reader cannot read it, so completed v2 is the newest version listed and
// already known to be older than the current one. A failed Agent reread on Refresh deployment
// changes nothing about that: v2 stays Historical, not Deployed (internal review of finding 2085).
test("A failed reread leaves the newest readable version Historical under a hidden current one", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Hidden current");
  const agent = await fixture.createAgent(namespace.id, "Hidden current Agent", nativeValues("v1"));
  const { revision: first } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const next = await fixture.deployAgent(namespace.id, agent.id);
  const hidden = await fixture.deployAgent(namespace.id, agent.id);
  await fixture.activateRevision(namespace.id, agent.id, hidden.id, first.id);
  fixture.policy.restrictions.push({
    id: `deny-read-${hidden.id}`,
    namespaceId: namespace.id,
    resourceKind: "agent_revision",
    resourceId: hidden.id,
    action: "read",
    effect: "deny",
  });
  const { page } = await newPage(t, fixture, { browser });
  let agentFail = false;
  await page.route(
    (url) => url.pathname === `/namespaces/${namespace.id}/agents/${agent.id}`,
    (route) =>
      agentFail && route.request().method() === "GET"
        ? route.fulfill(UNAVAILABLE)
        : route.fallback(),
  );
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, next.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          deploymentId: next.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status: "succeeded",
          error: null,
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_test_hidden_current" },
      }),
    }),
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, next.id, "configuration"));
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("Newer version hidden", { exact: true }).waitFor();
  await page.getByText(/^Historical version · read-only admitted snapshot/).waitFor();
  agentFail = true;
  await page.getByRole("button", { name: "Refresh deployment" }).click();
  await page.getByText(`${OVERVIEW_REFRESH_FAILED} ${READ_OUTAGE_REASON}`).waitFor();
  await page.getByText(/^Historical version · read-only admitted snapshot/).waitFor();
  assert.equal(await page.getByText(/^Deployed version/).count(), 0);
});

// A failure's card folds Deployment details (finding 2094), but it says nothing of a refresh that
// could not reread the Agent: a Refresh deployment that reads the failure while its Agent read
// fails keeps the details open on that warning, without the reader opening them.
test("A failure read by a refresh that cannot reread the Agent keeps its warning in view", async (t) => {
  const { page, record } = await deployingVersion(t, "Failed refresh");
  record.status = "failed";
  record.agentFail = true;
  await page.getByRole("button", { name: "Refresh deployment" }).click();
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery.waitFor();
  const warning = page.getByText(`${OVERVIEW_REFRESH_FAILED} ${READ_OUTAGE_REASON}`);
  // The panel renders the warning and the card folds the details in one task, so once the
  // warning is in the page the details' state is settled.
  await warning.waitFor({ state: "attached" });
  assert.equal(await deploymentDetailsOpen(page), true);
  assert.equal(await warning.evaluate((node) => node.checkVisibility()), true);
});

// Nor does the card carry a failure's startup warnings: a failure read with warnings keeps the
// details open on them.
test("A failure read with startup warnings keeps them in view", async (t) => {
  const { page, record } = await deployingVersion(t, "Failed warnings");
  record.status = "failed";
  record.warnings = [{ code: "PLUGIN_INSTALL_FAILED", pluginId: "remote-calendar" }];
  await page.getByRole("button", { name: "Refresh deployment" }).click();
  await page.getByRole("region", { name: "Deployment needs attention" }).waitFor();
  const warning = page
    .locator(".deployment-status")
    .getByText("remote-calendar was disabled for this startup", { exact: false });
  await warning.waitFor({ state: "attached" });
  assert.equal(await deploymentDetailsOpen(page), true);
  assert.equal(await warning.evaluate((node) => node.checkVisibility()), true);
});

// A refused record read ends the wait: polling stops, and the version is no longer labelled
// Deploying from a record the page can no longer follow (internal review of finding 2085).
test("A refused status read ends the wait and the Deploying label", async (t) => {
  const { page, record, summary } = await deployingVersion(t, "Status refused");
  record.fail = 403;
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await summary.getByText("v2 · Unavailable", { exact: true }).waitFor();
  await page.getByText(/^Historical version · read-only admitted snapshot/).waitFor();
  const refused = record.recordReads;
  record.fail = false;
  await page.clock.runFor(DEPLOYMENT_POLL_MS * 3);
  assert.equal(record.recordReads, refused);
});
