import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  connect,
  constants,
  createSecureServer,
  type ClientHttp2Stream,
  type Http2Stream,
  type OutgoingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";

const middleware = "/openshell.middleware.v1.SupervisorMiddleware/";
const setup = new Set([middleware + "Describe", middleware + "ValidateConfig"]);

export function assertGitCallbackEndpoint(services: unknown, endpoint: string) {
  assert.ok(Array.isArray(services), "Require installed Supervisor middleware readback");
  const git = services.filter((service) => service?.name === "oce-prepared-git");
  assert.ok(
    git.length === 1 &&
      git[0].audience === "oce-prepared-git" &&
      !git[0].allow_insecure_transport &&
      endpoint.startsWith("https://") &&
      git[0].grpc_endpoint === endpoint,
    "Expected the calibrated Git callback observer",
  );
}

type Action = "read" | "disable" | "resume";
type Counter = { generation: string; attempts: number; disabled: boolean };

export async function inspectObserver(action: Action, port = 8447): Promise<Counter> {
  const response = await fetch(`http://127.0.0.1:${port}/${action}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const receipt = (await response.json()) as Partial<Counter>;
  assert.ok(typeof receipt.generation === "string" && receipt.generation.length > 0);
  assert.ok(
    typeof receipt.attempts === "number" &&
      Number.isSafeInteger(receipt.attempts) &&
      receipt.attempts >= 0,
  );
  assert.equal(typeof receipt.disabled, "boolean");
  return receipt as Counter;
}

function unavailable(stream: ServerHttp2Stream) {
  if (stream.destroyed || stream.closed) {
    return;
  }
  if (stream.headersSent) {
    stream.close(constants.NGHTTP2_INTERNAL_ERROR);
    return;
  }
  stream.respond(
    { ":status": 200, "content-type": "application/grpc", "grpc-status": "14" },
    { endStream: true },
  );
  stream.resume();
}

function relay(source: Http2Stream, destination: Http2Stream) {
  let trailers: OutgoingHttpHeaders = {};
  source.once("trailers", (headers) => {
    trailers = headers;
  });
  destination.once("wantTrailers", () => {
    if (!destination.closed && !destination.destroyed) {
      destination.sendTrailers(trailers);
    }
  });
  source.pipe(destination);
}

export function gitCallbackObserver(options: {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
  upstreamName: string;
  upstreamPort?: number;
}) {
  const { key, cert, ca, upstreamName, upstreamPort = 8445 } = options;
  const state: Counter = { generation: randomUUID(), attempts: 0, disabled: false };
  let calibrated = false;
  // Inspection reads the live counter in the same event loop as the HTTP/2 listener.
  const control = createServer((request, response) => {
    if (
      request.method !== "POST" ||
      !["/read", "/disable", "/resume"].includes(request.url ?? "")
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/disable") {
      state.disabled = true;
      if (!calibrated) {
        state.attempts = 0;
        calibrated = true;
      }
    } else if (request.url === "/resume") {
      state.disabled = false;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      connection: "close",
    });
    response.end(JSON.stringify(state));
  });
  const server = createSecureServer({ key, cert });
  server.on("sessionError", () => {});
  server.on("stream", (stream: ServerHttp2Stream, headers, flags) => {
    stream.on("error", () => {});
    // Only the two setup RPCs are exempt. Count all other streams before body parsing or forwarding.
    if (!setup.has(String(headers[":path"]))) {
      state.attempts++;
      if (state.disabled) {
        unavailable(stream);
        return;
      }
    }

    // The loopback address selects the Worker in this Pod. TLS verifies its service SAN.
    const client = connect(`https://127.0.0.1:${upstreamPort}`, { ca, servername: upstreamName });
    stream.once("close", () => client.destroy());
    client.once("error", () => unavailable(stream));
    const endRequest = (flags & constants.NGHTTP2_FLAG_END_STREAM) !== 0;
    let upstream: ClientHttp2Stream;
    try {
      upstream = client.request(headers, { endStream: endRequest, waitForTrailers: !endRequest });
    } catch {
      unavailable(stream);
      client.destroy();
      return;
    }
    upstream.on("error", () => unavailable(stream));
    upstream.once("aborted", () => unavailable(stream));
    upstream.once("response", (response, responseFlags) => {
      if (stream.closed || stream.destroyed) {
        return;
      }
      const endResponse = (responseFlags & constants.NGHTTP2_FLAG_END_STREAM) !== 0;
      stream.respond(response, { endStream: endResponse, waitForTrailers: !endResponse });
      if (!endResponse) {
        relay(upstream, stream);
      }
    });
    if (!endRequest) {
      relay(stream, upstream);
    }
  });
  return { server, control };
}

if (import.meta.main) {
  const upstreamName = process.env.UPSTREAM_NAME;
  assert.ok(upstreamName, "UPSTREAM_NAME must name the Worker certificate");
  const { server, control } = gitCallbackObserver({
    upstreamName,
    key: readFileSync("/cert/tls.key"),
    cert: readFileSync("/cert/tls.crt"),
    ca: readFileSync("/cert/ca.crt"),
  });
  control.listen(8447, "127.0.0.1", () => server.listen(8446, "0.0.0.0"));
}
