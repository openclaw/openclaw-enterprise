import { setTimeout as delay } from "node:timers/promises";

interface ImageCommandResult {
  stdout: string | Buffer;
}

type ImageCommand<Result extends ImageCommandResult> = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<Result>;

interface ImagePullOptions<Result extends ImageCommandResult> {
  execFile?: ImageCommand<Result>;
  docker?: string;
  attempts?: number;
  firstDelayMs?: number;
  attemptTimeoutMs?: number;
  budgetMs?: number;
  sleep?: (milliseconds: number) => PromiseLike<void>;
  log?: (message: string) => void;
}

// Rejections can come from spawn, a timed-out command, or an injected executor.
// Normalize only the fields used for retry decisions, never the error message.
function pullFailureEvidence(error: unknown) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return { timedOut: false, code: undefined, stderr: "" };
  }
  return {
    timedOut: "timedOut" in error && error.timedOut === true,
    code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    stderr: String("stderr" in error ? (error.stderr ?? "") : ""),
  };
}

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

export function isTransientPullFailure(error: unknown): boolean {
  return transientPullEvidence(pullFailureEvidence(error));
}

function transientPullEvidence(error: ReturnType<typeof pullFailureEvidence>): boolean {
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

// Worst case: four attempts of attemptTimeoutMs plus 35 s of backoff, about 9
// minutes; no retry starts after budgetMs. The slowest healthy CI pulls (Grafana,
// Keycloak) finish within about 45 s, so a stalled attempt is retried after 2
// minutes instead of 5.
export async function pullImage<Result extends ImageCommandResult = ImageCommandResult>(
  image: string,
  {
    execFile,
    docker = "docker",
    attempts = 4,
    firstDelayMs = 5_000,
    attemptTimeoutMs = 120_000,
    budgetMs = 600_000,
    sleep = delay,
    log = (message) => process.stderr.write(`${message}\n`),
  }: ImagePullOptions<Result> = {},
): Promise<Result> {
  if (typeof execFile !== "function") {
    throw new Error("pullImage requires execFile.");
  }
  const started = Date.now();
  let delayMs = firstDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await execFile(docker, ["pull", image], { timeoutMs: attemptTimeoutMs });
    } catch (error) {
      const evidence = pullFailureEvidence(error);
      if (
        !transientPullEvidence(evidence) ||
        attempt >= attempts ||
        Date.now() - started + delayMs > budgetMs
      ) {
        throw error;
      }
      const reason = evidence.timedOut
        ? `timed out after ${attemptTimeoutMs} ms`
        : evidence.stderr.trim().split("\n").at(-1);
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
export async function hasLocalRepoDigest<Result extends ImageCommandResult = ImageCommandResult>(
  image: string,
  { execFile, docker = "docker" }: ImagePullOptions<Result> = {},
): Promise<boolean> {
  const digest = /@sha256:([a-f0-9]{64})$/i.exec(image ?? "")?.[1]?.toLowerCase();
  if (!digest) {
    return false;
  }
  let stdout;
  try {
    if (typeof execFile !== "function") {
      throw new TypeError("execFile is not a function");
    }
    ({ stdout } = await execFile(
      docker,
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
      { timeoutMs: 60_000 },
    ));
  } catch (error) {
    const evidence = pullFailureEvidence(error);
    if (!evidence.timedOut && /No such (?:image|object)|image not known/i.test(evidence.stderr)) {
      return false;
    }
    throw error;
  }
  try {
    const repoDigests: unknown = JSON.parse(String(stdout).trim() || "[]");
    return (
      Array.isArray(repoDigests) &&
      repoDigests.some(
        (reference: unknown) =>
          typeof reference === "string" && reference.toLowerCase().endsWith(`@sha256:${digest}`),
      )
    );
  } catch {
    return false;
  }
}

// pullImage, skipped when hasLocalRepoDigest finds the pinned image. `docker pull`
// asks the registry again even for a digest the engine holds, so a stalled registry
// would otherwise delay a step whose image a lane already pulled.
export async function ensureImage<Result extends ImageCommandResult = ImageCommandResult>(
  image: string,
  options: ImagePullOptions<Result> = {},
): Promise<Result | undefined> {
  if (await hasLocalRepoDigest(image, options)) {
    return undefined;
  }
  return pullImage(image, options);
}
