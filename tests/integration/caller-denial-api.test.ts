import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { assertApiError } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { assertSameAnswer } from "../helpers/refusal-answers.mjs";
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
  // its ID only when it holds Secret read, which already shows that ID, and Agent read, which
  // already shows that this Agent binds it.
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
  // Secret read without Agent read: the caller may read the Secret but not the Agent record that
  // binds it, so the text names no Secret.
  const withoutAgentRead = deployer.filter(
    ([action, kind]) => !(action === "read" && kind === "agent"),
  );
  assert.equal(
    (
      await deployRefusal("deployer-read-secret-not-agent", [
        ...withoutAgentRead,
        ["read", "secret"],
      ])
    ).message,
    callerDenied("Secret operate", "a Secret this request uses"),
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
// stored binding, so the refusal names it only to a caller who may read both it and the Agent,
// and never names the principal. Secret read alone shows the Secret, not that this Agent uses it.
test("an Agent principal's deploy refusal names its bound Secret only to a caller who may read it and the Agent", async (t) => {
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
  // Secret read or Agent read alone: the caller sees the Secret or the Agent record, never both,
  // so it cannot already tell that this Agent binds this Secret and the text names none.
  const generic = agentPrincipalDenied(`Agent ${agent.id}`, "one of its bound Secrets");
  for (const [label, grant] of [
    ["deploy-and-secret-read", ["read", "secret"]],
    ["deploy-and-agent-read", ["read", "agent"]],
  ] as const) {
    assert.equal(await refusal(label, [...deployGrants, grant]), generic, label);
  }
  // Both reads: the caller can already see the Secret and the binding, so the Secret is named.
  const named = await refusal("deploy-secret-and-agent-read", [
    ...deployGrants,
    ["read", "secret"],
    ["read", "agent"],
  ]);
  assert.equal(named, agentPrincipalDenied(`Agent ${agent.id}`, `Secret ${secretId}`));
});

// Finding 2614: saving a Configuration or credential source without new bindings checks Secret
// operate on the bindings it already stores. The binding is part of that record, so the caller's
// own denial names the bound Secret only when the caller may read both the Secret and the record.
// With Secret read alone, the text would tell a caller that a record it cannot read binds that
// Secret. The allow or deny decision is unchanged; only the text differs.
test("a stored binding's denial names its Secret only to a caller who may read the record that binds it", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  // The Credential Gateway is a test double; HTTP, IAM and OCC admission stay real.
  const gateway = {
    id: "caller-denial-gateway",
    capability: "credential_gateway",
    implementation: "test-ready-gateway",
    validateSourceConfig() {},
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
      ];
    },
    async registerSource() {
      return { state: "ready" };
    },
    async sourceStatus() {
      return { state: "ready" };
    },
    ...Object.fromEntries(
      [
        "updateSource",
        "rotateSource",
        "removeSource",
        "attachForRevision",
        "attachmentStatus",
        "withdraw",
      ].map((name) => [
        name,
        async () => {
          throw new Error(`${name} is not exercised: the save is refused first`);
        },
      ]),
    ),
  };
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver("credential_gateway", gateway.id);
  const namespace = await fixture.createNamespace("Stored binding denials", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Bound token", "synthetic-bound-token");
  const configuration = await fixture.createConfiguration(
    namespace.id,
    {},
    { secretBindings: { EXTERNAL_API_TOKEN: { source: secret.ref, delivery: { type: "env" } } } },
  );
  const sources = `/namespaces/${namespace.id}/credential-sources`;
  const source = await fixture.request("POST", sources, {
    body: { name: "bound-source", type: "openai", secrets: { api_key: secret.ref } },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));

  // Each save sends no Secret ID: the denied Secret comes from the stored record.
  const cases = [
    {
      label: "configuration",
      path: `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      body: { values: {} },
      kind: "configuration",
    },
    {
      label: "credential-source",
      path: `${sources}/${source.data.id}`,
      body: {},
      kind: "credential_source",
    },
  ] as const;
  for (const { label, path, body, kind } of cases) {
    const refusal = async (suffix: string, grants: Grants) => {
      const session = await memberSession(fixture, `${label}-${suffix}`, namespace.id, [
        ["read", "namespace"],
        ["update", kind],
        ["read", "secret"],
        ...grants,
      ]);
      const response = await fixture.request("PATCH", path, { session, body });
      assertApiError(response, 403, "FORBIDDEN", `${label} ${suffix}`);
      return response.body.error.message as string;
    };
    // Secret read without read on the record: the caller cannot already see the binding.
    assert.equal(
      await refusal("secret-read", []),
      callerDenied("Secret operate", "a Secret this request uses"),
      label,
    );
    // Read on both: the caller can already see the Secret and that this record binds it.
    assert.equal(
      await refusal("secret-and-record-read", [["read", kind]]),
      callerDenied("Secret operate", `Secret ${secret.id}`),
      label,
    );
    // Without update on the record, the stored-binding check never runs: the caller who reads
    // both gets one denial for this record and for an ID that names none (finding 2624).
    const reader = await memberSession(fixture, `${label}-reader`, namespace.id, [
      ["read", "namespace"],
      ["read", kind],
      ["read", "secret"],
    ]);
    const recordId = path.split("/").at(-1) as string;
    const collection = path.slice(0, -recordId.length);
    await assertSameAnswer(
      (id: string) => fixture.request("PATCH", `${collection}${id}`, { session: reader, body }),
      [recordId, `${recordId.split("_")[0]}_${randomUUID()}`],
      { label },
    );
  }
});
