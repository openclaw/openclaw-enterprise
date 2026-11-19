import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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

type Actor = "human" | "service";
type Outcome = {
  completedSseResponses: number;
  sseObservations: string[];
  sseFailure?: unknown;
};

async function startReceiptLoopback(
  t: TestContext,
  respond: (response: ServerResponse, actor: Actor, planted: string) => void | Promise<void>,
  failCleanup = false,
) {
  const { verifyQaHttpChat } = await import("../helpers/qa-http-chat.ts");
  const planted = "qa-loopback-only-" + randomUUID();
  const requests: Actor[] = [];
  const serialized: string[] = [];
  const finalizers: string[] = [];
  let keyCount = 0;
  let outcomes: string | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === "/api/auth/sign-in/email") {
      request.resume();
      response.setHeader("Set-Cookie", "qa_session=" + planted + "; Path=/");
      response.end("{}");
      return;
    }
    assert.equal(request.url, "/agents/agt-loopback/chat");
    if (request.headers["content-length"] === "100") {
      // The fixture holds this deliberately incomplete request open until the Controller responds.
      request.once("data", () => {
        response.writeHead(408).end();
      });
      return;
    }
    const bytes: Buffer[] = await request.toArray();
    const body: { stream: boolean } = JSON.parse(Buffer.concat(bytes).toString());
    if (request.headers["x-api-key"] === planted + "-reader") {
      response.writeHead(403).end();
    } else if (body.stream) {
      const actor = request.headers.cookie === undefined ? "service" : "human";
      requests.push(actor);
      await respond(response, actor, planted);
    } else if (requests.length === 2) {
      // Stop at the first conversation request after proving both successful SSE attempts.
      response.writeHead(418).end();
    } else {
      response.end(
        JSON.stringify({
          object: "chat.completion",
          choices: [{ message: { content: "DONE" } }],
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  // These fixture inputs stand in for installation setup. The actual verifier sends
  // HTTP to the loopback server and invokes its normal outcome and disposal callbacks.
  const fixture = {
    apiUrl: "http://127.0.0.1:" + address.port,
    consoleUrl: "https://console.example.test",
    credentials: { email: "qa@example.test", password: planted },
    controlPlane: "compose",
    configuration: {
      drivers: { compute: { configuration: { gatewayRouting: { hostname: "qa.example.test" } } } },
    },
    env: {},
    async api(method: string, path: string) {
      if (method === "DELETE") {
        finalizers.push("disposed " + path.split("/").at(-1));
        if (failCleanup && finalizers.length === 2) {
          throw new Error("synthetic cleanup failure");
        }
        return;
      }
      if (method === "GET" && path.includes("/runtime/logs?")) {
        return { records: [{ message: planted }] };
      }
      assert.equal(method, "POST");
      if (path === "/api/auth/service-keys") {
        keyCount += 1;
        return { id: "key-" + keyCount, key: keyCount === 1 ? planted : planted + "-reader" };
      }
      return { id: "qa-loopback-iam" };
    },
    async pod(_agent: unknown, role: string) {
      return {
        metadata: { uid: "pod", namespace: "qa-loopback", name: "gateway" },
        spec: {
          containers: [
            {
              name: role,
              image: "example.test/runtime@sha256:" + "a".repeat(64),
              ports: [{ name: "http", containerPort: 8080 }],
              volumeMounts: [{ mountPath: "/home/node/.openclaw/workspace" }],
            },
          ],
        },
        status: { containerStatuses: [{ name: role, containerID: "fixture-container" }] },
      };
    },
    async compose() {
      return "[404,404,404,404,404]";
    },
    async execRole() {
      return { stdout: "[401,401,401]" };
    },
    async apply() {},
    async waitFor() {
      return { status: { phase: "Succeeded" } };
    },
    async kubectl(...args: string[]) {
      if (args[2] === "logs") {
        return "BLOCKED";
      }
      return args.at(-3) === "readback" ? "match" : "";
    },
    async record(name: string, value: unknown) {
      const json = JSON.stringify(value, null, 2);
      serialized.push(json);
      if (name.endsWith("-outcomes")) {
        outcomes = json;
        finalizers.push("recorded outcomes");
      }
    },
  };
  const agent = {
    id: "agt-loopback",
    preset: "OpenClaw",
    namespaceId: "ns-loopback",
    revision: { id: "rev-loopback" },
  } as Parameters<typeof verifyQaHttpChat>[1];
  return {
    requests,
    verification: verifyQaHttpChat(
      fixture as unknown as Parameters<typeof verifyQaHttpChat>[0],
      agent,
    ),
    outcome(): Outcome {
      assert.deepEqual(finalizers, ["recorded outcomes", "disposed key-1", "disposed key-2"]);
      assert.ok(outcomes, "the verifier must record its outcome before disposing keys");
      assert.ok(
        serialized.every((json) => !json.includes(planted)),
        "serialized evidence must hide the planted value",
      );
      return JSON.parse(outcomes);
    },
  };
}

const doneFrame = "data: [DONE]\n\n";

async function sendIncremental(response: ServerResponse) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(completionFrame("40"));
  // Keep the connection open for the real HTTP client before releasing the terminator.
  await delay(200);
  response.end(doneFrame);
}

export function registerQaHttpChatStreamCases() {
  test("QA HTTP chat records the first failed SSE check in the serialized fixture outcome", async (t) => {
    const controls: {
      name: string;
      respond: Parameters<typeof startReceiptLoopback>[1];
      primary: RegExp | ((error: unknown) => boolean);
      stage: string;
      reason: string;
      statusClass: string;
      failCleanup?: boolean;
    }[] = [
      {
        name: "wrong media despite valid frames and simultaneous cleanup failure",
        respond(response, _actor, planted) {
          response.writeHead(200, { "Content-Type": "application/json", "X-Fixture": planted });
          response.end(completionFrame("40") + doneFrame);
        },
        primary: /must have a valid text\/event-stream Content-Type/,
        stage: "response",
        reason: "media-type",
        statusClass: "2xx",
        failCleanup: true,
      },
      {
        name: "non-success HTTP response",
        respond(response) {
          response.writeHead(429).end("synthetic rate limit");
        },
        primary: /429 !== 200/,
        stage: "response",
        reason: "http-status",
        statusClass: "4xx",
      },
      {
        name: "request transport before HTTP headers",
        respond(response) {
          response.destroy();
        },
        primary: (error) => error instanceof Error && Reflect.get(error, "code") === "ECONNRESET",
        stage: "request",
        reason: "request-transport",
        statusClass: "unavailable",
      },
      {
        name: "body transport after HTTP headers",
        respond(response) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Content-Length": 1024,
            Connection: "close",
          });
          response.end(completionFrame("40"));
        },
        primary: (error) => error instanceof Error && Reflect.get(error, "code") === "ECONNRESET",
        stage: "body",
        reason: "body-transport",
        statusClass: "2xx",
      },
      {
        name: "incomplete UTF-8 at EOF",
        respond(response) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(Buffer.from([0xc3]));
        },
        primary: (error) =>
          error instanceof TypeError &&
          Reflect.get(error, "code") === "ERR_ENCODING_INVALID_ENCODED_DATA",
        stage: "body",
        reason: "body-decode",
        statusClass: "2xx",
      },
      {
        name: "response limit",
        respond(response) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(Buffer.alloc(1024 * 1024 + 1, 97));
        },
        primary: /proof response exceeded 1 MiB/,
        stage: "body",
        reason: "response-limit",
        statusClass: "2xx",
      },
      {
        name: "clean framing without DONE",
        respond(response) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(completionFrame("40"));
        },
        primary: /must end with a complete \[DONE\] frame/,
        stage: "verification",
        reason: "missing-done",
        statusClass: "2xx",
      },
      {
        name: "invalid choice with DONE",
        respond(response, _actor, planted) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(completionFrame(planted, "\n\n", 1) + doneFrame);
        },
        primary: /must contain complete, valid events/,
        stage: "verification",
        reason: "invalid-choice",
        statusClass: "2xx",
      },
      {
        name: "application error retains priority over invalid choice",
        respond(response, _actor, planted) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            completionFrame("40", "\n\n", 1) +
              "data: " +
              JSON.stringify({ error: { message: planted } }) +
              "\n\n" +
              doneFrame,
          );
        },
        primary: /must not report an application error/,
        stage: "verification",
        reason: "application-error",
        statusClass: "2xx",
      },
    ];
    for (const control of controls) {
      await t.test(control.name, async (context) => {
        const loopback = await startReceiptLoopback(context, control.respond, control.failCleanup);
        await assert.rejects(loopback.verification, control.primary);
        assert.deepEqual(loopback.requests, ["human"]);
        const outcome = loopback.outcome();
        assert.equal(outcome.completedSseResponses, 0);
        assert.deepEqual(outcome.sseObservations, ["failed"]);
        assert.deepEqual(outcome.sseFailure, {
          actor: "human",
          stage: control.stage,
          reason: control.reason,
          statusClass: control.statusClass,
        });
      });
    }
  });

  test("QA HTTP chat records a service failure after a valid incremental human response", async (t) => {
    const loopback = await startReceiptLoopback(t, async (response, actor) => {
      if (actor === "human") {
        await sendIncremental(response);
      } else {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(completionFrame("40"));
      }
    });
    await assert.rejects(loopback.verification, /must end with a complete \[DONE\] frame/);
    assert.deepEqual(loopback.requests, ["human", "service"]);
    const outcome = loopback.outcome();
    assert.equal(outcome.completedSseResponses, 1);
    assert.deepEqual(outcome.sseObservations, ["incremental", "failed"]);
    assert.deepEqual(outcome.sseFailure, {
      actor: "service",
      stage: "verification",
      reason: "missing-done",
      statusClass: "2xx",
    });
  });

  test("QA HTTP chat completes both incremental responses without a failure receipt", async (t) => {
    const loopback = await startReceiptLoopback(t, sendIncremental);
    await assert.rejects(loopback.verification, /native completion must succeed/);
    assert.deepEqual(loopback.requests, ["human", "service"]);
    const outcome = loopback.outcome();
    assert.equal(outcome.completedSseResponses, 2);
    assert.deepEqual(outcome.sseObservations, ["incremental", "incremental"]);
    assert.equal(Object.hasOwn(outcome, "sseFailure"), false);
  });

  test("QA HTTP chat preserves valid coalesced delivery as unmeasured", async (t) => {
    const loopback = await startReceiptLoopback(t, (response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(completionFrame("40") + doneFrame);
    });
    await assert.rejects(
      loopback.verification,
      /complete chunk before the terminal read while HTTP is open/,
    );
    assert.deepEqual(loopback.requests, ["human"]);
    const outcome = loopback.outcome();
    assert.equal(outcome.completedSseResponses, 0);
    assert.deepEqual(outcome.sseObservations, ["unmeasured"]);
    assert.equal(Object.hasOwn(outcome, "sseFailure"), false);
  });

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
