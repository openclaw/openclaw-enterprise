import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleRepositoryLaunchFixture } from "../helpers/console-repository-launch.mjs";
import {
  login,
  newPage,
  repositoryCheckbox,
  setSlackSelection,
} from "./console-agents-browser-helpers.mjs";
import { openCreateSecretDialog } from "./console-agents-test-support.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

for (const issuesEnabled of [true, false]) {
  test(`one Dedicated Agent retains repository scope through Slack setup, credentials and deployment admission (issues ${issuesEnabled ? "on" : "off"})`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess } =
      await createConsoleRepositoryLaunchFixture(t, { filesystemConfiguration: true });
    const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
      body: {
        name: "Repository teammate",
        template: {
          agent: {
            name: "Repository teammate",
            executionMode: "dedicated",
            repositoryBindings: [{ repositoryRef: "application" }],
            harnessAuth: { method: "api_key", source: modelSecret.ref },
          },
          configuration: { values: createHarnessConfiguration("codex", "gpt-5.1") },
        },
      },
    });
    assert.equal(preset.status, 201, JSON.stringify(preset));
    const { page } = await newPage(t, fixture);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByRole("button", { name: "Use Preset" }).click();
    await page.getByLabel("Agent name").fill("Repository teammate");
    await page.getByLabel("Harness", { exact: true }).selectOption("codex");
    // An omitted profile in a legacy Preset retains the API's git-write default as Custom.
    await page.getByText("Contributor · no issue management · Custom", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Access for example/application" }).click();
    await page.locator("#repository-inherit-application").check();
    await page.getByRole("button", { name: "Access for example/application" }).click();
    await repositoryCheckbox(page, "example/documentation").click();
    await page.getByRole("radio", { name: /^Contributor / }).check();
    assert.equal(await page.locator(".repository-write-access").isVisible(), false);
    const customize = page.getByText("Customize access", { exact: true });
    await customize.focus();
    await customize.press("Enter");
    assert.equal(
      await page.getByRole("checkbox", { name: /^Create and manage issues/ }).isChecked(),
      true,
    );
    await page.getByRole("checkbox", { name: /^Create and manage issues/ }).uncheck();
    assert.equal(
      await page
        .getByRole("radio", {
          name: "Contributor Push code and work with pull requests.",
          exact: true,
        })
        .isChecked(),
      true,
    );
    await page
      .getByText(
        "Contributor · no issue management applies to repositories using the Agent default.",
        {
          exact: true,
        },
      )
      .waitFor();
    await page.getByRole("checkbox", { name: /^Create and manage issues/ }).check();
    await customize.press("Enter");
    assert.equal(
      await page.getByRole("checkbox", { name: /^Create and manage issues/ }).isVisible(),
      false,
    );
    assert.equal(await page.getByLabel("Configuration JSON").isVisible(), false);
    if (!issuesEnabled) {
      await customize.press("Enter");
      await page.getByRole("checkbox", { name: /^Create and manage issues/ }).uncheck();
      // Changing the repository set must not silently restore issue management.
      await page.getByRole("button", { name: "Remove example/documentation" }).click();
      await repositoryCheckbox(page, "example/documentation").click();
      assert.equal(
        await page.getByRole("checkbox", { name: /^Create and manage issues/ }).isChecked(),
        false,
      );
    }
    const profile = issuesEnabled ? "git-full" : "git-write";
    const label = issuesEnabled ? "Contributor" : "Contributor · no issue management";
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    const response = await createdResponse;
    assert.equal(response.status(), 201);
    const { data: agent } = await response.json();
    const expectedBindings = [
      { repositoryRef: "application", profile },
      { repositoryRef: "documentation", profile },
    ];
    assert.equal(agent.executionMode, "dedicated");
    assert.deepEqual(agent.harnessAuth, { method: "api_key", source: modelSecret.ref });
    assert.deepEqual(agent.repositoryBindings, expectedBindings);
    await page.getByRole("heading", { name: "Create new version" }).waitFor();
    await page
      .getByText(`application · ${label}, documentation · ${label}`, { exact: true })
      .waitFor();
    // The operator grant is deliberately separate from Console authentication
    // selection. Real managed IAM writes authorize the same Agent's model Secret.
    await grantModelAccess(agent);
    await page.getByRole("button", { name: "Channels", exact: true }).click();
    await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
    await setSlackSelection(
      page.getByRole("combobox", { name: "Channels", exact: true }),
      "CDEMO123",
    );
    await setSlackSelection(
      page.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
      "UDEMO123",
    );
    const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
    // This workflow enables channel mentions without granting direct-message access.
    await channelDialog.getByLabel("Direct-message policy").selectOption("disabled");
    for (const [label, value] of [
      ["Slack app token", "xapp-synthetic-demo"],
      ["Slack bot token", "xoxb-synthetic-demo"],
    ]) {
      await openCreateSecretDialog(channelDialog, label);
      const secretDialog = page.getByRole("dialog", { name: `Create ${label} Secret` });
      assert.equal(
        await secretDialog.getByLabel("Value", { exact: true }).getAttribute("type"),
        "password",
      );
      await secretDialog.getByLabel("Value", { exact: true }).fill(value);
      await secretDialog.getByRole("button", { name: "Create Secret", exact: true }).click();
      await secretDialog.waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new version", exact: true });
    const text = await page.locator("body").innerText();
    assert.equal(text.includes("xapp-synthetic-demo"), false);
    assert.equal(text.includes("xoxb-synthetic-demo"), false);
    assert.equal(await deploy.isEnabled(), true);
    const admittedResponse = page.waitForResponse(
      (result) =>
        result.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deploy` &&
        result.request().method() === "POST",
    );
    await deploy.click();
    const admitted = await admittedResponse;
    assert.equal(admitted.status(), 202);
    const credentialStatus = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`,
    );
    assert.equal(credentialStatus.status, 200);
    assert.deepEqual(credentialStatus.data, { transportConfigured: true });
    const { data: revision } = await admitted.json();
    assert.equal(revision.agentId, agent.id);
    assert.equal(revision.harness.id, "codex");
    assert.equal(revision.harness.mode, "dedicated");
    assert.deepEqual(revision.repositoryCredentials.bindings, expectedBindings);
    assert.equal(revision.configuration.channels.slack.enabled, true);
    assert.deepEqual(revision.configuration.channels.slack.channels.CDEMO123, {
      requireMention: true,
      users: ["UDEMO123"],
    });
    assert.equal(Object.hasOwn(revision.configuration.channels.slack, "allowFrom"), false);
    const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    assert.deepEqual(saved.data.repositoryBindings, expectedBindings);
    assert.equal(configuration.data.values.channels.slack.enabled, true);
    assert.deepEqual(configuration.data.values.channels.slack.channels.CDEMO123, {
      requireMention: true,
      users: ["UDEMO123"],
    });
    assert.equal(Object.hasOwn(configuration.data.values.channels.slack, "allowFrom"), false);
    assert.deepEqual(Object.keys(configuration.data.secretBindings).sort(), [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
    ]);
    assert.deepEqual(revision.secretBindings, configuration.data.secretBindings);
    const storedRevision = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${revision.id}`,
    );
    assert.equal(storedRevision.status, 200);
    assert.deepEqual(storedRevision.data, revision);
    const deployment = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    );
    assert.equal(deployment.status, 200);
    assert.equal(deployment.data.deploymentId, revision.id);
    assert.equal(deployment.data.status, "queued");
    await page
      .locator(".deployment-outcome")
      .filter({ hasText: "Recorded status: queued" })
      .waitFor();
    await page.getByRole("button", { name: "Configuration", exact: true }).click();
    await page
      .getByRole("heading", { name: `Version v${revision.revision}`, exact: true })
      .waitFor();
    await page
      .getByText(`application · ${label}, documentation · ${label}`, { exact: true })
      .waitFor();
    assert.equal(await page.locator(".repository-write-access").isVisible(), true);
    assert.deepEqual(
      (await fixture.request("GET", `/namespaces/${namespace.id}/agents`)).data.map(({ id }) => id),
      [agent.id],
    );
    // No worker, Pod, model or provider runs in this fixture. Acceptance ends at
    // the actual immutable revision admitted by OCC; no Ready result is fabricated.
    assert.equal(saved.data.activeRevisionId, undefined);
  });
}
