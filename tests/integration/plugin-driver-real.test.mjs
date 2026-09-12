import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertNoSecretMaterial,
  createPluginDriverRealFixture,
  pluginProofSkipReason,
  readCodexServiceAccountCredential,
} from "../helpers/plugin-driver-real.mjs";

test(
  "a real official OpenClaw plugin installs, runs in a normal Agent turn, and stays scoped to one Agent",
  {
    skip: pluginProofSkipReason("openclaw"),
    timeout: 900_000,
  },
  async (context) => {
    const pluginId = process.env.OCC_TEST_OPENCLAW_PLUGIN_ID ?? "occ-plugin:diffs";
    const turnMarker = `OPENCLAW_PLUGIN_REAL_${randomUUID()}`;
    const prompt =
      process.env.OCC_TEST_OPENCLAW_PLUGIN_PROMPT ??
      [
        "Call the Diffs plugin tool exactly once with this harmless input:",
        'before: "alpha\\nold line\\nomega\\n"',
        'after: "alpha\\nnew line\\nomega\\n"',
        'path: "plugin-driver-proof.txt"',
        'mode: "view"',
        `After the tool returns, include ${turnMarker} in the final answer.`,
      ].join("\n");
    const expectedPatterns = (
      process.env.OCC_TEST_OPENCLAW_PLUGIN_EXPECT ?? "OPENCLAW_PLUGIN_REAL_"
    )
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const toolName = process.env.OCC_TEST_OPENCLAW_PLUGIN_TOOL_NAME ?? "diffs";
    const resultPattern =
      process.env.OCC_TEST_OPENCLAW_PLUGIN_RESULT_EXPECT ?? "Diff viewer ready.";

    const fixture = await createPluginDriverRealFixture(context, {
      pluginDriverId: "occ-plugin",
      databaseUrl: process.env.OCC_TEST_PLUGIN_DRIVER_OPENCLAW_DATABASE_URL,
    });
    const primary = await fixture.createAgent({
      harnessId: "openclaw",
      executionMode: "embedded",
      name: `openclaw-plugin-primary-${randomUUID()}`,
    });
    const sibling = await fixture.createAgent({
      harnessId: "openclaw",
      executionMode: "embedded",
      name: `openclaw-plugin-sibling-${randomUUID()}`,
    });
    const modelSecret = await fixture.materializeOpenAIModelSecret(primary.id);
    await fixture.materializeOpenAIModelSecret(sibling.id);

    const siblingBefore = await fixture.getAgent(sibling.id);
    assert.ok(
      Object.keys(siblingBefore.plugins ?? {}).length === 0,
      "a sibling Agent sharing the same runtime configuration starts with no desired plugins.",
    );

    const desired = await fixture.selectPlugin(primary.id, {
      pluginId,
      enabled: true,
      approvalMode: "always",
    });
    assert.equal(desired.approvalMode, "always");
    const selectedAgent = await fixture.getAgent(primary.id);
    assert.equal(selectedAgent.plugins[pluginId].enabled, true);

    const deployedPrimary = await fixture.deployAndWait(primary);
    assert.equal(deployedPrimary.revision.plugins?.driver.id, "occ-plugin");
    assert.ok(Object.hasOwn(deployedPrimary.revision.plugins?.plugins ?? {}, pluginId));
    assert.equal(Object.hasOwn(deployedPrimary.revision.plugins, "artifacts"), false);
    const deployedSibling = await fixture.deployAndWait(sibling);
    assert.equal(Object.keys(deployedSibling.revision.plugins?.plugins ?? {}).length, 0);

    const proofSessionKey = `agent:main:plugin-proof-${randomUUID()}`;
    const content = await fixture.normalGatewayTurn({
      agent: primary,
      gatewayToken: deployedPrimary.gatewayToken,
      sessionKey: proofSessionKey,
      prompt,
      expectedPatterns,
      secrets: [modelSecret],
    });
    assertNoSecretMaterial(
      content,
      [modelSecret],
      "OpenClaw plugin proof response must not expose model credentials.",
    );
    await fixture.assertSessionToolCallEvidence(primary, {
      sessionKey: proofSessionKey,
      turnMarker,
      toolName,
      resultPattern,
    });

    const disabled = await fixture.updatePluginPolicy(primary.id, pluginId, { enabled: false });
    assert.equal(disabled.enabled, false);
    const disabledRevision = await fixture.deployAndWait(primary);
    assert.equal(disabledRevision.revision.plugins?.plugins[pluginId]?.enabled, false);
    const disabledMarker = `OPENCLAW_PLUGIN_DISABLED_${randomUUID()}`;
    const disabledSessionKey = `agent:main:plugin-disabled-${randomUUID()}`;
    await fixture.normalGatewayTurn({
      agent: primary,
      gatewayToken: disabledRevision.gatewayToken,
      sessionKey: disabledSessionKey,
      prompt: `Try to use the previously installed plugin. If no plugin tool is available, answer ${disabledMarker}.`,
      expectedPatterns: [disabledMarker],
      secrets: [modelSecret],
    });
    await fixture.assertNoSessionToolCallEvidence(primary, {
      sessionKey: disabledSessionKey,
      turnMarker: disabledMarker,
      toolName,
    });

    await fixture.removePluginSelection(primary.id, pluginId);
    const removedRevision = await fixture.deployAndWait(primary);
    assert.equal(
      Object.hasOwn(removedRevision.revision.plugins?.plugins ?? {}, pluginId),
      false,
      "removal applies on the next deployment snapshot.",
    );
    const removedMarker = `OPENCLAW_PLUGIN_REMOVED_${randomUUID()}`;
    const removedSessionKey = `agent:main:plugin-removed-${randomUUID()}`;
    await fixture.normalGatewayTurn({
      agent: primary,
      gatewayToken: removedRevision.gatewayToken,
      sessionKey: removedSessionKey,
      prompt: `Try to use the previously installed plugin. If no plugin tool is available, answer ${removedMarker}.`,
      expectedPatterns: [removedMarker],
      secrets: [modelSecret],
    });
    await fixture.assertNoSessionToolCallEvidence(primary, {
      sessionKey: removedSessionKey,
      turnMarker: removedMarker,
      toolName,
    });
    const siblingAfter = await fixture.getAgent(sibling.id);
    assert.ok(
      Object.keys(siblingAfter.plugins ?? {}).length === 0,
      "disable/remove on one Agent must not mutate a sibling Agent.",
    );
    const siblingMarker = `OPENCLAW_PLUGIN_SIBLING_${randomUUID()}`;
    const siblingSessionKey = `agent:main:plugin-sibling-${randomUUID()}`;
    await fixture.normalGatewayTurn({
      agent: sibling,
      gatewayToken: deployedSibling.gatewayToken,
      sessionKey: siblingSessionKey,
      prompt: `Try to use the plugin installed on the other Agent. If no plugin tool is available, answer ${siblingMarker}.`,
      expectedPatterns: [siblingMarker],
      secrets: [modelSecret],
    });
    await fixture.assertNoSessionToolCallEvidence(sibling, {
      sessionKey: siblingSessionKey,
      turnMarker: siblingMarker,
      toolName,
    });
  },
);

test(
  "curated Codex Google Calendar installs with the service-account credential and performs a harmless normal-turn read",
  {
    skip: pluginProofSkipReason("codex_calendar"),
    timeout: 900_000,
  },
  async (context) => {
    const pluginId =
      process.env.OCC_TEST_CODEX_CALENDAR_PLUGIN_ID ??
      "codex-plugin:google-calendar@openai-curated-remote";
    const turnMarker = `CODEX_CALENDAR_PLUGIN_REAL_READ_${randomUUID()}`;
    const prompt =
      process.env.OCC_TEST_CODEX_CALENDAR_PROMPT ??
      `Use the Google Calendar list_calendars tool with max_results 1 to read the calendars visible to this test account, then answer with the exact marker ${turnMarker}.`;
    const configuredExpectedPatterns = (process.env.OCC_TEST_CODEX_CALENDAR_EXPECT ?? "")
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const expectedPatterns = configuredExpectedPatterns.includes(turnMarker)
      ? configuredExpectedPatterns
      : [...configuredExpectedPatterns, turnMarker];
    const toolName =
      process.env.OCC_TEST_CODEX_CALENDAR_TOOL_NAME ??
      assert.fail(
        "OCC_TEST_CODEX_CALENDAR_TOOL_NAME must be the exact harmless Google Calendar tool name used by the live fixture.",
      );
    const resultPattern =
      process.env.OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT ??
      assert.fail(
        "OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT is required for live Google Calendar result evidence.",
      );

    const credential = await readCodexServiceAccountCredential();
    const fixture = await createPluginDriverRealFixture(context, {
      pluginDriverId: "codex-plugin",
      databaseUrl: process.env.OCC_TEST_PLUGIN_DRIVER_CODEX_CALENDAR_DATABASE_URL,
      codexCredential: credential,
    });
    const account = await fixture.createCodexServiceAccountFromToken({
      accessToken: credential.accessToken,
      name: `codex-calendar-plugin-${randomUUID()}`,
    });
    assertNoSecretMaterial(
      account,
      [credential.accessToken, credential.workspaceId],
      "ServiceAccount metadata must not expose Codex credential material.",
    );

    const agent = await fixture.createAgent({
      harnessId: "codex",
      executionMode: "dedicated",
      name: `codex-calendar-plugin-${randomUUID()}`,
      serviceAccountId: account.id,
      providerId: "openai",
    });
    const desired = await fixture.selectPlugin(agent.id, {
      pluginId,
      enabled: true,
      approvalMode: "auto",
      approvalsReviewer: "auto_review",
    });
    assert.equal(desired.approvalMode, "auto");
    assert.equal(desired.approvalsReviewer, "auto_review");

    const deployed = await fixture.deployAndWait(agent);
    assert.equal(deployed.revision.plugins?.driver.id, "codex-plugin");
    assert.ok(Object.hasOwn(deployed.revision.plugins?.plugins ?? {}, pluginId));
    assert.equal(Object.hasOwn(deployed.revision.plugins, "artifacts"), false);
    assert.deepEqual(deployed.revision.serviceAccount, {
      id: account.id,
      credential: account.credential,
    });

    const calendarSessionKey = `agent:main:codex-calendar-${randomUUID()}`;
    const content = await fixture.normalGatewayTurn({
      agent,
      gatewayToken: deployed.gatewayToken,
      sessionKey: calendarSessionKey,
      prompt: `${prompt}\nInclude this marker in the final answer: ${turnMarker}`,
      expectedPatterns,
      secrets: [credential.accessToken, credential.workspaceId],
    });
    assertNoSecretMaterial(
      content,
      [credential.accessToken, credential.workspaceId],
      "Codex Google Calendar plugin proof response must not expose service-account credentials.",
    );
    await fixture.assertSessionToolCallEvidence(agent, {
      sessionKey: calendarSessionKey,
      turnMarker,
      toolName,
      resultPattern,
    });
  },
);
