import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import { message } from "../../apps/controller/src/console/agents/list.mts";
import {
  createApiClient,
  responseFields,
  type RequestOptions,
} from "../../apps/controller/src/console/api-client.mts";
import { createViewLifetime } from "../../apps/controller/src/console/view-lifetime.mts";
import { listen } from "../helpers/listen.mjs";

async function namespaceUrl(t: TestContext, server: Server) {
  const port: unknown = await listen(t, server);
  assert.ok(typeof port === "number");
  return `http://127.0.0.1:${port}/namespaces`;
}

async function interruptedResponse(
  t: TestContext,
  interrupt: (response: ServerResponse, controller: AbortController) => void,
  responseType: RequestOptions["responseType"] = "json",
) {
  const controller = new AbortController();
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    // Deliver headers and part of a body over a real socket before interrupting
    // consumption. This does not simulate a successful OCC operation.
    response.writeHead(200, {
      "content-type": responseType === "text" ? "text/plain" : "application/json",
      "content-length": 1000,
    });
    response.write('{"data":');
    const timer = setTimeout(() => interrupt(response, controller), 100);
    response.on("close", () => clearTimeout(timer));
  });
  const url = await namespaceUrl(t, server);
  const request = createApiClient({
    lifetime: createViewLifetime(),
    hasSession: () => true,
    onExpired() {},
  });
  return {
    result: request(url, {
      signal: controller.signal,
      responseType,
    }),
    calls: () => calls,
  };
}

test("a timed-out text download remains an interrupted read instead of a view cancellation", async (t) => {
  const { result } = await interruptedResponse(
    t,
    (_response, controller) => controller.abort(new DOMException("Deadline", "TimeoutError")),
    "text",
  );
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "TimeoutError");
    assert.equal(
      message(error),
      "Request interrupted. Retry to check current access and saved state.",
    );
    return true;
  });
});

for (const { name, status = 200, contentType, body, expectedStatus, succeeds = false } of [
  { name: "plain text", contentType: "text/plain", body: "synthetic log\n", succeeds: true },
  {
    name: "parameterized mixed-case plain text",
    contentType: "Text/Plain; Charset=UTF-8",
    body: "synthetic log\n",
    expectedStatus: 200,
    succeeds: true,
  },
  { name: "JSON string data", contentType: "application/json", body: '{"data":"not a log"}' },
  { name: "near-match media type", contentType: "text/plainish", body: "not a log" },
  {
    name: "nonmatching expected status",
    contentType: "text/plain",
    body: "synthetic log\n",
    expectedStatus: 201,
  },
  {
    name: "non-200 plain text",
    status: 201,
    contentType: "text/plain",
    body: "synthetic log\n",
  },
]) {
  test(`text downloads enforce the attachment response boundary: ${name}`, async (t) => {
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(body, { status, headers: { "content-type": contentType } }),
    );
    const request = createApiClient({
      lifetime: createViewLifetime(),
      hasSession: () => true,
      onExpired() {},
    });
    const result = request("/logs?download=true", {
      responseType: "text",
      ...(expectedStatus === undefined ? {} : { expectedStatus }),
    });
    if (succeeds) {
      assert.equal(await result, body);
    } else {
      await assert.rejects(result, { status, message: "The request could not be completed." });
    }
    assert.equal(fetch.mock.callCount(), 1);
  });
}

for (const status of [403, 401]) {
  test(`text downloads retain JSON error metadata and session expiry for ${status}`, async (t) => {
    const code = status === 401 ? "UNAUTHORIZED" : "FORBIDDEN";
    const details = [{ path: "/source", code: "DENIED", message: "Synthetic denial" }];
    const requestId = "req_12345678-1234-1234-1234-123456789abc";
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: { code, message: "Synthetic request refusal", details },
            meta: { requestId },
          }),
          { status, headers: { "content-type": "application/json", "retry-after": "3" } },
        ),
    );
    let expired = 0;
    const request = createApiClient({
      lifetime: createViewLifetime(),
      hasSession: () => true,
      onExpired() {
        expired += 1;
      },
    });
    await assert.rejects(request("/logs?download=true", { responseType: "text" }), (error) => {
      const fields = responseFields(error);
      assert.equal(fields.status, status);
      assert.equal(fields.code, code);
      assert.equal(fields.serverMessage, "Synthetic request refusal");
      assert.deepEqual(fields.details, details);
      assert.deepEqual(fields.detailPaths, ["/source"]);
      assert.equal(fields.requestId, requestId);
      assert.equal(fields.retryAfterSeconds, 3);
      return true;
    });
    assert.equal(expired, status === 401 ? 1 : 0);
  });
}

test("a complete malformed JSON body retains the invalid-response error", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not JSON");
  });
  const url = await namespaceUrl(t, server);
  const request = createApiClient({
    lifetime: createViewLifetime(),
    hasSession: () => true,
    onExpired() {},
  });
  await assert.rejects(request(url), {
    name: "Error",
    status: 200,
    message: "The request could not be completed.",
  });
});

test("a disconnected JSON body reaches the caller's interrupted-read recovery", async (t) => {
  const { result, calls } = await interruptedResponse(t, (response) => response.destroy());
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "TypeError");
    assert.equal(
      message(error),
      "Request interrupted. Retry to check current access and saved state.",
    );
    assert.equal(
      message(error, true),
      "We couldn't confirm the result of your request. Refresh the page and check before submitting it again.",
    );
    return true;
  });
  assert.equal(calls(), 1, "A body failure must not replay the request");
});

for (const name of ["AbortError", "TimeoutError"]) {
  test(`an interrupted JSON body preserves ${name} for the Console caller`, async (t) => {
    const { result, calls } = await interruptedResponse(t, (_response, controller) => {
      controller.abort(new DOMException("Request interrupted", name));
    });
    await assert.rejects(result, { name });
    assert.equal(calls(), 1);
  });
}

test("empty 204 responses honor an explicit expected status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  const lifetime = {
    signal: new AbortController().signal,
    capture: () => 1,
    isCurrent: () => true,
  };
  const request = createApiClient({ lifetime, hasSession: () => true, onExpired() {} });

  assert.equal(await request("/resource", { expectedStatus: 204 }), undefined);
  assert.equal(
    await request("/resource", { responseType: "text", expectedStatus: 204 }),
    undefined,
  );
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    await assert.rejects(request("/resource", { method }), { status: 204 });
  }
  await assert.rejects(request("/resource", { expectedStatus: 200 }), { status: 204 });
});

test("sharing mutations reject unexpected success statuses without replay", async (t) => {
  let response: Response;
  const fetch = t.mock.method(globalThis, "fetch", async () => response);
  const lifetime = {
    signal: new AbortController().signal,
    capture: () => 1,
    isCurrent: () => true,
  };
  const request = createApiClient({ lifetime, hasSession: () => true, onExpired() {} });
  const cases = [
    { method: "POST", expectedStatus: 201, actualStatus: 200 },
    { method: "POST", expectedStatus: 201, actualStatus: 204 },
    { method: "DELETE", expectedStatus: 204, actualStatus: 200 },
  ];
  for (const { method, expectedStatus, actualStatus } of cases) {
    response = new Response(actualStatus === 204 ? null : JSON.stringify({ data: {} }), {
      status: actualStatus,
    });
    const calls = fetch.mock.callCount();
    await assert.rejects(request("/resource", { method, expectedStatus }), {
      status: actualStatus,
    });
    assert.equal(
      fetch.mock.callCount(),
      calls + 1,
      "An unexpected outcome must not replay a write",
    );
  }

  response = new Response(JSON.stringify({ data: { id: "binding-confirmed" } }), { status: 201 });
  assert.deepEqual(await request("/resource", { method: "POST", expectedStatus: 201 }), {
    id: "binding-confirmed",
  });
  response = new Response(null, { status: 204 });
  assert.equal(await request("/resource", { method: "DELETE", expectedStatus: 204 }), undefined);
});

test("a lost sharing response remains an error and never retries the write", async (t) => {
  const lostResponse = new TypeError("Connection closed before the response arrived");
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw lostResponse;
  });
  const lifetime = {
    signal: new AbortController().signal,
    capture: () => 1,
    isCurrent: () => true,
  };
  const request = createApiClient({ lifetime, hasSession: () => true, onExpired() {} });
  await assert.rejects(request("/resource", { method: "POST", expectedStatus: 201 }), (error) => {
    assert.equal(error, lostResponse);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("only a read that outlives the view survives the view's reset", async (t) => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (_path: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  });
  const lifetime = createViewLifetime();
  const request = createApiClient({ lifetime, hasSession: () => true, onExpired() {} });
  await request("/view");
  await request("/session", { outlivesView: true });
  lifetime.reset();
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true, false],
  );
});
