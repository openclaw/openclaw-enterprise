import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

import { commandPath, composeConfigurationProvider } from "./compose.mjs";
import { bashString, commandShim, startCommandServer } from "./fixture-command-server.mjs";
import { readJsonLines as readJsonLinesFile } from "./json-lines.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const serviceKey = "sk-test-secret-value";
const matchingInstallationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const mismatchedInstallationId = "ins_9ce0e58a-415d-485e-90c2-20c3c5572505";
const defaultRuntimeImage = "openclaw-enterprise-runtime:quickstart";
const bashExecutable = "/bin/bash";

// Callers isolate scenario environments in fixture.env and leave the parent PATH,
// cwd and provider executables unchanged. Reuse discovery, never scenario renders.
let configurationProvider;
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

// The external commands dev-up runs (the container engine, yq, uname, the project's occ,
// and k3d, kubectl and helm for Kubernetes Compute) are bash scripts answered by the
// fixture's command server (fixture-command-server.mjs), so their logic below runs in
// the test process: a command costs a bash start instead of a node start. The real CLI,
// scripts/dev-up and scripts/dev-down still start each one as a process. A command
// sends the environment variables below.
const forwardedEnv = [
  "CONTAINER_CONNECTION",
  "DEV_UP_ENGINE_LOG",
  "DEV_UP_EXISTING_CONTROLLER_IMAGE",
  "DEV_UP_EXISTING_RUNTIME_IMAGE",
  "DEV_UP_FAKE_SCENARIO",
  "DEV_UP_LIFECYCLE_SCENARIO",
  "DEV_UP_OCC_LOG",
  "DEV_UP_REAL_COMPOSE_COMMAND",
  "DEV_UP_REAL_COMPOSE_FORMAT",
  "DEV_UP_REAL_COMPOSE_PREFIX",
  "DEV_UP_REAL_PATH",
  "DEV_UP_REAL_YQ",
  "DEV_UP_REPOSITORY",
  "DEV_UP_RESOURCE_STATE",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "OCC_CONTAINER_ENGINE_SOCKET",
  "OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR",
  "OCC_DOCKER_AGENT_IMAGE",
  "OCC_DOCKER_GATEWAY_IMAGE",
  "OCC_DOCKER_RUNTIME_IMAGE",
  "PODMAN_COMPOSE_PROVIDER",
  "SAFETY_LOG",
];

// The fake commands of each fixture: its options, the CLI it runs for `occ dev`, and
// whether prepareLifecycleCommands added the Kubernetes lifecycle commands.
const fakes = new WeakMap();

// A fake command's process exit, thrown from its logic.
class FakeExit {
  constructor(code) {
    this.code = code;
  }
}

// Returned by a fake that never answers: its process waits until it is killed.
const hold = Symbol("hold");

// Runs one fake command's logic. It writes through out/err, ends with exit (or by
// returning, as status 0), or hands the command a final bash line with script.
async function runFake(io, logic) {
  const out = [];
  const err = [];
  const command = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    exit: (code, message = "") => {
      if (message) {
        err.push(message + "\n");
      }
      throw new FakeExit(code);
    },
    readInput: io.readInput,
  };
  let code = 0;
  let script;
  try {
    script = await logic(command);
  } catch (error) {
    if (!(error instanceof FakeExit)) {
      throw error;
    }
    code = error.code;
  }
  io.stdout(out.join(""));
  io.stderr(err.join(""));
  if (script === hold) {
    return;
  }
  if (typeof script === "string") {
    io.script(script);
  } else {
    io.exit(code);
  }
}

function engineCommand(fake, { args, env, cwd }, { stdout, exit }) {
  const { engine, options } = fake;
  const podmanJsonConfig = options.podmanJsonConfig ?? false;
  const podmanDockerApi = options.podmanDockerApi ?? false;
  const log = env.DEV_UP_ENGINE_LOG;
  if (log) {
    appendFileSync(
      log,
      JSON.stringify({
        args,
        env: {
          OCC_DOCKER_RUNTIME_IMAGE: env.OCC_DOCKER_RUNTIME_IMAGE || "",
          OCC_DOCKER_GATEWAY_IMAGE: env.OCC_DOCKER_GATEWAY_IMAGE || "",
          OCC_DOCKER_AGENT_IMAGE: env.OCC_DOCKER_AGENT_IMAGE || "",
          PODMAN_COMPOSE_PROVIDER: env.PODMAN_COMPOSE_PROVIDER || "",
          OCC_CONTAINER_ENGINE_SOCKET: env.OCC_CONTAINER_ENGINE_SOCKET || "",
          OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR: env.OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR || "",
          CONTAINER_CONNECTION: env.CONTAINER_CONNECTION || "",
        },
      }) + "\n",
    );
  }
  const scenario = env.DEV_UP_FAKE_SCENARIO || "success";
  const writeServiceKey = (destination, id) =>
    writeFileSync(
      resolve(cwd, destination),
      JSON.stringify({
        data: { id, key: serviceKey },
        meta: { installationId: matchingInstallationId },
      }),
    );
  const composeCommandIndex = () =>
    args.findIndex(
      (arg, index) => index > 0 && ["config", "build", "up", "ps", "cp", "exec"].includes(arg),
    );
  // The real Compose renders the configuration, as this command's own child did: the
  // command runs it with its own environment and these overrides.
  const delegateComposeConfig = () => {
    const command = env.DEV_UP_REAL_COMPOSE_COMMAND;
    const prefix = JSON.parse(env.DEV_UP_REAL_COMPOSE_PREFIX || "[]");
    const format = env.DEV_UP_REAL_COMPOSE_FORMAT;
    if (!command || !format) {
      exit(99, "real Compose configuration provider is required");
    }
    const commandIndex = composeCommandIndex();
    const composeArgs = args.slice(1, commandIndex + 1).filter((arg, index, values) => {
      if (arg === "--format") {
        return false;
      }
      return index === 0 || values[index - 1] !== "--format";
    });
    if (format === "json") {
      composeArgs.push("--format", "json");
    }
    const assignments = [
      `PATH=${env.DEV_UP_REAL_PATH ? bashString(env.DEV_UP_REAL_PATH) : '"$PATH"'}`,
      "OPENAI_API_KEY=",
      ...["OCC_DOCKER_RUNTIME_IMAGE", "OCC_DOCKER_GATEWAY_IMAGE", "OCC_DOCKER_AGENT_IMAGE"].map(
        (name) => `${name}="\${${name}:-}"`,
      ),
    ].join(" ");
    const compose = [command, ...prefix, ...composeArgs].map(bashString).join(" ");
    const enter = env.DEV_UP_REPOSITORY
      ? `cd -- ${bashString(env.DEV_UP_REPOSITORY)} || exit 1; `
      : "";
    if (format === "json") {
      return `${enter}${assignments} exec ${compose}`;
    }
    return (
      `${enter}__config=$(${assignments} ${compose}) || exit $?; ` +
      `printf '%s\\n' "$__config" | ${bashString(env.DEV_UP_REAL_YQ)} -o=json; exit $?`
    );
  };
  if (args[0] === "--version") {
    exit(0, engine === "podman" ? "podman version 6.1.0" : "Docker version 29.4.0");
  }
  if (args[0] === "version") {
    const platform = options.dockerPlatformName ?? "Docker Engine - Community";
    const server =
      engine === "docker"
        ? { Platform: { Name: platform }, Components: [{ Name: "Engine" }] }
        : {
            Platform: { Name: podmanDockerApi ? "linux/amd64/fedora-40" : "Podman Engine" },
            Components: podmanDockerApi
              ? [{ Name: "Podman Engine" }, { Name: "Engine" }]
              : [{ Name: "Podman Engine" }],
          };
    if (args.includes("{{json .Server}}") && (engine === "docker" || podmanDockerApi)) {
      stdout(JSON.stringify(server) + "\n");
    } else if (engine === "docker" || podmanDockerApi) {
      stdout(server.Platform.Name + "\n");
    } else {
      exit(1);
    }
    exit(0);
  }
  if (args[0] === "info") {
    if (engine === "podman" && args.includes("{{.DockerRootDir}}")) {
      if (podmanDockerApi) {
        stdout("/var/lib/containers/storage\n");
        exit(0);
      }
      exit(1);
    }
    if (engine === "podman") {
      stdout("unix:///run/user/501/podman/podman.sock\n");
    } else {
      stdout("29.4.0\n");
    }
    exit(0);
  }
  const macosPodmanMachine = options.macosPodmanMachine !== undefined;
  if (
    engine === "podman" &&
    args[0] === "system" &&
    args[1] === "connection" &&
    args[2] === "list" &&
    macosPodmanMachine
  ) {
    const rootful = options.macosPodmanMachine === "rootful";
    stdout(
      [
        `podman-machine-default|${rootful ? "false" : "true"}|true|ssh://core@127.0.0.1:54321/run/user/501/podman/podman.sock`,
        `podman-machine-default-root|${rootful ? "true" : "false"}|true|ssh://root@127.0.0.1:54321/run/podman/podman.sock`,
      ].join("\n") + "\n",
    );
    exit(0);
  }
  if (engine === "podman" && args[0] === "machine" && args[1] === "inspect" && macosPodmanMachine) {
    stdout("true\n");
    exit(0);
  }
  if (engine === "podman" && args[0] === "machine" && args[1] === "ssh" && macosPodmanMachine) {
    stdout("default via 192.168.127.1 dev eth0\n");
    exit(0);
  }
  if (args[0] === "image" && args[1] === "inspect") {
    exit(args[2] === defaultRuntimeImage ? 1 : 0);
  }
  if (args[0] === "build") {
    exit(0);
  }
  if (engine === "podman" && args[0] === "cp") {
    writeServiceKey(args[args.length - 1], "key_3033697e-6397-4cc6-9b04-8ec17af78cf1");
    exit(0);
  }
  if (args[0] !== "compose") {
    exit(99, "unexpected " + engine + " command: " + args.join(" "));
  }
  if (args[1] === "version") {
    exit(0);
  }
  const commandIndex = composeCommandIndex();
  if (commandIndex === -1) {
    exit(99, "missing compose command");
  }
  const command = args[commandIndex];
  if (command === "config") {
    if (engine === "podman" && args.includes("--format") && !podmanJsonConfig) {
      exit(2, "podman-compose: error: unrecognized arguments: --format json");
    }
    return delegateComposeConfig();
  }
  if (command === "build") {
    exit(0);
  }
  if (command === "up") {
    exit(0);
  }
  if (command === "ps") {
    const serviceNames = ["migrate", "bootstrap", "controller", "worker"];
    const requested = serviceNames.includes(args[args.length - 1])
      ? [args[args.length - 1]]
      : serviceNames;
    const entries = requested.map((service) => {
      let serviceState = "running";
      let exitCode = 0;
      let health = "";
      if (service === "migrate" || service === "bootstrap") {
        serviceState = "exited";
      }
      if (service === "bootstrap" && scenario === "bootstrap-failed") {
        exitCode = 1;
      }
      if (service === "controller") {
        health = "healthy";
      }
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
      stdout(
        JSON.stringify(
          entries.map((entry) => ({
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
          })),
        ) + "\n",
      );
    } else {
      stdout(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    }
    exit(0);
  }
  if (engine === "docker" && command === "cp") {
    writeServiceKey(args[args.length - 1], "key_3033697e-6397-4cc6-9b04-8ec17af78cf1");
    exit(0);
  }
  if (command === "exec") {
    exit(
      scenario === "worker-timeout" ? 42 : 0,
      scenario === "worker-timeout" ? "worker marker missing" : "",
    );
  }
  exit(99, "unhandled " + engine + " compose command: " + command);
}

// The project's bin/occ: `occ dev` is the real development CLI; any other command is the
// Installation API read dev-up makes after startup.
function projectOccCommand(fake, { args, env }, { stdout, stderr, exit }) {
  if (args[0] === "dev") {
    return `exec ${bashString(fake.cli)} "$@"`;
  }
  const log = env.DEV_UP_OCC_LOG;
  if (log) {
    appendFileSync(log, JSON.stringify({ args }) + "\n");
  }
  const scenario = env.DEV_UP_FAKE_SCENARIO || "success";
  if (scenario === "api-unauthorized") {
    const payload = {
      error: { code: "UNAUTHENTICATED", message: "A valid service API key is required." },
      meta: { requestId: "req_1" },
    };
    stderr(JSON.stringify(payload) + "\nHTTP 401\n");
    exit(1);
  }
  stdout(
    JSON.stringify({
      id: scenario === "api-mismatch" ? mismatchedInstallationId : matchingInstallationId,
    }) + "\n",
  );
  exit(0);
}

// The engine, k3d, kubectl and helm after prepareLifecycleCommands: inert cluster and
// image commands over a resource state file, logged to SAFETY_LOG.
function lifecycleCommand(fake, invocation, io) {
  const { command, args, env, cwd } = invocation;
  const { stdout, exit } = io;
  const { engine } = fake;
  const scenario = env.DEV_UP_LIFECYCLE_SCENARIO;
  const statePath = env.DEV_UP_RESOURCE_STATE;
  // Hold only the external command before an observable result: the real Go launcher
  // owns cancellation, rollback, and journal retention.
  if (
    scenario === "cancelled-creation" &&
    command === "k3d" &&
    args[0] === "cluster" &&
    args[1] === "create"
  ) {
    writeFileSync(join(fake.directory, "creation-started"), "dispatched");
    return hold;
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  const output = (value) => stdout(value + "\n");
  const fail = (message) => exit(77, message);
  appendFileSync(
    env.SAFETY_LOG,
    JSON.stringify({
      command,
      args,
      dockerHost: env.DOCKER_HOST || "",
      dockerContext: env.DOCKER_CONTEXT || "",
    }) + "\n",
  );
  // Podman records an unqualified local name under the `localhost` registry; Docker
  // keeps it as written. A name whose first component already names a registry is left
  // alone by both engines.
  const recordedTag = (name) => {
    if (engine !== "podman") {
      return name;
    }
    const first = name.split("/")[0];
    // Only a first component before a slash can name a registry; a bare `name:tag`
    // carries its tag there and is still unqualified.
    const qualified =
      name.includes("/") && (first === "localhost" || first.includes(".") || first.includes(":"));
    return qualified ? name : "localhost/" + name;
  };
  // containerd stores whatever reference was imported, so the node inventory reflects the
  // same qualification the engine applied.
  const importedTag = (name) => {
    if (engine === "podman") {
      return recordedTag(name);
    }
    return name.includes("/") ? "docker.io/" + name : "docker.io/library/" + name;
  };
  const serviceKeyFile = JSON.stringify({
    data: { id: "key_fixture", key: serviceKey },
    meta: { installationId: matchingInstallationId },
  });
  if (command === engine) {
    if (
      args[0] === "version" ||
      (args[0] === "compose" && (args.includes("config") || args[1] === "version"))
    ) {
      return engineCommand(fake, invocation, io);
    }
    if (args[0] === "context" && args[1] === "show") {
      output("fixture-context");
    } else if (args[0] === "context" && args[1] === "inspect") {
      output(
        JSON.stringify([{ Endpoints: { docker: { Host: "unix:///fixture/owned-docker.sock" } } }]),
      );
    } else if (args[0] === "info" && args.includes("{{.Host.RemoteSocket.Path}}")) {
      output("/fixture/owned-podman.sock");
    }
    // Kubernetes endpoint discovery reads the whole inventory; a local service reports
    // the host socket directly.
    else if (engine === "podman" && args[0] === "info" && args.includes("json")) {
      output(
        JSON.stringify({
          host: {
            serviceIsRemote: false,
            remoteSocket: { path: "unix:///fixture/owned-podman.sock", exists: true },
          },
        }),
      );
    } else if (args[0] === "info") {
      output("/var/lib/docker");
    } else if (args[0] === "network" && args[1] === "inspect" && args[2] === "k3d-occ-dev-owned") {
      output(
        JSON.stringify([
          {
            Name: "k3d-occ-dev-owned",
            IPAM: {
              Config: [
                { Subnet: "fd00:42::/64" },
                { Subnet: "172.30.42.0/24", Gateway: "172.30.42.1" },
              ],
            },
          },
        ]),
      );
    } else if (args[0] === "network" && args[1] === "inspect") {
      if (!state.compose) {
        exit(1);
      }
      output(JSON.stringify([{ IPAM: { Config: [{ Subnet: "172.30.41.0/24" }] } }]));
    } else if (
      args[0] === "image" &&
      args[1] === "inspect" &&
      args.includes("{{json .RepoTags}}")
    ) {
      output(JSON.stringify([recordedTag(args.at(-1))]));
    } else if (args[0] === "image" && args[1] === "inspect" && args.includes("--format")) {
      output("linux/amd64");
    } else if (args[0] === "image" && args[1] === "save") {
      writeFileSync(resolve(cwd, args[args.indexOf("--output") + 1]), "fixture image archive\n");
    } else if (
      args[0] === "image" &&
      args[1] === "inspect" &&
      args[2] === "openclaw-enterprise-controller:kubernetes-quickstart" &&
      env.DEV_UP_EXISTING_CONTROLLER_IMAGE === "1"
    ) {
      // An existing controller image.
    } else if (
      args[0] === "image" &&
      args[1] === "inspect" &&
      args[2] === "openclaw-enterprise-runtime:kubernetes-quickstart" &&
      env.DEV_UP_EXISTING_RUNTIME_IMAGE === "1"
    ) {
      // An existing runtime image.
    } else if (["volume", "network", "image"].includes(args[0]) && args[1] === "inspect") {
      exit(1);
    } else if (
      args[0] === "ps" ||
      (["volume", "network"].includes(args[0]) && args[1] === "ls") ||
      args[0] === "build" ||
      args[0] === "pull" ||
      args[0] === "tag" ||
      (args[0] === "image" && args[1] === "rm")
    ) {
      // Inert.
    } else if (args[0] === "inspect") {
      if (args.includes("{{.State.Status}}")) {
        output("exited");
      } else if (args.includes("{{.State.ExitCode}}")) {
        output("0");
      } else {
        fail("unexpected inspect: " + args.join(" "));
      }
    } else if (args[0] === "exec" && args[1].endsWith("-server-0") && args[2] === "nslookup") {
      // The launcher checks the new node's resolver before any image pull.
      if (scenario === "node-dns-refused") {
        fail(
          ";; connection timed out; no servers could be reached\nnslookup: write to '172.30.42.1': Connection refused",
        );
      }
      output("Name:\tregistry-1.docker.io\nAddress: 192.0.2.10");
    } else if (
      args[0] === "exec" &&
      args[1].endsWith("-server-0") &&
      args.slice(2, 5).join(" ") === "ip route get"
    ) {
      // The k3d API server reaches local Pods over the node's cni0 bridge.
      output(args[5] + " dev cni0 src 10.42.0.1 uid 0\n    cache");
    } else if (args[0] === "exec" && args.includes("images")) {
      if (args.includes("list")) {
        output(
          [
            ["openclaw-enterprise-runtime:kubernetes-quickstart", "a".repeat(64)],
            ["openclaw-enterprise-controller:kubernetes-quickstart", "b".repeat(64)],
            ["openclaw-development/import-b9b4e5950649:occ-dev-owned", "c".repeat(64)],
            [
              "openclaw-development/openshell-gateway:occ-dev-owned",
              "ca0bc15a045017ee20bfab682f1a561eca6e6c6ed7d021d20641da24aaa6dfb6",
            ],
            [
              "openclaw-development/openshell-sandbox:occ-dev-owned",
              "e9adf9ecde328122414ad2ee8c6fc5d5b389e4cf168daf4357c46f5a77d55851",
            ],
            [
              "openclaw-development/openshell-supervisor:occ-dev-owned",
              "fabcd01f656e9d23df4386f82e80b4f48b90f3452d7d5c58889007643a069161",
            ],
          ]
            .map(
              ([name, digest]) =>
                importedTag(name) + " application/vnd.oci.image.manifest.v1+json sha256:" + digest,
            )
            .join("\n"),
        );
      }
    } else if (args[0] === "cp") {
      writeFileSync(resolve(cwd, args.at(-1)), serviceKeyFile);
    } else if (args[0] === "compose") {
      if (args.includes("up")) {
        state.compose = true;
        save();
        if (scenario === "compose-up-failed") {
          fail("partial compose startup");
        }
      } else if (args.includes("down")) {
        if (scenario === "compose-down-failed") {
          fail("compose cleanup unavailable");
        }
        state.compose = false;
        save();
      } else if (args.includes("ps")) {
        output(args.at(-1) + "-container-id");
      } else if (!args.includes("exec") && !args.includes("logs") && !args.includes("stop")) {
        fail("unexpected compose: " + args.join(" "));
      }
    } else {
      fail("unexpected " + engine + ": " + args.join(" "));
    }
  } else if (command === "k3d") {
    if (args[0] === "cluster" && args[1] === "list") {
      output(JSON.stringify(state.clusters.map((name) => ({ name }))));
    } else if (args[0] === "cluster" && args[1] === "create") {
      state.clusters.push(args[2]);
      save();
      if (scenario === "cluster-create-failed") {
        fail("partial cluster creation");
      }
    } else if (args[0] === "cluster" && args[1] === "delete") {
      if (scenario === "cluster-delete-failed") {
        fail("cluster cleanup unavailable");
      }
      state.clusters = state.clusters.filter((name) => name !== args[2]);
      save();
    } else if (args[0] === "kubeconfig" && args[1] === "get") {
      output(
        JSON.stringify({
          apiVersion: "v1",
          kind: "Config",
          "current-context": "k3d-occ-dev-owned",
          contexts: [
            { name: "k3d-occ-dev-owned", context: { cluster: "k3d-occ-dev-owned", user: "admin" } },
          ],
          clusters: [
            {
              name: "k3d-occ-dev-owned",
              cluster: {
                server: "https://127.0.0.1:6443",
                "certificate-authority-data": "fixture-ca",
              },
            },
          ],
          users: [{ name: "admin", user: { token: "fixture-kubernetes-token" } }],
        }),
      );
    } else if (args[0] !== "image") {
      fail("unexpected k3d: " + args.join(" "));
    }
  } else if (command === "kubectl") {
    if (args.includes("get") && args.includes("--raw=/version")) {
      // Reachable.
    } else if (
      args[0] === "apply" ||
      args[0] === "rollout" ||
      args[0] === "create" ||
      args[0] === "patch"
    ) {
      // Inert.
    } else if (args[0] === "get" && args[1] === "node" && args[2].endsWith("-server-0")) {
      output(JSON.stringify({ spec: { podCIDR: "10.42.0.0/24" } }));
    } else if (args[0] === "get" && args[1] === "namespace") {
      output(JSON.stringify({ metadata: { name: args[2] } }));
    } else if (args[0] === "-n" && args.includes("wait")) {
      // Ready.
    } else if (args[0] === "-n" && args.includes("rollout")) {
      // Rolled out.
    } else if (args[0] === "-n" && args.includes("delete")) {
      // Deleted.
    } else if (args[0] === "-n" && args.includes("exec")) {
      output(serviceKeyFile);
    } else if (
      args[0] === "-n" &&
      args.includes("pod") &&
      args.includes("bootstrap-password-prepare")
    ) {
      output("Succeeded");
    } else if (args[0] === "-n" && args.includes("pod") && args.includes("postgres-0")) {
      output("10.42.0.20");
    } else if (
      args[0] === "-n" &&
      args.includes("endpoints") &&
      args.includes("kubernetes") &&
      args.includes("jsonpath={.subsets[0].ports[0].port}")
    ) {
      output("6443");
    } else if (args[0] === "-n" && args.includes("endpoints") && args.includes("kubernetes")) {
      output("172.30.42.3");
    } else if (args[0] === "get" && args[1] === "service" && args[2] === "kubernetes") {
      output(JSON.stringify({ spec: { clusterIP: "10.43.0.1" } }));
    } else if (
      args[0] === "get" &&
      args[1] === "service" &&
      args[2] === "openshell-gateway" &&
      args.includes("jsonpath={.spec.clusterIP}")
    ) {
      output("10.43.0.50");
    } else if (args[0] === "get" && args[1] === "endpoints" && args[2] === "kubernetes") {
      output(JSON.stringify({ subsets: [{ addresses: [{ ip: "172.30.41.4" }] }] }));
    } else if (args[0] === "get" && args[1] === "namespaces") {
      output(
        JSON.stringify({
          items: [
            {
              metadata: {
                name: "oce-123456789012345",
                labels: { "openclaw.dev/namespace": "namespace_fixture" },
                annotations: { "openclaw.dev/namespace-id": "namespace_fixture" },
              },
            },
          ],
        }),
      );
    } else if (
      args[0] === "get" &&
      args[1] === "service" &&
      args.includes("jsonpath={.spec.ports[0].nodePort}")
    ) {
      output("30051");
    } else {
      fail("unexpected kubectl: " + args.join(" "));
    }
  } else if (command === "helm") {
    if ((args[0] === "show" && args[1] === "chart") || args[0] === "upgrade") {
      // Inert.
    } else if (args[0] === "template") {
      output(
        [
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
        ].join("\n"),
      );
    } else {
      fail("unexpected helm: " + args.join(" "));
    }
  }
}

function fakeCommand(fake, invocation, io) {
  const { command } = invocation;
  return runFake(io, async (output) => {
    if (fake.lifecycle && [fake.engine, "k3d", "kubectl", "helm"].includes(command)) {
      return lifecycleCommand(fake, invocation, output);
    }
    if (command === fake.engine) {
      return engineCommand(fake, invocation, output);
    }
    if (command === "occ") {
      return projectOccCommand(fake, invocation, output);
    }
    if (command === "yq") {
      if (invocation.args.includes("--version")) {
        output.stdout("yq version v4.53.6\n");
      } else {
        output.stdout(await output.readInput());
      }
      return;
    }
    if (command === "uname") {
      output.stdout(`${fake.options.macosPodmanMachine === undefined ? "Linux" : "Darwin"}\n`);
      return;
    }
    throw new Error("Unexpected external command: " + command);
  });
}

// A fake command answered by the fixture's server; it holds the server's tokens, so it
// is private to this user.
async function writeFakeCommand(fake, path, command) {
  const { port, clientToken, serverToken } = fake.server;
  await writeFile(
    path,
    commandShim({
      bash: bashExecutable,
      sleep: commandPath("sleep") || "/bin/sleep",
      setsid: commandPath("setsid") || "/usr/bin/setsid",
      port,
      clientToken,
      serverToken,
      command,
      forwardedEnv,
    }),
    { mode: 0o700 },
  );
}

async function createFixture(t, options = {}) {
  const directory = await temporaryDirectory(t, "openclaw-dev-up-");

  const fixtureRepository = join(directory, "repository");
  await mkdir(join(fixtureRepository, "scripts"), { recursive: true });
  await mkdir(join(fixtureRepository, "bin"), { recursive: true });
  await mkdir(join(fixtureRepository, "deploy/runtime"), { recursive: true });
  await copyFile(
    join(repository, "deploy/runtime/openclaw-source.json"),
    join(fixtureRepository, "deploy/runtime/openclaw-source.json"),
  );
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
  const provider = (configurationProvider ??= composeConfigurationProvider());
  const cli = await developmentCli();
  const fake = { directory, engine, options, cli, lifecycle: false };
  fake.server = await startCommandServer({
    forwardedEnv,
    handle: ({ command, args, env, cwd, io }) => fakeCommand(fake, { command, args, env, cwd }, io),
  });
  t.after(() => fake.server.close());

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
    await writeFakeCommand(fake, join(bin, "yq"), "yq");
  }

  await writeFakeCommand(fake, join(bin, engine), engine);
  if (engine === "podman" && options.dockerAlias === true) {
    await symlink("podman", join(bin, "docker"));
  }
  if (engine === "podman") {
    await writeFakeCommand(fake, join(bin, "uname"), "uname");
    await symlink("podman", join(bin, "podman-compose"));
  }
  await writeFakeCommand(fake, join(fixtureRepository, "bin", "occ"), "occ");
  await writeExecutable(
    join(bin, "occ"),
    `#!/bin/sh
echo "dev-up invoked occ from PATH instead of the project bin directory" >&2
exit 86
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

  const fixture = {
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
  fakes.set(fixture, fake);
  return fixture;
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
  const fake = fakes.get(fixture);
  assert.equal(engine, fake.engine, "the lifecycle commands use the fixture's engine");
  fake.lifecycle = true;
  for (const command of ["k3d", "kubectl", "helm"]) {
    await writeFakeCommand(fake, join(bin, command), command);
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

// Like spawnSync with encoding utf8 (status, signal, stdout, stderr, and error on a
// failed start or timeout), but without blocking this process: its command server must
// answer the fake commands the program runs.
function runCommand(command, args, { cwd, env, timeout } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let error;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            error = Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), {
              code: "ETIMEDOUT",
            });
            child.kill("SIGTERM");
          }, timeout);
    child.once("error", (spawnError) => {
      error ??= spawnError;
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr, error });
    });
  });
}

function runDevUp(args, env) {
  return runCommand(bashExecutable, ["scripts/dev-up", ...args], {
    cwd: env.DEV_UP_FIXTURE_REPOSITORY,
    env,
  });
}

function runDevDown(env) {
  return runCommand(bashExecutable, ["scripts/dev-down"], {
    cwd: env.DEV_UP_FIXTURE_REPOSITORY,
    env,
  });
}

// A dev-up log the fixture may not have written yet: a missing file is no records, and blank
// lines are skipped.
function readJsonLines(path) {
  return readJsonLinesFile(path, { missingOk: true, skipBlank: true });
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
  runCommand,
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
  runDevDown,
  runDevUp,
  serviceKey,
};
