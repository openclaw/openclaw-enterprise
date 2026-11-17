import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { ownPortForward } from "../helpers/port-forward-cleanup.ts";

// These are inert local processes, not kubectl or a Kubernetes installation.
test(
  "operator forwarder shutdown waits for normal closure and can repeat",
  { timeout: 5_000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const owner = ownPortForward(child);
    const closed = once(child, "close");
    let observedClose = false;
    child.once("close", () => {
      observedClose = true;
    });
    try {
      await once(child.stdout, "data");
      await owner.close();
      assert.equal(observedClose, true);
      assert.equal(child.signalCode, "SIGTERM");
      await owner.close();
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  },
);

test(
  "operator forwarder shutdown escalates a stubborn child before returning",
  { timeout: 5_000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const owner = ownPortForward(child, { graceMs: 100 });
    const closed = once(child, "close");
    let observedClose = false;
    child.once("close", () => {
      observedClose = true;
    });
    try {
      await once(child.stdout, "data");
      await owner.close();
      assert.equal(observedClose, true);
      assert.equal(child.signalCode, "SIGKILL");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  },
);

test(
  "operator forwarder shutdown refuses an exited child with an open inherited pipe",
  { timeout: 5_000 },
  async () => {
    // The holder is separately owned by this test. Killing the exited leader cannot close its pipe.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require('node:child_process');
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    console.log(holder.pid);
    holder.unref();
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const owner = ownPortForward(child, { graceMs: 50 });
    const closed = once(child, "close");
    const exited = once(child, "exit");
    let holderPid: number | undefined;
    let observedClose = false;
    child.once("close", () => {
      observedClose = true;
    });
    try {
      const [pid] = await once(child.stdout, "data");
      holderPid = Number(String(pid).trim());
      assert.ok(Number.isSafeInteger(holderPid) && holderPid > 0);
      await exited;
      assert.equal(observedClose, false);
      await assert.rejects(owner.close(), /Port-forward did not close after bounded shutdown/);
      assert.equal(observedClose, false);
      process.kill(holderPid, "SIGKILL");
      holderPid = undefined;
      await closed;
      await owner.close();
    } finally {
      if (holderPid !== undefined) {
        process.kill(holderPid, "SIGKILL");
      }
      child.kill("SIGKILL");
      await closed;
    }
  },
);

test(
  "forwarder launch failure remains available after confirmed cleanup",
  { timeout: 5_000 },
  async () => {
    const child = spawn("/nonexistent/operator-forwarder", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const owner = ownPortForward(child);
    let observedClose = false;
    child.once("close", () => {
      observedClose = true;
    });
    await owner.close();
    assert.equal((owner.error as NodeJS.ErrnoException)?.code, "ENOENT");
    assert.equal(observedClose, true);
    await owner.close();
  },
);
