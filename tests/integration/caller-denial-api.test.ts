import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { assertApiError } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  callerDenied,
  createDenied,
  INSTALLATION_ADMINISTER_DENIED,
  NAMESPACE_CREATE_DENIED,
} from "../helpers/refusal-text.mjs";

type Body = Record<string, unknown> | undefined;

// The production Fastify app with the Native IAM Driver and a live policy (finding 2534). A
// caller's own 403 names the grant its request checked and who grants it. It never names an ID
// the request did not carry, never tells a Restriction from a missing grant, and reads the same
// for an unknown resource as for one the caller cannot read.
test("a caller's own denial names the missing grant without disclosing what the caller cannot see", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    agentRuntimeLogs: { enabled: true, cursorSecret: `caller-denial-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Caller denials", { ready: true });
  const values = createHarnessConfiguration("openclaw", "gpt-4.1");
  const agent = await fixture.createAgent(namespace.id, "Denied Agent", values);
  const unknownAgentId = `agt_${randomUUID()}`;
  const agents = `/namespaces/${namespace.id}/agents`;

  // Namespace read only: every Agent operation below checks a grant the member lacks.
  const member = await fixture.createNamespaceMember("no-grant", namespace.id, [
    ["read", "namespace"],
  ]);
  const session = await fixture.signIn(member.credentials);
  const refusal = async (
    method: string,
    path: string,
    body?: Body,
    as: typeof session = session,
  ): Promise<{ code: string; message: string }> => {
    const response = await fixture.request(method, path, { session: as, body });
    assertApiError(response, 403, "FORBIDDEN", `${method} ${path}`);
    return response.body.error;
  };

  const logsGrant = "Agent read_logs (or Agent administer when no Restriction applies)";
  const exactCases: readonly [string, string, (id: string) => string, Body, string][] = [
    ["read", "GET", (id) => `${agents}/${id}`, undefined, "Agent read"],
    [
      "update",
      "PATCH",
      (id) => `${agents}/${id}`,
      { configurationId: agent.configurationId },
      "Agent update",
    ],
    ["delete", "DELETE", (id) => `${agents}/${id}`, undefined, "Agent delete"],
    ["deploy", "POST", (id) => `${agents}/${id}/deploy`, undefined, "Agent deploy"],
    [
      "read logs",
      "GET",
      (id) => `${agents}/${id}/deployments/rev_${randomUUID()}/runtime/logs?source=gateway`,
      undefined,
      logsGrant,
    ],
  ];
  for (const [label, method, path, body, grant] of exactCases) {
    // The text depends only on the request: an Agent the member cannot read and an ID that
    // names no Agent get the same status, code and sentence, each with the ID it sent.
    assert.deepEqual(
      await refusal(method, path(agent.id), body),
      { code: "FORBIDDEN", message: callerDenied(grant, `Agent ${agent.id}`) },
      label,
    );
    assert.deepEqual(
      await refusal(method, path(unknownAgentId), body),
      { code: "FORBIDDEN", message: callerDenied(grant, `Agent ${unknownAgentId}`) },
      `${label} of an unknown Agent`,
    );
  }

  // A create needs the collection grant, which Namespace Roles cannot give.
  assert.equal(
    (
      await refusal("POST", `/namespaces/${namespace.id}/secrets`, {
        name: "Refused",
        value: "synthetic-value",
      })
    ).message,
    createDenied("Secret", namespace.id),
  );
  assert.equal(
    (await refusal("POST", "/namespaces", { name: "Refused Namespace" })).message,
    NAMESPACE_CREATE_DENIED,
  );
  // Installation administration, from the route's own check and from the controller's.
  assert.equal((await refusal("GET", "/backends")).message, INSTALLATION_ADMINISTER_DENIED);
  assert.equal(
    (await refusal("GET", `/namespaces/${namespace.id}/iam/roles`)).message,
    INSTALLATION_ADMINISTER_DENIED,
  );

  // A Restriction denies a member who holds the grant; the member above holds none. Both get
  // the same answer, so the text never tells that an operator wrote a rule for this Agent.
  const restricted = await fixture.createAgent(namespace.id, "Restricted Agent", values);
  const reader = await fixture.createNamespaceMember("restricted-reader", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
  ]);
  const readerSession = await fixture.signIn(reader.credentials);
  fixture.policy.restrictions.push({
    id: "deny-restricted-agent-read",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: restricted.id,
    action: "read",
    effect: "deny",
  });
  const restrictedPath = `${agents}/${restricted.id}`;
  const byRestriction = await refusal("GET", restrictedPath, undefined, readerSession);
  assert.deepEqual(byRestriction, await refusal("GET", restrictedPath));
  assert.equal(byRestriction.message, callerDenied("Agent read", `Agent ${restricted.id}`));

  // A secondary grant names its ID only when the request carried it. Updating an Agent sends
  // the Configuration ID, so its Configuration read names it; deploying sends none, so the same
  // check on the stored Configuration names no ID.
  const editor = await fixture.createNamespaceMember("agent-editor", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["update", "agent"],
    ["deploy", "agent"],
  ]);
  const editorSession = await fixture.signIn(editor.credentials);
  const sent = await refusal(
    "PATCH",
    `${agents}/${agent.id}`,
    { configurationId: agent.configurationId },
    editorSession,
  );
  assert.equal(
    sent.message,
    callerDenied("Configuration read", `Configuration ${agent.configurationId}`),
  );
  const stored = await refusal("POST", `${agents}/${agent.id}/deploy`, undefined, editorSession);
  assert.equal(
    stored.message,
    callerDenied("Configuration read", "a Configuration this request uses"),
  );
});
