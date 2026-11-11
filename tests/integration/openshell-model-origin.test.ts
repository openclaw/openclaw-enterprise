import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import {
  startOpenShellModelOrigin,
  type ModelOriginObservation,
  type ModelOriginToolTurn,
  type ModelOriginTurn,
} from "../fixtures/openshell-model-origin.ts";

test(
  "OpenShell model origin requires assistant history for a continued turn",
  { timeout: 10_000 },
  async (t) => {
    const nonce = randomUUID();
    const token = randomBytes(32).toString("hex");
    const model = "fixture-model";
    const before: ModelOriginTurn = {
      harness: "codex",
      id: "before",
      marker: `OCE-MODEL-before-marker-${nonce}`,
      answer: `OCE-MODEL-before-answer-${nonce}`,
    };
    const after: ModelOriginTurn = {
      harness: "codex",
      id: "after",
      priorTurnId: before.id,
      marker: `OCE-MODEL-after-marker-${nonce}`,
      answer: `OCE-MODEL-after-answer-${nonce}`,
    };
    const observations: ModelOriginObservation[] = [];
    const upstream = await startOpenShellModelOrigin({
      host: "127.0.0.1",
      port: 0,
      model,
      bearerDigests: {
        codex: createHash("sha256").update(token).digest("hex"),
        openclaw: createHash("sha256").update(randomBytes(32)).digest("hex"),
      },
      turns: [before, after],
      onObservation: (observation) => observations.push(observation),
    });
    t.after(() => upstream.close());
    const request = (input: unknown[]) =>
      fetch(`${upstream.origin}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, input }),
        signal: t.signal,
      });

    const first = await request([{ role: "user", content: before.marker }]);
    assert.equal(first.status, 200);
    assert.equal((await first.text()).includes(before.answer), true);

    // An origin-side record of the first request does not substitute for the
    // assistant history that the real Harness must send on the second request.
    const continuation = { role: "user", content: after.marker };
    const missingHistory = await request([continuation]);
    assert.equal(missingHistory.status, 400);
    assert.equal((await missingHistory.json()).error.message, "Missing previous assistant reply.");

    // Model the Responses wire here. The installed helper sends only the new
    // marker to the Gateway, so its real Harness must add this earlier history.
    const continued = await request([
      { role: "user", content: before.marker },
      { role: "assistant", content: [{ type: "output_text", text: before.answer }] },
      continuation,
    ]);
    assert.equal(continued.status, 200);
    assert.equal((await continued.text()).includes(after.answer), true);
    assert.deepEqual(
      observations.filter((observation) => observation.kind === "turn"),
      [
        {
          event: "request",
          kind: "turn",
          harness: "codex",
          status: 200,
          turnId: before.id,
          count: 1,
          priorTurnObserved: false,
        },
        {
          event: "request",
          kind: "turn",
          harness: "codex",
          status: 200,
          turnId: after.id,
          count: 1,
          priorTurnObserved: true,
        },
      ],
    );
  },
);

test(
  "OpenShell model origin waits for native tool completion and verifies its output",
  { timeout: 10_000 },
  async (t) => {
    const nonce = randomUUID();
    const token = randomBytes(32).toString("hex");
    const model = "fixture-model";
    const observations: ModelOriginObservation[] = [];
    const upstream = await startOpenShellModelOrigin({
      host: "127.0.0.1",
      port: 0,
      model,
      bearerDigests: {
        codex: createHash("sha256").update(token).digest("hex"),
        openclaw: createHash("sha256").update(randomBytes(32)).digest("hex"),
      },
      turns: [],
      onObservation: (observation) => observations.push(observation),
    });
    t.after(() => upstream.close());
    type ToolCall = { type: "function_call"; call_id: string; name: string; arguments: string };
    type Event = { type: string; item?: ToolCall };
    const request = async (input: unknown[], expectedStatus = 200) => {
      const response = await fetch(`${upstream.origin}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, input }),
        signal: t.signal,
      });
      assert.equal(response.status, expectedStatus);
      const text = await response.text();
      const events: Event[] = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .filter((line) => line !== "[DONE]")
        .map((line) => JSON.parse(line));
      return { text, events };
    };
    const toolCall = ({ events }: { events: Event[] }) => {
      const calls = events.filter(
        (event) =>
          event.type === "response.output_item.done" && event.item?.type === "function_call",
      );
      assert.equal(calls.length, 1);
      const call = calls[0]?.item;
      assert.ok(call);
      return call;
    };
    const receipt = (turnId: string) =>
      observations.find((event) => event.kind === "tool" && event.turnId === turnId);
    const wrong: ModelOriginToolTurn = {
      id: "wrong-output",
      harness: "codex",
      marker: `OCE-MODEL-tool-wrong-${nonce}`,
      answer: `OCE-MODEL-answer-wrong-${nonce}`,
      command: "printf 'expected\\n'",
      expectedOutput: "expected\n",
      timeoutMs: 60_000,
    };
    upstream.addToolTurn(wrong);
    const initial = toolCall(await request([{ role: "user", content: wrong.marker }]));
    assert.equal(initial.name, "exec_command");
    assert.equal(JSON.parse(initial.arguments).login, false);
    assert.equal(receipt(wrong.id), undefined, "a requested command is not a completed tool turn");
    // Repeating the prompt cannot replay a command whose outcome is still unknown.
    const replay = await request([{ role: "user", content: wrong.marker }], 400);
    assert.equal(
      JSON.parse(replay.text).error.message,
      "A tool result is required before continuing this command.",
    );

    // These are native Codex result envelopes, not executed commands. A yielded
    // process must be polled through the same session instead of replaying Git.
    const poll = toolCall(
      await request([
        initial,
        {
          type: "function_call_output",
          call_id: initial.call_id,
          output: "Wall time: 0.010 seconds\nProcess running with session ID 42\nOutput:\n",
        },
      ]),
    );
    assert.equal(poll.name, "write_stdin");
    const polling = JSON.parse(poll.arguments);
    assert.equal(polling.session_id, 42);
    assert.equal(polling.chars, "");
    assert.equal(receipt(wrong.id), undefined, "a running process cannot satisfy completion");
    const rejected = await request([
      poll,
      {
        type: "function_call_output",
        call_id: poll.call_id,
        output:
          "Wall time: 0.010 seconds\nProcess exited with code 0\nOutput:\nwrong\n" +
          `SKIPPER_COMPUTE_DONE_${initial.call_id}\n`,
      },
    ]);
    assert.equal(rejected.text.includes(wrong.answer), false);
    assert.equal(rejected.text.includes("OCE_TOOL_INCOMPLETE"), true);
    assert.deepEqual(receipt(wrong.id), {
      event: "request",
      kind: "tool",
      harness: "codex",
      status: 200,
      turnId: wrong.id,
      count: 1,
      commandCount: 1,
      pollCount: 1,
      exitCode: 0,
      completed: false,
      outputMatched: false,
    });

    // Only the exact expected stdout plus the native completion marker permits
    // the final answer; a zero exit code by itself was insufficient above.
    const correct: ModelOriginToolTurn = {
      ...wrong,
      id: "correct-output",
      marker: `OCE-MODEL-tool-correct-${nonce}`,
      answer: `OCE-MODEL-answer-correct-${nonce}`,
    };
    upstream.addToolTurn(correct);
    const executed = toolCall(await request([{ role: "user", content: correct.marker }]));
    assert.equal(executed.name, "exec_command");
    const completed = await request([
      executed,
      {
        type: "function_call_output",
        call_id: executed.call_id,
        output:
          "Wall time: 0.010 seconds\nProcess exited with code 0\nOutput:\n" +
          correct.expectedOutput +
          `SKIPPER_COMPUTE_DONE_${executed.call_id}\n`,
      },
    ]);
    assert.equal(completed.text.includes(correct.answer), true);
    assert.deepEqual(receipt(correct.id), {
      event: "request",
      kind: "tool",
      harness: "codex",
      status: 200,
      turnId: correct.id,
      count: 1,
      commandCount: 1,
      pollCount: 0,
      exitCode: 0,
      completed: true,
      outputMatched: true,
    });
  },
);
