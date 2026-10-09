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
  ServiceAccountCredentialSecretExistsError,
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
      !(error instanceof ServiceAccountDriverNotConfiguredError) &&
      error.message === "The selected ServiceAccount Driver is unavailable.",
  );
});

test("a leftover credential Secret reaches the issuing caller as a conflict that names it", async () => {
  let calls = 0;
  const leftover = new ServiceAccountCredentialSecretExistsError(
    "oce-0123456789abcde",
    "service-account-0123456789abcdef0123456789abcdef",
  );
  const { controller, externalCredentials, namespace } = await fixture({
    createCredential: async () => {
      calls += 1;
      throw leftover;
    },
  });
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "leftover-secret-account",
  });
  // A caller without the account's update grant never reaches the Driver or the Secret's name.
  await assert.rejects(
    controller.createServiceAccountCredential(reader, namespace.id, account.id),
    (error) =>
      error instanceof AuthorizationDeniedError &&
      !(error instanceof DependencyUnavailableError) &&
      !error.message.includes(leftover.secretName),
  );
  assert.equal(calls, 0);
  // Before finding 935 the controller replaced it with "The selected ServiceAccount Driver is
  // unavailable." (503), which hid the Secret that blocks every retry.
  await assert.rejects(
    controller.createServiceAccountCredential(administrator, namespace.id, account.id),
    (error) => error === leftover && !(error instanceof DependencyUnavailableError),
  );
  assert.equal(calls, 1);
  assert.equal(externalCredentials.size, 0);
  assert.equal(
    (await controller.getServiceAccount(administrator, namespace.id, account.id)).credential,
    undefined,
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

// An in-memory ChatGPT Admin API behind a replaced global fetch. Each fault applies the
// request first (or not), then answers as the test asks.
function fakeChatGPT(workspaceId) {
  const accounts = new Map();
  const requests = [];
  const faults = [];
  let next = 0;
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const base = `/v1/manage/workspaces/${workspaceId}/service-accounts`;
    const [accountId, segment, credentialId] = path.slice(base.length + 1).split("/");
    const request = { method: init.method, path };
    requests.push(request);
    const fault = faults.shift() ?? {};
    if (fault.apply === false) {
      throw new TypeError("fetch failed");
    }
    let reply;
    if (init.method === "POST" && path === base) {
      const id = `acct-${++next}`;
      accounts.set(id, { name: JSON.parse(init.body).name, credentials: new Set() });
      reply = json(200, { id, workspace_id: workspaceId, enabled: true, ...fault.body });
    } else if (init.method === "POST" && segment === "credentials" && credentialId === undefined) {
      const owner = decodeURIComponent(accountId);
      const account = accounts.get(owner);
      if (account === undefined) {
        reply = json(404, { error: { code: "service_account_not_found" } });
      } else {
        const id = `cred-${++next}`;
        account.credentials.add(id);
        const { scopes, ttl } = JSON.parse(init.body);
        reply = json(200, {
          id,
          access_token: `synthetic-${id}`,
          workspace_id: workspaceId,
          service_account_id: owner,
          scopes,
          expires_at: 1_800_000_000 + ttl,
          ...fault.body,
        });
      }
    } else if (init.method === "DELETE" && segment === "credentials") {
      const account = accounts.get(decodeURIComponent(accountId));
      if (!account?.credentials.delete(decodeURIComponent(credentialId))) {
        reply = json(404, { error: { code: "credential_not_found" } });
      } else {
        reply = json(200, { id: decodeURIComponent(credentialId), deleted: true });
      }
    } else if (init.method === "DELETE" && segment === undefined) {
      if (!accounts.delete(decodeURIComponent(accountId))) {
        reply = json(404, { error: { code: "service_account_not_found" } });
      } else {
        reply = json(200, { id: decodeURIComponent(accountId), deleted: true });
      }
    } else {
      reply = json(400, { error: { code: "unexpected" } });
    }
    if (fault.lost) {
      throw new TypeError("fetch failed");
    }
    if (fault.status !== undefined) {
      return new Response(fault.text ?? "", { status: fault.status });
    }
    return reply;
  };
  return { accounts, requests, faults, fetch };
}

async function withFakeChatGPT(work) {
  const workspaceId = backend.configuration.workspaceId;
  const server = fakeChatGPT(workspaceId);
  const original = globalThis.fetch;
  globalThis.fetch = server.fetch;
  try {
    const client = new ChatGPTClient({ workspaceId, adminKey: "synthetic-test-key" });
    await work({ client, server, workspaceId });
  } finally {
    globalThis.fetch = original;
  }
}

test("a ChatGPT account create whose reply is invalid removes exactly the account it made", async (t) => {
  for (const reply of [
    {
      name: "disabled account",
      body: { enabled: false },
      stored: ["foreign"],
      requests: ["POST service-accounts", "DELETE acct-1"],
    },
    {
      // The reply does not place the account in this workspace, so it proves nothing.
      name: "another workspace",
      body: { workspace_id: "22222222-2222-4222-8222-222222222222" },
      stored: ["foreign", "acct-1"],
      requests: ["POST service-accounts"],
    },
  ]) {
    await t.test(reply.name, () =>
      withFakeChatGPT(async ({ client, server }) => {
        server.accounts.set("foreign", { name: "kept-sa_x", credentials: new Set() });
        server.faults.push({ body: reply.body });
        await assert.rejects(
          client.createServiceAccount({ name: "kept-sa_x" }),
          (error) =>
            error instanceof DependencyUnavailableError &&
            error.message === "ChatGPT returned an invalid service account.",
        );
        assert.deepEqual([...server.accounts.keys()], reply.stored);
        assert.deepEqual(
          server.requests.map(({ method, path }) => `${method} ${path.split("/").at(-1)}`),
          reply.requests,
        );
      }),
    );
  }

  await t.test("the cleanup fails", () =>
    withFakeChatGPT(async ({ client, server }) => {
      server.faults.push({ body: { enabled: false } }, { apply: false });
      await assert.rejects(
        client.createServiceAccount({ name: "unremovable" }),
        (error) =>
          error instanceof DependencyUnavailableError && /could not be removed/.test(error.message),
      );
      assert.deepEqual([...server.accounts.keys()], ["acct-1"]);
    }),
  );

  await t.test("the reply names no account", () =>
    withFakeChatGPT(async ({ client, server }) => {
      server.faults.push({ body: { id: "" } });
      await assert.rejects(
        client.createServiceAccount({ name: "nameless" }),
        (error) =>
          error instanceof DependencyUnavailableError &&
          error.message === "ChatGPT returned an invalid service account.",
      );
      assert.deepEqual(
        server.requests.map(({ method }) => method),
        ["POST"],
      );
    }),
  );
});

test("a ChatGPT credential create whose reply is invalid revokes exactly the credential it issued", async (t) => {
  const invalid = (error) =>
    error instanceof DependencyUnavailableError &&
    error.message === "ChatGPT returned an invalid service-account credential.";
  const credentials = (server) =>
    Object.fromEntries([...server.accounts].map(([id, { credentials }]) => [id, [...credentials]]));
  const issue = async (body) => {
    let result;
    await withFakeChatGPT(async ({ client, server }) => {
      server.accounts.set("acct-own", { name: "own", credentials: new Set() });
      server.accounts.set("acct-other", { name: "other", credentials: new Set(["cred-other"]) });
      server.faults.push(body === undefined ? {} : { body });
      let error;
      let credential;
      try {
        credential = await client.createCredential({ accountId: "acct-own", name: "occ-sa_x" });
      } catch (caught) {
        error = caught;
      }
      result = {
        error,
        credential,
        stored: credentials(server),
        requests: server.requests.map(({ method, path }) => `${method} ${path.split("/").at(-1)}`),
      };
    });
    return result;
  };

  await t.test("a valid reply is returned unchanged", async () => {
    const { error, credential, stored } = await issue();
    assert.equal(error, undefined);
    assert.deepEqual(credential, { id: "cred-1", accessToken: "synthetic-cred-1" });
    assert.deepEqual(stored, { "acct-own": ["cred-1"], "acct-other": ["cred-other"] });
  });

  for (const [name, body] of [
    ["an unexpected scope", { scopes: ["another.scope"] }],
    ["no access token", { access_token: "" }],
    ["no expiry", { expires_at: null }],
  ]) {
    await t.test(`a reply with ${name} under this account removes that credential`, async () => {
      const { error, stored, requests } = await issue(body);
      assert.ok(invalid(error), String(error));
      assert.deepEqual(stored, { "acct-own": [], "acct-other": ["cred-other"] });
      assert.deepEqual(requests, ["POST credentials", "DELETE cred-1"]);
    });
  }

  for (const [name, body] of [
    // The reply does not place the credential under the requested account or this
    // workspace, or names none, so it proves nothing and nothing is deleted.
    ["another account", { service_account_id: "acct-other", id: "cred-other" }],
    ["another workspace", { workspace_id: "22222222-2222-4222-8222-222222222222" }],
    ["no credential ID", { id: "" }],
  ]) {
    await t.test(`a reply naming ${name} deletes nothing`, async () => {
      const { error, stored, requests } = await issue(body);
      assert.ok(invalid(error), String(error));
      assert.deepEqual(stored, { "acct-own": ["cred-1"], "acct-other": ["cred-other"] });
      assert.deepEqual(requests, ["POST credentials"]);
    });
  }

  await t.test("the cleanup fails", () =>
    withFakeChatGPT(async ({ client, server }) => {
      server.accounts.set("acct-own", { name: "own", credentials: new Set() });
      server.faults.push({ body: { scopes: [] } }, { apply: false });
      await assert.rejects(
        client.createCredential({ accountId: "acct-own", name: "occ-sa_x" }),
        (error) =>
          error instanceof DependencyUnavailableError &&
          error.message ===
            "ChatGPT returned an invalid service-account credential that could not be removed.",
      );
      assert.deepEqual(credentials(server), { "acct-own": ["cred-1"] });
    }),
  );
});

test("a ChatGPT account create whose reply is lost deletes nothing it cannot prove is its own", async (t) => {
  // The Admin API key holds write scope only and the client has no account read, so a
  // matching name is not proof: the create is reported as unavailable and nothing is deleted.
  for (const fault of [
    { name: "applied, reply lost", fault: { lost: true }, stored: ["foreign", "acct-1"] },
    { name: "applied, HTTP 503", fault: { status: 503 }, stored: ["foreign", "acct-1"] },
    {
      name: "applied, reply unreadable",
      fault: { status: 200, text: "{" },
      stored: ["foreign", "acct-1"],
    },
    { name: "never applied", fault: { apply: false }, stored: ["foreign"] },
  ]) {
    await t.test(fault.name, () =>
      withFakeChatGPT(async ({ client, server }) => {
        server.accounts.set("foreign", { name: "lost-sa_x", credentials: new Set() });
        server.faults.push(fault.fault);
        await assert.rejects(
          client.createServiceAccount({ name: "lost-sa_x" }),
          DependencyUnavailableError,
        );
        assert.deepEqual([...server.accounts.keys()], fault.stored);
        assert.deepEqual(
          server.requests.map(({ method }) => method),
          ["POST"],
        );
      }),
    );
  }
});

test("a ChatGPT account delete that applied but answered an error completes on retry", async () => {
  const { ChatGPTServiceAccountDriver } =
    await import("../../apps/controller/src/drivers/service-account/chatgpt.ts");
  await withFakeChatGPT(async ({ client, server, workspaceId }) => {
    server.accounts.set("acct-own", { name: "own", credentials: new Set(["cred-own"]) });
    server.accounts.set("foreign", { name: "foreign", credentials: new Set(["cred-foreign"]) });
    const binding = {
      backendId: "openai",
      driverId: "chatgpt-service-accounts",
      externalAccountId: "acct-own",
      externalCredentialId: "cred-own",
      workspaceId,
    };
    const secrets = new Set(["service-account-own"]);
    const driver = new ChatGPTServiceAccountDriver(
      { id: "openai", drivers: { service_account: "chatgpt-service-accounts" }, client },
      { transact: (work) => work({}) },
      { queryInTransaction: async () => ({ rows: [binding], rowCount: 1 }) },
      {
        async deleteServiceAccountCredential({ secretRef }) {
          secrets.delete(secretRef.name);
        },
      },
    );
    const account = {
      id: "sa_own",
      namespaceId: "ns_own",
      name: "own",
      credential: { kind: "access_token", secretRef: { name: "service-account-own", key: "t" } },
    };
    // Revocation applied, then the account deletion applied but its reply was lost: OCC
    // rolls its records back and the provider account cannot be recreated.
    server.faults.push({}, { lost: true });
    await assert.rejects(driver.delete(account), DependencyUnavailableError);
    assert.deepEqual([...server.accounts.keys()], ["foreign"]);

    // The retry finds every provider resource already gone and completes.
    await driver.delete(account);
    assert.deepEqual([...server.accounts.keys()], ["foreign"]);
    assert.deepEqual([...server.accounts.get("foreign").credentials], ["cred-foreign"]);
    assert.equal(secrets.size, 0);
  });
});
