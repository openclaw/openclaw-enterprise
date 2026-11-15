import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type * as startup from "../../apps/controller/src/composition/installation-config.ts";
import type {
  ConfigurationValidationError,
  ErrorDetail,
} from "../../packages/contracts/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

type StartupFixture = (
  context: TestContext,
  configuration?: Readonly<Record<string, unknown>>,
) => Promise<string>;

type StartupInputs = {
  fixture: StartupFixture;
  loadInstallationConfiguration: typeof startup.loadInstallationConfiguration;
  loadStartupConfigurationSnapshot: typeof startup.loadStartupConfigurationSnapshot;
  ConfigurationValidationError: typeof ConfigurationValidationError;
};

type ObservabilityInput = { url: string; extra?: number };
type NativeWorkerInput = { nativeWorkerSupport?: boolean | string; image?: string };
type InstallationFixture = ReturnType<typeof installation>;
type ConfigurationDriver = InstallationFixture["drivers"]["configuration"];
type ComputeConfiguration = InstallationFixture["drivers"]["compute"]["configuration"];
type InstallationInput = Omit<InstallationFixture, "drivers"> & {
  observability?: ObservabilityInput;
  runtime?: NativeWorkerInput;
  drivers: InstallationFixture["drivers"] & {
    configuration: ConfigurationDriver & { implementation?: string };
    iam: { configuration: { unexpected?: boolean } };
    compute: {
      configuration: ComputeConfiguration & {
        apiKey?: string;
        unexpected?: number;
        secretRef?: string;
        authentication: { installation_id?: string };
        resources: { gateway: { unexpected?: boolean } };
        runtime: { modelSecretPrefix?: string };
      };
    };
  };
};
type ObservabilityRefusal = [input: ObservabilityInput, expected: RegExp];
type NativeWorkerRefusal = [input: NativeWorkerInput, expected: RegExp];
type InstallationRefusal = [
  mutate: (input: InstallationInput) => void,
  expected: RegExp | readonly ErrorDetail[],
];

export async function checkExternalObservabilityUrl(
  t: TestContext,
  { fixture, loadInstallationConfiguration }: StartupInputs,
): Promise<void> {
  const url = "https://metrics.example.test/d/operations";
  const configuration: InstallationInput = { ...installation(), observability: { url } };
  const path = await fixture(t, configuration);
  const load = () =>
    loadInstallationConfiguration({ mode: "development", environment: { OCC_CONFIG_PATH: path } });
  const loadWith = async (observability: ObservabilityInput) => {
    configuration.observability = observability;
    await writeFile(path, JSON.stringify(configuration), "utf8");
    return load();
  };
  const loaded = await load();
  assert.ok(loaded?.installation.observability);
  assert.equal(loaded.installation.observability.url, url);

  const rewrittenIpv4ObservabilityUrl =
    /observability\.url IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address\./;
  const invalidUrls: ObservabilityRefusal[] = [
    ...[
      "javascript:alert(1)",
      syntheticCredentialUrl({
        username: "user",
        password: "pass",
        host: "example.test",
      }),
      "relative",
      "https://x.example/#f",
    ].map((invalid): ObservabilityRefusal => [{ url: invalid }, /observability\.url/]),
    [{ url, extra: 1 }, /observability contains unsupported option extra/],
  ];
  for (const [observability, message] of invalidUrls) {
    await assert.rejects(loadWith(observability), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, rewrittenIpv4ObservabilityUrl);
      return true;
    });
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
    await assert.rejects(
      loadWith({ url: userinfo }),
      /observability\.url must not contain user info or an @ before the host\./,
      JSON.stringify(userinfo),
    );
  }
  for (const shorthand of ["http://192.168.1", "http://2130706433"]) {
    await assert.rejects(loadWith({ url: shorthand }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, rewrittenIpv4ObservabilityUrl);
      assert.doesNotMatch(error.message, /must be an absolute HTTP or HTTPS URL/);
      return true;
    });
  }
  for (const raw of [
    "http://good.example\tevil.com/x",
    "http://evil.com\\.good.example/path",
    "http://good.example\nevil.com/x",
    "http://good.example\revil.com/x",
  ]) {
    await assert.rejects(
      loadWith({ url: raw }),
      /observability\.url must not contain a tab or newline, or a backslash before the query; the URL parser drops or rewrites them into a different host\./,
      JSON.stringify(raw),
    );
  }
  const canonical = await loadWith({ url: "http://192.168.1.1" });
  assert.ok(canonical?.installation.observability);
  assert.equal(canonical.installation.observability.url, "http://192.168.1.1/");
  assert.equal(new URL(canonical.installation.observability.url).hostname, "192.168.1.1");
  const queryBackslash = await loadWith({
    url: "https://grafana.example.test/d/operations?var-pattern=\\d+",
  });
  assert.ok(queryBackslash?.installation.observability);
  assert.equal(
    new URL(queryBackslash.installation.observability.url).hostname,
    "grafana.example.test",
  );
}

export async function checkNativeWorkerSupport(
  t: TestContext,
  { fixture, loadInstallationConfiguration }: StartupInputs,
): Promise<void> {
  const configuration: InstallationInput = installation();
  const path = await fixture(t, configuration);
  const load = () =>
    loadInstallationConfiguration({ mode: "development", environment: { OCC_CONFIG_PATH: path } });
  // The pinned runtime needs no operator declaration in the Installation file.
  const pinned = await load();
  assert.ok(pinned);
  assert.equal(pinned.installation.runtime, undefined);
  configuration.runtime = { nativeWorkerSupport: "custom-image" };
  await writeFile(path, JSON.stringify(configuration), "utf8");
  const custom = await load();
  assert.ok(custom);
  assert.deepEqual(custom.installation.runtime, { nativeWorkerSupport: "custom-image" });
  const invalidRuntimes: NativeWorkerRefusal[] = [
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
  ];
  for (const [runtime, message] of invalidRuntimes) {
    configuration.runtime = runtime;
    await writeFile(path, JSON.stringify(configuration), "utf8");
    await assert.rejects(load(), message);
  }
}

export function registerDevelopmentMetricsStartupCase({
  fixture,
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot,
}: StartupInputs): void {
  test("development accepts a Metrics URL with its default Compose Drivers", async (t) => {
    const url = "https://metrics.example.test/d/operations";
    const path = await fixture(t, { observability: { url } });
    const environment = { OCC_CONFIG_PATH: path };
    const snapshot = await loadStartupConfigurationSnapshot({ mode: "development", environment });
    assert.ok(snapshot.observability);
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
}

export function registerStartupYamlInputCases({
  fixture,
  loadInstallationConfiguration,
}: StartupInputs): void {
  test("startup accepts actual block-style YAML instead of requiring JSON", async (t) => {
    const path = await fixture(t);
    const configuration = installation();
    const yaml = `occ:\n  cluster: production-west\ndrivers:\n  configuration: ${JSON.stringify(configuration.drivers.configuration)}\n  iam: ${JSON.stringify(configuration.drivers.iam)}\n  compute: ${JSON.stringify(configuration.drivers.compute)}\n  secret: ${JSON.stringify(configuration.drivers.secret)}\n`;
    await writeFile(path, yaml, "utf8");
    const loaded = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
    });
    assert.ok(loaded);
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
    const invalidPaths: [path: string, message: string][] = [
      [" ", "OCC_CONFIG_PATH must identify the Installation startup YAML."],
      [
        "relative/installation.yaml",
        "OCC_CONFIG_PATH must identify an absolute Installation startup YAML path.",
      ],
      [`${invalidYaml}.missing`, "The configured Installation startup YAML is unavailable."],
      [invalidYaml, "The configured Installation startup file must contain valid YAML."],
    ];
    for (const [path, message] of invalidPaths) {
      await assert.rejects(
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: path },
        }),
        { message },
        JSON.stringify(path),
      );
    }
  });
}

export function registerStartupInstallationInputCases({
  fixture,
  loadInstallationConfiguration,
  ConfigurationValidationError,
}: StartupInputs): void {
  test("startup rejects caller-selected Installation IDs and obsolete Driver selectors", async (t) => {
    const path = await fixture(t);
    const retiredSelectors: [name: string, value: string][] = [
      ["OCC_INSTALLATION_ID", "ins_untrusted"],
      ["OCC_COMPUTE_DRIVER", "kubernetes"],
      ["OCC_KUBERNETES_CONFIG_PATH", "/tmp/obsolete.json"],
      ["OCC_NATIVE_IAM_DRIVER_ID", "native-iam"],
    ];
    for (const [name, value] of retiredSelectors) {
      await assert.rejects(
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: path, [name]: value },
        }),
        new RegExp(name),
      );
    }

    const injected: InstallationInput = installation();
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
    const refusal = (path: string, code: ErrorDetail["code"], message: string): ErrorDetail[] => [
      { path, code, message },
    ];
    const structural = (
      path: string,
      keyword: string,
      code: ErrorDetail["code"] = "INVALID_VALUE",
    ) => refusal(path, code, `Configuration does not satisfy ${keyword}.`);
    const invalidInstallations: InstallationRefusal[] = [
      [
        (value) => (value.drivers.compute.configuration.apiKey = "plaintext"),
        /plaintext credential/,
      ],
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
          ...refusal(
            "/authentication/context",
            "REQUIRED",
            "This configuration field is required.",
          ),
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
        (value) => {
          const configuration: Partial<Pick<ComputeConfiguration, "runtime">> =
            value.drivers.compute.configuration;
          delete configuration.runtime;
        },
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
        (value) => Object.assign(value.drivers.compute.configuration, { constructor: {} }),
        /contains an unsafe configuration key\.$/,
      ],
      [
        (value) => (value.drivers.compute.configuration.secretRef = "installation-secret"),
        /Installation-scoped secret references cannot be resolved safely\.$/,
      ],
    ];
    for (const [mutate, expected] of invalidInstallations) {
      const configuration: InstallationInput = installation();
      mutate(configuration);
      await assert.rejects(
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
        }),
        (error: unknown) => {
          if (expected instanceof RegExp) {
            assert.ok(error instanceof Error);
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
}
