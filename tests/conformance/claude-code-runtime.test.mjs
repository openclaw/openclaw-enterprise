import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  CLAUDE_CODE_RUNTIME_HELPERS,
  GATEWAY_RUNTIME_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// The Gateway entrypoint's Claude Code preparation, run as the generated script runs it: real
// filesystem under a scratch HOME, the `claude --version` child replaced by a recorder.
const VERSION = "2.1.304";
const PROBE_CONFIG = (provider) =>
  JSON.stringify({
    agents: { defaults: { model: "anthropic/claude-sonnet-4-5" } },
    models: { providers: { anthropic: provider } },
  });

function prepare(t, { env, version = `${VERSION} (Claude Code)\n`, status = 0 }) {
  const home = mkdtempSync(join(tmpdir(), "oce-claude-code-runtime-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
    { ...context, fs, spawnSync },
  );
  return { ...result, home, calls, env: context.process.env };
}

const selectedEnvironment = {
  OPENCLAW_HARNESS_AGENT_RUNTIME: "claude-cli",
  OPENCLAW_HARNESS_PROVIDER: "anthropic",
  OPENCLAW_HARNESS_CREDENTIAL_ENV: "ANTHROPIC_API_KEY",
  ANTHROPIC_API_KEY: "sk-ant-api03-fixture-key",
  OCE_CLAUDE_CODE_VERSION: VERSION,
  OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({ baseUrl: "https://api.anthropic.com" }),
};

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

test("an API key and the default endpoint produce a hardened, private settings file", (t) => {
  const { failure, home, calls, env } = prepare(t, { env: selectedEnvironment });
  assert.equal(failure, undefined);
  const directory = join(home, ".claude");
  assert.equal(env.CLAUDE_CONFIG_DIR, directory);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, "settings.json")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")), {
    env: {
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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
  assert.equal(calls[0].env.DISABLE_AUTOUPDATER, "1");
  for (const name of ["ANTHROPIC_API_KEY", "OPENCLAW_HARNESS_PROBE_CONFIG"]) {
    assert.equal(Object.hasOwn(calls[0].env, name), false, name);
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
  const { env } = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-ant-oat01-fixture-setup-token");
  assert.equal(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://models.example.test/anthropic");
});

test("a provider without a configured endpoint leaves Claude Code on its default", (t) => {
  const { failure, home } = prepare(t, {
    env: { ...selectedEnvironment, OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({}) },
  });
  assert.equal(failure, undefined);
  const { env } = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(Object.hasOwn(env, "ANTHROPIC_BASE_URL"), false);
});

test("missing inputs refuse before any file is written", (t) => {
  for (const [name, overrides] of [
    ["version pin", { OCE_CLAUDE_CODE_VERSION: "" }],
    ["credential", { ANTHROPIC_API_KEY: "  " }],
    ["credential name", { OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY" }],
    ["provider", { OPENCLAW_HARNESS_PROVIDER: "openai" }],
    ["probe configuration", { OPENCLAW_HARNESS_PROBE_CONFIG: "{" }],
    ["endpoint shape", { OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({ baseUrl: 7 }) }],
  ]) {
    const { failure, home, calls, env } = prepare(t, {
      env: { ...selectedEnvironment, ...overrides },
    });
    assert.equal(failure, "NOT_CONFIGURED", name);
    assert.equal(calls.length, 0, name);
    assert.equal(fs.existsSync(join(home, ".claude", "settings.json")), false, name);
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
    assert.equal(fs.existsSync(join(home, ".claude", "settings.json")), false, name);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, name);
  }
});
