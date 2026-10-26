import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";

// This origin implements only the external provider wire, never OCE authorization,
// credential selection, installation evidence, or the supervisor's response policy.
export function syntheticResponsesEvents(model, text, { mode, credential } = {}) {
  const message = {
    type: "message",
    id: "msg_synthetic",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const base = { id: "resp_synthetic", object: "response", model, created_at: 1 };
  const events = [
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
      response: {
        ...base,
        status: "completed",
        output: [message],
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      },
    },
  ];
  if (
    ["reflect-split-id", "reflect-encoded-arguments", "reflect-message-citation"].includes(mode)
  ) {
    assert.match(credential, /^SYNTHETIC-OCE-EGRESS-[a-f0-9-]+-v[12]$/);
  }
  if (mode === "reflect-split-id") {
    // Both deltas name output slot zero. Changing item_id on one must not
    // create independent redaction streams for the same assistant output.
    const split = Math.floor(credential.length / 2);
    const first = {
      ...events[3],
      item_id: "msg_synthetic_other",
      delta: credential.slice(0, split),
    };
    events.splice(3, 1, first, { ...events[3], delta: credential.slice(split) });
  }
  if (mode === "reflect-encoded-arguments") {
    // The inner JSON string contains escaped material. The outer event JSON
    // alone never contains the credential, even after its first decode.
    const argumentsValue = `{"value":"${Array.from(
      credential,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ).join("")}"}`;
    const call = {
      type: "function_call",
      id: "fc_synthetic",
      call_id: "call_synthetic",
      // An unregistered name prevents a failed enforcement check from invoking
      // a real tool. Unknown-tool failure cannot satisfy the pre-return oracle.
      name: "oce_unregistered_synthetic_tool",
      arguments: argumentsValue,
      status: "completed",
    };
    return [
      events[0],
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: call.id,
        output_index: 0,
        delta: argumentsValue,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: call.id,
        output_index: 0,
        arguments: argumentsValue,
      },
      { type: "response.output_item.done", output_index: 0, item: call },
      { ...events.at(-1), response: { ...events.at(-1).response, output: [call] } },
    ];
  }
  if (mode === "reflect-message-citation") {
    // Earlier stream events stay benign: only the completed response contains this projection.
    events.at(-1).response.output = outputWithIndependentCitation(message, credential);
  }
  return events;
}

// The first message leaves a citation open. Stripping citations from the joined messages
// hides the start of text that a reader of the second message sees in full.
export function outputWithIndependentCitation(message, text) {
  const split = Math.floor(text.length / 2);
  const content = (...parts) =>
    parts.map((text) => ({ type: "output_text", text, annotations: [] }));
  return [
    { ...message, content: content("ordinary <oai-mem-citation>unclosed") },
    {
      ...message,
      id: "msg_independent",
      content: content(
        text.slice(0, split) + "<oai-mem-citation>note",
        "</oai-mem-citation>" + text.slice(split),
      ),
    },
  ];
}

export function encodeSyntheticEvents(events) {
  return Buffer.from(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

/** Counts every request independently, including requests with rejected credentials.
 * Only the two explicitly synthetic values may be reflected; raw requests are never logged. */
export async function startSyntheticEgressProvider(t, configuration, credentials) {
  assert.deepEqual(Object.keys(credentials).sort(), ["initial", "rotated"]);
  for (const value of Object.values(credentials)) {
    assert.match(value, /^SYNTHETIC-OCE-EGRESS-[a-f0-9-]+-v[12]$/);
  }
  let mode = "answer";
  const observations = [];
  const errors = [];
  const server = createServer(
    {
      cert: await readFile(configuration.certificatePath),
      key: await readFile(configuration.privateKeyPath),
    },
    async (request, response) => {
      // Reserve the count before reading the body: denial cannot hide an incomplete send.
      const observation = {
        number: observations.length + 1,
        mode,
        at: new Date().toISOString(),
        method: request.method === "POST" ? "POST" : "unrecognized",
        path: request.url === "/v1/responses" ? "/v1/responses" : "unrecognized",
        credentialVersion: "unrecognized",
      };
      observations.push(observation);
      try {
        const responseMode = observation.mode;
        const version = Object.entries(credentials).find(
          ([, value]) => request.headers.authorization === `Bearer ${value}`,
        )?.[0];
        if (version === undefined) {
          observation.status = 403;
          response.writeHead(403).end();
          return;
        }
        observation.credentialVersion = version;
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          observation.status = 404;
          response.writeHead(404).end();
          return;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            observation.status = 413;
            response.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const wire = Buffer.concat(chunks).toString("utf8");
        const body = JSON.parse(wire);
        const nonce = wire.match(/OCE-EGRESS-[a-f0-9-]{36}/g)?.at(-1);
        Object.assign(observation, {
          requestBytes: bytes,
          model: body.model === configuration.model ? configuration.model : "unrecognized",
          stream: body.stream === true,
          store: body.store === false ? false : "unrecognized",
          nonce,
          toolTypes: [
            ...new Set(
              (body.tools ?? []).map(({ type }) =>
                ["function", "namespace", "custom", "web_search", "web_search_preview"].includes(
                  type,
                )
                  ? type
                  : "unrecognized",
              ),
            ),
          ],
        });
        assert.equal(body.model, configuration.model);
        assert.equal(body.stream, true, "the genuine Codex caller must use HTTP/SSE");
        assert.equal(body.store, false);
        assert.equal(
          (body.tools ?? []).some(
            ({ type }) => !["function", "namespace", "custom"].includes(type),
          ),
          false,
        );
        const text = responseMode === "reflect-body" ? credentials[version] : (nonce ?? "READY");
        const events = syntheticResponsesEvents(body.model, text, {
          mode: responseMode,
          credential: credentials[version],
        });
        let responseBody = encodeSyntheticEvents(events);
        if (responseMode === "oversize") {
          // A complete event exceeding the 4 MiB response limit must never reach Codex.
          responseBody = encodeSyntheticEvents(
            syntheticResponsesEvents(body.model, "x".repeat(4 * 1024 * 1024 + 1)),
          );
        }
        const headers = { "content-type": "text/event-stream", "cache-control": "no-cache" };
        if (responseMode === "reflect-header") {
          headers["x-synthetic-reflection"] = credentials[version];
        }
        if (responseMode === "incomplete") {
          responseBody = encodeSyntheticEvents(events.slice(0, 1));
        }
        observation.status = 200;
        observation.responseBytes = responseBody.length;
        response.writeHead(200, headers);
        // Multiple HTTP chunks, splitting JSON/event boundaries, exercise finite stream staging.
        for (let offset = 0; offset < responseBody.length; offset += 1021) {
          if (!response.write(responseBody.subarray(offset, offset + 1021))) {
            await new Promise((resolve) => {
              const finish = () => {
                response.removeListener("drain", finish);
                response.removeListener("close", finish);
                resolve();
              };
              response.once("drain", finish);
              response.once("close", finish);
            });
          }
          if (response.destroyed) {
            break;
          }
        }
        response.end();
      } catch {
        // Neither an exception message nor the parsed request is safe diagnostic material.
        errors.push({ request: observation.number, code: "SYNTHETIC_PROVIDER_REQUEST_FAILED" });
        response.destroy();
      }
    },
  );
  // Direct-bypass qualification must count TCP arrivals, even without TLS or HTTP.
  let tcpConnections = 0;
  server.on("connection", () => {
    tcpConnections++;
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 5_000;
  t.after(() => {
    server.closeAllConnections();
    if (!server.listening) {
      return;
    }
    return new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuration.bindPort, configuration.bindHost, resolve);
  });
  return {
    observations,
    errors,
    get tcpConnections() {
      return tcpConnections;
    },
    setMode(value) {
      assert.ok(
        [
          "answer",
          "reflect-body",
          "reflect-header",
          "reflect-split-id",
          "reflect-encoded-arguments",
          "reflect-message-citation",
          "oversize",
          "incomplete",
        ].includes(value),
      );
      mode = value;
    },
  };
}
