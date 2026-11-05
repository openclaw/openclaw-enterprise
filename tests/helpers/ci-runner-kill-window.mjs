// Preloaded into scripts/ci/run-tests.mjs (node --import) beside ci-runner-held-clock.mjs by the
// ci-runner test that starts a process while the runner is ending its descendants (finding
// 2182). The runner lists its process tree from /proc and then kills what it found. This module
// holds the runner between the two steps of its first listing: once readdirSync("/proc") has
// read the directory, it creates the `window` path in this module's URL and returns only once the
// `forked` path exists. A fixture process waits for `window`, starts a child, and then creates
// `forked`, so that child is always missing from the listing the runner has just made.
//
// Only the first readdirSync("/proc") waits; later calls, and every other path, are Node's own.
// If `forked` never appears, the runner goes on after 30 s (real time, which the held clock
// does not stop) and says so on stderr.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const query = new URL(import.meta.url).searchParams;
const windowPath = query.get("window");
const forkedPath = query.get("forked");
const realReaddirSync = fs.readdirSync;
let waited = false;

// Sleeps this thread for `ms` without returning to the event loop.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

fs.readdirSync = function readdirSync(path, ...rest) {
  const entries = realReaddirSync(path, ...rest);
  if (waited || path !== "/proc") {
    return entries;
  }
  waited = true;
  fs.writeFileSync(windowPath, "");
  const deadline = performance.now() + 30_000;
  while (!fs.existsSync(forkedPath)) {
    if (performance.now() >= deadline) {
      process.stderr.write(`ci-runner-kill-window: ${forkedPath} never appeared\n`);
      break;
    }
    pause(10);
  }
  return entries;
};
// The runner imports readdirSync by name; this updates that binding too.
syncBuiltinESMExports();
