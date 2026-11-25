import assert from "node:assert/strict";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import test from "node:test";
import type { ControlRequest } from "../../apps/controller/src/drivers/repo/access/control-contracts.ts";
import { createAlternateProcessFixture } from "../fixtures/repository-credentials/alternate-process.ts";
import { appFunction } from "../fixtures/repository-credentials/app-functions.ts";

const openRequest: ControlRequest = {
  method: "POST",
  path: "/v1/sessions",
  body: { durationSeconds: 3600, profile: "git-write" },
};

test(
  "SIGKILL restart recovers the owned stale control socket with fresh sessions",
  { timeout: 15000 },
  async (t) => {
    const fixture = await createAlternateProcessFixture(t);
    const callControl = await appFunction(
      "drivers/repo/github/access/client/operator",
      "callControl",
    );
    const { socketPath } = fixture;
    const first = fixture.start();
    await first.ready;
    const original = await callControl(socketPath, openRequest);
    assert.ok("session" in original);
    assert.equal(original.session.state, "OPEN");
    assert.deepEqual(await first.stop("SIGKILL"), { code: null, signal: "SIGKILL" });

    // SIGKILL bypasses cleanup, leaving the actual socket inode behind. A dead
    // process alone is insufficient: verify the operating system refuses connect.
    const abandoned = await lstat(socketPath);
    assert.ok(abandoned.isSocket());
    assert.equal(abandoned.mode & 0o7777, 0o600);
    assert.ok(process.getuid);
    assert.equal(abandoned.uid, process.getuid());
    const refusal = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("dead listener accepted connection"));
      });
      socket.once("error", resolve);
    });
    assert.equal(refusal.code, "ECONNREFUSED");

    const restarted = fixture.start();
    await restarted.ready;
    assert.deepEqual(
      await callControl(socketPath, {
        method: "GET",
        path: `/v1/sessions/${original.session.sessionId}`,
      }),
      { error: "not-found" },
    );
    const replacement = await callControl(socketPath, openRequest);
    assert.ok("session" in replacement);
    assert.equal(replacement.session.state, "OPEN");
    assert.notEqual(replacement.session.sessionId, original.session.sessionId);
    assert.notEqual(replacement.bearer, original.bearer);
    assert.equal((await lstat(socketPath)).mode & 0o7777, 0o600);
    assert.deepEqual(await restarted.stop("SIGTERM"), { code: 0, signal: null });
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  },
);

test(
  "restart refuses a live control listener and preserves its session",
  { timeout: 10000 },
  async (t) => {
    const fixture = await createAlternateProcessFixture(t);
    const callControl = await appFunction(
      "drivers/repo/github/access/client/operator",
      "callControl",
    );
    const { socketPath } = fixture;
    const first = fixture.start();
    await first.ready;
    const opened = await callControl(socketPath, openRequest);
    assert.ok("session" in opened);
    const before = await lstat(socketPath);
    const contender = fixture.start();
    await assert.rejects(contender.ready, /startup-failed/);
    assert.deepEqual(await contender.closed, { code: 1, signal: null });
    const after = await lstat(socketPath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    const status = await callControl(socketPath, {
      method: "GET",
      path: `/v1/sessions/${opened.session.sessionId}`,
    });
    assert.ok("state" in status);
    assert.equal(status.state, "OPEN");
  },
);

test("restart preserves a regular file at the control path", { timeout: 10000 }, async (t) => {
  const fixture = await createAlternateProcessFixture(t);
  const { socketPath } = fixture;
  await writeFile(socketPath, "operator-owned file", { mode: 0o600 });
  const before = await lstat(socketPath);
  const contender = fixture.start();
  await assert.rejects(contender.ready, /startup-failed/);
  assert.deepEqual(await contender.closed, { code: 1, signal: null });
  assert.equal((await lstat(socketPath)).ino, before.ino);
  assert.equal(await readFile(socketPath, "utf8"), "operator-owned file");
});

test(
  "restart preserves an abandoned socket with unsafe permissions",
  { timeout: 10000 },
  async (t) => {
    const fixture = await createAlternateProcessFixture(t);
    const { socketPath } = fixture;
    const first = fixture.start();
    await first.ready;
    assert.deepEqual(await first.stop("SIGKILL"), { code: null, signal: "SIGKILL" });
    await chmod(socketPath, 0o660);
    const before = await lstat(socketPath);
    const contender = fixture.start();
    await assert.rejects(contender.ready, /startup-failed/);
    assert.deepEqual(await contender.closed, { code: 1, signal: null });
    const after = await lstat(socketPath);
    assert.ok(after.isSocket());
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o7777, 0o660);
  },
);
