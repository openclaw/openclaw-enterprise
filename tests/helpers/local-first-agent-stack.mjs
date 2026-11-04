import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(root, "bin", "occ");
const minute = 60_000;
const phases = [
  ["Creating Kubernetes-only k3d cluster", "Kubernetes cluster"],
  ["Installing OCE in Namespace", "database and control plane"],
  ["OpenClaw Enterprise development stack is ready.", "ready"],
];

const setupPoints = [
  ["Starting the Compose database, migration, and bootstrap services", "database-start"],
  ["Creating k3d cluster", "cluster-start"],
  ["Creating Kubernetes-only k3d cluster", "cluster-start"],
  ["Importing the controller and PostgreSQL images", "controller-images-start"],
  ["Installing pinned private routing", "routing-start"],
  ["Verifying Kubernetes network isolation", "network-check-start"],
  ["Preparing pinned OpenShell development assets", "openshell-assets-start"],
  ["Installing the deployment OpenShell gateway", "openshell-gateway-start"],
  ["Installing OpenShell Gateway and OCE in Namespace", "platform-start"],
  ["Starting the Compose controller and Kubernetes worker", "controller-start"],
  ["Verifying the initial gateway Namespace network isolation", "namespace-check-start"],
  ["OpenClaw Enterprise development stack is ready.", "ready"],
];

// Register before Local Setup's teardown. A cancelled Node subtest can settle
// before its async body, so retain the actual operations until their work stops.
export function ownFirstAgentWork(context) {
  const operations = [];
  context.after(async () => {
    await Promise.allSettled(operations);
  });
  return (operation) => {
    operations.push(operation);
    return operation;
  };
}

// The reporter retains only fixed stage names, outcome and elapsed time.
export async function measureFirstAgentStage(context, stage, operation) {
  const started = performance.now();
  let outcome = "failed";
  try {
    const result = await operation();
    outcome = "passed";
    return result;
  } finally {
    context.diagnostic(
      `openclaw-ci-measurement ${JSON.stringify({
        kind: "local-first-agent",
        stage,
        outcome,
        elapsedMs: Math.round(performance.now() - started),
      })}`,
    );
  }
}

function withoutModelCredentials(environment) {
  const result = { ...environment };
  delete result.OPENAI_API_KEY;
  delete result.OPENAI_API_KEY_FILE;
  delete result.CODEX_ACCESS_TOKEN;
  delete result.CODEX_ACCESS_TOKEN_FILE;
  return result;
}

function killGroup(child, signal) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The command may have already exited or failed before obtaining a process group.
    }
  }
  child.kill(signal);
}

function run(
  command,
  args,
  environment,
  label,
  timeout,
  collect = false,
  context,
  timingPhase = "setup",
) {
  const started = performance.now();
  const observed = new Set();
  const commands = new Map();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let outputSize = 0;
    let phase;
    let timedOut = false;
    let spawnCode;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 5_000);
      killTimer.unref();
    }, timeout);
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      let partial = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (collect && index === 0) {
          outputSize += Buffer.byteLength(chunk);
          if (outputSize <= 4 * 1024 * 1024) {
            output.push(chunk);
          }
        }
        partial += chunk;
        const lines = partial.split("\n");
        partial = lines.pop().slice(-4_096);
        for (const line of lines) {
          const timing =
            context &&
            /^\[occ-dev-timing\] stage=([a-z0-9-]+) elapsed_ms=([0-9]+) failed=(true|false)$/.exec(
              line,
            );
          if (timing) {
            const total = commands.get(timing[1]) ?? { count: 0, elapsedMs: 0, failed: 0 };
            total.count++;
            total.elapsedMs += Number(timing[2]);
            total.failed += Number(timing[3] === "true");
            commands.set(timing[1], total);
          }
          const known = phases.find(([prefix]) => line.startsWith(prefix));
          if (known) {
            phase = known[1];
          }
          const point = context && setupPoints.find(([prefix]) => line.startsWith(prefix));
          if (point && !observed.has(point[1])) {
            observed.add(point[1]);
            context.diagnostic(
              "openclaw-ci-measurement " +
                JSON.stringify({
                  kind: "local-first-agent-setup-point",
                  stage: point[1],
                  elapsedMs: Math.round(performance.now() - started),
                }),
            );
          }
        }
      });
    }
    child.once("error", (error) => {
      if (/^[A-Z0-9_]+$/.test(error.code ?? "")) {
        spawnCode = error.code;
      } else {
        spawnCode = "SPAWN_ERROR";
      }
    });
    child.once("close", (code, signal) => {
      for (const [stage, total] of commands) {
        context.diagnostic(
          "openclaw-ci-measurement " +
            JSON.stringify({
              kind: "local-first-agent-command",
              phase: timingPhase,
              stage,
              ...total,
            }),
        );
      }
      clearTimeout(timer);
      if (!timedOut && killTimer) {
        clearTimeout(killTimer);
      }
      if (!timedOut && !spawnCode && code === 0 && outputSize <= 4 * 1024 * 1024) {
        resolve(output.join(""));
        return;
      }
      const status = timedOut
        ? "timed out"
        : spawnCode
          ? "could not start (" + spawnCode + ")"
          : outputSize > 4 * 1024 * 1024
            ? "exceeded the output limit"
            : "exited with " +
              (Number.isInteger(code)
                ? "status " + code
                : /^SIG[A-Z0-9]+$/.test(signal ?? "")
                  ? signal
                  : "an unknown signal");
      const progress = phase ? "; last stage: " + phase : "";
      // Raw output is never included: Compose and bootstrap can emit credentials.
      reject(new Error(label + " " + status + progress + "; raw output withheld."));
    });
  });
}

async function privatePath(path, directory = false) {
  const info = await lstat(path);
  return (
    info.uid === process.geteuid?.() &&
    (info.mode & 0o077) === 0 &&
    (directory ? info.isDirectory() : info.isFile())
  );
}

async function recordedStack(directory, sandboxDriver) {
  if (!directory || !isAbsolute(directory)) {
    return undefined;
  }
  try {
    if ((await realpath(directory)) !== directory || !(await privatePath(directory, true))) {
      return undefined;
    }
    for (const name of [".openclaw-development", "state.json", "kubeconfig"]) {
      if (!(await privatePath(join(directory, name)))) {
        return undefined;
      }
    }
    if (
      (await readFile(join(directory, ".openclaw-development"), "utf8")) !==
      "openclaw-enterprise-development-v3\n"
    ) {
      return undefined;
    }
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    if (
      state.version !== 3 ||
      state.computeDriver !== "kubernetes" ||
      state.sandboxDriver !== sandboxDriver ||
      !["docker", "podman"].includes(state.containerEngine) ||
      !["", undefined, "k3d"].includes(state.deploymentMode) ||
      (state.deploymentMode === "k3d"
        ? state.composeProject !== "" ||
          !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(state.platformNamespace ?? "") ||
          !Number.isInteger(state.apiPort) ||
          state.apiPort < 1 ||
          state.apiPort > 65535
        : !/^[a-z0-9][a-z0-9_-]*$/.test(state.composeProject ?? "") ||
          !(await privatePath(join(directory, "compose.yaml")))) ||
      !/^occ-dev-[a-z0-9][a-z0-9-]*$/.test(state.cluster ?? "") ||
      typeof state.dockerHost !== "string" ||
      !state.dockerHost.startsWith("unix:///") ||
      typeof state.repository !== "string" ||
      !isAbsolute(state.repository) ||
      (await realpath(state.repository)) !== (await realpath(root)) ||
      typeof state.keyPath !== "string" ||
      !isAbsolute(state.keyPath) ||
      (state.keyOwned && state.keyPath !== join(directory, "initial-admin-service-key.json")) ||
      !(await privatePath(state.keyPath))
    ) {
      return undefined;
    }
    return state;
  } catch {
    return undefined;
  }
}

function loopbackOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    ) {
      return url.origin;
    }
  } catch {
    // Report only the fixed error; the supplied value could contain credentials.
  }
  throw new Error("The existing Local Setup must expose one explicit loopback HTTP port.");
}

async function existingOrigin(directory, state, environment) {
  if (environment.OCC_URL) {
    return loopbackOrigin(environment.OCC_URL);
  }
  if (state.deploymentMode === "k3d") {
    return loopbackOrigin(`http://127.0.0.1:${state.apiPort}`);
  }
  const subprocessEnvironment = withoutModelCredentials({
    ...environment,
    COMPOSE_DISABLE_ENV_FILE: "1",
    DOCKER_HOST: state.dockerHost,
  });
  if (state.containerEngine === "podman") {
    subprocessEnvironment.PODMAN_COMPOSE_PROVIDER ||= "podman-compose";
  }
  const result = await run(
    state.containerEngine,
    [
      "compose",
      "--project-directory",
      state.repository,
      "--project-name",
      state.composeProject,
      "-f",
      join(directory, "compose.yaml"),
      "port",
      "controller",
      "3000",
    ],
    subprocessEnvironment,
    "Read existing Local Setup controller port",
    minute,
    true,
  );
  return loopbackOrigin("http://" + result.trim());
}

async function availablePorts() {
  const servers = [];
  try {
    const ports = [];
    for (let index = 0; index < 3; index++) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, resolve);
      });
      servers.push(server);
      ports.push(server.address().port);
    }
    return ports;
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(() => resolve()))),
    );
  }
}

export async function localFirstAgentStack(context) {
  if (process.env.OCC_TEST_LOCAL_FIRST_AGENT_REAL !== "1") {
    throw new Error("The protected local first-Agent test must be explicitly enabled.");
  }
  const testEnvironment = { ...process.env };
  const sandboxDriver = process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER ?? "none";
  if (!["none", "openshell"].includes(sandboxDriver)) {
    throw new Error("OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER must be none or openshell.");
  }
  if (!testEnvironment.OPENCLAW_FIRST_AGENT_MODEL && testEnvironment.OCC_TEST_OPENAI_MODEL) {
    testEnvironment.OPENCLAW_FIRST_AGENT_MODEL = testEnvironment.OCC_TEST_OPENAI_MODEL;
  }
  const selected = process.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const existing = await recordedStack(selected, sandboxDriver);
  if (existing) {
    return {
      directory: selected,
      environment: {
        ...testEnvironment,
        OCC_URL: await existingOrigin(selected, existing, testEnvironment),
      },
    };
  }
  if (selected !== undefined) {
    throw new Error(
      "OCC_DEVELOPMENT_STATE_DIRECTORY must select valid Kubernetes Local Setup state for this checkout.",
    );
  }
  const credentialVariable =
    sandboxDriver === "openshell" ? "CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY";
  if (!process.env[credentialVariable]?.trim()) {
    throw new Error(
      `${credentialVariable} is required to provision the protected local first-Agent test.`,
    );
  }
  const safe = withoutModelCredentials({ ...testEnvironment, COMPOSE_DISABLE_ENV_FILE: "1" });
  try {
    await access(cli, constants.X_OK);
  } catch {
    await mkdir(dirname(cli), { recursive: true });
    await run(
      "go",
      ["build", "-trimpath", "-o", "bin/occ", "./cmd/occ"],
      safe,
      "Build occ",
      2 * minute,
    );
  }
  const [controller, kubernetes, browser] = await availablePorts();
  // k3d rejects cluster names longer than 32 characters; the prefix below uses 20.
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const directory = join(await realpath("/tmp"), "occ-first-agent-" + suffix);
  // OpenShell proofs run against either development control plane; Compose remains its
  // default because the first OpenShell first-Agent proof used it.
  const controlPlane =
    process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE ??
    (sandboxDriver === "openshell" ? "compose" : "kubernetes");
  if (!["compose", "kubernetes"].includes(controlPlane)) {
    throw new Error("OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE must be compose or kubernetes.");
  }
  const environment = {
    ...testEnvironment,
    COMPOSE_DISABLE_ENV_FILE: "1",
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_CONTROL_PLANE: controlPlane,
    OCC_DEVELOPMENT_COMPOSE_PROJECT: "occ_first_agent_" + suffix,
    OCC_DEVELOPMENT_SANDBOX_DRIVER: sandboxDriver,
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
    OCC_DEVELOPMENT_STATE_DIRECTORY: directory,
    OCC_DEVELOPMENT_KUBERNETES_CLUSTER: "occ-dev-first-agent-" + suffix,
    OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetes),
    OCC_DEVELOPMENT_BROWSER_PORT: String(browser),
    OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
    OPENCLAW_DEV_PORT: String(controller),
    OCC_SERVICE_KEY_FILE: join(directory, "initial-admin-service-key.json"),
    OCC_URL: "http://127.0.0.1:" + controller,
  };
  const subprocessEnvironment = withoutModelCredentials(environment);
  const startupArguments = ["dev", "up"];
  if (sandboxDriver === "openshell") {
    // Exercise the public startup input before the regular Agent workflow.
    // The policy file is separate from dev-owned state and stays keyless.
    const policyFile = `${directory}-network-policy.yaml`;
    await writeFile(
      policyFile,
      "networkPolicies:\n  - name: python-web\n    binaries:\n      - path: /usr/bin/python3.11\n    endpoints:\n      - host: example.com\n        ports: [443]\n        tls: skip\n",
      { mode: 0o600, flag: "wx" },
    );
    context.after(() => rm(policyFile, { force: true }));
    startupArguments.push("--sandbox-network-policy-file", policyFile);
  }
  const buildRevision = environment.OCC_TEST_LOCAL_FIRST_AGENT_BUILD_REVISION;
  if (buildRevision !== undefined) {
    if (
      controlPlane !== "compose" ||
      !/^[a-f0-9]{40}$/.test(buildRevision) ||
      !environment.BUILDX_BUILDER
    ) {
      throw new Error("Invalid prepared Compose build selection.");
    }
    const buildFile = `${directory}-build.json`;
    await writeFile(
      buildFile,
      JSON.stringify({
        services: Object.fromEntries(
          ["migrate", "bootstrap", "controller", "worker-kubernetes", "browser-proxy"].map(
            (service) => [
              service,
              { build: { args: { SOURCE_DATE_EPOCH: "0", OCC_BUILD_REVISION: buildRevision } } },
            ],
          ),
        ),
      }),
      { mode: 0o600, flag: "wx" },
    );
    context.after(() => rm(buildFile, { force: true }));
    startupArguments.push("--", "-f", buildFile);
  }
  let initializationAttempted = false;
  context.after(async () => {
    if (!initializationAttempted) {
      return;
    }
    try {
      await measureFirstAgentStage(context, "cleanup", () =>
        run(
          cli,
          ["dev", "down"],
          subprocessEnvironment,
          "Stop Local Setup",
          4 * minute,
          false,
          context,
          "cleanup",
        ),
      );
    } catch (error) {
      try {
        await lstat(directory);
      } catch (stateError) {
        if (stateError.code === "ENOENT") {
          return;
        }
      }
      throw error;
    }
  });
  initializationAttempted = true;
  await measureFirstAgentStage(context, "setup", () =>
    run(
      cli,
      startupArguments,
      subprocessEnvironment,
      "Start Local Setup",
      18 * minute,
      false,
      context,
    ),
  );
  return { directory, environment };
}
