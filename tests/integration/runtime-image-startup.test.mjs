import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const execute = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_RUNTIME_IMAGE;
const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_RUNTIME_IMAGE to a locally built OpenClaw runtime image tag.",
      }
    : {};

async function runDocker(args, options = {}) {
  return execute(docker, args, {
    timeout: 20_000,
    maxBuffer: 1_000_000,
    ...options,
  });
}

function commandOutput(error) {
  return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
}

function assertNoPackagingFailure(output) {
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/);
  assert.doesNotMatch(output, /ENOENT: no such file or directory/);
  assert.doesNotMatch(output, /TypeScript .* is not supported in strip-only mode/);
}

async function dockerGatewayEntrypoint() {
  const source = await readFile(
    join("apps", "controller", "src", "drivers", "compute", "docker", "index.ts"),
    "utf8",
  );
  const match = source.match(/const GATEWAY_RUNTIME_ENTRYPOINT = String\.raw`([\s\S]*?)`;/);
  assert.ok(match, "Docker gateway runtime entrypoint must remain discoverable");
  return match[1];
}

async function temporaryGatewayConfiguration(t, harnessId) {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-image-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify(createHarnessConfiguration(harnessId, "gpt-4.1")));
  return path;
}

async function waitForGatewayReady(containerName) {
  let lastReadinessOutput = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
    if (ready !== undefined) return;
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

function assertBundledCodexPluginLoaded(pluginList) {
  const codexPlugin = pluginList.plugins?.find((plugin) => plugin.id === "codex");

  assert.ok(codexPlugin, "Codex plugin must be present in OpenClaw plugin discovery output");
  assert.equal(codexPlugin.origin, "bundled");
  assert.equal(codexPlugin.enabled, true);
  assert.equal(codexPlugin.status, "loaded");
  assert.match(
    codexPlugin.source,
    /\/app\/node_modules\/openclaw\/dist\/extensions\/codex\/dist\/index\.js$/,
  );
  assert.deepEqual(codexPlugin.providerIds, ["codex"]);
  assert.equal(codexPlugin.dependencyStatus?.requiredInstalled, true);
  assert.deepEqual(codexPlugin.dependencyStatus?.missing, []);
}

async function runGatewaySmoke(t, harnessId, options = {}) {
  const {
    configurationPath,
    entrypoint = await dockerGatewayEntrypoint(),
    extraEnvironment = [],
    tmpfs = ["/home/node:size=1024m,uid=1000,gid=1000,mode=700"],
    volumes = [],
  } = options;
  const containerName = `oce-runtime-image-${harnessId}-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

  const configuration = createHarnessConfiguration(harnessId, "gpt-4.1");
  const environment = [
    `OPENCLAW_CONFIG_PATH=${configurationPath ?? "/home/node/.openclaw/openclaw.json"}`,
    ...(configurationPath === undefined
      ? [`OPENCLAW_CONFIG_JSON=${JSON.stringify(configuration)}`]
      : []),
    "OPENCLAW_GATEWAY_PORT=8080",
    "OPENCLAW_GATEWAY_TOKEN=openclaw-runtime-image-smoke-token",
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
    const pluginList = harnessId === "codex" ? await listGatewayPlugins(containerName) : undefined;
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
process.stdout.write(JSON.stringify({ bundledCount: bundled.length }));
`,
  ]);

  assert.ok(JSON.parse(stdout).bundledCount > 0);
}

test(
  "runtime image starts an embedded OpenClaw gateway with the Docker driver entrypoint",
  imageTestOptions,
  async (t) => {
    const { logs } = await runGatewaySmoke(t, "openclaw");

    assert.match(logs, /\[gateway\] ready/);
    assert.match(logs, /agent model: openai\/gpt-4\.1/);
    assertNoPackagingFailure(logs);
  },
);

test(
  "runtime image discovers the bundled Codex plugin from a fresh gateway home",
  imageTestOptions,
  async (t) => {
    const { logs, pluginList } = await runGatewaySmoke(t, "codex");

    assert.match(logs, /\[gateway\] ready/);
    assert.match(logs, /agent model: codex\/gpt-4\.1/);
    assertBundledCodexPluginLoaded(pluginList);
    assertNoPackagingFailure(logs);
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
      extraEnvironment: ["OPENCLAW_WORKSPACE_DIR=/home/node/workspace"],
      tmpfs: [
        "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
        "/home/node/workspace:size=1024m,uid=1000,gid=1000,mode=700",
      ],
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });

    assert.match(logs, /\[gateway\] ready/);
    assert.match(logs, /agent model: codex\/gpt-4\.1/);
    await assertDedicatedRuntimeAssets(containerName);
    assertNoPackagingFailure(logs);
  },
);
