import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
  prepareLifecycleCommands,
  publicControllerOverride,
  readJsonLines,
  runCommand,
  runDevDown,
  runDevUp,
  serviceKey,
} from "../helpers/dev-up.mjs";

// dev-up's Compose stack: engine selection, generated configuration, key output, readiness,
// profile selection and the ports Compose renders, including the Kubernetes Compute checks that
// refuse before startup. The Kubernetes lifecycle, cleanup, rollback and launcher cases are in
// dev-up.test.mjs; CI runs the two files side by side.

test("dev-up builds the default runtime only when real Compose leaves runtime images unselected", async (t) => {
  const fixture = await createFixture(t);
  const keyDirectory = join(fixture.directory, "private key directory");
  await mkdir(keyDirectory, { mode: 0o700 });
  const keyOutput = join(keyDirectory, "service-key.json");
  const options = composeOptions(fixture);

  const result = await runDevUp(["--key-output", keyOutput, "--", ...options], fixture.env);

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
  const source = JSON.parse(
    await readFile(new URL("../../deploy/runtime/openclaw-source.json", import.meta.url), "utf8"),
  );
  const runtimeBuild = dockerLogs.find((entry) => entry.args[0] === "build");
  assert.deepEqual(runtimeBuild?.args, [
    "build",
    "-f",
    "deploy/runtime/Dockerfile",
    "--build-arg",
    `OPENCLAW_COMMIT=${source.commit}`,
    "--build-arg",
    `OPENCLAW_SOURCE_SHA256=${source.sourceArchiveSha256}`,
    "--build-arg",
    `OPENCLAW_BUILD_TIMESTAMP=${source.buildTimestamp}`,
    "--tag",
    defaultRuntimeImage,
    ".",
  ]);
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

  const result = await runDevUp(["--key-output", keyOutput], fixture.env);

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "dev-up did not exit");
  assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
  assert.match(result.stdout, /Container engine: Docker/);
});

test("dev-up refuses an invalid source identity before building or starting Compose", async (t) => {
  const fixture = await createFixture(t);
  const sourcePath = join(fixture.fixtureRepository, "deploy/runtime/openclaw-source.json");
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  // A malformed timestamp must not reach Docker or start a stack with an unbuildable image.
  source.buildTimestamp = "2026-02-30T00:00:00Z";
  await writeFile(sourcePath, JSON.stringify(source));

  const result = await runDevUp([], fixture.env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot read a valid deploy\/runtime\/openclaw-source.json/);
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.ok(dockerLogs.every((entry) => entry.args[0] !== "build"));
  const composeCommands = composeInvocations(dockerLogs);
  assert.ok(composeCommands.every((entry) => !entry.args.includes("up")));
});

test("dev-up preserves a selected custom runtime image and skips the quickstart build", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "custom-service-key.json");
  const env = { ...fixture.env, OPENCLAW_DEV_PORT: "4137" };
  const override = await customRuntimeOverride(fixture);
  // A prebuilt selection does not consume this checkout's runtime source identity.
  await writeFile(join(fixture.fixtureRepository, "deploy/runtime/openclaw-source.json"), "{}");
  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(
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

  const result = await runDevUp(["--key-output", keyOutput], fixture.env);

  assert.equal(result.status, 0, result.stderr ?? result.error?.message ?? "dev-up did not exit");
  assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
  assert.match(result.stdout, /Container engine: Podman/);
});

test("dev-up honors Podman Compose file selection from the environment and explicit flags", async (t) => {
  // A security override selected through the environment must participate in validation.
  const fixture = await createFixture(t, { engine: "podman" });
  const keyOutput = join(fixture.directory, "podman-compose-file-service-key.json");
  const override = await publicControllerOverride(fixture);
  const env = {
    ...fixture.env,
    COMPOSE_FILE: ["compose.yaml", override].join(delimiter),
  };

  const result = await runDevUp(
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

  // Explicit file flags must override COMPOSE_FILE, including argparse's attached
  // short form. Real Compose must load the selected file before startup proceeds.
  for (const form of ["split", "attached", "long equals"]) {
    await t.test(form, async (t) => {
      const explicit = await createFixture(t, { engine: "podman" });
      const sourceDirectory = join(explicit.directory, "source with spaces");
      await symlink(explicit.env.DEV_UP_REPOSITORY, sourceDirectory);
      const selectedFile = join(sourceDirectory, "compose.yaml");
      const missingFile = join(explicit.directory, "missing-compose.yaml");
      const fileArgs =
        form === "split"
          ? ["-f", selectedFile]
          : [form === "attached" ? `-f${selectedFile}` : `--file=${selectedFile}`];
      const result = await runDevUp(
        [
          "--key-output",
          join(explicit.directory, "explicit-service-key.json"),
          "--",
          "--env-file",
          explicit.emptyEnv,
          "--project-name",
          "oce-dev-up-explicit-files",
          ...fileArgs,
        ],
        { ...explicit.env, COMPOSE_FILE: missingFile },
      );

      assert.equal(result.status, 0, result.stderr ?? result.error?.message);
      assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
      assert.match(result.stdout, /API URL: http:\/\/127\.0\.0\.1:3000/);
      const calls = composeInvocations(await readJsonLines(explicit.podmanLog));
      assert.ok(calls.some((entry) => entry.args.includes("config")));
      assert.ok(calls.every((entry) => !entry.args.includes(missingFile)));
    });
  }
});

test("dev-up accepts Docker when its server omits the platform name", async (t) => {
  // Docker-compatible server metadata may omit Platform.Name while the required
  // engine and Compose capabilities remain available.
  const fixture = await createFixture(t, { dockerPlatformName: "" });
  const keyOutput = join(fixture.directory, "docker-no-platform-service-key.json");

  const result = await runDevUp(
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

  const result = await runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Container engine: Podman/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
});

test("dev-up recognizes a JSON-capable Docker CLI connected to Podman", async (t) => {
  // Docker CLI formatting adds Engine even when the server reports Podman Engine.
  // The distribution-style platform, DockerRootDir and Compose availability
  // cannot override that explicit Podman identity.
  const fixture = await createFixture(t, {
    engine: "podman",
    dockerAlias: true,
    podmanDockerApi: true,
    podmanJsonConfig: true,
  });
  const keyOutput = join(fixture.directory, "podman-json-alias-service-key.json");

  const result = await runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Container engine: Podman/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
});

test("Compose dev-up refuses explicit Docker when its CLI is connected to Podman", async (t) => {
  const fixture = await createFixture(t, {
    engine: "podman",
    dockerAlias: true,
    podmanDockerApi: true,
    podmanJsonConfig: true,
  });
  const keyOutput = join(fixture.directory, "podman-explicit-compose-service-key.json");
  const result = await runDevUp(["--key-output", keyOutput, "--", ...composeOptions(fixture)], {
    ...fixture.env,
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /a running Docker Engine with Docker Compose or Podman with podman-compose is required/,
  );
  const calls = await readJsonLines(fixture.podmanLog);
  assert.ok(calls.some(({ args }) => args.join(" ") === "version --format {{json .Server}}"));
  assert.equal(
    calls.some(({ args }) => args[0] !== "version"),
    false,
  );
  await assert.rejects(stat(keyOutput), { code: "ENOENT" });
});

test("Kubernetes dev-up refuses explicit Docker when its CLI is connected to Podman", async (t) => {
  const fixture = await createFixture(t, {
    engine: "podman",
    dockerAlias: true,
    podmanDockerApi: true,
  });
  // These prerequisites must be discoverable, but selection must reject the
  // server before invoking a cluster command or acquiring any state.
  for (const name of ["k3d", "kubectl"]) {
    await writeFile(join(fixture.directory, "bin", name), "#!/bin/sh\nexit 99\n", {
      mode: 0o755,
    });
  }
  await symlink(process.execPath, join(fixture.directory, "bin", "node"));
  const stateDirectory = join(fixture.directory, "kubernetes-state");
  const keyOutput = join(fixture.directory, "podman-explicit-docker-service-key.json");
  const result = await runCommand(fixture.cli, ["dev", "up", "--key-output", keyOutput], {
    cwd: fixture.fixtureRepository,
    env: {
      ...fixture.env,
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /a running docker container engine with its Compose provider is required/,
  );
  assert.deepEqual(
    (await readJsonLines(fixture.podmanLog)).map(({ args }) => args),
    [["version", "--format", "{{json .Server}}"]],
    "explicit Docker refusal must precede info, Compose and startup effects",
  );
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
  await assert.rejects(stat(keyOutput), { code: "ENOENT" });
});

test("dev-up rejects the Docker Fluentd logging override when Podman is selected", async (t) => {
  const fixture = await createFixture(t, { engine: "podman" });
  const keyOutput = join(fixture.directory, "podman-logging-service-key.json");
  const options = composeOptions(fixture);
  options.splice(4, 0, "-f", "compose.logging.yaml");

  const result = await runDevUp(["--key-output", keyOutput, "--", ...options], fixture.env);

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

  const result = await runDevUp(
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

  const result = await runDevUp(["--key-output", keyOutput], {
    ...fixture.env,
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Container engine: Docker/);
});

test("dev-up rejects an unsupported development selector before startup", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "invalid-selector-service-key.json");

  const result = await runDevUp(["--key-output", keyOutput], {
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
  const result = await runDevUp(["--help"], {
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
  const script = await runDevUp(
    ["--key-output", join(fixture.directory, "script-key.json"), "--", ...options],
    env,
  );
  const cli = await runCommand(
    fixture.cli,
    ["dev", "up", "--key-output", join(fixture.directory, "cli-key.json"), "--", ...options],
    { cwd: fixture.fixtureRepository, env },
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
    await runDevUp(["--", "--env-file", fixture.emptyEnv], env),
    await runCommand(fixture.cli, ["dev", "up", "--", "--env-file", fixture.emptyEnv], {
      cwd: fixture.fixtureRepository,
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
  const result = await runDevDown(fixture.env);
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
  const result = await runDevDown(fixture.env);
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
      const result = await runDevUp(["--", ...options], {
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
        const result = await runDevUp(
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
