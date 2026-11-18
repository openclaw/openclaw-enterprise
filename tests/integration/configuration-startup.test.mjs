import {
  assertChatGPTStartupMetadata,
  checkNativeRepositoryStartup,
  createChatGPTInstallation,
  checkedStartupCapture,
  checkCountedQuotaStartup,
  registerChatGPTStartupRefusals,
  registerStartupDriverResolutionCases,
  registerStartupProcessResolutionCases,
  startupDiagnostic,
} from "./configuration-startup-resolution-cases.ts";
import { registerStartupCredentialProxyCases } from "./configuration-startup-credential-proxy-cases.ts";
import {
  registerStartupDiagnosticsCases,
  registerStartupPresetCases,
} from "./configuration-startup-validation-cases.ts";
import {
  checkExternalObservabilityUrl,
  checkNativeWorkerSupport,
  registerDevelopmentMetricsStartupCase,
  registerStartupInstallationInputCases,
  registerStartupYamlInputCases,
} from "./configuration-startup-input-cases.ts";
import { reconcileNamespaceLifecycle } from "../../packages/occ/src/namespace-lifecycle.ts";
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { before } from "node:test";
import pg from "pg";
import {
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot,
} from "../../apps/controller/src/composition/installation-config.ts";
import {
  DEVELOPMENT_BROWSER_ORIGIN_RULE,
  isDevelopmentBrowserOrigin,
} from "../../apps/controller/src/auth/configuration.ts";
import { PresetFileError } from "../../apps/controller/src/composition/installation-presets.ts";
import { DEVELOPMENT_HARNESS_DESCRIPTOR } from "../../apps/controller/src/composition/production-harness.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  admitLoggingConfiguration,
  ConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import { validateSelectedBackendDrivers } from "../../packages/occ/src/index.ts";
import { spawnSync } from "node:child_process";
import { reservedPortArgs, reservePort } from "../helpers/available-port.ts";
import { captureChild, concurrencyLimit, settled } from "../helpers/child-processes.mjs";
import { fileCompileCache } from "../helpers/compile-cache.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  createCredentialProxyInstallationConfiguration as credentialProxyInstallation,
  createInstallationDriverConfiguration as installation,
} from "../helpers/installation-driver-configuration.ts";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.ts";
import { socketDirectory } from "../helpers/socket-directory.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const startupInputs = {
  fixture,
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot,
  ConfigurationValidationError,
};
const chatgptInstallation = () => createChatGPTInstallation(installation);

// The startup cases boot the real API and worker processes with an allowlisted environment,
// which drops NODE_COMPILE_CACHE, so it is passed explicitly: the lane's cache in CI, otherwise
// a temporary one owned by this file, so each boot after the first reuses compiled code.
const compileCache = await fileCompileCache("configuration-startup");

// The production listener and sign-in settings of the API boots that reach session auth.
const productionServer = {
  OCC_HOST: "192.0.2.10",
  OCC_PORT: "8080",
  OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
  OCC_AUTH_BASE_URL: "https://console.example.test",
  OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.example.test",
};

// Boots run concurrently, about one per CPU. A boot killed at its timeout rejects with
// the signal instead of reading as a wrong exit status. The timeout only guards against a
// process that never exits: every boot here ends in a startup refusal within a second or two
// on an idle machine, and on a loaded runner the same boot took more than 10 s.
const limit = concurrencyLimit();
async function boot(script, env, timeout = 30_000, nodeArguments = []) {
  const capture = await limit(() =>
    captureChild(process.execPath, [...nodeArguments, script], {
      cwd: process.cwd(),
      env: { ...env, NODE_COMPILE_CACHE: compileCache },
      timeout,
    }),
  );
  const { signal, ...result } = checkedStartupCapture(capture);
  if (signal) {
    throw new Error(`${script} ended by ${signal} (timeout ${timeout} ms): ${result.stderr}`);
  }
  return result;
}

// Warm the compile cache with one API and one worker boot through production startup to the
// database connection, the furthest any case here goes. Node writes a cold cache when a process
// exits, and the first test starts all its boots at once: each one compiled the whole graph and
// spent seconds writing the same cache at exit, so on a loaded runner the valid case's API had
// logged its startup error but had not exited within its 15 s budget.
before(async () => {
  const directory = await mkdtemp(join(tmpdir(), "occ-installation-warm-"));
  try {
    const path = join(directory, "installation.yaml");
    await writeFile(path, JSON.stringify(installation()), "utf8");
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: path,
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
    };
    const [server, worker] = await settled([
      boot("apps/controller/src/server.mjs", { ...env, ...productionServer }),
      boot("apps/controller/src/worker.mjs", env),
    ]);
    // A boot that stopped earlier would leave the composition modules uncached.
    const warmUp = "compile-cache warm-up";
    assert.equal(server.status, 1, warmUp);
    assert.equal(
      startupDiagnostic(server.stderr, "startup-error").code,
      "PERSISTENCE_UNAVAILABLE",
      warmUp,
    );
    assert.equal(worker.status, 1, warmUp);
    assert.equal(
      startupDiagnostic(worker.stderr, "worker.startup-error").code,
      "PERSISTENCE_UNAVAILABLE",
      warmUp,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * @param {import("node:test").TestContext} t
 * @param {Readonly<Record<string, unknown>>} configuration
 */
async function fixture(t, configuration = installation()) {
  const directory = await temporaryDirectory(t, "occ-installation-startup-");
  const path = join(directory, "installation.yaml");
  // JSON is valid YAML; mutations exercise the same real SDK YAML parser as controller startup.
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

test("Credential Proxy startup preserves the selection and refuses retired keys", async (t) => {
  const configuration = credentialProxyInstallation();
  const path = await fixture(t, configuration);
  const load = () =>
    loadInstallationConfiguration({
      mode: "development",
      environment: { OCC_CONFIG_PATH: path },
    });
  // This is real startup composition; no gateway connection or listener is started.
  const loaded = await load();
  assert.equal(loaded.proxyDriver.capability, "credential_proxy");
  assert.equal(loaded.proxyDriver.id, "openshell-egress");
  assert.equal(loaded.installation.drivers.credential_proxy.id, loaded.proxyDriver.id);
  assert.equal(loaded.installation.backend[0].drivers.credential_proxy, loaded.proxyDriver.id);
  assert.equal(loaded.protectedDriver.require("credential_proxy"), loaded.proxyDriver);
  assert.equal(typeof loaded.proxyDriver.bindExchange, "function");

  for (const [member, selected] of [
    [true, false],
    [false, true],
    [false, false],
    [true, true],
  ]) {
    await t.test(
      `Credential Proxy: Backend member=${member}, Installation selection=${selected}`,
      async () => {
        const candidate = structuredClone(configuration);
        if (!member) {
          delete candidate.backend[0].drivers.credential_proxy;
        }
        if (!selected) {
          delete candidate.drivers.credential_proxy;
        }
        await writeFile(path, JSON.stringify(candidate));

        // Direct OCC composition must enforce the same membership rule as Installation startup.
        const validateSelection = () =>
          validateSelectedBackendDrivers(
            candidate.backend,
            {
              sandbox: loaded.sandboxDriver,
              credential_gateway: loaded.credentialGatewayDriver,
              ...(selected ? { credential_proxy: loaded.proxyDriver } : {}),
            },
            loaded.protectedDriver,
          );
        if (member !== selected) {
          await assert.rejects(
            load(),
            /credential_proxy must match the selected drivers\.credential_proxy\.id/,
          );
          assert.throws(validateSelection, /Credential Proxy Driver/i);
        } else {
          assert.equal(
            (await load()).proxyDriver?.id,
            selected ? loaded.proxyDriver.id : undefined,
          );
          validateSelection();
        }
      },
    );
  }

  for (const boundary of ["installation", "backend"]) {
    for (const scenario of ["retired only", "both", "null retired"]) {
      await t.test(`${boundary}: ${scenario}`, async () => {
        const invalid = structuredClone(configuration);
        const drivers = boundary === "installation" ? invalid.drivers : invalid.backend[0].drivers;
        // Even a null retired key must not silently disable or override protection.
        drivers.conduit = scenario === "null retired" ? null : drivers.credential_proxy;
        if (scenario !== "both") {
          delete drivers.credential_proxy;
        }
        await writeFile(path, JSON.stringify(invalid));
        await assert.rejects(load(), /drivers\.conduit is retired; use drivers\.credential_proxy/);
      });
    }
  }

  // Finding 2361: the retired drivers.repo refusal named only native Git, which startup refuses
  // beside a Sandbox. It now names the path that fits the selected Sandbox.
  for (const [sandbox, advice] of [
    [
      "bundled",
      /configure repository\.openShell with repository\.preparedGitHub \(the bundled OpenShell Driver refuses git-write\), or repository\.nativeSender without drivers\.sandbox or drivers\.credential_proxy\./,
    ],
    [
      "package",
      /configure repository\.preparedGitHub with the package's drivers\.credential_proxy and no repository\.openShell, or repository\.nativeSender without drivers\.sandbox/,
    ],
    ["none", /then configure repository\.nativeSender with repository\.preparedGitHub\. Do not/],
  ]) {
    await t.test(`retired drivers.repo, Sandbox ${sandbox}`, async () => {
      const invalid = structuredClone(configuration);
      invalid.drivers.repo = { id: "repository-credentials", configuration: {} };
      if (sandbox === "none") {
        delete invalid.drivers.sandbox;
      } else if (sandbox === "package") {
        invalid.drivers.sandbox.package = "@example/installed-sender";
      }
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(load(), (error) => {
        assert.match(error.message, /^drivers\.repo native admission is retired\./);
        assert.match(error.message, advice);
        return true;
      });
    });
  }
});

test("Installation startup validates the optional external observability URL", async (t) => {
  await checkExternalObservabilityUrl(t, startupInputs);
});

registerStartupDiagnosticsCases({ boot, fixture, productionServer, readFile, settled });
test("Installation startup declares native worker support only as a custom runtime image", async (t) => {
  await checkNativeWorkerSupport(t, startupInputs);
});

registerDevelopmentMetricsStartupCase(startupInputs);

async function repositoryInstallation(t) {
  const directory = await temporaryDirectory(t, "occ-repository-startup-");
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
  configuration.repository = {
    id: "repository-credentials",
    configuration: { sessionDurationSeconds: 600 },
    nativeSender: {
      controlSocket: "/run/openclaw/repository-control/private/control.sock",
      publicCaPath: publicCaPath,
    },
    preparedGitHub: {
      custodyKeyPath: join(directory, "custody.key"),
      privateKeyPath: join(directory, "app.pem"),
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

for (const mode of ["native", "selected-blocked", "selected"]) {
  test(`Installation loads prepared GitHub lifecycle only for selected metadata: ${mode}`, async (t) => {
    const configuration =
      mode === "native"
        ? (await repositoryInstallation(t)).configuration
        : credentialProxyInstallation();
    if (mode !== "native") {
      configuration.drivers.credential_proxy.configuration.preparedGitHub = {
        custodyKeyPath: "/nonexistent/fixture-custody.key",
      };
    }
    const path = await fixture(t, configuration);
    const result = spawnSync(
      process.execPath,
      ["tests/fixtures/repository-credentials/installation-module-guard.ts", path, mode],
      { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH } },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
  });
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
  for (const runtime of [api, worker]) {
    assert.equal(Object.hasOwn(runtime, "repositoryPolicy"), false);
    assert.equal(Object.hasOwn(runtime.installation.drivers, "repo"), false);
    assert.equal(runtime.repositoryAdmission.policyMode, "built-in");
    assert.equal(runtime.repositoryAdmission.backendId, registry.backendId);
  }
  const policy = api.repositoryAdmission.policy;
  const workerPolicy = worker.repositoryAdmission.policy;
  assert.equal(policy.capability, "repo");
  // The capability name does not replace the operator's opaque policy identity.
  assert.equal(policy.id, "repository-credentials");
  assert.equal(workerPolicy.id, policy.id);
  assert.deepEqual(api.installation.backend[0].drivers, { repo: policy.id });
  assert.equal(Object.hasOwn(api.installation.drivers, "repository_credentials"), false);
  assert.equal(api.installation.repository.implementation, policy.implementation);
  const selection = { namespaceId: "ns_repository", bindings: [{ repositoryRef: "application" }] };
  const resolved = policy.resolveBindings(selection);
  assert.deepEqual(workerPolicy.resolveBindings(selection), resolved);
  assert.equal(resolved.bindings[0].profile, "git-write");
  assert.equal(resolved.bindings[0].grant.repositoryId, "34567");
  assert.equal(resolved.sessionDurationSeconds, 600);
  assert.throws(
    () => policy.resolveBindings({ ...selection, namespaceId: "ns_other" }),
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
  const server = await boot("apps/controller/src/server.mjs", {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
    ...productionServer,
  });
  assert.equal(server.status, 1);
  assert.equal(startupDiagnostic(server.stderr, "startup-error").code, "PERSISTENCE_UNAVAILABLE");
});

test("the worker refuses a repository App key that cannot sign before it reports ready", async (t) => {
  // Finding 2217: the worker read the App key only at its first token preparation, so it
  // reported ready and each pass logged PREPARED_GITHUB_MAINTENANCE_FAILED without a reason.
  const { configuration, registry, registrySource } = await repositoryInstallation(t);
  // The prepared owner admits only one explicit write ref per Namespace.
  Object.assign(registry.repositories[0].namespaces[0], {
    profiles: ["git-write"],
    transport: "git-only",
    pushRefAllowlist: ["refs/heads/review"],
  });
  await writeFile(registrySource, JSON.stringify(registry));
  const { preparedGitHub } = configuration.repository;
  // Each case binds its own control and prepared-git-use sockets under a short directory.
  const sockets = await socketDirectory(t, "occ-app-key-", {
    longest: "group-writable/prepared-git-use.sock",
  });
  await writeFile(preparedGitHub.custodyKeyPath, randomBytes(32), { mode: 0o600 });
  const directory = dirname(preparedGitHub.custodyKeyPath);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const pkcs8 = { type: "pkcs8", format: "pem" };
  const keys = [
    ["valid", rsa.export(pkcs8), 0o600],
    ["group-writable", rsa.export(pkcs8), 0o620, "app_key_unreadable"],
    ["missing", undefined, 0o600, "app_key_unreadable"],
    [
      "public",
      createPublicKey(rsa).export({ type: "spki", format: "pem" }),
      0o600,
      "app_key_unparsable",
    ],
    [
      "encrypted",
      rsa.export({ ...pkcs8, cipher: "aes-256-cbc", passphrase: "unused-passphrase" }),
      0o600,
      "app_key_unparsable",
    ],
    [
      "ec",
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export(pkcs8),
      0o600,
      "app_key_unsupported",
    ],
  ];
  await Promise.all(
    keys.map(async ([name, pem, mode, reason]) => {
      const keyPath = join(directory, `${name}.pem`);
      if (pem !== undefined) {
        await writeFile(keyPath, pem, { mode });
        await chmod(keyPath, mode);
      }
      const mutated = structuredClone(configuration);
      mutated.repository.preparedGitHub.privateKeyPath = keyPath;
      mutated.repository.nativeSender.controlSocket = join(sockets, name, "control.sock");
      const worker = await boot("apps/controller/src/worker.mjs", {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        OCC_CONFIG_PATH: await fixture(t, mutated),
        OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
      });
      assert.equal(worker.status, 1, name);
      const diagnostic = startupDiagnostic(worker.stderr, "worker.startup-error");
      // A usable key gets past the owner to the unreachable database.
      assert.deepEqual(
        [diagnostic.code, diagnostic.reason],
        reason === undefined
          ? ["PERSISTENCE_UNAVAILABLE", undefined]
          : ["PREPARED_GITHUB_APP_KEY_INVALID", reason],
        `${name}: ${worker.stderr}`,
      );
      assert.ok(!worker.stderr.includes("-----BEGIN") && !worker.stderr.includes(directory));
    }),
  );
});

test("the worker binds bundled OpenShell Git with the prepared owner's protected authority", async (t) => {
  // Finding 2866: worker.mjs starts the prepared owner and hands the selected OpenShell transport
  // only its protected authority, never the owner, which also holds the revision material
  // reader and the trial request callback. This boots the real worker with repository.openShell:
  // it starts the owner, binds the transport (its Git authority listener included) and stops
  // only at the unreachable database.
  const {
    configuration: repository,
    registry,
    registrySource,
    tls,
  } = await repositoryInstallation(t);
  // The prepared owner admits only one explicit write ref per Namespace.
  Object.assign(registry.repositories[0].namespaces[0], {
    profiles: ["git-write"],
    transport: "git-only",
    pushRefAllowlist: ["refs/heads/review"],
  });
  await writeFile(registrySource, JSON.stringify(registry));
  const configuration = credentialProxyInstallation();
  configuration.backend.push(...repository.backend);
  // repository.openShell selects the bundled Proxy's Git registration, with no egress authority,
  // on the same installed Driver as the Sandbox.
  const { sandbox } = configuration.drivers;
  configuration.drivers.credential_proxy = { id: sandbox.id, configuration: {} };
  configuration.backend[0].drivers.credential_proxy = sandbox.id;
  const { nativeSender: _native, ...protectedRepository } = repository.repository;
  const directory = dirname(protectedRepository.preparedGitHub.custodyKeyPath);
  const issuerPublicKeyPath = join(directory, "gateway-public.pem");
  // The worker binds the Git authority on this port seconds after its configuration names it,
  // once its boot gets a slot. Hold the port until the worker exits, so a test file running in
  // parallel cannot take it (finding 3024's race).
  const authority = await reservePort();
  t.after(() => authority.release());
  configuration.repository = {
    ...protectedRepository,
    openShell: {
      registrationName: "oce-prepared-git",
      authority: {
        host: "127.0.0.1",
        port: authority.port,
        certificatePath: tls.certFile,
        privateKeyPath: tls.keyFile,
        issuerPublicKeyPath,
        issuer: "openshell-gateway:openshell-gateway",
        audience: "oce-prepared-git",
        keyId: "current",
      },
    },
  };
  const pkcs8 = { type: "pkcs8", format: "pem" };
  await Promise.all([
    writeFile(protectedRepository.preparedGitHub.custodyKeyPath, randomBytes(32), { mode: 0o600 }),
    writeFile(
      protectedRepository.preparedGitHub.privateKeyPath,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export(pkcs8),
      { mode: 0o600 },
    ),
    writeFile(
      issuerPublicKeyPath,
      generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }),
    ),
  ]);
  const worker = await boot(
    "apps/controller/src/worker.mjs",
    {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: await fixture(t, configuration),
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
    },
    undefined,
    reservedPortArgs(authority),
  );
  assert.equal(worker.status, 1, worker.stderr);
  // The bundled sender reads the authority's online port, which the owner does not have: handing
  // over the owner fails the bind (WORKER_STARTUP_FAILED) before the database is reached.
  assert.equal(
    startupDiagnostic(worker.stderr, "worker.startup-error").code,
    "PERSISTENCE_UNAVAILABLE",
    worker.stderr,
  );
});

function nativeSenderRefusal(path, code, message) {
  return (error) => {
    assert.equal(error.name, "ConfigurationValidationError");
    assert.deepEqual(
      error.error.details.map((detail) => [detail.path, detail.code]),
      [[path, code]],
    );
    assert.equal(error.error.details[0].message, message);
    return true;
  };
}

test("repository startup rejects unmatched ownership, registry identity, duration and CA inputs", async (t) => {
  const { configuration: baseline, tls, writableCaPath } = await repositoryInstallation(t);
  for (const [mutate, expected] of [
    [(value) => delete value.backend, /requires an owning backend/],
    [
      (value) => {
        value.drivers.repository_credentials = value.repository;
        delete value.repository;
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
    [(value) => delete value.repository, /requires repository/],
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
      (value) => (value.repository.configuration.sessionDurationSeconds = 3601),
      /duration|configuration/,
    ],
    [(value) => (value.repository.nativeSender.publicCaPath = tls.keyFile), /invalid-public-ca/],
    [(value) => (value.repository.nativeSender.publicCaPath = writableCaPath), /invalid-public-ca/],
    // An existing CA file under a non-canonical path is refused before file loading.
    [
      (value) =>
        (value.repository.nativeSender.publicCaPath =
          value.repository.nativeSender.publicCaPath.replace(/\/ca\.crt$/, "/./ca.crt")),
      nativeSenderRefusal(
        "/publicCaPath",
        "INVALID_VALUE",
        "repository.nativeSender.publicCaPath must be a canonical absolute path without ASCII control characters.",
      ),
    ],
    // Both diagnostics identify the configured field without repeating the supplied path.
    ...["private-relative/control.sock", `/${"é".repeat(52)}`].map((controlSocket) => [
      (value) => (value.repository.nativeSender.controlSocket = controlSocket),
      nativeSenderRefusal(
        "/controlSocket",
        "INVALID_VALUE",
        "repository.nativeSender.controlSocket must be a canonical absolute path without ASCII control characters, at most 103 UTF-8 bytes.",
      ),
    ]),
    [(value) => (value.repository.package = "@example/driver"), /unsupported option package/],
    [(value) => (value.repository.implementation = "other"), /unsupported option implementation/],
    [(value) => (value.drivers.compute.id = "compute-ssh"), /bundled Kubernetes/],
    // A missing or misplaced native broker peer: see "native repository delivery names a
    // missing or misplaced broker peer in startup logs".
    // Without native delivery no repository material Secret exists and the chart grants no
    // Secret list, so a peer left behind is refused rather than looping on 403 (finding 2212).
    [
      (value) => {
        delete value.repository;
        delete value.backend;
      },
      /drivers\.compute\.configuration\.network\.repositoryCredentials requires repository\.nativeSender/,
    ],
    [
      (value) => (value.backend[0].drivers.repo = "ghp_notarealtoken123456"),
      /plaintext credential/,
    ],
    [
      (value) => (value.backend[0].drivers.repo = "ghu_notarealtoken123456"),
      /plaintext credential/,
    ],
    [
      (value) => (value.backend[0].drivers.repo = "ghs_notarealtoken123456"),
      /plaintext credential/,
    ],
    [
      (value) => (value.backend[0].drivers.repo = "ghr_notarealtoken123456"),
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

test("public CA loading rejects repeated malformed certificates without stalling", async (t) => {
  const directory = await temporaryDirectory(t, "occ-public-ca-");
  const path = join(directory, "ca.pem");
  await writeFile(
    path,
    "-----BEGIN CERTIFICATE-----\nA-----END CERTIFICATE-----\n".repeat(32) + "!",
    { mode: 0o644 },
  );
  // A separate process keeps a pathological parser from blocking the test runner indefinitely.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { loadPublicCa } from "./apps/controller/src/composition/repository-credentials/public-ca.ts"; await loadPublicCa(process.argv[1]).catch((error) => console.log(error.message));',
      path,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), "invalid-public-ca");
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

  assertChatGPTStartupMetadata(drivers);
});

registerChatGPTStartupRefusals(fixture, installation);

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
  const events = [];
  const worker = createControllerWorker({
    pool,
    mode: "production",
    drivers,
    emit: (event) => events.push(event),
  });
  const completed = () =>
    events
      .filter(({ event }) => event === "worker.completed")
      .map(({ workId, outcome, result, code }) => ({ workId, outcome, result, code }));
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
    gatewayManagedMode: true,
    executionAdmission: { version: 2, mode: "unprotected" },
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
  predecessor.harness = { ...harness, overrides: {} };
  predecessor.harness.configuration = computeDriver.resolveHarnessConfiguration(
    predecessor.harness,
    predecessor.harnessAuth,
    predecessor.configuration,
  );
  predecessor.compute.admission = computeDriver.admitRevision(predecessor);
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
  const locks = [];
  let compareAndSetAttempts = 0;
  worker.state.transactWithQueue = async (transaction) =>
    transaction(
      {
        namespaces: {
          lockNamespace: async (...arguments_) => {
            locks.push(["namespace", ...arguments_]);
            return { id: namespaceId };
          },
        },
        agents: {
          lockAgent: async (...arguments_) => {
            locks.push(["agent", ...arguments_]);
            return activeAgent;
          },
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
  // Admission order: the Namespace before the Agent.
  assert.deepEqual(locks, [
    ["namespace", namespaceId, { includeDeleted: true }],
    ["agent", namespaceId, agentId],
  ]);
  assert.equal(compareAndSetAttempts, 1);
  assert.deepEqual(retries, [{ code: "ACTIVE_REVISION_CHANGED" }]);
  assert.equal(activeAgent.activeRevisionId, predecessor.id);
  assert.deepEqual(service.spec.selector, activeSelector);
  assert.deepEqual(serviceWrites, []);
  // The pass logs the retry it committed, not the success it resolved (finding 1611).
  const lostRace = {
    workId: claim.idempotencyKey,
    outcome: "retry",
    result: "retry",
    code: "ACTIVE_REVISION_CHANGED",
  };
  assert.deepEqual(completed(), [lostRace]);

  // The pointer moved before the compare-and-set: the same retry, and the same log.
  activeAgent.activeRevisionId = `rev_production-${harness.mode}-newer`;
  await worker.finalizeRevision(claim, observation);
  assert.equal(compareAndSetAttempts, 1);
  assert.deepEqual(retries, Array(2).fill({ code: "ACTIVE_REVISION_CHANGED" }));
  assert.deepEqual(completed(), [lostRace, lostRace]);

  // The pointer moved after activation committed it: completion retries and logs that retry too.
  await worker.completeActivatedRevision(claim, { ...observation, revision: candidate });
  assert.deepEqual(retries, Array(3).fill({ code: "ACTIVE_REVISION_CHANGED" }));
  assert.deepEqual(completed(), [lostRace, lostRace, lostRace]);
  activeAgent.activeRevisionId = predecessor.id;

  // Recovery for an older claim must never replace a gateway already advanced to a newer revision.
  const newerGateway = computeDriver.deployment(
    name,
    ownership,
    { name: kubernetesNamespaceName(namespaceId), plane: "execution" },
    {
      runtime: "openclaw-enterprise/gateway-fixture:local",
      workspaceSetup: computeDriver.options.images.gateway,
    },
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

registerStartupYamlInputCases(startupInputs);

registerStartupProcessResolutionCases(
  { boot, fixture, productionServer },
  {
    installation,
    isDevelopmentBrowserOrigin,
    developmentBrowserOriginRule: DEVELOPMENT_BROWSER_ORIGIN_RULE,
  },
);

registerStartupInstallationInputCases(startupInputs);

registerStartupPresetCases({
  boot,
  fixture,
  PresetFileError,
  productionServer,
  settled,
});

registerStartupCredentialProxyCases({ boot, fixture, productionServer, settled });

registerStartupDriverResolutionCases(
  { boot, fixture, productionServer },
  { installation, credentialProxyInstallation, repositoryInstallation },
);

test("native repository delivery names a missing or misplaced broker peer in startup logs", async (t) => {
  await checkNativeRepositoryStartup(
    t,
    { boot, fixture, productionServer },
    repositoryInstallation,
  );
});

test("closed Installation observes only its operator-bound Namespace, including Secret and Configuration custody", async (t) => {
  const { gatewayRouting, digest } = await import("../helpers/kubernetes-routed-scenarios.mjs");
  const controllerRequire = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const { KubernetesObjectApi } = controllerRequire("@kubernetes/client-node");
  const configuration = credentialProxyInstallation();
  configuration.drivers.sandbox.configuration.gateway.operatorNamespaceLabels = {
    "openshell.ai/openclaw-workspace": "true",
  };
  configuration.drivers.sandbox.configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "sandbox" },
      automountServiceAccountToken: false,
    },
  ];
  const approvedWorkspacePolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "workspace-deny" },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
  };
  configuration.drivers.sandbox.configuration.gateway.networkPolicyResources = [
    approvedWorkspacePolicy,
  ];
  const compute = configuration.drivers.compute.configuration;
  const id = "ns_closed_binding_test";
  const name = kubernetesNamespaceName(id);
  const uid = "19fc773a-b474-499e-9406-ba18ee701689";
  compute.gatewayRouting = gatewayRouting;
  delete compute.network.gatewayClients;
  const environment = {
    OCC_CONFIG_PATH: await fixture(t, configuration),
    OCC_PREPROVISIONED_NAMESPACE: JSON.stringify({ namespaceId: id, uid }),
  };
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment,
    createOpenShellBackend: (definition) => ({
      id: definition.id,
      drivers: definition.drivers,
      client: {
        clientForNamespace: () => ({
          health: async () => {},
          getWorkspace: async () => ({
            name,
            phase: 1,
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/namespace-id": id,
            },
          }),
        }),
      },
    }),
  });
  const { computeDriver: driver, configurationDriver, secretDriver } = drivers;
  const ns = {
    apiVersion: "v1",
    kind: "Namespace",
    status: { phase: "Active" },
    metadata: {
      name,
      uid,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openshell.ai/openclaw-workspace": "true",
        "openclaw.dev/namespace": id,
        "openclaw.dev/gateway-namespace": id,
        "openclaw-enterprise.io/gateway": digest(
          gatewayRouting.gatewayNamespace + "/" + gatewayRouting.gatewayName,
        ),
        ...Object.fromEntries(
          ["enforce", "audit", "warn"].map((x) => [
            "pod-security.kubernetes.io/" + x,
            "restricted",
          ]),
        ),
      },
      annotations: {
        "openclaw.dev/namespace-id": id,
        "openclaw.dev/namespace-lifecycle": "preprovisioned",
      },
    },
  };
  let observed = structuredClone(ns);
  const reads = [];
  const writes = [];
  const readNamespace = async (query) => {
    assert.deepEqual(query, { name });
    reads.push(name);
    return observed;
  };
  const absent = async (q) => {
    assert.equal(q.namespace, name);
    throw Object.assign(new Error("not found"), { code: 404 });
  };
  const write = async (q) => {
    assert.equal(q.namespace, name);
    assert.equal(q.body.metadata.annotations["openclaw.dev/namespace-id"], id);
    writes.push(q.body.kind + "/" + q.name);
    return q.body;
  };
  // Namespace API is GET of this name only. A list, adoption, or delete has no implementation.
  const core = {
    readNamespace,
    readNamespacedResourceQuota: absent,
    patchNamespacedResourceQuota: write,
    readNamespacedLimitRange: absent,
    patchNamespacedLimitRange: write,
  };
  const account = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    automountServiceAccountToken: false,
    metadata: {
      name: "sandbox",
      namespace: name,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": id,
      },
      annotations: { "openclaw.dev/namespace-id": id },
    },
  };
  const workspacePolicy = {
    ...approvedWorkspacePolicy,
    metadata: { ...account.metadata, name: "workspace-deny" },
  };
  let policies = [workspacePolicy];
  const objects = Object.create(KubernetesObjectApi.prototype);
  objects.read = async (ref) =>
    ref.kind === "Namespace" ? observed : ref.kind === "NetworkPolicy" ? workspacePolicy : account;
  objects.patch = async () => {
    throw Error("unexpected OpenShell Kubernetes write");
  };
  driver.apiClients = Promise.resolve({
    objects,
    version: { getCode: async () => ({ gitVersion: "v1.35.0" }) },
    core,
    networking: {
      listNamespacedNetworkPolicy: async (q) => (
        assert.equal(q.namespace, name),
        { items: policies }
      ),
      readNamespacedNetworkPolicy: absent,
      patchNamespacedNetworkPolicy: write,
    },
  });
  await driver.preflight();
  await configurationDriver.controlNamespace(core, id);
  await secretDriver.readyNamespace(core, id);
  assert.equal(reads.length, 3);

  const tenant = { id };
  assert.equal((await driver.ensureNamespace(tenant)).namespaceReady, true);
  assert.ok(writes.includes("ResourceQuota/openclaw-quota"));
  assert.ok(writes.includes("NetworkPolicy/default-deny"));

  const ownedPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { ...account.metadata, name: "unexpected-allow" },
    spec: { podSelector: {}, policyTypes: ["Egress"], egress: [{}] },
  };
  writes.length = 0;
  policies = [ownedPolicy];
  assert.equal((await driver.ensureNamespace(tenant)).namespaceReady, false);
  assert.deepEqual(writes, []);
  policies = [{ ...ownedPolicy, metadata: { ...ownedPolicy.metadata, name: "default-deny" } }];
  assert.equal((await driver.ensureNamespace(tenant)).namespaceReady, false);
  assert.deepEqual(writes, []);
  policies = [workspacePolicy];

  account.automountServiceAccountToken = true;
  // Sandbox validation now runs through the shared lifecycle after Compute observation.
  const observation = await reconcileNamespaceLifecycle(
    driver,
    drivers.namespaceLifecycleBindings.map(({ owner, hooks }) => ({ id: owner.id, hooks })),
    tenant,
    "ready",
    new AbortController().signal,
    () => {},
  );
  assert.equal(observation.namespaceReady, false);
  account.automountServiceAccountToken = false;
  writes.length = 0;
  const before = reads.length;
  for (const request of [{ id: id + "_other" }, { id, existingNamespace: name }]) {
    const result = await driver.ensureNamespace(request);
    assert.equal(result.failure, "permanent");
    assert.equal(result.namespaceReady, false);
  }
  assert.equal((await driver.deleteNamespace(tenant)).namespaceDeleted, false);
  assert.equal(reads.length, before);
  for (const corrupt of [
    (x) => (x.metadata.uid = uid + "replaced"),
    (x) => (x.metadata.annotations["openclaw.dev/namespace-id"] += "_foreign"),
    (x) => delete x.metadata.annotations["openclaw.dev/namespace-lifecycle"],
    (x) => (x.metadata.labels["pod-security.kubernetes.io/enforce"] = "privileged"),
    (x) => delete x.metadata.labels["openclaw-enterprise.io/gateway"],
    (x) => delete x.metadata.labels["openclaw.dev/gateway-namespace"],
    (x) => (x.metadata.deletionTimestamp = new Date().toISOString()),
  ]) {
    observed = structuredClone(ns);
    corrupt(observed);
    const result = await driver.ensureNamespace(tenant);
    assert.equal(result.failure, "permanent");
    assert.equal(result.namespaceReady, false);
  }
  await assert.rejects(configurationDriver.controlNamespace(core, id), {
    message: /does not match the Installation|control-plane storage namespace/,
  });
  await assert.rejects(secretDriver.readyNamespace(core, id), {
    message: /Kubernetes Secret namespace verification/,
  });
  assert.deepEqual(writes, []);
});

// The public startup processes must reject the quota before persistence, while a
// valid mixed-unit control reaches the deliberately unavailable database.
test("API and worker startup refuse fractional counted quotas before persistence", async (t) => {
  await checkCountedQuotaStartup(t, { boot, fixture, productionServer }, installation);
});
