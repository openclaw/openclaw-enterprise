import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInWithEmailPassword,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { injectJson } from "../helpers/inject-json.mjs";
import { listen } from "../helpers/listen.mjs";

const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const allowedNamespace = "ns_00000000-0000-4000-8000-000000000001";
const deniedNamespace = "ns_00000000-0000-4000-8000-000000000002";

test("the singleton Namespace HTTP route enforces internal admission and exact IAM", async (t) => {
  const authFixture = await createTestAuthPrincipal({
    installationId,
    mode: "production",
    baseURL: "http://127.0.0.1",
    email: "production-security-admin@example.test",
    password: "production-security-generated-password",
  });
  const principal = authFixture.seed.principal;

  // Give the admitted Principal access to exactly one tenant, not its neighboring Namespace.
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [principal],
      groups: [],
      memberships: [],
      roles: [
        {
          id: "role-production-namespace-reader",
          namespaceId: allowedNamespace,
          permissions: [{ action: "read", resourceKind: "namespace" }],
        },
      ],
      bindings: [
        {
          id: "binding-production-namespace-reader",
          namespaceId: allowedNamespace,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: "role-production-namespace-reader",
        },
      ],
      restrictions: [],
    }),
  });
  const auditSink = new InMemoryAuditSink();
  const controller = new OpenClawController(
    {
      id: installationId,
      name: "Production authorization integration",
      createdAt: "2026-08-19T00:00:00.000Z",
    },
    { state: new InMemoryPlatformState({ auditSink }) },
  );
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  // Persist both real tenants so authorization is enforced by OCC, not a test-only route filter.
  await controller.transact(async (state) => {
    for (const [id, name] of [
      [allowedNamespace, "Allowed tenant"],
      [deniedNamespace, "Denied tenant"],
    ]) {
      await state.namespaces.createNamespace({
        id,
        name,
        status: "ready",
        createdAt: "2026-08-19T00:00:00.000Z",
      });
    }
  });

  // Exercise the actual registered Fastify route and production admission pipeline over HTTP.
  const app = createFastifyApp({
    controller,
    iamDriver: iam,
    resolveHarness: resolveApprovedProductionHarness,
    auditSink,
    development: {
      enabled: false,
      installationId,
    },
    auth: authFixture.auth,
  });
  t.after(async () => app.close());
  const endpoint = await app.listen({ port: 0, host: "127.0.0.1" });

  await assert.rejects(
    signInWithEmailPassword({
      origin: endpoint,
      email: authFixture.email,
      password: "wrong-production-security-password",
    }),
    /HTTP 401/,
  );
  const session = await signInWithEmailPassword({
    origin: endpoint,
    email: authFixture.email,
    password: authFixture.password,
  });

  // Missing sessions and legacy bearer credentials must fail closed.
  for (const headers of [
    {},
    { authorization: "Bearer wrong" },
    { authorization: "Basic no-longer-supported" },
  ]) {
    const response = await fetch(`${endpoint}/namespaces/${allowedNamespace}`, {
      headers,
    });
    assert.equal(response.status, 401);
  }

  // Authentication does not grant the Principal access to a neighboring Namespace.
  const forbidden = await fetch(`${endpoint}/namespaces/${deniedNamespace}`, {
    headers: authenticatedHeaders(session),
  });
  assert.equal(forbidden.status, 403);

  // Even an otherwise valid internal request must not trust forwarded client identity.
  const forwarded = await fetch(`${endpoint}/namespaces/${allowedNamespace}`, {
    headers: authenticatedHeaders(session, { "x-forwarded-for": "127.0.0.1" }),
  });
  assert.equal(forwarded.status, 403);

  // The authorized request reaches the real controller and returns its exact Namespace.
  const allowed = await fetch(`${endpoint}/namespaces/${allowedNamespace}`, {
    headers: authenticatedHeaders(session),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).data, {
    id: allowedNamespace,
    name: "Allowed tenant",
    status: "ready",
    createdAt: "2026-08-19T00:00:00.000Z",
  });
});

test("IAM decision reasons must be strings before an installation-admin read", async (t) => {
  const authFixture = await createTestAuthPrincipal({
    installationId,
    mode: "production",
    baseURL: "http://127.0.0.1",
  });
  let restrictions = [];
  const native = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [authFixture.seed.principal],
      groups: [],
      memberships: [],
      roles: authFixture.seed.roles,
      bindings: authFixture.seed.bindings,
      restrictions,
    }),
  });
  let transform = (decision) => decision;
  const iam = {
    id: native.id,
    capability: native.capability,
    implementation: native.implementation,
    lookupIdentity: (input) => native.lookupIdentity(input),
    authorize: async (request) => transform(await native.authorize(request)),
  };
  const controller = new OpenClawController({
    id: installationId,
    name: "Decision validation",
    createdAt: "2026-08-19T00:00:00.000Z",
  });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  let protectedReads = 0;
  const app = createFastifyApp({
    controller,
    iamDriver: iam,
    auditSink: new InMemoryAuditSink(),
    development: { enabled: false, installationId },
    auth: authFixture.auth,
    get observabilityUrl() {
      protectedReads += 1;
      return "https://metrics.example.test";
    },
  });
  t.after(() => app.close());
  const session = await signInToControllerApp(app, authFixture);
  const read = () =>
    injectJson(app, "GET", "/observability", { session, remoteAddress: "127.0.0.1" });

  for (const [name, reason] of [
    ["omitted", undefined],
    ["null", null],
    ["number", 42],
    ["object", {}],
  ]) {
    await t.test(name, async () => {
      transform = (decision) => {
        const result = { ...decision, reason };
        if (reason === undefined) {
          delete result.reason;
        }
        return result;
      };
      const before = protectedReads;
      const response = await read();
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(
        protectedReads,
        before,
        "a malformed decision must not read the protected setting",
      );
    });
  }
  for (const reason of ["Allowed by the selected IAM Driver.", ""]) {
    await t.test(reason === "" ? "empty string remains valid" : "valid string", async () => {
      transform = (decision) => ({ ...decision, reason });
      const before = protectedReads;
      const response = await read();
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().data, { url: "https://metrics.example.test" });
      assert.equal(protectedReads, before + 1);
    });
  }
  await t.test("wrong Driver and malformed evidence remain unavailable", async () => {
    for (const invalid of [
      (decision) => ({ ...decision, driverId: "another-driver" }),
      (decision) => ({ ...decision, evidence: { ...decision.evidence, roleIds: null } }),
    ]) {
      transform = invalid;
      const before = protectedReads;
      const response = await read();
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(protectedReads, before);
    }
  });
  await t.test("a genuine Restriction remains forbidden", async () => {
    transform = (decision) => decision;
    restrictions = [
      { id: "deny-admin-read", action: "administer", resourceKind: "installation", effect: "deny" },
    ];
    const before = protectedReads;
    const response = await read();
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "FORBIDDEN");
    assert.equal(protectedReads, before);
  });
});

test("compute operation cancellation disconnects an actual in-flight HTTP request", async (t) => {
  // Hold a real server request open so cancelling its operation is observable as a disconnect.
  let received;
  const requestReceived = new Promise((resolve) => {
    received = resolve;
  });
  let disconnected;
  const requestDisconnected = new Promise((resolve) => {
    disconnected = resolve;
  });
  const server = createServer((request) => {
    request.once("close", disconnected);
    received();
  });
  const endpoint = `http://127.0.0.1:${await listen(t, server)}`;
  const cancellation = new AbortController();

  // This proves operation-context transport cancellation; it does not simulate a database lease.
  const operation = withComputeAbortSignal(cancellation.signal, async () =>
    fetch(`${endpoint}/pending`, { signal: currentComputeAbortSignal() }),
  );
  await requestReceived;
  cancellation.abort(new Error("The compute operation was cancelled."));

  await assert.rejects(operation, /operation was cancelled/i);
  await requestDisconnected;
});
