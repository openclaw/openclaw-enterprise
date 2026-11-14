#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
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
const controllerProbePaths = [
  "/app/apps/controller/src/drivers/repo/github/access/admission-probe.mjs",
  "/app/apps/controller/src/drivers/repo/github/credentials/admission-probe.mjs",
];
const interruption = new AbortController();

class IncompatibleImageError extends Error {}
// A local setup problem the operator can fix; its message names no secrets.
class ProbeEnvironmentError extends Error {}

type ProbeMode = "recover" | "reserve";

type ImageIdentity = {
  image: string;
  platform: string;
  rootDigest: string;
  manifestDigest: string;
  configDigest: string;
};

type ProbeInput = {
  namespaceId: typeof backend;
  repositoryRef: typeof backend;
  expectedBinding: { providerInstanceId: typeof backend; repositoryId: "1"; grantId: string };
  profile: "git-write";
  durationSeconds: 60;
  deadlineWallMs: number;
  preparedOnly: true;
};

type ReceiptRequest = {
  kind: ProbeMode;
  admissionId: string;
  generation: string;
  input: ProbeInput;
};

type ProbeReport = {
  version: 1;
  mode: ProbeMode;
  admissionId: string;
  outcome: "missing" | "unavailable";
  input: ProbeInput;
};

type PairProof = {
  version: 1;
  daemonPlatform: string;
  controller: ImageIdentity;
  broker: ImageIdentity;
  reports: Record<ProbeMode, ProbeReport>;
  observations: Record<ProbeMode, ReceiptRequest>;
};

type RunOptions = { timeout?: number; cleanup?: true };

async function run(
  command: string,
  args: readonly string[],
  { timeout = 30000, cleanup }: RunOptions = {},
): Promise<string> {
  const options: ExecFileOptionsWithStringEncoding = {
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
    ...(cleanup ? {} : { signal: interruption.signal }),
  };
  const result = await execute(command, args, options);
  return result.stdout;
}

async function identity(image: string, target: string): Promise<ImageIdentity> {
  const value: unknown = JSON.parse(
    await run("python3", [identityScript, image, target], { timeout: 150000 }),
  );
  assert.ok(
    exactKeys(value, ["image", "platform", "rootDigest", "manifestDigest", "configDigest"]),
  );
  assert.ok(
    value.image === image &&
      value.platform === target &&
      typeof value.rootDigest === "string" &&
      typeof value.manifestDigest === "string" &&
      typeof value.configDigest === "string",
  );
  return {
    configDigest: value.configDigest,
    image: value.image,
    manifestDigest: value.manifestDigest,
    platform: value.platform,
    rootDigest: value.rootDigest,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys<Key extends string>(
  value: unknown,
  keys: readonly Key[],
): value is Record<Key, unknown> {
  return (
    isObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validateInput(input: unknown): asserts input is ProbeInput {
  assert.ok(
    exactKeys(input, [
      "namespaceId",
      "repositoryRef",
      "expectedBinding",
      "profile",
      "durationSeconds",
      "deadlineWallMs",
      "preparedOnly",
    ]),
  );
  assert.equal(input.namespaceId, backend);
  assert.equal(input.repositoryRef, backend);
  assert.equal(input.profile, "git-write");
  assert.equal(input.durationSeconds, 60);
  assert.equal(input.preparedOnly, true);
  assert.ok(
    typeof input.deadlineWallMs === "number" &&
      Number.isSafeInteger(input.deadlineWallMs) &&
      input.deadlineWallMs > 0,
  );
  assert.ok(exactKeys(input.expectedBinding, ["providerInstanceId", "repositoryId", "grantId"]));
  assert.equal(input.expectedBinding.providerInstanceId, backend);
  assert.equal(input.expectedBinding.repositoryId, "1");
  assert.ok(
    typeof input.expectedBinding.grantId === "string" &&
      input.expectedBinding.grantId.length > 0 &&
      input.expectedBinding.grantId.length <= 256,
  );
}

function validateReceiptRequest(
  body: unknown,
  ids: Partial<Record<ProbeMode, string>>,
): asserts body is ReceiptRequest {
  assert.ok(exactKeys(body, ["kind", "admissionId", "generation", "input"]));
  assert.ok(body.kind === "recover" || body.kind === "reserve");
  assert.ok(typeof body.admissionId === "string");
  assert.equal(body.admissionId, ids[body.kind]);
  assert.ok(typeof body.generation === "string");
  assert.match(
    body.generation,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  validateInput(body.input);
}

function validateReport(
  report: unknown,
  mode: ProbeMode,
  admissionId: string,
): asserts report is ProbeReport {
  assert.ok(exactKeys(report, ["version", "mode", "admissionId", "outcome", "input"]));
  assert.equal(report.version, 1);
  assert.equal(report.mode, mode);
  assert.equal(report.admissionId, admissionId);
  assert.equal(report.outcome, mode === "recover" ? "missing" : "unavailable");
  validateInput(report.input);
}

async function projectedDirectory(root: string, files: Readonly<Record<string, string | Buffer>>) {
  await mkdir(root, { mode: 0o700 });
  const generation = join(root, "..generation");
  await mkdir(generation, { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(generation, name), value, { mode: 0o600 });
  }
  await symlink("..generation", join(root, "..data"));
}

async function ready(path: string): Promise<boolean> {
  let missingThroughout = true;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    interruption.signal.throwIfAborted();
    try {
      const entry = await lstat(path);
      missingThroughout = false;
      if (!entry.isSocket()) {
        throw new Error("invalid control socket");
      }
      await new Promise<void>((resolve, reject) => {
        const connection = createConnection(path);
        connection.once("connect", () => {
          connection.destroy();
          resolve();
        });
        connection.once("error", reject);
      });
      return true;
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") {
        missingThroughout = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!missingThroughout) {
    throw new Error("broker control socket was not ready");
  }
  return false;
}

async function ownedBrokerExitCode(containerId: string, owner: string) {
  const format =
    '{{.Id}} {{index .Config.Labels "openclaw.upgrade-probe"}} ' +
    "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{json .State.Error}}";
  const result = /^([a-f0-9]{64}) (\S+) exited ([1-9][0-9]{0,2}) false ""\n$/u.exec(
    await run("docker", ["inspect", "--type", "container", "--format", format, containerId]),
  );
  if (result?.[1] === containerId && result[2] === owner && Number(result[3]) <= 255) {
    return result[3];
  }
}

export async function checkBrokerCapability(path: string) {
  const result = await new Promise<{ status: number | undefined; body: string }>(
    (resolve, reject) => {
      const req = request(
        { socketPath: path, method: "GET", path: "/v1/capabilities", timeout: 5000 },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
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
    },
  );
  if (result.status === 404 && result.body === '{"error":"not-found"}') {
    throw new IncompatibleImageError("broker durable admission capability is missing");
  }
  assert.equal(result.status, 200, "broker capability request failed");
  const capability: unknown = JSON.parse(result.body);
  assert.ok(capability && isObject(capability));
  assert.equal(capability.durableAdmissionVersion, 1, "unsupported broker admission capability");
}

async function main(args: readonly string[]) {
  process.once("SIGINT", () => interruption.abort());
  process.once("SIGTERM", () => interruption.abort());
  const [controller, broker, target] = args;
  assert.equal(args.length, 3);
  assert.ok(controller !== undefined && broker !== undefined && target !== undefined);
  let native;
  if (platform() === "linux" && arch() === "x64") {
    native = "linux/amd64";
  } else if (platform() === "linux" && arch() === "arm64") {
    native = "linux/arm64";
  }
  assert.equal(target, native, "the probe must run on the target's native architecture");
  assert.equal(process.getuid?.(), 1000, "the fixture must run as the broker's UID 1000");
  // Check before Docker runs or anything is created. mkdtemp adds six characters, and
  // receipt.sock and control.sock have the same length; 103 bytes binds on Linux and macOS.
  const receiptSocket = join(tmpdir(), "oce-pair-XXXXXX", "control", "receipt.sock");
  if (Buffer.byteLength(receiptSocket) > 103) {
    throw new ProbeEnvironmentError(
      `socket path ${receiptSocket} is ${Buffer.byteLength(receiptSocket)} bytes, over the ` +
        "103-byte Unix socket limit; set TMPDIR to a shorter directory",
    );
  }
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
  const ids: Partial<Record<ProbeMode, string>> = {};
  const observations = new Map<ProbeMode, ReceiptRequest>();
  let invalid = false;
  let fixture: Server | undefined;
  let socketWatcher: FSWatcher | undefined;
  let proof: PairProof | undefined;
  let probeFailed = false;
  let probeError;
  let cleanupFailed = false;
  let cleanupError;
  try {
    await mkdir(control, { mode: 0o700 });
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
          defaultProfile: "git-write",
          allowedProfiles: ["git-write"],
        },
        backend: { kind: "github-prepared-git-registry", backendId: backend },
      }),
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
            namespaces: [
              {
                namespaceId: backend,
                profiles: ["git-write"],
                transport: "git-only",
                pushRefAllowlist: ["refs/heads/compatibility-probe"],
              },
            ],
          },
        ],
      }),
    });

    const receiptFixture = createServer((request, response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
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
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          validateReceiptRequest(body, ids);
          assert.ok(!observations.has(body.kind));
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
    fixture = receiptFixture;
    await new Promise<void>((resolve, reject) => {
      receiptFixture.once("error", reject);
      receiptFixture.listen(join(control, "receipt.sock"), resolve);
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
    const controllerCommand = await run("docker", [
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
      `const fs = require("node:fs");
for (const path of process.argv.slice(1)) {
  try {
    fs.accessSync(path, fs.constants.R_OK);
    process.stdout.write(path);
    break;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}`,
      ...controllerProbePaths,
    ]);
    if (!controllerCommand) {
      throw new IncompatibleImageError("controller admission probe is missing");
    }
    assert.ok(controllerProbePaths.includes(controllerCommand));
    // A process may create and unlink its socket before Docker returns the container ID.
    // Without continuous observation, an early exit alone cannot rule out socket activity.
    let canDiagnoseEarlyExit = true;
    try {
      socketWatcher = watch(control, (_event, filename) => {
        if (filename === null || filename === "control.sock") {
          canDiagnoseEarlyExit = false;
        }
      });
      socketWatcher.on("error", () => {
        canDiagnoseEarlyExit = false;
      });
    } catch {
      canDiagnoseEarlyExit = false;
    }
    const brokerId = (
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
        "--authority",
        "prepared-git",
      ])
    ).trim();
    assert.match(brokerId, /^[a-f0-9]{64}$/u);
    if (!(await ready(join(control, "control.sock")))) {
      const exitCode = await ownedBrokerExitCode(brokerId, owner);
      if (canDiagnoseEarlyExit && exitCode) {
        throw new IncompatibleImageError(
          "broker exited before its control socket was ready (exit " + exitCode + ")",
        );
      }
      throw new Error("broker control socket was not ready");
    }
    await checkBrokerCapability(join(control, "control.sock"));
    const reports: Partial<Record<ProbeMode, ProbeReport>> = {};
    for (const mode of ["recover", "reserve"] as const) {
      const admissionId = `${Date.now()}-${randomUUID()}`;
      ids[mode] = admissionId;
      const output = await run("docker", [
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
        admissionId,
      ]);
      const report: unknown = JSON.parse(output);
      validateReport(report, mode, admissionId);
      assert.deepEqual(report.input, observations.get(mode)?.input);
      reports[mode] = report;
    }
    assert.equal(invalid, false);
    assert.equal(observations.size, 2);
    const recover = observations.get("recover");
    const reserve = observations.get("reserve");
    assert.ok(recover && reserve);
    assert.equal(recover.generation, reserve.generation);
    assert.ok(reports.recover && reports.reserve);
    assert.deepEqual(await identity(controller, target), controllerIdentity);
    assert.deepEqual(await identity(broker, target), brokerIdentity);
    proof = {
      version: 1,
      daemonPlatform: daemon,
      controller: controllerIdentity,
      broker: brokerIdentity,
      reports: { recover: reports.recover, reserve: reports.reserve },
      observations: { recover, reserve },
    };
  } catch (error) {
    probeFailed = true;
    probeError = error;
  } finally {
    socketWatcher?.close();
    // Inspect even after a failed or timed-out launch: Docker may have created
    // the container before the client lost the response.
    for (const container of [brokerName, `${name}-inspect`, `${name}-recover`, `${name}-reserve`]) {
      try {
        const names = (
          await run(
            "docker",
            ["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"],
            { cleanup: true },
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
              { cleanup: true },
            )
          ).trim();
          assert.equal(label, owner, "probe container ownership changed");
          await run("docker", ["rm", "-f", container], { cleanup: true });
        }
      } catch (error) {
        cleanupFailed = true;
        cleanupError ??= error;
      }
    }
    if (fixture) {
      const receiptFixture = fixture;
      receiptFixture.closeAllConnections();
      await new Promise<void>((resolve) => receiptFixture.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
    if (cleanupFailed) {
      process.stderr.write(`Could not clean probe containers with prefix ${name}.\n`);
    }
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  interruption.signal.throwIfAborted();
  if (probeFailed) {
    throw probeError;
  }
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const detail =
      error instanceof IncompatibleImageError || error instanceof ProbeEnvironmentError
        ? `: ${error.message}`
        : "";
    process.stderr.write(`repository image-pair probe failed${detail}\n`);
    process.exitCode = 1;
  });
}
