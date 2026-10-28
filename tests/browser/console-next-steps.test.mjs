import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  DEPLOYED_VERSION_UNREADABLE,
  deployAcceptedVersionUnreadable,
  MODEL_CREDENTIAL_REJECTED_RECORDED,
  MODEL_CREDENTIAL_REJECTED_REPLACED,
  modelCredentialRejectedAsk,
  modelCredentialRejectedReadOnly,
  requestedVersionUnavailable,
  VERSION_READ_DENIED,
  VERSION_UNAVAILABLE,
  VERSION_READ_DENIED_HEADING,
  READ_ONLY_DRAFT_NOTICE,
} from "../helpers/refusal-text.mjs";
import {
  AGENT_READ,
  authorizationDenials,
  denyRevisionRead,
  detailUrl,
  login,
  nativeValues,
  newPage,
  routeFailedDeployment,
  routeOneVersionPerPage,
  shortId,
  stopAgentButton,
  trackSettledFetches,
  waitForIdleFetches,
  waitForEnabled,
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
  assert.equal(await page.getByText(VERSION_READ_DENIED_HEADING).count(), 0);
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
        denyRevisionRead(fixture, namespace, next);
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
  await page.getByRole("heading", { name: VERSION_READ_DENIED_HEADING, exact: true }).waitFor();
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
    detailUrl(fixture, namespace.id, agent.id, "draft", "deployment"),
    operator.credentials,
  );
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  // The Agent's credential is a Secret, so the text names both grants that fix it: Secret update
  // replaces the value in place, which the permission answer does not cover.
  assert.equal(agent.harnessAuth.source.kind, "secret");
  const access = { secretBacked: true, gap: "update", deploy: true };
  await recovery.getByText(modelCredentialRejectedAsk(access)).waitFor();
  await page.getByText(modelCredentialRejectedReadOnly(access), { exact: true }).waitFor();
  // No step the operator cannot take: neither "update or replace" nor a link to Credentials.
  assert.doesNotMatch(await recovery.innerText(), /update or replace/);
  assert.doesNotMatch(await page.locator(".agent-draft-actions").innerText(), /update or replace/);
  assert.equal(await recovery.getByRole("link", { name: "Open Credentials" }).count(), 0);
  // The deployment record's alert and the Agents list say it in the same words (finding D752).
  const activity = page.getByRole("region", { name: "Deployment activity" });
  await activity
    .getByRole("alert", { includeHidden: true })
    .getByText(`RUNTIME_AUTHENTICATION_FAILED: ${modelCredentialRejectedAsk(access)}`, {
      exact: true,
    })
    .waitFor({ state: "attached" });
  assert.doesNotMatch(await activity.textContent(), /update or replace/);
  await page.goto(new URL(`/console/agents?namespace=${namespace.id}`, page.url()).href);
  const row = page.getByRole("row").filter({ hasText: "Rejected Agent" });
  await row.getByText(modelCredentialRejectedAsk(access), { exact: true }).waitFor();
  assert.doesNotMatch(await row.innerText(), /update or replace/);
});

// The answer allows Agent update but not the Secret grant each Agent update checks, or denies
// Agent deploy: the text names the grant the member lacks and does not tell her to deploy when
// she cannot (finding D752). A member without Secret read cannot see the bound Secret, so no
// text names it, and one who holds every grant the fix needs deploys it.
test("a rejected credential names the grant a member lacks and what deploying needs", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Rejected grants", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Rejected grants", nativeValues("grants"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  assert.equal(agent.harnessAuth.source.kind, "secret");
  // The fixture names the Agent's model credential Secret "Auth <Agent name>".
  const hidden = ["Auth Rejected grants", agent.harnessAuth.source.id].filter(Boolean);
  const members = {
    // Agent update, and Secret update in place, but no Secret operate on the bound Secret.
    editor: [
      ...AGENT_READ,
      ["update", "agent"],
      ["update", "configuration"],
      ["deploy", "agent"],
      ["update", "secret"],
    ],
    // The binding can be saved even though a deployment would be refused.
    bindingEditor: [...AGENT_READ, ["update", "agent"], ["read", "secret"], ["operate", "secret"]],
    // Secret update in place, without Agent deploy.
    updater: [...AGENT_READ, ["operate", "agent"], ["update", "secret"]],
    // Every grant replacing the value in place and deploying it needs.
    deployer: [...AGENT_READ, ["deploy", "agent"], ["update", "secret"], ["operate", "secret"]],
  };
  const expected = {
    editor: { secretBacked: true, gap: "sources", deploy: true },
    updater: { secretBacked: true, gap: "update", deploy: false },
    deployer: { secretBacked: true, gap: "update", deploy: true },
  };
  for (const [label, grants] of Object.entries(members)) {
    const member = await fixture.createNamespaceMember(`rejected-${label}`, namespace.id, grants);
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
      detailUrl(fixture, namespace.id, agent.id, "draft", "deployment"),
      member.credentials,
    );
    const recovery = page.getByRole("region", { name: "Deployment needs attention" });
    if (label === "bindingEditor") {
      const denied =
        "The model provider rejected this version's credential (HTTP 401 or 403). Choose a valid authentication source in Credentials. Your access does not include deploying this Agent. Ask an Installation administrator for Agent deploy on it.";
      await recovery.getByText(denied, { exact: false }).waitFor();
      await page
        .getByRole("region", { name: "Deployment activity" })
        .getByText(`RUNTIME_AUTHENTICATION_FAILED: ${denied}`, { exact: true })
        .waitFor({ state: "attached" });
      assert.doesNotMatch(await recovery.innerText(), /then deploy/i);
      await recovery.getByRole("link", { name: "Open Credentials" }).click();
      const save = page.getByRole("button", { name: "Save authentication source", exact: true });
      await waitForEnabled(save);
      const saved = page.waitForResponse(
        (response) =>
          response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
          response.request().method() === "PATCH",
      );
      await save.click();
      assert.equal((await saved).status(), 200);
      continue;
    }
    await recovery.getByText(modelCredentialRejectedAsk(expected[label])).waitFor();
    await page
      .getByRole("region", { name: "Deployment activity" })
      .getByText(`RUNTIME_AUTHENTICATION_FAILED: ${modelCredentialRejectedAsk(expected[label])}`, {
        exact: true,
      })
      .waitFor({ state: "attached" });
    assert.equal(await recovery.getByRole("link", { name: "Open Credentials" }).count(), 0);
    const text = await recovery.innerText();
    for (const value of hidden) {
      assert.ok(!text.includes(value), `${label}: the hidden Secret is not named`);
    }
    if (label === "editor") {
      assert.doesNotMatch(text, /Agent update on this Agent, which your access does not include/);
      const draft = page.locator(".agent-draft-actions");
      await draft
        .getByText(modelCredentialRejectedReadOnly(expected.editor), { exact: false })
        .waitFor();
      assert.doesNotMatch(await draft.innerText(), /update or replace it in Credentials/);
      assert.equal(await draft.getByRole("button", { name: "Set up credentials" }).count(), 0);
      for (const value of hidden) {
        assert.ok(!(await draft.innerText()).includes(value));
      }
    }
    if (label === "updater") {
      assert.doesNotMatch(text, /Then deploy/);
    }
    if (label === "deployer") {
      const deploy = page.getByRole("button", { name: "Deploy new version" });
      await waitForEnabled(deploy);
      const deployResponse = page.waitForResponse(
        (response) =>
          response.url() ===
            `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy` &&
          response.request().method() === "POST",
      );
      await deploy.click();
      assert.equal((await deployResponse).status(), 202);
    }
  }
});

// The deployment record keeps the API's next step for a caller who may change the credential.
// Once the Agent binds another credential, the failure no longer asks for anything: it is not an
// alert next to "Ready to deploy." (finding D752).
test("a rejected credential's record stops alerting once the Agent binds another credential", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Rebound credential", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Rebound Agent", nativeValues("rebound"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await routeFailedDeployment(page, fixture, {
    namespaceId: namespace.id,
    agentId: agent.id,
    deploymentId: revision.id,
    code: "RUNTIME_AUTHENTICATION_FAILED",
  });
  const draft = detailUrl(fixture, namespace.id, agent.id, "draft", "deployment");
  await login(page, fixture, draft);
  const activity = page.getByRole("region", { name: "Deployment activity" });
  const recorded = `RUNTIME_AUTHENTICATION_FAILED: ${MODEL_CREDENTIAL_REJECTED_RECORDED}`;
  await activity
    .getByRole("alert", { includeHidden: true })
    .getByText(recorded, { exact: true })
    .waitFor({ state: "attached" });

  // The administrator binds another Secret; the next deployment uses it.
  const replacement = await fixture.createSecret(namespace.id, "rebound-key", "test-api-key-2");
  await fixture.grantAgentSecretOperate(agent, replacement.ref);
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: replacement.ref },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await activity
    .getByText(`RUNTIME_AUTHENTICATION_FAILED: ${MODEL_CREDENTIAL_REJECTED_REPLACED}`, {
      exact: true,
    })
    .waitFor({ state: "attached" });
  assert.equal(await activity.getByRole("alert", { includeHidden: true }).count(), 0);
  assert.equal(await activity.getByText(recorded).count(), 0);

  // Another tab restores the rejected binding. Refresh deployment rereads the Agent without
  // remounting the page; the recorded failure must become actionable again.
  async function refreshDeploymentWithBinding(expected) {
    const reread = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
        response.request().method() === "GET",
    );
    await activity.getByRole("button", { name: "Refresh deployment", exact: true }).click();
    const response = await reread;
    assert.equal(response.status(), 200);
    assert.deepEqual((await response.json()).data.harnessAuth, expected);
  }

  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: agent.harnessAuth,
  });
  await refreshDeploymentWithBinding(agent.harnessAuth);
  await activity
    .getByRole("alert", { includeHidden: true })
    .getByText(recorded)
    .waitFor({ state: "attached" });
  assert.equal(
    await activity.getByText(MODEL_CREDENTIAL_REJECTED_REPLACED, { exact: false }).count(),
    0,
  );

  const rebound = await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: replacement.ref },
  });
  await refreshDeploymentWithBinding(rebound.harnessAuth);
  await activity
    .getByText(MODEL_CREDENTIAL_REJECTED_REPLACED, { exact: false })
    .waitFor({ state: "attached" });
  assert.equal(await activity.getByRole("alert", { includeHidden: true }).count(), 0);

  // Detaching the source is not a replacement. No new credential is available to deploy.
  const detached = await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: null,
  });
  assert.equal(detached.harnessAuth, null);
  await refreshDeploymentWithBinding(null);
  await activity
    .getByRole("alert", { includeHidden: true })
    .getByText(recorded)
    .waitFor({ state: "attached" });
  assert.equal(
    await activity.getByText(MODEL_CREDENTIAL_REJECTED_REPLACED, { exact: false }).count(),
    0,
  );
});

// A member who may deploy but holds AgentRevision read per version. The Deploy answer creates a
// version her read does not cover: the policy denies it before the console reads it, as when an
// administrator grants read on each version after it exists (docs/guides/topics/iam.md).
async function deployWithoutVersionRead(t, name) {
  const auditSink = new InMemoryAuditSink();
  const { fixture, namespace } = await createRuntimeAuthFixture(t, name, { auditSink });
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
      denyRevisionRead(fixture, namespace, { id });
      await route.fulfill({ response });
    },
  );
  // Each refused version read is audited as a denial the member never attempted (finding D758).
  const versionReadDenials = () => authorizationDenials(auditSink, "openclaw.agent_revisions.read");
  return { fixture, namespace, agent, deployer, page, deployed, versionReadDenials };
}

// The version a member just deployed exists: the API accepted it. #3721's hedge for edited links
// ("does not exist or your access does not include it", with Retry) told her otherwise (finding
// D751). A refused version is settled, so its panel offers no Retry or request ID; the page
// Refresh checks access again (finding D753). The version list, which audits nothing it leaves
// out, already shows she cannot read it, so the page never reads it (finding D758).
test("a member's own deploy of a version she cannot read is accepted, not possibly missing", async (t) => {
  const { fixture, namespace, agent, deployer, page, deployed, versionReadDenials } =
    await deployWithoutVersionRead(t, "Accepted unreadable");
  await trackSettledFetches(page);
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
  // The summary card says the same as after a redeploy, not "None. No readable deployments."
  // (finding D755).
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("Deployment accepted", { exact: true }).waitFor();
  await summary.getByText(DEPLOYED_VERSION_UNREADABLE, { exact: true }).waitFor();
  assert.equal(await summary.getByText("No readable deployments.").count(), 0);
  const panel = page.locator(".state-panel");
  await panel.getByRole("heading", { name: VERSION_READ_DENIED_HEADING, exact: true }).waitFor();
  await panel.getByText(VERSION_READ_DENIED, { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Retry" }).count(), 0);
  assert.equal(await panel.getByText(/^Request ID/).count(), 0);
  assert.equal(await page.getByText(/does not exist/).count(), 0);
  assert.equal(await page.getByText("Viewed version unavailable").count(), 0);
  // Nothing readable says what runs, so Stop stays: the API answers if nothing does.
  await stopAgentButton(page).waitFor();
  await waitForIdleFetches(page);
  assert.deepEqual(versionReadDenials(), []);

  // The page Refresh checks the version list again, which still leaves the version out. The
  // rebuilt page replaces the panel.
  const shownPanel = await panel.elementHandle();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await shownPanel.waitForElementState("hidden");
  await panel.getByRole("heading", { name: VERSION_READ_DENIED_HEADING, exact: true }).waitFor();
  await page
    .locator(".agent-status-line")
    .getByText(deployAcceptedVersionUnreadable(shortId(id)), { exact: true })
    .waitFor();
  await waitForIdleFetches(page);
  assert.deepEqual(versionReadDenials(), []);

  // Once read is granted, the page Refresh shows the version: the tab does not keep the denial.
  fixture.policy.restrictions.length = 0;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByLabel("Viewing version", { exact: true })
    .getByRole("option", { selected: true })
    .filter({ hasText: /^v1/ })
    .waitFor({ state: "attached" });
  assert.equal(await page.getByRole("heading", { name: VERSION_READ_DENIED_HEADING }).count(), 0);
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
  assert.equal(await stopAgentButton(page).count(), 0);

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
    .getByText(`${DEPLOYED_VERSION_UNREADABLE} v1 (Failed) is older.`, { exact: true })
    .waitFor();
  await stopAgentButton(page).waitFor();
  assert.equal(await recovery.count(), 0);
  assert.equal(await page.getByText(/does not exist/).count(), 0);
  // The older page is still unread, so the list is incomplete.
  assert.equal(
    await page.getByRole("button", { name: "Load older versions", exact: true }).count(),
    paged ? 1 : 0,
  );

  // The draft entry says the same: the accepted deployment, not v1's failure, and Stop stays.
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.waitForURL(/revision=draft/);
  // The URL changes before the draft page replaces the version page.
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  await page
    .locator(".agent-status-line")
    .getByText(deployAcceptedVersionUnreadable(shortId(id)), { exact: true })
    .waitFor();
  await summary.getByText("Deployment accepted", { exact: true }).waitFor();
  await stopAgentButton(page).waitFor();
  assert.equal(await recovery.count(), 0);
}

test("a redeploy the member cannot read leads with the accepted deployment and keeps Stop", (t) =>
  redeployUnreadable(t, "Redeploy unreadable"));

// An Agent with more than one page of versions (the API lists 50 per page). The accepted version
// is newer than every listed one, so it cannot be on an older page that is not loaded yet: the
// page still leads with it and keeps Stop (finding 2615).
test("a redeploy the member cannot read leads with the accepted deployment with an older page of versions", (t) =>
  redeployUnreadable(t, "Redeploy unreadable paged", { paged: true }));
