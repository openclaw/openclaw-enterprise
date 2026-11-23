import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createSecureServer, type ServerHttp2Stream } from "node:http2";
import type { Server } from "node:net";
import test from "node:test";

import {
  assertGitCallbackEndpoint,
  gitCallbackObserver,
  inspectObserver,
} from "../fixtures/openshell-git-callback-proxy.ts";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: Server) {
  if (server.listening) {
    server.close();
    await once(server, "close");
  }
}

test("Git callback evidence requires the exact calibrated HTTPS endpoint", () => {
  const endpoint = "https://git-callback-observer.oce-system.svc.cluster.local:8446";
  const git = { name: "oce-prepared-git", audience: "oce-prepared-git", grpc_endpoint: endpoint };
  assertGitCallbackEndpoint([git], endpoint);
  for (const grpc_endpoint of [
    "https://openclaw-enterprise-openshell-git.oce-system.svc.cluster.local:8445",
    "https://127.0.0.1:8445",
    endpoint.replace("8446", "8445"),
    endpoint + "/different",
  ]) {
    assert.throws(
      () => assertGitCallbackEndpoint([{ ...git, grpc_endpoint }], endpoint),
      /calibrated/,
    );
  }
  assert.throws(() => assertGitCallbackEndpoint([git, git], endpoint), /calibrated/);
  assert.throws(
    () => assertGitCallbackEndpoint([{ ...git, allow_insecure_transport: true }], endpoint),
    /calibrated/,
  );
});

test(
  "Git callback counter sees malformed streams and requires a live observer",
  { timeout: 15000 },
  async (t) => {
    const tls = await createTlsMaterial(t);
    const upstream = createSecureServer(tls);
    const received: string[] = [];
    upstream.on("stream", (stream: ServerHttp2Stream, headers) => {
      received.push(String(headers[":path"]));
      stream.resume();
      stream.respond(
        { ":status": 200, "content-type": "application/grpc", "grpc-status": "3" },
        { endStream: true },
      );
    });
    const upstreamPort = await listen(upstream);
    const { server, control } = gitCallbackObserver({
      ...tls,
      upstreamName: "localhost",
      upstreamPort,
    });
    const port = await listen(server);
    const counterPort = await listen(control);
    const client = connect(`https://127.0.0.1:${port}`, { ca: tls.ca, servername: "localhost" });
    t.after(async () => {
      client.destroy();
      await Promise.all([close(server), close(control), close(upstream)]);
    });
    const request = async (path: string) => {
      const stream = client.request({
        ":path": path,
        ":method": "POST",
        "content-type": "application/grpc",
      });
      const response = once(stream, "response");
      stream.end(Buffer.from("invalid gRPC frame"));
      stream.resume();
      const [headers] = await response;
      return headers["grpc-status"];
    };
    const base = "/openshell.middleware.v1.SupervisorMiddleware/";
    const evaluate = base + "EvaluateHttpRequest";
    const read = () => inspectObserver("read", counterPort);
    const disable = () => inspectObserver("disable", counterPort);
    const first = await read();
    assert.equal(first.disabled, false);
    assert.equal(first.attempts, 0);
    assert.equal(await request(evaluate), "3");
    assert.deepEqual(await read(), { ...first, attempts: 1 });
    assert.deepEqual(received, [evaluate]);
    const gated = await disable();
    assert.deepEqual(gated, { ...first, disabled: true });
    for (const path of [evaluate, base + "%45valuateHttpRequest", "/unrecognized"]) {
      assert.equal(await request(path), "14");
    }
    assert.deepEqual(received, [evaluate]);
    const counted = { ...gated, attempts: 3 };
    assert.deepEqual(await read(), counted);
    assert.deepEqual(await disable(), counted, "A duplicate disable must retain every attempt");
    for (const name of ["Describe", "ValidateConfig"]) {
      assert.equal(await request(base + name), "3");
    }
    assert.deepEqual(received, [evaluate, base + "Describe", base + "ValidateConfig"]);
    assert.deepEqual(await read(), counted);
    await close(control);
    await assert.rejects(read, { name: "TypeError", message: "fetch failed" });
  },
);
