import assert from "node:assert/strict";
import { isIPv4 } from "node:net";
import { setTimeout } from "node:timers/promises";

const [budget, address, reachable] = process.argv.slice(2);
const budgetMs = Number(budget);
assert.ok(Number.isSafeInteger(budgetMs) && budgetMs > 0, "Invalid readiness budget");
assert.ok(address && isIPv4(address), "Invalid Gateway address");
assert.ok(reachable === "true" || reachable === "false", "Invalid reachability expectation");
const deadline = Date.now() + budgetMs;

async function probe(host: string, port: number) {
  try {
    const response = await fetch(`http://${host}:${port}/readyz`, {
      signal: AbortSignal.timeout(3000),
    });
    return { port, status: response.status };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const cause = error.cause;
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    return { port, error: typeof code === "string" ? code : error.name };
  }
}

for (;;) {
  const [native, status] = await Promise.all([probe(address, 8080), probe(address, 18791)]);
  const settled = reachable === "true" ? native.status === 200 : native.error === "ECONNREFUSED";
  if ((status.status === 200 && settled) || Date.now() >= deadline) {
    console.log(JSON.stringify([native, status]));
    break;
  }
  await setTimeout(500);
}
