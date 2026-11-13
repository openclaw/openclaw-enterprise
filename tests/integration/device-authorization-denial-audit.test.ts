import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import type { AuditEvent, ResourceRef } from "../../packages/contracts/src/index.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  createDeviceCredentialDrivers,
  DEVICE_ACCESS_TOKEN,
  DEVICE_ACCOUNT_ID,
} from "../helpers/device-credential-gateway.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { bindRole, grantRole } from "../helpers/iam-grants.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";

const reasonCode = "DEVICE_AUTHORIZATION_SCOPE_MISMATCH";
const genericNotFound = {
  code: "NOT_FOUND",
  message: "The requested platform resource was not found.",
};

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type Session = Awaited<ReturnType<ConsoleFixture["signIn"]>>;
type Operation = "poll" | "cancel";
type HttpResult = { status: number; body: unknown; headers: Headers };
type Login = { id: string; userCode: string };
type Target = { path: string; agentId?: string };
type Refusal = {
  label: string;
  login: Login;
  target: Target;
  actorId: string;
  session?: Session;
};

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function responseRequestId(response: HttpResult): string {
  const requestId = string(object(object(response.body).meta).requestId);
  assert.equal(response.headers.get("x-request-id"), requestId);
  return requestId;
}

function withoutRequestId(response: HttpResult): unknown {
  const body = object(response.body);
  const { requestId: _requestId, ...meta } = object(body.meta);
  return { ...body, meta };
}

function assertPublicOnly(value: unknown, excluded: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const item of excluded) {
    assert.equal(serialized.includes(item), false, "denial disclosed private session data");
  }
}

class DenialAuditSink extends InMemoryAuditSink {
  failing = false;
  attempts = 0;

  override async append(event: AuditEvent): Promise<void> {
    if (this.failing && event.kind === "authorization_denial") {
      this.attempts++;
      throw new Error("Test audit sink unavailable.");
    }
    await super.append(event);
  }
}

async function createFixture(t: TestContext) {
  const auditSink = new DenialAuditSink();
  const clock = createControlledClock();
  const secretDriver = createTestSecretDriver();
  const { gateway, refresh } = createDeviceCredentialDrivers({
    now: () => clock.wallNow(),
    approve: async () => false,
  });
  const fixture = await createConsoleAppFixture(t, {
    auditSink,
    secretDriver,
    credentialGatewayDriver: gateway,
    now: () => new Date(clock.wallNow()),
    // Admission-only Sandbox: the real Controller still creates and validates the Agents.
    sandboxDriver: {
      id: "device-denial-admission",
      capability: "sandbox",
      implementation: "test-admission-only",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking", "filesystem", "process"],
      async cleanup() {},
    },
  });
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Device denial audit", { ready: true });
  const controller = fixture.controller;
  assert.ok(controller);
  controller.registerDriver(gateway);
  controller.selectDriver("credential_gateway", gateway.id);
  controller.registerDriver(refresh);
  controller.selectDriver("credential_refresh", refresh.id);
  const basePath = `/namespaces/${namespace.id}/agents`;
  const unsaved: Target = { path: `${basePath}/device-authorizations` };
  async function savedTarget(name: string): Promise<Target> {
    const agent = await fixture.createAgent(
      namespace.id,
      name,
      createHarnessConfiguration("codex", "gpt-5.1"),
      { executionMode: "dedicated", harnessAuth: null },
    );
    return { path: `${basePath}/${agent.id}/device-authorizations`, agentId: agent.id };
  }
  async function start(target: Target): Promise<Login> {
    const response = await fixture.request("POST", target.path, {
      headers: { "content-type": "application/json" },
      body: { harnessId: "codex" },
    });
    assert.equal(response.status, 200);
    const data = object(response.data);
    assert.equal(data.status, "pending");
    return { id: string(object(data.session).id), userCode: string(data.userCode) };
  }
  async function send(operation: Operation, item: Refusal): Promise<HttpResult> {
    const path = `${item.target.path}/${item.login.id}`;
    const session = item.session === undefined ? {} : { session: item.session };
    return operation === "poll"
      ? fixture.request("POST", `${path}/poll`, {
          ...session,
          headers: { "content-type": "application/json" },
          body: {},
        })
      : fixture.request("DELETE", path, session);
  }
  async function snapshot(login: Login) {
    return controller.transact(async (unit: PlatformUnitOfWork) => {
      const secret = await unit.secrets.findSecret(namespace.id, login.id);
      assert.ok(secret, "the actual start must own a Secret");
      const bytes = secretDriver.valueFor(secret);
      assert.ok(bytes);
      const session = object(JSON.parse(bytes));
      const sourceId = string(session.sourceId);
      const source = await unit.credentialSources.findCredentialSource(namespace.id, sourceId);
      assert.ok(source, "the actual start must own a source");
      return { secret, bytes, session, source };
    });
  }
  const resource = (target: Target): ResourceRef => ({
    kind: "agent",
    id: target.agentId ?? namespace.id,
    namespaceId: namespace.id,
  });
  return {
    ...fixture,
    controller,
    installation,
    namespace,
    auditSink,
    clock,
    secretDriver,
    gateway,
    unsaved,
    savedTarget,
    start,
    send,
    snapshot,
    resource,
  };
}

test("device login binding denials retain generic 404 and attributable fail-closed audit", async (t) => {
  const originalFetch = globalThis.fetch;
  const loopbackFetch: typeof fetch = (input, options) => {
    const address = new URL(input instanceof Request ? input.url : input.toString());
    assert.ok(
      ["127.0.0.1", "[::1]", "localhost"].includes(address.hostname),
      "the component proof must not contact a provider",
    );
    return originalFetch(input, options);
  };
  t.mock.method(globalThis, "fetch", loopbackFetch);
  const fixture = await createFixture(t);
  const owner = fixture.principal.id;
  const saved = await fixture.savedTarget("Saved login owner");
  const otherAgent = await fixture.savedTarget("Different existing Agent");
  const unsavedLogin = await fixture.start(fixture.unsaved);
  const savedLogin = await fixture.start(saved);
  const controlLogin = await fixture.start(fixture.unsaved);

  const other = await fixture.createAccountWithPolicy("device-denial-caller", () => {});
  const otherSession = await fixture.signIn(other.credentials);
  const targets = [fixture.unsaved, saved, otherAgent];
  const role = grantRole(fixture.policy, other.principal.id, {
    id: "device-denial-exact-operations",
    namespaceId: undefined,
    permissions: {
      agent: ["create", "read", "update"],
      secret: ["operate"],
      credential_source: ["operate"],
    },
    resource: { kind: "agent", id: fixture.namespace.id },
  });
  for (const target of targets.slice(1)) {
    bindRole(fixture.policy, other.principal.id, {
      id: `device-denial-agent-${target.agentId}`,
      roleId: role.role.id,
      namespaceId: fixture.namespace.id,
      resource: { kind: "agent", id: target.agentId },
    });
  }
  for (const login of [unsavedLogin, savedLogin]) {
    const stored = await fixture.snapshot(login);
    for (const resource of [
      { kind: "secret", id: login.id },
      { kind: "credential_source", id: string(stored.session.sourceId) },
    ]) {
      bindRole(fixture.policy, other.principal.id, {
        id: `device-denial-${resource.id}`,
        roleId: role.role.id,
        namespaceId: fixture.namespace.id,
        resource,
      });
    }
  }

  const control: Refusal = {
    label: "authorized owner",
    login: controlLogin,
    target: fixture.unsaved,
    actorId: owner,
  };
  const beforeEarly = fixture.gateway.operations.length;
  const early = await fixture.send("poll", control);
  assert.equal(early.status, 200);
  assert.equal(object(object(early.body).data).status, "pending");
  assert.equal(fixture.gateway.operations.length, beforeEarly);
  await fixture.clock.advance(5000);
  const due = await fixture.send("poll", control);
  assert.equal(due.status, 200);
  assert.equal(object(object(due.body).data).status, "pending");
  assert.deepEqual(fixture.gateway.operations.slice(beforeEarly), ["pollDeviceAuthorization"]);

  const member = await fixture.createNamespaceMember("device-denial-member", fixture.namespace.id, [
    ["read", "namespace"],
  ]);
  const memberSession = await fixture.signIn(member.credentials);
  const ordinary: Refusal = { ...control, actorId: member.principal.id, session: memberSession };
  const beforeOrdinary = fixture.gateway.operations.length;
  const forbidden = await fixture.send("poll", ordinary);
  assert.equal(forbidden.status, 403);
  assert.equal(object(object(forbidden.body).error).code, "FORBIDDEN");
  const ordinaryEvents = fixture.auditSink.events.filter(
    (event) => event.requestId === responseRequestId(forbidden),
  );
  assert.equal(ordinaryEvents.length, 1);
  const ordinaryEvent = ordinaryEvents[0];
  assert.ok(ordinaryEvent);
  assert.equal(ordinaryEvent.kind, "authorization_denial");
  assert.equal(ordinaryEvent.outcome, "denied");
  assert.equal(ordinaryEvent.actorId, member.principal.id);
  assert.deepEqual(ordinaryEvent.authorization, {
    principalId: member.principal.id,
    action: "create",
    resource: fixture.resource(fixture.unsaved),
  });
  assert.equal(fixture.gateway.operations.length, beforeOrdinary);

  // The real sink's ordinary IAM failure proves the seam before the new binding path uses it.
  fixture.auditSink.failing = true;
  const ordinaryUnavailable = await fixture.send("poll", ordinary);
  fixture.auditSink.failing = false;
  assert.equal(ordinaryUnavailable.status, 503);
  assert.equal(object(object(ordinaryUnavailable.body).error).code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(fixture.auditSink.attempts, 1);
  assert.equal(fixture.gateway.operations.length, beforeOrdinary);

  const cases: Refusal[] = [
    {
      label: "other actor unsaved",
      login: unsavedLogin,
      target: fixture.unsaved,
      actorId: other.principal.id,
      session: otherSession,
    },
    {
      label: "other actor saved",
      login: savedLogin,
      target: saved,
      actorId: other.principal.id,
      session: otherSession,
    },
    { label: "unsaved handle on saved route", login: unsavedLogin, target: saved, actorId: owner },
    {
      label: "saved handle on unsaved route",
      login: savedLogin,
      target: fixture.unsaved,
      actorId: owner,
    },
    { label: "different existing Agent", login: savedLogin, target: otherAgent, actorId: owner },
  ];
  const observed: { item: Refusal; operation: Operation; requestId: string; excluded: string[] }[] =
    [];
  for (const item of cases) {
    for (const operation of ["poll", "cancel"] as const) {
      const before = await fixture.snapshot(item.login);
      assert.equal(before.session.phase, "pending");
      assert.ok(Date.parse(string(before.session.nextPollAt)) <= fixture.clock.wallNow());
      assert.ok(Date.parse(string(before.session.expiresAt)) > fixture.clock.wallNow());
      const operations = fixture.gateway.operations.length;
      const secretWrites = fixture.secretDriver.calls.filter(
        (call) => call.operation !== "withValue" && call.operation !== "resolve",
      ).length;
      const absent = await fixture.send(operation, {
        label: "absent handle",
        target: item.target,
        actorId: owner,
        login: { id: `sec_${randomUUID()}`, userCode: "unused" },
      });
      assert.equal(absent.status, 404);
      assert.deepEqual(object(absent.body).error, genericNotFound);
      const response = await fixture.send(operation, item);
      assert.equal(response.status, 404, item.label);
      assert.deepEqual(withoutRequestId(response), withoutRequestId(absent));
      assert.ok(
        isDeepStrictEqual(await fixture.snapshot(item.login), before),
        "binding refusal changed the saved session or source",
      );
      assert.equal(
        fixture.secretDriver.calls.filter(
          (call) => call.operation !== "withValue" && call.operation !== "resolve",
        ).length,
        secretWrites,
        "binding refusal wrote Secret state",
      );
      assert.equal(
        fixture.gateway.operations.length,
        operations,
        "binding refusal reached an external service",
      );
      const requestId = responseRequestId(response);
      const rows = fixture.auditSink.events.filter((event) => event.requestId === requestId);
      assert.equal(
        rows.some((event) => event.kind === "mutation" && event.outcome === "success"),
        false,
      );
      const excluded = [
        item.login.id,
        item.login.userCode,
        string(before.session.privateState),
        string(before.session.sourceId),
        before.bytes,
        DEVICE_ACCESS_TOKEN,
        DEVICE_ACCOUNT_ID,
        ...(item.actorId === owner ? [] : [owner]),
        ...(before.session.agentId === item.target.agentId || before.session.agentId === undefined
          ? []
          : [string(before.session.agentId)]),
      ];
      assertPublicOnly([response.body, rows], excluded);
      observed.push({ item, operation, requestId, excluded });
    }
  }

  // All ten denials have passed the HTTP, ownership, storage, and no-I/O oracles above.
  // The pre-fix regression fails here, specifically because the attributable row is absent.
  for (const { item, operation, requestId, excluded } of observed) {
    const rows = fixture.auditSink.events.filter((event) => event.requestId === requestId);
    assert.equal(rows.length, 1, `missing binding-denial audit: ${item.label} ${operation}`);
    const event = rows[0];
    assert.ok(event);
    assert.equal(event.kind, "authorization_denial");
    assert.equal(event.outcome, "denied");
    assert.equal(event.reasonCode, reasonCode);
    assert.equal(event.action, `openclaw.agents.device_authorization.${operation}`);
    assert.equal(event.actorId, item.actorId);
    assert.equal(event.actor?.principalId, item.actorId);
    assert.equal(event.installationId, fixture.installation.id);
    assert.equal(event.namespaceId, fixture.namespace.id);
    assert.ok(event.admissionDecisionId);
    assert.equal(event.iamDriverId, fixture.iamDriver.id);
    assert.deepEqual(event.resource, fixture.resource(item.target));
    assert.deepEqual(event.authorization, {
      principalId: item.actorId,
      action: item.target.agentId === undefined ? "create" : "update",
      resource: fixture.resource(item.target),
    });
    assertPublicOnly(event, excluded);
  }

  // On the repaired producer, failure to append this exact denial must fail closed too.
  const item = cases[0];
  assert.ok(item);
  const beforeFailure = await fixture.snapshot(item.login);
  const beforeEffects = fixture.gateway.operations.length;
  const beforeAttempts = fixture.auditSink.attempts;
  fixture.auditSink.failing = true;
  const unavailable = await fixture.send("poll", item);
  fixture.auditSink.failing = false;
  assert.equal(unavailable.status, 503);
  assert.equal(object(object(unavailable.body).error).code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(fixture.auditSink.attempts, beforeAttempts + 1);
  assert.equal(fixture.gateway.operations.length, beforeEffects);
  assert.ok(isDeepStrictEqual(await fixture.snapshot(item.login), beforeFailure));
  assertPublicOnly(unavailable.body, observed[0]!.excluded);
});
