import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import type nodeTest from "node:test";
import type { TestContext } from "node:test";

import {
  liveNativeRequest,
  rawNativeRequest,
  waitForNativeIntegrity,
  type NativeHttpResponse,
  type NativeHttpTarget,
} from "./native-admin-http-integrity-transport.ts";

interface ParsedNativeRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

interface NativeWireCapture {
  chunks: Buffer[];
  bytes: number;
  overflow: boolean;
}

export interface NativeAdminStream {
  closed: boolean;
  finished: boolean;
  writes: number;
  close: Promise<{ finished: boolean; writes: number }>;
  reset(): void;
}

// The shared HTTPS peer records arrivals before decoding the body and retains
// the decrypted wire independently of Node's HTTP parser.
export interface NativeAdminHttpObservations {
  requests: (ParsedNativeRequest & { body: string })[];
  parsedRequests: ParsedNativeRequest[];
  wire: NativeWireCapture[];
  streams: Map<string, NativeAdminStream>;
  parserErrors: { code: string | undefined }[];
}

interface NativeAdminHttpFixture extends NativeHttpTarget {
  upstream: NativeAdminHttpObservations;
  namespaceId: string;
  agentId: string;
  nativeOrigin: string;
  nativeGatewayApiKey: string;
  createReadOnlySession(label: string): Promise<{ cookie: string }>;
}

export type CreateNativeAdminHttpFixture = (
  t: TestContext,
  options?: { upstream: { captureWire: boolean } },
) => Promise<NativeAdminHttpFixture>;

function nativeIntegrityDiagnostic(
  t: TestContext,
  findingId: string,
  observedBehavior: object,
  positiveControls: object,
): void {
  t.diagnostic(
    "NATIVE_HTTP_INTEGRITY " + JSON.stringify({ findingId, observedBehavior, positiveControls }),
  );
}

function findWireCapture(wire: readonly NativeWireCapture[], requestLine: string) {
  return wire.find((capture) =>
    Buffer.concat(capture.chunks).toString("latin1").includes(requestLine),
  );
}

function readWireFrame(capture: NativeWireCapture, requestLine: string) {
  assert.equal(capture.overflow, false);
  const wire = Buffer.concat(capture.chunks).toString("latin1");
  const start = wire.indexOf(requestLine);
  const headerEnd = wire.indexOf("\r\n\r\n", start);
  assert.ok(headerEnd > start);
  return {
    frameHeaders: wire.slice(start, headerEnd),
    wireBody: wire.slice(headerEnd + 4),
    requestWire: wire.slice(start),
  };
}

function resetProducer(upstream: NativeAdminHttpObservations, name: string): void {
  const producer = upstream.streams.get(name);
  assert.ok(producer, `the HTTPS peer must start the ${name} producer`);
  producer.reset();
}

function streamResult(result: NativeHttpResponse) {
  return {
    statusCode: result.statusCode,
    body: result.body,
    complete: result.complete,
    ended: result.ended,
    aborted: result.aborted,
    error: result.error,
  };
}

export function registerNativeAdminHttpIntegrityCases(
  test: typeof nodeTest,
  createFixture: CreateNativeAdminHttpFixture,
): void {
  test("native HTTP framing preserves bodyless requests and nominated lengths", async (t) => {
    const context = await createFixture(t, { upstream: { captureWire: true } });
    const targetPrefix = "/namespaces/" + context.namespaceId + "/agents/" + context.agentId;
    const bodyless: { method: string; parsedRequests: number; body: string }[] = [];
    for (const method of ["GET", "HEAD"]) {
      const path = "/integrity-bodyless-" + method.toLowerCase();
      const expectedTarget = targetPrefix + path;
      const beforeParsed = context.upstream.parsedRequests.length;
      // Send no body framing on the genuine incoming wire. Ordinary page and asset
      // requests must retain that shape after the controller admits the Agent host.
      const downstream = await rawNativeRequest(context, method, path, {});
      assert.match(downstream, /^HTTP\/1\.1 200 /);
      const parsed = context.upstream.parsedRequests.slice(beforeParsed);
      const observed = context.upstream.requests.filter((r) => r.url === expectedTarget);
      assert.equal(parsed.length, 1);
      const [parsedRequest] = parsed;
      assert.ok(parsedRequest);
      assert.equal(parsedRequest.method, method);
      assert.equal(parsedRequest.url, expectedTarget);
      assert.equal(observed.length, 1);
      const [observedRequest] = observed;
      assert.ok(observedRequest);
      assert.equal(observedRequest.body, "");
      const requestLine = method + " " + expectedTarget + " HTTP/1.1\r\n";
      const capture = findWireCapture(context.upstream.wire, requestLine);
      assert.ok(capture, "the real HTTPS wire must contain the bodyless request");
      const { frameHeaders } = readWireFrame(capture, requestLine);
      assert.doesNotMatch(frameHeaders, /\r\n(?:content-length|transfer-encoding):/i);
      assert.equal(parsedRequest.headers["content-length"], undefined);
      assert.equal(parsedRequest.headers["transfer-encoding"], undefined);
      bodyless.push({ method, parsedRequests: parsed.length, body: observedRequest.body });
    }

    // Connection can remove Content-Length from the sanitized header map even
    // though Node's incoming parser still delivers the length-delimited body.
    const marker = "native-connection-nominated-length-body";
    const path = "/integrity-nominated-content-length";
    const expectedTarget = targetPrefix + path;
    const beforeParsed = context.upstream.parsedRequests.length;
    const downstream = await rawNativeRequest(
      context,
      "GET",
      path,
      {
        connection: "close, Content-Length",
        "content-length": String(Buffer.byteLength(marker)),
      },
      marker,
    );
    assert.match(downstream, /^HTTP\/1\.1 200 /);
    const parsed = context.upstream.parsedRequests.slice(beforeParsed);
    const observed = context.upstream.requests.filter((r) => r.url === expectedTarget);
    assert.equal(parsed.length, 1, "one browser request must produce one upstream request");
    const [parsedRequest] = parsed;
    assert.ok(parsedRequest);
    assert.equal(parsedRequest.method, "GET");
    assert.equal(parsedRequest.url, expectedTarget);
    assert.equal(parsedRequest.headers["content-length"], undefined);
    assert.equal(parsedRequest.headers["transfer-encoding"], "chunked");
    assert.equal(observed.length, 1);
    const [observedRequest] = observed;
    assert.ok(observedRequest);
    assert.equal(observedRequest.body, marker);
    const requestLine = "GET " + expectedTarget + " HTTP/1.1\r\n";
    const capture = findWireCapture(context.upstream.wire, requestLine);
    assert.ok(capture, "the real HTTPS wire must contain the body-bearing request");
    const { frameHeaders, wireBody } = readWireFrame(capture, requestLine);
    assert.doesNotMatch(frameHeaders, /\r\ncontent-length:/i);
    assert.match(frameHeaders, /\r\ntransfer-encoding: chunked(?:\r\n|$)/i);
    assert.ok(wireBody.endsWith("0\r\n\r\n"));
    assert.deepEqual(context.upstream.parserErrors, []);
    nativeIntegrityDiagnostic(
      t,
      "NATIVE-HTTP-FIX-01",
      {
        bodyless,
        nominatedContentLength: { parsedRequests: parsed.length, body: observedRequest.body },
      },
      { exactTarget: true, reconstructedChunked: true, parserErrors: 0 },
    );
  });

  test("native HTTP integrity 01 preserves framing for an admitted chunked GET", async (t) => {
    const context = await createFixture(t, { upstream: { captureWire: true } });
    const safeHeaders = {
      "x-forwarded-for": "203.0.113.10",
      "x-occ-identity": "invented-browser-identity",
      "x-openclaw-scopes": "invented-browser-scope",
      "x-safe-client-header": "integrity-preserved",
    };
    const lengthBody = "native-content-length-control";
    const length = await liveNativeRequest(context, "/integrity-content-length", {
      headers: { ...safeHeaders, "content-length": String(Buffer.byteLength(lengthBody)) },
      chunks: [lengthBody],
    });
    assert.equal(length.statusCode, 200);
    assert.equal(length.complete, true);
    const lengthObserved = context.upstream.requests.find((r) =>
      r.url?.endsWith("/integrity-content-length"),
    );
    assert.equal(lengthObserved?.body, lengthBody);
    assert.equal(lengthObserved?.headers["content-length"], String(Buffer.byteLength(lengthBody)));
    const posted = await liveNativeRequest(context, "/integrity-streamed-post", {
      method: "POST",
      headers: safeHeaders,
      chunks: ["native-streamed-", "post-control"],
    });
    assert.equal(posted.statusCode, 200);
    assert.equal(posted.complete, true);
    const postObserved = context.upstream.requests.find((r) =>
      r.url?.endsWith("/integrity-streamed-post"),
    );
    assert.equal(postObserved?.body, "native-streamed-post-control");
    assert.equal(postObserved?.headers["transfer-encoding"], "chunked");
    assert.ok(lengthObserved);
    assert.ok(postObserved);
    const beforeDenied = context.upstream.parsedRequests.length;
    const wrongOrigin = await liveNativeRequest(context, "/integrity-denied-origin", {
      headers: { origin: "https://untrusted.example.test" },
    });
    const readOnly = await context.createReadOnlySession("native-integrity-read-only");
    const forbidden = await liveNativeRequest(context, "/integrity-denied-iam", {
      headers: { cookie: readOnly.cookie },
    });
    // Rejected requests must stop at the controller before reaching the HTTPS parser.
    assert.equal(wrongOrigin.statusCode, 403);
    assert.equal(forbidden.statusCode, 403);
    assert.equal(context.upstream.parsedRequests.length, beforeDenied);
    const marker = "native-chunked-get-body";
    const path = "/integrity-chunked-get";
    const beforeParsed = context.upstream.parsedRequests.length;
    const downstream = await rawNativeRequest(
      context,
      "GET",
      path,
      {
        ...safeHeaders,
        "transfer-encoding": "chunked",
      },
      Buffer.byteLength(marker).toString(16) + "\r\n" + marker + "\r\n0\r\n\r\n",
    );
    await waitForNativeIntegrity(
      () => context.upstream.parsedRequests.some((r) => r.url?.endsWith(path)),
      "the real HTTPS parser must observe the admitted request",
    );
    const expectedTarget =
      "/namespaces/" + context.namespaceId + "/agents/" + context.agentId + path;
    const parsed = context.upstream.parsedRequests.slice(beforeParsed);
    const observed = context.upstream.requests.find((r) => r.url === expectedTarget);
    const requestLine = "GET " + expectedTarget + " HTTP/1.1\r\n";
    const capture = findWireCapture(context.upstream.wire, requestLine);
    if (!capture) {
      nativeIntegrityDiagnostic(
        t,
        "NATIVE-TRANSPORT-01",
        {
          captureReady: false,
          wireConnections: context.upstream.wire.map((w) => ({
            bytes: w.bytes,
            chunks: w.chunks.length,
            overflow: w.overflow,
          })),
          parsedRequests: parsed.map((r) => ({ method: r.method, url: r.url })),
          parsedBody: observed?.body,
          parserErrors: context.upstream.parserErrors,
        },
        {
          contentLengthGet: length.statusCode,
          streamedPost: posted.statusCode,
          denialStatuses: [wrongOrigin.statusCode, forbidden.statusCode],
        },
      );
    }
    assert.ok(capture, "decrypted upstream wire capture must include the actual request");
    const { frameHeaders, wireBody, requestWire } = readWireFrame(capture, requestLine);
    const framedByLength = new RegExp(
      "\\r\\ncontent-length: " + Buffer.byteLength(marker) + "(?:\\r\\n|$)",
      "i",
    ).test(frameHeaders);
    const framedByChunks = /\r\ntransfer-encoding: chunked(?:\r\n|$)/i.test(frameHeaders);
    assert.equal(parsed.length, 1, "one browser request must produce one parsed upstream request");
    const [parsedRequest] = parsed;
    assert.ok(parsedRequest);
    assert.equal(parsedRequest.url, expectedTarget);
    assert.equal(parsedRequest.headers["x-api-key"], context.nativeGatewayApiKey);
    assert.equal(parsedRequest.headers["x-safe-client-header"], "integrity-preserved");
    for (const name of [
      "cookie",
      "authorization",
      "x-forwarded-for",
      "x-occ-identity",
      "x-openclaw-scopes",
    ]) {
      assert.equal(parsedRequest.headers[name], undefined, name + " must not reach the peer");
    }
    const positiveControls = {
      contentLengthGet: {
        status: length.statusCode,
        complete: length.complete,
        body: lengthObserved.body,
      },
      streamedPost: {
        status: posted.statusCode,
        complete: posted.complete,
        body: postObserved.body,
      },
      denialStatuses: [wrongOrigin.statusCode, forbidden.statusCode],
      denialUpstreamContacts: context.upstream.parsedRequests.slice(beforeDenied, beforeParsed)
        .length,
      sanitizedExactTarget: true,
    };
    nativeIntegrityDiagnostic(
      t,
      "NATIVE-TRANSPORT-01",
      {
        downstreamStatus: Number(/^HTTP\/1.1 (\d+)/.exec(downstream)?.[1]),
        parsedRequests: parsed.map((r) => ({ method: r.method, url: r.url })),
        parsedBody: observed?.body,
        framedByLength,
        framedByChunks,
        wireBody,
        wire: requestWire.replaceAll(context.nativeGatewayApiKey, "<invented-fixture-key>"),
        parserErrors: context.upstream.parserErrors,
      },
      positiveControls,
    );
    assert.deepEqual(
      {
        framed: framedByLength || framedByChunks,
        parsedBody: observed?.body,
        wireContainsBody: wireBody.includes(marker),
      },
      { framed: true, parsedBody: marker, wireContainsBody: true },
      "HTTP_INTEGRITY_01_REQUEST_FRAMING",
    );
  });

  test("native HTTP integrity 02 preserves incomplete upstream responses", async (t) => {
    const context = await createFixture(t);
    const complete = await liveNativeRequest(context, "/integrity-response-complete");
    assert.equal(complete.statusCode, 200);
    assert.equal(complete.body, "native-complete-body\n");
    assert.equal(complete.complete, true);
    const beforeHeaders = await liveNativeRequest(context, "/integrity-response-pre-header");
    assert.equal(beforeHeaders.statusCode, 503);
    assert.match(beforeHeaders.body, /native gateway is unavailable/);
    assert.equal(beforeHeaders.complete, true);
    // Reset only after the client receives a prefix, so the relay has already committed 200.
    const interrupted = await liveNativeRequest(context, "/integrity-response-reset", {
      onFirstData: () => resetProducer(context.upstream, "response-reset"),
    });
    const shortLength = await liveNativeRequest(context, "/integrity-response-short", {
      onFirstData: () => resetProducer(context.upstream, "response-short"),
    });
    const positiveControls = {
      completeResponse: streamResult(complete),
      preHeaderFailure: streamResult(beforeHeaders),
    };
    nativeIntegrityDiagnostic(
      t,
      "NATIVE-TRANSPORT-02",
      {
        interrupted: streamResult(interrupted),
        shortContentLength: streamResult(shortLength),
      },
      positiveControls,
    );
    assert.equal(interrupted.statusCode, 200);
    assert.equal(shortLength.statusCode, 200);
    assert.deepEqual(
      {
        interruptedBody: interrupted.body,
        interruptedComplete: interrupted.complete,
        interruptedFallback: interrupted.body.includes("native gateway is unavailable"),
        shortBody: shortLength.body,
        shortComplete: shortLength.complete,
        shortFallback: shortLength.body.includes("native gateway is unavailable"),
      },
      {
        interruptedBody: "native-response-reset-prefix\n",
        interruptedComplete: false,
        interruptedFallback: false,
        shortBody: "native-response-short-prefix\n",
        shortComplete: false,
        shortFallback: false,
      },
      "HTTP_INTEGRITY_02_INCOMPLETE_RESPONSE",
    );
  });

  test("native HTTP integrity 03 keeps browser state headers controller-owned", async (t) => {
    const context = await createFixture(t);
    const ordinary = await liveNativeRequest(context, "/settings/profile");
    assert.equal(ordinary.statusCode, 200);
    assert.equal(ordinary.headers["x-native-upstream"], "reached");
    assert.equal(ordinary.headers["set-cookie"], undefined);
    const redirected = await liveNativeRequest(context, "/redirect-root");
    assert.equal(redirected.statusCode, 302);
    assert.equal(
      redirected.headers.location,
      context.nativeOrigin + "/settings/profile?from=redirect",
    );
    const redirectCsp = redirected.headers["content-security-policy"];
    assert.ok(typeof redirectCsp === "string");
    assert.match(redirectCsp, /default-src 'self'/);
    assert.match(redirectCsp, /worker-src 'none'/);
    const external = await liveNativeRequest(context, "/redirect-external");
    const reserved = await liveNativeRequest(context, "/redirect-reserved");
    assert.equal(external.statusCode, 502);
    assert.equal(external.headers.location, undefined);
    assert.equal(reserved.statusCode, 502);
    assert.equal(reserved.headers.location, undefined);
    const response = await liveNativeRequest(context, "/integrity-response-headers");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "native-header-body\n");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.headers["x-native-upstream"], "integrity-headers");
    assert.equal(response.headers["cache-control"], "no-store");
    const responseCsp = response.headers["content-security-policy"];
    assert.ok(typeof responseCsp === "string");
    assert.match(responseCsp, /default-src 'self'/);
    assert.match(responseCsp, /worker-src 'none'/);
    const positiveControls = {
      ordinaryStatus: ordinary.statusCode,
      safeHeader: response.headers["x-native-upstream"],
      setCookieRemoved: response.headers["set-cookie"] === undefined,
      csp: responseCsp,
      cacheControl: response.headers["cache-control"],
      redirectStatus: redirected.statusCode,
      redirectLocation: redirected.headers.location,
      unsafeRedirectStatuses: [external.statusCode, reserved.statusCode],
    };
    nativeIntegrityDiagnostic(
      t,
      "NATIVE-TRANSPORT-03",
      {
        status: response.statusCode,
        clearSiteData: response.headers["clear-site-data"] ?? null,
        body: response.body,
      },
      positiveControls,
    );
    assert.equal(
      response.headers["clear-site-data"],
      undefined,
      "HTTP_INTEGRITY_03_BROWSER_STATE_HEADER",
    );
  });

  test("native HTTP integrity 04 cancels discarded avatar error streams", async (t) => {
    const context = await createFixture(t);
    const finiteAvatar = await liveNativeRequest(context, "/api/users/upstream-unavailable/avatar");
    assert.equal(finiteAvatar.statusCode, 404);
    assert.equal(finiteAvatar.body, "");
    assert.equal(finiteAvatar.complete, true);
    const finiteError = await liveNativeRequest(context, "/upstream-unavailable");
    assert.equal(finiteError.statusCode, 502);
    assert.match(finiteError.body, /avatar_upstream_unavailable/);
    assert.equal(finiteError.complete, true);
    const disconnected = await liveNativeRequest(context, "/integrity-client-stream", {
      onFirstData: (response) => response.destroy(),
    });
    const ordinaryProducer = context.upstream.streams.get("client-stream");
    assert.ok(ordinaryProducer, "the HTTPS peer must start the ordinary producer");
    await waitForNativeIntegrity(
      () => ordinaryProducer.closed,
      "client disconnect must close the ordinary producer",
    );
    assert.equal(ordinaryProducer.finished, false);
    const avatar = await liveNativeRequest(context, "/api/users/integrity-avatar-stream/avatar");
    assert.equal(avatar.statusCode, 404);
    assert.equal(avatar.body, "");
    assert.equal(avatar.complete, true);
    const producer = context.upstream.streams.get("avatar-stream");
    assert.ok(producer);
    // A complete fallback must release its upstream producer before the fixture watchdog.
    const writesAtFinal404 = producer.writes;
    const closedAfter404 = await Promise.race([
      producer.close.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    const observed = {
      downstream: streamResult(avatar),
      producerClosedAfterFinal404: closedAfter404,
      producerFinished: producer.finished,
      writesAtFinal404,
      writesAfterObservation: producer.writes,
    };
    producer.reset();
    await producer.close;
    const positiveControls = {
      finiteAvatar: streamResult(finiteAvatar),
      nonAvatarFiniteError: streamResult(finiteError),
      clientDisconnect: streamResult(disconnected),
      ordinaryProducerClosed: ordinaryProducer.closed,
      ordinaryProducerFinished: ordinaryProducer.finished,
      testOwnedProducerCleanup: producer.closed,
    };
    nativeIntegrityDiagnostic(t, "NATIVE-TRANSPORT-04", observed, positiveControls);
    assert.equal(closedAfter404, true, "HTTP_INTEGRITY_04_DISCARDED_STREAM_CANCELLATION");
  });
}
