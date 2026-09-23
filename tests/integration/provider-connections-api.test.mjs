import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

test("provider setup admits API-key and local connections and rejects unsupported authentication methods", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provider setup", { ready: true });
  const base = `/namespaces/${namespace.id}/provider-connections`;
  const catalog = await fixture.request("GET", "/provider-catalog");
  assert.equal(catalog.status, 200);
  assert.deepEqual(
    catalog.data.map(({ id, authMethods }) => [id, authMethods.map((method) => method.id)]),
    [
      ["openai", ["api-key"]],
      ["anthropic", ["api-key"]],
      ["ollama", ["local"]],
      ["vllm", ["custom"]],
    ],
  );

  const secret = await fixture.createSecret(namespace.id, "Model key", "synthetic-provider-key");
  const created = await fixture.request("POST", base, {
    body: {
      name: "Team OpenAI",
      providerId: "openai",
      authMethodId: "api-key",
      source: secret.ref,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.data.source, secret.ref);
  assert.doesNotMatch(JSON.stringify(created.body), /synthetic-provider-key|backendRef/);
  const binding = { method: "provider_connection", connectionId: created.data.id };
  const agent = await fixture.createAgent(
    namespace.id,
    "Connected Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
    { harnessAuth: binding },
  );

  // Connection visibility does not authorize consumption. The Agent needs both
  // the connection grant and its underlying Secret grant before admission.
  const deployPath = `/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  assert.equal((await fixture.request("POST", deployPath)).status, 403);
  fixture.policy.identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: namespace.id,
    agentId: agent.id,
  });
  fixture.policy.roles.push({
    id: "provider-consumer",
    namespaceId: namespace.id,
    permissions: [
      { action: "operate", resourceKind: "provider_connection" },
      { action: "operate", resourceKind: "secret" },
    ],
  });
  for (const [resourceKind, resourceId] of [
    ["provider_connection", created.data.id],
    ["secret", secret.id],
  ]) {
    fixture.policy.bindings.push({
      id: `consume-${resourceKind}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: "provider-consumer",
      resourceKind,
      resourceId,
    });
  }
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  assert.deepEqual(revision.harnessAuth, binding);
  assert.equal((await fixture.request("DELETE", `${base}/${created.data.id}`)).status, 409);
  assert.equal(
    (await fixture.request("DELETE", `/namespaces/${namespace.id}/secrets/${secret.id}`)).status,
    409,
  );

  const historical = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${revision.id}`,
  );
  assert.deepEqual(historical.data.harnessAuth, binding);

  // The public catalog is closed: setup cannot admit a hidden native method.
  for (const body of [
    { name: "Unknown", providerId: "openai", authMethodId: "arbitrary-command" },
    ...["oauth", "device-code", "token-sharing"].map((authMethodId) => ({
      name: "Unsupported OpenAI authentication",
      providerId: "openai",
      authMethodId,
    })),
    { name: "Unsupported Claude token", providerId: "anthropic", authMethodId: "setup-token" },
    {
      name: "Injected token",
      providerId: "openai",
      authMethodId: "api-key",
      accessToken: "synthetic-token",
    },
    {
      name: "Wrong source",
      providerId: "ollama",
      authMethodId: "local",
      baseUrl: "http://models.example.test:11434",
      source: secret.ref,
    },
  ]) {
    assert.equal(
      (await fixture.request("POST", base, { body })).status,
      Object.hasOwn(body, "accessToken") ? 400 : 404,
    );
  }
  const local = await fixture.request("POST", base, {
    body: {
      name: "Local server",
      providerId: "ollama",
      authMethodId: "local",
      baseUrl: "http://models.example.test:11434",
    },
  });
  assert.equal(local.status, 201);
  assert.equal((await fixture.request("DELETE", `${base}/${local.data.id}`)).status, 204);
  assert.equal((await fixture.request("GET", base)).data.length, 1);
});

test("provider connection lookup, source selection, and consumption cannot cross Namespaces", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha connections", { ready: true });
  const beta = await fixture.createNamespace("Beta connections", { ready: true });
  const secret = await fixture.createSecret(alpha.id, "Alpha key", "synthetic-alpha-key");
  const body = {
    name: "Alpha provider",
    providerId: "openai",
    authMethodId: "api-key",
    source: secret.ref,
  };
  const base = `/namespaces/${alpha.id}/provider-connections`;
  const created = await fixture.request("POST", base, { body });
  assert.equal(created.status, 201);
  assert.equal(
    (await fixture.request("POST", `/namespaces/${beta.id}/provider-connections`, { body })).status,
    404,
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${beta.id}/provider-connections/${created.data.id}`))
      .status,
    404,
  );

  const limited = await fixture.createAccountWithPolicy("connection-no-permissions", () => {});
  const session = await fixture.signIn(limited.credentials);
  assert.deepEqual((await fixture.request("GET", base, { session })).data, []);
  assert.equal(
    (await fixture.request("GET", `${base}/${created.data.id}`, { session })).status,
    403,
  );
  assert.equal((await fixture.request("POST", base, { body, session })).status, 403);
  assert.equal(
    (await fixture.request("DELETE", `${base}/${created.data.id}`, { session })).status,
    403,
  );
});

test("provider setup creates its credential atomically and never returns or audits its value", async (t) => {
  const driver = createTestSecretDriver();
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const fixture = await createConsoleAppFixture(t, { secretDriver: driver, state });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential setup", { ready: true });
  const path = `/namespaces/${namespace.id}/provider-connections`;
  const secretValue = "synthetic-provider-credential";
  const body = {
    name: "New model key",
    providerId: "openai",
    authMethodId: "api-key",
    secretValue,
  };
  const response = await fixture.request("POST", path, { body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(driver.valueFor(response.data.source), secretValue);
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /synthetic-provider-credential|secretValue|backendRef/,
  );
  const persisted = await state.read((view) =>
    view.providerConnections.findProviderConnection(namespace.id, response.data.id),
  );
  assert.equal(Object.hasOwn(persisted, "secretValue"), false);
  assert.equal(
    audit.events.filter((event) => event.action === "openclaw.secrets.create").length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(audit.events), /synthetic-provider-credential/);

  // Duplicate configuration rejects the transaction and removes only its newly-created Secret.
  const conflict = await fixture.request("POST", path, { body });
  assert.equal(conflict.status, 409);
  const creates = driver.calls.filter((call) => call.operation === "create");
  assert.equal(creates.length, 2);
  assert.equal(driver.has(creates[0].identity), true);
  assert.equal(driver.has(creates[1].identity), false);
  assert.equal(
    await state.read((view) => view.secrets.findSecret(namespace.id, creates[1].identity.id)),
    undefined,
  );
  assert.equal(
    audit.events.filter((event) => event.action === "openclaw.secrets.create").length,
    1,
  );

  for (const invalid of [
    { ...body, name: "Mixed credential", source: response.data.source },
    { ...body, name: "Local credential", providerId: "ollama", authMethodId: "local" },
  ]) {
    assert.equal((await fixture.request("POST", path, { body: invalid })).status, 404);
  }
  assert.equal(driver.calls.filter((call) => call.operation === "create").length, 2);
  const limited = await fixture.createAccountWithPolicy(
    "provider-without-secret-create",
    (principal) => {
      fixture.policy.roles.push({
        id: "connection-creator",
        namespaceId: namespace.id,
        permissions: [
          { action: "create", resourceKind: "provider_connection" },
          { action: "operate", resourceKind: "secret" },
        ],
      });
      fixture.policy.bindings.push({
        id: "connection-creator-binding",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "connection-creator",
      });
    },
  );
  const session = await fixture.signIn(limited.credentials);
  const denied = await fixture.request("POST", path, {
    session,
    body: { ...body, name: "Unauthorized new Secret" },
  });
  assert.equal(denied.status, 403);
  assert.equal(driver.calls.filter((call) => call.operation === "create").length, 2);
});

test("Anthropic API-key connections admit embedded revisions with private Secret custody", async (t) => {
  const state = new InMemoryPlatformState();
  const fixture = await createConsoleAppFixture(t, { state });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Anthropic agents", { ready: true });
  fixture.policy.roles.push({
    id: "anthropic-consumer",
    namespaceId: namespace.id,
    permissions: [
      { action: "operate", resourceKind: "provider_connection" },
      { action: "operate", resourceKind: "secret" },
    ],
  });
  const authMethodId = "api-key";
  const connection = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/provider-connections`,
    {
      body: {
        name: `Claude ${authMethodId}`,
        providerId: "anthropic",
        authMethodId,
        secretValue: `synthetic-${authMethodId}`,
      },
    },
  );
  assert.equal(connection.status, 201);
  const model = "claude-sonnet-4-5";
  const modelRef = `anthropic/${model}`;
  const configuration = createHarnessConfiguration("openclaw", model);
  configuration.agents.defaults.model = modelRef;
  configuration.agents.defaults.models = { [modelRef]: { agentRuntime: { id: "openclaw" } } };
  configuration.models.providers = {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      models: [{ id: model, name: model }],
    },
  };
  const binding = { method: "provider_connection", connectionId: connection.data.id };
  const agent = await fixture.createAgent(namespace.id, `Claude ${authMethodId}`, configuration, {
    harnessAuth: binding,
  });
  fixture.policy.identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: namespace.id,
    agentId: agent.id,
  });
  fixture.policy.bindings.push({
    id: `grant-${authMethodId}`,
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: "anthropic-consumer",
  });
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  assert.deepEqual(revision.harnessAuth, binding);
  const admitted = await state.read((view) =>
    view.revisions.findRevision(namespace.id, agent.id, revision.id),
  );
  assert.deepEqual(admitted.harnessAuth, {
    method: "provider_connection",
    connection: { id: connection.data.id, providerId: "anthropic", authMethodId },
    credential: { source: connection.data.source, secretDriverId: "console-secret" },
  });
});
