import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";
import { waitForControllerSignIn } from "../helpers/postgres-platform-state.ts";
import { within } from "../helpers/wait-for.mjs";

const runningChild = { exitCode: null, signalCode: null };
const childOutput = "fixture controller is starting";
const readOutput = () => childOutput;

async function listen(context: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

test("PostgreSQL controller readiness cancels a stalled sign-in body and reports timeout after a backward clock step", async (context) => {
  const timeoutMs = 2_400;
  const firstResponseDelayMs = 1_200;
  // Allow for timer and socket scheduling while still ruling out a fresh deadline on retry.
  const observationMs = timeoutMs + 700;
  const requests: string[] = [];
  const now = Date.now;
  let clockOffsetMs = 0;
  let partialBodySentAt = 0;
  let peerClosedAt = 0;
  let readinessReported = false;
  const peerClosed = Promise.withResolvers<void>();
  context.mock.method(Date, "now", () => now() - clockOffsetMs);

  const { origin, server } = await listen(context, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (requests.length === 1) {
      setTimeout(() => {
        response.writeHead(503).end("controller starting");
      }, firstResponseDelayMs);
      return;
    }

    request.socket.once("close", () => {
      peerClosedAt = performance.now();
      peerClosed.resolve();
    });
    // Send the headers and part of the declared body without ending the response.
    response.writeHead(200, { "content-length": 100 });
    response.write("{");
    // Move the wall clock back past the observation window after the retry begins.
    clockOffsetMs = observationMs + 1_000;
    partialBodySentAt = performance.now();
  });

  const startedAt = performance.now();
  const readiness = assert
    .rejects(waitForControllerSignIn(origin, runningChild, readOutput, timeoutMs), {
      code: "ERR_ASSERTION",
      message: /fixture controller is starting\nLast sign-in attempt: no HTTP response/,
    })
    .then(() => {
      readinessReported = true;
    });
  try {
    await within(
      Promise.all([readiness, peerClosed.promise]),
      () =>
        `readiness failure and peer socket closure (requests: ${requests.length}, partial body sent: ${partialBodySentAt > 0}, peer closed: ${peerClosedAt > 0}, readiness reported: ${readinessReported})`,
      observationMs,
    );
  } finally {
    // Let a wall-clock poll terminate even when the assertion above fails.
    clockOffsetMs = 0;
    server.closeAllConnections();
    await within(Promise.allSettled([readiness]), "readiness cleanup", 1_000);
  }

  assert.deepEqual(requests, Array(2).fill("POST /api/auth/sign-in/email"));
  assert.ok(partialBodySentAt - startedAt >= firstResponseDelayMs - 50);
  assert.ok(peerClosedAt - startedAt >= timeoutMs - 50, "the peer closed before the deadline");
  assert.ok(peerClosedAt - startedAt <= observationMs, "the peer closed after the shared deadline");
});

test(
  "PostgreSQL controller readiness reports a completed 503 and child output at timeout",
  { timeout: 3_100 },
  async (context) => {
    const timeoutMs = 2_400;
    let attempts = 0;
    const { origin } = await listen(context, (_request, response) => {
      attempts += 1;
      response.writeHead(503).end("controller starting");
    });

    const advanceDeadline = () => context.mock.timers.tick(timeoutMs);
    // Use a real fallback so the readiness call ends even if the response never arrives.
    const fallback = setTimeout(advanceDeadline, timeoutMs);
    const clearFallback = clearTimeout;
    context.after(() => clearFallback(fallback));
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const readText = Response.prototype.text;
    context.mock.method(Response.prototype, "text", async function (this: Response) {
      const text = await readText.call(this);
      // Expire the budget after the client receives the complete 503.
      clearFallback(fallback);
      setImmediate(advanceDeadline);
      return text;
    });

    await assert.rejects(waitForControllerSignIn(origin, runningChild, readOutput, timeoutMs), {
      code: "ERR_ASSERTION",
      message: /fixture controller is starting\nLast sign-in attempt: HTTP 503/,
    });
    assert.equal(attempts, 1);
  },
);

test("PostgreSQL controller readiness reports an early child signal with output", async (context) => {
  let attempts = 0;
  const { origin } = await listen(context, (_request, response) => {
    attempts += 1;
    response.writeHead(503).end("controller starting");
  });
  await assert.rejects(
    waitForControllerSignIn(origin, { exitCode: null, signalCode: "SIGTERM" }, readOutput, 2_400),
    {
      code: "ERR_ASSERTION",
      message: /The durable OCC subprocess exited early:\nfixture controller is starting/,
    },
  );
  assert.equal(attempts, 0);
});

test("PostgreSQL controller readiness accepts a sign-in cookie after a 503", async (context) => {
  let attempts = 0;
  const { origin } = await listen(context, (_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503).end("controller starting");
      return;
    }
    response.writeHead(200, { "set-cookie": "fixture-session=ready; Path=/; HttpOnly" }).end("{}");
  });

  const session = await waitForControllerSignIn(origin, runningChild, readOutput, 2_400);
  assert.equal(attempts, 2);
  assert.equal(session.response.status, 200);
  assert.equal(session.cookie, "fixture-session=ready");
});
