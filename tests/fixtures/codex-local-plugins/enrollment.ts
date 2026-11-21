import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const input = JSON.parse(readFileSync(0, "utf8")) as { bearer: string; release?: unknown };

async function enroll() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:4500/openclaw/runtime/egress-enrollment", {
        method: input.release ? "POST" : "GET",
        headers: { authorization: "Bearer " + input.bearer, "content-type": "application/json" },
        ...(input.release ? { body: JSON.stringify(input.release) } : {}),
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(response.status, 200, "enrollment HTTP status");
      console.log(await response.text());
      return;
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code !== "ECONNREFUSED") {
        throw error;
      }
      await delay(100);
    }
  }
  throw new Error("enrollment listener timeout");
}

try {
  await enroll();
} catch (error) {
  console.error(String(error).replaceAll(input.bearer, "[redacted]"));
  process.exitCode = 1;
}
