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
import { OpenShellProviderAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { storedCredentialSourceConfig } from "../helpers/refusal-text.mjs";

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
const TOKEN_URL_MESSAGE = {
  host: (type) =>
    `The ${type} token_url host must be a DNS name with at least two labels, not an IP address or a localhost or localdomain name.`,
  port: (type) => `The ${type} token_url port must be 1 to 65535.`,
  gateway: (type) =>
    `The ${type} token_url host must not be a Kubernetes Pod name or a name in the OpenShell gateway's namespace.`,
};

/** A save refused for one config field: HTTP 400 naming only that field, and its message. */
function assertRefused(response, field, message, label = field) {
  assert.equal(response.status, 400, label + " " + JSON.stringify(response.body));
  assert.equal(response.body.error.code, "INVALID_REQUEST", label);
  assert.deepEqual(
    response.body.error.details,
    [{ path: "/config/" + field, code: "INVALID_VALUE" }],
    label,
  );
  if (typeof message === "string") {
    assert.equal(response.body.error.message, message, label);
  } else if (message !== undefined) {
    assert.match(response.body.error.message, message, label);
  }
}

/**
 * Rule tables list each row's check points: `save` (refused through the API), `validate`
 * (accepted by the Driver's validateSourceConfig) and `attach` (a source stored before the rule,
 * with its provider, attached to a new revision). Returns the rows checked at `point`.
 */
const CHECK_POINTS = ["save", "validate", "attach"];
const checkedAt = (rows, point) =>
  rows
    .filter(([value, points]) => {
      const list = points.split(" ");
      assert.ok(
        list.every((name) => CHECK_POINTS.includes(name)),
        value + ": " + points,
      );
      return list.includes(point);
    })
    .map(([value]) => value);

// Gateway storage and Compute placement are test doubles. Requests use the real
// Fastify app, authentication, IAM, OCC transactions, and OpenShell Driver.
async function fixture(
  t,
  { toolSources = false, gateway = { endpoint: "http://127.0.0.1:1" } } = {},
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
        config: { base_url: baseUrl },
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
    /** Saves a tool source through the API, with `config` over the type's valid config. */
    saveTool(type, config, name = "tool") {
      return app.request("POST", path, {
        body: {
          name,
          type,
          config: toolConfig(type, config),
          secrets: { [SECRET_FIELD[type]]: toolSecret.ref },
        },
      });
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
        name: "stored",
        type,
        config: type === "openai" ? config : toolConfig(type, config),
        secrets:
          type === "openai" ? { api_key: secret.ref } : { [SECRET_FIELD[type]]: toolSecret.ref },
        ownerCapability: "credential_gateway",
        driverId: driver.id,
        state: "ready",
        createdAt: new Date().toISOString(),
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
        revision: { harness: { id: "codex", mode: "dedicated" } },
        signal: AbortSignal.timeout(5000),
      });
    },
  };
}

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
    const response = await f.create("invalid", { base_url });
    // Assert absence independently of the status: the original bug left a deleting row.
    assert.deepEqual((await f.request("GET", f.path)).data, [], base_url);
    assertRefused(response, "base_url", /HTTPS.*\/v1/, base_url);
    if (base_url.startsWith("https://[")) {
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
  const context = {
    namespace: { ...f.namespace, name: provider.workspace },
    source,
    signal: AbortSignal.timeout(5000),
  };
  // Native inference uses the source's exact endpoint, including a custom prefix.
  const nativeRevision = {
    harness: { id: "openclaw", mode: "dedicated" },
    configuration: {
      models: {
        providers: {
          openai: { baseUrl: custom.data.config.base_url, models: [{ id: "model" }] },
        },
      },
    },
  };
  assert.deepEqual(
    await f.driver.attachForRevision({ ...context, sources: [source], revision: nativeRevision }),
    [{ sourceId: custom.data.id, ref: provider.name }],
  );
  for (const model of [{ id: "model", baseUrl: "https://other.example.test/v1" }, {}]) {
    const revision = structuredClone(nativeRevision);
    revision.configuration.models.providers.openai.models = [model];
    if (!model.baseUrl) {
      delete revision.configuration.models.providers.openai.baseUrl;
    }
    await assert.rejects(
      f.driver.attachForRevision({ ...context, sources: [source], revision }),
      /must match the bound credential source endpoint/,
    );
  }
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

test("concrete credential source endpoints retain normalized profile scope", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["https://models.example.test/v1", "models.example.test", 443, "/v1/**"],
    ["https://MODELS.example.test:443/api/./v1/", "models.example.test", 443, "/api/v1/**"],
    ["https://bücher.example.test:8443/api/v1/", "xn--bcher-kva.example.test", 8443, "/api/v1/**"],
    ["https://API.OpenAI.com:443/v1/", "api.openai.com", 443, "/v1/**"],
    // Spellings the URL parser rewrites: the source stores and returns the rewritten URL.
    ["HTTPS://models.example.test/v1", "models.example.test", 443, "/v1/**"],
    ["https://models.example.test:00443/v1", "models.example.test", 443, "/v1/**"],
    ["https://ｍｏｄｅｌｓ.example.test/v1", "models.example.test", 443, "/v1/**"],
    ["https:\\\\models.example.test/v1", "models.example.test", 443, "/v1/**"],
  ];
  for (const [base_url, host, port, path] of cases) {
    const created = await f.create("concrete endpoint", { base_url });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // The stored endpoint is the one the profile uses, not the written spelling (finding 1292).
    const stored = `https://${host}${port === 443 ? "" : ":" + port}${path.slice(0, -3)}`;
    assert.deepEqual(created.data.config, { base_url: stored }, base_url);
    assert.deepEqual(
      (await f.request("GET", f.path + "/" + created.data.id)).data.config,
      { base_url: stored },
      base_url,
    );
    // Assert the profile produced through HTTP/OCC, not a copied normalizer.
    const profile = [...f.profiles.values()][0];
    assert.deepEqual(profile.endpoints, [{ host, port, protocol: "rest", path }]);
    assert.equal(profile.id, openShellProviderName(created.data.id));
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

test("credential source endpoints refuse spellings the URL parser would rewrite", async (t) => {
  const f = await fixture(t);
  // Each parses as https://models.example.test/v1, so it used to be stored as written while the
  // profile used another URL (finding 1292). The shared baseUrl rules refuse these spellings.
  for (const [base_url, message] of [
    ["https://@models.example.test/v1", /must not contain user info or an @ before the host/],
    ["https://:@models.example.test/v1", /must not contain user info or an @ before the host/],
    ["https:models.example.test/v1", /must start with https:\/\/ \(the \/\/ after the scheme/],
    ["https:/models.example.test/v1", /must start with https:\/\/ \(the \/\/ after the scheme/],
    ["https:///models.example.test/v1", /requires HTTPS/],
    ["  https://models.example.test/v1  ", /must not contain spaces or control characters/],
    ["https://models.example.test\t/v1", /must not contain spaces or control characters/],
    ["https://models.exam\nple.test/v1", /must not contain spaces or control characters/],
    // The API schema already refuses a NUL in any string (INVALID_FORMAT).
  ]) {
    const response = await f.create("rewritten", { base_url });
    assertRefused(response, "base_url", message, JSON.stringify(base_url));
    assert.deepEqual((await f.request("GET", f.path)).data, [], JSON.stringify(base_url));
  }
  await f.assertNothingSaved();
});

test("credential source endpoints require an exact DNS host name", async (t) => {
  const f = await fixture(t);
  // The bearer-token host rule: IP addresses in any spelling the URL parser accepts, and labels
  // with `_` or an edge `-`, widened the member's Sandbox egress (finding 1293).
  for (const host of [
    "127.0.0.1",
    "10.0.0.1",
    "192.0.2.1",
    "169.254.169.254",
    "0x7f000001",
    "2130706433",
    "127.1",
    "models_internal.example.test",
    "-models.example.test",
    "models-.example.test",
  ]) {
    const response = await f.create("ip", { base_url: `https://${host}/v1` });
    assertRefused(
      response,
      "base_url",
      "The openai base_url host must be an exact DNS name.",
      host,
    );
  }
  await f.assertNothingSaved();
  // A source stored before the rule, with its provider, cannot be attached to a new revision,
  // nor can its value be replaced: a 409 that names the replacement, not a 404 (finding 2536).
  const { stored } = await f.seedStoredRecord("openai", {
    base_url: "https://169.254.169.254/v1",
  });
  await assert.rejects(f.attach(stored), {
    name: "StoredCredentialSourceConfigError",
    message: storedCredentialSourceConfig("base_url"),
  });
  const replaced = await f.replaceSecret(stored);
  assert.equal(replaced.status, 409, JSON.stringify(replaced.body));
  assert.equal(replaced.body.error.code, "RESOURCE_CONFLICT");
  assert.equal(replaced.body.error.message, storedCredentialSourceConfig("base_url"));
  assert.equal(f.profiles.size, 0);
  assert.ok(!f.mutations.includes("updateProvider"));
});

test("bearer-token and OAuth2 hosts must not end in a numeric or 0x label", async (t) => {
  const f = await fixture(t, { toolSources: true });
  // The URL parser and inet_aton-style resolvers (glibc's, the Sandbox proxy's) read a host whose
  // last label is a decimal or 0x number as an IPv4 address (finding 1360). Stored sources are
  // checked at attach too, and a stored DNS host still attaches (finding 1363).
  const refused = [
    ["0xa000005", "save attach"],
    ["0xa.0.0.5", "save"],
    ["10.0x0.0.5", "save"],
    ["0x7f.0x1", "save attach"],
    ["0xa9.0xfe.0xa9.0xfe", "save"],
    ["example.123", "save attach"],
    ["example.123.", "attach"],
    ["example.0x", "save attach"],
    ["api.example.0x10", "save"],
    ["10.0.0.5", "attach"],
    ["169.254.169.254", "attach"],
  ];
  const accepted = [
    ["api.example.com", "validate attach"],
    ["a1.example.com", "validate"],
    ["0xdead.example.com", "validate attach"],
    ["123.example.com", "validate attach"],
    // Only a whole-label number is one; this last label is a name.
    ["example.0xg", "validate"],
  ];
  const message = (type) => `The ${type} host must be an exact DNS name.`;
  for (const type of TOOL_TYPES) {
    for (const host of checkedAt(refused, "save")) {
      assertRefused(await f.saveTool(type, { host }), "host", message(type), host);
    }
    for (const host of checkedAt(accepted, "validate")) {
      assert.doesNotThrow(() => f.validate(type, { host }), host);
    }
  }
  await f.assertNothingSaved();
  // A refused stored source's profile is not written either. Only a stored source reaches the
  // profile check, so it names the replacement (finding 2536).
  const refusal = (field, label) => (error) => {
    assert.equal(error.name, "StoredCredentialSourceConfigError", label);
    assert.equal(error.message, storedCredentialSourceConfig(field), label);
    return true;
  };
  for (const type of TOOL_TYPES) {
    for (const host of checkedAt(refused, "attach")) {
      await assert.rejects(f.attach(f.seedStored(type, { host }).stored), refusal("host", host));
    }
    if (type === "bearer-token") {
      // Replacing the value of such a source through the API fails the same way: a 409 that
      // names the replacement, where it was a 404 (finding 2536).
      const { stored } = await f.seedStoredRecord(type, { host: "0x7f.0x1" });
      const replaced = await f.replaceSecret(stored);
      assert.equal(replaced.status, 409, JSON.stringify(replaced.body));
      assert.equal(replaced.body.error.code, "RESOURCE_CONFLICT");
      assert.equal(replaced.body.error.message, storedCredentialSourceConfig("host"));
    } else {
      // As at save, the host is checked before token_url.
      const { stored } = f.seedStored(type, {
        host: "0x7f.0x1",
        token_url: "https://169.254.169.254/token",
      });
      await assert.rejects(f.attach(stored), refusal("host", "with token_url"));
    }
    assert.equal(f.profiles.size, 0, type);
    assert.deepEqual(f.mutations, [], type);
    for (const host of checkedAt(accepted, "attach")) {
      const { stored, name, profileKey } = f.seedStored(type, { host });
      assert.deepEqual(await f.attach(stored), [{ sourceId: stored.id, ref: name }], host);
      assert.deepEqual(
        f.profiles.get(profileKey).endpoints.map((endpoint) => endpoint.host),
        [host],
        host,
      );
    }
    f.profiles.clear();
    f.mutations.length = 0;
  }
});

test("OAuth2 token_url hosts must be multi-label DNS names, not IP addresses or localhost names", async (t) => {
  const f = await fixture(t, { toolSources: true });
  // The OpenShell gateway, not the Sandbox, posts the issuer material to token_url, so the
  // protected host's rule applies to its parsed hostname, plus localhost (finding 1348).
  const refused = [
    ["https://10.0.0.5/token", "save"],
    ["https://127.0.0.1:8443/token", "save"],
    ["https://169.254.169.254/latest", "save"],
    ["https://169.254.169.254/token", "attach"],
    ["https://0x7f000001/token", "save"],
    ["https://2130706433/token", "save"],
    ["https://127.1/token", "save"],
    ["https://0177.0.0.1/token", "save"],
    ["https://[::1]:8443/token", "save"],
    ["https://[::ffff:127.0.0.1]/token", "save"],
    ["https://localhost/token", "save"],
    ["https://LOCALHOST:8443/token", "save"],
    ["https://issuer.localhost/token", "save"],
    // The gateway resolves names through its Pod's /etc/hosts, where the kubelet and
    // container runtimes map these to loopback, link-local or multicast addresses, and the
    // Pod's own single-label hostname to the Pod itself (finding 1354).
    ["https://ip6-localhost/token", "save attach"],
    ["https://ip6-loopback:8443/token", "save"],
    ["https://IP6-LOOPBACK/token", "save"],
    ["https://ip6-localnet/token", "save"],
    ["https://ip6-allnodes/token", "save"],
    ["https://localhost4/token", "save"],
    ["https://localhost6/token", "save"],
    ["https://localhost.localdomain/token", "save attach"],
    ["https://LOCALHOST.LOCALDOMAIN:8443/token", "save"],
    ["https://localhost4.localdomain4/token", "save"],
    ["https://localhost6.localdomain6/token", "save"],
    ["https://keycloak/token", "save"],
    ["https://openshell-gateway-0:8443/token", "save"],
    // An SRV-style `_port._protocol` name is not a host name (finding 1366).
    ["https://_grpc._tcp.openshell-gateway/token", "save"],
    // A stored token_url that does not parse (save never accepts one) is refused the same way,
    // not with a parser error.
    ["https://login example.test/token", "attach"],
  ];
  const port = "https://login.example.test:0/token";
  // In-cluster issuers have DNS names, which the protected host accepts too.
  const accepted = [
    "https://login.example.test/oauth2/token",
    "https://localhost.example/token",
    "https://localdomain.example/token",
    "https://keycloak.idp/token",
    "https://kubernetes.default.svc/token",
    "https://keycloak.idp.svc.cluster.local:8443/realms/occ/protocol/openid-connect/token",
  ];
  for (const type of OAUTH2_TYPES) {
    for (const token_url of checkedAt(refused, "save")) {
      const response = await f.saveTool(type, { token_url });
      assertRefused(response, "token_url", TOKEN_URL_MESSAGE.host(type), token_url);
    }
    const response = await f.saveTool(type, { token_url: port });
    assertRefused(response, "token_url", TOKEN_URL_MESSAGE.port(type), port);
    for (const token_url of accepted) {
      assert.doesNotThrow(() => f.validate(type, { token_url }), token_url);
    }
  }
  await f.assertNothingSaved();
  // A stored source is not attached to a new revision, and its profile is not rewritten.
  for (const token_url of [...checkedAt(refused, "attach"), port]) {
    const { stored } = f.seedStored("oauth2-client-credentials", { token_url });
    await assert.rejects(
      f.attach(stored),
      {
        name: "StoredCredentialSourceConfigError",
        message: storedCredentialSourceConfig("token_url"),
      },
      token_url,
    );
  }
  assert.equal(f.profiles.size, 0);
});

test("the OpenShell Backend names its gateway's namespace only from Service-shaped hosts", () => {
  const placement = (configuration, namespace) =>
    createOpenShellBackend({
      id: "openshell",
      type: "openshell",
      configuration,
      drivers: { sandbox: "s", credential_gateway: "c" },
    }).client.placement(namespace);
  const named = { service: "openshell-gateway", namespace: "openshell-system" };
  for (const configuration of [
    { endpoint: "https://openshell-gateway.openshell-system.svc:8080" },
    { endpoint: "http://openshell-gateway.openshell-system.svc.cluster.local:8080" },
    { endpoint: "openshell-gateway.openshell-system.svc.example.internal:8080" },
    { endpoint: "https://openshell-gateway-0.openshell-gateway-peer.openshell-system.svc:8080" },
    // CoreDNS answers a port and protocol before the Service name like the Service (finding 1369).
    { endpoint: "https://grpc.tcp.openshell-gateway.openshell-system.svc:8080" },
    { endpoint: "http://_grpc._tcp.openshell-gateway.openshell-system.svc.cluster.local:8080" },
    { serviceName: "openshell-gateway.openshell-system" },
    { serviceName: "openshell-gateway.openshell-system.svc.cluster.local" },
    { serviceName: "openshell-gateway-0.openshell-gateway-peer.openshell-system.svc" },
    // DNS names are case-insensitive, and token_url hosts are compared after URL parsing.
    { serviceName: "OpenShell-Gateway.OpenShell-System" },
    { serviceName: "OpenShell-Gateway.OpenShell-System.SVC.Cluster.Local" },
    { serviceName: "GRPC.TCP.OpenShell-Gateway.OpenShell-System.SVC" },
  ]) {
    assert.deepEqual(placement(configuration, "oce-0123456789abcde"), named, configuration);
  }
  // A Service name, with or without a port and protocol, is kept as written.
  for (const endpoint of [
    "https://openshell-gateway-peer.openshell-system.svc:8080",
    "https://_grpc._tcp.openshell-gateway-peer.openshell-system.svc:8080",
  ]) {
    assert.deepEqual(
      placement({ endpoint }),
      { service: "openshell-gateway-peer", namespace: "openshell-system" },
      endpoint,
    );
  }
  // Only a trailing `-peer` names the peer Service of the gateway Service.
  assert.deepEqual(
    placement({ endpoint: "https://gateway-0.gateway-peering.openshell-system.svc:8080" }),
    { service: "gateway-peering", namespace: "openshell-system" },
  );
  // A bare Service name resolves in each tenant namespace, so only a tenant names it.
  assert.equal(placement({ serviceName: "openshell-gateway" }), undefined);
  assert.deepEqual(placement({ serviceName: "openshell-gateway" }, "oce-0123456789abcde"), {
    service: "openshell-gateway",
    namespace: "oce-0123456789abcde",
  });
  for (const endpoint of [
    "http://127.0.0.1:1",
    "http://[::1]:8080",
    "http://k3d-occ-dev-server-0:30080",
    "https://openshell.example.com",
    "openshell-gateway.openshell-system:8080",
    // CoreDNS answers at most two labels before the Service name.
    "https://a.grpc.tcp.openshell-gateway.openshell-system.svc:8080",
  ]) {
    assert.equal(placement({ endpoint }, "oce-0123456789abcde"), undefined, endpoint);
  }
});

test("OAuth2 token_url hosts must not name the OpenShell gateway's own namespace or a Pod", async (t) => {
  // The gateway Pod's /etc/hosts and its cluster DNS search list resolve these to the gateway's
  // own Pod or Service, which no egress NetworkPolicy polices (finding 1356).
  const gatewayOwn = [
    "https://openshell-gateway-0.openshell-gateway-peer.openshell-system.svc.cluster.local:8080/token",
    "https://openshell-gateway-0.openshell-gateway-peer.openshell-system.svc/token",
    "https://openshell-gateway-0.openshell-gateway-peer.openshell-system/token",
    "https://openshell-gateway-0.openshell-gateway-peer/token",
    "https://openshell-gateway-peer.openshell-system.svc.cluster.local/token",
    "https://openshell-gateway.openshell-system.svc/token",
    "https://openshell-gateway.openshell-system/token",
    "https://openshell-gateway-0.openshell-gateway/token",
    // CoreDNS reads two leading labels as a port and protocol, case-insensitively, and the
    // search list completes them; whatever the port name, they are refused (finding 1366).
    "https://grpc.tcp.openshell-gateway/token",
    "https://GRPC.TCP.openshell-gateway/token",
    "https://grpc.tcp.openshell-gateway-peer/token",
    "https://any.any.openshell-gateway/token",
    "https://keycloak.openshell-system.svc.example.internal/token",
    "https://10-42-0-5.openshell-system.pod.cluster.local/token",
    // The namespace's `pod` zone itself, with no Pod label in front.
    "https://openshell-system.pod.cluster.local/token",
  ];
  // CoreDNS's default `pods insecure` answers a Pod name with its written address, in any
  // namespace, so these name an address (here loopback) and are refused without a gateway.
  const podNames = [
    "https://127-0-0-1.default.pod.cluster.local/token",
    "https://10-42-0-5.idp.pod/token",
    // CoreDNS also answers one or two leading labels (an endpoint, or a port and protocol)
    // before a Pod name and ignores them; the search list completes the short forms, and
    // any cluster domain may follow (finding 1359).
    "https://x.127-0-0-1.default.pod.cluster.local/token",
    "https://a.b.127-0-0-1.default.pod.cluster.local/token",
    "https://x.127-0-0-1.default.pod/token",
    "https://a.b.127-0-0-1.default.pod/token",
    "https://x.0--1.default.pod.cluster.local/token",
    "https://x.169-254-169-254.idp.pod.k8s.example.internal/token",
    // Any `pod` label after the second is refused, so a public name of that shape is too
    // (deliberately fail-closed), and so is any prefix depth.
    "https://login.idp.pod.example.com/token",
    "https://a.b.c.127-0-0-1.default.pod.cluster.local/token",
  ];
  // Issuers in other namespaces, including the test and development Keycloaks, keep working.
  const accepted = [
    "https://keycloak.idp.svc.cluster.local:8443/realms/occ/protocol/openid-connect/token",
    "https://keycloak.oce-keycloak-0a1b2c3d.svc.cluster.local:8443/realms/occ/token",
    "https://keycloak.occ-development-keycloak.svc.cluster.local/token",
    "https://keycloak.idp/token",
    // Three labels ending in another Service name the gateway's namespace only through a
    // Service the OpenShell chart does not create there, and never the gateway itself.
    "https://a.b.keycloak/token",
    // A Service that only shares the gateway Service's name as a prefix, without the `-` its
    // peer Service adds.
    "https://grpc.tcp.openshell-gateway2/token",
    // CoreDNS answers at most two labels before a Service name, so four labels ending in the
    // gateway Service resolve only through the `svc.<zone>` search entry, as Service `c` in a
    // namespace named after the last label, never the gateway's.
    "https://a.b.c.openshell-gateway/token",
    "https://a.b.c.openshell-gateway-peer/token",
    "https://kubernetes.default.svc/token",
    "https://openshell-system.example/token",
    "https://login.openshell-gateway.example/token",
    "https://login.example.test/oauth2/token",
    "https://example.com/token",
    "https://pod.example.com/token",
    "https://login.pod.example.com/token",
    "https://keycloak.pod.svc.cluster.local/token",
  ];
  const message = TOKEN_URL_MESSAGE.gateway;
  for (const gateway of [
    { endpoint: "https://openshell-gateway.openshell-system.svc:8080" },
    { serviceName: "openshell-gateway.openshell-system" },
    { endpoint: "https://grpc.tcp.openshell-gateway.openshell-system.svc:8080" },
  ]) {
    const f = await fixture(t, { toolSources: true, gateway });
    for (const type of OAUTH2_TYPES) {
      for (const token_url of [...gatewayOwn, ...podNames]) {
        assertRefused(await f.saveTool(type, { token_url }), "token_url", message(type), token_url);
      }
      for (const token_url of accepted) {
        assert.doesNotThrow(() => f.validate(type, { token_url }), token_url);
      }
    }
    await f.assertNothingSaved();
  }

  // Without a named gateway namespace only Pod names are refused at save.
  const unnamed = await fixture(t, { toolSources: true });
  for (const token_url of podNames) {
    assert.throws(
      () => unnamed.validate("oauth2-client-credentials", { token_url }),
      { name: "CredentialSourceConfigError", message: message("oauth2-client-credentials") },
      token_url,
    );
  }

  // A gateway in each tenant namespace is known at registration and attach, which carry it.
  const f = await fixture(t, { toolSources: true, gateway: { serviceName: "openshell-gateway" } });
  const tenant = f.namespace.name;
  const tenantOwn = [
    `https://openshell-gateway-0.openshell-gateway-peer.${tenant}.svc.cluster.local/token`,
    `https://openshell-gateway.${tenant}.svc/token`,
    "https://openshell-gateway-0.openshell-gateway-peer/token",
    "https://grpc.tcp.openshell-gateway/token",
    "https://GRPC.TCP.openshell-gateway-peer/token",
  ];
  for (const [index, token_url] of tenantOwn.entries()) {
    assert.doesNotThrow(() => f.validate("oauth2-client-credentials", { token_url }));
    // A refused registration leaves its record deleting, so each attempt takes a new name.
    const response = await f.saveTool(
      "oauth2-client-credentials",
      { token_url },
      `issuer-${index}`,
    );
    // Registration refuses the request's own value by field, as save does for a gateway the
    // Backend names, where it was a 404 (finding 2536).
    assertRefused(response, "token_url", message("oauth2-client-credentials"), token_url);
  }
  // Refused before the profile or provider is written, so no refresh is configured either.
  assert.deepEqual(
    f.mutations.filter((mutation) => mutation === "importProfile" || mutation === "createProvider"),
    [],
  );
  assert.equal(f.profiles.size, 0);
  assert.equal(f.providers.size, 0);
  // A source stored before the rule, with its provider, cannot be attached to a new revision.
  for (const token_url of [...tenantOwn, ...podNames]) {
    await assert.rejects(
      f.attach(f.seedStored("oauth2-client-credentials", { token_url }).stored),
      {
        name: "StoredCredentialSourceConfigError",
        message: storedCredentialSourceConfig("token_url"),
      },
      token_url,
    );
  }
  assert.equal(f.profiles.size, 0);
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
