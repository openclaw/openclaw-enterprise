import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import {
  ErrorResponse,
  type CreateConfigurationBody,
  type UpdateConfigurationBody,
} from "../../packages/contracts/src/api/common.ts";
import { ConfigurationResponse } from "../../packages/contracts/src/api/resources.ts";
import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  PermissionAction,
  ResourceRef,
} from "../../packages/contracts/src/index.ts";
import { ConfigurationSizeError } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import {
  assertWriteAuthorizationDenial,
  partialWrite,
} from "../helpers/partial-write-authorization.mjs";
import { callerDenied, createDenied } from "../helpers/refusal-text.mjs";

// The Configuration write limit: the Kubernetes Driver's 1 MiB of values and a 32 KiB envelope,
// all written with six-byte JSON escapes.
const CONFIGURATION_VALUES_LIMIT = 1024 * 1024;
const CONFIGURATION_BODY_LIMIT = 6 * (CONFIGURATION_VALUES_LIMIT + 32 * 1024);
type WriteMethod = "POST" | "PATCH";
const collection = (namespaceId: string) => `/namespaces/${namespaceId}/configurations`;
const configurationPath = (namespaceId: string, configurationId: string) =>
  `${collection(namespaceId)}/${configurationId}`;
const notes = (text: OpenClawConfigurationValue): OpenClawConfigurationDocument => ({
  plugins: { entries: { knowledge: { enabled: true, config: { notes: text } } } },
});
function createFixture(t: TestContext) {
  return createReadyConsoleNamespace(t, "Configuration body limits", { providers: [] });
}

type Fixture = Awaited<ReturnType<typeof createFixture>>["fixture"];
type Session = string | { cookie: string; origin?: string | undefined };

// Sends `text` as the exact request body, without re-encoding it.
async function sendRaw(
  fixture: Fixture,
  method: WriteMethod,
  path: string,
  text: string,
  session: Session,
): Promise<{ status: number; body: unknown }> {
  const response = await fixture.fetch(
    new Request(new URL(path, fixture.origin), {
      method,
      headers: {
        ...authenticatedHeaders(session, { origin: fixture.origin }),
        "content-type": "application/json",
      },
      body: text,
      signal: AbortSignal.timeout(30_000),
    }),
  );
  const body: unknown = await response.json();
  return { status: response.status, body };
}

test("Configuration writes admit every Configuration the Kubernetes Driver stores", async (t) => {
  const { fixture, namespace } = await createFixture(t);
  const adminSession = await fixture.signIn();

  // About 100 KB: over the general 64 KiB limit, inside the 448 KiB provisioning limit.
  const values = notes("n".repeat(100 * 1024));
  const driver = new KubernetesConfigurationDriver({ authentication: { mode: "inCluster" } });
  await driver.validateValues(values);
  const created = await fixture.request("POST", collection(namespace.id), {
    body: { kind: "agent", values } satisfies CreateConfigurationBody,
  });
  const configuration = fixture.fixtureResponse(
    created,
    201,
    ConfigurationResponse,
    "create Configuration",
  ).data;
  const path = configurationPath(namespace.id, configuration.id);
  assert.deepEqual(configuration.values, values);
  // The console's Slack editor saves the whole Configuration back.
  const resaved = notes(`${"n".repeat(100 * 1024)} edited`);
  const updated = await fixture.request("PATCH", path, {
    body: { values: resaved } satisfies UpdateConfigurationBody,
  });
  const updatedConfiguration = fixture.fixtureResponse(
    updated,
    200,
    ConfigurationResponse,
    "update Configuration",
  ).data;
  assert.equal(updatedConfiguration.generation, 2);
  assert.deepEqual(updatedConfiguration.values, resaved);

  // Just under the Driver's 1 MiB, written with six-byte escapes for every character (legal
  // JSON a client may send): about 6 MiB on the wire.
  const notesBytes = CONFIGURATION_VALUES_LIMIT - Buffer.byteLength(JSON.stringify(notes("")));
  const largest = notes("x".repeat(notesBytes - 1));
  await driver.validateValues(largest);
  await assert.rejects(
    driver.validateValues(notes("x".repeat(notesBytes))),
    (error: unknown) =>
      error instanceof ConfigurationSizeError && error.limitBytes === CONFIGURATION_VALUES_LIMIT,
  );
  const escaped = (body: CreateConfigurationBody | UpdateConfigurationBody) =>
    JSON.stringify(body).replaceAll("x", String.raw`\u0078`);
  const createBody = escaped({ kind: "agent", values: largest });
  assert.ok(Buffer.byteLength(createBody) > 6 * 1024 * 1024 - 1024);
  const createdLargest = await sendRaw(
    fixture,
    "POST",
    collection(namespace.id),
    createBody,
    adminSession,
  );
  assert.deepEqual(
    fixture.fixtureResponse(
      createdLargest,
      201,
      ConfigurationResponse,
      "create escaped Configuration",
    ).data.values,
    largest,
  );
  const updatedLargest = await sendRaw(
    fixture,
    "PATCH",
    path,
    escaped({ values: largest }),
    adminSession,
  );
  assert.deepEqual(
    fixture.fixtureResponse(
      updatedLargest,
      200,
      ConfigurationResponse,
      "update escaped Configuration",
    ).data.values,
    largest,
  );

  // One byte over the route limit is still refused before the body is parsed.
  const padding = (body: string) =>
    body + " ".repeat(CONFIGURATION_BODY_LIMIT + 1 - Buffer.byteLength(body));
  for (const [method, requestPath, body] of [
    ["POST", collection(namespace.id), JSON.stringify({ kind: "agent", values: notes("x") })],
    ["PATCH", path, JSON.stringify({ values: notes("x") })],
  ] satisfies [WriteMethod, string, string][]) {
    const oversized = await sendRaw(fixture, method, requestPath, padding(body), adminSession);
    assert.equal(
      fixture.fixtureResponse(oversized, 413, ErrorResponse, method).error.code,
      "PAYLOAD_TOO_LARGE",
    );
  }
  const stored = await fixture.request("GET", path);
  assert.equal(
    fixture.fixtureResponse(stored, 200, ConfigurationResponse, "read Configuration").data
      .generation,
    3,
  );
});

test("Configuration writes refuse a serialized wide body without changing stored state", async (t) => {
  const { fixture, namespace } = await createFixture(t);
  const existing = await fixture.createConfiguration(namespace.id, notes("retained"));
  const session = await fixture.signIn();
  const values = notes(["\u0000", ...Array.from({ length: 100_000 }, () => 0), "\ud800"]);
  const text = JSON.stringify({ values });
  assert.ok(Buffer.byteLength(text) < CONFIGURATION_BODY_LIMIT);

  // The first array value is invalid. The later surrogate must not replace its detail, and the
  // ordinary serialized HTTP path must refuse before the Configuration generation changes.
  const refused = await sendRaw(
    fixture,
    "PATCH",
    configurationPath(namespace.id, existing.id),
    text,
    session,
  );
  const { error } = fixture.fixtureResponse(
    refused,
    400,
    ErrorResponse,
    "refuse wide Configuration",
  );
  assert.equal(error.code, "INVALID_REQUEST");
  assert.deepEqual(error.details, [
    { path: "/values/plugins/entries/knowledge/config/notes/0", code: "INVALID_FORMAT" },
  ]);
  const unchanged = await fixture.request("GET", configurationPath(namespace.id, existing.id));
  assert.deepEqual(
    fixture.fixtureResponse(unchanged, 200, ConfigurationResponse, "read unchanged Configuration")
      .data,
    existing,
  );
});

test("Configuration writes refuse a caller without the grant before reading the body", async (t) => {
  const { fixture, namespace } = await createFixture(t);
  const existing = await fixture.createConfiguration(namespace.id, notes("existing"));
  const member = await fixture.createNamespaceMember("configuration-member", namespace.id, [
    ["read", "namespace"],
    ["read", "configuration"],
  ]);
  const session = await fixture.signIn(member.credentials);
  const address = fixture.app.server.address();
  assert.ok(address !== null && typeof address === "object", "the Controller listens on TCP");
  const transportOrigin = `http://127.0.0.1:${address.port}`;
  // Over the general 64 KiB limit and under the Configuration route limit.
  const declaredBytes = 6 * 1024 * 1024;
  // Each refusal names the grant it checked, the same before and after the body arrives.
  const forbidden = {
    POST: { code: "FORBIDDEN", message: createDenied("Configuration", namespace.id) },
    PATCH: {
      code: "FORBIDDEN",
      message: callerDenied("Configuration update", `Configuration ${existing.id}`),
    },
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
  ] satisfies [WriteMethod, string, string, PermissionAction, string][]) {
    const target: ResourceRef = { kind: "configuration", id: targetId, namespaceId: namespace.id };
    const small = await fixture.request(method, path, {
      session,
      body: method === "POST" ? { kind: "agent", values: {} } : { values: {} },
    });
    assert.deepEqual(
      fixture.fixtureResponse(small, 403, ErrorResponse, method).error,
      forbidden[method],
    );
    const auditStart = fixture.auditSink.events.length;
    const refused: unknown = await partialWrite({
      origin: fixture.origin,
      transportOrigin,
      method,
      path,
      session,
      declaredBytes,
      bodyPrefix: '{"kind":"agent","values":{"notes":"',
    });
    assert.notEqual(refused, null, `${method}: the controller waited for the unread body`);
    assert.ok(
      typeof refused === "object" &&
        refused !== null &&
        "status" in refused &&
        typeof refused.status === "number" &&
        "body" in refused,
      `${method}: expected a response on the unfinished socket`,
    );
    assert.deepEqual(
      fixture.fixtureResponse(
        { status: refused.status, body: refused.body },
        403,
        ErrorResponse,
        method,
      ).error,
      forbidden[method],
    );
    // The refusal keeps its audit row, naming the exact grant the write itself checks.
    assertWriteAuthorizationDenial(
      fixture.auditSink.events.slice(auditStart),
      { principalId: member.principal.id, action, grant, resource: target },
      method,
    );
  }
  const unchanged = await fixture.request("GET", configurationPath(namespace.id, existing.id), {
    session,
  });
  assert.deepEqual(
    fixture.fixtureResponse(unchanged, 200, ConfigurationResponse, "read unchanged Configuration")
      .data,
    existing,
  );
});

test("Configuration writes check the grant again in their transaction after the pre-body check", async (t) => {
  const { fixture, namespace } = await createFixture(t);
  const existing = await fixture.createConfiguration(namespace.id, notes("existing"));
  const label = "configuration-writer";
  const member = await fixture.createNamespaceMember(label, namespace.id, [
    ["read", "namespace"],
    ["read", "configuration"],
    ["create", "configuration"],
    ["update", "configuration"],
  ]);
  const writer = fixture.policy.bindings.find(({ id }) => id === `binding-${label}`);
  assert.ok(writer, "the fixture installed the writer's binding");
  const session = await fixture.signIn(member.credentials);
  // The grant is withdrawn right after the pre-body check passes, before the handler runs.
  const occ = fixture.controller;
  const preBodyCheck = occ.authorizeConfigurationWrite;
  const check = t.mock.method(
    occ,
    "authorizeConfigurationWrite",
    async (...args: Parameters<typeof preBodyCheck>) => {
      await preBodyCheck.apply(occ, args);
      const index = fixture.policy.bindings.indexOf(writer);
      assert.notEqual(index, -1);
      fixture.policy.bindings.splice(index, 1);
    },
  );
  for (const [method, path, body] of [
    ["POST", collection(namespace.id), { kind: "agent", values: notes("withdrawn") }],
    ["PATCH", configurationPath(namespace.id, existing.id), { values: notes("withdrawn") }],
  ] satisfies [WriteMethod, string, CreateConfigurationBody | UpdateConfigurationBody][]) {
    const refused = await fixture.request(method, path, { session, body });
    assert.equal(
      fixture.fixtureResponse(refused, 403, ErrorResponse, method).error.code,
      "FORBIDDEN",
    );
    assert.equal(fixture.policy.bindings.includes(writer), false, method);
    fixture.policy.bindings.push(writer);
  }
  assert.equal(check.mock.callCount(), 2);
  const unchanged = await fixture.request("GET", configurationPath(namespace.id, existing.id), {
    session,
  });
  assert.deepEqual(
    fixture.fixtureResponse(unchanged, 200, ConfigurationResponse, "read unchanged Configuration")
      .data,
    existing,
  );
});
