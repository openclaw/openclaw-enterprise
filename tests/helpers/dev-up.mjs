import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

import { commandPath, composeConfigurationProvider } from "./compose.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const serviceKey = "sk-test-secret-value";
const matchingInstallationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const mismatchedInstallationId = "ins_9ce0e58a-415d-485e-90c2-20c3c5572505";
const defaultRuntimeImage = "openclaw-enterprise-runtime:quickstart";
const nodeExecutable = process.execPath;
const bashExecutable = "/bin/bash";

const cliBuilds = new Map();
const cliDirectories = [];
after(async () => {
  for (const directory of cliDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

// hostOS links the CLI as if it ran on that operating system, so a Linux runner
// can exercise the host-specific node resolver selection.
function developmentCli(hostOS = "") {
  if (!cliBuilds.has(hostOS)) {
    cliBuilds.set(
      hostOS,
      (async () => {
        const directory = await mkdtemp(join(tmpdir(), "openclaw-dev-cli-"));
        cliDirectories.push(directory);
        const executable = join(directory, "occ");
        const ldflags = hostOS
          ? [
              "-ldflags",
              `-X github.com/openclaw/openclaw-enterprise/internal/occdev.developmentHostOS=${hostOS}`,
            ]
          : [];
        const build = spawnSync("go", ["build", ...ldflags, "-o", executable, "./cmd/occ"], {
          cwd: repository,
          encoding: "utf8",
          env: process.env,
        });
        assert.equal(build.status, 0, build.stderr || build.error?.message);
        return executable;
      })(),
    );
  }
  return cliBuilds.get(hostOS);
}

// Node stand-ins use process.getBuiltinModule, not require: they load as ESM when TMPDIR is
// inside this repo, whose package.json sets type=module.
async function writeExecutable(path, body) {
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function createFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-dev-up-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fixtureRepository = join(directory, "repository");
  await mkdir(join(fixtureRepository, "scripts"), { recursive: true });
  await mkdir(join(fixtureRepository, "bin"), { recursive: true });
  for (const script of ["dev-up", "dev-down"]) {
    const destination = join(fixtureRepository, "scripts", script);
    await copyFile(join(repository, "scripts", script), destination);
    await chmod(destination, 0o755);
  }
  // Real dev commands discover the disposable source root before selecting its CLI.
  for (const source of ["go.mod", "compose.yaml", "compose.podman.yaml"]) {
    await symlink(join(repository, source), join(fixtureRepository, source));
  }

  const bin = join(directory, "bin");
  await mkdir(bin);
  const engine = options.engine ?? "docker";
  const engineLog = join(directory, `${engine}.log`);
  const provider = composeConfigurationProvider();
  const cli = await developmentCli(options.developmentHostOS);

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
const fs = process.getBuiltinModule("node:fs");
const { spawnSync } = process.getBuiltinModule("node:child_process");
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
      OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR:
        process.env.OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR || "",
      CONTAINER_CONNECTION: process.env.CONTAINER_CONNECTION || "",
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
  if (delegated.stderr) fs.writeFileSync(2, delegated.stderr);
  if (delegated.status !== 0) process.exit(delegated.status ?? 1);
  if (format === "json") {
    // Flush the complete configuration before exiting, even when stdout is a pipe.
    fs.writeFileSync(1, delegated.stdout);
    process.exit(0);
  }
  const converted = spawnSync(process.env.DEV_UP_REAL_YQ, ["-o=json"], {
    input: delegated.stdout,
    encoding: "utf8",
  });
  if (converted.stdout) fs.writeFileSync(1, converted.stdout);
  if (converted.stderr) fs.writeFileSync(2, converted.stderr);
  process.exit(converted.status ?? 1);
}
if (args[0] === "--version") exit(0, engine === "podman" ? "podman version 6.1.0" : "Docker version 29.4.0");
if (args[0] === "version") {
  const platform = ${JSON.stringify(options.dockerPlatformName ?? "Docker Engine - Community")};
  const server = engine === "docker"
    ? { Platform: { Name: platform }, Components: [{ Name: "Engine" }] }
    : {
        Platform: { Name: podmanDockerApi ? "linux/amd64/fedora-40" : "Podman Engine" },
        Components: podmanDockerApi
          ? [{ Name: "Podman Engine" }, { Name: "Engine" }]
          : [{ Name: "Podman Engine" }],
      };
  if (args.includes("{{json .Server}}") && (engine === "docker" || podmanDockerApi)) {
    process.stdout.write(JSON.stringify(server) + "\\n");
  } else if (engine === "docker" || podmanDockerApi) process.stdout.write(server.Platform.Name + "\\n");
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
if (
  engine === "podman" &&
  args[0] === "system" &&
  args[1] === "connection" &&
  args[2] === "list" &&
  ${JSON.stringify(options.macosPodmanMachine !== undefined)}
) {
  process.stdout.write(${JSON.stringify(
    [
      `podman-machine-default|${options.macosPodmanMachine === "rootful" ? "false" : "true"}|true|ssh://core@127.0.0.1:54321/run/user/501/podman/podman.sock`,
      `podman-machine-default-root|${options.macosPodmanMachine === "rootful" ? "true" : "false"}|true|ssh://root@127.0.0.1:54321/run/podman/podman.sock`,
    ].join("\n") + "\n",
  )});
  exit(0);
}
if (
  engine === "podman" &&
  args[0] === "machine" &&
  args[1] === "inspect" &&
  ${JSON.stringify(options.macosPodmanMachine !== undefined)}
) {
  process.stdout.write("true\\n");
  exit(0);
}
if (
  engine === "podman" &&
  args[0] === "machine" &&
  args[1] === "ssh" &&
  ${JSON.stringify(options.macosPodmanMachine !== undefined)}
) {
  process.stdout.write("default via 192.168.127.1 dev eth0\\n");
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
    await writeExecutable(
      join(bin, "uname"),
      `#!${nodeExecutable}\nprocess.stdout.write(${JSON.stringify(options.macosPodmanMachine === undefined ? "Linux" : "Darwin")} + "\\n");\n`,
    );
    await symlink("podman", join(bin, "podman-compose"));
  }
  await writeExecutable(
    join(fixtureRepository, "bin", "occ"),
    `#!${nodeExecutable}
const fs = process.getBuiltinModule("node:fs");
const args = process.argv.slice(2);
if (args[0] === "dev") {
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const result = spawnSync(${JSON.stringify(cli)}, args, { env: process.env, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const log = process.env.DEV_UP_OCC_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args }) + "\\n");
const scenario = process.env.DEV_UP_FAKE_SCENARIO || "success";
let payload;
let exitCode = 0;
if (scenario === "api-unauthorized") {
  exitCode = 1;
  payload = { error: { code: "UNAUTHENTICATED", message: "A valid service API key is required." }, meta: { requestId: "req_1" } };
} else {
  payload = {
    id: scenario === "api-mismatch" ? ${JSON.stringify(mismatchedInstallationId)} : ${JSON.stringify(matchingInstallationId)},
  };
}
if (exitCode === 0) process.stdout.write(JSON.stringify(payload) + "\\n");
else process.stderr.write(JSON.stringify(payload) + "\\nHTTP 401\\n");
process.exit(exitCode);
`,
  );
  await writeExecutable(
    join(bin, "occ"),
    `#!${nodeExecutable}
process.stderr.write("dev-up invoked occ from PATH instead of the project bin directory\\n");
process.exit(86);
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
  const occLog = join(directory, "occ.log");
  // Settings exported in the caller's shell would override the defaults the
  // tests assert (for example OCC_DEVELOPMENT_K3S_IMAGE's +v1.35 channel).
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("OCC_DEVELOPMENT_")),
  );
  const env = {
    ...inherited,
    PATH: engine === "podman" ? bin : `${bin}${delimiter}${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "",
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "docker",
    OCC_DOCKER_RUNTIME_IMAGE: "",
    OCC_DOCKER_GATEWAY_IMAGE: "",
    OCC_DOCKER_AGENT_IMAGE: "",
    OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR: "",
    CONTAINER_CONNECTION: options.containerConnection ?? "",
    CONTAINER_HOST: options.containerHost ?? "",
    DEV_UP_ENGINE_LOG: engineLog,
    DEV_UP_OCC_LOG: occLog,
    DEV_UP_FAKE_SCENARIO: options.scenario ?? "success",
    DEV_UP_REAL_COMPOSE_COMMAND: provider.command,
    DEV_UP_REAL_COMPOSE_PREFIX: JSON.stringify(provider.prefix),
    DEV_UP_REAL_COMPOSE_FORMAT: provider.format,
    DEV_UP_REAL_YQ: provider.yq ?? "",
    DEV_UP_REAL_PATH: process.env.PATH ?? "",
    DEV_UP_REPOSITORY: repository,
    DEV_UP_FIXTURE_REPOSITORY: fixtureRepository,
  };

  // Shell startup configuration is outside this disposable command environment.
  delete env.BASH_ENV;
  delete env.ENV;
  delete env.SHELLOPTS;

  return {
    directory,
    cli,
    fixtureRepository,
    occCli: join(fixtureRepository, "bin", "occ"),
    emptyEnv,
    dockerLog,
    podmanLog,
    occLog,
    env,
  };
}

// Only external engine and cluster commands are inert. Configuration rendering,
// selection, state ownership, rollback, and authenticated HTTP use the real code.
async function prepareLifecycleCommands(fixture, scenario = "success", options = {}) {
  const engine = options.engine ?? "docker";
  const bin = join(fixture.directory, "bin");
  // Isolate the launcher contract; real sandbox enforcement is covered by the
  // real-cluster lifecycle suite, not this external-command fixture.
  await writeFile(
    join(fixture.fixtureRepository, "scripts", "prepare-development-codex-seccomp.mjs"),
    'process.stdout.write(JSON.stringify({ mode: "RuntimeDefault", profileName: "" }));\n',
  );
  await rename(join(bin, engine), join(bin, `${engine}-config`));
  fixture.env.SAFETY_LOG = join(fixture.directory, "lifecycle.log");
  fixture.env.DEV_UP_RESOURCE_STATE = join(fixture.directory, "resources.json");
  fixture.env.DEV_UP_LIFECYCLE_SCENARIO = scenario;
  fixture.env.OCC_DEVELOPMENT_CONTAINER_ENGINE = engine;
  fixture.env.OCC_DEVELOPMENT_KUBERNETES_CLUSTER = "occ-dev-owned";
  fixture.env.OCC_DEVELOPMENT_COMPOSE_PROJECT = "owned-kubernetes";
  fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY = join(fixture.directory, "kubernetes state");
  fixture.env.OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS = "1";
  fixture.env.DOCKER_HOST = "unix:///fixture/owned-docker.sock";
  const openShellChart = join(fixture.directory, "openshell-chart.tgz");
  const openShellWorkspaceChart = join(fixture.directory, "openshell-workspace-chart.tgz");
  const agentSandboxManifest = join(fixture.directory, "agent-sandbox.yaml");
  await writeFile(openShellChart, "fixture OpenShell chart\n", { mode: 0o600 });
  await writeFile(openShellWorkspaceChart, "fixture OpenShell workspace chart\n", { mode: 0o600 });
  await writeFile(agentSandboxManifest, "fixture Agent Sandbox manifest\n", { mode: 0o600 });
  fixture.env.OCC_DEVELOPMENT_OPENSHELL_HELM_CHART = openShellChart;
  fixture.env.OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART = openShellWorkspaceChart;
  fixture.env.OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST = agentSandboxManifest;
  delete fixture.env.DOCKER_CONTEXT;
  await writeFile(
    fixture.env.DEV_UP_RESOURCE_STATE,
    JSON.stringify({ clusters: ["occ-dev-unrelated"], compose: false }),
  );
  for (const command of [engine, "k3d", "kubectl", "helm"]) {
    await writeExecutable(
      join(bin, command),
      `#!${nodeExecutable}
const fs = process.getBuiltinModule("node:fs");
const { spawnSync } = process.getBuiltinModule("node:child_process");
const args = process.argv.slice(2);
const command = ${JSON.stringify(command)};
const engine = ${JSON.stringify(engine)};
const scenario = process.env.DEV_UP_LIFECYCLE_SCENARIO;
const statePath = process.env.DEV_UP_RESOURCE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }
function output(value) { process.stdout.write(value + "\\n"); }
function fail(message) { process.stderr.write(message + "\\n"); process.exit(77); }
fs.appendFileSync(process.env.SAFETY_LOG, JSON.stringify({ command, args, dockerHost: process.env.DOCKER_HOST || "", dockerContext: process.env.DOCKER_CONTEXT || "" }) + "\\n");
// Podman records an unqualified local name under the \`localhost\` registry;
// Docker keeps it as written. A name whose first component already names a
// registry is left alone by both engines.
function recordedTag(name) {
  if (engine !== "podman") return name;
  const first = name.split("/")[0];
  // Only a first component before a slash can name a registry; a bare
  // \`name:tag\` carries its tag there and is still unqualified.
  const qualified = name.includes("/") && (first === "localhost" || first.includes(".") || first.includes(":"));
  return qualified ? name : "localhost/" + name;
}
// containerd stores whatever reference was imported, so the node inventory
// reflects the same qualification the engine applied.
function importedTag(name) {
  if (engine === "podman") return recordedTag(name);
  return name.includes("/") ? "docker.io/" + name : "docker.io/library/" + name;
}
if (command === engine) {
  if (args[0] === "version" || (args[0] === "compose" && (args.includes("config") || args[1] === "version"))) {
    const result = spawnSync(${JSON.stringify(join(bin, `${engine}-config`))}, args, { env: process.env, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  if (args[0] === "context" && args[1] === "show") output("fixture-context");
  else if (args[0] === "context" && args[1] === "inspect") output(JSON.stringify([{ Endpoints: { docker: { Host: "unix:///fixture/owned-docker.sock" } } }]));
  else if (args[0] === "info" && args.includes("{{.Host.RemoteSocket.Path}}")) output("/fixture/owned-podman.sock");
  // Kubernetes endpoint discovery reads the whole inventory; a local service
  // reports the host socket directly.
  else if (engine === "podman" && args[0] === "info" && args.includes("json")) output(JSON.stringify({ host: { serviceIsRemote: false, remoteSocket: { path: "unix:///fixture/owned-podman.sock", exists: true } } }));
  else if (args[0] === "info" && args.includes("{{.OperatingSystem}}")) output(process.env.DEV_UP_DOCKER_OPERATING_SYSTEM || "Docker Engine");
  else if (args[0] === "run" && args.at(-1) === "/etc/resolv.conf" && args.includes("bridge")) {
    const choice = process.env.DEV_UP_BRIDGE_RESOLV_CONF || "";
    const bodies = {
      "192.168.65.7": "nameserver 192.168.65.7\\n",
      ipv6: "nameserver 2001:db8::53\\n",
    };
    if (bodies[choice] == null) fail("unexpected bridge resolv.conf probe");
    process.stdout.write(bodies[choice]);
  }
  else if (args[0] === "info") output("/var/lib/docker");
  else if (args[0] === "network" && args[1] === "inspect" && args[2] === "k3d-occ-dev-owned") {
    output(JSON.stringify([{ Name: "k3d-occ-dev-owned", IPAM: { Config: [{ Subnet: "fd00:42::/64" }, { Subnet: "172.30.42.0/24", Gateway: "172.30.42.1" }] } }]));
  }
  else if (args[0] === "network" && args[1] === "inspect") {
    if (!state.compose) process.exit(1);
    output(JSON.stringify([{ IPAM: { Config: [{ Subnet: "172.30.41.0/24" }] } }]));
  }
  else if (args[0] === "image" && args[1] === "inspect" && args.includes("{{json .RepoTags}}")) output(JSON.stringify([recordedTag(args.at(-1))]));
  else if (args[0] === "image" && args[1] === "inspect" && args.includes("--format")) output("linux/amd64");
  else if (args[0] === "image" && args[1] === "save") fs.writeFileSync(args[args.indexOf("--output") + 1], "fixture image archive\\n");
  else if (args[0] === "image" && args[1] === "inspect" && args[2] === "openclaw-enterprise-controller:kubernetes-quickstart" && process.env.DEV_UP_EXISTING_CONTROLLER_IMAGE === "1") {}
  else if (args[0] === "image" && args[1] === "inspect" && args[2] === "openclaw-enterprise-runtime:kubernetes-quickstart" && process.env.DEV_UP_EXISTING_RUNTIME_IMAGE === "1") {}
  else if (["volume", "network", "image"].includes(args[0]) && args[1] === "inspect") process.exit(1);
  else if (args[0] === "ps" || (["volume", "network"].includes(args[0]) && args[1] === "ls") || args[0] === "build" || args[0] === "pull" || args[0] === "tag" || (args[0] === "image" && args[1] === "rm")) {}
  else if (args[0] === "inspect") {
    if (args.includes("{{.State.Status}}")) output("exited");
    else if (args.includes("{{.State.ExitCode}}")) output("0");
    else fail("unexpected inspect: " + args.join(" "));
  } else if (args[0] === "exec" && args[1].endsWith("-server-0") && args[2] === "nslookup") {
    // The launcher checks the new node's resolver before any image pull.
    if (scenario === "node-dns-refused") fail(";; connection timed out; no servers could be reached\\nnslookup: write to '172.30.42.1': Connection refused");
    output("Name:\\tregistry-1.docker.io\\nAddress: 192.0.2.10");
  } else if (args[0] === "exec" && args[1].endsWith("-server-0") && args.slice(2, 5).join(" ") === "ip route get") {
    // The k3d API server reaches local Pods over the node's cni0 bridge.
    output(args[5] + " dev cni0 src 10.42.0.1 uid 0\\n    cache");
  } else if (args[0] === "exec" && args.includes("images")) {
    if (args.includes("list")) output([
      ["openclaw-enterprise-runtime:kubernetes-quickstart", "a".repeat(64)],
      ["openclaw-enterprise-controller:kubernetes-quickstart", "b".repeat(64)],
      ["openclaw-development/import-b9b4e5950649:occ-dev-owned", "c".repeat(64)],
      ["openclaw-development/openshell-gateway:occ-dev-owned", "17b2f65d1e33f32a419ecc98dd42389b0227280be54139c14834933ec29420ea"],
      ["openclaw-development/openshell-sandbox:occ-dev-owned", "b46ed57b080946d0fe80490dbe1441ebf4a83c6eec79369ddbcfc49ec19dc0cf"],
      ["openclaw-development/openshell-supervisor:occ-dev-owned", "971d71f45f677a7b1084385322bae4ac6fd09e9450e680684ab79a04d07c5c9f"],
    ].map(([name, digest]) => importedTag(name) + " application/vnd.oci.image.manifest.v1+json sha256:" + digest).join("\\n"));
  } else if (args[0] === "cp") {
    fs.writeFileSync(args.at(-1), JSON.stringify({ data: { id: "key_fixture", key: ${JSON.stringify(serviceKey)} }, meta: { installationId: ${JSON.stringify(matchingInstallationId)} } }));
  } else if (args[0] === "compose") {
    if (args.includes("up")) {
      state.compose = true; save();
      if (scenario === "compose-up-failed") fail("partial compose startup");
    } else if (args.includes("down")) {
      if (scenario === "compose-down-failed") fail("compose cleanup unavailable");
      state.compose = false; save();
    } else if (args.includes("ps")) output(args.at(-1) + "-container-id");
    else if (!args.includes("exec") && !args.includes("logs") && !args.includes("stop")) fail("unexpected compose: " + args.join(" "));
  } else fail("unexpected " + engine + ": " + args.join(" "));
} else if (command === "k3d") {
  if (args[0] === "cluster" && args[1] === "list") output(JSON.stringify(state.clusters.map(name => ({ name }))));
  else if (args[0] === "cluster" && args[1] === "create") {
    state.clusters.push(args[2]); save();
    if (scenario === "cluster-create-failed") fail("partial cluster creation");
  } else if (args[0] === "cluster" && args[1] === "delete") {
    if (scenario === "cluster-delete-failed") fail("cluster cleanup unavailable");
    state.clusters = state.clusters.filter(name => name !== args[2]); save();
  } else if (args[0] === "kubeconfig" && args[1] === "get") output(JSON.stringify({
    apiVersion: "v1", kind: "Config", "current-context": "k3d-occ-dev-owned",
    contexts: [{ name: "k3d-occ-dev-owned", context: { cluster: "k3d-occ-dev-owned", user: "admin" } }],
    clusters: [{ name: "k3d-occ-dev-owned", cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": "fixture-ca" } }],
    users: [{ name: "admin", user: { token: "fixture-kubernetes-token" } }]
  }));
  else if (args[0] !== "image") fail("unexpected k3d: " + args.join(" "));
} else if (command === "kubectl") {
  if (args.includes("get") && args.includes("--raw=/version")) {}
  else if (args[0] === "apply" || args[0] === "rollout" || args[0] === "create" || args[0] === "patch") {}
  else if (args[0] === "get" && args[1] === "node" && args[2].endsWith("-server-0")) output(JSON.stringify({ spec: { podCIDR: "10.42.0.0/24" } }));
  else if (args[0] === "get" && args[1] === "namespace") output(JSON.stringify({ metadata: { name: args[2] } }));
  else if (args[0] === "-n" && args.includes("wait")) {}
  else if (args[0] === "-n" && args.includes("rollout")) {}
  else if (args[0] === "-n" && args.includes("delete")) {}
  else if (args[0] === "-n" && args.includes("exec")) output(JSON.stringify({ data: { id: "key_fixture", key: ${JSON.stringify(serviceKey)} }, meta: { installationId: ${JSON.stringify(matchingInstallationId)} } }));
  else if (args[0] === "-n" && args.includes("pod") && args.includes("bootstrap-password-prepare")) output("Succeeded");
  else if (args[0] === "-n" && args.includes("pod") && args.includes("postgres-0")) output("10.42.0.20");
  else if (args[0] === "-n" && args.includes("endpoints") && args.includes("kubernetes") && args.includes("jsonpath={.subsets[0].ports[0].port}")) output("6443");
  else if (args[0] === "-n" && args.includes("endpoints") && args.includes("kubernetes")) output("172.30.42.3");
  else if (args[0] === "get" && args[1] === "service" && args[2] === "kubernetes") output(JSON.stringify({ spec: { clusterIP: "10.43.0.1" } }));
  else if (args[0] === "get" && args[1] === "service" && args[2] === "openshell-gateway" && args.includes("jsonpath={.spec.clusterIP}")) output("10.43.0.50");
  else if (args[0] === "get" && args[1] === "endpoints" && args[2] === "kubernetes") output(JSON.stringify({ subsets: [{ addresses: [{ ip: "172.30.41.4" }] }] }));
  else if (args[0] === "get" && args[1] === "namespaces") output(JSON.stringify({ items: [{ metadata: { name: "oce-123456789012345", labels: { "openclaw.dev/namespace": "namespace_fixture" }, annotations: { "openclaw.dev/namespace-id": "namespace_fixture" } } }] }));
  else if (args[0] === "get" && args[1] === "service" && args.includes("jsonpath={.spec.ports[0].nodePort}")) output("30051");
  else fail("unexpected kubectl: " + args.join(" "));
} else if (command === "helm") {
  if ((args[0] === "show" && args[1] === "chart") || args[0] === "upgrade") {}
  else if (args[0] === "template") output([
    "apiVersion: v1",
    "kind: ServiceAccount",
    "metadata:",
    "  name: openshell-sandbox",
    "  namespace: openclaw-workspace-template",
    "---",
    "apiVersion: rbac.authorization.k8s.io/v1",
    "kind: Role",
    "metadata:",
    "  name: openshell-workspace-sandbox",
    "  namespace: openclaw-workspace-template",
  ].join("\\n"));
  else fail("unexpected helm: " + args.join(" "));
}
`,
    );
  }
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
    cwd: env.DEV_UP_FIXTURE_REPOSITORY,
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
    if (error.code === "ENOENT") {
      return [];
    }
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
  prepareLifecycleCommands,
  publicControllerOverride,
  readJsonLines,
  runDevUp,
  serviceKey,
};
