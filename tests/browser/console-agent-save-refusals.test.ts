import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";

import type { AgentWire, NamespaceWire } from "../../packages/contracts/src/api/resources.ts";
import type { Restriction } from "../../packages/contracts/src/index.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/state/platform-state.ts";

import { liftRestriction, restrict } from "../helpers/iam-grants.mjs";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  AGENT_READ,
  apiRequests,
  detailUrl,
  expectReachableReason,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nextFrames,
  nonAuthWriteRequests,
  pathRequests,
  waitForEnabled,
  selectSecret,
  waitForInputValue,
  grantMember,
  grantStaleConfigurationUpdate,
  revokeMemberGrant,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  openAdvancedSettings,
  withholdPermissionSummary,
} from "./console-agents-test-support.mjs";
import { createPolicyConsole } from "./console-sandbox-policy-fixture.ts";
import {
  AGENT_SOURCES_DENIED,
  AGENT_STOP_DENIED,
  AGENT_UPDATE_DENIED,
  CONFIGURATION_SAVE_DENIED,
  DIAGNOSTICS_DENIED,
  stopRefused,
  WORKSPACE_SAVE_DENIED,
  REPOSITORY_CHOICES_AGENT_DENIED,
  SAVE_READ_REFUSED,
  WORKSPACE_SAVE_REFUSED,
} from "../helpers/refusal-text.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// A member who can read an Agent and its Configuration, but not change them, was offered Save
// on the Configuration JSON editor, the Slack drawer and the Agent-side editors. Each save
// answered 403 and the console showed a bare "Access denied" sentence, naming no permission (finding 1530, D618). Configuration saves now name the
// grant they need; Agent-side saves are disabled up front when the permission answer denies
// Agent update.

const AGENT_SOURCES_SERVICE_ACCOUNT_DENIED =
  "Saving these settings needs operate on each Secret and credential source this Agent and its Configuration bind, and read on the ServiceAccount it uses for Harness authentication. Your access does not include all of them. Ask an Installation administrator for that access.";
const AGENT_CONFIGURATION_READ_DENIED =
  "Saving these settings needs read access to this Agent's Configuration, which your access does not include. Ask an Installation administrator for Configuration read on it.";

// A member who can read the Namespace's Agents and Configurations but change nothing.
const READER = "save-refusal-reader";
function createReader(
  fixture: Awaited<ReturnType<typeof createConsoleAppFixture>>,
  namespace: Pick<NamespaceWire, "id">,
) {
  return fixture.createNamespaceMember(READER, namespace.id, AGENT_READ);
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
  await grantStaleConfigurationUpdate(page);
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
        await page.getByText(CONFIGURATION_SAVE_DENIED, { exact: true }).waitFor();
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
        await dialog.getByText(CONFIGURATION_SAVE_DENIED).waitFor();
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

// A member who can only read the Configuration sees what the saved document runs with, but no
// toggle takes an edit no Save could keep; the reason is linked to each toggle.
test("a member who can only read the Configuration sees the collaboration and safety settings unavailable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Safety Reader", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Safety Reader", {
    ...nativeValues("reader"),
    messages: { queue: { allowCollaborativeSteering: false } },
  });
  const member = await createReader(fixture, namespace);
  const { page } = await newPage(t, fixture, { browser });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href,
    member.credentials,
  );
  await page.getByText("These settings are read-only with your access.", { exact: true }).waitFor();
  for (const [name, checked] of [
    ["Strict mode", true],
    ["Other participants can steer a running turn", false],
    ["apply_patch changes files only in the workspace", true],
  ] as const) {
    const toggle = page.getByRole("checkbox", { name, exact: true });
    assert.equal(await toggle.isChecked(), checked, name);
    assert.equal(await toggle.isDisabled(), true, name);
    assert.match((await toggle.getAttribute("aria-describedby")) ?? "", /gateway-safety-reason/);
  }
  assert.equal(
    await page
      .locator("#gateway-safety-collaborative-steering-hint .gateway-safety-source")
      .textContent(),
    "Set in Configuration. ",
  );
});

// Every field a tab's Save would write is disabled or inert: an edit no Save can keep would
// only block leaving the tab or Deploy (finding 1539). An unavailable field with its reason is
// aria-disabled and ignores edits (finding 2899).
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
          field.getAttribute("aria-disabled") !== "true" &&
          !("readOnly" in field && field.readOnly) &&
          !field.closest("[inert]"),
      )
      .map((field) => field.id || field.getAttribute("aria-label") || field.name),
  );

// The Agent-side editors: each Save sends an Agent update.
const agentSaves = (repositorySave?: string) => [
  // Without a save the plugin selections show as a read-only summary with no editor or Save
  // (finding 2455).
  { tab: "plugins", absentSave: "Save plugin selections" },
  // The Channel Secrets card below saves the Configuration, not the Agent.
  {
    tab: "credentials",
    save: "Save authentication source",
    field: "Authentication source",
    scope: "form:has(#harness-auth-method)",
  },
  // Repository fields need a repository Driver; the repository test covers them.
  { tab: "repositories", save: repositorySave },
];

// Opens each Agent-side editor as the signed-in member and checks it shows `note`, offers no
// Save and takes no edit, and that nothing was written.
async function assertAgentSavesDisabled(
  { fixture, namespace, agent, member, page }: Awaited<ReturnType<typeof readOnlyMember>>,
  note: string,
  saves: ReturnType<typeof agentSaves>,
) {
  const requests = apiRequests(page, fixture.origin);
  for (const [index, { tab, save, absentSave, field, scope }] of saves.entries()) {
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", tab).href;
    if (index === 0) {
      await login(page, fixture, url, member.credentials);
    } else {
      await page.goto(url);
    }
    await page.getByRole("status").filter({ hasText: note }).waitFor();
    if (save) {
      // The note is the proof where Save is also disabled for an unedited form.
      const button = page.getByRole("button", { name: save, exact: true });
      assert.equal(await button.isDisabled(), true, `${save} is disabled`);
    }
    assert.deepEqual(await editableFields(page, scope), [], `no ${tab} field takes an edit`);
    if (absentSave) {
      assert.equal(await page.getByRole("button", { name: absentSave }).count(), 0);
    }
    if (field) {
      // The saved settings stay in view.
      assert.equal(await page.getByLabel(field, { exact: true }).isVisible(), true);
    }
  }
  assert.deepEqual(nonAuthWriteRequests(requests), []);
}

// Repository access reads as a summary: its choices read needs Agent update (finding 2454).
test("a member without Agent update sees the Agent-side saves and fields disabled with the reason", async (t) => {
  await assertAgentSavesDisabled(
    await readOnlyMember(t, "Agent Saves Off"),
    AGENT_UPDATE_DENIED,
    agentSaves(),
  );
});

// Each Agent update also checks operate on every source the Agent and its Configuration bind:
// here the Slack token Secrets and the Harness authentication Secret. A member with Agent update
// but no Secret operate was offered these saves, and each answered 403 (finding 2441).
test("an Agent editor without operate on the bound Secrets sees the Agent-side saves disabled", async (t) => {
  const member = await readOnlyMember(t, "Agent Sources Off");
  grantMember(member.fixture, READER, [["update", "agent"]]);
  // As on Plugins, repository access reads as a summary with the note: no save could keep an
  // edit, so the editor and its choices read are not offered.
  await assertAgentSavesDisabled(member, AGENT_SOURCES_DENIED, agentSaves());
  await member.page
    .getByText(
      "The version draft selects no repositories. The Agent runs without repository access.",
    )
    .waitFor();
  // The answer the page showed: Agent update, but not the bound sources.
  const session = await member.fixture.signIn(member.member.credentials);
  const answer = await member.fixture.request(
    "GET",
    `/namespaces/${member.namespace.id}/agents/${member.agent.id}/permissions`,
    { session },
  );
  assert.equal(answer.data.update, true);
  assert.equal(answer.data.agentSourcesOperate, false);
});

// An Agent that uses a ServiceAccount for Harness authentication: each update also reads it. A
// member with every operate grant but no read on that account was asked only for operate, which
// an administrator could grant without effect (finding 2459). The note names both grants.
test("an Agent editor without read on the Harness ServiceAccount is told about it", async (t) => {
  const member = await readOnlyMember(t, "Account Read Off");
  const { fixture, namespace, agent, page } = member;
  // Issuance is outside this test: the account is seeded through State.
  const account = await fixture.controller.transact((state: PlatformUnitOfWork) =>
    state.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: "Harness account",
    }),
  );
  const switched = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    {
      body: {
        configurationId: agent.configurationId,
        harnessAuth: {
          method: "codex_pat",
          source: { kind: "service_account", namespaceId: namespace.id, id: account.id },
        },
      },
    },
  );
  assert.equal(switched.status, 200);
  grantMember(fixture, READER, [
    ["update", "agent"],
    ["operate", "secret"],
  ]);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
    member.member.credentials,
  );
  await page
    .getByRole("status")
    .filter({ hasText: AGENT_SOURCES_SERVICE_ACCOUNT_DENIED })
    .waitFor();
  assert.equal(await page.getByRole("status").filter({ hasText: AGENT_SOURCES_DENIED }).count(), 0);
});

// Each Agent update also needs Configuration read. When that read is the missing grant, the note
// names it instead of source operate, which this member has. The permission answer is held until
// the draft has read the Configuration, and the read is revoked meanwhile, so the real answer
// arrives after the editors are drawn.
test("an Agent editor whose Configuration read was revoked is told to ask for it", async (t) => {
  const { fixture, namespace, agent, member, page } = await readOnlyMember(t, "Read Revoked");
  grantMember(fixture, READER, [
    ["update", "agent"],
    ["operate", "secret"],
  ]);
  const answer = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    { once: true },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
    member.credentials,
  );
  await answer.requested;
  const save = page.getByRole("button", { name: "Save authentication source", exact: true });
  await save.waitFor();
  revokeMemberGrant(fixture, READER, ["read", "configuration"]);
  answer.release();
  await page.getByRole("status").filter({ hasText: AGENT_CONFIGURATION_READ_DENIED }).waitFor();
  assert.equal(await page.getByRole("status").filter({ hasText: AGENT_SOURCES_DENIED }).count(), 0);
  assert.equal(await save.isDisabled(), true);
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
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "repositories").href,
    member.credentials,
  );
  // Listing repository choices needs Agent update, so the reader is not sent that read: the
  // saved access shows as a summary with no editor (finding 2454).
  await page.getByText("application · Contributor", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: AGENT_UPDATE_DENIED }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Remove application" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).count(), 0);
  assert.deepEqual(await editableFields(page), []);
  assert.deepEqual(
    pathRequests(
      requests,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/repository-options`,
    ),
    [],
  );
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("heading", { name: "Plugin selections", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save plugin selections" }).count(), 0);
});

// An unknown permission answer keeps today's behaviour: the editor shows and its choices are
// read, and the API still authorizes every save (finding 2454).
test("an unknown permission answer keeps the repository access editor", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) => [
    {
      repositoryRef: "application",
      repositoryId: "1601",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(namespace.id, "Repository Editor", nativeValues("repo"));
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "repositories").href,
  );
  await page.getByText("Default repository access", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save repository access", exact: true }).waitFor();
  assert.notDeepEqual(
    pathRequests(
      requests,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/repository-options`,
    ),
    [],
  );
  assert.equal(await page.getByText(/read-only with your access/).count(), 0);
});

// Without a permission answer a reader's console still reads the repository choices. The API
// refuses them for lack of Agent update, and the status says so and who grants it, not that the
// choices are "denied" (finding D753).
test("a refused repository choices read names the Agent update it needs", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) => [
    {
      repositoryRef: "application",
      repositoryId: "1602",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(namespace.id, "Repository Choices", nativeValues("repo"));
  const member = await createReader(fixture, namespace);
  const { page } = await newPage(t, fixture, { browser });
  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  const refused = page.waitForResponse((response) =>
    response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}/repository-options`),
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "repositories").href,
    member.credentials,
  );
  assert.equal((await refused).status(), 403);
  await page.getByText(REPOSITORY_CHOICES_AGENT_DENIED, { exact: true }).waitFor();
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
  grantMember(fixture, READER, [["update", "agent"]]);
  await page.getByRole("button", { name: "Reload authentication source", exact: true }).click();
  await note.waitFor({ state: "detached" });
  // Each Agent update also checks operate on the Secrets the Agent and its Configuration bind,
  // which this member lacks: the reread names that grant instead (finding 2441).
  const sourcesNote = page.getByRole("status").filter({ hasText: AGENT_SOURCES_DENIED });
  await sourcesNote.waitFor();
  assert.equal(await save.isDisabled(), true);
  grantMember(fixture, READER, [["operate", "secret"]]);
  await page.getByRole("button", { name: "Reload authentication source", exact: true }).click();
  await sourcesNote.waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Save authentication source", exact: true, disabled: false })
    .waitFor();
  await waitForEnabled(page.getByLabel("Authentication source", { exact: true }));
});

// A plugin edit left unsaved on another tab was kept as a draft. Once a reread answer denied
// Agent update, Plugins showed its summary but the kept edit still counted as unsaved: Deploy
// said "Save or discard plugin changes" and nothing could discard it (finding 2463). The summary
// shows the Agent as read, so it drops the kept edit and Deploy no longer waits for it.
test("a plugin edit kept across a revoked Agent update no longer holds Deploy", async (t) => {
  const { fixture, namespace, agent, member, page } = await readOnlyMember(t, "Plugin Draft");
  grantMember(fixture, READER, [
    ["update", "agent"],
    ["deploy", "agent"],
    ["operate", "secret"],
  ]);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "plugins").href,
    member.credentials,
  );
  const held = page.getByText("Save or discard plugin changes before deploying.", {
    exact: true,
  });
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  const json = page.getByLabel("Plugin selections JSON", { exact: true });
  await waitForEnabled(json);
  await json.fill(JSON.stringify({ "codex-plugin:linear@openai-curated-remote": {} }));
  await held.waitFor();

  // Leaving the tab keeps the edit. Agent update is revoked, and Reload authentication source
  // rereads the permission answer.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  revokeMemberGrant(fixture, READER, ["update", "agent"]);
  await page.getByRole("button", { name: "Reload authentication source", exact: true }).click();
  await page.getByRole("status").filter({ hasText: AGENT_UPDATE_DENIED }).waitFor();
  await held.waitFor();

  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("heading", { name: "Plugin selections", exact: true }).waitFor();
  await page.getByText("No plugins are selected.", { exact: true }).waitFor();
  await held.waitFor({ state: "detached" });
  // The kept edit is gone for good: leaving and reopening the tab does not bring it back.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByRole("status").filter({ hasText: AGENT_UPDATE_DENIED }).waitFor();
  assert.equal(await held.count(), 0);
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
    const secret = await fixture.createSecret(
      namespace.id,
      "Protected harness association",
      "synthetic-value",
    );
    const marker = "protected-saved-document-marker";
    const agent = await fixture.createAgent(
      namespace.id,
      `Protected ${c.tab} Agent title`,
      nativeValues(marker),
      {
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: secret.ref },
      },
    );
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", c.tab).href;
    await login(page, fixture, url);
    await c.edit(page);
    const denied = c.deny(agent);
    const restriction = restrict(fixture.policy, "read", denied.resourceKind, {
      namespaceId: namespace.id,
      resourceId: denied.resourceId,
    });
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response
          .url()
          .endsWith(
            `/${denied.resourceKind === "agent" ? "agents" : "configurations"}/${denied.resourceId}`,
          ),
    );
    await c.save(page);
    assert.equal((await response).status(), 403);
    const requestId = (await (await response).json()).meta.requestId;
    await page.getByText(SAVE_READ_REFUSED, { exact: true }).waitFor();
    assert.ok(requestId);
    await page.getByText(`Request ID: ${requestId}`, { exact: true }).waitFor();
    assert.equal((await page.locator("body").innerText()).split(requestId).length - 1, 1);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    // A truthful receipt survives, but the denied preflight must retire all protected editors.
    const absent = async () => {
      const html = await page.content();
      for (const value of [secret.id, secret.name, marker, "edited after a revoke"]) {
        assert.equal(html.includes(value), false, value);
      }
      assert.equal(await page.getByLabel("Configuration JSON", { exact: true }).count(), 0);
      assert.equal(await page.getByLabel("API key Secret", { exact: true }).count(), 0);
      if (c.tab === "credentials") {
        assert.equal(html.includes(agent.name), false);
        assert.equal(await page.getByRole("button", { name: "Deploy", exact: true }).count(), 0);
      }
    };
    await absent();
    assert.equal((await page.content()).includes(agent.name), false);
    // Fresh admission and history must not reattach the discarded editor or its draft.
    const passiveRefusal =
      c.tab === "credentials"
        ? page.waitForResponse(
            (response) =>
              response.url().endsWith(`/agents/${agent.id}`) && response.status() === 403,
          )
        : null;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    if (passiveRefusal) {
      const passiveId = (await (await passiveRefusal).json()).meta.requestId;
      await page
        .getByText(`Request ID: ${passiveId}`, { exact: true })
        .waitFor({ state: "attached" });
      await page.getByText("Request details", { exact: true }).click();
      await page.getByText(`Request ID: ${passiveId}`, { exact: true }).waitFor();
      assert.equal((await page.locator("body").innerText()).split(passiveId).length - 1, 1);
    }
    await page
      .getByRole("heading", {
        name: c.tab === "credentials" ? "Access denied" : "Configuration unavailable",
        exact: true,
      })
      .waitFor();
    await absent();
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
    await page.goBack();
    await page
      .getByRole("heading", {
        name: c.tab === "credentials" ? "Access denied" : "Configuration unavailable",
        exact: true,
      })
      .waitFor();
    await absent();
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    liftRestriction(fixture.policy, restriction);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    if (c.tab === "configuration") {
      await page.getByRole("heading", { name: "Configuration unavailable", exact: true }).waitFor();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      // Restoring access reads saved values, never the draft captured before revocation.
      await page.getByRole("button", { name: "Edit Configuration", exact: true }).click();
      await openAdvancedSettings(page);
      const value = await page.getByLabel("Configuration JSON", { exact: true }).inputValue();
      assert.ok(value.includes(marker));
      assert.equal(value.includes("edited after a revoke"), false);
    } else {
      await page.getByLabel("API key Secret", { exact: true }).waitFor();
    }
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
  await page.getByText(WORKSPACE_SAVE_REFUSED, { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), "after");
});

const OPERATE_REASON = WORKSPACE_SAVE_DENIED;

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
  await page.getByText(OPERATE_REASON, { exact: true }).waitFor();
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await page
      .getByRole("tablist", { name: "Workspace file", exact: true })
      .getByRole("tab", { name: new RegExp(name.replace(".", "\\.")) })
      .click();
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
      OPERATE_REASON,
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

// The page's other operate-gated controls follow the same observed answer as Workspace: the Stop
// row hides and each version's Run diagnostics disables while operate is denied (finding 2328).
async function expectOperateControls(page: Page, allowed: boolean) {
  const stopRow = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRow.waitFor({ state: allowed ? "visible" : "hidden" });
  await page.getByRole("tab", { name: "Deployment", exact: true }).click();
  const run = page.getByRole("button", { name: "Run diagnostics for this version", exact: true });
  await run.waitFor();
  const denial = page.getByText(DIAGNOSTICS_DENIED, { exact: true });
  await denial.waitFor({ state: allowed ? "hidden" : "visible" });
  assert.equal(await run.isDisabled(), !allowed);
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
}

// A reader without Agent operate on the Agent's Workspace tab. Runtime status answers 403, so
// Logs remembers a status denial and every later Logs visit rereads the permission answer from
// the real API and IAM policy; `operate` grants or removes Agent operate there.
async function operateScenario(t: TestContext, name: string) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("ws-operate"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = await createReader(fixture, namespace);
  const { page } = await newPage(t, fixture, { browser });
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const permissionsUrl = `${fixture.origin}${agentPath}/permissions`;
  await page.route(
    `${fixture.origin}${agentPath}/deployments/${active.revision.id}/runtime`,
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden." } }),
      }),
  );
  await page.route(`${fixture.origin}${agentPath}/workspace/files/*`, (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    if (route.request().method() !== "GET") {
      return route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { name: file, content: `# ${file}\n` } }),
    });
  });
  const binding = {
    id: "binding-workspace-operate",
    namespaceId: namespace.id,
    subjectKind: "identity" as const,
    subjectId: member.principal.id,
    roleId: "role-workspace-operate",
  };
  fixture.policy.roles.push({
    id: binding.roleId,
    namespaceId: namespace.id,
    permissions: [{ action: "operate", resourceKind: "agent" }],
  });
  return {
    fixture,
    namespace,
    agent,
    page,
    permissionsUrl,
    editor: page.getByLabel("AGENTS.md", { exact: true }),
    // Opens the Workspace tab. By default it waits, as a reader without operate, for the reason
    // and then every file; `answered: false` is for a page whose permission read fails.
    open: async ({ answered = true } = {}) => {
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
        member.credentials,
      );
      if (answered) {
        await page.getByText(OPERATE_REASON, { exact: true }).waitFor();
        for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
          // All files load before retention, including the editors hidden by the picker.
          await page.getByText(`${file} loaded.`, { exact: true }).waitFor({ state: "attached" });
        }
      }
    },
    operate(allowed: boolean) {
      const index = fixture.policy.bindings.findIndex((entry) => entry.id === binding.id);
      if (allowed && index === -1) {
        fixture.policy.bindings.push(binding);
      } else if (!allowed && index !== -1) {
        fixture.policy.bindings.splice(index, 1);
      }
    },
    // The first Logs visit records the status denial without a fresh permission read.
    async rememberStatusDenial() {
      await page.getByRole("tab", { name: "Logs", exact: true }).click();
      await page.getByText(/Runtime status requires Agent operate/).waitFor();
      await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
    },
    // A later Logs visit rereads the answer; Workspace is shown again once it has answered.
    async rereadThroughLogs() {
      const answered = page.waitForResponse(
        (response) =>
          response.url() === permissionsUrl &&
          response.request().method() === "GET" &&
          response.status() === 200,
      );
      await page.getByRole("tab", { name: "Logs", exact: true }).click();
      await answered;
      await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
    },
  };
}

// The Workspace editor is kept while the reader visits Logs. Logs can observe a newer Agent
// operate answer. Coming back must apply that answer and keep any unsaved text; Stop and Run
// diagnostics follow it too, without a reload.
test("restoring Workspace applies the operate answer the page already observed", async (t) => {
  const scenario = await operateScenario(t, "Workspace operate restore");
  const { page, editor } = scenario;
  await scenario.open();
  assert.equal(await editor.isEditable(), false);
  await expectOperateControls(page, false);

  await scenario.rememberStatusDenial();
  await page.getByText(OPERATE_REASON, { exact: true }).waitFor();
  scenario.operate(true);
  await scenario.rereadThroughLogs();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(await page.getByText(OPERATE_REASON, { exact: true }).count(), 0);
  assert.equal(await editor.isEditable(), true);
  await expectOperateControls(page, true);
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  await editor.fill("kept across the revocation");

  scenario.operate(false);
  await scenario.rereadThroughLogs();
  await page.getByText(OPERATE_REASON, { exact: true }).waitFor();
  assert.equal(await editor.isEditable(), false);
  assert.equal(await editor.inputValue(), "kept across the revocation");
  await expectOperateControls(page, false);
  assert.equal(await editor.inputValue(), "kept across the revocation");
});

// An answer that arrives after Workspace is shown again applies to the shown editor, not only to
// parked ones, and to the page's other operate-gated controls (finding 2328).
test("an operate answer that arrives while Workspace is shown applies to it", async (t) => {
  const scenario = await operateScenario(t, "Workspace operate shown");
  const { page, editor } = scenario;
  await scenario.open();
  await scenario.rememberStatusDenial();
  scenario.operate(true);
  const reread = await holdRequests(t, page, scenario.permissionsUrl, {
    once: true,
    method: "GET",
    afterServer: true,
  });
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await reread.requested;
  // The restored Workspace is the retained one (every file loaded first): a rebuilt tab would
  // take the held read itself and hide a regression in the mounted-tab apply.
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await page.getByText(OPERATE_REASON, { exact: true }).waitFor();
  reread.release();
  await page.getByText(OPERATE_REASON, { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await editor.isEditable(), true);
  await expectOperateControls(page, true);
});

// A Stop refused while the permission answer was unavailable names the missing grant. When a
// later answer denies operate and a grant follows, the row returns without that refusal.
test("a Stop refusal clears once a later answer grants Agent operate", async (t) => {
  const scenario = await operateScenario(t, "Stop refusal grant");
  const { page } = scenario;
  await withholdPermissionSummary(page, scenario.fixture, scenario.namespace.id, scenario.agent.id);
  await scenario.open({ answered: false });
  const stopRow = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRow.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  const refusal = page.getByText(stopRefused("Stop refusal grant"), { exact: true });
  await refusal.waitFor();
  await page.unroute(scenario.permissionsUrl);
  await scenario.rememberStatusDenial();
  // The row stays because this viewer used it; the denial disables Stop and adds its notice.
  // Exact: the refusal repeats the reason after "Stop was refused:".
  const notice = stopRow.getByText(AGENT_STOP_DENIED, { exact: true });
  await scenario.rereadThroughLogs();
  await notice.waitFor();
  // The refused Stop stays in the Tab order, described by that notice (finding 2935).
  const stop = stopRow.getByRole("button", { name: "Stop Agent", exact: true });
  await expectReachableReason(page, stop, AGENT_STOP_DENIED);
  scenario.operate(true);
  await scenario.rereadThroughLogs();
  await notice.waitFor({ state: "hidden" });
  await waitForEnabled(stop);
  // The grant leaves no stale reason on Stop.
  assert.deepEqual(
    await stop.evaluate((node) => ({
      ariaDisabled: node.getAttribute("aria-disabled"),
      describedby: node.getAttribute("aria-describedby"),
    })),
    { ariaDisabled: null, describedby: null },
  );
  assert.equal(await refusal.count(), 0);
});

// After this viewer's Stop is accepted, a later answer that denies Agent operate keeps the row
// (they used it). Request Stop again stays in the Tab order, described by the denial notice,
// and activating it opens no confirmation and sends nothing (finding 2946).
test("a refused Request Stop again stays reachable with its reason", async (t) => {
  const scenario = await operateScenario(t, "Repeat stop refusal");
  const { page } = scenario;
  scenario.operate(true);
  await scenario.open({ answered: false });
  const stopRow = page.getByRole("region", { name: "Stop Agent", exact: true });
  const stop = stopRow.getByRole("button", { name: "Stop Agent", exact: true });
  await waitForEnabled(stop);
  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  const repeat = stopRow.getByRole("button", { name: "Request Stop again", exact: true });
  await waitForEnabled(repeat);
  scenario.operate(false);
  await scenario.rememberStatusDenial();
  await scenario.rereadThroughLogs();
  await stopRow.getByText(AGENT_STOP_DENIED, { exact: true }).waitFor();
  await expectReachableReason(page, repeat, AGENT_STOP_DENIED);
  assert.equal(await page.getByRole("dialog", { name: "Stop this Agent?" }).count(), 0);
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
    await page.getByRole("button", { name: "Manage rules", exact: true }).click();
    await page.getByLabel("Actions for network rule 1", { exact: true }).click();
    await page.getByRole("button", { name: "Remove rule", exact: true }).click();
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
      assert.equal(
        await page.getByRole("button", { name: "Save for later", exact: true }).count(),
        0,
      );
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
        await page.getByRole("button", { name: /^(Apply saved rules|Retry application)$/ }).count(),
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

// Binding persistence precedes access grants. A failed retry must retain that fact without
// retaining any of the binding metadata or replaying the already successful PATCH.
for (const { resource, status } of [
  { resource: "agent", status: 403 },
  { resource: "configuration", status: 403 },
  { resource: "configuration", status: 503 },
] as const) {
  test(`saved channel bindings retain a sanitized receipt when ${resource} retry read answers ${status}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Saved binding retry", { ready: true });
    const original = await fixture.createSecret(
      namespace.id,
      "Original retry app",
      "synthetic-original",
    );
    const replacement = await fixture.createSecret(
      namespace.id,
      "Replacement retry app",
      "synthetic-replacement",
    );
    const bot = await fixture.createSecret(namespace.id, "Retry bot", "synthetic-bot");
    const agent = await fixture.createAgent(
      namespace.id,
      "Saved binding retry Agent",
      nativeValues("retry-document", {
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          },
        },
      }),
      {
        executionMode: "dedicated",
        secretBindings: {
          SLACK_APP_TOKEN: { source: original.ref, delivery: { type: "env" } },
          SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
        },
      },
    );
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "credentials").href,
    );
    await waitForInputValue(page.getByLabel("Slack app token", { exact: true }), original.name);
    await selectSecret(page, "Slack app token", replacement);
    const noGrant = restrict(fixture.policy, "administer", "installation");
    await page.getByRole("button", { name: "Save channel Secrets", exact: true }).click();
    const retry = page.getByRole("button", { name: "Retry Secret access", exact: true });
    await waitForEnabled(retry);
    const configPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    assert.equal(
      (await fixture.request("GET", configPath)).data.secretBindings.SLACK_APP_TOKEN.source.id,
      replacement.id,
    );
    assert.equal(pathRequests(requests, "PATCH", configPath).length, 1);
    liftRestriction(fixture.policy, noGrant);
    const deniedPath =
      resource === "agent" ? `/namespaces/${namespace.id}/agents/${agent.id}` : configPath;
    const denial =
      status === 403
        ? restrict(fixture.policy, "read", resource, {
            namespaceId: namespace.id,
            resourceId: resource === "agent" ? agent.id : agent.configurationId,
          })
        : null;
    if (status === 503) {
      await page.route(`${fixture.origin}${deniedPath}`, (route) =>
        route.request().method() === "GET"
          ? route.fulfill(
              apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Temporarily unavailable"),
            )
          : route.continue(),
      );
    }
    requests.length = 0;
    const response = page.waitForResponse(
      (r) => r.url().endsWith(deniedPath) && r.request().method() === "GET",
    );
    await retry.click();
    assert.equal((await response).status(), status);
    await page
      .getByText(
        new RegExp(
          `Channel Secret bindings are saved\\. Could not read the ${resource === "agent" ? "Agent" : "Configuration"} before retrying Secret access`,
        ),
      )
      .waitFor();
    if (denial) {
      const requestId = (await (await response).json()).meta.requestId;
      assert.ok(requestId);
      assert.equal((await page.locator("body").innerText()).split(requestId).length - 1, 1);
      const html = await page.content();
      for (const secret of [original, replacement, bot]) {
        assert.equal(html.includes(secret.id), false);
        assert.equal(html.includes(secret.name), false);
      }
      liftRestriction(fixture.policy, denial);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
    } else {
      await page.unroute(`${fixture.origin}${deniedPath}`);
    }
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    await waitForInputValue(page.getByLabel("Slack app token", { exact: true }), replacement.name);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    await page.getByRole("button", { name: "Retry Secret access", exact: true }).click();
    await page.getByText("This Agent can use its saved Slack Secrets.", { exact: false }).waitFor();
    assert.equal(pathRequests(requests, "PATCH", configPath).length, 0);
    const grants = requests.filter(
      ({ method, path }) => method === "POST" && path.endsWith("/iam/access-bindings"),
    );
    assert.equal(grants.length, 1);
    const granted = grants[0]?.body;
    assert.ok(granted && typeof granted === "object" && "resourceId" in granted);
    assert.equal(granted.resourceId, replacement.id);
  });
}

// A transport failure does not establish revoked read access: keep the staged document,
// and permit one explicit retry after the dependency recovers.
for (const c of readRefusals) {
  test(`a transient read before saving the ${c.name} retains the editor for explicit retry`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Transient save read", { ready: true });
    const agent = await fixture.createAgent(
      namespace.id,
      "Transient save Agent",
      nativeValues("transient-read"),
    );
    const { page } = await newPage(t, fixture, { browser });
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", c.tab).href);
    await c.edit(page);
    const resource = c.deny(agent);
    const path = `/namespaces/${namespace.id}/${resource.resourceKind === "agent" ? "agents" : "configurations"}/${resource.resourceId}`;
    await page.route(`${fixture.origin}${path}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Temporarily unavailable"))
        : route.continue(),
    );
    const response = page.waitForResponse(
      (r) => r.url().endsWith(path) && r.request().method() === "GET",
    );
    await c.save(page);
    assert.equal((await response).status(), 503);
    const save = page.getByRole("button", {
      name: c.tab === "credentials" ? "Save authentication source" : "Save Configuration",
      exact: true,
    });
    await waitForEnabled(save);
    await page.getByRole("heading", { name: agent.name, exact: true }).waitFor();
    if (c.tab === "configuration") {
      assert.ok(
        (await page.getByLabel("Configuration JSON", { exact: true }).inputValue()).includes(
          "edited after a revoke",
        ),
      );
    }
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    await page.unroute(`${fixture.origin}${path}`);
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().endsWith(path),
    );
    await save.click();
    assert.equal((await saved).status(), 200);
    assert.equal(pathRequests(requests, "PATCH", path).length, 1);
  });
}
