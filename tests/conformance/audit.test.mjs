import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditEventFactory,
  InMemoryAuditSink,
  recordAuthorizationDenial,
  recordMutation,
  redactAuditDetails,
} from "../../packages/audit/src/index.ts";

function resource(id = "agent-a") {
  return {
    kind: "agent",
    id,
    namespaceId: "namespace-a",
  };
}

test("platform mutations create attributable, scoped, immutable audit evidence", async () => {
  const sink = new InMemoryAuditSink();
  const event = await recordMutation(sink, {
    installationId: "installation-a",
    namespaceId: "namespace-a",
    actorId: "principal-admin",
    actor: { principalId: "principal-admin", kind: "principal" },
    action: "agents.create",
    resource: resource(),
    details: { driverId: "native-iam", operationId: "operation-a" },
  });

  assert.equal(event.kind, "mutation");
  assert.equal(event.outcome, "success");
  assert.equal(event.installationId, "installation-a");
  assert.equal(event.namespaceId, "namespace-a");
  assert.equal(event.actorId, "principal-admin");
  assert.equal(event.actor?.kind, "principal");
  assert.equal(event.action, "agents.create");
  assert.deepEqual(event.resource, resource());
  assert.equal(typeof event.id, "string");
  assert.ok(event.id.length > 0);
  assert.equal(Number.isNaN(Date.parse(event.occurredAt)), false);
  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0], event);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.resource), true);
});

test("audit records attribute service principal operations to their platform identities", async () => {
  const sink = new InMemoryAuditSink();
  const event = await recordMutation(sink, {
    installationId: "installation-a",
    namespaceId: "namespace-a",
    actorId: "service-principal-deployer",
    actor: { principalId: "service-principal-deployer", kind: "service_principal" },
    action: "agents.create",
    resource: resource(),
    details: { messageId: "operation-message-001" },
  });

  assert.equal(event.actorId, "service-principal-deployer");
  assert.equal(event.actor?.kind, "service_principal");
  assert.equal(event.details?.messageId, "operation-message-001");
});

test("authorization denials are attributable and never record credentials or message contents", async () => {
  const sink = new InMemoryAuditSink();
  const confidential = [
    "session-cookie-secret-value",
    "provider-secret-value",
    "nested-token-value",
    "api-key-value",
    "private-customer-message",
  ];

  const event = await recordAuthorizationDenial(sink, {
    installationId: "installation-a",
    namespaceId: "namespace-a",
    actorId: "principal-unbound",
    action: "agents.deploy",
    resource: resource(),
    details: {
      driverId: "native-iam",
      cookie: `better-auth.session_token=${confidential[0]}`,
      providerCredential: confidential[1],
      nested: {
        accessToken: confidential[2],
        attempts: [{ apiKey: confidential[3] }],
        messages: [{ content: confidential[4] }],
      },
    },
  });

  assert.equal(event.kind, "authorization_denial");
  assert.equal(event.outcome, "denied");
  assert.equal(event.actorId, "principal-unbound");
  assert.equal(event.action, "agents.deploy");
  assert.equal(event.details?.driverId, "native-iam");
  assert.equal(sink.events.length, 1);

  const serialized = JSON.stringify(event);
  for (const secret of confidential) {
    assert.ok(!serialized.includes(secret));
  }
  assert.equal(Object.isFrozen(event.details), true);
});

test("audit rejects infrastructure actor identities", async () => {
  const sink = new InMemoryAuditSink();
  const event = {
    installationId: "installation-a",
    namespaceId: "namespace-a",
    actorId: "principal-admin",
    action: "agents.create",
    resource: resource(),
  };

  await assert.rejects(
    recordMutation(sink, {
      ...event,
      actor: { principalId: "principal-admin", kind: "workload_identity" },
    }),
    /actors must be human or service principals/,
  );
  assert.equal(sink.events.length, 0);
});

test("audit sanitization retains operational evidence while removing nested sensitive values", () => {
  const sanitized = redactAuditDetails({
    namespaceId: "namespace-a",
    driver: { id: "gateway-local", password: "nested-password-value" },
    attempts: [{ secret: "nested-secret-value", result: "denied" }],
    body: "private-request-body-value",
  });

  const serialized = JSON.stringify(sanitized);
  assert.ok(serialized.includes("namespace-a"));
  assert.ok(serialized.includes("gateway-local"));
  assert.ok(serialized.includes("denied"));
  assert.ok(!serialized.includes("nested-password-value"));
  assert.ok(!serialized.includes("nested-secret-value"));
  assert.ok(!serialized.includes("private-request-body-value"));
});

test("audit evidence retains Installation identity and rejects another Namespace", async () => {
  const sink = new InMemoryAuditSink();
  const event = await recordMutation(sink, {
    installationId: "installation-a",
    namespaceId: "namespace-a",
    actorId: "principal-admin",
    action: "agents.create",
    resource: resource(),
  });
  assert.equal(event.installationId, "installation-a");
  assert.equal(Object.hasOwn(event.resource, "installationId"), false);

  await assert.rejects(
    recordMutation(sink, {
      installationId: "installation-a",
      namespaceId: "namespace-b",
      actorId: "principal-admin",
      action: "agents.create",
      resource: resource(),
    }),
    /Audit event and resource scopes must match exactly/,
  );
  assert.equal(sink.events.length, 1);
});

test("audit event kinds default to their own outcome", () => {
  const factory = new AuditEventFactory({ clock: () => "2026-09-30T12:00:00.000Z" });
  const base = {
    installationId: "installation-a",
    namespaceId: "namespace-a",
    actorId: "principal-admin",
    action: "openclaw.agents.runtime_logs.view",
    resource: resource(),
  };
  assert.deepEqual(
    ["bootstrap", "mutation", "access", "authorization_denial"].map(
      (kind) => factory.create({ ...base, kind }).outcome,
    ),
    ["success", "success", "success", "denied"],
  );
  assert.equal(factory.create({ ...base, kind: "access", outcome: "failure" }).outcome, "failure");
});
