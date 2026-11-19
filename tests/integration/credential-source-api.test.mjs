import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Check } from "typebox/value";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";

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
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
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
/**
 * A save refused for one config field: HTTP 400 naming only that field, and its message.
 * @param {{status: number, body: unknown}} response
 * @param {string} field
 * @param {string | RegExp} [message]
 * @param {string} [label]
 */
function assertRefused(response, field, message, label = field) {
  assert.equal(response.status, 400, label + " " + JSON.stringify(response.body));
  const body = response.body;
  assert.ok(Check(ErrorResponse, body), label + " invalid error response");
  assert.equal(body.error.code, "INVALID_REQUEST", label);
  assert.deepEqual(
    body.error.details,
    [{ path: "/config/" + field, code: "INVALID_VALUE" }],
    label,
  );
  if (typeof message === "string") {
    assert.equal(body.error.message, message, label);
  } else if (message !== undefined) {
    assert.match(body.error.message, message, label);
  }
}

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
  let now = Date.parse("2026-10-05T12:00:00Z");
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
  const create = (name, config = {}) =>
    app.request("POST", path, {
      body: { name, type: "openai", config, secrets: { api_key: secret.ref } },
    });
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
    create,
    passRegistrationFence() {
      now += 71_000;
    },
    async seedInvalid(type = "openai", baseUrl = "http://") {
      // Reproduce invalid persisted configuration beyond the registration fence.
      // Each case decides whether the remote provider is absent or still present.
      const source = {
        id: "cs_" + randomUUID(),
        namespaceId: namespace.id,
        name: "invalid-" + randomUUID(),
        type,
        config: { authorized_base_url: baseUrl },
        secrets: { api_key: secret.ref },
        ownerCapability: "credential_gateway",
        driverId: driver.id,
        state: "registering",
        createdAt: new Date(now - 71_000).toISOString(),
      };
      await app.controller.transact(async (unit) => {
        await unit.credentialSources.createCredentialSource(source);
        await unit.credentialSources.markCredentialSourceDeleting(namespace.id, source.id);
      });
      return source;
    },
    /** A tool source create body, with `config` over the type's valid config. */
    toolBody(type, config, name = "tool") {
      return {
        name,
        type,
        config: toolConfig(type, config),
        secrets: { [SECRET_FIELD[type]]: toolSecret.ref },
      };
    },
    /** Saves a tool source through the API, with `config` over the type's valid config. */
    saveTool(type, config, name = "tool") {
      return app.request("POST", path, { body: this.toolBody(type, config, name) });
    },
    validate(type, config) {
      return driver.validateSourceConfig({ type, config: toolConfig(type, config) });
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
    /** Replaces a stored source's Secret through the API, as a caller rotating its value does. */
    replaceSecret(stored) {
      return app.request("PATCH", path + "/" + stored.id, { body: { secrets: stored.secrets } });
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

test("source API rejects routing inputs and registers independently authorized destinations", async (t) => {
  const endpoint = "https://models.example.test/v1";
  const f = await fixture(t, {
    modelProvider: { protocol: "openai-responses", baseUrl: endpoint },
  });
  // Neither an old routing field nor permission to use a default-provider key selects a route.
  assertRefused(await f.create("routing", { base_url: endpoint }), "base_url", /has no field/);
  // Schema validation runs before catalog lookup and must escape the submitted key as one segment.
  assertRefused(await f.create("invalid field", { "bad/key~name": "x" }), "bad~1key~0name");
  await f.assertNothingSaved();
  assert.equal((await f.create("default")).status, 201);
  assert.equal(
    (await f.create("other", { authorized_base_url: "https://other.example.test/v1" })).status,
    201,
  );
  const created = await f.create("authorized", { authorized_base_url: endpoint });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const profile = [...f.profiles.values()].find(
    (profile) => profile.id === openShellProviderName(created.data.id),
  );
  assert.deepEqual(profile.endpoints, [
    { host: "models.example.test", port: 443, protocol: "rest", path: "/v1/**" },
  ]);
});

test("credential source deletion identifies its registration fence without parsing the message", async (t) => {
  const f = await fixture(t);
  const created = await f.create("recent source");
  assert.equal(created.status, 201);
  const path = f.path + "/" + created.data.id;

  // Retry guidance is returned only after the source's authorization and lookup.
  const denied = await f.request("DELETE", path, { session: null });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.reason, undefined);
  assert.equal(denied.headers.get("retry-after"), null);

  // Removal cannot discard the record while a late Gateway registration could still complete.
  const pending = await f.request("DELETE", path);
  assert.equal(pending.status, 503);
  assert.equal(pending.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(pending.body.error.reason, "credential_registration_pending");
  assert.equal(pending.headers.get("retry-after"), "70");
  assert.equal((await f.request("GET", path)).data.state, "deleting");

  // This is the same source and supported retry, after its real controller fence expires.
  f.passRegistrationFence();
  const deleted = await f.request("DELETE", path);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.headers.get("retry-after"), null);
  const absent = await f.request("GET", path);
  assert.equal(absent.status, 404);
  assert.equal(absent.body.error.reason, undefined);
  assert.equal(absent.headers.get("retry-after"), null);
});

test("old source routing records cannot deliver credentials and remain readable and removable", async (t) => {
  const endpoint = "https://models.example.test/v1";
  const f = await fixture(t, {
    modelProvider: { protocol: "openai-responses", baseUrl: endpoint },
  });
  // Matching the new route does not implicitly authorize converting an old source record.
  const { stored } = await f.seedStoredRecord("openai", { base_url: endpoint });
  const before = [...f.mutations];
  await assert.rejects(f.attach(stored), { name: "StoredCredentialSourceConfigError" });
  const replacement = await f.replaceSecret(stored);
  assert.equal(replacement.status, 409);
  assert.deepEqual(f.mutations, before);
  assert.equal((await f.request("GET", f.path + "/" + stored.id)).status, 200);
  f.passRegistrationFence();
  assert.equal((await f.request("DELETE", f.path + "/" + stored.id)).status, 204);
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

test("credential source HTTP admission rejects invalid endpoints without retaining records", async (t) => {
  const f = await fixture(t);
  for (const authorized_base_url of [
    "http://",
    "https://models.example.test",
    "http://models.example.test/v1",
    "https://models.example.test/*/v1",
    "https://**/v1",
    "https://*.example.test/v1",
    "https://ex*ample.test/v1",
    "https://%2a%2A/v1",
    "https://%2A.example.test/v1",
    "https://ex%2aample.test/v1",
    "https://＊.example.test/v1",
    // OpenShell's hostname matcher rejects empty labels and brace patterns.
    "https://models.example.test./v1",
    "https://models..example.test/v1",
    "https://{a,b}.example.test/v1",
    "https://{models}.example.test/v1",
    "https://%7Bmodels%7D.example.test/v1",
    "https://models.example.test:0/v1",
    "https://models.example.test:000/v1",
    // URI-valid IPv6 brackets would be character classes in OpenShell host patterns.
    "https://[2001:db8::1]/v1",
    "https://[::1]/v1",
    "https://models.example.test/v1?option=value",
    "https://models.example.test/v1#fragment",
  ]) {
    const response = await f.create("invalid", { authorized_base_url });
    // Assert absence independently of the status: the original bug left a deleting row.
    assert.deepEqual((await f.request("GET", f.path)).data, [], authorized_base_url);
    assertRefused(response, "authorized_base_url", /HTTPS.*\/v1/, authorized_base_url);
    if (authorized_base_url.startsWith("https://[")) {
      assert.match(response.body.error.message, /bracketed IPv6 hosts.*unsupported/);
    }
  }
  await f.assertNothingSaved();
});

test("credential source HTTP deletion uses source ownership even with an invalid stored endpoint", async (t) => {
  const f = await fixture(t);
  const healthy = await f.create("healthy");
  assert.equal(healthy.status, 201, JSON.stringify(healthy.body));
  const profilesBefore = structuredClone([...f.profiles]);
  for (const baseUrl of ["http://", "https://**/v1", "https://[2001:db8::1]/v1"]) {
    const source = await f.seedInvalid("openai", baseUrl);
    const path = f.path + "/" + source.id;
    const read = await f.request("GET", path);
    assert.equal(read.status, 200);
    assert.equal(read.data.status.state, "absent");
    assert.equal((await f.request("DELETE", path)).status, 204);
    assert.equal((await f.request("GET", path)).status, 404);
    assert.deepEqual([...f.profiles], profilesBefore);
  }
  assert.equal((await f.request("GET", f.path + "/" + healthy.data.id)).data.status.state, "ready");

  // Labels alone do not prove ownership if the provider points to another source's profile.
  for (const baseUrl of ["https://**/v1", "https://[2001:db8::1]/v1"]) {
    const collision = await f.seedInvalid("openai", baseUrl);
    const existing = [...f.providers.values()][0];
    const foreign = {
      ...existing,
      name: openShellProviderName(collision.id),
      labels: { ...existing.labels, "openclaw.dev/credential-source-id": collision.id },
    };
    f.providers.set(foreign.workspace + "/" + foreign.name, foreign);
    const collisionPath = f.path + "/" + collision.id;
    assert.equal((await f.request("GET", collisionPath)).data.status.state, "failed");
    assert.notEqual((await f.request("DELETE", collisionPath)).status, 204);
    assert.equal((await f.request("GET", collisionPath)).data.state, "deleting");
    assert.ok([...f.providers.values()].includes(foreign));
    assert.deepEqual([...f.profiles], profilesBefore);
  }

  const unknown = await f.seedInvalid("unknown");
  assert.notEqual((await f.request("DELETE", f.path + "/" + unknown.id)).status, 204);
  assert.equal((await f.request("GET", f.path + "/" + unknown.id)).data.state, "deleting");
});

test("OpenShell credentials authorized for one provider keep independent ownership and lifecycle", async (t) => {
  const endpoint = "https://models.example.test:8443/api/v1";
  let placementCalls = 0;
  const f = await fixture(t, {
    modelProvider: { protocol: "openai-responses", baseUrl: endpoint },
    placement() {
      placementCalls += 1;
      throw new Error("Model profiles must not resolve gateway placement.");
    },
  });
  const standard = await f.create("first", { authorized_base_url: endpoint });
  const custom = await f.create("custom", {
    authorized_base_url: "https://MODELS.example.test:8443/api/v1/",
  });
  const shared = await f.create("shared", {
    authorized_base_url: "https://models.example.test:8443/api/v1",
  });
  assert.equal(placementCalls, 0, "static registration must not resolve Gateway placement");
  for (const result of [standard, custom, shared]) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.data.status.state, "ready");
    assert.equal(
      (await f.request("GET", f.path + "/" + result.data.id)).data.status.state,
      "ready",
    );
  }
  const customProfile = [...f.profiles.values()].find(
    (profile) => profile.id === openShellProviderName(custom.data.id),
  );
  assert.equal(f.profiles.size, 3);
  assert.notEqual(customProfile.id, openShellProviderName(shared.data.id));
  assert.deepEqual(customProfile.endpoints, [
    { host: "models.example.test", port: 8443, protocol: "rest", path: "/api/v1/**" },
  ]);
  assert.deepEqual(customProfile.binaries, ["/app/bin/codex"]);
  const provider = [...f.providers.values()].find(
    (row) => row.name === openShellProviderName(custom.data.id),
  );
  const source = await f.controller.transact((unit) =>
    unit.credentialSources.findCredentialSource(f.namespace.id, custom.data.id),
  );
  assert.deepEqual(provider.credentials, { OPENAI_API_KEY: "synthetic-model-key" });
  const replacement = await f.createSecret(
    f.namespace.id,
    "replacement-model-key",
    "synthetic-replacement-model-key",
  );
  const updated = await f.replaceSecret({
    ...source,
    secrets: { api_key: replacement.ref },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.data.status.state, "ready");
  assert.ok(f.mutations.includes("updateProvider"));
  assert.deepEqual(provider.credentials, { OPENAI_API_KEY: "synthetic-replacement-model-key" });
  assert.equal((await f.request("GET", f.path + "/" + source.id)).data.status.state, "ready");
  assert.equal(placementCalls, 0);
  const context = {
    namespace: { ...f.namespace, name: provider.workspace },
    source,
    signal: AbortSignal.timeout(5000),
  };
  // Native inference uses the source's exact endpoint, including a custom prefix.
  const nativeRevision = {
    harness: {
      id: "openclaw",
      mode: "dedicated",
      overrides: {},
      configuration: {
        modelProvider: {
          protocol: "openai-responses",
          baseUrl: endpoint,
          supportsStandaloneWebSearch: false,
        },
      },
    },
    configuration: {
      agents: { defaults: { model: "openai/model" } },
      models: {
        providers: {
          openai: { baseUrl: custom.data.config.authorized_base_url, models: [{ id: "model" }] },
        },
      },
    },
  };
  const attachNative = (change) => {
    const revision = structuredClone(nativeRevision);
    change(revision.configuration);
    return f.driver.attachForRevision({ ...context, sources: [source], revision });
  };
  assert.deepEqual(await attachNative(() => {}), [
    { sourceId: custom.data.id, ref: provider.name },
  ]);
  // The written endpoint is compared after normalization, as Compute renders it.
  assert.deepEqual(
    await attachNative((configuration) => {
      configuration.models.providers.openai.baseUrl = "https://MODELS.example.test:8443/api/v1/";
    }),
    [{ sourceId: custom.data.id, ref: provider.name }],
  );
  // Compute renders only the selected models into the native worker's catalog, so an
  // unselected entry for another endpoint gets no traffic and does not block the deployment
  // (finding 1686).
  assert.deepEqual(
    await attachNative((configuration) => {
      configuration.models.providers.openai.models.push({
        id: "unselected",
        baseUrl: "https://other.example.test/v1",
      });
    }),
    [{ sourceId: custom.data.id, ref: provider.name }],
  );
  // Default provider metadata is translated, including model-level default URLs.
  assert.deepEqual(
    await attachNative((configuration) => {
      configuration.models.providers.openai.baseUrl = "https://api.openai.com/v1";
      configuration.models.providers.openai.models[0].baseUrl = "https://api.openai.com/v1";
    }),
    [{ sourceId: custom.data.id, ref: provider.name }],
  );
  // Selected model, provider, fallback and roster destinations cannot override the shared route.
  for (const change of [
    (configuration) => {
      configuration.models.providers.openai.models[0].baseUrl = "https://other.example.test/v1";
    },
    (configuration) => {
      configuration.models.providers.openai.baseUrl = "https://models.example.test:8443/v1";
    },
    (configuration) => {
      configuration.models.providers.openai.baseUrl = "https://models.example.test/api/v1";
    },
    (configuration) => {
      configuration.agents.defaults.model = {
        primary: "openai/model",
        fallbacks: ["openai/fallback"],
      };
      configuration.models.providers.openai.models.push({
        id: "fallback",
        baseUrl: "https://other.example.test/v1",
      });
    },
    (configuration) => {
      configuration.agents.entries = { helper: { model: "openai/helper" } };
      configuration.models.providers.openai.models.push({
        id: "helper",
        baseUrl: "https://other.example.test/v1",
      });
    },
  ]) {
    await assert.rejects(
      attachNative(change),
      /OpenAI model baseUrl must match the resolved Harness/,
    );
  }
  // A shape Compute refuses before deployment stays refused here, without naming a setting.
  for (const change of [
    (configuration) => {
      delete configuration.agents;
    },
    (configuration) => {
      configuration.models.providers.openai.models = [{ id: "another" }];
    },
    // OpenClaw merges rows whose ids match after trimming, so this unselected row would give
    // the selected model its endpoint.
    (configuration) => {
      configuration.models.providers.openai.models.push({
        id: " model",
        baseUrl: "https://other.example.test/v1",
      });
    },
  ]) {
    await assert.rejects(attachNative(change), {
      message:
        "Dedicated native OpenClaw model endpoints must match the bound credential source endpoint.",
    });
  }
  assert.deepEqual(
    await f.driver.attachForRevision({
      ...context,
      sources: [source],
      revision: {
        harness: {
          id: "codex",
          mode: "dedicated",
          overrides: {},
          configuration: {
            modelProvider: {
              protocol: "openai-responses",
              baseUrl: endpoint,
              supportsStandaloneWebSearch: false,
            },
          },
        },
      },
    }),
    [{ sourceId: custom.data.id, ref: provider.name }],
  );
  assert.equal(placementCalls, 0);
  provider.type = "oce-openai";
  assert.equal((await f.request("GET", f.path + "/" + custom.data.id)).data.status.state, "failed");
  await assert.rejects(
    f.driver.registerSource(context, {
      type: "openai",
      config: custom.data.config,
      secrets: { api_key: "synthetic-model-key" },
    }),
    /not owned/,
  );
  await assert.rejects(f.driver.removeSource(context), /not owned/);
  provider.type = customProfile.id;
  assert.equal((await f.request("PATCH", f.path + "/" + custom.data.id, { body: {} })).status, 200);
  f.passRegistrationFence();
  assert.equal((await f.request("DELETE", f.path + "/" + custom.data.id)).status, 204);
  assert.equal(f.profiles.size, 2);
  assert.ok(
    [...f.profiles.values()].some(
      (profile) => profile.id === openShellProviderName(shared.data.id),
    ),
  );
  assert.equal((await f.request("DELETE", f.path + "/" + shared.data.id)).status, 204);
  assert.deepEqual(
    [...f.profiles.values()].map((profile) => profile.id),
    [openShellProviderName(standard.data.id)],
  );
  assert.equal(
    (await f.request("GET", f.path + "/" + standard.data.id)).data.status.state,
    "ready",
  );
  assert.equal((await f.request("DELETE", f.path + "/" + standard.data.id)).status, 204);
  assert.equal(f.profiles.size, 0);
  assert.equal(f.providers.size, 0);
});

registerCredentialSourceEndpointCases({
  fixture,
  assertRefused,
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

test("offered OpenShell source values return field-specific HTTP 400 before effects", async (t) => {
  const f = await fixture(t, { toolSources: true });
  // Use each offered type through real API/OCC/Driver admission. Only the value is
  // invalid: catalog fields and Secret references are valid, so this must not be a 404.
  for (const [type, field, value] of [
    ["bearer-token", "host", "*.example.test"],
    ["bearer-token", "port", "0"],
    ["bearer-token", "path", "relative"],
    ["bearer-token", "env_var", "PATH"],
    ["oauth2-client-credentials", "token_url", "http://issuer.example.test/token"],
    ["oauth2-client-credentials", "client_id", "not visible"],
    ["oauth2-client-credentials", "scope", "read\twrite"],
    ["oauth2-refresh-token", "env_var", "OPENAI_API_KEY"],
  ]) {
    await t.test(type + ": " + field, async () => {
      assert.ok(field, "Each refusal case must name the invalid config field.");
      const response = await f.saveTool(type, { [field]: value }, "invalid-" + field);
      assert.deepEqual((await f.request("GET", f.path)).data, []);
      assertRefused(response, field);
    });
  }
  const unavailable = await f.request("POST", f.path, {
    body: { name: "unoffered", type: "not-offered", config: {}, secrets: {} },
  });
  assert.equal(unavailable.status, 409, JSON.stringify(unavailable.body));
  await f.assertNothingSaved();
});
