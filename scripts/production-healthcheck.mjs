import { stat } from "node:fs/promises";

try {
  if (process.argv[2] !== "worker") {
    throw new Error("Only worker health requires an exec probe.");
  }
  const marker = process.env.OCC_WORKER_READINESS_PATH;
  if (typeof marker !== "string" || !marker.startsWith("/")) {
    throw new Error("The worker readiness marker must be an explicit absolute path.");
  }
  const observed = await stat(marker);
  if (process.argv[3] === "ready") {
    const poll = Number(process.env.OCC_WORKER_POLL_INTERVAL_MS ?? "250");
    const lease = Number(process.env.OCC_WORKER_LEASE_DURATION_MS ?? "5000");
    if (Date.now() - observed.mtimeMs > Math.max(15_000, poll * 60, lease * 3)) {
      throw new Error("The worker has not reported a recent healthy database observation.");
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Health check failed."}\n`);
  process.exitCode = 1;
}
