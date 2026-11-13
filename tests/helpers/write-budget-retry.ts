import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

interface WriteReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/** Setup clients retry only explicit, pre-admission budget refusals, never uncertain writes. */
export async function retryWriteBudget<T extends WriteReply>(
  request: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reply = await request();
    const code = (reply.body as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (
      reply.status !== 429 ||
      (code !== "RATE_LIMITED" && code !== "SANDBOX_POLICY_RATE_LIMITED")
    ) {
      return reply;
    }
    const seconds = Number(reply.headers.get("retry-after"));
    assert.ok(Number.isFinite(seconds) && seconds >= 1 && seconds <= 5);
    await delay(seconds * 1000);
  }
  assert.fail("write remained rate limited after honoring Retry-After");
}
