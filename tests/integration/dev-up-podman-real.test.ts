import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { availablePort } from "../helpers/available-port.mjs";
import {
  createQaInstallation,
  launcherEnvironment,
  prepareQaConsoleTheme,
  prepareQaPreset,
} from "../helpers/qa-installation.mjs";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

for (const [scenario, command] of [
  ["failed initialization", "exit 42"],
  ["blocked initialization", "sleep 300"],
]) {
  test(
    `Podman dev-up bounds ${scenario} and removes only its owned resources`,
    {
      skip: process.env.OCC_TEST_DEV_UP_PODMAN_REAL !== "1",
      timeout: 180_000,
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "oce-podman-failure-"));
      const stateDirectory = join(root, "state");
      const project = `occ-dev-failure-${randomUUID().slice(0, 8)}`;
      const ports = new Set<number>();
      while (ports.size < 4) {
        ports.add(await availablePort());
      }
      const [apiPort, postgresPort, browserPort, kubePort] = [...ports];
      const env = {
        ...launcherEnvironment(),
        OCC_DEVELOPMENT_CONTAINER_ENGINE: "podman",
        OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
        OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
        OCC_DEVELOPMENT_SANDBOX_DRIVER: "openshell",
        OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
        OCC_DEVELOPMENT_COMPOSE_PROJECT: project,
        OCC_DEVELOPMENT_KUBERNETES_CLUSTER: project,
        OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubePort),
        OCC_DEVELOPMENT_BROWSER_PORT: String(browserPort),
        OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "30",
        OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR:
          process.env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR ?? "172.30.41.0/24",
        OPENCLAW_DEV_PORT: String(apiPort),
        OCC_POSTGRES_PORT: String(postgresPort),
      };
      const run = (command: string, args: string[], timeout = 60_000) =>
        execute(command, args, { cwd: repository, env, timeout, maxBuffer: 8 * 1024 * 1024 });
      const exists = async (path: string) =>
        stat(path).then(
          () => true,
          () => false,
        );
      const sentinel = `${project}-unrelated`;
      await run("podman", ["volume", "create", sentinel]);
      t.after(async () => {
        try {
          if (await exists(stateDirectory)) {
            await run(join(repository, "scripts/dev-down"), [], 60_000);
          }
          await rm(root, { recursive: true });
        } finally {
          await run("podman", ["volume", "rm", sentinel]);
        }
      });

      const postgres = loadYaml(await readFile(join(repository, "compose.postgres.yaml"), "utf8"));
      // Use the real database image for the failing one-shot processes too. This
      // exercises actual dependency waits without building an unrelated runtime.
      const image = postgres.services.postgres.image;
      await run("podman", ["pull", image], 90_000);
      const override = join(root, "failure.yaml");
      const markerDirectory = join(root, "migration");
      await mkdir(markerDirectory, { mode: 0o700 });
      await writeFile(
        override,
        `services:
  migrate:
    build: !reset null
    image: ${image}
    entrypoint: ["/bin/sh", "-c"]
    command: ["touch /proof/started; ${command}"]
    volumes:
      - "${markerDirectory}:/proof:Z"
  bootstrap:
    build: !reset null
    image: ${image}
    entrypoint: ["/bin/sh", "-c"]
    command: ["exit 0"]
`,
        { mode: 0o600 },
      );
      const started = Date.now();
      let failed = false;
      try {
        await run(join(repository, "scripts/dev-up"), ["--", "-f", override], 100_000);
      } catch (error) {
        // Do not expose the captured Compose output or environment on assertion
        // failure. The resource observations below establish actual rollback.
        assert.ok(
          error instanceof Error && "code" in error && "stdout" in error && "stderr" in error,
        );
        assert.equal(typeof error.code, "number", "launcher must exit, not hit the test timeout");
        assert.match(String(error.stdout), /Starting the Compose database/);
        if (scenario === "blocked initialization") {
          assert.match(String(error.stderr), /context deadline exceeded/);
        }
        failed = true;
      }
      assert.ok(failed, "failed initialization must not report a ready stack");
      assert.ok(await exists(join(markerDirectory, "started")), "real migration process must run");
      assert.ok(Date.now() - started < 95_000, "provider dependency waits must be bounded");
      assert.equal(
        await exists(stateDirectory),
        false,
        "successful rollback removes recovery state",
      );
      for (const kind of ["container", "volume", "network"]) {
        const args = [kind, "ls", "--quiet"];
        if (kind === "container") {
          args.push("--all");
        }
        for (const prefix of ["com.docker.compose", "io.podman.compose"]) {
          const result = await run("podman", [
            ...args,
            "--filter",
            `label=${prefix}.project=${project}`,
          ]);
          assert.equal(result.stdout.trim(), "", `owned ${kind} remains after rollback`);
        }
      }
      const pods = await run("podman", [
        "pod",
        "ls",
        "--quiet",
        "--filter",
        `name=^pod_${project}$`,
      ]);
      assert.equal(pods.stdout.trim(), "", "provider must not leave an unowned Pod");
      await run("podman", ["volume", "inspect", sentinel]);
    },
  );
}

test(
  "Podman QA preserves private routing after theme and Preset preparation",
  { skip: process.env.OCC_TEST_DEV_UP_PODMAN_REAL !== "1", timeout: 1_200_000 },
  async (t) => {
    assert.equal(process.env.OCC_TEST_QA_CONTAINER_ENGINE, "podman");
    assert.equal(process.env.OCC_TEST_QA_SANDBOX_DRIVER, "openshell");
    const artifacts = await mkdtemp(join(tmpdir(), "oce-podman-routing-"));
    const f = await createQaInstallation(t, "compose", artifacts, { repositoryInputs: false });
    t.after(async () => {
      await f.resources.close();
      await rm(f.directory, { recursive: true });
      await rm(artifacts, { recursive: true });
    });
    const configuration = loadYaml(
      await readFile(join(f.stateDirectory, "installation.yaml"), "utf8"),
    );
    const routing = configuration.drivers.compute.configuration.gatewayRouting;
    const probe = async () => {
      const id = (
        await f.run("podman", [
          "ps",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${f.cluster}`,
          "--filter",
          "label=com.docker.compose.service=controller",
        ])
      ).trim();
      assert.equal(id.split(/\s+/).filter(Boolean).length, 1);
      // A TLS-verified 404 from Envoy proves the actual private network path.
      // No Agent route exists yet, and no model credential is needed.
      const status = await f.run(
        "podman",
        [
          "exec",
          id,
          "node",
          "-e",
          `
          const fs = require('node:fs');
          const https = require('node:https');
          const request = https.get({
            hostname: process.argv[1], port: Number(process.argv[2]), path: '/',
            ca: fs.readFileSync('/run/openclaw-development/gateway-ca.crt'),
            headers: { 'x-api-key': fs.readFileSync('/run/openclaw-development/gateway-api-key', 'utf8').trim() }
          }, response => {
            response.resume();
            response.on('end', () => process.stdout.write(String(response.statusCode)));
          });
          request.setTimeout(10000, () => request.destroy(new Error('private gateway timed out')));
          request.on('error', () => { process.stderr.write('private gateway unreachable'); process.exitCode = 1; });
        `,
          routing.hostname,
          String(routing.endpointPort),
        ],
        { timeout: 15_000 },
      );
      assert.equal(status, "404");
    };
    await probe();
    // These are the same real reconfigurations made before model-ui QA. A new
    // Podman IP would no longer match the private route's exact source policy.
    await prepareQaConsoleTheme(f);
    await probe();
    await prepareQaPreset(f, "Codex");
    await probe();
  },
);
