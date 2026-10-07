import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import pg from "pg";
import {
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot,
} from "../../apps/controller/src/composition/installation-config.ts";
import { DEVELOPMENT_HARNESS_DESCRIPTOR } from "../../apps/controller/src/composition/production-harness.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

function jsonLines(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function startupDiagnostic(stderr, event) {
  const diagnostic = jsonLines(stderr).find((line) => line.event === event);
  assert.ok(diagnostic, stderr);
  return diagnostic;
}

async function fixture(t, configuration = installation()) {
  const directory = await mkdtemp(join(tmpdir(), "occ-installation-startup-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  // JSON is valid YAML; mutations exercise the same real SDK YAML parser as controller startup.
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

test("Installation startup validates the optional external observability URL", async (t) => {
  const configuration = installation();
  configuration.observability = { url: "https://metrics.example.test/d/operations" };
  const path = await fixture(t, configuration);
  const loaded = await loadInstallationConfiguration({
    mode: "development",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.equal(loaded.installation.observability.url, configuration.observability.url);

  const url = configuration.observability.url;
  for (const [observability, message] of [
    ...[
      "javascript:alert(1)",
      syntheticCredentialUrl({
        username: "user",
        password: "pass",
        host: "example.test",
      }),
      "relative",
      "https://x.example/#f",
    ].map((invalid) => [{ url: invalid }, /observability\.url/]),
    [{ url, extra: 1 }, /observability contains unsupported option extra/],
  ]) {
    configuration.observability = observability;
    await writeFile(path, JSON.stringify(configuration), "utf8");
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "development",
        environment: { OCC_CONFIG_PATH: path },
      }),
      message,
    );
  }
});

test("Installation startup declares native worker support only as a custom runtime image", async (t) => {
  const configuration = installation();
  const path = await fixture(t, configuration);
  const load = () =>
    loadInstallationConfiguration({ mode: "development", environment: { OCC_CONFIG_PATH: path } });
  // Off by default: the pinned runtime cannot run dedicated native OpenClaw.
  assert.equal((await load()).installation.runtime, undefined);
  configuration.runtime = { nativeWorkerSupport: "custom-image" };
  await writeFile(path, JSON.stringify(configuration), "utf8");
  assert.deepEqual((await load()).installation.runtime, { nativeWorkerSupport: "custom-image" });
  for (const [runtime, message] of [
    [{ nativeWorkerSupport: true }, /runtime\.nativeWorkerSupport must be "custom-image"/],
    [
      { nativeWorkerSupport: "pinned-runtime" },
      /runtime\.nativeWorkerSupport must be "custom-image"/,
    ],
    [{}, /runtime\.nativeWorkerSupport must be "custom-image"/],
    [
      { nativeWorkerSupport: "custom-image", image: "x" },
      /runtime contains unsupported option image/,
    ],
  ]) {
    configuration.runtime = runtime;
    await writeFile(path, JSON.stringify(configuration), "utf8");
    await assert.rejects(load(), message);
  }
});

test("development accepts a Metrics URL with its default Compose Drivers", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const path = await fixture(t, { observability: { url } });
  const environment = { OCC_CONFIG_PATH: path };
  const snapshot = await loadStartupConfigurationSnapshot({ mode: "development", environment });
  assert.equal(snapshot.observability.url, url);
  assert.equal(
    await loadInstallationConfiguration({
      mode: "development",
      environment,
      startupConfiguration: snapshot,
    }),
    undefined,
  );
});

function chatgptInstallation() {
  const configuration = installation();
  configuration.backend = [
    {
      id: "openai",
      type: "chatgpt",
      configuration: {
        workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
        apiKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
        credentialTtlSeconds: 3600,
      },
      drivers: {
        service_account: "chatgpt-service-accounts",
      },
    },
  ];
  configuration.drivers.service_account = {
    id: "chatgpt-service-accounts",
    configuration: {},
  };
  return configuration;
}

function retiredChatgptInstallation() {
  const configuration = installation();
  configuration.integrations = {
    chatgpt: {
      workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
      adminKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
      credentialTtlSeconds: 3600,
    },
  };
  configuration.drivers.service_account = {
    id: "chatgpt-service-accounts",
    configuration: {},
  };
  return configuration;
}

async function repositoryInstallation(t) {
  const directory = await mkdtemp(join(tmpdir(), "occ-repository-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tls = await createTlsMaterial(t);
  await chmod(tls.certFile, 0o644);
  const writableCaPath = join(directory, "writable-ca.crt");
  await writeFile(writableCaPath, tls.ca);
  await chmod(writableCaPath, 0o666);
  const registry = {
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-com",
    appId: "12345",
    githubInstallationId: "67890",
    maximumDurationSeconds: 3600,
    repositories: [
      {
        repositoryRef: "application",
        repositoryId: "34567",
        repository: "example/application",
        namespaces: [{ namespaceId: "ns_repository", profiles: ["git-read", "git-write"] }],
      },
    ],
  };
  const registrySource = join(directory, "registry-generation.json");
  await writeFile(registrySource, JSON.stringify(registry), { mode: 0o644 });
  const registryPath = join(directory, "registry.json");
  // Kubernetes ConfigMap/public-CA projection uses symlinks; these nonsecret
  // inputs must not inherit the service's stricter private-file loader.
  await symlink(registrySource, registryPath);
  const publicCaPath = join(directory, "ca.crt");
  await symlink(tls.certFile, publicCaPath);
  const configuration = installation();
  configuration.backend = [
    {
      id: registry.backendId,
      type: "github",
      configuration: { registryPath },
      drivers: { repo: "repository-credentials" },
    },
  ];
  configuration.drivers.repo = {
    id: "repository-credentials",
    configuration: {
      controlSocket: "/run/openclaw/repository-control/private/control.sock",
      sessionDurationSeconds: 600,
      publicCaPath,
    },
  };
  configuration.drivers.compute.configuration.network.repositoryCredentials = {
    namespace: "occ-system",
    podLabels: {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/component": "worker",
    },
    port: 8443,
  };
  return { configuration, registry, registrySource, tls, writableCaPath };
}

test("repository startup constructs the same local resolver without a private socket or App key", async (t) => {
  const { configuration, registry, registrySource } = await repositoryInstallation(t);
  const path = await fixture(t, configuration);
  const api = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  const worker = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.equal(api.repoDriver.capability, "repo");
  // The capability name does not replace the operator's opaque Driver identity.
  assert.equal(api.repoDriver.id, "repository-credentials");
  assert.equal(worker.repoDriver.id, api.repoDriver.id);
  assert.deepEqual(api.installation.backend[0].drivers, { repo: api.repoDriver.id });
  assert.equal(Object.hasOwn(api.installation.drivers, "repository_credentials"), false);
  assert.equal(api.installation.drivers.repo.implementation, api.repoDriver.implementation);
  const selection = { namespaceId: "ns_repository", bindings: [{ repositoryRef: "application" }] };
  const resolved = api.repoDriver.resolve(selection);
  assert.deepEqual(worker.repoDriver.resolve(selection), resolved);
  assert.equal(resolved.bindings[0].profile, "git-write");
  assert.equal(resolved.bindings[0].grant.repositoryId, "34567");
  assert.equal(resolved.sessionDurationSeconds, 600);
  assert.throws(
    () => api.repoDriver.resolve({ ...selection, namespaceId: "ns_other" }),
    /permitted/,
  );
  const chatgpt = chatgptInstallation();
  const combined = structuredClone(configuration);
  combined.backend.push(...chatgpt.backend);
  combined.drivers.service_account = chatgpt.drivers.service_account;
  const combinedDrivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, combined) },
  });
  assert.deepEqual(
    combinedDrivers.installation.backend.map((backend) => backend.type),
    ["github", "chatgpt"],
  );
  // Repository bindings store a GitHub Backend ID under a 200 UTF-16 code unit bound, so
  // 101 emoji (101 characters, 202 units) is refused for a GitHub Backend only.
  const astral = structuredClone(configuration);
  astral.backend[0].id = "😀".repeat(101);
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, astral) },
    }),
    /backend\[0\]\.id must fit in 200 UTF-16 code units for a GitHub Backend, because/,
  );
  // 100 emoji is exactly 200 units, so it fits; its registry names the same Backend ID.
  astral.backend[0].id = "😀".repeat(100);
  astral.backend[0].configuration.registryPath = join(dirname(registrySource), "astral.json");
  await writeFile(
    astral.backend[0].configuration.registryPath,
    JSON.stringify({ ...registry, backendId: astral.backend[0].id }),
    { mode: 0o644 },
  );
  const fits = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, astral) },
  });
  assert.equal(fits.installation.backend[0].id, astral.backend[0].id);

  // The actual API reaches its ordinary database dependency while the configured
  // Unix directory is absent. No private service inputs are supplied to it.
  const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: path,
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
      OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
      OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
    },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(server.status, 1);
  assert.equal(startupDiagnostic(server.stderr, "startup-error").code, "PERSISTENCE_UNAVAILABLE");
});

test("repository startup rejects unmatched ownership, registry identity, duration and CA inputs", async (t) => {
  const { configuration: baseline, tls, writableCaPath } = await repositoryInstallation(t);
  for (const [mutate, expected] of [
    [(value) => delete value.backend, /requires an owning backend/],
    [
      (value) => {
        value.drivers.repository_credentials = value.drivers.repo;
        delete value.drivers.repo;
      },
      /unsupported option repository_credentials/,
    ],
    [
      (value) => {
        value.backend[0].drivers.repository_credentials = value.backend[0].drivers.repo;
        delete value.backend[0].drivers.repo;
      },
      /plaintext credential/,
    ],
    [(value) => delete value.drivers.repo, /requires drivers\.repo/],
    [(value) => (value.backend[0].drivers.repo = "other-driver"), /must match/],
    [
      (value) => (value.backend[0].configuration.registryPath = "relative.json"),
      /absolute mounted/,
    ],
    [(value) => (value.backend[0].configuration.apiKeyPath = "/unavailable"), /unsupported/],
    [
      (value) => value.backend.push({ ...structuredClone(value.backend[0]), id: "other-github" }),
      /cannot belong to multiple Backends/,
    ],
    [(value) => (value.backend[0].id = "other-backend"), /invalid-repository-registry/],
    [
      (value) => (value.drivers.repo.configuration.sessionDurationSeconds = 3601),
      /duration|configuration/,
    ],
    [(value) => (value.drivers.repo.configuration.publicCaPath = tls.keyFile), /public CA/],
    [(value) => (value.drivers.repo.configuration.publicCaPath = writableCaPath), /public CA/],
    [(value) => (value.drivers.repo.package = "@example/driver"), /unsupported option package/],
    [(value) => (value.drivers.repo.implementation = "other"), /unsupported option implementation/],
    [(value) => (value.drivers.compute.id = "compute-ssh"), /bundled Kubernetes/],
    [
      (value) => delete value.drivers.compute.configuration.network.repositoryCredentials,
      /repository service peer/,
    ],
    [
      (value) => (value.drivers.compute.configuration.network.repositoryCredentials.port = 443),
      /repository service peer/,
    ],
    [
      (value) => (value.backend[0].drivers.repo = "ghp_notarealtoken123456"),
      /plaintext credential/,
    ],
  ]) {
    const configuration = structuredClone(baseline);
    mutate(configuration);
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});

test("startup loads singleton Installation YAML and validates Drivers before construction", async (t) => {
  const path = await fixture(t);
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  const configuration = drivers.installation;
  assert.equal(configuration.occ.cluster, "production-west");
  assert.equal(Object.hasOwn(configuration, "installationId"), false);

  // Runtime Driver identities must exactly match startup selections and admitted descriptors.
  assert.equal(drivers.computeDriver.id, "compute-kubernetes");
  assert.equal(drivers.computeDriver.implementation, "occ/kubernetes");
  assert.equal(drivers.configurationDriver.id, "config-kubernetes");
  assert.equal(drivers.configurationDriver.implementation, "occ/kubernetes-configmap");
  assert.equal(configuration.drivers.compute.configuration.network.gatewayPort, 8080);

  // Startup constructs the selected Compute Driver using the updated trusted YAML settings.
  const changed = installation();
  changed.drivers.compute.configuration.network.gatewayPort = 8081;
  const updated = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, changed) },
  });
  assert.equal(updated.computeDriver.id, drivers.computeDriver.id);
  assert.equal(updated.computeDriver.implementation, drivers.computeDriver.implementation);
  assert.equal(updated.installation.drivers.compute.configuration.network.gatewayPort, 8081);
});

test("shared startup loads backend metadata without reading the API-only ChatGPT admin Secret", async (t) => {
  // The worker shares this loader but deliberately cannot access the configured API-only mount.
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, chatgptInstallation()) },
  });

  assert.deepEqual(drivers.installation.backend, [
    {
      id: "openai",
      type: "chatgpt",
      configuration: {
        workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
        apiKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
        credentialTtlSeconds: 3600,
      },
      drivers: {
        service_account: "chatgpt-service-accounts",
      },
    },
  ]);
  assert.equal(Object.hasOwn(drivers.installation.backend[0].configuration, "adminKeyPath"), false);
  assert.deepEqual(drivers.installation.drivers.service_account, {
    id: "chatgpt-service-accounts",
  });
  assert.equal(Object.hasOwn(drivers, "serviceAccountDriver"), false);
  assert.equal(Object.hasOwn(drivers, "chatgptClient"), false);
});

test("ChatGPT startup rejects retired integrations and unsafe backend configuration", async (t) => {
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, retiredChatgptInstallation()) },
    }),
    /integrations is retired.*backend.*apiKeyPath/,
  );

  for (const [mutate, expected] of [
    [(value) => delete value.backend, /requires an owning backend/],
    [(value) => delete value.drivers.service_account, /requires drivers\.service_account/],
    [
      (value) => delete value.backend[0].drivers.service_account,
      /drivers\.service_account.*required/,
    ],
    [(value) => (value.backend[0].configuration.workspaceId = "untrusted"), /workspaceId.*invalid/],
    [
      (value) => (value.backend[0].configuration.apiKeyPath = "relative-admin-key"),
      /absolute mounted file path/,
    ],
    [
      (value) => (value.backend[0].configuration.credentialTtlSeconds = 2_592_001),
      /between 1 and 2592000/,
    ],
    [
      (value) => (value.backend[0].configuration.apiKey = "plaintext-admin-key"),
      /plaintext credential|unsupported option/,
    ],
    [
      (value) => (value.backend[0].configuration.adminKeyPath = "/tmp/old-admin-key"),
      /adminKeyPath.*unsupported/,
    ],
    [
      (value) => (value.backend[0].id = " openai"),
      /backend\[0\]\.id must be a string of 1 to 200 characters with no leading or trailing whitespace and no control characters or line or paragraph separators\./,
    ],
    [
      (value) => (value.backend[0].id = "a".repeat(201)),
      /backend\[0\]\.id must be a string of 1 to 200/,
    ],
    // 201 code points, a C1 control and a line separator, refused as the API refuses them, and
    // a lone surrogate, which has no UTF-8 spelling.
    ...[
      "openai ",
      "open\u0007ai",
      7,
      "😀".repeat(201),
      "open\u0085ai",
      "open\u2028ai",
      "open\ud800ai",
    ].map((id) => [
      (value) => (value.backend[0].id = id),
      /backend\[0\]\.id must be a string of 1 to 200/,
    ]),
    [(value) => (value.backend[0].type = "installed"), /must be chatgpt/],
    [(value) => (value.backend[0].package = "@example/backend"), /unsupported option package/],
    [
      (value) => (value.backend[0].drivers.service_account = "other-service-accounts"),
      /must match the selected drivers\.service_account\.id/,
    ],
    [
      (value) => value.backend.push(structuredClone(value.backend[0])),
      /Backend IDs must be unique/,
    ],
    [
      (value) => {
        const duplicate = structuredClone(value.backend[0]);
        duplicate.id = "other-openai";
        value.backend.push(duplicate);
      },
      /A Driver cannot belong to multiple Backends/,
    ],
    [
      (value) => (value.drivers.service_account.configuration.backendId = "openai"),
      /unsupported option/,
    ],
  ]) {
    const configuration = chatgptInstallation();
    mutate(configuration);
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }

  // The stated rule's upper edge: 200 characters, interior whitespace allowed.
  const longest = chatgptInstallation();
  longest.backend[0].id = `open ${"a".repeat(195)}`;
  const accepted = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, longest) },
  });
  assert.equal(accepted.installation.backend[0].id, longest.backend[0].id);
});

test("production embedded replacements preserve their active Service across failed activation", async (t) => {
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t) },
  });
  const { computeDriver } = drivers;
  // This worker activation unit uses managed placement without claiming live Kubernetes discovery.
  t.mock.method(computeDriver, "resolveNamespace", async (namespaceId) => ({
    name: { name: kubernetesNamespaceName(namespaceId), plane: "execution" },
    external: false,
  }));
  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  const worker = createControllerWorker({
    pool,
    mode: "production",
    drivers,
    emit: () => {},
  });
  // Queue health is outside this selector unit; the PostgreSQL suites exercise
  // real health observations while activation holds and renews its claim.
  t.mock.method(worker.queue, "pending", async () => 0);

  const shortHash = (value, length) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  // Dedicated RWO replacement stops its predecessor before preparation. Its
  // interruption/recovery contract is covered by the PostgreSQL worker and real-cluster suites.
  const harness = { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" };
  const namespaceId = `ns_production-${harness.mode}-cutover`;
  const agentId = `agt_production-${harness.mode}-cutover`;
  const servicePrincipalId = `service-production-${harness.mode}-cutover`;
  const predecessor = {
    id: `rev_production-${harness.mode}-active`,
    namespaceId,
    agentId,
    revision: 1,
    configurationId: `cfg_production-${harness.mode}-cutover`,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: admitLoggingConfiguration(
      createHarnessConfiguration(harness.id, "gpt-4.1"),
      "info",
    ),
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId, id: "sec_production-model" },
      secretDriverId: "secret-kubernetes",
    },
    harness,
    compute: { id: computeDriver.id, implementation: computeDriver.implementation },
    servicePrincipalId,
    createdAt: new Date().toISOString(),
  };
  const candidate = {
    ...predecessor,
    id: `rev_production-${harness.mode}-candidate`,
    revision: 2,
  };
  const authContext = {
    harnessAuth: {
      ...candidate.harnessAuth,
      backendRef: {
        namespaceName: kubernetesNamespaceName(namespaceId),
        name: "model-key",
        key: "value",
        uid: "model-key-uid",
      },
    },
  };
  const name = `gateway-${shortHash(agentId, 12)}`;
  const activeSelector = {
    "app.kubernetes.io/name": name,
    "openclaw.dev/agent": agentId,
  };
  const ownership = { namespaceId, agentId };
  const service = computeDriver.service(
    name,
    ownership,
    { name: kubernetesNamespaceName(namespaceId), plane: "execution" },
    structuredClone(activeSelector),
  );
  assert.equal(service.spec.ports[0].name, "http");

  const serviceWrites = [];
  computeDriver.reconcile = async (manifest) => {
    assert.equal(manifest.kind, "Service");
    assert.equal(manifest.metadata.name, name);
    service.spec.selector = structuredClone(manifest.spec.selector);
    serviceWrites.push(structuredClone(manifest.spec.selector));
  };
  computeDriver.prepareRevision = async (revision) => ({
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    ready: true,
  });
  const now = new Date();
  const claim = {
    idempotencyKey: `revision:${candidate.id}:reconcile`,
    namespaceId,
    agentId,
    revisionId: candidate.id,
    actorId: "principal-production",
    state: "claimed",
    claimToken: randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    availableAt: now,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  // This selector unit assumes a live claim at the queue boundary; actual
  // renewal/loss is exercised by the PostgreSQL worker and stale-claim suites.
  const heartbeat = t.mock.method(worker.queue, "heartbeat", async (received) => {
    assert.equal(received, claim);
    return claim;
  });
  worker.state.read = async (read) =>
    read({
      agents: {
        findAgent: async () => ({
          id: agentId,
          namespaceId,
          desiredRuntimeState: "running",
        }),
      },
    });

  // Preparation must leave the currently serving selector untouched before CAS.
  const observation = await worker.observeRevision(claim, candidate, predecessor, predecessor.id);
  assert.deepEqual(service.spec.selector, activeSelector);
  assert.deepEqual(serviceWrites, []);
  assert.equal(observation.expectedActiveRevisionId, predecessor.id);

  const activeAgent = {
    id: agentId,
    namespaceId,
    servicePrincipalId,
    activeRevisionId: predecessor.id,
    desiredRuntimeState: "running",
  };
  const retries = [];
  let compareAndSetAttempts = 0;
  worker.state.transactWithQueue = async (transaction) =>
    transaction(
      {
        agents: {
          lockAgent: async () => activeAgent,
          compareAndSetActiveRevision: async (...arguments_) => {
            compareAndSetAttempts++;
            assert.deepEqual(arguments_, [namespaceId, agentId, predecessor.id, candidate.id]);
            return undefined;
          },
        },
      },
      {
        heartbeat: async () => claim,
        retry: async (_claim, reason) => retries.push(reason),
      },
    );
  await worker.finalizeRevision(claim, observation);
  assert.equal(compareAndSetAttempts, 1);
  assert.deepEqual(retries, [{ code: "ACTIVE_REVISION_CHANGED" }]);
  assert.equal(activeAgent.activeRevisionId, predecessor.id);
  assert.deepEqual(service.spec.selector, activeSelector);
  assert.deepEqual(serviceWrites, []);

  // Recovery for an older claim must never replace a gateway already advanced to a newer revision.
  const newerGateway = computeDriver.deployment(
    name,
    ownership,
    { name: kubernetesNamespaceName(namespaceId), plane: "execution" },
    "openclaw-enterprise/gateway-fixture:local",
    `agent-${shortHash(agentId, 12)}`,
    "gateway",
    {},
    "info",
    computeDriver.gatewayConfiguration(candidate),
    true,
    servicePrincipalId,
    computeDriver.harnessAuthForRevision(candidate, authContext, {
      name: kubernetesNamespaceName(namespaceId),
      plane: "control",
    }),
  );
  const originalGet = computeDriver.get;
  computeDriver.get = async (kind, requestedName) => {
    assert.equal(kind, "Deployment");
    assert.equal(requestedName, name);
    return newerGateway;
  };
  try {
    await assert.rejects(
      computeDriver.activateRevision(predecessor, authContext),
      /stale.*activation/i,
    );
  } finally {
    computeDriver.get = originalGet;
  }
  assert.deepEqual(serviceWrites, []);

  const inactiveSelector = { "app.kubernetes.io/name": `${name}-inactive` };
  // Embedded preparation already fences its gateway; the worker must never rewrite it pre-CAS.
  service.spec.selector = computeDriver.service(
    name,
    ownership,
    { name: kubernetesNamespaceName(namespaceId), plane: "execution" },
    inactiveSelector,
  ).spec.selector;
  const initial = await worker.observeRevision(claim, candidate, undefined, undefined);
  assert.equal(initial.outcome, "success");
  assert.equal(initial.code, "REVISION_ACTIVATED");
  assert.equal(Object.hasOwn(initial, "expectedActiveRevisionId"), false);
  assert.deepEqual(serviceWrites, []);
  assert.deepEqual(service.spec.selector, inactiveSelector);
  heartbeat.mock.restore();
});

test("startup accepts actual block-style YAML instead of requiring JSON", async (t) => {
  const path = await fixture(t);
  const configuration = installation();
  const yaml = `occ:\n  cluster: production-west\ndrivers:\n  configuration: ${JSON.stringify(configuration.drivers.configuration)}\n  iam: ${JSON.stringify(configuration.drivers.iam)}\n  compute: ${JSON.stringify(configuration.drivers.compute)}\n  secret: ${JSON.stringify(configuration.drivers.secret)}\n`;
  await writeFile(path, yaml, "utf8");
  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.equal(loaded.installation.occ.cluster, "production-west");
});

test("production requires one YAML while development may start without a ConfigurationDriver", async (t) => {
  await assert.rejects(
    loadInstallationConfiguration({ mode: "production", environment: {} }),
    /OCC_CONFIG_PATH/,
  );
  assert.equal(
    await loadInstallationConfiguration({ mode: "development", environment: {} }),
    undefined,
  );
  // Unusable paths and unparsable files get fixed messages that never echo the path or the
  // filesystem or parser error.
  const invalidYaml = await fixture(t);
  await writeFile(invalidYaml, "drivers: [\n", "utf8");
  for (const [path, message] of [
    [" ", "OCC_CONFIG_PATH must identify the Installation startup YAML."],
    [
      "relative/installation.yaml",
      "OCC_CONFIG_PATH must identify an absolute Installation startup YAML path.",
    ],
    [`${invalidYaml}.missing`, "The configured Installation startup YAML is unavailable."],
    [invalidYaml, "The configured Installation startup file must contain valid YAML."],
  ]) {
    await assert.rejects(
      loadInstallationConfiguration({ mode: "production", environment: { OCC_CONFIG_PATH: path } }),
      { message },
      JSON.stringify(path),
    );
  }
});

test("production server and worker resolve singleton startup without an Installation ID", async (t) => {
  const path = await fixture(t);
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };

  // The actual server gets beyond singleton/Driver startup and fails only at missing session auth.
  const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...shared,
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(server.status, 1);
  assert.equal(startupDiagnostic(server.stderr, "startup-error").code, "AUTH_BASE_URL_INVALID");
  assert.doesNotMatch(server.stderr, /OCC_AUTH_BASE_URL|OCC_AUTH_SECRET|OCC_INSTALLATION_ID/);

  // The real worker likewise reaches PostgreSQL; no test-owned database or driver is substituted.
  const worker = spawnSync(process.execPath, ["apps/controller/src/worker.mjs"], {
    cwd: process.cwd(),
    env: shared,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(worker.status, 1);
  assert.equal(
    startupDiagnostic(worker.stderr, "worker.startup-error").code,
    "PERSISTENCE_UNAVAILABLE",
  );
  assert.doesNotMatch(worker.stderr, /OCC_INSTALLATION_ID|explicit Installation/);
});

test("only the actual API process reads ChatGPT admin credentials and backend accounts require PostgreSQL", async (t) => {
  const path = await fixture(t, chatgptInstallation());
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };

  // API startup fails on its missing mounted admin key before opening the configured database.
  const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...shared,
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
      OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
      OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(server.status, 1);
  assert.equal(
    startupDiagnostic(server.stderr, "startup-error").code,
    "CHATGPT_ADMIN_KEY_UNAVAILABLE",
  );
  assert.doesNotMatch(server.stderr, /ChatGPT admin-key Secret is unavailable/);

  // The same configured worker cannot read that mount and fails only when PostgreSQL is unavailable.
  const worker = spawnSync(process.execPath, ["apps/controller/src/worker.mjs"], {
    cwd: process.cwd(),
    env: shared,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(worker.status, 1);
  assert.equal(
    startupDiagnostic(worker.stderr, "worker.startup-error").code,
    "PERSISTENCE_UNAVAILABLE",
  );
  assert.doesNotMatch(worker.stderr, /ChatGPT|admin-key|ServiceAccount Driver/);

  // Driver-private backend bindings cannot silently fall back to ephemeral in-memory persistence.
  const inMemory = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      OCC_CONFIG_PATH: path,
      OCC_HOST: "127.0.0.1",
      OCC_PORT: "8080",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(inMemory.status, 1);
  assert.equal(
    startupDiagnostic(inMemory.stderr, "startup-error").code,
    "SERVICE_ACCOUNT_REQUIRES_POSTGRES",
  );
  assert.doesNotMatch(
    inMemory.stderr,
    /ServiceAccounts require PostgreSQL persistence|ChatGPT admin-key Secret/,
  );
});

test("startup rejects caller-selected Installation IDs and obsolete Driver selectors", async (t) => {
  const path = await fixture(t);
  for (const [name, value] of [
    ["OCC_INSTALLATION_ID", "ins_untrusted"],
    ["OCC_COMPUTE_DRIVER", "kubernetes"],
    ["OCC_KUBERNETES_CONFIG_PATH", "/tmp/obsolete.json"],
    ["OCC_NATIVE_IAM_DRIVER_ID", "native-iam"],
  ]) {
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: path, [name]: value },
      }),
      new RegExp(name),
    );
  }

  const injected = installation();
  injected.drivers.compute.configuration.authentication.installation_id = "ins_untrusted";
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, injected) },
    }),
    /must not contain an Installation ID/,
  );
});

test("startup rejects plaintext secrets, caller-authored identities, and unsupported schema options", async (t) => {
  for (const [mutate, expected] of [
    [(value) => (value.drivers.compute.configuration.apiKey = "plaintext"), /plaintext credential/],
    [
      (value) => (value.drivers.configuration.implementation = "occ/docker-config"),
      /unsupported option.*implementation/,
    ],
    [
      (value) =>
        (value.drivers.configuration.configuration.authentication = { mode: "kubeconfig" }),
      /schema|authentication/,
    ],
    [(value) => (value.drivers.iam.configuration.unexpected = true), /schema|unsupported option/],
    [
      (value) => (value.drivers.compute.configuration.resources.gateway.unexpected = true),
      /schema|unsupported option/,
    ],
    [
      (value) => (value.drivers.compute.configuration.images.requireImmutableDigest = false),
      /immutable image digests/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.network.gatewayPort = Number.MAX_SAFE_INTEGER + 1),
      /schema|integer|port/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.images.gateway = "registry.example/gateway:latest"),
      /immutable SHA-256 digest/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.images.agent = "registry.example/agent:latest"),
      /immutable SHA-256 digest/,
    ],
    [
      (value) => delete value.drivers.compute.configuration.runtime,
      /explicitly configured Codex runtime/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.runtime.modelSecretPrefix =
          value.drivers.compute.configuration.runtime.transportSecretPrefix),
      /schema|unsupported option/,
    ],
    // The reader refuses these anywhere in the file, before any Driver schema runs.
    [
      (value) => (value.drivers.compute.configuration.unexpected = 2 ** 53 + 2),
      /\.unexpected must be a safe integer\.$/,
    ],
    [
      (value) => (value.drivers.compute.configuration.constructor = {}),
      /contains an unsafe configuration key\.$/,
    ],
    [
      (value) => (value.drivers.compute.configuration.secretRef = "installation-secret"),
      /Installation-scoped secret references cannot be resolved safely\.$/,
    ],
  ]) {
    const configuration = installation();
    mutate(configuration);
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});

test("Installation default Presets are opt-in and reject ambiguous YAML settings", async (t) => {
  for (const presets of [undefined, {}, { includeDefaults: false }]) {
    const configuration = installation();
    if (presets !== undefined) {
      configuration.presets = presets;
    }
    const loaded = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    });
    assert.deepEqual(loaded.defaultPresets, []);
  }
  const enabled = installation();
  enabled.presets = { includeDefaults: true };
  const enabledRuntime = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, enabled) },
  });
  assert.deepEqual(enabledRuntime.defaultPresets.map((preset) => preset.name).sort(), [
    "Standard Codex",
    "Standard OpenClaw",
    "default-codex",
  ]);
  for (const presets of [
    { includeDefaults: "true" },
    { includeDefaults: 1 },
    { includeDefault: true },
    { files: "preset.json" },
    { files: [1] },
    { files: [""] },
    null,
  ]) {
    const configuration = installation();
    configuration.presets = presets;
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      /presets/,
    );
  }
});

test("an Installation Preset file named like a bundled default replaces that default", async (t) => {
  // default-codex became a bundled default after operators could already name a file
  // default-codex. Startup must keep the operator's file instead of refusing to start.
  const operatorCodex = {
    name: "default-codex",
    template: { agent: { name: "Operator Codex", executionMode: "dedicated" } },
  };
  const configuration = installation();
  configuration.presets = { includeDefaults: true, files: ["presets/codex.json"] };
  const path = await fixture(t, configuration);
  await mkdir(join(dirname(path), "presets"), { recursive: true });
  const presetPath = join(dirname(path), "presets", "codex.json");
  await writeFile(presetPath, JSON.stringify(operatorCodex));
  const runtime = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.deepEqual(runtime.defaultPresets.map((preset) => preset.name).sort(), [
    "Standard Codex",
    "Standard OpenClaw",
    "default-codex",
  ]);
  assert.deepEqual(
    runtime.defaultPresets.find((preset) => preset.name === "default-codex").template,
    operatorCodex.template,
  );
  // The resolved path names the file the operator must keep or rename.
  assert.deepEqual(runtime.shadowedDefaultPresets, [
    { presetName: "default-codex", presetFile: presetPath },
  ]);
  // Without includeDefaults nothing is shadowed: the file is an ordinary default.
  configuration.presets.includeDefaults = false;
  await writeFile(path, JSON.stringify(configuration), "utf8");
  const filesOnly = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.deepEqual(
    filesOnly.defaultPresets.map((preset) => preset.name),
    ["default-codex"],
  );
  assert.deepEqual(filesOnly.shadowedDefaultPresets, []);
});

test("Installation Preset JSON files resolve beside startup YAML and fail closed", async (t) => {
  const validPreset = {
    name: "from-file",
    template: {
      variables: { name: { type: "string" } },
      agent: {
        name: "{{ vars.name }}",
        initialWorkspaceFiles: {
          "AGENTS.md": "# Agent\nName: {{ vars.name }}\n",
          "USER.md": "",
        },
      },
    },
  };
  const relativeConfiguration = installation();
  relativeConfiguration.presets = { includeDefaults: false, files: ["presets/from-file.json"] };
  const relativePath = await fixture(t, relativeConfiguration);
  const relativeDirectory = dirname(relativePath);
  await mkdir(join(relativeDirectory, "presets"), { recursive: true });
  await writeFile(
    join(relativeDirectory, "presets", "from-file.json"),
    JSON.stringify(validPreset),
  );
  const relativeRuntime = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: relativePath },
  });
  assert.deepEqual(
    relativeRuntime.defaultPresets.map((preset) => preset.name),
    ["from-file"],
  );
  assert.equal(
    relativeRuntime.defaultPresets[0].template.agent.initialWorkspaceFiles["AGENTS.md"],
    "# Agent\nName: {{ vars.name }}\n",
  );

  const absoluteConfiguration = installation();
  const absolutePreset = join(relativeDirectory, "absolute.json");
  absoluteConfiguration.presets = { includeDefaults: false, files: [absolutePreset] };
  await writeFile(absolutePreset, JSON.stringify({ ...validPreset, name: "absolute-file" }));
  const absoluteRuntime = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, absoluteConfiguration) },
  });
  assert.equal(absoluteRuntime.defaultPresets[0].name, "absolute-file");

  for (const [filename, contents, expected] of [
    ["missing.json", undefined, /Preset file .* is unavailable/],
    ["malformed.json", '{"name":', /Preset file .* must contain valid JSON/],
    [
      "unsupported.json",
      JSON.stringify({ name: "unsupported", template: {}, unexpected: true }),
      /unsupported option unexpected/,
    ],
    [
      "invalid-template.json",
      JSON.stringify({ name: "invalid", template: { agent: { unsupported: true } } }),
      /Preset agent: contains unsupported fields/,
    ],
    [
      "invalid-name.json",
      JSON.stringify({ name: "edge\u00a0", template: {} }),
      /Preset file .*invalid-name\.json\.name must follow the Name rule: 1 to 200 characters/,
    ],
    [
      "duplicate.json",
      JSON.stringify({ name: "Standard Codex", template: {} }),
      /Default Preset Standard Codex is configured more than once: .*duplicate\.json and .*duplicate-b\.json/,
    ],
  ]) {
    const configuration = installation();
    // Two operator files may not share a name, even one that shadows a bundled default.
    configuration.presets = {
      includeDefaults: filename === "duplicate.json",
      files:
        filename === "duplicate.json"
          ? [`cases/${filename}`, "cases/duplicate-b.json"]
          : [`cases/${filename}`],
    };
    const path = await fixture(t, configuration);
    const directory = dirname(path);
    await mkdir(join(directory, "cases"), { recursive: true });
    if (contents !== undefined) {
      await writeFile(join(directory, "cases", filename), contents);
    }
    if (filename === "duplicate.json") {
      await writeFile(join(directory, "cases", "duplicate-b.json"), contents);
    }
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: path },
      }),
      expected,
    );
  }
});

test("API and worker name a Preset file failure in their startup error code", async (t) => {
  // An operator who lists a file the image lacks, or a broken one, needs a cause rather
  // than STARTUP_FAILED. The file path and the loader message stay out of the log.
  const duplicate = JSON.stringify({ name: "twice", template: {} });
  for (const [filename, contents, files] of [
    ["missing.json", undefined],
    [
      "invalid-template.json",
      JSON.stringify({ name: "invalid", template: { agent: { unsupported: true } } }),
    ],
    ["invalid-name.json", JSON.stringify({ name: "line\u2028break", template: {} })],
    ["duplicate.json", duplicate, ["cases/duplicate.json", "cases/duplicate-b.json"]],
    ["not-a-list.json", undefined, "cases/not-a-list.json"],
  ]) {
    const configuration = installation();
    configuration.presets = { includeDefaults: false, files: files ?? [`cases/${filename}`] };
    const path = await fixture(t, configuration);
    await mkdir(join(dirname(path), "cases"), { recursive: true });
    if (contents !== undefined) {
      await writeFile(join(dirname(path), "cases", filename), contents);
      await writeFile(join(dirname(path), "cases", "duplicate-b.json"), duplicate);
    }
    const shared = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: path,
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
    };
    const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...shared,
        OCC_HOST: "192.0.2.10",
        OCC_PORT: "8080",
        OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
        OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(server.status, 1, filename);
    const apiDiagnostic = startupDiagnostic(server.stderr, "startup-error");
    assert.equal(apiDiagnostic.code, "PRESET_FILE_INVALID", filename);
    assert.equal(apiDiagnostic.message, undefined);
    assert.ok(!server.stderr.includes(dirname(path)), server.stderr);

    const worker = spawnSync(process.execPath, ["apps/controller/src/worker.mjs"], {
      cwd: process.cwd(),
      env: shared,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(worker.status, 1, filename);
    const workerDiagnostic = startupDiagnostic(worker.stderr, "worker.startup-error");
    assert.equal(workerDiagnostic.code, "PRESET_FILE_INVALID", filename);
    assert.equal(workerDiagnostic.message, undefined);
    assert.ok(!worker.stderr.includes(dirname(path)), worker.stderr);
  }
});
