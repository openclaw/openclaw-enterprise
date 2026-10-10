import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { OpenShellProviderAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

// Gateway storage and Compute placement are test doubles. Requests use the real
// Fastify app, authentication, IAM, OCC transactions, and OpenShell Driver.
async function fixture(t, { toolSources = false } = {}) {
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
    async updateProviderProfile(workspace, profile) {
      mutations.push("updateProfile");
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
      configuration: { endpoint: "http://127.0.0.1:1" },
      drivers: {
        credential_gateway: "openshell-credentials",
        sandbox: "openshell-sandbox",
        ...(toolSources ? { credential_refresh: "openshell-refresh" } : {}),
      },
    },
    { gatewayClient: client },
  );
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
        config: { base_url: baseUrl },
        secrets: { api_key: secret.ref },
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
  };
}

test("credential source HTTP admission rejects invalid endpoints without retaining records", async (t) => {
  const f = await fixture(t);
  for (const base_url of [
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
    "https://models.example.test:0/v1",
    "https://models.example.test:000/v1",
    // URI-valid IPv6 brackets would be character classes in OpenShell host patterns.
    "https://[2001:db8::1]/v1",
    "https://[::1]/v1",
    "https://models.example.test/v1?option=value",
    "https://models.example.test/v1#fragment",
  ]) {
    const response = await f.create("invalid", { base_url });
    // Assert absence independently of the status: the original bug left a deleting row.
    assert.deepEqual((await f.request("GET", f.path)).data, [], base_url);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.deepEqual(response.body.error.details, [
      { path: "/config/base_url", code: "INVALID_VALUE" },
    ]);
    assert.match(response.body.error.message, new RegExp("HTTPS.*/v1"));
    if (base_url.startsWith("https://[")) {
      assert.match(response.body.error.message, /bracketed IPv6 hosts.*unsupported/);
    }
  }
  assert.equal(
    f.secretDriver.calls.some(({ operation }) => operation === "withValue"),
    false,
  );
  assert.deepEqual(f.mutations, []);
  assert.equal(f.providers.size, 0);
  assert.equal(f.profiles.size, 0);
});

test("credential source HTTP deletion recovers invalid stored endpoints without touching profiles", async (t) => {
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

  // An unexpected remote resource is not evidence of absence. Even source labels
  // cannot prove its profile from an invalid endpoint; preserve both objects.
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

test("OpenShell custom and default credential profiles keep independent ownership and lifecycle", async (t) => {
  const f = await fixture(t);
  const standard = await f.create("default");
  const custom = await f.create("custom", { base_url: "https://MODELS.example.test:8443/api/v1/" });
  const shared = await f.create("shared", { base_url: "https://models.example.test:8443/api/v1" });
  for (const result of [standard, custom, shared]) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.data.status.state, "ready");
    assert.equal(
      (await f.request("GET", f.path + "/" + result.data.id)).data.status.state,
      "ready",
    );
  }
  const customProfile = [...f.profiles.values()].find((profile) => profile.id !== "oce-openai");
  assert.equal(f.profiles.size, 2);
  assert.match(customProfile.id, /^oce-openai-[0-9a-f]{12}$/);
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
  const context = {
    namespace: { ...f.namespace, name: provider.workspace },
    source,
    signal: AbortSignal.timeout(5000),
  };
  // Native OpenClaw cannot use a custom endpoint. Codex can attach only the source's profile.
  await assert.rejects(
    f.driver.attachForRevision({
      ...context,
      sources: [source],
      revision: { harness: { id: "openclaw", mode: "dedicated" } },
    }),
    /default OpenAI endpoint/,
  );
  assert.deepEqual(
    await f.driver.attachForRevision({
      ...context,
      sources: [source],
      revision: { harness: { id: "codex", mode: "dedicated" } },
    }),
    [{ sourceId: custom.data.id, ref: provider.name }],
  );
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
  assert.equal(f.profiles.size, 2, "another source still needs the custom profile");
  assert.equal((await f.request("DELETE", f.path + "/" + shared.data.id)).status, 204);
  assert.deepEqual(
    [...f.profiles.values()].map((profile) => profile.id),
    ["oce-openai"],
  );
  assert.equal(
    (await f.request("GET", f.path + "/" + standard.data.id)).data.status.state,
    "ready",
  );
  assert.equal((await f.request("DELETE", f.path + "/" + standard.data.id)).status, 204);
  assert.equal(f.profiles.size, 0);
  assert.equal(f.providers.size, 0);
});

test("concrete credential source endpoints retain normalized profile scope", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["https://models.example.test/v1", "models.example.test", 443, "/v1/**"],
    ["https://MODELS.example.test:443/api/./v1/", "models.example.test", 443, "/api/v1/**"],
    ["https://bücher.example.test:8443/api/v1/", "xn--bcher-kva.example.test", 8443, "/api/v1/**"],
    ["https://192.0.2.1/v1", "192.0.2.1", 443, "/v1/**"],
    ["https://API.OpenAI.com:443/v1/", "api.openai.com", 443, "/v1/**"],
  ];
  for (const [base_url, host, port, path] of cases) {
    const created = await f.create("concrete endpoint", { base_url });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // Assert the profile produced through HTTP/OCC, not a copied normalizer.
    const profile = [...f.profiles.values()][0];
    assert.deepEqual(profile.endpoints, [{ host, port, protocol: "rest", path }]);
    if (host === "api.openai.com") {
      assert.equal(profile.id, "oce-openai");
    }
    assert.equal(
      (await f.request("GET", f.path + "/" + created.data.id)).data.status.state,
      "ready",
    );
    f.passRegistrationFence();
    assert.equal((await f.request("DELETE", f.path + "/" + created.data.id)).status, 204);
    assert.equal(f.profiles.size, 0);
    assert.equal(f.providers.size, 0);
  }
});

test("offered OpenShell source values return field-specific HTTP 400 before effects", async (t) => {
  const f = await fixture(t, { toolSources: true });
  const secret = await f.createSecret(f.namespace.id, "tool-material", "synthetic-tool-material");
  const endpoint = { host: "tools.example.test", env_var: "TOOL_TOKEN" };
  const oauth = { ...endpoint, token_url: "https://issuer.example.test/token", client_id: "occ" };
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
      const secretField = {
        "bearer-token": "token",
        "oauth2-client-credentials": "client_secret",
        "oauth2-refresh-token": "refresh_token",
      }[type];
      const response = await f.request("POST", f.path, {
        body: {
          name: "invalid-" + field,
          type,
          config: { ...(type === "bearer-token" ? endpoint : oauth), [field]: value },
          secrets: { [secretField]: secret.ref },
        },
      });
      assert.deepEqual((await f.request("GET", f.path)).data, []);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, "INVALID_REQUEST");
      assert.deepEqual(response.body.error.details, [
        { path: "/config/" + field, code: "INVALID_VALUE" },
      ]);
    });
  }
  const unavailable = await f.request("POST", f.path, {
    body: { name: "unoffered", type: "not-offered", config: {}, secrets: {} },
  });
  assert.equal(unavailable.status, 409, JSON.stringify(unavailable.body));
  assert.equal(
    f.secretDriver.calls.some(({ operation }) => operation === "withValue"),
    false,
  );
  assert.deepEqual(f.mutations, []);
  assert.equal(f.providers.size, 0);
  assert.equal(f.profiles.size, 0);
});

test("OpenShell auth_header rejects unsafe values before Secret reads or gateway effects", async (t) => {
  const f = await fixture(t);
  for (const auth_header of [
    "",
    "Authorization",
    "bearer",
    "X-API-Key",
    "x-other-key",
    "x-api-key\r\nx-extra: value",
    "synthetic-secret-value",
  ]) {
    const response = await f.create("invalid-header", { auth_header });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.deepEqual(response.body.error.details, [
      { path: "/config/auth_header", code: "INVALID_VALUE" },
    ]);
    assert.equal(JSON.stringify(response.body).includes(auth_header), auth_header === "");
    assert.deepEqual((await f.request("GET", f.path)).data, []);
  }
  assert.equal(
    f.secretDriver.calls.some(({ operation }) => operation === "withValue"),
    false,
  );
  assert.deepEqual(f.mutations, []);
});

test("OpenShell headers isolate profiles through registration, rotation, repair and removal", async (t) => {
  const f = await fixture(t);
  const base_url = "https://models.example.test/v1";
  const bearer = await f.create("bearer", { base_url });
  const explicitBearer = await f.create("explicit-bearer", {
    base_url,
    auth_header: "authorization",
  });
  const header = await f.create("header", { base_url, auth_header: "x-api-key" });
  const sharedHeader = await f.create("shared-header", {
    base_url: "https://MODELS.example.test:443/v1/",
    auth_header: "x-api-key",
  });
  for (const created of [bearer, explicitBearer, header, sharedHeader]) {
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.status.state, "ready");
    assert.equal(JSON.stringify(created.body).includes("synthetic-model-key"), false);
  }
  assert.equal(f.profiles.size, 2);
  const profileFor = (created) => {
    const provider = [...f.providers.values()].find(
      (row) => row.name === openShellProviderName(created.data.id),
    );
    return f.profiles.get(provider.workspace + "/" + provider.type);
  };
  const bearerProfile = profileFor(bearer);
  const headerProfile = profileFor(header);
  assert.notEqual(headerProfile.id, bearerProfile.id);
  assert.equal(profileFor(explicitBearer).id, bearerProfile.id);
  assert.equal(profileFor(sharedHeader).id, headerProfile.id);
  assert.deepEqual(headerProfile.credentials, [
    {
      name: "api_key",
      envVars: ["OPENAI_API_KEY"],
      required: true,
      authStyle: "header",
      headerName: "x-api-key",
    },
  ]);
  assert.deepEqual(headerProfile.endpoints, bearerProfile.endpoints);
  assert.deepEqual(headerProfile.binaries, ["/app/bin/codex"]);
  assert.equal(bearerProfile.credentials[0].authStyle, "bearer");
  assert.equal(bearerProfile.credentials[0].headerName, "authorization");
  const source = await f.controller.transact((unit) =>
    unit.credentialSources.findCredentialSource(f.namespace.id, header.data.id),
  );
  const provider = [...f.providers.values()].find(
    (row) => row.name === openShellProviderName(source.id),
  );
  const context = {
    namespace: { ...f.namespace, name: provider.workspace },
    source,
    signal: AbortSignal.timeout(5000),
  };
  // A stale profile is repaired only within its auth/endpoint scope.
  f.profiles.get(provider.workspace + "/" + provider.type).annotations = {};
  await f.driver.attachForRevision({
    ...context,
    sources: [source],
    revision: { harness: { id: "codex", mode: "dedicated" } },
  });
  assert.equal(profileFor(header).credentials[0].headerName, "x-api-key");
  assert.deepEqual(profileFor(bearer), bearerProfile);
  await assert.rejects(
    f.driver.attachForRevision({
      ...context,
      sources: [source],
      revision: { harness: { id: "openclaw", mode: "dedicated" } },
    }),
    /Bearer authentication/,
  );
  const replacement = await f.createSecret(
    f.namespace.id,
    "rotated-header-key",
    "synthetic-rotated-key",
  );
  const rotated = await f.request("PATCH", f.path + "/" + source.id, {
    body: { secrets: { api_key: replacement.ref } },
  });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal(provider.type, headerProfile.id);
  assert.equal(
    f.providers.get(provider.workspace + "/" + provider.name).credentials.OPENAI_API_KEY,
    "synthetic-rotated-key",
  );
  assert.equal(JSON.stringify(rotated.body).includes("synthetic-rotated-key"), false);
  // Correct source labels alone do not authorize adopting a Bearer profile.
  provider.type = bearerProfile.id;
  assert.equal((await f.driver.sourceStatus(context)).state, "failed");
  await assert.rejects(f.driver.removeSource(context), /not owned/);
  provider.type = headerProfile.id;
  f.passRegistrationFence();
  assert.equal((await f.request("DELETE", f.path + "/" + source.id)).status, 204);
  assert.equal(f.profiles.size, 2, "the shared raw-header source still needs its profile");
  assert.equal((await f.request("DELETE", f.path + "/" + sharedHeader.data.id)).status, 204);
  assert.deepEqual([...f.profiles.values()], [bearerProfile]);
  for (const created of [bearer, explicitBearer]) {
    assert.equal((await f.request("DELETE", f.path + "/" + created.data.id)).status, 204);
  }
  assert.equal(f.profiles.size, 0);
});
