import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  MODEL_CREDENTIAL_REJECTED_ASK,
  MODEL_CREDENTIAL_REJECTED_READ_ONLY,
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

  // A made-up version ID: the API answers it as it answers a version the reader may not read.
  const madeUp = `rev_${randomUUID()}`;
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, madeUp, "configuration"),
    reader.credentials,
  );
  await page.getByRole("heading", { name: "Version unavailable" }).waitFor();
  await page.getByText(VERSION_UNAVAILABLE, { exact: true }).waitFor();
  // The current version is readable, so the status line speaks only of the requested one.
  const statusLine = page.locator(".agent-status-line");
  await statusLine
    .getByText(requestedVersionUnavailable(shortId(madeUp)), { exact: true })
    .waitFor();
  assert.equal(await page.getByText(/after each deployment/).count(), 0);
  assert.equal(await page.getByText("You cannot read this version").count(), 0);
});

test("a rejected model credential tells a member without Agent update who updates it", async (t) => {
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
  await recovery.getByText(MODEL_CREDENTIAL_REJECTED_ASK).waitFor();
  await page.getByText(MODEL_CREDENTIAL_REJECTED_READ_ONLY, { exact: true }).waitFor();
  // No step the operator cannot take: neither "update or replace" nor a link to Credentials.
  assert.equal(await page.getByText(/update or replace/).count(), 0);
  assert.equal(await recovery.getByRole("link", { name: "Open Credentials" }).count(), 0);
});
