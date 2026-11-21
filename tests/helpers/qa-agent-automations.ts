import assert from "node:assert/strict";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createConsoleFixtureTransport } from "./console-fixture-transport.ts";
import type { createQaInstallation, createQaAgent } from "./qa-installation.mjs";
import { registerQaSecret } from "./qa-secrets.ts";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;

/** Real installed OCC refusal; positive scheduled execution remains unqualified. */
export async function verifyQaAgentAutomations(f: Fixture, agent: Agent): Promise<void> {
  const transport = createConsoleFixtureTransport(f.consoleUrl, f.apiUrl);
  const session = await signInWithEmailPassword({
    ...f.credentials,
    origin: f.consoleUrl,
    headers: { origin: f.consoleUrl },
    fetch: transport.fetchThroughLoopback,
  });
  registerQaSecret(session.cookie);
  const headers = authenticatedHeaders(session, { origin: f.consoleUrl });
  const base = `/namespaces/${agent.namespaceId}/agents/${agent.id}/automations`;
  async function call(
    method: string,
    expected: number,
    body?: unknown,
    selectedHeaders: Record<string, string> = headers,
  ) {
    const result = await transport.rawRequest(method, base, {
      headers: selectedHeaders,
      body,
      timeout: 40_000,
    });
    assert.equal(result.response.status, expected, `Automation ${method} status`);
    return JSON.parse(result.text);
  }
  const input = {
    name: "Unqualified scheduled turn",
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
    prompt: "This request must not schedule execution.",
  };
  for (const enabled of [false, true]) {
    const refused = await call("POST", 503, { ...input, enabled });
    assert.equal(refused.error.code, "AUTOMATIONS_UNQUALIFIED");
  }
  assert.deepEqual((await call("GET", 200)).data.jobs, []);
  await call("GET", 403, undefined, { "x-api-key": f.serviceKey });
  await call("POST", 403, input, {
    ...headers,
    origin: "https://other.example.test",
    "sec-fetch-site": "cross-site",
  });
  await f.record(`automations-${agent.preset}`, {
    agentId: agent.id,
    revisionId: agent.revision.id,
    executionQualified: false,
    createRefused: true,
    scheduledModelTurnsVerified: 0,
  });
}
