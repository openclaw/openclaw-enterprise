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

// True when the local engine already holds `image`, an image@sha256 reference, under
// that repository digest. The digest names the content, so the local copy is what a
// pull would fetch. A missing image or unreadable output is false, and the caller
// pulls; any other inspect failure, a timeout included, is thrown rather than read as
// an absent image.
export async function hasLocalRepoDigest(image, { execFile, docker = "docker" } = {}) {
  const digest = /@sha256:([a-f0-9]{64})$/i.exec(image ?? "")?.[1]?.toLowerCase();
  if (!digest) {
    return false;
  }
  let stdout;
  try {
    ({ stdout } = await execFile(
      docker,
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
      { timeoutMs: 60_000 },
    ));
  } catch (error) {
    if (
      error?.timedOut !== true &&
      /No such (?:image|object)|image not known/i.test(String(error?.stderr ?? ""))
    ) {
      return false;
    }
    throw error;
  }
  let repoDigests;
  try {
    repoDigests = JSON.parse(String(stdout).trim() || "[]");
  } catch {
    return false;
  }
  return (
    Array.isArray(repoDigests) &&
    repoDigests.some(
      (reference) =>
        typeof reference === "string" && reference.toLowerCase().endsWith(`@sha256:${digest}`),
    )
  );
}

// pullImage, skipped when hasLocalRepoDigest finds the pinned image. `docker pull`
// asks the registry again even for a digest the engine holds, so a stalled registry
// would otherwise delay a step whose image a lane already pulled.
export async function ensureImage(image, options = {}) {
  if (await hasLocalRepoDigest(image, options)) {
    return undefined;
  }
  return pullImage(image, options);
}
