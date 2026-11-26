import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  apiRequests,
  createSlackSourceConsoleFixture as sourceConsole,
  detailUrl,
  login,
  newPage,
  revokeAdministratorGrant,
  setSlackSelection,
} from "./console-agents-browser-helpers.ts";
import { enterManualModel, openAdvancedSettings } from "./console-agents-ui-test-support.ts";

function grantExactSourceOperate(
  fixture: Awaited<ReturnType<typeof sourceConsole>>["fixture"],
  namespaceId: string,
  sourceIds: string[],
) {
  const administrator = fixture.policy.roles.find(
    ({ name }) => name === "Installation administrator",
  );
  const administratorBinding = fixture.policy.bindings.find(
    ({ roleId }) => roleId === administrator?.id,
  );
  assert.ok(administratorBinding);
  const roleId = `source-operate-${randomUUID()}`;
  fixture.policy.roles.push({
    id: roleId,
    namespaceId,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  for (const id of sourceIds) {
    fixture.policy.bindings.push({
      id: `${roleId}-${id}`,
      namespaceId,
      subjectKind: "identity",
      subjectId: administratorBinding.subjectId,
      roleId,
      resourceKind: "credential_source",
      resourceId: id,
    });
  }
}

// The editing steps share one saved Agent and advance its draft from simple to named Slack settings.
test("Edit Slack Channel credentials and Configuration with Credential Sources", async (t) => {
  const { fixture, namespace, enroll } = await sourceConsole(t, "Slack Source UI");

  let botCredential = "";
  const slackDriver = new SlackChannelDriver(
    async (input: URL | Request | string, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(url.origin, "https://slack.com");
      assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${botCredential}`);
      switch (url.pathname) {
        case "/api/auth.test":
          return Response.json({
            ok: true,
            bot_id: "B12345678",
            team_id: "T12345678",
            team: "Fixture workspace",
          });
        case "/api/conversations.list":
          return Response.json({
            ok: true,
            channels: [{ id: "C12345678", name: "platform" }],
            response_metadata: { next_cursor: "" },
          });
        case "/api/conversations.info":
          return Response.json({
            ok: true,
            channel: { id: url.searchParams.get("channel"), name: "platform" },
          });
        default:
          throw new Error(`Unexpected controlled provider method ${url.pathname}`);
      }
    },
  );
  fixture.controller.registerDriver(slackDriver);
  fixture.controller.selectDriver("channel", slackDriver.id);
  const app = (await enroll("App credential", "xapp")).source;
  const botEnrollment = await enroll("Bot credential");
  const bot = botEnrollment.source;
  botCredential = botEnrollment.secret;
  const replacement = (await enroll("Replacement bot credential")).source;
  const signing = (await enroll("Signing credential", "synthetic")).source;
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Source operator",
    {
      ...createHarnessConfiguration("openclaw", "gpt-5"),
      channels: {
        slack: {
          enabled: true,
          dmPolicy: "disabled",
          groupPolicy: "allowlist",
          channels: { C12345678: { requireMention: true, users: ["*"] } },
          appToken: "${SLACK_APP_TOKEN}",
          botToken: "${SLACK_BOT_TOKEN}",
        },
      },
    },
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const directoryPath = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const directoryResponse = (predicate: (body: Record<string, unknown>) => boolean) =>
    page.waitForResponse(
      (result) =>
        result.url() === fixture.origin + directoryPath &&
        result.request().method() === "POST" &&
        predicate(result.request().postDataJSON()),
    );
  await t.test(
    "directory uses the selected Source and checks Source and target permissions",
    async () => {
      await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "channels"));
      const editSlack = page.getByRole("button", { name: "Edit Slack", exact: true });
      await editSlack.waitFor();
      assert.equal(
        requests.filter(
          ({ method, path }) =>
            method === "GET" && path === `/namespaces/${namespace.id}/credential-sources`,
        ).length,
        0,
        "a closed Credentials panel does not discover Sources on the Channels tab",
      );
      await editSlack.click();
      const drawer = page.getByRole("dialog", { name: "Edit Slack", exact: true });
      const browseResponse = directoryResponse((body) => body.query === "platform");
      await drawer.getByRole("combobox", { name: "Channels", exact: true }).fill("platform");
      const browse = await browseResponse;
      assert.equal(browse.status(), 200, await browse.text());
      assert.deepEqual(browse.request().postDataJSON(), {
        sourceId: bot.id,
        kind: "channels",
        query: "platform",
        configurationId: agent.configurationId,
      });
      await drawer.getByRole("option", { name: /#platform.*C12345678/ }).waitFor();

      // Read discovery does not authorize using the selected Source for directory lookup.
      const sourceRestore = revokeAdministratorGrant(fixture, ["operate", "credential_source"]);
      const deniedResponse = directoryResponse((body) => body.query === "denied-source");
      await drawer.getByRole("combobox", { name: "Channels", exact: true }).fill("denied-source");
      const denied = await deniedResponse;
      assert.equal(denied.status(), 403);
      await drawer.getByText(new RegExp(`Credential ?Source.*operate.*${bot.id}`, "i")).waitFor();
      sourceRestore();
      const targetRestore = revokeAdministratorGrant(fixture, ["update", "configuration"]);
      const targetResponse = directoryResponse((body) => body.query === "denied-target");
      await drawer.getByRole("combobox", { name: "Channels", exact: true }).fill("denied-target");
      assert.equal((await targetResponse).status(), 403);
      await drawer
        .getByText(new RegExp(`Configuration.*update.*${agent.configurationId}`, "i"))
        .waitFor();
      targetRestore();
      await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
    },
  );
  await t.test(
    "denied saved binding blocks Disable and unchanged edits but permits replacement",
    async () => {
      // Give the administrator exact Source operate on app and the replacement, but not the saved bot.
      // The real permission advice must make Disable unavailable and allow replacing only that denied binding.
      grantExactSourceOperate(fixture, namespace.id, [app.id, replacement.id]);
      const persistedRestore = revokeAdministratorGrant(fixture, ["operate", "credential_source"]);
      await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "channels").href);
      const disable = page.getByRole("button", { name: "Disable Slack", exact: true });
      await page
        .getByText(
          new RegExp(
            `Disabling keeps Slack bot token unchanged.*Credential Source operate.*${bot.id}`,
            "i",
          ),
        )
        .waitFor();
      assert.equal(await disable.isDisabled(), true);
      await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Edit Slack", exact: true });
      await drawer.getByLabel("Require a mention").setChecked(false);
      const writesBefore = requests.filter(
        ({ method, path }: { method: string; path: string }) =>
          method === "PATCH" && path === configurationPath,
      ).length;
      await drawer.getByRole("button", { name: "Save configuration", exact: true }).click();
      await drawer
        .getByText(
          new RegExp(
            `This save keeps Slack bot token unchanged.*Credential Source operate.*${bot.id}`,
            "i",
          ),
        )
        .waitFor();
      assert.equal(
        requests.filter(
          ({ method, path }: { method: string; path: string }) =>
            method === "PATCH" && path === configurationPath,
        ).length,
        writesBefore,
        "unchanged denied Source is refused locally with no PATCH",
      );
      await drawer.getByLabel("Slack bot token", { exact: true }).selectOption(replacement.id);
      const reboundResponse = page.waitForResponse(
        (result) =>
          result.url() === fixture.origin + configurationPath &&
          result.request().method() === "PATCH",
      );
      await drawer.getByRole("button", { name: "Save configuration", exact: true }).click();
      assert.equal((await reboundResponse).status(), 200);
      persistedRestore();
      const persisted = await fixture.request("GET", configurationPath);
      assert.deepEqual(persisted.data.secretBindings.SLACK_BOT_TOKEN.source, replacement.ref);
    },
  );
  await t.test(
    "named Credential Source pickers share discovery and permit explicit refresh",
    async () => {
      const persisted = await fixture.request("GET", configurationPath);
      // Named Slack fields use the same Source selector and canonical binding through the actual Credentials panel.
      const namedValues = structuredClone(persisted.data.values);
      const {
        appToken: _defaultApp,
        botToken: _defaultBot,
        ...otherSlackSettings
      } = namedValues.channels.slack;
      namedValues.channels.slack = {
        ...otherSlackSettings,
        accounts: {
          ops: {
            enabled: true,
            appToken: "${OPS_APP}",
            botToken: "${OPS_BOT}",
          },
        },
      };
      const namedBindings = {
        OPS_APP: { source: app.ref, delivery: { type: "env" } },
        OPS_BOT: { source: replacement.ref, delivery: { type: "env" } },
      };
      const namedPrepared = await fixture.request("PATCH", configurationPath, {
        body: {
          expectedGeneration: persisted.data.generation,
          values: namedValues,
          secretBindings: namedBindings,
        },
      });
      assert.equal(namedPrepared.status, 200);
      // Reload the Channels view to observe the externally staged named-account draft, then use
      // the tab strip rather than a new page load to activate the existing Credentials panel.
      await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "channels").href);
      await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();
      const sourceListPath = `/namespaces/${namespace.id}/credential-sources`;
      let sourceListReads = 0;
      // A save in the preceding Channels view can finish its own inventory read as navigation
      // starts. Count only requests made by the Credentials view whose controls are under test.
      page.on("request", (request) => {
        if (
          request.method() === "GET" &&
          request.url() === fixture.origin + sourceListPath &&
          new URL(page.url()).searchParams.get("tab") === "credentials"
        ) {
          sourceListReads += 1;
        }
      });
      await page.getByRole("tab", { name: "Credentials", exact: true }).click();
      await page.getByLabel("OPS_APP", { exact: true }).waitFor();
      await page.getByLabel("OPS_BOT", { exact: true }).waitFor();
      const appSource = page.getByLabel("OPS_APP", { exact: true });
      await appSource.locator(`option[value="${app.id}"]`).waitFor({ state: "attached" });
      assert.equal(
        sourceListReads,
        1,
        "all visible Credential Source pickers share the pending inventory read",
      );
      const refreshed = page.waitForResponse(
        (result) =>
          result.url() === fixture.origin + sourceListPath && result.request().method() === "GET",
      );
      await appSource
        .locator("..")
        .getByRole("button", { name: "Refresh Source list", exact: true })
        .click();
      assert.equal((await refreshed).status(), 200);
      assert.equal(sourceListReads, 2, "explicit refresh issues a new inventory read");
    },
  );
  await t.test(
    "Detail adds a signing reference and carries its Source through reload",
    async () => {
      await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href);
      await page.getByRole("button", { name: "Edit Configuration", exact: true }).click();
      await openAdvancedSettings(page);
      const editor = page.getByLabel("Configuration JSON", { exact: true });
      const editedValues = JSON.parse(await editor.inputValue());
      editedValues.channels.slack.accounts.ops.signingSecret = "${SLACK_SIGNING_SECRET}";
      await editor.fill(JSON.stringify(editedValues, null, 2));
      await page.locator("#slack-binding-slack-signing-secret").selectOption(signing.id);
      const current = await fixture.request("GET", configurationPath);
      const otherEditor = await fixture.request("PATCH", configurationPath, {
        body: {
          expectedGeneration: current.data.generation,
          values: editedValues,
          secretBindings: {
            ...current.data.secretBindings,
            SLACK_SIGNING_SECRET: { source: replacement.ref, delivery: { type: "env" } },
          },
        },
      });
      assert.equal(otherEditor.status, 200);
      const patchesBefore = requests.filter(
        ({ method, path }) => method === "PATCH" && path === configurationPath,
      ).length;
      await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
      const reload = page.getByRole("button", { name: "Reload draft", exact: true });
      await reload.waitFor();
      assert.equal(
        requests.filter(({ method, path }) => method === "PATCH" && path === configurationPath)
          .length,
        patchesBefore,
        "generation preflight refuses stale save without a PATCH",
      );
      await reload.click();
      await page
        .getByText("Your edits are applied over the reloaded Configuration.", { exact: false })
        .waitFor();
      const carried = page.locator("#slack-binding-slack-signing-secret");
      await carried
        .locator("..")
        .getByText("Listing confirms read access", { exact: false })
        .waitFor();
      await carried.locator(`option[value="${signing.id}"]`).waitFor({ state: "attached" });
      assert.equal(
        await carried.inputValue(),
        signing.id,
        "staged Source A remains visible after Source B was saved elsewhere",
      );
      assert.deepEqual(
        (await fixture.request("GET", configurationPath)).data.secretBindings.SLACK_SIGNING_SECRET
          .source,
        replacement.ref,
        "Reload does not overwrite saved Source B",
      );
      const atomicSave = page.waitForResponse(
        (result) =>
          result.url() === fixture.origin + configurationPath &&
          result.request().method() === "PATCH",
      );
      await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
      const saved = await atomicSave;
      assert.equal(saved.status(), 200);
      const payload = saved.request().postDataJSON();
      assert.equal(
        payload.values.channels.slack.accounts.ops.signingSecret,
        "${SLACK_SIGNING_SECRET}",
      );
      assert.deepEqual(payload.secretBindings.SLACK_SIGNING_SECRET.source, signing.ref);
      const committed = await fixture.request("GET", configurationPath);
      assert.deepEqual(committed.data.secretBindings.SLACK_SIGNING_SECRET.source, signing.ref);
      assert.equal(
        committed.data.values.channels.slack.accounts.ops.signingSecret,
        "${SLACK_SIGNING_SECRET}",
      );
    },
  );
});

// The Create steps share one unsaved form to verify approver follow and native binding admission.
test("Create an Agent with Slack Credential Sources and approvers", async (t) => {
  const preset = JSON.parse(
    await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
  );
  const { fixture, namespace, enroll } = await sourceConsole(t, "Approver Source follow", {
    defaultPresets: [preset],
  });
  const plugin = new CodexPluginDriver();
  fixture.controller.registerDriver(plugin);
  fixture.controller.selectDriver("plugin", plugin.id);
  const app = await enroll("App credential", "xapp");
  const first = await enroll("First bot credential");
  const second = await enroll("Second bot credential");
  const signing = await enroll("Signing credential", "synthetic");
  const slack = new SlackChannelDriver(
    async (input: URL | Request | string, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(url.origin, "https://slack.com");
      const token = new Headers(options?.headers).get("authorization");
      assert.ok(token === `Bearer ${first.secret}` || token === `Bearer ${second.secret}`);
      if (url.pathname === "/api/auth.test") {
        return Response.json({ ok: true, bot_id: "B12345678", team_id: "T12345678" });
      }
      if (url.pathname === "/api/users.list") {
        return Response.json({
          ok: true,
          members: [
            {
              id: "U12345678",
              name: token === `Bearer ${first.secret}` ? "alpha" : "beta",
              profile: { display_name: "Fixture person" },
            },
          ],
          response_metadata: { next_cursor: "" },
        });
      }
      if (url.pathname === "/api/conversations.info") {
        return Response.json({
          ok: true,
          channel: { id: url.searchParams.get("channel"), name: "platform" },
        });
      }
      throw new Error(`Unexpected controlled provider method ${url.pathname}`);
    },
  );
  fixture.controller.registerDriver(slack);
  fixture.controller.selectDriver("channel", slack.id);
  const { page } = await newPage(t, fixture);
  const lookupPath = `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`;
  const responseFor = (query: string) =>
    page.waitForResponse(
      (result) =>
        result.url() === lookupPath &&
        result.request().method() === "POST" &&
        result.request().postDataJSON().query === query,
    );
  await t.test("approver directory follows the selected channel bot Source", async () => {
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
    const unbound = page.getByText("No Credential Source bound", { exact: true });
    await unbound.first().waitFor();
    assert.equal(await unbound.count(), 2);
    await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
    let drawer = page.getByRole("dialog", { name: "Configure Slack", exact: true });
    await drawer.getByLabel("Direct-message policy").selectOption("disabled");
    await setSlackSelection(
      drawer.getByRole("combobox", { name: "Channels", exact: true }),
      "C12345678",
    );
    await drawer.getByLabel("Who can use the agent in these channels?").selectOption("everyone");
    await drawer.getByLabel("Slack app token", { exact: true }).selectOption(app.source.id);
    await drawer.getByLabel("Slack bot token", { exact: true }).selectOption(first.source.id);
    await drawer.getByRole("button", { name: "Apply channel settings", exact: true }).click();
    await openAdvancedSettings(page);
    await page.getByLabel("Default plugin approvers mode", { exact: true }).selectOption("chosen");
    let directorySource = page.getByLabel("Slack bot Credential Source for people search", {
      exact: true,
    });
    await directorySource
      .locator(`option[value="${first.source.id}"]`)
      .waitFor({ state: "attached" });
    assert.equal(await directorySource.inputValue(), first.source.id);
    const people = page.getByRole("combobox", {
      name: "Default plugin approvers people",
      exact: true,
    });
    let response = responseFor("alpha");
    await people.fill("alpha");
    assert.equal((await response).status(), 200, await (await response).text());
    assert.equal((await response).request().postDataJSON().sourceId, first.source.id);
    await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
    drawer = page.getByRole("dialog", { name: "Edit Slack", exact: true });
    await drawer.getByLabel("Slack bot token", { exact: true }).selectOption(second.source.id);
    await drawer.getByRole("button", { name: "Apply channel settings", exact: true }).click();
    directorySource = page.getByLabel("Slack bot Credential Source for people search", {
      exact: true,
    });
    await directorySource
      .locator(`option[value="${second.source.id}"]`)
      .waitFor({ state: "attached" });
    assert.equal(await directorySource.inputValue(), second.source.id);
    response = responseFor("beta");
    await people.fill("beta");
    const secondLookup = await response;
    assert.equal(secondLookup.status(), 200);
    assert.equal(secondLookup.request().postDataJSON().sourceId, second.source.id);
    assert.equal("secretId" in secondLookup.request().postDataJSON(), false);
  });
  await t.test("known bot Source remains usable when discovery read is unavailable", async () => {
    // Discovery lists only readable Sources. A known channel binding remains usable with exact
    // operate authority even when the caller can no longer discover that Source.
    const roleCount = fixture.policy.roles.length;
    const bindingCount = fixture.policy.bindings.length;
    grantExactSourceOperate(fixture, namespace.id, [second.source.id]);
    const restoreOperate = revokeAdministratorGrant(fixture, ["operate", "credential_source"]);
    const restoreRead = revokeAdministratorGrant(fixture, ["read", "credential_source"]);
    try {
      const sourcePath = `${fixture.origin}/namespaces/${namespace.id}/credential-sources`;
      const list = page.waitForResponse(
        (result) => result.url() === sourcePath && result.request().method() === "GET",
      );
      const sourceField = page.locator("#approver-directory-source").locator("..");
      await sourceField.getByRole("button", { name: "Refresh Source list", exact: true }).click();
      const discovered = await list;
      assert.equal(discovered.status(), 200);
      assert.deepEqual((await discovered.json()).data, []);
      await sourceField
        .getByText("No ready static Credential Sources are readable", { exact: false })
        .waitFor();
      assert.equal(await page.locator("#approver-directory-source").inputValue(), second.source.id);
      const response = responseFor("known");
      await page
        .getByRole("combobox", { name: "Default plugin approvers people", exact: true })
        .fill("known");
      const lookup = await response;
      assert.equal(lookup.status(), 200, await lookup.text());
      assert.equal(lookup.request().postDataJSON().sourceId, second.source.id);
    } finally {
      restoreRead();
      restoreOperate();
      fixture.policy.roles.splice(roleCount);
      fixture.policy.bindings.splice(bindingCount);
    }
  });
  await t.test(
    "Create stages and removes native signing bindings, then names exact denial",
    async () => {
      // The operator adds a native signing reference and its Source in the same unsaved create plan.
      await page.getByLabel("Agent name", { exact: true }).fill("Signing Source Agent");
      await enterManualModel(page, "synthetic-model-key", "gpt-5");
      const runtime = page.locator(".launch-runtime:not([open]) > summary");
      if (await runtime.count()) {
        await runtime.click();
      }
      assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
      assert.equal(
        await page.getByLabel("Execution mode", { exact: true }).inputValue(),
        "dedicated",
      );
      const editor = page.getByLabel("Configuration JSON", { exact: true });
      const values = JSON.parse(await editor.inputValue());
      values.channels.slack.signingSecret = "${SLACK_SIGNING_SECRET}";
      await editor.fill(JSON.stringify(values, null, 2));
      await page.locator("#slack-binding-slack-signing-secret").selectOption(signing.source.id);
      delete values.channels.slack.signingSecret;
      await editor.fill(JSON.stringify(values, null, 2));
      grantExactSourceOperate(fixture, namespace.id, [app.source.id]);
      const restore = revokeAdministratorGrant(fixture, ["operate", "credential_source"]);
      const validationPath = `/namespaces/${namespace.id}/agents/validate`;
      const configurationsPath = `/namespaces/${namespace.id}/configurations`;
      const before = await fixture.request("GET", configurationsPath);
      const waitFor = (path: string) =>
        page.waitForResponse(
          (result) =>
            result.url() === fixture.origin + path && result.request().method() === "POST",
        );
      const removedValidation = waitFor(validationPath);
      const missingBot = waitFor(configurationsPath);
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      const removed = await removedValidation;
      assert.equal(removed.status(), 204);
      assert.equal(
        "SLACK_SIGNING_SECRET" in removed.request().postDataJSON().configuration.secretBindings,
        false,
        "removing the native reference also removes its staged Source binding",
      );
      assert.equal((await missingBot).status(), 403);
      await page
        .getByText(new RegExp(`Credential ?Source.*operate.*${second.source.id}`, "i"))
        .waitFor();
      grantExactSourceOperate(fixture, namespace.id, [second.source.id]);
      values.channels.slack.signingSecret = "${SLACK_SIGNING_SECRET}";
      await editor.fill(JSON.stringify(values, null, 2));
      await page.locator("#slack-binding-slack-signing-secret").selectOption(signing.source.id);
      const validation = waitFor(validationPath);
      const refusedResponse = waitFor(configurationsPath);
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      assert.equal((await validation).status(), 204);
      const refused = await refusedResponse;
      assert.equal(refused.status(), 403);
      const plan = refused.request().postDataJSON();
      assert.equal(plan.values.channels.slack.signingSecret, "${SLACK_SIGNING_SECRET}");
      assert.deepEqual(plan.secretBindings.SLACK_SIGNING_SECRET.source, signing.source.ref);
      await page
        .getByText(new RegExp(`Credential ?Source.*operate.*${signing.source.id}`, "i"))
        .waitFor();
      assert.deepEqual(
        (await fixture.request("GET", configurationsPath)).data,
        before.data,
        "a refused Source binding creates no Configuration",
      );
      restore();
      const configurationCreated = page.waitForResponse(
        (result) =>
          result.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
          result.request().method() === "POST",
      );
      const agentCreated = page.waitForResponse(
        (result) =>
          result.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
          result.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      const createdConfiguration = await configurationCreated;
      assert.equal(createdConfiguration.status(), 201);
      assert.equal((await agentCreated).status(), 201);
      const sourceBinding = (await createdConfiguration.json()).data.secretBindings
        .SLACK_SIGNING_SECRET.source;
      assert.deepEqual(sourceBinding, signing.source.ref);
    },
  );
});
