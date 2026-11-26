import assert from "node:assert/strict";
import test from "node:test";
import type {
  CodexRepositoryBrokerNetworkPolicy,
  PluginRuntimeSpec,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  PLUGIN_RUNTIME_CODEX_CONFIG,
  PLUGIN_RUNTIME_ENVIRONMENT,
  PLUGIN_RUNTIME_MANIFEST,
  pluginRuntimeConfigMapData,
  pluginRuntimeEarlierConfigMapData,
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  codexLinearPluginState,
  codexNoPluginState,
  openClawPluginState,
  parseJson,
  property,
  record,
  required,
  revision,
} from "./plugin-compute-fixtures.ts";
import { runRuntime, runRuntimeHelper } from "./plugin-compute-runtime-helper.ts";

export function registerHarnessRendering(): void {
  test("compute renders plugin-free Codex revisions with native default-deny plugin config", () => {
    const runtime = required(pluginRuntimeSpecForRevision(revision()));
    assert.equal(runtime.kind, "codex");
    assert.deepEqual(runtime.selections, {});

    const data = pluginRuntimeConfigMapData(runtime);
    assert.deepEqual(parseJson(data[PLUGIN_RUNTIME_MANIFEST]), { kind: "codex", selections: {} });
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /^\[features\]\napps = false\nplugins = false\nremote_plugin = false/m,
    );
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /^\[apps\._default\]\nenabled = false/m,
    );
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /^\[plugins\._default\]\nenabled = false/m,
    );
  });

  test("standalone search declarations cannot enable protected provider tools", () => {
    const runtime: PluginRuntimeSpec = {
      kind: "codex",
      selections: {},
      providerTools: "none",
      modelEndpoint: {
        baseUrl: "https://models.example.test/v1",
        modelProvider: "openai-compatible",
        supportsStandaloneWebSearch: true,
      },
    };
    const config = required(pluginRuntimeConfigMapData(runtime)[PLUGIN_RUNTIME_CODEX_CONFIG]);
    assert.match(config, /^web_search = "disabled"$/m);
    assert.equal(config.includes("supports_standalone_web_search"), false);
    assert.match(config, /^request_max_retries = 0$/m);
    assert.match(config, /^stream_max_retries = 0$/m);
  });

  test("compute pins the credential source endpoint in dedicated Codex configuration", () => {
    const baseUrl = "https://models.example.test/api/v1";
    const runtime = required(pluginRuntimeSpecForRevision(revision(), undefined, baseUrl));
    const data = pluginRuntimeConfigMapData(runtime);

    // Provider and approval policy stay at the TOML root; neither belongs to a feature table.
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /^model_provider = "openai-compatible"\n\napproval_policy = "on-request"\n\n\[features\]/,
    );
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /^\[plugins\._default\]\nenabled = false/m,
    );
    assert.deepEqual(property(parseJson(data[PLUGIN_RUNTIME_MANIFEST]), "modelEndpoint"), {
      baseUrl,
      modelProvider: "openai-compatible",
    });
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /\[model_providers\.openai-compatible\][\s\S]*base_url = "https:\/\/models\.example\.test\/api\/v1"[\s\S]*requires_openai_auth = true\nsupports_websockets = false/,
    );
    const environment = parseJson(pluginRuntimeEnvironment(runtime)[PLUGIN_RUNTIME_ENVIRONMENT]);
    assert.equal(
      property(environment, "codexConfigurationToml"),
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
    );
  });

  test("plugin-free revisions apply explicit Slack approvers for configured Slack and keep unrelated approvals", () => {
    const rawSlackApprovers = [
      { channel: "slack", id: "U456" },
      { channel: "slack", id: "W789" },
    ];
    for (const [candidate, expectedApprovers] of [
      [revision({ pluginApprovers: [] }), []],
      [revision({ pluginApprovers: rawSlackApprovers }), ["U456", "W789"]],
      [
        revision({
          harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
          pluginApprovers: rawSlackApprovers,
        }),
        ["U456", "W789"],
      ],
      [
        revision({
          harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
          pluginApprovers: [],
        }),
        [],
      ],
      [
        revision({
          harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
          pluginApprovers: rawSlackApprovers,
        }),
        ["U456", "W789"],
      ],
    ] as const) {
      const runtime = required(pluginRuntimeSpecForRevision(candidate));
      assert.deepEqual(runtime.pluginApprovers, candidate.pluginApprovers);
      assert.deepEqual(parseJson(pluginRuntimeConfigMapData(runtime)[PLUGIN_RUNTIME_MANIFEST]), {
        kind: runtime.kind,
        selections: {},
        pluginApprovers: candidate.pluginApprovers,
      });
      const { files } = runRuntimeHelper({ manifest: required(runtime) }, [], {
        baseConfig: {
          channels: { slack: { enabled: true } },
          approvals: {
            exec: { enabled: true, mode: "session" },
          },
        },
      });
      const config = parseJson(files.get("/home/node/.openclaw/openclaw.json"));
      assert.deepEqual(property(config, "approvals"), {
        exec: { enabled: true, mode: "session" },
        plugin: { slack: { approvers: expectedApprovers } },
      });
    }
  });

  test("plugin-free Codex Gateway applies explicit Agent approvers at launch", async () => {
    const runtime = required(pluginRuntimeSpecForRevision(revision({ pluginApprovers: [] })));
    const { files } = await runRuntime({ manifest: required(runtime) }, [], {
      env: {
        APP_SERVER_URL: "ws://harness.example.test:18790",
        OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: required(runtime) }),
      },
      baseConfig: {
        channels: { slack: { enabled: true } },
        approvals: { exec: { enabled: true, mode: "session" } },
      },
    });
    const config = parseJson(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(property(config, "approvals"), {
      exec: { enabled: true, mode: "session" },
      plugin: { slack: { approvers: [] } },
    });
  });

  test("plugin-free Codex runtime carries broker policy and Slack approvers together", () => {
    const repositoryBrokerNetworkPolicy: CodexRepositoryBrokerNetworkPolicy = {
      host: "git.oce.svc",
      domains: { "github.com": "allow" },
    };
    const runtime = required(
      pluginRuntimeSpecForRevision(
        revision({ pluginApprovers: [] }),
        repositoryBrokerNetworkPolicy,
      ),
    );
    assert.deepEqual(parseJson(pluginRuntimeConfigMapData(runtime)[PLUGIN_RUNTIME_MANIFEST]), {
      kind: "codex",
      selections: {},
      pluginApprovers: [],
      repositoryBrokerNetworkPolicy,
    });
    const { files } = runRuntimeHelper({ manifest: required(runtime) }, [], {
      baseConfig: { channels: { slack: { enabled: true } } },
    });
    const config = parseJson(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(property(config, "approvals", "plugin", "slack", "approvers"), []);
    assert.equal(
      property(
        config,
        "plugins",
        "entries",
        "codex",
        "config",
        "appServer",
        "networkProxy",
        "domains",
        "git.oce.svc",
      ),
      "allow",
    );
  });

  test("compute consumes Codex no-plugin selections from the revision", () => {
    const state = codexNoPluginState();
    const runtime = required(pluginRuntimeSpecForRevision(revision({ plugins: state })));
    assert.equal(runtime.kind, "codex");
    assert.deepEqual(runtime.selections, {});

    const data = pluginRuntimeConfigMapData(runtime);
    assert.deepEqual(parseJson(data[PLUGIN_RUNTIME_MANIFEST]), { kind: "codex", selections: {} });
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /^\[features\]\napps = false\nplugins = false\nremote_plugin = false/m,
    );

    const docker = parseJson(pluginRuntimeEnvironment(runtime)[PLUGIN_RUNTIME_ENVIRONMENT]);
    assert.deepEqual(property(docker, "manifest"), parseJson(data[PLUGIN_RUNTIME_MANIFEST]));
    assert.equal(
      property(docker, "codexConfigurationToml"),
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
    );
  });

  test("compute serializes selected Codex plugins for startup-time resolution", () => {
    const state = codexLinearPluginState({
      toolDefaults: { approval: "provider_default", reviewer: "auto" },
    });
    const runtime = required(pluginRuntimeSpecForRevision(revision({ plugins: state })));

    assert.equal(runtime.kind, "codex");
    assert.deepEqual(runtime.selections, state.plugins);

    const data = pluginRuntimeConfigMapData(runtime);
    // Startup reviewer checks must see the session policy selected by the
    // gateway, before the gateway can start a native thread.
    assert.match(required(data[PLUGIN_RUNTIME_CODEX_CONFIG]), /^approval_policy = "on-request"\n/);
    const manifest = parseJson(data[PLUGIN_RUNTIME_MANIFEST]);
    assert.deepEqual(manifest, {
      kind: "codex",
      selections: state.plugins,
    });
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /^\[features\]\napps = true\nplugins = true\nremote_plugin = true/m,
    );
    assert.match(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /^\[plugins\._default\]\nenabled = false/m,
    );
    assert.doesNotMatch(
      required(data[PLUGIN_RUNTIME_CODEX_CONFIG]),
      /asdk_app_69a089a326dc8191b32a3f2553f5be2c/,
    );
  });

  test("compute serializes selected OpenClaw plugins for startup-time resolution", () => {
    const state = openClawPluginState();
    const runtime = required(
      pluginRuntimeSpecForRevision(
        revision({
          harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
          plugins: state,
        }),
      ),
    );

    assert.deepEqual(runtime.selections, state.plugins);
    const data = pluginRuntimeConfigMapData(runtime);
    assert.deepEqual(Object.keys(data), [PLUGIN_RUNTIME_MANIFEST]);
    assert.deepEqual(parseJson(data[PLUGIN_RUNTIME_MANIFEST]), {
      kind: "openclaw",
      selections: state.plugins,
    });
  });

  test("Codex startup preserves explicit session approval choices and native defaults", () => {
    // Native startup gets the policy the pinned Gateway runs: it runs on-failure as on-request.
    // A reviewer request must never silently upgrade an incompatible session policy to
    // on-request; the native readiness check owns that rejection, and deployment refuses
    // an omitted policy with an automatic reviewer before rendering.
    for (const [policy, native] of [
      ["on-request", "on-request"],
      ["on-failure", "on-request"],
      ["never", "never"],
      [undefined, undefined],
    ] as const) {
      const candidate = revision({ plugins: codexLinearPluginState() });
      record(
        property(candidate.configuration, "plugins", "entries", "codex", "config", "appServer"),
      ).approvalPolicy = policy;
      const runtime = required(pluginRuntimeSpecForRevision(candidate));
      const config = required(pluginRuntimeConfigMapData(runtime)[PLUGIN_RUNTIME_CODEX_CONFIG]);
      if (native === undefined) {
        assert.doesNotMatch(config, /approval_policy/);
      } else {
        assert.ok(config.startsWith(`approval_policy = "${native}"\n\n[features]`), policy);
      }
      // Docker delivers the same file through the environment.
      const delivered = parseJson(pluginRuntimeEnvironment(runtime)[PLUGIN_RUNTIME_ENVIRONMENT]);
      assert.equal(property(delivered, "codexConfigurationToml"), config);
    }
    // Preparation applies admission's rule again (codexApprovalPolicy): a value outside the
    // Gateway's enum, the retired untrusted included, is refused before anything renders.
    const setting = "plugins.entries.codex.config.appServer.approvalPolicy";
    for (const [policy, requirement] of [
      ["invalid", 'must be "never", "on-request" or "on-failure"'],
      [null, 'must be "never", "on-request" or "on-failure"'],
      [
        "untrusted",
        'must not be "untrusted", which the OpenClaw runtime retired: use "on-request"',
      ],
    ] as const) {
      const malformed = revision();
      record(
        property(malformed.configuration, "plugins", "entries", "codex", "config", "appServer"),
      ).approvalPolicy = policy;
      assert.throws(() => pluginRuntimeSpecForRevision(malformed), {
        message: `Configuration setting ${setting} ${requirement}.`,
      });
    }
    const notObject = revision();
    record(property(notObject.configuration, "plugins", "entries", "codex", "config")).appServer =
      "on-request";
    assert.throws(() => pluginRuntimeSpecForRevision(notObject), {
      message: "Configuration setting plugins.entries.codex.config.appServer must be an object.",
    });
    // The Gateway entrypoint replaces a null plugin config, so it sets no policy.
    const nullConfig = revision();
    record(property(nullConfig.configuration, "plugins", "entries", "codex")).config = null;
    assert.doesNotMatch(
      required(
        pluginRuntimeConfigMapData(required(pluginRuntimeSpecForRevision(nullConfig)))[
          PLUGIN_RUNTIME_CODEX_CONFIG
        ],
      ),
      /approval_policy/,
    );
  });

  test("Kubernetes keeps only the exact earlier Codex config of a selected-plugin revision", () => {
    const candidate = revision({ plugins: codexLinearPluginState() });
    const runtime = required(pluginRuntimeSpecForRevision(candidate));
    const current = pluginRuntimeConfigMapData(runtime);
    // The config.toml earlier controllers rendered for a selected-plugin Codex runtime:
    // before #508 without [plugins._default], before #1995 without approval_policy.
    const beforePluginDefaults = `[features]
apps = true
plugins = true
remote_plugin = true

[apps._default]
enabled = false
`;
    const beforeApprovalPolicy = `${beforePluginDefaults}
[plugins._default]
enabled = false
`;
    assert.equal(
      required(current[PLUGIN_RUNTIME_CODEX_CONFIG]),
      `approval_policy = "on-request"\n\n${beforeApprovalPolicy}`,
    );
    // Only config.toml differs; the manifest that carries selections and approvers must match.
    assert.deepEqual(pluginRuntimeEarlierConfigMapData(runtime), [
      { ...current, [PLUGIN_RUNTIME_CODEX_CONFIG]: beforeApprovalPolicy },
      { ...current, [PLUGIN_RUNTIME_CODEX_CONFIG]: beforePluginDefaults },
    ]);
    // #1995 rendered on-failure as written; the Gateway runs it as on-request, which the
    // current rendering carries.
    const onFailure = revision({ plugins: codexLinearPluginState() });
    record(
      property(onFailure.configuration, "plugins", "entries", "codex", "config", "appServer"),
    ).approvalPolicy = "on-failure";
    const onFailureRuntime = required(pluginRuntimeSpecForRevision(onFailure));
    const onFailureCurrent = pluginRuntimeConfigMapData(onFailureRuntime);
    assert.deepEqual(onFailureCurrent, current);
    assert.deepEqual(pluginRuntimeEarlierConfigMapData(onFailureRuntime), [
      {
        ...current,
        [PLUGIN_RUNTIME_CODEX_CONFIG]: `approval_policy = "on-failure"\n\n${beforeApprovalPolicy}`,
      },
      { ...current, [PLUGIN_RUNTIME_CODEX_CONFIG]: beforeApprovalPolicy },
      { ...current, [PLUGIN_RUNTIME_CODEX_CONFIG]: beforePluginDefaults },
    ]);
    // OpenClaw plugin runtimes never had a Codex config, so nothing earlier is accepted.
    const openClaw = revision({
      harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
      plugins: openClawPluginState(),
    });
    assert.deepEqual(
      pluginRuntimeEarlierConfigMapData(required(pluginRuntimeSpecForRevision(openClaw))),
      [],
    );
  });

  test("Codex gateway bridge config writes through the runtime state directory without HOME", () => {
    const state = codexLinearPluginState();
    const runtime = {
      manifest: required(pluginRuntimeSpecForRevision(revision({ plugins: state }))),
    };

    // The production gateway image does not define HOME, so selected Codex plugins must
    // still publish their OpenClaw bridge overlay before the separate agent installs them.
    const { calls, files } = runRuntimeHelper(runtime, [], {
      env: { HOME: undefined, OPENCLAW_STATE_DIR: "/gateway-state/state" },
    });

    assert.deepEqual(calls, []);
    const effective = parseJson(files.get("/gateway-state/state/openclaw.json"));
    assert.equal(
      property(effective, "plugins", "entries", "codex", "config", "codexPlugins", "enabled"),
      true,
    );
    assert.deepEqual(
      property(
        effective,
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
      ),
      {
        enabled: true,
        marketplaceName: "openai-curated-remote",
        pluginName: "linear",
        allow_destructive_actions: "auto",
      },
    );
  });
}
