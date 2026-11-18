import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  ErrorResponse,
  NamespaceListResponse,
  RequestId,
  type ErrorCode,
  type Role,
} from "../../packages/contracts/src/index.ts";
import {
  validateAuthAccountPrincipalSeed,
  type AuthPrincipalSeed,
} from "../../packages/iam/src/index.ts";
import { BOOTSTRAP_DEFAULT_NAMESPACE_NAME } from "../../packages/occ/src/index.ts";
import { signInWithEmailPassword } from "../helpers/auth-session.mjs";
import {
  bootstrapInstallation as bootstrap,
  checkedInjectedBody,
  createInjectedControllerFixture,
  injectedRequest,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type FixtureOptions = Parameters<typeof createInjectedControllerFixture>[0];
type Reply = Awaited<ReturnType<FixtureRequest>>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const PublicUser = Type.Object({ id: Type.String(), email: Type.String(), name: Type.String() });
const SessionResponse = Type.Object({
  data: Type.Union([
    Type.Null(),
    Type.Object({ authenticated: Type.Literal(true), sessionKey: Type.String(), user: PublicUser }),
  ]),
  meta: Type.Object({ requestId: RequestId }),
});
const AccountResponse = Type.Object({
  data: Type.Object({
    id: Type.String(),
    email: Type.String(),
    name: Type.String(),
    principalId: Type.String(),
  }),
  meta: Type.Object({ requestId: RequestId }),
});

function assertApiError(reply: Reply, status: number, code: ErrorCode, label?: string) {
  const body = checkedInjectedBody(reply, status, ErrorResponse);
  assert.equal(body.error.code, code, label ?? JSON.stringify(body));
}

async function configuredController(options: FixtureOptions = {}) {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createInjectedControllerFixture(
    { ...options, auditSink },
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...appOptions }) {
        assert.equal(backendSummaries, undefined);
        return factory(appOptions);
      },
    },
  );
  const request: FixtureRequest = (method, pathname, requestOptions) =>
    injectedRequest(fixture.app, method, pathname, requestOptions);
  return { fixture, request, auditSink };
}

type TestController = Awaited<ReturnType<typeof configuredController>>;

async function defaultNamespace(controller: TestController) {
  const { data } = checkedInjectedBody(
    await controller.request("GET", "/namespaces"),
    200,
    NamespaceListResponse,
  );
  const found = data.find((namespace) => namespace.name === BOOTSTRAP_DEFAULT_NAMESPACE_NAME);
  assert.ok(found, "fresh bootstrap must create the default Namespace");
  assert.equal(found.status, "provisioning");
  return found;
}

test("session inspection stays optional and never exposes session or credential secrets", async () => {
  const { fixture } = await configuredController();

  const anonymous = await injectedRequest(fixture.app, "GET", "/api/auth/session", {
    identity: false,
  });
  assert.equal(checkedInjectedBody(anonymous, 200, SessionResponse).data, null);

  const authenticated = await injectedRequest(fixture.app, "GET", "/api/auth/session");
  const authenticatedData = checkedInjectedBody(authenticated, 200, SessionResponse).data;
  assert.notEqual(authenticatedData, null);
  assert.ok(authenticatedData);
  // Match secret-bearing field names at every depth, not serialized values: the
  // generated user ID and random sessionKey can spell "token" by chance (finding 725).
  const fieldNames: string[] = [];
  const collectFieldNames = (value: JsonValue): void => {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      fieldNames.push(key);
      collectFieldNames(child);
    }
  };
  collectFieldNames(authenticatedData);
  assert.deepEqual(
    fieldNames.filter((name) => /token|password|credential/i.test(name)),
    [],
  );
  // Known secret values must not appear anywhere, under any field name.
  const exposed = JSON.stringify(authenticatedData);
  assert.ok(fixture.app.defaultSession);
  assert.equal(exposed.includes(fixture.app.defaultSession.cookie), false);
  for (const pair of fixture.app.defaultSession.cookie.split(";")) {
    const value = pair.slice(pair.indexOf("=") + 1).trim();
    assert.ok(value.length > 0);
    assert.equal(exposed.includes(value), false);
    const decoded = decodeURIComponent(value);
    assert.equal(exposed.includes(decoded), false);
    // A signed cookie value is "<token>.<signature>"; the bare token is a secret too.
    const signature = decoded.lastIndexOf(".");
    if (signature > 0) {
      assert.equal(exposed.includes(decoded.slice(0, signature)), false);
    }
  }
  assert.equal(exposed.includes(fixture.authFixture.password), false);
  assert.match(authenticatedData.sessionKey, /^[A-Za-z0-9_-]+$/);

  const repeated = await injectedRequest(fixture.app, "GET", "/api/auth/session");
  const repeatedData = checkedInjectedBody(repeated, 200, SessionResponse).data;
  assert.ok(repeatedData);
  assert.equal(repeatedData.sessionKey, authenticatedData.sessionKey);
  assert.deepEqual(repeatedData.user, authenticatedData.user);

  const nextSession = await signInWithEmailPassword({
    fetch: fixture.app.fetch.bind(fixture.app),
    email: fixture.authFixture.email,
    password: fixture.authFixture.password,
  });
  const nextAuthenticated = await injectedRequest(fixture.app, "GET", "/api/auth/session", {
    session: nextSession,
  });
  const nextData = checkedInjectedBody(nextAuthenticated, 200, SessionResponse).data;
  assert.ok(nextData);
  assert.notEqual(nextData.sessionKey, authenticatedData.sessionKey);
  assert.deepEqual(nextData.user, authenticatedData.user);
});

test("administrator-created auth accounts sign in and receive only provisioned IAM access", async () => {
  const provisionedSeeds: AuthPrincipalSeed[] = [];
  const controller = await configuredController({
    provisionAuthAccount(seed, { installAuthSeed, state, auditEvent }) {
      provisionedSeeds.push(seed);
      // Use the production validator so Role errors map exactly as they do on PostgreSQL.
      validateAuthAccountPrincipalSeed(seed, state, fixture.installationId);
      return installAuthSeed(seed, { auditEvent });
    },
  });
  const { fixture, auditSink } = controller;
  const selectedIAMDriver = fixture.iamDriver;
  await bootstrap(controller, "Provisioned account installation");
  const readOnlyRole: Role = {
    id: "role-read-only-auth-account",
    name: "Read-only auth account",
    permissions: [{ action: "read", resourceKind: "installation" }],
  };
  fixture.state.roles.push(readOnlyRole);
  const { id: namespaceId } = await defaultNamespace(controller);

  const noGrantEmail = `no-grant-${randomUUID()}@example.com`;
  const noGrantPassword = `generated-password-${randomUUID()}`;
  const noGrantAuditCount = auditSink.events.length;
  const noGrant = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: {
      email: noGrantEmail,
      password: noGrantPassword,
      name: "No Grant Operator",
    },
  });
  const noGrantData = checkedInjectedBody(noGrant, 201, AccountResponse).data;
  const noGrantSeed = provisionedSeeds.at(-1);
  assert.ok(noGrantSeed);
  assert.deepEqual(noGrantSeed.roles, []);
  assert.deepEqual(noGrantSeed.bindings, []);
  const noGrantEvents = auditSink.events.slice(noGrantAuditCount);
  assert.equal(noGrantEvents.length, 1);
  assert.ok(noGrantEvents[0]);
  assert.equal(noGrantEvents[0].kind, "mutation");
  assert.equal(noGrantEvents[0].action, "openclaw.auth.accounts.create");
  assert.equal(noGrantEvents[0].outcome, "success");
  assert.equal(noGrantEvents[0].details?.principalId, noGrantData.principalId);
  assert.equal(noGrantEvents[0].details?.grant, "none");
  assert.equal(noGrantEvents[0].details?.roleId, undefined);
  assert.ok(!JSON.stringify(noGrantEvents[0]).includes(noGrantEmail));
  assert.ok(!JSON.stringify(noGrantEvents[0]).includes(noGrantPassword));
  assert.deepEqual(noGrantEvents[0].resource, {
    kind: "installation",
    id: fixture.installationId,
  });
  const noGrantSession = await signInWithEmailPassword({
    fetch: fixture.app.fetch.bind(fixture.app),
    email: noGrantEmail,
    password: noGrantPassword,
  });
  const noGrantInstallation = await injectedRequest(fixture.app, "GET", "/installation", {
    session: noGrantSession,
  });
  assert.equal(noGrantInstallation.status, 403);
  // A zero-grant human is authenticated but sees nothing and can change nothing until an
  // administrator binds a Role; list reads filter to an empty set, everything else is denied.
  const noGrantNamespaces = await injectedRequest(fixture.app, "GET", "/namespaces", {
    session: noGrantSession,
  });
  assert.deepEqual(checkedInjectedBody(noGrantNamespaces, 200, NamespaceListResponse).data, []);
  const deniedOperations: [string, string, Record<string, JsonValue>?][] = [
    ["POST", "/namespaces", { name: "zero-grant-namespace" }],
    ["GET", `/namespaces/${namespaceId}`],
    ["DELETE", `/namespaces/${namespaceId}`],
    ["GET", `/namespaces/${namespaceId}/agents`],
    ["GET", `/namespaces/${namespaceId}/iam/roles`],
    [
      "POST",
      `/namespaces/${namespaceId}/iam/roles`,
      { permissions: [{ action: "read", resourceKind: "namespace" }] },
    ],
    [
      "POST",
      "/api/auth/accounts",
      {
        email: `zero-grant-escalation-${randomUUID()}@example.com`,
        password: `generated-password-${randomUUID()}`,
        name: "Zero Grant Escalation",
      },
    ],
  ];
  for (const [method, pathname, body] of deniedOperations) {
    const denied = await injectedRequest(fixture.app, method, pathname, {
      session: noGrantSession,
      ...(body === undefined ? {} : { body }),
    });
    assertApiError(denied, 403, "FORBIDDEN", `${method} ${pathname}`);
  }

  const unknownRole = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: {
      email: `unknown-role-${randomUUID()}@example.com`,
      password: `generated-password-${randomUUID()}`,
      name: "Unknown Role Operator",
      roleId: "role-does-not-exist",
    },
  });
  assert.equal(unknownRole.status, 400);

  // A Namespace-scoped Role exists but cannot back an Installation account binding.
  fixture.state.roles.push({
    id: "role-namespace-auth-account",
    name: "Namespace reader",
    namespaceId,
    permissions: [{ action: "read", resourceKind: "namespace" }],
  });
  const beforeNamespaceRole = {
    identities: fixture.state.identities.length,
    bindings: fixture.state.bindings.length,
    auditEvents: auditSink.events.length,
  };
  const namespaceRoleEmail = `namespace-role-${randomUUID()}@example.com`;
  const namespaceRolePassword = `generated-password-${randomUUID()}`;
  const namespaceRole = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: {
      email: namespaceRoleEmail,
      password: namespaceRolePassword,
      name: "Namespace Role Operator",
      roleId: "role-namespace-auth-account",
    },
  });
  assertApiError(namespaceRole, 400, "INVALID_REQUEST");
  assert.deepEqual(
    {
      identities: fixture.state.identities.length,
      bindings: fixture.state.bindings.length,
      auditEvents: auditSink.events.length,
    },
    beforeNamespaceRole,
  );
  await assert.rejects(
    signInWithEmailPassword({
      fetch: fixture.app.fetch.bind(fixture.app),
      email: namespaceRoleEmail,
      password: namespaceRolePassword,
    }),
    /sign-in failed with HTTP 401: .*"code":\s*"UNAUTHENTICATED"/s,
  );

  // An explicit but blank or null roleId is a malformed request, never the zero-grant path.
  for (const roleId of ["", null]) {
    const before = {
      identities: fixture.state.identities.length,
      auditEvents: auditSink.events.length,
    };
    const blankRole = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
      body: {
        email: `blank-role-${randomUUID()}@example.com`,
        password: `generated-password-${randomUUID()}`,
        name: "Blank Role Operator",
        roleId,
      },
    });
    assertApiError(blankRole, 400, "INVALID_REQUEST", `roleId ${JSON.stringify(roleId)}`);
    assert.equal(fixture.state.identities.length, before.identities);
    assert.equal(auditSink.events.length, before.auditEvents);
  }

  const invalidEmail = "invalid-auth-account-email";
  const invalidEmailPassword = `generated-password-${randomUUID()}`;
  const stateCounts = {
    identities: fixture.state.identities.length,
    roles: fixture.state.roles.length,
    bindings: fixture.state.bindings.length,
    auditEvents: auditSink.events.length,
  };
  const invalidEmailResult = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: {
      email: invalidEmail,
      password: invalidEmailPassword,
      name: "Invalid Email Operator",
      roleId: readOnlyRole.id,
    },
  });
  assertApiError(invalidEmailResult, 400, "INVALID_REQUEST");
  assert.deepEqual(
    {
      identities: fixture.state.identities.length,
      roles: fixture.state.roles.length,
      bindings: fixture.state.bindings.length,
      auditEvents: auditSink.events.length,
    },
    stateCounts,
  );
  await assert.rejects(
    signInWithEmailPassword({
      fetch: fixture.app.fetch.bind(fixture.app),
      email: invalidEmail,
      password: invalidEmailPassword,
    }),
    /HTTP 400/,
  );

  const email = `operator-${randomUUID()}@example.com`;
  const password = `generated-password-${randomUUID()}`;
  const originalAuthorize = selectedIAMDriver.authorize;
  selectedIAMDriver.authorize = async (...args) => {
    const decision = await originalAuthorize.apply(selectedIAMDriver, args);
    if (args[0].action !== "administer") {
      return decision;
    }
    const groupIds = ["original-admin-evidence"];
    groupIds[Symbol.iterator] = () => {
      throw new Error("the audit event must not use the supplied iterator");
    };
    return { ...decision, evidence: { ...decision.evidence, groupIds } };
  };
  const auditCount = auditSink.events.length;
  const created = await injectedRequest(fixture.app, "POST", "/api/auth/accounts", {
    body: { email, password, name: "Read Only Operator", roleId: readOnlyRole.id },
  });
  const createdData = checkedInjectedBody(created, 201, AccountResponse).data;
  const provisionedSeed = provisionedSeeds.at(-1);
  assert.ok(provisionedSeed);
  assert.equal(fixture.iamDriver, selectedIAMDriver);
  assert.equal(createdData.email, email);
  assert.equal(createdData.name, "Read Only Operator");
  assert.equal(createdData.principalId, provisionedSeed.principal.id);
  assert.deepEqual(provisionedSeed.roles, []);
  assert.deepEqual(
    provisionedSeed.bindings.map(({ roleId }) => roleId),
    [readOnlyRole.id],
  );
  const accountEvents = auditSink.events.slice(auditCount);
  assert.equal(accountEvents.length, 1);
  assert.ok(accountEvents[0]);
  assert.equal(accountEvents[0].kind, "mutation");
  assert.equal(accountEvents[0].action, "openclaw.auth.accounts.create");
  const evidence = accountEvents[0].details?.iamEvidence;
  assert(Check(Type.Object({ groupIds: Type.Array(Type.String()) }), evidence));
  assert.deepEqual(evidence.groupIds, ["original-admin-evidence"]);
  assert.equal(accountEvents[0].details?.principalId, createdData.principalId);
  assert.equal(accountEvents[0].details?.roleId, readOnlyRole.id);
  assert.equal(accountEvents[0].details?.grant, undefined);
  assert.ok(!JSON.stringify(accountEvents[0]).includes(email));
  assert.ok(!JSON.stringify(accountEvents[0]).includes(password));
  assert.deepEqual(accountEvents[0].resource, {
    kind: "installation",
    id: fixture.installationId,
  });

  const secondSession = await signInWithEmailPassword({
    fetch: fixture.app.fetch.bind(fixture.app),
    email,
    password,
  });
  const installation = await injectedRequest(fixture.app, "GET", "/installation", {
    session: secondSession,
  });
  assert.equal(installation.status, 200);

  const denied = await injectedRequest(fixture.app, "POST", "/namespaces", {
    session: secondSession,
    body: { name: "denied-account-namespace" },
  });
  assertApiError(denied, 403, "FORBIDDEN");
});
