import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  modelCredentialRejectedAsk,
  modelCredentialRejectedReadOnly,
  requestedVersionUnavailable,
  VERSION_UNAVAILABLE,
} from "../helpers/refusal-text.mjs";
import {
  AGENT_READ,
  detailUrl,
  login,
  nativeValues,
  newPage,
  routeFailedDeployment,
} from "./console-agents-browser-helpers.mjs";

// A next step the reader cannot take is a dead end (finding D750). Each page below names what
// the reader can do: ask an Installation administrator, or accept that a version may not exist.

const shortId = (id) => `${id.slice(0, 12)}…${id.slice(-6)}`;

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
