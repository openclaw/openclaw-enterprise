import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  loadInstallationConfiguration,
  type InstallationRuntimeDrivers,
} from "../../apps/controller/src/composition/installation-config.ts";
import { formatStartupConfigurationFailure } from "../../apps/controller/src/startup-failure.ts";
import type { BackendConfiguration, ErrorDetail } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { settled as waitForSiblings } from "../helpers/child-processes.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

type StartupFixture = (
  context: TestContext,
  configuration?: Readonly<Record<string, unknown>>,
) => Promise<string>;

type StartupProcessFixtures = {
  boot: (script: string, environment: NodeJS.ProcessEnv) => Promise<StartupResult>;
  fixture: StartupFixture;
  productionServer: NodeJS.ProcessEnv;
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
type StartupResult = { status: number | null; stderr: string; stdout: string };
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

export function checkedStartupCapture(
  capture: unknown,
): StartupResult & { signal: NodeJS.Signals | null } {
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
