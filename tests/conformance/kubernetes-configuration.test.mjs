import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  ConfigurationConflictError,
  ConfigurationValidationError,
  KubernetesConfigurationDriver,
  kubernetesConfigurationName,
} from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
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
    KubernetesConfigurationDriver.validateConfiguration({ authentication: { mode: "inCluster" } }),
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
    assert.throws(() => KubernetesConfigurationDriver.validateConfiguration(invalid), refusal);
    assert.throws(() => new KubernetesConfigurationDriver(invalid), refusal);
  }

  // Inherited client injection must not evade the closed own-property schema.
  const inheritedClients = Object.assign(Object.create({ clients: {} }), {
    authentication: { mode: "inCluster" },
  });
  assert.throws(() => new KubernetesConfigurationDriver(inheritedClients), /client/i);
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
  const valuesWithCredential = [
    { models: { providers: { openai: { apiKey: sentinel } } } },
    { models: { providers: { codex: { headers: { Authorization: `Bearer ${sentinel}` } } } } },
    { models: { providers: { openai: { headers: { "x-api-key": sentinel } } } } },
    { env: { OPENAI_API_KEY: sentinel } },
    { env: { ANTHROPIC_API_KEY: sentinel } },
    { env: { vars: { ANTHROPIC_AUTH_TOKEN: sentinel } } },
    { env: { vars: { CODEX_ACCESS_TOKEN: sentinel } } },
  ];
  for (const values of valuesWithCredential) {
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
    await assert.rejects(
      driver.checkedConfiguration(stored, configuration, "existing-tenant"),
      (error) => {
        assert.match(error.message, /security boundaries/);
        assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );
  }
  const referenceOnly = {
    ...configuration,
    values: {
      models: {
        providers: {
          openai: {
            apiKey: "${OPENAI_API_KEY}",
            headers: { Authorization: "Bearer ${MODEL_TOKEN}" },
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
