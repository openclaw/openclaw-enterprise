import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";

// The Configuration write limit: the Kubernetes Driver's 1 MiB of values and a 32 KiB envelope,
// all written with six-byte JSON escapes.
const CONFIGURATION_BODY_LIMIT = 6 * (1024 * 1024 + 32 * 1024);
const collection = (namespaceId) => `/namespaces/${namespaceId}/configurations`;
const configurationPath = (namespaceId, configurationId) =>
  `${collection(namespaceId)}/${configurationId}`;
const notes = (text) => ({
  plugins: { entries: { knowledge: { enabled: true, config: { notes: text } } } },
});
// The Kubernetes Configuration Driver's own size rule, the one these limits must admit.
const driverAccepts = async (values) => {
  try {
    await KubernetesConfigurationDriver.prototype.validateValues.call({}, values);
    return true;
  } catch {
    return false;
  }
};

async function createFixture(t) {
  const audit = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink: audit, providers: [] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Configuration body limits", { ready: true });
  return { ...fixture, audit, namespace };
}

// Sends `text` as the exact request body, without re-encoding it.
async function sendRaw(fixture, method, path, text, session) {
  const response = await fetch(new URL(path, fixture.origin), {
    method,
    headers: {
      ...authenticatedHeaders(session, { origin: fixture.origin }),
      "content-type": "application/json",
    },
    body: text,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() };
}

// Declares `declaredBytes`, sends only a 64 KiB prefix, and resolves with the response, or null
// when the controller waits for the rest of the body.
function partialWrite(fixture, method, path, session, declaredBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        request.destroy();
        callback(value);
      }
    };
    const request = httpRequest(new URL(path, fixture.origin), {
      method,
      headers: {
        ...authenticatedHeaders(session, { origin: fixture.origin }),
        "content-type": "application/json",
        "content-length": String(declaredBytes),
      },
    });
    const timer = setTimeout(() => settle(resolve, null), 15_000);
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          settle(resolve, { status: response.statusCode, body });
        } catch (error) {
          settle(reject, error);
        }
      });
      response.on("error", (error) => settle(reject, error));
    });
    request.on("error", (error) => settle(reject, error));
    request.write(`{"kind":"agent","values":{"notes":"${"x".repeat(64 * 1024)}`);
  });
}

test("Configuration writes admit every Configuration the Kubernetes Driver stores", async (t) => {
  const fixture = await createFixture(t);
  const { namespace } = fixture;
  const adminSession = await fixture.signIn();

  // About 100 KB: over the general 64 KiB limit, inside the 448 KiB provisioning limit.
  const values = notes("n".repeat(100 * 1024));
  assert.equal(await driverAccepts(values), true);
  const created = await fixture.request("POST", collection(namespace.id), {
    body: { kind: "agent", values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 500));
  assert.deepEqual(created.data.values, values);
  // The console's Slack editor saves the whole Configuration back.
  const resaved = notes(`${"n".repeat(100 * 1024)} edited`);
  const updated = await fixture.request("PATCH", configurationPath(namespace.id, created.data.id), {
    body: { values: resaved },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body).slice(0, 500));
  assert.equal(updated.data.generation, 2);
  assert.deepEqual(updated.data.values, resaved);

  // Just under the Driver's 1 MiB, written with six-byte escapes for every character (legal
  // JSON a client may send): about 6 MiB on the wire.
  const largest = notes("x".repeat(1024 * 1024 - 128));
  assert.equal(await driverAccepts(largest), true);
  assert.equal(await driverAccepts(notes("x".repeat(1024 * 1024))), false);
  const escaped = (body) => JSON.stringify(body).replaceAll("x", String.raw`\u0078`);
  const createBody = escaped({ kind: "agent", values: largest });
  assert.ok(Buffer.byteLength(createBody) > 6 * 1024 * 1024 - 1024);
  const createdLargest = await sendRaw(
    fixture,
    "POST",
    collection(namespace.id),
    createBody,
    adminSession,
  );
  assert.equal(createdLargest.status, 201, JSON.stringify(createdLargest.body).slice(0, 500));
  assert.deepEqual(createdLargest.body.data.values, largest);
  const updatedLargest = await sendRaw(
    fixture,
    "PATCH",
    configurationPath(namespace.id, created.data.id),
    escaped({ values: largest }),
    adminSession,
  );
  assert.equal(updatedLargest.status, 200, JSON.stringify(updatedLargest.body).slice(0, 500));
  assert.deepEqual(updatedLargest.body.data.values, largest);

  // One byte over the route limit is still refused before the body is parsed.
  const padding = (body) =>
    body + " ".repeat(CONFIGURATION_BODY_LIMIT + 1 - Buffer.byteLength(body));
  for (const [method, path, body] of [
    ["POST", collection(namespace.id), JSON.stringify({ kind: "agent", values: notes("x") })],
    [
      "PATCH",
      configurationPath(namespace.id, created.data.id),
      JSON.stringify({ values: notes("x") }),
    ],
  ]) {
    const oversized = await sendRaw(fixture, method, path, padding(body), adminSession);
    assert.equal(oversized.status, 413, `${method}: ${JSON.stringify(oversized.body)}`);
    assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE", method);
  }
  const stored = await fixture.request("GET", configurationPath(namespace.id, created.data.id));
  assert.equal(stored.data.generation, 3);
});

test("Configuration writes refuse a caller without the grant before reading the body", async (t) => {
  const fixture = await createFixture(t);
  const { namespace } = fixture;
  const existing = await fixture.createConfiguration(namespace.id, notes("existing"));
  const member = await fixture.createAccountWithPolicy("configuration-member", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "pre-body-configuration-reader",
      bindingId: "pre-body-read-configurations",
      namespaceId: namespace.id,
      permissions: { namespace: ["read"], configuration: ["read"] },
    });
  });
  const memberId = member.principal.id;
  const session = await fixture.signIn(member.credentials);
  // Over the general 64 KiB limit and under the Configuration route limit.
  const declaredBytes = 6 * 1024 * 1024;
  const forbidden = {
    code: "FORBIDDEN",
    message: "The exact platform operation was not authorized.",
  };
  for (const [method, path, action, grant, targetId] of [
    ["POST", collection(namespace.id), "openclaw.configurations.create", "create", namespace.id],
    [
      "PATCH",
      configurationPath(namespace.id, existing.id),
      "openclaw.configurations.update",
      "update",
      existing.id,
    ],
  ]) {
    const target = { kind: "configuration", id: targetId, namespaceId: namespace.id };
    const small = await fixture.request(method, path, {
      session,
      body: method === "POST" ? { kind: "agent", values: {} } : { values: {} },
    });
    assert.equal(small.status, 403, `${method}: ${JSON.stringify(small.body)}`);
    assert.deepEqual(small.body.error, forbidden, method);
    const denials = () =>
      fixture.audit.events.filter(
        (event) =>
          event.kind === "authorization_denial" &&
          event.actor?.principalId === memberId &&
          event.action === action,
      );
    const before = denials().length;
    const refused = await partialWrite(fixture, method, path, session, declaredBytes);
    assert.notEqual(refused, null, `${method}: the controller waited for the unread body`);
    assert.equal(refused.status, 403, `${method}: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(refused.body.error, forbidden, method);
    // The refusal keeps its audit row, naming the exact grant the write itself checks.
    const recorded = denials().slice(before);
    assert.equal(recorded.length, 1, method);
    assert.equal(recorded[0].reasonCode, "AUTHORIZATION_DENIED", method);
    assert.deepEqual(recorded[0].resource, target, method);
    assert.deepEqual(
      recorded[0].authorization,
      { principalId: memberId, action: grant, resource: target },
      method,
    );
  }
  const unchanged = await fixture.request("GET", configurationPath(namespace.id, existing.id));
  assert.deepEqual(unchanged.data, existing);
});

test("Configuration writes check the grant again in their transaction after the pre-body check", async (t) => {
  const fixture = await createFixture(t);
  const { namespace } = fixture;
  const existing = await fixture.createConfiguration(namespace.id, notes("existing"));
  let writer;
  const member = await fixture.createAccountWithPolicy("configuration-writer", (principal) => {
    ({ binding: writer } = grantRole(fixture.policy, principal.id, {
      id: "re-check-configuration-writer",
      bindingId: "re-check-write-configurations",
      namespaceId: namespace.id,
      permissions: { namespace: ["read"], configuration: ["read", "create", "update"] },
    }));
  });
  const session = await fixture.signIn(member.credentials);
  // The grant is withdrawn right after the pre-body check passes, before the handler runs.
  const occ = fixture.controller;
  const preBodyCheck = occ.authorizeConfigurationWrite;
  let checks = 0;
  occ.authorizeConfigurationWrite = async (...args) => {
    await preBodyCheck.apply(occ, args);
    checks += 1;
    const index = fixture.policy.bindings.indexOf(writer);
    assert.notEqual(index, -1);
    fixture.policy.bindings.splice(index, 1);
  };
  t.after(() => delete occ.authorizeConfigurationWrite);
  for (const [method, path, body] of [
    ["POST", collection(namespace.id), { kind: "agent", values: notes("withdrawn") }],
    ["PATCH", configurationPath(namespace.id, existing.id), { values: notes("withdrawn") }],
  ]) {
    const refused = await fixture.request(method, path, { session, body });
    assert.equal(refused.status, 403, `${method}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error.code, "FORBIDDEN", method);
    assert.equal(fixture.policy.bindings.includes(writer), false, method);
    fixture.policy.bindings.push(writer);
  }
  assert.equal(checks, 2);
  const unchanged = await fixture.request("GET", configurationPath(namespace.id, existing.id));
  assert.deepEqual(unchanged.data, existing);
});
