import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createModelProviderFiles,
  writeModelProviderTrust,
} from "../../../tests/helpers/runtime-model-provider.mjs";
import { postgresImage, registryImage, runtimeNodeBaseImage } from "../fixture-support-images.mjs";
import { ensureImage } from "../image-pull.ts";
import {
  openclawBuildArguments,
  openclawBuildValues,
  readOpenclawSource,
  type OpenclawSource,
} from "../../lib/openclaw-source.ts";
import { prepareRuntimeArtifactLayout, runtimeArtifactSelection } from "../runtime-artifact.ts";
import {
  log,
  minute,
  registry,
  root,
  run,
  slotNames,
  workDirectory,
  type RunOptions,
  type RunResult,
  type Step,
} from "./process.ts";

// `run` reads the selections from its environment (GitHub Actions) or from the
// work directory (local runs).
async function exportEnvironment(values: Record<string, unknown>) {
  await writeFile(join(workDirectory, "images.json"), `${JSON.stringify(values)}\n`);
  if (process.env.GITHUB_ENV) {
    await appendFile(
      process.env.GITHUB_ENV,
      Object.entries(values)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
  }
}

// ---------------------------------------------------------------------------
// images

const nodeBaseImage =
  "docker.io/library/node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a";

function cacheSources(role: "controller" | "runtime") {
  // Restore only: main's cache is written by the warm workflow alone.
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    !process.env.ACTIONS_RUNTIME_TOKEN ||
    !process.env.ACTIONS_RESULTS_URL
  ) {
    return [];
  }
  const scope = `oce-ci-${role}-${process.platform}-${process.arch}-v1`;
  return [`type=gha,version=2,scope=${scope},timeout=60s`];
}

function cacheArguments(role: "controller" | "runtime") {
  return cacheSources(role).flatMap((source) => ["--cache-from", source]);
}

// The image lanes and the warm job build with a fixed SOURCE_DATE_EPOCH, and
// BuildKit stamps the directories WORKDIR creates with it. Without the same
// value no step after an image's first WORKDIR matched their cache, so every
// smoke run reinstalled both images' packages (finding 1273). It sets only
// timestamps (image config, history, WORKDIR); the smoke reads none of them.
// RUN steps do not see it: an `ARG SOURCE_DATE_EPOCH` would change their keys.
const cacheEpoch = "0";
const cacheBuildArguments = ["--build-arg", `SOURCE_DATE_EPOCH=${cacheEpoch}`];

// Local Setup selects images by registry digest, which the engine records when it
// pushes or pulls a tag.
async function pushedDigest(tag: string) {
  await run("docker", ["push", tag], { timeout: 10 * minute });
  return recordedDigest(tag);
}

async function pulledDigest(tag: string) {
  await run("docker", ["pull", tag], { timeout: 10 * minute });
  return recordedDigest(tag);
}

async function recordedDigest(tag: string): Promise<string> {
  const { stdout } = await run("docker", [
    "image",
    "inspect",
    "--format",
    "{{json .RepoDigests}}",
    tag,
  ]);
  const repository = tag.slice(0, tag.lastIndexOf(":"));
  const digests: unknown = JSON.parse(stdout);
  const reference = (digests as string[]).find((digest) => digest.startsWith(`${repository}@`));
  assert.match(reference ?? "", /@sha256:[a-f0-9]{64}$/, `no registry digest for ${tag}`);
  return reference as string;
}

// The image-pull.ts retry helper over `run`.
async function pullExecFile(command: string, args: string[], { timeoutMs }: { timeoutMs: number }) {
  try {
    return await run(command, args, { timeout: timeoutMs });
  } catch (error) {
    const failure = error as Error & { result?: RunResult };
    Object.assign(failure, {
      stdout: failure.result?.stdout ?? "",
      stderr: failure.result?.stderr ?? "",
      timedOut: failure.result?.signal === "SIGKILL",
    });
    throw error;
  }
}

// Fetch an image manifest from the loopback registry by digest and check its
// bytes against that digest.
export async function registryManifest({
  registry,
  path,
  digest,
  fetchRegistry = fetch,
}: {
  registry: string;
  path: string;
  digest: string;
  fetchRegistry?: typeof fetch;
}): Promise<unknown> {
  const reference = `${registry}/${path}@${digest}`;
  const response = await fetchRegistry(`http://${registry}/v2/${path}/manifests/${digest}`, {
    headers: {
      accept:
        "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `registry manifest ${reference}: HTTP ${response.status}`);
  const manifest = Buffer.from(await response.arrayBuffer());
  assert.equal(
    `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
    digest,
    `the registry manifest does not match ${reference}`,
  );
  const parsed: unknown = JSON.parse(manifest.toString("utf8"));
  return parsed;
}

// Copy the pinned PostgreSQL image into the loopback registry, so the k3d node
// pulls it by digest like the checkout's images, instead of Local Setup pulling
// it from Docker Hub and exporting and importing it beside the cluster checks.
// The engine verified the pin when it pulled the image. Its push recompresses
// the layers, so the registry digest differs from the pin, but the registry's
// manifest must name the pinned image's config, which fixes every layer's
// uncompressed digest (containerd checks them as it unpacks). The engine's
// containerd image store reports other IDs and pushes indexes, so there the
// copy is skipped and PostgreSQL keeps the archive path.
type DockerCommand = (
  command: string,
  args: string[],
  options?: RunOptions,
) => Promise<{ stdout: string }>;

export async function publishPostgresImage({
  registry,
  runCommand = run,
  fetchRegistry = fetch,
  pull = (image: string) => ensureImage(image, { execFile: pullExecFile }),
}: {
  registry: string;
  runCommand?: DockerCommand;
  fetchRegistry?: typeof fetch;
  pull?: (image: string) => Promise<unknown>;
}) {
  assert.match(registry, /^127\.0\.0\.1:\d+$/, "the PostgreSQL copy needs a loopback registry");
  const { stdout: driverStatus } = await runCommand("docker", [
    "info",
    "--format",
    "{{json .DriverStatus}}",
  ]);
  if (driverStatus.includes("io.containerd.snapshotter")) {
    log("PostgreSQL keeps the archive path: the engine uses the containerd image store");
    return undefined;
  }
  await pull(postgresImage);
  const id = (
    await runCommand("docker", ["image", "inspect", "--format", "{{.Id}}", postgresImage])
  ).stdout.trim();
  assert.match(id, /^sha256:[a-f0-9]{64}$/, `no image ID for ${postgresImage}`);
  const tag = `${registry}/oce-smoke/postgres:${/:([^:/@]+)@/.exec(postgresImage)![1]}`;
  await runCommand("docker", ["tag", id, tag]);
  // This push's own digest: a long-lived engine keeps every digest it ever
  // recorded for the image.
  const { stdout } = await runCommand("docker", ["push", tag], { timeout: 10 * minute });
  const digest = /: digest: (sha256:[a-f0-9]{64}) size: \d+/.exec(stdout)?.[1];
  assert.ok(digest, `docker push reported no digest for ${tag}`);
  const reference = `${registry}/oce-smoke/postgres@${digest}`;
  const manifest = await registryManifest({
    registry,
    path: "oce-smoke/postgres",
    digest,
    fetchRegistry,
  });
  assert.equal(
    (manifest as { config?: { digest?: unknown } | null }).config?.digest,
    id,
    `the registry copy of PostgreSQL is not the pinned image: ${reference}`,
  );
  return reference;
}

// The image selection Local Setup reads. The prepared-Git acceptance keeps
// the archive path for every image, so it selects no registry and no
// PostgreSQL copy.
interface RepositoryEnvironment extends Record<string, unknown> {
  OCC_DEVELOPMENT_REPOSITORY_IMAGE?: string;
  OCC_SKIPPER_IMAGE_REGISTRY_CONTAINER?: string;
}

interface ImageEnvironment {
  preparedGit: boolean;
  repository?: RepositoryEnvironment;
  registryContainer: string;
  controller: string;
  runtime: string;
  postgres?: string | undefined;
  providerImage?: string | undefined;
  modelDirectory: string;
}

export function smokeImageEnvironment({
  preparedGit,
  repository,
  registryContainer,
  controller,
  runtime,
  postgres,
  providerImage,
  modelDirectory,
}: ImageEnvironment) {
  return {
    ...repository,
    // The k3d node pulls the controller, runtime and PostgreSQL images from
    // this loopback registry by digest instead of importing exported archives.
    ...(preparedGit
      ? {}
      : {
          OCC_DEVELOPMENT_IMAGE_REGISTRY_CONTAINER: registryContainer,
          ...(postgres ? { OCC_DEVELOPMENT_POSTGRES_IMAGE: postgres } : {}),
        }),
    OCC_DEVELOPMENT_CONTROLLER_IMAGE: controller,
    OCC_KUBERNETES_RUNTIME_IMAGE: runtime,
    OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY: modelDirectory,
    ...(providerImage ? { OCC_FIRST_AGENT_SMOKE_PROVIDER_IMAGE: providerImage } : {}),
  };
}

function smokeImageRepository(role: string) {
  return `${registry}/oce-smoke/${role}`;
}

// Record the build's selected manifests before the installer produces its own receipt.
export async function writeReleaseSelection(file: string | undefined) {
  if (!file || process.argv.length !== 4) {
    throw new Error("Usage: node scripts/ci/first-agent-smoke.ts release-selection <file>");
  }
  const images: Record<string, string> = {};
  for (const [role, name] of [
    ["controller", "OCC_DEVELOPMENT_CONTROLLER_IMAGE"],
    ["runtime", "OCC_KUBERNETES_RUNTIME_IMAGE"],
    ["repository", "OCC_DEVELOPMENT_REPOSITORY_IMAGE"],
  ] as const) {
    const reference = process.env[name];
    const prefix = `${smokeImageRepository(role)}@`;
    const digest = reference?.startsWith(prefix) ? reference.slice(prefix.length) : "";
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`${name} must be a SHA-256 image digest reference`);
    }
    images[role] = digest;
  }
  let sourceSha: string;
  try {
    sourceSha = (
      await run("git", ["rev-parse", "--verify", "HEAD"], { timeout: 10_000 })
    ).stdout.trim();
  } catch {
    throw new Error("Cannot read checked-out HEAD for release selection");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error("Checked-out HEAD must be a full source SHA");
  }
  try {
    await writeFile(file, `${JSON.stringify({ sourceSha, images })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw new Error("Cannot write a fresh release selection file");
  }
}

type BuildResult<T> = PromiseFulfilledResult<T> | { status: "rejected"; reason: unknown };

export async function buildImages(step: Step, { preparedGit = false } = {}) {
  const selection = runtimeArtifactSelection(process.env);
  if (selection && process.env.OCC_K3D_OPENCLAW_SOURCE) {
    throw new Error("A runtime artifact cannot be combined with OCC_K3D_OPENCLAW_SOURCE.");
  }
  const revision = (await run("git", ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  assert.match(revision, /^[a-f0-9]{40}$/);
  if (selection) {
    assert.equal(selection.sourceSha, revision, "runtime artifact must match checked-out HEAD");
  }
  await mkdir(workDirectory, { recursive: true });
  const modelDirectory = join(workDirectory, "model");
  await step("model certificates", () =>
    createModelProviderFiles({
      directory: modelDirectory,
      caName: "oce-first-agent-smoke-ca",
      run,
    }),
  );
  if (preparedGit) {
    const name = "skipper-prepared-compute-model.mjs";
    const companion = join(modelDirectory, name);
    await copyFile(join(root, "tests", "fixtures", name), companion);
    await chmod(companion, 0o644); // The model fixture runs as the image's non-root user.
    await rm(join(modelDirectory, "ca-key.pem"));
  }
  const registryContainer = await step("loopback registry", () =>
    run("docker", [
      "run",
      "--detach",
      "--name",
      slotNames.registryContainer,
      "--publish",
      `${registry}:5000`,
      registryImage,
    ]),
  );
  const controllerTag = `${smokeImageRepository("controller")}:${revision}`;
  const smokeRuntimeTag = `${smokeImageRepository("runtime")}:${revision}`;
  // The only difference from the checkout's runtime image: the stand-in
  // provider's private CA in the system store (Codex) and for Node (OpenClaw).
  // Labels, user, entrypoint and every other layer are inherited unchanged.
  const context = join(workDirectory, "runtime-trust");
  await writeModelProviderTrust({ context, caPath: join(modelDirectory, "ca.pem") });
  const driver = await builderDriver();
  let runtimeArtifact: RuntimeArtifact | undefined;
  let settled: [BuildResult<ImageReferences>, BuildResult<string | undefined>] | undefined;
  const failures: unknown[] = [];
  try {
    if (selection) {
      runtimeArtifact = await step("verified runtime artifact", () =>
        prepareRuntimeArtifactLayout(selection),
      );
    }
    // Both finish before cleanup, so neither keeps using the artifact unseen.
    settled = await Promise.allSettled([
      driver === "docker-container"
        ? bakeAndPushImages(step, {
            revision,
            controllerTag,
            smokeRuntimeTag,
            context,
            runtimeArtifact,
            // The prepared-Git acceptance imports archives, so the engine needs both.
            load: preparedGit,
          })
        : buildAndPushImages(step, {
            revision,
            controllerTag,
            smokeRuntimeTag,
            context,
            runtimeArtifact,
          }),
      // The prepared-Git acceptance keeps the archive path for every image.
      preparedGit
        ? undefined
        : step("PostgreSQL image to the loopback registry", () =>
            publishPostgresImage({ registry }),
          ),
    ]);
    for (const result of settled) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await runtimeArtifact?.cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      failures.map((error) => (error as Error).message ?? String(error)).join("\n"),
    );
  }
  // Every rejection and cleanup failure has already been rethrown.
  const [build, database] = settled as [
    PromiseFulfilledResult<ImageReferences>,
    PromiseFulfilledResult<string | undefined>,
  ];
  const [controller, runtime, providerImage] = build.value;
  const postgres = database.value;
  const repository: RepositoryEnvironment = {};
  if (preparedGit) {
    const tag = `${smokeImageRepository("repository")}:${revision}`;
    await step("repository service image build", () =>
      run(
        "docker",
        [
          "buildx",
          "build",
          "--load",
          ...cacheArguments("runtime"),
          ...cacheBuildArguments,
          "--file",
          "deploy/runtime/Dockerfile",
          "--target",
          "repository-credentials-service",
          "--label",
          `org.opencontainers.image.revision=${revision}`,
          "--tag",
          tag,
          ".",
        ],
        { timeout: 30 * minute, label: "repository-build" },
      ),
    );
    repository.OCC_DEVELOPMENT_REPOSITORY_IMAGE = await pushedDigest(tag);
    repository.OCC_SKIPPER_IMAGE_REGISTRY_CONTAINER = registryContainer.stdout.trim();
  }
  await exportEnvironment(
    smokeImageEnvironment({
      preparedGit,
      repository,
      registryContainer: slotNames.registryContainer,
      controller,
      runtime,
      postgres,
      providerImage,
      modelDirectory,
    }),
  );
  log(`controller ${controller}`);
  log(`runtime ${runtime}`);
  if (postgres) {
    log(`PostgreSQL ${postgres}`);
  }
}

async function builderDriver() {
  const { stdout } = await run("docker", ["buildx", "inspect"]);
  return /^Driver:\s+(\S+)/m.exec(stdout)?.[1] ?? "";
}

// The stand-in model provider runs tests/fixtures/runtime-model-probe-endpoint.mjs,
// which needs Node and the `ws` package the runtime image ships. This image is
// the runtime image's Node base with only that package, so the engine loads a
// small image instead of the whole runtime image.
export const providerImageDockerfile = [
  "ARG NODE_RUNTIME_BASE_IMAGE",
  "FROM ${NODE_RUNTIME_BASE_IMAGE}",
  "COPY --from=smoke-runtime-base /app/node_modules/ws/ /app/node_modules/ws/",
  `RUN node -e 'if (typeof require("/app/node_modules/ws").WebSocketServer !== "function") process.exit(1)'`,
  "USER node",
  "",
].join("\n");

// The bake definition for the checkout's images. With `load` (the prepared-Git
// acceptance, which imports archives) the engine also loads the controller and
// runtime images. Without it they only go to the registry: Local Setup reads
// their revision labels there and the node pulls them by digest; the engine
// loads only the stand-in provider's image.
interface SmokeBakeInput {
  revision: string;
  controllerTag: string;
  smokeRuntimeTag: string;
  context: string;
  providerContext: string;
  nodeRuntimeBaseImage: string;
  openclawSource: OpenclawSource;
  registryAddress: string;
  runtimeContext?: string | undefined;
  load: boolean;
  caches?: typeof cacheSources;
}

interface BakeTarget {
  context: string;
  contexts?: Record<string, string>;
  dockerfile?: string;
  target?: string;
  args: Record<string, string>;
  labels?: Record<string, string>;
  "cache-from"?: string[];
  pull?: boolean;
  output?: string[];
}

type SmokeBakeTarget = {
  "smoke-controller": BakeTarget & { output: string[] };
  "smoke-runtime": BakeTarget & { output: string[] };
  "smoke-runtime-base"?: BakeTarget;
  "smoke-provider"?: BakeTarget & { output: string[] };
};

export function smokeBakeDefinition({
  revision,
  controllerTag,
  smokeRuntimeTag,
  context,
  providerContext,
  nodeRuntimeBaseImage,
  openclawSource,
  registryAddress,
  runtimeContext,
  load,
  caches = cacheSources,
}: SmokeBakeInput) {
  const outputs = (tag: string) => [
    ...(load ? [`type=docker,name=${tag}`] : []),
    `type=image,name=${registryAddress}${tag.slice(registry.length)},push=true,registry.insecure=true`,
  ];
  const runtimeBase = runtimeContext ?? "target:smoke-runtime-base";
  const target: SmokeBakeTarget = {
    "smoke-controller": {
      context: root,
      target: "runtime",
      args: { NODE_BASE_IMAGE: nodeBaseImage, SOURCE_DATE_EPOCH: cacheEpoch },
      labels: { "org.opencontainers.image.revision": revision },
      "cache-from": caches("controller"),
      pull: false,
      output: outputs(controllerTag),
    },
    ...(runtimeContext
      ? {}
      : {
          "smoke-runtime-base": {
            context: root,
            dockerfile: "deploy/runtime/Dockerfile",
            args: {
              ...openclawBuildValues(openclawSource),
              OCC_BUILD_REVISION: revision,
              SOURCE_DATE_EPOCH: cacheEpoch,
            },
            "cache-from": caches("runtime"),
            pull: false,
          },
        }),
    "smoke-runtime": {
      context,
      contexts: { "smoke-runtime-base": runtimeBase },
      args: { RUNTIME_IMAGE: "smoke-runtime-base" },
      output: outputs(smokeRuntimeTag),
    },
  };
  if (!load) {
    target["smoke-provider"] = {
      context: providerContext,
      contexts: { "smoke-runtime-base": runtimeBase },
      args: { NODE_RUNTIME_BASE_IMAGE: nodeRuntimeBaseImage },
      output: [`type=docker,name=${providerImageTag(revision)}`],
    };
  }
  return { target };
}

// A builder in its own container (the hosted job's) builds, adds the trust
// layer and pushes both images in one bake. The push sends the compressed
// layers the hosted cache already holds, so only layers this checkout changed
// are compressed. The builder reaches the registry over the default bridge
// network, so it must run there (setup-buildx's default) or on the host
// network. Unless `load` is set, neither image is loaded into the engine, and
// the bake's metadata names their registry digests.
type RuntimeArtifact = Awaited<ReturnType<typeof prepareRuntimeArtifactLayout>>;

interface ImageBuild {
  revision: string;
  controllerTag: string;
  smokeRuntimeTag: string;
  context: string;
  runtimeArtifact: RuntimeArtifact | undefined;
}

type ImageReferences = [controller: string, runtime: string, provider?: string];

async function bakeAndPushImages(
  step: Step,
  {
    revision,
    controllerTag,
    smokeRuntimeTag,
    context,
    load,
    runtimeArtifact,
  }: ImageBuild & { load: boolean },
): Promise<ImageReferences> {
  const address = (
    await run("docker", [
      "inspect",
      "--format",
      '{{with index .NetworkSettings.Networks "bridge"}}{{.IPAddress}}{{end}}',
      slotNames.registryContainer,
    ])
  ).stdout.trim();
  assert.match(address, /^\d+\.\d+\.\d+\.\d+$/, "registry has no bridge address");
  const providerContext = join(workDirectory, "provider-image");
  await mkdir(providerContext, { recursive: true });
  await writeFile(join(providerContext, "Dockerfile"), providerImageDockerfile);
  const nodeRuntimeBaseImage = runtimeNodeBaseImage(
    await readFile(join(root, "deploy/runtime/Dockerfile"), "utf8"),
  );
  const definition = smokeBakeDefinition({
    revision,
    controllerTag,
    smokeRuntimeTag,
    context,
    providerContext,
    nodeRuntimeBaseImage,
    openclawSource: await readOpenclawSource(),
    registryAddress: `${address}:5000`,
    runtimeContext: runtimeArtifact
      ? `oci-layout://${runtimeArtifact.layoutDirectory}@${runtimeArtifact.platformManifestDigest}`
      : undefined,
    load,
  });
  const targets = Object.keys(definition.target).filter((name) => name !== "smoke-runtime-base");
  const file = join(workDirectory, "images.bake.json");
  const metadataFile = join(workDirectory, "images.metadata.json");
  await writeFile(file, `${JSON.stringify(definition, null, 2)}\n`);
  // Both builds read the hosted caches main's warm job (ci-image-cache.yml) writes.
  await step("controller and runtime image builds", () =>
    // The trust and provider contexts lie outside the working directory, so
    // bake needs explicit read grants (its check sometimes missed them, by
    // target order).
    run(
      "docker",
      [
        "buildx",
        "bake",
        `--allow=fs.read=${context}`,
        `--allow=fs.read=${providerContext}`,
        ...(runtimeArtifact ? [`--allow=fs.read=${runtimeArtifact.layoutDirectory}`] : []),
        "--file",
        file,
        "--metadata-file",
        metadataFile,
        ...targets,
      ],
      {
        // Single-platform image manifests without attestation indexes, so the
        // recorded digest is the image manifest's.
        env: { ...process.env, BUILDX_NO_DEFAULT_ATTESTATIONS: "1" },
        timeout: (runtimeArtifact ? 40 : 180) * minute,
        label: "image-bake",
      },
    ),
  );
  if (load) {
    // The engine pulls the same tags back from loopback, which records their
    // digests without copying layers it already loaded.
    return step("registry digests", () =>
      Promise.all([pulledDigest(controllerTag), pulledDigest(smokeRuntimeTag)]),
    );
  }
  const metadata: unknown = JSON.parse(await readFile(metadataFile, "utf8"));
  const references = bakeReferences(metadata, {
    controllerTag,
    smokeRuntimeTag,
  });
  // Local Setup reads both from loopback; check here that they are there.
  await step("registry digests", () =>
    Promise.all(
      references.map((reference) => {
        const [name, digest] = reference.split("@") as [string, string];
        return registryManifest({ registry, path: name.slice(registry.length + 1), digest });
      }),
    ),
  );
  return [...references, providerImageTag(revision)];
}

// The provider image's local name: per slot and revision.
export function providerImageTag(revision: string) {
  return `${slotNames.model}-provider:${revision}`;
}

// Registry references for the pushed images, from the bake's metadata file.
export function bakeReferences(
  metadata: unknown,
  { controllerTag, smokeRuntimeTag }: Pick<ImageBuild, "controllerTag" | "smokeRuntimeTag">,
): [string, string] {
  const targets = metadata as Record<string, { "containerimage.digest"?: string } | null>;
  const pinned = (name: string, tag: string) => {
    const digest = targets[name]?.["containerimage.digest"];
    assert.match(
      digest ?? "",
      /^sha256:[a-f0-9]{64}$/,
      `bake metadata has no containerimage.digest for ${name}`,
    );
    return `${tag.slice(0, tag.lastIndexOf(":"))}@${digest}`;
  };
  return [pinned("smoke-controller", controllerTag), pinned("smoke-runtime", smokeRuntimeTag)];
}

// The engine's own builder: build, add the trust layer, then push.
async function buildAndPushImages(
  step: Step,
  { revision, controllerTag, smokeRuntimeTag, context, runtimeArtifact }: ImageBuild,
): Promise<ImageReferences> {
  const runtimeTag = `${registry}/oce-smoke/runtime-base:${revision}`;
  const sourceArguments = openclawBuildArguments(await readOpenclawSource());
  // Both builds read the hosted caches main's warm job (ci-image-cache.yml) writes.
  await step("controller and runtime image builds", () =>
    Promise.all([
      run(
        "docker",
        [
          "buildx",
          "build",
          "--load",
          ...cacheArguments("controller"),
          ...cacheBuildArguments,
          "--pull=false",
          "--target",
          "runtime",
          "--build-arg",
          `NODE_BASE_IMAGE=${nodeBaseImage}`,
          "--label",
          `org.opencontainers.image.revision=${revision}`,
          "--tag",
          controllerTag,
          ".",
        ],
        { timeout: 40 * minute, label: "controller-build" },
      ),
      ...(runtimeArtifact
        ? []
        : [
            run(
              "docker",
              [
                "buildx",
                "build",
                "--load",
                ...cacheArguments("runtime"),
                ...cacheBuildArguments,
                ...sourceArguments,
                "--pull=false",
                "--file",
                "deploy/runtime/Dockerfile",
                "--build-arg",
                `OCC_BUILD_REVISION=${revision}`,
                "--tag",
                runtimeTag,
                ".",
              ],
              { timeout: 180 * minute, label: "runtime-build" },
            ),
          ]),
    ]),
  );
  await step("runtime trust layer", () =>
    run("docker", [
      "buildx",
      "build",
      "--builder",
      "default",
      "--load",
      "--build-arg",
      `RUNTIME_IMAGE=${runtimeArtifact ? "smoke-runtime-base" : runtimeTag}`,
      ...(runtimeArtifact
        ? [
            "--build-context",
            `smoke-runtime-base=oci-layout://${runtimeArtifact.layoutDirectory}@${runtimeArtifact.platformManifestDigest}`,
          ]
        : []),
      "--tag",
      smokeRuntimeTag,
      context,
    ]),
  );
  return step("registry digests", () =>
    Promise.all([pushedDigest(controllerTag), pushedDigest(smokeRuntimeTag)]),
  );
}
