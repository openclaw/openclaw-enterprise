#!/usr/bin/env node
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { asRecord } from "../../packages/utils/src/index.ts";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { openclawBuildArguments, readOpenclawSource } from "../lib/openclaw-source.ts";
import { isOpenShellLane } from "./openshell-full-integration.ts";
import {
  assertRuntimeArtifactTagAvailable,
  loadRuntimeArtifact,
  runtimeArtifactSelection,
} from "./runtime-artifact.ts";
import { cleanupResourceIds, type RequireJournal } from "./cleanup.ts";
import { withStateLock } from "./state-lock.ts";
import { createPostgresPreparation } from "./prepare-postgres.ts";
import { createK3dFixtureStorage } from "./k3d-fixture-storage.ts";
import { createK3dNodeImages } from "./k3d-node-images.ts";
import {
  assertDockerImageId,
  assertImmutableImageReference,
  boundedImageCommand,
  createK3dImageAdmission,
  devUpUnrelatedImage,
  ensureDockerSourceImage,
  imageCommandTimeoutMs,
  immutableDigest,
  prepareDevUpImage,
} from "./k3d-image-admission.ts";
import {
  createK3dPreparation,
  findK3dCluster,
  reserveLoopbackPort,
  type K3dCluster,
  type PreparationResource,
  type PreparationState,
} from "./k3d-preparation.ts";
import { commandAvailable, execFile } from "./prepare-command.ts";
import { prepareGatewayRouting } from "./routing.ts";
import { prepareLogging, readDefaultCollectorImage } from "./logging.ts";
import { startObservabilityPhase } from "./observability-phase-notice.ts";
import { recordLoggingSetupTiming } from "./logging-setup-timing.ts";
import { ownedName, randomSuffix, slug } from "./resource-names.ts";
import { registryImage } from "./fixture-support-images.ts";
import {
  assertNodeBaseImage,
  imageBuildArgs,
  imageBuildBudgetMs,
  imageBuildDeadlineMs,
  imageBuildTestReserveMs,
  imageCacheLanes,
  imageCacheObservation,
  laneImageCommand,
  localImageBuildArgs,
  observesImageCache,
  reuseEngineImage,
  warmImageBuildCache,
} from "./image-build-cache.ts";
import { keycloakResourceKind, prepareKeycloak, readKeycloakImage } from "./keycloak.ts";
import { imageInventory, laneImagesResourceKind } from "./lane-images.ts";
import { imageConfigDigest } from "./image-config-digest.ts";
import { verifyPreloadedAgentSandbox } from "./agent-sandbox.ts";
import {
  preparationIdentity,
  readImageCodexProvenance,
  readRuntimeProvenance,
} from "./runtime-provenance.ts";
import { metricsMonitoringImages } from "./metrics-monitoring-images.ts";
import {
  prepareRepositoryCredentials,
  prepareRepositoryCredentialsFile,
} from "./repository-credentials.ts";
import { prepareCodexSeccompProfile } from "../lib/codex-seccomp-k3d.ts";
import { prepareOpenShell, validateOpenShellSelection } from "./openshell.ts";
import { runPreparationCli } from "./prepare-cli.ts";
import {
  assertLane,
  effectiveLaneEnv,
  laneDefaults,
  laneDefinition,
  laneName,
  lanePrepare,
  nativeIAMBarrierFile,
  normalizeFile,
  productionUpgradeImages,
  repositoryCredentialsFileNeedsBinary,
  repositoryRoot,
  requireEnv,
  selectedLaneFile,
  suiteView,
  validateLaneInputsBeforeSideEffects,
  type LaneSelection,
  type PrepareFileOptions,
  type PrepareLaneOptions,
} from "./prepare-inputs.ts";

type JournalResource = PreparationResource & {
  imageId?: string;
  containerId?: string;
  controllerImage?: string;
  sourceImage?: string;
  reference?: string;
  hostImageId?: string;
  cluster?: string;
  envName?: string;
};
type RuntimeRecord = {
  imageId: string;
  manifestDigest: string;
  status: "available" | "unavailable";
};
type PreparedCluster = K3dCluster & {
  codexSeccompProfile?: string;
  codexSeccompProfiles?: Awaited<ReturnType<typeof prepareCodexSeccompProfile>>["nodes"];
  codexDockerSeccompProfile?: { path: string; sha256: string | undefined };
};
type CiState = Omit<PreparationState, "resources"> & {
  resources: JournalResource[];
  runtimeProvenance?: Record<string, RuntimeRecord>;
  version: 1;
  repositoryRoot: string;
  statePath: string;
  createdAt: string;
  ciRun?: { id: string; attempt: string };
  cleanupOwner?: string;
  selectedFile?: string | undefined;
  env?: Record<string, string>;
  defaults?: Record<string, string>;
};
type PreparedLane = { cleanup: () => Promise<boolean | void>; env: Record<string, string> };
type PreparedFile = {
  cleanup: ((options?: { lockTimeoutMs?: number | undefined }) => Promise<void>) | null;
  env: Record<string, string>;
  defaults: Record<string, string>;
};

const runtimeDockerfile = join(repositoryRoot, "deploy/runtime/Dockerfile");
const fixtureDockerContext = join(repositoryRoot, "tests/fixtures/kubernetes");
const defaultStatePath = join(
  process.env.RUNNER_TEMP ?? tmpdir(),
  "openclaw-enterprise-ci-state.json",
);
const fixtureLanes = new Set([
  "k3d-fixture-configuration",
  "k3d-fixture-state",
  "k3d-fixture-network",
  "k3d-fixture-plugins",
]);
// These lanes' tests use no Ingress, LoadBalancer Service, metrics API or
// Gateway API, so their clusters skip K3s's Traefik, ServiceLB and
// metrics-server add-ons, which would otherwise pull and start on every node
// while the lane imports its images. Lanes that set up gateway routing need
// Traefik: K3s installs the Gateway API CRDs with it, and prepareGatewayRouting
// refuses a cluster without it (routing.ts). Every lane here runs in PR CI;
// full-integration lanes keep K3s's defaults.
const lanesWithoutK3sAddons = new Set([
  ...fixtureLanes,
  "images-runtime-startup",
  "k3d-observability",
]);
// Ordinary k3d lanes pin the K3s node image by digest so cluster creation
// never depends on k3d's online release-channel lookup (update.k3s.io). Bump
// it deliberately to a newer v1.35 patch; OPENCLAW_CI_K3S_IMAGE still
// overrides it with another immutable reference. The QA workflows pass the same
// image to the Compose launcher as OCC_DEVELOPMENT_K3S_IMAGE (ci-prepare.test.ts
// checks they match).
const defaultK3sImage =
  "docker.io/rancher/k3s:v1.35.9-k3s1@sha256:ec9868c6a38d4e8c1869832fb5fd1eb8473c39794a0b44d2b952e7ba911951bc";

function progress(lane: LaneSelection, message: string) {
  process.stderr.write(`[prepare:${laneName(lane)}] ${message}\n`);
}

async function timedPreparation<Result>(
  lane: string,
  phase: string,
  operation: () => Result | Promise<Result>,
) {
  const finishTiming = startObservabilityPhase(lane, phase);
  const started = performance.now();
  let succeeded = false;
  try {
    const result = await operation();
    succeeded = true;
    return result;
  } finally {
    const elapsedMs = Math.round(performance.now() - started);
    finishTiming?.(succeeded ? "success" : "failure", elapsedMs);
    // Labels are fixed by the runner; never include commands, paths, or credentials.
    process.stderr.write(`[ci-timing] lane=${lane} phase=${phase} duration_ms=${elapsedMs}\n`);
    if (lane === "k3d-model" && process.env.GITHUB_ACTIONS === "true") {
      const outcome = succeeded ? "success" : "failure";
      if (phase === "controller" || phase === "runtime") {
        // Each role measures its own build or reuse. Their wall times can overlap.
        process.stderr.write(
          `::notice title=k3d Model Runtime image::role=${phase} elapsed_ms=${elapsedMs} outcome=${outcome}\n`,
        );
      } else if (
        [
          "postgres-start",
          "k3d-cluster-preparation",
          "image-build-or-reuse",
          "runtime-image-preparation",
          "gateway-routing",
        ].includes(phase)
      ) {
        process.stderr.write(
          `::notice title=k3d Model Runtime preparation::stage=${phase} elapsed_ms=${elapsedMs} outcome=${outcome}\n`,
        );
      }
    }
    if (lane === "logging-collector" && phase === "image-pulls") {
      await recordLoggingSetupTiming("image-pulls", succeeded ? "success" : "failure", elapsedMs);
    }
    if (
      process.env.OPENCLAW_CI_NATIVE_PREPARATION_SUMMARY === "1" &&
      process.env.GITHUB_STEP_SUMMARY &&
      lane === "images-packaging" &&
      ["k3d-create", "runtime-image-import", "codex-seccomp-profile"].includes(phase) &&
      Number.isSafeInteger(elapsedMs) &&
      elapsedMs >= 0
    ) {
      try {
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `- ${phase}: ${elapsedMs} ms (elapsed; see step outcome)\n`,
        );
      } catch {
        // Summary output is best effort; preserve the operation's result and stderr.
      }
    }
  }
}

export function timedK3dModelPreparation<Result>(
  lane: string,
  phase: string,
  operation: () => Result,
) {
  return lane === "k3d-model" ? timedPreparation(lane, phase, operation) : operation();
}

function fileStem(file: string) {
  return slug(basename(file).replace(/\.test\.(?:mjs|ts)$/, ""), "_") || "test_file";
}

function normalizeStatePath(statePath: string | undefined) {
  return resolve(statePath ?? defaultStatePath);
}

function runPrefix(lane: string) {
  const runId = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  const job = process.env.GITHUB_JOB ?? "local";
  const label =
    suiteView === "full-integration" && isOpenShellLane(lane)
      ? `${runId}-${attempt}-${lane.replace(/^openshell-/, "")}`
      : `${runId}-${attempt}-${job}`;
  return ownedName("openclaw-ci", label, { maxLength: 48 });
}

function baseState(lane: string, statePath: string): CiState {
  const state: CiState = {
    version: 1,
    repositoryRoot,
    lane,
    prefix: runPrefix(lane),
    statePath,
    createdAt: new Date().toISOString(),
    resources: [],
  };
  if (
    lane === "images-packaging" &&
    (process.env.GITHUB_RUN_ID || process.env.GITHUB_RUN_ATTEMPT)
  ) {
    const id = process.env.GITHUB_RUN_ID;
    const attempt = process.env.GITHUB_RUN_ATTEMPT;
    if (!id || !attempt || !/^[1-9][0-9]*$/.test(id) || !/^[1-9][0-9]*$/.test(attempt)) {
      throw new Error("Image CI state requires a valid run ID and attempt.");
    }
    state.ciRun = { id, attempt };
  }
  return state;
}

function isStringMap(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every((entry) => typeof entry === "string");
}

function stringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isStringMap(value)) {
    throw new Error(`CI state ${field} must contain string values.`);
  }
  return value;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function configInspection(value: unknown): value is Parameters<typeof imageConfigDigest>[0] {
  const image = asRecord(value);
  const descriptor = asRecord(image?.Descriptor);
  const annotations = asRecord(descriptor?.annotations);
  return (
    image !== undefined &&
    (image.Id === undefined || typeof image.Id === "string") &&
    (image.Descriptor === undefined ||
      (descriptor !== undefined &&
        typeof descriptor.digest === "string" &&
        (descriptor.mediaType === undefined || typeof descriptor.mediaType === "string") &&
        (descriptor.annotations === undefined ||
          (annotations !== undefined &&
            Object.values(annotations).every((entry) => typeof entry === "string")))))
  );
}

async function readState(path: string) {
  try {
    const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
    const state = asRecord(decoded);
    if (state?.version !== 1) {
      throw new Error(`Unsupported CI state version: ${state?.version}`);
    }
    if (state.repositoryRoot !== repositoryRoot) {
      throw new Error(`CI state belongs to another repository root: ${state.repositoryRoot}`);
    }
    if (typeof state.prefix !== "string" || !state.prefix.startsWith("openclaw-ci-")) {
      throw new Error("CI state prefix is not an OpenClaw Enterprise CI prefix.");
    }
    if (!Array.isArray(state.resources)) {
      throw new Error("CI state resources must be an array.");
    }
    if (typeof state.lane !== "string") {
      throw new Error("CI state lane must be a string.");
    }
    if (state.selectedFile !== undefined && typeof state.selectedFile !== "string") {
      throw new Error("CI state selected file must be a string.");
    }
    const env = stringMap(state.env, "env");
    const defaults = stringMap(state.defaults, "defaults");
    return {
      ...state,
      lane: state.lane,
      prefix: state.prefix,
      selectedFile: state.selectedFile,
      env,
      defaults,
      // Resource owners admit their own details when they use the journal.
      resources: state.resources as PreparationResource[],
    };
  } catch (error) {
    if (asRecord(error)?.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

const stateWrites = new Map<string, Promise<void>>();

// The Codex version the runtime image pins; seccomp preparation verifies the
// image's `codex --version` against it, so it must not drift from the Dockerfile.
async function kubernetesCodexVersion(env: NodeJS.ProcessEnv) {
  const override =
    env.OCC_TEST_KUBERNETES_CODEX_VERSION ?? process.env.OCC_TEST_KUBERNETES_CODEX_VERSION;
  if (override) {
    return override;
  }
  const dockerfile = await readFile(runtimeDockerfile, "utf8");
  const match = /^ENV OPENAI_CODEX_VERSION=(\S+)$/m.exec(dockerfile);
  if (!match) {
    throw new Error(`${runtimeDockerfile} does not pin OPENAI_CODEX_VERSION.`);
  }
  return match[1]!;
}

async function writeState(path: string, state: PreparationState) {
  // Concurrent preparation must never publish an older cleanup inventory after
  // a newer one. A failed write still lets subsequent cleanup record its state.
  const pending = (stateWrites.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(() => persistState(path, state));
  stateWrites.set(path, pending);
  try {
    await pending;
  } finally {
    if (stateWrites.get(path) === pending) {
      stateWrites.delete(path);
    }
  }
}

async function persistState(
  path: string,
  state: PreparationState,
  { exclusive = false }: { exclusive?: boolean } = {},
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomSuffix()}.tmp`);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(content).finally(() => file.close());
    await chmod(temp, 0o600);
    if (exclusive) {
      // Publish a complete initial journal without replacing another owner's state.
      await link(temp, path);
    } else {
      await rename(temp, path);
    }
  } finally {
    await rm(temp, { force: true });
  }
}

type PreparationResults<Operations extends readonly (() => unknown)[]> = {
  [K in keyof Operations]: Awaited<ReturnType<Operations[K]>>;
};

async function prepareTogether<const Operations extends readonly (() => unknown)[]>(
  operations: Operations,
  concurrency = operations.length,
): Promise<PreparationResults<Operations>> {
  const remaining = operations.entries();
  const results: unknown[] = [];
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, operations.length) }, async () => {
      for (const [index, operation] of remaining) {
        results[index] = await operation();
      }
    }),
  );
  // Wait for every in-flight command before cleanup can remove its resources.
  for (const worker of workers) {
    if (worker.status === "rejected") {
      throw worker.reason;
    }
  }
  return results as PreparationResults<Operations>;
}

function addResource<Kind extends string, Details extends object>(
  state: PreparationState,
  kind: Kind,
  resource: Details,
) {
  const entry: JournalResource & { kind: Kind } & Details = {
    id: `${kind}-${randomSuffix()}`,
    kind,
    owner: state.prefix,
    status: "planned",
    createdAt: new Date().toISOString(),
    ...resource,
  };
  state.resources.push(entry);
  return entry;
}

async function markResourceReady(
  statePath: string,
  state: PreparationState,
  resource: PreparationResource,
) {
  resource.status = "ready";
  resource.readyAt = new Date().toISOString();
  await writeState(statePath, state);
}

function repositoryCredentialsImageJournal(
  statePath: string,
  state: ReturnType<typeof baseState>,
): import("./repository-credentials.ts").RepositoryCredentialsImageJournal {
  return {
    imagePrefix: `localhost/${ownedName("openclaw-ci-image", state.prefix, { maxLength: 48 })}`,
    registerImage: async (tag) => {
      const resource = addResource(state, "image-tag", { name: tag });
      await writeState(statePath, state);
      return async (imageId) => {
        resource.imageId = imageId;
        await markResourceReady(statePath, state, resource);
      };
    },
  };
}

async function buildRuntimeImages(
  statePath: string,
  state: CiState,
  {
    controller = false,
    runtime = false,
    nodeBaseImage = process.env.NODE_BASE_IMAGE,
    localStore = false,
    cacheWarm = false,
    requireCacheExport = false,
    reuseEngineImages = true,
    revision,
    controllerTarget = "runtime",
    buildConcurrency,
    registryOutput,
    runtimeArtifact,
  }: {
    controller?: boolean;
    runtime?: boolean;
    nodeBaseImage?: string | undefined;
    localStore?: boolean;
    cacheWarm?: boolean;
    requireCacheExport?: boolean;
    reuseEngineImages?: boolean;
    revision?: string;
    controllerTarget?: "runtime" | "development";
    buildConcurrency?: number;
    registryOutput?: string;
    runtimeArtifact?: ReturnType<typeof runtimeArtifactSelection>;
  } = {},
) {
  // Plain BuildKit progress shows each step's cache hit or duration. The warm job
  // prints it per image and command once that ends (parallel builds stay
  // readable), also when it fails or overruns its own deadline inside the job's.
  const plainProgress = cacheWarm || observesImageCache(state.lane) ? ["--progress=plain"] : [];
  if (revision !== undefined && !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("Image builds require a complete checkout revision.");
  }
  if (!["runtime", "development"].includes(controllerTarget)) {
    throw new Error("Unsupported controller build target.");
  }
  const revisionArgs =
    revision === undefined
      ? []
      : [
          "--build-arg",
          `OCC_BUILD_REVISION=${revision}`,
          "--label",
          `org.opencontainers.image.revision=${revision}`,
          "--provenance=false",
        ];
  const build = async (role: "controller" | "runtime", args: string[]) => {
    if (cacheWarm) {
      await warmImageBuildCache(role, args, requireCacheExport, progress);
    } else {
      const result = await laneImageCommand(role, args);
      imageCacheObservation(state.lane, role, "load", result.stderr, progress);
    }
  };
  const importDeadlineMs =
    runtimeArtifact && ["docker-model", "gateway-routing", "production-tui"].includes(state.lane)
      ? imageBuildDeadlineMs()
      : undefined;
  const importBudgetMs = importDeadlineMs === undefined ? undefined : importDeadlineMs - Date.now();
  if (importBudgetMs !== undefined && importBudgetMs < 1_000) {
    throw new Error("No time remains to import the runtime artifact before the test reserve.");
  }
  await commandAvailable(
    process.env.OCC_DOCKER_BIN ?? "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { timeoutMs: importBudgetMs },
  );

  const env: Record<string, string> = {};
  const resources: JournalResource[] = [];
  const label =
    state.lane === "images-packaging" && state.ciRun
      ? createHash("sha256")
          .update(JSON.stringify([state.ciRun.id, state.ciRun.attempt, state.prefix]))
          .digest("hex")
          .slice(0, 17)
      : state.prefix;
  const tagBase =
    registryOutput ?? `localhost/${ownedName("openclaw-ci-image", label, { maxLength: 48 })}`;
  const openclawSource = runtime ? process.env.OCC_K3D_OPENCLAW_SOURCE : undefined;
  if (runtimeArtifact && (!runtime || registryOutput || cacheWarm || openclawSource)) {
    throw new Error("A selected runtime artifact requires ordinary runtime image preparation.");
  }
  if (controller) {
    assertNodeBaseImage(nodeBaseImage);
  }
  if (openclawSource !== undefined) {
    if (!isAbsolute(openclawSource) || !(await stat(join(openclawSource, "Dockerfile"))).isFile()) {
      throw new Error("OCC_K3D_OPENCLAW_SOURCE must select an absolute OpenClaw source checkout");
    }
    if (!/^[a-f0-9]{40,64}$/u.test(process.env.OCC_K3D_OPENCLAW_COMMIT ?? "")) {
      throw new Error("OCC_K3D_OPENCLAW_COMMIT must identify the selected OpenClaw source");
    }
  }
  type Build = {
    role: "controller" | "runtime";
    tag: string;
    args: string[];
    env: Record<string, string>;
    metadataFile?: string;
    resource?: JournalResource;
  };
  const builds: Build[] = [];
  if (controller) {
    const tag = `${tagBase}/controller:local`;
    builds.push({
      role: "controller",
      tag,
      args: [
        ...imageBuildArgs(state.lane, "controller", localStore),
        ...plainProgress,
        "--pull=false",
        "--target",
        controllerTarget,
        ...revisionArgs,
        "--build-arg",
        `NODE_BASE_IMAGE=${nodeBaseImage}`,
        "-t",
        tag,
        ".",
      ],
      env: { OCC_TEST_PRODUCTION_IMAGE: tag, OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: tag },
    });
  }
  if (runtime) {
    const tag = `${tagBase}/runtime:local`;
    const runtimeEnv = {
      OCC_TEST_RUNTIME_IMAGE: tag,
      OCC_DOCKER_RUNTIME_IMAGE: tag,
      OCC_DOCKER_GATEWAY_IMAGE: tag,
      OCC_DOCKER_AGENT_IMAGE: tag,
      OCC_TEST_KUBERNETES_RUNTIME_IMAGE: tag,
      ...(openclawSource === undefined
        ? {}
        : { OCC_K3D_OPENCLAW_COMMIT: process.env.OCC_K3D_OPENCLAW_COMMIT! }),
    };
    if (runtimeArtifact) {
      assertRuntimeArtifactTagAvailable(tag, importDeadlineMs);
      const resource = addResource(state, "image-tag", { name: tag, owner: state.prefix });
      resources.push(resource);
      await writeState(statePath, state);
      const loaded = await loadRuntimeArtifact({ ...runtimeArtifact, tag }, importDeadlineMs);
      try {
        await markResourceReady(statePath, state, resource);
        Object.assign(env, runtimeEnv);
      } finally {
        await loaded.cleanup();
      }
    } else {
      const sourceArguments =
        openclawSource === undefined ? openclawBuildArguments(await readOpenclawSource()) : [];
      builds.push({
        role: "runtime",
        tag,
        args:
          openclawSource === undefined
            ? [
                ...imageBuildArgs(state.lane, "runtime", localStore),
                ...plainProgress,
                ...revisionArgs,
                ...sourceArguments,
                "--pull=false",
                "-f",
                runtimeDockerfile,
                "-t",
                tag,
                repositoryRoot,
              ]
            : [
                ...localImageBuildArgs(localStore),
                ...plainProgress,
                "--build-arg",
                "OPENCLAW_DOCKER_BUILD_SKIP_DTS=1",
                "-t",
                tag,
                openclawSource,
              ],
        env: runtimeEnv,
      });
    }
  }
  // Registry output reuses compressed cached layers directly, without loading
  // and recompressing them through the host engine.
  for (const entry of builds) {
    if (registryOutput) {
      entry.metadataFile = join(dirname(statePath), `first-agent-${entry.role}-build.json`);
      entry.args = [
        ...entry.args.slice(0, 2),
        "--output",
        "type=image,push=true,registry.insecure=true",
        "--metadata-file",
        entry.metadataFile,
        ...entry.args.slice(2).filter((arg) => arg !== "--load"),
      ];
    } else {
      entry.resource = addResource(state, "image-tag", { name: entry.tag, owner: state.prefix });
      resources.push(entry.resource);
    }
  }
  await writeState(statePath, state);
  await prepareTogether(
    builds.map((entry) => async () => {
      if (registryOutput) {
        const result = await laneImageCommand(entry.role, entry.args);
        imageCacheObservation(state.lane, entry.role, "direct-publish", result.stderr, progress);
        const metadata = asRecord(parseJson(await readFile(entry.metadataFile!, "utf8")));
        const digest = metadata?.["containerimage.digest"];
        if (typeof digest !== "string") {
          throw new Error("First-Agent image export has no digest.");
        }
        const reference = `${entry.tag.slice(0, entry.tag.lastIndexOf(":"))}@${digest}`;
        assertImmutableImageReference(reference, "first-Agent image export");
        entry.env = Object.fromEntries(Object.keys(entry.env).map((name) => [name, reference]));
        await rm(entry.metadataFile!, { force: true });
      } else {
        await timedK3dModelPreparation(state.lane, entry.role, async () => {
          // The warm job builds every step so its export has them all.
          if (
            cacheWarm ||
            !reuseEngineImages ||
            !(await reuseEngineImage(state.lane, entry.role, entry.args, entry.tag, progress))
          ) {
            await build(entry.role, entry.args);
          }
        });
        await markResourceReady(statePath, state, entry.resource!);
      }
    }),
    buildConcurrency,
  );
  for (const entry of builds) {
    Object.assign(env, entry.env);
  }
  return { env, resourceIds: resources.map((resource) => resource.id) };
}

// Restore current-source image layers only. Local Setup still owns its cluster,
// installation, Agent workflow and teardown. The loopback registry is CI-owned.
async function prepareFirstAgentImages(
  statePath: string,
  state: CiState,
  env: Record<string, string>,
  file: string | undefined,
) {
  imageBuildArgs(state.lane, "runtime", false); // Validate the hosted cache boundary before resources.
  if (process.env.OCC_K3D_OPENCLAW_SOURCE) {
    throw new Error("First-Agent image preparation requires the checkout's pinned runtime source.");
  }
  const builder = process.env.OCC_CI_FIRST_AGENT_BUILDER;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(builder ?? "")) {
    throw new Error("First-Agent image preparation requires its selected job builder.");
  }
  const revision = (await execFile("git", ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  const compose = file === "tests/integration/local-first-agent-openshell-real.test.mjs";
  const nodeBaseImage = effectiveLaneEnv(state.lane, env).NODE_BASE_IMAGE;
  assertNodeBaseImage(nodeBaseImage);
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const port = await reserveLoopbackPort();
  const registry = addResource(state, "first-agent-image-registry", {
    name: ownedName("openclaw-ci-first-images", state.prefix, { maxLength: 63 }),
    port,
  });
  await writeState(statePath, state);
  await ensureDockerSourceImage(state, registryImage, "first-Agent registry image");
  const createdRegistry = await execFile(docker, [
    "run",
    "--detach",
    "--name",
    registry.name,
    "--label",
    `openclaw.dev/ci-owner=${state.prefix}`,
    "--publish",
    `127.0.0.1:${port}:5000`,
    registryImage,
  ]);
  const containerId = createdRegistry.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    throw new Error("Registry creation returned no container identity.");
  }
  registry.containerId = containerId;
  await writeState(statePath, state);
  const registryOrigin = `http://127.0.0.1:${port}`;
  const registryDeadline = Date.now() + 30_000;
  let registryReady = false;
  while (Date.now() < registryDeadline) {
    try {
      registryReady = (await fetch(`${registryOrigin}/v2/`, { signal: AbortSignal.timeout(1000) }))
        .ok;
    } catch {
      registryReady = false;
    }
    if (registryReady) {
      break;
    }
    await delay(250);
  }
  if (!registryReady) {
    throw new Error("First-Agent image registry did not become ready.");
  }
  const built = await timedPreparation(state.lane, "first-agent-images", () =>
    buildRuntimeImages(statePath, state, {
      controller: true,
      runtime: true,
      nodeBaseImage,
      revision,
      controllerTarget: compose ? "development" : "runtime",
      registryOutput: `127.0.0.1:${port}/${registry.name}`,
      // These two independent targets already share source/cache dependencies.
      // Keep the same two-build bound as ordinary image preparation.
      buildConcurrency: 2,
    }),
  );
  const selected = {
    controller: built.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE!,
    runtime: built.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE!,
  };
  for (const reference of Object.values(selected)) {
    const [name, digest] = reference.split("@") as [string, string];
    const repository = name.slice(name.indexOf("/") + 1);
    const readVerified = async (path: string, expected: string): Promise<unknown> => {
      const response = await fetch(`${registryOrigin}/v2/${repository}/${path}`, {
        headers: {
          accept:
            "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error("First-Agent image metadata is unavailable.");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        bytes.length > 4 * 1024 * 1024 ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected
      ) {
        throw new Error("First-Agent image metadata does not match its digest.");
      }
      return parseJson(bytes.toString("utf8"));
    };
    const manifest = asRecord(await readVerified(`manifests/${digest}`, digest));
    const configDigest = asRecord(manifest?.config)?.digest;
    if (
      typeof manifest?.mediaType !== "string" ||
      ![
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].includes(manifest.mediaType) ||
      typeof configDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(configDigest)
    ) {
      throw new Error("First-Agent images must select one immutable platform manifest.");
    }
    const config = asRecord(await readVerified(`blobs/${configDigest}`, configDigest));
    const labels = asRecord(asRecord(config?.config)?.Labels);
    if (
      labels?.["org.opencontainers.image.revision"] !== revision ||
      config?.os !== "linux" ||
      config.architecture !== (process.arch === "x64" ? "amd64" : process.arch)
    ) {
      throw new Error("First-Agent image does not match the checkout and runner platform.");
    }
  }
  if (compose) {
    // Record before Compose can pull it; cleanup removes only this owned digest.
    registry.controllerImage = selected.controller;
  }
  await markResourceReady(statePath, state, registry);
  env.NODE_BASE_IMAGE = nodeBaseImage;
  env.OCC_KUBERNETES_RUNTIME_IMAGE = selected.runtime;
  env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE = selected.runtime;
  env.OCC_DEVELOPMENT_IMAGE_REGISTRY_CONTAINER = registry.name;
  env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE = selected.controller;
  if (compose) {
    // Compose consumes the same verified development image for all five services.
    // The default local/setup-shard path still builds from the checkout.
    env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROLLER_IMAGE = selected.controller;
  } else {
    env.OCC_DEVELOPMENT_CONTROLLER_IMAGE = selected.controller;
  }
}

const nodeImages = createK3dNodeImages({
  execFile,
  boundedImageCommand,
  immutableDigest,
  progress,
  timedPreparation,
});

const preparationJournal: import("./k3d-preparation.ts").PreparationJournal = {
  addResource,
  writeState,
  markResourceReady,
};
const { ensurePostgresServer, createAndMigrateDatabase } = createPostgresPreparation(
  repositoryRoot,
  preparationJournal,
);
const { ensureK3dCluster, k3dStage } = createK3dPreparation({
  ...preparationJournal,
  progress,
  fixtureLanes,
  lanesWithoutK3sAddons,
  defaultK3sImage,
});
const { registerImageInK3d } = createK3dImageAdmission(
  preparationJournal,
  nodeImages,
  fixtureLanes,
);
const { k3dNodeImageCheck } = nodeImages;

const {
  verifyFixtureStorage,
  buildFixtureImage,
  importFixtureImage,
  prepareFixtureStorageAndImage,
  pinFixtureImageInK3d,
} = createK3dFixtureStorage({
  execFile,
  progress,
  k3dStage,
  timedPreparation,
  fixtureDockerContext,
  imageCommandTimeoutMs,
  imageBuildBudgetMs,
  imageBuildTestReserveMs,
  addResource,
  writeState,
  markResourceReady,
  registerImageInK3d,
});

async function retainRuntimeProvenance(
  statePath: string,
  state: CiState,
  cluster: K3dCluster,
  image: Awaited<ReturnType<typeof registerImageInK3d>>,
  role: string,
) {
  state.runtimeProvenance ??= {};
  const record: RuntimeRecord = {
    imageId: image.hostImageId,
    manifestDigest: `sha256:${immutableDigest(image.reference)}`,
    status: "unavailable",
  };
  const matching = Object.values(state.runtimeProvenance).find(
    (other) => other.imageId === record.imageId && other.manifestDigest === record.manifestDigest,
  );
  state.runtimeProvenance[role] = matching ? { ...matching } : record;
  async function command(
    _docker: "docker",
    args: string[],
    options?: import("../lib/image-file.ts").ImageFileTextOptions,
  ): Promise<string>;
  async function command(
    _docker: "docker",
    args: string[],
    options: import("../lib/image-file.ts").ImageFileArchiveOptions,
  ): Promise<Buffer>;
  async function command(
    _docker: "docker",
    args: string[],
    options:
      | import("../lib/image-file.ts").ImageFileTextOptions
      | import("../lib/image-file.ts").ImageFileArchiveOptions = {},
  ): Promise<string | Buffer> {
    try {
      const limits = {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL" as const,
        ...options,
      };
      if (options.encoding === "buffer") {
        return (
          await promisify(execFileCallback)(process.env.OCC_DOCKER_BIN ?? "docker", args, {
            ...limits,
            encoding: "buffer",
          })
        ).stdout;
      }
      return (
        await promisify(execFileCallback)(process.env.OCC_DOCKER_BIN ?? "docker", args, {
          ...limits,
          encoding: "utf8",
        })
      ).stdout;
    } catch (error) {
      const failure: NodeJS.ErrnoException = new Error("Runtime provenance image command failed.");
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") {
        failure.code = code;
      }
      throw failure;
    }
  }
  try {
    if (matching) {
      return;
    }
    let platform;
    try {
      const inspection = parseJson(
        await command("docker", ["image", "inspect", image.hostImageId]),
      );
      const inspected = asRecord(Array.isArray(inspection) ? inspection[0] : undefined);
      if (typeof inspected?.Os !== "string" || typeof inspected.Architecture !== "string") {
        return;
      }
      platform = `${inspected.Os}/${inspected.Architecture}`;
      const readBlob = async (digest: string) =>
        (
          await k3dNodeImageCheck(
            cluster.nodes[0]!,
            ["ctr", "-n", "k8s.io", "content", "get", digest],
            "containerd",
          )
        ).stdout;
      const selection = parseJson(
        await command("docker", ["image", "inspect", "--platform", platform, image.hostImageId]),
      );
      const selected: unknown = Array.isArray(selection) ? selection[0] : undefined;
      if (!configInspection(selected)) {
        return;
      }
      const config = await imageConfigDigest(selected, readBlob);
      const imported = asRecord(
        parseJson(
          (
            await k3dNodeImageCheck(
              cluster.nodes[0]!,
              ["crictl", "inspecti", image.reference],
              "CRI",
            )
          ).stdout,
        ),
      );
      if (
        typeof config !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(config) ||
        asRecord(imported?.status)?.id !== config
      ) {
        return;
      }
    } catch {
      // An unavailable or mismatched image binding is not a readiness gate.
      return;
    }
    const extraction = addResource(state, "image-file", {
      name: `${state.prefix}-provenance-${randomSuffix()}`,
    });
    const metadata = await readImageCodexProvenance({
      imageId: image.hostImageId,
      platform,
      directory: cluster.directory,
      resource: extraction,
      command,
      persist: () => writeState(statePath, state),
    });
    if (metadata) {
      Object.assign(record, { status: "available", ...metadata });
    }
  } finally {
    await writeState(statePath, state);
    // Publish before later preparation or test failures can remove the cluster.
    try {
      const path = `${statePath}.diagnostics.json`;
      const preparationId = preparationIdentity(state.prefix);
      let report: Record<string, unknown> = { lane: state.lane, preparationId };
      try {
        const previous = asRecord(parseJson(await readFile(path, "utf8")));
        if (previous?.lane === state.lane && previous.preparationId === preparationId) {
          report = previous;
        }
      } catch {
        /* First diagnostic for this lane. */
      }
      report.runtimeProvenance = await readRuntimeProvenance(statePath, {
        lane: state.lane,
        preparationId,
      });
      await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    } catch {
      progress(state.lane, "Runtime provenance diagnostics unavailable.");
    }
  }
}

type K3dRuntimeOptions = {
  buildController?: boolean;
  buildRuntime?: boolean;
  reuseEngineImages?: boolean;
  runtimeArtifact?: ReturnType<typeof runtimeArtifactSelection>;
};
async function prepareK3dRuntimeImages(
  statePath: string,
  state: CiState,
  cluster: PreparedCluster,
  env: Record<string, string>,
  {
    buildController = false,
    buildRuntime = false,
    reuseEngineImages = true,
    runtimeArtifact,
  }: K3dRuntimeOptions = {},
) {
  const needsController = buildController && !process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE;
  const needsRuntime =
    buildRuntime &&
    (!process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ||
      !process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE);
  if (needsController || needsRuntime) {
    const images = [
      needsController ? "controller" : undefined,
      needsRuntime
        ? process.env.OCC_K3D_OPENCLAW_SOURCE === undefined
          ? "gateway and Codex runtime"
          : "gateway and native OpenClaw runtime"
        : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    if (runtimeArtifact) {
      progress(
        state.lane,
        `Loading the shared gateway and Codex runtime artifact${needsController ? " and preparing the current controller image" : ""}.`,
      );
    } else {
      progress(
        state.lane,
        `Building the current ${images} image${needsController && needsRuntime ? "s" : ""}.`,
      );
    }
    const built = await timedK3dModelPreparation(state.lane, "image-build-or-reuse", () =>
      buildRuntimeImages(statePath, state, {
        controller: needsController,
        runtime: needsRuntime,
        nodeBaseImage: effectiveLaneEnv(state.lane, env).NODE_BASE_IMAGE,
        reuseEngineImages,
        runtimeArtifact,
      }),
    );
    Object.assign(env, built.env);
    if (needsRuntime) {
      env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE = built.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE!;
      env.OCC_TEST_KUBERNETES_AGENT_IMAGE = built.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE!;
    }
  }
  const inputs = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE:
      env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
    OCC_TEST_KUBERNETES_AGENT_IMAGE:
      env.OCC_TEST_KUBERNETES_AGENT_IMAGE ?? process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
  };
  requireEnv(Object.keys(inputs), inputs);
  progress(
    state.lane,
    process.env.OCC_K3D_OPENCLAW_SOURCE === undefined
      ? "Importing the gateway and Codex runtime images into k3d."
      : "Importing the native OpenClaw runtime image into k3d.",
  );
  for (const [name, value] of Object.entries(inputs)) {
    const image = await registerImageInK3d(statePath, state, cluster, value!, name);
    env[name] = image.reference;
    await retainRuntimeProvenance(statePath, state, cluster, image, name);
    if (name === "OCC_TEST_KUBERNETES_GATEWAY_IMAGE") {
      // Host relays need the Docker image, not the cluster's imported manifest reference.
      env.OCC_DOCKER_RUNTIME_IMAGE = image.hostImageId;
    }
  }
  if (buildController) {
    const controller = await registerImageInK3d(
      statePath,
      state,
      cluster,
      (env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE ??
        process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE)!,
      "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
    );
    env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE = controller.reference;
  }
  // Replace the build tag with its imported digest before publishing the next step's inputs.
  env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE = env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE!;
  // This focused journey deploys only embedded OpenClaw Agents. The full lane
  // still prepares Codex because its other files exercise dedicated execution.
  const embeddedOidcOnly =
    state.lane === "gateway-routing" &&
    state.selectedFile === "tests/integration/oidc-agent-chat-k3d-real.test.ts";
  if (
    lanePrepare(state.lane).codexSeccomp &&
    !embeddedOidcOnly &&
    process.env.OCC_K3D_OPENCLAW_SOURCE === undefined
  ) {
    progress(state.lane, "Deriving and installing the dedicated Codex seccomp profile.");
    const seccomp = await prepareCodexSeccompProfile({
      cluster,
      image: env.OCC_TEST_KUBERNETES_AGENT_IMAGE!,
      execFile,
      kubectl: cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl",
      codexVersion: await kubernetesCodexVersion(env),
    });
    env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE = seccomp.profileName;
    cluster.codexSeccompProfile = seccomp.profileName;
    cluster.codexSeccompProfiles = seccomp.nodes;
    await writeState(statePath, state);
  }
}

// The CI lane passes a cluster it created alongside the runtime image build.
async function prepareRuntimeSmokeCodexSeccompProfile(
  statePath: string,
  state: CiState,
  env: Record<string, string>,
  created?: PreparedCluster,
) {
  const cluster: PreparedCluster =
    created ??
    (await timedPreparation(state.lane, "k3d-create", () => ensureK3dCluster(statePath, state)));
  const runtimeImage = await timedPreparation(state.lane, "runtime-image-import", () =>
    registerImageInK3d(
      statePath,
      state,
      cluster,
      env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE!,
      "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
    ),
  );
  progress(
    state.lane,
    "Deriving the reviewed Codex seccomp profile for native runtime image smoke tests.",
  );
  const codexVersion = await kubernetesCodexVersion(env);
  const seccomp = await timedPreparation(state.lane, "codex-seccomp-profile", () =>
    prepareCodexSeccompProfile({
      cluster,
      image: runtimeImage.reference,
      execFile,
      kubectl: cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl",
      codexVersion,
    }),
  );
  if (!seccomp.dockerProfilePath || !isAbsolute(seccomp.dockerProfilePath)) {
    throw new Error("Codex seccomp preparation did not publish an absolute Docker profile path.");
  }
  env.OCC_TEST_CODEX_SECCOMP_PROFILE = seccomp.dockerProfilePath;
  env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE = seccomp.profileName;
  cluster.codexSeccompProfile = seccomp.profileName;
  cluster.codexSeccompProfiles = seccomp.nodes;
  cluster.codexDockerSeccompProfile = {
    path: seccomp.dockerProfilePath,
    sha256: seccomp.profileSha256,
  };
  await writeState(statePath, state);
}

async function prepareNativeWorkspaceEnvoyImage(state: CiState, env: Record<string, string>) {
  const image = effectiveLaneEnv("images-runtime-startup", env).OCC_TEST_WORKSPACE_ENVOY_IMAGE!;
  await ensureDockerSourceImage(state, image, "OCC_TEST_WORKSPACE_ENVOY_IMAGE");
  env.OCC_TEST_WORKSPACE_ENVOY_IMAGE = image;
}

// The release job owns a fresh state path. Refuse a prior reservation rather
// than adopting another attempt's resources. Cleanup uses the ordinary CI state.

export async function prepareStagingSigninCluster(path: string) {
  const state = baseState("staging-signin", path);
  await writeFile(path, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
  const cluster = await ensureK3dCluster(path, state);
  if (cluster.nodes.length !== 1 || cluster.nodes[0] !== `k3d-${cluster.name}-server-0`) {
    throw new Error("Staging sign-in requires a single owned k3d server.");
  }
  return cluster;
}

export async function prepareRuntimeImageSmoke({
  image,
  statePath,
  codexVersion,
}: {
  image: string;
  statePath: string;
  codexVersion?: string | undefined;
}) {
  assertDockerImageId(image, "Runtime smoke image");
  const path = normalizeStatePath(statePath);
  if (await readState(path)) {
    throw new Error(`CI state already exists at ${path}; run cleanup before runtime smoke.`);
  }
  const state = baseState("images-packaging", path);
  const tag = `localhost/${ownedName("openclaw-ci-image", state.prefix, { maxLength: 48 })}/runtime-smoke:local`;

  const env: Record<string, string> = {
    ...baseEnv(path, state),
    OCC_TEST_KUBERNETES_RUNTIME_IMAGE: tag,
  };
  if (codexVersion !== undefined) {
    env.OCC_TEST_KUBERNETES_CODEX_VERSION = codexVersion;
  }
  const resource = addResource(state, "image-tag", { name: tag });
  await writeState(path, state);
  try {
    // Import the caller's exact loaded config ID without rebuilding or pulling.
    await execFile(process.env.OCC_DOCKER_BIN ?? "docker", ["tag", image, tag]);
    await markResourceReady(path, state, resource);
    await prepareNativeWorkspaceEnvoyImage(state, env);
    await prepareRuntimeSmokeCodexSeccompProfile(path, state, env);
    await saveLaneEnv(path, state, env);
    return { env, cleanup: () => cleanupResourceIds(path) };
  } catch (error) {
    await cleanupResourceIds(path);
    throw error;
  }
}

async function prepareProductionImages(
  statePath: string,
  state: CiState,
  cluster: K3dCluster,
  env: Record<string, string>,
  {
    localStore = false,
    sourceImages,
    runtimeArtifact,
  }: {
    localStore?: boolean;
    sourceImages?: NodeJS.ProcessEnv | undefined;
    runtimeArtifact?: ReturnType<typeof runtimeArtifactSelection>;
  } = {},
) {
  if (sourceImages) {
    Object.assign(env, sourceImages);
  } else {
    const built = await buildRuntimeImages(statePath, state, {
      controller: true,
      runtime: true,
      nodeBaseImage: effectiveLaneEnv(state.lane, env).NODE_BASE_IMAGE,
      localStore,
      runtimeArtifact,
    });
    Object.assign(env, built.env);
  }
  env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE = (
    await registerImageInK3d(
      statePath,
      state,
      cluster,
      env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE!,
      "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
    )
  ).reference;
  env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE = (
    await registerImageInK3d(
      statePath,
      state,
      cluster,
      env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE!,
      "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
    )
  ).reference;
  requireEnv(["OCC_TEST_PRODUCTION_POSTGRES_IMAGE", "OCC_TEST_PRODUCTION_NODE_IMAGE"]);
  env.OCC_TEST_PRODUCTION_POSTGRES_IMAGE = (
    await registerImageInK3d(
      statePath,
      state,
      cluster,
      process.env.OCC_TEST_PRODUCTION_POSTGRES_IMAGE!,
      "OCC_TEST_PRODUCTION_POSTGRES_IMAGE",
    )
  ).reference;
  env.OCC_TEST_PRODUCTION_NODE_IMAGE = (
    await registerImageInK3d(
      statePath,
      state,
      cluster,
      process.env.OCC_TEST_PRODUCTION_NODE_IMAGE!,
      "OCC_TEST_PRODUCTION_NODE_IMAGE",
    )
  ).reference;
  for (const name of [
    "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
    "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
    "OCC_TEST_PRODUCTION_POSTGRES_IMAGE",
    "OCC_TEST_PRODUCTION_NODE_IMAGE",
  ]) {
    assertImmutableImageReference(env[name], name);
  }
}

function baseEnv(
  statePath: string,
  state: { prefix: string; env?: Record<string, string> | undefined },
): Record<string, string> {
  return {
    ...(state.env ?? {}),
    OPENCLAW_ENTERPRISE_CI_STATE: statePath,
    OPENCLAW_ENTERPRISE_CI_PREFIX: state.prefix,
  };
}

async function saveLaneEnv(statePath: string, state: CiState, env: Record<string, string>) {
  state.env = { ...env };
  await writeState(statePath, state);
}

async function prepareLaneLogging(
  statePath: string,
  state: CiState,
  env: Record<string, string>,
  cluster?: K3dCluster,
) {
  const logging = await prepareLogging({
    laneName: state.lane,
    cluster,
    execFile,
    registerResource: async (kind, details) => {
      const resource = addResource(state, kind, details);
      await writeState(statePath, state);
      return resource;
    },
  });
  Object.assign(env, logging.env);
  await markResourceReady(statePath, state, logging.resource as PreparationResource);
}

async function prepareLane({
  lane,
  statePath,
  file,
  cleanupOwner,
}: PrepareLaneOptions): Promise<PreparedLane> {
  if (
    cleanupOwner !== undefined &&
    (typeof cleanupOwner !== "string" || !/^[a-z0-9-]{1,128}$/.test(cleanupOwner))
  ) {
    throw new Error("Invalid CI cleanup owner.");
  }
  const name = assertLane(lane);
  const relativeFile = selectedLaneFile(name, file);
  const runtimeArtifact = runtimeArtifactSelection(process.env);
  if (runtimeArtifact) {
    if (
      ![
        "docker-model",
        "gateway-routing",
        "production-tui",
        "images-packaging",
        "images-runtime-startup",
        "images-runtime-startup-2",
        "images-runtime-startup-3",
      ].includes(name)
    ) {
      throw new Error(
        "Runtime artifacts are supported only by Docker Model Runtime, Gateway Routing, Production TUI and the ordinary image lanes.",
      );
    }
    const conflictingImages = [];
    if (name === "gateway-routing") {
      conflictingImages.push(
        "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
        "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      );
    } else if (name === "production-tui") {
      conflictingImages.push(...Object.keys(productionUpgradeImages));
    }
    if (conflictingImages.some((variable) => process.env[variable])) {
      throw new Error(
        "A runtime artifact cannot be combined with selected Gateway or TUI upgrade images.",
      );
    }
    if (process.env.OCC_K3D_OPENCLAW_SOURCE) {
      throw new Error("A runtime artifact cannot be combined with OCC_K3D_OPENCLAW_SOURCE.");
    }
  }
  validateLaneInputsBeforeSideEffects(name, { file: relativeFile });
  // The lane receives source inputs. File preparation later receives its
  // chart paths and imported image references through the prepared environment.
  if (isOpenShellLane(name) && !lanePrepare(name).selfProvisionedFiles.includes(relativeFile!)) {
    await validateOpenShellSelection(effectiveLaneEnv(name), execFile);
  }
  const resolvedStatePath = normalizeStatePath(statePath);
  const existingState = await readState(resolvedStatePath);
  if (existingState) {
    throw new Error(
      `CI state already exists at ${resolvedStatePath}; run cleanup before preparing ${name}.`,
    );
  }
  const state = baseState(name, resolvedStatePath);
  state.selectedFile = relativeFile;
  if (cleanupOwner !== undefined) {
    state.cleanupOwner = cleanupOwner;
  }
  const env = baseEnv(resolvedStatePath, state);
  await persistState(resolvedStatePath, state, { exclusive: true });

  const sourceBuild = lanePrepare(name).sourceBuildFiles?.some((path) =>
    relativeFile === undefined
      ? laneDefinition(name).files.some((file) => file.path === path)
      : path === relativeFile,
  );
  const fullOpenShellSourceBuild =
    process.env.OCC_CI_IMAGE_CACHE === "1" &&
    sourceBuild &&
    isOpenShellLane(name) &&
    relativeFile === undefined;
  if (process.env.OCC_CI_IMAGE_CACHE === "1" && sourceBuild) {
    // Prime the selected builder, but keep the installer's actual source-build path.
    // Cache credentials remain in preparation; tests inherit only the builder name.
    const builder = process.env.BUILDX_BUILDER;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(builder ?? "")) {
      throw new Error("Installer image preparation requires its selected job builder.");
    }
    // Full OpenShell lanes populate the same builder during their shared stack
    // preparation below; focused source-build files have no shared stack.
    if (!fullOpenShellSourceBuild) {
      await timedPreparation(name, "installer-source-images", () =>
        buildRuntimeImages(resolvedStatePath, state, {
          controller: true,
          runtime: true,
          nodeBaseImage: effectiveLaneEnv(name, env).NODE_BASE_IMAGE,
          // An engine tag does not populate the selected builder's layer cache.
          reuseEngineImages: false,
        }),
      );
    }
    env.BUILDX_BUILDER = builder!;
    // WORKDIR cache keys include this value; match the preparation build so the
    // installer reuses its layers instead of rebuilding with an unset epoch.
    env.SOURCE_DATE_EPOCH = "0";
  }

  switch (name) {
    case "postgres":
    case "postgres-application":
    case "postgres-auth":
    case "postgres-platform":
      // Verify the same workspace that the file's migrator will use.
      await execFile(process.env.OPENCLAW_CI_COREPACK_BIN ?? "corepack", [
        "pnpm",
        "exec",
        "node",
        "--version",
      ]);
      await ensurePostgresServer(resolvedStatePath, state);
      break;
    case "keycloak-oidc": // Browser sign-in composes the production API on PostgreSQL.
      await ensurePostgresServer(resolvedStatePath, state);
      break;
    case "runtime-image-fixture":
      // The test builds and owns its own unique image on the job's engine.
      // Do not register it with generic force-removal cleanup.
      env.OCC_RUNTIME_IMAGE_RECEIPT = join(
        dirname(resolvedStatePath),
        "runtime-image-fixture-receipt.json",
      );
      break;
    case "images-runtime-startup":
    case "images-runtime-startup-2":
    case "images-runtime-startup-3": {
      // Runtime image smoke tests run apart from packaging, in three lanes, to
      // shorten CI wall time. Only the lane whose tests run the Codex sandbox
      // sets codexSeccomp; the others skip the k3d cluster it needs. The
      // cluster needs no image, so it is created while the image builds.
      const codexSeccomp = lanePrepare(name).codexSeccomp;
      const [built, cluster] = await timedPreparation(name, "runtime-image-build-cluster", () =>
        prepareTogether([
          () =>
            timedPreparation(name, "runtime-image-build", () =>
              buildRuntimeImages(resolvedStatePath, state, { runtime: true, runtimeArtifact }),
            ),
          ...(codexSeccomp
            ? [
                () =>
                  timedPreparation(name, "k3d-create", () =>
                    ensureK3dCluster(resolvedStatePath, state),
                  ),
              ]
            : []),
        ]),
      );
      Object.assign(env, built.env);
      if (name === "images-runtime-startup") {
        await timedPreparation(name, "workspace-envoy-image", () =>
          prepareNativeWorkspaceEnvoyImage(state, env),
        );
      }
      if (codexSeccomp) {
        await prepareRuntimeSmokeCodexSeccompProfile(resolvedStatePath, state, env, cluster);
      }
      break;
    }
    case "images-packaging":
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await commandAvailable(process.env.OCC_YQ_BIN ?? "yq", ["--version"]);
      Object.assign(
        env,
        (
          await timedPreparation(name, "controller-runtime-image-build", () =>
            buildRuntimeImages(resolvedStatePath, state, {
              controller: true,
              runtime: true,
              runtimeArtifact,
              nodeBaseImage: effectiveLaneEnv(name, env).NODE_BASE_IMAGE,
            }),
          )
        ).env,
      );
      // BuildKit's base-image cache is not Docker's runnable image store.
      env.OCC_TEST_CODEX_PROBE_IMAGE = await ensureDockerSourceImage(
        state,
        effectiveLaneEnv(name, env).NODE_BASE_IMAGE!,
        "NODE_BASE_IMAGE",
      );
      break;
    case "repository-credentials-container":
      Object.assign(
        env,
        await prepareRepositoryCredentials({
          repositoryRoot,
          ...repositoryCredentialsImageJournal(resolvedStatePath, state),
          receiptPath: join(dirname(resolvedStatePath), "repository-credentials-images.json"),
          execFile,
        }),
      );
      break;
    case "k3d-fixture-configuration":
    case "k3d-fixture-state":
    case "k3d-fixture-network":
    case "k3d-fixture-plugins": {
      // Publish PostgreSQL's daemon-assigned port before k3d probes its fixed API
      // port. The independent image build can overlap both resource startups.
      const [cluster, built] = await timedPreparation(name, "postgres-cluster-fixture-build", () =>
        prepareTogether([
          async () => {
            await timedPreparation(name, "postgres-start", () =>
              ensurePostgresServer(resolvedStatePath, state),
            );
            return timedPreparation(name, "k3d-create", () =>
              ensureK3dCluster(resolvedStatePath, state),
            );
          },
          () =>
            timedPreparation(name, "fixture-image-build", () =>
              buildFixtureImage(resolvedStatePath, state),
            ),
        ]),
      );
      const fixture = await timedPreparation(name, "fixture-storage-image-import", () =>
        prepareFixtureStorageAndImage(resolvedStatePath, state, cluster, built),
      );
      // The pin and the storage check are independent; both wait on rollouts.
      await timedPreparation(name, "fixture-pin-storage-verify", () =>
        prepareTogether([
          // Fixture suites use the same local-only image. Keep it active on
          // every node so kubelet image garbage collection cannot remove it.
          () =>
            timedPreparation(name, "fixture-image-pin", () =>
              pinFixtureImageInK3d(cluster, fixture.image),
            ),
          // The suites restart this controller when enabling shared storage. Verify
          // replacement scheduling after image imports consume the runner's disk.
          async () => {
            await execFile(
              process.env.OCC_KUBECTL_BIN ?? "kubectl",
              [
                "--kubeconfig",
                cluster.kubeconfig,
                "--context",
                cluster.context,
                "--namespace",
                "kube-system",
                "rollout",
                "restart",
                "deployment/local-path-provisioner",
              ],
              { timeoutMs: 10_000 },
            );
            await timedPreparation(name, "fixture-storage-verify", () =>
              verifyFixtureStorage(cluster),
            );
          },
        ]),
      );
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      env.OCC_TEST_KUBERNETES_IMAGE = fixture.image;
      env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS = cluster.pluginStatusProxyCidrs!;
      break;
    }
    case "k3d-observability": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      const inputs = effectiveLaneEnv(name, env);
      const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
      const { loadYaml } = require("@kubernetes/client-node");
      const production = loadYaml(
        await readFile(join(repositoryRoot, "deploy/helm/openclaw-enterprise/values.yaml"), "utf8"),
      );
      const externalImages = {
        OCC_TEST_PRODUCTION_NODE_IMAGE: inputs.NODE_BASE_IMAGE,
        OCC_TEST_PRODUCTION_POSTGRES_IMAGE: inputs.OCC_TEST_PRODUCTION_POSTGRES_IMAGE,
        OCC_TEST_OBSERVABILITY_COLLECTOR_IMAGE: production.logging.collector.image,
      };
      const [cluster, built, , fixture, serviceTag] = await timedPreparation(
        name,
        "cluster-build-pull",
        () =>
          prepareTogether([
            () => ensureK3dCluster(resolvedStatePath, state),
            async () => {
              await ensureDockerSourceImage(state, inputs.NODE_BASE_IMAGE!, "NODE_BASE_IMAGE");
              return buildRuntimeImages(resolvedStatePath, state, {
                controller: true,
                nodeBaseImage: inputs.NODE_BASE_IMAGE,
                localStore: true,
              });
            },
            () =>
              prepareTogether(
                Object.entries(externalImages)
                  .filter(([, image]) => image !== inputs.NODE_BASE_IMAGE)
                  .map(
                    ([variable, image]) =>
                      () =>
                        ensureDockerSourceImage(state, image!, variable),
                  ),
                2,
              ),
            () => buildFixtureImage(resolvedStatePath, state),
            () =>
              prepareRepositoryCredentials({
                repositoryRoot,
                ...repositoryCredentialsImageJournal(resolvedStatePath, state),
                execFile,
                serviceOnly: true,
              }),
          ]),
      );
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      // Keep imports into this cluster serial: images that share layers may
      // contend for the same containerd content. The pulls and
      // builds above overlap. Each import still verifies the immutable
      // reference through CRI on every node.
      await timedPreparation(name, "workload-image-imports", () =>
        prepareTogether(
          [
            async () => {
              env.OCC_TEST_KUBERNETES_IMAGE = (
                await importFixtureImage(resolvedStatePath, state, cluster, fixture)
              ).image;
              await pinFixtureImageInK3d(cluster, env.OCC_TEST_KUBERNETES_IMAGE);
            },
            ...Object.entries({
              OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: built.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
              OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE: serviceTag,
              ...externalImages,
            }).map(([variable, image]) => async () => {
              progress(name, `Importing ${variable}.`);
              env[variable] = (
                await registerImageInK3d(resolvedStatePath, state, cluster, image, variable)
              ).reference;
            }),
          ],
          1,
        ),
      );
      break;
    }
    case "k3d-observability-demo": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      const inputs = effectiveLaneEnv(name, env);
      const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
      const { loadYaml } = require("@kubernetes/client-node");
      const demo = loadYaml(
        await readFile(
          join(repositoryRoot, "deploy/helm/openclaw-observability-demo/values.yaml"),
          "utf8",
        ),
      );
      const images = {
        // Start the larger service first; pulls still overlap before imports run serially.
        OCC_TEST_OBSERVABILITY_GRAFANA_IMAGE: demo.images.grafana,
        OCC_TEST_OBSERVABILITY_PROMETHEUS_IMAGE: demo.images.prometheus,
        OCC_TEST_OBSERVABILITY_LOKI_IMAGE: demo.images.loki,
        OCC_TEST_PRODUCTION_NODE_IMAGE: inputs.NODE_BASE_IMAGE,
      };
      const [cluster] = await timedPreparation(name, "cluster-and-pulls", () =>
        prepareTogether([
          () => ensureK3dCluster(resolvedStatePath, state),
          () =>
            prepareTogether(
              Object.entries(images).map(
                ([variable, image]) =>
                  () =>
                    ensureDockerSourceImage(state, image!, variable),
              ),
              2,
            ),
        ]),
      );
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      // Keep imports into this cluster serial (shared layers may contend for
      // the same containerd content) even though the pulls above overlap.
      await timedPreparation(name, "demo-image-imports", () =>
        prepareTogether(
          Object.entries(images).map(([variable, image]) => async () => {
            progress(name, `Importing ${variable}.`);
            env[variable] = (
              await registerImageInK3d(resolvedStatePath, state, cluster, image, variable)
            ).reference;
          }),
          1,
        ),
      );
      break;
    }
    case "docker-model":
      Object.assign(
        env,
        (await buildRuntimeImages(resolvedStatePath, state, { runtime: true, runtimeArtifact }))
          .env,
      );
      await prepareLaneLogging(resolvedStatePath, state, env);
      break;
    case "k3d-model":
    case "slack":
    case "k3d-otel":
    case "gateway-routing": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      const cluster = await prepareK3dModelLane(resolvedStatePath, state, env, {
        buildController: true,
        buildRuntime: true,
        runtimeArtifact,
      });
      const routing = await timedK3dModelPreparation(name, "gateway-routing", () =>
        prepareGatewayRouting({ cluster, execFile }),
      );
      Object.assign(env, routing.env);
      if (name === "k3d-otel") {
        await prepareLaneLogging(resolvedStatePath, state, env, cluster);
      }
      break;
    }
    case "production-tui": {
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await ensureK3dCluster(resolvedStatePath, state);
      env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
      env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
      const inputs = effectiveLaneEnv(name, env);
      const upgradeSelected = Object.keys(productionUpgradeImages).some(
        (variable) => inputs[variable],
      );
      const sourceImages = upgradeSelected
        ? {
            OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: inputs.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
            OCC_TEST_KUBERNETES_RUNTIME_IMAGE: inputs.OCC_TEST_KUBERNETES_RUNTIME_IMAGE,
          }
        : undefined;
      await prepareProductionImages(resolvedStatePath, state, cluster, env, {
        sourceImages,
        runtimeArtifact,
      });
      if (upgradeSelected) {
        for (const [variable, baseline] of Object.entries(productionUpgradeImages)) {
          const imported = await registerImageInK3d(
            resolvedStatePath,
            state,
            cluster,
            inputs[variable]!,
            variable,
          );
          const baselineImage = state.resources.find(
            (resource) => resource.kind === "k3d-image" && resource.reference === env[baseline],
          );
          if (!baselineImage || imported.hostImageId === baselineImage.hostImageId) {
            throw new Error(`${variable} must contain a different image from ${baseline}.`);
          }
          env[variable] = imported.reference;
        }
      }
      await prepareLaneLogging(resolvedStatePath, state, env, cluster);
      break;
    }
    case "openshell-installers":
    case "openshell-policy":
    case "openshell": {
      // These files exercise the installer in their own Local Setup. Preparing a
      // second stack here builds the same images and installs unused services.
      if (lanePrepare(name).selfProvisionedFiles.includes(relativeFile!)) {
        if (
          process.env.OCC_CI_IMAGE_CACHE === "1" &&
          !lanePrepare(name).sourceBuildFiles?.includes(relativeFile!)
        ) {
          await prepareFirstAgentImages(resolvedStatePath, state, env, relativeFile);
        }
        break;
      }
      await commandAvailable(process.env.OCC_HELM_BIN ?? "helm", ["version", "--short"]);
      await ensurePostgresServer(resolvedStatePath, state);
      const cluster = await prepareK3dModelLane(resolvedStatePath, state, env, {
        buildController: true,
        buildRuntime: true,
        reuseEngineImages: !fullOpenShellSourceBuild,
      });
      const routing = await prepareGatewayRouting({ cluster, execFile });
      Object.assign(env, routing.env);
      Object.assign(
        env,
        await prepareOpenShell({
          cluster,
          execFile,
          env: { ...process.env, ...env },
          registerImage: (image, name, nativeSelection) =>
            registerImageInK3d(
              resolvedStatePath,
              state,
              cluster,
              image,
              name,
              nativeSelection,
            ).then((registered) => registered.reference),
        }),
      );
      const agentSandbox = state.resources.find(
        (resource) =>
          resource.kind === "k3d-image" &&
          resource.cluster === cluster.name &&
          resource.envName === "Agent Sandbox controller" &&
          resource.status === "ready",
      );
      if (!agentSandbox) {
        throw new Error("Agent Sandbox preparation did not record its imported image.");
      }
      const maxVerificationOutput = 4 * 1024 * 1024;
      await verifyPreloadedAgentSandbox({
        execFile: async (file, args) => {
          const output = await execFile(file, args, {
            timeoutMs: imageCommandTimeoutMs,
            maxOutputChars: maxVerificationOutput,
          });
          // This wrapper retains only the tail at its cap. Never validate a
          // truncated response, even if that tail happens to be valid JSON.
          if (
            output.stdout.length >= maxVerificationOutput ||
            output.stderr.length >= maxVerificationOutput
          ) {
            throw new Error("Agent Sandbox verification output exceeded its limit.");
          }
          return output;
        },
        kubectlCommand: env.OCC_KUBECTL_BIN ?? "kubectl",
        kubectl: ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context],
        engine: process.env.OCC_DOCKER_BIN ?? "docker",
        ownedNodes: cluster.nodes,
        source: agentSandbox.sourceImage!,
        reference: agentSandbox.reference!,
      });
      // The OAuth2 refresh proof's Keycloak: pulled here with pullImage's retry and
      // imported, so the cluster never pulls it from the registry.
      env.OCC_TEST_KEYCLOAK_IMAGE = (
        await timedPreparation(name, "keycloak-image-import", async () =>
          registerImageInK3d(
            resolvedStatePath,
            state,
            cluster,
            effectiveLaneEnv(name, env).OCC_TEST_KEYCLOAK_IMAGE || (await readKeycloakImage()),
            "OCC_TEST_KEYCLOAK_IMAGE",
          ),
        )
      ).reference;
      break;
    }
    case "logging-collector": {
      // The tests start these containers themselves under 60–120 s command
      // timeout, so pull the pinned images here, where a slow or failed pull
      // is retried. An unpinned local override is still pulled by the test.
      let collectorImage;
      try {
        collectorImage = await readDefaultCollectorImage();
      } catch (error) {
        // The prepare step fails before the image pulls start.
        await recordLoggingSetupTiming("image-pulls", "skipped");
        throw error;
      }
      const images = {
        OCC_TEST_LOGGING_COLLECTOR_IMAGE: collectorImage,
        OCC_TEST_LOGGING_NODE_IMAGE: effectiveLaneEnv(name, env).OCC_TEST_LOGGING_NODE_IMAGE,
        ...metricsMonitoringImages,
      };
      // A rejected prerequisite rules out this lane. Drain active acquisitions,
      // but don't spend another pull/retry budget on a still-queued image.
      let failed = false;
      await timedPreparation(name, "image-pulls", () =>
        prepareTogether(
          Object.entries(images)
            .filter(([, image]) => immutableDigest(image!))
            .map(([variable, image]) => async () => {
              if (failed) {
                return;
              }
              try {
                await ensureDockerSourceImage(state, image!, variable);
              } catch (error) {
                failed = true;
                throw error;
              }
            }),
          2,
        ),
      );
      break;
    }
    case "qa-matrix":
      // On a hosted runner, record the starting images so cleanup can return the
      // shared image store to them (lane-images.ts, finding 1345). A workstation's
      // launcher tags are the developer's own and stay as the run leaves them. A
      // failed inventory only skips that: the QA run itself does not need it.
      if (process.env.GITHUB_ACTIONS === "true") {
        let images;
        try {
          images = await imageInventory({
            execFile: (command, args) =>
              execFile(command, args, { timeoutMs: imageCommandTimeoutMs }),
            docker: process.env.OCC_DOCKER_BIN ?? "docker",
          });
        } catch (error) {
          console.log(
            `::warning::QA image baseline skipped: ${String((error as Error).message).split("\n")[0]}`,
          );
        }
        if (images) {
          addResource(state, laneImagesResourceKind, { name, images, status: "ready" });
          await writeState(resolvedStatePath, state);
        }
      }
      break;
    case "helper-timeout":
      break;
  }

  if (lanePrepare(name).keycloak) {
    const keycloak = await timedPreparation(name, "keycloak-start", () =>
      prepareKeycloak({
        stateDirectory: dirname(resolvedStatePath),
        name: ownedName("openclaw-ci-kc", state.prefix, { maxLength: 63 }),
        execFile,
        docker: process.env.OCC_DOCKER_BIN ?? "docker",
        ensureImage: (image) => ensureDockerSourceImage(state, image, "Keycloak image"),
        reservePort: reserveLoopbackPort,
        registerResource: async (details) => {
          const resource = addResource(state, keycloakResourceKind, details);
          await writeState(resolvedStatePath, state);
          return resource;
        },
        saveState: () => writeState(resolvedStatePath, state),
      }),
    );
    const existingCaPath = env.NODE_EXTRA_CA_CERTS;
    Object.assign(env, keycloak.env);
    if (existingCaPath && existingCaPath !== env.NODE_EXTRA_CA_CERTS) {
      // The same test process verifies both private Gateway TLS and the IdP.
      const certificates = await Promise.all([
        readFile(existingCaPath, "utf8"),
        readFile(env.NODE_EXTRA_CA_CERTS!, "utf8"),
      ]);
      const combinedCaPath = join(dirname(resolvedStatePath), "combined-test-ca.pem");
      await writeFile(combinedCaPath, certificates.join("\n"), { mode: 0o600 });
      env.NODE_EXTRA_CA_CERTS = combinedCaPath;
    }
    await markResourceReady(resolvedStatePath, state, keycloak.resource);
  }

  const defaults = laneDefaults(name, env);
  state.defaults = defaults;
  await saveLaneEnv(resolvedStatePath, state, env);
  return {
    env: { ...defaults, ...env },
    cleanup: async () => cleanupResourceIds(resolvedStatePath),
  };
}

async function prepareK3dModelLane(
  statePath: string,
  state: CiState,
  env: Record<string, string>,
  options: K3dRuntimeOptions,
) {
  const cluster = await timedK3dModelPreparation(state.lane, "k3d-cluster-preparation", () =>
    ensureK3dCluster(statePath, state),
  );
  // Register PostgreSQL after the cluster so cleanup removes its attached
  // container before k3d removes the network. Test files preserve this attachment.
  await timedK3dModelPreparation(state.lane, "postgres-start", () =>
    ensurePostgresServer(statePath, state),
  );
  env.OCC_TEST_KUBERNETES_KUBECONFIG = cluster.kubeconfig;
  env.OCC_TEST_KUBERNETES_CONTEXT = cluster.context;
  if (cluster.pluginStatusProxyCidrs !== undefined) {
    env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS = cluster.pluginStatusProxyCidrs!;
  }
  if (cluster.kubectl) {
    env.OCC_KUBECTL_BIN = cluster.kubectl;
  }
  await timedK3dModelPreparation(state.lane, "runtime-image-preparation", () =>
    prepareK3dRuntimeImages(statePath, state, cluster, env, options),
  );
  return cluster;
}

// `template` (optional) is an OCC_TEST_DATABASE_URL that an earlier prepareFile call
// returned for this state. The file's database is then a copy of that database
// (CREATE DATABASE ... TEMPLATE) instead of a copy of the lane template. The worker
// revision suite copies the database the runner prepared for its file, one copy per test.
// Defaults remain overridable by a file; env contains preparation-owned outputs.

async function prepareFile({
  lane,
  file,
  statePath,
  template,
  modelSelectors,
  requireJournal,
}: PrepareFileOptions & { requireJournal?: RequireJournal | undefined }): Promise<PreparedFile> {
  const name = assertLane(lane);
  if (!file) {
    throw new Error("prepareFile requires a file.");
  }
  const relativeFile = normalizeFile(file);
  validateLaneInputsBeforeSideEffects(name, { file: relativeFile, modelSelectors });
  const resolvedStatePath = normalizeStatePath(statePath);
  // A test may prepare databases from its own process while the runner prepares and
  // cleans other files. The lock keeps either side from writing back a stale state.
  return withStateLock(resolvedStatePath, () =>
    prepareFileWithState({ name, relativeFile, resolvedStatePath, template, requireJournal }),
  );
}

async function prepareFileWithState({
  name,
  relativeFile,
  resolvedStatePath,
  template,
  requireJournal,
}: {
  name: string;
  relativeFile: string;
  resolvedStatePath: string;
  template: string | undefined;
  requireJournal: RequireJournal | undefined;
}): Promise<PreparedFile> {
  requireJournal?.(true);
  const state = await readState(resolvedStatePath);
  requireJournal?.(state !== undefined);
  const prepare = lanePrepare(name);
  if (suiteView === "full-integration" && isOpenShellLane(name)) {
    if (
      state?.lane !== name ||
      !laneDefinition(name).files.some(({ path }) => path === relativeFile)
    ) {
      throw new Error("OpenShell file must match its prepared Full Integration lane.");
    }
  }
  if (state?.selectedFile !== undefined && state.selectedFile !== relativeFile) {
    throw new Error("Selected file must match the prepared lane state.");
  }
  if (!state && prepare.requiresPreparedStateForFile) {
    throw new Error(
      `prepareFile for ${name} requires a prior prepareLane call using the same state path.`,
    );
  }
  if (template !== undefined && (!prepare.postgres || !state)) {
    throw new Error("A template database requires a prepared PostgreSQL lane state.");
  }
  const effectiveState = state ?? baseState(name, resolvedStatePath);
  const env = baseEnv(resolvedStatePath, effectiveState);
  const resourceIds: string[] = [];

  if (name === "production-tui" && state) {
    const inputs = effectiveLaneEnv(name);
    const variables = Object.keys(productionUpgradeImages);
    const selected = variables.some((variable) => inputs[variable]);
    const prepared = variables.some((variable) => state.env?.[variable]);
    if (state.lane !== name || selected !== prepared) {
      throw new Error("Production upgrade inputs must match the prepared lane state.");
    }
    if (selected) {
      for (const variable of [...Object.values(productionUpgradeImages), ...variables]) {
        if (
          !state.resources.some((resource) => {
            const details = asRecord(resource);
            return (
              details?.kind === "k3d-image" &&
              details.sourceImage === inputs[variable] &&
              details.reference === state.env?.[variable] &&
              details.status === "ready"
            );
          })
        ) {
          throw new Error(`${variable} must match the prepared lane state.`);
        }
      }
    }
  }

  if (name === "repository-credentials-container") {
    if (state?.lane !== name) {
      throw new Error("Repository credential images require their own lane state.");
    }
    if (!repositoryCredentialsFileNeedsBinary(relativeFile)) {
      return {
        defaults: laneDefaults(name, { ...state.defaults, ...env }),
        env,
        cleanup: null,
      };
    }
    const prepared = await prepareRepositoryCredentialsFile({
      clientImage: env.REPOSITORY_CREDENTIALS_CLIENT_IMAGE,
      execFile,
    });
    return {
      defaults: laneDefaults(name, { ...state.defaults, ...env }),
      env: { ...env, ...prepared.env },
      cleanup: prepared.cleanup,
    };
  }

  if (relativeFile === "tests/integration/ci-prepare-postgres-real.test.ts") {
    // The runner survives a killed test worker. Journal both child state paths
    // before handing them to the test, so file or lane cleanup can recover them.
    const children = Array.from({ length: 2 }, () => {
      const name = `${effectiveState.prefix}-child-${randomSuffix()}`;
      const resource = addResource(effectiveState, "child-state", { name });
      resourceIds.push(resource.id);
      return { path: join(dirname(resolvedStatePath), `${name}.json`), owner: resource.id };
    });
    await writeState(resolvedStatePath, effectiveState);
    env.OCC_TEST_CI_POSTGRES_STATES = JSON.stringify(children);
  }

  if (prepare.postgres && !prepare.selfProvisionedFiles?.includes(relativeFile)) {
    const dbKind = prepare.k3d ? "k8s" : "ci";
    const database = await createAndMigrateDatabase(resolvedStatePath, effectiveState, {
      kind: dbKind,
      label: fileStem(relativeFile),
      requireExistingServer: true,
      template,
    });
    resourceIds.push(database.resourceId);
    env.OCC_TEST_DATABASE_URL = database.appUrl;
    if (
      [
        "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs",
        "tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts",
        "tests/integration/openshell-plugin-install-real.test.ts",
        "tests/integration/openshell-gateway-tool-policy-real.test.ts",
        "tests/integration/openshell-refresh-real.test.ts",
        "tests/integration/openshell-upstream-real.test.ts",
        "tests/integration/openshell-credentials-real.test.ts",
        "tests/integration/openshell-withdrawal-real.test.ts",
      ].includes(relativeFile)
    ) {
      env.OCC_TEST_OPENSHELL_POLICY_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (name === "postgres-application" && relativeFile === nativeIAMBarrierFile) {
      env.OCC_TEST_NATIVE_IAM_BARRIER_CI = "1";
      env.OCC_TEST_NATIVE_IAM_BARRIER_DATABASE = database.name;
      env.OCC_TEST_NATIVE_IAM_BARRIER_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (relativeFile === "tests/integration/occ-metrics.test.ts") {
      env.OCC_METRICS_TEST_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (relativeFile === "tests/integration/postgres-api-request-audit.test.ts") {
      env.OCC_TEST_API_REQUEST_AUDIT_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (relativeFile === "tests/integration/postgres-static-token-service-lifecycle.test.ts") {
      env.OCC_TEST_STATIC_TOKEN_SERVICE_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (relativeFile === "tests/integration/postgres-agent-audit-read.test.ts") {
      env.OCC_TEST_AGENT_AUDIT_READ_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (relativeFile === "tests/integration/postgres-worker-audit.test.ts") {
      env.OCC_TEST_WORKER_AUDIT_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
    if (
      relativeFile === "tests/integration/auth-maintain.test.ts" ||
      relativeFile === "tests/integration/postgres-break-glass-auth-maintain.test.ts"
    ) {
      env.OCC_AUTH_MAINTAIN_MIGRATION_DATABASE_URL = database.migrationUrl;
    }
  }

  if (relativeFile.endsWith("postgres-bootstrap-failures.test.ts")) {
    const failures = await createAndMigrateDatabase(resolvedStatePath, effectiveState, {
      kind: "failures",
      label: fileStem(relativeFile),
      requireExistingServer: true,
    });
    resourceIds.push(failures.resourceId);
    env.OCC_BOOTSTRAP_FAILURE_DATABASE_URL = failures.appUrl;
    env.OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL = failures.migrationUrl;
  }

  if (relativeFile.endsWith("postgres-production-wireup.test.ts")) {
    const production = await createAndMigrateDatabase(resolvedStatePath, effectiveState, {
      kind: "ci",
      label: `${fileStem(relativeFile)}_production`,
      requireExistingServer: true,
    });
    resourceIds.push(production.resourceId);
    env.OCC_PRODUCTION_WIREUP_DATABASE_URL = production.appUrl;
  }

  const defaults = laneDefaults(name, { ...state?.defaults, ...env });

  if (name === "dev-up-k3d") {
    await prepareDevUpImage(
      env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? defaults.OCC_TEST_DEV_UP_CONTAINER_ENGINE,
    );
  }

  if (state) {
    await writeState(resolvedStatePath, effectiveState);
  }
  return {
    defaults,
    env,
    // `lockTimeoutMs` limits the wait for the CI state lock (cleanupResourceIds).
    cleanup: async ({ lockTimeoutMs } = {}) => {
      try {
        if (fixtureLanes.has(name)) {
          const cluster = findK3dCluster(effectiveState);
          // Suites restart the storage controller after selecting shared storage.
          // Run this in the runner parent so sanitized child reports cannot hide
          // infrastructure diagnostics after that configuration change.
          try {
            await verifyFixtureStorage(cluster!, 5);
          } catch (error) {
            console.error((error as Error).message);
            throw error;
          }
        }
      } finally {
        await cleanupResourceIds(resolvedStatePath, resourceIds, {
          ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
          requireJournal,
        });
      }
    },
  };
}

// Both builds share the images-packaging recipe and cleanup journal with the
// image lanes, so the cache writer produces the same inputs the lanes restore.

export async function prepareImageCacheBuilds(statePath: string | undefined) {
  const lane = "images-packaging";
  validateLaneInputsBeforeSideEffects(lane);
  const resolvedStatePath = normalizeStatePath(statePath);
  if (await readState(resolvedStatePath)) {
    throw new Error(`CI state already exists at ${resolvedStatePath}; run cleanup first.`);
  }
  const state = baseState(lane, resolvedStatePath);
  await writeState(resolvedStatePath, state);

  const defaultNodeBaseImage: string | undefined = effectiveLaneEnv(lane).NODE_BASE_IMAGE;
  return {
    async buildController(nodeBaseImage: string | undefined, requireCacheExport: boolean) {
      await buildRuntimeImages(resolvedStatePath, state, {
        controller: true,
        nodeBaseImage: nodeBaseImage ?? defaultNodeBaseImage,
        cacheWarm: true,
        requireCacheExport,
      });
    },

    async buildRuntime(requireCacheExport: boolean) {
      const { env } = await buildRuntimeImages(resolvedStatePath, state, {
        runtime: true,
        cacheWarm: true,
        requireCacheExport,
      });
      if (!env.OCC_TEST_RUNTIME_IMAGE) {
        throw new Error("Image cache preparation did not produce a runtime image tag.");
      }
      return env.OCC_TEST_RUNTIME_IMAGE;
    },
  };
}

export {
  devUpUnrelatedImage,
  prepareDevUpImage,
  defaultK3sImage,
  imageCacheLanes,
  lanesWithoutK3sAddons,
  prepareFile,
  prepareLane,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runPreparationCli(process.argv.slice(2), { prepareFile, prepareLane }).catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
