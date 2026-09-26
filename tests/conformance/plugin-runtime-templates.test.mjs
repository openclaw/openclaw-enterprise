import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { PLUGIN_RUNTIME_TRANSLATOR_SOURCE } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";

const translator = vm.runInNewContext(`(${PLUGIN_RUNTIME_TRANSLATOR_SOURCE})()`);

const nativeId = "fixture@openai-curated-remote";
const selections = {
  [`codex-plugin:${nativeId}`]: {
    enabled: true,
    toolDefaults: { approval: "native", reviewer: "human" },
  },
};
const detail = {
  plugin: {
    summary: { id: nativeId, remotePluginId: "fixture", version: "1.0.0" },
    apps: [{ id: "concrete_app" }],
    skills: [],
    hooks: [],
    mcpServers: [],
  },
};
const templates = [
  {
    templateId: "unconfigured_template",
    name: "Unconfigured app",
    reason: "NOT_CONFIGURED_FOR_WORKSPACE",
    materializedAppIds: [],
  },
  {
    templateId: "workspace_template",
    name: "Workspace app",
    reason: "NO_ACTIVE_WORKSPACE",
    materializedAppIds: [],
  },
  {
    templateId: "materialized_template",
    name: "Materialized app",
    materializedAppIds: ["concrete_app", "template_only_app"],
    reason: null,
  },
];

test("serialized Agent startup ignores template metadata and configures only concrete apps", () => {
  // Template-only IDs must not gain access, even when reported as materialized.
  for (const appTemplates of [templates, undefined, null, "uninterpreted metadata"]) {
    const artifact = translator.codexRuntimeArtifact(selections, [
      { plugin: { ...detail.plugin, appTemplates } },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(artifact.configuration.apps)), {
      _default: { enabled: false },
      concrete_app: {
        enabled: true,
        default_tools_approval_mode: "auto",
        approvals_reviewer: "user",
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(artifact.installs)), [
      {
        pluginId: `codex-plugin:${nativeId}`,
        nativeId,
        remotePluginId: "fixture",
        version: "1.0.0",
        registry: "openai-curated-remote",
      },
    ]);
  }
});

test("serialized Agent startup carries repository broker policy into bridge config", () => {
  const overlay = translator.codexOpenClawConfiguration({}, [], {
    host: "git.openclaw-system.svc",
    port: 443,
    allowMethods: ["POST"],
    domains: { "github.com": "allow" },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(overlay.plugins.entries.codex.config)), {
    appServer: {
      networkProxy: {
        enabled: true,
        mode: "limited",
        allowLocalBinding: false,
        domains: { "github.com": "allow", "git.openclaw-system.svc": "allow" },
        privateEndpoints: [{ host: "git.openclaw-system.svc", port: 443, allowMethods: ["POST"] }],
      },
    },
  });
});

test("serialized Agent startup cannot use templates in place of a concrete app mapping", () => {
  assert.throws(
    () =>
      translator.codexRuntimeArtifact(selections, [
        { plugin: { ...detail.plugin, apps: [], appTemplates: templates } },
      ]),
    /does not expose an app mapping/,
  );
});
