import assert from "node:assert/strict";
import test from "node:test";
import { waitForWorkspaceReconnect } from "../helpers/gateway-workspace-readiness.mjs";

const disconnected = (changes = {}) =>
  new Error("workspace unavailable", {
    cause: {
      type: "gateway_request_error",
      code: "UNAVAILABLE",
      message: "node not connected",
      ...changes,
    },
  });

for (const message of [
  "node not connected",
  "GatewayClientRequestError: node not connected: code=UNAVAILABLE",
]) {
  test(`replacement workspace read waits for enrollment: ${message}`, async () => {
    const expected = { file: { content: "retained workspace" } };
    let reads = 0;
    const result = await waitForWorkspaceReconnect(async () => {
      reads += 1;
      if (reads === 1) {
        throw disconnected({ message });
      }
      return expected;
    });
    assert.equal(result, expected);
    assert.equal(reads, 2);
  });
}

test("workspace readiness never retries other protocol, authorization or transport failures", async () => {
  for (const failure of [
    disconnected({ code: "FORBIDDEN" }),
    disconnected({ message: "upstream unavailable" }),
    disconnected({ type: "gateway_credentials_required" }),
    new Error("transport closed"),
  ]) {
    let reads = 0;
    await assert.rejects(
      waitForWorkspaceReconnect(async () => {
        reads += 1;
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(reads, 1);
  }
});

test("a permanently disconnected workspace fails within the readiness deadline", async () => {
  await assert.rejects(
    waitForWorkspaceReconnect(async () => {
      throw disconnected();
    }, 0),
    /Timed out waiting for workspace node reconnection: node not connected \(UNAVAILABLE\)/,
  );
});
