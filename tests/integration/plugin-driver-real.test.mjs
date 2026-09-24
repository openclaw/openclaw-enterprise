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
    const modelSecret = await fixture.bindOpenAIModelSecret(primary.id);
    await fixture.bindOpenAIModelSecret(sibling.id);

    // Compose the selection with real reusable Configuration policy before the
    // ordinary deploy path snapshots it and the native installer runs.
    const nativePluginId = pluginId.replace(/^occ-plugin:/, "");
    const allowedPlugins = ["openai", nativePluginId];
    const configurationPath = `/namespaces/${fixture.namespaceId}/configurations/${primary.configurationId}`;
    const configuration = await fixture.request("GET", configurationPath);
    assert.equal(configuration.status, 200, JSON.stringify(configuration.error));
    const restrictedConfiguration = {
      ...configuration.data.values,
      plugins: { ...configuration.data.values.plugins, allow: allowedPlugins },
      tools: { ...configuration.data.values.tools, allow: ["read"], deny: ["exec"] },
    };
    const configured = await fixture.request("PATCH", configurationPath, {
      values: restrictedConfiguration,
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.error));

    const siblingBefore = await fixture.getAgent(sibling.id);
    assert.ok(
      Object.keys(siblingBefore.plugins ?? {}).length === 0,
      "a sibling Agent sharing the same runtime configuration starts with no desired plugins.",
    );

    const desired = await fixture.selectPlugin(primary.id, {
      pluginId,
      enabled: true,
      toolDefaults: { approval: "approve" },
    });
    assert.equal(desired.toolDefaults.approval, "approve");
    const selectedAgent = await fixture.getAgent(primary.id);
    assert.equal(selectedAgent.plugins[pluginId].enabled, true);

    const deployedPrimary = await fixture.deployAndWait(primary);
    assert.equal(deployedPrimary.revision.plugins?.driver.id, "occ-plugin");
    assert.ok(Object.hasOwn(deployedPrimary.revision.plugins?.plugins ?? {}, pluginId));
    assert.equal(Object.hasOwn(deployedPrimary.revision.plugins, "artifacts"), false);
    assert.deepEqual(await fixture.readOpenClawPluginPolicy(primary, nativePluginId), {
      plugins: { allow: allowedPlugins, enabled: true },
      tools: { allow: ["read", nativePluginId], deny: ["exec"] },
    });
    assert.deepEqual(
      deployedPrimary.status.warnings,
      [],
      "the expected-success OpenClaw plugin proof requires a clean plugin install.",
    );
    const deployedSibling = await fixture.deployAndWait(sibling);
    assert.equal(Object.keys(deployedSibling.revision.plugins?.plugins ?? {}).length, 0);

    const proofSessionKey = `agent:main:plugin-proof-${randomUUID()}`;
    const content = await fixture.normalGatewayTurn({
      agent: primary,
      gatewayPassword: deployedPrimary.gatewayPassword,
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

    // A tool override wins in both directions. Redeployment must remove the
    // generated denial while preserving the reusable Configuration's exec denial.
    for (const enabled of [false, true]) {
      const policy = await fixture.updatePluginPolicy(primary.id, pluginId, {
        toolDefaults: { enabled: !enabled, approval: "approve" },
        tools: { [toolName]: { enabled } },
      });
      const redeployed = await fixture.deployAndWait(primary);
      assert.deepEqual(redeployed.revision.plugins.plugins[pluginId], policy);
      assert.deepEqual(redeployed.status.warnings, []);
      assert.deepEqual(await fixture.readOpenClawPluginPolicy(primary, nativePluginId), {
        plugins: { allow: allowedPlugins, enabled: true },
        tools: { allow: ["read", nativePluginId], deny: enabled ? ["exec"] : ["exec", toolName] },
      });
      const sessionKey = `agent:main:tool-override-${randomUUID()}`;
      const marker = `OPENCLAW_TOOL_OVERRIDE_${randomUUID()}`;
      await fixture.normalGatewayTurn({
        agent: primary,
        gatewayPassword: redeployed.gatewayPassword,
        sessionKey,
        prompt: `${prompt}\nIf the tool is unavailable, do not substitute another tool. Include ${marker} in the final answer.`,
        expectedPatterns: [marker],
        secrets: [modelSecret],
      });
      const evidence = { sessionKey, turnMarker: marker, toolName, resultPattern };
      if (enabled) {
        await fixture.assertSessionToolCallEvidence(primary, evidence);
      } else {
        await fixture.assertNoSessionToolCallEvidence(primary, evidence);
      }
    }

    // The same enabled exception cannot remove an operator's native tool deny.
    const toolDenied = await fixture.request("PATCH", configurationPath, {
      values: {
        ...restrictedConfiguration,
        tools: { ...restrictedConfiguration.tools, deny: ["exec", toolName] },
      },
    });
    assert.equal(toolDenied.status, 200, JSON.stringify(toolDenied.error));
    const operatorDenied = await fixture.deployAndWait(primary);
    assert.deepEqual(operatorDenied.status.warnings, []);
    assert.deepEqual(await fixture.readOpenClawPluginPolicy(primary, nativePluginId), {
      plugins: { allow: allowedPlugins, enabled: true },
      tools: { allow: ["read", nativePluginId], deny: ["exec", toolName] },
    });
    const operatorDeniedSession = `agent:main:operator-tool-denied-${randomUUID()}`;
    const operatorDeniedMarker = `OPENCLAW_OPERATOR_TOOL_DENIED_${randomUUID()}`;
    await fixture.normalGatewayTurn({
      agent: primary,
      gatewayPassword: operatorDenied.gatewayPassword,
      sessionKey: operatorDeniedSession,
      prompt: `${prompt}\nIf the tool is unavailable, do not substitute another tool. Include ${operatorDeniedMarker} in the final answer.`,
      expectedPatterns: [operatorDeniedMarker],
      secrets: [modelSecret],
    });
    await fixture.assertNoSessionToolCallEvidence(primary, {
      sessionKey: operatorDeniedSession,
      turnMarker: operatorDeniedMarker,
      toolName,
    });

    const disabled = await fixture.updatePluginPolicy(primary.id, pluginId, { enabled: false });
    assert.equal(disabled.enabled, false);
    const deniedConfiguration = {
      ...restrictedConfiguration,
      plugins: { ...restrictedConfiguration.plugins, deny: [nativePluginId] },
    };
    const denied = await fixture.request("PATCH", configurationPath, {
      values: deniedConfiguration,
    });
    assert.equal(denied.status, 200, JSON.stringify(denied.error));
    const disabledRevision = await fixture.deployAndWait(primary);
    assert.equal(disabledRevision.revision.plugins?.plugins[pluginId]?.enabled, false);
    assert.deepEqual(await fixture.readOpenClawPluginPolicy(primary, nativePluginId), {
      plugins: { allow: allowedPlugins, deny: [nativePluginId], enabled: false },
      tools: { allow: ["read"], deny: ["exec"] },
    });
    const disabledMarker = `OPENCLAW_PLUGIN_DISABLED_${randomUUID()}`;
    const disabledSessionKey = `agent:main:plugin-disabled-${randomUUID()}`;
    await fixture.normalGatewayTurn({
      agent: primary,
      gatewayPassword: disabledRevision.gatewayPassword,
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
      gatewayPassword: removedRevision.gatewayPassword,
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
      gatewayPassword: deployedSibling.gatewayPassword,
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

    // A later contradictory selection must fail in the replacement's startup,
    // rather than allowing installation to erase the reusable Configuration deny.
    await fixture.selectPlugin(primary.id, {
      pluginId,
      enabled: true,
      toolDefaults: { approval: "approve" },
    });
    const conflicting = await fixture.request(
      "POST",
      `/namespaces/${fixture.namespaceId}/agents/${primary.id}/deploy`,
    );
    assert.equal(conflicting.status, 202, JSON.stringify(conflicting.error));
    const failed = await fixture.waitFor(
      "conflicting plugin revision startup failure",
      async () => {
        const listed = JSON.parse(
          await fixture.kubectl(
            "get",
            "pods",
            "--namespace",
            fixture.tenantNamespace,
            "--selector",
            `openclaw.dev/revision=${conflicting.data.id}`,
            "-o",
            "json",
          ),
        );
        for (const pod of listed.items) {
          const container = pod.status.containerStatuses?.find((container) => {
            const terminated = container.state.terminated ?? container.lastState?.terminated;
            return terminated !== undefined && terminated.exitCode !== 0;
          });
          if (container !== undefined) {
            return { pod, container };
          }
        }
      },
    );
    const logs = await fixture.kubectl(
      "logs",
      failed.pod.metadata.name,
      "--namespace",
      fixture.tenantNamespace,
      ...(failed.container.state.terminated === undefined && failed.container.restartCount > 0
        ? ["--previous"]
        : []),
    );
    assertNoSecretMaterial(
      logs,
      [modelSecret, deployedPrimary.gatewayPassword],
      "failed startup must not expose credentials.",
    );
    assert.equal(logs.includes("OpenClaw plugin configuration conflicts"), true);
    assert.equal(
      failed.pod.status.conditions?.some(
        ({ type, status }) => type === "Ready" && status === "True",
      ),
      false,
    );
  },
);

test(
  "curated Codex Google Calendar enforces per-call human and automatic review in normal Agent turns",
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
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
      providerId: "openai",
    });
    const desired = await fixture.selectPlugin(agent.id, {
      pluginId,
      enabled: true,
      toolDefaults: { approval: "native", reviewer: "auto" },
    });
    assert.equal(desired.toolDefaults.approval, "native");
    assert.equal(desired.toolDefaults.reviewer, "auto");

    const deployed = await fixture.deployAndWait(agent);
    assert.equal(deployed.revision.plugins?.driver.id, "codex-plugin");
    assert.ok(Object.hasOwn(deployed.revision.plugins?.plugins ?? {}, pluginId));
    assert.equal(Object.hasOwn(deployed.revision.plugins, "artifacts"), false);
    assert.deepEqual(deployed.revision.harnessAuth, {
      method: "chatgpt_service_account",
      serviceAccountId: account.id,
    });

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
      toolDefaults: { approval: "prompt", reviewer: "human" },
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
      toolDefaults: { approval: "prompt", reviewer: "auto" },
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
        assert.equal(
          reviewIds.has(id),
          false,
          "a repeated read must receive a new automatic review",
        );
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
      toolDefaults: { enabled: false, approval: "prompt", reviewer: "human" },
      tools: { [toolId]: { enabled: true, approval: "approve" } },
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
      toolDefaults: { enabled: true, approval: "prompt", reviewer: "human" },
      tools: { [toolId]: { enabled: false, approval: "approve" } },
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
  },
);

test(
  "curated Codex plugin failure succeeds with a warning, disables the failed plugin, and preserves a sibling Agent",
  {
    skip: pluginProofSkipReason("codex_failure"),
    timeout: 900_000,
  },
  async (context) => {
    const successPluginId =
      process.env.OCC_TEST_CODEX_SUCCESS_PLUGIN_ID ??
      "codex-plugin:google-calendar@openai-curated-remote";
    const failureCandidates = (
      process.env.OCC_TEST_CODEX_FAILURE_PLUGIN_IDS ??
      [
        "codex-plugin:microsoft-sharepoint@openai-curated-remote",
        "codex-plugin:outlook-calendar@openai-curated-remote",
        "codex-plugin:financial-charts@openai-curated-remote",
      ].join("\n")
    )
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry !== successPluginId);
    const successTurnMarker = `CODEX_BEST_EFFORT_SUCCESS_${randomUUID()}`;
    const successPrompt =
      process.env.OCC_TEST_CODEX_CALENDAR_PROMPT ??
      `Use the Google Calendar list_calendars tool with max_results 1 to read the calendars visible to this test account, then answer with the exact marker ${successTurnMarker}.`;
    const successExpectedPatterns = (
      process.env.OCC_TEST_CODEX_CALENDAR_EXPECT ?? successTurnMarker
    )
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const successToolName = process.env.OCC_TEST_CODEX_CALENDAR_TOOL_NAME;
    const successResultPattern = process.env.OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT;

    const credential = await readCodexServiceAccountCredential();
    const fixture = await createPluginDriverRealFixture(context, {
      pluginDriverId: "codex-plugin",
      databaseUrl: process.env.OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_DATABASE_URL,
      codexCredential: credential,
    });
    const account = await fixture.createCodexServiceAccountFromToken({
      accessToken: credential.accessToken,
      name: `cpf-${randomUUID().slice(0, 8)}`,
    });
    assertNoSecretMaterial(
      account,
      [credential.accessToken, credential.workspaceId],
      "ServiceAccount metadata must not expose Codex credential material.",
    );

    const primary = await fixture.createAgent({
      harnessId: "codex",
      executionMode: "dedicated",
      name: `cpf-primary-${randomUUID().slice(0, 8)}`,
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
      providerId: "openai",
    });
    const sibling = await fixture.createAgent({
      harnessId: "codex",
      executionMode: "dedicated",
      name: `cpf-sibling-${randomUUID().slice(0, 8)}`,
      harnessAuth: { method: "chatgpt_service_account", serviceAccountId: account.id },
      providerId: "openai",
    });

    // Select the known connected app through OCC before native discovery: a
    // plugin-free revision deliberately disables the remote catalog feature.
    const selectedSuccess = await fixture.selectPlugin(primary.id, {
      pluginId: successPluginId,
      enabled: true,
      toolDefaults: { approval: "native", reviewer: "auto" },
    });
    assert.equal(selectedSuccess.enabled, true);
    const deployedPrimary = await fixture.deployAndWait(primary);
    assert.deepEqual(Object.keys(deployedPrimary.revision.plugins?.plugins ?? {}), [
      successPluginId,
    ]);
    const catalog = await fixture.listCodexNativeCatalog(primary, [
      successPluginId,
      ...failureCandidates,
    ]);
    context.diagnostic(
      `native Codex catalog candidates: ${catalog.length} entries, ${catalog.filter((entry) => entry.detailAvailable).length} readable details, ${catalog.filter((entry) => entry.appCount > 0).length} with apps`,
    );
    const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
    const successEntry = catalogById.get(successPluginId);
    assert.ok(
      successEntry,
      `native Codex catalog did not contain success plugin ${successPluginId}`,
    );
    const successAppIds = new Set(successEntry.appIds);
    const failureEntry = failureCandidates
      .map((pluginId) => catalogById.get(pluginId))
      .find(
        (entry) =>
          entry?.detailAvailable === true &&
          entry.appCount > 0 &&
          entry.appIds.some((appId) => !successAppIds.has(appId)),
      );
    assert.ok(
      failureEntry,
      `native Codex catalog did not contain any configured failure candidate: ${failureCandidates.join(
        ", ",
      )}`,
    );
    const failurePluginId = failureEntry.id;
    context.diagnostic(
      `native Codex catalog selected success=${successPluginId} apps=${successEntry.appCount ?? "unknown"} failure=${failurePluginId} apps=${failureEntry.appCount ?? "unknown"}`,
    );
    function assertBestEffortDeploymentStatus(status, deploymentId) {
      assert.equal(status.deploymentId, deploymentId);
      assert.equal(status.namespaceId, fixture.namespaceId);
      assert.equal(status.agentId, primary.id);
      assert.equal(status.status, "succeeded");
      assert.equal(status.error, null);
      assert.equal(status.warnings.length, 1);
      assert.equal(status.warnings[0].pluginId, failurePluginId);
      assert.ok(
        ["PLUGIN_AUTH_REQUIRED", "PLUGIN_INSTALL_FAILED"].includes(status.warnings[0].code),
        `unexpected plugin warning code ${status.warnings[0].code}`,
      );
    }

    const installedSuccess = await fixture.codexNativePluginDetail(primary, successEntry);
    assert.equal(installedSuccess.installed, true);
    assert.equal(installedSuccess.enabled, true);
    assert.equal(installedSuccess.remotePluginId, successEntry.remotePluginId);
    const deployedSibling = await fixture.deployAndWait(sibling);
    assert.equal(
      Object.keys(deployedSibling.revision.plugins?.plugins ?? {}).length,
      0,
      "the sibling Agent starts without desired plugins.",
    );
    const siblingPodBefore = await fixture.gatewayPodIdentity(sibling);
    const sentinel = {
      name: `codex-failure-${randomUUID().slice(0, 8)}.txt`,
      content: `sibling workspace sentinel ${randomUUID()}`,
    };
    const siblingWorkspaceBefore = await fixture.writeWorkspaceSentinel(sibling, sentinel);
    assert.equal(siblingWorkspaceBefore.content, sentinel.content);

    const selectedFailure = await fixture.selectPlugin(primary.id, {
      pluginId: failurePluginId,
      enabled: true,
      toolDefaults: { approval: "native", reviewer: "auto" },
    });
    assert.equal(selectedFailure.enabled, true);
    const deployedWithWarning = await fixture.deployAndWait(primary);
    assertBestEffortDeploymentStatus(deployedWithWarning.status, deployedWithWarning.revision.id);
    assert.deepEqual(Object.keys(deployedWithWarning.revision.plugins?.plugins ?? {}), [
      successPluginId,
      failurePluginId,
    ]);
    assertBestEffortDeploymentStatus(
      await fixture.getDeploymentStatus(primary.id, deployedWithWarning.revision.id),
      deployedWithWarning.revision.id,
    );
    const primaryAfterWarning = await fixture.getAgent(primary.id);
    assert.equal(primaryAfterWarning.activeRevisionId, deployedWithWarning.revision.id);
    assert.equal(primaryAfterWarning.plugins[successPluginId].enabled, true);
    assert.equal(primaryAfterWarning.plugins[failurePluginId].enabled, true);

    const effective = await fixture.codexEffectivePluginConfiguration(primary, {
      successEntry,
      failureEntry,
    });
    assert.equal(
      effective.successBridge?.enabled,
      true,
      `missing enabled success bridge ${effective.successBridgeSlug}; keys=${effective.bridgePluginKeys.join(",")}`,
    );
    assert.equal(
      effective.failureBridge?.enabled,
      false,
      `missing disabled failure bridge ${effective.failureBridgeSlug}; keys=${effective.bridgePluginKeys.join(",")}`,
    );
    for (const [appId, config] of Object.entries(effective.successApps)) {
      assert.equal(config?.enabled, true, `${appId} must stay enabled for the successful plugin.`);
    }
    for (const [appId, config] of Object.entries(effective.failedOnlyApps)) {
      assert.equal(config?.enabled, false, `${appId} must be explicitly disabled after failure.`);
    }

    const restarted = await fixture.restartActiveCodexAgentPod(primary);
    const restartedEffective = await fixture.waitFor(
      "gateway configuration to synchronize with the restarted Codex Agent",
      async () => {
        const candidate = await fixture.codexEffectivePluginConfiguration(primary, {
          successEntry,
          failureEntry,
        });
        if (
          candidate.gatewayRuntime !== restarted.gatewayAfter.podName ||
          candidate.codexRuntime !== restarted.agentAfter.podName ||
          candidate.successBridge?.enabled !== true ||
          candidate.failureBridge?.enabled !== false ||
          !Object.values(candidate.successApps).every((config) => config?.enabled === true) ||
          !Object.values(candidate.failedOnlyApps).every((config) => config?.enabled === false)
        ) {
          return undefined;
        }
        return candidate;
      },
    );
    assert.equal(
      restartedEffective.gatewayRuntime,
      restarted.gatewayAfter.podName,
      "effective gateway configuration must be read from the gateway Pod that survived the Agent restart.",
    );
    assert.equal(
      restartedEffective.codexRuntime,
      restarted.agentAfter.podName,
      "effective Codex app configuration must be read from the fresh Agent Pod.",
    );
    assert.equal(restartedEffective.successBridge?.enabled, true);
    assert.equal(
      restartedEffective.failureBridge?.enabled,
      false,
      `missing disabled failure bridge ${restartedEffective.failureBridgeSlug}; keys=${restartedEffective.bridgePluginKeys.join(",")}`,
    );
    for (const [appId, config] of Object.entries(restartedEffective.successApps)) {
      assert.equal(config?.enabled, true, `${appId} must stay enabled after runtime restart.`);
    }
    for (const [appId, config] of Object.entries(restartedEffective.failedOnlyApps)) {
      assert.equal(
        config?.enabled,
        false,
        `${appId} must stay explicitly disabled after runtime restart.`,
      );
    }

    const successSessionKey = `agent:main:codex-best-effort-success-${randomUUID()}`;
    const content = await fixture.normalGatewayTurn({
      agent: primary,
      gatewayPassword: deployedWithWarning.gatewayPassword,
      sessionKey: successSessionKey,
      prompt: `${successPrompt}\nInclude this marker in the final answer: ${successTurnMarker}`,
      expectedPatterns: successExpectedPatterns.includes(successTurnMarker)
        ? successExpectedPatterns
        : [...successExpectedPatterns, successTurnMarker],
      secrets: [credential.accessToken, credential.workspaceId],
    });
    assertNoSecretMaterial(
      content,
      [credential.accessToken, credential.workspaceId],
      "Codex best-effort plugin proof response must not expose service-account credentials.",
    );
    const calendarEvidence = await fixture.assertSessionToolCallEvidence(primary, {
      sessionKey: successSessionKey,
      turnMarker: successTurnMarker,
      toolName: successToolName,
      resultPattern: successResultPattern,
    });
    context.diagnostic(`native Codex calendar proof tool=${calendarEvidence.toolName}`);

    assertBestEffortDeploymentStatus(
      await fixture.getDeploymentStatus(primary.id, deployedWithWarning.revision.id),
      deployedWithWarning.revision.id,
    );

    const siblingAfterFailure = await fixture.getAgent(sibling.id);
    assert.equal(
      Object.keys(siblingAfterFailure.plugins ?? {}).length,
      0,
      "the warning-producing primary deployment must not mutate sibling desired plugins.",
    );
    assert.deepEqual(
      await fixture.gatewayPodIdentity(sibling),
      siblingPodBefore,
      "the warning-producing primary deployment must not replace the sibling Agent workload.",
    );
    assert.deepEqual(await fixture.readWorkspaceSentinel(sibling, { name: sentinel.name }), {
      runtime: siblingWorkspaceBefore.runtime,
      path: siblingWorkspaceBefore.path,
      sha256: siblingWorkspaceBefore.sha256,
      length: siblingWorkspaceBefore.length,
      content: sentinel.content,
    });
  },
);
