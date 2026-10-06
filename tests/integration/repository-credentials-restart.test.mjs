import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { appRoot, credentialDriverModule } from "../fixtures/repository-credentials/runtime.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { createLoopbackServiceConfiguration } from "../fixtures/repository-credentials/service.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";

async function configuration(t) {
  const resources = createTestResourceScope(t);
  const tls = await createTlsMaterial(resources);
  const config = await createLoopbackServiceConfiguration(resources);
  return { resources, config, tls };
}

function startProcess({ resources, config, tls }) {
  // Only the provider is a fixture. Listener startup, control routes, sessions,
  // signal handling and socket cleanup all belong to the real process composition.
  const program = `
    import { readFile } from 'node:fs/promises';
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const { credentialCompositionModule, credentialDriverModule } = await import(input.runtime);
    const [{ runService }, { createSystemClock }, { createAlternateDriverFactory }] = await Promise.all([
      credentialCompositionModule('service'), credentialDriverModule('clock'), import(input.adapter),
    ]);
    const clock = createSystemClock();
    const factory = createAlternateDriverFactory({origin:'https://upstream.example.test',gatewayOrigin:input.config.gateway.publicOrigin,clock});
    const tls = { key: await readFile(input.key), cert: await readFile(input.cert) };
    await runService({ config:input.config, tls, factory, trustedUpstreamOrigins:new Set(), close(){} }, clock);
    process.send('ready');
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    env: {
      PATH: process.env.PATH,
      REPOSITORY_CREDENTIALS_APP_ROOT: appRoot,
    },
    stdio: ["pipe", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("service readiness timed out")), 5000);
    child.once("message", (message) => {
      clearTimeout(timer);
      assert.equal(message, "ready");
      resolve();
    });
    void closed.then(() => {
      clearTimeout(timer);
      reject(new Error(`service exited before readiness: ${stderr}`));
    }, reject);
  });
  resources.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  });
  child.stdin.end(
    JSON.stringify({
      config,
      runtime: new URL("../fixtures/repository-credentials/runtime.mjs", import.meta.url).href,
      adapter: new URL("../fixtures/repository-credentials/alternate.mjs", import.meta.url).href,
      key: tls.keyFile,
      cert: tls.certFile,
    }),
  );
  return { child, ready, closed };
}

const openRequest = {
  method: "POST",
  path: "/v1/sessions",
  body: { durationSeconds: 3600, profile: "git-write" },
};

test(
  "SIGKILL restart recovers the owned stale control socket with fresh sessions",
  { timeout: 15000 },
  async (t) => {
    const fixture = await configuration(t);
    const { callControl } = await credentialDriverModule("client/operator");
    const socketPath = fixture.config.gateway.controlSocket;
    const first = startProcess(fixture);
    await first.ready;
    const original = await callControl(socketPath, openRequest);
    assert.equal(original.session.state, "OPEN");
    first.child.kill("SIGKILL");
    assert.deepEqual(await first.closed, { code: null, signal: "SIGKILL" });

    // SIGKILL bypasses cleanup, leaving the actual socket inode behind. A dead
    // process alone is insufficient: verify the operating system refuses connect.
    const abandoned = await lstat(socketPath);
    assert.ok(abandoned.isSocket());
    assert.equal(abandoned.mode & 0o7777, 0o600);
    assert.equal(abandoned.uid, process.getuid());
    const refusal = await new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("dead listener accepted connection"));
      });
      socket.once("error", resolve);
    });
    assert.equal(refusal.code, "ECONNREFUSED");

    const restarted = startProcess(fixture);
    await restarted.ready;
    assert.deepEqual(
      await callControl(socketPath, {
        method: "GET",
        path: `/v1/sessions/${original.session.sessionId}`,
      }),
      { error: "not-found" },
    );
    const replacement = await callControl(socketPath, openRequest);
    assert.equal(replacement.session.state, "OPEN");
    assert.notEqual(replacement.session.sessionId, original.session.sessionId);
    assert.notEqual(replacement.bearer, original.bearer);
    assert.equal((await lstat(socketPath)).mode & 0o7777, 0o600);
    restarted.child.kill("SIGTERM");
    assert.deepEqual(await restarted.closed, { code: 0, signal: null });
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  },
);

test(
  "restart refuses a live control listener and preserves its session",
  { timeout: 10000 },
  async (t) => {
    const fixture = await configuration(t);
    const { callControl } = await credentialDriverModule("client/operator");
    const socketPath = fixture.config.gateway.controlSocket;
    const first = startProcess(fixture);
    await first.ready;
    const opened = await callControl(socketPath, openRequest);
    const before = await lstat(socketPath);
    const contender = startProcess(fixture);
    await assert.rejects(contender.ready, /startup-failed/);
    assert.deepEqual(await contender.closed, { code: 1, signal: null });
    const after = await lstat(socketPath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(
      (
        await callControl(socketPath, {
          method: "GET",
          path: `/v1/sessions/${opened.session.sessionId}`,
        })
      ).state,
      "OPEN",
    );
  },
);

test("restart preserves a regular file at the control path", { timeout: 10000 }, async (t) => {
  const fixture = await configuration(t);
  const socketPath = fixture.config.gateway.controlSocket;
  await writeFile(socketPath, "operator-owned file", { mode: 0o600 });
  const before = await lstat(socketPath);
  const contender = startProcess(fixture);
  await assert.rejects(contender.ready, /startup-failed/);
  assert.deepEqual(await contender.closed, { code: 1, signal: null });
  assert.equal((await lstat(socketPath)).ino, before.ino);
  assert.equal(await readFile(socketPath, "utf8"), "operator-owned file");
});

test(
  "restart preserves an abandoned socket with unsafe permissions",
  { timeout: 10000 },
  async (t) => {
    const fixture = await configuration(t);
    const socketPath = fixture.config.gateway.controlSocket;
    const first = startProcess(fixture);
    await first.ready;
    first.child.kill("SIGKILL");
    await first.closed;
    await chmod(socketPath, 0o660);
    const before = await lstat(socketPath);
    const contender = startProcess(fixture);
    await assert.rejects(contender.ready, /startup-failed/);
    assert.deepEqual(await contender.closed, { code: 1, signal: null });
    const after = await lstat(socketPath);
    assert.ok(after.isSocket());
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o7777, 0o660);
  },
);
