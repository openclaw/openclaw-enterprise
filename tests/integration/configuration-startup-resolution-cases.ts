import assert from "node:assert/strict";
import { spawnSync, type SpawnOptions } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  loadInstallationConfiguration,
  type InstallationRuntimeDrivers,
} from "../../apps/controller/src/composition/installation-config.ts";
import type {
  GitHubRepositoryRegistration,
  GitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import type { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import type { OpenShellGitRuntimeConfiguration } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { formatStartupConfigurationFailure } from "../../apps/controller/src/startup-failure.ts";
import type {
  BackendConfiguration,
  ErrorDetail,
  GitHubRepositoryCredentialBackendDefinition,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type {
  reservePort as reserveStartupPort,
  reservedPortArgs as startupReservedPortArgs,
} from "../helpers/available-port.ts";
import type {
  createCredentialProxyInstallationConfiguration,
  createInstallationDriverConfiguration,
} from "../helpers/installation-driver-configuration.ts";
import { settled as waitForSiblings } from "../helpers/child-processes.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

type StartupFixture = (
  context: TestContext,
  configuration?: Readonly<Record<string, unknown>>,
) => Promise<string>;

type StartupProcessDependencies = {
  captureChild: (
    program: string,
    args: string[],
    options: Pick<SpawnOptions, "cwd" | "env" | "timeout">,
  ) => Promise<unknown>;
  concurrencyLimit: () => (task: () => Promise<unknown>) => Promise<unknown>;
  compileCache: string;
};
type StartupProcesses = ReturnType<typeof createStartupProcesses>;
export type StartupSiblingWait = typeof waitForSiblings;
export type StartupProcessFixtures = Pick<StartupProcesses, "boot" | "productionServer"> & {
  fixture: StartupFixture;
};

type InstallationInput = Readonly<Record<string, unknown>> & {
  drivers: Readonly<Record<string, unknown>>;
};

type MutableComputeInstallation = InstallationInput & {
  drivers: {
    compute: {
      configuration: {
        servicePrincipalCredentials: { mode: string };
        resources: { namespace: { quota: Record<string, string> } };
      };
    };
  };
};
type InstallationFactory = () => MutableComputeInstallation;

type BaseInstallation = ReturnType<typeof createInstallationDriverConfiguration>;
type ProxyInstallation = ReturnType<typeof createCredentialProxyInstallationConfiguration>;
type RepositoryBackendInput = {
  -readonly [
    K in keyof Pick<GitHubRepositoryCredentialBackendDefinition, "id" | "type" | "configuration">
  ]: GitHubRepositoryCredentialBackendDefinition[K];
} & { configuration: { registryPath: string } };
type RepositoryOptionsInput = {
  id: string;
  configuration: { sessionDurationSeconds: number };
  nativeSender: { controlSocket: string; publicCaPath: string };
  preparedGitHub: { custodyKeyPath: string; privateKeyPath: string };
};
type RepositoryStartupInput = BaseInstallation & {
  backend: [RepositoryBackendInput, ...RepositoryBackendInput[]];
  repository: RepositoryOptionsInput;
};
type ProxyLifecycleInput = Omit<ProxyInstallation, "drivers"> & {
  drivers: Omit<ProxyInstallation["drivers"], "credential_proxy"> & {
    credential_proxy: Omit<ProxyInstallation["drivers"]["credential_proxy"], "configuration"> & {
      configuration: ProxyInstallation["drivers"]["credential_proxy"]["configuration"] & {
        preparedGitHub?: { custodyKeyPath: string };
      };
    };
  };
};
type CombinedRepositoryInput = Omit<RepositoryStartupInput, "backend" | "drivers"> & {
  backend: (RepositoryBackendInput | ChatGPTBackendInput)[];
  drivers: BaseInstallation["drivers"] & { service_account?: ChatGPTServiceAccountInput };
};
type ProtectedWorkerInput = Omit<ProxyInstallation, "backend" | "drivers"> & {
  backend: [
    ProxyInstallation["backend"][0],
    ...(ProxyInstallation["backend"][0] | RepositoryBackendInput)[],
  ];
  drivers: Omit<ProxyInstallation["drivers"], "credential_proxy"> & {
    credential_proxy: {
      id: string;
      configuration:
        ProxyInstallation["drivers"]["credential_proxy"]["configuration"] | Record<string, never>;
    };
  };
  repository?: Omit<RepositoryOptionsInput, "nativeSender"> & {
    openShell: OpenShellGitRuntimeConfiguration;
  };
};
type RepositoryLifecycleMode = "native" | "selected-blocked" | "selected";
type RepositoryFiles = Awaited<ReturnType<typeof prepareRepositoryFiles>>;

type RepositoryInstallation = Readonly<Record<string, unknown>> & {
  drivers: {
    compute: {
      configuration: { network: Record<string, unknown> };
    };
  };
  repository?: unknown;
  backend?: unknown;
};

type RepositoryFixture = (context: TestContext) => Promise<{
  configuration: RepositoryInstallation;
}>;

type StartupEvent = "startup-error" | "worker.startup-error";
type StartupResult = Awaited<ReturnType<StartupProcesses["boot"]>>;
type ChatGPTInputSettings = {
  -readonly [K in keyof BackendConfiguration]: BackendConfiguration[K];
} & {
  apiKey?: string;
  adminKeyPath?: string;
};
type ChatGPTBackendInput = {
  id: string | number;
  type: string;
  package?: string;
  configuration: ChatGPTInputSettings;
  drivers: { service_account?: string };
};
type ChatGPTServiceAccountInput = { id: string; configuration: { backendId?: string } };

const workspaceId = "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0";
const keyPath = "/tmp/nonexistent-occ-chatgpt-admin-key";
const unavailableDatabase = "postgresql://127.0.0.1:1/occ";

export function startupDiagnostic(
  stderr: string,
  event: StartupEvent,
): { code: string; details: unknown; reason: unknown } {
  const lines = stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      const record = asRecord(value);
      assert.ok(record, "startup log must contain JSON records");
      return record;
    });
  const diagnostic = lines.find((line) => line.event === event);
  assert.ok(
    diagnostic && typeof diagnostic.code === "string",
    `startup log must include a code for ${event}`,
  );
  return { code: diagnostic.code, details: diagnostic.details, reason: diagnostic.reason };
}

function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && Object.hasOwn(constants.signals, value);
}

function checkedStartupCapture(capture: unknown) {
  const result = asRecord(capture);
  assert.ok(result, "startup child must report a process result");
  const { status, signal, stderr, stdout } = result;
  assert.ok(
    status === null || typeof status === "number",
    "startup child must report an exit status",
  );
  assert.ok(signal === null || isSignal(signal), "startup child must report an exit signal");
  assert.ok(typeof stdout === "string", "startup child must capture stdout as text");
  assert.ok(typeof stderr === "string", "startup child must capture stderr as text");
  return { status, signal, stdout, stderr };
}

async function settled<const T extends readonly Promise<unknown>[]>(promises: T) {
  // Wait even when a sibling fails, then read the fulfilled values in their original tuple order.
  const wait: (siblings: T) => Promise<unknown> = waitForSiblings;
  await wait(promises);
  return Promise.all(promises);
}

function productionEnvironment(configPath: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: configPath,
    OCC_DATABASE_URL: unavailableDatabase,
  };
}

export function createStartupProcesses({
  captureChild,
  concurrencyLimit,
  compileCache,
}: StartupProcessDependencies) {
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
  async function boot(
    script: string,
    env: NodeJS.ProcessEnv,
    timeout = 30_000,
    nodeArguments: readonly string[] = [],
  ) {
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

  async function warmStartupProcesses(path: string): Promise<void> {
    const env = productionEnvironment(path);
    const boots = [
      boot("apps/controller/src/server.mjs", { ...env, ...productionServer }),
      boot("apps/controller/src/worker.mjs", env),
    ] as const;
    await waitForSiblings(boots);
    const [server, worker] = await Promise.all(boots);
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
  }

  return { boot, productionServer, warmStartupProcesses };
}

function assertDriverRefusal(
  server: StartupResult,
  worker: StartupResult,
  details: readonly ErrorDetail[],
): void {
  for (const [result, event] of [
    [server, "startup-error"],
    [worker, "worker.startup-error"],
  ] as const) {
    assert.equal(result.status, 1, result.stderr);
    const diagnostic = startupDiagnostic(result.stderr, event);
    assert.equal(diagnostic.code, "DRIVER_CONFIGURATION_INVALID", result.stderr);
    assert.deepEqual(diagnostic.details, details);
  }
}

export function createChatGPTInstallation(installation: () => InstallationInput) {
  const backend: [ChatGPTBackendInput, ...ChatGPTBackendInput[]] = [
    {
      id: "openai",
      type: "chatgpt",
      configuration: { workspaceId, apiKeyPath: keyPath, credentialTtlSeconds: 3600 },
      drivers: { service_account: "chatgpt-service-accounts" },
    },
  ];
  const serviceAccount: ChatGPTServiceAccountInput = {
    id: "chatgpt-service-accounts",
    configuration: {},
  };
  const base = installation();
  return { ...base, backend, drivers: { ...base.drivers, service_account: serviceAccount } };
}

type ChatGPTStartupInput = ReturnType<typeof createChatGPTInstallation>;
type ChatGPTRefusal = [(input: ChatGPTStartupInput) => void, RegExp];

function retiredChatGPTInstallation(installation: () => InstallationInput) {
  const { drivers, ...configuration } = installation();
  return {
    ...configuration,
    drivers: { ...drivers, service_account: { id: "chatgpt-service-accounts", configuration: {} } },
    integrations: {
      chatgpt: { workspaceId, adminKeyPath: keyPath, credentialTtlSeconds: 3600 },
    },
  };
}

export function assertChatGPTStartupMetadata(
  drivers: InstallationRuntimeDrivers | undefined,
): void {
  assert.ok(drivers);
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
  const [backend] = drivers.installation.backend;
  assert.ok(backend);
  assert.equal(Object.hasOwn(backend.configuration, "adminKeyPath"), false);
  assert.deepEqual(drivers.installation.drivers.service_account, {
    id: "chatgpt-service-accounts",
  });
  assert.equal(Object.hasOwn(drivers, "serviceAccountDriver"), false);
  assert.equal(Object.hasOwn(drivers, "chatgptClient"), false);
}

export function registerChatGPTStartupRefusals(
  fixture: StartupFixture,
  installation: () => InstallationInput,
): void {
  test("ChatGPT startup rejects retired integrations and unsafe backend configuration", async (t) => {
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: {
          OCC_CONFIG_PATH: await fixture(t, retiredChatGPTInstallation(installation)),
        },
      }),
      /integrations is retired.*backend.*apiKeyPath/,
    );

    const refusals: ChatGPTRefusal[] = [
      [
        (value: Partial<ChatGPTStartupInput>) => {
          delete value.backend;
        },
        /requires an owning backend/,
      ],
      [
        ({ drivers }: { drivers: Partial<ChatGPTStartupInput["drivers"]> }) => {
          delete drivers.service_account;
        },
        /requires drivers\.service_account/,
      ],
      [
        (value) => delete value.backend[0].drivers.service_account,
        /drivers\.service_account.*required/,
      ],
      [
        (value) => (value.backend[0].configuration.workspaceId = "untrusted"),
        /workspaceId.*invalid/,
      ],
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
      ].map((id): ChatGPTRefusal => [
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
    ];
    for (const [mutate, expected] of refusals) {
      const configuration = createChatGPTInstallation(installation);
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
    const longest = createChatGPTInstallation(installation);
    longest.backend[0].id = `open ${"a".repeat(195)}`;
    const accepted = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, longest) },
    });
    const backend = accepted?.installation.backend[0];
    assert.ok(backend);
    assert.equal(backend.id, longest.backend[0].id);
  });
}

export function registerStartupProcessResolutionCases(
  { boot, fixture, productionServer }: StartupProcessFixtures,
  {
    installation,
    isDevelopmentBrowserOrigin,
    developmentBrowserOriginRule,
  }: {
    installation: () => InstallationInput;
    isDevelopmentBrowserOrigin: (origin: string) => boolean;
    developmentBrowserOriginRule: string;
  },
): void {
  test("development OCC_AUTH_BASE_URL must be a loopback origin or an HTTPS localhost subdomain", async (t) => {
    for (const accepted of [
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "http://localhost:3000",
      "https://console.occ-dev-example.oce.localhost:8443",
    ]) {
      assert.equal(isDevelopmentBrowserOrigin(accepted), true, accepted);
    }
    const refused = [
      "http://x.localhost",
      "https://.localhost",
      "https://a..localhost",
      "http://localhost:3000/auth",
      "http://localhost:3000/",
      "http://user@localhost:3000",
      "https://console.example.com",
      "ftp://127.0.0.1:3000",
      // A bind-all address is not loopback, and "localhost" counts only as the whole last label.
      "http://0.0.0.0:3000",
      "https://console.notlocalhost",
      "https://localhost.example.com",
    ];
    for (const value of refused) {
      assert.equal(isDevelopmentBrowserOrigin(value), false, value);
    }
    assert.match(developmentBrowserOriginRule, /HTTPS localhost subdomain/);
    assert.match(developmentBrowserOriginRule, /no path, query, fragment or user info/);

    // The server refuses each spelling in configuration(), before reading the Installation, so the
    // startup diagnostic names the setting instead of a later generic failure.
    const path = await fixture(t);
    await settled(
      ["http://x.localhost", "https://.localhost", "http://localhost:3000/auth"].map(
        async (authBaseURL) => {
          const server = await boot("apps/controller/src/server.mjs", {
            PATH: process.env.PATH,
            NODE_ENV: "development",
            OCC_CONFIG_PATH: path,
            OCC_HOST: "127.0.0.1",
            OCC_PORT: "8080",
            OCC_AUTH_BASE_URL: authBaseURL,
          });
          assert.equal(server.status, 1, authBaseURL);
          assert.equal(
            startupDiagnostic(server.stderr, "startup-error").code,
            "AUTH_BASE_URL_INVALID",
            authBaseURL,
          );
        },
      ),
    );
  });

  test("production server and worker resolve singleton startup without an Installation ID", async (t) => {
    const path = await fixture(t);
    const shared = productionEnvironment(path);

    const [server, worker] = await settled([
      boot("apps/controller/src/server.mjs", {
        ...shared,
        OCC_HOST: "192.0.2.10",
        OCC_PORT: "8080",
      }),
      boot("apps/controller/src/worker.mjs", shared),
    ]);
    // The actual server gets beyond singleton/Driver startup and fails only at missing session auth.
    assert.equal(server.status, 1);
    assert.equal(startupDiagnostic(server.stderr, "startup-error").code, "AUTH_BASE_URL_INVALID");
    assert.doesNotMatch(server.stderr, /OCC_AUTH_BASE_URL|OCC_AUTH_SECRET|OCC_INSTALLATION_ID/);

    // The real worker likewise reaches PostgreSQL; no test-owned database or driver is substituted.
    assert.equal(worker.status, 1);
    assert.equal(
      startupDiagnostic(worker.stderr, "worker.startup-error").code,
      "PERSISTENCE_UNAVAILABLE",
    );
    assert.doesNotMatch(worker.stderr, /OCC_INSTALLATION_ID|explicit Installation/);
  });

  // An unwritable readiness path left the worker running but never Ready (finding 2311). Both
  // health markers are probed before PostgreSQL; readiness through a sibling file, since its
  // marker must not appear before queue health does. The code names the setting (finding 2327),
  // whether the path is relative, in a missing directory or an existing directory.
  test("worker refuses an unwritable readiness or liveness path before opening PostgreSQL", async (t) => {
    const path = await fixture(t);
    const directory = await temporaryDirectory(t, "occ-worker-markers-");
    const shared = productionEnvironment(path);
    const occupied = join(directory, "occupied");
    await mkdir(join(occupied, "entry"), { recursive: true });
    const refusals = (
      [
        ["OCC_WORKER_READINESS_PATH", "WORKER_READINESS_PATH_INVALID"],
        ["OCC_WORKER_LIVENESS_PATH", "WORKER_LIVENESS_PATH_INVALID"],
      ] as const
    ).flatMap(([setting, code]) =>
      ["marker", join(directory, "missing", "marker"), occupied].map((marker) => ({
        setting,
        code,
        marker,
      })),
    );
    const ready = join(directory, "ready");
    const [writable, ...refused] = await settled([
      boot("apps/controller/src/worker.mjs", { ...shared, OCC_WORKER_READINESS_PATH: ready }),
      ...refusals.map(({ setting, marker }) =>
        boot("apps/controller/src/worker.mjs", { ...shared, [setting]: marker }),
      ),
    ]);
    for (const [index, { setting, code, marker }] of refusals.entries()) {
      const worker = refused[index];
      assert.ok(worker, `missing result for ${setting}`);
      assert.equal(worker.status, 1, `${setting}=${marker}`);
      assert.equal(
        startupDiagnostic(worker.stderr, "worker.startup-error").code,
        code,
        `${setting}=${marker}`,
      );
      // The code names the setting; the configured path stays out of the log.
      assert.ok(!worker.stderr.includes(directory), setting);
    }
    // A writable path reaches PostgreSQL, leaving neither the marker nor the probe behind.
    assert.equal(writable.status, 1);
    assert.equal(
      startupDiagnostic(writable.stderr, "worker.startup-error").code,
      "PERSISTENCE_UNAVAILABLE",
    );
    assert.deepEqual((await readdir(directory)).sort(), ["occupied"]);
    assert.deepEqual(await readdir(occupied), ["entry"]);
  });

  test("only the actual API process reads ChatGPT admin credentials and backend accounts require PostgreSQL", async (t) => {
    const path = await fixture(t, createChatGPTInstallation(installation));
    const shared = productionEnvironment(path);

    const [server, worker, inMemory] = await settled([
      boot("apps/controller/src/server.mjs", {
        ...shared,
        ...productionServer,
      }),
      boot("apps/controller/src/worker.mjs", shared),
      boot("apps/controller/src/server.mjs", {
        PATH: process.env.PATH,
        NODE_ENV: "development",
        OCC_AUTH_BASE_URL: "https://console.oce.localhost",
        OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
        OCC_CONFIG_PATH: path,
        OCC_HOST: "127.0.0.1",
        OCC_PORT: "8080",
      }),
    ]);
    // API startup fails on its missing mounted admin key before opening the configured database.
    assert.equal(server.status, 1);
    assert.equal(
      startupDiagnostic(server.stderr, "startup-error").code,
      "CHATGPT_ADMIN_KEY_UNAVAILABLE",
    );
    assert.doesNotMatch(server.stderr, /ChatGPT admin-key Secret is unavailable/);

    // The same configured worker cannot read that mount and fails only when PostgreSQL is unavailable.
    assert.equal(worker.status, 1);
    assert.equal(
      startupDiagnostic(worker.stderr, "worker.startup-error").code,
      "PERSISTENCE_UNAVAILABLE",
    );
    assert.doesNotMatch(worker.stderr, /ChatGPT|admin-key|ServiceAccount Driver/);

    // Driver-private backend bindings cannot silently fall back to ephemeral in-memory persistence.
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
}

export function registerStartupDriverResolutionCases(
  { boot, fixture, productionServer }: StartupProcessFixtures,
  {
    installation,
    credentialProxyInstallation,
    repositoryInstallation,
  }: {
    installation: InstallationFactory;
    credentialProxyInstallation: InstallationFactory;
    repositoryInstallation: RepositoryFixture;
  },
): void {
  test("production Kubernetes Compute refuses disabled ServicePrincipal credentials unless a Sandbox is selected", async (t) => {
    // Finding 1753: #1400 dropped this production guard for every install, not only
    // Sandbox-backed ones, so a hand-written Installation could run Agents without it.
    const disabled = (configuration: MutableComputeInstallation): MutableComputeInstallation => {
      configuration.drivers.compute.configuration.servicePrincipalCredentials = {
        mode: "disabled",
      };
      return configuration;
    };
    const details: ErrorDetail[] = [
      {
        path: "/drivers/compute/configuration/servicePrincipalCredentials/mode",
        code: "INVALID_VALUE",
        message:
          "drivers.compute.configuration.servicePrincipalCredentials.mode must be projectedServiceAccountToken in production unless a Sandbox Driver is selected.",
      },
    ];
    const load = async (
      mode: "development" | "production",
      configuration: MutableComputeInstallation,
    ) =>
      loadInstallationConfiguration({
        mode,
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      });
    await assert.rejects(load("production", disabled(installation())), (error: unknown) => {
      assert.equal(
        formatStartupConfigurationFailure(error),
        `DRIVER_CONFIGURATION_INVALID: ${JSON.stringify(details)}`,
      );
      return true;
    });
    // Development, projected credentials, and a Sandbox-backed production install still load.
    for (const [mode, configuration] of [
      ["development", disabled(installation())],
      ["production", installation()],
      ["production", disabled(credentialProxyInstallation())],
    ] as const) {
      const loaded = await load(mode, configuration);
      assert.equal(loaded?.installation.occ.cluster, "production-west");
    }
    // API and worker startup logs carry the same field refusal.
    const shared = productionEnvironment(await fixture(t, disabled(installation())));
    const [server, worker] = await settled([
      boot("apps/controller/src/server.mjs", { ...shared, ...productionServer }),
      boot("apps/controller/src/worker.mjs", shared),
    ]);
    assertDriverRefusal(server, worker, details);
  });

  test("a leftover repository broker peer names its field in API and worker startup logs", async (t) => {
    // Finding 2226: the refusal was a plain Error, so API and worker logged only STARTUP_FAILED
    // and WORKER_STARTUP_FAILED, and only the upgrade check printed which field to remove.
    // installation-change-preflight.test.mjs checks the upgrade check's line.
    const { configuration } = await repositoryInstallation(t);
    delete configuration.repository;
    delete configuration.backend;
    const shared = productionEnvironment(await fixture(t, configuration));
    const details: ErrorDetail[] = [
      {
        path: "/drivers/compute/configuration/network/repositoryCredentials",
        code: "INVALID_VALUE",
        message:
          "drivers.compute.configuration.network.repositoryCredentials requires repository.nativeSender; remove it for protected Git or when no repository is configured.",
      },
    ];
    const [server, worker] = await settled([
      boot("apps/controller/src/server.mjs", { ...shared, ...productionServer }),
      boot("apps/controller/src/worker.mjs", shared),
    ]);
    assertDriverRefusal(server, worker, details);
  });
}

export async function prepareRepositoryFiles(
  directory: string,
  certificatePath: string,
  publicCa: Uint8Array,
) {
  await chmod(certificatePath, 0o644);
  const writableCaPath = join(directory, "writable-ca.crt");
  await writeFile(writableCaPath, publicCa);
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
  } satisfies GitHubRepositoryRegistry;
  const registrySource = join(directory, "registry-generation.json");
  await writeFile(registrySource, JSON.stringify(registry), { mode: 0o644 });
  const registryPath = join(directory, "registry.json");
  // Kubernetes ConfigMap/public-CA projection uses symlinks; these nonsecret
  // inputs must not inherit the service's stricter private-file loader.
  await symlink(registrySource, registryPath);
  const publicCaPath = join(directory, "ca.crt");
  await symlink(certificatePath, publicCaPath);
  return { writableCaPath, registry, registrySource, registryPath, publicCaPath };
}

export async function checkRepositoryLifecycle(
  t: TestContext,
  mode: RepositoryLifecycleMode,
  fixture: StartupFixture,
  {
    native,
    proxy,
  }: {
    native: () => Promise<RepositoryStartupInput>;
    proxy: typeof createCredentialProxyInstallationConfiguration;
  },
): Promise<void> {
  const configuration: RepositoryStartupInput | ProxyLifecycleInput =
    mode === "native" ? await native() : proxy();
  if (mode !== "native") {
    assert.ok("credential_proxy" in configuration.drivers);
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
}

export async function checkRepositoryResolution(
  t: TestContext,
  {
    policy,
    workerPolicy,
    configuration,
    registry,
    registrySource,
    path,
  }: {
    policy: Pick<GitHubRepositoryPolicy, "resolveBindings">;
    workerPolicy: Pick<GitHubRepositoryPolicy, "resolveBindings">;
    configuration: RepositoryStartupInput;
    registry: GitHubRepositoryRegistry;
    registrySource: string;
    path: string;
  },
  {
    boot,
    fixture,
    productionServer,
    chatgptInstallation,
  }: StartupProcessFixtures & {
    chatgptInstallation: () => ChatGPTStartupInput;
  },
): Promise<void> {
  const selection = { namespaceId: "ns_repository", bindings: [{ repositoryRef: "application" }] };
  const resolved = policy.resolveBindings(selection);
  assert.deepEqual(workerPolicy.resolveBindings(selection), resolved);
  const binding = resolved.bindings[0];
  assert.ok(binding);
  assert.equal(binding.profile, "git-write");
  assert.equal(binding.grant.repositoryId, "34567");
  assert.equal(resolved.sessionDurationSeconds, 600);
  assert.throws(
    () => policy.resolveBindings({ ...selection, namespaceId: "ns_other" }),
    /permitted/,
  );
  const chatgpt = chatgptInstallation();
  const combined: CombinedRepositoryInput = structuredClone(configuration);
  combined.backend.push(...chatgpt.backend);
  combined.drivers.service_account = chatgpt.drivers.service_account;
  const combinedDrivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, combined) },
  });
  assert.ok(combinedDrivers);
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
  const fittedBackend = fits?.installation.backend[0];
  assert.ok(fittedBackend);
  assert.equal(fittedBackend.id, astral.backend[0].id);

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
}

export async function checkProtectedRepositoryWorker(
  t: TestContext,
  {
    repository,
    registry,
    registrySource,
    certFile,
    keyFile,
  }: {
    repository: RepositoryStartupInput;
    registry: RepositoryFiles["registry"];
    registrySource: string;
    certFile: string;
    keyFile: string;
  },
  {
    boot,
    fixture,
    reservePort,
    reservedPortArgs,
    credentialProxyInstallation,
  }: Pick<StartupProcessFixtures, "boot" | "fixture"> & {
    reservePort: typeof reserveStartupPort;
    reservedPortArgs: typeof startupReservedPortArgs;
    credentialProxyInstallation: typeof createCredentialProxyInstallationConfiguration;
  },
): Promise<void> {
  // Finding 2866: worker.mjs starts the prepared owner and hands the selected OpenShell transport
  // only its protected authority, never the owner, which also holds the revision material
  // reader and the trial request callback. This boots the real worker with repository.openShell:
  // it starts the owner, binds the transport (its Git authority listener included) and stops
  // only at the unreachable database.
  // The prepared owner admits only one explicit write ref per Namespace.
  const registration = registry.repositories[0];
  const namespace = registration?.namespaces[0];
  assert.ok(namespace);
  Object.assign(namespace, {
    profiles: ["git-write"],
    transport: "git-only",
    pushRefAllowlist: ["refs/heads/review"],
  } satisfies Pick<
    GitHubRepositoryRegistration["namespaces"][number],
    "profiles" | "transport" | "pushRefAllowlist"
  >);
  await writeFile(registrySource, JSON.stringify(registry));
  const configuration: ProtectedWorkerInput = credentialProxyInstallation();
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
        certificatePath: certFile,
        privateKeyPath: keyFile,
        issuerPublicKeyPath,
        issuer: "openshell-gateway:openshell-gateway",
        audience: "oce-prepared-git",
        keyId: "current",
      },
    },
  };
  const pkcs8 = { type: "pkcs8", format: "pem" } as const;
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
}

export async function checkNativeRepositoryStartup(
  t: TestContext,
  { boot, fixture, productionServer }: StartupProcessFixtures,
  repositoryInstallation: RepositoryFixture,
): Promise<void> {
  // Finding 2227: like finding 2226, the refusal was a plain Error, so API and worker logged
  // only STARTUP_FAILED and WORKER_STARTUP_FAILED.
  const field = "/drivers/compute/configuration/network/repositoryCredentials";
  const { configuration } = await repositoryInstallation(t);
  const missing = structuredClone(configuration);
  delete missing.drivers.compute.configuration.network.repositoryCredentials;
  // Ports on both sides of 8443; neither appears inside "8443", so the echo check means something.
  const misplaced = (port: number) => {
    const value = structuredClone(configuration);
    const peer = asRecord(value.drivers.compute.configuration.network.repositoryCredentials);
    assert.ok(peer && typeof peer.port === "number");
    peer.port = port;
    return value;
  };
  for (const [mutated, expected] of [
    [missing, [field, "REQUIRED"]],
    [misplaced(8444), [`${field}/port`, "INVALID_VALUE"]],
    [misplaced(8442), [`${field}/port`, "INVALID_VALUE"]],
  ] as const) {
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, mutated) },
      }),
      (error: unknown) => {
        // What the startup log and the upgrade check print, after the log filter.
        const failure = formatStartupConfigurationFailure(error);
        const prefix = "DRIVER_CONFIGURATION_INVALID: ";
        assert.ok(failure && failure.startsWith(prefix), String(error));
        const details: unknown = JSON.parse(failure.slice(prefix.length));
        assert.ok(Array.isArray(details));
        assert.deepEqual(
          details.map((detail: unknown) => {
            const field = asRecord(detail);
            assert.ok(field && typeof field.path === "string" && typeof field.code === "string");
            return [field.path, field.code];
          }),
          [expected],
          failure,
        );
        assert.ok(!failure.includes("8444") && !failure.includes("8442"), failure);
        return true;
      },
    );
  }
  const shared = productionEnvironment(await fixture(t, missing));
  const [server, worker] = await settled([
    boot("apps/controller/src/server.mjs", { ...shared, ...productionServer }),
    boot("apps/controller/src/worker.mjs", shared),
  ]);
  assertDriverRefusal(server, worker, [
    {
      path: field,
      code: "REQUIRED",
      message:
        "repository.nativeSender requires drivers.compute.configuration.network.repositoryCredentials, the Kubernetes repository service peer.",
    },
  ]);
}

export async function checkCountedQuotaStartup(
  t: TestContext,
  { boot, fixture, productionServer }: StartupProcessFixtures,
  installation: InstallationFactory,
): Promise<void> {
  const quotas: readonly [Record<string, string>, string][] = [
    [{ pods: "1.5" }, "DRIVER_CONFIGURATION_INVALID"],
    [{ "services.nodeports": "1.5" }, "DRIVER_CONFIGURATION_INVALID"],
    [{ "count/deployments.apps": "1500m" }, "DRIVER_CONFIGURATION_INVALID"],
    [{ pods: "1000m", "requests.cpu": "500m" }, "PERSISTENCE_UNAVAILABLE"],
  ];
  for (const [quota, expectedCode] of quotas) {
    const configuration: MutableComputeInstallation = installation();
    configuration.drivers.compute.configuration.resources.namespace.quota = quota;
    const path = await fixture(t, configuration);
    for (const [script, event] of [
      ["server", "startup-error"],
      ["worker", "worker.startup-error"],
    ] as const) {
      const result = await boot(`apps/controller/src/${script}.mjs`, {
        ...productionEnvironment(path),
        ...productionServer,
      });
      assert.equal(result.status, 1, result.stderr);
      const diagnostic = startupDiagnostic(result.stderr, event);
      assert.equal(diagnostic.code, expectedCode, result.stderr);
      if (expectedCode === "DRIVER_CONFIGURATION_INVALID") {
        assert.deepEqual(diagnostic.details, [
          {
            path: "/resources/namespace/quota",
            code: "INVALID_FORMAT",
            message: `Namespace quota resource ${Object.keys(quota)[0]} must satisfy Kubernetes integer precision; use a whole count such as 4.`,
          },
        ]);
      }
    }
  }
}
