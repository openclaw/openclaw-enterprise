import { setTimeout as delay } from "node:timers/promises";

// Bounded retry for `docker pull`, the image counterpart of
// scripts/ci/download-pinned.sh. A transient failure is a registry 5xx or
// 429 (toomanyrequests), a refused or reset connection, a DNS lookup
// failure, a TLS handshake, I/O or client timeout, an unexpected EOF, or the
// attempt outliving its own timeout. Anything else fails on the first attempt, and the permanent
// patterns win when both match: a missing manifest or repository, denied or
// unauthorized access, a digest mismatch, a bad reference, or a missing
// Docker binary. The caller still verifies the pulled repository digest.
const permanentPullFailure =
  /manifest unknown|not found|unauthorized|denied|authentication required|verification failed|digest mismatch|unexpected commit digest|invalid reference format/i;
const transientPullFailure =
  /toomanyrequests|too many requests|(?:HTTP|status)(?: code)?:? (?:429|5\d\d)\b|internal server error|bad gateway|service unavailable|gateway timeout|connection reset|connection refused|no such host|server misbehaving|name resolution|TLS handshake timeout|i\/o timeout|Client\.Timeout exceeded|deadline exceeded|unexpected EOF|: EOF\b/i;

export function isTransientPullFailure(error) {
  if (error?.timedOut === true) {
    return true;
  }
  if (typeof error?.code === "string" && error.code.startsWith("E")) {
    // spawn failures (ENOENT, EACCES): no registry was contacted
    return false;
  }
  // stderr only: the error message repeats the image reference, and a digest
  // or tag must not decide the classification.
  const output = String(error?.stderr ?? "");
  return !permanentPullFailure.test(output) && transientPullFailure.test(output);
}

// Worst case: no retry starts after budgetMs, and one attempt can then run for
// attemptTimeoutMs more, so a pull gives up within about 15 minutes.
export async function pullImage(
  image,
  {
    execFile,
    docker = "docker",
    attempts = 4,
    firstDelayMs = 5_000,
    attemptTimeoutMs = 300_000,
    budgetMs = 600_000,
    sleep = delay,
    log = (message) => process.stderr.write(`${message}\n`),
  } = {},
) {
  if (typeof execFile !== "function") {
    throw new Error("pullImage requires execFile.");
  }
  const started = Date.now();
  let delayMs = firstDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await execFile(docker, ["pull", image], { timeoutMs: attemptTimeoutMs });
    } catch (error) {
      if (
        !isTransientPullFailure(error) ||
        attempt >= attempts ||
        Date.now() - started + delayMs > budgetMs
      ) {
        throw error;
      }
      const reason = error.timedOut
        ? `timed out after ${attemptTimeoutMs} ms`
        : String(error.stderr).trim().split("\n").at(-1);
      log(
        `Transient image pull failure (${reason}); retrying in ${delayMs} ms (attempt ${attempt + 1}/${attempts}): ${image}`,
      );
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}
