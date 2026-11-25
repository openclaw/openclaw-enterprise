import { repositoryAccessSelections } from "../../packages/contracts/src/index.ts";
import {
  openCreateSecretDialog,
  createAgentThroughForm,
} from "./console-agents-ui-test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentDeploymentStatusWire,
  AgentReadWire,
  AgentRevisionResponse,
  ConfigurationWire,
  PresetWire,
} from "../../packages/contracts/src/api/resources.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { createConsoleRepositoryLaunchFixture } from "../helpers/console-repository-launch.ts";
import {
  login,
  newPage,
  repositoryCheckbox,
  setSlackSelection,
  waitForEnabled,
  isMaskedSecretValue,
} from "./console-agents-browser-helpers.ts";
import { expectDeploymentOutcome } from "./console-deployment-activity-helpers.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

function assertChannelOnlySlackAccess(configuration: unknown) {
  const channels = asRecord(asRecord(configuration)?.channels);
  const slack = asRecord(channels?.slack);
  assert.ok(slack, "the saved configuration contains Slack settings");
  assert.equal(slack.enabled, true);
  assert.deepEqual(asRecord(slack.channels)?.CDEMO123, {
    requireMention: true,
    users: ["UDEMO123"],
  });
  assert.equal(Object.hasOwn(slack, "allowFrom"), false);
}

test("a Dedicated Agent keeps repository access and Channel Secrets in its admitted revision", async (t) => {
  const { fixture, namespace, modelSecret, grantModelAccess } =
    await createConsoleRepositoryLaunchFixture(t, { filesystemConfiguration: true });
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Repository teammate",
      template: {
        agent: {
          name: "Repository teammate",
          executionMode: "dedicated",
          repositoryAccess: {
            defaultProfile: "git-write",
            repositories: [{ repositoryRef: "application" }],
          },
          harnessAuth: { method: "api_key", source: modelSecret.ref },
        },
        configuration: { values: createHarnessConfiguration("codex", "gpt-5.1") },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset));
  const { id: presetId }: PresetWire = preset.data;
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(presetId);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByLabel("Agent name").fill("Repository teammate");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await repositoryCheckbox(page, "example/documentation").check();
  const profile = "git-write";
  const label = "Contributor · no issue management";
  const agent = await createAgentThroughForm(page, fixture, namespace.id);
  const expectedBindings = [
    { repositoryRef: "application", profile },
    { repositoryRef: "documentation", profile },
  ];
  assert.equal(agent.executionMode, "dedicated");
  assert.deepEqual(agent.harnessAuth, { method: "api_key", source: modelSecret.ref });
  assert.deepEqual(repositoryAccessSelections(agent.repositoryAccess), expectedBindings);
  await page.getByRole("heading", { name: "Prepare this version" }).waitFor();
  await page
    .getByText(`application · ${label}, documentation · ${label}`, { exact: true })
    .waitFor();
  // The operator grant is deliberately separate from Console authentication
  // selection. Real managed IAM writes authorize the same Agent's model Secret.
  await grantModelAccess(agent);
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
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
  ] as const) {
    await openCreateSecretDialog(channelDialog, label);
    const secretDialog = page.getByRole("dialog", { name: `Create ${label} Secret` });
    assert.equal(
      await isMaskedSecretValue(secretDialog.getByLabel("Value", { exact: true })),
      true,
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
  await waitForEnabled(deploy);
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
  const { data: revision }: AgentRevisionResponse = await admitted.json();
  assert.equal(revision.agentId, agent.id);
  assert.equal(revision.harness.id, "codex");
  assert.equal(revision.harness.mode, "dedicated");
  assert.deepEqual(revision.repositoryCredentials?.bindings, expectedBindings);
  assertChannelOnlySlackAccess(revision.configuration);
  const saved: AgentReadWire = (
    await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)
  ).data;
  const configuration: ConfigurationWire = (
    await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    )
  ).data;
  assert.ok("repositoryAccess" in saved);
  assert.deepEqual(repositoryAccessSelections(saved.repositoryAccess), expectedBindings);
  assertChannelOnlySlackAccess(configuration.values);
  assert.ok(configuration.secretBindings);
  assert.deepEqual(Object.keys(configuration.secretBindings).sort(), [
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
  ]);
  assert.deepEqual(revision.secretBindings, configuration.secretBindings);
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
  const { deploymentId, status }: AgentDeploymentStatusWire = deployment.data;
  assert.equal(deploymentId, revision.id);
  assert.equal(status, "queued");
  await expectDeploymentOutcome(page, "Queued");
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  const version = page.getByRole("combobox", { name: "Viewing version", exact: true });
  await version.waitFor();
  assert.equal(await version.inputValue(), revision.id);
  await page
    .getByText(`application · ${label}, documentation · ${label}`, { exact: true })
    .waitFor();
  assert.equal(await page.locator(".repository-write-access").isVisible(), true);
  const agents = await fixture.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.equal(agents.status, 200);
  const savedAgents: AgentReadWire[] = agents.data;
  assert.deepEqual(
    savedAgents.map(({ id }) => id),
    [agent.id],
  );
  // No worker, Pod, model or provider runs in this fixture. Acceptance ends at
  // the actual immutable revision admitted by OCC; no Ready result is fabricated.
  assert.equal(saved.activeRevisionId, undefined);
});
