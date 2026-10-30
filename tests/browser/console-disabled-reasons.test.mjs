import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.mjs";
import {
  AGENT_CREATE_DENIED,
  AGENT_DEPLOY_NOT_INCLUDED,
  CHANNELS_NEED_DEDICATED,
  DIAGNOSTICS_DENIED,
  SECRET_CREATE_DENIED,
  SLACK_SETUP_HINT,
} from "../helpers/refusal-text.mjs";
import {
  AGENT_READ,
  accessibleDescription,
  detailUrl,
  expectReachableReason,
  grantInstallationAdministration,
  holdRequests,
  login,
  nativeValues,
  newPage,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { slackAgentValues, slackTokenBindings } from "./console-slack-agent.mjs";
import { enterManualModel } from "./console-agents-test-support.mjs";
import { restrict } from "../helpers/iam-grants.mjs";

// The shipped default Preset, so Create Agent offers "Start with default Preset".
const DEFAULT_CODEX_PRESET = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

// A disabled control whose reason sits nearby but is not linked to it leaves a screen reader
// user with a dead control and no why (finding D749). Each disabled control below is described
// by the sentence a sighted reader sees beside it.

test("a reader's disabled Deploy, diagnostics and authentication controls name their reasons", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Described reader");
  const agent = await fixture.createAgent(namespace.id, "Described Agent", nativeValues("why"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // An Agent bound to an issued service account. Issuance is outside the console: seed its stored
  // result, as the Credentials tests do.
  const issued = await fixture.controller.transact(async (state) => {
    const created = await state.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: "Described issued account",
    });
    return state.serviceAccounts.updateCredential(namespace.id, created.id, {
      kind: "access_token",
      secretRef: { name: "described-issued-account", key: "token" },
    });
  });
  const issuedAgent = await fixture.createAgent(
    namespace.id,
    "Described issued Agent",
    nativeValues("issued", { harnessId: "codex" }),
    {
      executionMode: "dedicated",
      harnessAuth: {
        method: "codex_pat",
        source: { kind: "service_account", namespaceId: namespace.id, id: issued.id },
      },
    },
  );
  const reader = await fixture.createNamespaceMember("described-reader", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);

  // The current version: diagnostics need Agent operate, which a reader lacks.
  const current = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "deployment");
  await login(page, fixture, current, reader.credentials);
  await page.getByText(DIAGNOSTICS_DENIED, { exact: true }).waitFor();
  const run = page.getByRole("button", { name: "Run diagnostics for this version" });
  assert.equal(await run.isDisabled(), true);
  await expectReachableReason(page, run, DIAGNOSTICS_DENIED);

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
  // under the form, whose text the reader also sees. The API key Secret field's own status says
  // what is bound.
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
  await expectReachableReason(page, method, await accessibleDescription(method));
  await expectReachableReason(page, save, reason);
  const apiKey = page.getByRole("combobox", { name: "API key Secret", exact: true });
  const status = page.locator("#harness-auth-secret-status");
  await status.filter({ hasNotText: "Loading" }).filter({ hasText: /\S/ }).waitFor();
  const bound = (await status.textContent())?.trim();
  await expectReachableReason(page, apiKey, bound);

  // An issued-account source: its account select needs Agent update too, and the same note says
  // why (finding 2925).
  await page.goto(detailUrl(fixture, namespace.id, issuedAgent.id, "draft", "credentials").href);
  const account = page.getByLabel("Issued ChatGPT service account", { exact: true });
  await page.getByText(reason, { exact: true }).waitFor();
  assert.equal(await account.inputValue(), issued.id);
  await expectReachableReason(page, account, reason);
});

// Finding 2899: the Agents list, Secrets and Slack token controls a reader cannot use were
// natively disabled, so Tab skipped them and their reasons.
test("a reader reaches the list, Secret and Slack token controls they cannot use, and why", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Reachable reader");
  const tokens = [
    await fixture.createSecret(namespace.id, "Reachable Slack app token", "xapp-reachable"),
    await fixture.createSecret(namespace.id, "Reachable Slack bot token", "xoxb-reachable"),
  ];
  // A running Agent for the row's Stop and Delete, and a Slack draft for the token fields.
  const running = await fixture.createAgent(namespace.id, "Reachable Agent", nativeValues("run"));
  await fixture.seedActiveAgentRevision(namespace.id, running.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "Reachable Slack Agent",
    slackAgentValues("reach"),
    slackTokenBindings(...tokens),
  );
  const reader = await fixture.createNamespaceMember("reachable-reader", namespace.id, [
    ...AGENT_READ,
    ["read", "secret"],
  ]);
  const { page } = await newPage(t, fixture);

  // The Agents list: Create Agent needs Agent create; the row's Stop and Delete need Agent
  // operate and delete, which the row's note names once its permission answer arrives.
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, reader.credentials);
  await expectReachableReason(
    page,
    page.getByRole("button", { name: "Create Agent", exact: true }),
    AGENT_CREATE_DENIED,
  );
  for (const name of ["Stop Reachable Agent", "Delete Reachable Agent"]) {
    const icon = page.locator(`button[aria-label="${name}"][aria-disabled="true"]`);
    await icon.waitFor();
    const reason = await accessibleDescription(icon);
    assert.match(reason, /Agent operate and Agent delete/);
    await expectReachableReason(page, icon, reason);
  }

  // Secrets: Create Secret needs Secret create.
  await page.goto(new URL(`/console/secrets?namespace=${namespace.id}`, fixture.origin).href);
  await expectReachableReason(
    page,
    page.getByRole("button", { name: "Create Secret", exact: true }),
    SECRET_CREATE_DENIED,
  );

  // Credentials: each read-only Slack token field's status says what is bound.
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href);
  for (const name of ["Slack app token", "Slack bot token"]) {
    const field = page.getByRole("combobox", { name, exact: true });
    await field.waitFor();
    const status = page.locator(`#${await field.getAttribute("id")}-status`);
    await status.filter({ hasNotText: "Loading" }).filter({ hasText: /\S/ }).waitFor();
    await expectReachableReason(page, field, (await status.textContent())?.trim());
  }
});

// Configure Slack stays in the Tab order while that reason shows (class of finding 2899).
test("Configure Slack on an embedded Agent is described by the execution mode", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Described channels");
  const agent = await fixture.createAgent(namespace.id, "Embedded Agent", nativeValues("embed"));
  const { page } = await newPage(t, fixture);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "channels"));
  const configure = page.getByRole("button", { name: "Configure Slack" });
  await configure.waitFor();
  assert.equal(await configure.isDisabled(), true);
  assert.equal(await accessibleDescription(configure), CHANNELS_NEED_DEDICATED);
  await expectReachableReason(page, configure, CHANNELS_NEED_DEDICATED);
  assert.equal(await page.getByRole("dialog").count(), 0);
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

// Finding 2936: with no readable Namespace, the header's selector was natively disabled, so Tab
// skipped it and the no-Namespace panel that says why. It stays in the Tab order, described by
// that panel, and changes nothing.
test("the Namespace selector with no readable Namespace is reachable and names the panel", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  await fixture.createNamespace("Hidden from the reader", { ready: true });
  restrict(fixture.policy, "read", "namespace");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, "/console/agents");
  const reason = page.locator("#namespace-access-reason");
  await reason.waitFor();
  const selector = page.getByLabel("Namespace", { exact: true });
  assert.equal(await selector.isDisabled(), true);
  await expectReachableReason(page, selector, (await reason.textContent())?.trim());
  assert.equal(new URL(page.url()).pathname, "/console/agents");
});

// Finding 2937: with no default Preset, Start with default Preset was natively disabled with no
// reason. The hint beside it says why, describes it, and stays when another Preset is chosen
// (the chooser's status line changes then).
test("Start with default Preset names the missing default as its reason", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "No default Preset", {
    defaultPresets: [],
    filesystemConfiguration: true,
  });
  const other = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: { name: "Team Preset", template: { agent: { name: "Team Agent" } } },
  });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  const reason = "default-codex is not available to you in this Namespace.";
  await page.getByText(reason, { exact: true }).waitFor();
  const shortcut = page.getByRole("button", { name: "Start with default Preset", exact: true });
  assert.equal(await shortcut.isDisabled(), true);
  await expectReachableReason(page, shortcut, reason);
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
  // The chooser's status line does not repeat the hint (finding 2946), and it still describes
  // the unavailable Use Preset.
  const choose = "Choose a Preset.";
  await page
    .getByRole("status")
    .filter({ hasText: /^Choose a Preset\.$/ })
    .waitFor();
  assert.equal(await page.getByText(reason, { exact: false }).count(), 1);
  await expectReachableReason(page, page.getByRole("button", { name: "Use Preset" }), choose);

  await page.getByLabel("Preset template").selectOption(other.data.id);
  await page
    .getByText("Fill in the variables, then use this Preset to create an editable draft.", {
      exact: true,
    })
    .waitFor();
  await expectReachableReason(page, shortcut, reason);
});

// Finding D793. Save plugin selections, Discard changes, Save channel Secrets and Use Preset were
// disabled with a sentence beside them that no control named. Each is described by it now.
test("a draft's disabled Save and Discard name their reasons", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Described draft");
  const tokens = [
    await fixture.createSecret(namespace.id, "Described Slack app token", "xapp-described"),
    await fixture.createSecret(namespace.id, "Described Slack bot token", "xoxb-described"),
  ];
  const agent = await fixture.createAgent(
    namespace.id,
    "Described Slack Agent",
    slackAgentValues("slack"),
    slackTokenBindings(...tokens),
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
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Described Preset", {
    defaultPresets: [DEFAULT_CODEX_PRESET],
  });
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
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Unbound Slack");
  const agent = await fixture.createAgent(
    namespace.id,
    "Unbound Slack Agent",
    slackAgentValues("unbound"),
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

// An Installation administrator's Credentials tab read the IAM policy and found no grant of the
// saved authentication Secret to the Agent (finding 2260).
const HARNESS_GRANT_MISSING =
  "This Agent has no access to its authentication Secret, so deploying it would be refused. Select Save authentication source to grant it.";
// The same missing grant, read by a session whose Save authentication source is unavailable.
const HARNESS_GRANT_MISSING_ASK =
  "This Agent has no access to its authentication Secret, so deploying it would be refused. Granting it needs Installation administration access: ask an Installation administrator to open this Agent's Credentials and select Save authentication source.";

// Finding 2949. While she administers the Installation, the warning names the Save that grants
// the Agent its Secret. Her administration then ends: the newer permission answer refuses her
// Agent update, so Save is unavailable, and the shown warning is reworded in place to name who
// grants it instead of a Save she cannot use.
test("a missing harness grant names the administrator once a revoke makes Save unavailable", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Revoked harness grant");
  const secret = await fixture.createSecret(namespace.id, "Revoked harness Secret", "hidden");
  const agent = await fixture.createAgent(
    namespace.id,
    "Revoked Grant Agent",
    nativeValues("revoked-grant"),
  );
  // The Agent's binding moves to a Secret it holds no grant for.
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const account = await fixture.createNamespaceMember("revoked-harness", namespace.id, AGENT_READ);
  const revoke = grantInstallationAdministration(fixture, account.principal);
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    account.credentials,
  );
  await page.getByRole("heading", { name: "Revoked Grant Agent" }).waitFor();
  const save = page.getByRole("button", { name: "Save authentication source" });
  await page.getByText(HARNESS_GRANT_MISSING, { exact: true }).waitFor();
  await waitForEnabled(save);

  revoke();
  // The Access tab's policy read is refused, which settles that she no longer administers the
  // Installation; the page reads its permission answer again and leaves for Configuration.
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByText(HARNESS_GRANT_MISSING_ASK, { exact: true }).waitFor();
  assert.equal(await page.getByText(HARNESS_GRANT_MISSING, { exact: true }).count(), 0);
  assert.equal(await save.isDisabled(), true);
});

// Finding 2950. The Codex lock keeps Execution mode in the Tab order with its hint (finding
// 2945). A pending Create disables every field natively, this select too: it must not be turned
// into the reachable Codex lock, which a keyboard could still open while the request runs.
test("a pending Codex Create keeps Execution mode natively disabled", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Pending Codex mode");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  await page.getByLabel("Agent name").fill("Pending Codex Agent");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await enterManualModel(page, "pending-codex-key", "gpt-5.1");
  await page.locator(".launch-runtime > summary").click();
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.getAttribute("aria-disabled"), "true");
  // The first write Create sends after the model Secret is held, so the form stays pending.
  const write = await holdRequests(
    t,
    page,
    (url) =>
      url.pathname.startsWith(`/namespaces/${namespace.id}/`) && !url.pathname.includes("/secrets"),
    { method: "POST", once: true },
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await write.requested;
  await page.waitForFunction((node) => node.disabled, await mode.elementHandle());
  assert.equal(await mode.getAttribute("aria-disabled"), null);
  write.release();
});
