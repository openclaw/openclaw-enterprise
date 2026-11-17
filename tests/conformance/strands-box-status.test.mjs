import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import { listen } from "../helpers/listen.ts";

// Substitute revision Service discovery only. Both status reads use real loopback sockets.
async function check(t, diagnostic, signal = new AbortController().signal) {
  const server = createServer(diagnostic);
  server.on("upgrade", (_request, socket) => socket.destroy());
  const port = await listen(t, server);
  const address = `127.0.0.1:${port}`;
  return StrandsBoxSandboxDriver.prototype.harnessStatus.call(
    {
      harnessServiceAddress: async () => address,
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
      assert.equal(
        req.headers.authorization,
        "Bearer " + createHmac("sha256", "fixture").update(req.url).digest("hex"),
      );
      res.end(JSON.stringify(payload));
    });
    assert.deepEqual(status, payload);
  }
});
