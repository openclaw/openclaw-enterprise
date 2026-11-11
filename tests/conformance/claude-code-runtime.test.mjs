import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  admitGatewaySecurityDefaults,
  agentRuntimeTelemetryEnabled,
} from "../../packages/occ/src/gateway-security-defaults.ts";
import {
  CLAUDE_CODE_RUNTIME_HELPERS,
  GATEWAY_RUNTIME_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// The Gateway entrypoint's Claude Code preparation, run as the generated script runs it: real
// filesystem under a scratch HOME, the `claude --version` child replaced by a recorder. The
// image links /etc/claude-code (Claude Code's admin-managed settings) to HOME's
// .oce-claude-code; `link` stands in for that symlink, the only path outside the scratch HOME.
const VERSION = "2.1.304";
const PROBE_CONFIG = (provider) =>
  JSON.stringify({
    agents: { defaults: { model: "anthropic/claude-sonnet-4-5" } },
    models: { providers: { anthropic: provider } },
  });

function prepare(t, { env, version = `${VERSION} (Claude Code)\n`, status = 0, link }) {
  const home = mkdtempSync(join(tmpdir(), "oce-claude-code-runtime-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const linked = link === undefined ? join(home, ".oce-claude-code") : link;
  const imageFs = {
    ...fs,
    readlinkSync: (path) => {
      if (path !== "/etc/claude-code") return fs.readlinkSync(path);
      if (linked === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return linked;
    },
  };
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return { status, stdout: version, stderr: "" };
  };
  const context = {
    process: { env: { HOME: home, PATH: "/usr/local/bin:/usr/bin", ...env } },
    JSON,
    Object,
  };
  const result = vm.runInNewContext(
    `${CLAUDE_CODE_RUNTIME_HELPERS}\n({ selected: claudeCodeRuntimeSelected(), failure: prepareClaudeCodeRuntime(fs, spawnSync) })`,
    { ...context, fs: imageFs, spawnSync },
  );
  return { ...result, home, calls, env: context.process.env };
}

const managedSettings = (home) => join(home, ".oce-claude-code", "managed-settings.json");

const selectedEnvironment = {
  OPENCLAW_HARNESS_AGENT_RUNTIME: "claude-cli",
  OPENCLAW_HARNESS_PROVIDER: "anthropic",
  OPENCLAW_HARNESS_CREDENTIAL_ENV: "ANTHROPIC_API_KEY",
  ANTHROPIC_API_KEY: "sk-ant-api03-fixture-key",
  OCE_CLAUDE_CODE_VERSION: VERSION,
  OPENCLAW_HARNESS_MODEL: "anthropic/claude-sonnet-4-5",
  OCE_AGENT_RUNTIME_TELEMETRY: "disabled",
  OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({ baseUrl: "https://api.anthropic.com" }),
};

// Settings Claude Code reads that OCE always sets: no self-update or feedback prompts, no extra
// headers or side endpoints.
const ALWAYS = {
  DISABLE_AUTOUPDATER: "1",
  DISABLE_UPDATES: "1",
  DISABLE_INSTALLATION_CHECKS: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  ANTHROPIC_CUSTOM_HEADERS: "",
  CLAUDE_CODE_AUTO_MODE_SERVER: "",
  CLAUDE_CODE_CLIENT_DATA_URL: "",
};
// Telemetry, error reporting and nonessential traffic, off unless the Configuration opts in.
const TELEMETRY_DENIAL = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_GROWTHBOOK: "1",
  DO_NOT_TRACK: "1",
  CLAUDE_CODE_ENABLE_TELEMETRY: "0",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "0",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_LOGS_EXPORTER: "none",
  OTEL_TRACES_EXPORTER: "none",
  OTEL_LOG_USER_PROMPTS: "0",
};
// Every model slot Claude Code fills by itself names the admitted primary model.
const MODEL_SLOTS = Object.fromEntries(
  [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_AUTO_MODE_MODEL",
    "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
  ].map((name) => [name, "claude-sonnet-4-5"]),
);

test("the Gateway entrypoint carries the Claude Code preparation after the model probe", () => {
  assert.ok(GATEWAY_RUNTIME_ENTRYPOINT.includes(CLAUDE_CODE_RUNTIME_HELPERS));
  const probe = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("probeOpenClawAuthenticationFailure();");
  const setup = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("prepareClaudeCodeRuntime(require(");
  const hold = GATEWAY_RUNTIME_ENTRYPOINT.indexOf(
    'holdFailedAuthentication("model-probe", claudeCodeRuntimeFailure);',
  );
  assert.ok(probe > 0 && setup > probe && hold > setup);
  // Preparation only runs once the probe accepted the credential.
  assert.ok(
    GATEWAY_RUNTIME_ENTRYPOINT.includes(
      "openClawAuthenticationFailure === undefined && claudeCodeRuntimeSelected()",
    ),
  );
});

test("the preparation is skipped unless Compute selected the Claude Code runtime", (t) => {
  const { OPENCLAW_HARNESS_AGENT_RUNTIME: _selected, ...rest } = selectedEnvironment;
  assert.equal(prepare(t, { env: rest }).selected, false);
  assert.equal(prepare(t, { env: selectedEnvironment }).selected, true);
});

test("an API key and the default endpoint produce hardened, private managed settings", (t) => {
  const { failure, home, calls, env } = prepare(t, { env: selectedEnvironment });
  assert.equal(failure, undefined);
  const directory = join(home, ".claude");
  assert.equal(env.CLAUDE_CONFIG_DIR, directory);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  // OpenClaw runs agent turns with --setting-sources "", so a user settings file would be
  // ignored; only the admin-managed file reaches Claude Code.
  assert.equal(fs.existsSync(join(directory, "settings.json")), false);
  assert.equal(statSync(join(home, ".oce-claude-code")).mode & 0o777, 0o700);
  assert.equal(statSync(managedSettings(home)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(managedSettings(home), "utf8")), {
    env: {
      ...ALWAYS,
      ...TELEMETRY_DENIAL,
      ...MODEL_SLOTS,
      ANTHROPIC_API_KEY: "sk-ant-api03-fixture-key",
    },
  });
  // The version check ran against the image binary with the prepared directory and without
  // the credential or the probe configuration.
  assert.equal(calls.length, 1);
  // The recorder's arrays come from the script's realm, so compare their contents.
  assert.deepEqual([...calls[0].args], ["--version"]);
  assert.equal(calls[0].command, "claude");
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, directory);
  for (const [name, value] of Object.entries({ ...ALWAYS, ...TELEMETRY_DENIAL })) {
    assert.equal(calls[0].env[name], value, name);
  }
  for (const name of ["ANTHROPIC_API_KEY", "OPENCLAW_HARNESS_PROBE_CONFIG"]) {
    assert.equal(Object.hasOwn(calls[0].env, name), false, name);
  }
});

test("only an explicit telemetry opt-in leaves Claude Code's telemetry on", (t) => {
  const settings = (value) => {
    const env = { ...selectedEnvironment };
    if (value === undefined) {
      delete env.OCE_AGENT_RUNTIME_TELEMETRY;
    } else {
      env.OCE_AGENT_RUNTIME_TELEMETRY = value;
    }
    const { failure, home, calls } = prepare(t, { env });
    assert.equal(failure, undefined);
    // The version check never reports, whatever the opt-in.
    assert.equal(calls[0].env.DISABLE_TELEMETRY, "1");
    return JSON.parse(readFileSync(managedSettings(home), "utf8")).env;
  };
  assert.deepEqual(settings("enabled"), {
    ...ALWAYS,
    ...MODEL_SLOTS,
    ANTHROPIC_API_KEY: "sk-ant-api03-fixture-key",
  });
  // Unset or any other value denies, as when an older controller rendered the Pod.
  for (const value of [undefined, "disabled", "1", "true"]) {
    const env = settings(value);
    for (const [name, denied] of Object.entries(TELEMETRY_DENIAL)) {
      assert.equal(env[name], denied, `${value}: ${name}`);
    }
  }
});

test("a setup token becomes a bearer and a custom endpoint is carried without its trailing slash", (t) => {
  const { failure, home } = prepare(t, {
    env: {
      ...selectedEnvironment,
      ANTHROPIC_API_KEY: " sk-ant-oat01-fixture-setup-token ",
      OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({
        baseUrl: "https://models.example.test/anthropic/",
        api: "anthropic-messages",
      }),
    },
  });
  assert.equal(failure, undefined);
  const { env } = JSON.parse(readFileSync(managedSettings(home), "utf8"));
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-ant-oat01-fixture-setup-token");
  assert.equal(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://models.example.test/anthropic");
});

test("a provider without a configured endpoint leaves Claude Code on its default", (t) => {
  const { failure, home } = prepare(t, {
    env: { ...selectedEnvironment, OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({}) },
  });
  assert.equal(failure, undefined);
  const { env } = JSON.parse(readFileSync(managedSettings(home), "utf8"));
  assert.equal(Object.hasOwn(env, "ANTHROPIC_BASE_URL"), false);
});

test("missing inputs refuse before any file is written", (t) => {
  for (const [name, overrides] of [
    ["version pin", { OCE_CLAUDE_CODE_VERSION: "" }],
    ["credential", { ANTHROPIC_API_KEY: "  " }],
    ["credential name", { OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY" }],
    ["provider", { OPENCLAW_HARNESS_PROVIDER: "openai" }],
    ["primary model", { OPENCLAW_HARNESS_MODEL: "openai/gpt-5.5" }],
    ["empty model", { OPENCLAW_HARNESS_MODEL: "anthropic/" }],
    ["probe configuration", { OPENCLAW_HARNESS_PROBE_CONFIG: "{" }],
    ["endpoint shape", { OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({ baseUrl: 7 }) }],
  ]) {
    const { failure, home, calls, env } = prepare(t, {
      env: { ...selectedEnvironment, ...overrides },
    });
    assert.equal(failure, "NOT_CONFIGURED", name);
    assert.equal(calls.length, 0, name);
    assert.equal(fs.existsSync(managedSettings(home)), false, name);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, name);
  }
});

test("a binary that is missing or not the pinned version holds the Gateway without a settings file", (t) => {
  for (const [name, options] of [
    ["other version", { version: "2.1.300 (Claude Code)\n" }],
    ["failed check", { status: 1 }],
    ["no output", { version: "" }],
  ]) {
    const { failure, home, env } = prepare(t, { env: selectedEnvironment, ...options });
    assert.equal(failure, "UNAVAILABLE", name);
    assert.equal(fs.existsSync(managedSettings(home)), false, name);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, name);
  }
});

test("an image without the managed settings link holds the Gateway without a settings file", (t) => {
  for (const [name, link] of [
    ["missing link", null],
    ["link elsewhere", "/etc/claude-code-elsewhere"],
  ]) {
    const { failure, home, calls, env } = prepare(t, { env: selectedEnvironment, link });
    assert.equal(failure, "UNAVAILABLE", name);
    assert.equal(calls.length, 0, name);
    assert.equal(fs.existsSync(managedSettings(home)), false, name);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, name);
  }
});

test("deployment admission keeps runtime telemetry off unless the Configuration opts in", () => {
  // Admission fills OpenClaw's telemetry.enabled false and keeps an explicit value; Compute
  // renders OCE_AGENT_RUNTIME_TELEMETRY=enabled only from an explicit true.
  assert.deepEqual(admitGatewaySecurityDefaults({}).telemetry, { enabled: false });
  assert.equal(agentRuntimeTelemetryEnabled(admitGatewaySecurityDefaults({})), false);
  const optedIn = admitGatewaySecurityDefaults({ telemetry: { enabled: true } });
  assert.deepEqual(optedIn.telemetry, { enabled: true });
  assert.equal(agentRuntimeTelemetryEnabled(optedIn), true);
  for (const telemetry of [{ enabled: "true" }, { enabled: 1 }, true, null, []]) {
    assert.equal(agentRuntimeTelemetryEnabled({ telemetry }), false, JSON.stringify(telemetry));
  }
});
