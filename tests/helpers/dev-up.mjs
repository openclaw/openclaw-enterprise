import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
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

let cliBuild;
let cliDirectory;
after(async () => {
  if (cliDirectory) {
    await rm(cliDirectory, { recursive: true, force: true });
  }
});

function developmentCli() {
  cliBuild ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-dev-cli-"));
    cliDirectory = directory;
    const executable = join(directory, "occ");
    const build = spawnSync("go", ["build", "-o", executable, "./cmd/occ"], {
      cwd: repository,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    return executable;
  })();
  return cliBuild;
}

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
  const cli = await developmentCli();

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
  return args.findIndex((arg, index) => index > 0 && ["config", "build", "up", "down", "ps", "cp", "exec"].includes(arg));
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
    ? { Platform: { Name: platform }, Components: ${JSON.stringify(options.dockerComponents ?? [{ Name: "Engine" }])} }
    : { Platform: { Name: "Podman Engine" }, Components: [{ Name: "Podman Engine" }] };
  if (args.includes("{{json .Server}}") && (engine === "docker" || podmanDockerApi)) {
    process.stdout.write(JSON.stringify(server) + "\\n");
  } else if (engine === "docker") process.stdout.write(platform + "\\n");
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
if (command === "down") exit(0);
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
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "dev") {
  const { spawnSync } = require("node:child_process");
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
  const env = {
    ...process.env,
    PATH: engine === "podman" ? bin : `${bin}${delimiter}${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "",
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
async function prepareLifecycleCommands(fixture, scenario = "success") {
  const bin = join(fixture.directory, "bin");
  await rename(join(bin, "docker"), join(bin, "docker-config"));
  fixture.env.SAFETY_LOG = join(fixture.directory, "lifecycle.log");
  fixture.env.DEV_UP_RESOURCE_STATE = join(fixture.directory, "resources.json");
  fixture.env.DEV_UP_LIFECYCLE_SCENARIO = scenario;
  fixture.env.OCC_DEVELOPMENT_CONTAINER_ENGINE = "docker";
  fixture.env.OCC_DEVELOPMENT_KUBERNETES_CLUSTER = "occ-dev-owned";
  fixture.env.OCC_DEVELOPMENT_COMPOSE_PROJECT = "owned-kubernetes";
  fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY = join(fixture.directory, "kubernetes state");
  fixture.env.OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS = "1";
  fixture.engineEndpoint = `unix://${join(fixture.directory, "engine.sock")}`;
  fixture.env.DOCKER_HOST = fixture.engineEndpoint;
  delete fixture.env.DOCKER_CONTEXT;
  await writeFile(
    fixture.env.DEV_UP_RESOURCE_STATE,
    JSON.stringify({ clusters: ["occ-dev-unrelated"], compose: false }),
  );
  await writeFile(fixture.env.DEV_UP_RESOURCE_STATE + ".owners", "{}");
  await writeFile(fixture.env.DEV_UP_RESOURCE_STATE + ".nodes", "{}");
  await writeFile(fixture.env.DEV_UP_RESOURCE_STATE + ".volumes", "{}");
  for (const command of ["docker", "k3d", "kubectl"]) {
    await writeExecutable(
      join(bin, command),
      `#!${nodeExecutable}
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const command = ${JSON.stringify(command)};
const scenario = process.env.DEV_UP_LIFECYCLE_SCENARIO;
const statePath = process.env.DEV_UP_RESOURCE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const ownersPath = statePath + ".owners";
const owners = JSON.parse(fs.readFileSync(ownersPath, "utf8"));
const nodesPath = statePath + ".nodes";
const nodes = JSON.parse(fs.readFileSync(nodesPath, "utf8"));
const volumesPath = statePath + ".volumes";
const volumes = JSON.parse(fs.readFileSync(volumesPath, "utf8"));
function saveNodes() { fs.writeFileSync(nodesPath, JSON.stringify(nodes)); }
function saveVolumes() { fs.writeFileSync(volumesPath, JSON.stringify(volumes)); }
function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }
function saveOwners() { fs.writeFileSync(ownersPath, JSON.stringify(owners)); }
function output(value) { process.stdout.write(value + "\\n"); }
function fail(message) { process.stderr.write(message + "\\n"); process.exit(77); }
fs.appendFileSync(process.env.SAFETY_LOG, JSON.stringify({ command, args, dockerHost: process.env.DOCKER_HOST || "", dockerContext: process.env.DOCKER_CONTEXT || "" }) + "\\n");
if (command === "docker") {
  if (args[0] === "version" || (args[0] === "compose" && (args.includes("config") || args[1] === "version"))) {
    const result = spawnSync(${JSON.stringify(join(bin, "docker-config"))}, args, { env: process.env, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  if (args[0] === "context" && args[1] === "show") output("fixture-context");
  else if (args[0] === "context" && args[1] === "inspect") output(JSON.stringify([{ Endpoints: { docker: { Host: ${JSON.stringify(fixture.engineEndpoint)} } } }]));
  else if (args[0] === "info") output("/var/lib/docker");
  else if (args[0] === "volume" && args[1] === "create") {
    const name = args.at(-1);
    // Docker VolumeCreate preserves an existing volume's labels.
    if (!volumes[name]) {
      volumes[name] = Object.fromEntries(args.flatMap((arg, i) => arg === "--label" ? [args[i + 1].split("=")] : []));
      saveVolumes();
    }
    output(name);
  } else if (args[0] === "volume" && args[1] === "inspect") {
    if (!volumes[args.at(-1)]) process.exit(1);
    output(volumes[args.at(-1)]["io.openclaw.development.owner"] || "");
  } else if (args[0] === "volume" && args[1] === "ls") {
    const filter = args[args.indexOf("--filter") + 1] || "";
    for (const [name, labels] of Object.entries(volumes)) {
      if (filter.startsWith("name=") ? name.includes(filter.slice(5)) : labels["k3d.cluster"] === filter.slice("label=k3d.cluster=".length)) output(name);
    }
  } else if (args[0] === "volume" && args[1] === "rm") {
    delete volumes[args.at(-1)]; saveVolumes();
  } else if (["network", "image"].includes(args[0]) && args[1] === "inspect") process.exit(1);
  else if (args[0] === "container" && args[1] === "inspect") {
    const node = Object.values(nodes).flat().find(node => node.Id === args.at(-1) || node.Name === "/" + args.at(-1));
    if (!node || !state.clusters.includes(node.Config.Labels["k3d.cluster"])) process.exit(1);
    const cluster = node.Config.Labels["k3d.cluster"];
    const name = node.Name.slice(1);
    const owner = owners[name] ?? (node.Config.Labels["k3d.role"] === "noRole" ? "" : owners[cluster]) ?? "";
    node.Config.Labels["io.openclaw.development.owner"] = owner;
    output(args.includes("{{json .}}") ? JSON.stringify(node) : owner);
  } else if (args[0] === "container" && args[1] === "rm") {
    const node = Object.values(nodes).flat().find(node => node.Id === args.at(-1));
    if (!node) process.exit(1);
    if (scenario === "cluster-delete-partial-node" && node.Name.endsWith("-serverlb")) fail("auxiliary deletion unavailable");
    const cluster = node.Config.Labels["k3d.cluster"];
    nodes[cluster] = nodes[cluster].filter(item => item.Id !== node.Id); saveNodes();
    if (nodes[cluster].length === 0) { state.clusters = state.clusters.filter(name => name !== cluster); save(); }
  }
  else if (args[0] === "ps") {
    const clusterFilter = args.find(arg => arg.startsWith("label=k3d.cluster="));
    if (clusterFilter) {
      const cluster = clusterFilter.slice("label=k3d.cluster=".length);
      if (state.clusters.includes(cluster)) for (const node of nodes[cluster] || []) output(node.Id);
    }
  } else if ((["volume", "network"].includes(args[0]) && args[1] === "ls") || args[0] === "build") {}
  else if (args[0] === "inspect") {
    if (args.includes("{{.State.Status}}")) output("exited");
    else if (args.includes("{{.State.ExitCode}}")) output("0");
    else if (args.some(arg => arg.includes("io.openclaw.development.owner"))) {
      const node = Object.values(nodes).flat().find(node => node.Name === "/" + args.at(-1));
      if (!node || !state.clusters.includes(node.Config.Labels["k3d.cluster"])) process.exit(1);
      output(owners[node.Name.slice(1)] ?? owners[node.Config.Labels["k3d.cluster"]] ?? "");
    }
    else fail("unexpected inspect: " + args.join(" "));
  } else if (args[0] === "exec" && args.includes("images")) {
    if (args.includes("list")) output("docker.io/library/openclaw-enterprise-runtime:kubernetes-quickstart application/vnd.oci.image.manifest.v1+json sha256:" + "a".repeat(64));
  } else if (args[0] === "cp") {
    fs.writeFileSync(args.at(-1), JSON.stringify({ data: { id: "key_fixture", key: ${JSON.stringify(serviceKey)} }, meta: { installationId: ${JSON.stringify(matchingInstallationId)} } }));
  } else if (args[0] === "compose") {
    if (args.includes("up")) {
      state.compose = true; save();
      if (scenario === "compose-up-failed") fail("partial compose startup");
    } else if (args.includes("down")) {
      if (scenario === "compose-down-failed") fail("compose cleanup unavailable");
      state.compose = false; save();
    } else if (args.includes("ps")) {
      if (scenario === "migration-pipe-held" && args.at(-1) === "migrate") {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { detached: true, stdio: ["ignore", process.stdout, "ignore"] });
        fs.writeFileSync(statePath + ".child", String(child.pid));
        child.unref();
      }
      output(args.at(-1) + "-container-id");
    }
    else if (!args.includes("exec") && !args.includes("logs") && !args.includes("stop")) fail("unexpected compose: " + args.join(" "));
  } else fail("unexpected docker: " + args.join(" "));
} else if (command === "k3d") {
  if (args[0] === "cluster" && args[1] === "list") output(JSON.stringify(state.clusters.filter(name => scenario !== "cluster-create-hidden" || name !== "occ-dev-owned").map(name => ({ name }))));
  else if (args[0] === "cluster" && args[1] === "create") {
    const imageVolume = "k3d-" + args[2] + "-images";
    volumes[imageVolume] ??= { "k3d.cluster": args[2], app: "k3d" }; saveVolumes();
    if (scenario === "cluster-create-before-tools") fail("creation failed before cluster preparation");
    state.clusters.push(args[2]); save();
    const label = args[args.indexOf("--runtime-label") + 1] || "";
    const owner = label.split("=")[1]?.split("@")[0] || "";
    const { createHash } = require("node:crypto");
    function node(suffix, role) {
      const name = "k3d-" + args[2] + "-" + suffix;
      return {
        Id: createHash("sha256").update(name + owner).digest("hex"), Name: "/" + name,
        Config: { Labels: { app: "k3d", "k3d.cluster": args[2], "k3d.role": role } },
        Mounts: [{ Name: imageVolume, Destination: "/k3d/images" }],
        NetworkSettings: { Networks: { [process.env.OCC_DEVELOPMENT_COMPOSE_PROJECT + "_development"]: {} } },
      };
    }
    // The native tools node exists independently of configured nodes and never
    // inherits --runtime-label, including with @all.
    nodes[args[2]] = [node("tools", "noRole")]; saveNodes();
    if (scenario === "cluster-create-before-server") fail("creation failed before first server");
    nodes[args[2]].push(node("server-0", "server"), node("serverlb", "loadbalancer")); saveNodes();
    if (scenario === "cluster-create-collision") {
      owners[args[2]] = "another-invocation"; saveOwners();
      fail("cluster name already occupied");
    }
    owners[args[2]] = label.split("=")[1]?.split("@")[0] || "";
    // v5.9.0 @server:0 excludes the proxy; @all includes both prepared nodes.
    if (!label.endsWith("@all")) owners["k3d-" + args[2] + "-serverlb"] = "";
    saveOwners();
    if (scenario === "cluster-create-failed" || scenario === "cluster-create-hidden") fail("partial cluster creation");
  } else if (args[0] === "cluster" && args[1] === "delete") {
    if (scenario === "cluster-delete-failed") fail("cluster cleanup unavailable");
    if (scenario === "cluster-delete-partial-node" || scenario === "cluster-delete-partial-volume") {
      nodes[args[2]] = scenario === "cluster-delete-partial-node" ? nodes[args[2]].filter(node => node.Name.endsWith("-serverlb")) : [];
      saveNodes();
      if (nodes[args[2]].length === 0) { state.clusters = state.clusters.filter(name => name !== args[2]); save(); }
      fail("partial cluster deletion");
    }
    for (const [name, labels] of Object.entries(volumes)) {
      if (labels["k3d.cluster"] === args[2] && labels.app === "k3d") delete volumes[name];
    }
    saveVolumes();
    state.clusters = state.clusters.filter(name => name !== args[2]); save();
    delete owners[args[2]]; saveOwners();
  } else if (args[0] === "kubeconfig" && args[1] === "get") output(JSON.stringify({
    apiVersion: "v1", kind: "Config", "current-context": "k3d-occ-dev-owned",
    contexts: [{ name: "k3d-occ-dev-owned", context: { cluster: "k3d-occ-dev-owned", user: "admin" } }],
    clusters: [{ name: "k3d-occ-dev-owned", cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": "fixture-ca" } }],
    users: [{ name: "admin", user: { token: "fixture-kubernetes-token" } }]
  }));
  else if (args[0] === "image") {
    if (scenario !== "cluster-delete-tools") {
      const cluster = args[args.indexOf("-c") + 1];
      nodes[cluster] = nodes[cluster].filter(node => node.Config.Labels["k3d.role"] !== "noRole"); saveNodes();
    }
  } else fail("unexpected k3d: " + args.join(" "));
} else if (command === "kubectl") {
  if (!args.includes("get")) fail("unexpected kubectl: " + args.join(" "));
  output(JSON.stringify({ gitVersion: scenario === "unsupported-kubernetes-version" ? "v1.34.9+k3s1" : "v1.35.8+k3s1" }));
}
`,
    );
  }
}

// Pause one inert mutation while the real CLI and its filesystem remain live.
async function pauseLifecycleCommand(fixture, command, operation, afterCommand = false) {
  const executable = join(fixture.directory, "bin", command);
  const original = executable + "-unpaused";
  const ready = join(fixture.directory, "mutation-ready");
  const gate = join(fixture.directory, "mutation-release");
  const done = join(fixture.directory, "mutation-done");
  await rename(executable, original);
  await writeExecutable(
    executable,
    `#!${nodeExecutable}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const operation = ${JSON.stringify(operation)};
const matches = args[0] === operation[0] && args.includes(operation[1]);
function run() {
  return spawnSync(${JSON.stringify(original)}, args, { stdio: "inherit", env: process.env }).status ?? 1;
}

if (!matches || fs.existsSync(${JSON.stringify(ready)})) process.exit(run());
const status = ${JSON.stringify(afterCommand)} ? run() : null;
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(gate)})) return;
  clearInterval(timer);
  const result = status ?? run();
  fs.writeFileSync(${JSON.stringify(done)}, String(result));
  process.exit(result);
}, 10);
`,
  );
  async function waitForFile(path) {
    const deadline = Date.now() + 20_000;
    while (true) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      assert.ok(Date.now() < deadline, `timed out waiting for ${path}`);
      await delay(20);
    }
  }
  return {
    waitUntilPaused: async () => Number(await waitForFile(ready)),
    release: async () => {
      await writeFile(gate, "settle");
      assert.equal(await waitForFile(done), "0");
    },
  };
}

// Leave an independent child alive after its direct helper fails. The child can
// still finish the inert operation, including while holding a captured pipe.
async function failLifecycleCommand(fixture, command, operation, mode) {
  const executable = join(fixture.directory, "bin", command);
  const original = executable + "-settled";
  const ready = join(fixture.directory, "failure-ready");
  const gate = join(fixture.directory, "failure-release");
  const done = join(fixture.directory, "failure-done");
  await rename(executable, original);
  const descendant = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = JSON.parse(process.argv[1]);
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(gate)})) return;
  clearInterval(timer);
  const result = spawnSync(${JSON.stringify(original)}, args, { stdio: "ignore", env: process.env });
  fs.writeFileSync(${JSON.stringify(done)}, String(result.status));
  process.exit(result.status ?? 1);
}, 10);`;
  await writeExecutable(
    executable,
    `#!${nodeExecutable}
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const operation = ${JSON.stringify(operation)};
const matches = args[0] === operation[0] && args.includes(operation[1]);
if (!matches || fs.existsSync(${JSON.stringify(ready)})) {
  process.exit(spawnSync(${JSON.stringify(original)}, args, { stdio: "inherit", env: process.env }).status ?? 1);
}
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, JSON.stringify(args)], {
  detached: true,
  stdio: ["ignore", ${mode === "nonzero-pipe" ? "process.stdout" : '"ignore"'}, "ignore"],
  env: process.env,
});
child.unref();
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ helper: process.pid, descendant: child.pid }));
${mode === "nonzero-pipe" ? "process.exit(77);" : "setInterval(() => {}, 1000);"}
`,
  );
  async function waitForFile(path) {
    const deadline = Date.now() + 20_000;
    while (true) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      assert.ok(Date.now() < deadline, `timed out waiting for ${path}`);
      await delay(20);
    }
  }
  return {
    waitUntilStarted: async () => JSON.parse(await waitForFile(ready)),
    release: async () => {
      await writeFile(gate, "settle");
      assert.equal(await waitForFile(done), "0");
    },
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
  failLifecycleCommand,
  matchingInstallationId,
  mismatchedInstallationId,
  perImageOverride,
  pauseLifecycleCommand,
  prepareLifecycleCommands,
  publicControllerOverride,
  readJsonLines,
  runDevUp,
  serviceKey,
};
