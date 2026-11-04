import assert from "node:assert/strict";
import { protectedText } from "./qa-secrets.mjs";

export async function verifyAwsSecretDiscovery() {
  const origin = new URL(process.env.OCC_TEST_QA_AWS_DISCOVERY_ORIGIN);
  assert.ok(
    origin.origin === process.env.OCC_TEST_QA_AWS_DISCOVERY_ORIGIN &&
      ["http:", "https:"].includes(origin.protocol) &&
      ["127.0.0.1", "[::1]"].includes(origin.hostname),
    "Use the loopback origin forwarded to the prepared OCC API",
  );
  const namespaceId = process.env.OCC_TEST_QA_AWS_DISCOVERY_NAMESPACE_ID;
  const agentId = process.env.OCC_TEST_QA_AWS_DISCOVERY_AGENT_ID;
  assert.match(namespaceId, /^ns_[a-zA-Z0-9_-]+$/);
  assert.match(agentId, /^agt_[a-zA-Z0-9_-]+$/);
  const pluginId = process.env.OCC_TEST_QA_AWS_DISCOVERY_PLUGIN_ID;
  const key = await protectedText(
    process.env.OCC_TEST_QA_AWS_DISCOVERY_KEY_FILE,
    "OCC service key",
  );

  async function api(path, body) {
    const response = await fetch(new URL(path, origin), {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: { "x-api-key": key, ...(body && { "content-type": "application/json" }) },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `OCC request failed with HTTP ${response.status}`);
    return response.json();
  }

  // Curated discovery succeeds without a Secret read. Require the installed hosted Driver.
  const {
    data: { configurations },
  } = await api("/installation/driver-configurations");
  assert.ok(
    configurations.some(
      (entry) =>
        entry.capability === "secret" &&
        entry.driverId === "secret-aws-secrets-manager" &&
        entry.implementation === "occ/aws-secrets-manager",
    ),
  );
  const {
    data: { capabilities },
  } = await api("/installation");
  assert.equal(capabilities.pluginPolicies.driver.implementation, "occ/codex-plugin");
  assert.equal(capabilities.pluginDiscovery.credential, "required");

  const path = `/namespaces/${namespaceId}/agents/${agentId}`;
  const { data: agent } = await api(path);
  assert.equal(agent.namespaceId, namespaceId);
  assert.equal(agent.id, agentId);
  assert.equal(agent.executionMode, "dedicated");
  assert.equal(agent.harnessAuth?.method, "codex_pat");
  assert.equal(agent.harnessAuth.source.kind, "secret");
  assert.equal(agent.harnessAuth.source.namespaceId, namespaceId);

  // Supply only the hosted catalog entry. OCC must derive the credential from the saved Agent.
  const { data, meta } = await api(`${path}/plugins/details`, { pluginId });
  assert.ok(data.remoteId === pluginId, "The hosted catalog returned a different entry");
  assert.match(meta.requestId, /^req_[0-9a-f-]{36}$/);
  return meta.requestId;
}
