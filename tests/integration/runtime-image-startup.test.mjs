import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_STOP_TIMEOUT_MS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const execute = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_RUNTIME_IMAGE;
const runtimeImageModel = defaultAgentModel;
const syntheticCodexApiKey = "sk-openclaw-runtime-image-smoke-synthetic";
const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag.",
      }
    : {};

test(
  "runtime image reaps descendants during workspace node and Codex restarts",
  imageTestOptions,
  async (t) => {
    const containerName = `oce-runtime-image-supervisor-${randomBytes(6).toString("hex")}`;
    t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
    // Run the same process proof inside the image, using the production init
    // command. Copy source over argv so this also works with a remote Docker engine.
    const paths = [
      "tests/conformance/workspace-node-supervisor.test.mjs",
      "apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
      "apps/controller/src/drivers/plugin/runtime-translator.ts",
    ];
    const files = await Promise.all(
      paths.map(async (path) => [
        path,
        await readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
      ]),
    );
    const launch = String.raw`
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
for (const [relative, content] of JSON.parse(process.argv[1])) {
  const target = join("/tmp/proof", relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const child = spawnSync(process.execPath, ["--test", "/tmp/proof/tests/conformance/workspace-node-supervisor.test.mjs"], { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`;
    const { stdout } = await runDocker([
      "run",
      "--rm",
      "--name",
      containerName,
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "none",
      "--tmpfs",
      "/tmp:size=64m,mode=1777",
      "--entrypoint",
      "/usr/bin/tini",
      image,
      "-s",
      "--",
      "node",
      "-e",
      launch,
      JSON.stringify(files),
    ]);
    assert.match(stdout, /pass 1/);
    assert.match(stdout, /skipped 0/);
  },
);

test(
  "runtime image initializes the Harness workspace without replacing owner edits",
  imageTestOptions,
  async () => {
    // Run the real Harness entrypoint and native setup. Replace only the long-lived
    // node/Codex bodies: this proves initialization order, not pairing or a model turn.
    const launch = String.raw`
const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const entrypoint = process.argv[1];
const sentinel = "Owner edit that must survive a Harness restart.\n";
for (let attempt = 0; attempt < 4; attempt++) {
  const bootstrap = attempt === 0 ? { skipBootstrap: true } : attempt === 3 ? { skipBootstrap: "invalid" } : {};
  const substitute = [
    'const cp = require("node:child_process");',
    'cp.spawn = () => {',
    'if (!JSON.parse(process.env.OPENCLAW_WORKSPACE_BOOTSTRAP).skipBootstrap) require("node:assert/strict").ok(require("node:fs").readFileSync("/home/node/workspace/AGENTS.md", "utf8").length > 0);',
    'console.log("WORKSPACE_CHILD_STARTED");',
    'return new (require("node:events").EventEmitter)();',
    '};',
    entrypoint,
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", substitute], {
    env: { PATH: process.env.PATH, HOME: "/home/node", OPENCLAW_NODE_STATE_DIR: "/tmp/node-state", OPENCLAW_NODE_SETUP_CODE: "synthetic-setup", OPENCLAW_WORKSPACE_BOOTSTRAP: JSON.stringify(bootstrap) },
    encoding: "utf8",
  });
  if (attempt === 3) {
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /WORKSPACE_CHILD_STARTED/);
    assert.match(result.stderr, /Workspace initialization failed/);
    continue;
  }
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(require("node:fs").readdirSync("/home/node/openclaw-runtime-assets/bundled-skills").length > 0);
  assert.ok(require("node:fs").statSync("/home/node/openclaw-runtime-assets/plugin-skills").isDirectory());
  assert.equal(result.stdout.split("WORKSPACE_CHILD_STARTED").length - 1, 2);
  if (attempt === 0) {
    assert.equal(existsSync("/home/node/workspace/AGENTS.md"), false);
    continue;
  }
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md"]) {
    assert.ok(readFileSync("/home/node/workspace/" + name, "utf8").length > 0);
  }
  if (attempt === 2) assert.equal(readFileSync("/home/node/workspace/AGENTS.md", "utf8"), sentinel);
  writeFileSync("/home/node/workspace/AGENTS.md", sentinel);
}
console.log("WORKSPACE_INITIALIZATION_PASSED");
`;
    const { stdout } = await runDocker(
      [
        "run",
        "--rm",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:size=64m,mode=1777",
        "--tmpfs",
        "/home/node:size=64m,uid=1000,gid=1000",
        "--tmpfs",
        "/home/node/workspace:size=16m,uid=1000,gid=1000",
        "--entrypoint",
        "/usr/bin/tini",
        image,
        "-s",
        "--",
        "node",
        "-e",
        launch,
        AGENT_WITH_NODE_ENTRYPOINT,
      ],
      { timeout: 120_000 * imageSmokeTimeoutMultiplier },
    );
    assert.match(stdout, /WORKSPACE_INITIALIZATION_PASSED/);
  },
);

async function runDocker(args, options = {}) {
  return execute(docker, args, {
    timeout: 60_000 * imageSmokeTimeoutMultiplier,
    maxBuffer: 1_000_000,
    ...options,
  });
}

function commandOutput(error) {
  return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
}

function sanitizeSyntheticCredential(output) {
  return output.replaceAll(syntheticCodexApiKey, "[REDACTED_SYNTHETIC_KEY]");
}

function assertNoPackagingFailure(output) {
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/);
  assert.doesNotMatch(output, /ENOENT: no such file or directory/);
  assert.doesNotMatch(output, /TypeScript .* is not supported in strip-only mode/);
}

async function temporaryGatewayConfiguration(t, harnessId) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify(createAdmittedRuntimeImageConfiguration(harnessId)));
  return path;
}

function createRuntimeImageConfiguration(harnessId, providerModel, options = {}) {
  const configuration = createHarnessConfiguration(harnessId, providerModel);
  if (options.enableSlack !== true) {
    return configuration;
  }

  const plugins = configuration.plugins ?? {};
  const entries = plugins.entries ?? {};
  configuration.plugins = {
    ...plugins,
    allow: [...new Set([...(Array.isArray(plugins.allow) ? plugins.allow : []), "slack"])],
    entries: {
      ...entries,
      slack: {
        ...entries.slack,
        enabled: true,
      },
    },
  };
  configuration.channels = {
    ...configuration.channels,
    slack: {
      ...configuration.channels?.slack,
      enabled: true,
    },
  };

  return configuration;
}

function createAdmittedRuntimeImageConfiguration(harnessId, options = {}) {
  return admitLoggingConfiguration(
    createRuntimeImageConfiguration(harnessId, runtimeImageModel, options),
    "info",
  );
}

async function waitForGatewayReady(containerName) {
  let lastReadinessOutput = "";
  for (let attempt = 0; attempt < 60 * imageSmokeTimeoutMultiplier; attempt += 1) {
    const inspect = await runDocker([
      "inspect",
      containerName,
      "--format",
      "{{.State.Running}} {{.State.ExitCode}}",
    ]);
    const [running, exitCode] = inspect.stdout.trim().split(/\s+/);
    if (running !== "true") {
      throw new Error(`Gateway container exited before readiness with code ${exitCode}.`);
    }

    const ready = await runDocker([
      "exec",
      containerName,
      "node",
      "-e",
      'fetch("http://127.0.0.1:8080/readyz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));',
    ]).catch((error) => {
      lastReadinessOutput = commandOutput(error);
      return undefined;
    });
    if (ready !== undefined) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway readiness timed out.${lastReadinessOutput}`);
}

async function listGatewayPlugins(containerName) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "/app/openclaw.mjs",
    "plugins",
    "list",
    "--json",
  ]);

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`OpenClaw plugin list output was not valid JSON.\n${stdout}`);
  }
}

function jsonLogEntries(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry !== undefined);
}

function gatewayLogDiagnostic(entries) {
  return entries
    .filter((entry) => entry.subsystem === "gateway")
    .map(({ level, message }) => `${level}: ${message}`)
    .slice(-8)
    .join("\n");
}

function assertGatewayLogEntry(entries, predicate, description) {
  assert.ok(
    entries.some(predicate),
    `${description}\nRecent gateway logs:\n${gatewayLogDiagnostic(entries)}`,
  );
}

function assertGatewayReadyLog(entries) {
  assertGatewayLogEntry(
    entries,
    (entry) =>
      entry.subsystem === "gateway" && entry.level === "info" && entry.message === "gateway ready",
    "runtime image must emit gateway ready at native info level",
  );
}

function assertGatewayModelLog(entries, modelReference) {
  assertGatewayLogEntry(
    entries,
    (entry) =>
      entry.subsystem === "gateway" &&
      entry.level === "info" &&
      entry.message.includes(`agent model: ${modelReference}`),
    `runtime image must emit ${modelReference} at native info level`,
  );
}

function assertBundledCodexPluginLoaded(pluginList) {
  const codexPlugin = assertBundledPluginLoaded(pluginList, "codex");
  assert.match(
    codexPlugin.source,
    /\/app\/node_modules\/openclaw\/dist\/extensions\/codex\/index\.js$/,
  );
  assert.equal(codexPlugin.dependencyStatus?.requiredInstalled, true);
  assert.deepEqual(codexPlugin.dependencyStatus?.missing, []);
}

function assertBundledSlackPluginLoaded(pluginList) {
  const slackPlugin = assertBundledPluginLoaded(pluginList, "slack");
  assert.match(
    slackPlugin.source,
    /\/app\/node_modules\/openclaw\/dist\/extensions\/slack\/index\.js$/,
  );
  assert.equal(slackPlugin.dependencyStatus?.requiredInstalled, true);
  assert.deepEqual(slackPlugin.dependencyStatus?.missing, []);
}

function assertBundledPluginLoaded(pluginList, pluginId) {
  const plugin = pluginList.plugins?.find((entry) => entry.id === pluginId);

  assert.ok(plugin, `${pluginId} plugin must be present in OpenClaw plugin discovery output`);
  assert.equal(plugin.origin, "bundled");
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.status, "loaded");
  return plugin;
}

async function assertCodexAppServerHandshake(containerName) {
  const { stdout } = await runDocker(
    [
      "exec",
      containerName,
      "node",
      "--input-type=module",
      "-e",
      `
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pluginDist = "/app/node_modules/openclaw/dist";
const sharedClientChunk = readdirSync(pluginDist).find((name) =>
  /^shared-client-.*\\.mjs$/.test(name)
);
if (sharedClientChunk === undefined) {
  throw new Error("Bundled Codex shared-client chunk was not found under " + pluginDist);
}

const sharedClientExports = await import(pathToFileURL(join(pluginDist, sharedClientChunk)));
const createIsolatedCodexAppServerClient = Object.values(sharedClientExports).find(
  (value) => typeof value === "function" && value.name === "createIsolatedCodexAppServerClient"
);
if (createIsolatedCodexAppServerClient === undefined) {
  throw new Error("Bundled Codex shared-client export did not expose createIsolatedCodexAppServerClient.");
}
const configChunk = readdirSync(pluginDist).find((name) => /^config-options-.*\\.mjs$/.test(name));
if (configChunk === undefined) {
  throw new Error("Bundled Codex config chunk was not found under " + pluginDist);
}
const configExports = await import(pathToFileURL(join(pluginDist, configChunk)));
const createCodexAppServerConfig = Object.values(configExports).find(
  (value) => typeof value === "function" && value.name === "createCodexAppServerConfig"
);
if (createCodexAppServerConfig === undefined) {
  throw new Error("Bundled Codex config export did not expose createCodexAppServerConfig.");
}
const { resolveProviderIdForAuth } = await import("openclaw/plugin-sdk/provider-auth-aliases");
const { resolveCodexAppServerRuntimeOptions } = createCodexAppServerConfig({ resolveProviderIdForAuth });
const versionOutput = execFileSync("codex", ["--version"], { encoding: "utf8" });
const installedVersion = versionOutput.match(/\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
if (installedVersion === undefined) {
  throw new Error("Unable to parse installed Codex version from: " + versionOutput);
}

const agentDir = mkdtempSync(join(tmpdir(), "openclaw-codex-agent-"));
const codexHome = join(agentDir, "codex-home");
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
const runtime = resolveCodexAppServerRuntimeOptions({
  env: {
    OPENCLAW_CODEX_APP_SERVER_BIN: "codex",
    OPENCLAW_CODEX_APP_SERVER_ARGS: "app-server --listen stdio://",
  },
});
const client = await createIsolatedCodexAppServerClient({
  agentDir,
  authProfileId: null,
  timeoutMs: ${10_000 * imageSmokeTimeoutMultiplier},
  startOptions: {
    ...runtime.start,
    env: {
      CODEX_HOME: codexHome,
      HOME: "/home/node",
    },
    clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
  },
});

try {
  const serverVersion = client.getServerVersion();
  if (serverVersion !== installedVersion) {
    throw new Error(
      \`Codex app-server initialized as \${serverVersion}, but codex --version reported \${installedVersion}.\`
    );
  }
  process.stdout.write(JSON.stringify({ installedVersion, serverVersion }));
} finally {
  client.close();
}
`,
    ],
    { timeout: 20_000 * imageSmokeTimeoutMultiplier },
  );

  const result = JSON.parse(stdout);
  assert.equal(result.serverVersion, result.installedVersion);
}

async function runGatewaySmoke(t, harnessId, options = {}) {
  const {
    collectPlugins = harnessId === "codex",
    configuration = createAdmittedRuntimeImageConfiguration(harnessId, {
      enableSlack: harnessId === "openclaw",
    }),
    configurationPath,
    entrypoint = DOCKER_GATEWAY_RUNTIME_ENTRYPOINT,
    extraEnvironment = [],
    tmpfs = ["/home/node:size=1024m,uid=1000,gid=1000,mode=700"],
    volumes = [],
  } = options;
  const containerName = `oce-runtime-image-${harnessId}-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

  const environment = [
    `OPENCLAW_CONFIG_PATH=${configurationPath ?? "/home/node/.openclaw/openclaw.json"}`,
    ...(configurationPath === undefined
      ? [`OPENCLAW_CONFIG_JSON=${JSON.stringify(configuration)}`]
      : []),
    "OPENCLAW_GATEWAY_PORT=8080",
    "OPENCLAW_GATEWAY_PASSWORD=openclaw-runtime-image-smoke-password",
    "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    "APP_SERVER_URL=ws://127.0.0.1:9",
    "APP_SERVER_TOKEN=openclaw-runtime-image-app-server-token",
    "HOME=/home/node",
    ...extraEnvironment,
  ];

  await runDocker(["rm", "-f", containerName]).catch(() => {});
  await runDocker([
    "run",
    "--name",
    containerName,
    "--detach",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...tmpfs.flatMap((value) => ["--tmpfs", value]),
    "--tmpfs",
    "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
    "--network",
    "none",
    ...volumes.flatMap((value) => ["--volume", value]),
    ...environment.flatMap((value) => ["-e", value]),
    "--entrypoint",
    "node",
    image,
    "-e",
    entrypoint,
  ]);

  try {
    await waitForGatewayReady(containerName);
    const pluginList = collectPlugins ? await listGatewayPlugins(containerName) : undefined;
    const logs = await runDocker(["logs", containerName]);
    return {
      containerName,
      logs: `${logs.stdout}\n${logs.stderr}`,
      pluginList,
    };
  } catch (error) {
    const logs = await runDocker(["logs", containerName]).catch((logsError) => logsError);
    throw new Error(`${error.message}\n${commandOutput(logs)}`);
  }
}

async function assertDedicatedRuntimeAssets(containerName) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "-e",
    `
const { lstatSync, readdirSync } = require("node:fs");
const appSkills = lstatSync("/app/skills");
if (!appSkills.isDirectory() || appSkills.isSymbolicLink()) {
  throw new Error("/app/skills must be a real directory in the runtime image.");
}
const bundled = readdirSync("/home/node/openclaw-runtime-assets/bundled-skills");
if (bundled.length === 0) {
  throw new Error("Kubernetes gateway entrypoint did not publish bundled skills.");
}
const plugin = lstatSync("/home/node/openclaw-runtime-assets/plugin-skills");
	if (!plugin.isDirectory()) {
	  throw new Error("Kubernetes gateway entrypoint did not publish plugin skills directory.");
	}
	const slack = lstatSync("/home/node/openclaw-runtime-assets/plugin-skills/slack/SKILL.md");
	if (!slack.isFile()) {
	  throw new Error("Kubernetes gateway entrypoint did not publish Slack plugin skills.");
	}
	process.stdout.write(JSON.stringify({ bundledCount: bundled.length, slackSkill: true }));
	`,
  ]);

  assert.ok(JSON.parse(stdout).bundledCount > 0);
}

test(
  "runtime image applies Dedicated repository policy to native Codex command execution",
  imageTestOptions,
  async () => {
    // Substitute only authentication results and the app-server transport. The emitted
    // startup computes native settings; the image's actual Codex executes the shell.
    // Docker supplies isolation; this offline check proves no model turn or provider access.
    const probe = `
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const vm = require("node:vm");
const fs = require("node:fs");
const { createInterface } = require("node:readline");
const environment = {
  PATH: "/opt/oce/repository-credentials/bin:" + process.env.PATH,
  HOME: "/home/node", CODEX_HOME: "/home/node/.codex",
  CODEX_LOGIN_MODE: "api_key", OPENAI_API_KEY: "synthetic-offline-key",
  OPENCLAW_HARNESS_MODEL: "codex/gpt-5",
  APP_SERVER_TOKEN: "synthetic-transport-token", APP_SERVER_PORT: "4500",
};
let native;
vm.runInNewContext(${JSON.stringify(AGENT_RUNTIME_ENTRYPOINT)}, {
  URL, console, setTimeout, setInterval,
  process: { env: environment, on() {}, exit() {} },
  require(name) {
    if (name !== "node:child_process") return require(name);
    return {
      spawnSync(_command, args) {
        return args.includes("login") ? { status: 0 } : {
          status: 0,
          stdout: [
            { type: "turn.started" },
            { type: "item.completed", item: { type: "agent_message", text: "READY" } },
            { type: "turn.completed" },
          ].map(JSON.stringify).join("\\n"),
        };
      },
      spawn(command, args, options) {
        const appServer = args.indexOf("app-server");
        assert.ok(appServer > 0);
        native = cp.spawn(command, [...args.slice(0, appServer + 1), "--listen", "stdio://"], {
          ...options, env: environment, stdio: ["pipe", "pipe", "pipe"],
        });
        return native;
      },
    };
  },
});
assert.ok(native);
const pending = new Map();
let nextId = 1;
const lines = createInterface({ input: native.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
});
native.stderr.resume();
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  native.stdin.write(JSON.stringify({ id, method, params }) + "\\n");
});
const timeout = setTimeout(() => { native.kill("SIGKILL"); process.exitCode = 1; }, 20000);
(async () => {
  try {
    await rpc("initialize", { clientInfo: { name: "repository-runtime-smoke", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    native.stdin.write(JSON.stringify({ method: "initialized" }) + "\\n");
    const { config } = await rpc("config/read", {});
    assert.equal(config.allow_login_shell, false);
    assert.equal(config.shell_environment_policy.set.PATH, environment.PATH);
    const result = await rpc("command/exec", {
      command: ["/bin/bash", "-c", "command -v gh; command -v git; git config --system --get-all include.path"],
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout.trim().split("\\n"), [
      "/opt/oce/repository-credentials/bin/gh", "/usr/bin/git", "/run/oce/repository-credentials/gitconfig",
    ]);
    fs.accessSync("/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/router.js");
    process.stdout.write("native-repository-shell-ready\\n");
  } finally {
    clearTimeout(timeout);
    lines.close();
    native.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
    const { stdout } = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/home/node:size=128m,uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
      "--entrypoint",
      "node",
      image,
      "-e",
      probe,
    ]);
    assert.match(stdout, /native-repository-shell-ready/);
  },
);

test(
  "runtime image gateway ignores inherited OPENCLAW_LOG_LEVEL in favor of native configuration",
  imageTestOptions,
  async (t) => {
    const configuration = createAdmittedRuntimeImageConfiguration("openclaw", {
      enableSlack: true,
    });

    const { logs } = await runGatewaySmoke(t, "openclaw", {
      collectPlugins: false,
      configuration,
      extraEnvironment: ["OPENCLAW_LOG_LEVEL=error"],
    });

    const entries = jsonLogEntries(logs);
    assertGatewayReadyLog(entries);
    assertGatewayModelLog(entries, `openai/${runtimeImageModel}`);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image starts an embedded OpenClaw gateway with the Docker driver entrypoint",
  imageTestOptions,
  async (t) => {
    const { logs, pluginList } = await runGatewaySmoke(t, "openclaw", {
      collectPlugins: true,
      configuration: createAdmittedRuntimeImageConfiguration("openclaw", {
        enableSlack: true,
      }),
    });

    const entries = jsonLogEntries(logs);
    assertGatewayReadyLog(entries);
    assertGatewayModelLog(entries, `openai/${runtimeImageModel}`);
    assertBundledSlackPluginLoaded(pluginList);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image discovers the bundled Codex plugin from a fresh gateway home",
  imageTestOptions,
  async (t) => {
    const { logs, containerName, pluginList } = await runGatewaySmoke(t, "codex");

    const entries = jsonLogEntries(logs);
    assertGatewayReadyLog(entries);
    assertGatewayModelLog(entries, `codex/${runtimeImageModel}`);
    assertBundledCodexPluginLoaded(pluginList);
    await assertCodexAppServerHandshake(containerName);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image keeps Codex auth writable with a nested generated images mount",
  imageTestOptions,
  async (t) => {
    const containerName = `oce-runtime-image-codex-auth-${randomBytes(6).toString("hex")}`;
    t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

    const probe = String.raw`
set -eu
printf "%s\n" "$SYNTHETIC_CODEX_API_KEY" | timeout ${20 * imageSmokeTimeoutMultiplier}s codex login --with-api-key >/tmp/codex-login.stdout 2>/tmp/codex-login.stderr || {
  sed -E "s/sk-[A-Za-z0-9_-]+/[REDACTED_SYNTHETIC_KEY]/g" /tmp/codex-login.stderr >&2
  exit 1
}
node - <<'NODE'
const { accessSync, constants, statSync } = require("node:fs");
function entry(path) {
  const stat = statSync(path);
  return {
    uid: stat.uid,
    gid: stat.gid,
    mode: (stat.mode & 0o777).toString(8),
    directory: stat.isDirectory(),
    file: stat.isFile(),
  };
}
accessSync("/home/node/.codex", constants.W_OK);
accessSync("/home/node/.codex/generated_images", constants.W_OK);
process.stdout.write(JSON.stringify({
  uid: process.getuid(),
  gid: process.getgid(),
  codexHome: entry("/home/node/.codex"),
  generatedImages: entry("/home/node/.codex/generated_images"),
  authJson: entry("/home/node/.codex/auth.json"),
}));
NODE
`;

    const { stdout } = await runDocker(
      [
        "run",
        "--rm",
        "--name",
        containerName,
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/home/node/.codex/generated_images:size=64m,uid=1000,gid=1000,mode=700",
        "--tmpfs",
        "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
        "--network",
        "none",
        "-e",
        "HOME=/home/node",
        "-e",
        "CODEX_HOME=/home/node/.codex",
        "-e",
        `SYNTHETIC_CODEX_API_KEY=${syntheticCodexApiKey}`,
        "--entrypoint",
        "sh",
        image,
        "-c",
        probe,
      ],
      { timeout: 30_000 * imageSmokeTimeoutMultiplier },
    ).catch((error) => {
      throw new Error(sanitizeSyntheticCredential(commandOutput(error)));
    });

    const result = JSON.parse(stdout);
    assert.equal(result.uid, 1000);
    assert.equal(result.gid, 1000);
    assert.deepEqual(result.codexHome, {
      uid: 1000,
      gid: 1000,
      mode: "700",
      directory: true,
      file: false,
    });
    assert.deepEqual(result.generatedImages, {
      uid: 1000,
      gid: 1000,
      mode: "700",
      directory: true,
      file: false,
    });
    assert.deepEqual(result.authJson, {
      uid: 1000,
      gid: 1000,
      mode: "600",
      directory: false,
      file: true,
    });
  },
);

test(
  "runtime image publishes dedicated assets with the Kubernetes gateway entrypoint",
  imageTestOptions,
  async (t) => {
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { logs, containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      extraEnvironment: ["OPENCLAW_WORKSPACE_DIR=/home/node/workspace", "OPENCLAW_LOG_LEVEL=error"],
      tmpfs: [
        "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
        "/home/node/workspace:size=1024m,uid=1000,gid=1000,mode=700",
      ],
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });

    const entries = jsonLogEntries(logs);
    assertGatewayReadyLog(entries);
    assertGatewayModelLog(entries, `codex/${runtimeImageModel}`);
    await assertDedicatedRuntimeAssets(containerName);
    const { stdout } = await runDocker([
      "exec",
      containerName,
      "node",
      "--input-type=module",
      "-e",
      'import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "/app/node_modules/openclaw/gateway-shutdown-budget.mjs"; console.log(GATEWAY_SERVICE_STOP_TIMEOUT_MS);',
    ]);
    const runtimeStopTimeoutMs = Number(stdout.trim());
    assert.ok(runtimeStopTimeoutMs > 0 && runtimeStopTimeoutMs <= GATEWAY_STOP_TIMEOUT_MS);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image enrolls the restricted workspace node and reconnects with saved credentials",
  imageTestOptions,
  async (t) => {
    // The Kubernetes entrypoint admits the workspace command grant before pairing.
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-workspace-node.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      ["exec", containerName, "node", "--input-type=module", "-e", source],
      { timeout: 240_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.sameIdentityAfterRestart, true);
    assert.equal(result.singleBootstrapCompletion, true);
    assert.equal(result.commands.length, 7);
  },
);

test(
  "runtime image shares Codex 0.156.0 between the plugin and Dedicated command",
  imageTestOptions,
  async () => {
    const script = String.raw`
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { realpathSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const plugin = createRequire("/app/dist/extensions/codex/package.json");
const installed = plugin.resolve("@openai/codex/package.json");
assert.equal(JSON.parse(readFileSync(installed, "utf8")).version, "0.156.0");
const bundledCommand = plugin.resolve("@openai/codex/bin/codex.js");
assert.equal(realpathSync("/app/node_modules/.bin/codex"), realpathSync(bundledCommand));
assert.equal(execFileSync("codex", ["--version"], {encoding: "utf8"}).trim(), "codex-cli 0.156.0");
assert.equal(execFileSync(process.execPath, [bundledCommand, "--version"], {encoding: "utf8"}).trim(), "codex-cli 0.156.0");
const provenance = JSON.parse(readFileSync("/opt/oce/runtime/provenance.json", "utf8"));
assert.equal(provenance.codexVersion, "0.156.0");
assert.equal(require("node:crypto").createHash("sha256").update(readFileSync("/opt/oce/runtime/contents.json")).digest("hex"), provenance.runtimeContentsSha256);
process.stdout.write("shared-codex-0.156.0-ready\n");
`;
    const { stdout } = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      image,
      "-e",
      script,
    ]);
    assert.match(stdout, /shared-codex-0.156.0-ready/);
  },
);
