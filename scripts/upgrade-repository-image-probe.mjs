#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createConnection } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const identityScript = join(dirname(fileURLToPath(import.meta.url)), "upgrade-image-identity.py");
const socket = "/run/openclaw/repository-control/private/control.sock";
const origin = "https://credentials.example.test";
const backend = "compatibility-probe";
const brokerCommand = "/app/dist/composition/repository-credentials/projected-inputs.js";
const controllerCommand =
  "/app/apps/controller/src/drivers/repo/github/credentials/admission-probe.mjs";
const interruption = new AbortController();

class IncompatibleImageError extends Error {}

async function run(command, args, timeout = 30000, cleanup = false) {
  const result = await execute(command, args, {
    timeout,
    maxBuffer: 1024 * 1024,
    signal: cleanup ? undefined : interruption.signal,
  });
  return result.stdout;
}

async function identity(image, target) {
  return JSON.parse(await run("python3", [identityScript, image, target], 150000));
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function validateInput(input) {
  assert.ok(
    exactKeys(input, [
      "namespaceId",
      "repositoryRef",
      "expectedBinding",
      "profile",
      "durationSeconds",
      "deadlineWallMs",
    ]),
  );
  assert.equal(input.namespaceId, backend);
  assert.equal(input.repositoryRef, backend);
  assert.equal(input.profile, "git-read");
  assert.equal(input.durationSeconds, 60);
  assert.ok(Number.isSafeInteger(input.deadlineWallMs) && input.deadlineWallMs > 0);
  assert.ok(exactKeys(input.expectedBinding, ["providerInstanceId", "repositoryId", "grantId"]));
  assert.equal(input.expectedBinding.providerInstanceId, backend);
  assert.equal(input.expectedBinding.repositoryId, "1");
  assert.ok(
    typeof input.expectedBinding.grantId === "string" &&
      input.expectedBinding.grantId.length > 0 &&
      input.expectedBinding.grantId.length <= 256,
  );
}

async function projectedDirectory(root, files) {
  await mkdir(root, { mode: 0o700 });
  const generation = join(root, "..generation");
  await mkdir(generation, { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(generation, name), value, { mode: 0o600 });
  }
  await symlink("..generation", join(root, "..data"));
}

async function ready(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    interruption.signal.throwIfAborted();
    try {
      if (!(await stat(path)).isSocket()) {
        throw new Error("invalid control socket");
      }
      await new Promise((resolve, reject) => {
        const connection = createConnection(path);
        connection.once("connect", () => {
          connection.destroy();
          resolve();
        });
        connection.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("broker control socket was not ready");
}

export async function checkBrokerCapability(path) {
  const result = await new Promise((resolve, reject) => {
    const req = request(
      { socketPath: path, method: "GET", path: "/v1/capabilities", timeout: 5000 },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16384) {
            response.destroy(new Error("capability response too large"));
          } else {
            chunks.push(chunk);
          }
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("capability request timed out")));
    req.on("error", reject);
    req.end();
  });
  if (result.status === 404 && result.body === '{"error":"not-found"}') {
    throw new IncompatibleImageError("broker durable admission capability is missing");
  }
  assert.equal(result.status, 200, "broker capability request failed");
  const capability = JSON.parse(result.body);
  assert.ok(capability && typeof capability === "object" && !Array.isArray(capability));
  assert.equal(capability.durableAdmissionVersion, 1, "unsupported broker admission capability");
}

async function main() {
  process.once("SIGINT", () => interruption.abort());
  process.once("SIGTERM", () => interruption.abort());
  assert.equal(process.argv.length, 5);
  const controller = process.argv[2];
  const broker = process.argv[3];
  const target = process.argv[4];
  let native;
  if (platform() === "linux" && arch() === "x64") {
    native = "linux/amd64";
  } else if (platform() === "linux" && arch() === "arm64") {
    native = "linux/arm64";
  }
  assert.equal(target, native, "the probe must run on the target's native architecture");
  assert.equal(process.getuid?.(), 1000, "the fixture must run as the broker's UID 1000");
  const daemon = (await run("docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"]))
    .trim()
    .replace("linux/x86_64", "linux/amd64")
    .replace("linux/aarch64", "linux/arm64");
  assert.equal(daemon, target, "the Docker daemon must use the target's native architecture");
  const controllerIdentity = await identity(controller, target);
  const brokerIdentity = await identity(broker, target);
  const root = await mkdtemp(join(tmpdir(), "oce-pair-"));
  const control = join(root, "control");
  const inputs = join(root, "inputs");
  const registry = join(root, "registry");
  const name = `oce-pair-${randomUUID()}`;
  const brokerName = `${name}-broker`;
  const owner = randomUUID();
  const ids = {};
  const observations = new Map();
  let invalid = false;
  let fixture;
  let proof;
  let probeFailed = false;
  let probeError;
  let cleanupFailed = false;
  let cleanupError;
  try {
    await mkdir(control, { mode: 0o700 });
    assert.ok(Buffer.byteLength(join(control, "receipt.sock")) <= 103);
    await run("openssl", [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:2048",
      "-out",
      join(root, "app.pem"),
    ]);
    await run("openssl", [
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
      join(root, "tls.key"),
      "-out",
      join(root, "tls.crt"),
    ]);
    await projectedDirectory(inputs, {
      "config.json": JSON.stringify({
        gateway: { listen: "0.0.0.0:8443", controlSocket: socket },
        sessionPolicy: {
          maximumDurationSeconds: 60,
          defaultProfile: "git-read",
          allowedProfiles: ["git-read"],
        },
        backend: { kind: "github-app-registry", backendId: backend },
      }),
      "private-key.pem": await readFile(join(root, "app.pem")),
      "tls.crt": await readFile(join(root, "tls.crt")),
      "tls.key": await readFile(join(root, "tls.key")),
    });
    await projectedDirectory(registry, {
      "registry.json": JSON.stringify({
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
            namespaces: [{ namespaceId: backend, profiles: ["git-read"] }],
          },
        ],
      }),
    });

    fixture = createServer((request, response) => {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16384) {
          invalid = true;
          request.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      request.on("error", () => {
        invalid = true;
      });
      request.on("end", () => {
        try {
          assert.equal(request.method, "POST");
          assert.equal(request.url, "/v1/receipt");
          assert.equal(request.headers["content-type"], "application/json");
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          assert.ok(exactKeys(body, ["kind", "admissionId", "generation", "input"]));
          assert.ok(body.kind === "recover" || body.kind === "reserve");
          assert.equal(body.admissionId, ids[body.kind]);
          assert.match(
            body.generation,
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          assert.ok(!observations.has(body.kind));
          validateInput(body.input);
          observations.set(body.kind, body);
          response.writeHead(body.kind === "recover" ? 200 : 503, {
            "content-type": "application/json",
          });
          response.end(body.kind === "recover" ? '{"kind":"missing"}' : "{}");
        } catch {
          invalid = true;
          response.writeHead(400);
          response.end();
        }
      });
    });
    await new Promise((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(join(control, "receipt.sock"), resolve);
    });
    await chmod(join(control, "receipt.sock"), 0o600);
    const isolation = [
      "--platform",
      target,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=256m",
    ];
    // Diagnose a missing packaged probe only after Node runs successfully in
    // the selected image. Other container failures remain inconclusive.
    const probeFile = await run("docker", [
      "run",
      "--rm",
      "--name",
      `${name}-inspect`,
      "--label",
      `openclaw.upgrade-probe=${owner}`,
      ...isolation,
      "--entrypoint",
      "node",
      controller,
      "-e",
      'const fs = require("node:fs"); try { fs.accessSync(process.argv[1], fs.constants.R_OK); process.stdout.write("present"); } catch (error) { if (error.code !== "ENOENT") throw error; process.stdout.write("missing"); }',
      controllerCommand,
    ]);
    assert.ok(probeFile === "present" || probeFile === "missing");
    if (probeFile === "missing") {
      throw new IncompatibleImageError("controller admission probe is missing");
    }
    await run("docker", [
      "run",
      "-d",
      "--name",
      brokerName,
      "--label",
      `openclaw.upgrade-probe=${owner}`,
      ...isolation,
      "--tmpfs",
      "/run/openclaw/repository-private:rw,size=4m,mode=0700,uid=1000,gid=1000",
      "--mount",
      `type=bind,src=${control},dst=/run/openclaw/repository-control/private`,
      "--mount",
      `type=bind,src=${inputs},dst=/etc/openclaw/repository-inputs,readonly`,
      "--mount",
      `type=bind,src=${registry},dst=/etc/openclaw/repository-registry,readonly`,
      "--entrypoint",
      "node",
      broker,
      brokerCommand,
      "--public-origin",
      origin,
      "--backend-id",
      backend,
    ]);
    await ready(join(control, "control.sock"));
    await checkBrokerCapability(join(control, "control.sock"));
    const reports = {};
    for (const mode of ["recover", "reserve"]) {
      ids[mode] = `${Date.now()}-${randomUUID()}`;
      const output = await run(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          `${name}-${mode}`,
          "--label",
          `openclaw.upgrade-probe=${owner}`,
          ...isolation,
          "--mount",
          `type=bind,src=${control},dst=/run/openclaw/repository-control/private`,
          "--entrypoint",
          "node",
          controller,
          controllerCommand,
          socket,
          mode,
          ids[mode],
        ],
        30000,
      );
      const report = JSON.parse(output);
      assert.ok(exactKeys(report, ["version", "mode", "admissionId", "outcome", "input"]));
      assert.equal(report.version, 1);
      assert.equal(report.mode, mode);
      assert.equal(report.admissionId, ids[mode]);
      assert.equal(report.outcome, mode === "recover" ? "missing" : "unavailable");
      validateInput(report.input);
      assert.deepEqual(report.input, observations.get(mode)?.input);
      reports[mode] = report;
    }
    assert.equal(invalid, false);
    assert.equal(observations.size, 2);
    assert.equal(observations.get("recover").generation, observations.get("reserve").generation);
    assert.deepEqual(await identity(controller, target), controllerIdentity);
    assert.deepEqual(await identity(broker, target), brokerIdentity);
    proof = {
      version: 1,
      daemonPlatform: daemon,
      controller: controllerIdentity,
      broker: brokerIdentity,
      reports,
      observations: Object.fromEntries(observations),
    };
  } catch (error) {
    probeFailed = true;
    probeError = error;
  } finally {
    // Inspect even after a failed or timed-out launch: Docker may have created
    // the container before the client lost the response.
    for (const container of [brokerName, `${name}-inspect`, `${name}-recover`, `${name}-reserve`]) {
      try {
        const names = (
          await run(
            "docker",
            ["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"],
            30000,
            true,
          )
        ).trim();
        if (names) {
          assert.equal(names, container, "probe container name is ambiguous");
          const label = (
            await run(
              "docker",
              [
                "inspect",
                "--format",
                '{{index .Config.Labels "openclaw.upgrade-probe"}}',
                container,
              ],
              30000,
              true,
            )
          ).trim();
          assert.equal(label, owner, "probe container ownership changed");
          await run("docker", ["rm", "-f", container], 30000, true);
        }
      } catch (error) {
        cleanupFailed = true;
        cleanupError ??= error;
      }
    }
    if (fixture) {
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
    if (cleanupFailed) {
      process.stderr.write(`Could not clean probe containers with prefix ${name}.\n`);
    }
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  if (probeFailed) {
    throw probeError;
  }
  interruption.signal.throwIfAborted();
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const detail = error instanceof IncompatibleImageError ? `: ${error.message}` : "";
    process.stderr.write(`repository image-pair probe failed${detail}\n`);
    process.exitCode = 1;
  });
}
