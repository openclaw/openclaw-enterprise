import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatGPTClient } from "../../apps/controller/src/backends/chatgpt.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
  ServiceAccountDriverNotConfiguredError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

const administrator = "service-account-driver-administrator";
const reader = "service-account-driver-reader";
const { Agent, buildConnector, getGlobalDispatcher, setGlobalDispatcher } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("undici");
const installation = Object.freeze({
  id: "installation-service-account-driver",
  name: "ServiceAccount Driver OCC conformance",
  createdAt: "2026-08-24T00:00:00.000Z",
});
const backend = Object.freeze({
  id: "openai",
  type: "chatgpt",
  configuration: Object.freeze({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    apiKeyPath: "/unused-conformance-chatgpt-admin-key",
    credentialTtlSeconds: 3600,
  }),
  drivers: Object.freeze({ service_account: "service-account-driver-conformance" }),
});

async function fixture({ selectServiceAccountDriver = true, createCredential } = {}) {
  const administrators = {
    namespace: ["create", "read"],
    service_account: ["create", "read", "update", "delete"],
    configuration: ["create", "read"],
    agent: ["create", "read", "deploy"],
  };
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => ({
        identities: [administrator, reader].map((id) => ({
          kind: "principal",
          id,
          issuer: "service-account-driver-conformance",
          subject: id,
        })),
        groups: [],
        memberships: [],
        roles: [
          {
            id: "service-account-driver-administrator-role",
            permissions: Object.entries(administrators).flatMap(([resourceKind, actions]) =>
              actions.map((action) => ({ action, resourceKind })),
            ),
          },
          {
            id: "service-account-driver-reader-role",
            permissions: [{ action: "read", resourceKind: "service_account" }],
          },
        ],
        bindings: ["administrator", "reader"].map((kind) => ({
          id: `service-account-driver-${kind}-binding`,
          subjectKind: "identity",
          subjectId: kind === "administrator" ? administrator : reader,
          roleId: `service-account-driver-${kind}-role`,
        })),
        restrictions: [],
      }),
    },
    { id: "service-account-driver-iam" },
  );
  const controller = new OpenClawController(installation, {
    backends: selectServiceAccountDriver ? [backend] : [],
  });
  const compute = createDevelopmentComputeDriver();
  const configuration = createTestConfigurationDriver();
  const externalAccounts = new Set();
  const externalCredentials = new Set();
  const driver = {
    id: "service-account-driver-conformance",
    capability: "service_account",
    implementation: "occ-conformance-service-account",
    backendId: backend.id,
    async create(account) {
      externalAccounts.add(account.id);
      controller.registerRollback(async () => {
        externalAccounts.delete(account.id);
      });
    },
    async createCredential(account) {
      if (createCredential !== undefined) {
        return createCredential(account);
      }
      externalCredentials.add(account.id);
      controller.registerRollback(async () => {
        externalCredentials.delete(account.id);
      });
      return {
        kind: "access_token",
        secretRef: { name: `account-${account.id.slice(3)}`, key: "token" },
      };
    },
    async delete(account) {
      externalCredentials.delete(account.id);
      externalAccounts.delete(account.id);
    },
  };
  for (const selected of [
    iam,
    compute,
    configuration,
    ...(selectServiceAccountDriver ? [driver] : []),
  ]) {
    controller.registerDriver(selected);
    controller.selectDriver(selected.capability, selected.id);
  }
  const namespace = await controller.createNamespace(administrator, {
    name: "ServiceAccount Driver conformance tenant",
  });

  return { controller, driver, externalAccounts, externalCredentials, namespace };
}

test("a selected ServiceAccount Driver owns authorized account and credential lifecycle", async () => {
  const { controller, driver, externalAccounts, externalCredentials, namespace } = await fixture();

  assert.equal(controller.selectedDriver("service_account"), driver);
  assert.throws(
    () =>
      controller.registerDriver({
        id: "service-account-driver-invalid",
        capability: "service_account",
        implementation: "invalid",
        create: async () => {},
        delete: async () => {},
      }),
    DriverSelectionError,
  );
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "backend-managed-account",
  });
  assert.equal(externalAccounts.has(account.id), true);

  // An exact account read grant cannot issue its credential or trigger Driver effects.
  await assert.rejects(
    controller.createServiceAccountCredential(reader, namespace.id, account.id),
    AuthorizationDeniedError,
  );
  assert.equal(externalCredentials.size, 0);

  const issued = await controller.createServiceAccountCredential(
    administrator,
    namespace.id,
    account.id,
  );
  assert.equal(issued.credential.kind, "access_token");
  assert.equal(externalCredentials.has(account.id), true);
  assert.deepEqual(
    await controller.getServiceAccount(administrator, namespace.id, account.id),
    issued,
  );
  await assert.rejects(
    controller.createServiceAccountCredential(administrator, namespace.id, account.id),
    ResourceConflictError,
  );
  await assert.rejects(
    controller.updateServiceAccountCredential(administrator, namespace.id, account.id, {
      kind: "api_key",
      secretRef: { name: "replacement-secret", key: "token" },
    }),
    ResourceConflictError,
  );

  await controller.deleteServiceAccount(administrator, namespace.id, account.id);
  assert.equal(externalAccounts.has(account.id), false);
  assert.equal(externalCredentials.has(account.id), false);
  await assert.rejects(
    controller.getServiceAccount(administrator, namespace.id, account.id),
    ScopeViolationError,
  );
});

test("issuance without a ChatGPT Backend names the fix after the grant and the account lookup", async () => {
  const { controller, namespace } = await fixture({ selectServiceAccountDriver: false });
  // Account creation needs no Driver.
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "no-backend-account",
  });
  const missing = "sa_00000000-0000-4000-8000-000000000000";

  // Grant first: a caller without update gets the same denial whether or not the account exists.
  for (const id of [account.id, missing]) {
    await assert.rejects(
      controller.createServiceAccountCredential(reader, namespace.id, id),
      // DependencyUnavailableError is an AuthorizationDeniedError, so rule out the old 503 too.
      (error) =>
        error instanceof AuthorizationDeniedError &&
        !(error instanceof DependencyUnavailableError) &&
        !(error instanceof ServiceAccountDriverNotConfiguredError),
    );
  }
  // Then the lookup: an unknown account is still not found.
  await assert.rejects(
    controller.createServiceAccountCredential(administrator, namespace.id, missing),
    (error) =>
      error instanceof ScopeViolationError &&
      !(error instanceof ServiceAccountDriverNotConfiguredError),
  );
  // Only then the Installation property, as a conflict naming the fix, not an outage.
  await assert.rejects(
    controller.createServiceAccountCredential(administrator, namespace.id, account.id),
    (error) => {
      assert.ok(error instanceof ServiceAccountDriverNotConfiguredError, error.name);
      assert.ok(!(error instanceof DependencyUnavailableError));
      assert.match(error.message, /no ChatGPT Backend.*guides\/integrations\/chatgpt\//);
      return true;
    },
  );
  assert.equal(
    (await controller.getServiceAccount(administrator, namespace.id, account.id)).credential,
    undefined,
  );
});

test("deleting an account with an issued token without a ChatGPT Backend names the fix after the grant and the account lookup", async () => {
  const { controller, namespace } = await fixture({ selectServiceAccountDriver: false });
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "orphaned-token-account",
  });
  // The token was issued while the ChatGPT Backend was configured; the Backend is gone now.
  await controller.transact((unit) =>
    unit.serviceAccounts.updateCredential(namespace.id, account.id, {
      kind: "access_token",
      secretRef: { name: `account-${account.id.slice(3)}`, key: "token" },
    }),
  );
  const missing = "sa_00000000-0000-4000-8000-000000000000";

  // Grant first: a caller without delete gets the same denial whether or not the account exists.
  for (const id of [account.id, missing]) {
    await assert.rejects(
      controller.deleteServiceAccount(reader, namespace.id, id),
      (error) =>
        error instanceof AuthorizationDeniedError &&
        !(error instanceof DependencyUnavailableError) &&
        !(error instanceof ServiceAccountDriverNotConfiguredError),
    );
  }
  await assert.rejects(
    controller.deleteServiceAccount(administrator, namespace.id, missing),
    (error) =>
      error instanceof ScopeViolationError &&
      !(error instanceof ServiceAccountDriverNotConfiguredError),
  );
  // Nothing can revoke the token, so deletion refuses with a conflict naming the fix, not an
  // outage, and keeps the account.
  await assert.rejects(
    controller.deleteServiceAccount(administrator, namespace.id, account.id),
    (error) => {
      assert.ok(error instanceof ServiceAccountDriverNotConfiguredError, error.name);
      assert.ok(!(error instanceof DependencyUnavailableError));
      assert.match(
        error.message,
        /no ChatGPT Backend to revoke it.*guides\/integrations\/chatgpt\//,
      );
      assert.doesNotMatch(error.message, new RegExp(account.id));
      return true;
    },
  );
  assert.equal(
    (await controller.getServiceAccount(administrator, namespace.id, account.id)).credential.kind,
    "access_token",
  );

  // An account without an issued token never needed the Backend and still deletes.
  const native = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "native-account",
  });
  await controller.deleteServiceAccount(administrator, namespace.id, native.id);
  await assert.rejects(
    controller.getServiceAccount(administrator, namespace.id, native.id),
    ScopeViolationError,
  );
});

test("a configured ServiceAccount Driver that fails keeps the generic dependency outage", async () => {
  const { controller, namespace } = await fixture({
    createCredential: async () => {
      throw new Error("provider unreachable");
    },
  });
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "unhealthy-backend-account",
  });
  await assert.rejects(
    controller.createServiceAccountCredential(administrator, namespace.id, account.id),
    (error) =>
      error instanceof DependencyUnavailableError &&
      !(error instanceof ServiceAccountDriverNotConfiguredError),
  );
});

test("outer transaction failure compensates selected Driver account and credential effects", async () => {
  const { controller, externalAccounts, externalCredentials, namespace } = await fixture();
  let abortedAccount;

  // HTTP audit append runs after the inner OCC mutation in this same outer transaction.
  await assert.rejects(
    controller.transact(async () => {
      abortedAccount = await controller.createServiceAccount(administrator, {
        namespaceId: namespace.id,
        name: "aborted-account",
      });
      throw new Error("transactional audit append failed");
    }),
    /transactional audit append failed/,
  );
  assert.equal(externalAccounts.has(abortedAccount.id), false);
  await assert.rejects(
    controller.getServiceAccount(administrator, namespace.id, abortedAccount.id),
    ScopeViolationError,
  );

  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "aborted-credential",
  });
  await assert.rejects(
    controller.transact(async () => {
      await controller.createServiceAccountCredential(administrator, namespace.id, account.id);
      throw new Error("credential audit append failed");
    }),
    /credential audit append failed/,
  );
  assert.equal(externalAccounts.has(account.id), true);
  assert.equal(externalCredentials.has(account.id), false);
  assert.equal(
    (await controller.getServiceAccount(administrator, namespace.id, account.id)).credential,
    undefined,
  );
});

test("the ChatGPT account name is cut by whole characters, never half of a surrogate pair", async () => {
  const { ChatGPTServiceAccountDriver } =
    await import("../../apps/controller/src/drivers/service-account/chatgpt.ts");
  const names = [];
  const stop = new Error("stop after the provider call");
  const driver = new ChatGPTServiceAccountDriver(
    {
      id: "openai",
      drivers: { service_account: "chatgpt-service-accounts" },
      client: {
        async createServiceAccount({ name }) {
          names.push(name);
          throw stop;
        },
      },
    },
    {},
    {},
    {},
  );
  const id = "sa_11111111-1111-4111-8111-111111111111";
  // One ASCII character puts every emoji on an odd UTF-16 offset, so a 160-unit cut would
  // fall inside the last emoji that starts before it.
  const name = `x${"\u{1F600}".repeat(199)}`;
  await assert.rejects(driver.create({ id, namespaceId: "ns_x", name }), stop);
  const [sent] = names;
  assert.equal(sent, `x${"\u{1F600}".repeat(79)}-${id}`);
  assert.ok(sent.length <= 200);
  assert.doesNotMatch(sent, /\p{Cs}/u);
});

test("ChatGPT Backend releases rejected HTTPS responses for subsequent account calls", async (t) => {
  assert.doesNotThrow(
    () => execFileSync("openssl", ["version"], { stdio: "ignore" }),
    "This native HTTPS regression requires openssl on PATH.",
  );
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-backend-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-subj",
      "/CN=api.chatgpt.com",
      "-addext",
      "subjectAltName=DNS:api.chatgpt.com",
    ],
    { stdio: "ignore" },
  );
  const key = await readFile(join(directory, "key.pem"));
  const cert = await readFile(join(directory, "cert.pem"));
  const workspaceId = backend.configuration.workspaceId;
  for (const fault of [
    { name: "HTTP 429", status: 429, reason: /failed with HTTP 429/ },
    { name: "HTTP 503", status: 503, reason: /failed with HTTP 503/ },
    {
      name: "oversized declared response",
      status: 200,
      length: 4 * 1024 * 1024 + 1,
      reason: /invalid response/,
    },
  ]) {
    await t.test(fault.name, async () => {
      const requests = [];
      const server = createServer({ key, cert }, (request, response) => {
        requests.push({ method: request.method, path: request.url });
        request.resume();
        if (requests.length === 1) {
          if (fault.length !== undefined) {
            response.setHeader("content-length", fault.length);
          }
          response.writeHead(fault.status);
          // The native response stays open after the Backend rejects its headers.
          response.write("unfinished synthetic response");
        } else {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ id: "recovered-account", workspace_id: workspaceId, enabled: true }),
          );
        }
      });
      const originalDispatcher = getGlobalDispatcher();
      const connector = buildConnector({ ca: cert, allowH2: false });
      const agent = new Agent({
        connections: 1,
        pipelining: 1,
        // Route native fetch to our TLS listener without replacing fetch or body disposal.
        connect: (options, callback) =>
          connector(
            {
              ...options,
              hostname: "127.0.0.1",
              port: server.address().port,
              servername: "api.chatgpt.com",
            },
            callback,
          ),
      });
      let retry;
      let timer;
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        setGlobalDispatcher(agent);
        const client = new ChatGPTClient({ workspaceId, adminKey: "synthetic-test-key" });
        await assert.rejects(client.createServiceAccount({ name: "first" }), fault.reason);
        retry = client.createServiceAccount({ name: "retry" });
        const account = await Promise.race([
          retry,
          new Promise((_, reject) => {
            // Shorter than the Backend's 30-second request timeout: cleanup must release capacity now.
            timer = setTimeout(
              () =>
                reject(new Error("The next account call stalled behind the rejected response.")),
              5000,
            );
          }),
        ]);
        assert.deepEqual(account, { id: "recovered-account" });
        assert.deepEqual(
          requests,
          Array(2).fill({
            method: "POST",
            path: `/v1/manage/workspaces/${workspaceId}/service-accounts`,
          }),
        );
      } finally {
        clearTimeout(timer);
        setGlobalDispatcher(originalDispatcher);
        await agent.destroy();
        await retry?.catch(() => {});
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});
