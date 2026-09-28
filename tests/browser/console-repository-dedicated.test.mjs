import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { createConsoleRepositoryLaunchFixture } from "../helpers/console-repository-launch.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

for (const issuesEnabled of [true, false]) {
  test(`one Dedicated Agent retains repository scope through Slack setup, credentials and deployment admission (issues ${issuesEnabled ? "on" : "off"})`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess } =
      await createConsoleRepositoryLaunchFixture(t);
    const root = await mkdtemp(join(tmpdir(), "occ-repository-preset-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const configurationDriver = new FilesystemConfigurationDriver(root);
    fixture.controller.registerDriver(configurationDriver);
    fixture.controller.selectDriver("configuration", configurationDriver.id);
    const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
      body: {
        name: "Repository teammate",
        template: {
          agent: {
            name: "Repository teammate",
            executionMode: "dedicated",
            harnessAuth: { method: "api_key", source: modelSecret.ref },
          },
          configuration: { values: createHarnessConfiguration("codex", "gpt-5.1") },
        },
      },
    });
    assert.equal(preset.status, 201, JSON.stringify(preset));
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
        : {}),
    });
    let context;
    fixture.registerCleanupBeforeAppClose(async () => {
      try {
        await context?.close();
      } finally {
        await browser.close();
      }
    });
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Username").fill(fixture.credentials.email);
    await page.getByLabel("Password").fill(fixture.credentials.password);
    await page.getByRole("button", { name: "Login" }).click();
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByRole("button", { name: "Use Preset" }).click();
    await page.getByLabel("Agent name").fill("Repository teammate");
    await page.getByLabel("Harness", { exact: true }).selectOption("codex");
    await page.locator("#repository-application").check();
    await page.locator("#repository-documentation").check();
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
    await page
      .getByText("Contributor · push code and work with pull requests. Issue management is off.", {
        exact: true,
      })
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
      await page.locator("#repository-documentation").uncheck();
      await page.locator("#repository-documentation").check();
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
    await page.getByRole("heading", { name: "New revision" }).waitFor();
    await page
      .getByText(`application · ${label}, documentation · ${label}`, { exact: true })
      .waitFor();
    // The operator grant is deliberately separate from Console authentication
    // selection. Real managed IAM writes authorize the same Agent's model Secret.
    await grantModelAccess(agent);
    await page.getByRole("button", { name: "Channels", exact: true }).click();
    await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
    await page.getByLabel("Slack channel IDs").fill("CDEMO123");
    await page.getByLabel("Allowed channel user IDs").fill("UDEMO123");
    const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
    for (const [label, value] of [
      ["Slack app token", "xapp-synthetic-demo"],
      ["Slack bot token", "xoxb-synthetic-demo"],
    ]) {
      await channelDialog.getByLabel(label).selectOption({ label: "Create new Secret..." });
      const secretDialog = page.getByRole("dialog", { name: `Create ${label} Secret` });
      assert.equal(await secretDialog.getByLabel("Secret value").getAttribute("type"), "password");
      await secretDialog.getByLabel("Secret value").fill(value);
      await secretDialog.getByRole("button", { name: "Create Secret", exact: true }).click();
      await secretDialog.waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();
    await page.getByRole("button", { name: "Credentials", exact: true }).click();
    const deploy = page.getByRole("button", { name: "Deploy new revision", exact: true });
    assert.equal(await deploy.isDisabled(), true);
    const provisionResponse = page.waitForResponse(
      (result) =>
        result.url() ===
          `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials` &&
        result.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Provision generated runtime credentials" }).click();
    const provisioned = await provisionResponse;
    assert.equal(provisioned.status(), 200, JSON.stringify((await provisioned.json()).error));
    const credentialStatus = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`,
    );
    assert.equal(credentialStatus.status, 200);
    assert.deepEqual(credentialStatus.data, { transportConfigured: true });
    await page.getByText("Generated runtime credential metadata refreshed.").waitFor();
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
    await page.getByText("queued", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Configuration", exact: true }).click();
    await page
      .getByRole("heading", { name: `AgentRevision v${revision.revision}`, exact: true })
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
