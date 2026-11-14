import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { formatStartupConfigurationFailure } from "../../apps/controller/src/startup-failure.ts";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

type ValidationConfiguration = ReturnType<typeof installation> & {
  observability?: { url: string };
  presets?: unknown;
  sandboxNetworkPolicyCeiling?: unknown;
};
type FieldDetail = { path: string; code: string; message: string };
type DiagnosticCase = [
  (configuration: ValidationConfiguration) => void,
  FieldDetail[],
  { bootProcesses?: boolean }?,
];
type RefusalInput = [label: string, message: RegExp | FieldDetail[], apply: () => void];
type Diagnostic = { code?: unknown; details?: unknown; message?: unknown };
type StartupCaseContext = {
  boot: (
    script: string,
    environment: NodeJS.ProcessEnv,
    timeout?: number,
  ) => Promise<{ status: number | null; stderr: string }>;
  fixture: (context: TestContext, configuration?: ValidationConfiguration) => Promise<string>;
  settled: <const T extends readonly unknown[]>(promises: {
    [K in keyof T]: Promise<T[K]>;
  }) => Promise<T>;
};

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${context} must contain valid JSON`);
  }
}

function startupDiagnostic(stderr: string, event: string): Diagnostic {
  const lines = stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = parseJson(line, "startup log");
      assert.ok(
        value !== null && typeof value === "object" && !Array.isArray(value),
        "startup log must contain JSON records",
      );
      return value as Record<string, unknown>;
    });
  const diagnostic = lines.find((line) => line.event === event);
  assert.ok(diagnostic, `startup log must contain the ${event} event`);
  return diagnostic;
}

function safeBoot(boot: StartupCaseContext["boot"]): StartupCaseContext["boot"] {
  return async (script, environment, timeout) => {
    try {
      return await boot(script, environment, timeout);
    } catch {
      throw new Error(`${script} did not complete startup`);
    }
  };
}

function rejectionMatches(expected: RegExp, context: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(expected.test(String(error)), context);
    return true;
  };
}

export function registerStartupDiagnosticsCases({
  boot: runBoot,
  fixture,
  readFile,
  settled,
}: StartupCaseContext & { readFile: typeof import("node:fs/promises").readFile }): void {
  const boot = safeBoot(runBoot);

  test("API, worker, and Helm hook report safe field diagnostics before persistence", async (t) => {
    const cases: DiagnosticCase[] = [
      // These all passed pair ordering but Kubernetes refuses their negative quantities.
      ...(
        [
          ["gateway", "Gateway"],
          ["agent", "Agent"],
          ["namespace.containerDefaults", "Namespace default"],
        ] as const
      ).map(([role, description]): DiagnosticCase => [
        (configuration) => {
          const resources = configuration.drivers.compute.configuration.resources;
          const selected =
            role === "namespace.containerDefaults"
              ? resources.namespace.containerDefaults
              : resources[role];
          selected.requests.cpu = "-1";
        },
        [
          {
            path: `/resources/${role.replaceAll(".", "/")}/requests/cpu`,
            code: "INVALID_FORMAT",
            message: `${description} CPU requests must be non-negative Kubernetes quantity strings, such as 500m.`,
          },
        ],
        { bootProcesses: role === "gateway" },
      ]),
      [
        (configuration) => {
          Object.assign(configuration.drivers.compute.configuration.authentication, {
            mode: "kubeconfig",
            kubeconfigPath: "/etc/kube/config",
          });
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
        { bootProcesses: true },
      ],
    ];
    // All three entrypoints map a ConfigurationValidationError to the code and its details with
    // the same function. Marked negative-resource and ceiling cases boot them for real.
    // The others reach the loader all three call with the file (production mode) and get that
    // function's one-line diagnostic.
    for (const [mutate, details, { bootProcesses = false } = {}] of cases) {
      const configuration: ValidationConfiguration = installation();
      configuration.occ.cluster = "production-west";
      mutate(configuration);
      const path = await fixture(t, configuration);
      if (!bootProcesses) {
        await assert.rejects(
          loadInstallationConfiguration({
            mode: "production",
            environment: { OCC_CONFIG_PATH: path },
          }),
          (error) => {
            assert.ok(error instanceof ConfigurationValidationError);
            const line = formatStartupConfigurationFailure(error);
            assert.ok(line);
            assert.ok(
              /^DRIVER_CONFIGURATION_INVALID: /.test(line),
              "configuration diagnostic must name the failure code",
            );
            assert.ok(
              isDeepStrictEqual(
                parseJson(
                  line.slice("DRIVER_CONFIGURATION_INVALID: ".length),
                  "configuration diagnostic",
                ),
                details,
              ),
              "configuration diagnostic must contain the expected field details",
            );
            assert.ok(!line.includes(path));
            assert.ok(
              !/Bad_Class|ceiling\.example\.test|\/additions/.test(line),
              "configuration diagnostic must omit input values and Agent paths",
            );
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
        OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.example.test",
      };
      // All three entrypoints reject before persistence. Ceiling errors must name
      // the Installation input, including its array index, rather than the Agent wrapper.
      await settled(
        (
          [
            ["apps/controller/src/server.mjs", "startup-error"],
            ["apps/controller/src/worker.mjs", "worker.startup-error"],
            ["deploy/helm/openclaw-enterprise/files/check-installation.mjs", null],
          ] as const
        ).map(async ([script, event]) => {
          const result = await boot(script, environment, 15_000);
          assert.equal(result.status, 1);
          if (event === null) {
            assert.ok(
              /^installation-check:.*DRIVER_CONFIGURATION_INVALID: /.test(result.stderr),
              "installation check must name the failure code",
            );
          }
          const diagnostic: Diagnostic =
            event === null
              ? {
                  code: "DRIVER_CONFIGURATION_INVALID",
                  details: parseJson(
                    result.stderr
                      .slice(
                        result.stderr.indexOf("DRIVER_CONFIGURATION_INVALID: ") +
                          "DRIVER_CONFIGURATION_INVALID: ".length,
                      )
                      .trim(),
                    "installation check diagnostic",
                  ),
                }
              : startupDiagnostic(result.stderr, event);
          assert.ok(
            diagnostic.code === "DRIVER_CONFIGURATION_INVALID",
            "startup diagnostic must name the failure code",
          );
          assert.ok(
            isDeepStrictEqual(diagnostic.details, details),
            "startup diagnostic must contain the expected field details",
          );
          assert.ok(!result.stderr.includes(path));
          assert.ok(
            !/Bad_Class|ceiling\.example\.test|\/additions|PERSISTENCE_UNAVAILABLE/.test(
              result.stderr,
            ),
            "startup diagnostic must omit input values, Agent paths, and persistence errors",
          );
        }),
      );
    }
  });

  test("API and worker refuse a bad observability host or runtime image before opening PostgreSQL", async (t) => {
    const configuration: ValidationConfiguration = installation();
    configuration.occ.cluster = "production-west";
    const path = await fixture(t, configuration);
    const shared = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: path,
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
    };
    const processes: [string, string, NodeJS.ProcessEnv][] = [
      [
        "apps/controller/src/server.mjs",
        "startup-error",
        {
          ...shared,
          OCC_HOST: "192.0.2.10",
          OCC_PORT: "8080",
          OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
          OCC_AUTH_BASE_URL: "https://console.oce.example.internal",
          OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
        },
      ],
      ["apps/controller/src/worker.mjs", "worker.startup-error", shared],
    ];
    // Each real case boots both processes on its own copy of the file, concurrently.
    const refuses = async (file: string, code: string, label: string) =>
      settled(
        processes.map(async ([script, event, env]) => {
          const result = await boot(script, { ...env, OCC_CONFIG_PATH: file });
          assert.equal(result.status, 1, script);
          assert.ok(!result.stderr.includes(file), "startup log must omit the configuration path");
          const diagnostic = startupDiagnostic(result.stderr, event);
          assert.ok(
            diagnostic.code === code,
            `${script} ${label}: startup diagnostic must name the expected failure code`,
          );
          return diagnostic;
        }),
      );
    // One real pair per refusal message the startup code mappings tell apart: the first input
    // of each family. Its other inputs go through the loader both processes call with the file
    // (production mode) before they open PostgreSQL; the message is what maps to the code.
    const cases: Promise<unknown>[] = [];
    const check = (code: string, inputs: RefusalInput[]) => {
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
                      assert.ok(
                        isDeepStrictEqual(error.error.details, message),
                        `${label}: configuration error must contain the expected field details`,
                      );
                      return true;
                    }
                  : rejectionMatches(
                      message,
                      `${label}: loader rejection must match the expected diagnostic`,
                    ),
                label,
              );
              return;
            }
            for (const diagnostic of await refuses(copy, code, label)) {
              assert.ok(
                diagnostic.message === undefined,
                `${label}: startup diagnostic must omit the loader message`,
              );
              if (Array.isArray(message)) {
                assert.ok(
                  isDeepStrictEqual(diagnostic.details, message),
                  `${label}: startup diagnostic must contain the expected field details`,
                );
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
            port: undefined,
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
    ] satisfies [RegExp, string[]][]) {
      check(
        "OBSERVABILITY_URL_INVALID",
        urls.map((url, index) => [
          `observability.url case ${index + 1}`,
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
    const uppercase = (image: string) =>
      image.replace(
        /^([^/]*\/)(.)/,
        (_: string, host: string, first: string) => host + first.toUpperCase(),
      );
    const dotted = (image: string) => image.replace(/^([^/]*\/)/, "$1re..po/");
    const refusedImage = (
      role: "gateway" | "agent",
      refuse: (image: string) => string,
      message: string,
    ): RefusalInput => [
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
    const corrected: unknown = parseJson(await readFile(path, "utf8"), "corrected configuration");
    assert.ok(
      corrected &&
        typeof corrected === "object" &&
        "occ" in corrected &&
        "observability" in corrected,
    );
    assert.ok(corrected.occ && typeof corrected.occ === "object" && "cluster" in corrected.occ);
    assert.ok(
      corrected.observability &&
        typeof corrected.observability === "object" &&
        "url" in corrected.observability,
    );
    assert.ok(
      corrected.occ.cluster === "production-west",
      "corrected configuration must preserve the cluster",
    );
    assert.ok(
      corrected.observability.url === "http://192.168.1.1",
      "corrected configuration must preserve the observability URL",
    );
  });
}

export function registerStartupPresetCases({
  boot: runBoot,
  fixture,
  PresetFileError,
  productionServer,
  settled,
}: StartupCaseContext & {
  PresetFileError: typeof import("../../apps/controller/src/composition/installation-presets.ts").PresetFileError;
  productionServer: NodeJS.ProcessEnv;
}): void {
  const boot = safeBoot(runBoot);

  test("Installation default Presets are opt-in and reject ambiguous YAML settings", async (t) => {
    for (const presets of [undefined, {}, { includeDefaults: false }]) {
      const configuration: ValidationConfiguration = installation();
      if (presets !== undefined) {
        configuration.presets = presets;
      }
      const loaded = await loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      });
      assert.ok(loaded?.defaultPresets);
      assert.deepEqual(loaded.defaultPresets, []);
    }
    const enabled: ValidationConfiguration = installation();
    enabled.presets = { includeDefaults: true };
    const enabledRuntime = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, enabled) },
    });
    assert.ok(enabledRuntime?.defaultPresets);
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
      const configuration: ValidationConfiguration = installation();
      configuration.presets = presets;
      await assert.rejects(
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
        }),
        rejectionMatches(/presets/, "loader rejection must identify the Presets setting"),
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
    const configuration: ValidationConfiguration = installation();
    configuration.presets = { includeDefaults: true, files: ["presets/codex.json"] };
    const path = await fixture(t, configuration);
    await mkdir(join(dirname(path), "presets"), { recursive: true });
    const presetPath = join(dirname(path), "presets", "codex.json");
    await writeFile(presetPath, JSON.stringify(operatorCodex));
    const runtime = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
    });
    assert.ok(runtime?.defaultPresets);
    assert.deepEqual(runtime.defaultPresets.map((preset) => preset.name).sort(), [
      "Standard Codex",
      "Standard OpenClaw",
      "default-codex",
    ]);
    assert.deepEqual(
      runtime.defaultPresets.find((preset) => preset.name === "default-codex")?.template,
      operatorCodex.template,
    );
    // The resolved path names the file the operator must keep or rename.
    assert.deepEqual(runtime.shadowedDefaultPresets, [
      { presetName: "default-codex", presetFile: presetPath },
    ]);
    // Without includeDefaults nothing is shadowed: the file is an ordinary default.
    configuration.presets = { includeDefaults: false, files: ["presets/codex.json"] };
    await writeFile(path, JSON.stringify(configuration), "utf8");
    const filesOnly = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
    });
    assert.ok(filesOnly?.defaultPresets);
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
    const relativeConfiguration: ValidationConfiguration = installation();
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
    assert.ok(relativeRuntime?.defaultPresets);
    assert.deepEqual(
      relativeRuntime.defaultPresets.map((preset) => preset.name),
      ["from-file"],
    );
    assert.equal(
      relativeRuntime.defaultPresets[0]?.template.agent?.initialWorkspaceFiles?.["AGENTS.md"],
      "# Agent\nName: {{ vars.name }}\n",
    );

    const absoluteConfiguration: ValidationConfiguration = installation();
    const absolutePreset = join(relativeDirectory, "absolute.json");
    absoluteConfiguration.presets = { includeDefaults: false, files: [absolutePreset] };
    await writeFile(absolutePreset, JSON.stringify({ ...validPreset, name: "absolute-file" }));
    const absoluteRuntime = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, absoluteConfiguration) },
    });
    assert.ok(absoluteRuntime?.defaultPresets);
    assert.equal(absoluteRuntime.defaultPresets[0]?.name, "absolute-file");

    // Editors on Windows often save JSON with a UTF-8 byte order mark. Like Driver package
    // manifests and the startup YAML, a Preset file may carry one leading mark.
    const markedConfiguration: ValidationConfiguration = installation();
    const markedPreset = join(relativeDirectory, "marked.json");
    markedConfiguration.presets = { includeDefaults: false, files: [markedPreset] };
    await writeFile(
      markedPreset,
      `\uFEFF${JSON.stringify({ ...validPreset, name: "marked-file" })}`,
    );
    const markedRuntime = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, markedConfiguration) },
    });
    assert.ok(markedRuntime?.defaultPresets);
    assert.equal(markedRuntime.defaultPresets[0]?.name, "marked-file");

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
    ] satisfies [string, string | undefined, RegExp][]) {
      const configuration: ValidationConfiguration = installation();
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
        assert.ok(contents !== undefined);
        await writeFile(join(directory, "cases", "duplicate-b.json"), contents);
      }
      await assert.rejects(
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: path },
        }),
        rejectionMatches(
          expected,
          `${filename}: loader rejection must match the expected diagnostic`,
        ),
      );
    }
  });

  test("API and worker name a Preset file failure in their startup error code", async (t) => {
    // An operator who lists a file the image lacks, or a broken one, needs a cause rather
    // than STARTUP_FAILED. The file path and the loader message stay out of the log.
    const duplicate = JSON.stringify({ name: "twice", template: {} });
    const cases: [string, string | undefined, (string | string[])?][] = [
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
        const configuration: ValidationConfiguration = installation();
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
              assert.ok(error instanceof PresetFileError, filename);
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
        assert.ok(
          apiDiagnostic.code === "PRESET_FILE_INVALID",
          `${filename}: API startup diagnostic must name the Preset file failure`,
        );
        assert.ok(
          apiDiagnostic.message === undefined,
          "API startup diagnostic must omit the loader message",
        );
        assert.ok(
          !server.stderr.includes(dirname(path)),
          "API startup log must omit the Preset path",
        );

        assert.equal(worker.status, 1, filename);
        const workerDiagnostic = startupDiagnostic(worker.stderr, "worker.startup-error");
        assert.ok(
          workerDiagnostic.code === "PRESET_FILE_INVALID",
          `${filename}: worker startup diagnostic must name the Preset file failure`,
        );
        assert.ok(
          workerDiagnostic.message === undefined,
          "worker startup diagnostic must omit the loader message",
        );
        assert.ok(
          !worker.stderr.includes(dirname(path)),
          "worker startup log must omit the Preset path",
        );
      }),
    );
  });
}
