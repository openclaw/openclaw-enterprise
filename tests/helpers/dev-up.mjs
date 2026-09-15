import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { composeConfigurationProvider } from "./compose.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const serviceKey = "sk-test-secret-value";
const matchingInstallationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const mismatchedInstallationId = "ins_9ce0e58a-415d-485e-90c2-20c3c5572505";
const defaultRuntimeImage = "openclaw-enterprise-runtime:quickstart";
const nodeExecutable = process.execPath;
const bashExecutable = "/bin/bash";

async function writeExecutable(path, body) {
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

function commandPath(name) {
  return spawnSync(bashExecutable, ["-c", `command -v ${name}`], {
    encoding: "utf8",
    env: process.env,
  }).stdout.trim();
}

async function createFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-dev-up-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const bin = join(directory, "bin");
  await mkdir(bin);
  const engine = options.engine ?? "docker";
  const engineLog = join(directory, `${engine}.log`);
  const provider = composeConfigurationProvider();

  if (engine === "podman") {
    for (const command of [
      "bash",
      "cat",
      "chmod",
      "dirname",
      "mktemp",
      "python3",
      "rm",
      "rmdir",
      "sed",
      "sleep",
    ]) {
      const target = commandPath(command);
      assert.ok(target, `${command} must be available for the isolated Podman fixture`);
      await symlink(target, join(bin, command));
    }
    await writeExecutable(
      join(bin, "yq"),
      `#!${nodeExecutable}\nif (process.argv.includes("--version")) {\n  process.stdout.write("yq version v4.53.6\\n");\n} else {\n  process.stdin.pipe(process.stdout);\n}\n`,
    );
  }

  await writeExecutable(
    join(bin, engine),
    `#!${nodeExecutable}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const engine = ${JSON.stringify(engine)};
const podmanJsonConfig = ${JSON.stringify(options.podmanJsonConfig ?? false)};
const podmanDockerApi = ${JSON.stringify(options.podmanDockerApi ?? false)};
const log = process.env.DEV_UP_ENGINE_LOG;
if (log) {
  fs.appendFileSync(log, JSON.stringify({
    args,
    env: {
      OCC_DOCKER_RUNTIME_IMAGE: process.env.OCC_DOCKER_RUNTIME_IMAGE || "",
      OCC_DOCKER_GATEWAY_IMAGE: process.env.OCC_DOCKER_GATEWAY_IMAGE || "",
      OCC_DOCKER_AGENT_IMAGE: process.env.OCC_DOCKER_AGENT_IMAGE || "",
      PODMAN_COMPOSE_PROVIDER: process.env.PODMAN_COMPOSE_PROVIDER || "",
      OCC_CONTAINER_ENGINE_SOCKET: process.env.OCC_CONTAINER_ENGINE_SOCKET || "",
    },
  }) + "\\n");
}
const scenario = process.env.DEV_UP_FAKE_SCENARIO || "success";
const defaultRuntime = ${JSON.stringify(defaultRuntimeImage)};
const installationId = ${JSON.stringify(matchingInstallationId)};
const key = ${JSON.stringify(serviceKey)};
function exit(code, message = "") {
  if (message) process.stderr.write(message + "\\n");
  process.exit(code);
}
function composeCommandIndex() {
  return args.findIndex((arg, index) => index > 0 && ["config", "build", "up", "ps", "cp", "exec"].includes(arg));
}
function delegateComposeConfig() {
  const command = process.env.DEV_UP_REAL_COMPOSE_COMMAND;
  const prefix = JSON.parse(process.env.DEV_UP_REAL_COMPOSE_PREFIX || "[]");
  const format = process.env.DEV_UP_REAL_COMPOSE_FORMAT;
  if (!command || !format) exit(99, "real Compose configuration provider is required");
  const commandIndex = composeCommandIndex();
  const composeArgs = args.slice(1, commandIndex + 1).filter((arg, index, values) => {
    if (arg === "--format") return false;
    return index === 0 || values[index - 1] !== "--format";
  });
  if (format === "json") composeArgs.push("--format", "json");
  const delegated = spawnSync(command, [...prefix, ...composeArgs], {
    cwd: process.env.DEV_UP_REPOSITORY,
    env: {
      ...process.env,
      PATH: process.env.DEV_UP_REAL_PATH || process.env.PATH,
      OPENAI_API_KEY: "",
      OCC_DOCKER_RUNTIME_IMAGE: process.env.OCC_DOCKER_RUNTIME_IMAGE || "",
      OCC_DOCKER_GATEWAY_IMAGE: process.env.OCC_DOCKER_GATEWAY_IMAGE || "",
      OCC_DOCKER_AGENT_IMAGE: process.env.OCC_DOCKER_AGENT_IMAGE || "",
    },
    encoding: "utf8",
  });
  if (delegated.stderr) process.stderr.write(delegated.stderr);
  if (delegated.status !== 0) process.exit(delegated.status ?? 1);
  if (format === "json") {
    process.stdout.write(delegated.stdout);
    process.exit(0);
  }
  const converted = spawnSync(process.env.DEV_UP_REAL_YQ, ["-o=json"], {
    input: delegated.stdout,
    encoding: "utf8",
  });
  if (converted.stdout) process.stdout.write(converted.stdout);
  if (converted.stderr) process.stderr.write(converted.stderr);
  process.exit(converted.status ?? 1);
}
if (args[0] === "--version") exit(0, engine === "podman" ? "podman version 6.1.0" : "Docker version 29.4.0");
if (args[0] === "version") {
  if (engine === "docker") process.stdout.write(${JSON.stringify((options.dockerPlatformName ?? "Docker Engine - Community") + "\n")});
  else if (podmanDockerApi) process.stdout.write("Podman Engine\\n");
  else exit(1);
  exit(0);
}
if (args[0] === "info") {
  if (engine === "podman" && args.includes("{{.DockerRootDir}}")) {
    if (podmanDockerApi) {
      process.stdout.write("/var/lib/containers/storage\\n");
      exit(0);
    }
    exit(1);
  }
  if (engine === "podman") process.stdout.write("unix:///run/user/501/podman/podman.sock\\n");
  else process.stdout.write("29.4.0\\n");
  exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  exit(args[2] === defaultRuntime ? 1 : 0);
}
if (args[0] === "build") exit(0);
if (engine === "podman" && args[0] === "cp") {
  const destination = args[args.length - 1];
  fs.writeFileSync(destination, JSON.stringify({
    data: { id: "key_3033697e-6397-4cc6-9b04-8ec17af78cf1", key },
    meta: { installationId },
  }));
  exit(0);
}
if (args[0] !== "compose") exit(99, "unexpected " + engine + " command: " + args.join(" "));
if (args[1] === "version") exit(0);
const commandIndex = composeCommandIndex();
if (commandIndex === -1) exit(99, "missing compose command");
const command = args[commandIndex];
if (command === "config") {
  if (engine === "podman" && args.includes("--format") && !podmanJsonConfig) {
    exit(2, "podman-compose: error: unrecognized arguments: --format json");
  }
  delegateComposeConfig();
}
if (command === "build") exit(0);
if (command === "up") exit(0);
if (command === "ps") {
  const serviceNames = ["migrate", "bootstrap", "controller", "worker"];
  const requested = serviceNames.includes(args[args.length - 1]) ? [args[args.length - 1]] : serviceNames;
  const entries = requested.map((service) => {
    let serviceState = "running";
    let exitCode = 0;
    let health = "";
    if (service === "migrate" || service === "bootstrap") serviceState = "exited";
    if (service === "bootstrap" && scenario === "bootstrap-failed") exitCode = 1;
    if (service === "controller") health = "healthy";
    if (service === "worker" && scenario === "worker-exited") {
      serviceState = "exited";
      exitCode = 1;
    }
    return {
      Service: service,
      State: serviceState,
      ExitCode: exitCode,
      Health: health,
      Labels: "com.docker.compose.service=" + service,
    };
  });
  if (engine === "podman") {
    process.stdout.write(JSON.stringify(entries.map((entry) => ({
      AutoRemove: false,
      Exited: entry.State !== "running",
      Id: entry.Service + "-container-id",
      Names: ["oce-dev-up-test_" + entry.Service + "_1"],
      State: entry.State,
      Status:
        entry.State === "running"
          ? "Up 5 seconds" + (entry.Health ? " (" + entry.Health + ")" : "")
          : "Exited (" + entry.ExitCode + ") 1 second ago",
      ExitCode: entry.ExitCode,
      Labels: {
        "com.docker.compose.project": "oce-dev-up-test",
        "com.docker.compose.service": entry.Service,
        "io.podman.compose.project": "oce-dev-up-test",
        "io.podman.compose.service": entry.Service,
      },
    }))) + "\\n");
  } else {
    process.stdout.write(entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
  }
  exit(0);
}
if (engine === "docker" && command === "cp") {
  const destination = args[args.length - 1];
  fs.writeFileSync(destination, JSON.stringify({
    data: { id: "key_3033697e-6397-4cc6-9b04-8ec17af78cf1", key },
    meta: { installationId },
  }));
  exit(0);
}
if (command === "exec") {
  exit(
    scenario === "worker-timeout" ? 42 : 0,
    scenario === "worker-timeout" ? "worker marker missing" : "",
  );
}
exit(99, "unhandled " + engine + " compose command: " + command);
`,
  );
  if (engine === "podman" && options.dockerAlias === true) {
    await symlink("podman", join(bin, "docker"));
  }
  if (engine === "podman") {
    await symlink("podman", join(bin, "podman-compose"));
  }
  await writeExecutable(
    join(bin, "curl"),
    `#!${nodeExecutable}
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.DEV_UP_CURL_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args }) + "\\n");
const scenario = process.env.DEV_UP_FAKE_SCENARIO || "success";
const outputIndex = args.indexOf("--output");
const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
let payload;
let status = "200";
let exitCode = 0;
if (scenario === "api-unauthorized") {
  status = "401";
  exitCode = 22;
  payload = { error: { code: "UNAUTHENTICATED", message: "A valid service API key is required." }, meta: { requestId: "req_1" } };
} else {
  payload = {
    data: { id: scenario === "api-mismatch" ? ${JSON.stringify(mismatchedInstallationId)} : ${JSON.stringify(matchingInstallationId)} },
    meta: { requestId: "req_1" },
  };
}
if (output) fs.writeFileSync(output, JSON.stringify(payload));
process.stdout.write(status);
process.exit(exitCode);
`,
  );

  const emptyEnv = join(directory, "empty.env");
  await writeFile(
    emptyEnv,
    [
      "OPENAI_API_KEY=",
      "OCC_DOCKER_RUNTIME_IMAGE=",
      "OCC_DOCKER_GATEWAY_IMAGE=",
      "OCC_DOCKER_AGENT_IMAGE=",
      "",
    ].join("\n"),
  );
  const dockerLog = engine === "docker" ? engineLog : join(directory, "docker.log");
  const podmanLog = engine === "podman" ? engineLog : join(directory, "podman.log");
  const curlLog = join(directory, "curl.log");
  const env = {
    ...process.env,
    PATH: engine === "podman" ? bin : `${bin}${delimiter}${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "",
    OCC_DOCKER_RUNTIME_IMAGE: "",
    OCC_DOCKER_GATEWAY_IMAGE: "",
    OCC_DOCKER_AGENT_IMAGE: "",
    DEV_UP_ENGINE_LOG: engineLog,
    DEV_UP_CURL_LOG: curlLog,
    DEV_UP_FAKE_SCENARIO: options.scenario ?? "success",
    DEV_UP_REAL_COMPOSE_COMMAND: provider.command,
    DEV_UP_REAL_COMPOSE_PREFIX: JSON.stringify(provider.prefix),
    DEV_UP_REAL_COMPOSE_FORMAT: provider.format,
    DEV_UP_REAL_YQ: provider.yq ?? "",
    DEV_UP_REAL_PATH: process.env.PATH ?? "",
    DEV_UP_REPOSITORY: repository,
  };

  return {
    directory,
    emptyEnv,
    dockerLog,
    podmanLog,
    curlLog,
    env,
  };
}

async function writeOverride(fixture, name, lines) {
  const path = join(fixture.directory, name);
  await writeFile(path, [...lines, ""].join("\n"));
  return path;
}

async function customRuntimeOverride(fixture) {
  return writeOverride(fixture, "compose.custom-runtime.yaml", [
    "services:",
    "  worker:",
    "    environment:",
    "      OCC_DOCKER_RUNTIME_IMAGE: custom-runtime:local",
    '      OCC_DOCKER_GATEWAY_IMAGE: ""',
    '      OCC_DOCKER_AGENT_IMAGE: ""',
  ]);
}

async function perImageOverride(fixture) {
  return writeOverride(fixture, "compose.per-image.yaml", [
    "services:",
    "  worker:",
    "    environment:",
    "      OCC_DOCKER_RUNTIME_IMAGE: shared-runtime:local",
    "      OCC_DOCKER_GATEWAY_IMAGE: custom-gateway:local",
    '      OCC_DOCKER_AGENT_IMAGE: ""',
  ]);
}

async function publicControllerOverride(fixture) {
  return writeOverride(fixture, "compose.public-controller.yaml", [
    "services:",
    "  controller:",
    "    ports:",
    '      - "0.0.0.0:3999:3000"',
  ]);
}

function composeOptions(fixture, overridePath) {
  const options = [
    "--env-file",
    fixture.emptyEnv,
    "-f",
    "compose.yaml",
    "--project-name",
    "oce-dev-up-test",
  ];
  if (overridePath) {
    options.splice(4, 0, "-f", overridePath);
  }
  return options;
}

function runDevUp(args, env) {
  return spawnSync(bashExecutable, ["scripts/dev-up", ...args], {
    cwd: repository,
    encoding: "utf8",
    env,
  });
}

async function readJsonLines(path) {
  try {
    const content = await readFile(path, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function composeInvocations(logs) {
  return logs.filter(
    (entry) =>
      entry.args[0] === "compose" &&
      entry.args[1] !== "version" &&
      !entry.args.some((argument) => argument.endsWith("/compose-capability.yaml")),
  );
}

export {
  composeInvocations,
  composeOptions,
  createFixture,
  customRuntimeOverride,
  defaultRuntimeImage,
  matchingInstallationId,
  mismatchedInstallationId,
  perImageOverride,
  publicControllerOverride,
  readJsonLines,
  runDevUp,
  serviceKey,
};
