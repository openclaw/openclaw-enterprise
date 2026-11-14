import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkBrokerCapability } from "../../scripts/upgrade-repository-image-probe.ts";
import { testOwner, withTestOwnerLabel } from "../helpers/docker-test-owner.mjs";
import { commandPath, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const execute = promisify(execFile);
const probeFailure = "repository image-pair probe failed";
const missingCapability = "broker durable admission capability is missing";
const pairScript = fileURLToPath(
  new URL("../../scripts/upgrade-repository-image-probe.ts", import.meta.url),
);
const imageScript = fileURLToPath(
  new URL("../../scripts/upgrade-image-identity.py", import.meta.url),
);

const controllerImage = process.env.OCC_PROBE_CONTROLLER_IMAGE;
const brokerImage = process.env.OCC_PROBE_BROKER_IMAGE;
const oldControllerImage = process.env.OCC_PROBE_OLD_CONTROLLER_IMAGE;
const oldBrokerImage = process.env.OCC_PROBE_OLD_BROKER_IMAGE;
const architectures: Partial<Record<NodeJS.Architecture, string>> = {
  x64: "linux/amd64",
  arm64: "linux/arm64",
};
const nativePlatform = process.platform === "linux" ? architectures[process.arch] : undefined;

function rawCapability(socketPath: string) {
  return new Promise<{ status: number | undefined; body: Buffer }>((resolve, reject) => {
    const req = request({ socketPath, path: "/v1/capabilities", timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16384) {
          res.destroy(new Error("historical capability response too large"));
        } else {
          chunks.push(chunk);
        }
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("historical capability request timed out")));
    req.end();
  });
}

async function expectedBrokerRefusal(image: string, platform: string) {
  const owner = randomUUID();
  const name = "oce-old-pair-" + owner;
  const root = await mkdtemp(join(tmpdir(), "oce-old-pair-"));
  const inputs = join(root, "inputs");
  const registry = join(root, "registry");
  const control = join(root, "control");
  const controlMount = "/run/openclaw/repository-control/private";
  const controlSocket = join(control, "control.sock");
  const backend = "compatibility-probe";
  const origin = "https://credentials.example.test";
  const label = "openclaw.upgrade-probe=" + owner;
  const docker = (args: string[]) =>
    execute("docker", withTestOwnerLabel("docker", args), { timeout: 30000 });

  async function project(directory: string) {
    const generation = join(directory, "..generation");
    await mkdir(directory, { mode: 0o700 });
    await mkdir(generation, { mode: 0o700 });
    await symlink("..generation", join(directory, "..data"));
    return generation;
  }

  async function removeContainer() {
    const { stdout } = await docker([
      "ps",
      "-a",
      "--filter",
      "name=^/" + name + "$",
      "--filter",
      "label=" + label,
      "--format",
      "{{.ID}}",
      "--no-trunc",
    ]);
    const id = stdout.trim();
    if (id) {
      assert.match(id, /^[a-f0-9]{64}$/u);
      await docker(["rm", "-f", id]);
    }
  }

  async function launch(authority: string[]) {
    const { stdout } = await docker([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      label,
      "--platform",
      platform,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=256m",
      "--tmpfs",
      "/run/openclaw/repository-private:rw,size=4m,mode=0700,uid=1000,gid=1000",
      "--mount",
      "type=bind,src=" + control + ",dst=" + controlMount,
      "--mount",
      "type=bind,src=" + inputs + ",dst=/etc/openclaw/repository-inputs,readonly",
      "--mount",
      "type=bind,src=" + registry + ",dst=/etc/openclaw/repository-registry,readonly",
      "--entrypoint",
      "node",
      image,
      "/app/dist/composition/repository-credentials/projected-inputs.js",
      "--public-origin",
      origin,
      "--backend-id",
      backend,
      ...authority,
    ]);
    const id = stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/u);
    return id;
  }

  async function writeProjection(
    inputGeneration: string,
    registryGeneration: string,
    prepared: boolean,
  ) {
    const profile = prepared ? "git-write" : "git-read";
    await writeFile(
      join(inputGeneration, "config.json"),
      JSON.stringify({
        gateway: { listen: "0.0.0.0:8443", controlSocket: controlMount + "/control.sock" },
        sessionPolicy: {
          maximumDurationSeconds: 60,
          defaultProfile: profile,
          allowedProfiles: [profile],
        },
        backend: {
          kind: prepared ? "github-prepared-git-registry" : "github-app-registry",
          backendId: backend,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(registryGeneration, "registry.json"),
      JSON.stringify({
        version: 1,
        backendId: backend,
        providerInstanceId: backend,
        appId: "1",
        githubInstallationId: "1",
        maximumDurationSeconds: 60,
        repositories: [
          {
            repositoryRef: backend,
            repositoryId: "1",
            repository: "fixture/repository",
            namespaces: [
              {
                namespaceId: backend,
                profiles: [profile],
                ...(prepared
                  ? { transport: "git-only", pushRefAllowlist: ["refs/heads/compatibility-probe"] }
                  : {}),
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );
  }

  async function readWhenReady() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        return await rawCapability(controlSocket);
      } catch (error) {
        assert.ok(error instanceof Error && "code" in error);
        assert.ok(error.code === "ENOENT" || error.code === "ECONNREFUSED");
        await delay(100);
      }
    }
    return undefined;
  }

  async function assertMissing(response: Awaited<ReturnType<typeof readWhenReady>>) {
    assert.deepEqual(response, { status: 404, body: Buffer.from('{"error":"not-found"}') });
    await assert.rejects(checkBrokerCapability(controlSocket), { message: missingCapability });
  }

  async function assertEarlyExit(id: string) {
    assert.equal((await docker(["wait", id])).stdout, "1\n");
    const format =
      '{{.Id}} {{index .Config.Labels "openclaw.upgrade-probe"}} ' +
      "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{json .State.Error}}";
    assert.equal(
      (await docker(["inspect", "--type", "container", "--format", format, id])).stdout,
      id + " " + owner + ' exited 1 false ""\n',
    );
    assert.deepEqual(await readdir(control), []);
  }

  async function probePreparedAuthority() {
    // A broker can unlink its socket during shutdown. Watch before launch so
    // an empty directory after exit cannot hide a transient socket.
    let socketObserved = false;
    const watcher = watch(control, (_event, filename) => {
      socketObserved ||= filename === null || filename === "control.sock";
    });
    try {
      const id = await launch(["--authority", "prepared-git"]);
      const response = await readWhenReady();
      if (response) {
        await assertMissing(response);
        return "missing-capability";
      }
      await assertEarlyExit(id);
      assert.equal(socketObserved, false, "broker opened its control socket before exit");
      return "early-exit";
    } finally {
      watcher.close();
    }
  }

  try {
    // A killed test cannot run finally. Match the directory to the Docker process owner for recovery.
    await writeFile(join(root, "owner.json"), JSON.stringify({ testOwner, probeOwner: owner }), {
      mode: 0o600,
    });
    await mkdir(control, { mode: 0o700 });
    const inputGeneration = await project(inputs);
    const registryGeneration = await project(registry);
    await execute(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=credentials.example.test",
        "-addext",
        "subjectAltName=DNS:credentials.example.test",
        "-keyout",
        join(inputGeneration, "tls.key"),
        "-out",
        join(inputGeneration, "tls.crt"),
      ],
      { timeout: 30000 },
    );
    // Observe the packaged broker independently before checking what the operator CLI reports.
    await writeProjection(inputGeneration, registryGeneration, true);
    if ((await probePreparedAuthority()) === "missing-capability") {
      return missingCapability;
    }
    await removeContainer();

    // The historical loader requires an App key. Generate an unregistered key for the offline fixture.
    await execute(
      "openssl",
      [
        "genpkey",
        "-algorithm",
        "RSA",
        "-pkeyopt",
        "rsa_keygen_bits:2048",
        "-out",
        join(inputGeneration, "private-key.pem"),
      ],
      { timeout: 30000 },
    );
    await writeProjection(inputGeneration, registryGeneration, false);
    await launch([]);
    await assertMissing(await readWhenReady());
    await removeContainer();
    await rm(controlSocket, { force: true });

    // Only the later authority arguments change on this otherwise working historical projection.
    assert.equal(await probePreparedAuthority(), "early-exit");
    return "broker exited before its control socket was ready (exit 1)";
  } finally {
    try {
      await removeContainer();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

test(
  "staged controller and broker images qualify through the real Driver and broker",
  {
    skip:
      !controllerImage || !brokerImage || !nativePlatform
        ? "staged image pair is not configured"
        : false,
    timeout: 360000,
  },
  async () => {
    assert.ok(controllerImage && brokerImage && nativePlatform);
    const { stdout } = await execute(
      process.execPath,
      [pairScript, controllerImage, brokerImage, nativePlatform],
      { timeout: 350000 },
    );
    const proof: unknown = JSON.parse(stdout);
    assert.partialDeepStrictEqual(proof, {
      controller: { image: controllerImage },
      broker: { image: brokerImage },
      reports: { recover: { outcome: "missing" }, reserve: { outcome: "unavailable" } },
    });
  },
);

test(
  "incompatible old and new staged image pairs are rejected",
  {
    skip:
      !controllerImage || !brokerImage || !oldControllerImage || !oldBrokerImage || !nativePlatform
        ? "staged current and old image pairs are not configured"
        : false,
    timeout: 2100000,
  },
  async (t) => {
    assert.ok(
      controllerImage && brokerImage && oldControllerImage && oldBrokerImage && nativePlatform,
    );
    // Establish a working fixture and staged images before attributing failures
    // to either incompatibility rather than Docker, setup, or a missing image.
    for (const image of [controllerImage, brokerImage, oldControllerImage, oldBrokerImage]) {
      await execute("python3", [imageScript, image, nativePlatform], { timeout: 150000 });
    }
    await execute(process.execPath, [pairScript, controllerImage, brokerImage, nativePlatform], {
      timeout: 350000,
    });

    const cli = (controller: string, broker: string) =>
      execute(process.execPath, [pairScript, controller, broker, nativePlatform], {
        timeout: 350000,
      });
    await t.test("current controller refuses the broker without durable admission", async (t) => {
      const detail = await expectedBrokerRefusal(oldBrokerImage, nativePlatform);
      await assert.rejects(cli(controllerImage, oldBrokerImage), {
        code: 1,
        stdout: "",
        stderr: probeFailure + ": " + detail + "\n",
      });
      if (detail === missingCapability) {
        return;
      }

      // Docker has launched the real historical broker. Briefly place an invalid entry at
      // its socket path before returning the container ID to the CLI's readiness loop.
      const root = await temporaryDirectory(t, "oce-pair-transient-");
      const marker = join(root, "entry-removed");
      await writeCommand(
        root,
        "docker",
        'PATH="$OCE_PAIR_REAL_PATH"\n' +
          'if [ "$1" = run ] && [ "$2" = -d ]; then\n' +
          '  id=$(docker "$@") || exit $?\n' +
          '  for arg in "$@"; do\n' +
          '    case "$arg" in type=bind,src=*,dst=/run/openclaw/repository-control/private)\n' +
          "      src=${arg#type=bind,src=}\n" +
          '      entry="${src%,dst=*}/control.sock"\n' +
          '      ln -s absent "$entry" && rm "$entry" && touch "$OCE_PAIR_ENTRY_MARKER" || exit 1\n' +
          "    esac\n" +
          "  done\n" +
          '  echo "$id"\n' +
          "  exit 0\n" +
          "fi\n" +
          'exec docker "$@"',
      );
      await assert.rejects(
        execute(process.execPath, [pairScript, controllerImage, oldBrokerImage, nativePlatform], {
          timeout: 350000,
          env: {
            ...process.env,
            PATH: commandPath(root),
            OCE_PAIR_REAL_PATH: process.env.PATH,
            OCE_PAIR_ENTRY_MARKER: marker,
          },
        }),
        { code: 1, stdout: "", stderr: probeFailure + "\n" },
      );
      assert.deepEqual((await readdir(root)).sort(), ["docker", "entry-removed"]);
    });
    for (const [name, broker] of [
      ["current", brokerImage],
      ["old", oldBrokerImage],
    ] as const) {
      await t.test("old controller refuses with the " + name + " broker", async () => {
        await assert.rejects(cli(oldControllerImage, broker), {
          code: 1,
          stdout: "",
          stderr: probeFailure + ": controller admission probe is missing\n",
        });
      });
    }
    await t.test("a failed Docker launch leaves broker readiness inconclusive", async (t) => {
      const root = await temporaryDirectory(t, "oce-pair-launch-");
      const marker = join(root, "launch-attempted");
      // Delegate every operation to Docker up to the detached broker launch.
      // A client failure there provides no container state to classify.
      await writeCommand(
        root,
        "docker",
        'if [ "$1" = run ] && [ "$2" = -d ]; then\n' +
          '  touch "$OCE_PAIR_LAUNCH_MARKER"\n' +
          "  exit 87\n" +
          "fi\n" +
          'PATH="$OCE_PAIR_REAL_PATH" exec docker "$@"',
      );
      await assert.rejects(
        execute(process.execPath, [pairScript, controllerImage, brokerImage, nativePlatform], {
          timeout: 350000,
          env: {
            ...process.env,
            PATH: commandPath(root),
            OCE_PAIR_REAL_PATH: process.env.PATH,
            OCE_PAIR_LAUNCH_MARKER: marker,
          },
        }),
        { code: 1, stdout: "", stderr: probeFailure + "\n" },
      );
      assert.deepEqual((await readdir(root)).sort(), ["docker", "launch-attempted"]);
    });
  },
);
