// Capture real old-runtime state. No provider or model credentials are supplied.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  checkNativeProfileFixture,
  nativeProfileFixtureConfiguration,
  nativeProfileFixtureMessage,
  nativeProfileFixtureName,
} from "../tests/helpers/native-profile-state-fixture.mjs";

const { values } = parseArgs({ options: { image: { type: "string" }, out: { type: "string" } } });
assert.match(values.image ?? "", /@sha256:[a-f0-9]{64}$/, "--image must be immutable");
assert.ok(values.out, "--out must name a new output directory");
const image = values.image;
const output = resolve(values.out);
await mkdir(output, { mode: 0o700 });
const temporary = await mkdtemp(join(tmpdir(), "oce-profile-fixture-"));
const containers = [];
const volumes = [];
const execute = promisify(execFile);
async function docker(args) {
  try {
    return await execute("docker", args, { timeout: 180_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new Error(`Docker ${args[0]} failed: ${String(error.stderr ?? "").slice(-8000)}`, {
      cause: error,
    });
  }
}

async function stateVolume(archive) {
  const volume = `oce-profile-fixture-${randomUUID()}`;
  await docker(["volume", "create", volume]);
  volumes.push(volume);
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0:0",
    "--volume",
    `${volume}:/home/node`,
    ...(archive ? ["--volume", `${archive}:/fixture.tar.gz:ro`] : []),
    "--entrypoint",
    "sh",
    image,
    "-c",
    `${archive ? "tar -xzf /fixture.tar.gz -C /home/node && " : ""}chown -R 1000:1000 /home/node`,
  ]);
  return volume;
}

async function startGateway(volume) {
  const name = `oce-profile-fixture-${randomUUID()}`;
  containers.push(name);
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:size=128m,uid=1000,gid=1000,mode=1777",
    "--volume",
    `${volume}:/home/node`,
    "--volume",
    `${temporary}/config.json:/etc/openclaw.json:ro`,
    "--env",
    "HOME=/home/node",
    "--env",
    "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    "--env",
    "OPENCLAW_CONFIG_PATH=/etc/openclaw.json",
    "--env",
    "OPENCLAW_NO_AUTO_UPDATE=1",
    "--entrypoint",
    "node",
    image,
    "/app/openclaw.mjs",
    "gateway",
    "--port",
    "8080",
    "--bind",
    "loopback",
  ]);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ready = await docker([
      "exec",
      name,
      "node",
      "-e",
      'fetch("http://127.0.0.1:8080/readyz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
    ]).then(
      () => true,
      () => false,
    );
    if (ready) {
      return name;
    }
    const state = await docker(["inspect", "--format", "{{.State.Running}}", name]);
    if (state.stdout.trim() !== "true") {
      const logs = await docker(["logs", "--tail", "20", name]);
      throw new Error(`Old Gateway exited before readiness: ${logs.stdout}\n${logs.stderr}`);
    }
    assert.ok(Date.now() < deadline, "Old Gateway did not become ready");
    await new Promise((done) => setTimeout(done, 500));
  }
}

let captureFailure;
const cleanupFailures = [];
try {
  await writeFile(
    join(temporary, "config.json"),
    JSON.stringify(nativeProfileFixtureConfiguration),
    { mode: 0o644 },
  );
  const { stdout } = await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--entrypoint",
    "cat",
    image,
    "/opt/oce/runtime/provenance.json",
  ]);
  const provenance = JSON.parse(stdout);
  const volume = await stateVolume();
  const gateway = await startGateway(volume);
  const expected = await checkNativeProfileFixture(docker, gateway, {
    mode: "capture",
    displayName: nativeProfileFixtureName,
    message: nativeProfileFixtureMessage,
  });
  await docker(["stop", "--time", "60", gateway]);
  // Copy application stores and keyless client migration metadata. Journal keys,
  // locks, logs and config files never enter the archive. Remove the shared
  // store's generated configuration HMAC key, then vacuum away deleted bytes.
  const snapshot = join(temporary, "snapshot");
  await mkdir(snapshot, { mode: 0o777 });
  await chmod(snapshot, 0o777);
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--volume",
    `${volume}:/source:ro`,
    "--tmpfs",
    "/tmp:size=128m,uid=1000,gid=1000,mode=1777",
    "--volume",
    `${snapshot}:/snapshot`,
    "--entrypoint",
    "node",
    image,
    "-e",
    `
const { DatabaseSync } = require("node:sqlite");
const { chmodSync, copyFileSync, existsSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
for (const relative of [".openclaw/state/openclaw.sqlite", ".openclaw/agents/main/agent/openclaw-agent.sqlite", ".openclaw/client/credentials.sqlite"]) {
  const output = "/snapshot/" + relative;
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  // SQLite may need writable WAL bookkeeping even for a read-only query.
  // Use a private working copy, preserving any committed WAL frames.
  const working = "/tmp/" + relative;
  mkdirSync(dirname(working), { recursive: true });
  copyFileSync("/source/" + relative, working);
  if (existsSync("/source/" + relative + "-wal")) {
    copyFileSync("/source/" + relative + "-wal", working + "-wal");
  }
  const source = new DatabaseSync(working);
  source.prepare("VACUUM INTO ?").run(output);
  source.close();
  const copy = new DatabaseSync(output);
  if (relative.endsWith("/state/openclaw.sqlite")) copy.exec("DELETE FROM config_revision_keys");
  if (relative.endsWith("/client/credentials.sqlite")) {
    for (const table of ["device_identities", "device_auth_tokens", "gateway_origin_device_tokens", "native_exec_socket_credentials"]) {
      copy.exec("DELETE FROM " + table);
    }
  }
  copy.exec("VACUUM");
  copy.close();
  chmodSync(output, 0o600);
}
`,
  ]);
  const archive = join(output, "native-profile-state.tar.gz");
  await execute("tar", ["-czf", archive, "-C", snapshot, ".openclaw"], {
    timeout: 30_000,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  // Verification restores a separate copy: keys generated by reopening cannot
  // be accidentally captured in the keyless archive.
  const restored = await startGateway(await stateVolume(archive));
  await checkNativeProfileFixture(docker, restored, { expected });
  await docker(["stop", "--time", "60", restored]);
  await writeFile(
    join(output, "native-profile-state.json"),
    JSON.stringify(
      {
        version: 1,
        image,
        provenance,
        archiveSha256: createHash("sha256")
          .update(await readFile(archive))
          .digest("hex"),
        capture:
          "Native trusted-human RPC: users.self, users.setDisplayName, sessions.create, chat.inject. No model generation.",
        sanitized:
          "Shared and Agent SQLite stores plus client migration metadata; generated identity, token and configuration HMAC rows removed and vacuumed; no journal keys.",
        verifiedWithOriginalRuntime: true,
        expected,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Verified native profile fixture: ${output}`);
} catch (error) {
  captureFailure = error;
} finally {
  for (const name of containers.reverse()) {
    await docker(["rm", "-f", name]).catch((error) => cleanupFailures.push(error));
  }
  for (const volume of volumes.reverse()) {
    await docker(["volume", "rm", volume]).catch((error) => cleanupFailures.push(error));
  }
  await rm(temporary, { recursive: true, force: true }).catch((error) =>
    cleanupFailures.push(error),
  );
}
if (captureFailure || cleanupFailures.length > 0) {
  throw new AggregateError(
    [...(captureFailure ? [captureFailure] : []), ...cleanupFailures],
    "Native profile fixture capture or cleanup failed",
  );
}
