import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";

// Runs in a container of the runtime image and stands in for the model provider
// as api.openai.com. In the runtime image tests it is a sidecar that owns the
// network namespace a runtime wrapper joins, with api.openai.com mapped to
// loopback, and it also observes the wrapper from outside: when the native
// process accepts connections, what the private runtime and plugin status
// report, and what the real readiness program decides. The first-Agent smoke
// (scripts/ci/first-agent-smoke.mjs) runs it without observation on an address
// the cluster resolves api.openai.com to. Every line it prints is one JSON event
// with an epoch timestamp.
const mode = process.env.PROBE_ENDPOINT_MODE; // "answer" | "reject" | "hang"
const delayMs = Number(process.env.PROBE_ENDPOINT_DELAY_MS ?? 0);
const listenHost = process.env.PROBE_ENDPOINT_HOST ?? "127.0.0.1";
// When set, a turn answers with the last match of this pattern in its request
// (a caller's nonce) instead of READY, so a caller can prove its own turn arrived.
const echoPattern =
  process.env.PROBE_ENDPOINT_ECHO_PATTERN === undefined
    ? undefined
    : new RegExp(process.env.PROBE_ENDPOINT_ECHO_PATTERN, "g");
const observing = process.env.PROBE_OBSERVE_NATIVE_PORT !== undefined;
const nativePort = Number(process.env.PROBE_OBSERVE_NATIVE_PORT);
const statusPort = Number(process.env.PROBE_OBSERVE_STATUS_PORT);
const readinessEnvironment = JSON.parse(process.env.PROBE_OBSERVE_READINESS_ENV ?? "{}");
const readinessProgram = observing ? readFileSync("/fixture/readiness.cjs", "utf8") : "";
// Codex opens the Responses API over a WebSocket first and falls back to HTTPS.
// Use the WebSocket implementation the runtime image already ships.
const { WebSocketServer } = createRequire("/app/node_modules/ws/package.json")("ws");
const rejection = JSON.stringify({
  error: {
    message: "Incorrect API key provided.",
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
});

function emit(event) {
  process.stdout.write(`${JSON.stringify({ ...event, at: Date.now() })}\n`);
}

function sseResponse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function answerText(request) {
  const matches = echoPattern === undefined ? [] : request.match(echoPattern);
  return matches?.at(-1) ?? "READY";
}

// A minimal Responses API stream: one assistant message saying READY, or the
// caller's echoed nonce.
function answerEvents(model, text) {
  const id = "resp_runtime_probe";
  const message = {
    type: "message",
    id: "msg_runtime_probe",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const usage = {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  };
  const base = { id, object: "response", model, created_at: Math.floor(Date.now() / 1000) };
  return [
    { type: "response.created", response: { ...base, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: message.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: { ...base, status: "completed", output: [message], usage },
    },
  ];
}

// Answer one model turn after the configured delay, unless the caller left.
function turn(transport, model, request, respond, closed) {
  emit({ event: "request", transport, turn: true });
  if (mode === "hang") {
    return;
  }
  const text = answerText(request);
  setTimeout(() => {
    if (closed()) {
      return;
    }
    respond(answerEvents(model, text));
    emit({
      event: "turn-answered",
      transport,
      status: 200,
      ...(echoPattern === undefined ? {} : { text }),
    });
  }, delayMs);
}

const server = createServer(
  { key: readFileSync("/fixture/key.pem"), cert: readFileSync("/fixture/cert.pem") },
  (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const path = new URL(request.url, "https://api.openai.com").pathname;
      if (!(request.method === "POST" && path.endsWith("/responses"))) {
        emit({ event: "request", method: request.method, path, turn: false });
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }),
        );
        return;
      }
      let model = "unknown";
      try {
        model = JSON.parse(body).model;
      } catch {
        // A malformed body still gets an answer; the caller validates it.
      }
      // Like the provider, authenticate first, then refuse a request without a
      // model: the wrapper's upfront credential check sends exactly that.
      if (model === undefined && mode !== "reject") {
        emit({ event: "request", method: request.method, path, turn: false });
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Missing required parameter: 'model'.",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      if (mode === "reject") {
        emit({ event: "request", transport: "https", turn: true });
        response.writeHead(401, { "content-type": "application/json" });
        response.end(rejection);
        emit({ event: "turn-answered", transport: "https", status: 401 });
        return;
      }
      response.on("close", () => emit({ event: "turn-closed", transport: "https" }));
      turn(
        "https",
        model,
        body,
        (events) => sseResponse(response, events),
        () => response.destroyed,
      );
    });
  },
);

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (mode === "reject") {
    emit({ event: "request", transport: "websocket", turn: true });
    socket.end(
      "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(rejection)}\r\nconnection: close\r\n\r\n${rejection}`,
    );
    emit({ event: "turn-answered", transport: "websocket", status: 401 });
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    let open = true;
    webSocket.on("close", () => {
      open = false;
      emit({ event: "turn-closed", transport: "websocket" });
    });
    webSocket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type !== "response.create") {
        return;
      }
      // A prewarm (generate: false) primes the connection and is answered at
      // once, as the provider does; only model turns take the configured time.
      if (message.generate === false) {
        const base = { id: "resp_runtime_prewarm", object: "response", model: message.model };
        webSocket.send(
          JSON.stringify({
            type: "response.created",
            response: { ...base, status: "in_progress", output: [] },
          }),
        );
        webSocket.send(
          JSON.stringify({
            type: "response.completed",
            response: { ...base, status: "completed", output: [] },
          }),
        );
        emit({ event: "prewarm", transport: "websocket" });
        return;
      }
      turn(
        "websocket",
        message.model ?? "unknown",
        String(data),
        (events) => {
          for (const event of events) {
            webSocket.send(JSON.stringify(event));
          }
        },
        () => !open,
      );
    });
  });
});

function nativeListening() {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: nativePort });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function readStatus(path) {
  return new Promise((resolve) => {
    const request = httpGet(
      { host: "127.0.0.1", port: statusPort, path, timeout: 1000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    request.on("error", () => resolve(undefined));
    request.on("timeout", () => request.destroy());
  });
}

// The real readiness entrypoint, with the wrapper container's environment.
// Its output is what kubelet shows after "Readiness probe failed:".
function ready() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", readinessProgram], {
      env: { ...process.env, ...readinessEnvironment },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("close", (code) =>
      resolve({ ready: code === 0, reason: output.trim() === "" ? null : output.trim() }),
    );
    child.once("error", () => resolve({ ready: false, reason: null }));
  });
}

const last = {};
function observe(key, value) {
  if (last[key] === value) {
    return;
  }
  last[key] = value;
  emit({ event: "observe", key, value });
}

server.listen(443, listenHost, () => {
  emit({ event: "listening" });
  if (!observing) {
    return;
  }
  (async () => {
    for (;;) {
      const [listening, runtime, plugin, readiness] = await Promise.all([
        nativeListening(),
        readStatus("/openclaw/runtime/status"),
        readStatus("/openclaw/plugin-runtime/status"),
        ready(),
      ]);
      observe("native", listening);
      observe("startup", runtime?.startup ?? null);
      observe("runtimeFailure", runtime?.runtimeFailure?.code ?? null);
      observe("plugin", plugin?.phase ?? null);
      observe("ready", readiness.ready);
      observe("readinessReason", readiness.reason);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
});
