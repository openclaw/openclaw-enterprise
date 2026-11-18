import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { reservePort, reservedPortArgs } from "../helpers/available-port.ts";
import { faultObserver } from "../helpers/egress-custody-observations.mjs";
import { ownPortForward } from "../helpers/port-forward-cleanup.ts";
import { socketDirectory } from "../helpers/socket-directory.ts";

const run = promisify(execFile);
const observerCommand = fileURLToPath(
  new URL("../fixtures/egress-custody-postgres-observer.ts", import.meta.url),
);

async function exchange(path: string, first: string, last = ""): Promise<string> {
  const socket = createConnection(path);
  socket.setTimeout(5_000, () => socket.destroy(new Error("observer socket timed out")));
  let response = "";
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    response += data;
  });
  socket.once("connect", () => {
    socket.write(first, () => {
      socket.end(last);
    });
  });
  try {
    await once(socket, "end");
    return response;
  } finally {
    socket.destroy();
  }
}

test(
  "the dispatch observer rejects malformed selections before arming its one fault",
  { timeout: 20_000 },
  async (t) => {
    const parent = await socketDirectory(t, "egress-observer-", { longest: "owner/control.sock" });
    const directory = join(parent, "owner");
    const path = join(directory, "control.sock");

    // This scenario exercises the command and control wire with zero upstream traffic.
    const env = {
      OCC_TEST_DATABASE_URL: syntheticCredentialUrl({
        protocol: "postgresql",
        username: "occ_app",
        password: "fixture",
        host: "127.0.0.1",
        port: 1,
        pathname: "/openclaw_k8s_observer",
      }),
    };
    // A failed bind must remove only the directory this attempt created, so a retry can use it.
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    try {
      const address = occupied.address();
      assert.ok(address && typeof address !== "string");
      await assert.rejects(
        run(process.execPath, [observerCommand, directory, String(address.port)], {
          env,
          timeout: 5_000,
        }),
        /EADDRINUSE/,
      );
      await assert.rejects(stat(directory), { code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const reservation = await reservePort();
    t.after(() => reservation.release());
    const args = [observerCommand, directory, String(reservation.port)];
    const observer = spawn(process.execPath, [...reservedPortArgs(reservation), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const owner = ownPortForward(observer);
    const exit = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      observer.once("close", (code, signal) => resolve([code, signal]));
    });
    const lines = createInterface({ input: observer.stdout });
    let errors = "";
    observer.stderr.setEncoding("utf8");
    observer.stderr.on("data", (data: string) => {
      errors += data;
    });
    try {
      const [ready]: unknown[] = await Promise.race([
        once(lines, "line", { signal: AbortSignal.timeout(5_000) }),
        exit.then(([code, signal]) => {
          throw new Error(`Observer exited before readiness (${code ?? signal}): ${errors}`);
        }),
      ]);
      assert.ok(typeof ready === "string");
      assert.match(ready, /observer ready on loopback port/);
      await reservation.release();

      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      const socket = await stat(path);
      assert.ok(socket.isSocket());
      assert.equal(socket.mode & 0o777, 0o600);

      const fresh = { authorizations: 0, observed: false, armed: false };
      assert.equal(await exchange(path, "sta", "tus"), JSON.stringify(fresh));
      // Reusing the path must leave the original observer reachable.
      await assert.rejects(run(process.execPath, args, { env, timeout: 5_000 }), /EEXIST/);
      assert.deepEqual(await faultObserver(path), fresh);

      const refusal = '{"error":"invalid or consumed observer operation"}';
      assert.equal(await exchange(path, "drop ", "-".repeat(36)), refusal);
      assert.deepEqual(await faultObserver(path), fresh);
      assert.equal(await exchange(path, "drop ", "10ba8f57-daed-4e73-7740-05484777695c"), refusal);
      // Adjacent UTF-8 byte counts distinguish the size guard from idle timeout or character counting.
      assert.equal(await exchange(path, "é".repeat(128)), refusal);
      assert.equal(await exchange(path, "é".repeat(128) + "x"), "");
      assert.deepEqual(await faultObserver(path), fresh);

      const armed = { ...fresh, armed: true };
      assert.deepEqual(
        await faultObserver(path, "drop 10BA8F57-DAED-4E73-B740-05484777695C"),
        armed,
      );
      assert.equal(await exchange(path, "drop ", "2a7f8a49-6d66-4edc-ae03-4edc2336f61d"), refusal);
      assert.deepEqual(await faultObserver(path), armed);
    } finally {
      lines.close();
      await owner.close();
    }

    assert.deepEqual(await exit, [0, null]);
    await assert.rejects(stat(path), { code: "ENOENT" });
  },
);
