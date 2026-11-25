import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const STOCK_CONTROL_SOCKET = "/run/strands-stock/control.sock";
const START_TIMEOUT_MS = 60_000;
const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * The trusted container owns the listener. The stock launcher mounts this
 * revision's directory read-only. Accept one peer for a single lifetime.
 * @returns {Promise<import("node:net").Socket>}
 */
export async function acceptStockControl(
  certificate,
  path = STOCK_CONTROL_SOCKET,
  receipt = "/run/strands-receipt/certificate",
  timeout = RECEIPT_TIMEOUT_MS,
) {
  // Kubelet projects the immutable receipt after the worker pins one Pod.
  // A replacement gets a different key and must never open the launch socket.
  const leaf = new X509Certificate(certificate);
  const deadline = performance.now() + timeout;
  while (true) {
    try {
      const pin = new X509Certificate(readFileSync(receipt));
      if (!pin.raw.equals(leaf.raw)) throw new Error("Strands Box listener receipt mismatch");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("Strands Box listener receipt timed out");
      await delay(Math.min(500, remaining));
    }
  }
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      clearTimeout(deadline);
      server.close();
      resolve(socket);
    });
    const deadline = setTimeout(() => {
      server.close();
      reject(new Error("Strands Box control connection timed out"));
    }, START_TIMEOUT_MS);
    server.maxConnections = 1;
    server.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    const priorMask = process.umask(0o117);
    try {
      server.listen(path);
    } finally {
      process.umask(priorMask);
    }
  });
}

/** @returns {Promise<import("node:net").Socket>} */
export async function connectStockControl(
  path = STOCK_CONTROL_SOCKET,
  timeout = RECEIPT_TIMEOUT_MS + START_TIMEOUT_MS,
) {
  const deadline = performance.now() + timeout;
  do {
    try {
      return await new Promise((resolve, reject) => {
        const socket = connect(path);
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.removeListener("error", reject);
          resolve(socket);
        });
      });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED") {
        throw error;
      }
      await delay(Math.max(0, Math.min(100, deadline - performance.now())));
    }
  } while (performance.now() < deadline);
  throw new Error("Strands Box control connection timed out");
}

/**
 * Pipes preserve the existing bounded Harness frame protocol and apply stream backpressure.
 * @param {import("node:net").Socket} control
 * @param {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, null>} box
 */
export function pipeStockBox(control, box) {
  let exitCode;
  let killDeadline;
  function stop(code = 0) {
    if (exitCode !== undefined) return;
    exitCode = code;
    control.destroy();
    box.kill("SIGTERM");
    killDeadline = setTimeout(() => box.kill("SIGKILL"), 8000);
    killDeadline.unref();
  }
  const disconnected = () => stop(1);
  /** @type {Promise<number>} */
  const done = new Promise((resolve) => {
    box.once("error", () => finish(1));
    control.once("end", disconnected);
    control.once("close", disconnected);
    control.on("error", disconnected);
    box.stdin.on("error", disconnected);
    box.stdout.on("error", disconnected);
    box.stdout.once("end", disconnected);
    function finish(code) {
      clearTimeout(killDeadline);
      exitCode ??= code === 0 ? 0 : 1;
      control.destroy();
      // Do not wait for a descendant holding either pipe after supervisor loss.
      box.stdin.destroy();
      box.stdout.destroy();
      resolve(exitCode);
    }
    box.once("exit", finish);
  });
  control.pipe(box.stdin, { end: false });
  box.stdout.pipe(control, { end: false });
  return { stop, done };
}
