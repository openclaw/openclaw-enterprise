import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  deployAcceptedVersionUnreadable,
  modelCredentialRejectedAsk,
  modelCredentialRejectedReadOnly,
  requestedVersionUnavailable,
  VERSION_READ_DENIED,
  VERSION_UNAVAILABLE,
} from "../helpers/refusal-text.mjs";
import {
  AGENT_READ,
  detailUrl,
  login,
  nativeValues,
  newPage,
  routeFailedDeployment,
  routeOneVersionPerPage,
  shortId,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";

// A next step the reader cannot take is a dead end (finding D750). Each page below names what
// the reader can do: ask an Installation administrator, or accept that a version may not exist.

test("a version link the page cannot list says the version may not exist", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Edited version link", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Linked Agent", nativeValues("link"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const reader = await fixture.createNamespaceMember("link-reader", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);

  // A made-up version ID. With read on every version the API answers it as missing (404); a
  // reader granted read per version gets the answer a version they may not read gets (403,
  // console-agent-state.test.mjs). Both say the version may not exist.
  const madeUp = `rev_${randomUUID()}`;
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, madeUp, "configuration"),
    reader.credentials,
  );
  await page.getByRole("heading", { name: "Version not found or not shared" }).waitFor();
  await page.getByText(VERSION_UNAVAILABLE, { exact: true }).waitFor();
  // The current version is readable, so the status line speaks only of the requested one.
  const statusLine = page.locator(".agent-status-line");
  await statusLine
    .getByText(requestedVersionUnavailable(shortId(madeUp)), { exact: true })
    .waitFor();
  assert.equal(await page.getByText(/after each deployment/).count(), 0);
  assert.equal(await page.getByText("You cannot read this version").count(), 0);
});

test("a version link stays hedged when the reader can read no version", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("No readable versions", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Unlisted Agent", nativeValues("none"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // Agent read without AgentRevision read: the Versions list is empty for this reader.
  const reader = await fixture.createNamespaceMember(
    "no-version-reader",
    namespace.id,
    AGENT_READ.filter(([, kind]) => kind !== "agent_revision"),
  );
  const { page } = await newPage(t, fixture);

  const madeUp = `rev_${randomUUID()}`;
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, madeUp, "configuration"),
    reader.credentials,
  );
  await page.getByRole("heading", { name: "Version not found or not shared" }).waitFor();
  // The requested version is not the current one, so it may not exist either.
  const statusLine = page.locator(".agent-status-line");
  await statusLine
    .getByText(requestedVersionUnavailable(shortId(madeUp)), { exact: true })
    .waitFor();
  assert.equal(await page.getByText(/after each deployment/).count(), 0);
});

// A version the page lists exists. When the reader's read on it is revoked between the list read
// and the version's own read, the page says the reader cannot read it, not that it may not exist.
test("a listed version the reader can no longer read is not called possibly missing", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked version", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Revoked Agent", nativeValues("rev"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const next = await fixture.deployAgent(namespace.id, agent.id);
  const reader = await fixture.createNamespaceMember("revoked-reader", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);
  const listPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  const listed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === listPath && response.request().method() === "GET",
  );
  await page.route(
    (url) => url.origin === fixture.origin && url.pathname === `${listPath}/${next.id}`,
    async (route) => {
      // The list has shown v2; the grant is revoked before v2's own read.
      await listed;
      if (!fixture.policy.restrictions.some((item) => item.id === `deny-read-${next.id}`)) {
        fixture.policy.restrictions.push({
          id: `deny-read-${next.id}`,
          namespaceId: namespace.id,
          resourceKind: "agent_revision",
          resourceId: next.id,
          action: "read",
          effect: "deny",
        });
      }
      await route.continue();
    },
  );

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, next.id, "configuration"),
    reader.credentials,
  );
  await page.getByRole("heading", { name: "You cannot read this version" }).waitFor();
  assert.equal(await page.getByText("Version not found or not shared").count(), 0);
});

test("a rejected model credential tells a member without Agent update which grants fix it", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Rejected for operator", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Rejected Agent", nativeValues("rej"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // An operator who may deploy and use the Agent's Secret, but not change the Agent.
  const operator = await fixture.createNamespaceMember("rejected-operator", namespace.id, [
    ...AGENT_READ,
    ["operate", "agent"],
    ["deploy", "agent"],
    ["read", "secret"],
    ["operate", "secret"],
  ]);
  const { page } = await newPage(t, fixture);
  await routeFailedDeployment(page, fixture, {
    namespaceId: namespace.id,
    agentId: agent.id,
    deploymentId: revision.id,
    code: "RUNTIME_AUTHENTICATION_FAILED",
  });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    operator.credentials,
  );
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  // The Agent's credential is a Secret, so the text names both grants that fix it: Secret update
  // replaces the value in place, which the permission answer does not cover.
  assert.equal(agent.harnessAuth.source.kind, "secret");
  await recovery.getByText(modelCredentialRejectedAsk(true)).waitFor();
  await page.getByText(modelCredentialRejectedReadOnly(true), { exact: true }).waitFor();
  // No step the operator cannot take: neither "update or replace" nor a link to Credentials.
  // The folded Deployment details keep the API's recorded message as it was recorded.
  assert.doesNotMatch(await recovery.innerText(), /update or replace/);
  assert.doesNotMatch(await page.locator(".agent-draft-actions").innerText(), /update or replace/);
  assert.equal(await recovery.getByRole("link", { name: "Open Credentials" }).count(), 0);
});

// A member who may deploy but holds AgentRevision read per version. The Deploy answer creates a
// version her read does not cover: the policy denies it before the console reads it, as when an
// administrator grants read on each version after it exists (docs/guides/topics/iam.md).
async function deployWithoutVersionRead(t, name) {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, name);
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("accepted"), {
    harnessAuth: { method: "runtime" },
  });
  const deployer = await fixture.createNamespaceMember(`${agent.id}-deployer`, namespace.id, [
    ...AGENT_READ,
    ["deploy", "agent"],
    ["operate", "agent"],
  ]);
  const { page } = await newPage(t, fixture);
  const deployed = [];
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const id = body.data?.id ?? body.id;
      deployed.push(id);
      fixture.policy.restrictions.push({
        id: `deny-read-${id}`,
        namespaceId: namespace.id,
        resourceKind: "agent_revision",
        resourceId: id,
        action: "read",
        effect: "deny",
      });
      await route.fulfill({ response });
    },
  );
  return { fixture, namespace, agent, deployer, page, deployed };
}

const stopButton = (page) =>
  page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByRole("button", { name: "Stop Agent", exact: true });

// The version a member just deployed exists: the API accepted it. #3721's hedge for edited links
// ("does not exist or your access does not include it", with Retry) told her otherwise (finding
// D751). A refused version is settled, so its panel offers no Retry or request ID; the page
// Refresh checks access again (finding D753).
test("a member's own deploy of a version she cannot read is accepted, not possibly missing", async (t) => {
  const { fixture, namespace, agent, deployer, page, deployed } = await deployWithoutVersionRead(
    t,
    "Accepted unreadable",
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    deployer.credentials,
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  await page.waitForURL(/revision=rev_/);
  const [id] = deployed;
  await page
    .locator(".agent-status-line")
    .getByText(deployAcceptedVersionUnreadable(shortId(id)), { exact: true })
    .waitFor();
  const panel = page.locator(".state-panel");
  await panel.getByRole("heading", { name: "You cannot read this version" }).waitFor();
  await panel.getByText(VERSION_READ_DENIED, { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Retry" }).count(), 0);
  assert.equal(await panel.getByText(/^Request ID/).count(), 0);
  assert.equal(await page.getByText(/does not exist/).count(), 0);
  assert.equal(await page.getByText("Viewed version unavailable").count(), 0);
  // Nothing readable says what runs, so Stop stays: the API answers if nothing does.
  await stopButton(page).waitFor();

  // Once read is granted, the page Refresh shows the version: the tab does not keep the denial.
  fixture.policy.restrictions.length = 0;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "You cannot read this version" }).count(),
    0,
  );
});

// After a failed first deployment the member deploys again. The failure is the newest version she
// can read, but the version she just deployed is newer: the page leads with the accepted
// deployment instead of the old failure, and keeps Stop for it (findings D751, D691).
async function redeployUnreadable(t, name, { paged = false } = {}) {
  const { fixture, namespace, agent, deployer, page, deployed } = await deployWithoutVersionRead(
    t,
    name,
  );
  const first = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedDeployment(page, fixture, {
    namespaceId: namespace.id,
    agentId: agent.id,
    deploymentId: first.id,
  });
  if (paged) {
    // The first page lists v1 and says older versions exist; nothing here loads the older page.
    await routeOneVersionPerPage(page, fixture, namespace, agent);
  }
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    deployer.credentials,
  );
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery.waitFor();
  // A failed first deployment leaves nothing to stop (finding D691).
  assert.equal(await stopButton(page).count(), 0);

  await page.getByRole("button", { name: "Deploy new version" }).click();
  await page.waitForURL(/revision=rev_/);
  const [id] = deployed;
  assert.notEqual(id, first.id);
  await page
    .locator(".agent-status-line")
    .getByText(deployAcceptedVersionUnreadable(shortId(id)), { exact: true })
    .waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("Deployment accepted", { exact: true }).waitFor();
  await summary
    .getByText("You cannot read the version you deployed. v1 (Failed) is older.")
    .waitFor();
  await stopButton(page).waitFor();
  assert.equal(await recovery.count(), 0);
  assert.equal(await page.getByText(/does not exist/).count(), 0);
  // The older page is still unread, so the list is incomplete.
  assert.equal(
    await page.getByRole("button", { name: "Show older versions", exact: true }).count(),
    paged ? 1 : 0,
  );

  // The draft entry says the same: the accepted deployment, not v1's failure, and Stop stays.
  await page.getByRole("button", { name: "Open version draft", exact: true }).click();
  await page.waitForURL(/revision=draft/);
  // The URL changes before the draft page replaces the version page.
  await page.getByText(/^Version draft · read-only with your access/).waitFor();
  await page
    .locator(".agent-status-line")
    .getByText(deployAcceptedVersionUnreadable(shortId(id)), { exact: true })
    .waitFor();
  await summary.getByText("Deployment accepted", { exact: true }).waitFor();
  await stopButton(page).waitFor();
  assert.equal(await recovery.count(), 0);
}

test("a redeploy the member cannot read leads with the accepted deployment and keeps Stop", (t) =>
  redeployUnreadable(t, "Redeploy unreadable"));

// An Agent with more than one page of versions (the API lists 50 per page). The accepted version
// is newer than every listed one, so it cannot be on an older page that is not loaded yet: the
// page still leads with it and keeps Stop (finding 2615).
test("a redeploy the member cannot read leads with the accepted deployment with an older page of versions", (t) =>
  redeployUnreadable(t, "Redeploy unreadable paged", { paged: true }));
