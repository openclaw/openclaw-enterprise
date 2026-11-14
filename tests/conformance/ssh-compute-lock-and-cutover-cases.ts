import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import {
  digest,
  fixture,
  holdLock,
  json,
  missing,
  prepare,
  revision,
  tenant,
  waitForLockWait,
} from "./ssh-compute-fixture.ts";

test("SSH local executor cancellation terminates the real helper waiting for the host lock", async (t) => {
  const f = await fixture(t);
  // Simulate a live concurrent host operation; this tests manual cancellation, not lease loss.
  const held = await holdLock(f);
  t.after(() => held.kill());
  const controller = new AbortController();
  const pending = withComputeAbortSignal(controller.signal, () => f.driver.ensureNamespace(tenant));
  await waitForLockWait(f);
  controller.abort();
  assert.equal((await pending).failure, "retryable");
  const [child] = f.children;
  assert.ok(child);
  assert.notEqual(child.signalCode ?? child.exitCode, null);
  await missing(f.nsDir);
});

test("SSH activation repairs an interrupted cutover instead of accepting an unserved pointer", async (t) => {
  const f = await fixture(t);
  const first = await prepare(f);
  const second = revision(f.driver, 2);
  assert.equal((await f.driver.prepareRevision(second)).ready, true);
  const dir = f.agentDir(first);
  const restarts = async () =>
    (await readFile(join(f.state, "systemctl.log"), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("restart ")).length;
  const before = await restarts();
  assert.equal(await readlink(join(dir, "current")), `revisions/${digest(first.id).slice(0, 12)}`);
  assert.deepEqual(await json(join(dir, "served.json")), { revisionId: first.id });
  // Simulate a helper that died between replacing `current` and `systemctl restart`.
  await rm(join(dir, "current"));
  await symlink(`revisions/${digest(second.id).slice(0, 12)}`, join(dir, "current"));
  await f.driver.activateRevision(second);
  assert.equal(await restarts(), before + 1);
  assert.deepEqual(await json(join(dir, "served.json")), { revisionId: second.id });
  await f.driver.retireRevision(second);
  await missing(join(dir, "served.json"));
});

test("SSH helper stops mutating when its session pipe closes, without any signal", async (t) => {
  const f = await fixture(t);
  // The real transport cannot signal the remote helper; sshd only closes its pipes.
  const held = await holdLock(f);
  t.after(() => held.kill());
  const pending = f.driver.ensureNamespace(tenant);
  await waitForLockWait(f);
  const [child] = f.children;
  assert.ok(child);
  child.stdout.destroy();
  const started = Date.now();
  assert.equal((await pending).failure, "retryable");
  assert.notEqual(child.signalCode ?? child.exitCode, null);
  assert.ok(Date.now() - started < 5_000, "helper must exit on the next heartbeat write");
  await missing(f.nsDir);
  held.release();
  await held.exited;
  assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
});

test("SSH host lock excludes concurrent helpers and is released by the kernel when a holder dies", async (t) => {
  const f = await fixture(t);
  const held = await holdLock(f);
  t.after(() => held.kill());
  const pending = f.driver.ensureNamespace(tenant);
  // While another helper holds the lock, this one must keep waiting without mutating
  // the host: thirty held attempts span about the 1.5 s this test used to sleep.
  await waitForLockWait(f, 30);
  await missing(f.nsDir);
  const [child] = f.children;
  assert.ok(child);
  assert.equal(child.exitCode, null);
  // A holder killed without any cleanup (SIGKILL) releases the flock through the kernel;
  // the waiting helper proceeds immediately instead of waiting out a stale-lock deadline.
  held.kill();
  await held.exited;
  const released = Date.now();
  assert.equal((await pending).namespaceReady, true);
  assert.ok(Date.now() - released < 5_000, "kernel lock release must unblock the waiter");
  assert.equal((await stat(join(f.root, ".compute-lock"))).isFile(), true);
});
