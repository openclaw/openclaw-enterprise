import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";

const run = promisify(execFile);
const occApi = fileURLToPath(new URL("../../scripts/occ-api", import.meta.url));

// Real Fastify HTTP, Better Auth plugin/storage, OCC, and native IAM. This test
// does not claim PostgreSQL or Agent runtime coverage.
test("service API keys authenticate scoped automation without replacing sessions or IAM", async (t) => {
  const installationId = `ins_${randomUUID()}`;
  const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
  const authOptions = {
    installationId,
    mode: "development",
    baseURL: "http://127.0.0.1",
    secret: `test-secret-${randomUUID()}`,
    memoryDatabase,
    secureCookies: false,
  };
  const auth = createControllerAuth(authOptions);
  const credentials = { email: "admin@example.invalid", password: `test-password-${randomUUID()}` };
  const account = await auth.createAccount(credentials);
  const seed = auth.principalSeed(account);
  const policy = {
    identities: [seed.principal],
    roles: [...seed.roles],
    bindings: [...seed.bindings],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const iamDriver = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
  const auditSink = new InMemoryAuditSink();
  let controller;
  const app = createFastifyApp({
    auth,
    iamDriver,
    auditSink,
    development: { enabled: true, installationId },
    configurationDriver: createTestConfigurationDriver(),
    resolveHarness: async () => {
      throw new Error("No runtime is needed for authentication tests.");
    },
    createController(installation) {
      controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const session = await signInWithEmailPassword({ origin, ...credentials });
  async function request(method, path, { headers = { cookie: session.cookie }, body } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, ...(await response.json()) };
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
  const namespaceId = tenantA.data.id;
  const path = `/namespaces/${namespaceId}`;
  const principal = { kind: "service_principal", id: `sp_${randomUUID()}`, namespaceId };
  policy.identities.push(principal);
  policy.roles.push({
    id: "tenant-automation",
    namespaceId,
    permissions: [
      { action: "read", resourceKind: "namespace" },
      { action: "delete", resourceKind: "configuration" },
    ],
  });
  policy.bindings.push({
    id: "service-automation",
    namespaceId,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: "tenant-automation",
  });
  const body = { servicePrincipalId: principal.id, namespaceId, name: "tenant-automation" };
  const issue = () => request("POST", "/api/auth/service-keys", { body });
  const issued = await issue();
  assert.equal(issued.status, 201);
  assert.equal(issued.data.servicePrincipalId, principal.id);
  assert.equal(issued.data.namespaceId, namespaceId);
  assert.match(issued.data.key, /^occ_/);
  const headers = { "x-api-key": issued.data.key };

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

  await t.test("occ-api accepts a real bodyless Configuration deletion", async (t) => {
    const created = await request("POST", `/namespaces/${namespaceId}/configurations`, {
      body: { kind: "agent", values: { model: "gpt-test" } },
    });
    assert.equal(created.status, 201);
    const configurationPath = `/namespaces/${namespaceId}/configurations/${created.data.id}`;
    const directory = await mkdtemp(join(tmpdir(), "openclaw-occ-api-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const keyFile = join(directory, "service-key.json");
    await writeFile(keyFile, JSON.stringify(issued), { mode: 0o600 });
    const env = { ...process.env, OCC_URL: origin, OCC_SERVICE_KEY_FILE: keyFile };

    // Exercise the supported shell client against the real Configuration DELETE route.
    const deleted = await run(occApi, ["DELETE", configurationPath], { env });
    assert.equal(deleted.stdout, "");
    assert.equal((await request("GET", configurationPath)).status, 404);
  });

  await t.test(
    "invalid credentials fail closed even alongside a valid administrator cookie",
    async () => {
      for (const key of ["", "forged-key", `${issued.data.key}tampered`]) {
        const invalidHeaders = { "x-api-key": key, cookie: session.cookie };
        assert.equal((await request("GET", path, { headers: invalidHeaders })).status, 401);
        assert.equal(
          (await request("POST", "/api/auth/service-keys", { headers: invalidHeaders, body }))
            .status,
          401,
        );
        assert.equal(
          (
            await request("DELETE", `/api/auth/service-keys/${issued.data.id}`, {
              headers: invalidHeaders,
            })
          ).status,
          401,
        );
      }
      assert.equal((await request("GET", path, { headers: {} })).status, 401);
      assert.equal(
        (await request("GET", path, { headers: { authorization: `Bearer ${issued.data.key}` } }))
          .status,
        401,
      );
    },
  );

  await t.test("Namespace boundaries and exact IAM permissions remain authoritative", async () => {
    assert.equal((await request("GET", `/namespaces/${tenantB.data.id}`, { headers })).status, 403);
    assert.equal((await request("GET", "/installation", { headers })).status, 403);
    assert.equal((await request("DELETE", path, { headers })).status, 403);
    // Removing a grant is immediately visible without reissuing the credential.
    const binding = policy.bindings.pop();
    assert.equal((await request("GET", path, { headers })).status, 403);
    policy.bindings.push(binding);
    policy.restrictions.push({
      id: "deny-read",
      namespaceId,
      resourceKind: "namespace",
      action: "read",
      effect: "deny",
    });
    assert.equal((await request("GET", path, { headers })).status, 403);
    policy.restrictions.length = 0;
    assert.equal((await request("GET", path, { headers })).status, 200);
    // Even an administrative Role cannot widen a credential's fixed Namespace.
    policy.bindings.push({
      id: "namespace-service-admin",
      namespaceId,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: seed.bindings[0].roleId,
    });
    assert.equal((await request("POST", "/api/auth/service-keys", { headers, body })).status, 403);
    assert.equal(
      (await request("DELETE", `/api/auth/service-keys/${issued.data.id}`, { headers })).status,
      403,
    );
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
      const installationPrincipal = { kind: "service_principal", id: `sp_${randomUUID()}` };
      policy.identities.push(installationPrincipal);
      policy.roles.push({
        id: "installation-reader",
        permissions: [{ action: "read", resourceKind: "installation" }],
      });
      policy.bindings.push({
        id: "installation-service-reader",
        subjectKind: "identity",
        subjectId: installationPrincipal.id,
        roleId: "installation-reader",
      });
      const created = await request("POST", "/api/auth/service-keys", {
        body: { servicePrincipalId: installationPrincipal.id, name: "installation-reader" },
      });
      assert.equal(created.status, 201);
      const keyHeaders = { "x-api-key": created.data.key };
      assert.equal((await request("GET", "/installation", { headers: keyHeaders })).status, 200);
      assert.equal((await request("GET", path, { headers: keyHeaders })).status, 403);
      // A reader key cannot borrow the human cookie's Installation authority.
      const managementHeaders = { ...keyHeaders, cookie: session.cookie };
      assert.equal(
        (await request("POST", "/api/auth/service-keys", { headers: managementHeaders, body }))
          .status,
        403,
      );
      assert.equal(
        (
          await request("DELETE", `/api/auth/service-keys/${created.data.id}`, {
            headers: managementHeaders,
          })
        ).status,
        403,
      );
      const adminBinding = {
        id: "installation-service-admin",
        subjectKind: "identity",
        subjectId: installationPrincipal.id,
        roleId: seed.bindings[0].roleId,
        resourceKind: "installation",
        resourceId: installationId,
      };
      policy.bindings.push(adminBinding);
      const child = await request("POST", "/api/auth/service-keys", { headers: keyHeaders, body });
      assert.equal(child.status, 201);
      assert.equal(child.data.servicePrincipalId, principal.id);
      assert.equal(
        (await request("GET", path, { headers: { "x-api-key": child.data.key } })).status,
        200,
      );
      // Automated rotation issues a replacement and uses it to revoke the old key.
      const replacement = await request("POST", "/api/auth/service-keys", {
        headers: keyHeaders,
        body: { servicePrincipalId: installationPrincipal.id, name: "replacement-admin" },
      });
      assert.equal(replacement.status, 201);
      const replacementHeaders = { "x-api-key": replacement.data.key };
      assert.equal(
        (
          await request("DELETE", `/api/auth/service-keys/${created.data.id}`, {
            headers: replacementHeaders,
          })
        ).status,
        200,
      );
      assert.equal(
        (await request("POST", "/api/auth/service-keys", { headers: managementHeaders, body }))
          .status,
        401,
      );
      assert.equal(
        (
          await request("DELETE", `/api/auth/service-keys/${child.data.id}`, {
            headers: managementHeaders,
          })
        ).status,
        401,
      );

      // Management rechecks IAM: neither a removed grant nor a deny Restriction
      // can be bypassed by retaining a valid administrator credential.
      policy.bindings.pop();
      for (const restricted of [false, true]) {
        if (restricted) {
          policy.bindings.push(adminBinding);
          policy.restrictions.push({
            id: "deny-service-key-management",
            resourceKind: "installation",
            resourceId: installationId,
            action: "administer",
            effect: "deny",
          });
        }
        assert.equal(
          (await request("POST", "/api/auth/service-keys", { headers: replacementHeaders, body }))
            .status,
          403,
        );
        assert.equal(
          (
            await request("DELETE", `/api/auth/service-keys/${child.data.id}`, {
              headers: replacementHeaders,
            })
          ).status,
          403,
        );
      }
      policy.restrictions.pop();
      for (const key of [child.data, replacement.data]) {
        const revoked = await request("DELETE", `/api/auth/service-keys/${key.id}`, {
          headers: replacementHeaders,
        });
        assert.equal(revoked.status, 200);
        assert.equal(revoked.data.revoked, true);
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
      for (const [action, key] of [
        ["create", child.data],
        ["create", replacement.data],
        ["revoke", created.data],
        ["revoke", child.data],
        ["revoke", replacement.data],
      ]) {
        assert.ok(
          auditSink.events.some(
            (event) =>
              event.action === `openclaw.auth.service-keys.${action}` &&
              event.actorId === installationPrincipal.id &&
              event.details.serviceKeyId === key.id &&
              event.details.servicePrincipalId === key.servicePrincipalId,
          ),
        );
        assert.equal(JSON.stringify(auditSink.events).includes(key.key), false);
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
        { ...body, namespaceId: tenantB.data.id },
      ])
        assert.equal(
          (await request("POST", "/api/auth/service-keys", { body: candidate })).status,
          400,
        );
      // Creating an Agent through OCC provisions its real dedicated IAM identity.
      // Its workload-credential path must not be replaced by an ordinary service key.
      const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
        body: { kind: "agent", values: {} },
      });
      assert.equal(configuration.status, 201);
      const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
        body: { name: "owned-agent", configurationId: configuration.data.id },
      });
      assert.equal(agent.status, 201);
      const ownedAgent = await controller.getAgent(seed.principal.id, namespaceId, agent.data.id);
      policy.identities.push({
        kind: "service_principal",
        id: ownedAgent.servicePrincipalId,
        agentId: agent.data.id,
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
      ])
        assert.equal(
          (await request("POST", "/api/auth/service-keys", { body: { ...body, ...extra } })).status,
          400,
        );
    },
  );

  await t.test(
    "a signed-in human still needs Installation administer to issue or revoke",
    async () => {
      const adminBinding = policy.bindings.shift();
      assert.equal((await issue()).status, 403);
      assert.equal(
        (await request("DELETE", `/api/auth/service-keys/${issued.data.id}`)).status,
        403,
      );
      policy.bindings.unshift(adminBinding);
    },
  );

  await t.test(
    "expired credentials and a removed IAM identity cannot authenticate an authorized request",
    async () => {
      const expiring = await issue();
      assert.equal(expiring.status, 201);
      const authContext = await auth.auth.$context;
      await authContext.adapter.update({
        model: "apikey",
        where: [{ field: "id", value: expiring.data.id }],
        update: { expiresAt: new Date(Date.now() - 1000) },
      });
      assert.equal(
        (await request("GET", path, { headers: { "x-api-key": expiring.data.key } })).status,
        401,
      );
      const at = policy.identities.indexOf(principal);
      policy.identities.splice(at, 1);
      const binding = policy.bindings.find((entry) => entry.subjectId === principal.id);
      policy.bindings.splice(policy.bindings.indexOf(binding), 1);
      assert.equal((await request("GET", path, { headers })).status, 403);
      policy.identities.push(principal);
      policy.bindings.push(binding);
    },
  );

  await t.test(
    "HTTP revocation rejects the key, preserves sessions, and never exposes the credential",
    async () => {
      const revoked = await request("DELETE", `/api/auth/service-keys/${issued.data.id}`);
      assert.equal(revoked.status, 200);
      assert.equal(revoked.data.revoked, true);
      assert.equal(JSON.stringify(revoked).includes(issued.data.key), false);
      assert.equal(
        (await request("GET", path, { headers: { ...headers, cookie: session.cookie } })).status,
        401,
      );
      assert.equal((await request("GET", "/installation")).status, 200);
      const events = auditSink.events;
      assert.equal(JSON.stringify(events).includes(issued.data.key), false);
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
