import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("../fixtures/docker-compute-wire.ts", import.meta.url));

export function registerDockerWireCases() {
  test("Docker preflight identifies request timeout and caller cancellation without losing retry", async () => {
    // The child isolates socket redirection and waits for the real ten-second request deadline.
    await exec(process.execPath, [fixture, "cancellation"], { timeout: 30_000 });
  });

  test("Docker Compute rejects an unbounded API response before its request deadline", async () => {
    await exec(process.execPath, [fixture, "response-limit"], { timeout: 10_000 });
  });

  test("Docker Agent readiness handles interrupted status responses immediately", async () => {
    // Run the exact generated healthcheck against a peer that resets a partial response.
    await exec(process.execPath, [fixture, "readiness"], { timeout: 10_000 });
  });

  test("Docker namespace delete treats a network that vanished before DELETE as removed", async () => {
    // The real Docker client inspects the owned network before Engine sends the DELETE result.
    await exec(process.execPath, [fixture, "namespace-delete"], { timeout: 10_000 });
  });
}
