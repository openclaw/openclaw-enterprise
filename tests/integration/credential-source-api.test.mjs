import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createOpenShellBackend,
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { OpenShellProviderAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { registerCredentialSourceEndpointCases } from "./credential-source-endpoint-cases.ts";

// Tool source types, the Secret field each takes, and a valid config each starts from.
const SECRET_FIELD = {
  "bearer-token": "token",
  "oauth2-client-credentials": "client_secret",
  "oauth2-refresh-token": "refresh_token",
};
const TOOL_TYPES = Object.keys(SECRET_FIELD);
const OAUTH2_TYPES = TOOL_TYPES.filter((type) => type !== "bearer-token");

const TOOL = { host: "tools.example.test", env_var: "TOOL_TOKEN" };
const ISSUER = { ...TOOL, token_url: "https://issuer.example.test/token", client_id: "occ" };
const toolConfig = (type, config) => ({ ...(type === "bearer-token" ? TOOL : ISSUER), ...config });
// Gateway storage and Compute placement are test doubles. Requests use the real
// Fastify app, authentication, IAM, OCC transactions, and OpenShell Driver.
/**
 * @param {import("node:test").TestContext} t
 * @param {{
 *   toolSources?: boolean,
 *   persistedIam?: boolean,
 *   gateway?: import("../../packages/contracts/src/index.ts").OpenShellBackendConfiguration,
 *   modelProvider?: { protocol: "openai-responses", baseUrl: string },
 *   placement?: ReturnType<typeof createOpenShellBackend>["client"]["placement"]
 * }} [options]
 */
async function fixture(
  t,
  {
    toolSources = false,
    persistedIam = false,
    gateway = { endpoint: "http://127.0.0.1:1" },
    modelProvider,
    placement,
  } = {},
) {
  const providers = new Map();
  const profiles = new Map();
  const mutations = [];
  const key = (workspace, name) => workspace + "/" + name;
  const client = {
    async getProviderProfile(workspace, id) {
      return profiles.get(key(workspace, id));
    },
    async importProviderProfile(workspace, profile) {
      mutations.push("importProfile");
      profiles.set(key(workspace, profile.id), structuredClone(profile));
    },
    async deleteProviderProfile(workspace, id) {
      mutations.push("deleteProfile");
      profiles.delete(key(workspace, id));
    },
    async createProvider(input) {
      const id = key(input.workspace, input.name);
      if (providers.has(id)) {
        throw new OpenShellProviderAlreadyExistsError();
      }
      mutations.push("createProvider");
      providers.set(id, structuredClone(input));
      return providers.get(id);
    },
    async getProvider(workspace, name) {
      return providers.get(key(workspace, name));
    },
    async listProviders(workspace) {
      return [...providers.values()].filter((provider) => provider.workspace === workspace);
    },
    async deleteProvider(workspace, name) {
      mutations.push("deleteProvider");
      providers.delete(key(workspace, name));
    },
    async updateProviderCredentials(workspace, name, credentials) {
      mutations.push("updateProvider");
      providers.get(key(workspace, name)).credentials = structuredClone(credentials);
    },
    close() {},
  };
  const backend = createOpenShellBackend(
    {
      id: "openshell-test",
      type: "openshell",
      configuration: gateway,
      drivers: {
        credential_gateway: "openshell-credentials",
        sandbox: "openshell-sandbox",
        ...(toolSources ? { credential_refresh: "openshell-refresh" } : {}),
      },
    },
    { gatewayClient: client },
  );
  if (placement !== undefined) {
    t.mock.method(backend.client, "placement", placement);
  }
  const driver = new OpenShellCredentialGatewayDriver(
    {
      binaries: ["/app/bin/codex"],
      ...(toolSources ? { toolBinaries: ["/usr/bin/curl"] } : {}),
    },
    {
      id: "openshell-credentials",
      backend,
    },
  );
  const now = Date.parse("2026-10-05T12:00:00Z");
  const computeDriver = {
    ...createDevelopmentComputeDriver({ id: "credential-source-compute" }),
    async resolveSandboxNamespace(namespace) {
      return namespace;
    },
  };
  const secretDriver = createTestSecretDriver();
  const app = await createConsoleAppFixture(t, {
    now: () => new Date(now),
    ...(persistedIam ? { provisionedPeople: [] } : {}),
    computeDriver,
    secretDriver,
  });
  await app.bootstrap();
  app.controller.registerDriver(driver);
  app.controller.selectDriver("credential_gateway", driver.id);
  if (toolSources) {
    const refresh = new OpenShellCredentialRefreshDriver({}, { id: "openshell-refresh", backend });
    app.controller.registerDriver(refresh);
    app.controller.selectDriver("credential_refresh", refresh.id);
  }
  const namespace = await app.createNamespace("credential-test", { ready: true });
  const path = "/namespaces/" + namespace.id + "/credential-sources";
  const secret = await app.createSecret(namespace.id, "model-key", "synthetic-model-key");
  const toolSecret = toolSources
    ? await app.createSecret(namespace.id, "tool-material", "synthetic-tool-material")
    : undefined;
  return {
    ...app,
    driver,
    client,
    providers,
    profiles,
    mutations,
    secretDriver,
    namespace,
    path,
    validate(type, config) {
      return driver.validateSourceConfig({
        type,
        config: type === "openai" ? config : toolConfig(type, config),
      });
    },
    /** No source listed, no Secret value read, nothing written to the gateway. */
    async assertNothingSaved() {
      assert.deepEqual((await app.request("GET", path)).data, []);
      assert.equal(
        secretDriver.calls.some(({ operation }) => operation === "withValue"),
        false,
      );
      assert.deepEqual(mutations, []);
      assert.equal(providers.size, 0);
      assert.equal(profiles.size, 0);
    },
    /** A source stored before a rule existed, with its provider, as an older release left it. */
    seedStored(type, config) {
      const stored = {
        id: "cs_" + randomUUID(),
        namespaceId: namespace.id,
        name: `Stored ${type}`,
        type,
        config: type === "openai" ? config : toolConfig(type, config),
        secrets:
          type === "openai" ? { api_key: secret.ref } : { [SECRET_FIELD[type]]: toolSecret.ref },
        ownerCapability: /** @type {const} */ ("credential_gateway"),
        driverId: driver.id,
        state: /** @type {const} */ ("ready"),
        createdAt: new Date(now - 71_000).toISOString(),
      };
      const workspace = openShellWorkspaceName(namespace);
      const name = openShellProviderName(stored.id);
      providers.set(workspace + "/" + name, {
        workspace,
        name,
        type: name,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/credential-source-id": stored.id,
          "openclaw.dev/namespace-id": namespace.id,
        },
        credentials: {},
      });
      return { stored, name, profileKey: workspace + "/" + name };
    },
    /** As seedStored, with the ready OCC record an older release committed. */
    async seedStoredRecord(type, config) {
      const seeded = this.seedStored(type, config);
      await app.controller.transact(async (unit) => {
        await unit.credentialSources.createCredentialSource({
          ...seeded.stored,
          state: "registering",
        });
        await unit.credentialSources.markCredentialSourceReady(namespace.id, seeded.stored.id);
      });
      return seeded;
    },
    /** Attaches stored sources to a new dedicated Codex revision. */
    attach(...sources) {
      return driver.attachForRevision({
        namespace,
        sources,
        revision: {
          harness: {
            id: "codex",
            mode: "dedicated",
            overrides: {},
            configuration: {
              modelProvider: {
                protocol: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                ...modelProvider,
                supportsStandaloneWebSearch: false,
              },
            },
          },
        },
        signal: AbortSignal.timeout(5000),
      });
    },
  };
}

test("canonical Source registration fails closed without a selected TokenService", async (t) => {
  const f = await fixture(t);
  const material = "synthetic-managed-material";
  const refused = await f.request("POST", f.path, {
    body: { name: "Managed", type: "static", secret: { opaque: material } },
  });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(refused.body).includes(material), false);
  await f.assertNothingSaved();

  const member = await f.createNamespaceMember("source-reader", f.namespace.id, [
    ["read", "namespace"],
  ]);
  const session = await f.signIn(member.credentials);
  const before = f.auditSink.events.length;
  const denied = await f.request("POST", f.path, {
    session,
    body: { name: "Denied", type: "static", secret: { opaque: material } },
  });
  assert.equal(denied.status, 403);
  const denials = f.auditSink.events
    .slice(before)
    .filter((event) => event.kind === "authorization_denial");
  assert.deepEqual(
    denials.map((event) => event.authorization),
    [
      {
        principalId: member.principal.id,
        action: "create",
        resource: { kind: "credential_source", id: f.namespace.id, namespaceId: f.namespace.id },
      },
    ],
  );
});

test("historical Source routing records cannot deliver credentials without exact authorization", async (t) => {
  const endpoint = "https://models.example.test/v1";
  const f = await fixture(t, {
    modelProvider: { protocol: "openai-responses", baseUrl: endpoint },
  });
  // Matching the new route does not implicitly authorize converting an old source record.
  const { stored } = await f.seedStoredRecord("openai", { base_url: endpoint });
  const before = [...f.mutations];
  await assert.rejects(f.attach(stored), { name: "StoredCredentialSourceConfigError" });
  assert.deepEqual(f.mutations, before);
});

test("the saved Agent picker and binding use the granted source and the same reviewed release", async (t) => {
  const f = await fixture(t, { toolSources: true, persistedIam: true });
  const { stored: google } = await f.seedStoredRecord("oauth2-refresh-token", {
    token_url: "https://oauth2.googleapis.com/token",
    host: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/messages",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    env_var: "GOG_ACCESS_TOKEN",
  });
  for (const driver of [
    new OCCPluginDriver(),
    createTestKubernetesComputeDriver("plugin-compute"),
  ]) {
    f.controller.registerDriver(driver);
    f.controller.selectDriver(driver.capability, driver.id);
  }
  const { stored: other } = await f.seedStoredRecord("bearer-token", {
    host: "tools.example.test",
    path: "/lookup",
    env_var: "LOOKUP_TOKEN",
  });
  const { stored: sameHost } = await f.seedStoredRecord("oauth2-client-credentials", {
    host: "gmail.googleapis.com",
    port: "8443",
    path: "/different-path",
    env_var: "ANOTHER_TOKEN",
  });
  const agent = await f.createAgent(
    f.namespace.id,
    "Google Agent",
    createHarnessConfiguration("openclaw", "gpt-5"),
    {
      harnessAuth: null,
      executionMode: "dedicated",
      credentialSources: [{ sourceId: google.id }, { sourceId: other.id }],
    },
  );
  const path = `/namespaces/${f.namespace.id}/agents/${agent.id}`;
  const slots = async () =>
    (await f.request("GET", `${path}/plugins/capabilities`)).data.credentialSlots;
  assert.deepEqual((await slots())[0].sources, []);
  const iam = `/namespaces/${f.namespace.id}/iam`;
  const role = await f.request("POST", `${iam}/roles`, {
    body: {
      name: "Read Gmail",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    },
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  for (const source of [google, other, sameHost]) {
    const grant = await f.request("POST", `${iam}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: role.data.id,
        resourceKind: "credential_source",
        resourceId: source.id,
      },
    });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
  }
  const [slot] = await slots();
  assert.deepEqual(slot.sources, [{ id: google.id, name: google.name }]);
  const save = (sourceId, releaseSha256) =>
    f.request("PATCH", path, {
      body: {
        configurationId: agent.configurationId,
        plugins: {
          [slot.pluginId]: {
            enabled: true,
            driverPolicy: { releaseSha256, credentials: { [slot.id]: sourceId } },
          },
        },
      },
    });
  const stale = await save(google.id, "0".repeat(64));
  assert.equal(stale.status, 400, JSON.stringify(stale.body));
  const otherAccount = await save("cs_" + randomUUID(), slot.releaseSha256);
  assert.equal(otherAccount.status, 400, JSON.stringify(otherAccount.body));
  const unsupported = await save(google.id, slot.releaseSha256);
  assert.equal(unsupported.status, 400, JSON.stringify(unsupported.body));
  assert.match(unsupported.body.error.message, /OpenShell Sandbox and Credential Gateway/);
  const sandbox = {
    id: "openshell-placement",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    implementation: "openshell",
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
  f.controller.registerDriver(sandbox);
  f.controller.selectDriver("sandbox", sandbox.id);
  const saved = await save(google.id, slot.releaseSha256);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.data.plugins[slot.pluginId].driverPolicy, {
    releaseSha256: slot.releaseSha256,
    credentials: { account: google.id },
  });
  const conflicting = await f.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      credentialSources: [google, other, sameHost].map(({ id }) => ({ sourceId: id })),
    },
  });
  assert.equal(conflicting.status, 400, JSON.stringify(conflicting.body));
  assert.match(conflicting.body.error.message, /another attached credential.*guarded Google host/);
  const clear = await f.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      plugins: { [slot.pluginId]: { enabled: false } },
    },
  });
  assert.equal(clear.status, 200, JSON.stringify(clear.body));
  assert.deepEqual(clear.data.credentialSources, [{ sourceId: google.id }, { sourceId: other.id }]);
});
test("Installation discovery serializes OpenShell model authentication and refresh source metadata", async (t) => {
  const f = await fixture(t, { toolSources: true });
  // The real Driver advertises model login and OAuth2 refresh sources. The Installation
  // response must carry that catalog through Fastify serialization for Console discovery.
  const response = await f.request("GET", "/installation");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const types = response.data.capabilities.credentialSources.types;
  assert.deepEqual(
    types
      .filter(({ harnessAuth }) => harnessAuth)
      .map(({ type, harnessAuth }) => ({
        type,
        ...harnessAuth,
      })),
    [
      { type: "codex-oauth", modelProvider: "openai", loginMode: "chatgptAuthTokens" },
      { type: "openai", modelProvider: "openai", loginMode: "api_key" },
      { type: "codex-pat", modelProvider: "openai", loginMode: "codex_pat" },
    ],
  );
  assert.deepEqual(types.find(({ type }) => type === "codex-oauth")?.deviceAuthorization, {
    harnessId: "codex",
  });
  for (const type of OAUTH2_TYPES) {
    assert.equal(types.find((entry) => entry.type === type)?.rotation, "refresh", type);
  }
  const refreshToken = types
    .find(({ type }) => type === "oauth2-refresh-token")
    ?.secrets.find(({ name }) => name === "refresh_token");
  assert.equal(refreshToken?.required, true);
  assert.equal(refreshToken?.issuerRotated, true);
  assert.deepEqual(f.mutations, []);
});

registerCredentialSourceEndpointCases({
  fixture,
  toolTypes: TOOL_TYPES,
  oauth2Types: OAUTH2_TYPES,
});

test("OAuth2 token_url is stored as parsed", async (t) => {
  const f = await fixture(t, { toolSources: true });
  for (const [written, stored] of [
    ["https://Login.Example.test:443/oauth2/token", "https://login.example.test/oauth2/token"],
    ["https://login.example.test", "https://login.example.test/"],
    ["https://login.example.test/a/../token", "https://login.example.test/token"],
    // Already as parsed: the written config is stored.
    ["https://login.example.test/oauth2/token", undefined],
  ]) {
    assert.deepEqual(
      f.validate("oauth2-client-credentials", { token_url: written }),
      stored === undefined ? undefined : { ...ISSUER, token_url: stored },
      written,
    );
  }
});
