// Executed by the owned supervisor against its actual contained Codex server.
// Credentials stay inside the existing probe mount; no model calls are made.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const { WebSocket } = createRequire("/app/package.json")("ws");
const token = readFileSync(process.argv[1], "utf8");
const port = Number(process.argv[2]);
// Standalone command/exec does not inherit a Gateway turn's policy. Use the
// same admitted policy as normal OCE turns; Box remains the containment owner.
const sandboxPolicy = JSON.parse(process.argv[3]);
const clients = new Set();
const receipt = { cases: [] };
const stage = (name) => {
  receipt.stage = name;
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
};
const deadline = setTimeout(() => {
  process.stderr.write(JSON.stringify({ ...receipt, error: "protocol probe deadline" }) + "\n");
  for (const client of clients) {
    client.socket.terminate();
  }
  process.exitCode = 1;
}, 90000);

async function connection() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { authorization: `Bearer ${token}` },
    handshakeTimeout: 4000,
    maxPayload: 16 * 1024 * 1024,
  });
  const pending = new Map();
  const observers = new Set();
  const client = {
    socket,
    observers,
    rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
  clients.add(client);
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(JSON.stringify(message.error)));
      } else {
        waiter.resolve(message.result);
      }
    } else {
      for (const observe of observers) {
        observe(message);
      }
    }
  });
  socket.on("error", () => {});
  socket.once("close", () => {
    clients.delete(client);
    for (const waiter of pending.values()) {
      waiter.reject(new Error("connection closed"));
    }
    pending.clear();
  });
  await once(socket, "open");
  await client.rpc("initialize", {
    clientInfo: { name: "oce_transport_acceptance", version: "1" },
    capabilities: { experimentalApi: true },
  });
  socket.send(JSON.stringify({ method: "initialized" }));
  return client;
}

const command = (client, argv, options = {}) =>
  client.rpc("command/exec", {
    command: argv,
    cwd: "/home/node/workspace",
    timeoutMs: 15000,
    sandboxPolicy,
    ...options,
  });
function firstOutput(client, processId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.observers.delete(observe);
      reject(new Error(`No stdout for ${receipt.stage}`));
    }, 18000);
    const observe = (message) => {
      if (
        message.method === "command/exec/outputDelta" &&
        message.params.processId === processId &&
        message.params.stream === "stdout"
      ) {
        clearTimeout(timer);
        client.observers.delete(observe);
        resolve(message.params);
      }
    };
    client.observers.add(observe);
  });
}

try {
  stage("initialize");
  const client = await connection();
  stage("standalone default policy comparison");
  receipt.standaloneDefault = await command(
    client,
    ["sh", "-c", "printf 'expected-exit'; exit 7"],
    {
      sandboxPolicy: undefined,
    },
  );
  stage("selected native policy exit status");
  const exit = await command(client, ["sh", "-c", "printf 'expected-exit'; exit 7"]);
  assert.equal(exit.exitCode, 7, JSON.stringify(exit));
  assert.equal(exit.stdout, "expected-exit");
  receipt.cases.push({ name: "native nonzero exit preserved", passed: true });

  stage("8 MiB streamed output");
  const processId = randomUUID();
  const expectedBytes = 8 * 1024 * 1024;
  let bytes = 0;
  let stderrBytes = 0;
  const hash = createHash("sha256");
  const output = (message) => {
    if (message.method !== "command/exec/outputDelta" || message.params.processId !== processId) {
      return;
    }
    assert.equal(message.params.capReached, false);
    const data = Buffer.from(message.params.deltaBase64, "base64");
    if (message.params.stream === "stderr") {
      stderrBytes += data.length;
      assert.ok(stderrBytes < 4096);
      return;
    }
    assert.equal(message.params.stream, "stdout");
    bytes += data.length;
    hash.update(data);
  };
  client.observers.add(output);
  const large = await command(
    client,
    ["node", "-e", `process.stdout.write(Buffer.alloc(${expectedBytes}, 90))`],
    {
      processId,
      streamStdoutStderr: true,
      outputBytesCap: expectedBytes + 1,
    },
  );
  client.observers.delete(output);
  assert.equal(large.exitCode, 0);
  assert.equal(bytes, expectedBytes);
  const sha256 = hash.digest("hex");
  assert.equal(sha256, createHash("sha256").update(Buffer.alloc(expectedBytes, 90)).digest("hex"));
  receipt.cases.push({
    name: "8 MiB native streamed output without truncation",
    passed: true,
    bytes,
    sha256,
    stderrBytes,
  });

  stage("interactive stdin readiness");
  const interactiveId = randomUUID();
  const ready = firstOutput(client, interactiveId);
  const interactive = command(client, ["sh", "-c", "printf ready; cat"], {
    processId: interactiveId,
    streamStdin: true,
    streamStdoutStderr: true,
  });
  await ready;
  stage("interactive stdin echo");
  const echoed = firstOutput(client, interactiveId);
  await client.rpc("command/exec/write", {
    processId: interactiveId,
    deltaBase64: Buffer.from("stdin-roundtrip").toString("base64"),
    closeStdin: true,
  });
  assert.equal(Buffer.from((await echoed).deltaBase64, "base64").toString(), "stdin-roundtrip");
  assert.equal((await interactive).exitCode, 0);
  receipt.cases.push({ name: "interactive stdin and EOF", passed: true });

  stage("explicit cancellation readiness");
  const cancelId = randomUUID();
  const started = firstOutput(client, cancelId);
  const running = command(client, ["sh", "-c", "printf started; exec sleep 60"], {
    processId: cancelId,
    streamStdoutStderr: true,
  });
  await started;
  stage("explicit cancellation completion");
  const cancelledAt = Date.now();
  await client.rpc("command/exec/terminate", { processId: cancelId });
  assert.notEqual((await running).exitCode, 0);
  assert.ok(Date.now() - cancelledAt < 5000);
  receipt.cases.push({
    name: "explicit command cancellation",
    passed: true,
    elapsedMs: Date.now() - cancelledAt,
  });

  stage("connection loss readiness");
  const lost = await connection();
  const lostId = randomUUID();
  const sentinel = `.qa-transport-${randomUUID()}`;
  const lossReady = firstOutput(lost, lostId);
  const lostCommand = command(
    lost,
    [
      "node",
      "-e",
      `process.stdout.write('started'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unexpected survivor'), 2500)`,
    ],
    { processId: lostId, streamStdoutStderr: true },
  ).catch((error) => String(error));
  await lossReady;
  stage("connection loss cleanup");
  lost.socket.terminate();
  assert.match(await lostCommand, /connection closed/u);
  await delay(3500);
  const absence = await command(client, [
    "sh",
    "-c",
    `if test -e '${sentinel}'; then rm -- '${sentinel}'; exit 1; fi; printf disconnected-child-stopped`,
  ]);
  assert.equal(absence.exitCode, 0);
  receipt.cases.push({
    name: "connection loss cancels native process before its delayed write",
    passed: true,
  });

  stage("fresh authenticated reconnect");
  const fresh = await connection();
  const after = await command(fresh, ["sh", "-c", "printf fresh-connection"]);
  assert.equal(after.exitCode, 0);
  assert.equal(after.stdout, "fresh-connection");
  receipt.cases.push({
    name: "fresh authenticated reconnect executes after cancellation",
    passed: true,
  });
  receipt.passed = true;
} catch (error) {
  process.stderr.write(JSON.stringify({ ...receipt, error: String(error) }) + "\n");
  throw error;
} finally {
  clearTimeout(deadline);
  for (const client of clients) {
    client.socket.terminate();
  }
}
process.stdout.write(JSON.stringify(receipt));
