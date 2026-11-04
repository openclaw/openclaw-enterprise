import { requireConfiguration } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { composeConfiguration } from "../helpers/compose.mjs";
import { runDevUpModelProviderCase } from "../helpers/dev-up-model-provider.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";
import {
  createFixture,
  matchingInstallationId,
  mismatchedInstallationId,
  prepareLifecycleCommands,
  readJsonLines,
  runCommand,
  runDevDown,
  runDevUp,
  serviceKey,
} from "../helpers/dev-up.mjs";

// dev-up's Kubernetes Compute lifecycle: authenticated startup, cleanup, rollback and the real
// Go launcher's recovery. The Compose stack cases are in dev-up-compose.test.mjs.

const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

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
  t.after(() => stopProcess(child));
  const [port] = await once(child.stdout, "data");
  fixture.env.OPENCLAW_DEV_PORT = String(port).trim();
  return requestLog;
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
  const result = await fixture.start();
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
  requireConfiguration(KubernetesComputeDriver, compute);
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

  const duplicate = await fixture.start();
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
  const cleaned = await runDevDown({
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
  const repeated = await runDevDown(fixture.env);
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /no such file or directory/);
});

test("Kubernetes Compute defaults to the Compose control plane", async (t) => {
  const fixture = await kubernetesFixture(t);
  delete fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE;

  // Kubernetes Compute remains available while the control plane defaults to Compose.
  const result = await fixture.start();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Control plane: Compose/);
  const cleaned = await runDevDown(fixture.env);
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
      const result = await runCommand(fixture.cli, ["dev", "up"], {
        cwd: fixture.fixtureRepository,
        env: {
          ...fixture.env,
          OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
          OCC_DEVELOPMENT_CONTROL_PLANE: controlPlane,
          OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
          OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
        },
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
  const result = await runCommand(fixture.cli, ["dev", "up"], {
    cwd: fixture.fixtureRepository,
    env: {
      ...fixture.env,
      PATH: join(fixture.directory, "bin"),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
      OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
    },
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
  const result = await fixture.start();
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
  const cleaned = await runDevDown(fixture.env);
  assert.equal(cleaned.status, 0, cleaned.stderr);
});

test("Kubernetes dev-up rejects an unsupported control-plane selection", async (t) => {
  const fixture = await kubernetesFixture(t);
  fixture.env.OCC_DEVELOPMENT_SANDBOX_DRIVER = "openshell";
  fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE = "external";

  const result = await fixture.start();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OCC_DEVELOPMENT_CONTROL_PLANE must be compose or kubernetes/);
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
    clusters: ["occ-dev-unrelated"],
    compose: false,
  });
});

test("dev-up rejects OpenShell when Kubernetes Compute is not selected", async (t) => {
  const fixture = await createFixture(t);
  const result = await runDevUp([], {
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
    const result = await runDevDown({ ...fixture.env, OCC_DEVELOPMENT_COMPUTE_DRIVER: driver });
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
    const result = await fixture.start(["--key-output", keyOutput]);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
    if (scenario === "cluster-create-failed") {
      // k3d can fail with partial resources absent from its inventory. Retain
      // the recovery record until the operator explicitly retries cleanup.
      assert.match(result.stderr, /rollback incomplete; preserving/);
      assert.ok((await stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY)).isDirectory());
      const cleaned = await runDevDown(fixture.env);
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

test("Kubernetes dev-up keeps the failed stack for inspection when KEEP_ON_FAILURE is set", async (t) => {
  // The inspection override must skip rollback entirely: the state directory,
  // cluster, and any copied service key stay for diagnosis, and the operator
  // gets a cleanup hint naming occ dev down instead of a rollback error.
  const fixture = await kubernetesFixture(t, "api-unauthorized");
  fixture.env.OCC_DEVELOPMENT_KEEP_ON_FAILURE = "1";
  const keyOutput = join(fixture.directory, "retained-key.json");
  const result = await fixture.start(["--key-output", keyOutput]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authorization failed/);
  assert.match(result.stdout, /OCC_DEVELOPMENT_KEEP_ON_FAILURE is set; kept the failed stack/);
  assert.doesNotMatch(result.stderr, /rollback incomplete; preserving/);
  const directory = fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  await assert.ok((await stat(directory)).isDirectory());
  // The authorization failure happens before the service key is copied, so
  // the kept stack holds no key material to clean up.
  await assert.rejects(stat(keyOutput), { code: "ENOENT" });
  // The kept stack must still clean up through the recorded state.
  const cleaned = await runDevDown(fixture.env);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("Kubernetes-only dev-up stops and rolls back when the node resolver refuses queries", async (t) => {
  const fixture = await kubernetesFixture(t, "node-dns-refused");
  fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE = "kubernetes";
  fixture.env.OCC_DEVELOPMENT_SANDBOX_DRIVER = "none";
  fixture.env.DEV_UP_EXISTING_CONTROLLER_IMAGE = "1";
  fixture.env.DEV_UP_EXISTING_RUNTIME_IMAGE = "1";
  const result = await runDevUp([], fixture.env);
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
  const started = await fixture.start();
  assert.equal(started.status, 0, started.stderr);
  const directory = fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const state = await readFile(join(directory, "state.json"), "utf8");
  const failed = await runDevDown(fixture.env);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /cleanup incomplete; preserving/);
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), state);
  assert.deepEqual(JSON.parse(await readFile(fixture.env.DEV_UP_RESOURCE_STATE, "utf8")), {
    clusters: ["occ-dev-unrelated", "occ-dev-owned"],
    compose: false,
  });
  const retried = await runDevDown({ ...fixture.env, DEV_UP_LIFECYCLE_SCENARIO: "success" });
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
  await waitUntil(
    () => `startup to reach readiness: ${output}`,
    async () => {
      if (
        (await readJsonLines(fixture.requestLog)).some((row) => row.url === "/api/auth/session")
      ) {
        return true;
      }
      assert.equal(child.exitCode, null, output || "startup exited before readiness");
      return false;
    },
    { timeoutMs: 15_000 },
  );
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
  const started = await fixture.start();
  assert.equal(started.status, 0, started.stderr);
  const directory = join(temporary, "openclaw-development");
  assert.ok((await stat(directory)).isDirectory());
  assert.ok(started.stdout.includes(`OCC_DEVELOPMENT_STATE_DIRECTORY='${directory}'`));
  const stopped = await runDevDown(fixture.env);
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
      // The cancelled-creation scenario's k3d cluster create writes this file and then
      // never answers (tests/helpers/dev-up.mjs).
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
        await waitUntil("creation to start", () => existsSync(started), { timeoutMs: 15_000 });
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
