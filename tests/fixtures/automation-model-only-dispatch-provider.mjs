import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Supplemental provider only. It sends model tool requests, never tool outcomes.
// Stock Harnesses must execute/reject them and return the correlated result.
export async function startDispatchProvider({
  harness,
  credential,
  nonce,
  workspace,
  probe,
  strategy,
}) {
  const { WebSocketServer } = createRequire("/app/node_modules/ws/package.json")("ws");
  const records = [];
  const cases = new Map();
  const callCases = new Map();
  const callCounts = new Map();
  let selected;
  const markerFor = (phase) => `OCE_DISPATCH_${phase.toUpperCase()}_${nonce}`;
  const fileFor = (phase) => `${workspace}/occ-dispatch-${phase}-${nonce}`;
  function toolEntries(tools) {
    return (tools ?? []).flatMap((tool) =>
      tool.type === "namespace"
        ? tool.tools.map((entry) => ({ ...entry, namespace: tool.name }))
        : [tool],
    );
  }
  function selectTool(tools) {
    const entries = toolEntries(tools);
    const find = (name, type) => entries.find((tool) => tool.name === name && tool.type === type);
    const tool = find(probe, probe === "exec" ? "custom" : "function");
    assert.ok(tool, "ordinary chat must advertise a supported real write/shell tool");
    return {
      name: tool.name,
      type: tool.type,
      pathField: tool.parameters?.properties?.file_path ? "file_path" : "path",
    };
  }
  function response(model, item) {
    const base = {
      id: `resp_${randomUUID()}`,
      object: "response",
      model,
      created_at: Math.floor(Date.now() / 1000),
    };
    const events = [
      { type: "response.created", response: { ...base, status: "in_progress", output: [] } },
    ];
    if (item.type === "function_call") {
      events.push(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, arguments: "", status: "in_progress" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          arguments: item.arguments,
        },
      );
    } else if (item.type === "custom_tool_call") {
      events.push(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, input: "", status: "in_progress" },
        },
        {
          type: "response.custom_tool_call_input.delta",
          item_id: item.id,
          output_index: 0,
          delta: item.input,
        },
      );
    } else {
      events.push(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, content: [], status: "in_progress" },
        },
        {
          type: "response.content_part.added",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: item.content[0].text,
        },
        {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: item.content[0].text,
        },
        {
          type: "response.content_part.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: item.content[0],
        },
      );
    }
    events.push(
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          ...base,
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        },
      },
    );
    return events;
  }
  function answer(model, text) {
    return response(model, {
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  function events(body, transport) {
    const auxiliary = strategy?.auxiliary?.(body);
    if (auxiliary) {
      records.push({ event: "scenario-auxiliary-request", transport, text: auxiliary.text });
      return answer(body.model, auxiliary.text);
    }
    const input = body.input ?? [];
    const outputs = input.filter((item) =>
      ["function_call_output", "custom_tool_call_output"].includes(item.type),
    );
    const output = outputs.findLast((item) => callCases.has(item.call_id));
    const phase = output
      ? callCases.get(output.call_id)
      : ["positive", "negative"].find((candidate) =>
          JSON.stringify(input).includes(markerFor(candidate)),
        );
    if (!phase) {
      return answer(body.model, "READY");
    }
    const tools = toolEntries(body.tools);
    records.push({
      event: "model-request",
      phase,
      transport,
      tools: tools.map(({ type, name, namespace }) => ({ type, name, namespace })),
    });
    if (cases.get(phase)?.complete) {
      records.push({ event: "auxiliary-model-request", phase });
      return answer(body.model, "Supplemental dispatch probe");
    }
    let rejected = false;
    if (output) {
      const text = JSON.stringify(output.output ?? "");
      rejected =
        /unknown tool|tool.{0,80}(?:not found|not available|unavailable|disabled)|unsupported.{0,40}tool|unsupported call:|unrecognized.{0,40}tool|no tool/i.test(
          text,
        );
      records.push({
        event: "tool-result",
        phase,
        callId: output.call_id,
        rejected,
        resultText: text.slice(0, 2000),
        resultTypes: Array.isArray(output.output)
          ? output.output.map((part) => part.type)
          : [typeof output.output],
      });
      if (!strategy) {
        cases.set(phase, { complete: true, rejected, callId: output.call_id });
        return answer(body.model, `DISPATCH_FINISHED_${phase}_${nonce}`);
      }
    }
    if (strategy) {
      if (!output) {
        assert.ok(
          !cases.has(phase),
          "a scenario must return correlated native output before continuing",
        );
      }
      const action = strategy.plan({ phase, tools, output, body });
      if (action.complete) {
        assert.ok(output, "a scenario cannot complete without an actual native tool result");
        cases.set(phase, { complete: true, rejected, callId: output.call_id });
        records.push({ event: "scenario-completed", phase, summary: action.summary });
        return answer(body.model, `DISPATCH_FINISHED_${phase}_${nonce}`);
      }
      const count = (callCounts.get(phase) ?? 0) + 1;
      assert.ok(count <= 8, "supplemental scenario exceeded its bounded model call sequence");
      callCounts.set(phase, count);
      const call = {
        ...action.call,
        id: `tool_${randomUUID()}`,
        call_id: `call_${phase}_${nonce}_${count}`,
        status: "completed",
      };
      assert.ok(["function_call", "custom_tool_call"].includes(call.type));
      cases.set(phase, { complete: false, callId: call.call_id });
      callCases.set(call.call_id, phase);
      records.push({
        event: "tool-call-emitted",
        phase,
        callId: call.call_id,
        type: call.type,
        name: call.name,
        namespace: call.namespace,
      });
      return response(body.model, call);
    }
    if (phase === "positive") {
      selected ??= selectTool(body.tools);
    }
    assert.ok(
      selected,
      "negative dispatch requires the genuine ordinary-chat positive control first",
    );
    assert.ok(
      !cases.has(phase),
      "a tool call must return correlated dispatch output, not silently restart",
    );
    const file = fileFor(phase);
    const marker = markerFor(phase);
    const command = `printf '%s' '${marker}' > '${file}'`;
    const call = {
      id: `tool_${randomUUID()}`,
      call_id: `call_${phase}_${nonce}`,
      name: selected.name,
      type: selected.type === "custom" ? "custom_tool_call" : "function_call",
      status: "completed",
    };
    if (selected.name === "write") {
      call.arguments = JSON.stringify({ [selected.pathField]: file, content: marker });
    } else if (selected.name === "exec_command") {
      call.arguments = JSON.stringify({
        cmd: command,
        login: false,
        sandbox_permissions: "use_default",
      });
    } else {
      assert.equal(harness, "codex");
      assert.equal(selected.name, "exec");
      call.input = `// @exec: {"yield_time_ms": 10000}\ntext(await tools.exec_command(${JSON.stringify({ cmd: command, login: false, sandbox_permissions: "use_default" })}));`;
    }
    cases.set(phase, { complete: false, callId: call.call_id });
    callCases.set(call.call_id, phase);
    records.push({
      event: "tool-call-emitted",
      phase,
      callId: call.call_id,
      type: call.type,
      name: call.name,
    });
    return response(body.model, call);
  }
  const server = createServer(
    { key: readFileSync("/fixture/key.pem"), cert: readFileSync("/fixture/cert.pem") },
    (req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        if (req.headers.authorization !== `Bearer ${credential}`) {
          res.writeHead(401).end();
          return;
        }
        if (
          req.method === "GET" &&
          new URL(req.url, "https://api.openai.com").pathname.endsWith("/models")
        ) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              object: "list",
              data: [{ id: "gpt-5", object: "model", owned_by: "openai", created: 1 }],
            }),
          );
          return;
        }
        if (
          req.method !== "POST" ||
          !new URL(req.url, "https://api.openai.com").pathname.endsWith("/responses")
        ) {
          res.writeHead(404).end();
          return;
        }
        try {
          const body = JSON.parse(raw);
          if (!body.model) {
            res.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({
                error: {
                  message: "Missing required parameter: model",
                  type: "invalid_request_error",
                },
              }),
            );
            return;
          }
          const stream = events(body, "https");
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of stream) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          res.end();
        } catch (error) {
          records.push({ event: "provider-contract-failure", message: error.message });
          res.writeHead(500).end();
        }
      });
    },
  );
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${credential}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        try {
          for (const event of events(JSON.parse(raw.toString()), "websocket")) {
            ws.send(JSON.stringify(event));
          }
        } catch (error) {
          records.push({ event: "provider-contract-failure", message: error.message });
          ws.close();
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(443, "127.0.0.1", resolve));
  return {
    records,
    cases,
    markerFor,
    async close() {
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
