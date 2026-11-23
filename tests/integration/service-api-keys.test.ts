import { runServiceApiKeysCliScenario } from "./service-api-keys-cli-cases.ts";
import { fetchLoopback } from "../helpers/console-fixture-transport.ts";
import type {
  AccessBinding,
  AgentRuntimeCredentialStatus,
  ComputeDriver,
  ServicePrincipal,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createControllerAuth } from "../helpers/password-hasher.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { jsonRequestInit } from "../helpers/inject-json.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.ts";
import { bindRole, grantRole, restrict } from "../helpers/iam-grants.ts";
import {
  AUTHORIZATION_HEADER_REFUSED,
  CREDENTIAL_REQUIRED,
  serviceKeyOutsideNamespace,
} from "../helpers/request-admission-expectations.ts";

type MutableIAMState = { [K in keyof NativeIAMState]: NativeIAMState[K][number][] };
type RequestOptions = { headers?: Record<string, string>; body?: unknown };
type HttpResult = Record<string, unknown> & { status: number };

function record(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  assert.ok(result, "expected an object");
  return result;
}

function stringField(value: unknown, field: string): string {
  const result = record(value)[field];
  assert.ok(typeof result === "string", `expected ${field} to be a string`);
  return result;
}

function assertStringFields<K extends string>(
  value: Record<string, unknown>,
  ...fields: K[]
): asserts value is Record<string, unknown> & Record<K, string> {
  for (const field of fields) {
    stringField(value, field);
  }
}

function jsonValue(text: string): unknown {
  return JSON.parse(text);
}

// Real Fastify HTTP, Better Auth plugin/storage, OCC, and native IAM. This test
// does not claim PostgreSQL or Agent runtime coverage.
test("service API keys authenticate scoped automation without replacing sessions or IAM", async (t) => {
  const installationId = `ins_${randomUUID()}`;
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const authOptions = {
    installationId,
    mode: "development",
    baseURL: "https://console.oce.localhost",
    agentDomain: "agents.oce.localhost",
    secret: `test-secret-${randomUUID()}`,
    memoryDatabase,
  } satisfies Parameters<typeof createControllerAuth>[0];
  const auth = createControllerAuth(authOptions);
  const credentials = { email: "admin@example.invalid", password: `test-password-${randomUUID()}` };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account, { grant: "administrator" });
  const bootstrapBinding = seed.bindings[0];
  assert.ok(bootstrapBinding);
  const policy: MutableIAMState = {
    identities: [seed.principal],
    roles: [...seed.roles],
    bindings: [...seed.bindings],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const auditSink = new InMemoryAuditSink();
  const runtimeCredentialStatus = new Map<string, AgentRuntimeCredentialStatus>();
  const computeDriver = {
    ...createDevelopmentComputeDriver(),
    async getAgentRuntimeCredentialStatus({ namespace, agent }) {
      return (
        runtimeCredentialStatus.get(`${namespace.id}:${agent.id}`) ?? {
          transportConfigured: false,
        }
      );
    },
    async provisionAgentRuntimeCredentials({ namespace, agent }) {
      const status = { transportConfigured: true };
      runtimeCredentialStatus.set(`${namespace.id}:${agent.id}`, status);
      return status;
    },
  } satisfies ComputeDriver;
  let controller: OpenClawController | undefined;
  const app = createFastifyApp({
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId, browserOrigin: authOptions.baseURL },
    computeDriver,
    secretDriver: createTestSecretDriver(),
    configurationDriver: createTestConfigurationDriver(),
    resolveHarness: resolveApprovedDevelopmentHarness,
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
  });
  let rotateKeyBeforeResponse: (() => void) | undefined;
  app.addHook("onSend", (_request, reply, payload, done) => {
    if (rotateKeyBeforeResponse && reply.statusCode === 403) {
      rotateKeyBeforeResponse();
      rotateKeyBeforeResponse = undefined;
    }
    done(null, payload);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const session = await signInWithEmailPassword({
    rememberMe: undefined,
    origin,
    headers: { origin: authOptions.baseURL },
    ...credentials,
  });
  async function request(
    method: string,
    path: string,
    {
      headers = { cookie: session.cookie, origin: authOptions.baseURL },
      body,
    }: RequestOptions = {},
  ): Promise<HttpResult> {
    const response = await fetchLoopback(
      `${origin}${path}`,
      jsonRequestInit(method, body, { host: "console.oce.localhost", ...headers }),
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const envelope = record(await response.json());
    return { status: response.status, ...envelope };
  }
  assert.equal(
    (await request("POST", "/installation/bootstrap", { body: { name: "Service keys test" } }))
      .status,
    201,
  );
  const tenantA = await request("POST", "/namespaces", { body: { name: "tenant-a" } });
  const tenantB = await request("POST", "/namespaces", { body: { name: "tenant-b" } });
  assert.equal(tenantA.status, 201);
  assert.equal(tenantB.status, 201);
  const activeController = controller;
  assert.ok(activeController);
  const namespaceId = stringField(tenantA.data, "id");
  const path = `/namespaces/${namespaceId}`;
  const principal: ServicePrincipal = {
    kind: "service_principal",
    id: `sp_${randomUUID()}`,
    namespaceId,
  };
  policy.identities.push(principal);
  grantRole(policy, principal.id, {
    id: "tenant-automation",
    bindingId: "service-automation",
    resource: undefined,
    namespaceId,
    permissions: {
      namespace: ["read"],
      configuration: ["create", "delete"],
      secret: ["create", "read", "update", "delete"],
      preset: ["read"],
      agent: ["read", "operate", "delete"],
    },
  });
  const body = { servicePrincipalId: principal.id, namespaceId, name: "tenant-automation" };
  const issue = () => request("POST", "/api/auth/service-keys", { body });
  async function assertServiceKeyManagementDenied(
    headers: Record<string, string>,
    keyResponse: Awaited<ReturnType<typeof request>>,
    status: number,
  ) {
    assert.equal(
      (await request("POST", "/api/auth/service-keys", { headers, body })).status,
      status,
    );
    assert.equal(
      (
        await request("DELETE", `/api/auth/service-keys/${stringField(keyResponse.data, "id")}`, {
          headers,
        })
      ).status,
      status,
    );
  }
  // A key's expiry is computed from the controller's clock at issuance; allow one second
  // of rounding on either side of the request.
  function assertIssuedLifetime(
    response: Awaited<ReturnType<typeof request>>,
    before: number,
    seconds: number,
  ) {
    const expiresAt = Date.parse(stringField(response.data, "expiresAt"));
    assert.ok(
      expiresAt >= before + seconds * 1000 - 1000 &&
        expiresAt <= Date.now() + seconds * 1000 + 1000,
      `expiresAt ${stringField(response.data, "expiresAt")} is not ${seconds} s after issuance`,
    );
  }
  const issuedBefore = Date.now();
  const issued = await issue();
  assert.equal(issued.status, 201);
  // Without expiresIn a key lives the documented 30 days.
  assertIssuedLifetime(issued, issuedBefore, 30 * 24 * 60 * 60);
  assert.equal(stringField(issued.data, "servicePrincipalId"), principal.id);
  assert.equal(stringField(issued.data, "namespaceId"), namespaceId);
  assert.match(stringField(issued.data, "key"), /^occ_/);
  const headers = { "x-api-key": stringField(issued.data, "key") };

  await t.test(
    "valid key reads the exact Namespace and never creates a user or session",
    async () => {
      assert.equal((await request("GET", path, { headers })).status, 200);
      assert.equal(memoryDatabase.user.length, 1);
      assert.equal(memoryDatabase.session.length, 1);
      const inspected = await request("GET", "/api/auth/session", { headers });
      assert.equal(inspected.data, null);
      assert.equal((await request("GET", "/installation")).status, 200);
    },
  );

  await t.test("Agent-capability denials identify the exact Agent collection", async () => {
    // The foreign Namespace fails service-key scope admission. The key's own Namespace
    // reaches OCC, where its Role lacks Agent create. Both must name the requested collection.
    for (const targetNamespaceId of [stringField(tenantB.data, "id"), namespaceId]) {
      const deniedBefore = auditSink.events.length;
      const response = await request("GET", `/namespaces/${targetNamespaceId}/agent-capabilities`, {
        headers,
      });
      assert.equal(response.status, 403);
      assert.equal(stringField(response.error, "code"), "FORBIDDEN");
      const denials = auditSink.events
        .slice(deniedBefore)
        .filter((event) => event.kind === "authorization_denial");
      assert.equal(denials.length, 1);
      const denial = denials[0];
      assert.ok(denial);
      const resource = { kind: "agent", id: targetNamespaceId, namespaceId: targetNamespaceId };
      assert.equal(denial.action, "openclaw.namespaces.agent_capabilities.read");
      assert.equal(denial.actorId, principal.id);
      assert.equal(denial.details?.actorServiceKeyId, stringField(issued.data, "id"));
      assert.deepEqual(denial.authorization, {
        principalId: principal.id,
        action: "create",
        resource,
      });
      assert.deepEqual(denial.resource, resource);
      if (targetNamespaceId !== namespaceId) {
        assert.equal(
          stringField(response.error, "message"),
          serviceKeyOutsideNamespace(namespaceId),
        );
      } else {
        assert.equal(record(denial.details?.iamEvidence).identityId, principal.id);
      }
    }
  });

  await t.test(
    "audit rows name the service key that acted, apart from its principal's other keys",
    async () => {
      const second = await issue();
      assert.equal(second.status, 201);
      const configurationIds: string[] = [];
      for (const key of [record(issued.data), record(second.data)]) {
        assertStringFields(key, "key", "id");
        const created = await request("POST", `/namespaces/${namespaceId}/configurations`, {
          headers: { "x-api-key": key.key },
          body: { kind: "agent", values: { model: "gpt-test" } },
        });
        assert.equal(created.status, 201);
        configurationIds.push(stringField(created.data, "id"));
        const mutation = auditSink.events.find(
          (event) =>
            event.action === "openclaw.configurations.create" &&
            event.resource.id === stringField(created.data, "id"),
        );
        assert.ok(mutation);
        assert.equal(mutation.actorId, principal.id);
        assert.equal(mutation.details?.actorServiceKeyId, key.id);
      }
      // A denial names the key too; the key's Role reads Presets but cannot create them.
      const deniedBefore = auditSink.events.length;
      assert.equal(
        (
          await request("POST", `/namespaces/${namespaceId}/presets`, {
            headers: { "x-api-key": stringField(second.data, "key") },
            body: { name: "denied-preset", template: { agent: { name: "Denied" } } },
          })
        ).status,
        403,
      );
      const denial = auditSink.events
        .slice(deniedBefore)
        .find((event) => event.kind === "authorization_denial");
      assert.ok(denial);
      assert.equal(denial.actorId, principal.id);
      assert.equal(denial.details?.actorServiceKeyId, stringField(second.data, "id"));
      // The acting key joins the denial's IAM evidence; it does not replace it.
      assert.equal(record(denial.details?.iamEvidence).identityId, principal.id);
      // Session requests carry no key; key management names the key acted on and its name.
      for (const id of configurationIds) {
        const deleted = await fetchLoopback(
          `${origin}/namespaces/${namespaceId}/configurations/${id}`,
          {
            method: "DELETE",
            headers: {
              host: "console.oce.localhost",
              cookie: session.cookie,
              origin: authOptions.baseURL,
            },
          },
        );
        assert.equal(deleted.status, 204);
      }
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${stringField(second.data, "id")}`))
          .status,
        200,
      );
      for (const action of ["create", "revoke"]) {
        const managed = auditSink.events.find(
          (event) =>
            event.action === `openclaw.auth.service-keys.${action}` &&
            event.details?.serviceKeyId === stringField(second.data, "id"),
        );
        assert.ok(managed?.details);
        assert.equal(managed.actorId, seed.principal.id);
        assert.equal(managed.details.serviceKeyName, "tenant-automation");
        assert.equal(Object.hasOwn(managed.details, "actorServiceKeyId"), false);
      }
      const sessionDeletes = auditSink.events.filter(
        (event) =>
          event.action === "openclaw.configurations.delete" &&
          configurationIds.includes(event.resource.id),
      );
      assert.equal(sessionDeletes.length, 2);
      for (const event of sessionDeletes) {
        assert.equal(event.details?.actorServiceKeyId, undefined);
      }
      const recorded = JSON.stringify(auditSink.events);
      assert.equal(recorded.includes(stringField(issued.data, "key")), false);
      assert.equal(recorded.includes(stringField(second.data, "key")), false);
    },
  );

  await t.test("occ CLI exercises Configuration CRUD and Agent stop/delete", async (t) => {
    await runServiceApiKeysCliScenario(t, {
      issued,
      origin,
      namespaceId,
      installationId,
      policy,
      request,
      controller: activeController,
      administratorId: seed.principal.id,
      principal,
      keyCount: () => memoryDatabase.apikey.length,
      setRotateKeyBeforeResponse: (callback) => {
        rotateKeyBeforeResponse = callback;
      },
      getRotateKeyBeforeResponse: () => rotateKeyBeforeResponse,
      assertions: { record, stringField, assertStringFields, jsonValue },
    });
  });

  await t.test(
    "invalid credentials fail closed even alongside a valid administrator cookie",
    async () => {
      for (const key of ["", "forged-key", `${stringField(issued.data, "key")}tampered`]) {
        const invalidHeaders = { "x-api-key": key, cookie: session.cookie };
        const refused = await request("GET", path, { headers: invalidHeaders });
        assert.equal(refused.status, 401);
        // Only a request that sent an Authorization header gets header advice (finding D762).
        assert.equal(record(refused.error).message, CREDENTIAL_REQUIRED);
        await assertServiceKeyManagementDenied(invalidHeaders, issued, 401);
      }
      const anonymous = await request("GET", path, { headers: {} });
      assert.equal(anonymous.status, 401);
      assert.equal(record(anonymous.error).message, CREDENTIAL_REQUIRED);
      const bearer = await request("GET", path, {
        headers: { authorization: `Bearer ${stringField(issued.data, "key")}` },
      });
      assert.equal(bearer.status, 401);
      assert.equal(record(bearer.error).message, AUTHORIZATION_HEADER_REFUSED);
    },
  );

  await t.test("Namespace boundaries and exact IAM permissions remain authoritative", async () => {
    // The key's fixed Namespace refuses every other route before IAM is asked, and the
    // refusal is audited against the key's service principal.
    for (const other of [`/namespaces/${stringField(tenantB.data, "id")}`, "/installation"]) {
      const eventsBefore = auditSink.events.length;
      const denied = await request("GET", other, { headers });
      assert.equal(denied.status, 403);
      // Names the key's own Namespace, never the requested one (finding D763).
      assert.equal(record(denied.error).message, serviceKeyOutsideNamespace(namespaceId));
      assert.equal(auditSink.events.length, eventsBefore + 1);
      const audit = auditSink.events.at(-1);
      assert.ok(audit);
      assert.equal(audit.kind, "authorization_denial");
      assert.equal(audit.actorId, principal.id);
    }
    assert.equal((await request("DELETE", path, { headers })).status, 403);
    // Removing a grant is immediately visible without reissuing the credential.
    const bindingIndex = policy.bindings.findIndex((entry) => entry.id === "service-automation");
    const [binding] = policy.bindings.splice(bindingIndex, 1);
    assert.ok(binding);
    assert.equal((await request("GET", path, { headers })).status, 403);
    policy.bindings.push(binding);
    restrict(policy, "read", "namespace", { namespaceId });
    assert.equal((await request("GET", path, { headers })).status, 403);
    policy.restrictions.length = 0;
    assert.equal((await request("GET", path, { headers })).status, 200);
    // Even an administrative Role cannot widen a credential's fixed Namespace.
    bindRole(policy, principal.id, {
      id: "namespace-service-admin",
      resource: undefined,
      roleId: bootstrapBinding.roleId,
      namespaceId,
    });
    await assertServiceKeyManagementDenied(headers, issued, 403);
    policy.bindings.pop();
  });

  await t.test("service credentials cannot manage human accounts or bootstrap", async () => {
    assert.equal((await request("POST", "/api/auth/accounts", { headers, body: {} })).status, 401);
    assert.equal(
      (await request("POST", "/installation/bootstrap", { headers, body: {} })).status,
      401,
    );
    assert.equal((await request("POST", "/api/auth/api-key/create", { body })).status, 404);
    assert.equal((await request("POST", "/api/auth/api-key/update", { body: {} })).status, 404);
  });

  await t.test(
    "Installation service administrators issue and rotate keys under current IAM policy",
    async () => {
      const installationPrincipal: ServicePrincipal = {
        kind: "service_principal",
        id: `sp_${randomUUID()}`,
      };
      policy.identities.push(installationPrincipal);
      grantRole(policy, installationPrincipal.id, {
        id: "installation-reader",
        bindingId: "installation-service-reader",
        namespaceId: undefined,
        resource: undefined,
        permissions: { installation: ["read"] },
      });
      const created = await request("POST", "/api/auth/service-keys", {
        body: { servicePrincipalId: installationPrincipal.id, name: "installation-reader" },
      });
      assert.equal(created.status, 201);
      const keyHeaders = { "x-api-key": stringField(created.data, "key") };
      assert.equal((await request("GET", "/installation", { headers: keyHeaders })).status, 200);
      assert.equal((await request("GET", path, { headers: keyHeaders })).status, 403);
      // A reader key cannot borrow the human cookie's Installation authority.
      const managementHeaders = { ...keyHeaders, cookie: session.cookie };
      await assertServiceKeyManagementDenied(managementHeaders, created, 403);
      // Installation administer alone cannot issue a key that reaches the
      // Namespace grants the issuer itself lacks.
      const exactAdminBinding: AccessBinding = {
        id: "installation-service-exact-admin",
        subjectKind: "identity",
        subjectId: installationPrincipal.id,
        roleId: bootstrapBinding.roleId,
        resourceKind: "installation",
        resourceId: installationId,
      };
      policy.bindings.push(exactAdminBinding);
      assert.equal(
        (await request("POST", "/api/auth/service-keys", { headers: keyHeaders, body })).status,
        403,
      );
      policy.bindings.splice(policy.bindings.indexOf(exactAdminBinding), 1);
      const adminBinding: AccessBinding = {
        id: "installation-service-admin",
        subjectKind: "identity",
        subjectId: installationPrincipal.id,
        roleId: bootstrapBinding.roleId,
      };
      policy.bindings.push(adminBinding);
      const child = await request("POST", "/api/auth/service-keys", { headers: keyHeaders, body });
      assert.equal(child.status, 201);
      assert.equal(stringField(child.data, "servicePrincipalId"), principal.id);
      assert.equal(
        (await request("GET", path, { headers: { "x-api-key": stringField(child.data, "key") } }))
          .status,
        200,
      );
      // Automated rotation issues a replacement and uses it to revoke the old key.
      const replacement = await request("POST", "/api/auth/service-keys", {
        headers: keyHeaders,
        body: { servicePrincipalId: installationPrincipal.id, name: "replacement-admin" },
      });
      assert.equal(replacement.status, 201);
      const replacementHeaders = { "x-api-key": stringField(replacement.data, "key") };
      assert.equal(
        (
          await request("DELETE", `/api/auth/service-keys/${stringField(created.data, "id")}`, {
            headers: replacementHeaders,
          })
        ).status,
        200,
      );
      await assertServiceKeyManagementDenied(managementHeaders, child, 401);

      // Management rechecks IAM: neither a removed grant nor a deny Restriction
      // can be bypassed by retaining a valid administrator credential.
      policy.bindings.pop();
      for (const restricted of [false, true]) {
        if (restricted) {
          policy.bindings.push(adminBinding);
          restrict(policy, "administer", "installation", { resourceId: installationId });
        }
        await assertServiceKeyManagementDenied(replacementHeaders, child, 403);
      }
      policy.restrictions.pop();
      for (const key of [record(child.data), record(replacement.data)]) {
        assertStringFields(key, "id", "key");
        const revoked = await request("DELETE", `/api/auth/service-keys/${key.id}`, {
          headers: replacementHeaders,
        });
        assert.equal(revoked.status, 200);
        assert.equal(record(revoked.data).revoked, true);
        assert.equal(JSON.stringify(revoked).includes(key.key), false);
        assert.equal(
          (
            await request("GET", key.namespaceId ? path : "/installation", {
              headers: { "x-api-key": key.key },
            })
          ).status,
          401,
        );
      }
      // Audits attribute issuance/revocation to the service actor, not the human
      // who originally issued its key, and never contain credential material.
      // Each also names the key that acted (`actorServiceKeyId`) apart from the key acted on.
      for (const [action, key, actorKey] of [
        ["create", child.data, created.data],
        ["create", replacement.data, created.data],
        ["revoke", created.data, replacement.data],
        ["revoke", child.data, replacement.data],
        ["revoke", replacement.data, replacement.data],
      ] as const) {
        const keyData = record(key);
        const actorKeyData = record(actorKey);
        assertStringFields(keyData, "id", "key", "name", "servicePrincipalId");
        assertStringFields(actorKeyData, "id");
        assert.ok(
          auditSink.events.some(
            (event) =>
              event.action === `openclaw.auth.service-keys.${action}` &&
              event.actorId === installationPrincipal.id &&
              event.details?.serviceKeyId === keyData.id &&
              event.details?.serviceKeyName === keyData.name &&
              event.details?.actorServiceKeyId === actorKeyData.id &&
              event.details?.servicePrincipalId === keyData.servicePrincipalId,
          ),
          `${action} ${keyData.name}`,
        );
        assert.equal(JSON.stringify(auditSink.events).includes(keyData.key), false);
      }
      assert.equal(memoryDatabase.user.length, 1);
      assert.equal(memoryDatabase.session.length, 1);
    },
  );

  await t.test(
    "unknown, human, wrong-scope, and Agent-owned subjects cannot receive keys",
    async () => {
      for (const candidate of [
        { ...body, servicePrincipalId: "missing" },
        { ...body, servicePrincipalId: seed.principal.id },
        { ...body, namespaceId: stringField(tenantB.data, "id") },
      ]) {
        assert.equal(
          (await request("POST", "/api/auth/service-keys", { body: candidate })).status,
          400,
        );
      }
      // Creating an Agent through OCC provisions its real dedicated IAM identity.
      // Its workload-credential path must not be replaced by an ordinary service key.
      const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
        body: { kind: "agent", values: {} },
      });
      assert.equal(configuration.status, 201);
      const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
        body: { name: "owned-agent", configurationId: stringField(configuration.data, "id") },
      });
      assert.equal(agent.status, 201);
      const ownedAgent = await activeController.getAgent(
        seed.principal.id,
        namespaceId,
        stringField(agent.data, "id"),
      );
      policy.identities.push({
        kind: "service_principal",
        id: ownedAgent.servicePrincipalId,
        agentId: stringField(agent.data, "id"),
        namespaceId,
      });
      assert.equal(
        (
          await request("POST", "/api/auth/service-keys", {
            body: { ...body, servicePrincipalId: ownedAgent.servicePrincipalId },
          })
        ).status,
        400,
      );
      for (const extra of [
        { permissions: { installation: ["administer"] } },
        { userId: account.id },
        { expiresIn: 0 },
        { expiresIn: 31536001 },
      ]) {
        assert.equal(
          (await request("POST", "/api/auth/service-keys", { body: { ...body, ...extra } })).status,
          400,
        );
      }
    },
  );

  await t.test(
    "a signed-in human still needs Installation administer to issue or revoke",
    async () => {
      const adminBinding = policy.bindings.shift();
      assert.ok(adminBinding);
      assert.equal((await issue()).status, 403);
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${stringField(issued.data, "id")}`))
          .status,
        403,
      );
      policy.bindings.unshift(adminBinding);
    },
  );

  await t.test("a requested lifetime sets the key's expiry", async () => {
    const before = Date.now();
    const shortLived = await request("POST", "/api/auth/service-keys", {
      body: { ...body, expiresIn: 86400 },
    });
    assert.equal(shortLived.status, 201);
    assertIssuedLifetime(shortLived, before, 86400);
    assert.equal(
      (
        await request("GET", path, {
          headers: { "x-api-key": stringField(shortLived.data, "key") },
        })
      ).status,
      200,
    );
    // Revoking takes no body; one is refused with the same wording as OCC's bodyless
    // operations, and the key stays valid.
    const withBody = await request(
      "DELETE",
      `/api/auth/service-keys/${stringField(shortLived.data, "id")}`,
      {
        body: {},
      },
    );
    assert.equal(withBody.status, 400);
    assert.equal(record(withBody.error).code, "INVALID_REQUEST");
    assert.equal(
      record(withBody.error).message,
      "The request does not match the operation contract: this operation accepts no request body.",
    );
    assert.equal(
      (
        await request("GET", path, {
          headers: { "x-api-key": stringField(shortLived.data, "key") },
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("DELETE", `/api/auth/service-keys/${stringField(shortLived.data, "id")}`))
        .status,
      200,
    );
  });

  await t.test("key names count code points, as the schema and the CLI do", async () => {
    const tooLong =
      "The request does not match the operation contract: body /name is too long (expected at most 32 characters).";
    // 32 code points that are 64 UTF-16 units still fit, and the name round-trips.
    for (const name of ["😀".repeat(32), "\u{20000}".repeat(32), `${"a".repeat(31)}😀`]) {
      const named = await request("POST", "/api/auth/service-keys", { body: { ...body, name } });
      assert.equal(named.status, 201, name);
      assert.equal(stringField(named.data, "name"), name);
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${stringField(named.data, "id")}`)).status,
        200,
      );
    }
    const keysBefore = memoryDatabase.apikey.length;
    const over = await request("POST", "/api/auth/service-keys", {
      body: { ...body, name: "😀".repeat(33) },
    });
    assert.equal(over.status, 400);
    assert.equal(record(over.error).message, tooLong);
    assert.deepEqual(record(over.error).details, [{ path: "/name", code: "TOO_LONG" }]);
    // Should Better Auth still refuse a name the schema admitted, the caller gets the
    // schema's 400, not a dependency 503, and no key is stored.
    const createServiceKey = auth.createServiceKey;
    auth.createServiceKey = (input) => createServiceKey({ ...input, name: "a".repeat(65) });
    try {
      const refused = await issue();
      assert.equal(refused.status, 400);
      assert.equal(record(refused.error).code, "INVALID_REQUEST");
      assert.equal(record(refused.error).message, tooLong);
      assert.deepEqual(record(refused.error).details, [{ path: "/name", code: "TOO_LONG" }]);
    } finally {
      auth.createServiceKey = createServiceKey;
    }
    assert.equal(memoryDatabase.apikey.length, keysBefore);
  });

  await t.test(
    "expired credentials and a removed IAM identity cannot authenticate an authorized request",
    async () => {
      const expiring = await issue();
      assert.equal(expiring.status, 201);
      const authContext = await auth.auth.$context;
      await authContext.adapter.update({
        model: "apikey",
        where: [{ field: "id", value: stringField(expiring.data, "id") }],
        update: { expiresAt: new Date(Date.now() - 1000) },
      });
      assert.equal(
        (
          await request("GET", path, {
            headers: { "x-api-key": stringField(expiring.data, "key") },
          })
        ).status,
        401,
      );
      const at = policy.identities.indexOf(principal);
      policy.identities.splice(at, 1);
      const binding = policy.bindings.find((entry) => entry.subjectId === principal.id);
      assert.ok(binding);
      policy.bindings.splice(policy.bindings.indexOf(binding), 1);
      assert.equal((await request("GET", path, { headers })).status, 403);
      policy.identities.push(principal);
      policy.bindings.push(binding);
    },
  );

  await t.test("a key record altered after issuance fails closed", async () => {
    const altered = await issue();
    assert.equal(altered.status, 201);
    const keyHeaders = { "x-api-key": stringField(altered.data, "key") };
    const read = async () => (await request("GET", path, { headers: keyHeaders })).status;
    assert.equal(await read(), 200);
    const authContext = await auth.auth.$context;
    const where = [{ field: "id", value: stringField(altered.data, "id") }];
    const keyRecord = record(await authContext.adapter.findOne({ model: "apikey", where }));
    const { expiresAt, configId } = keyRecord;
    const encoded = typeof keyRecord.metadata === "string";
    const metadata = record(
      typeof keyRecord.metadata === "string" ? jsonValue(keyRecord.metadata) : keyRecord.metadata,
    );
    assert.equal(metadata.namespaceId, namespaceId);
    const alter = ({
      referenceId = keyRecord.referenceId,
      ...changes
    }: {
      referenceId?: unknown;
      installationId?: string;
    }) =>
      authContext.adapter.update({
        model: "apikey",
        where,
        update: {
          referenceId,
          metadata: encoded
            ? JSON.stringify({ ...metadata, ...changes })
            : { ...metadata, ...changes },
        },
      });
    // Each altered subject below holds the same Namespace grant as the issued key.
    const grant = (identity: ServicePrincipal) => {
      policy.identities.push(identity);
      bindRole(policy, identity.id, {
        id: `altered-${identity.id}`,
        resource: undefined,
        roleId: "tenant-automation",
        namespaceId,
      });
    };
    const agentPrincipal: ServicePrincipal = {
      kind: "service_principal",
      id: `sp_${randomUUID()}`,
      namespaceId,
      agentId: `agt_${randomUUID()}`,
    };
    const unscopedPrincipal: ServicePrincipal = {
      kind: "service_principal",
      id: `sp_${randomUUID()}`,
    };
    grant(agentPrincipal);
    grant(unscopedPrincipal);
    try {
      // Another Installation's key is not a credential here at all.
      await alter({ installationId: `ins_${randomUUID()}` });
      assert.equal(await read(), 401);
      // An Agent's own service principal never acts through a service key.
      await alter({ referenceId: agentPrincipal.id });
      assert.equal(await read(), 403);
      // A Namespace key cannot name an Installation-scoped service principal.
      await alter({ referenceId: unscopedPrincipal.id });
      assert.equal(await read(), 403);
      // A record without a service principal or without an expiry is not a credential: the
      // caller is unauthenticated (401), not facing a dependency outage (503).
      await alter({ referenceId: "" });
      assert.equal(await read(), 401);
      await alter({});
      await authContext.adapter.update({ model: "apikey", where, update: { expiresAt: null } });
      assert.equal(await read(), 401);
      await authContext.adapter.update({ model: "apikey", where, update: { expiresAt } });
      assert.equal(await read(), 200);
      // Another key configuration's record is neither a credential nor revocable here.
      await authContext.adapter.update({ model: "apikey", where, update: { configId: "default" } });
      assert.equal(await read(), 401);
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${stringField(altered.data, "id")}`))
          .status,
        404,
      );
      await authContext.adapter.update({ model: "apikey", where, update: { configId } });
      assert.equal(await read(), 200);
    } finally {
      await authContext.adapter.update({ model: "apikey", where, update: { expiresAt, configId } });
      await alter({});
      for (const identity of [agentPrincipal, unscopedPrincipal]) {
        policy.identities.splice(policy.identities.indexOf(identity), 1);
        policy.bindings.splice(
          policy.bindings.findIndex((binding) => binding.subjectId === identity.id),
          1,
        );
      }
    }
  });

  await t.test(
    "HTTP revocation rejects the key, preserves sessions, and never exposes the credential",
    async () => {
      const revoked = await request(
        "DELETE",
        `/api/auth/service-keys/${stringField(issued.data, "id")}`,
      );
      assert.equal(revoked.status, 200);
      assert.equal(record(revoked.data).revoked, true);
      assert.equal(JSON.stringify(revoked).includes(stringField(issued.data, "key")), false);
      assert.equal(
        (await request("GET", path, { headers: { ...headers, cookie: session.cookie } })).status,
        401,
      );
      assert.equal((await request("GET", "/installation")).status, 200);
      const events = auditSink.events;
      assert.equal(JSON.stringify(events).includes(stringField(issued.data, "key")), false);
      assert.ok(
        events.some(
          (event) =>
            event.action === "openclaw.auth.service-keys.create" &&
            event.actorId === seed.principal.id,
        ),
      );
      assert.ok(events.some((event) => event.action === "openclaw.auth.service-keys.revoke"));
      assert.ok(
        events.some(
          (event) => event.kind === "authorization_denial" && event.actorId === principal.id,
        ),
      );
    },
  );
});

// Issuing a key hands the caller every grant of the target ServicePrincipal, so
// Installation administer alone must not reach a principal with broader access.
test("service key issuance cannot exceed the caller's own IAM grants", async (t) => {
  const installationId = `ins_${randomUUID()}`;
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const baseURL = "https://console.oce.localhost";
  const auth = createControllerAuth({
    installationId,
    mode: "development",
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret: `test-secret-${randomUUID()}`,
    memoryDatabase,
  });
  const adminCredentials = {
    email: "admin@example.invalid",
    password: `test-password-${randomUUID()}`,
  };
  const operatorCredentials = {
    email: "operator@example.invalid",
    password: `test-password-${randomUUID()}`,
  };
  const admin = auth.principalSeed(await auth.createAccount(adminCredentials), {
    grant: "administrator",
  });
  const administratorRole = admin.roles[0];
  assert.ok(administratorRole);
  // POST /api/auth/accounts with the administrator roleId binds it to the exact Installation.
  const operator = auth.principalSeed(await auth.createAccount(operatorCredentials), {
    roleId: administratorRole.id,
  });
  // Same shape as the bootstrap ServicePrincipal: the administrator Role, unscoped.
  const bootstrapService: ServicePrincipal = {
    kind: "service_principal",
    id: `spn_${randomUUID()}`,
  };
  const installationService: ServicePrincipal = {
    kind: "service_principal",
    id: `spn_${randomUUID()}`,
  };
  const policy: MutableIAMState = {
    identities: [admin.principal, operator.principal, bootstrapService, installationService],
    roles: [
      ...admin.roles,
      {
        id: "installation-iam",
        permissions: [{ action: "administer", resourceKind: "installation" }],
      },
    ],
    bindings: [
      ...admin.bindings,
      ...operator.bindings,
      {
        id: "bootstrap-service-admin",
        subjectKind: "identity",
        subjectId: bootstrapService.id,
        roleId: administratorRole.id,
      },
      {
        id: "installation-service-iam",
        subjectKind: "identity",
        subjectId: installationService.id,
        roleId: "installation-iam",
        resourceKind: "installation",
        resourceId: installationId,
      },
    ],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const auditSink = new InMemoryAuditSink();
  const app = createFastifyApp({
    auth,
    iamDriver: new NativeIAMDriver({ loadNativeIAMState: async () => policy }),
    auditSink,
    development: { enabled: true, installationId, browserOrigin: baseURL },
    computeDriver: createDevelopmentComputeDriver(),
    secretDriver: createTestSecretDriver(),
    configurationDriver: createTestConfigurationDriver(),
    resolveHarness: resolveApprovedDevelopmentHarness,
    createController(installation) {
      return new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const adminSession = await signInWithEmailPassword({
    rememberMe: undefined,
    origin,
    headers: { origin: baseURL },
    ...adminCredentials,
  });
  const operatorSession = await signInWithEmailPassword({
    rememberMe: undefined,
    origin,
    headers: { origin: baseURL },
    ...operatorCredentials,
  });
  async function request(
    method: string,
    path: string,
    { headers, body }: RequestOptions = {},
  ): Promise<HttpResult> {
    const response = await fetchLoopback(
      `${origin}${path}`,
      jsonRequestInit(method, body, { host: "console.oce.localhost", origin: baseURL, ...headers }),
    );
    const envelope = record(await response.json());
    return { status: response.status, ...envelope };
  }
  const asAdmin = { cookie: adminSession.cookie };
  const asOperator = { cookie: operatorSession.cookie };
  assert.equal(
    (await request("POST", "/installation/bootstrap", { headers: asAdmin, body: { name: "t" } }))
      .status,
    201,
  );
  const namespace = await request("POST", "/namespaces", {
    headers: asAdmin,
    body: { name: "tenant" },
  });
  assert.equal(namespace.status, 201);
  const namespacePath = `/namespaces/${stringField(namespace.data, "id")}`;

  // The operator's grant stops at the exact Installation.
  assert.equal((await request("GET", "/installation", { headers: asOperator })).status, 200);
  assert.equal((await request("GET", namespacePath, { headers: asOperator })).status, 403);

  const escalation = await request("POST", "/api/auth/service-keys", {
    headers: asOperator,
    body: { servicePrincipalId: bootstrapService.id, name: "escalation" },
  });
  assert.equal(escalation.status, 403, JSON.stringify(escalation));
  assert.equal(JSON.stringify(escalation).includes("occ_"), false);
  assert.equal(memoryDatabase.apikey.length, 0);
  assert.ok(
    auditSink.events.some(
      (event) =>
        event.action === "openclaw.auth.service-keys.create" &&
        event.kind === "authorization_denial" &&
        event.actorId === operator.principal.id,
    ),
  );

  // A principal whose grants the operator already holds is still issuable.
  const covered = await request("POST", "/api/auth/service-keys", {
    headers: asOperator,
    body: { servicePrincipalId: installationService.id, name: "covered" },
  });
  assert.equal(covered.status, 201, JSON.stringify(covered));

  // The unscoped administrator holds every grant of the bootstrap principal.
  const bootstrapKey = await request("POST", "/api/auth/service-keys", {
    headers: asAdmin,
    body: { servicePrincipalId: bootstrapService.id, name: "bootstrap" },
  });
  assert.equal(bootstrapKey.status, 201, JSON.stringify(bootstrapKey));
  assert.equal(
    (
      await request("GET", namespacePath, {
        headers: { "x-api-key": stringField(bootstrapKey.data, "key") },
      })
    ).status,
    200,
  );
  const coverageDenial = auditSink.events.find(
    (event) =>
      event.action === "openclaw.auth.service-keys.create" &&
      event.kind === "authorization_denial" &&
      event.actorId === operator.principal.id,
  );
  assert.ok(coverageDenial?.details);
  assert.ok(coverageDenial.decisionReason);
  assert.equal(coverageDenial.reasonCode, "SERVICE_PRINCIPAL_GRANTS_NOT_COVERED");
  assert.match(coverageDenial.decisionReason, /every grant of the target ServicePrincipal/);
  assert.equal(coverageDenial.details.servicePrincipalId, bootstrapService.id);

  // The administrator Role grants Agent administer but not read_logs. Administer already
  // admits log reads, so it covers a principal that was delegated read_logs on an Agent.
  const logReader: ServicePrincipal = {
    kind: "service_principal",
    id: `spn_${randomUUID()}`,
    namespaceId: stringField(namespace.data, "id"),
  };
  policy.identities.push(logReader);
  grantRole(policy, logReader.id, {
    id: "agent-log-reader",
    bindingId: "agent-log-reader-binding",
    namespaceId: stringField(namespace.data, "id"),
    permissions: { agent: ["read", "read_logs"] },
    resource: { kind: "agent", id: `agt_${randomUUID()}` },
  });
  const logReaderKey = await request("POST", "/api/auth/service-keys", {
    headers: asAdmin,
    body: {
      servicePrincipalId: logReader.id,
      namespaceId: stringField(namespace.data, "id"),
      name: "logs",
    },
  });
  assert.equal(logReaderKey.status, 201, JSON.stringify(logReaderKey));
  assert.equal(
    (
      await request("DELETE", `/api/auth/service-keys/${stringField(logReaderKey.data, "id")}`, {
        headers: asAdmin,
      })
    ).status,
    200,
  );

  // Revocation needs the same authority as issuance.
  const revokePath = `/api/auth/service-keys/${stringField(bootstrapKey.data, "id")}`;
  const revokeEscalation = await request("DELETE", revokePath, { headers: asOperator });
  assert.equal(revokeEscalation.status, 403, JSON.stringify(revokeEscalation));
  assert.equal(
    (
      await request("GET", namespacePath, {
        headers: { "x-api-key": stringField(bootstrapKey.data, "key") },
      })
    ).status,
    200,
  );
  const revokeDenial = auditSink.events.find(
    (event) =>
      event.action === "openclaw.auth.service-keys.revoke" &&
      event.kind === "authorization_denial" &&
      event.actorId === operator.principal.id,
  );
  assert.ok(revokeDenial?.details);
  assert.equal(revokeDenial.reasonCode, "SERVICE_PRINCIPAL_GRANTS_NOT_COVERED");
  assert.equal(revokeDenial.details.servicePrincipalId, bootstrapService.id);
  assert.equal(revokeDenial.details.serviceKeyId, stringField(bootstrapKey.data, "id"));
  // The operator can still revoke a key whose principal it covers.
  assert.equal(
    (
      await request("DELETE", `/api/auth/service-keys/${stringField(covered.data, "id")}`, {
        headers: asOperator,
      })
    ).status,
    200,
  );
  assert.equal((await request("DELETE", revokePath, { headers: asAdmin })).status, 200);
  assert.equal(
    (
      await request("GET", namespacePath, {
        headers: { "x-api-key": stringField(bootstrapKey.data, "key") },
      })
    ).status,
    401,
  );
});
