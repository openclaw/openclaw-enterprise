import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { asRecord } from "../../packages/utils/src/index.ts";
import { assertImmutableImageReference, boundedImageCommand } from "./k3d-image-admission.ts";
import { isOpenShellLane } from "./openshell-full-integration.ts";
import { execFile } from "./prepare-command.ts";

type ImageRole = "controller" | "runtime";
type Progress = (lane: string, message: string) => void;
type CachePhase = "probe" | "load" | "direct-publish";

// Lanes that restore the hosted BuildKit cache. Only the main-only warm job
// (ci-image-cache.yml) exports it, building with images-packaging's state.
export const imageCacheLanes = new Map([
  ["slack", { localStore: false }],
  ["production-tui", { localStore: false }],
  ["gateway-routing", { localStore: false }],
  ["k3d-otel", { localStore: false }],
  ["openshell", { localStore: false }],
  ["dev-up-k3d", { localStore: false }],
  ["qa-matrix", { localStore: false }],
  ["images-packaging", { localStore: false }],
  ["images-runtime-startup", { localStore: false }],
  ["images-runtime-startup-2", { localStore: false }],
  ["images-runtime-startup-3", { localStore: false }],
]);

export function assertNodeBaseImage(image: string | undefined): asserts image is string {
  assertImmutableImageReference(image, "NODE_BASE_IMAGE");
  if (!/(?:^|[/:])node:24[.-]/.test(image)) {
    throw new Error("NODE_BASE_IMAGE must select an approved Node 24 image.");
  }
}

function imageCache(role: ImageRole) {
  return `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1`;
}

// The hosted cache build's arguments without --load or the tag, writing only
// to BuildKit's cache, with the given options first.
function imageCacheOnlyArgs(buildArgs: string[], ...options: string[]) {
  const [engineCommand, action, output, ...args] = buildArgs;
  if (engineCommand !== "buildx" || action !== "build" || output !== "--load") {
    throw new Error("Only a hosted cache build can export the image cache.");
  }
  const rest: string[] = [];
  const iterator = args.values();
  for (const arg of iterator) {
    if (arg === "-t") {
      iterator.next();
    } else {
      rest.push(arg);
    }
  }
  return ["buildx", "build", "--output", "type=cacheonly", ...options, ...rest];
}

// Only main's warm job (ci-image-cache.yml) writes the cache. It runs for every
// image input change, on a schedule, and before selected OpenShell runs. The
// singleton queue prevents concurrent writers, but does not order source commits.
// CI lanes only restore: a lane export on main could land after a newer commit's warm export
// and replace it, and on a pull request it cost about 40 s and filled only the
// merge ref's scope. The warm job exports in a second build after the image is
// built and loaded: the same arguments without --load or the tag, so BuildKit
// reuses the steps it just ran and only uploads the cache.
function imageCacheExportArgs(role: ImageRole, buildArgs: string[]) {
  return imageCacheOnlyArgs(buildArgs, "--cache-to", `${imageCache(role)},mode=max,timeout=10m`);
}

// The runtime Dockerfile builds OpenClaw beside its bridge tests (openclaw-build
// and openclaw-bridge-tests). OpenClaw's build refuses to start unless about 5 GiB
// is available, and the warm runner has 7.65 GiB: with the tests beside it, it
// found 2.2-3.9 GiB. The warm job builds that stage alone first, so the image
// build after it reuses the result and runs the tests then. Image lanes run on
// larger runners and keep both stages in parallel.
const warmRuntimeFirstStage = "openclaw-build";

// The warm job's limit for one image's cache export. Exports that reuse the
// OpenClaw layers took 25-65 s. A change to those layers (an OpenClaw pin, patch
// or install step) uploads them all again, one at a time: 513-817 s on the warm
// runner. Those layers are not byte-reproducible, so a cut-off export's uploads
// never help the next run, and a 5 min limit left the image lanes rebuilding
// them on every run (finding 1275). One upload once stalled for 17 min (finding
// 1219); this still bounds that. Tests shorten it.
const imageCacheExportTimeoutMs =
  Number(process.env.OPENCLAW_CI_IMAGE_CACHE_EXPORT_TIMEOUT_MS) > 0
    ? Number(process.env.OPENCLAW_CI_IMAGE_CACHE_EXPORT_TIMEOUT_MS)
    : 20 * 60_000;

export function imageBuildArgs(lane: string, role: ImageRole, localStore: boolean) {
  if (process.env.OCC_CI_IMAGE_CACHE === "1") {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      imageCacheLanes.get(isOpenShellLane(lane) ? "openshell" : lane)?.localStore !== localStore ||
      !process.env.ACTIONS_RUNTIME_TOKEN ||
      !process.env.ACTIONS_RESULTS_URL
    ) {
      throw new Error("Image caching requires the hosted image lane and its cache credentials.");
    }
    return [
      "buildx",
      "build",
      "--load",
      ...(isOpenShellLane(lane) && process.env.OCC_CI_FIRST_AGENT_BUILDER
        ? ["--builder", process.env.OCC_CI_FIRST_AGENT_BUILDER]
        : []),
      // An image ID covers each history entry's creation time. A fixed epoch lets
      // builders that write the same layers agree on the ID, so reuseEngineImage
      // can match an image another job built. It sets the config and history
      // timestamps and WORKDIR directory mtimes; RUN steps do not see it.
      "--build-arg",
      "SOURCE_DATE_EPOCH=0",
      "--cache-from",
      `${imageCache(role)},timeout=60s`,
    ];
  }
  return localImageBuildArgs(localStore);
}

export function localImageBuildArgs(localStore: boolean): string[] {
  return [
    "build",
    ...(localStore && basename(process.env.OCC_DOCKER_BIN ?? "docker") !== "podman"
      ? ["--builder", "default", "--load"]
      : []),
  ];
}

// CI_RUNNER_DEADLINE_MS (Unix epoch milliseconds; the run-ci-lane action sets it five
// minutes before the job's timeout-minutes) is when the lane's test files must have stopped.
// A lane image build may use the time before it less this reserve for the rest of preparation
// (an Envoy image, a seccomp profile, a fixture build or k3d imports in some lanes) and the
// tests: the image lanes' test phases took at most 102-171 s per lane over 29 runs each
// (10-19/20). A build
// that misses the image cache can take 20 min: on #2905 the engine image probe below, then
// bounded by a fixed 20 min, was stopped mid-build, the build after it took 4 more min, and
// the tests got 40 s (finding 2103). Tests shorten the reserve.
export const imageBuildTestReserveMs =
  Number(process.env.OPENCLAW_CI_IMAGE_BUILD_TEST_RESERVE_MS) > 0
    ? Number(process.env.OPENCLAW_CI_IMAGE_BUILD_TEST_RESERVE_MS)
    : 3 * 60_000;

export function imageBuildDeadlineMs() {
  const deadline = Number(process.env.CI_RUNNER_DEADLINE_MS ?? "");
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    return undefined;
  }
  return deadline - imageBuildTestReserveMs;
}

// What a lane image build may still take, or undefined outside a lane with a deadline.
export function imageBuildBudgetMs() {
  const deadline = imageBuildDeadlineMs();
  return deadline === undefined ? undefined : deadline - Date.now();
}

type LaneImageOperation = "current-build" | "baseline-build" | "cache-probe";

// The lane cannot pass once its image build has used the time its tests need, so it stops
// with this instead of building on and cutting every test file at the deadline.
function imageBuildOutOfTime(role: ImageRole, limitMs: number, operation: LaneImageOperation) {
  const revision = operation === "baseline-build" ? "Baseline" : "Current";
  const action = operation === "cache-probe" ? "cache probe" : "build";
  const title =
    limitMs > 0
      ? `${revision} ${role} image ${action} timed out`
      : `Insufficient lane time to start the ${revision.toLowerCase()} ${role} image ${action}`;
  const message =
    `The ${role} image did not finish building within this lane's time` +
    (limitMs > 0 ? ` (stopped after ${Math.round(limitMs / 1000)} s)` : "") +
    `; the lane keeps ${Math.round(imageBuildTestReserveMs / 1000)} s before its deadline ` +
    "for the rest of preparation and its tests, so it stops here. A build that misses the " +
    "image cache, for example after a change to the image inputs, can take about 20 min.";
  process.stdout.write(`::error title=${title}::${message}\n`);
  return Object.assign(new Error(message), { imageBuildOutOfTime: true });
}

const imageBuildTailLines = 40;

function commandStderr(error: unknown): string {
  const stderr = asRecord(error)?.stderr;
  return typeof stderr === "string" ? stderr : "";
}

// Runs a lane image build command within the lane's budget (unbounded without one).
export async function laneImageCommand(
  role: ImageRole,
  args: string[],
  budgetMs = imageBuildBudgetMs(),
  operation: LaneImageOperation = "current-build",
) {
  if (budgetMs !== undefined && budgetMs < 1_000) {
    throw imageBuildOutOfTime(role, 0, operation);
  }
  try {
    return await execFile(process.env.OCC_DOCKER_BIN ?? "docker", args, { timeoutMs: budgetMs });
  } catch (error) {
    if (budgetMs !== undefined && asRecord(error)?.timedOut === true) {
      // The build's progress names the step that was running (finding 2710: a cold
      // build stopped after 1305 s with no clue which step stalled).
      const tail = commandStderr(error).trimEnd().split("\n").slice(-imageBuildTailLines);
      if (tail.join("").trim()) {
        process.stderr.write(
          `[image-build] the ${role} image build's last output:\n${tail.join("\n")}\n`,
        );
      }
      throw imageBuildOutOfTime(role, budgetMs, operation);
    }
    throw error;
  }
}

export function observesImageCache(lane: string) {
  return (
    isOpenShellLane(lane) ||
    ["slack", "production-tui", "gateway-routing", "k3d-otel"].includes(lane)
  );
}

// Keep cache evidence without build arguments, URLs, command text or credentials.
export function imageCacheObservation(
  lane: string,
  role: ImageRole,
  phase: CachePhase,
  output: string,
  progress: Progress,
) {
  if (!observesImageCache(lane)) {
    return;
  }
  const cached = new Set([...output.matchAll(/^#(\d+) CACHED\r?$/gm)].map((match) => match[1]));
  const sourceBuild = new Set(
    [...output.matchAll(/^#(\d+) \[openclaw-build [^\]]+\] RUN /gm)].map((match) => match[1]),
  );
  progress(
    lane,
    JSON.stringify({
      stage: isOpenShellLane(lane) ? "first-agent-image-cache" : "image-cache",
      role,
      phase,
      cacheImports: [...output.matchAll(/^#\d+ importing cache manifest /gm)].length,
      cachedSteps: cached.size,
      openclawBuildSteps: sourceBuild.size,
      openclawBuildCached: [...sourceBuild].filter((id) => cached.has(id)).length,
    }),
  );
}

// A restored build otherwise downloads every cached layer (about 20 s for the
// runtime image) only to load an image the engine often already holds: the
// hosted runners' Docker data comes from a shared image cache. Resolve the
// image from the BuildKit cache without exporting its layers, then tag the
// engine's image if it has the same ID. The ID is the digest of a config that
// names every layer's content digest, so the tagged image is the one the build
// would load. The warm job, which builds every step for its export, and any probe
// failure (a timeout, an engine error, unreadable metadata, a failed tag) build as before. The log
// says "absent" only when the engine reports no such image, "different" when it
// holds another image under that reference, and "probe-failed" otherwise. In a lane with a
// deadline the probe, which builds on a cache miss, may use the whole image build budget;
// running out of it ends preparation ("out-of-time") instead of building again with no time
// left for the tests. The trade-off: a probe that hangs, rather than builds slowly, no longer
// hands over to a fresh build after 20 min in the longer lanes.
export async function reuseEngineImage(
  lane: string,
  role: ImageRole,
  args: string[],
  tag: string,
  progress: Progress,
): Promise<boolean> {
  if (args[0] !== "buildx" || !args.includes("--load")) {
    return false;
  }
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const started = performance.now();
  let directory: string | undefined;
  let outcome: "unresolved" | "out-of-time" | "absent" | "different" | "reused" | "probe-failed" =
    "unresolved";
  let image: string | undefined;
  try {
    directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "oce-image-probe-"));
    const metadata = join(directory, "metadata.json");
    const probeArgs = [
      "buildx",
      "build",
      "--output",
      "type=image,push=false,store=false",
      "--provenance=false",
      "--metadata-file",
      metadata,
      ...args.slice(2).filter((arg) => arg !== "--load"),
    ];
    // A cache miss builds the image here; the build below then reuses those
    // steps from the same builder and only exports and loads.
    const budgetMs = imageBuildBudgetMs();
    let probeResult: Awaited<ReturnType<typeof execFile>>;
    if (budgetMs === undefined) {
      probeResult = await execFile(docker, probeArgs, { timeoutMs: 20 * 60_000 });
    } else {
      try {
        probeResult = await laneImageCommand(role, probeArgs, budgetMs, "cache-probe");
      } catch (error) {
        if (asRecord(error)?.imageBuildOutOfTime === true) {
          outcome = "out-of-time";
        }
        throw error;
      }
    }
    imageCacheObservation(lane, role, "probe", probeResult.stderr, progress);
    const receipt: unknown = JSON.parse(await readFile(metadata, "utf8"));
    // A null document cannot supply metadata. A missing or invalid field is unresolved.
    if (receipt === null) {
      outcome = "probe-failed";
      return false;
    }
    const id = asRecord(receipt)?.["containerimage.config.digest"];
    if (typeof id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(id)) {
      return false;
    }
    image = id;
    // Under Docker's containerd image store the engine reports a manifest
    // digest here instead, so the comparison fails safe, the log says
    // "different", and the lane builds.
    let held: string;
    try {
      held = (
        await boundedImageCommand(["image", "inspect", "--format", "{{.Id}}", id])
      ).stdout.trim();
    } catch (error) {
      if (!/No such (?:image|object)|image not known/i.test(commandStderr(error))) {
        throw error;
      }
      outcome = "absent";
      return false;
    }
    if (held !== id) {
      outcome = "different";
      return false;
    }
    await boundedImageCommand(["tag", id, tag]);
    outcome = "reused";
    return true;
  } catch (error) {
    if (asRecord(error)?.imageBuildOutOfTime === true) {
      throw error;
    }
    outcome = "probe-failed";
    return false;
  } finally {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    progress(
      lane,
      JSON.stringify({
        stage: `${role}-image-reuse`,
        outcome,
        ...(image ? { image } : {}),
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  }
}

async function warmCommand(heading: string, args: string[], timeoutMs: number): Promise<void> {
  let output = "";
  try {
    const result = await execFile(process.env.OCC_DOCKER_BIN ?? "docker", args, { timeoutMs });
    output = result.stderr;
  } catch (error) {
    output = commandStderr(error);
    throw error;
  } finally {
    process.stderr.write(`[image-cache-warm] ${heading}\n${output}\n`);
  }
}

export async function warmImageBuildCache(
  role: ImageRole,
  args: string[],
  requireCacheExport: boolean,
  progress: Progress,
): Promise<void> {
  const exportArgs = imageCacheExportArgs(role, args);
  // A failed or overrunning build fails the job and keeps nothing. The first
  // stage and the image build share one 20-minute limit.
  const buildTimeoutMs = 20 * 60_000;
  const deadline = performance.now() + buildTimeoutMs;
  if (role === "runtime") {
    await warmCommand(
      `runtime ${warmRuntimeFirstStage} build`,
      imageCacheOnlyArgs(args, "--target", warmRuntimeFirstStage),
      buildTimeoutMs,
    );
  }
  await warmCommand(`${role} build`, args, Math.max(1, Math.round(deadline - performance.now())));
  // Standalone exports are best effort; prerequisites require success. Without an
  // export, image lanes restore
  // the previous cache: content-addressed steps that still match are reused and
  // the rest rebuild, so a missed export makes builds slower, never wrong.
  // BuildKit writes the cache manifest after the layers, so an interrupted
  // export leaves lanes the previous cache.
  const started = performance.now();
  let outcome = "exported";
  try {
    await warmCommand(`${role} cache export`, exportArgs, imageCacheExportTimeoutMs);
  } catch (error) {
    outcome = asRecord(error)?.timedOut === true ? "timed-out" : "failed";
    if (requireCacheExport) {
      throw error;
    }
    const reason =
      outcome === "timed-out" ? `did not finish within ${imageCacheExportTimeoutMs} ms` : "failed";
    process.stdout.write(
      `::warning title=Image cache export::The ${role} image built, but its cache export ` +
        `${reason}; image lanes restore the previous cache until the next warm run.\n`,
    );
  } finally {
    progress(
      "image-cache-warm",
      JSON.stringify({
        stage: `${role}-cache-export`,
        outcome,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  }
}
