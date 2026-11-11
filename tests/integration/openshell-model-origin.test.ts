import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { openShellGrantCredentialIdentity } from "../../apps/controller/src/drivers/egress-proxy/openshell-token-grant.ts";
import { assertOpenShellModelTurn } from "../helpers/openshell-model-turn.ts";

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

test(
  "OpenShell model turn requires a fresh matching Gateway assertion despite a valid upstream bearer",
  { timeout: 10_000 },
  async (t) => {
    type Evidence = NonNullable<Parameters<typeof assertOpenShellModelTurn>[0]["grantEvidence"]>;
    type Approval = Awaited<ReturnType<Evidence["readApprovals"]>>[number];
    const expected: Evidence["expected"] = {
      providerId: randomUUID(),
      credentialKey: "access_token",
      sandboxId: randomUUID(),
      bindingId: randomUUID(),
      namespaceId: randomUUID(),
      agentId: randomUUID(),
      revisionId: randomUUID(),
    };
    const approval: Approval = {
      recipientId: expected.sandboxId,
      requestId: randomUUID(),
      bindingId: expected.bindingId,
      namespaceId: expected.namespaceId,
      agentId: expected.agentId,
      revisionId: expected.revisionId,
      credentialIdentity: openShellGrantCredentialIdentity(expected.providerId, "access_token"),
      consumed: true,
      assertionReplayClaimed: true,
    };
    const scenarios: {
      name: string;
      before: Approval[];
      after: Approval[];
      accepted?: boolean;
    }[] = [
      { name: "missing", before: [], after: [] },
      { name: "startup", before: [approval], after: [approval] },
      {
        name: "startup-in-flight",
        before: [{ ...approval, consumed: false, assertionReplayClaimed: false }],
        after: [approval],
      },
      {
        name: "other-provider",
        before: [],
        after: [
          {
            ...approval,
            credentialIdentity: openShellGrantCredentialIdentity(randomUUID(), "access_token"),
          },
        ],
      },
      { name: "other-execution", before: [], after: [{ ...approval, revisionId: randomUUID() }] },
      { name: "other-sandbox", before: [], after: [{ ...approval, recipientId: randomUUID() }] },
      { name: "other-binding", before: [], after: [{ ...approval, bindingId: randomUUID() }] },
      {
        name: "unconsumed",
        before: [],
        after: [{ ...approval, consumed: false, assertionReplayClaimed: false }],
      },
      { name: "fresh", before: [], after: [approval], accepted: true },
    ];
    const turns: ModelOriginTurn[] = scenarios.map(({ name }) => ({
      id: name,
      harness: "codex",
      marker: `OCE-MODEL-request-${randomUUID()}`,
      answer: `OCE-MODEL-answer-${randomUUID()}`,
    }));
    const token = randomBytes(32).toString("hex");
    const gatewayPassword = randomBytes(32).toString("hex");
    const observations: ModelOriginObservation[] = [];
    const upstream = await startOpenShellModelOrigin({
      host: "127.0.0.1",
      port: 0,
      model: "fixture-model",
      bearerDigests: {
        codex: createHash("sha256").update(token).digest("hex"),
        openclaw: createHash("sha256").update(randomBytes(32)).digest("hex"),
      },
      turns,
      onObservation: (observation) => observations.push(observation),
    });
    t.after(() => upstream.close());
    const statuses: number[] = [];
    const adapterFailures: unknown[] = [];
    // This HTTP adapter tests the proof helper, not the installed Gateway. It
    // forwards a previously known bearer to the real controlled origin, but
    // never redeems a grant. Only the installed case reads actual OCC records.
    const adapter = createServer(async (request, response) => {
      try {
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, `Bearer ${gatewayPassword}`);
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await fetch(`${upstream.origin}/v1/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "fixture-model", stream: true, input: body.messages }),
          signal: t.signal,
        });
        statuses.push(result.status);
        assert.equal(result.status, 200);
        const completed = (await result.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)))
          .find((event) => event.type === "response.completed");
        const content = completed.response.output[0].content[0].text;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      } catch (error) {
        adapterFailures.push(error);
        response.writeHead(500);
        response.end();
      }
    });
    adapter.listen(0, "127.0.0.1");
    await once(adapter, "listening");
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          adapter.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = adapter.address();
    assert.ok(address && typeof address !== "string");
    for (const [index, scenario] of scenarios.entries()) {
      const turn = turns[index]!;
      let reads = 0;
      const run = (): ReturnType<typeof assertOpenShellModelTurn> =>
        assertOpenShellModelTurn({
          gatewayUrl: `http://127.0.0.1:${address.port}`,
          gatewayPassword,
          sessionKey: `proof-${randomUUID()}`,
          turn,
          readOriginTurn: async (id) =>
            observations.find(
              (observation): observation is Extract<ModelOriginObservation, { kind: "turn" }> =>
                observation.kind === "turn" && observation.turnId === id,
            ),
          grantEvidence: {
            expected,
            readApprovals: async () => (reads++ === 0 ? scenario.before : scenario.after),
          },
          forbiddenCredentials: [token],
          signal: t.signal,
        });
      if (scenario.accepted) {
        const receipt = await run();
        assert.deepEqual(receipt.grant, {
          providerId: expected.providerId,
          sandboxId: expected.sandboxId,
          bindingId: expected.bindingId,
          requestId: approval.requestId,
          assertionConsumed: true,
        });
      } else {
        await assert.rejects(run, /fresh matching consumed Gateway assertion/u, scenario.name);
      }
      assert.equal(reads, 2);
      assert.equal(statuses[index], 200, "the correct upstream bearer really succeeded");
      assert.ok(
        observations.some(
          (observation) => observation.kind === "turn" && observation.turnId === turn.id,
        ),
      );
    }
    assert.deepEqual(adapterFailures, []);
  },
);
