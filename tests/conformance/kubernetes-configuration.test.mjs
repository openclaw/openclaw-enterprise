import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { mock } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  ConfigurationBackendUnavailableError,
  ConfigurationConflictError,
  ConfigurationValidationError,
  KubernetesConfigurationDriver,
  kubernetesConfigurationName,
} from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { READ_RETRY_PAUSES_MS, withRetryTimers } from "../helpers/kubernetes-request-retry.mjs";
import { writeUnsafeKubeconfigs } from "../helpers/unsafe-kubeconfigs.mjs";

const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const configuration = {
  id: "cfg_00000000-0000-4000-8000-000000000001",
  namespaceId,
  kind: "agent",
  generation: 1,
  values: {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { source: "store", provider: "teamstore", id: "OPENAI_API_KEY" },
        },
      },
    },
    secrets: {
      providers: { teamstore: { source: "store" } },
      defaults: { store: "teamstore" },
      egressProxy: { enabled: true },
    },
    agents: { defaults: { sandbox: { mode: "all" } } },
    plugins: { entries: { example: { config: { enabled: true, retries: 3, tags: [null] } } } },
  },
  createdAt: "2026-08-19T00:00:00.000Z",
};

function createDriver(authentication = { mode: "inCluster" }) {
  return new KubernetesConfigurationDriver({ authentication });
}

function physicalNamespaceName(id) {
  return `oce-${createHash("sha256").update(id).digest("hex").slice(0, 15)}`;
}

class FakeConfigurationCoreV1Api {
  namespaces = new Map();
  configMaps = new Map();
  creates = 0;

  addNamespace(id, layout = "shared") {
    const name =
      layout === "split"
        ? `oce-gateways-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`
        : layout === "adopted"
          ? "customer-support"
          : physicalNamespaceName(id);
    this.namespaces.set(name, {
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/gateway-namespace": id,
          ...(layout === "split" ? {} : { "openclaw.dev/namespace": id }),
          ...(layout === "adopted"
            ? Object.fromEntries(
                ["enforce", "audit", "warn"].map((mode) => [
                  `pod-security.kubernetes.io/${mode}`,
                  "restricted",
                ]),
              )
            : {}),
        },
        annotations: {
          "openclaw.dev/namespace-id": id,
          ...(layout === "adopted" ? { "openclaw.dev/namespace-lifecycle": "external" } : {}),
        },
      },
      status: { phase: "Active" },
    });
    return name;
  }

  async listNamespace({ labelSelector }) {
    const [label, id] = labelSelector.split("=");
    return {
      items: [...this.namespaces.values()].filter(
        ({ metadata }) => metadata.labels?.[label] === id,
      ),
    };
  }

  async readNamespace({ name }) {
    const namespace = this.namespaces.get(name);
    if (namespace === undefined) {
      throw Object.assign(new Error("missing Namespace"), { code: 404 });
    }
    return structuredClone(namespace);
  }

  async createNamespacedConfigMap({ namespace, body }) {
    this.creates += 1;
    const key = `${namespace}/${body.metadata.name}`;
    if (this.configMaps.has(key)) {
      throw Object.assign(new Error("conflict"), { code: 409 });
    }
    const stored = {
      ...structuredClone(body),
      metadata: {
        ...body.metadata,
        uid: `uid-${this.configMaps.size + 1}`,
        resourceVersion: "1",
      },
    };
    this.configMaps.set(key, stored);
    return structuredClone(stored);
  }

  async readNamespacedConfigMap({ namespace, name }) {
    const stored = this.configMaps.get(`${namespace}/${name}`);
    if (stored === undefined) {
      throw Object.assign(new Error("missing ConfigMap"), { code: 404 });
    }
    return structuredClone(stored);
  }
}

test("Kubernetes configuration implementations expose a closed preconstruction schema", () => {
  const schema = KubernetesConfigurationDriver.configurationSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["authentication"]);
  assert.doesNotThrow(() =>
    requireConfiguration(KubernetesConfigurationDriver, { authentication: { mode: "inCluster" } }),
  );

  const injected = /Injected clients and unknown Kubernetes configuration options/;
  for (const [invalid, refusal] of [
    [undefined, /Kubernetes configuration options are required/],
    [{}, /Explicit Kubernetes authentication is required/],
    [{ authentication: { mode: "ambient" } }, /explicit Kubernetes authentication mode/],
    [
      { authentication: { mode: "inCluster", context: "unexpected" } },
      /In-cluster authentication does not accept additional options/,
    ],
    [
      {
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: "/tmp/config",
          context: "tenant",
          token: "x",
        },
      },
      /Unknown kubeconfig authentication options are forbidden/,
    ],
    [
      { authentication: { mode: "kubeconfig", kubeconfigPath: "", context: "tenant" } },
      /Dedicated kubeconfig path must be a nonempty string/,
    ],
    [
      { authentication: { mode: "kubeconfig", kubeconfigPath: "relative", context: "tenant" } },
      /Dedicated kubeconfig path must be absolute/,
    ],
    [
      { authentication: { mode: "kubeconfig", kubeconfigPath: "/tmp/config", context: "" } },
      /Explicit Kubernetes context must be a nonempty string/,
    ],
    [{ authentication: { mode: "inCluster" }, token: "not-allowed" }, injected],
    [{ authentication: { mode: "inCluster" }, clients: {} }, injected],
  ]) {
    assert.throws(
      () => requireConfiguration(KubernetesConfigurationDriver, invalid),
      SharedConfigurationValidationError,
    );
    assert.throws(
      () => new KubernetesConfigurationDriver(invalid),
      SharedConfigurationValidationError,
      String(refusal),
    );
  }

  // Inherited client injection must not evade the closed own-property schema.
  const inheritedClients = Object.assign(Object.create({ clients: {} }), {
    authentication: { mode: "inCluster" },
  });
  assert.throws(
    () => new KubernetesConfigurationDriver(inheritedClients),
    SharedConfigurationValidationError,
  );
});

test("configuration Driver selection is explicit and cannot switch implementations", () => {
  const selected = new KubernetesConfigurationDriver(
    { authentication: { mode: "inCluster" } },
    { id: "config-selected", implementation: "occ/kubernetes-configmap" },
  );
  assert.equal(selected.id, "config-selected");
  assert.equal(selected.capability, "configuration");
  assert.equal(selected.implementation, "occ/kubernetes-configmap");
  assert.throws(
    () => new KubernetesConfigurationDriver({ authentication: { mode: "inCluster" } }, { id: "" }),
    /driver id/i,
  );
  assert.throws(
    () =>
      new KubernetesConfigurationDriver(
        { authentication: { mode: "inCluster" } },
        { implementation: "docker" },
      ),
    /implementation/i,
  );
});

test("ConfigMap object names are deterministic, DNS-safe, bounded, and collision-resistant", () => {
  for (const id of ["cfg_Upper.Case_and!punctuation", `cfg_${"x".repeat(250)}`, "cfg_---"]) {
    const name = kubernetesConfigurationName(id);
    const suffix = createHash("sha256").update(id).digest("hex").slice(0, 12);

    assert.equal(name, kubernetesConfigurationName(id));
    assert.match(name, /^cfg-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    assert.ok(name.length <= 63);
    assert.ok(name.endsWith(suffix));
  }

  // Normalization must not collapse distinct server-owned configuration identities.
  assert.notEqual(
    kubernetesConfigurationName("cfg_Team A"),
    kubernetesConfigurationName("cfg_Team-A"),
  );
  assert.throws(() => kubernetesConfigurationName("agent_123"), /cfg_/);
});

test("Namespace configurations accept native, bounded OpenClaw documents", async () => {
  const driver = createDriver();
  await assert.doesNotReject(driver.validate(configuration));

  for (const [values, reason] of [
    [undefined, /document|object/i],
    [null, /document|object/i],
    [[], /document|object/i],
    [{ models: { displayName: "x".repeat(1_048_576) } }, /size/i],
  ]) {
    await assert.rejects(driver.validate({ ...configuration, values }), reason);
  }

  await assert.rejects(driver.validate({ ...configuration, id: "agent_1" }), /cfg_/);
  await assert.rejects(driver.validate({ ...configuration, namespaceId: "" }), /namespace/i);
  for (const kind of [undefined, "gateway", "namespace", ""]) {
    await assert.rejects(driver.validate({ ...configuration, kind }), /kind|agent/i);
  }
  for (const generation of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    await assert.rejects(driver.validate({ ...configuration, generation }), /generation/i);
  }
  await assert.rejects(driver.validate({ ...configuration, createdAt: "invalid" }), /time/i);
});

test("ConfigMaps contain exactly one native document and preserve real ownership boundaries", async () => {
  const driver = createDriver();
  const physicalNamespace = "customer-support-existing";

  // Exercise the production serializer/read boundary directly without claiming a mock is a cluster.
  const observed = driver.manifest(configuration, physicalNamespace);
  assert.equal(observed.metadata.namespace, physicalNamespace);
  assert.deepEqual(observed.metadata.labels, {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace": configuration.namespaceId,
    "openclaw.dev/configuration": configuration.id,
  });
  assert.deepEqual(observed.data, { "openclaw.json": JSON.stringify(configuration.values) });
  assert.equal(observed.metadata.annotations["openclaw.dev/configuration-kind"], "agent");
  assert.equal(observed.metadata.annotations["openclaw.dev/configuration-generation"], "1");
  assert.deepEqual(
    await driver.checkedConfiguration(observed, configuration, physicalNamespace),
    configuration,
  );
  assert.deepEqual(
    await driver.checkedConfiguration(
      { ...observed, binaryData: {} },
      configuration,
      physicalNamespace,
    ),
    configuration,
  );

  for (const [mutate, reason] of [
    [(resource) => (resource.data = {}), /data|invalid/i],
    [(resource) => (resource.data["openclaw.json"] = "{"), /malformed|json/i],
    [(resource) => (resource.data["openclaw.json"] = "[]"), /document|object/i],
    [(resource) => (resource.data.extra = "not-allowed"), /data|invalid/i],
    [(resource) => (resource.binaryData = { secret: "c2VjcmV0" }), /binary/i],
    [(resource) => (resource.data["openclaw.json"] = "x".repeat(1_048_576)), /size/i],
    [
      (resource) => (resource.metadata.annotations["openclaw.dev/namespace-id"] = "ns_other"),
      /exact|namespace/i,
    ],
    [
      (resource) => (resource.metadata.annotations["openclaw.dev/configuration-kind"] = "gateway"),
      /kind|unsupported/i,
    ],
    [
      (resource) => delete resource.metadata.annotations["openclaw.dev/configuration-kind"],
      /kind|unsupported/i,
    ],
    [
      (resource) => (resource.metadata.annotations["openclaw.dev/configuration-generation"] = "0"),
      /generation/i,
    ],
    [
      (resource) => (resource.metadata.annotations["openclaw.dev/configuration-generation"] = "2"),
      /generation/i,
    ],
    [
      (resource) => (resource.metadata.annotations["openclaw.dev/configuration-generation"] = "01"),
      /generation/i,
    ],
    [
      (resource) =>
        (resource.metadata.annotations["openclaw.dev/configuration-generation"] =
          "9007199254740992"),
      /generation/i,
    ],
    [
      (resource) => delete resource.metadata.annotations["openclaw.dev/configuration-generation"],
      /generation/i,
    ],
  ]) {
    const invalid = structuredClone(observed);
    mutate(invalid);
    await assert.rejects(
      driver.checkedConfiguration(invalid, configuration, physicalNamespace),
      reason,
    );
  }
});

for (const layout of ["shared", "adopted", "split"]) {
  test(`Kubernetes Configuration inspectExact recovers only the exact Configuration (${layout})`, async () => {
    const client = new FakeConfigurationCoreV1Api();
    const namespace = client.addNamespace(namespaceId, layout);
    const driver = createDriver();
    driver.client = Promise.resolve(client);

    const created = await driver.createExact(configuration);
    assert.deepEqual(await driver.inspectExact(configuration), created);
    assert.equal(client.creates, 1);
    assert.equal(client.configMaps.size, 1);
    await assert.rejects(() => driver.createExact(configuration), ConfigurationConflictError);
    assert.equal(
      await driver.inspectExact({
        ...configuration,
        id: "cfg_00000000-0000-4000-8000-000000000099",
      }),
      undefined,
    );

    const stored = client.configMaps.get(
      `${namespace}/${kubernetesConfigurationName(configuration.id)}`,
    );
    stored.data["openclaw.json"] = JSON.stringify({
      plugins: configuration.values.plugins,
      agents: configuration.values.agents,
      secrets: configuration.values.secrets,
      models: configuration.values.models,
    });
    assert.deepEqual(await driver.inspectExact(configuration), created);

    stored.data["openclaw.json"] = JSON.stringify({
      ...configuration.values,
      agents: { defaults: { sandbox: { mode: "networking" } } },
    });
    await assert.rejects(() => driver.inspectExact(configuration), ConfigurationConflictError);
  });
}

test("configuration operations reject invalid references before reading Kubernetes credentials", async () => {
  const driver = createDriver();

  await assert.rejects(driver.read({ id: "agent_1", namespaceId }), /cfg_/);
  await assert.rejects(driver.delete({ id: configuration.id, namespaceId: "" }), /namespace/i);
  await assert.rejects(driver.update({ ...configuration, values: [] }), /document|object/i);
});

test("configuration CRUD fails closed when its explicitly selected kubeconfig is unavailable", async () => {
  const driver = createDriver({
    mode: "kubeconfig",
    kubeconfigPath: `/tmp/openclaw-configuration-missing-${process.pid}`,
    context: "explicit-tenant-context",
  });

  await assert.rejects(driver.read(configuration), /ENOENT|no such file/i);
  await assert.rejects(driver.create(configuration), /ENOENT|no such file/i);
});

test("the official Kubernetes client rejects ambiguous identities and insecure API servers", async (t) => {
  for (const scenario of await writeUnsafeKubeconfigs(t)) {
    const driver = createDriver({
      mode: "kubeconfig",
      kubeconfigPath: scenario.kubeconfigPath,
      context: scenario.context,
    });

    // The real Kubernetes SDK parses each fixture; unsafe identity or transport must fail
    // validation before I/O (fetch's own refusal of a credentialed URL does not count).
    await assert.rejects(
      driver.read(configuration),
      (error) =>
        error instanceof ConfigurationValidationError &&
        /context|cluster|credential|identity|verified HTTPS|URL/i.test(error.message),
      scenario.name,
    );
  }
});

test("Kubernetes Configuration rejects literal model credentials before writes and stored reads", async () => {
  const driver = createDriver();
  const sentinel = "synthetic-model-credential-not-for-configuration";
  // Slots no release ever stored a literal in: refused on writes and on stored reads.
  const refusedWhenStored = [
    { models: { providers: { openai: { apiKey: sentinel } } } },
    { models: { providers: { codex: { headers: { Authorization: `Bearer ${sentinel}` } } } } },
    { models: { providers: { openai: { headers: { "x-api-key": sentinel } } } } },
    { env: { OPENAI_API_KEY: sentinel } },
    { env: { ANTHROPIC_API_KEY: sentinel } },
    { env: { vars: { ANTHROPIC_AUTH_TOKEN: sentinel } } },
    { env: { vars: { CODEX_ACCESS_TOKEN: sentinel } } },
  ];
  // Other credential header names, model rows and OpenClaw's request transport overrides
  // (findings 1142 and 1143), refused since the 2026-10-12 notice. An older release stored
  // them, so a stored one still reads and its operator can replace it.
  const refusedOnWrite = [
    { models: { providers: { google: { headers: { "x-goog-api-key": sentinel } } } } },
    { models: { providers: { openai: { headers: { "Proxy-Authorization": sentinel } } } } },
    { models: { providers: { openai: { headers: { Cookie: `session=${sentinel}` } } } } },
    {
      models: {
        providers: { openai: { models: [{ id: "m", headers: { "x-auth-token": sentinel } }] } },
      },
    },
    {
      models: {
        providers: { openai: { request: { headers: { Authorization: `Bearer ${sentinel}` } } } },
      },
    },
    {
      models: {
        providers: {
          openai: { request: { auth: { mode: "authorization-bearer", token: sentinel } } },
        },
      },
    },
    {
      models: {
        providers: {
          openai: {
            request: { auth: { mode: "header", headerName: "x-api-key", value: sentinel } },
          },
        },
      },
    },
    { models: { providers: { openai: { headers: { x_api_key: sentinel } } } } },
    { models: { providers: { openai: { headers: { "x-functions-key": sentinel } } } } },
    // Any key, a credential, passphrase, passcode, signature or bearer word (finding 1185).
    { models: { providers: { openai: { headers: { "X-Auth-Key": sentinel } } } } },
    { models: { providers: { openai: { headers: { "x-portkey-virtual-key": sentinel } } } } },
    { models: { providers: { openai: { request: { headers: { "X-Credentials": sentinel } } } } } },
    { models: { providers: { openai: { headers: { "X-Hub-Signature-256": sentinel } } } } },
    // Authentication, JWT and assertion words, version and dot suffixes (finding 1189).
    { models: { providers: { openai: { headers: { Authentication: sentinel } } } } },
    { models: { providers: { openai: { headers: { "X-JWT-Assertion": sentinel } } } } },
    { models: { providers: { openai: { headers: { "X-Api-Key-V2": sentinel } } } } },
    // Algorithm suffixes and a glued key digit (finding 1196).
    { models: { providers: { openai: { headers: { "X-Signature-Ed25519": sentinel } } } } },
    { models: { providers: { openai: { request: { headers: { "x-api-key2": sentinel } } } } } },
    {
      models: { providers: { openai: { request: { headers: { "x.authorization": sentinel } } } } },
    },
    // The client certificate, key and passphrase for the model endpoint and its proxy.
    { models: { providers: { openai: { request: { tls: { key: sentinel } } } } } },
    { models: { providers: { openai: { request: { tls: { passphrase: sentinel } } } } } },
    {
      models: {
        providers: {
          openai: { request: { proxy: { mode: "env-proxy", tls: { cert: sentinel } } } },
        },
      },
    },
    // The other key and header slots the Gateway sends (finding 1307), refused since the
    // 2026-10-14 notice.
    { memory: { search: { remote: { apiKey: sentinel } } } },
    { tools: { media: { models: [{ headers: { Authorization: `Bearer ${sentinel}` } }] } } },
    { tts: { providers: { openai: { apiKey: sentinel } } } },
    { talk: { providers: { openai: { apiKey: sentinel } } } },
    // The other slots OpenClaw marks sensitive, and channel and plugin settings (finding 1309).
    { gateway: { auth: { token: sentinel } } },
    { hooks: { token: sentinel } },
    { channels: { telegram: { botToken: sentinel } } },
    { plugins: { entries: { brave: { config: { webSearch: { apiKey: sentinel } } } } } },
  ];
  for (const values of [...refusedWhenStored, ...refusedOnWrite]) {
    const unsafe = { ...configuration, values };
    for (const operation of ["create", "update"]) {
      await assert.rejects(driver[operation](unsafe), (error) => {
        assert.match(
          error.message,
          /holds a credential value inline, where a reference is required/,
        );
        assert.equal(error.message.includes(sentinel), false);
        return true;
      });
    }
    const stored = driver.manifest(unsafe, "existing-tenant");
    if (refusedWhenStored.includes(values)) {
      await assert.rejects(
        driver.checkedConfiguration(stored, configuration, "existing-tenant"),
        (error) => {
          assert.match(error.message, /security boundaries/);
          assert.equal(error.message.includes(sentinel), false);
          return true;
        },
      );
    } else {
      assert.deepEqual(
        await driver.checkedConfiguration(stored, configuration, "existing-tenant"),
        unsafe,
      );
    }
  }
  // A proxy URL with a user name or password carries the proxy credential in the URL.
  for (const url of [
    `http://user:${sentinel}@proxy.example:3128`,
    `http://${sentinel}@proxy`,
    `http://:${sentinel}@proxy`,
    // Finding 1250: an environment reference in the port leaves the URL unparsable as
    // written, but the user name and password are literal.
    `http://user:${sentinel}@proxy.example:\${PROXY_PORT}`,
  ]) {
    const unsafe = {
      ...configuration,
      values: {
        models: { providers: { openai: { request: { proxy: { mode: "explicit-proxy", url } } } } },
      },
    };
    for (const operation of ["create", "update"]) {
      await assert.rejects(driver[operation](unsafe), (error) => {
        assert.equal(
          error.message,
          "Configuration field /models/providers/openai/request/proxy/url carries a user name or password in the URL. Remove it, or make the whole URL a ${NAME} reference.",
        );
        return true;
      });
    }
  }
  const referenceOnly = {
    ...configuration,
    values: {
      models: {
        providers: {
          anthropic: {
            headers: { "anthropic-version": "2023-06-01", "idempotency-key": "k" },
            request: {
              tls: { ca: "-----BEGIN CERTIFICATE-----", cert: "${TLS_CERT}", key: "${TLS_KEY}" },
              proxy: {
                mode: "explicit-proxy",
                url: "http://proxy.example:3128",
                tls: { passphrase: "${PROXY_TLS_PASSPHRASE}" },
              },
            },
          },
          groq: { request: { proxy: { mode: "explicit-proxy", url: "${PROXY_URL}" } } },
          openai: {
            apiKey: "${OPENAI_API_KEY}",
            headers: {
              Authorization: "Bearer ${MODEL_TOKEN}",
              Authentication: "Bearer ${MODEL_TOKEN}",
              "X-Authorization-V2": "Bearer ${MODEL_TOKEN}",
              "x-goog-api-key": "${GOOGLE_KEY}",
            },
            request: {
              headers: { "Proxy-Authorization": "Bearer ${PROXY_TOKEN}" },
              auth: { mode: "authorization-bearer", token: "${MODEL_TOKEN}" },
            },
            models: [{ id: "m", headers: { "x-auth-token": "${MODEL_TOKEN}" } }],
          },
          google: {
            request: {
              auth: {
                mode: "header",
                headerName: "x-goog-api-key",
                value: { source: "env", provider: "default", id: "GOOGLE_KEY" },
              },
            },
          },
        },
      },
      env: { OPENAI_API_KEY: { source: "env", provider: "default", id: "MODEL_KEY" } },
      channels: {
        slack: { botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" } },
      },
    },
  };
  const stored = driver.manifest(referenceOnly, "existing-tenant");
  assert.deepEqual(
    await driver.checkedConfiguration(stored, referenceOnly, "existing-tenant"),
    referenceOnly,
  );
});

test("Kubernetes Configuration cancels an in-flight request when its provisioning claim is lost", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-configuration-cancellation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "kubeconfig.json");
  await writeFile(
    path,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "configuration", cluster: { server: "https://127.0.0.1:1" } }],
      users: [{ name: "configuration", user: { token: "test-only-fixture-token" } }],
      contexts: [
        { name: "configuration", context: { cluster: "configuration", user: "configuration" } },
      ],
      "current-context": "configuration",
    }),
  );
  const driver = createDriver({
    mode: "kubeconfig",
    kubeconfigPath: path,
    context: "configuration",
  });
  const sdk = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
    "@kubernetes/client-node",
  );
  const client = await driver.core();
  let dispatched;
  const started = new Promise((resolve) => {
    dispatched = resolve;
  });
  let finishTransport;
  // Retain the real SDK request construction, authentication and middleware.
  // Only transport is stalled, like an API that accepts a request but never responds.
  t.mock.method(
    client.api.configuration.httpApi,
    "send",
    (request) =>
      new sdk.Observable(
        new Promise((resolve, reject) => {
          finishTransport = reject;
          const signal = request.getSignal();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          dispatched();
        }),
      ),
  );
  const owner = new AbortController();
  const lost = new Error("Configuration provisioning claim lost");
  const pending = withComputeAbortSignal(owner.signal, () => driver.read(configuration));
  await started;
  owner.abort(lost);
  let timer;
  try {
    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Configuration request ignored claim loss")),
            1000,
          );
        }),
      ]),
      (error) => error === lost,
    );
  } finally {
    clearTimeout(timer);
    finishTransport(lost);
    await pending.catch(() => {});
  }
});

// The fake API with failures queued per method, each thrown before the call takes
// effect, and a method that can stall until its request is aborted.
class FlakyConfigurationCoreV1Api extends FakeConfigurationCoreV1Api {
  failureCodes = {
    listNamespace: [],
    readNamespacedConfigMap: [],
    createNamespacedConfigMap: [],
    replaceNamespacedConfigMap: [],
    deleteNamespacedConfigMap: [],
  };
  calls = Object.fromEntries(Object.keys(this.failureCodes).map((method) => [method, 0]));
  stalls = new Set();

  async called(method) {
    this.calls[method] += 1;
    const failure = this.failureCodes[method].shift();
    if (failure === "dropped") {
      // What the client throws when the API server closes the connection unanswered.
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    if (failure !== undefined) {
      throw Object.assign(new Error(`${method} failed with ${failure}`), { code: failure });
    }
    if (this.stalls.has(method)) {
      const signal = currentComputeAbortSignal();
      if (signal === undefined) {
        throw new Error(`${method} would stall with no deadline`);
      }
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }
  }

  async listNamespace(request) {
    await this.called("listNamespace");
    return super.listNamespace(request);
  }

  async readNamespacedConfigMap(request) {
    await this.called("readNamespacedConfigMap");
    return super.readNamespacedConfigMap(request);
  }

  async createNamespacedConfigMap(request) {
    await this.called("createNamespacedConfigMap");
    return super.createNamespacedConfigMap(request);
  }

  async replaceNamespacedConfigMap({ namespace, name, body }) {
    await this.called("replaceNamespacedConfigMap");
    const stored = {
      ...structuredClone(body),
      metadata: { ...body.metadata, resourceVersion: "2" },
    };
    this.configMaps.set(`${namespace}/${name}`, stored);
    return structuredClone(stored);
  }

  async deleteNamespacedConfigMap({ namespace, name }) {
    await this.called("deleteNamespacedConfigMap");
    this.configMaps.delete(`${namespace}/${name}`);
    return {};
  }
}

async function storedConfiguration() {
  const client = new FlakyConfigurationCoreV1Api();
  client.addNamespace(namespaceId);
  const driver = createDriver();
  driver.client = Promise.resolve(client);
  await driver.create(configuration);
  return { client, driver };
}

const nextGeneration = { ...configuration, generation: 2 };

// Each read the driver sends, and an operation that sends it.
const readPaths = [
  ["listNamespace", "read", (driver) => driver.read(configuration)],
  ["readNamespacedConfigMap", "read", (driver) => driver.read(configuration)],
  ["readNamespacedConfigMap", "inspectExact", (driver) => driver.inspectExact(configuration)],
  ["readNamespacedConfigMap", "update", (driver) => driver.update(nextGeneration)],
  ["readNamespacedConfigMap", "delete", (driver) => driver.delete(configuration)],
];

test("Kubernetes Configuration retries 429, 5xx and dropped reads on the pause schedule", async () => {
  for (const failure of ["dropped", 429, 500, 503]) {
    for (const [method, name, operation] of readPaths) {
      const label = `${name} ${method} ${failure}`;
      let { client, driver } = await storedConfiguration();

      // Five failures, then an answer: the operation succeeds after the five pauses.
      client.failureCodes[method].push(...Array(5).fill(failure));
      let before = client.calls[method];
      let pauses = [];
      await withRetryTimers(() => operation(driver), pauses);
      assert.equal(client.calls[method] - before, 6, label);
      assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, label);

      // A sixth failure ends the operation with the client's error once the schedule is spent.
      ({ client, driver } = await storedConfiguration());
      client.failureCodes[method].push(...Array(6).fill(failure));
      before = client.calls[method];
      pauses = [];
      await assert.rejects(
        () => withRetryTimers(() => operation(driver), pauses),
        (error) => error.code === (failure === "dropped" ? "ECONNRESET" : failure),
        label,
      );
      assert.equal(client.calls[method] - before, 6, label);
      assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, label);
      assert.equal(client.calls.replaceNamespacedConfigMap, 0, label);
      assert.equal(client.calls.deleteNamespacedConfigMap, 0, label);
    }
  }
});

test("Kubernetes Configuration ends a refused or missing read at once", async () => {
  for (const failure of [403, 404, 409, "EACCES"]) {
    for (const [method, name, operation] of readPaths) {
      const label = `${name} ${method} ${failure}`;
      const { client, driver } = await storedConfiguration();
      client.failureCodes[method].push(failure);
      const before = client.calls[method];
      const pauses = [];
      if (failure === 404 && name === "inspectExact") {
        assert.equal(await withRetryTimers(() => operation(driver), pauses), undefined, label);
      } else {
        await assert.rejects(
          () => withRetryTimers(() => operation(driver), pauses),
          (error) => error.code === failure,
          label,
        );
      }
      assert.equal(client.calls[method] - before, 1, label);
      assert.deepEqual(pauses, [], label);
    }
  }
});

test("Kubernetes Configuration sends a failed write once, even when a read would retry", async () => {
  const otherConfiguration = { ...configuration, id: "cfg_00000000-0000-4000-8000-000000000002" };
  for (const failure of ["dropped", 429, 503]) {
    for (const [name, method, write] of [
      ["create", "createNamespacedConfigMap", (driver) => driver.create(otherConfiguration)],
      [
        "createExact",
        "createNamespacedConfigMap",
        (driver) => driver.createExact(otherConfiguration),
      ],
      ["update", "replaceNamespacedConfigMap", (driver) => driver.update(nextGeneration)],
      ["delete", "deleteNamespacedConfigMap", (driver) => driver.delete(configuration)],
    ]) {
      const label = `${name} ${method} ${failure}`;
      const { client, driver } = await storedConfiguration();
      const stored = structuredClone([...client.configMaps.entries()]);
      client.failureCodes[method].push(failure);
      const before = client.calls[method];
      const pauses = [];
      await assert.rejects(
        () => withRetryTimers(() => write(driver), pauses),
        (error) => error.code === (failure === "dropped" ? "ECONNRESET" : failure),
        label,
      );
      assert.equal(client.calls[method] - before, 1, label);
      assert.deepEqual(pauses, [], label);
      assert.deepEqual([...client.configMaps.entries()], stored, label);
    }
  }
});

test("Kubernetes Configuration ends a retry pause at once when the owner cancels", async () => {
  const { client, driver } = await storedConfiguration();
  const owner = new AbortController();
  const lost = new Error("Configuration provisioning claim lost");
  const before = client.calls.readNamespacedConfigMap;
  client.failureCodes.readNamespacedConfigMap.push("dropped", "dropped");

  // The mocked clock never moves: only the owner's abort can end the 100 ms pause.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const result = withComputeAbortSignal(owner.signal, () => driver.read(configuration));
    result.then(
      () => (settled = true),
      () => (settled = true),
    );
    const turns = async (count) => {
      for (let turn = 0; turn < count && !settled; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    // The fake client answers in microtasks, so a few turns reach the pause.
    await turns(20);
    assert.equal(settled, false, "the dropped read waits in its retry pause");
    assert.equal(client.calls.readNamespacedConfigMap - before, 1);

    owner.abort(lost);
    await turns(20);
    assert.equal(settled, true, "the owner's abort ends the pause");
    await assert.rejects(result, (error) => error === lost);
    assert.equal(
      client.calls.readNamespacedConfigMap - before,
      1,
      "no read after the cancellation",
    );
  } finally {
    // Settles the read even when an assertion above failed first.
    owner.abort(lost);
    mock.timers.reset();
  }
});

test("Kubernetes Configuration gives up on a request at its deadline and never resends it", async (t) => {
  // Each request's 10 s deadline is an AbortSignal.timeout; these deadlines fire on demand.
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", (delay) => {
    assert.equal(delay, 10_000);
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
  for (const [method, action, operation] of [
    ["readNamespacedConfigMap", "read", (driver) => driver.read(configuration)],
    ["listNamespace", "namespace verification", (driver) => driver.read(configuration)],
    ["replaceNamespacedConfigMap", "update", (driver) => driver.update(nextGeneration)],
  ]) {
    const { client, driver } = await storedConfiguration();
    client.stalls.add(method);
    const before = client.calls[method];
    const result = operation(driver);
    try {
      for (let turn = 0; client.calls[method] === before; turn += 1) {
        assert.ok(turn < 100, `${method} was never sent`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      deadlines.at(-1).abort(new DOMException("deadline", "TimeoutError"));
      await assert.rejects(
        result,
        (error) =>
          error instanceof ConfigurationBackendUnavailableError &&
          error.message === `The Kubernetes ConfigMap ${action} outcome is unknown after timeout.`,
        method,
      );
      assert.equal(client.calls[method] - before, 1, method);
    } finally {
      // Settles the operation even when an assertion above failed first.
      for (const deadline of deadlines) {
        deadline.abort();
      }
      await result.catch(() => {});
    }
  }
});

test("Kubernetes Configuration reads a ConfigMap only when every ownership mark is its own", async () => {
  const driver = createDriver();
  const physicalNamespace = "customer-support-existing";
  const observed = driver.manifest(configuration, physicalNamespace);
  const otherId = "cfg_00000000-0000-4000-8000-000000000002";
  const otherNamespaceId = "ns_00000000-0000-4000-8000-000000000002";
  for (const [mark, mutate] of [
    ["object name", (resource) => (resource.metadata.name = kubernetesConfigurationName(otherId))],
    ["Kubernetes Namespace", (resource) => (resource.metadata.namespace = "other-tenant")],
    [
      "manager label",
      (resource) => (resource.metadata.labels["app.kubernetes.io/managed-by"] = "helm"),
    ],
    [
      "Namespace label",
      (resource) => (resource.metadata.labels["openclaw.dev/namespace"] = otherNamespaceId),
    ],
    [
      "Configuration label",
      (resource) => (resource.metadata.labels["openclaw.dev/configuration"] = otherId),
    ],
    [
      "Configuration annotation",
      (resource) => (resource.metadata.annotations["openclaw.dev/configuration-id"] = otherId),
    ],
  ]) {
    const foreign = structuredClone(observed);
    mutate(foreign);
    await assert.rejects(
      driver.checkedConfiguration(foreign, configuration, physicalNamespace),
      /does not belong to the exact requested Namespace configuration/,
      mark,
    );
  }

  // An exact read (inspectExact passes the whole Configuration) also checks the creation time.
  const recreated = structuredClone(observed);
  recreated.metadata.annotations["openclaw.dev/configuration-created-at"] =
    "2026-08-20T00:00:00.000Z";
  await assert.rejects(
    driver.checkedConfiguration(recreated, configuration, physicalNamespace),
    /expected Configuration kind, generation, or creation time/,
  );
});

test("Kubernetes Configuration stores a document up to one byte under 1 MiB of UTF-8", async () => {
  const driver = createDriver();
  const limit = 1_048_576;
  const document = (text) => ({ models: { displayName: text } });
  const envelope = JSON.stringify(document("")).length;
  const largest = document("x".repeat(limit - 1 - envelope));
  const atLimit = document("x".repeat(limit - envelope));
  // "é" is two UTF-8 bytes but one UTF-16 code unit: under the limit in code units, over it
  // in bytes.
  const wide = document("é".repeat(Math.ceil((limit - envelope) / 2)));
  assert.equal(JSON.stringify(wide).length < limit, true);

  await assert.doesNotReject(driver.validate({ ...configuration, values: largest }));
  await assert.doesNotReject(driver.validateSize(largest));
  const stored = { ...configuration, values: largest };
  assert.deepEqual(
    await driver.checkedConfiguration(driver.manifest(stored, "tenant"), configuration, "tenant"),
    stored,
  );
  for (const values of [atLimit, wide]) {
    await assert.rejects(driver.validate({ ...configuration, values }), {
      name: "ConfigurationSizeError",
      limitBytes: limit,
    });
    await assert.rejects(driver.validateSize(values), {
      name: "ConfigurationSizeError",
      limitBytes: limit,
    });
    await assert.rejects(
      driver.checkedConfiguration(
        driver.manifest({ ...configuration, values }, "tenant"),
        configuration,
        "tenant",
      ),
      /ConfigMap exceeds its size limit/,
    );
  }
});

test("Kubernetes Configuration accepts only whole credential references", async () => {
  const driver = createDriver();
  const sentinel = "synthetic-model-credential-not-for-configuration";
  const provider = (settings) => ({ models: { providers: { openai: settings } } });
  for (const values of [
    // A reference must be the whole value, not a part of a literal.
    provider({ apiKey: `${sentinel}\${OPENAI_API_KEY}` }),
    provider({ apiKey: `\${OPENAI_API_KEY}${sentinel}` }),
    provider({ apiKey: `\${${sentinel}}` }),
    provider({ headers: { Authorization: `Bearer \${MODEL_TOKEN}${sentinel}` } }),
    provider({ headers: { Authorization: `${sentinel} Bearer \${MODEL_TOKEN}` } }),
    provider({ headers: { "api-key": sentinel } }),
    // The Bearer form is a reference only in an Authorization header.
    provider({ apiKey: "Bearer ${OPENAI_API_KEY}" }),
    // A SecretRef names a source, provider and ID, and carries nothing else.
    provider({ apiKey: { source: "store", provider: "teamstore", id: "KEY", value: sentinel } }),
    provider({ apiKey: { source: "store", provider: "", id: sentinel } }),
  ]) {
    const unsafe = { ...configuration, values };
    await assert.rejects(driver.create(unsafe), (error) => {
      assert.match(error.message, /holds a credential value inline, where a reference is required/);
      assert.equal(error.message.includes(sentinel), false);
      return true;
    });
    await assert.rejects(
      driver.checkedConfiguration(driver.manifest(unsafe, "tenant"), configuration, "tenant"),
      /security boundaries/,
    );
  }
  // Other headers are not credential slots and may hold literals.
  await assert.doesNotReject(
    driver.validate({ ...configuration, values: provider({ headers: { "x-api-key-id": "a" } }) }),
  );
});

// The API server's write preconditions, and another writer that changes the ConfigMap right
// after the driver reads it.
class RacedConfigurationCoreV1Api extends FlakyConfigurationCoreV1Api {
  raceAfterRead;

  async readNamespacedConfigMap(request) {
    const answer = await super.readNamespacedConfigMap(request);
    const race = this.raceAfterRead;
    this.raceAfterRead = undefined;
    race?.(this.configMaps.get(`${request.namespace}/${request.name}`));
    return answer;
  }

  async replaceNamespacedConfigMap(request) {
    const stored = this.configMaps.get(`${request.namespace}/${request.name}`);
    const expected = request.body.metadata?.resourceVersion;
    if (stored === undefined) {
      throw Object.assign(new Error("missing ConfigMap"), { code: 404 });
    }
    if (expected !== undefined && expected !== stored.metadata.resourceVersion) {
      throw Object.assign(new Error("the object has been modified"), { code: 409 });
    }
    return super.replaceNamespacedConfigMap(request);
  }

  async deleteNamespacedConfigMap(request) {
    const stored = this.configMaps.get(`${request.namespace}/${request.name}`);
    const uid = request.body?.preconditions?.uid;
    if (stored === undefined) {
      throw Object.assign(new Error("missing ConfigMap"), { code: 404 });
    }
    if (uid !== undefined && uid !== stored.metadata.uid) {
      throw Object.assign(new Error("precondition failed: UID"), { code: 409 });
    }
    return super.deleteNamespacedConfigMap(request);
  }
}

test("Kubernetes Configuration changes only the exact ConfigMap it read", async () => {
  const setup = async () => {
    const client = new RacedConfigurationCoreV1Api();
    const namespace = client.addNamespace(namespaceId);
    const driver = createDriver();
    driver.client = Promise.resolve(client);
    await driver.create(configuration);
    const key = `${namespace}/${kubernetesConfigurationName(configuration.id)}`;
    return { client, driver, stored: () => client.configMaps.get(key) };
  };

  // Update moves the generation by exactly one, either way, and keeps the creation time.
  {
    const { client, driver } = await setup();
    await assert.rejects(driver.update({ ...configuration }), /generation/);
    await assert.rejects(
      driver.update({ ...nextGeneration, createdAt: "2026-08-20T00:00:00.000Z" }),
      /creation time cannot be changed/,
    );
    assert.equal(client.calls.replaceNamespacedConfigMap, 0);
    await driver.update(nextGeneration);
    assert.deepEqual(await driver.update(configuration), configuration);
  }

  // A write another writer made after the read conflicts instead of being overwritten.
  {
    const { client, driver, stored } = await setup();
    client.raceAfterRead = (current) => {
      current.metadata.resourceVersion = "5";
      current.data["openclaw.json"] = JSON.stringify({ written: "elsewhere" });
    };
    await assert.rejects(driver.update(nextGeneration), (error) => error.code === 409);
    assert.equal(stored().data["openclaw.json"], JSON.stringify({ written: "elsewhere" }));
  }

  // A stored document that breaks the value rules is never written over.
  {
    const { client, driver, stored } = await setup();
    stored().data["openclaw.json"] = JSON.stringify({ env: { OPENAI_API_KEY: "literal-key" } });
    await assert.rejects(driver.update(nextGeneration), /security boundaries/);
    assert.equal(client.calls.replaceNamespacedConfigMap, 0);
  }

  // A ConfigMap deleted and recreated after the read survives the delete.
  {
    const { client, driver, stored } = await setup();
    client.raceAfterRead = (current) => (current.metadata.uid = "uid-recreated");
    await assert.rejects(driver.delete(configuration), (error) => error.code === 409);
    assert.equal(stored().metadata.uid, "uid-recreated");
  }

  // A same-named ConfigMap with another manager is never deleted.
  {
    const { client, driver, stored } = await setup();
    stored().metadata.labels["app.kubernetes.io/managed-by"] = "helm";
    await assert.rejects(driver.delete(configuration), /exact requested Namespace configuration/);
    assert.equal(client.calls.deleteNamespacedConfigMap, 0);
    assert.notEqual(stored(), undefined);
  }

  // An exact inspection of one recreated at another time reports a conflict.
  {
    const { driver, stored } = await setup();
    stored().metadata.annotations["openclaw.dev/configuration-created-at"] =
      "2026-08-20T00:00:00.000Z";
    await assert.rejects(driver.inspectExact(configuration), ConfigurationConflictError);
  }
});

test("Kubernetes Configuration reads and replaces a stored document with credentials refused since it was saved", async () => {
  // An older release stored a literal request.auth token in a ConfigMap. After the upgrade the
  // Driver reads it and accepts a replacement without it, so the operator can repair it; a
  // write or deployment validation that keeps the literal is still refused.
  const sentinel = "synthetic-model-credential-not-for-configuration";
  const { client, driver } = await storedConfiguration();
  const stale = {
    ...configuration,
    values: {
      ...configuration.values,
      models: {
        providers: {
          openai: {
            ...configuration.values.models.providers.openai,
            request: { auth: { mode: "authorization-bearer", token: sentinel } },
          },
        },
      },
    },
  };
  const [key, stored] = [...client.configMaps.entries()][0];
  client.configMaps.set(key, {
    ...stored,
    data: { "openclaw.json": JSON.stringify(stale.values) },
  });

  assert.deepEqual(await driver.read(configuration), stale);
  const refusal = (error) => {
    assert.equal(
      error.message,
      "Configuration field /models/providers/openai/request/auth/token holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.",
    );
    return true;
  };
  // Deployment validates the stored document before it is admitted.
  await assert.rejects(driver.validate(stale), refusal);
  await assert.rejects(driver.update({ ...stale, generation: 2 }), refusal);
  assert.equal(client.calls.replaceNamespacedConfigMap, 0);

  assert.deepEqual(await driver.update(nextGeneration), nextGeneration);
  assert.equal(client.configMaps.get(key).data["openclaw.json"].includes(sentinel), false);
  assert.deepEqual(await driver.read({ id: configuration.id, namespaceId }), nextGeneration);
});
