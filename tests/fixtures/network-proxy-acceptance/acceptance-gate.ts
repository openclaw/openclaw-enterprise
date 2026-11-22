import assert from "node:assert/strict";
import { request } from "node:http";
import { isAbsolute } from "node:path";

/** Ask the trusted parent to reconcile activity and consumer ownership before a possible send. */
export async function acceptanceGate(operation: "sender" | "qa-root"): Promise<void> {
  const socketPath = process.env.OCC_TEST_ACCEPTANCE_GATE;
  assert.ok(socketPath && isAbsolute(socketPath), "Acceptance post gate is unavailable");
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ operation });
    const call = request(
      {
        socketPath,
        path: "/gate",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 120_000,
      },
      (response) => {
        response.resume();
        if (response.statusCode === 204) {
          resolve();
        } else {
          reject(new Error("Acceptance post gate refused the send"));
        }
      },
    );
    call.once("error", () => reject(new Error("Acceptance post gate failed")));
    call.once("timeout", () => {
      call.destroy();
      reject(new Error("Acceptance post gate timed out"));
    });
    call.end(body);
  });
}
