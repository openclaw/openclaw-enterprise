import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";

import type { AgentWire, NamespaceWire } from "../../packages/contracts/src/api/resources.ts";
import type { Principal, Restriction } from "../../packages/contracts/src/index.ts";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  openAdvancedSettings,
} from "./console-agents-test-support.mjs";

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
