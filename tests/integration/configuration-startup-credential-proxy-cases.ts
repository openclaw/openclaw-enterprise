import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  InstallationFieldError,
  type EgressAuthorityConfiguration,
  type InstallationFieldDetail,
} from "../../apps/controller/src/composition/installation-fields.ts";
import { openShellRepositoryConfiguration } from "../../apps/controller/src/drivers/egress-proxy/openshell-configuration.ts";
import { formatStartupConfigurationFailure } from "../../apps/controller/src/startup-failure.ts";
import type { validateSelectedBackendDrivers as validateBackendSelection } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createCredentialProxyInstallationConfiguration } from "../helpers/installation-driver-configuration.ts";
import type {
  StartupProcessFixtures,
  StartupSiblingWait,
} from "./configuration-startup-resolution-cases.ts";

type ProxyInput = ReturnType<typeof createCredentialProxyInstallationConfiguration>;
type ProxySelection = ProxyInput["drivers"]["credential_proxy"];
type RetiredProxy = string | ProxySelection | null;
type MutableProxyInput = Omit<ProxyInput, "backend" | "drivers"> & {
  backend: [
    Omit<ProxyInput["backend"][0], "drivers"> & {
      drivers: Omit<ProxyInput["backend"][0]["drivers"], "credential_proxy"> & {
        credential_proxy?: string;
        conduit?: RetiredProxy;
      };
    },
  ];
  drivers: Omit<ProxyInput["drivers"], "credential_proxy" | "sandbox"> & {
    credential_proxy?: ProxySelection;
    sandbox?: ProxyInput["drivers"]["sandbox"] & { package?: string };
    conduit?: RetiredProxy;
    repo?: { id: string; configuration: Record<string, never> };
  };
};

type StartupMode = Parameters<typeof loadInstallationConfiguration>[0]["mode"];
type ExpectedFields = readonly (readonly [path: string, code: InstallationFieldDetail["code"]])[];
type DiagnosticDetail = Omit<InstallationFieldDetail, "code"> & { code: string };
type MutableAuthority = { -readonly [K in keyof EgressAuthorityConfiguration]?: unknown };
type StartupDiagnosticSource =
  | { readonly script: string; readonly event: "startup-error" | "worker.startup-error" }
  | { readonly script: string; readonly event: null };

type StartupCredentialProxyFixtures = StartupProcessFixtures & {
  settled: StartupSiblingWait;
};

const api = { script: "apps/controller/src/server.mjs", event: "startup-error" } as const;
const worker = { script: "apps/controller/src/worker.mjs", event: "worker.startup-error" } as const;
const helm = {
  script: "deploy/helm/openclaw-enterprise/files/check-installation.mjs",
  event: null,
} as const;

function credentialProxyFixture() {
  const configuration = createCredentialProxyInstallationConfiguration();
  const proxy = asRecord(asRecord(configuration.drivers)?.credential_proxy);
  const proxyConfiguration = asRecord(proxy?.configuration);
  const authority = asRecord(proxyConfiguration?.authority);
  assert.ok(
    proxy && proxyConfiguration && authority,
    "expected the Credential Proxy authority fixture",
  );
  return { configuration, proxy, proxyConfiguration, authority };
}

function startupEnvironment(path: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };
}

function parseJson(text: string, source: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    assert.fail(`${source} must contain valid JSON`);
  }
}

function isDetail(value: unknown): value is DiagnosticDetail {
  const detail = asRecord(value);
  return (
    typeof detail?.path === "string" &&
    typeof detail.code === "string" &&
    typeof detail.message === "string"
  );
}

function fieldDetails(value: unknown): readonly DiagnosticDetail[] {
  assert.ok(Array.isArray(value), "expected an array of diagnostic fields");
  const details: readonly unknown[] = value;
  assert.ok(details.every(isDetail), "expected path, code, and message in every diagnostic field");
  return details;
}

function expectedRefusal(expected: ExpectedFields, hiddenValues: readonly string[]) {
  return (error: unknown) => {
    // The formatter is what the API, worker and upgrade hook use to omit rejected values.
    const failure = formatStartupConfigurationFailure(error);
    const prefix = "DRIVER_CONFIGURATION_INVALID: ";
    assert.ok(
      failure !== undefined && failure.startsWith(prefix),
      "expected a formatted Driver configuration refusal",
    );
    const details = fieldDetails(parseJson(failure.slice(prefix.length), "Driver refusal"));
    assert.deepEqual(
      details.map(({ path, code }) => [path, code]),
      expected,
    );
    for (const value of hiddenValues) {
      assert.ok(!failure.includes(value), "the refusal must omit rejected values");
    }
    return true;
  };
}

function startupDiagnostic(stderr: string, source: StartupDiagnosticSource) {
  if (source.event === null) {
    const line = stderr.trim();
    const prefix = "installation-check: API and worker startup would refuse the Installation: ";
    assert.ok(line.startsWith(prefix), "the Helm hook must report an Installation refusal");
    const separator = line.indexOf(": ", prefix.length);
    assert.ok(separator > prefix.length, "the Helm hook must emit the failure code");
    return {
      code: line.slice(prefix.length, separator),
      details: fieldDetails(parseJson(line.slice(separator + 2), source.script)),
    };
  }
  const diagnostic = stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => asRecord(parseJson(line, source.script)))
    .find((line) => line?.event === source.event);
  assert.ok(typeof diagnostic?.code === "string", `expected the ${source.event} diagnostic code`);
  return { code: diagnostic.code, details: fieldDetails(diagnostic.details) };
}

export async function checkCredentialProxySelection(
  t: TestContext,
  configuration: ProxyInput,
  path: string,
  load: () => ReturnType<typeof loadInstallationConfiguration>,
  validateSelectedBackendDrivers: typeof validateBackendSelection,
): Promise<void> {
  // This is real startup composition; no gateway connection or listener is started.
  const loaded = await load();
  assert.ok(loaded);
  const { proxyDriver, protectedDriver, sandboxDriver, credentialGatewayDriver } = loaded;
  assert.ok(proxyDriver && protectedDriver && sandboxDriver && credentialGatewayDriver);
  const backend = loaded.installation.backend[0];
  assert.ok(backend?.type === "openshell" && loaded.installation.drivers.credential_proxy);
  assert.equal(proxyDriver.capability, "credential_proxy");
  assert.equal(proxyDriver.id, "openshell-egress");
  assert.equal(loaded.installation.drivers.credential_proxy.id, proxyDriver.id);
  assert.equal(backend.drivers.credential_proxy, proxyDriver.id);
  assert.equal(protectedDriver.require("credential_proxy"), proxyDriver);
  assert.equal(typeof proxyDriver.bindExchange, "function");

  for (const [member, selected] of [
    [true, false],
    [false, true],
    [false, false],
    [true, true],
  ] as const) {
    await t.test(
      `Credential Proxy: Backend member=${member}, Installation selection=${selected}`,
      async () => {
        const candidate: MutableProxyInput = structuredClone(configuration);
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
              sandbox: sandboxDriver,
              credential_gateway: credentialGatewayDriver,
              ...(selected ? { credential_proxy: proxyDriver } : {}),
            },
            protectedDriver,
          );
        if (member !== selected) {
          await assert.rejects(
            load(),
            /credential_proxy must match the selected drivers\.credential_proxy\.id/,
          );
          assert.throws(validateSelection, /Credential Proxy Driver/i);
        } else {
          const selectedDrivers = await load();
          assert.ok(selectedDrivers);
          assert.equal(selectedDrivers.proxyDriver?.id, selected ? proxyDriver.id : undefined);
          validateSelection();
        }
      },
    );
  }

  for (const boundary of ["installation", "backend"]) {
    for (const scenario of ["retired only", "both", "null retired"]) {
      await t.test(`${boundary}: ${scenario}`, async () => {
        const invalid: MutableProxyInput = structuredClone(configuration);
        const drivers = boundary === "installation" ? invalid.drivers : invalid.backend[0].drivers;
        // Even a null retired key must not silently disable or override protection.
        assert.ok(drivers.credential_proxy);
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
  ] as const) {
    await t.test(`retired drivers.repo, Sandbox ${sandbox}`, async () => {
      const invalid: MutableProxyInput = structuredClone(configuration);
      invalid.drivers.repo = { id: "repository-credentials", configuration: {} };
      if (sandbox === "none") {
        delete invalid.drivers.sandbox;
      } else if (sandbox === "package") {
        assert.ok(invalid.drivers.sandbox);
        invalid.drivers.sandbox.package = "@example/installed-sender";
      }
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(load(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^drivers\.repo native admission is retired\./);
        assert.match(error.message, advice);
        return true;
      });
    });
  }
}

export function registerStartupCredentialProxyCases({
  boot,
  fixture,
  productionServer,
  settled,
}: StartupCredentialProxyFixtures): void {
  async function checkBoots(
    entries: readonly { source: StartupDiagnosticSource; env: NodeJS.ProcessEnv }[],
    code: string,
    details: readonly DiagnosticDetail[],
  ): Promise<void> {
    // Join every process before the shared Installation fixture can be removed.
    await settled(
      entries.map(async ({ source, env }) => {
        const result = await boot(source.script, env);
        assert.equal(result.status, 1, `${source.script} must refuse startup`);
        const diagnostic = startupDiagnostic(result.stderr, source);
        assert.equal(diagnostic.code, code, source.script);
        assert.deepEqual(diagnostic.details, details, source.script);
      }),
    );
  }

  test("API and worker name a chart listener mismatch and both values in their startup error", async (t) => {
    // On a fresh install no upgrade check runs, so startup's log is the operator's only clue
    // that the Installation authority is not on the port the chart routes (finding 2213).
    const { configuration, authority } = credentialProxyFixture();
    authority.host = "0.0.0.0";
    const env = {
      ...startupEnvironment(await fixture(t, configuration)),
      OCC_EGRESS_AUTHORITY_PORT: "9555",
      OCC_OPENSHELL_GIT_PORT: "disabled",
    };
    await checkBoots(
      [
        { source: api, env: { ...env, ...productionServer } },
        { source: worker, env },
      ],
      "CHART_LISTENER_MISMATCH",
      [
        {
          path: "/drivers/credential_proxy/configuration/authority/port",
          code: "INVALID_VALUE",
          message:
            "drivers.credential_proxy.configuration.authority.port is 9444, but Helm egressAuthority.port is 9555.",
        },
      ],
    );
  });

  test("an authority block names each refused field and never its value", async (t) => {
    // Finding 2216: nine faults shared one message about "a loopback development listener",
    // and API and worker logs said only STARTUP_FAILED.
    const field = "/drivers/credential_proxy/configuration/authority";
    const sentinel = "sentinel-7c1e";
    type ProxyFixture = ReturnType<typeof credentialProxyFixture>;
    const block =
      (value: unknown) =>
      ({ proxyConfiguration }: ProxyFixture) => {
        proxyConfiguration.authority = value;
      };
    const fieldOf =
      (fields: MutableAuthority) =>
      ({ authority }: ProxyFixture): void => {
        Object.assign(authority, fields);
      };
    const cases: readonly (readonly [
      mode: StartupMode,
      mutate: (fixture: ProxyFixture) => void,
      expected: ExpectedFields,
    ])[] = [
      ["production", block(undefined), [[field, "REQUIRED"]]],
      ["production", block([]), [[field, "INVALID_TYPE"]]],
      // An unknown key is reported at the block: the key itself could be anything.
      [
        "production",
        ({ authority }) => {
          authority[`${sentinel}/~`] = 1;
        },
        [[field, "UNKNOWN_FIELD"]],
      ],
      ["production", fieldOf({ issuer: undefined }), [[`${field}/issuer`, "REQUIRED"]]],
      ["production", fieldOf({ keyId: "" }), [[`${field}/keyId`, "INVALID_VALUE"]]],
      ["production", fieldOf({ audience: 7 }), [[`${field}/audience`, "INVALID_TYPE"]]],
      ["production", fieldOf({ port: undefined }), [[`${field}/port`, "REQUIRED"]]],
      ["production", fieldOf({ port: "9444" }), [[`${field}/port`, "INVALID_TYPE"]]],
      ["production", fieldOf({ port: 65536 }), [[`${field}/port`, "INVALID_RANGE"]]],
      [
        "production",
        fieldOf({
          certificatePath: `${sentinel}.crt`,
          privateKeyPath: `${sentinel}.key`,
          issuerPublicKeyPath: `${sentinel}.pub`,
        }),
        ["certificatePath", "privateKeyPath", "issuerPublicKeyPath"].map(
          (key) => [`${field}/${key}`, "INVALID_FORMAT"] as const,
        ),
      ],
      ["development", fieldOf({ host: "0.0.0.0" }), [[`${field}/host`, "INVALID_VALUE"]]],
    ];
    for (const [mode, mutate, expected] of cases) {
      const input = credentialProxyFixture();
      mutate(input);
      await assert.rejects(
        loadInstallationConfiguration({
          mode,
          environment: { OCC_CONFIG_PATH: await fixture(t, input.configuration) },
        }),
        expectedRefusal(expected, [sentinel, "0.0.0.0", "9444"]),
      );
    }
    // The same field and code reach both processes' startup logs.
    const { configuration, authority } = credentialProxyFixture();
    authority.privateKeyPath = "tls.key";
    const env = startupEnvironment(await fixture(t, configuration));
    await checkBoots(
      [
        { source: api, env: { ...env, ...productionServer } },
        { source: worker, env },
      ],
      "DRIVER_CONFIGURATION_INVALID",
      [
        {
          path: `${field}/privateKeyPath`,
          code: "INVALID_FORMAT",
          message:
            "drivers.credential_proxy.configuration.authority.privateKeyPath must be an absolute mounted-file path.",
        },
      ],
    );
  });
  test("Credential Proxy request capacity keeps today's bounds and refuses each bad field by name", async (t) => {
    const field = "/drivers/credential_proxy/requestCapacity";
    const sentinel = 7_919;
    const withCapacity = async (requestCapacity?: unknown, mode: StartupMode = "development") => {
      const { configuration, proxy } = credentialProxyFixture();
      if (requestCapacity !== undefined) {
        proxy.requestCapacity = requestCapacity;
      }
      const loaded = await loadInstallationConfiguration({
        mode,
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      });
      const capacity = loaded?.installation.credentialProxyCapacity;
      assert.ok(capacity, "startup must load the Credential Proxy capacity");
      return capacity;
    };
    const today = {
      operations: 1024,
      authenticatingOperations: 256,
      sandboxOperations: 256,
      requestIds: 8192,
      sandboxRequestIds: 2048,
    };
    assert.deepEqual(await withCapacity(), today);
    assert.deepEqual(await withCapacity({}), today);
    // An omitted share is a quarter of its configured pool, at least 1; a set share is kept.
    assert.deepEqual(
      await withCapacity({ operations: 64, requestIds: 4096, sandboxRequestIds: 4096 }),
      {
        operations: 64,
        authenticatingOperations: 16,
        sandboxOperations: 16,
        requestIds: 4096,
        sandboxRequestIds: 4096,
      },
    );
    assert.deepEqual(await withCapacity({ operations: 3, requestIds: 1, sandboxOperations: 3 }), {
      operations: 3,
      authenticatingOperations: 1,
      sandboxOperations: 3,
      requestIds: 1,
      sandboxRequestIds: 1,
    });
    assert.deepEqual(
      (
        await withCapacity({
          operations: 8192,
          authenticatingOperations: 8192,
          sandboxOperations: 8192,
          requestIds: 131_072,
          sandboxRequestIds: 131_072,
        })
      ).sandboxRequestIds,
      131_072,
      "the documented maximum is accepted",
    );
    const cases: readonly (readonly [unknown, ExpectedFields])[] = [
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
        {
          [`${sentinel}`]: true,
          operations: 0,
          sandboxRequestIds: "all",
          requestIds: sentinel * 99,
        },
        [
          [field, "UNKNOWN_FIELD"],
          [`${field}/operations`, "INVALID_RANGE"],
          [`${field}/requestIds`, "INVALID_RANGE"],
          [`${field}/sandboxRequestIds`, "INVALID_TYPE"],
        ],
      ],
    ];
    for (const [requestCapacity, expected] of cases) {
      await assert.rejects(
        withCapacity(requestCapacity, "production"),
        expectedRefusal(expected, [
          String(sentinel),
          String(sentinel * 99),
          "1024",
          "8193",
          "4097",
        ]),
      );
    }
    // The startup file loader already refuses any unsafe integer in the Installation.
    await assert.rejects(
      withCapacity({ requestIds: 2 ** 53 }, "production"),
      /requestCapacity\.requestIds must be a safe integer/,
    );
    // API, worker and the chart's upgrade check refuse the same field before any other work.
    const { configuration, proxy } = credentialProxyFixture();
    proxy.requestCapacity = { requestIds: 0 };
    const env = { ...startupEnvironment(await fixture(t, configuration)), ...productionServer };
    await checkBoots(
      [
        { source: api, env },
        { source: worker, env },
        { source: helm, env },
      ],
      "DRIVER_CONFIGURATION_INVALID",
      [
        {
          path: `${field}/requestIds`,
          code: "INVALID_RANGE",
          message: "drivers.credential_proxy.requestCapacity.requestIds must be from 1 to 131072.",
        },
      ],
    );
  });

  test("a repository OpenShell authority refusal names its own block", () => {
    // The Installation and the repository transport share the validator, not the field path.
    const { authority } = credentialProxyFixture();
    delete authority.keyId;
    assert.throws(
      () => openShellRepositoryConfiguration({ registrationName: "git", authority }, "production"),
      (error: unknown) => {
        assert.ok(error instanceof InstallationFieldError);
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
}
