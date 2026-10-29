import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { openShellRepositoryConfiguration } from "../../apps/controller/src/composition/installation-fields.ts";
import { DEVELOPMENT_HARNESS_DESCRIPTOR } from "../../apps/controller/src/composition/production-harness.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { formatStartupConfigurationFailure } from "../../apps/controller/src/startup-failure.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  admitLoggingConfiguration,
  ConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import { validateSelectedBackendDrivers } from "../../packages/occ/src/index.ts";
import { spawnSync } from "node:child_process";
import { availablePort } from "../helpers/available-port.mjs";
import { captureChild, concurrencyLimit, settled } from "../helpers/child-processes.mjs";
import { fileCompileCache } from "../helpers/compile-cache.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  createCredentialProxyInstallationConfiguration as credentialProxyInstallation,
  createInstallationDriverConfiguration as installation,
} from "../helpers/installation-driver-configuration.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

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

// The startup cases boot the real API and worker processes with an allowlisted environment,
// which drops NODE_COMPILE_CACHE, so it is passed explicitly: the lane's cache in CI, otherwise
// a temporary one owned by this file, so each boot after the first reuses compiled code.
const compileCache = await fileCompileCache("configuration-startup");

// The production listener and sign-in settings of the API boots that reach session auth.
const productionServer = {
  OCC_HOST: "192.0.2.10",
  OCC_PORT: "8080",
  OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
  OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
};

// Boots run concurrently, about one per CPU. A boot killed at its timeout rejects with
// the signal instead of reading as a wrong exit status. The timeout only guards against a
// process that never exits: every boot here ends in a startup refusal within a second or two
// on an idle machine, and on a loaded runner the same boot took more than 10 s.
const limit = concurrencyLimit();
async function boot(script, env, timeout = 30_000) {
  const { signal, ...result } = await limit(() =>
    captureChild(process.execPath, [script], {
      cwd: process.cwd(),
      env: { ...env, NODE_COMPILE_CACHE: compileCache },
      timeout,
    }),
  );
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
  const configuration = installation();
  configuration.observability = { url: "https://metrics.example.test/d/operations" };
  const path = await fixture(t, configuration);
  const loaded = await loadInstallationConfiguration({
    mode: "development",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.equal(loaded.installation.observability.url, configuration.observability.url);

  const url = configuration.observability.url;
  const rewrittenIpv4ObservabilityUrl =
    /observability\.url IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address\./;
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
      (error) => {
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, rewrittenIpv4ObservabilityUrl);
        return true;
      },
    );
  }
  // URL parsing drops an empty user info and keeps the host alone; profile preflight refuses
  // any @ before the host, and so does startup.
  for (const userinfo of [
    "http://@grafana.example.internal/d",
    "https://:@grafana.example.internal/d",
    "http:@grafana.example.internal/d",
    "http:\t//@grafana.example.internal/d",
    "http://@192.0.2.10:3000/d",
  ]) {
    configuration.observability = { url: userinfo };
    await writeFile(path, JSON.stringify(configuration), "utf8");
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "development",
        environment: { OCC_CONFIG_PATH: path },
      }),
      /observability\.url must not contain user info or an @ before the host\./,
      JSON.stringify(userinfo),
    );
  }
  for (const shorthand of ["http://192.168.1", "http://2130706433"]) {
    configuration.observability = { url: shorthand };
    await writeFile(path, JSON.stringify(configuration), "utf8");
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "development",
        environment: { OCC_CONFIG_PATH: path },
      }),
      (error) => {
        assert.match(error.message, rewrittenIpv4ObservabilityUrl);
        assert.doesNotMatch(error.message, /must be an absolute HTTP or HTTPS URL/);
        return true;
      },
    );
  }
  for (const raw of [
    "http://good.example\tevil.com/x",
    "http://evil.com\\.good.example/path",
    "http://good.example\nevil.com/x",
    "http://good.example\revil.com/x",
  ]) {
    configuration.observability = { url: raw };
    await writeFile(path, JSON.stringify(configuration), "utf8");
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "development",
        environment: { OCC_CONFIG_PATH: path },
      }),
      /observability\.url must not contain a tab or newline, or a backslash before the query; the URL parser drops or rewrites them into a different host\./,
      JSON.stringify(raw),
    );
  }
  configuration.observability = { url: "http://192.168.1.1" };
  await writeFile(path, JSON.stringify(configuration), "utf8");
  const canonical = await loadInstallationConfiguration({
    mode: "development",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.equal(canonical.installation.observability.url, "http://192.168.1.1/");
  assert.equal(new URL(canonical.installation.observability.url).hostname, "192.168.1.1");
  configuration.observability = {
    url: "https://grafana.example.test/d/operations?var-pattern=\\d+",
  };
  await writeFile(path, JSON.stringify(configuration), "utf8");
  const queryBackslash = await loadInstallationConfiguration({
    mode: "development",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.equal(
    new URL(queryBackslash.installation.observability.url).hostname,
    "grafana.example.test",
  );
});

test("API, worker, and Helm hook report safe field diagnostics before persistence", async (t) => {
  const cases = [
    [
      (configuration) => {
        configuration.drivers.compute.configuration.authentication = {
          mode: "kubeconfig",
          kubeconfigPath: "/etc/kube/config",
        };
      },
      [
        {
          path: "/authentication/context",
          code: "REQUIRED",
          message: "Explicit Kubernetes context must be explicitly configured.",
        },
      ],
    ],
    [
      (configuration) => {
        configuration.drivers.compute.configuration.runtime.gatewayStorageClassName = "Bad_Class";
      },
      [
        {
          path: "/runtime/gatewayStorageClassName",
          code: "INVALID_FORMAT",
          message:
            "SQLite-compatible gateway storage class must be a DNS-safe Kubernetes resource name.",
        },
      ],
    ],
    [
      (configuration) => {
        configuration.sandboxNetworkPolicyCeiling = {};
      },
      [
        {
          path: "/sandboxNetworkPolicyCeiling",
          code: "INVALID_TYPE",
          message: "Configuration does not satisfy type.",
        },
      ],
    ],
    [
      (configuration) => {
        configuration.sandboxNetworkPolicyCeiling = [
          {
            id: "ceiling-control",
            binary: "/usr/bin/python3.11",
            host: "ceiling.example.test",
            ports: [{ from: 444, to: 443 }],
          },
        ];
      },
      [
        {
          path: "/sandboxNetworkPolicyCeiling/0/ports/0/to",
          code: "INVALID_RANGE",
          message: "The end port must be at least the start port.",
        },
      ],
    ],
  ];
  // All three entrypoints map a ConfigurationValidationError to the code and its details with
  // the same function, so, as in the observability test, the last case boots them for real.
  // The others reach the loader all three call with the file (production mode) and get that
  // function's one-line diagnostic.
  for (const [index, [mutate, details]] of cases.entries()) {
    const configuration = installation();
    configuration.occ.cluster = "production-west";
    mutate(configuration);
    const path = await fixture(t, configuration);
    if (index < cases.length - 1) {
      await assert.rejects(
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: path },
        }),
        (error) => {
          assert.ok(error instanceof ConfigurationValidationError, String(error));
          const line = formatStartupConfigurationFailure(error);
          assert.match(line, /^DRIVER_CONFIGURATION_INVALID: /);
          assert.deepEqual(
            JSON.parse(line.slice("DRIVER_CONFIGURATION_INVALID: ".length)),
            details,
          );
          assert.ok(!line.includes(path));
          assert.doesNotMatch(line, /Bad_Class|ceiling\.example\.test|\/additions/);
          return true;
        },
      );
      continue;
    }
    const environment = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: path,
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
      OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
      OCC_AUTH_BASE_URL: "https://console.example.test",
    };
    // All three entrypoints reject before persistence. Ceiling errors must name
    // the Installation input, including its array index, rather than the Agent wrapper.
    await settled(
      [
        ["apps/controller/src/server.mjs", "startup-error"],
        ["apps/controller/src/worker.mjs", "worker.startup-error"],
        ["deploy/helm/openclaw-enterprise/files/check-installation.mjs", null],
      ].map(async ([script, event]) => {
        const result = await boot(script, environment, 15_000);
        assert.equal(result.status, 1);
        if (event === null) {
          assert.match(result.stderr, /^installation-check:.*DRIVER_CONFIGURATION_INVALID: /);
        }
        const diagnostic =
          event === null
            ? {
                code: "DRIVER_CONFIGURATION_INVALID",
                details: JSON.parse(
                  result.stderr.trim().split("DRIVER_CONFIGURATION_INVALID: ")[1],
                ),
              }
            : startupDiagnostic(result.stderr, event);
        assert.equal(diagnostic.code, "DRIVER_CONFIGURATION_INVALID");
        assert.deepEqual(diagnostic.details, details);
        assert.ok(!result.stderr.includes(path));
        assert.doesNotMatch(
          result.stderr,
          /Bad_Class|ceiling\.example\.test|\/additions|PERSISTENCE_UNAVAILABLE/,
        );
      }),
    );
  }
});

test("API and worker refuse a bad observability host or runtime image before opening PostgreSQL", async (t) => {
  const configuration = installation();
  configuration.occ.cluster = "production-west";
  const path = await fixture(t, configuration);
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };
  const processes = [
    [
      "apps/controller/src/server.mjs",
      "startup-error",
      {
        ...shared,
        OCC_HOST: "192.0.2.10",
        OCC_PORT: "8080",
        OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
        OCC_AUTH_BASE_URL: "https://console.oce.example.internal",
      },
    ],
    ["apps/controller/src/worker.mjs", "worker.startup-error", shared],
  ];
  // Each real case boots both processes on its own copy of the file, concurrently.
  const refuses = async (file, code, label) =>
    settled(
      processes.map(async ([script, event, env]) => {
        const result = await boot(script, { ...env, OCC_CONFIG_PATH: file });
        assert.equal(result.status, 1, script);
        assert.ok(!result.stderr.includes(file), result.stderr);
        const diagnostic = startupDiagnostic(result.stderr, event);
        assert.equal(diagnostic.code, code, `${script} ${label}`);
        return diagnostic;
      }),
    );
  // One real pair per refusal message the startup code mappings tell apart: the first input
  // of each family. Its other inputs go through the loader both processes call with the file
  // (production mode) before they open PostgreSQL; the message is what maps to the code.
  const cases = [];
  const check = (code, inputs) => {
    for (const [index, [label, message, apply]] of inputs.entries()) {
      apply();
      cases.push(
        fixture(t, structuredClone(configuration)).then(async (copy) => {
          if (index > 0) {
            await assert.rejects(
              loadInstallationConfiguration({
                mode: "production",
                environment: { OCC_CONFIG_PATH: copy },
              }),
              Array.isArray(message)
                ? (error) => {
                    assert.ok(error instanceof ConfigurationValidationError, label);
                    assert.deepEqual(error.error.details, message, label);
                    return true;
                  }
                : message,
              label,
            );
            return;
          }
          for (const diagnostic of await refuses(copy, code, label)) {
            assert.equal(diagnostic.message, undefined, label);
            if (Array.isArray(message)) {
              assert.deepEqual(diagnostic.details, message, label);
            }
          }
        }),
      );
    }
  };
  for (const [message, urls] of [
    [
      /observability\.url IPv4 host must be four decimal octets/,
      ["http://192.168.1", "http://2130706433"],
    ],
    [
      /observability\.url must not contain user info/,
      ["http://@grafana.example.internal/d", "http://@192.168.1.1"],
    ],
    [
      /observability\.url must be an absolute HTTP/,
      [
        "javascript:alert(1)",
        syntheticCredentialUrl({
          username: "user",
          password: "",
          host: "grafana.example.internal",
        }),
      ],
    ],
    [
      /observability\.url must not contain a tab/,
      [
        "http://good.example\tevil.com/x",
        "http://evil.com\\.good.example/path",
        "http://good.example\nevil.com/x",
      ],
    ],
  ]) {
    check(
      "OBSERVABILITY_URL_INVALID",
      urls.map((url) => [
        url,
        message,
        () => {
          configuration.observability = { url };
        },
      ]),
    );
  }
  // Kubernetes refuses to pull an image whose repository path has an uppercase letter, or any
  // other reference its parser refuses, such as one with .. in the path. The real pairs take
  // a Gateway image for one message and an Agent image for the other.
  configuration.observability = { url: "http://192.168.1.1" };
  const images = configuration.drivers.compute.configuration.images;
  const original = { ...images };
  const uppercase = (image) =>
    image.replace(/^([^/]*\/)(.)/, (_, host, first) => host + first.toUpperCase());
  const dotted = (image) => image.replace(/^([^/]*\/)/, "$1re..po/");
  const refusedImage = (role, refuse, message) => [
    `${role} ${refuse(original[role])}`,
    [{ path: `/images/${role}`, code: "INVALID_FORMAT", message }],
    () => {
      Object.assign(images, original);
      images[role] = refuse(original[role]);
      assert.notEqual(images[role], original[role]);
    },
  ];
  check("DRIVER_CONFIGURATION_INVALID", [
    refusedImage(
      "gateway",
      uppercase,
      "Gateway image repository path must be lowercase; Kubernetes refuses to pull an uppercase one.",
    ),
    refusedImage(
      "agent",
      uppercase,
      "Agent image repository path must be lowercase; Kubernetes refuses to pull an uppercase one.",
    ),
  ]);
  check("DRIVER_CONFIGURATION_INVALID", [
    refusedImage(
      "agent",
      dotted,
      "Agent image must be a container image reference Kubernetes can pull.",
    ),
    refusedImage(
      "gateway",
      dotted,
      "Gateway image must be a container image reference Kubernetes can pull.",
    ),
  ]);
  Object.assign(images, original);
  configuration.observability = { url: "http://192.168.1.1" };
  cases.push(
    writeFile(path, JSON.stringify(configuration), "utf8").then(() =>
      refuses(path, "PERSISTENCE_UNAVAILABLE", "valid"),
    ),
  );
  await settled(cases);
  const corrected = JSON.parse(await readFile(path, "utf8"));
  assert.equal(corrected.occ.cluster, "production-west");
  assert.equal(corrected.observability.url, "http://192.168.1.1");
});

test("Installation startup declares native worker support only as a custom runtime image", async (t) => {
  const configuration = installation();
  const path = await fixture(t, configuration);
  const load = () =>
    loadInstallationConfiguration({ mode: "development", environment: { OCC_CONFIG_PATH: path } });
  // The pinned runtime needs no operator declaration in the Installation file.
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
  assert.equal(api.repositoryPolicy.capability, "repo");
  // The capability name does not replace the operator's opaque Driver identity.
  assert.equal(api.repositoryPolicy.id, "repository-credentials");
  assert.equal(worker.repositoryPolicy.id, api.repositoryPolicy.id);
  assert.deepEqual(api.installation.backend[0].drivers, { repo: api.repositoryPolicy.id });
  assert.equal(Object.hasOwn(api.installation.drivers, "repository_credentials"), false);
  assert.equal(api.installation.repository.implementation, api.repositoryPolicy.implementation);
  const selection = { namespaceId: "ns_repository", bindings: [{ repositoryRef: "application" }] };
  const resolved = api.repositoryPolicy.resolve(selection);
  assert.deepEqual(worker.repositoryPolicy.resolve(selection), resolved);
  assert.equal(resolved.bindings[0].profile, "git-write");
  assert.equal(resolved.bindings[0].grant.repositoryId, "34567");
  assert.equal(resolved.sessionDurationSeconds, 600);
  assert.throws(
    () => api.repositoryPolicy.resolve({ ...selection, namespaceId: "ns_other" }),
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
  configuration.repository = {
    ...protectedRepository,
    openShell: {
      registrationName: "oce-prepared-git",
      authority: {
        host: "127.0.0.1",
        port: await availablePort(),
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
  const worker = await boot("apps/controller/src/worker.mjs", {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: await fixture(t, configuration),
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  });
  assert.equal(worker.status, 1, worker.stderr);
  // The bundled sender reads the authority's online port, which the owner does not have: handing
  // over the owner fails the bind (WORKER_STARTUP_FAILED) before the database is reached.
  assert.equal(
    startupDiagnostic(worker.stderr, "worker.startup-error").code,
    "PERSISTENCE_UNAVAILABLE",
    worker.stderr,
  );
});

function nativeSenderRefusal(path, code) {
  return (error) => {
    assert.equal(error.name, "ConfigurationValidationError");
    assert.deepEqual(
      error.error.details.map((detail) => [detail.path, detail.code]),
      [[path, code]],
    );
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
    // The native sender's path contract (finding 2214): an existing CA file under a
    // non-canonical path is refused at load. The control socket client checks its own path.
    [
      (value) =>
        (value.repository.nativeSender.publicCaPath =
          value.repository.nativeSender.publicCaPath.replace(/\/ca\.crt$/, "/./ca.crt")),
      nativeSenderRefusal("", "INVALID_VALUE"),
    ],
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
  assert.match(DEVELOPMENT_BROWSER_ORIGIN_RULE, /HTTPS localhost subdomain/);
  assert.match(DEVELOPMENT_BROWSER_ORIGIN_RULE, /no path, query, fragment or user info/);

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
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };

  const [server, worker] = await settled([
    boot("apps/controller/src/server.mjs", { ...shared, OCC_HOST: "192.0.2.10", OCC_PORT: "8080" }),
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
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };
  const occupied = join(directory, "occupied");
  await mkdir(join(occupied, "entry"), { recursive: true });
  const refusals = [
    ["OCC_WORKER_READINESS_PATH", "WORKER_READINESS_PATH_INVALID"],
    ["OCC_WORKER_LIVENESS_PATH", "WORKER_LIVENESS_PATH_INVALID"],
  ].flatMap(([setting, code]) =>
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
  const path = await fixture(t, chatgptInstallation());
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };

  const [server, worker, inMemory] = await settled([
    boot("apps/controller/src/server.mjs", {
      ...shared,
      ...productionServer,
    }),
    boot("apps/controller/src/worker.mjs", shared),
    boot("apps/controller/src/server.mjs", {
      PATH: process.env.PATH,
      NODE_ENV: "development",
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
  const refusal = (path, code, message) => [{ path, code, message }];
  const structural = (path, keyword, code = "INVALID_VALUE") =>
    refusal(path, code, `Configuration does not satisfy ${keyword}.`);
  for (const [mutate, expected] of [
    [(value) => (value.drivers.compute.configuration.apiKey = "plaintext"), /plaintext credential/],
    [
      (value) => (value.drivers.configuration.implementation = "occ/docker-config"),
      /unsupported option.*implementation/,
    ],
    [
      (value) =>
        (value.drivers.configuration.configuration.authentication = { mode: "kubeconfig" }),
      [
        ...structural("/authentication/mode", "const"),
        ...refusal(
          "/authentication/kubeconfigPath",
          "REQUIRED",
          "This configuration field is required.",
        ),
        ...refusal("/authentication/context", "REQUIRED", "This configuration field is required."),
        ...structural("/authentication", "oneOf"),
      ],
    ],
    [
      (value) => (value.drivers.iam.configuration.unexpected = true),
      structural("", "additionalProperties", "UNKNOWN_FIELD"),
    ],
    [
      (value) => (value.drivers.compute.configuration.resources.gateway.unexpected = true),
      structural("/resources/gateway", "additionalProperties", "UNKNOWN_FIELD"),
    ],
    [
      (value) => (value.drivers.compute.configuration.images.requireImmutableDigest = false),
      /immutable image digests/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.network.gatewayPort = Number.MAX_SAFE_INTEGER + 1),
      /network\.gatewayPort must be a safe integer\.$/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.images.gateway = "registry.example/gateway:latest"),
      refusal(
        "/images/gateway",
        "INVALID_FORMAT",
        "Gateway image must use an immutable SHA-256 digest.",
      ),
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.images.agent = "registry.example/agent:latest"),
      refusal(
        "/images/agent",
        "INVALID_FORMAT",
        "Agent image must use an immutable SHA-256 digest.",
      ),
    ],
    [
      (value) => delete value.drivers.compute.configuration.runtime,
      /explicitly configured Codex runtime/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.runtime.modelSecretPrefix =
          value.drivers.compute.configuration.runtime.transportSecretPrefix),
      structural("/runtime", "additionalProperties", "UNKNOWN_FIELD"),
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
      (error) => {
        if (expected instanceof RegExp) {
          assert.match(error.message, expected);
        } else {
          assert.ok(error instanceof ConfigurationValidationError);
          assert.deepEqual(error.error.details, expected);
        }
        return true;
      },
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
  // Entries are trimmed before they resolve, so whitespace inside a quoted YAML entry does not
  // change the path.
  relativeConfiguration.presets = {
    includeDefaults: false,
    files: ["  presets/from-file.json\t"],
  };
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

  // Editors on Windows often save JSON with a UTF-8 byte order mark. Like Driver package
  // manifests and the startup YAML, a Preset file may carry one leading mark.
  const markedConfiguration = installation();
  const markedPreset = join(relativeDirectory, "marked.json");
  markedConfiguration.presets = { includeDefaults: false, files: [markedPreset] };
  await writeFile(markedPreset, `\uFEFF${JSON.stringify({ ...validPreset, name: "marked-file" })}`);
  const markedRuntime = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, markedConfiguration) },
  });
  assert.equal(markedRuntime.defaultPresets[0].name, "marked-file");

  for (const [filename, contents, expected] of [
    ["missing.json", undefined, /Preset file .* is unavailable/],
    ["malformed.json", '{"name":', /Preset file .* must contain valid JSON/],
    // Only one leading mark is stripped; a second is not JSON.
    [
      "double-mark.json",
      `\uFEFF\uFEFF${JSON.stringify(validPreset)}`,
      /Preset file .* must contain valid JSON/,
    ],
    [
      "missing-name.json",
      JSON.stringify({ template: {} }),
      /Preset file .*missing-name\.json\.name must be a nonempty string/,
    ],
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
  const cases = [
    ["missing.json", undefined],
    [
      "invalid-template.json",
      JSON.stringify({ name: "invalid", template: { agent: { unsupported: true } } }),
    ],
    ["invalid-name.json", JSON.stringify({ name: "line\u2028break", template: {} })],
    ["duplicate.json", duplicate, ["cases/duplicate.json", "cases/duplicate-b.json"]],
    ["not-a-list.json", undefined, "cases/not-a-list.json"],
    ["blank-entry", undefined, ["  "]],
  ];
  // Both processes map any PresetFileError to the code (`instanceof`), and their logs keep only
  // the code. One real pair proves that mapping and the log; each other cause must reach the
  // loader both processes call with the file (production mode) as a PresetFileError.
  await settled(
    cases.map(async ([filename, contents, files], index) => {
      const configuration = installation();
      configuration.presets = { includeDefaults: false, files: files ?? [`cases/${filename}`] };
      const path = await fixture(t, configuration);
      await mkdir(join(dirname(path), "cases"), { recursive: true });
      if (contents !== undefined) {
        await writeFile(join(dirname(path), "cases", filename), contents);
        await writeFile(join(dirname(path), "cases", "duplicate-b.json"), duplicate);
      }
      if (index > 0) {
        await assert.rejects(
          loadInstallationConfiguration({
            mode: "production",
            environment: { OCC_CONFIG_PATH: path },
          }),
          (error) => {
            assert.ok(error instanceof PresetFileError, `${filename}: ${String(error)}`);
            return true;
          },
        );
        return;
      }
      const shared = {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        OCC_CONFIG_PATH: path,
        OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
      };
      const [server, worker] = await settled([
        boot("apps/controller/src/server.mjs", {
          ...shared,
          ...productionServer,
        }),
        boot("apps/controller/src/worker.mjs", shared),
      ]);
      assert.equal(server.status, 1, filename);
      const apiDiagnostic = startupDiagnostic(server.stderr, "startup-error");
      assert.equal(apiDiagnostic.code, "PRESET_FILE_INVALID", filename);
      assert.equal(apiDiagnostic.message, undefined);
      assert.ok(!server.stderr.includes(dirname(path)), server.stderr);

      assert.equal(worker.status, 1, filename);
      const workerDiagnostic = startupDiagnostic(worker.stderr, "worker.startup-error");
      assert.equal(workerDiagnostic.code, "PRESET_FILE_INVALID", filename);
      assert.equal(workerDiagnostic.message, undefined);
      assert.ok(!worker.stderr.includes(dirname(path)), worker.stderr);
    }),
  );
});

test("API and worker name a chart listener mismatch and both values in their startup error", async (t) => {
  // On a fresh install no upgrade check runs, so startup's log is the operator's only clue
  // that the Installation authority is not on the port the chart routes (finding 2213).
  const configuration = credentialProxyInstallation();
  configuration.drivers.credential_proxy.configuration.authority.host = "0.0.0.0";
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: await fixture(t, configuration),
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
    OCC_EGRESS_AUTHORITY_PORT: "9555",
    OCC_OPENSHELL_GIT_PORT: "disabled",
  };
  const [server, worker] = await settled([
    boot("apps/controller/src/server.mjs", { ...shared, ...productionServer }),
    boot("apps/controller/src/worker.mjs", shared),
  ]);
  for (const [result, event] of [
    [server, "startup-error"],
    [worker, "worker.startup-error"],
  ]) {
    assert.equal(result.status, 1, result.stderr);
    const diagnostic = startupDiagnostic(result.stderr, event);
    assert.equal(diagnostic.code, "CHART_LISTENER_MISMATCH");
    assert.deepEqual(diagnostic.details, [
      {
        path: "/drivers/credential_proxy/configuration/authority/port",
        code: "INVALID_VALUE",
        message:
          "drivers.credential_proxy.configuration.authority.port is 9444, but Helm egressAuthority.port is 9555.",
      },
    ]);
  }
});

test("an authority block names each refused field and never its value", async (t) => {
  // Finding 2216: nine faults shared one message about "a loopback development listener",
  // and API and worker logs said only STARTUP_FAILED.
  const field = "/drivers/credential_proxy/configuration/authority";
  const sentinel = "sentinel-7c1e";
  const block = (value) => (configuration) =>
    (configuration.drivers.credential_proxy.configuration.authority = value);
  const fieldOf = (mutate) => (configuration) =>
    mutate(configuration.drivers.credential_proxy.configuration.authority);
  const cases = [
    ["production", block(undefined), [[field, "REQUIRED"]]],
    ["production", block([]), [[field, "INVALID_TYPE"]]],
    // An unknown key is reported at the block: the key itself could be anything.
    ["production", fieldOf((a) => (a[`${sentinel}/~`] = 1)), [[field, "UNKNOWN_FIELD"]]],
    ["production", fieldOf((a) => delete a.issuer), [[`${field}/issuer`, "REQUIRED"]]],
    ["production", fieldOf((a) => (a.keyId = "")), [[`${field}/keyId`, "INVALID_VALUE"]]],
    ["production", fieldOf((a) => (a.audience = 7)), [[`${field}/audience`, "INVALID_TYPE"]]],
    ["production", fieldOf((a) => delete a.port), [[`${field}/port`, "REQUIRED"]]],
    ["production", fieldOf((a) => (a.port = "9444")), [[`${field}/port`, "INVALID_TYPE"]]],
    ["production", fieldOf((a) => (a.port = 65536)), [[`${field}/port`, "INVALID_RANGE"]]],
    [
      "production",
      fieldOf((a) => {
        a.certificatePath = `${sentinel}.crt`;
        a.privateKeyPath = `${sentinel}.key`;
        a.issuerPublicKeyPath = `${sentinel}.pub`;
      }),
      ["certificatePath", "privateKeyPath", "issuerPublicKeyPath"].map((key) => [
        `${field}/${key}`,
        "INVALID_FORMAT",
      ]),
    ],
    ["development", fieldOf((a) => (a.host = "0.0.0.0")), [[`${field}/host`, "INVALID_VALUE"]]],
  ];
  for (const [mode, mutate, expected] of cases) {
    const configuration = credentialProxyInstallation();
    mutate(configuration);
    await assert.rejects(
      loadInstallationConfiguration({
        mode,
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      (error) => {
        // What the startup log and the upgrade check print, after the log filter.
        const failure = formatStartupConfigurationFailure(error);
        const prefix = "DRIVER_CONFIGURATION_INVALID: ";
        assert.ok(failure?.startsWith(prefix), String(error));
        assert.deepEqual(
          JSON.parse(failure.slice(prefix.length)).map((detail) => [detail.path, detail.code]),
          expected,
          failure,
        );
        for (const value of [sentinel, "0.0.0.0", "9444"]) {
          assert.ok(!failure.includes(value), failure);
        }
        return true;
      },
    );
  }
  // The same field and code reach both processes' startup logs.
  const configuration = credentialProxyInstallation();
  configuration.drivers.credential_proxy.configuration.authority.privateKeyPath = "tls.key";
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: await fixture(t, configuration),
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };
  const [server, worker] = await settled([
    boot("apps/controller/src/server.mjs", { ...shared, ...productionServer }),
    boot("apps/controller/src/worker.mjs", shared),
  ]);
  for (const [result, event] of [
    [server, "startup-error"],
    [worker, "worker.startup-error"],
  ]) {
    assert.equal(result.status, 1, result.stderr);
    const diagnostic = startupDiagnostic(result.stderr, event);
    assert.equal(diagnostic.code, "DRIVER_CONFIGURATION_INVALID", result.stderr);
    assert.deepEqual(diagnostic.details, [
      {
        path: `${field}/privateKeyPath`,
        code: "INVALID_FORMAT",
        message:
          "drivers.credential_proxy.configuration.authority.privateKeyPath must be an absolute mounted-file path.",
      },
    ]);
  }
});

test("Credential Proxy request capacity keeps today's bounds and refuses each bad field by name", async (t) => {
  const field = "/drivers/credential_proxy/requestCapacity";
  const sentinel = 7_919;
  const withCapacity = async (requestCapacity, mode = "development") => {
    const configuration = credentialProxyInstallation();
    if (requestCapacity !== undefined) {
      configuration.drivers.credential_proxy.requestCapacity = requestCapacity;
    }
    return loadInstallationConfiguration({
      mode,
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    });
  };
  const today = {
    operations: 1024,
    authenticatingOperations: 256,
    sandboxOperations: 256,
    requestIds: 8192,
    sandboxRequestIds: 2048,
  };
  assert.deepEqual((await withCapacity()).installation.credentialProxyCapacity, today);
  assert.deepEqual((await withCapacity({})).installation.credentialProxyCapacity, today);
  // An omitted share is a quarter of its configured pool, at least 1; a set share is kept.
  assert.deepEqual(
    (await withCapacity({ operations: 64, requestIds: 4096, sandboxRequestIds: 4096 })).installation
      .credentialProxyCapacity,
    {
      operations: 64,
      authenticatingOperations: 16,
      sandboxOperations: 16,
      requestIds: 4096,
      sandboxRequestIds: 4096,
    },
  );
  assert.deepEqual(
    (await withCapacity({ operations: 3, requestIds: 1, sandboxOperations: 3 })).installation
      .credentialProxyCapacity,
    {
      operations: 3,
      authenticatingOperations: 1,
      sandboxOperations: 3,
      requestIds: 1,
      sandboxRequestIds: 1,
    },
  );
  assert.deepEqual(
    (
      await withCapacity({
        operations: 8192,
        authenticatingOperations: 8192,
        sandboxOperations: 8192,
        requestIds: 131_072,
        sandboxRequestIds: 131_072,
      })
    ).installation.credentialProxyCapacity.sandboxRequestIds,
    131_072,
    "the documented maximum is accepted",
  );
  const cases = [
    [[], [[field, "INVALID_TYPE"]]],
    [null, [[field, "INVALID_TYPE"]]],
    [7, [[field, "INVALID_TYPE"]]],
    // An unknown key is reported at the block: the key itself could be anything.
    [{ [`x${sentinel}/~`]: 1 }, [[field, "UNKNOWN_FIELD"]]],
    [{ operations: "1024" }, [[`${field}/operations`, "INVALID_TYPE"]]],
    [{ sandboxOperations: 2.5 }, [[`${field}/sandboxOperations`, "INVALID_TYPE"]]],
    [{ requestIds: null }, [[`${field}/requestIds`, "INVALID_TYPE"]]],
    [{ operations: 0 }, [[`${field}/operations`, "INVALID_RANGE"]]],
    [{ authenticatingOperations: -1 }, [[`${field}/authenticatingOperations`, "INVALID_RANGE"]]],
    [{ operations: 8193 }, [[`${field}/operations`, "INVALID_RANGE"]]],
    [{ requestIds: 131_073 }, [[`${field}/requestIds`, "INVALID_RANGE"]]],
    [{ sandboxRequestIds: 131_073 }, [[`${field}/sandboxRequestIds`, "INVALID_RANGE"]]],
    // Each share is bounded by its pool, configured or default.
    [{ sandboxOperations: 1025 }, [[`${field}/sandboxOperations`, "INVALID_RANGE"]]],
    [
      { operations: 64, authenticatingOperations: 65 },
      [[`${field}/authenticatingOperations`, "INVALID_RANGE"]],
    ],
    [
      { requestIds: 4096, sandboxRequestIds: 4097 },
      [[`${field}/sandboxRequestIds`, "INVALID_RANGE"]],
    ],
    // Every fault is reported at once.
    [
      { [`${sentinel}`]: true, operations: 0, sandboxRequestIds: "all", requestIds: sentinel * 99 },
      [
        [field, "UNKNOWN_FIELD"],
        [`${field}/operations`, "INVALID_RANGE"],
        [`${field}/requestIds`, "INVALID_RANGE"],
        [`${field}/sandboxRequestIds`, "INVALID_TYPE"],
      ],
    ],
  ];
  for (const [requestCapacity, expected] of cases) {
    await assert.rejects(withCapacity(requestCapacity, "production"), (error) => {
      // What the startup log and the upgrade check print, after the log filter.
      const failure = formatStartupConfigurationFailure(error);
      const prefix = "DRIVER_CONFIGURATION_INVALID: ";
      assert.ok(failure?.startsWith(prefix), String(error));
      assert.deepEqual(
        JSON.parse(failure.slice(prefix.length)).map((detail) => [detail.path, detail.code]),
        expected,
        failure,
      );
      for (const value of [String(sentinel), String(sentinel * 99), "1024", "8193", "4097"]) {
        assert.ok(!failure.includes(value), failure);
      }
      return true;
    });
  }
  // The startup file loader already refuses any unsafe integer in the Installation.
  await assert.rejects(
    withCapacity({ requestIds: 2 ** 53 }, "production"),
    /requestCapacity\.requestIds must be a safe integer/,
  );
  // API, worker and the chart's upgrade check refuse the same field before any other work.
  const configuration = credentialProxyInstallation();
  configuration.drivers.credential_proxy.requestCapacity = { requestIds: 0 };
  const environment = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: await fixture(t, configuration),
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };
  const expected = [
    {
      path: `${field}/requestIds`,
      code: "INVALID_RANGE",
      message: "drivers.credential_proxy.requestCapacity.requestIds must be from 1 to 131072.",
    },
  ];
  await settled(
    [
      ["apps/controller/src/server.mjs", "startup-error"],
      ["apps/controller/src/worker.mjs", "worker.startup-error"],
      ["deploy/helm/openclaw-enterprise/files/check-installation.mjs", null],
    ].map(async ([script, event]) => {
      const result = await boot(script, { ...environment, ...productionServer });
      assert.equal(result.status, 1, result.stderr);
      const diagnostic =
        event === null
          ? {
              code: "DRIVER_CONFIGURATION_INVALID",
              details: JSON.parse(result.stderr.trim().split("DRIVER_CONFIGURATION_INVALID: ")[1]),
            }
          : startupDiagnostic(result.stderr, event);
      assert.equal(diagnostic.code, "DRIVER_CONFIGURATION_INVALID", result.stderr);
      assert.deepEqual(diagnostic.details, expected);
    }),
  );
});

test("a repository OpenShell authority refusal names its own block", () => {
  // The Installation and the repository transport share the validator, not the field path.
  const authority = credentialProxyInstallation().drivers.credential_proxy.configuration.authority;
  delete authority.keyId;
  assert.throws(
    () => openShellRepositoryConfiguration({ registrationName: "git", authority }, "production"),
    (error) => {
      assert.deepEqual(error.details, [
        {
          path: "/repository/openShell/authority/keyId",
          code: "REQUIRED",
          message: "repository.openShell.authority.keyId must be a nonempty string.",
        },
      ]);
      return true;
    },
  );
});

test("production Kubernetes Compute refuses disabled ServicePrincipal credentials unless a Sandbox is selected", async (t) => {
  // Finding 1753: #1400 dropped this production guard for every install, not only
  // Sandbox-backed ones, so a hand-written Installation could run Agents without it.
  const disabled = (configuration) => {
    configuration.drivers.compute.configuration.servicePrincipalCredentials = {
      mode: "disabled",
    };
    return configuration;
  };
  const details = [
    {
      path: "/drivers/compute/configuration/servicePrincipalCredentials/mode",
      code: "INVALID_VALUE",
      message:
        "drivers.compute.configuration.servicePrincipalCredentials.mode must be projectedServiceAccountToken in production unless a Sandbox Driver is selected.",
    },
  ];
  const load = async (mode, configuration) =>
    loadInstallationConfiguration({
      mode,
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    });
  await assert.rejects(load("production", disabled(installation())), (error) => {
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
  ]) {
    const loaded = await load(mode, configuration);
    assert.equal(loaded.installation.occ.cluster, "production-west");
  }
  // API and worker startup logs carry the same field refusal.
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: await fixture(t, disabled(installation())),
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };
  const [server, worker] = await settled([
    boot("apps/controller/src/server.mjs", { ...shared, ...productionServer }),
    boot("apps/controller/src/worker.mjs", shared),
  ]);
  for (const [result, event] of [
    [server, "startup-error"],
    [worker, "worker.startup-error"],
  ]) {
    assert.equal(result.status, 1, result.stderr);
    const diagnostic = startupDiagnostic(result.stderr, event);
    assert.equal(diagnostic.code, "DRIVER_CONFIGURATION_INVALID", result.stderr);
    assert.deepEqual(diagnostic.details, details);
  }
});

test("a leftover repository broker peer names its field in API and worker startup logs", async (t) => {
  // Finding 2226: the refusal was a plain Error, so API and worker logged only STARTUP_FAILED
  // and WORKER_STARTUP_FAILED, and only the upgrade check printed which field to remove.
  // installation-change-preflight.test.mjs checks the upgrade check's line.
  const { configuration } = await repositoryInstallation(t);
  delete configuration.repository;
  delete configuration.backend;
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: await fixture(t, configuration),
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };
  const details = [
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
  for (const [result, event] of [
    [server, "startup-error"],
    [worker, "worker.startup-error"],
  ]) {
    assert.equal(result.status, 1, result.stderr);
    const diagnostic = startupDiagnostic(result.stderr, event);
    assert.equal(diagnostic.code, "DRIVER_CONFIGURATION_INVALID", result.stderr);
    assert.deepEqual(diagnostic.details, details);
  }
});

test("native repository delivery names a missing or misplaced broker peer in startup logs", async (t) => {
  // Finding 2227: like finding 2226, the refusal was a plain Error, so API and worker logged
  // only STARTUP_FAILED and WORKER_STARTUP_FAILED.
  const field = "/drivers/compute/configuration/network/repositoryCredentials";
  const { configuration } = await repositoryInstallation(t);
  const missing = structuredClone(configuration);
  delete missing.drivers.compute.configuration.network.repositoryCredentials;
  // Ports on both sides of 8443; neither appears inside "8443", so the echo check means something.
  const misplaced = (port) => {
    const value = structuredClone(configuration);
    value.drivers.compute.configuration.network.repositoryCredentials.port = port;
    return value;
  };
  for (const [mutated, expected] of [
    [missing, [field, "REQUIRED"]],
    [misplaced(8444), [`${field}/port`, "INVALID_VALUE"]],
    [misplaced(8442), [`${field}/port`, "INVALID_VALUE"]],
  ]) {
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, mutated) },
      }),
      (error) => {
        // What the startup log and the upgrade check print, after the log filter.
        const failure = formatStartupConfigurationFailure(error);
        const prefix = "DRIVER_CONFIGURATION_INVALID: ";
        assert.ok(failure?.startsWith(prefix), String(error));
        const details = JSON.parse(failure.slice(prefix.length));
        assert.deepEqual(
          details.map((detail) => [detail.path, detail.code]),
          [expected],
          failure,
        );
        assert.ok(!failure.includes("8444") && !failure.includes("8442"), failure);
        return true;
      },
    );
  }
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: await fixture(t, missing),
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };
  const [server, worker] = await settled([
    boot("apps/controller/src/server.mjs", { ...shared, ...productionServer }),
    boot("apps/controller/src/worker.mjs", shared),
  ]);
  for (const [result, event] of [
    [server, "startup-error"],
    [worker, "worker.startup-error"],
  ]) {
    assert.equal(result.status, 1, result.stderr);
    const diagnostic = startupDiagnostic(result.stderr, event);
    assert.equal(diagnostic.code, "DRIVER_CONFIGURATION_INVALID", result.stderr);
    assert.deepEqual(diagnostic.details, [
      {
        path: field,
        code: "REQUIRED",
        message:
          "repository.nativeSender requires drivers.compute.configuration.network.repositoryCredentials, the Kubernetes repository service peer.",
      },
    ]);
  }
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
  assert.equal((await driver.ensureNamespace(tenant)).namespaceReady, false);
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
