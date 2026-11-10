import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitOpenShellProgress } from "../../scripts/ci/openshell-progress.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const categories = new Set([
  "AssertionError",
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "TimeoutError",
]);
const codes = new Set(["ERR_ASSERTION", "ABORT_ERR", "ETIMEDOUT", "ECONNREFUSED", "ENOENT"]);

function failureLocation(error) {
  const stack = error?.stack;
  if (typeof stack !== "string") {
    return null;
  }
  // Only publish an existing source file inside this checkout, never message
  // text, function names, external paths, or unverified source paths.
  for (const line of stack.slice(0, 16_384).split("\n")) {
    const frame = /^\s+at (?:.*\()?file:\/\/([^\s)]+):(\d{1,7}):(\d{1,7})\)?$/.exec(line);
    if (!frame) {
      continue;
    }
    try {
      const path = realpathSync(fileURLToPath(`file://${frame[1]}`));
      if (!path.startsWith(root) || !statSync(path).isFile()) {
        continue;
      }
      const relative = path.slice(root.length).replaceAll("\\", "/");
      if (/^(?:apps|packages|scripts|tests)\/[\w./-]+\.(?:[cm]?js|[cm]?ts)$/.test(relative)) {
        return `${relative}:${frame[2]}:${frame[3]}`;
      }
    } catch {
      // Unavailable or malformed frames do not prevent the original failure.
    }
  }
  return null;
}

export async function runOpenShellStage(context, stage, operation, sandboxPhase) {
  emitOpenShellProgress(stage, "started");
  const started = performance.now();
  let outcome = "failed";
  try {
    const result = await operation();
    outcome = "passed";
    return result;
  } catch (error) {
    // node:test reports errors after hooks; emit safe metadata before cleanup
    // can block. Messages and assertion values can contain generated credentials.
    try {
      const name = error?.name;
      const code = error?.code;
      process.stderr.write(
        `OpenShell stage failure ${JSON.stringify({
          category: categories.has(name) ? name : "unknown",
          code: codes.has(code) ? code : null,
          location: failureLocation(error),
        })}\n`,
      );
    } catch {
      // Diagnostics must not replace the failed operation.
    }
    throw error;
  } finally {
    const elapsedMs = Math.round(performance.now() - started);
    emitOpenShellProgress(stage, outcome);
    if (stage !== "exposure-auth") {
      context.diagnostic(
        `openclaw-ci-measurement ${JSON.stringify({ kind: "openshell-stage", stage, outcome, elapsedMs })}`,
      );
    }
    if (sandboxPhase !== undefined) {
      context.diagnostic(
        `openclaw-ci-measurement ${JSON.stringify({
          kind: "openshell-sandbox-phase",
          stage: sandboxPhase,
          outcome,
          elapsedMs,
        })}`,
      );
    }
  }
}
