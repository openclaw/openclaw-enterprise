import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get, type IncomingMessage } from "node:http";
import test, { type TestContext } from "node:test";

function completionFrame(content: string, end = "\n\n", index?: number) {
  return `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index, delta: { content } }] })}${end}`;
}

async function observeLoopback(
  t: TestContext,
  fragments: Buffer[],
  {
    splitAfterCompletion,
    contentTypes = ["text/event-stream"],
  }: { splitAfterCompletion?: number; contentTypes?: string[] } = {},
) {
  const { readQaHttpChatSse } = await import("../helpers/qa-http-chat.ts");
  let releaseNext: (() => void) | undefined;
  let sent = 0;
  const server = createServer((_request, response) => {
    releaseNext = () => {
      const part = fragments[sent++];
      assert.ok(part);
      if (sent === fragments.length) {
        response.end(part);
      } else {
        response.write(part);
      }
    };
    response.writeHead(
      200,
      contentTypes.flatMap((value) => ["Content-Type", value]),
    );
    releaseNext();
  });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(5_000) }, resolve).once(
      "error",
      reject,
    );
  });
  return readQaHttpChatSse({
    headersDistinct: response.headersDistinct,
    get complete() {
      return response.complete;
    },
    async *[Symbol.asyncIterator]() {
      if (splitAfterCompletion !== undefined) {
        const chunks: Buffer[] = await response.toArray();
        const buffered = Buffer.concat(chunks);
        assert.equal(response.complete, true);
        yield buffered.subarray(0, splitAfterCompletion);
        yield buffered.subarray(splitAfterCompletion);
        return;
      }
      let consumed = 0;
      for await (const bytes of response as AsyncIterable<Buffer>) {
        yield bytes;
        consumed += bytes.length;
        // Requesting the next read acknowledges consumption while terminal bytes and EOF are held.
        if (sent < fragments.length && consumed === fragments[sent - 1]?.length) {
          assert.ok(releaseNext);
          consumed = 0;
          releaseNext();
        }
      }
    },
  });
}

export function registerQaHttpChatStreamCases() {
  test("QA HTTP chat observes a complete CRLF event before DONE at the same clock tick", async (t) => {
    t.mock.method(Date, "now", () => 1_000_000);
    const body = Buffer.from(completionFrame("café 40", "\r\n\r\n"));
    const split = body.indexOf(Buffer.from("é")) + 1;
    const result = await observeLoopback(t, [
      body.subarray(0, split),
      body.subarray(split, body.length - 1),
      body.subarray(body.length - 1),
      Buffer.from("data: [DONE]\r\n\r\n"),
    ]);
    assert.equal(result.answer, "café 40");
    assert.equal(result.malformed, false);
    assert.equal(result.done, true);
    assert.equal(result.incremental, true);
  });

  test("QA HTTP chat requires a complete event ahead of the terminal read", async (t) => {
    const chunk = completionFrame("40");
    const done = "data: [DONE]\n\n";
    for (const [name, reads] of [
      ["buffered", [chunk + done]],
      ["partial first event", [chunk.slice(0, -1), chunk.slice(-1) + done]],
      ["comment and empty event", [": keep-alive\n\ndata:\n\n", chunk + done]],
    ] as const) {
      await t.test(name, async (control) => {
        const result = await observeLoopback(
          control,
          reads.map((part) => Buffer.from(part)),
        );
        assert.equal(result.answer, "40");
        assert.equal(result.malformed, false);
        assert.equal(result.done, true);
        assert.equal(result.incremental, false);
      });
    }
  });

  test("QA HTTP chat leaves a completed HTTP response unmeasured across multiple reads", async (t) => {
    const chunk = completionFrame("40");
    const result = await observeLoopback(t, [Buffer.from(chunk + "data: [DONE]\n\n")], {
      splitAfterCompletion: chunk.length,
    });
    assert.equal(result.answer, "40");
    assert.equal(result.malformed, false);
    assert.equal(result.done, true);
    assert.equal(result.incremental, false);
  });

  test("QA HTTP chat keeps the final answer within one choice", async (t) => {
    const first = completionFrame("4", "\n\n", 0);
    const second = completionFrame("0", "\n\n", 0);
    const done = "data: [DONE]\n\n";
    const valid = await observeLoopback(t, [
      Buffer.from(first),
      Buffer.from(second),
      Buffer.from(done),
    ]);
    assert.equal(valid.answer, "40");
    assert.equal(valid.malformed, false);
    assert.equal(valid.done, true);
    assert.equal(valid.incremental, true);

    const mixed = `data: ${JSON.stringify({
      object: "chat.completion.chunk",
      choices: [
        { index: 0, delta: { content: "4" } },
        { index: 1, delta: { content: "0" } },
      ],
    })}\n\n`;
    for (const [name, chunks, answer] of [
      ["same event", [mixed, done], ""],
      ["different events", [first, completionFrame("0", "\n\n", 1), done], "4"],
    ] as const) {
      await t.test(name, async (control) => {
        const result = await observeLoopback(
          control,
          chunks.map((part) => Buffer.from(part)),
        );
        assert.equal(result.malformed, true);
        assert.equal(result.answer, answer);
      });
    }
  });

  test("QA HTTP chat requires one valid text/event-stream Content-Type", async (t) => {
    const fragments = [Buffer.from(completionFrame("40")), Buffer.from("data: [DONE]\n\n")];
    const valid = await observeLoopback(t, fragments, {
      contentTypes: ['Text/Event-Stream ; Charset="utf-8"; example="comma, semicolon;"'],
    });
    assert.equal(valid.answer, "40");
    assert.equal(valid.malformed, false);
    assert.equal(valid.done, true);
    assert.equal(valid.incremental, true);

    for (const [name, contentTypes] of [
      ["JSON", ["application/json"]],
      ["absent", []],
      ["duplicate", ["text/event-stream", "application/json"]],
      ["combined", ["text/event-stream; charset=utf-8, application/json"]],
      ["malformed parameter", ['text/event-stream; charset="utf-8']],
    ] satisfies [string, string[]][]) {
      await t.test(name, async (control) => {
        await assert.rejects(
          observeLoopback(control, fragments, { contentTypes }),
          /must have a valid text\/event-stream Content-Type/,
        );
      });
    }
  });

  test("QA HTTP chat checks terminal framing and structured application errors", async (t) => {
    const chunk = completionFrame("40");
    const done = "data: [DONE]\n\n";
    for (const [name, tail, terminated] of [
      ["incomplete terminal frame", "data: [DONE]\n", false],
      ["garbage after terminal frame", done + "garbage\n\n", true],
      ["malformed payload before terminal frame", "data:{broken\n\n" + done, true],
    ] as const) {
      await t.test(name, async (control) => {
        const result = await observeLoopback(control, [Buffer.from(chunk), Buffer.from(tail)]);
        assert.equal(result.malformed, true);
        assert.equal(result.done, terminated);
      });
    }
    const result = await observeLoopback(t, [
      Buffer.from('data: {"error":{"message":"synthetic error"}}\n\n'),
      Buffer.from(chunk + done),
    ]);
    assert.deepEqual(result.nativeErrors, ["synthetic error"]);
    assert.equal(result.applicationError, true);
    assert.equal(result.incremental, false);
  });
}
