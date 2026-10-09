import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { composeConfiguration } from "../helpers/compose.mjs";
import { runDevUpModelProviderCase } from "../helpers/dev-up-model-provider.mjs";
import {
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
} from "../helpers/dev-up.mjs";

const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

test("dev-up builds the default runtime only when real Compose leaves runtime images unselected", async (t) => {
  const fixture = await createFixture(t);
  const keyDirectory = join(fixture.directory, "private key directory");
  await mkdir(keyDirectory, { mode: 0o700 });
  const keyOutput = join(keyDirectory, "service-key.json");
  const options = composeOptions(fixture);

  const result = runDevUp(["--key-output", keyOutput, "--", ...options], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
  assert.ok(
    result.stdout.includes(
      `OCC_DEVELOPMENT_COMPUTE_DRIVER=docker OCC_DEVELOPMENT_CONTAINER_ENGINE=docker ${fixture.occCli} dev down`,
    ),
  );
  assert.ok(result.stdout.includes("API URL: http://127.0.0.1:3000"));
  assert.ok(result.stdout.includes(`Installation ID: ${matchingInstallationId}`));
  assert.ok(result.stdout.includes(`Service key file: ${keyOutput}`));
  assert.ok(result.stdout.includes(`OCC_SERVICE_KEY_FILE=${keyOutput.replaceAll(" ", "\\ ")}`));
  assert.ok(result.stdout.includes(`${fixture.occCli} installation get`));
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
        `build -f deploy/runtime/Dockerfile --tag ${defaultRuntimeImage} .`,
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

  // The CLI's client behavior is covered against the real Fastify API in
  // service-api-keys.test.mjs; this fixture isolates dev-up's CLI invocation.
  const occLogs = await readJsonLines(fixture.occLog);
  assert.deepEqual(occLogs, [{ args: ["installation", "get", "--output", "json"] }]);
  assert.doesNotMatch(JSON.stringify(occLogs), new RegExp(serviceKey));
});

test("dev-up starts Docker without Compose options on Bash 3.2", async (t) => {
  // The documented no-options invocation must not trip nounset on an empty Bash array.
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "docker-no-options-service-key.json");

  const result = runDevUp(["--key-output", keyOutput], fixture.env);

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "dev-up did not exit");
  assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
  assert.match(result.stdout, /Container engine: Docker/);
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
    /configuration failed: (?:Error: )?Compose controller port must publish only on loopback/,
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
  assert.equal((await readJsonLines(fixture.occLog)).length, 0);
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
  assert.match(result.stderr, /authorization failed: occ could not read the Installation/);
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
  assert.ok(
    result.stdout.includes(
      `Cleanup:\n  env OCC_DEVELOPMENT_COMPUTE_DRIVER=docker OCC_DEVELOPMENT_CONTAINER_ENGINE=podman ${fixture.occCli} dev down -- `,
    ),
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

test("dev-up trusts only the rootful macOS Podman machine gateway", async (t) => {
  // Podman machine forwards a host-loopback publication from its private gateway,
  // which is outside the Compose bridge and must be trusted as one exact peer.
  const fixture = await createFixture(t, { engine: "podman", macosPodmanMachine: "rootful" });
  const keyOutput = join(fixture.directory, "podman-macos-service-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "dev-up did not exit");
  const invocations = await readJsonLines(fixture.podmanLog);
  assert.ok(
    invocations.some(
      (entry) =>
        entry.args.includes("up") &&
        entry.env.OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR === "192.168.127.1/32" &&
        entry.env.CONTAINER_CONNECTION === "podman-machine-default-root",
    ),
  );
  assert.match(result.stdout, /CONTAINER_CONNECTION=podman-machine-default-root .*\/occ dev down/);
});

test("dev-up honors an effective rootless macOS Podman connection", async (t) => {
  // A rootless publication reaches the controller from inside the Compose bridge,
  // so it must not inherit the rootful machine gateway trust.
  const fixture = await createFixture(t, {
    engine: "podman",
    macosPodmanMachine: "rootful",
    containerConnection: "podman-machine-default",
  });
  const keyOutput = join(fixture.directory, "podman-macos-rootless-service-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "dev-up did not exit");
  const invocations = await readJsonLines(fixture.podmanLog);
  assert.ok(
    invocations.some(
      (entry) =>
        entry.args.includes("up") &&
        !entry.env.OCC_DEVELOPMENT_TRUSTED_FORWARDER_CIDR &&
        entry.env.CONTAINER_CONNECTION === "podman-machine-default",
    ),
  );
  assert.match(result.stdout, /CONTAINER_CONNECTION=podman-machine-default .*\/occ dev down/);
  assert.equal(
    invocations.some((entry) => entry.args[0] === "machine" && entry.args[1] === "ssh"),
    false,
  );
});

test("dev-up rejects a macOS Podman host override that does not identify a machine", async (t) => {
  // Gateway trust must remain bound to a machine connection that dev-up can inspect.
  const fixture = await createFixture(t, {
    engine: "podman",
    macosPodmanMachine: "rootful",
    containerHost: "unix:///tmp/opaque-podman.sock",
  });

  const result = runDevUp(
    ["--key-output", join(fixture.directory, "unused-service-key.json")],
    fixture.env,
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /CONTAINER_HOST does not identify a supported local Podman machine connection/,
  );
  assert.equal(
    (await readJsonLines(fixture.podmanLog)).some((entry) => entry.args.includes("up")),
    false,
  );
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
    /configuration failed: (?:Error: )?Compose controller port must publish only on loopback/,
  );
  const invocations = await readJsonLines(fixture.podmanLog);
  assert.equal(
    invocations.some((entry) => entry.args.includes("up")),
    false,
  );
});

test("dev-up accepts Docker when its server omits the platform name", async (t) => {
  // Docker-compatible server metadata may omit Platform.Name while the required
  // engine and Compose capabilities remain available.
  const fixture = await createFixture(t, { dockerPlatformName: "" });
  const keyOutput = join(fixture.directory, "docker-no-platform-service-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Container engine: Docker/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
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
    /configuration failed: (?:Error: )?Docker Fluentd logging is not supported with Podman/,
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
    /configuration failed: (?:Error: )?Compose controller port must publish only on loopback/,
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

test("dev-up routes Kubernetes Compute through the unified entry point", async (t) => {
  const fixture = await createFixture(t);
  const result = runDevUp(["--help"], {
    ...fixture.env,
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /occ dev up/);
});

test("development entry points default to the Compose profile", async (t) => {
  const fixture = await createFixture(t);
  const env = { ...fixture.env };
  delete env.OCC_DEVELOPMENT_COMPUTE_DRIVER;
  delete env.OCC_DEVELOPMENT_CONTROL_PLANE;
  delete env.OCC_DEVELOPMENT_SANDBOX_DRIVER;

  // Both entry points must start the same Compose profile when no selector is set.
  const options = composeOptions(fixture);
  const script = runDevUp(
    ["--key-output", join(fixture.directory, "script-key.json"), "--", ...options],
    env,
  );
  const cli = spawnSync(
    fixture.cli,
    ["dev", "up", "--key-output", join(fixture.directory, "cli-key.json"), "--", ...options],
    { cwd: fixture.fixtureRepository, encoding: "utf8", env },
  );
  for (const result of [script, cli]) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
    assert.match(result.stdout, /Container engine: Docker/);
  }
  const starts = (await readJsonLines(fixture.dockerLog)).filter(
    (entry) => entry.args[0] === "compose" && entry.args.includes("up"),
  );
  assert.equal(starts.length, 2);
});

test("explicit Kubernetes-only profile rejects Compose options before mutation", async (t) => {
  const fixture = await createFixture(t);
  const env = { ...fixture.env };
  env.OCC_DEVELOPMENT_COMPUTE_DRIVER = "kubernetes";
  env.OCC_DEVELOPMENT_CONTROL_PLANE = "kubernetes";
  env.OCC_DEVELOPMENT_STATE_DIRECTORY = join(fixture.directory, "kubernetes-state");

  // Compose options cannot redirect the explicitly selected Kubernetes-only profile.
  for (const result of [
    runDevUp(["--", "--env-file", fixture.emptyEnv], env),
    spawnSync(fixture.cli, ["dev", "up", "--", "--env-file", fixture.emptyEnv], {
      cwd: fixture.fixtureRepository,
      encoding: "utf8",
      env,
    }),
  ]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Kubernetes-only profile does not accept Compose options/);
  }
  await assert.rejects(stat(env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
  assert.equal((await readJsonLines(fixture.dockerLog)).length, 0);
});

test("development cleanup defaults to the Compose profile", async (t) => {
  const fixture = await createFixture(t);
  await prepareLifecycleCommands(fixture);
  delete fixture.env.OCC_DEVELOPMENT_COMPUTE_DRIVER;
  delete fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE;
  delete fixture.env.OCC_DEVELOPMENT_SANDBOX_DRIVER;

  // Cleanup without selectors must target Compose, not a Kubernetes state directory.
  const result = runDevDown(fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Stopped Docker-compatible development stack/);
  const commands = await readJsonLines(fixture.env.SAFETY_LOG);
  assert.ok(commands.some((entry) => entry.command === "docker" && entry.args.includes("down")));
  assert.equal(
    commands.some((entry) => entry.command === "k3d"),
    false,
  );
});

test("development cleanup rejects a Kubernetes control plane without Kubernetes Compute", async (t) => {
  const fixture = await createFixture(t);
  await prepareLifecycleCommands(fixture);
  delete fixture.env.OCC_DEVELOPMENT_COMPUTE_DRIVER;
  fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE = "kubernetes";

  // A mismatched selector must not stop an unrelated default Compose stack.
  const result = runDevDown(fixture.env);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes requires Kubernetes Compute/,
  );
  const commands = await readJsonLines(fixture.env.SAFETY_LOG);
  assert.equal(
    commands.some((entry) => entry.args.includes("down")),
    false,
  );
});

// Serve the existing Installation HTTP contract in a child process so the real
// synchronous CLI can authenticate without blocking the test runner's event loop.
async function installationServer(t, fixture, scenario = "success") {
  const requestLog = join(fixture.directory, "http-requests.jsonl");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import http from "node:http";
import fs from "node:fs";
const server = http.createServer((request, response) => {
  const authorized = request.headers["x-api-key"] === ${JSON.stringify(serviceKey)};
  fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ method: request.method, url: request.url, authorized }) + "\\n");
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/auth/session") {
    if (${JSON.stringify(scenario)} === "readiness-blocked") response.writeHead(503);
    response.end("{}"); return;
  }
  if (request.url === "/namespaces/namespace_fixture" && authorized) {
    response.end(JSON.stringify({ data: { id: "namespace_fixture", name: "default", status: "ready" }, meta: { requestId: "req_fixture" } }));
    return;
  }
  if (request.url !== "/installation" || !authorized || ${JSON.stringify(scenario)} === "api-unauthorized") {
    response.writeHead(401);
    response.end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "A valid service API key is required." }, meta: { requestId: "req_fixture" } }));
    return;
  }
  response.end(JSON.stringify({ data: { id: ${JSON.stringify(scenario === "api-mismatch" ? mismatchedInstallationId : matchingInstallationId)} }, meta: { requestId: "req_fixture" } }));
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill();
      await once(child, "exit");
    }
  });
  const [port] = await once(child.stdout, "data");
  fixture.env.OPENCLAW_DEV_PORT = String(port).trim();
  return requestLog;
}

function runDevDown(env) {
  return spawnSync("/bin/bash", ["scripts/dev-down"], {
    cwd: env.DEV_UP_FIXTURE_REPOSITORY,
    encoding: "utf8",
    env,
  });
}

async function kubernetesFixture(t, scenario = "success", options = {}) {
  const fixture = await createFixture(t, options);
  await prepareLifecycleCommands(fixture, scenario, options);
  fixture.env.OCC_DEVELOPMENT_COMPUTE_DRIVER = "kubernetes";
  fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE = "compose";
  fixture.requestLog = await installationServer(t, fixture, scenario);
  fixture.start = (args = []) =>
    runDevUp([...args, "--", "--env-file", fixture.emptyEnv], fixture.env);
  return fixture;
}

test("Kubernetes dev-up authenticates the Installation and cleanup uses its saved endpoint and Compose configuration", async (t) => {
  const fixture = await kubernetesFixture(t);
  delete fixture.env.DOCKER_HOST;
  const result = fixture.start();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Compute Driver: Kubernetes/);
  assert.ok(result.stdout.includes(`Installation ID: ${matchingInstallationId}`));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  const directory = fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(state.dockerHost, "unix:///fixture/owned-docker.sock");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(state.keyPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    await readJsonLines(fixture.requestLog).then((rows) =>
      rows.filter((row) => row.url === "/installation"),
    ),
    [{ method: "GET", url: "/installation", authorized: true }],
  );
  const savedConfiguration = composeConfiguration([join(directory, "compose.yaml")]);
  assert.equal(
    savedConfiguration.services.controller.ports[0].published,
    fixture.env.OPENCLAW_DEV_PORT,
  );
  const config = await readFile(join(directory, "installation.yaml"), "utf8");
  assert.match(config, /id: compute-kubernetes/);
  assert.match(
    config,
    /gateway: docker.io\/library\/openclaw-enterprise-runtime@sha256:[a-f0-9]{64}/,
  );
  // A newly bootstrapped local installation must pass the real Compute startup
  // contract while trusting only Pod loopback, never an assumed cluster CIDR.
  const installation = loadYaml(config);
  assert.equal(installation.presets.includeDefaults, true);
  assert.equal(installation.drivers.plugin.id, "codex-plugin");
  const compute = installation.drivers.compute.configuration;
  KubernetesComputeDriver.validateConfiguration(compute);
  assert.deepEqual(compute.network.gatewayTrustedProxyCidrs, ["127.0.0.1/32"]);
  // The API server's Pod proxy source, so Compute can read private status and a
  // dedicated Codex Gateway starts once on a first deploy.
  assert.deepEqual(compute.network.pluginStatusProxySourceCidrs, ["10.42.0.1/32"]);
  assert.match(config, /transportSecretPrefix: openclaw-agent-transport/);
  assert.doesNotMatch(config, /modelSecretPrefix/);
  const startupCommands = await readJsonLines(fixture.env.SAFETY_LOG);
  const clusterCreate = startupCommands.find(
    (entry) => entry.command === "k3d" && entry.args[0] === "cluster" && entry.args[1] === "create",
  );
  assert.ok(clusterCreate, "Kubernetes development must create its owned k3d cluster");
  assert.equal(clusterCreate.args[clusterCreate.args.indexOf("--image") + 1], "+v1.35");
  // Match the Kubernetes-only profile so nested nftables restore limits cannot leave stale policies.
  assert.equal(
    clusterCreate.args[clusterCreate.args.indexOf("--env") + 1],
    "IPTABLES_MODE=legacy@server:0",
  );

  const duplicate = fixture.start();
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /state directory already exists/);
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
    clusters: ["occ-dev-unrelated", "occ-dev-owned"],
    compose: true,
  });

  const beforeCleanup = await readJsonLines(fixture.env.SAFETY_LOG);
  // Ambient selection and source env files can change after startup. Cleanup
  // must still remove only the stack and endpoint recorded by that invocation.
  await writeFile(fixture.emptyEnv, "OPENCLAW_DEV_PORT=45678\n");
  const cleaned = runDevDown({
    ...fixture.env,
    DOCKER_HOST: "unix:///fixture/unrelated.sock",
    DOCKER_CONTEXT: "unrelated",
  });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  const commands = (await readJsonLines(fixture.env.SAFETY_LOG)).slice(beforeCleanup.length);
  assert.ok(
    commands.every((entry) => entry.dockerHost === state.dockerHost && entry.dockerContext === ""),
  );
  const down = commands.find((entry) => entry.command === "docker" && entry.args.includes("down"));
  assert.ok(down.args.includes(join(directory, "compose.yaml")));
  assert.ok(down.args.includes("owned-kubernetes"));
  assert.ok(!down.args.includes(fixture.emptyEnv));
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
    clusters: ["occ-dev-unrelated"],
    compose: false,
  });
  const repeated = runDevDown(fixture.env);
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /no such file or directory/);
});

test("Kubernetes Compute defaults to the Compose control plane", async (t) => {
  const fixture = await kubernetesFixture(t);
  delete fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE;

  // Kubernetes Compute remains available while the control plane defaults to Compose.
  const result = fixture.start();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Control plane: Compose/);
  const cleaned = runDevDown(fixture.env);
  assert.equal(cleaned.status, 0, cleaned.stderr);
});

for (const controlPlane of ["compose", "kubernetes"]) {
  for (const [reason, cluster] of [
    ["33-character name", `occ-dev-${"a".repeat(25)}`],
    ["trailing hyphen", "occ-dev-example-"],
  ]) {
    test(`${controlPlane} Kubernetes startup rejects ${reason} before any effects`, async (t) => {
      const fixture = await createFixture(t);
      await prepareLifecycleCommands(fixture);
      const resourcesBefore = await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8");

      // The compiled CLI owns validation. Existing inert commands record any
      // engine or resource access; no Installation server is needed for refusal.
      const result = spawnSync(fixture.cli, ["dev", "up"], {
        cwd: fixture.fixtureRepository,
        env: {
          ...fixture.env,
          OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
          OCC_DEVELOPMENT_CONTROL_PLANE: controlPlane,
          OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
          OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
        },
        encoding: "utf8",
        timeout: 30_000,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid OCC_DEVELOPMENT_KUBERNETES_CLUSTER/);
      assert.ok(result.stderr.includes(JSON.stringify(cluster)));
      assert.match(result.stderr, /at most 32 characters/);
      assert.match(result.stderr, /end with a lowercase letter or digit/);
      await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
      assert.deepEqual(await readJsonLines(fixture.env.SAFETY_LOG), []);
      assert.deepEqual(await readJsonLines(fixture.dockerLog), []);
      assert.deepEqual(await readJsonLines(fixture.occLog), []);
      assert.equal(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8"), resourcesBefore);
    });
  }
}

test("Compose Kubernetes startup rejects missing Node before creating resources", async (t) => {
  const fixture = await createFixture(t);
  await prepareLifecycleCommands(fixture);
  // Invoke the compiled CLI directly: a host may have the CLI and container
  // tools installed without the Node runtime required by sandbox preparation.
  const result = spawnSync(fixture.cli, ["dev", "up"], {
    cwd: fixture.fixtureRepository,
    env: {
      ...fixture.env,
      PATH: join(fixture.directory, "bin"),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
      OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node is required on PATH/);
  assert.deepEqual(await readJsonLines(fixture.env.SAFETY_LOG), []);
  await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
});

test("Kubernetes dev-up forwards an explicit K3s image and startup timeout to k3d", async (t) => {
  const fixture = await kubernetesFixture(t);
  fixture.env.OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS = "37";
  fixture.env.OCC_DEVELOPMENT_K3D_DNS_RESOLVER = "192.0.2.53";
  fixture.env.OCC_DEVELOPMENT_K3S_IMAGE = "rancher/k3s:v1.35.8-k3s1";
  const result = fixture.start();
  assert.equal(result.status, 0, result.stderr);
  const commands = await readJsonLines(fixture.env.SAFETY_LOG);
  const clusterCreate = commands.find(
    (entry) => entry.command === "k3d" && entry.args[0] === "cluster" && entry.args[1] === "create",
  );
  assert.ok(clusterCreate);
  assert.equal(
    clusterCreate.args[clusterCreate.args.indexOf("--image") + 1],
    "rancher/k3s:v1.35.8-k3s1",
  );
  // A failed node must not leave cluster creation waiting without a deadline.
  assert.equal(clusterCreate.args[clusterCreate.args.indexOf("--timeout") + 1], "37s");
  assert.ok(
    clusterCreate.args.some((argument) => argument.includes(":/etc/resolv.conf:ro@server:0")),
  );
  const cleaned = runDevDown(fixture.env);
  assert.equal(cleaned.status, 0, cleaned.stderr);
});

test("Kubernetes dev-up rejects an unsupported control-plane selection", async (t) => {
  const fixture = await kubernetesFixture(t);
  fixture.env.OCC_DEVELOPMENT_SANDBOX_DRIVER = "openshell";
  fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE = "external";

  const result = fixture.start();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OCC_DEVELOPMENT_CONTROL_PLANE must be compose or kubernetes/);
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
    clusters: ["occ-dev-unrelated"],
    compose: false,
  });
});

test("dev-up rejects OpenShell when Kubernetes Compute is not selected", async (t) => {
  const fixture = await createFixture(t);
  const result = runDevUp([], {
    ...fixture.env,
    OCC_DEVELOPMENT_SANDBOX_DRIVER: "openshell",
  });

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell requires OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes/,
  );
  assert.equal((await readJsonLines(fixture.dockerLog)).length, 0);
});

for (const driver of ["docker"]) {
  test(`dev-down preserves Kubernetes state when Compute selector is ${driver}`, async (t) => {
    const fixture = await createFixture(t);
    await prepareLifecycleCommands(fixture);
    const directory = fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
    await mkdir(directory, { mode: 0o700 });
    const result = runDevDown({ ...fixture.env, OCC_DEVELOPMENT_COMPUTE_DRIVER: driver });
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await stat(directory)).isDirectory());
    const commands = await readJsonLines(fixture.env.SAFETY_LOG);
    assert.equal(
      commands.some((entry) => entry.command === "k3d"),
      false,
    );
    assert.ok(commands.some((entry) => entry.command === "docker" && entry.args.includes("down")));
  });
}

for (const scenario of [
  "compose-up-failed",
  "cluster-create-failed",
  "node-dns-refused",
  "api-mismatch",
  "api-unauthorized",
]) {
  test(`Kubernetes dev-up rolls back owned resources after ${scenario}`, async (t) => {
    const fixture = await kubernetesFixture(t, scenario);
    const keyOutput = join(fixture.directory, "retained-key.json");
    const result = fixture.start(["--key-output", keyOutput]);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
    if (scenario === "cluster-create-failed") {
      // k3d can fail with partial resources absent from its inventory. Retain
      // the recovery record until the operator explicitly retries cleanup.
      assert.match(result.stderr, /rollback incomplete; preserving/);
      assert.ok((await stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY)).isDirectory());
      const cleaned = runDevDown(fixture.env);
      assert.equal(cleaned.status, 0, cleaned.stderr);
    }
    await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
      clusters: ["occ-dev-unrelated"],
      compose: false,
    });
    if (scenario === "compose-up-failed") {
      assert.match(result.stderr, /partial compose startup/);
    }
    if (scenario === "cluster-create-failed") {
      assert.match(result.stderr, /partial cluster creation/);
    }
    if (scenario === "node-dns-refused") {
      // A node resolver that refuses queries stops startup before the first image pull.
      assert.match(result.stderr, /cannot resolve registry-1\.docker\.io/);
      assert.match(result.stderr, /OCC_DEVELOPMENT_K3D_DNS_RESOLVER/);
      const commands = await readJsonLines(fixture.env.SAFETY_LOG);
      assert.equal(
        commands.some(({ command, args }) => command === "k3d" && args[0] === "image"),
        false,
      );
    }
    if (scenario.startsWith("api-")) {
      await assert.rejects(stat(keyOutput), { code: "ENOENT" });
      assert.match(
        result.stderr,
        scenario === "api-mismatch" ? /Installation ID does not match/ : /authorization failed/,
      );
    }
  });
}

test("Kubernetes-only dev-up stops and rolls back when the node resolver refuses queries", async (t) => {
  const fixture = await kubernetesFixture(t, "node-dns-refused");
  fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE = "kubernetes";
  fixture.env.OCC_DEVELOPMENT_SANDBOX_DRIVER = "none";
  fixture.env.DEV_UP_EXISTING_CONTROLLER_IMAGE = "1";
  fixture.env.DEV_UP_EXISTING_RUNTIME_IMAGE = "1";
  const result = runDevUp([], fixture.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot resolve registry-1\.docker\.io/);
  assert.match(result.stderr, /OCC_DEVELOPMENT_K3D_DNS_RESOLVER/);
  await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")).clusters, [
    "occ-dev-unrelated",
  ]);
});

test("Kubernetes dev-down preserves recovery state after incomplete cleanup and can retry", async (t) => {
  const fixture = await kubernetesFixture(t, "cluster-delete-failed");
  const started = fixture.start();
  assert.equal(started.status, 0, started.stderr);
  const directory = fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const state = await readFile(join(directory, "state.json"), "utf8");
  const failed = runDevDown(fixture.env);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /cleanup incomplete; preserving/);
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), state);
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
    clusters: ["occ-dev-unrelated", "occ-dev-owned"],
    compose: false,
  });
  const retried = runDevDown({ ...fixture.env, DEV_UP_LIFECYCLE_SCENARIO: "success" });
  assert.equal(retried.status, 0, retried.stderr);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
    clusters: ["occ-dev-unrelated"],
    compose: false,
  });
});

test("cancelling Kubernetes startup during readiness rolls back its owned resources", async (t) => {
  const fixture = await kubernetesFixture(t, "readiness-blocked");
  const child = spawn(fixture.cli, ["dev", "up", "--", "--env-file", fixture.emptyEnv], {
    cwd: fixture.fixtureRepository,
    env: { ...fixture.env, OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "60" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await exited;
  });
  // Wait for the real client to reach readiness, after all owned resources
  // exist, so cancellation must execute rollback rather than fail preflight.
  const deadline = Date.now() + 15_000;
  while (
    !(await readJsonLines(fixture.requestLog)).some((row) => row.url === "/api/auth/session")
  ) {
    assert.ok(
      Date.now() < deadline && child.exitCode === null,
      output || "startup did not reach readiness",
    );
    await delay(20);
  }
  child.kill("SIGTERM");
  const [status, signal] = await exited;
  assert.notEqual(status, 0, output);
  assert.equal(signal, null, "OCC should handle cancellation and finish rollback before exiting");
  assert.match(output, /context canceled/);
  assert.doesNotMatch(output, /development stack is ready/);
  await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
    clusters: ["occ-dev-unrelated"],
    compose: false,
  });
});

for (const driver of ["docker", "kubernetes"]) {
  for (const service of ["controller", "postgres"]) {
    test(`${driver} dev-up rejects host networking for ${service} before startup`, async (t) => {
      const fixture = await createFixture(t);
      await prepareLifecycleCommands(fixture);
      const override = join(fixture.directory, "host-network.yaml");
      await writeFile(
        override,
        `services:\n  ${service}:\n    network_mode: host\n    networks: !reset []\n    ports: !reset []\n`,
      );
      const options =
        driver === "kubernetes"
          ? ["--env-file", fixture.emptyEnv, "-f", override]
          : composeOptions(fixture, override);
      const result = runDevUp(["--", ...options], {
        ...fixture.env,
        OCC_DEVELOPMENT_COMPUTE_DRIVER: driver,
        OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
      });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`Compose ${service} must use the development network`),
      );
      await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
      const commands = await readJsonLines(fixture.env.SAFETY_LOG);
      assert.ok(commands.some((entry) => entry.args.includes("config")));
      assert.equal(
        commands.some((entry) =>
          entry.args.some((arg) => ["up", "down", "create", "delete"].includes(arg)),
        ),
        false,
      );
    });
  }
}

for (const driver of ["docker", "kubernetes"]) {
  for (const [service, port, label] of [
    ["controller", 3000, "controller"],
    ["postgres", 5432, "PostgreSQL"],
  ]) {
    for (const [mapping, publication, error] of [
      ["public", `"0.0.0.0:39000:${port}"`, "must publish only on loopback"],
      ["target-only", `"${port}"`, "must publish only on loopback"],
      [
        "loopback-dynamic",
        `{target: ${port}, host_ip: "127.0.0.1"}`,
        "must select an explicit host port",
      ],
    ]) {
      test(`${driver} dev-up rejects ${mapping} ${service} ports rendered by real Compose before startup`, async (t) => {
        const fixture = await createFixture(t);
        await prepareLifecycleCommands(fixture);
        const stateDirectory = join(fixture.directory, "new-state");
        const override = join(fixture.directory, "unsafe-port.yaml");
        await writeFile(override, `services:\n  ${service}:\n    ports:\n      - ${publication}\n`);
        // Kubernetes supplies its own base files and project; do not load the base twice.
        const options =
          driver === "kubernetes"
            ? ["--env-file", fixture.emptyEnv, "--project-directory", ".", "-f", override]
            : composeOptions(fixture, override);
        const result = runDevUp(
          ["--key-output", join(fixture.directory, "key.json"), "--", ...options],
          {
            ...fixture.env,
            OCC_DEVELOPMENT_COMPUTE_DRIVER: driver,
            OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
            OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
            OCC_DEVELOPMENT_KUBERNETES_CLUSTER: "occ-dev-new",
          },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`Compose ${label} port ${error}`));
        await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
        const commands = await readJsonLines(fixture.env.SAFETY_LOG);
        assert.equal(
          commands.some((entry) =>
            entry.args.some((arg) => ["up", "down", "create", "delete"].includes(arg)),
          ),
          false,
        );
        assert.ok(
          commands.some((entry) => entry.command === "docker" && entry.args.includes("config")),
        );
      });
    }
  }
}

test("Kubernetes development uses a canonical default state directory through a temporary-directory alias", async (t) => {
  const fixture = await kubernetesFixture(t);
  const temporary = join(fixture.directory, "system-temporary");
  const alias = join(fixture.directory, "temporary-alias");
  await mkdir(temporary, { mode: 0o700 });
  await symlink(temporary, alias);
  fixture.env.TMPDIR = alias;
  delete fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;

  // macOS temporary directories commonly contain a system symlink. The
  // helper-selected default must resolve it consistently for startup and cleanup.
  const started = fixture.start();
  assert.equal(started.status, 0, started.stderr);
  const directory = join(temporary, "openclaw-development");
  assert.ok((await stat(directory)).isDirectory());
  assert.ok(started.stdout.includes(`OCC_DEVELOPMENT_STATE_DIRECTORY='${directory}'`));
  const stopped = runDevDown(fixture.env);
  assert.equal(stopped.status, 0, stopped.stderr);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  assert.ok((await stat(temporary)).isDirectory());
});

for (const scenario of ["cancelled-creation", "cluster-create-failed", "node-dns-refused"]) {
  test(
    `launcher case recovery follows real Go rollback after ${scenario}`,
    { timeout: 30_000 },
    async (t) => {
      const fixture = await createFixture(t);
      await prepareLifecycleCommands(fixture, scenario);
      const environment = {
        ...fixture.env,
        OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
        OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
        OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
        OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "30",
        DEV_UP_EXISTING_CONTROLLER_IMAGE: "1",
        DEV_UP_EXISTING_RUNTIME_IMAGE: "1",
      };
      const started = join(fixture.directory, "creation-started");
      if (scenario === "cancelled-creation") {
        // Hold only the external command before an observable result. The real
        // Go launcher owns cancellation, rollback, and journal retention.
        const k3d = join(fixture.directory, "bin", "k3d");
        const original = await readFile(k3d, "utf8");
        const marker = "const statePath = process.env.DEV_UP_RESOURCE_STATE;";
        assert.ok(original.includes(marker));
        await writeFile(
          k3d,
          original.replace(
            marker,
            `if (args[0] === 'cluster' && args[1] === 'create') {
          fs.writeFileSync(${JSON.stringify(started)}, 'dispatched');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        ${marker}`,
          ),
        );
      }
      const controller = new AbortController();
      let cleanup;
      const commands = [];
      // Adapt only the teardown script path to the existing fixture repository.
      // Join actual process closure; no engine storage or late daemon effect is simulated.
      const run = (program, args, options = {}) =>
        new Promise((resolve, reject) => {
          if (program.endsWith("/scripts/dev-down")) {
            program = join(fixture.fixtureRepository, "scripts", "dev-down");
          }
          commands.push(program);
          const child = spawn(program, args, {
            cwd: fixture.fixtureRepository,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          const abort = () => child.kill("SIGTERM");
          options.signal?.addEventListener("abort", abort, { once: true });
          const deadline = setTimeout(() => child.kill("SIGKILL"), 12_000);
          child.once("close", (code, signal) => {
            clearTimeout(deadline);
            options.signal?.removeEventListener("abort", abort);
            if (code === 0 && !options.signal?.aborted) {
              resolve({ stdout, stderr });
            } else {
              reject(
                Object.assign(new Error("launcher command failed"), {
                  stdout,
                  stderr,
                  code,
                  forcedTermination: signal === "SIGKILL",
                }),
              );
            }
          });
          child.once("error", reject);
        });
      const work = runDevUpModelProviderCase(
        {
          signal: controller.signal,
          after: (operation) => {
            cleanup = operation;
          },
        },
        { root: fixture.directory, cluster: "occ-dev-owned", environment, run },
        async ({ execute }) => {
          await execute(fixture.cli, ["dev", "up"]);
        },
      ).catch((error) => error);
      t.after(async () => {
        controller.abort();
        await work;
      });
      if (scenario === "cancelled-creation") {
        const deadline = Date.now() + 15_000;
        while (!existsSync(started)) {
          assert.ok(Date.now() < deadline, "creation did not start");
          await delay(20);
        }
        controller.abort();
      }
      const failure = await work;
      assert.ok(failure instanceof Error);
      assert.equal(failure.forcedTermination, false);
      const journal = join(environment.OCC_DEVELOPMENT_STATE_DIRECTORY, "state.json");
      if (scenario === "node-dns-refused") {
        // A synchronous failure after acknowledged creation completes rollback;
        // the real launcher removes its state, so ordinary case cleanup is safe.
        assert.match(failure.stderr, /cannot resolve registry-1\.docker\.io/);
        assert.equal(existsSync(journal), false);
        await cleanup();
        assert.equal(existsSync(fixture.directory), false);
      } else {
        assert.match(failure.stderr, /cluster creation failed; verify and retry recorded cleanup/);
        const recorded = await readFile(journal, "utf8");
        // An absent cluster in the command fixture does not discharge the real
        // launcher's explicit uncertainty. Repeated cleanup must preserve evidence.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await assert.rejects(cleanup(), /outcome remains uncertain; recovery state preserved/);
          assert.equal(await readFile(journal, "utf8"), recorded);
          assert.equal(existsSync(fixture.directory), true);
        }
      }
      assert.deepEqual(commands, [fixture.cli], "no automatic dev-down or creation replay");
    },
  );
}
