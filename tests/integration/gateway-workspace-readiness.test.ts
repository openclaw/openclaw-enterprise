import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once, type EventEmitter } from "node:events";
import { copyFile, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installedGatewayRpc } from "../helpers/installed-gateway-rpc.ts";
import { waitForWorkspaceReconnect } from "../helpers/gateway-workspace-readiness.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const disconnected = (changes: { type?: string; code?: string; message?: string } = {}) =>
  new Error("workspace unavailable", {
    cause: {
      type: "gateway_request_error",
      code: "UNAVAILABLE",
      message: "node not connected",
      ...changes,
    },
  });

for (const message of [
  "node not connected",
  "GatewayClientRequestError: node not connected: code=UNAVAILABLE",
]) {
  test(`replacement workspace read waits for enrollment: ${message}`, async () => {
    const expected = { file: { content: "retained workspace" } };
    let reads = 0;
    const result = await waitForWorkspaceReconnect(async () => {
      reads += 1;
      if (reads === 1) {
        throw disconnected({ message });
      }
      return expected;
    });
    assert.equal(result, expected);
    assert.equal(reads, 2);
  });
}

test("workspace readiness never retries other protocol, authorization or transport failures", async () => {
  for (const failure of [
    disconnected({ code: "FORBIDDEN" }),
    disconnected({ message: "upstream unavailable" }),
    disconnected({ type: "gateway_credentials_required" }),
    new Error("transport closed"),
    { cause: null },
    "transport closed",
    null,
    undefined,
  ]) {
    let reads = 0;
    await assert.rejects(
      waitForWorkspaceReconnect(async () => {
        reads += 1;
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(reads, 1);
  }
});

test("a permanently disconnected workspace fails within the readiness deadline", async () => {
  await assert.rejects(
    waitForWorkspaceReconnect(async () => {
      throw disconnected();
    }, 0),
    /Timed out waiting for workspace node reconnection: node not connected \(UNAVAILABLE\)/,
  );
});

test("installed history polling waits for a current session sharing acquisition", async () => {
  const failure = {
    type: "gateway_request_error",
    code: "UNAVAILABLE",
    message:
      "SessionMutationFactsUnavailableError: Session access facts are unavailable; retry after session storage is ready. <- Error: Session sharing acquisition is no longer current",
    retryable: false,
  };
  const history = { messages: [{ role: "assistant", text: "retained" }] };
  const refused = (error: object) => JSON.stringify({ ok: false, error });
  const responses = [refused(failure), JSON.stringify(history)];
  const rpc = installedGatewayRpc(async () => responses.shift()!, 1000);
  assert.equal(await rpc.readAvailableHistory("session"), undefined);
  assert.deepEqual(await rpc.readAvailableHistory("session"), history);

  for (const error of [
    { ...failure, code: "FORBIDDEN" },
    { ...failure, message: failure.message.split(" <- ")[0] },
    { ...failure, details: { method: "chat.send" } },
  ]) {
    const other = installedGatewayRpc(async () => refused(error), 1000);
    await assert.rejects(other.readAvailableHistory("session"), { cause: error });
  }
  const direct = installedGatewayRpc(async () => refused(failure), 1000);
  await assert.rejects(direct.call("chat.send", {}), { cause: failure });
});

type ProbeSocket = EventEmitter<{ message: [data: Buffer] }> & {
  send(data: string): void;
  terminate(): void;
};
type ProbeServer = EventEmitter<{ connection: [socket: ProbeSocket]; listening: [] }> & {
  address(): AddressInfo;
  clients: Set<ProbeSocket>;
  close(callback: (error?: Error) => void): void;
};
type ProbeRequest = {
  id: string;
  method: string;
  params: { sessionKey?: string; idempotencyKey?: string };
};
type GatewayRejection = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: { method?: string };
  retryAfterMs?: number;
};

const controller = new URL("../../apps/controller/", import.meta.url);
const execute = promisify(execFile);
const workspaceMarker = "retained workspace marker";
const historyUnavailable: GatewayRejection = {
  code: "UNAVAILABLE",
  message: "history acquisition pending",
  retryable: true,
  details: { method: "chat.history" },
  retryAfterMs: 250,
};

async function startModelTurnProbe(
  t: TestContext,
  options: { historyErrors?: GatewayRejection[]; sendError?: GatewayRejection; timeoutMs?: number },
) {
  const directory = await temporaryDirectory(t, "gateway-routing-probe-");
  const probe = join(directory, "gateway-probe.mjs");
  // Mirror the controller mount and use the SDK from this workspace's installed graph.
  await copyFile(new URL("../fixtures/gateway-routing/probe.mjs", import.meta.url), probe);
  await symlink(
    fileURLToPath(new URL("node_modules", controller)),
    join(directory, "node_modules"),
  );
  const controllerRequire = createRequire(new URL("package.json", controller));
  const { WebSocketServer } = createRequire(controllerRequire.resolve("@openclaw/gateway-client"))(
    "ws",
  );
  const server: ProbeServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const requests: ProbeRequest[] = [];
  const historyTimes: number[] = [];
  server.on("connection", (socket) => {
    const send = (frame: object) => socket.send(JSON.stringify(frame));
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as ProbeRequest;
      requests.push(request);
      const sendResult = (payload: object) =>
        send({ type: "res", id: request.id, ok: true, payload });
      const rejectRequest = (error: GatewayRejection) =>
        send({ type: "res", id: request.id, ok: false, error });
      switch (request.method) {
        case "connect":
          sendResult({
            type: "hello-ok",
            protocol: 4,
            server: { version: "test", connId: "routing-probe" },
            features: { methods: ["chat.send", "chat.history"], events: [] },
            snapshot: {},
            auth: { role: "operator", scopes: ["operator.admin"] },
            policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
          });
          break;
        case "chat.send":
          if (options.sendError) {
            rejectRequest(options.sendError);
          } else {
            sendResult({ runId: request.params.idempotencyKey, status: "started" });
          }
          break;
        case "chat.history": {
          const error = options.historyErrors?.[historyTimes.length];
          historyTimes.push(performance.now());
          if (error) {
            rejectRequest(error);
          } else {
            sendResult({ messages: [{ role: "assistant", content: workspaceMarker }] });
          }
          break;
        }
        default:
          assert.fail(`unexpected probe request ${request.method}`);
      }
    });
    send({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "fixture-nonce", ts: Date.now() },
    });
  });
  await once(server, "listening");
  const execution = execute(process.execPath, [probe], { env: {}, timeout: 10_000 });
  execution.child.stdin?.end(
    JSON.stringify({
      action: "model-turn",
      url: `ws://127.0.0.1:${server.address().port}`,
      expectedMarker: workspaceMarker,
      timeoutMs: options.timeoutMs ?? 5_000,
    }),
  );
  return { execution, requests, historyTimes };
}

test("the routed probe keeps the sent turn while history becomes available", async (t) => {
  const { execution, requests, historyTimes } = await startModelTurnProbe(t, {
    historyErrors: [historyUnavailable, { ...historyUnavailable, retryAfterMs: 600 }],
  });
  const { stdout } = await execution;
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["connect", "chat.send", "chat.history", "chat.history", "chat.history"],
  );
  const sessionKey = requests[1]?.params.sessionKey;
  assert.ok(sessionKey);
  assert.ok(requests[1]?.params.idempotencyKey);
  assert.ok(requests.slice(2).every(({ params }) => params.sessionKey === sessionKey));
  assert.deepEqual(JSON.parse(stdout), {
    sessionKey,
    content: workspaceMarker,
    deviceTokenIssued: false,
  });
  const [first, second, third] = historyTimes;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  assert.ok(second - first >= 290, "a short retry hint preserves the history polling interval");
  assert.ok(third - second >= 590, "a longer retry hint delays the next history request");
});

for (const [name, error, onSend] of [
  ["wrong method", { ...historyUnavailable, details: { method: "chat.send" } }, false],
  ["unscoped unavailability", { ...historyUnavailable, details: {} }, false],
  ["non-retryable refusal", { ...historyUnavailable, retryable: false }, false],
  ["authorization failure", { ...historyUnavailable, code: "FORBIDDEN" }, false],
  ["send failure", { ...historyUnavailable, details: { method: "chat.send" } }, true],
] as const) {
  test(`the routed probe stops on ${name}`, async (t) => {
    const { execution, requests } = await startModelTurnProbe(
      t,
      onSend ? { sendError: error } : { historyErrors: [error] },
    );
    await assert.rejects(execution, {
      code: 1,
      signal: null,
      stderr: /GatewayClientRequestError:/u,
    });
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["connect", "chat.send", ...(onSend ? [] : ["chat.history"])],
    );
  });
}

test("a large history retry hint still stops at the turn deadline", async (t) => {
  const { execution, requests } = await startModelTurnProbe(t, {
    historyErrors: [{ ...historyUnavailable, retryAfterMs: 2_147_483_648 }],
    timeoutMs: 1_500,
  });
  await assert.rejects(execution, { code: 1, signal: null, stderr: /AbortError:/u });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["connect", "chat.send", "chat.history"],
  );
});
