import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  assertControlEdge,
  consoleViewports,
  detailUrl,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  routeFailedDeployment,
  settledView,
} from "./console-agents-browser-helpers.mjs";
import {
  createModelCredentialSecret,
  createRepositoryLaunchFixture,
  enterManualModel,
  openAdvancedSettings,
  routeInstallationWithoutProvisioning,
  waitForCreateFormReads,
} from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// The console's control patterns. Button hierarchy (UX plan C2): each view shows at most one
// primary action, a secondary button's edge is visible against its surface, and a button waiting
// on its own request says it is busy instead of looking permanently disabled (finding 1927).
// Status badges and cards (UX plan C4): a word or two of human copy in `.badge`, with a tone.

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

// The visible controls painted as a primary action: filled with the accent, or with the strong
// text colour the Agent page's older black primary used. Counted by paint, not class, so an
// older class name or a page rule cannot hide a second primary.
const filledActions = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const resolve = (value) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = value;
      document.body.append(probe);
      const color = globalThis.getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const fills = new Set([resolve("var(--color-accent)"), resolve("var(--color-text-strong)")]);
    return [...document.querySelectorAll("button, a, summary, [role='button']")]
      .filter((node) => {
        const style = globalThis.getComputedStyle(node);
        return (
          node.getClientRects().length > 0 &&
          style.visibility !== "hidden" &&
          fills.has(style.backgroundColor)
        );
      })
      .map((node) => node.textContent.trim().replace(/\s+/g, " "));
  });

// An Agent whose v1 serves while its v2 redeploy failed; each page routes that deployment's read
// to a DEPENDENCY_UNAVAILABLE failure.
async function failedRedeploy(fixture, namespace) {
  const agent = await fixture.createAgent(namespace.id, "Failed Agent", nativeValues("failed"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const route = (page) =>
    routeFailedDeployment(page, fixture, {
      namespaceId: namespace.id,
      agentId: agent.id,
      deploymentId: failed.id,
    });
  return { agent, active, route };
}

test("Agents, Agent detail, Create Agent and Logs each show at most one primary action at 1440 and 390", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Primary actions", {
    computeDriver: createRuntimeLogComputeDriver(),
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  const draft = await fixture.createAgent(namespace.id, "Draft Agent", nativeValues("draft"));
  const { agent: failed, active, route } = await failedRedeploy(fixture, namespace);
  for (const viewport of consoleViewports) {
    const size = `${viewport.width}x${viewport.height}`;
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await route(page);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);

    const views = [
      {
        name: "Agents",
        url: new URL(`/console/agents?namespace=${namespace.id}`, fixture.origin),
        ready: () => page.getByRole("link", { name: "Draft Agent" }).waitFor(),
        primary: "Create Agent",
      },
      {
        name: "Agent detail, draft",
        url: detailUrl(fixture, namespace.id, draft.id),
        ready: () => page.getByRole("button", { name: "Deploy new version" }).waitFor(),
        primary: "Deploy new version",
      },
      {
        name: "Agent detail, failed",
        url: detailUrl(fixture, namespace.id, failed.id),
        ready: () =>
          page
            .getByRole("region", { name: "Deployment needs attention" })
            .getByRole("link", { name: "Deploy again" })
            .waitFor(),
        primary: "Deploy again",
      },
      {
        // The failed version's recovery outranks the draft's own Deploy new version.
        name: "Agent detail, failed, draft",
        url: detailUrl(fixture, namespace.id, failed.id, "draft", "configuration"),
        ready: async () => {
          await page.getByRole("button", { name: "Deploy new version" }).waitFor();
          await page
            .getByRole("region", { name: "Deployment needs attention" })
            .getByRole("link", { name: "Deploy again" })
            .waitFor();
        },
        primary: "Deploy again",
      },
      {
        name: "Create Agent",
        url: new URL(`/console/agents/new?namespace=${namespace.id}`, fixture.origin),
        ready: async () => {
          await page.getByRole("button", { name: "Start without Preset", exact: true }).click();
          await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
        },
        primary: "Create Agent",
      },
      {
        name: "Logs",
        url: detailUrl(fixture, namespace.id, failed.id, active.revision.id, "logs"),
        // Deploy again follows the recovery's own Configuration read.
        ready: async () => {
          await page.getByRole("button", { name: "Refresh logs" }).waitFor();
          await page
            .getByRole("region", { name: "Deployment needs attention" })
            .getByRole("link", { name: "Deploy again" })
            .waitFor();
        },
        primary: "Deploy again",
      },
    ];
    for (const view of views) {
      await page.goto(view.url.href);
      await view.ready();
      await page.locator(settledView).waitFor();
      // Park the pointer so no hover repaints a control.
      await page.mouse.move(0, 0);
      assert.deepEqual(await filledActions(page), [view.primary], `${view.name} at ${size}`);
      if (view.primary === "Deploy again") {
        // Its secondary action is a white button on the card's warning tint, so its edge marks
        // it (finding 1958).
        await assertControlEdge(
          page
            .getByRole("region", { name: "Deployment needs attention" })
            .getByRole("link", { name: "Open v2 Logs" }),
          `Open v2 Logs, ${view.name} at ${size}`,
          { opaqueFill: true },
        );
      }
    }
    // The recovery's secondary link is a button of the same size as its primary, not bare text.
    const recovery = page.getByRole("region", { name: "Deployment needs attention" });
    const [primaryBox, secondaryBox] = await Promise.all(
      ["Deploy again", "Open v2 Logs"].map((name) =>
        recovery.getByRole("link", { name }).boundingBox(),
      ),
    );
    assert.equal(secondaryBox.height, primaryBox.height, size);
    assert.equal(
      await recovery
        .getByRole("link", { name: "Open v2 Logs" })
        .evaluate((link) => globalThis.getComputedStyle(link).textDecorationLine),
      "none",
    );
  }
});

// A secondary button is a white control on a white or near-white card, so its edge is what marks
// it as a control (WCAG 1.4.11). The old 1.27:1 line edge left a grey slab with no edge.
test("Secondary buttons have an edge of at least 3:1 against their fill and the surface behind", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Secondary edge", {
    computeDriver: createRuntimeLogComputeDriver(),
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  const agent = await fixture.createAgent(namespace.id, "Edge Agent", nativeValues("edge"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);

  const checks = [
    [
      new URL(`/console/agents/new?namespace=${namespace.id}`, fixture.origin),
      "Start without Preset",
    ],
    [detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"), "Edit Configuration"],
    [detailUrl(fixture, namespace.id, agent.id, active.revision.id, "logs"), "Download"],
  ];
  for (const [url, name] of checks) {
    await page.goto(url.href);
    const control = page.getByRole("button", { name, exact: true });
    await control.waitFor();
    await page.locator(settledView).waitFor();
    await page.mouse.move(0, 0);
    await assertControlEdge(control, name);
  }
});

// The cursor and busy state a pending button shows while its request is held.
const busyState = (locator) =>
  locator.evaluate((node) => ({
    busy: node.getAttribute("aria-busy"),
    cursor: globalThis.getComputedStyle(node).cursor,
    disabled: node.disabled,
    text: node.textContent,
  }));

// Stopping…, Deleting… and Save while saving are disabled while their request runs; they are
// busy, not unavailable, so they say so and show the progress cursor (finding 1927).
test("Stop, Delete and Save Configuration show busy, not only disabled, while their request runs", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Busy buttons");
  const agent = await fixture.createAgent(namespace.id, "Busy Agent", nativeValues("busy"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const editable = await fixture.createAgent(namespace.id, "Saving Agent", nativeValues("save"));
  const { page } = await newPage(t, fixture, { browser });
  const path = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));

  const stop = await holdRequests(t, page, `${path}/stop`, { method: "POST", once: true });
  await page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  const stopDialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await stopDialog.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await stop.requested;
  assert.deepEqual(await busyState(stopDialog.getByRole("button", { name: "Stopping…" })), {
    busy: "true",
    cursor: "progress",
    disabled: true,
    text: "Stopping…",
  });
  stop.release();
  await stopDialog.waitFor({ state: "detached" });

  const remove = await holdRequests(t, page, path, { method: "DELETE", once: true });
  await page.getByRole("button", { name: "Delete Agent", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete Busy Agent?" });
  await deleteDialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  await remove.requested;
  assert.deepEqual(await busyState(deleteDialog.getByRole("button", { name: "Deleting…" })), {
    busy: "true",
    cursor: "progress",
    disabled: true,
    text: "Deleting…",
  });
  remove.release();
  await deleteDialog.waitFor({ state: "detached" });

  await page.goto(detailUrl(fixture, namespace.id, editable.id, "draft", "configuration").href);
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("edited")));
  const save = page.getByRole("button", { name: "Save Configuration" });
  // Idle: available, and not busy.
  assert.equal(await save.getAttribute("aria-busy"), "false");
  const configurationUrl = `${fixture.origin}/namespaces/${namespace.id}/configurations/${editable.configurationId}`;
  // A refused save is busy while it runs and not after, so Save again is not left with a busy
  // state and the progress cursor (finding 1972).
  const refused = await holdRequests(t, page, configurationUrl, {
    method: "PATCH",
    once: true,
    fulfill: refusal(400, "VALIDATION_FAILED", "Refused for the busy test."),
  });
  await save.click();
  await refused.requested;
  assert.equal(await save.getAttribute("aria-busy"), "true");
  refused.release();
  await page.getByText("Refused for the busy test.", { exact: true }).waitFor();
  assert.deepEqual(await busyState(save), {
    busy: "false",
    cursor: "pointer",
    disabled: false,
    text: "Save Configuration",
  });
  const patch = await holdRequests(t, page, configurationUrl, { method: "PATCH", once: true });
  await save.click();
  await patch.requested;
  assert.deepEqual(await busyState(save), {
    busy: "true",
    cursor: "progress",
    disabled: true,
    text: "Save Configuration",
  });
  patch.release();
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
});

// Save repository access is busy while its request runs and not after it (finding 1972: removing
// its aria-busy wiring left every test green).
test("Save repository access shows busy while its request runs", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "789",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-full"] }],
    },
  ]);
  const configured = await fixture.createAgent(namespace.id, "Configured", nativeValues("repo"));
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Repository busy",
      configurationId: configured.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-read" }],
    },
  });
  assert.equal(created.status, 201);
  const { page } = await newPage(t, fixture, { browser });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, created.data.id, "draft", "repositories"),
  );
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  const save = page.getByRole("button", { name: "Save repository access" });
  assert.equal(await save.getAttribute("aria-busy"), "false");
  await page.getByRole("button", { name: "Access for example/application" }).click();
  await page.locator("#repository-override-application-git-full").check();
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  const patch = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${created.data.id}`,
    { method: "PATCH", once: true },
  );
  await save.click();
  await patch.requested;
  assert.deepEqual(await busyState(save), {
    busy: "true",
    cursor: "progress",
    disabled: true,
    text: "Save repository access",
  });
  patch.release();
  // The saved tab rebuilds in place; its Save is not busy.
  await page.getByText("Repository access saved.", { exact: true }).waitFor();
  assert.equal(await save.getAttribute("aria-busy"), "false");
});

test("a permanently disabled button says not allowed, not busy", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Disabled cursor", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "API-key plugin Agent",
    nativeValues("api-key-cursor", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  assert.equal(agent.harnessAuth.method, "api_key");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByText("Plugin browsing is unavailable with API-key authentication.").waitFor();
  // An API key can never browse the catalog, so Load plugins stays disabled: nothing is pending.
  const load = dialog.getByRole("button", { name: "Load plugins" });
  assert.equal(await load.isDisabled(), true);
  assert.deepEqual(
    await load.evaluate((node) => {
      const style = globalThis.getComputedStyle(node);
      return [style.cursor, style.opacity];
    }),
    ["not-allowed", "0.6"],
  );
});

const refusal = (status, code, message) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({
    error: { code, message },
    meta: { requestId: "req_00000000-0000-4000-8000-000000001961" },
  }),
});

// The busy state the button shows after its request ended, wherever the button now is.
const busyAfter = (handle) =>
  handle.evaluate((node) => ({ busy: node.getAttribute("aria-busy"), disabled: node.disabled }));

async function openCreateForm(page, fixture, namespace, name) {
  await page.goto(new URL(`/console/agents/new?namespace=${namespace.id}`, fixture.origin).href);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill(name);
  await enterManualModel(page, `${name} key`, "gpt-busy-create");
  await waitForCreateFormReads(page);
  const create = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.deepEqual(await busyState(create), {
    busy: "false",
    cursor: "pointer",
    disabled: false,
    text: "Create Agent",
  });
  return create;
}

// Create Agent is busy while its own request runs, and its busy state ends with the request:
// after a refusal, after success, and after a navigation away (finding 1961).
test("Create Agent shows busy while its request runs and clears it on refusal, success and navigation away", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Busy create");
  const { page } = await newPage(t, fixture, { browser });
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  const validateUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/validate`;
  const agentsUrl = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const busy = { busy: "true", cursor: "progress", disabled: true, text: "Create Agent" };

  // Refused by the preflight: available again, and no longer busy.
  let create = await openCreateForm(page, fixture, namespace, "Busy refused");
  const refused = await holdRequests(t, page, validateUrl, {
    method: "POST",
    once: true,
    fulfill: refusal(400, "VALIDATION_FAILED", "Refused for the busy test."),
  });
  await create.click();
  await refused.requested;
  assert.deepEqual(await busyState(create), busy);
  refused.release();
  await page.getByRole("alert").filter({ hasText: "Refused for the busy test." }).waitFor();
  assert.deepEqual(await busyAfter(create), { busy: "false", disabled: false });

  // Created: the page moves to the new Agent, and the button it left is not busy.
  const saved = await holdRequests(t, page, agentsUrl, { method: "POST", once: true });
  await create.click();
  await saved.requested;
  assert.deepEqual(await busyState(create), busy);
  let handle = await create.elementHandle();
  saved.release();
  await page.waitForURL((url) => /^\/console\/agents\/agt_/.test(url.pathname));
  await page.waitForFunction((node) => node.getAttribute("aria-busy") === "false", handle);

  // Left while the request runs: leaving aborts it, so the form it left is not busy even before
  // the held request is answered.
  create = await openCreateForm(page, fixture, namespace, "Busy left");
  const left = await holdRequests(t, page, validateUrl, { method: "POST", once: true });
  await create.click();
  await left.requested;
  assert.deepEqual(await busyState(create), busy);
  handle = await create.elementHandle();
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.waitForURL((url) => url.pathname === "/console/agents");
  await page.waitForFunction((node) => node.getAttribute("aria-busy") === "false", handle);
  left.release();
});

// A Credential Gateway that registers model Secrets as Credential Sources. Only the browser sees
// it: the Credential Source requests below are answered here.
async function routeCredentialSourceInstallation(page, fixture) {
  await page.route(`${fixture.origin}/installation`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "ins_00000000-0000-4000-8000-000000000001",
          name: "Console test installation",
          createdAt: new Date().toISOString(),
          capabilities: {
            agentProvisioning: { executionModes: ["dedicated"] },
            credentialSources: {
              types: [
                {
                  type: "openai",
                  config: [],
                  secrets: [{ name: "api_key", required: true }],
                  rotation: "none",
                  harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
                },
              ],
            },
          },
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      }),
    }),
  );
}

// Create's busy state is its own: Check credential registration's request disables Create but
// does not mark it busy, and an uncertain or refused registration ends the busy state.
test("Create Agent is busy only for its own request, not a recovery control's", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Own busy state");
  const { page } = await newPage(t, fixture, { browser });
  await routeCredentialSourceInstallation(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Agent name").fill("Own busy Agent");
  await createModelCredentialSecret(page, "own-busy-model-key");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  await waitForCreateFormReads(page);
  const create = page.getByRole("button", { name: "Create Agent", exact: true });
  const sourcesUrl = `${fixture.origin}/namespaces/${namespace.id}/credential-sources`;
  const busy = { busy: "true", cursor: "progress", disabled: true, text: "Create Agent" };

  // The registration's outcome is unknown: Create waits for a check, but is not busy.
  const uncertain = await holdRequests(t, page, sourcesUrl, {
    method: "POST",
    once: true,
    fulfill: refusal(503, "DEPENDENCY_UNAVAILABLE", "Synthetic lost registration."),
  });
  await create.click();
  await uncertain.requested;
  assert.deepEqual(await busyState(create), busy);
  uncertain.release();
  await page
    .getByRole("alert")
    .filter({ hasText: "Credential Source registration could not be confirmed." })
    .waitFor();
  const check = page.getByRole("button", { name: "Check credential registration" });
  await check.waitFor();
  assert.deepEqual(await busyAfter(create), { busy: "false", disabled: true });

  // Another control's request disables Create; Create is not the one working.
  const read = await holdRequests(t, page, sourcesUrl, {
    method: "GET",
    once: true,
    fulfill: {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        meta: { requestId: "req_00000000-0000-4000-8000-000000000002" },
      }),
    },
  });
  await check.click();
  await read.requested;
  assert.equal(await check.isDisabled(), true);
  assert.deepEqual(await busyAfter(create), { busy: "false", disabled: true });
  assert.notEqual(
    await create.evaluate((node) => globalThis.getComputedStyle(node).cursor),
    "progress",
  );
  read.release();
  await page
    .getByText(
      "No credential registration is visible. Select Create Agent to retry the same registration.",
      { exact: true },
    )
    .waitFor();
  assert.deepEqual(await busyAfter(create), { busy: "false", disabled: false });

  // A refused registration: available again, and no longer busy.
  const refused = await holdRequests(t, page, sourcesUrl, {
    method: "POST",
    once: true,
    fulfill: refusal(400, "VALIDATION_FAILED", "Refused registration for the busy test."),
  });
  await create.click();
  await refused.requested;
  assert.deepEqual(await busyState(create), busy);
  refused.release();
  await page
    .getByRole("alert")
    .filter({ hasText: "Credential Source registration could not be confirmed." })
    .waitFor();
  assert.deepEqual(await busyAfter(create), { busy: "false", disabled: false });
});

// A badge's words, tone and paint, and the gap to the element before it. `painted` is true when
// its text has its tone's colour (muted when neutral).
const badgeState = (locator) =>
  locator.evaluate((node) => {
    const style = globalThis.getComputedStyle(node);
    const probe = globalThis.document.createElement("span");
    probe.style.color = `var(--color-${node.dataset.tone ?? "text-muted"})`;
    globalThis.document.body.append(probe);
    const toneColor = globalThis.getComputedStyle(probe).color;
    probe.remove();
    const before = node.previousElementSibling?.getBoundingClientRect();
    return {
      badge: node.classList.contains("badge"),
      text: node.textContent,
      tone: node.dataset.tone ?? null,
      gap: before ? Math.round(node.getBoundingClientRect().left - before.right) : null,
      sameLine: before
        ? Math.abs(node.getBoundingClientRect().top - before.top) < before.height
        : null,
      painted: style.color === toneColor && style.backgroundColor !== "rgba(0, 0, 0, 0)",
    };
  });

// Status badges share one pattern. The version list's "Current version" label read as
// "Currentversion" (audit 2.2), and the Credentials tab's Slack token states had their own chrome.
test("The current version, Slack token bindings and Namespace rows use the badge and card patterns", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Badges and cards");
  const versioned = await fixture.createAgent(namespace.id, "Badge Agent", nativeValues("badge"));
  await fixture.seedActiveAgentRevision(namespace.id, versioned.id);
  const bot = await fixture.createSecret(namespace.id, "Badge bot token", "xoxb-badge");
  const slack = await fixture.createAgent(
    namespace.id,
    "Credential badges",
    nativeValues("channels", {
      harnessId: "codex",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          channels: {},
        },
      },
    }),
    {
      executionMode: "dedicated",
      secretBindings: { SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } } },
    },
  );

  // The current version shows a Current badge after a visible space. Info, not success: Current
  // means only that OCC selected the version, which may be stopped or failed (finding 1969).
  for (const viewport of consoleViewports) {
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(page, fixture, detailUrl(fixture, namespace.id, versioned.id));
    const version = page.getByRole("button", {
      name: "View version v1, current version",
      exact: true,
    });
    await version.waitFor();
    const state = await badgeState(version.locator(".badge"));
    assert.deepEqual(
      { ...state, gap: state.gap >= 4 },
      { badge: true, text: "Current", tone: "info", gap: true, sameLine: true, painted: true },
      `badge at ${viewport.width}: ${JSON.stringify(state)}`,
    );
    // Rendered text: the badge follows the version number after a space.
    assert.match(await version.innerText(), /^v1 Current\n/);
  }

  // Each Slack token binding reads Bound or Missing in the shared badge, with a tone.
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, slack.id, "draft", "credentials"));
  const list = page.locator(".credential-status-list").filter({ hasText: "Slack bot token" });
  await list.waitFor();
  const status = (label) =>
    list.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]/span");
  for (const [label, text, tone] of [
    ["Slack app token", "Missing", "danger"],
    ["Slack bot token", "Bound", "success"],
  ]) {
    const state = await badgeState(status(label));
    assert.deepEqual(
      { badge: state.badge, text: state.text, tone: state.tone, painted: state.painted },
      { badge: true, text, tone, painted: true },
      label,
    );
  }

  // Namespace rows sit in one table card (UX spec 3.12): the card's surface, edge and radius
  // belong to the table, and each row is divided from the next by a hairline.
  await page.goto(new URL(`/console/namespaces?namespace=${namespace.id}`, fixture.origin).href);
  const row = page
    .getByRole("list", { name: "Namespaces", exact: true })
    .getByRole("listitem")
    .filter({ hasText: namespace.id });
  await row.waitFor();
  assert.deepEqual(
    await row.evaluate((node) => {
      const table = globalThis.getComputedStyle(node.closest(".namespace-table"));
      return {
        card: node.classList.contains("card"),
        surface: table.backgroundColor,
        radius: table.borderTopLeftRadius,
        edge: table.borderTopWidth,
      };
    }),
    { card: false, surface: "rgb(255, 255, 255)", radius: "14px", edge: "1px" },
  );
  const { badge, text, tone, painted } = await badgeState(row.locator(".badge"));
  assert.deepEqual(
    { badge, text, tone, painted },
    { badge: true, text: "Ready", tone: "success", painted: true },
    "Namespace row",
  );
});

// The Agents list's Deleting and Saved configuration unreadable badges and the detail header's
// Deleting badge keep their tones; no test checked them (finding 1973).
test("Deleting and unreadable configuration badges take their tones on the list and the detail page", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Badge tones");
  const deleting = await fixture.createAgent(namespace.id, "Deleting Agent", nativeValues("del"));
  const unreadable = await fixture.createAgent(
    namespace.id,
    "Unreadable Agent",
    nativeValues("un"),
  );
  const deletingPath = `/namespaces/${namespace.id}/agents/${deleting.id}`;
  assert.equal((await fixture.request("DELETE", deletingPath)).status, 202);
  const { page } = await newPage(t, fixture, { browser });
  // The list reports a saved configuration it cannot decode in the API's degraded shape: Agent
  // metadata without the six saved-settings fields (AgentReadSchema), plus configurationReadError.
  // PostgreSQL tests own the decode failure itself.
  const savedSettings = [
    "plugins",
    "pluginApprovers",
    "repositoryBindings",
    "repositoryAccess",
    "harnessAuth",
    "credentialSources",
  ];
  await page.route(`${fixture.origin}/namespaces/${namespace.id}/agents`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    payload.data = payload.data.map((item) =>
      item.id === unreadable.id
        ? {
            ...Object.fromEntries(
              Object.entries(item).filter(([field]) => !savedSettings.includes(field)),
            ),
            configurationReadError: { code: "SAVED_CONFIGURATION_UNREADABLE", field: "plugins" },
          }
        : item,
    );
    await route.fulfill({ response, json: payload });
  });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const table = page.locator(settledView).getByRole("table", { name: "Agents" });
  const rowBadge = (name) =>
    table
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name, exact: true }) })
      .locator(".badge");
  for (const [name, text, tone] of [
    ["Deleting Agent", "Deleting", "warning"],
    ["Unreadable Agent", "Saved configuration unreadable", "danger"],
  ]) {
    await rowBadge(name).waitFor();
    const { badge, text: shown, tone: shownTone, painted } = await badgeState(rowBadge(name));
    assert.deepEqual(
      { badge, text: shown, tone: shownTone, painted },
      { badge: true, text, tone, painted: true },
      name,
    );
  }

  await page.goto(detailUrl(fixture, namespace.id, deleting.id).href);
  await page.locator(settledView).waitFor();
  // The badge sits in the page header's actions, where Create new version would be.
  const header = page
    .locator(".content .page-header .page-actions")
    .locator(".badge")
    .filter({ hasText: /^Deleting$/ });
  await header.waitFor();
  const { badge, text, tone, painted } = await badgeState(header);
  assert.deepEqual(
    { badge, text, tone, painted },
    { badge: true, text: "Deleting", tone: "warning", painted: true },
    "detail header",
  );
});

// Links and disclosures share a colour distinct from primary actions. Names in a table
// underline on hover and focus; prose links keep their underline.
test("Links and disclosures use the link colour with an underline, not the accent", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Link tone");
  const agent = await fixture.createAgent(namespace.id, "Link Agent", nativeValues("link"));
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  // Each node's paint against the resolved link and accent colours.
  const tones = (locator) =>
    locator.evaluateAll((nodes) => {
      const resolve = (value) => {
        const probe = globalThis.document.createElement("span");
        probe.style.color = value;
        globalThis.document.body.append(probe);
        const color = globalThis.getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const [link, accent] = [resolve("var(--color-link)"), resolve("var(--color-accent)")];
      return nodes
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => {
          const style = globalThis.getComputedStyle(node);
          return {
            text: node.textContent.trim(),
            link: style.color === link,
            accent: style.color === accent,
            line: style.textDecorationLine,
            lineShows: style.textDecorationColor !== "rgba(0, 0, 0, 0)",
            weight: style.fontWeight,
          };
        });
    });
  const tone = async (locator) => {
    const [{ text: _text, ...paint }] = await tones(locator);
    return paint;
  };

  // The name link's underline appears when the pointer is on it.
  const name = page.getByRole("link", { name: "Link Agent", exact: true });
  await name.waitFor();
  await page.mouse.move(0, 0);
  assert.deepEqual(await tone(name), {
    link: true,
    accent: false,
    line: "underline",
    lineShows: false,
    weight: "500",
  });
  await name.hover();
  assert.equal((await tone(name)).lineShows, true, "name link underlines on hover");

  // The native Configuration disclosure has the same colour and a persistent underline.
  await page.goto(detailUrl(fixture, namespace.id, agent.id).href);
  const native = page.getByText("View native Configuration", { exact: true });
  await native.waitFor();
  await page.locator(settledView).waitFor();
  await page.mouse.move(0, 0);
  assert.deepEqual(await tone(native), {
    link: true,
    accent: false,
    line: "underline",
    lineShows: true,
    weight: "500",
  });
  const painted = (await tones(page.locator(".content").locator("a, summary")))
    .filter((paint) => paint.accent)
    .map((paint) => paint.text);
  assert.deepEqual(painted, [], "links painted in the accent");
});
