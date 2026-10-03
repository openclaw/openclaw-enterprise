import { stat } from "node:fs/promises";

function milliseconds(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function absoluteMarker(name, label) {
  const marker = process.env[name];
  if (typeof marker !== "string" || !marker.startsWith("/")) {
    throw new Error(`The worker ${label} marker must be an explicit absolute path.`);
  }
  return marker;
}

try {
  if (process.argv[2] !== "worker") {
    throw new Error("Only worker health requires an exec probe.");
  }
  const poll = milliseconds("OCC_WORKER_POLL_INTERVAL_MS", 250);
  const lease = milliseconds("OCC_WORKER_LEASE_DURATION_MS", 5000);
  if (process.argv[3] === "ready") {
    const observed = await stat(absoluteMarker("OCC_WORKER_READINESS_PATH", "readiness"));
    if (Date.now() - observed.mtimeMs > Math.max(15_000, poll * 60, lease * 3)) {
      throw new Error("The worker has not reported a recent healthy database observation.");
    }
  } else if (process.env.OCC_WORKER_LIVENESS_PATH !== undefined) {
    // Liveness asks only whether the run loop still moves. A database outage keeps it
    // moving (each pass fails fast), even at startup; a pass stuck on an await does not.
    // Claim heartbeats, every lease / 3, also count, so a long Compute wait stays live,
    // and one abandoned database statement costs at most one database timeout.
    const database = milliseconds("OCC_WORKER_DATABASE_TIMEOUT_MS", 60_000);
    const moved = await stat(absoluteMarker("OCC_WORKER_LIVENESS_PATH", "liveness"));
    if (Date.now() - moved.mtimeMs > Math.max(120_000, poll * 240, lease * 6, database * 2)) {
      throw new Error("The worker run loop has not made progress recently.");
    }
  } else {
    // Without a progress marker, liveness only proves the process initialized.
    await stat(absoluteMarker("OCC_WORKER_READINESS_PATH", "readiness"));
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Health check failed."}\n`);
  process.exitCode = 1;
}
