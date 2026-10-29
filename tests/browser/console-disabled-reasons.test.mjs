import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  AGENT_DEPLOY_NOT_INCLUDED,
  CHANNELS_NEED_DEDICATED,
  DIAGNOSTICS_DENIED,
  SLACK_SETUP_HINT,
} from "../helpers/refusal-text.mjs";
import {
  AGENT_READ,
  accessibleDescription,
  detailUrl,
  hasFocus,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";
import { restrict } from "../helpers/iam-grants.mjs";

// The shipped default Preset, so Create Agent offers "Start with default Preset".
const DEFAULT_CODEX_PRESET = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

// Socket Mode Slack reading its two tokens from SLACK_APP_TOKEN and SLACK_BOT_TOKEN.
const SLACK_CHANNEL = {
  enabled: true,
  mode: "socket",
  appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
  botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
  dmPolicy: "allowlist",
  groupPolicy: "allowlist",
  allowFrom: ["U123"],
  channels: { C123: { requireMention: true } },
};

// A disabled control whose reason sits nearby but is not linked to it leaves a screen reader
// user with a dead control and no why (finding D749). Each disabled control below is described
// by the sentence a sighted reader sees beside it.

// A natively disabled control is out of the Tab order, so a keyboard reader never reaches it or
// its reason (finding 2878). An unavailable control with a reason is aria-disabled instead: Tab
// reaches it, it is described by the reason, and Enter or Space does nothing. Nothing runs: no
// handler changes its reason or moves focus, no form submits, no checkbox flips or edits the
// Configuration, and nothing is written.
async function expectReachableReason(page, control, reason) {
  await control.waitFor();
  await page.evaluate(() => {
    globalThis.document.activeElement?.blur();
    globalThis.unavailableActivations = [];
    for (const type of ["submit", "change", "input"]) {
      globalThis.document.addEventListener(
        type,
        () => globalThis.unavailableActivations.push(type),
        { capture: true },
      );
    }
  });
  let presses = 0;
  while (!(await hasFocus(control))) {
    assert.ok(++presses <= 200, `Tab reaches ${reason}`);
    await page.keyboard.press("Tab");
  }
  const state = () =>
    control.evaluate((node) => ({
      focused: node === globalThis.document.activeElement,
      disabled: node.disabled,
      ariaDisabled: node.getAttribute("aria-disabled"),
      checked: node.type === "checkbox" ? node.checked : null,
    }));
  const before = await state();
  assert.deepEqual(before, {
    focused: true,
    disabled: false,
    ariaDisabled: "true",
    checked: before.checked,
  });
  assert.equal(await accessibleDescription(control), reason);
  const writes = [];
  const onRequest = (request) => {
    if (!["GET", "HEAD"].includes(request.method())) {
      writes.push(`${request.method()} ${request.url()}`);
    }
  };
  page.on("request", onRequest);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  page.off("request", onRequest);
  assert.deepEqual(await state(), before);
  assert.equal(await accessibleDescription(control), reason);
  assert.deepEqual(await page.evaluate(() => globalThis.unavailableActivations), []);
  assert.deepEqual(writes, []);
}

test("a reader's disabled Deploy, diagnostics and authentication controls name their reasons", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Described reader", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Described Agent", nativeValues("why"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const reader = await fixture.createNamespaceMember("described-reader", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);

  // The current version: diagnostics need Agent operate, which a reader lacks.
  const current = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "deployment");
  await login(page, fixture, current, reader.credentials);
  await page.getByText(DIAGNOSTICS_DENIED, { exact: true }).waitFor();
  const run = page.getByRole("button", { name: "Run diagnostics for this version" });
  assert.equal(await run.isDisabled(), true);
  assert.equal(await accessibleDescription(run), DIAGNOSTICS_DENIED);

  // The draft: Deploy needs Agent deploy.
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href);
  await page.getByText(AGENT_DEPLOY_NOT_INCLUDED, { exact: true }).waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  assert.equal(await deploy.isDisabled(), true);
  await expectReachableReason(page, deploy, AGENT_DEPLOY_NOT_INCLUDED);
  // The Configuration tab's Strict mode and Gateway toggles are read-only for a reader.
  for (const name of ["Strict mode", "Other participants can steer a running turn"]) {
    const toggle = page.getByRole("checkbox", { name, exact: true });
    assert.equal(await toggle.isDisabled(), true);
    const help = await toggle.evaluate(
      (node) => globalThis.document.getElementById(`${node.id}-hint`)?.textContent?.trim() ?? "",
    );
    await expectReachableReason(
      page,
      toggle,
      [help, "These settings are read-only with your access."].filter(Boolean).join(" "),
    );
  }

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
  assert.equal(await accessibleDescription(configure), CHANNELS_NEED_DEDICATED);
  // An Embedded Agent cannot have channels, so the card asks for no Slack token Secrets
  // (finding D708).
  assert.equal(await page.getByText(SLACK_SETUP_HINT).count(), 0);
});

// The no-Namespace panel is the selector's only reason. A page without it, such as an
// administrator's Backends page in an Installation with no Namespace, links no description that
// is not there.
test("the Namespace selector names no missing reason on a page without the no-Namespace panel", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  restrict(fixture.policy, "read", "namespace");
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

// Finding D793. Save plugin selections, Discard changes, Save channel Secrets and Use Preset were
// disabled with a sentence beside them that no control named. Each is described by it now.
test("a draft's disabled Save and Discard name their reasons", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Described draft", { ready: true });
  const tokens = [
    await fixture.createSecret(namespace.id, "Described Slack app token", "xapp-described"),
    await fixture.createSecret(namespace.id, "Described Slack bot token", "xoxb-described"),
  ];
  const bound = (secret) => ({ source: secret.ref, delivery: { type: "env" } });
  const agent = await fixture.createAgent(
    namespace.id,
    "Described Slack Agent",
    nativeValues("slack", { harnessId: "codex", channels: { slack: SLACK_CHANNEL } }),
    {
      executionMode: "dedicated",
      secretBindings: { SLACK_APP_TOKEN: bound(tokens[0]), SLACK_BOT_TOKEN: bound(tokens[1]) },
    },
  );
  const { page } = await newPage(t, fixture);
  const describedBy = async (control, reason) => {
    await control.waitFor();
    assert.equal(await control.isDisabled(), true);
    assert.equal(await page.getByText(reason, { exact: true }).isVisible(), true);
    await expectReachableReason(page, control, reason);
  };

  // Both Slack tokens are bound, and nothing changed.
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await describedBy(
    page.getByRole("button", { name: "Save channel Secrets" }),
    "No channel Secret changes to save.",
  );

  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  for (const name of ["Save plugin selections", "Discard changes"]) {
    await describedBy(page.getByRole("button", { name }), "No plugin changes to save.");
  }
});

// Use Preset waits for a Preset; the status line under the chooser says so.
test("Use Preset names the Preset still to choose as its reason", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [DEFAULT_CODEX_PRESET] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Described Preset", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  const reason = "Choose a Preset or start with the default Preset.";
  await page.getByRole("status").filter({ hasText: reason }).waitFor();
  const use = page.getByRole("button", { name: "Use Preset" });
  assert.equal(await use.isDisabled(), true);
  await expectReachableReason(page, use, reason);
});

// A Slack token without a Secret is the reason too.
test("Save channel Secrets names an unbound Slack token as its reason", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unbound Slack", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Unbound Slack Agent",
    nativeValues("unbound", { harnessId: "codex", channels: { slack: SLACK_CHANNEL } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const save = page.getByRole("button", { name: "Save channel Secrets" });
  await save.waitFor();
  assert.equal(await save.isDisabled(), true);
  const reason = "Choose a Secret for each Slack token to save.";
  assert.equal(await page.getByText(reason, { exact: true }).isVisible(), true);
  await expectReachableReason(page, save, reason);
});
