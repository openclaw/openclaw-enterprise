import { requireConfiguration } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { composeConfiguration } from "../helpers/compose.ts";
import { startDevUpInstallationServer } from "../helpers/dev-up-installation.ts";
import { stopProcess } from "../helpers/stop-process.mjs";
import { waitUntil } from "../helpers/wait-for.ts";
import {
  createFixture,
  matchingInstallationId,
  prepareLifecycleCommands,
  readJsonLines,
  runCommand,
  runDevDown,
  runDevUp,
  serviceKey,
} from "../helpers/dev-up.mjs";
import { registerKubernetesRecoveryCases } from "./dev-up-kubernetes-recovery-cases.ts";
import {
  registerFreshShellCustodyCases,
  registerStackRollbackCases,
} from "./dev-up-stack-custody-cases.ts";

// dev-up's Kubernetes Compute lifecycle: authenticated startup, cleanup, rollback and the real
// Go launcher's recovery. The Compose startup and preflight suites cover the Compose stack.

const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

/** @typedef {NonNullable<Parameters<typeof prepareLifecycleCommands>[1]>} LifecycleScenario */

// Serve the existing Installation HTTP contract in a child process so the real
// synchronous CLI can authenticate without blocking the test runner's event loop.
/**
 * @param {import("node:test").TestContext} t
 * @param {Awaited<ReturnType<typeof createFixture>>} fixture
 * @param {LifecycleScenario} scenario
 */
async function installationServer(t, fixture, scenario) {
  const requestLog = join(fixture.directory, "http-requests.jsonl");
  const tlsDirectoryFile = join(fixture.directory, "browser-tls-directory");
  const writeBrowserTlsDirectory = () => {
    const directory = fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
    if (directory !== undefined) {
      return writeFile(tlsDirectoryFile, directory);
    }
    const temporary = fixture.env.TMPDIR;
    assert.ok(temporary !== undefined, "The launcher fixture must select a temporary directory");
    return writeFile(tlsDirectoryFile, join(temporary, "openclaw-development"));
  };
  await writeBrowserTlsDirectory();
  const ports = await startDevUpInstallationServer(
    t,
    {
      requestLog,
      tlsDirectoryFile,
      scenario,
      installationId: matchingInstallationId,
    },
    stopProcess,
  );
  fixture.env.OPENCLAW_DEV_PORT = String(ports.http);
  fixture.env.OCC_DEVELOPMENT_BROWSER_PORT = String(ports.https);
  return { requestLog, writeBrowserTlsDirectory };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {LifecycleScenario} [scenario]
 * @param {Parameters<typeof createFixture>[1]} [options]
 */
async function kubernetesFixture(t, scenario = "success", options = {}) {
  const fixture = await createFixture(t, options);
  await prepareLifecycleCommands(fixture, scenario, options);
  fixture.env.OCC_DEVELOPMENT_COMPUTE_DRIVER = "kubernetes";
  fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE = "compose";
  const { requestLog, writeBrowserTlsDirectory } = await installationServer(t, fixture, scenario);
  /** @param {string[]} [args] */
  const start = async (args = []) => {
    await writeBrowserTlsDirectory();
    return runDevUp([...args, "--", "--env-file", fixture.emptyEnv], fixture.env);
  };
  return Object.assign(fixture, { writeBrowserTlsDirectory, requestLog, start });
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
  assert.equal(installation.drivers.plugin[0].id, "codex-plugin");
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

test("Kubernetes Compute defaults to the Kubernetes control plane", async (t) => {
  const fixture = await kubernetesFixture(t);
  delete fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE;

  // Without a control-plane selection, Kubernetes Compute selects the Kubernetes-only
  // profile, which refuses Compose options before it creates anything. The Compose
  // control plane would accept them and start.
  const result = await fixture.start();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Kubernetes-only profile does not accept Compose options/);
  await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
  assert.deepEqual(await readJsonLines(fixture.env.SAFETY_LOG), []);
});

registerFreshShellCustodyCases(kubernetesFixture);

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

registerStackRollbackCases(kubernetesFixture);

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

/**
 * @param {import("node:test").TestContext} t
 * @param {LifecycleScenario} scenario
 */
async function kubernetesOnlyFixture(t, scenario) {
  const fixture = await kubernetesFixture(t, scenario);
  fixture.env.OCC_DEVELOPMENT_CONTROL_PLANE = "kubernetes";
  fixture.env.OCC_DEVELOPMENT_SANDBOX_DRIVER = "none";
  fixture.env.DEV_UP_EXISTING_CONTROLLER_IMAGE = "1";
  fixture.env.DEV_UP_EXISTING_RUNTIME_IMAGE = "1";
  return fixture;
}

test("Kubernetes-only dev-up names a Docker stack holding its API port before creating anything", async (t) => {
  // A Docker-compatible stack left running holds the loopback API port; k3d would fail
  // later with only "port is already allocated". The preflight names the port, the
  // container, and the command that stops that stack.
  const fixture = await kubernetesOnlyFixture(t, "docker-stack-holds-api-port");
  const result = await runDevUp([], fixture.env);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes(
      `host port 127.0.0.1:${fixture.env.OPENCLAW_DEV_PORT} (OPENCLAW_DEV_PORT) is already published by container openclaw-enterprise-development-controller-1: a Docker-compatible development stack (Compose project openclaw-enterprise-development) may be running; stop it with OCC_DEVELOPMENT_COMPUTE_DRIVER=docker occ dev down`,
    ),
    result.stderr,
  );
  await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
  const commands = await readJsonLines(fixture.env.SAFETY_LOG);
  assert.equal(
    commands.some(({ command, args }) => command === "k3d" && args[1] === "create"),
    false,
  );
});

registerKubernetesRecoveryCases({
  kubernetesFixture,
  kubernetesOnlyFixture,
  stopProcess,
  waitUntil,
});
