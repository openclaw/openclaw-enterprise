import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  BOOTSTRAP_KEY_FILE,
  STATE_FILE,
  createOccClient,
  createStateSaver,
  readSetupState,
  validatePrivateRegularFile,
  withStateLock,
} from "../../scripts/setup/common.mjs";

const commonModule = pathToFileURL(join(process.cwd(), "scripts/setup/common.mjs")).href;

async function privateDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-setup-state-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function runNode(source, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function writeServiceKey(directory, key = `occ_test_${randomUUID()}`) {
  const path = join(directory, BOOTSTRAP_KEY_FILE);
  await writeFile(
    path,
    `${JSON.stringify({
      data: { key },
      meta: { installationId: `ins_${randomUUID()}` },
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

function findUnusedPid() {
  for (let pid = 999_999; pid > 100_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return pid;
    }
  }
  throw new Error("Unable to find an unused PID for stale-lock coverage.");
}

test("setup state lock excludes concurrent writers and releases after failure", async (t) => {
  const directory = await privateDirectory(t);
  await assert.rejects(
    withStateLock(directory, async () => {
      await assert.rejects(
        withStateLock(directory, async () => "blocked"),
        /locked.*process/i,
      );
      throw new Error("intentional setup failure");
    }),
    /intentional setup failure/,
  );
  await withStateLock(directory, async () => {
    assert.equal((await readSetupState(directory)).version, 1);
  });
});

test("setup state lock reports stale same-host locks without deleting them", async (t) => {
  const directory = await privateDirectory(t);
  const lockPath = join(directory, "state.lock");
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: findUnusedPid(),
      host: hostname(),
      startedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(lockPath, 0o600);
  await assert.rejects(
    withStateLock(directory, async () => "blocked"),
    /not running.*remove .*state\.lock/i,
  );
  assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
  await rm(lockPath);
  await withStateLock(directory, async () => {
    assert.equal((await readSetupState(directory)).version, 1);
  });

  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(lockPath, 0o600);
  await assert.rejects(
    withStateLock(directory, async () => "blocked"),
    /process .* remove .*state\.lock/i,
  );
});

test("TUI-like child interruption runs after lock release", async (t) => {
  const directory = await privateDirectory(t);
  const result = await runNode(
    `
      import { runInteractive, withStateLock } from ${JSON.stringify(commonModule)};
      const directory = process.argv.at(-1);
      const launch = await withStateLock(directory, async () => ({
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGINT')"],
      }));
      await runInteractive(launch.command, launch.args);
    `,
    [directory],
  );
  assert.notEqual(result.code, 0, result.stderr);
  await withStateLock(directory, async () => {
    assert.equal((await readSetupState(directory)).version, 1);
  });
});

test("setup state persists a private roundtrip without storing credential material", async (t) => {
  const directory = await privateDirectory(t);
  const state = {
    version: 1,
    directory,
    mode: "development",
    backend: {
      mode: "development",
      identity: { model: "gpt-test", runtimeImage: "runtime:test" },
      serviceKeyFile: join(directory, BOOTSTRAP_KEY_FILE),
    },
    installationId: `ins_${randomUUID()}`,
    namespaceId: `ns_${randomUUID()}`,
    configurationId: `cfg_${randomUUID()}`,
    agentId: `agt_${randomUUID()}`,
    revisionId: `rev_${randomUUID()}`,
  };
  await createStateSaver(directory, state)();
  assert.equal((await stat(join(directory, STATE_FILE))).mode & 0o777, 0o600);
  assert.deepEqual(await readSetupState(directory), state);
  assert.equal(
    (await readFile(join(directory, STATE_FILE), "utf8")).includes("occ_test_secret"),
    false,
  );
});

test("setup state rejects public files and symlinks", async (t) => {
  const directory = await privateDirectory(t);
  const statePath = join(directory, STATE_FILE);
  await writeFile(statePath, '{"version":1}\n', { mode: 0o644 });
  await chmod(statePath, 0o644);
  await assert.rejects(readSetupState(directory), /private|0600/i);

  await chmod(statePath, 0o600);
  assert.deepEqual(await readSetupState(directory), { version: 1 });
  await rm(statePath);

  const target = join(directory, "state-target.json");
  await writeFile(target, '{"version":1}\n', { mode: 0o600 });
  await chmod(target, 0o600);
  await symlink(target, statePath);
  await assert.rejects(readSetupState(directory), /regular file/i);
});

test("service-key files must be private regular files before any HTTP request", async (t) => {
  const directory = await privateDirectory(t);
  let requests = 0;
  const server = await listen((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { ok: true }, meta: { requestId: "req_test" } }));
  });
  t.after(() => server.close());

  const publicKey = await writeServiceKey(directory);
  await chmod(publicKey, 0o644);
  await assert.rejects(
    createOccClient(server.url, publicKey).request("GET", "/installation"),
    /private|0600/i,
  );

  await rm(publicKey);
  const target = join(directory, "service-key-target.json");
  await writeFile(
    target,
    '{"data":{"key":"occ_test_target"},"meta":{"installationId":"ins_test"}}\n',
    { mode: 0o600 },
  );
  await chmod(target, 0o600);
  await symlink(target, publicKey);
  await assert.rejects(
    createOccClient(server.url, publicKey).request("GET", "/installation"),
    /regular file/i,
  );
  assert.equal(requests, 0);
});

test("OCC API client refuses redirects without forwarding the service key", async (t) => {
  const directory = await privateDirectory(t);
  const serviceKey = await writeServiceKey(directory);
  let redirectedRequests = 0;
  let redirectedKey;
  const redirected = await listen((request, response) => {
    redirectedRequests += 1;
    redirectedKey = request.headers["x-api-key"];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ data: { id: "ins_redirected" }, meta: { requestId: "req_test" } }),
    );
  });
  t.after(() => redirected.close());
  const redirecting = await listen((_request, response) => {
    response.writeHead(302, { location: `${redirected.url}/installation` });
    response.end();
  });
  t.after(() => redirecting.close());

  await assert.rejects(
    createOccClient(redirecting.url, serviceKey).request("GET", "/installation"),
    /fetch|redirect/i,
  );
  assert.equal(redirectedRequests, 0);
  assert.equal(redirectedKey, undefined);
});

test("OCC API client reports safe network failure context", async (t) => {
  const directory = await privateDirectory(t);
  const serviceKey = await writeServiceKey(directory, "occ_test_network_secret");
  const keyPayload = await readFile(serviceKey, "utf8");
  const unavailable = await listen((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  await unavailable.close();

  await assert.rejects(
    createOccClient(unavailable.url, serviceKey).request("POST", "/installation", {
      marker: "request-body-secret",
    }),
    (error) => {
      assert.match(error.message, /OCC API POST \/installation request failed: fetch failed/);
      assert.match(error.message, /ECONNREFUSED/);
      assert.equal(error.message.includes("x-api-key"), false);
      assert.equal(error.message.includes("request-body-secret"), false);
      assert.equal(error.message.includes(JSON.parse(keyPayload).data.key), false);
      return true;
    },
  );
});

test("private file validation accepts regular mode 0600 files", async (t) => {
  const directory = await privateDirectory(t);
  await validatePrivateRegularFile(await writeServiceKey(directory), "Bootstrap service-key file");
});
