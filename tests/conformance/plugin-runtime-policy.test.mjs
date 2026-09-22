import assert from "node:assert/strict";
import test from "node:test";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";

const OCC_DIFFS_DIGEST =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

function openClawRuntime(selection = {}) {
  return {
    manifest: {
      kind: "openclaw",
      selections: { "occ-plugin:diffs": { enabled: true, approvalMode: "always", ...selection } },
    },
  };
}

function installedPluginResponses() {
  return [
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
    {
      status: 0,
      stdout: JSON.stringify({
        plugin: {
          id: "diffs",
          version: "2026.8.2",
          rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
        },
        install: {
          source: "npm",
          resolvedName: "@openclaw/diffs",
          resolvedVersion: "2026.8.2",
          installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
          integrity: OCC_DIFFS_DIGEST,
        },
      }),
      stderr: "",
    },
  ];
}

test("OpenClaw runtime helper installs exact admitted package pins and verifies the install record", async () => {
  const runtime = openClawRuntime();
  const firstInstallConfig = { path: undefined, config: undefined };
  const { calls, files } = runOpenClawRuntimeHelper(runtime, installedPluginResponses(), {
    beforeSpawn(command, args, sandbox) {
      if (command === "node" && args[1] === "plugins" && args[2] === "install") {
        firstInstallConfig.path = sandbox.process.env.OPENCLAW_CONFIG_PATH;
        firstInstallConfig.config = JSON.parse(sandbox.files.get(firstInstallConfig.path));
      }
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(calls.map((call) => call.args))), [
    [
      "/app/openclaw.mjs",
      "plugins",
      "install",
      "@openclaw/diffs@2026.8.2",
      "--pin",
      "--force",
      "--no-enable",
    ],
    ["/app/openclaw.mjs", "plugins", "registry", "--refresh", "--json"],
    ["/app/openclaw.mjs", "plugins", "inspect", "diffs", "--json"],
  ]);
  assert.equal(firstInstallConfig.path, "/home/node/.openclaw/openclaw.json");
  assert.deepEqual(firstInstallConfig.config.plugins.entries, { diffs: { enabled: true } });
  assert.deepEqual(firstInstallConfig.config.tools.alsoAllow, ["existing-tool", "diffs"]);

  const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
  assert.equal(effective.gateway.port, 8080);
  assert.deepEqual(effective.plugins.installs.keep, { source: "npm" });
  assert.deepEqual(effective.plugins.load.paths, ["existing"]);
  assert.deepEqual(effective.plugins.entries, { diffs: { enabled: true } });
  assert.deepEqual(effective.tools.alsoAllow, ["existing-tool", "diffs"]);
});

for (const [name, tools] of [
  ["profile grants", { alsoAllow: ["existing-tool"] }],
  ["explicit allowlist", { allow: ["read"] }],
  ["operator plugin grant", { allow: ["diffs"] }],
]) {
  test(`OpenClaw runtime helper reports install warnings and preserves ${name}`, () => {
    const runtime = openClawRuntime();
    const result = runOpenClawRuntimeHelper(
      runtime,
      [{ status: 1, stdout: "", stderr: "native install failed" }],
      {
        baseConfig: { tools },
        env: {
          OPENCLAW_PLUGIN_STATUS_PORT: "18791",
          OPENCLAW_AGENT_REVISION_ID: "revision-plugin-compute-1",
          OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
        },
      },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), {
      successfulPluginIds: [],
      failures: [{ pluginId: "occ-plugin:diffs", code: "PLUGIN_INSTALL_FAILED" }],
    });
    assert.equal(result.calls.length, 1);
    const effective = JSON.parse(result.files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(effective.plugins.entries, { diffs: { enabled: false } });
    // Remove only startup's generated grant; emptying an operator allowlist would widen access.
    assert.deepEqual(effective.tools, tools);
  });
}

test("OpenClaw runtime helper fails before readiness when raw Codex bridge config conflicts", () => {
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": { enabled: true, approvalMode: "auto" },
      },
    },
  };

  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [], {
        baseConfig: {
          gateway: { port: 8080 },
          plugins: {
            entries: {
              codex: {
                config: {
                  codexPlugins: {
                    enabled: true,
                    allow_all_plugins: false,
                    plugins: { google_calendar: { enabled: true } },
                  },
                },
              },
            },
          },
        },
      }),
    /Codex bridge configuration conflicts/,
  );
});

test("OpenClaw runtime helper fails before readiness when installed metadata drifts", async () => {
  const runtime = openClawRuntime();
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [
        { status: 0, stdout: "", stderr: "" },
        { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
        {
          status: 0,
          stdout: JSON.stringify({
            plugin: {
              id: "diffs",
              version: "2026.8.2",
              rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
            },
            install: {
              source: "npm",
              resolvedName: "@openclaw/diffs",
              resolvedVersion: "2026.8.3",
              installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
              integrity: OCC_DIFFS_DIGEST,
            },
          }),
          stderr: "",
        },
      ]),
    /installed version does not match/,
  );
});

test("OpenClaw runtime helper fails before readiness when bundled metadata shadows the install", async () => {
  const runtime = openClawRuntime();
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [
        { status: 0, stdout: "", stderr: "" },
        { status: 0, stdout: JSON.stringify({ refreshed: true }), stderr: "" },
        {
          status: 0,
          stdout: JSON.stringify({
            plugin: {
              id: "diffs",
              version: "2026.8.2",
              rootDir: "/app/plugin-skills/diffs",
            },
            install: {
              source: "npm",
              resolvedName: "@openclaw/diffs",
              resolvedVersion: "2026.8.2",
              installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
              integrity: OCC_DIFFS_DIGEST,
            },
          }),
          stderr: "",
        },
      ]),
    /runtime root directory does not resolve inside the admitted install path/,
  );
});

for (const [name, tools, expected] of [
  [
    "explicit allowlist",
    { allow: ["read"], deny: ["exec"] },
    { allow: ["read", "diffs"], deny: ["exec"] },
  ],
  [
    "profile grants",
    { profile: "coding", alsoAllow: ["existing-tool"], deny: ["exec"] },
    { profile: "coding", alsoAllow: ["existing-tool", "diffs"], deny: ["exec"] },
  ],
  ["existing grant", { allow: ["read", "diffs"] }, { allow: ["read", "diffs"] }],
  ["empty allowlist", { allow: [] }, { allow: [], alsoAllow: ["diffs"] }],
]) {
  test(`OpenClaw startup composes plugin grants with ${name}`, () => {
    const { files } = runOpenClawRuntimeHelper(openClawRuntime(), installedPluginResponses(), {
      baseConfig: { tools },
    });
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(effective.tools, expected);
  });
}

for (const [field, plugins] of [
  ["plugins.enabled", { enabled: false }],
  ["plugins.deny", { deny: ["diffs"] }],
  ["plugins.allow", { allow: ["memory-core"] }],
  ["plugins.deny", { deny: [" Diffs "] }],
]) {
  test(`OpenClaw startup rejects blocked selection before installation: ${JSON.stringify(plugins)}`, () => {
    const calls = [];
    assert.throws(
      () =>
        runOpenClawRuntimeHelper(openClawRuntime(), installedPluginResponses(), {
          calls,
          baseConfig: { plugins },
        }),
      (error) =>
        error.message.includes("OpenClaw plugin configuration conflicts") &&
        error.message.includes(field),
    );
    assert.equal(calls.length, 0);
  });
}

for (const selection of [{ enabled: false }, { approvalMode: "never" }]) {
  test(`OpenClaw startup preserves restrictions for disabled selection: ${JSON.stringify(selection)}`, () => {
    const plugins = { allow: ["memory-core"], deny: ["diffs"], enabled: false };
    const { files, calls } = runOpenClawRuntimeHelper(
      openClawRuntime(selection),
      installedPluginResponses(),
      {
        baseConfig: { plugins },
      },
    );
    const effective = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"));
    assert.deepEqual(effective.plugins, { ...plugins, entries: { diffs: { enabled: false } } });
    assert.ok(calls[0].args.includes("--no-enable"));
  });
}

test("OpenClaw startup rejects a blocked Codex bridge before readiness", () => {
  const runtime = {
    manifest: {
      kind: "codex",
      selections: {
        "codex-plugin:linear@openai-curated-remote": { enabled: true, approvalMode: "auto" },
      },
    },
  };
  const calls = [];
  assert.throws(
    () =>
      runOpenClawRuntimeHelper(runtime, [], {
        calls,
        baseConfig: { plugins: { deny: ["codex"] } },
      }),
    /OpenClaw plugin configuration conflicts.*codex.*plugins.deny/,
  );
  assert.equal(calls.length, 0);
});
