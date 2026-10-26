import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { assertApiError } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  agentPrincipalDenied,
  callerDenied,
  createDenied,
  INSTALLATION_ADMINISTER_DENIED,
  NAMESPACE_CREATE_DENIED,
} from "../helpers/refusal-text.mjs";

type Body = Record<string, unknown> | undefined;
type Fixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type Grants = Parameters<Fixture["createNamespaceMember"]>[2];

// A signed-in Namespace member whose one Role holds exactly `grants`.
async function memberSession(fixture: Fixture, label: string, namespaceId: string, grants: Grants) {
  const member = await fixture.createNamespaceMember(label, namespaceId, grants);
  return fixture.signIn(member.credentials);
}

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
  const session = await memberSession(fixture, "no-grant", namespace.id, [["read", "namespace"]]);
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

  // The console and the CLI name the log grant in the same words (finding 2599).
  const logsGrant = "Agent read_logs (or Agent administer)";
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
  const readerSession = await memberSession(fixture, "restricted-reader", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
  ]);
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
  const editorSession = await memberSession(fixture, "agent-editor", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["update", "agent"],
    ["deploy", "agent"],
  ]);
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

  // A stored resource the caller may already read is named (finding 2594). Deploying reads the
  // Agent's model Secret from its stored Harness binding; a deployer without Secret operate learns
  // its ID only when it holds Secret read, which already shows that ID.
  const secretId = agent.harnessAuth.source.id;
  const deployer: Grants = [
    ["read", "namespace"],
    ["read", "agent"],
    ["deploy", "agent"],
    ["read", "configuration"],
  ];
  const deployRefusal = async (label: string, grants: Grants) =>
    refusal(
      "POST",
      `${agents}/${agent.id}/deploy`,
      undefined,
      await memberSession(fixture, label, namespace.id, grants),
    );
  assert.equal(
    (await deployRefusal("deployer-unread-secret", deployer)).message,
    callerDenied("Secret operate", "a Secret this request uses"),
  );
  assert.equal(
    (await deployRefusal("deployer-read-secret", [...deployer, ["read", "secret"]])).message,
    callerDenied("Secret operate", `Secret ${secretId}`),
  );
  // An Agent's SandboxPolicy ID derives from the Agent ID the path carries, so its denial names it.
  // Agent read without SandboxPolicy read, the same grants as the restricted reader above.
  assert.equal(
    (
      await refusal(
        "GET",
        `${agents}/${agent.id}/sandbox-policy/networking`,
        undefined,
        readerSession,
      )
    ).message,
    callerDenied("SandboxPolicy read", `SandboxPolicy sbp_${agent.id.slice(4)}`),
  );
});

// Finding 2592: when the Agent's own service principal lacks Secret operate on its model
// credential, deploy is refused for the Agent, not the caller. That Secret comes from the Agent's
// stored binding, so the refusal names it only to a caller who may read it, and never names the
// principal. A deployer who holds Secret operate but not Secret read learns no Secret ID.
test("an Agent principal's deploy refusal names its bound Secret only to a caller who may read it", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent principal denials", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Principal denied Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const secretId = agent.harnessAuth.source.id;
  // The Agent's principal loses its grant on the model credential; the callers below keep theirs.
  const agentGrants = fixture.policy.bindings.filter(
    (binding: { subjectId?: string }) => binding.subjectId === agent.servicePrincipalId,
  );
  assert.ok(agentGrants.length > 0);
  fixture.policy.bindings.splice(
    0,
    Infinity,
    ...fixture.policy.bindings.filter(
      (binding: { subjectId?: string }) => binding.subjectId !== agent.servicePrincipalId,
    ),
  );
  const deployPath = `/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  const deployGrants: Grants = [
    ["read", "namespace"],
    ["deploy", "agent"],
    ["read", "configuration"],
    ["operate", "secret"],
  ];
  const refusal = async (label: string, grants: Grants) => {
    const response = await fixture.request("POST", deployPath, {
      session: await memberSession(fixture, label, namespace.id, grants),
    });
    assertApiError(response, 403, "FORBIDDEN", label);
    return response.body.error.message as string;
  };

  // Deploy-only: the caller's own grants pass, but it cannot read the Secret, so the text names
  // the Agent it sent and no Secret.
  const hidden = await refusal("deploy-only", deployGrants);
  assert.equal(hidden, agentPrincipalDenied(`Agent ${agent.id}`, "one of its bound Secrets"));
  assert.equal(hidden.includes(secretId), false);
  assert.equal(hidden.includes(agent.servicePrincipalId), false);
  // The same grants plus Secret read: the caller can already see the Secret, so it is named.
  const named = await refusal("deploy-and-secret-read", [...deployGrants, ["read", "secret"]]);
  assert.equal(named, agentPrincipalDenied(`Agent ${agent.id}`, `Secret ${secretId}`));
});
