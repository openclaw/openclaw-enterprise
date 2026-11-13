import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
  type Configuration,
  type OpenClawConfigurationDocument,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { mock } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  ConfigurationBackendUnavailableError,
  ConfigurationConflictError,
  ConfigurationValidationError,
  KubernetesConfigurationDriver,
  kubernetesConfigurationName,
  type KubernetesConfigurationDriverOptions,
} from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { withMutationDeadline } from "../../apps/controller/src/admission/mutation-deadline.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  FakeConfigurationCoreV1Api,
  FlakyConfigurationCoreV1Api,
} from "../helpers/kubernetes-configuration-core.ts";
import {
  MINIMUM_SEND_BUDGET_MS,
  READ_RETRY_PAUSES_MS,
  controlledRequestTimeouts,
  frozenClock,
  nextTurns,
  settlement,
  untilSent,
  withRetryTimers,
} from "../helpers/kubernetes-core-api.ts";
import { writeUnsafeKubeconfigs } from "../helpers/unsafe-kubeconfigs.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { within } from "../helpers/wait-for.mjs";

type ConfigMap = Awaited<ReturnType<FakeConfigurationCoreV1Api["readNamespacedConfigMap"]>>;
type ConfigurationConfigMap = ConfigMap & {
  metadata: { labels: Record<string, string>; annotations: Record<string, string> };
  data: Record<string, string>;
};
type Sdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type HttpApi = ReturnType<Sdk["createConfiguration"]>["httpApi"];
type DriverInternals = {
  manifest(configuration: Configuration, namespace: string): ConfigMap;
  checkedConfiguration(
    observed: ConfigMap,
    reference: Parameters<KubernetesConfigurationDriver["read"]>[0],
    namespace: string,
  ): Promise<Configuration>;
  core(): Promise<InstanceType<Sdk["CoreV1Api"]>>;
};
type OperationPath = [
  method: keyof FlakyConfigurationCoreV1Api["calls"],
  action: string,
  operation: (driver: KubernetesConfigurationDriver) => Promise<Configuration | void>,
];

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
      credential_proxy: { enabled: true },
    },
    agents: { defaults: { sandbox: { mode: "all" } } },
    plugins: { entries: { example: { config: { enabled: true, retries: 3, tags: [null] } } } },
  },
  createdAt: "2026-08-19T00:00:00.000Z",
} satisfies Configuration;

function createDriver(
  authentication: KubernetesConfigurationDriverOptions["authentication"] = { mode: "inCluster" },
) {
  return new KubernetesConfigurationDriver({ authentication });
}

function useClient(
  driver: KubernetesConfigurationDriver,
  client: FakeConfigurationCoreV1Api,
): void {
  Object.assign(driver, { client: Promise.resolve(client) });
}

// TypeScript erases private method signatures from the controller's project declarations.
function configurationDriverInternals(driver: object): DriverInternals {
  assert.ok("manifest" in driver && typeof driver.manifest === "function");
  assert.ok("checkedConfiguration" in driver && typeof driver.checkedConfiguration === "function");
  assert.ok("core" in driver && typeof driver.core === "function");
  return driver as DriverInternals;
}

function assertConfigurationConfigMap(
  resource: ConfigMap | undefined,
): asserts resource is ConfigurationConfigMap {
  assert.ok(resource?.metadata?.labels && resource.metadata.annotations && resource.data);
}

function hasErrorCode(error: unknown, code: string | number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  assert.ok(
    typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string",
  );
  return error.message;
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
  const invalidOptions: [unknown, RegExp][] = [
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
  ];
  for (const [invalid, refusal] of invalidOptions) {
    assert.throws(
      () => requireConfiguration(KubernetesConfigurationDriver, invalid),
      SharedConfigurationValidationError,
    );
    assert.throws(
      // @ts-expect-error Pass the untrusted input through the constructor's runtime validation.
      () => new KubernetesConfigurationDriver(invalid),
      SharedConfigurationValidationError,
      String(refusal),
    );
  }

  // Inherited client injection must not evade the closed own-property schema.
  const inheritedClients = {
    __proto__: { clients: {} },
    authentication: { mode: "inCluster" as const },
  };
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

  const invalidDocuments: [unknown, RegExp][] = [
    [undefined, /document|object/i],
    [null, /document|object/i],
    [[], /document|object/i],
    [{ models: { displayName: "x".repeat(1_048_576) } }, /size/i],
  ];
  for (const [values, reason] of invalidDocuments) {
    // @ts-expect-error Exercise runtime rejection of non-document values.
    await assert.rejects(driver.validate({ ...configuration, values }), reason);
  }

  await assert.rejects(driver.validate({ ...configuration, id: "agent_1" }), /cfg_/);
  await assert.rejects(driver.validate({ ...configuration, namespaceId: "" }), /namespace/i);
  for (const kind of [undefined, "gateway", "namespace", ""]) {
    // @ts-expect-error Exercise runtime rejection of invalid Configuration kinds.
    await assert.rejects(driver.validate({ ...configuration, kind }), /kind|agent/i);
  }
  for (const generation of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    // @ts-expect-error Exercise runtime rejection of invalid Configuration generations.
    await assert.rejects(driver.validate({ ...configuration, generation }), /generation/i);
  }
  await assert.rejects(driver.validate({ ...configuration, createdAt: "invalid" }), /time/i);
});

test("ConfigMaps contain exactly one native document and preserve real ownership boundaries", async () => {
  const driver = createDriver();
  const internals = configurationDriverInternals(driver);
  const physicalNamespace = "customer-support-existing";

  // Exercise the production serializer/read boundary directly without claiming a mock is a cluster.
  const observed = internals.manifest(configuration, physicalNamespace);
  assertConfigurationConfigMap(observed);
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
    await internals.checkedConfiguration(observed, configuration, physicalNamespace),
    configuration,
  );
  assert.deepEqual(
    await internals.checkedConfiguration(
      { ...observed, binaryData: {} },
      configuration,
      physicalNamespace,
    ),
    configuration,
  );

  const invalidMaps: [(resource: ConfigurationConfigMap) => void, RegExp][] = [
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
  ];
  for (const [mutate, reason] of invalidMaps) {
    const invalid = structuredClone(observed);
    mutate(invalid);
    await assert.rejects(
      internals.checkedConfiguration(invalid, configuration, physicalNamespace),
      reason,
    );
  }
});

for (const layout of ["shared", "adopted", "split"] as const) {
  test(`Kubernetes Configuration inspectExact recovers only the exact Configuration (${layout})`, async () => {
    const client = new FakeConfigurationCoreV1Api();
    const namespace = client.addNamespace(namespaceId, layout);
    const driver = createDriver();
    useClient(driver, client);

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
    assertConfigurationConfigMap(stored);
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
  // @ts-expect-error Pass a malformed document to the runtime update boundary.
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
  const scenarios: { kubeconfigPath: unknown; context: unknown; name: unknown }[] =
    await writeUnsafeKubeconfigs(t);
  for (const scenario of scenarios) {
    assert.ok(typeof scenario.kubeconfigPath === "string");
    assert.ok(typeof scenario.context === "string");
    assert.ok(typeof scenario.name === "string");
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
  const internals = configurationDriverInternals(driver);
  const sentinel = "synthetic-model-credential-not-for-configuration";
  // Slots no release ever stored a literal in: refused on writes and on stored reads.
  const refusedWhenStored: OpenClawConfigurationDocument[] = [
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
  const refusedOnWrite: OpenClawConfigurationDocument[] = [
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
    for (const operation of ["create", "update"] as const) {
      await assert.rejects(driver[operation](unsafe), (error) => {
        const message = errorMessage(error);
        assert.match(message, /holds a credential value inline, where a reference is required/);
        assert.equal(message.includes(sentinel), false);
        return true;
      });
    }
    const stored = internals.manifest(unsafe, "existing-tenant");
    if (refusedWhenStored.includes(values)) {
      await assert.rejects(
        internals.checkedConfiguration(stored, configuration, "existing-tenant"),
        (error) => {
          const message = errorMessage(error);
          assert.match(message, /security boundaries/);
          assert.equal(message.includes(sentinel), false);
          return true;
        },
      );
    } else {
      assert.deepEqual(
        await internals.checkedConfiguration(stored, configuration, "existing-tenant"),
        unsafe,
      );
    }
  }
  // A proxy URL with a user name or password carries the proxy credential in the URL.
  const credentialUrl: (options: {
    protocol: string;
    username: string;
    password: string;
    host: string;
    port: number | string | undefined;
  }) => string = syntheticCredentialUrl;
  for (const url of [
    credentialUrl({
      protocol: "http",
      username: "user",
      password: sentinel,
      host: "proxy.example",
      port: 3128,
    }),
    credentialUrl({
      protocol: "http",
      username: sentinel,
      password: "",
      host: "proxy",
      port: undefined,
    }).replace(":@", "@"),
    credentialUrl({
      protocol: "http",
      username: "",
      password: sentinel,
      host: "proxy",
      port: undefined,
    }),
    // Finding 1250: an environment reference in the port leaves the URL unparsable as
    // written, but the user name and password are literal.
    credentialUrl({
      protocol: "http",
      username: "user",
      password: sentinel,
      host: "proxy.example",
      port: "${PROXY_PORT}",
    }),
  ]) {
    const unsafe = {
      ...configuration,
      values: {
        models: { providers: { openai: { request: { proxy: { mode: "explicit-proxy", url } } } } },
      },
    };
    for (const operation of ["create", "update"] as const) {
      await assert.rejects(driver[operation](unsafe), (error) => {
        assert.equal(
          errorMessage(error),
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
  const stored = internals.manifest(referenceOnly, "existing-tenant");
  assert.deepEqual(
    await internals.checkedConfiguration(stored, referenceOnly, "existing-tenant"),
    referenceOnly,
  );
});

test("Kubernetes Configuration cancels an in-flight request when its provisioning claim is lost", async (t) => {
  const directory = await temporaryDirectory(t, "oce-configuration-cancellation-");
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
  const requireSdk: (specifier: string) => unknown = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const sdk = requireSdk("@kubernetes/client-node");
  assert.ok(typeof sdk === "object" && sdk !== null && "Observable" in sdk);
  assert.equal(typeof sdk.Observable, "function");
  const Observable = sdk.Observable as Sdk["Observable"];
  const client: object = await configurationDriverInternals(driver).core();
  assert.ok("api" in client);
  const { api } = client;
  assert.ok(typeof api === "object" && api !== null && "configuration" in api);
  const { configuration: sdkConfiguration } = api;
  assert.ok(
    typeof sdkConfiguration === "object" &&
      sdkConfiguration !== null &&
      "httpApi" in sdkConfiguration,
  );
  const { httpApi } = sdkConfiguration;
  assert.ok(typeof httpApi === "object" && httpApi !== null && "send" in httpApi);
  assert.equal(typeof httpApi.send, "function");
  const { promise: started, resolve: dispatched } = Promise.withResolvers<void>();
  let finishTransport: ((reason: unknown) => void) | undefined;
  // Retain the real SDK request construction, authentication and middleware.
  // Only transport is stalled, like an API that accepts a request but never responds.
  const send: HttpApi["send"] = (request) => {
    const { promise: stalled, reject } = Promise.withResolvers<never>();
    finishTransport = reject;
    const signal:
      (Pick<AbortSignal, "addEventListener"> & { readonly reason: unknown }) | undefined =
      request.getSignal();
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    dispatched();
    return new Observable(stalled);
  };
  t.mock.method(httpApi as Pick<HttpApi, "send">, "send", send);
  const owner = new AbortController();
  const lost = new Error("Configuration provisioning claim lost");
  const pending = withComputeAbortSignal(owner.signal, () => driver.read(configuration));
  await started;
  owner.abort(lost);
  try {
    await assert.rejects(
      within(pending, "Configuration request ignored claim loss", 1_000),
      (error) => error === lost,
    );
  } finally {
    assert.ok(finishTransport);
    finishTransport(lost);
    await pending.catch(() => {});
  }
});

// A Driver over `client` with `configuration` stored, and the stored ConfigMap.
type StoredConfiguration<T extends FlakyConfigurationCoreV1Api> = {
  client: T;
  driver: KubernetesConfigurationDriver;
  stored: () => ConfigMap | undefined;
};

async function storedConfiguration(
  client?: undefined,
): Promise<StoredConfiguration<FlakyConfigurationCoreV1Api>>;
async function storedConfiguration<T extends FlakyConfigurationCoreV1Api>(
  client: T,
): Promise<StoredConfiguration<T>>;
async function storedConfiguration(client = new FlakyConfigurationCoreV1Api()) {
  const namespace = client.addNamespace(namespaceId);
  const driver = createDriver();
  useClient(driver, client);
  await driver.create(configuration);
  const key = `${namespace}/${kubernetesConfigurationName(configuration.id)}`;
  return { client, driver, stored: () => client.configMaps.get(key) };
}

function storedGeneration(stored: () => ConfigMap | undefined) {
  const resource = stored();
  assertConfigurationConfigMap(resource);
  return resource.metadata.annotations["openclaw.dev/configuration-generation"];
}

const nextGeneration = { ...configuration, generation: 2 };

// Each read the driver sends, and an operation that sends it.
const readPaths: OperationPath[] = [
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
      client.failureCodes[method].push(...Array.from({ length: 5 }, () => failure));
      let before = client.calls[method];
      let pauses: number[] = [];
      await withRetryTimers(() => operation(driver), pauses);
      assert.equal(client.calls[method] - before, 6, label);
      assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, label);

      // A sixth failure ends the operation with the client's error once the schedule is spent.
      ({ client, driver } = await storedConfiguration());
      client.failureCodes[method].push(...Array.from({ length: 6 }, () => failure));
      before = client.calls[method];
      pauses = [];
      await assert.rejects(
        () => withRetryTimers(() => operation(driver), pauses),
        (error) => hasErrorCode(error, failure === "dropped" ? "ECONNRESET" : failure),
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
      const pauses: number[] = [];
      if (failure === 404 && name === "inspectExact") {
        assert.equal(await withRetryTimers(() => operation(driver), pauses), undefined, label);
      } else {
        await assert.rejects(
          () => withRetryTimers(() => operation(driver), pauses),
          (error) => hasErrorCode(error, failure),
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
  const writePaths: OperationPath[] = [
    ["createNamespacedConfigMap", "create", (driver) => driver.create(otherConfiguration)],
    [
      "createNamespacedConfigMap",
      "createExact",
      (driver) => driver.createExact(otherConfiguration),
    ],
    ["replaceNamespacedConfigMap", "update", (driver) => driver.update(nextGeneration)],
    ["deleteNamespacedConfigMap", "delete", (driver) => driver.delete(configuration)],
  ];
  for (const failure of ["dropped", 429, 503]) {
    for (const [method, name, write] of writePaths) {
      const label = `${name} ${method} ${failure}`;
      const { client, driver } = await storedConfiguration();
      const stored = structuredClone([...client.configMaps.entries()]);
      client.failureCodes[method].push(failure);
      const before = client.calls[method];
      const pauses: number[] = [];
      await assert.rejects(
        () => withRetryTimers(() => write(driver), pauses),
        (error) => hasErrorCode(error, failure === "dropped" ? "ECONNRESET" : failure),
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
    const result = withComputeAbortSignal(owner.signal, () => driver.read(configuration));
    const state = settlement(result);
    await nextTurns(20, () => state.settled);
    assert.equal(state.settled, false, "the dropped read waits in its retry pause");
    assert.equal(client.calls.readNamespacedConfigMap - before, 1);

    owner.abort(lost);
    await nextTurns(20, () => state.settled);
    assert.equal(state.settled, true, "the owner's abort ends the pause");
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
  const timeouts = controlledRequestTimeouts(t);
  const operations: OperationPath[] = [
    ["readNamespacedConfigMap", "read", (driver) => driver.read(configuration)],
    ["listNamespace", "namespace verification", (driver) => driver.read(configuration)],
    ["replaceNamespacedConfigMap", "update", (driver) => driver.update(nextGeneration)],
  ];
  for (const [method, action, operation] of operations) {
    const { client, driver } = await storedConfiguration();
    client.stalls.add(method);
    const before = client.calls[method];
    const result = operation(driver);
    try {
      await untilSent(() => client.calls[method] > before, method);
      timeouts.fireLatest();
      await assert.rejects(
        result,
        (error) =>
          error instanceof ConfigurationBackendUnavailableError &&
          error.message === `The Kubernetes ConfigMap ${action} outcome is unknown after timeout.`,
        method,
      );
      assert.equal(client.calls[method] - before, 1, method);
    } finally {
      timeouts.fireAll();
      await result.catch(() => {});
    }
  }
  assert.deepEqual(
    timeouts.delays.filter((delay) => delay !== 10_000),
    [],
  );
});

test("Kubernetes Configuration sends no call past an API mutation's deadline", async (t) => {
  // Finding 3106: a save's chained calls each had 10 s, so a slow API server let the save commit
  // after the ingress answered 504. Under a mutation deadline each call gets only the time left,
  // and nothing is sent once it has passed. Read retries under the deadline have their own test.
  const clock = frozenClock(t);
  const timeouts = controlledRequestTimeouts(t);
  const sent = (client: FlakyConfigurationCoreV1Api) => ({ ...client.calls });
  const updateBy = (driver: KubernetesConfigurationDriver, deadline: number) =>
    withMutationDeadline(deadline, () => driver.update(nextGeneration));
  const notSent = (action: string) => (error: unknown) =>
    error instanceof ConfigurationBackendUnavailableError &&
    error.message ===
      `The Kubernetes ConfigMap ${action} was not sent: the request ran out of time.`;

  // A stalled read is cut when the deadline arrives, not after its own 10 s, and the write that
  // would follow is never sent.
  let { client, driver } = await storedConfiguration();
  let before = sent(client);
  timeouts.delays.length = 0;
  client.stalls.add("readNamespacedConfigMap");
  const stalled = updateBy(driver, clock.now + 3_000);
  try {
    await untilSent(
      () => client.calls.readNamespacedConfigMap > before.readNamespacedConfigMap,
      "the read",
    );
    assert.deepEqual(timeouts.delays, [3_000, 3_000], "namespace verification, then the read");
    timeouts.fireLatest();
    await assert.rejects(
      stalled,
      (error) =>
        error instanceof ConfigurationBackendUnavailableError &&
        error.message === "The Kubernetes ConfigMap read outcome is unknown after timeout.",
    );
  } finally {
    timeouts.fireAll();
    await stalled.catch(() => {});
  }
  assert.equal(client.calls.replaceNamespacedConfigMap, before.replaceNamespacedConfigMap);

  // A deadline that passes while the read is answered stops the update before its write.
  const replacement = await storedConfiguration();
  ({ client, driver } = replacement);
  before = sent(client);
  const read = client.readNamespacedConfigMap.bind(client);
  client.readNamespacedConfigMap = async (request) => {
    const answer = await read(request);
    clock.now += 3_000;
    return answer;
  };
  await assert.rejects(updateBy(driver, clock.now + 3_000), notSent("update"));
  assert.equal(client.calls.replaceNamespacedConfigMap, before.replaceNamespacedConfigMap);
  assert.equal(storedGeneration(replacement.stored), "1");

  // An expired deadline sends nothing at all.
  ({ client, driver } = await storedConfiguration());
  before = sent(client);
  await assert.rejects(updateBy(driver, clock.now), notSent("namespace verification"));
  assert.deepEqual(sent(client), before);
});

test("Kubernetes Configuration sends no write with less than the minimum send budget left", async (t) => {
  // A write sent just before an API mutation's deadline is likely cut off as "outcome unknown"
  // while the API server still applies it. With less than MINIMUM_SEND_BUDGET_MS left the
  // update fails cleanly as "not sent" instead, and the stored ConfigMap keeps generation 1.
  const clock = frozenClock(t);
  for (const [leftMs, sent] of [
    [MINIMUM_SEND_BUDGET_MS - 1, false],
    [MINIMUM_SEND_BUDGET_MS, true],
  ] as const) {
    const { client, driver, stored } = await storedConfiguration();
    const before = client.calls.replaceNamespacedConfigMap;
    // The update's read is answered when exactly `leftMs` of the budget remains.
    const deadline = clock.now + 5_000;
    const read = client.readNamespacedConfigMap.bind(client);
    client.readNamespacedConfigMap = async (request) => {
      const answer = await read(request);
      clock.now = deadline - leftMs;
      return answer;
    };
    const update = withMutationDeadline(deadline, () => driver.update(nextGeneration));
    if (sent) {
      await update;
      assert.equal(storedGeneration(stored), "2");
    } else {
      await assert.rejects(
        update,
        (error) =>
          error instanceof ConfigurationBackendUnavailableError &&
          error.message ===
            "The Kubernetes ConfigMap update was not sent: the request ran out of time.",
      );
      assert.equal(storedGeneration(stored), "1");
    }
    assert.equal(client.calls.replaceNamespacedConfigMap - before, sent ? 1 : 0, `${leftMs} ms`);
  }
});

test("Kubernetes Configuration retries a read only with room for the pause and an attempt", async (t) => {
  const clock = frozenClock(t);
  const [pause] = READ_RETRY_PAUSES_MS;
  assert.ok(pause !== undefined);

  // A dropped namespace verification is not retried when the pause would leave less than
  // MINIMUM_SEND_BUDGET_MS for the next attempt: the real failure is reported at once.
  let { client, driver } = await storedConfiguration();
  let before = client.calls.listNamespace;
  client.failureCodes.listNamespace.push("dropped");
  await assert.rejects(
    withMutationDeadline(clock.now + pause + MINIMUM_SEND_BUDGET_MS - 1, () =>
      driver.update(nextGeneration),
    ),
    { code: "ECONNRESET" },
  );
  assert.equal(client.calls.listNamespace - before, 1);

  // With room it is retried. When the pause ends late, past the deadline, the read reports the
  // failure its sent attempt got, not "was not sent".
  ({ client, driver } = await storedConfiguration());
  before = client.calls.listNamespace;
  client.failureCodes.listNamespace.push("dropped");
  const realSetTimeout = globalThis.setTimeout;
  const late = t.mock.method(
    globalThis,
    "setTimeout",
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay !== pause) {
        return realSetTimeout(callback, delay, ...args);
      }
      // The retry pause's timer fires a moment after the whole budget.
      clock.now += pause + MINIMUM_SEND_BUDGET_MS + 1;
      return realSetTimeout(callback, 0, ...args);
    },
  );
  await assert.rejects(
    withMutationDeadline(clock.now + pause + MINIMUM_SEND_BUDGET_MS, () =>
      driver.update(nextGeneration),
    ),
    { code: "ECONNRESET" },
  );
  const pauses = late.mock.calls.filter(({ arguments: [, delay] }) => delay === pause).length;
  late.mock.restore();
  assert.equal(pauses, 1, "the retry was scheduled");
  assert.equal(client.calls.listNamespace - before, 1);
  assert.equal(client.calls.replaceNamespacedConfigMap, 0);
});

test("Kubernetes Configuration reads a ConfigMap only when every ownership mark is its own", async () => {
  const driver = createDriver();
  const internals = configurationDriverInternals(driver);
  const physicalNamespace = "customer-support-existing";
  const observed = internals.manifest(configuration, physicalNamespace);
  assertConfigurationConfigMap(observed);
  const otherId = "cfg_00000000-0000-4000-8000-000000000002";
  const otherNamespaceId = "ns_00000000-0000-4000-8000-000000000002";
  const ownershipMarks: [string, (resource: ConfigurationConfigMap) => void][] = [
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
  ];
  for (const [mark, mutate] of ownershipMarks) {
    const foreign = structuredClone(observed);
    mutate(foreign);
    await assert.rejects(
      internals.checkedConfiguration(foreign, configuration, physicalNamespace),
      /does not belong to the exact requested Namespace configuration/,
      mark,
    );
  }

  // An exact read (inspectExact passes the whole Configuration) also checks the creation time.
  const recreated = structuredClone(observed);
  recreated.metadata.annotations["openclaw.dev/configuration-created-at"] =
    "2026-08-20T00:00:00.000Z";
  await assert.rejects(
    internals.checkedConfiguration(recreated, configuration, physicalNamespace),
    /expected Configuration kind, generation, or creation time/,
  );
});

test("Kubernetes Configuration stores a document up to one byte under 1 MiB of UTF-8", async () => {
  const driver = createDriver();
  const internals = configurationDriverInternals(driver);
  const limit = 1_048_576;
  const document = (text: string) => ({ models: { displayName: text } });
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
    await internals.checkedConfiguration(
      internals.manifest(stored, "tenant"),
      configuration,
      "tenant",
    ),
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
      internals.checkedConfiguration(
        internals.manifest({ ...configuration, values }, "tenant"),
        configuration,
        "tenant",
      ),
      /ConfigMap exceeds its size limit/,
    );
  }
});

test("Kubernetes Configuration accepts only whole credential references", async () => {
  const driver = createDriver();
  const internals = configurationDriverInternals(driver);
  const sentinel = "synthetic-model-credential-not-for-configuration";
  const provider = (settings: OpenClawConfigurationDocument) => ({
    models: { providers: { openai: settings } },
  });
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
      const message = errorMessage(error);
      assert.match(message, /holds a credential value inline, where a reference is required/);
      assert.equal(message.includes(sentinel), false);
      return true;
    });
    await assert.rejects(
      internals.checkedConfiguration(internals.manifest(unsafe, "tenant"), configuration, "tenant"),
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
  raceAfterRead: ((current: ConfigurationConfigMap) => void) | undefined;

  override async readNamespacedConfigMap(
    request: Parameters<FlakyConfigurationCoreV1Api["readNamespacedConfigMap"]>[0],
  ) {
    const answer = await super.readNamespacedConfigMap(request);
    const race = this.raceAfterRead;
    this.raceAfterRead = undefined;
    if (race !== undefined) {
      const current = this.configMaps.get(`${request.namespace}/${request.name}`);
      assertConfigurationConfigMap(current);
      race(current);
    }
    return answer;
  }

  override async replaceNamespacedConfigMap(
    request: Parameters<FlakyConfigurationCoreV1Api["replaceNamespacedConfigMap"]>[0],
  ) {
    const stored = this.configMaps.get(`${request.namespace}/${request.name}`);
    const expected = request.body.metadata?.resourceVersion;
    if (stored === undefined) {
      throw Object.assign(new Error("missing ConfigMap"), { code: 404 });
    }
    if (expected !== undefined) {
      assert.ok(stored.metadata);
      if (expected !== stored.metadata.resourceVersion) {
        throw Object.assign(new Error("the object has been modified"), { code: 409 });
      }
    }
    return super.replaceNamespacedConfigMap(request);
  }

  override async deleteNamespacedConfigMap(
    request: Parameters<FlakyConfigurationCoreV1Api["deleteNamespacedConfigMap"]>[0],
  ) {
    const stored = this.configMaps.get(`${request.namespace}/${request.name}`);
    const uid = request.body?.preconditions?.uid;
    if (stored === undefined) {
      throw Object.assign(new Error("missing ConfigMap"), { code: 404 });
    }
    if (uid !== undefined) {
      assert.ok(stored.metadata);
      if (uid !== stored.metadata.uid) {
        throw Object.assign(new Error("precondition failed: UID"), { code: 409 });
      }
    }
    return super.deleteNamespacedConfigMap(request);
  }
}

test("Kubernetes Configuration changes only the exact ConfigMap it read", async () => {
  const setup = () => storedConfiguration(new RacedConfigurationCoreV1Api());

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
    await assert.rejects(driver.update(nextGeneration), (error) => hasErrorCode(error, 409));
    const current = stored();
    assertConfigurationConfigMap(current);
    assert.equal(current.data["openclaw.json"], JSON.stringify({ written: "elsewhere" }));
  }

  // A stored document that breaks the value rules is never written over.
  {
    const { client, driver, stored } = await setup();
    const current = stored();
    assertConfigurationConfigMap(current);
    current.data["openclaw.json"] = JSON.stringify({ env: { OPENAI_API_KEY: "literal-key" } });
    await assert.rejects(driver.update(nextGeneration), /security boundaries/);
    assert.equal(client.calls.replaceNamespacedConfigMap, 0);
  }

  // A ConfigMap deleted and recreated after the read survives the delete.
  {
    const { client, driver, stored } = await setup();
    client.raceAfterRead = (current) => (current.metadata.uid = "uid-recreated");
    await assert.rejects(driver.delete(configuration), (error) => hasErrorCode(error, 409));
    assert.equal(stored()?.metadata?.uid, "uid-recreated");
  }

  // A same-named ConfigMap with another manager is never deleted.
  {
    const { client, driver, stored } = await setup();
    const current = stored();
    assertConfigurationConfigMap(current);
    current.metadata.labels["app.kubernetes.io/managed-by"] = "helm";
    await assert.rejects(driver.delete(configuration), /exact requested Namespace configuration/);
    assert.equal(client.calls.deleteNamespacedConfigMap, 0);
    assert.notEqual(stored(), undefined);
  }

  // An exact inspection of one recreated at another time reports a conflict.
  {
    const { driver, stored } = await setup();
    const current = stored();
    assertConfigurationConfigMap(current);
    current.metadata.annotations["openclaw.dev/configuration-created-at"] =
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
  const entry = [...client.configMaps.entries()][0];
  assert.ok(entry);
  const [key, stored] = entry;
  client.configMaps.set(key, {
    ...stored,
    data: { "openclaw.json": JSON.stringify(stale.values) },
  });

  assert.deepEqual(await driver.read(configuration), stale);
  const refusal = (error: unknown) => {
    assert.equal(
      errorMessage(error),
      "Configuration field /models/providers/openai/request/auth/token holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.",
    );
    return true;
  };
  // Deployment validates the stored document before it is admitted.
  await assert.rejects(driver.validate(stale), refusal);
  await assert.rejects(driver.update({ ...stale, generation: 2 }), refusal);
  assert.equal(client.calls.replaceNamespacedConfigMap, 0);

  assert.deepEqual(await driver.update(nextGeneration), nextGeneration);
  const updated = client.configMaps.get(key);
  assertConfigurationConfigMap(updated);
  const document = updated.data["openclaw.json"];
  assert.ok(document !== undefined);
  assert.equal(document.includes(sentinel), false);
  assert.deepEqual(await driver.read({ id: configuration.id, namespaceId }), nextGeneration);
});
