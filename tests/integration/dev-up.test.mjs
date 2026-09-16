import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
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
} from "../helpers/dev-up.mjs";

test("dev-up builds the default runtime only when real Compose leaves runtime images unselected", async (t) => {
  const fixture = await createFixture(t);
  const keyDirectory = join(fixture.directory, "private key directory");
  await mkdir(keyDirectory, { mode: 0o700 });
  const keyOutput = join(keyDirectory, "service-key.json");
  const options = composeOptions(fixture);

  const result = runDevUp(["--key-output", keyOutput, "--", ...options], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
  assert.match(
    result.stdout,
    /OCC_DEVELOPMENT_COMPUTE_DRIVER=docker OCC_DEVELOPMENT_CONTAINER_ENGINE=docker scripts\/dev-down/,
  );
  assert.ok(result.stdout.includes("API URL: http://127.0.0.1:3000"));
  assert.ok(result.stdout.includes(`Installation ID: ${matchingInstallationId}`));
  assert.ok(result.stdout.includes(`Service key file: ${keyOutput}`));
  assert.ok(result.stdout.includes(`OCC_SERVICE_KEY_FILE=${keyOutput.replaceAll(" ", "\\ ")}`));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));

  const outputMode = (await stat(keyOutput)).mode & 0o777;
  assert.equal(outputMode & 0o077, 0);

  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === `image inspect ${defaultRuntimeImage}`),
  );
  assert.ok(
    dockerLogs.some(
      (entry) =>
        entry.args.join(" ") ===
        `build -f deploy/runtime/Dockerfile --tag ${defaultRuntimeImage} deploy/runtime`,
    ),
  );
  assert.ok(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "compose" &&
        entry.args.includes("config") &&
        entry.args.includes("--format") &&
        entry.args.includes("json"),
    ),
  );
  assert.ok(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "compose" &&
        entry.args.includes("up") &&
        entry.args.includes("--build") &&
        entry.args.includes("-d") &&
        entry.env.OCC_DOCKER_RUNTIME_IMAGE === defaultRuntimeImage,
    ),
  );
  assert.ok(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "compose" &&
        entry.args.includes("exec") &&
        entry.args.includes("worker") &&
        entry.args.includes("scripts/production-healthcheck.mjs") &&
        entry.args.at(-1) === "ready",
    ),
  );
  for (const invocation of composeInvocations(dockerLogs)) {
    assert.deepEqual(invocation.args.slice(1, 1 + options.length), options);
  }

  const curlLogs = await readJsonLines(fixture.curlLog);
  assert.equal(curlLogs.length, 1);
  assert.ok(curlLogs[0].args.includes("http://127.0.0.1:3000/installation"));
  assert.doesNotMatch(JSON.stringify(curlLogs), new RegExp(serviceKey));
});

test("dev-up preserves a selected custom runtime image and skips the quickstart build", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "custom-service-key.json");
  const env = { ...fixture.env, OPENCLAW_DEV_PORT: "4137" };
  const override = await customRuntimeOverride(fixture);
  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture, override)],
    env,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /API URL: http:\/\/127\.0\.0\.1:4137/);
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === "image inspect custom-runtime:local"),
  );
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "build"),
    false,
  );
  assert.equal(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "compose" &&
        entry.args.includes("up") &&
        entry.env.OCC_DOCKER_RUNTIME_IMAGE === defaultRuntimeImage,
    ),
    false,
  );
});

test("dev-up applies per-image overrides on top of the shared runtime image", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "mixed-runtime-service-key.json");
  const override = await perImageOverride(fixture);

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture, override)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr);
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === "image inspect custom-gateway:local"),
  );
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === "image inspect shared-runtime:local"),
  );
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "build"),
    false,
  );
});

test("dev-up rejects a public controller port rendered by real Compose", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "public-controller-key.json");
  const override = await publicControllerOverride(fixture);

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture, override)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /configuration failed: Compose controller port must publish only on loopback/,
  );
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "compose" && entry.args.includes("up")),
    false,
  );
});

test("dev-up refuses an existing key destination before invoking Compose", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "existing-service-key.json");
  await writeFile(keyOutput, "keep-existing\n", { mode: 0o600 });

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /key output failed: destination already exists/);
  assert.equal(await readFile(keyOutput, "utf8"), "keep-existing\n");
  assert.equal((await readJsonLines(fixture.dockerLog)).length, 0);
});

test("dev-up fails closed when bootstrap exits unsuccessfully", async (t) => {
  const fixture = await createFixture(t, { scenario: "bootstrap-failed" });
  const keyOutput = join(fixture.directory, "bootstrap-failure-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /startup failed: bootstrap exited with 1/);
  assert.match(result.stderr, /diagnostic: docker compose .* ps --all bootstrap/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "compose" && entry.args.includes("cp")),
    false,
  );
  assert.equal((await readJsonLines(fixture.curlLog)).length, 0);
});

test("dev-up fails closed when the worker exits before readiness", async (t) => {
  const fixture = await createFixture(t, { scenario: "worker-exited" });
  const keyOutput = join(fixture.directory, "readiness-failure-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /startup failed: worker exited with 1/);
  assert.match(result.stderr, /diagnostic: docker compose .* logs worker/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "compose" && entry.args.includes("cp")),
    false,
  );
});

test("dev-up preserves a copied key when the authenticated installation check is rejected", async (t) => {
  const fixture = await createFixture(t, { scenario: "api-unauthorized" });
  const keyOutput = join(fixture.directory, "unauthorized-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /authorization failed: scripts\/occ-api could not read \/installation/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  assert.match(await readFile(keyOutput, "utf8"), new RegExp(serviceKey));
});

test("dev-up rejects an authenticated installation response for a different Installation", async (t) => {
  const fixture = await createFixture(t, { scenario: "api-mismatch" });
  const keyOutput = join(fixture.directory, "mismatch-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`Installation ID mismatch.*${mismatchedInstallationId}`));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  assert.match(await readFile(keyOutput, "utf8"), new RegExp(serviceKey));
});

test("dev-up selects Podman when no docker command exists and completes the supported lifecycle", async (t) => {
  // The isolated fixture PATH deliberately contains no docker executable, proving Podman is
  // selected directly rather than through an operator-provided Docker compatibility alias.
  const fixture = await createFixture(t, { engine: "podman" });
  const keyOutput = join(fixture.directory, "podman-service-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "dev-up did not exit");
  assert.match(result.stdout, /Container engine: Podman/);
  assert.match(
    result.stdout,
    /Cleanup:\n  env OCC_DEVELOPMENT_COMPUTE_DRIVER=docker OCC_DEVELOPMENT_CONTAINER_ENGINE=podman scripts\/dev-down -- /,
  );
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  assert.match(await readFile(keyOutput, "utf8"), new RegExp(serviceKey));

  const invocations = await readJsonLines(fixture.podmanLog);
  assert.ok(invocations.some((entry) => entry.args[0] === "info"));
  assert.ok(
    invocations.some(
      (entry) =>
        entry.args.includes("up") &&
        entry.args.includes("--no-build") &&
        entry.env.PODMAN_COMPOSE_PROVIDER.endsWith("/podman-compose") &&
        entry.env.OCC_CONTAINER_ENGINE_SOCKET === "/run/user/501/podman/podman.sock",
    ),
  );
  assert.ok(
    invocations.some(
      (entry) =>
        entry.args.includes("build") &&
        entry.args.at(-1) === "migrate" &&
        entry.args.some((argument) => argument.endsWith("/compose.podman.yaml")),
    ),
    "Podman must build the shared application image once before starting services",
  );
  assert.ok(
    invocations.some(
      (entry) =>
        entry.args.includes("config") &&
        entry.args.some((argument) => argument.endsWith("/compose.podman.yaml")) &&
        !entry.args.includes("--format") &&
        !entry.args.includes("json"),
    ),
  );
  assert.ok(
    invocations.some((entry) => entry.args.includes("ps") && !entry.args.includes("--all")),
  );
  assert.ok(
    invocations.some(
      (entry) =>
        entry.args[0] === "cp" &&
        entry.args[1] ===
          "bootstrap-container-id:/var/lib/openclaw/bootstrap/initial-admin-service-key.json",
    ),
  );
  assert.equal(await readJsonLines(fixture.dockerLog).then((entries) => entries.length), 0);
});

test("dev-up starts Podman without Compose options on Bash 3.2", async (t) => {
  // The documented no-options invocation must not trip nounset on an empty Bash array.
  const fixture = await createFixture(t, { engine: "podman" });
  const keyOutput = join(fixture.directory, "podman-no-options-service-key.json");

  const result = runDevUp(["--key-output", keyOutput], fixture.env);

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "dev-up did not exit");
  assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
  assert.match(result.stdout, /Container engine: Podman/);
});

test("dev-up preserves Compose files selected through COMPOSE_FILE for Podman", async (t) => {
  // A security override selected through the environment must participate in validation.
  const fixture = await createFixture(t, { engine: "podman" });
  const keyOutput = join(fixture.directory, "podman-compose-file-service-key.json");
  const override = await publicControllerOverride(fixture);
  const env = {
    ...fixture.env,
    COMPOSE_FILE: ["compose.yaml", override].join(delimiter),
  };

  const result = runDevUp(
    ["--key-output", keyOutput, "--", "--project-name", "oce-dev-up-compose-file-test"],
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /configuration failed: Compose controller port must publish only on loopback/,
  );
  const invocations = await readJsonLines(fixture.podmanLog);
  assert.equal(
    invocations.some((entry) => entry.args.includes("up")),
    false,
  );
});

test("dev-up recognizes a docker command backed by Podman and uses the Podman path", async (t) => {
  // Podman can install a docker compatibility symlink whose version text does not identify
  // Podman. Selection must follow supported Compose behavior instead of the executable name.
  const fixture = await createFixture(t, { engine: "podman", dockerAlias: true });
  const keyOutput = join(fixture.directory, "podman-alias-service-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Container engine: Podman/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
});

test("dev-up recognizes a JSON-capable Docker CLI connected to Podman", async (t) => {
  // Podman's Docker-compatible API can provide DockerRootDir while Compose delegates to Docker
  // Compose, so those capabilities cannot by themselves prove the server is Docker Engine.
  const fixture = await createFixture(t, {
    engine: "podman",
    dockerAlias: true,
    podmanDockerApi: true,
    podmanJsonConfig: true,
  });
  const keyOutput = join(fixture.directory, "podman-json-alias-service-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Container engine: Podman/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
});

test("dev-up rejects the Docker Fluentd logging override when Podman is selected", async (t) => {
  const fixture = await createFixture(t, { engine: "podman" });
  const keyOutput = join(fixture.directory, "podman-logging-service-key.json");
  const options = composeOptions(fixture);
  options.splice(4, 0, "-f", "compose.logging.yaml");

  const result = runDevUp(["--key-output", keyOutput, "--", ...options], fixture.env);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /configuration failed: Docker Fluentd logging is not supported with Podman/,
  );
  const invocations = await readJsonLines(fixture.podmanLog);
  assert.equal(
    invocations.some((entry) => entry.args.includes("up")),
    false,
  );
});

test("dev-up rejects a public controller port rendered by Podman Compose", async (t) => {
  // Podman Compose emits short port strings instead of Docker Compose's resolved objects;
  // the same loopback-only security boundary must be enforced for both representations.
  const fixture = await createFixture(t, { engine: "podman" });
  const keyOutput = join(fixture.directory, "podman-public-controller-key.json");
  const override = await publicControllerOverride(fixture);

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture, override)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /configuration failed: Compose controller port must publish only on loopback/,
  );
  const invocations = await readJsonLines(fixture.podmanLog);
  assert.equal(
    invocations.some((entry) => entry.args.includes("up")),
    false,
  );
});

test("dev-up honors an explicitly selected Docker Engine", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "selected-docker-service-key.json");

  const result = runDevUp(["--key-output", keyOutput], {
    ...fixture.env,
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Container engine: Docker/);
});

test("dev-up rejects an unsupported development selector before startup", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "invalid-selector-service-key.json");

  const result = runDevUp(["--key-output", keyOutput], {
    ...fixture.env,
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "containerd",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OCC_DEVELOPMENT_CONTAINER_ENGINE must be auto, docker, or podman/);
  const invocations = await readJsonLines(fixture.dockerLog);
  assert.equal(
    invocations.some((entry) => entry.args.includes("up")),
    false,
  );
});

test("dev-up routes Kubernetes Compute through the unified entry point", () => {
  const result = runDevUp(["--help"], {
    ...process.env,
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /usage: scripts\/dev-up/);
});

// Engine commands are inert here; config delegates to the real Compose renderer.
async function prepareSafetyCommands(fixture) {
  const bin = join(fixture.directory, "bin");
  await rename(join(bin, "docker"), join(bin, "docker-config"));
  for (const command of ["docker", "k3d", "kubectl"]) {
    await writeFile(
      join(bin, command),
      `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const command = ${JSON.stringify(command)};
fs.appendFileSync(process.env.SAFETY_LOG, JSON.stringify({ command, args }) + "\\n");
if (command === "docker" && (args[0] === "version" || (args[0] === "compose" && (args.includes("config") || args[1] === "version")))) {
  const result = spawnSync(${JSON.stringify(join(bin, "docker-config"))}, args, { env: process.env, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (command === "k3d" && args[0] === "cluster" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ name: "occ-dev-owned" }, { name: "occ-dev-unrelated" }]));
}
if (command === "docker" && args.includes("inspect")) process.exit(1);
if (command === "docker" && args.includes("up")) process.exit(77);
`,
      { mode: 0o755 },
    );
  }
  fixture.env.SAFETY_LOG = join(fixture.directory, "safety.log");
  fixture.env.OCC_DEVELOPMENT_CONTAINER_ENGINE = "docker";
}

async function writeKubernetesState(fixture) {
  const directory = join(fixture.directory, "kubernetes state");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, ".openclaw-development"), "openclaw-enterprise-development-v1\n");
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      version: 1,
      computeDriver: "kubernetes",
      containerEngine: "docker",
      composeProject: "owned-kubernetes",
      composeArgs: ["--env-file", fixture.emptyEnv],
      cluster: "occ-dev-owned",
      dockerHost: "",
      keyPath: join(directory, "initial-admin-service-key.json"),
      keyOwned: true,
    }),
    { mode: 0o600 },
  );
  return directory;
}

test("dev-down selects Docker explicitly and by default without deleting Kubernetes state", async (t) => {
  for (const driver of ["docker", ""]) {
    const fixture = await createFixture(t);
    await prepareSafetyCommands(fixture);
    const stateDirectory = await writeKubernetesState(fixture);
    const result = spawnSync("/bin/bash", ["scripts/dev-down"], {
      encoding: "utf8",
      env: {
        ...fixture.env,
        OCC_DEVELOPMENT_COMPUTE_DRIVER: driver,
        OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await stat(stateDirectory)).isDirectory());
    const commands = await readJsonLines(fixture.env.SAFETY_LOG);
    assert.deepEqual(commands, [{ command: "docker", args: ["compose", "down"] }]);
  }
});

test("dev-down requires Kubernetes state and cleans only its recorded resources", async (t) => {
  const fixture = await createFixture(t);
  await prepareSafetyCommands(fixture);
  const stateDirectory = await writeKubernetesState(fixture);
  const env = {
    ...fixture.env,
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
  };
  const result = spawnSync("/bin/bash", ["scripts/dev-down"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
  const commands = await readJsonLines(fixture.env.SAFETY_LOG);
  assert.deepEqual(
    commands.filter((entry) => entry.command === "k3d"),
    [
      { command: "k3d", args: ["cluster", "list", "-o", "json"] },
      { command: "k3d", args: ["cluster", "delete", "occ-dev-owned"] },
    ],
  );
  for (const entry of commands.filter((entry) => entry.command === "docker")) {
    assert.ok(entry.args.includes("owned-kubernetes"));
    assert.ok(entry.args.includes(fixture.emptyEnv));
  }
  // A repeated cleanup must not fall back to another profile's Compose project.
  const repeated = spawnSync("/bin/bash", ["scripts/dev-down"], { encoding: "utf8", env });
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /state directory not found/);
  assert.deepEqual(await readJsonLines(fixture.env.SAFETY_LOG), commands);
});

test("Kubernetes dev-up rejects public controller and database ports before startup using real Compose", async (t) => {
  for (const [service, port, label] of [
    ["controller", 3000, "controller"],
    ["postgres", 5432, "PostgreSQL"],
  ]) {
    const fixture = await createFixture(t);
    await prepareSafetyCommands(fixture);
    const stateDirectory = join(fixture.directory, "new-state");
    const override = join(fixture.directory, "public.yaml");
    await writeFile(
      override,
      `services:\n  ${service}:\n    ports:\n      - "0.0.0.0:39000:${port}"\n`,
    );
    const result = runDevUp(["--", ...composeOptions(fixture, override)], {
      ...fixture.env,
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: "occ-dev-new",
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`configuration failed: Compose ${label} port must publish only on loopback`),
    );
    await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
    const commands = await readJsonLines(fixture.env.SAFETY_LOG);
    assert.equal(
      commands.some(
        (entry) =>
          entry.args.includes("up") ||
          entry.args.includes("down") ||
          entry.args.includes("create") ||
          entry.args.includes("delete"),
      ),
      false,
    );
    assert.ok(
      commands.some((entry) => entry.command === "docker" && entry.args.includes("config")),
    );
  }
});
