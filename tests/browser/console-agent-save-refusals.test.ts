import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";

import type { AgentWire, NamespaceWire } from "../../packages/contracts/src/api/resources.ts";
import type { Principal, Restriction } from "../../packages/contracts/src/index.ts";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
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
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  openAdvancedSettings,
} from "./console-agents-test-support.mjs";
import { createPolicyConsole } from "./console-sandbox-policy-fixture.ts";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// A member who can read an Agent and its Configuration, but not change them, was offered Save
// on the Configuration JSON editor, the Slack drawer and the Agent-side editors. Each save
// answered 403 and the console showed "Access denied. You do not have permission for this
// operation.", naming no permission (finding 1530, D618). Configuration saves now name the
// grant they need; Agent-side saves are disabled up front when the permission answer denies
// Agent update.

const CONFIGURATION_REFUSAL =
  "You do not have permission to save this Configuration. Ask an administrator for Configuration update access, plus Secret operate on each Secret it binds.";
const AGENT_UPDATE_DENIED =
  "Your access does not include updating this Agent. Ask an administrator for Agent update access to save these settings.";
const READ_REFUSAL =
  "You do not have permission to read this Agent's saved settings. Ask an administrator for Agent read and Configuration read access.";

// A member who can read the Namespace's Agents and Configurations but change nothing.
function createReader(
  fixture: Awaited<ReturnType<typeof createConsoleAppFixture>>,
  namespace: Pick<NamespaceWire, "id">,
) {
  return fixture.createAccountWithPolicy(
    "save-refusal-reader",
    (principal: Pick<Principal, "id">) => {
      fixture.policy.roles.push({
        id: "role-save-refusal-reader",
        namespaceId: namespace.id,
        permissions: (["namespace", "agent", "agent_revision", "configuration"] as const).map(
          (resourceKind) => ({ action: "read", resourceKind }),
        ),
      });
      fixture.policy.bindings.push({
        id: "binding-save-refusal-reader",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "role-save-refusal-reader",
      });
    },
  );
}

async function readOnlyMember(t: TestContext, name: string) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const app = await fixture.createSecret(namespace.id, `${name} app token`, "xapp-refusal");
  const bot = await fixture.createSecret(namespace.id, `${name} bot token`, "xoxb-refusal");
  const agent = await fixture.createAgent(
    namespace.id,
    name,
    nativeValues("refusal", {
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
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  const member = await createReader(fixture, namespace);
  const { page } = await newPage(t, fixture, { browser });
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const refusedPatch = () =>
    page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url() === `${fixture.origin}${configurationPath}`,
    );
  return { fixture, namespace, agent, member, page, configurationPath, refusedPatch };
}

// Both Configuration editors send the same PATCH; each refusal names its grants and keeps the
// reader's edits on screen.
const configurationSaves = [
  {
    name: "JSON editor",
    tab: "configuration",
    async save(page: Page) {
      await page.getByRole("button", { name: "Edit Configuration" }).click();
      await openAdvancedSettings(page);
      const edited = JSON.stringify(nativeValues("edited by a reader"), null, 2);
      await page.getByLabel("Configuration JSON").fill(edited);
      await page.getByRole("button", { name: "Save Configuration" }).click();
      return async () => {
        await page.getByText(CONFIGURATION_REFUSAL, { exact: true }).waitFor();
        assert.equal(await page.getByLabel("Configuration JSON").inputValue(), edited);
      };
    },
  },
  {
    name: "Slack drawer",
    tab: "channels",
    async save(page: Page) {
      await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit Slack" });
      await dialog.getByLabel("Direct-message policy").selectOption("disabled");
      await dialog.getByRole("button", { name: "Save configuration" }).click();
      return async () => {
        await dialog.getByText(CONFIGURATION_REFUSAL).waitFor();
        assert.equal(await dialog.getByLabel("Direct-message policy").inputValue(), "disabled");
      };
    },
  },
];

for (const c of configurationSaves) {
  test(`a refused ${c.name} save names Configuration update and keeps the edits`, async (t) => {
    const { fixture, namespace, agent, member, page, configurationPath, refusedPatch } =
      await readOnlyMember(t, `Refused ${c.name}`);
    const before = (await fixture.request("GET", configurationPath)).data;
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", c.tab).href,
      member.credentials,
    );
    const refused = refusedPatch();
    const check = await c.save(page);
    assert.equal((await refused).status(), 403);
    await check();
    const after = (await fixture.request("GET", configurationPath)).data;
    assert.equal(after.generation, before.generation);
  });
}

// Every field a tab's Save would write is disabled or inert: an edit no Save can keep would
// only block leaving the tab or Deploy (finding 1539).
const editableFields = (page: Page, scope = ".agent-card") =>
  page.locator(scope).evaluateAll((cards) =>
    cards
      .flatMap((card) =>
        Array.from(
          card.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "input, select, textarea",
          ),
        ),
      )
      .filter(
        (field) =>
          field.type !== "hidden" &&
          !field.disabled &&
          !("readOnly" in field && field.readOnly) &&
          !field.closest("[inert]"),
      )
      .map((field) => field.id || field.getAttribute("aria-label") || field.name),
  );

test("a member without Agent update sees the Agent-side saves and fields disabled with the reason", async (t) => {
  const { fixture, namespace, agent, member, page } = await readOnlyMember(t, "Agent Saves Off");
  const tabs = [
    { tab: "plugins", save: "Save plugin selections", field: "Plugin selections JSON" },
    // The Channel Secrets card below saves the Configuration, not the Agent.
    {
      tab: "credentials",
      save: "Save authentication source",
      field: "Authentication source",
      scope: "form:has(#harness-auth-method)",
    },
    // Repository fields need a repository Driver; the next test covers them.
    { tab: "repositories", save: "Save repository access" },
  ];
  const patches: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH") {
      patches.push(request.url());
    }
  });
  for (const [index, { tab, save, field, scope }] of tabs.entries()) {
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", tab).href;
    if (index === 0) {
      await login(page, fixture, url, member.credentials);
    } else {
      await page.goto(url);
    }
    const button = page.getByRole("button", { name: save, exact: true });
    await button.waitFor();
    await page.getByRole("status").filter({ hasText: AGENT_UPDATE_DENIED }).waitFor();
    // The note is the proof where Save is also disabled for an unedited form.
    assert.equal(await button.isDisabled(), true, `${save} is disabled`);
    assert.deepEqual(await editableFields(page, scope), [], `no ${tab} field takes an edit`);
    if (field) {
      // The saved settings stay in view.
      assert.equal(await page.getByLabel(field, { exact: true }).isVisible(), true);
    }
    if (tab === "plugins") {
      // The selections JSON stays readable and focusable, but takes no edit.
      const json = page.getByLabel("Plugin selections JSON", { exact: true });
      assert.equal(await json.evaluate((node) => node.closest("[inert]") === null), true);
      assert.equal(await json.isEditable(), false);
    }
  }
  assert.deepEqual(patches, []);
});

test("a member without Agent update cannot edit repository access", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(namespace.id, "Repository Reader", nativeValues("repo"));
  const saved = await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: {
      configurationId: agent.configurationId,
      repositoryAccess: {
        defaultProfile: "git-full",
        repositories: [{ repositoryRef: "application" }],
      },
    },
  });
  assert.equal(saved.status, 200);
  const member = await createReader(fixture, namespace);
  const { page } = await newPage(t, fixture, { browser });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "repositories").href,
    member.credentials,
  );
  // Listing repository choices also needs Agent update; the saved access still shows.
  await page.getByText("Default repository access", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: AGENT_UPDATE_DENIED }).waitFor();
  // Remove was the edit left open: it blocked leaving the tab behind a disabled Save.
  assert.equal(
    await page.getByRole("button", { name: "Remove application", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.locator("#repository-default-git-read").isDisabled(), true);
  assert.deepEqual(await editableFields(page), []);
  // Cancel stays available; nothing is left to block leaving the tab.
  await waitForEnabled(page.getByRole("button", { name: "Cancel", exact: true }));
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).waitFor();
});

// The permission answer was read once per page, so a grant applied only after a full page
// Refresh (finding 1538). Reload authentication source reads it again.
test("a granted Agent update enables the Agent-side save on the next draft refresh", async (t) => {
  const { fixture, namespace, agent, member, page } = await readOnlyMember(t, "Agent Granted");
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
    member.credentials,
  );
  const save = page.getByRole("button", { name: "Save authentication source", exact: true });
  const note = page.getByRole("status").filter({ hasText: AGENT_UPDATE_DENIED });
  await note.waitFor();
  assert.equal(await save.isDisabled(), true);
  const reader = fixture.policy.roles.find((role) => role.id === "role-save-refusal-reader");
  assert.ok(reader, "the read-only role exists");
  reader.permissions.push({ action: "update", resourceKind: "agent" });
  await page.getByRole("button", { name: "Reload authentication source", exact: true }).click();
  await note.waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Save authentication source", exact: true, disabled: false })
    .waitFor();
  await waitForEnabled(page.getByLabel("Authentication source", { exact: true }));
});

// A save first rereads what it saves. A 403 from that read is a missing read grant, not a
// missing update grant (finding 1540). The read is revoked once the editor is ready.
const readRefusals: {
  name: string;
  tab: string;
  deny(agent: AgentWire): Pick<Restriction, "resourceKind" | "resourceId" | "action">;
  edit(page: Page): Promise<void>;
  save(page: Page): Promise<void>;
}[] = [
  {
    name: "authentication source",
    tab: "credentials",
    deny: (agent) => ({ resourceKind: "agent", resourceId: agent.id, action: "read" }),
    async edit(page) {
      await page.getByLabel("Authentication source", { exact: true }).waitFor();
    },
    async save(page) {
      await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
    },
  },
  {
    name: "Configuration JSON editor",
    tab: "configuration",
    deny: (agent) => ({
      resourceKind: "configuration",
      resourceId: agent.configurationId,
      action: "read",
    }),
    async edit(page) {
      await page.getByRole("button", { name: "Edit Configuration" }).click();
      await openAdvancedSettings(page);
      await page
        .getByLabel("Configuration JSON")
        .fill(JSON.stringify(nativeValues("edited after a revoke"), null, 2));
    },
    async save(page) {
      await page.getByRole("button", { name: "Save Configuration" }).click();
    },
  },
];

for (const c of readRefusals) {
  test(`a refused read before saving the ${c.name} names read access`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Read ${c.tab}`, { ready: true });
    const agent = await fixture.createAgent(namespace.id, `Read ${c.tab}`, nativeValues("read"));
    const { page } = await newPage(t, fixture, { browser });
    const patches: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH") {
        patches.push(request.url());
      }
    });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", c.tab).href);
    await c.edit(page);
    fixture.policy.restrictions.push({
      id: `deny-${c.tab}-read`,
      namespaceId: namespace.id,
      effect: "deny",
      ...c.deny(agent),
    });
    await c.save(page);
    await page.getByText(READ_REFUSAL, { exact: true }).waitFor();
    assert.deepEqual(patches, []);
  });
}

// Saving a workspace file is an Agent operate action; its refusal names that grant.
test("a refused workspace file save names Agent operate", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace Refusal", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Workspace Refusal", nativeValues("ws"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/*`,
    (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden." } }),
          })
        : route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ data: { name: "AGENTS.md", content: "before" } }),
          }),
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
  );
  const editor = page.getByLabel("AGENTS.md", { exact: true });
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  await editor.fill("after");
  await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).click();
  await page
    .getByText(
      "You do not have permission to save this file. Ask an administrator for Agent operate access.",
    )
    .waitFor();
  assert.equal(await editor.inputValue(), "after");
});

// A member who can read the Agent but not operate it was offered an enabled Save on every
// workspace file, and learned only from the refusal that saving needs Agent operate (finding
// 521, D443). When the Agent permission answer denies operate, each Save is marked unavailable
// up front, its description names the grant, the files stay readable but not editable, and
// activating Save sends nothing.
test("a member without Agent operate sees workspace Saves unavailable with the reason", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace Reader", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Workspace Reader", nativeValues("ws"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = await createReader(fixture, namespace);
  const { page } = await newPage(t, fixture, { browser });
  // The fixture has no Agent gateway, so the file reads are answered here; the permission
  // answer comes from the real API and IAM policy.
  const writes: string[] = [];
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/*`,
    (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
      if (route.request().method() !== "GET") {
        writes.push(name);
        return route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { name, content: `# ${name}\n` } }),
      });
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
    member.credentials,
  );
  const reason =
    "Your access does not include operating this Agent. Ask an administrator for Agent operate access to save workspace files.";
  await page.getByText(reason, { exact: true }).waitFor();
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await page.getByText(`${name} loaded.`, { exact: true }).waitFor();
    const editor = page.getByLabel(name, { exact: true });
    assert.equal(await editor.inputValue(), `# ${name}\n`);
    assert.equal(await editor.isEditable(), false, `${name} is read-only`);
    const save = page.getByRole("button", { name: `Save ${name}`, exact: true });
    assert.equal(await save.getAttribute("aria-disabled"), "true");
    assert.equal(
      await save.evaluate(
        (node) => document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent,
      ),
      reason,
    );
    // Save stays a keyboard stop. Even with a changed file (set by script, past readOnly),
    // activating it sends no write.
    await editor.evaluate((node: HTMLTextAreaElement) => {
      node.value = "changed";
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await save.focus();
    assert.equal(await save.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Enter");
  }
  await nextFrames(page);
  assert.deepEqual(writes, []);
});

const DIAGNOSTICS_DENIED = "Your access does not include running diagnostics for this Agent.";

// The page's other operate-gated controls follow the same observed answer as Workspace: the Stop
// row hides and each version's Run diagnostics disables while operate is denied (finding 2328).
async function expectOperateControls(page: Page, allowed: boolean) {
  const stopRow = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRow.waitFor({ state: allowed ? "visible" : "hidden" });
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  const run = page.getByRole("button", { name: "Run diagnostics for this version", exact: true });
  await run.waitFor();
  const denial = page.getByText(DIAGNOSTICS_DENIED, { exact: true });
  await denial.waitFor({ state: allowed ? "hidden" : "visible" });
  assert.equal(await run.isDisabled(), !allowed);
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
}

// The Workspace editor is kept while the reader visits Logs. Logs can observe a newer Agent
// operate answer. Coming back must apply that answer and keep any unsaved text; Stop and Run
// diagnostics follow it too, without a reload.
test("restoring Workspace applies the operate answer the page already observed", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace operate restore", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Workspace Operate Restore",
    nativeValues("ws-restore"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = await createReader(fixture, namespace);
  const { page } = await newPage(t, fixture, { browser });
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${active.revision.id}/runtime`,
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden." } }),
      }),
  );
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/*`,
    (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
      if (route.request().method() !== "GET") {
        return route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { name, content: `# ${name}\n` } }),
      });
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
    member.credentials,
  );
  const reason =
    "Your access does not include operating this Agent. Ask an administrator for Agent operate access to save workspace files.";
  const editor = page.getByLabel("AGENTS.md", { exact: true });
  await page.getByText(reason, { exact: true }).waitFor();
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await page.getByText(`${name} loaded.`, { exact: true }).waitFor();
  }
  assert.equal(await editor.isEditable(), false);
  await expectOperateControls(page, false);

  // The first Logs visit records the status denial without a fresh permission read.
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await page.getByText(reason, { exact: true }).waitFor();
  fixture.policy.roles.push({
    id: "role-workspace-operate-restore",
    namespaceId: namespace.id,
    permissions: [{ action: "operate", resourceKind: "agent" }],
  });
  fixture.policy.bindings.push({
    id: "binding-workspace-operate-restore",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: member.principal.id,
    roleId: "role-workspace-operate-restore",
  });
  const granted = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${agent.id}/permissions`) &&
      response.request().method() === "GET" &&
      response.status() === 200,
  );
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await granted;
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(await page.getByText(reason, { exact: true }).count(), 0);
  assert.equal(await editor.isEditable(), true);
  await expectOperateControls(page, true);
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  await editor.fill("kept across the revocation");

  fixture.policy.bindings.splice(
    fixture.policy.bindings.findIndex(
      (binding) => binding.id === "binding-workspace-operate-restore",
    ),
    1,
  );
  const revoked = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${agent.id}/permissions`) &&
      response.request().method() === "GET" &&
      response.status() === 200,
  );
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await revoked;
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await page.getByText(reason, { exact: true }).waitFor();
  assert.equal(await editor.isEditable(), false);
  assert.equal(await editor.inputValue(), "kept across the revocation");
  await expectOperateControls(page, false);
  assert.equal(await editor.inputValue(), "kept across the revocation");
});

for (const reply of ["an incomplete preview", "a save with different rules"] as const) {
  test(`Agent policy does not apply after ${reply}`, async (t) => {
    const grant = {
      id: "python-docs",
      binary: "/usr/bin/python3.11",
      host: "example.org",
      ports: [{ from: 443, to: 443 }],
    };
    const { fixture, namespace, agent, base } = await createPolicyConsole(t, [grant]);
    const seeded = await fixture.request("PUT", base, {
      body: { expectedVersion: 1, additions: [grant] },
    });
    assert.equal(seeded.status, 200);
    const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    const preview = reply === "an incomplete preview";
    const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "policy");
    await login(page, fixture, url.href);
    await page.getByRole("button", { name: "Remove Network rules 1", exact: true }).click();
    const refresh = page.getByRole("button", { name: "Refresh policy", exact: true });

    // The operator removes the grant. Let the controller validate or commit that removal, then
    // deliver an incomplete preview, or a well-formed save response still listing the old grant.
    await page.route(fixture.origin + base + (preview ? "/validate" : ""), async (route) => {
      if (route.request().method() !== (preview ? "POST" : "PUT")) {
        return route.continue();
      }
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const { data, meta } = await response.json();
      const actual = preview ? data.data : data;
      assert.deepEqual(actual.additions, []);
      if (!preview) {
        assert.equal(await refresh.isDisabled(), true, "cannot start a refresh during the save");
      }
      const changed = preview ? { success: true, data: {} } : { ...actual, additions: [grant] };
      await route.fulfill({ response, json: { data: changed, meta } });
    });
    const review = page.getByRole("button", { name: "Review changes", exact: true });
    await review.click();
    if (preview) {
      await page
        .getByRole("alert")
        .filter({ hasText: "could not read the validated rules" })
        .waitFor();
      assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0);
      assert.equal(pathRequests(requests, "PUT", base).length, 0);
      assert.equal(await review.isEnabled(), true);
    } else {
      // A refresh started before Save can still be delivering the previous version when Save
      // finishes. Only the operator's subsequent refresh can resolve the uncertain outcome.
      const policyUrl = fixture.origin + base;
      const stale = await holdRequests(t, page, policyUrl, {
        once: true,
        method: "GET",
        afterServer: true,
      });
      await refresh.click();
      await stale.requested;
      await page.getByRole("button", { name: "Save and apply to current revision" }).click();
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "could not confirm the saved rules" });
      await alert.waitFor();

      const delivered = page.waitForResponse(policyUrl);
      stale.release();
      const response = await delivered;
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).data.policy.version, 2);
      await nextFrames(page);
      assert.equal(await alert.isVisible(), true, "a pre-save policy read cannot resolve the save");
      assert.equal(await review.count(), 0);
      assert.equal(
        await page.getByRole("button", { name: "Apply saved policy to current revision" }).count(),
        0,
      );
      await refresh.click();
      await page.getByText(/Policy v3 reloaded/).waitFor();
      assert.equal(pathRequests(requests, "PUT", base).length, 1);
    }

    const { policy } = (await fixture.request("GET", base)).data;
    assert.equal(pathRequests(requests, "POST", base + "/apply").length, 0);
    assert.equal(policy.application, undefined);
    assert.equal(policy.version, preview ? 2 : 3);
    assert.deepEqual(policy.additions, preview ? [grant] : []);
  });
}
