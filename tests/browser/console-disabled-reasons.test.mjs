import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { DIAGNOSTICS_DENIED } from "../helpers/refusal-text.mjs";
import {
  AGENT_READ,
  accessibleDescription,
  detailUrl,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";

// A disabled control whose reason sits nearby but is not linked to it leaves a screen reader
// user with a dead control and no why (finding D749). Each disabled control below is described
// by the sentence a sighted reader sees beside it.

test("a reader's disabled Deploy, diagnostics and authentication controls name their reasons", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Described reader", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Described Agent", nativeValues("why"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const reader = await fixture.createNamespaceMember("described-reader", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);

  // The current version: diagnostics need Agent operate, which a reader lacks.
  const current = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await login(page, fixture, current, reader.credentials);
  await page.getByText(DIAGNOSTICS_DENIED, { exact: true }).waitFor();
  const run = page.getByRole("button", { name: "Run diagnostics for this version" });
  assert.equal(await run.isDisabled(), true);
  assert.equal(await accessibleDescription(run), DIAGNOSTICS_DENIED);

  // The draft: Deploy needs Agent deploy.
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href);
  await page.getByText("Your access does not include deploying this Agent.").waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(
    await accessibleDescription(deploy),
    "Your access does not include deploying this Agent.",
  );

  // Credentials: the method select and Save need Agent update. Both are described by the note
  // under the form, whose text the reader also sees.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  const save = page.getByRole("button", { name: "Save authentication source" });
  await save.waitFor();
  const method = page.locator("#harness-auth-method");
  for (const control of [save, method]) {
    assert.equal(await control.isDisabled(), true);
  }
  const reason = await accessibleDescription(save);
  assert.match(reason, /^Your access does not include /);
  assert.equal(await page.getByText(reason, { exact: true }).isVisible(), true);
  assert.ok((await accessibleDescription(method)).endsWith(reason));
});

test("Configure Slack on an embedded Agent is described by the execution mode", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Described channels", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Embedded Agent", nativeValues("embed"));
  const { page } = await newPage(t, fixture);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "channels"));
  const configure = page.getByRole("button", { name: "Configure Slack" });
  await configure.waitFor();
  assert.equal(await configure.isDisabled(), true);
  assert.equal(
    await accessibleDescription(configure),
    "Channels require Dedicated execution. Embedded Agents can only keep channels disabled.",
  );
});

test("a reader with no readable Namespace hears why the Namespace selector is disabled", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const hidden = await fixture.createNamespace("Not shared", { ready: true });
  fixture.policy.restrictions.push({
    id: "deny-all-namespace-read",
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  const { page } = await newPage(t, fixture);
  for (const [path, text] of [
    [
      "/console/agents",
      "Ask an Installation administrator to create a Namespace or to give you access to one, then Refresh.",
    ],
    [
      `/console/agents?namespace=${hidden.id}`,
      "This Namespace is missing or not shared with you, and you cannot read any other Namespace. Ask an Installation administrator to give you access to one, then Refresh.",
    ],
  ]) {
    if (path === "/console/agents") {
      await login(page, fixture, path);
    } else {
      await page.goto(new URL(path, fixture.origin).href);
    }
    await page.locator(".state-panel").getByText(text, { exact: true }).waitFor();
    const selector = page.getByLabel("Namespace", { exact: true });
    assert.equal(await selector.isDisabled(), true, path);
    assert.equal(await accessibleDescription(selector), text, path);
  }
});

// The no-Namespace panel is the selector's only reason. A page without it, such as an
// administrator's Backends page in an Installation with no Namespace, links no description that
// is not there.
test("the Namespace selector names no missing reason on a page without the no-Namespace panel", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  fixture.policy.restrictions.push({
    id: "deny-all-namespace-read",
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, "/console/backends");
  await page.getByRole("heading", { name: "Backends", exact: true }).waitFor();
  const selector = page.getByLabel("Namespace", { exact: true });
  assert.equal(await selector.isDisabled(), true);
  assert.equal(await page.locator("#namespace-access-reason").count(), 0);
  assert.deepEqual(
    await selector.evaluate((node) =>
      (node.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((id) => id && !globalThis.document.getElementById(id)),
    ),
    [],
  );
});
