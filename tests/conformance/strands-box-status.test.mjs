import { X509Certificate } from "node:crypto";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import test from "node:test";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import { listen } from "../helpers/listen.ts";

// Substitute revision Service discovery only. Both status reads use real loopback sockets.
async function check(t, diagnostic, signal = new AbortController().signal) {
  const tls = await harnessTlsFixture(t);
  const server = createServer(tls, diagnostic);
  server.on("upgrade", (_request, socket) => socket.destroy());
  const port = await listen(t, server);
  const address = `localhost:${port}`;
  return StrandsBoxSandboxDriver.prototype.harnessStatus.call(
    {
      harnessServiceAddress: async () => address,
      listenerCertificate: async () => new X509Certificate(tls.cert),
    },
    { signal, revision: { id: "rev_fixture" }, transportToken: "fixture" },
  );
}

test("Box reports an unreachable dependency when neither status read gets a response", async (t) => {
  await assert.rejects(
    check(t, (req) => req.socket.destroy()),
    {
      code: "SANDBOX_GATEWAY_UNAVAILABLE",
      reason: "unreachable",
    },
  );
});

test("Box preserves the caller's cancellation during its diagnostic read", async (t) => {
  const abort = new AbortController();
  const cause = new Error("cancelled revision");
  await assert.rejects(
    check(t, () => abort.abort(cause), abort.signal),
    (err) => err === cause,
  );
});

test("Box preserves startup and held failure responses from the Harness", async (t) => {
  const runtimeFailure = { code: "fixture-startup-failure" };
  for (const payload of [
    { state: "starting" },
    { state: "serving" },
    { state: "failed", runtimeFailure },
  ]) {
    const status = await check(t, (req, res) => {
      assert.equal(req.url, "/revisions/rev_fixture/readiness");
      assert.equal(req.headers.authorization, "Bearer fixture");
      res.end(JSON.stringify(payload));
    });
    assert.deepEqual(status, payload);
  }
});

test("a replacement at the same readiness endpoint receives no bearer or request", async (t) => {
  const original = await harnessTlsFixture(t);
  const replacement = await harnessTlsFixture(t);
  let requests = 0;
  let connections = 0;
  const server = createServer(replacement, (_req, res) => {
    requests++;
    res.end("{}");
  });
  server.on("connection", () => {
    connections++;
  });
  server.on("tlsClientError", (_, socket) => socket.destroy());
  const port = await listen(t, server);
  await assert.rejects(
    StrandsBoxSandboxDriver.prototype.harnessStatus.call(
      {
        harnessServiceAddress: async () => `localhost:${port}`,
        listenerCertificate: async () => new X509Certificate(original.cert),
      },
      {
        signal: new AbortController().signal,
        revision: { id: "rev_fixture" },
        transportToken: "revision-test",
      },
    ),
    { code: "SANDBOX_GATEWAY_UNAVAILABLE" },
  );
  assert.equal(connections, 1);
  assert.equal(requests, 0);
});
