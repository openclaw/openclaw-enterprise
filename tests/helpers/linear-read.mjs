import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertNoSecretMaterial } from "./plugin-driver-real.mjs";

// Both fixtures use the ordinary deployed Agent and correlate native tool calls
// with successful results. Assistant prose alone cannot satisfy this proof.
export async function verifyLinearRead(fixture, agent, credential, { remotePluginId } = {}) {
  const prompt = process.env.OCC_TEST_CODEX_LINEAR_PROMPT?.trim();
  const toolName = process.env.OCC_TEST_CODEX_LINEAR_TOOL_NAME?.trim();
  const resultPattern = process.env.OCC_TEST_CODEX_LINEAR_RESULT_EXPECT?.trim();
  assert.ok(prompt, "OCC_TEST_CODEX_LINEAR_PROMPT must request a harmless Linear read.");
  assert.ok(toolName, "OCC_TEST_CODEX_LINEAR_TOOL_NAME must identify the read tool.");
  assert.ok(resultPattern, "OCC_TEST_CODEX_LINEAR_RESULT_EXPECT must identify its result.");

  const pluginId = "codex-plugin:linear@openai-curated-remote";
  await fixture.selectPlugin(agent.id, {
    pluginId,
    enabled: true,
    toolDefaults: { approval: "provider_default", reviewer: "auto" },
  });
  const deployed = await fixture.deployAndWait(agent);
  assert.equal(deployed.revision.plugins?.driver.id, "codex-plugin");
  assert.ok(Object.hasOwn(deployed.revision.plugins?.plugins ?? {}, pluginId));
  assert.deepEqual(deployed.revision.harnessAuth, agent.harnessAuth);
  assert.deepEqual(
    deployed.status.warnings,
    [],
    "Linear must install with connected account authentication.",
  );
  const [native] = await fixture.listCodexNativeCatalog(agent, [pluginId]);
  assert.ok(native?.detailAvailable && native.appCount > 0);
  if (remotePluginId !== undefined) {
    assert.equal(native.remotePluginId, remotePluginId);
  }

  const turnMarker = `CODEX_LINEAR_CATALOG_${randomUUID()}`;
  const sessionKey = `agent:main:codex-linear-${randomUUID()}`;
  const content = await fixture.normalGatewayTurn({
    agent,
    gatewayPassword: deployed.gatewayPassword,
    sessionKey,
    prompt: `${prompt}\nInclude this marker in the final answer: ${turnMarker}`,
    expectedPatterns: [turnMarker],
    secrets: [credential.accessToken, credential.workspaceId],
  });
  assertNoSecretMaterial(
    content,
    [credential.accessToken, credential.workspaceId],
    "Linear Agent output must not expose credentials.",
  );
  await fixture.assertSessionToolCallEvidence(agent, {
    sessionKey,
    turnMarker,
    toolName,
    resultPattern,
  });
}
