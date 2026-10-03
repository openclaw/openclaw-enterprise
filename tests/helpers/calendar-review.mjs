import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertNoSecretMaterial } from "./plugin-driver-real.mjs";

// Shared by both installed QA fixtures. All decisions are
// correlated with native calls/results, never inferred from assistant prose.
export async function verifyCalendarReviewPolicy(fixture, agent, credential) {
  const pluginId =
    process.env.OCC_TEST_CODEX_CALENDAR_PLUGIN_ID?.trim() ||
    "codex-plugin:google-calendar@openai-curated-remote";
  const turnMarker = `CODEX_CALENDAR_PLUGIN_REAL_READ_${randomUUID()}`;
  const prompt =
    process.env.OCC_TEST_CODEX_CALENDAR_PROMPT?.trim() ||
    `Use the Google Calendar list_calendars tool with max_results 1 to read the calendars visible to this test account, then answer with the exact marker ${turnMarker}.`;
  const configuredExpectedPatterns = (process.env.OCC_TEST_CODEX_CALENDAR_EXPECT ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const expectedPatterns = configuredExpectedPatterns.includes(turnMarker)
    ? configuredExpectedPatterns
    : [...configuredExpectedPatterns, turnMarker];
  const toolName =
    process.env.OCC_TEST_CODEX_CALENDAR_TOOL_NAME?.trim() ||
    assert.fail(
      "OCC_TEST_CODEX_CALENDAR_TOOL_NAME must be the exact harmless Google Calendar tool name used by the live fixture.",
    );
  const resultPattern =
    process.env.OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT?.trim() ||
    assert.fail(
      "OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT is required for live Google Calendar result evidence.",
    );

  const desired = await fixture.selectPlugin(agent.id, {
    pluginId,
    enabled: true,
    toolDefaults: { approval: "provider_default", reviewer: "auto" },
  });
  assert.equal(desired.toolDefaults.approval, "provider_default");
  assert.equal(desired.toolDefaults.reviewer, "auto");

  const deployed = await fixture.deployAndWait(agent);
  assert.equal(deployed.revision.plugins?.driver.id, "codex-plugin");
  assert.ok(Object.hasOwn(deployed.revision.plugins?.plugins ?? {}, pluginId));
  assert.equal(Object.hasOwn(deployed.revision.plugins, "artifacts"), false);
  assert.deepEqual(deployed.revision.harnessAuth, agent.harnessAuth);

  const calendarSessionKey = `agent:main:codex-calendar-${randomUUID()}`;
  const content = await fixture.normalGatewayTurn({
    agent,
    gatewayPassword: deployed.gatewayPassword,
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

  // Reuse one native session: allowing the first read must not authorize the next.
  await fixture.updatePluginPolicy(agent.id, pluginId, {
    toolDefaults: { approval: "all_actions", reviewer: "human" },
  });
  const humanRevision = await fixture.deployAndWait(agent);
  const humanSessionKey = `agent:main:codex-calendar-human-${randomUUID()}`;
  for (const decision of ["allow-once", "deny"]) {
    const marker = `CODEX_CALENDAR_HUMAN_${randomUUID()}`;
    const evidence = { sessionKey: humanSessionKey, turnMarker: marker, toolName, resultPattern };
    await fixture.normalGatewayTurn({
      agent,
      gatewayPassword: humanRevision.gatewayPassword,
      sessionKey: humanSessionKey,
      prompt: [
        prompt,
        "Make a fresh call to that tool exactly once, even if earlier results are available.",
        "If the operator denies it, do not retry or call another tool; report the denial.",
        `Include this marker in the final answer after success or denial: ${marker}`,
      ].join("\n"),
      expectedPatterns: [marker],
      secrets: [credential.accessToken, credential.workspaceId],
      humanReview: { decision, turnMarker: marker, toolName },
    });
    if (decision === "deny") {
      await fixture.assertSessionToolDeniedEvidence(agent, evidence);
    } else {
      await fixture.assertSessionToolCallEvidence(agent, evidence);
    }
  }

  // A harmless read normally skips automatic review under auto. Prompt must
  // instead persist a fresh approval on each successful call, including repeats.
  await fixture.updatePluginPolicy(agent.id, pluginId, {
    toolDefaults: { approval: "all_actions", reviewer: "auto" },
  });
  const automaticRevision = await fixture.deployAndWait(agent);
  const automaticSessionKey = `agent:main:codex-calendar-automatic-${randomUUID()}`;
  const reviewIds = new Set();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const marker = `CODEX_CALENDAR_AUTOMATIC_${randomUUID()}`;
    await fixture.normalGatewayTurn({
      agent,
      gatewayPassword: automaticRevision.gatewayPassword,
      sessionKey: automaticSessionKey,
      prompt: [
        prompt,
        "Make a fresh call to that tool exactly once, even if earlier results are available.",
        `Include this marker in the final answer: ${marker}`,
      ].join("\n"),
      expectedPatterns: [marker],
      secrets: [credential.accessToken, credential.workspaceId],
    });
    const evidence = await fixture.assertSessionToolCallEvidence(agent, {
      sessionKey: automaticSessionKey,
      turnMarker: marker,
      toolName,
      resultPattern,
      requireAutomaticReview: true,
    });
    for (const id of evidence.approvedReviewIds) {
      assert.equal(typeof id, "string");
      assert.ok(id.length > 0);
      assert.equal(reviewIds.has(id), false, "a repeated read must receive a new automatic review");
      reviewIds.add(id);
    }
  }

  // Bind the known harmless read to the native raw name and owning app. These
  // catalog entries are discovery metadata, not policy-filtered tool exposure.
  const [entry] = await fixture.listCodexNativeCatalog(agent, [pluginId]);
  assert.ok(entry?.detailAvailable && entry.appCount > 0);
  const inventory = await fixture.codexPluginToolInventory(agent, entry);
  const matchingTools = inventory.filter((tool) => tool.transcriptName === toolName);
  assert.equal(matchingTools.length, 1, "the live read must identify one owned native tool.");
  const selectedTool = matchingTools[0];
  assert.equal(selectedTool.annotations.readOnlyHint, true, "the selected tool must be a read.");
  assert.notEqual(selectedTool.annotations.destructiveHint, true);
  assert.ok(inventory.length > 1, "the default-disabled proof requires sibling app tools.");
  const toolId = `${encodeURIComponent(selectedTool.appId)}/${encodeURIComponent(selectedTool.name)}`;

  // Only the explicit read exception is enabled; its approval overrides prompt.
  // Verify all observed siblings' configuration without calling write tools.
  const exceptionPolicy = await fixture.updatePluginPolicy(agent.id, pluginId, {
    toolDefaults: { enabled: false, approval: "all_actions", reviewer: "human" },
    tools: { [toolId]: { enabled: true, approval: "none" } },
  });
  const exceptionDeployment = await fixture.deployAndWait(agent);
  assert.deepEqual(exceptionDeployment.revision.plugins.plugins[pluginId], exceptionPolicy);
  assert.deepEqual(exceptionDeployment.status.warnings, []);
  const exceptionConfig = await fixture.codexAppConfiguration(agent);
  for (const appId of entry.appIds) {
    const app = exceptionConfig.apps[appId];
    assert.equal(app?.enabled, true, "the plugin must stay active with disabled tool defaults.");
    assert.equal(app.default_tools_enabled, false);
    assert.equal(app.default_tools_approval_mode, "prompt");
    assert.equal(app.approvals_reviewer, "user");
  }
  for (const tool of inventory) {
    const selected = tool.appId === selectedTool.appId && tool.name === selectedTool.name;
    const policy = exceptionConfig.apps[tool.appId].tools?.[tool.name];
    if (selected) {
      assert.equal(policy?.enabled, true);
      assert.equal(policy.approval_mode, "approve");
    } else {
      assert.ok(policy?.enabled == null, "siblings must inherit the disabled native default.");
      assert.ok(policy?.approval_mode == null, "siblings must inherit prompt review.");
    }
  }
  const exceptionMarker = `CODEX_CALENDAR_TOOL_EXCEPTION_${randomUUID()}`;
  const exceptionSessionKey = `agent:main:codex-calendar-exception-${randomUUID()}`;
  await fixture.normalGatewayTurn({
    agent,
    gatewayPassword: exceptionDeployment.gatewayPassword,
    sessionKey: exceptionSessionKey,
    prompt: `${prompt}\nInclude this marker in the final answer: ${exceptionMarker}`,
    expectedPatterns: [exceptionMarker],
    secrets: [credential.accessToken, credential.workspaceId],
  });
  await fixture.assertSessionToolCallEvidence(agent, {
    sessionKey: exceptionSessionKey,
    turnMarker: exceptionMarker,
    toolName,
    resultPattern,
  });

  // Enable siblings by default so only the explicit denial blocks this read.
  // Approval must not enable it, even with approve selected.
  const disabledToolPolicy = await fixture.updatePluginPolicy(agent.id, pluginId, {
    toolDefaults: { enabled: true, approval: "all_actions", reviewer: "human" },
    tools: { [toolId]: { enabled: false, approval: "none" } },
  });
  const disabledToolDeployment = await fixture.deployAndWait(agent);
  assert.deepEqual(disabledToolDeployment.revision.plugins.plugins[pluginId], disabledToolPolicy);
  assert.deepEqual(disabledToolDeployment.status.warnings, []);
  const disabledToolConfig = await fixture.codexAppConfiguration(agent);
  const disabledApp = disabledToolConfig.apps[selectedTool.appId];
  assert.equal(disabledApp?.enabled, true);
  assert.equal(disabledApp.default_tools_enabled, true);
  assert.equal(disabledApp.tools?.[selectedTool.name]?.enabled, false);
  assert.equal(disabledApp.tools[selectedTool.name].approval_mode, "approve");
  const disabledToolMarker = `CODEX_CALENDAR_TOOL_DISABLED_${randomUUID()}`;
  const disabledToolSessionKey = `agent:main:codex-calendar-tool-disabled-${randomUUID()}`;
  await fixture.normalGatewayTurn({
    agent,
    gatewayPassword: disabledToolDeployment.gatewayPassword,
    sessionKey: disabledToolSessionKey,
    prompt: `${prompt}\nIf the requested tool is unavailable, do not substitute another tool. Include ${disabledToolMarker} in the final answer.`,
    expectedPatterns: [disabledToolMarker],
    secrets: [credential.accessToken, credential.workspaceId],
  });
  await fixture.assertNoSessionToolCallEvidence(agent, {
    sessionKey: disabledToolSessionKey,
    turnMarker: disabledToolMarker,
    toolName,
  });
}
