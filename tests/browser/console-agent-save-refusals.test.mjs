import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { detailUrl, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";
import { openAdvancedSettings } from "./console-agents-test-support.mjs";

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

async function readOnlyMember(t, name) {
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
  const member = await fixture.createAccountWithPolicy("save-refusal-reader", (principal) => {
    fixture.policy.roles.push({
      id: "role-save-refusal-reader",
      namespaceId: namespace.id,
      permissions: ["namespace", "agent", "agent_revision", "configuration"].map(
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
  });
  const { page } = await newPage(t, fixture);
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
    async save(page) {
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
    async save(page) {
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
      detailUrl(fixture, namespace.id, agent.id, "draft", c.tab),
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

test("a member without Agent update sees the Agent-side saves disabled with the reason", async (t) => {
  const { fixture, namespace, agent, member, page } = await readOnlyMember(t, "Agent Saves Off");
  const tabs = [
    { tab: "plugins", save: "Save plugin selections" },
    { tab: "credentials", save: "Save authentication source" },
    { tab: "repositories", save: "Save repository access" },
  ];
  const patches = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH") {
      patches.push(request.url());
    }
  });
  for (const [index, { tab, save }] of tabs.entries()) {
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", tab);
    if (index === 0) {
      await login(page, fixture, url, member.credentials);
    } else {
      await page.goto(url.href);
    }
    const button = page.getByRole("button", { name: save, exact: true });
    await button.waitFor();
    await page.getByRole("status").filter({ hasText: AGENT_UPDATE_DENIED }).waitFor();
    // The note is the proof where Save is also disabled for an unedited form.
    if (tab === "plugins") {
      // An edit does not enable it.
      await page.getByText("Plugin selections JSON", { exact: true }).click();
      await page.getByLabel("Plugin selections JSON", { exact: true }).fill('{"edited":{}}');
    }
    assert.equal(await button.isDisabled(), true, `${save} is disabled`);
  }
  assert.deepEqual(patches, []);
});
