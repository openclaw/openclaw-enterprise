import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { connect, createServer as createControlServer } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// Runs in a container of the runtime image and stands in for the model provider
// as api.openai.com. In the runtime image tests it is a sidecar that owns the
// network namespace a runtime wrapper joins, with api.openai.com mapped to
// loopback, and it also observes the wrapper from outside: when the native
// process accepts connections, what the private runtime and plugin status
// report, and what the runtime's HTTP readiness endpoint decides. The first-Agent smoke
// (scripts/ci/first-agent-smoke.mjs) runs it without observation on an address
// the cluster resolves api.openai.com to. Every line it prints is one JSON event
// with an epoch timestamp.
export async function startModelProbeEndpoint({
  env = process.env,
  tls,
  WebSocketServer,
  port = 443,
}) {
  const mode = env.PROBE_ENDPOINT_MODE; // "answer" | "reject" | "hang"
  const delayMs = Number(env.PROBE_ENDPOINT_DELAY_MS ?? 0);
  const listenHost = env.PROBE_ENDPOINT_HOST ?? "127.0.0.1";
  // When set, a turn answers with the last match of this pattern in its request
  // (a caller's nonce) instead of READY, so a caller can prove its own turn arrived.
  const echoPattern =
    env.PROBE_ENDPOINT_ECHO_PATTERN === undefined
      ? undefined
      : new RegExp(env.PROBE_ENDPOINT_ECHO_PATTERN, "g");
  const observing = env.PROBE_OBSERVE_NATIVE_PORT !== undefined;
  const publicReadJourney = env.PROBE_PUBLIC_READ_JOURNEY === "1";
  const skipperFixture =
    env.PROBE_SKIPPER_PREPARED_COMPUTE === "1"
      ? (await import("./skipper-prepared-compute-model.mjs")).createSkipperPreparedComputeEvents(
          "/fixture/skipper-command.json",
        )
      : undefined;
  const nativePort = Number(env.PROBE_OBSERVE_NATIVE_PORT);
  const statusPort = Number(env.PROBE_OBSERVE_STATUS_PORT);
  const credentialLabels = readCredentialLabels(env.PROBE_ENDPOINT_CREDENTIAL_DIGESTS);
  // Codex opens the Responses API over a WebSocket first and falls back to HTTPS.
  // Use the WebSocket implementation the runtime image already ships.

  const rejection = JSON.stringify({
    error: {
      message: "Incorrect API key provided.",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  });

  function readCredentialLabels(value) {
    if (value === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(value);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error();
      }
      const entries = Object.entries(parsed);
      const labels = new Map();
      if (entries.length === 0) {
        throw new Error();
      }
      for (const [label, digest] of entries) {
        if (
          !/^[a-z][a-z0-9-]{0,63}$/.test(label) ||
          typeof digest !== "string" ||
          !/^[0-9a-f]{64}$/.test(digest) ||
          labels.has(digest)
        ) {
          throw new Error();
        }
        labels.set(digest, label);
      }
      return labels;
    } catch {
      throw new Error("Invalid probe endpoint credential digests");
    }
  }

  function callerLabel(request) {
    if (credentialLabels === undefined) {
      return undefined;
    }
    const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    return token === undefined
      ? null
      : (credentialLabels.get(createHash("sha256").update(token).digest("hex")) ?? null);
  }

  function emit(event) {
    process.stdout.write(`${JSON.stringify({ ...event, at: Date.now() })}\n`);
  }

  function sseResponse(response, events) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of events) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    return new Promise((resolve, reject) => {
      response.once("error", reject);
      response.once("close", () => {
        if (!response.writableFinished) {
          reject(new Error("Response closed"));
        }
      });
      response.end(resolve);
    });
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

  // The smoke's model stand-in requests a real Codex tool call. The command reads
  // the endpoint from the managed skill; the provider-only title is never supplied
  // to the model or the command before the tool output returns.
  function publicReadEvents(model, request) {
    if (!publicReadJourney) {
      return undefined;
    }
    let input;
    try {
      input = JSON.parse(request).input;
    } catch {
      return undefined;
    }
    if (!Array.isArray(input)) {
      return undefined;
    }
    const output = input.find(
      (item) => item.type === "function_call_output" && item.call_id === "public-read-call",
    );
    if (output) {
      const result = JSON.stringify(output.output);
      const title = result.match(/public-pull-[0-9a-f-]{36}/u)?.[0];
      const curlCode = result.match(/curl: \(([0-9]{1,3})\)/u)?.[1];
      emit({
        event: "public-read-tool-result",
        result: title ? "title-returned" : curlCode ? `curl-${curlCode}` : "no-title",
      });
      return answerEvents(model, title ?? "PUBLIC_READ_TOOL_FAILED");
    }
    if (!request.includes("OCE_PUBLIC_READ_JOURNEY")) {
      return undefined;
    }
    const command = [
      "set -eu",
      'test "$CODEX_NETWORK_PROXY_ACTIVE" = 1',
      'test "$CODEX_NETWORK_ALLOW_LOCAL_BINDING" = 0',
      'origin=$(grep -Eo "http://[0-9.]+:8080" /home/node/.openclaw/skills/public-github-read/SKILL.md | head -1)',
      'curl -q --proxy "$HTTP_PROXY" --noproxy "" --fail-with-body -sS --max-time 15 "$origin/repos/example/public-project/pulls/27"',
    ].join("\n");
    const item = {
      type: "function_call",
      call_id: "public-read-call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: command }),
    };
    const base = {
      id: "resp_public_read",
      object: "response",
      model,
      created_at: Math.floor(Date.now() / 1000),
    };
    return [
      { type: "response.created", response: { ...base, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { ...base, status: "completed", output: [item] } },
    ];
  }

  // Only an explicitly armed synthetic marker can hold a response. Match the
  // newest user input: earlier conversation history must not hold a continuation.
  function newestUserText(request) {
    const input = JSON.parse(request).input;
    if (typeof input === "string") {
      return input;
    }
    if (!Array.isArray(input)) {
      return "";
    }
    const item = input.findLast((entry) => entry?.role === "user");
    if (typeof item?.content === "string") {
      return item.content;
    }
    return Array.isArray(item?.content)
      ? item.content
          .filter((part) => part?.type === "input_text" || part?.type === "text")
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join("\n")
      : "";
  }
  const timers = new Set();
  const observationStop = new AbortController();
  let stopping = false;
  let gate;
  let control;
  const controlConnections = new Set();
  const connections = new Set();
  const controlPath = env.PROBE_ENDPOINT_CONTROL_SOCKET;
  function gateStatus() {
    return {
      gateId: gate.id,
      state: gate.state,
      matchingRequests: gate.matchingRequests,
      completedResponses: gate.completedResponses,
      ...(gate.reason ? { reason: gate.reason } : {}),
    };
  }
  function failGate(reason) {
    clearTimeout(gate.timer);
    gate.state = "failed";
    gate.reason = reason;
    gate.pending?.detach();
    gate.pending?.abort();
    emit({ event: "barrier-failed", ...gateStatus() });
  }
  async function command(value) {
    if (value?.op === "shutdown") {
      return { ok: true, state: "stopping" };
    }
    if (value?.op === "arm") {
      if (gate) {
        return { ok: false, error: "already-armed" };
      }
      if (
        mode !== "answer" ||
        typeof value.marker !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{15,127}$/.test(value.marker) ||
        !Number.isInteger(value.timeoutMs) ||
        value.timeoutMs < 1 ||
        value.timeoutMs > 300_000
      ) {
        return { ok: false, error: "invalid-arm" };
      }
      gate = {
        id: randomUUID(),
        marker: value.marker,
        state: "armed",
        matchingRequests: 0,
        completedResponses: 0,
      };
      gate.timer = setTimeout(() => failGate("timeout"), value.timeoutMs);
      return { ok: true, ...gateStatus() };
    }
    if (!gate || value?.gateId !== gate.id) {
      return { ok: false, error: "unknown-gate" };
    }
    if (value.op === "status") {
      return { ok: true, ...gateStatus() };
    }
    if (value.op !== "release") {
      return { ok: false, error: "unknown-operation" };
    }
    if (gate.state !== "held") {
      return { ok: false, error: "not-held", ...gateStatus() };
    }
    if (gate.pending.closed()) {
      failGate("aborted");
      return { ok: false, error: "not-held", ...gateStatus() };
    }
    gate.state = "releasing";
    try {
      await gate.pending.send();
      if (gate.state === "failed") {
        return { ok: false, error: "release-failed", ...gateStatus() };
      }
      gate.completedResponses++;
      gate.state = "completed";
      clearTimeout(gate.timer);
      gate.pending.detach();
      emit({ event: "barrier-completed", ...gateStatus() });
      return { ok: true, ...gateStatus() };
    } catch {
      if (gate.state !== "failed") {
        failGate("write-failed");
      }
      return { ok: false, error: "release-failed", ...gateStatus() };
    }
  }

  function turn(transport, model, request, respond, closed, caller, abort, onClose) {
    if (stopping) {
      abort();
      return;
    }
    emit({ event: "request", transport, turn: true });
    if (mode === "hang") {
      return;
    }
    const text = answerText(request);
    const send = async () => {
      await respond(
        skipperFixture?.({ model, request, answerEvents, emit }) ??
          publicReadEvents(model, request) ??
          answerEvents(model, text),
      );
      emit({
        event: "turn-answered",
        transport,
        status: 200,
        ...(caller === undefined ? {} : { caller }),
        ...(echoPattern === undefined ? {} : { text }),
      });
    };
    let target = false;
    if (gate) {
      try {
        // Markers contain only literal token characters; do not match a prefix of another token.
        target = newestUserText(request)
          .split(/[^A-Za-z0-9_-]+/)
          .includes(gate.marker);
      } catch {
        /* Keep the existing malformed-request behavior outside the barrier. */
      }
    }
    if (target) {
      gate.matchingRequests++;
      if (gate.state !== "armed") {
        failGate("duplicate-request");
        abort();
        return;
      }
      gate.pending = {
        send,
        abort,
        closed,
        detach: onClose(() => {
          if (gate.state === "held" || gate.state === "releasing") {
            failGate("aborted");
          }
        }),
      };
      gate.state = "held";
      emit({ event: "barrier-arrived", transport, ...gateStatus() });
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed() && !stopping) {
        void send().catch(() => {});
      }
    }, delayMs);
    timers.add(timer);
  }

  const server = createServer(tls, (request, response) => {
    if (stopping) {
      response.destroy();
      return;
    }
    const caller = callerLabel(request);
    if (caller === null) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(rejection);
      return;
    }
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
        caller,
        () => response.destroy(),
        (callback) => {
          const closed = () => {
            if (!response.writableFinished) {
              callback();
            }
          };
          response.once("close", closed);
          return () => response.off("close", closed);
        },
      );
    });
  });

  // Whether a caller that sent no request ever reached the provider: each TCP
  // connection, completed TLS handshake and failed handshake.
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    emit({ event: "connection" });
  });
  server.on("secureConnection", () => emit({ event: "secure" }));
  server.on("tlsClientError", (error) => emit({ event: "tls-error", code: error.code ?? null }));

  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const caller = callerLabel(request);
    if (caller === null || mode === "reject") {
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
          (events) =>
            Promise.all(
              events.map(
                (event) =>
                  new Promise((resolve, reject) => {
                    webSocket.send(JSON.stringify(event), (error) =>
                      error ? reject(error) : resolve(),
                    );
                  }),
              ),
            ),
          () => !open,
          caller,
          () => webSocket.terminate(),
          (callback) => {
            webSocket.once("close", callback);
            return () => webSocket.off("close", callback);
          },
        );
      });
    });
  });

  function nativeListening() {
    return new Promise((resolve) => {
      const socket = connect({
        host: "127.0.0.1",
        port: nativePort,
        signal: observationStop.signal,
      });
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
        {
          host: "127.0.0.1",
          port: statusPort,
          path,
          timeout: 1000,
          signal: observationStop.signal,
        },
        (response) => {
          response.once("error", () => resolve(undefined));
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

  function ready() {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const request = httpGet(
        {
          host: "127.0.0.1",
          port: statusPort,
          path: "/readyz",
          timeout: 1_000,
          signal: observationStop.signal,
        },
        (response) => {
          response.resume();
          response.once("end", () => settle({ ready: response.statusCode === 200 }));
        },
      );
      request.on("error", () => settle({ ready: false }));
      request.on("timeout", () => request.destroy());
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

  let observation;
  let closing;
  function close() {
    closing ??= (async () => {
      stopping = true;
      observationStop.abort();
      // Stop accepting connections before draining the sockets already owned.
      const serversClosed = [server, control, sockets]
        .filter(Boolean)
        .map((resource) => new Promise((resolve) => resource.close(() => resolve())));
      if (gate && (gate.state === "armed" || gate.state === "held" || gate.state === "releasing")) {
        failGate("shutdown");
      }
      for (const timer of timers) {
        clearTimeout(timer);
      }
      for (const socket of connections) {
        socket.destroy();
      }
      for (const socket of controlConnections) {
        socket.destroy();
      }
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await Promise.all([...serversClosed, observation]);
    })();
    return closing;
  }
  try {
    if (controlPath !== undefined) {
      if (!isAbsolute(controlPath)) {
        throw new Error("Control socket must be absolute");
      }
      const parent = lstatSync(dirname(controlPath));
      if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) {
        throw new Error("Control socket requires an owned private directory");
      }
      control = createControlServer({ allowHalfOpen: true }, (socket) => {
        controlConnections.add(socket);
        socket.once("close", () => controlConnections.delete(socket));
        socket.setTimeout(5_000, () => socket.destroy());
        let input = "";
        let received = false;
        socket.setEncoding("utf8");
        socket.on("error", () => {});
        socket.on("data", (chunk) => {
          if (received) {
            return;
          }
          input += chunk;
          if (Buffer.byteLength(input) > 4096) {
            received = true;
            socket.end('{"ok":false,"error":"invalid-command"}\n');
            return;
          }
          if (!input.includes("\n")) {
            return;
          }
          received = true;
          let value;
          try {
            value = JSON.parse(input);
          } catch {
            socket.end('{"ok":false,"error":"invalid-command"}\n');
            return;
          }
          void command(value).then(
            (result) => {
              socket.end(`${JSON.stringify(result)}\n`, () => {
                if (value?.op === "shutdown") {
                  void close();
                }
              });
            },
            () => socket.end('{"ok":false,"error":"command-failed"}\n'),
          );
        });
      });
      await new Promise((resolve, reject) => {
        control.once("error", reject);
        control.listen(controlPath, resolve);
      });
      chmodSync(controlPath, 0o600);
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, listenHost, resolve);
    });
  } catch (error) {
    await close();
    throw error;
  }

  emit({ event: "listening" });
  if (observing) {
    observation = (async () => {
      while (!stopping) {
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
        if (!stopping) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    })();
  }
  return { port: server.address().port, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { WebSocketServer } = createRequire("/app/node_modules/ws/package.json")("ws");
  const endpoint = await startModelProbeEndpoint({
    tls: { key: readFileSync("/fixture/key.pem"), cert: readFileSync("/fixture/cert.pem") },
    WebSocketServer,
  });
  process.once("SIGTERM", () => void endpoint.close());
  process.once("SIGINT", () => void endpoint.close());
}
