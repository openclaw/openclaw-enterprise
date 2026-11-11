import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  CLAUDE_CODE_MANAGED_SETTINGS_DIRECTORY,
  CLAUDE_CODE_RUNTIME_HELPERS,
  CLAUDE_CODE_SETTINGS_INIT_ENTRYPOINT,
  CLAUDE_CODE_SETTINGS_INIT_ROOT,
  GATEWAY_RUNTIME_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// Claude Code's admin-managed settings, run as the generated scripts run them on a real
// filesystem: the prepare-claude-code-settings init writes them into a scratch volume, then
// the Gateway entrypoint verifies them, with the `claude --version` child replaced by a
// recorder. The Pod mounts the volume's subPath read-only at /etc/claude-code. A scratch
// directory cannot be mounted here, so `mount` models what the Gateway's kernel reports:
// "ro" lists it read-only in /proc/self/mountinfo and fails writes below it with EROFS, as a
// read-only mount does. The runtime image startup test proves the real mount.
const VERSION = "2.1.304";
const PROBE_CONFIG = (provider) =>
  JSON.stringify({
    agents: { defaults: { model: "anthropic/claude-sonnet-4-5" } },
    models: { providers: { anthropic: provider } },
  });

function run(script, env, globals) {
  const context = { process: { env: { PATH: "/usr/local/bin:/usr/bin", ...env } }, JSON, Object };
  return { result: vm.runInNewContext(script, { ...context, ...globals }), context };
}

function scratch(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    // The init leaves its directory 0500; reopen it so the scratch tree can be removed.
    if (fs.lstatSync(join(directory, "managed"), { throwIfNoEntry: false })?.isDirectory()) {
      chmodSync(join(directory, "managed"), 0o700);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

// The init container's step on a scratch volume root.
function writeSettings(t, env, root = scratch(t, "oce-claude-code-settings-")) {
  const { result } = run(
    `${CLAUDE_CODE_RUNTIME_HELPERS}\nwriteClaudeCodeManagedSettings(fs, ${JSON.stringify(root)})`,
    env,
    { fs },
  );
  return { failure: result, root, directory: join(root, "managed") };
}

// The Gateway's view of the mount: what /proc/self/mountinfo lists and whether the kernel
// refuses writes below it.
function gatewayFs(directory, mount) {
  const rootLine = "22 1 0:21 / / ro,relatime - overlay overlay ro\n";
  const mountinfo =
    mount === "missing"
      ? rootLine
      : `${rootLine}31 22 0:42 /managed ${directory} ${mount === "rw" ? "rw" : "ro"},relatime - tmpfs tmpfs rw\n`;
  const readFileSync = (path, ...rest) =>
    path === "/proc/self/mountinfo" ? mountinfo : fs.readFileSync(path, ...rest);
  if (mount !== "ro") {
    return { ...fs, readFileSync };
  }
  const below = (path) => path === directory || String(path).startsWith(`${directory}/`);
  const readOnly = () => Object.assign(new Error("EROFS"), { code: "EROFS" });
  return {
    ...fs,
    readFileSync,
    accessSync: (path, mode) => {
      if (below(path) && (mode & fs.constants.W_OK) !== 0) {
        throw readOnly();
      }
      return fs.accessSync(path, mode);
    },
    openSync: (path, flags, ...rest) => {
      if (below(path) && flags !== "r") {
        throw readOnly();
      }
      return fs.openSync(path, flags, ...rest);
    },
  };
}

function prepare(
  t,
  { env, gatewayEnv = env, version = `${VERSION} (Claude Code)\n`, status = 0, mount = "ro", tamper },
) {
  const home = scratch(t, "oce-claude-code-runtime-");
  // The private-state init creates the configuration directory before the Gateway starts.
  mkdirSync(join(home, ".claude"), { mode: 0o700 });
  const written = writeSettings(t, env);
  tamper?.(written.directory);
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return { status, stdout: version, stderr: "" };
  };
  const { result, context } = run(
    `${CLAUDE_CODE_RUNTIME_HELPERS}\n({ selected: claudeCodeRuntimeSelected(), failure: verifyClaudeCodeRuntime(fs, spawnSync, ${JSON.stringify(written.directory)}) })`,
    { HOME: home, ...gatewayEnv },
    { fs: gatewayFs(written.directory, mount), spawnSync },
  );
  return { ...result, written, home, calls, env: context.process.env };
}

const managedSettings = (directory) => join(directory, "managed-settings.json");
const readSettings = (directory) => JSON.parse(readFileSync(managedSettings(directory), "utf8"));

// Reopens the init's 0500 directory for a change the Gateway must then refuse.
function reopened(change) {
  return (directory) => {
    chmodSync(directory, 0o700);
    change(directory);
    chmodSync(directory, 0o500);
  };
}

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

test("an init container writes the managed settings and the Gateway verifies them after the model probe", () => {
  assert.ok(CLAUDE_CODE_SETTINGS_INIT_ENTRYPOINT.includes(CLAUDE_CODE_RUNTIME_HELPERS));
  assert.ok(
    CLAUDE_CODE_SETTINGS_INIT_ENTRYPOINT.includes(
      `writeClaudeCodeManagedSettings(require("node:fs"), ${JSON.stringify(CLAUDE_CODE_SETTINGS_INIT_ROOT)})`,
    ),
  );
  assert.ok(GATEWAY_RUNTIME_ENTRYPOINT.includes(CLAUDE_CODE_RUNTIME_HELPERS));
  // The Gateway never writes the settings; it only checks the read-only mount.
  assert.equal(GATEWAY_RUNTIME_ENTRYPOINT.includes("writeClaudeCodeManagedSettings(require("), false);
  const probe = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("probeOpenClawAuthenticationFailure();");
  const check = GATEWAY_RUNTIME_ENTRYPOINT.indexOf(
    `verifyClaudeCodeRuntime(require("node:fs"), require("node:child_process").spawnSync, ${JSON.stringify(CLAUDE_CODE_MANAGED_SETTINGS_DIRECTORY)});`,
  );
  const hold = GATEWAY_RUNTIME_ENTRYPOINT.indexOf(
    'holdFailedAuthentication("model-probe", claudeCodeRuntimeFailure);',
  );
  assert.ok(probe > 0 && check > probe && hold > check);
  assert.ok(
    GATEWAY_RUNTIME_ENTRYPOINT.includes(
      "openClawAuthenticationFailure === undefined && claudeCodeRuntimeSelected()",
    ),
  );
});

test("the check is skipped unless Compute selected the Claude Code runtime", (t) => {
  const { OPENCLAW_HARNESS_AGENT_RUNTIME: _selected, ...rest } = selectedEnvironment;
  assert.equal(prepare(t, { env: rest }).selected, false);
  assert.equal(prepare(t, { env: selectedEnvironment }).selected, true);
});

test("an API key and the default endpoint produce hardened managed settings on a sealed mount", (t) => {
  const { failure, written, home, calls, env } = prepare(t, { env: selectedEnvironment });
  assert.equal(written.failure, undefined);
  assert.equal(failure, undefined);
  const directory = join(home, ".claude");
  assert.equal(env.CLAUDE_CONFIG_DIR, directory);
  // OpenClaw runs agent turns with --setting-sources "", so a user settings file would be
  // ignored; only the admin-managed file reaches Claude Code, and nothing lands in HOME.
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(readdirSync(home), [".claude"]);
  // The volume holds only the file: no managed-settings.d, whose drop-ins would outrank it.
  assert.deepEqual(readdirSync(written.directory), ["managed-settings.json"]);
  assert.equal(statSync(written.directory).mode & 0o777, 0o500);
  assert.equal(statSync(managedSettings(written.directory)).mode & 0o777, 0o400);
  assert.deepEqual(readSettings(written.directory), {
    // Managed hooks run even under OpenClaw's flag-level disableAllHooks; only the managed
    // tier can turn them all off.
    disableAllHooks: true,
    env: {
      ...ALWAYS,
      ...TELEMETRY_DENIAL,
      ...MODEL_SLOTS,
      ANTHROPIC_API_KEY: "sk-ant-api03-fixture-key",
    },
  });
  // The version check ran against the image binary without the credential or the probe
  // configuration.
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
    const { failure, written, calls } = prepare(t, { env });
    assert.equal(failure, undefined);
    // The version check never reports, whatever the opt-in.
    assert.equal(calls[0].env.DISABLE_TELEMETRY, "1");
    return readSettings(written.directory).env;
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
  const { failure, written } = prepare(t, {
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
  const { env } = readSettings(written.directory);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-ant-oat01-fixture-setup-token");
  assert.equal(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://models.example.test/anthropic");
});

test("a provider without a configured endpoint leaves Claude Code on its default", (t) => {
  const { failure, written } = prepare(t, {
    env: { ...selectedEnvironment, OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({}) },
  });
  assert.equal(failure, undefined);
  assert.equal(Object.hasOwn(readSettings(written.directory).env, "ANTHROPIC_BASE_URL"), false);
});

test("missing inputs leave the volume empty and refuse before the version check", (t) => {
  for (const [name, overrides] of [
    ["credential", { ANTHROPIC_API_KEY: "  " }],
    ["credential name", { OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY" }],
    ["provider", { OPENCLAW_HARNESS_PROVIDER: "openai" }],
    ["primary model", { OPENCLAW_HARNESS_MODEL: "openai/gpt-5.5" }],
    ["empty model", { OPENCLAW_HARNESS_MODEL: "anthropic/" }],
    ["probe configuration", { OPENCLAW_HARNESS_PROBE_CONFIG: "{" }],
    ["endpoint shape", { OPENCLAW_HARNESS_PROBE_CONFIG: PROBE_CONFIG({ baseUrl: 7 }) }],
  ]) {
    const { failure, written, calls, env } = prepare(t, {
      env: { ...selectedEnvironment, ...overrides },
    });
    assert.equal(written.failure, "NOT_CONFIGURED", name);
    assert.deepEqual(readdirSync(written.directory), [], name);
    assert.equal(failure, "NOT_CONFIGURED", name);
    assert.equal(calls.length, 0, name);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, name);
  }
  // The version pin is the image's, so only the Gateway checks it.
  const { failure, written, calls } = prepare(t, {
    env: selectedEnvironment,
    gatewayEnv: { ...selectedEnvironment, OCE_CLAUDE_CODE_VERSION: "" },
  });
  assert.equal(written.failure, undefined);
  assert.equal(failure, "NOT_CONFIGURED");
  assert.equal(calls.length, 0);
});

test("a binary that is missing or not the pinned version holds the Gateway", (t) => {
  for (const [name, options] of [
    ["other version", { version: "2.1.300 (Claude Code)\n" }],
    ["failed check", { status: 1 }],
    ["no output", { version: "" }],
  ]) {
    const { failure, env } = prepare(t, { env: selectedEnvironment, ...options });
    assert.equal(failure, "UNAVAILABLE", name);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, name);
  }
});

test("the Gateway refuses managed settings it could change or that are not exactly the admitted ones", (t) => {
  for (const [name, options] of [
    // No mount, or a writable one: the model's tools run as the file's owner.
    ["not a mount", { mount: "missing" }],
    ["writable mount", { mount: "rw" }],
    // The mount table claims read-only but a write succeeds: the write probe decides.
    [
      "writable directory",
      { mount: "unenforced", tamper: (directory) => chmodSync(directory, 0o700) },
    ],
    // A drop-in directory outranks managed-settings.json and would survive restarts.
    [
      "drop-in directory",
      {
        tamper: reopened((directory) => {
          mkdirSync(join(directory, "managed-settings.d"));
          writeFileSync(join(directory, "managed-settings.d", "zz.json"), "{}\n");
        }),
      },
    ],
    [
      "extra file",
      { tamper: reopened((directory) => writeFileSync(join(directory, "CLAUDE.md"), "x\n")) },
    ],
    [
      "symlinked file",
      {
        tamper: reopened((directory) => {
          const target = join(directory, "..", "elsewhere.json");
          writeFileSync(target, readFileSync(managedSettings(directory)));
          rmSync(managedSettings(directory));
          symlinkSync(target, managedSettings(directory));
        }),
      },
    ],
    // Inputs that do not match what the init wrote (here, a telemetry opt-in it never saw).
    [
      "other contents",
      { gatewayEnv: { ...selectedEnvironment, OCE_AGENT_RUNTIME_TELEMETRY: "enabled" } },
    ],
    ["empty volume", { tamper: reopened((directory) => rmSync(managedSettings(directory))) }],
  ]) {
    const { failure, calls, env } = prepare(t, { env: selectedEnvironment, ...options });
    assert.equal(failure, "UNAVAILABLE", name);
    assert.equal(calls.length, 0, name);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, name);
  }
});

test("a rerun of the init clears an earlier run's files and never writes through a symlink", (t) => {
  // A Pod restart reruns the init on the same emptyDir: stale drop-ins and files go, and a
  // later run with incomplete inputs leaves nothing behind.
  const root = scratch(t, "oce-claude-code-settings-");
  const first = writeSettings(t, selectedEnvironment, root);
  assert.equal(first.failure, undefined);
  reopened((directory) => {
    mkdirSync(join(directory, "managed-settings.d"));
    writeFileSync(join(directory, "managed-settings.d", "zz.json"), "{}\n");
  })(first.directory);
  assert.equal(writeSettings(t, selectedEnvironment, root).failure, undefined);
  assert.deepEqual(readdirSync(first.directory), ["managed-settings.json"]);
  const { ANTHROPIC_API_KEY: _credential, ...incomplete } = selectedEnvironment;
  assert.equal(writeSettings(t, incomplete, root).failure, "NOT_CONFIGURED");
  assert.deepEqual(readdirSync(first.directory), []);

  // A file symlink left in the directory is removed, not followed.
  const outside = scratch(t, "oce-claude-code-outside-");
  writeFileSync(join(outside, "target.json"), "kept\n");
  reopened((directory) =>
    symlinkSync(join(outside, "target.json"), managedSettings(directory)),
  )(first.directory);
  assert.equal(writeSettings(t, selectedEnvironment, root).failure, undefined);
  assert.equal(readFileSync(join(outside, "target.json"), "utf8"), "kept\n");
  assert.equal(fs.lstatSync(managedSettings(first.directory)).isFile(), true);

  // A directory symlink in place of the settings directory is refused.
  const linkedRoot = scratch(t, "oce-claude-code-settings-");
  symlinkSync(outside, join(linkedRoot, "managed"));
  assert.equal(writeSettings(t, selectedEnvironment, linkedRoot).failure, "UNAVAILABLE");
  assert.deepEqual(readdirSync(outside), ["target.json"]);
  assert.equal(statSync(outside).mode & 0o777, 0o700);
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
