import assert from "node:assert/strict";
import test from "node:test";
import { projectPlatformAuditRow } from "../../packages/audit/src/index.ts";
import {
  encodePlatformAuditPageV1,
  parsePlatformAuditEventV1,
  parsePlatformAuditPageV1,
} from "../../packages/contracts/src/index.ts";

const installationId = "ins_10000000-0000-4000-8000-000000000001";
const otherInstallationId = "ins_10000000-0000-4000-8000-000000000002";
const namespaceId = "ns_20000000-0000-4000-8000-000000000001";
const otherNamespaceId = "ns_20000000-0000-4000-8000-000000000002";
const secretId = "sec_30000000-0000-4000-8000-000000000001";
const id = "aud_40000000-0000-4000-8000-000000000001";
const requestId = "req_50000000-0000-4000-8000-000000000001";
const admissionDecisionId = "adm_60000000-0000-4000-8000-000000000001";
const occurredAt = "2026-09-23T12:30:00.123456Z";
const unavailable = { name: "Error", message: "Platform audit data is unavailable." };

// Raw column/extract inputs exercise the component contract. They do not claim
// persisted producer, SQL extraction, IAM, or HTTP integration coverage.
function row(patch = {}) {
  return {
    id,
    occurred_at: occurredAt,
    kind: "mutation",
    actor_id: "principal-recorded",
    action: "openclaw.secrets.update",
    namespace_id: namespaceId,
    resource_kind: "secret",
    resource_id: secretId,
    outcome: "success",
    details_type: "object",
    metadata_type: null,
    metadata_keys: null,
    metadata_schema_version: null,
    metadata_source: null,
    metadata_request_id: null,
    metadata_admission_decision_id: null,
    actor_type: null,
    actor_keys: null,
    actor_id_value: null,
    actor_principal_id: null,
    actor_kind: null,
    actor_unresolved: null,
    history_fact_type: null,
    ...patch,
  };
}

function page(events = [], patch = {}) {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    coverageVersion: "platform-bootstrap-namespace-secret-v1",
    installationId,
    window: { from: "2026-09-23T00:00:00Z", to: "2026-09-24T00:00:00Z" },
    limit: 50,
    events,
    continuation: null,
    ...patch,
  };
}

const cases = [
  [
    "HTTP bootstrap",
    {
      kind: "bootstrap",
      action: "openclaw.installation.bootstrap",
      namespace_id: null,
      resource_kind: "installation",
      resource_id: installationId,
    },
    {
      family: "installation",
      action: "installation.bootstrap",
      outcome: "success",
      target: { kind: "installation", id: installationId },
    },
  ],
  [
    "operator bootstrap",
    {
      kind: "bootstrap",
      action: "administer",
      namespace_id: null,
      resource_kind: "installation",
      resource_id: installationId,
    },
    {
      family: "installation",
      action: "installation.bootstrap",
      outcome: "success",
      target: { kind: "installation", id: installationId },
    },
  ],
  [
    "Namespace creation accepted",
    { action: "openclaw.namespaces.create", resource_kind: "namespace", resource_id: namespaceId },
    {
      family: "namespace",
      action: "namespace.creation_accepted",
      outcome: "success",
      namespaceId,
      target: { kind: "namespace", id: namespaceId },
    },
  ],
  [
    "Namespace deletion requested",
    { action: "openclaw.namespaces.delete", resource_kind: "namespace", resource_id: namespaceId },
    {
      family: "namespace",
      action: "namespace.deletion_requested",
      outcome: "success",
      namespaceId,
      target: { kind: "namespace", id: namespaceId },
    },
  ],
  [
    "Secret created",
    { action: "openclaw.secrets.create" },
    {
      family: "secret",
      action: "secret.created",
      outcome: "success",
      namespaceId,
      target: { kind: "secret", id: secretId },
    },
  ],
  [
    "Secret updated",
    {},
    {
      family: "secret",
      action: "secret.updated",
      outcome: "success",
      namespaceId,
      target: { kind: "secret", id: secretId },
    },
  ],
  [
    "Secret deleted",
    { action: "openclaw.secrets.delete" },
    {
      family: "secret",
      action: "secret.deleted",
      outcome: "success",
      namespaceId,
      target: { kind: "secret", id: secretId },
    },
  ],
  [
    "Namespace creation denied at Installation collection",
    {
      kind: "authorization_denial",
      outcome: "denied",
      action: "openclaw.namespaces.create",
      namespace_id: null,
      resource_kind: "namespace",
      resource_id: installationId,
    },
    {
      family: "namespace",
      action: "namespace.creation_accepted",
      outcome: "denied",
      target: { kind: "namespace_collection", installationId },
    },
  ],
  [
    "Namespace deletion denied",
    {
      kind: "authorization_denial",
      outcome: "denied",
      action: "openclaw.namespaces.delete",
      resource_kind: "namespace",
      resource_id: namespaceId,
    },
    {
      family: "namespace",
      action: "namespace.deletion_requested",
      outcome: "denied",
      namespaceId,
      target: { kind: "namespace", id: namespaceId },
    },
  ],
  [
    "Secret creation denied at Namespace collection",
    {
      kind: "authorization_denial",
      outcome: "denied",
      action: "openclaw.secrets.create",
      resource_id: namespaceId,
    },
    {
      family: "secret",
      action: "secret.created",
      outcome: "denied",
      namespaceId,
      target: { kind: "secret_collection", namespaceId },
    },
  ],
  [
    "Secret update denied",
    { kind: "authorization_denial", outcome: "denied" },
    {
      family: "secret",
      action: "secret.updated",
      outcome: "denied",
      namespaceId,
      target: { kind: "secret", id: secretId },
    },
  ],
  [
    "Secret deletion denied",
    { kind: "authorization_denial", outcome: "denied", action: "openclaw.secrets.delete" },
    {
      family: "secret",
      action: "secret.deleted",
      outcome: "denied",
      namespaceId,
      target: { kind: "secret", id: secretId },
    },
  ],
];

for (const [name, input, expected] of cases) {
  test(`Platform audit projects ${name} through its closed encoder`, () => {
    // HTTP emits actor/reference metadata; the operator bootstrap emits source
    // only. The ignored authorization/identity values never enter this shape.
    const producerMetadata =
      name === "operator bootstrap"
        ? { metadata_type: "object", metadata_keys: ["source"], metadata_source: "occ" }
        : {
            metadata_type: "object",
            metadata_keys: [
              "schemaVersion",
              "source",
              "requestId",
              "admissionDecisionId",
              "actor",
              "iamDriverId",
              "authorization",
              ...(expected.outcome === "denied" ? ["reasonCode"] : []),
            ],
            metadata_schema_version: 1,
            metadata_source: "occ",
            metadata_request_id: requestId,
            metadata_admission_decision_id: admissionDecisionId,
            actor_type: "object",
            actor_keys: ["principalId", "issuer", "subject"],
            actor_principal_id: "principal-recorded",
          };
    const event = projectPlatformAuditRow(row({ ...input, ...producerMetadata }), installationId);
    const expectedEvent = {
      schemaVersion: 1,
      id,
      occurredAt,
      installationId,
      actor: { status: "recorded", id: "principal-recorded", kind: "unknown" },
      ...(name === "operator bootstrap" ? {} : { requestId, admissionDecisionId }),
      ...expected,
    };
    assert.deepEqual(event, expectedEvent);
    assert.deepEqual(JSON.parse(encodePlatformAuditPageV1(page([event]))), page([expectedEvent]));
    assert.equal(Object.isFrozen(event.target), true);
    assert.equal(Object.isFrozen(event.actor), true);
  });
}

test("unsupported tuples are distinct from malformed selected rows", () => {
  for (const patch of [
    { action: "openclaw.agents.create" },
    { action: "openclaw.agent_provisioning.complete" },
    { action: "openclaw.iam.bindings.create" },
    { action: "openclaw.secrets.create.extra" },
    { action: "administer" },
    { kind: "bootstrap" },
    { outcome: "failure" },
    { kind: "authorization_denial", outcome: "success" },
  ]) {
    assert.equal(projectPlatformAuditRow(row(patch), installationId), undefined);
  }
  for (const patch of [
    { resource_kind: "agent" },
    { resource_id: namespaceId },
    { namespace_id: null },
    { namespace_id: otherInstallationId },
    { outcome: null },
    { action: { toString: () => "openclaw.secrets.update" } },
  ]) {
    assert.throws(() => projectPlatformAuditRow(row(patch), installationId), unavailable);
  }
});

test("selected parent and target mismatches refuse the entire projection", () => {
  for (const input of [
    { ...cases[0][1], resource_id: otherInstallationId },
    { ...cases[0][1], namespace_id: namespaceId },
    { ...cases[2][1], resource_id: otherNamespaceId },
    { ...cases[7][1], resource_id: namespaceId },
    { ...cases[7][1], namespace_id: namespaceId },
    { ...cases[9][1], resource_id: secretId },
    { ...cases[9][1], resource_id: otherNamespaceId },
  ]) {
    assert.throws(() => projectPlatformAuditRow(row(input), installationId), unavailable);
  }
});

test("recorded, unresolved, and unknown-kind attribution never imply a human", () => {
  assert.deepEqual(projectPlatformAuditRow(row({ actor_id: "unresolved" }), installationId).actor, {
    status: "unresolved",
  });
  const actorMetadata = {
    metadata_type: "object",
    metadata_keys: ["actor"],
    actor_type: "object",
    actor_keys: ["principalId", "kind", "issuer", "subject"],
    actor_principal_id: "principal-recorded",
  };
  for (const actor_kind of ["principal", "service_principal", "future_identity"]) {
    assert.deepEqual(
      projectPlatformAuditRow(row({ ...actorMetadata, actor_kind }), installationId).actor,
      { status: "recorded", id: "principal-recorded", kind: "unknown" },
    );
  }
  const unresolved = row({
    actor_id: "unresolved",
    metadata_type: "object",
    metadata_keys: ["actor"],
    actor_type: "object",
    actor_keys: ["unresolved"],
    actor_unresolved: true,
  });
  assert.deepEqual(projectPlatformAuditRow(unresolved, installationId).actor, {
    status: "unresolved",
  });
  for (const patch of [
    { ...unresolved, actor_id: "principal-recorded" },
    { ...actorMetadata, actor_kind: "principal", actor_principal_id: "different-actor" },
    {
      ...actorMetadata,
      actor_kind: "principal",
      actor_id: "unresolved",
      actor_principal_id: "unresolved",
    },
    { ...unresolved, actor_keys: ["unresolved", "kind"], actor_kind: "principal" },
    { ...unresolved, actor_unresolved: false },
  ]) {
    assert.throws(() => projectPlatformAuditRow(row(patch), installationId), unavailable);
  }
});

test("reserved metadata cannot overwrite ledger scope, actor, target, time, or inject History", () => {
  for (const key of [
    "id",
    "occurredAt",
    "installationId",
    "namespaceId",
    "actorId",
    "kind",
    "action",
    "resource",
    "outcome",
    "history_fact",
    "__proto__",
  ]) {
    assert.throws(
      () =>
        projectPlatformAuditRow(
          row({ metadata_type: "object", metadata_keys: [key] }),
          installationId,
        ),
      unavailable,
    );
  }
  for (const history_fact_type of ["object", "null", "string", "array", "boolean"]) {
    assert.throws(
      () => projectPlatformAuditRow(row({ history_fact_type }), installationId),
      unavailable,
    );
  }
  for (const patch of [
    { details_type: "null" },
    { details_type: "array" },
    { details_type: null, metadata_type: "object", metadata_keys: [] },
    { metadata_type: "null" },
    { metadata_type: "array", metadata_keys: [] },
    { metadata_type: "object", metadata_keys: ["source"], metadata_source: "foreign" },
    { metadata_type: "object", metadata_keys: ["schemaVersion"], metadata_schema_version: "1" },
    { metadata_type: "object", metadata_keys: ["actor"], actor_type: "null" },
    {
      metadata_type: "object",
      metadata_keys: ["actor"],
      actor_type: "object",
      actor_keys: ["resource"],
    },
    { metadata_type: "object", metadata_keys: ["source", "source"], metadata_source: "occ" },
  ]) {
    assert.throws(() => projectPlatformAuditRow(row(patch), installationId), unavailable);
  }
});

test("only present, independently validated request and admission references are emitted", () => {
  const references = {
    metadata_type: "object",
    metadata_keys: ["schemaVersion", "source", "requestId", "admissionDecisionId"],
    metadata_schema_version: 1,
    metadata_source: "occ",
    metadata_request_id: requestId,
    metadata_admission_decision_id: admissionDecisionId,
  };
  const event = projectPlatformAuditRow(row(references), installationId);
  assert.equal(event.requestId, requestId);
  assert.equal(event.admissionDecisionId, admissionDecisionId);
  assert.equal(Object.hasOwn(projectPlatformAuditRow(row(), installationId), "requestId"), false);
  for (const value of [
    null,
    "",
    "caller-controlled",
    "req_" + "a".repeat(129),
    "é".repeat(65),
    "https://example.invalid/private",
    requestId + "\n",
    { secret: "CANARY_PRIVATE_REFERENCE" },
  ]) {
    assert.throws(
      () =>
        projectPlatformAuditRow(row({ ...references, metadata_request_id: value }), installationId),
      unavailable,
    );
    assert.throws(
      () =>
        projectPlatformAuditRow(
          row({ ...references, metadata_admission_decision_id: value }),
          installationId,
        ),
      unavailable,
    );
  }
  assert.throws(
    () => projectPlatformAuditRow(row({ metadata_request_id: requestId }), installationId),
    unavailable,
  );
});

test("private fields and canaries cannot cross the closed raw or public boundary", () => {
  const event = projectPlatformAuditRow(row(), installationId);
  for (const [key, value] of Object.entries({
    details: { secretValue: "CANARY_SECRET", prompt: "CANARY_PROMPT" },
    issuer: "https://CANARY_ISSUER.invalid",
    subject: "CANARY_SUBJECT",
    headers: { authorization: "Bearer CANARY_TOKEN" },
    error: "CANARY_ERROR",
    history_fact: { content: "CANARY_HISTORY" },
  })) {
    assert.throws(
      () => projectPlatformAuditRow({ ...row(), [key]: value }, installationId),
      unavailable,
    );
    assert.throws(() => encodePlatformAuditPageV1(page([{ ...event, [key]: value }])), unavailable);
  }
  assert.throws(
    () =>
      parsePlatformAuditEventV1({ ...event, actor: { ...event.actor, issuer: "CANARY_ISSUER" } }),
    unavailable,
  );
  const serialized = encodePlatformAuditPageV1(page([event]));
  assert.equal(serialized.includes("CANARY"), false);
  assert.deepEqual(
    Object.keys(JSON.parse(serialized).events[0]).sort(),
    [
      "schemaVersion",
      "id",
      "occurredAt",
      "installationId",
      "namespaceId",
      "family",
      "action",
      "outcome",
      "target",
      "actor",
    ].sort(),
  );
});

test("timestamps preserve PostgreSQL precision and reject invalid calendar values", () => {
  for (const time of [
    "2026-09-23T12:30:00Z",
    "2026-09-23T12:30:00.1Z",
    "2026-09-23T12:30:00.123Z",
    occurredAt,
    "2024-02-29T00:00:00.000001Z",
  ]) {
    assert.equal(
      projectPlatformAuditRow(row({ occurred_at: time }), installationId).occurredAt,
      time,
    );
  }
  for (const time of [
    new Date(occurredAt),
    "2026-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-09-23T24:00:00Z",
    "2026-09-23T12:30:60Z",
    "2026-09-23T12:30:00.1234567Z",
    "2026-09-23T12:30:00+00:00",
    "0000-01-01T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "invalid",
  ]) {
    assert.throws(
      () => projectPlatformAuditRow(row({ occurred_at: time }), installationId),
      unavailable,
    );
  }
});

test("pages validate exact descending microsecond keys, ties, and the half-open window", () => {
  const first = projectPlatformAuditRow(row(), installationId);
  const older = {
    ...first,
    id: "aud_40000000-0000-4000-8000-000000000003",
    occurredAt: "2026-09-23T12:30:00.123455Z",
  };
  const higherId = { ...first, id: "aud_40000000-0000-4000-8000-000000000002" };
  assert.equal(
    parsePlatformAuditPageV1(page([first, older])).events[1].occurredAt,
    older.occurredAt,
  );
  assert.equal(parsePlatformAuditPageV1(page([higherId, first])).events.length, 2);
  for (const events of [
    [older, first],
    [first, higherId],
    [first, first],
    [{ ...first, occurredAt: "2026-09-24T00:00:00Z" }],
    [{ ...first, occurredAt: "2026-09-22T23:59:59.999999Z" }],
    [{ ...first, installationId: otherInstallationId }],
  ]) {
    assert.throws(() => encodePlatformAuditPageV1(page(events)), unavailable);
  }
  assert.equal(
    parsePlatformAuditPageV1(page([{ ...first, occurredAt: "2026-09-23T00:00:00Z" }])).events
      .length,
    1,
  );
});

test("closed validation rejects accessors, prototypes, hidden fields, sparse arrays, and serializer hooks", () => {
  const event = projectPlatformAuditRow(row(), installationId);
  let accessed = false;
  const getter = { ...event };
  Object.defineProperty(getter, "action", {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error("CANARY_GETTER");
    },
  });
  const rawGetter = row();
  Object.defineProperty(rawGetter, "metadata_keys", {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error("CANARY_GETTER");
    },
  });
  const hidden = { ...event };
  Object.defineProperty(hidden, "details", { value: "CANARY_HIDDEN" });
  const symbol = { ...event, [Symbol("private")]: "CANARY_SYMBOL" };
  for (const bad of [
    getter,
    hidden,
    symbol,
    Object.assign(Object.create({ actorId: "foreign" }), event),
    { ...event, toJSON: () => ({ private: "CANARY_JSON" }) },
  ]) {
    assert.throws(() => parsePlatformAuditEventV1(bad), unavailable);
  }
  assert.throws(() => projectPlatformAuditRow(rawGetter, installationId), unavailable);
  assert.equal(accessed, false);
  const events = [event];
  Object.defineProperty(events, "0", {
    get() {
      accessed = true;
      return event;
    },
  });
  assert.throws(() => encodePlatformAuditPageV1(page(events)), unavailable);
  assert.throws(() => encodePlatformAuditPageV1(page(new Array(1))), unavailable);
  assert.equal(accessed, false);
});

test("nominal IDs and byte ceilings fail without truncating, and maximal pages remain bounded", () => {
  const full = projectPlatformAuditRow(
    row({
      actor_id: "a".repeat(256),
      metadata_type: "object",
      metadata_keys: ["requestId", "admissionDecisionId"],
      metadata_request_id: requestId,
      metadata_admission_decision_id: admissionDecisionId,
    }),
    installationId,
  );
  assert.equal(full.actor.id.length, 256);
  for (const patch of [
    { actor_id: "a".repeat(257) },
    { actor_id: "é".repeat(129) },
    { id: "aud_" + "a".repeat(256) },
    { id: "audit-not-nominal" },
    { resource_id: "sec_not-a-uuid" },
    { namespace_id: "ns_20000000-0000-1000-8000-000000000001" },
  ]) {
    assert.throws(() => projectPlatformAuditRow(row(patch), installationId), unavailable);
  }
  const events = Array.from({ length: 100 }, (_, index) => ({
    ...full,
    id: `aud_40000000-0000-4000-8000-${String(100 - index).padStart(12, "0")}`,
  }));
  const maximum = page(events, { limit: 100, continuation: "c".repeat(4096) });
  const encoded = encodePlatformAuditPageV1(maximum);
  // Closed ASCII fields and nominal UUIDs impose a stronger maximum than the
  // aggregate ceilings: even a conservative 2 KiB/event leaves this below 210 KiB.
  assert.ok(Buffer.byteLength(JSON.stringify(full), "utf8") < 2048);
  assert.ok(Buffer.byteLength(encoded, "utf8") < 210 * 1024);
  assert.equal(JSON.parse(encoded).continuation.length, 4096);
  assert.equal(JSON.parse(encoded).events.length, 100);
  assert.throws(
    () => encodePlatformAuditPageV1(page(events, { limit: 100, continuation: "c".repeat(4097) })),
    unavailable,
  );
  assert.throws(
    () => encodePlatformAuditPageV1(page([...events, full], { limit: 100 })),
    unavailable,
  );
  assert.throws(
    () => encodePlatformAuditPageV1(page([{ ...full, details: "CANARY".repeat(200_000) }])),
    unavailable,
  );
});

test("page versions, limits, windows, and unknown fields fail closed; empty pages are valid data only", () => {
  assert.deepEqual(JSON.parse(encodePlatformAuditPageV1(page())), page());
  for (const patch of [
    { schemaVersion: 2 },
    { projectionVersion: 2 },
    { coverageVersion: "all-audit" },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "50" },
    { continuation: "https://example.invalid" },
    { count: 999 },
    { window: { from: "2026-09-01T00:00:00Z", to: "2026-09-09T00:00:00Z" } },
    { window: { from: "2026-09-24T00:00:00Z", to: "2026-09-24T00:00:00Z" } },
  ]) {
    assert.throws(() => encodePlatformAuditPageV1(page([], patch)), unavailable);
  }
  assert.throws(
    () =>
      encodePlatformAuditPageV1(
        page([projectPlatformAuditRow(row(), installationId)], { limit: 0 }),
      ),
    unavailable,
  );
});
