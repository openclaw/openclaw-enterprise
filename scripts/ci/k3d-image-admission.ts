import { createHash } from "node:crypto";
import { basename } from "node:path";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { createK3dNodeImages } from "./k3d-node-images.ts";
import {
  isPreparationResource,
  type K3dCluster,
  type PreparationJournal,
  type PreparationResource,
  type PreparationState,
} from "./k3d-preparation.ts";
import { pullImage } from "./image-pull.ts";
import { execFile } from "./prepare-command.ts";
import { randomSuffix, slug } from "./resource-names.ts";

export type NativeImageSelection = { platform: string; configDigest: string; cacheIndex?: string };
type NodeImages = ReturnType<typeof createK3dNodeImages>;
type ImageCluster = Pick<K3dCluster, "name"> & { nodes: readonly string[] };
type ImageOwnership = Pick<PreparationState, "resources"> &
  Partial<Pick<PreparationState, "prefix">>;

type K3dImageResource = PreparationResource & {
  kind: "k3d-image";
  name: string;
  sourceImage?: string;
  acquisitionReference?: string;
  nativeSelection?: NativeImageSelection;
  hostImageId?: string;
  cluster: string;
  envName: string;
  reference?: string;
};

export function assertImmutableImageReference(
  image: string | undefined,
  name: string,
): asserts image is string {
  if (typeof image !== "string" || !/^\S+@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error(`${name} must be an immutable image@sha256 reference.`);
  }
}

export function immutableDigest(image: string) {
  return image.match(/@sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
}

function stateOwnsImageTag(state: ImageOwnership, image: string) {
  return state.resources.some(
    (resource) =>
      resource.kind === "image-tag" &&
      resource.owner === state.prefix &&
      "name" in resource &&
      resource.name === image,
  );
}

function localImportTag(cluster: ImageCluster, envName: string) {
  return `localhost/${cluster.name}/${slug(envName)}-${randomSuffix()}:local`;
}

function repositoryDigestAliases(reference: string): string[] {
  const hubPath = /^(?:index\.)?docker\.io\/(.+)$/u.exec(reference)?.[1];
  if (!hubPath) {
    return [reference];
  }
  const aliases = [`docker.io/${hubPath}`, `index.docker.io/${hubPath}`];
  const [namespace] = hubPath.split("/", 1);
  // Docker reports familiar Hub names. A registry-looking first component
  // would instead select a different registry if its prefix were removed.
  if (namespace !== "localhost" && /^[a-z0-9_-]+$/u.test(namespace ?? "")) {
    aliases.push(hubPath.replace(/^library\/(?=[^/]+$)/u, ""));
  }
  return aliases;
}

// Each image inspect or tag on the host engine, and each check or tag on a k3d node, is
// one short command; a hung one (an unresponsive node or engine) fails the step with a
// clear message instead of stalling it until the job timeout. A timeout is never read as
// an absent image: its error carries no engine output, so nothing pulls or retries it.
// Despite its name, the variable also bounds the source image inspects of lanes without
// k3d, such as Images and Packaging and Logging Collector.
export const imageCommandTimeoutMs =
  Number(process.env.OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS) > 0
    ? Number(process.env.OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS)
    : 30_000;

export async function boundedImageCommand(
  args: string[],
  what = "The container engine",
  shown = args,
  docker = process.env.OCC_DOCKER_BIN ?? "docker",
) {
  try {
    return await execFile(docker, args, {
      timeoutMs: imageCommandTimeoutMs,
    });
  } catch (error) {
    if (asRecord(error)?.timedOut === true) {
      throw new Error(
        `${what} did not answer within ${imageCommandTimeoutMs} ms (${shown.join(" ")}).`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function dockerImageHasRepoDigest(image: string, docker: string) {
  const expected = immutableDigest(image);
  if (!expected) {
    return false;
  }
  const args = ["image", "inspect", "--format", "{{json .RepoDigests}}", image];
  const inspected = await boundedImageCommand(args, "The container engine", args, docker);
  const repoDigests: unknown = JSON.parse(inspected.stdout.trim() || "[]");
  if (!Array.isArray(repoDigests)) {
    return false;
  }
  const references: unknown[] = repoDigests;
  return references.some(
    (reference) =>
      typeof reference === "string" && reference.toLowerCase().endsWith(`@sha256:${expected}`),
  );
}

async function dockerImageId(image: string, docker: string) {
  const args = ["image", "inspect", "--format", "{{.Id}}", image];
  const inspected = await boundedImageCommand(args, "The container engine", args, docker);
  const value = inspected.stdout.trim();
  const id = /^[a-f0-9]{64}$/i.test(value) ? `sha256:${value}` : value;
  assertDockerImageId(id, `Docker image ${image}`);
  return id;
}

export function assertDockerImageId(id: unknown, description: string): asserts id is string {
  if (typeof id !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(id)) {
    throw new Error(`${description} did not resolve to an immutable local image ID.`);
  }
}

export async function ensureDockerSourceImage(
  state: ImageOwnership,
  image: string,
  envName: string,
  docker = process.env.OCC_DOCKER_BIN ?? "docker",
) {
  if (stateOwnsImageTag(state, image)) {
    const args = ["image", "inspect", image];
    await boundedImageCommand(args, "The container engine", args, docker);
    return dockerImageId(image, docker);
  }
  assertImmutableImageReference(image, envName);
  try {
    if (await dockerImageHasRepoDigest(image, docker)) {
      return await dockerImageId(image, docker);
    }
  } catch (error) {
    // A locally built immutable image may have no reachable registry. Reuse
    // only its verified repository digest; other Docker failures stay visible.
    const { stderr } = asRecord(error) ?? {};
    if (typeof stderr !== "string" || !/No such (?:image|object)|image not known/i.test(stderr)) {
      throw error;
    }
  }
  await pullImage(image, { execFile, docker });
  if (!(await dockerImageHasRepoDigest(image, docker))) {
    throw new Error(`${envName} pull did not materialize the requested registry digest.`);
  }
  return dockerImageId(image, docker);
}

// This deliberately unrelated release exercises the launcher's source-revision guard.
// Registry images remain in the engine cache; preparation owns no tag or cluster.
export const devUpUnrelatedImage =
  "rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657";

export async function prepareDevUpImage(
  docker = process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE || "docker",
) {
  await ensureDockerSourceImage(
    { resources: [] },
    devUpUnrelatedImage,
    "Dev-up rejection image",
    docker,
  );
}

// Native selection belongs to the importer: the required child may be present
// only beneath its pinned index in the engine's local content store.
export async function selectNativeSourceImage(
  image: string,
  selection: NativeImageSelection,
  envName: string,
  mode: "cache-only" | "pull-if-missing",
) {
  const repository = (reference: string) => {
    const name = reference.split("@", 1)[0] ?? "";
    return name.lastIndexOf(":") > name.lastIndexOf("/")
      ? name.slice(0, name.lastIndexOf(":"))
      : name;
  };
  assertImmutableImageReference(image, envName);
  assertDockerImageId(selection.configDigest, envName);
  if (selection.cacheIndex !== undefined) {
    assertImmutableImageReference(selection.cacheIndex, envName);
    if (repository(image) !== repository(selection.cacheIndex)) {
      throw new Error(`${envName} has an invalid native image selection.`);
    }
  }
  if (!selection.platform.startsWith("linux/")) {
    throw new Error(`${envName} has an invalid native image selection.`);
  }
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const inspect = async (reference: string, platform?: string) => {
    let result: Awaited<ReturnType<typeof boundedImageCommand>>;
    try {
      result = await boundedImageCommand([
        "image",
        "inspect",
        ...(platform && basename(docker) !== "podman" ? ["--platform", platform] : []),
        reference,
      ]);
    } catch (error) {
      const expected = reference.includes("@")
        ? `${repository(reference)}@sha256:${immutableDigest(reference)}`
        : reference;
      const details = asRecord(error);
      const diagnostic = typeof details?.stderr === "string" ? details.stderr.trim() : "";
      const stdout = typeof details?.stdout === "string" ? details.stdout.trim() : "";
      if (
        details?.exitCode === 1 &&
        !details.signal &&
        ["", "[]"].includes(stdout) &&
        [reference, ...repositoryDigestAliases(expected)].some(
          (alias) =>
            diagnostic === `Error response from daemon: No such image: ${alias}` ||
            diagnostic === `Error: ${alias}: image not known`,
        )
      ) {
        return undefined;
      }
      throw error;
    }
    const values: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length !== 1) {
      throw new Error(`${envName} has an invalid local image inspection.`);
    }
    const [value]: unknown[] = values;
    const inspected = asRecord(value);
    if (!inspected) {
      throw new Error(`${envName} has an invalid local image inspection.`);
    }
    const descriptor = asRecord(inspected.Descriptor);
    if (inspected.Descriptor != null && !descriptor) {
      throw new Error(`${envName} has an invalid local image descriptor.`);
    }
    const rawId = inspected.Id;
    const id =
      typeof rawId === "string" && /^[a-f0-9]{64}$/.test(rawId) ? `sha256:${rawId}` : rawId;
    assertDockerImageId(id, envName);
    return {
      id,
      descriptor,
      repoDigests: inspected.RepoDigests,
      os: inspected.Os,
      architecture: inspected.Architecture,
    };
  };
  const usable = async (reference: string) => {
    const held = await inspect(reference);
    if (!held) {
      return undefined;
    }
    const expected = `${repository(reference)}@sha256:${immutableDigest(reference)}`;
    const digests = held.repoDigests;
    if (
      !Array.isArray(digests) ||
      !repositoryDigestAliases(expected).some((alias) => digests.includes(alias))
    ) {
      throw new Error(`${envName} does not match its exact repository digest.`);
    }
    if (
      held.descriptor &&
      (held.descriptor.digest !== `sha256:${immutableDigest(reference)}` ||
        held.id !== held.descriptor.digest)
    ) {
      throw new Error(`${envName} local descriptor contradicts its acquisition identity.`);
    }
    const native = held.descriptor ? await inspect(reference, selection.platform) : held;
    if (!native) {
      return undefined;
    }
    if (held.descriptor && !native.descriptor) {
      throw new Error(`${envName} native image inspection lost its descriptor.`);
    }
    if (native.descriptor) {
      if (
        !isImageManifest(native.descriptor.mediaType) ||
        native.descriptor.digest !== `sha256:${immutableDigest(image)}` ||
        native.id !== native.descriptor.digest
      ) {
        throw new Error(`${envName} does not match the selected native manifest.`);
      }
      const annotated = asRecord(native.descriptor.annotations)?.["config.digest"];
      const platform = asRecord(native.descriptor.platform);
      if (
        (annotated !== undefined && annotated !== selection.configDigest) ||
        (native.descriptor.platform !== undefined &&
          (typeof platform?.os !== "string" ||
            typeof platform.architecture !== "string" ||
            `${platform.os}/${platform.architecture}` !== selection.platform))
      ) {
        throw new Error(`${envName} descriptor contradicts its native config or platform.`);
      }
      if (basename(docker) !== "podman" && native.os === "" && native.architecture === "") {
        return undefined;
      }
    } else if (native.id !== selection.configDigest) {
      throw new Error(`${envName} does not match the selected native config.`);
    }
    if (
      typeof native.os !== "string" ||
      typeof native.architecture !== "string" ||
      `${native.os}/${native.architecture}` !== selection.platform
    ) {
      throw new Error(`${envName} does not match the selected node platform.`);
    }
    return { acquisitionReference: reference, hostImageId: held.id };
  };
  for (const reference of selection.cacheIndex ? [image, selection.cacheIndex] : [image]) {
    const held = await usable(reference);
    if (held) {
      return held;
    }
  }
  if (mode !== "pull-if-missing") {
    throw new Error(
      `${envName} is missing from the ${selection.platform} cache. Stage ${image} or its pinned index ${selection.cacheIndex} on this engine.`,
    );
  }
  await pullImage(image, { execFile, docker });
  const pulled = await usable(image);
  if (!pulled) {
    throw new Error(`${envName} pull did not materialize the selected native image.`);
  }
  return pulled;
}

function isImageManifest(mediaType: unknown): boolean {
  return (
    mediaType === "application/vnd.oci.image.manifest.v1+json" ||
    mediaType === "application/vnd.docker.distribution.manifest.v2+json"
  );
}

function isK3dImageResource(value: unknown): value is K3dImageResource {
  if (!isPreparationResource(value)) {
    return false;
  }
  const resource = asRecord(value);
  const selection = asRecord(resource?.nativeSelection);
  return (
    resource?.kind === "k3d-image" &&
    typeof resource.name === "string" &&
    typeof resource.cluster === "string" &&
    typeof resource.envName === "string" &&
    (resource.nativeSelection === undefined ||
      (typeof selection?.platform === "string" &&
        typeof selection.configDigest === "string" &&
        (selection.cacheIndex === undefined || typeof selection.cacheIndex === "string"))) &&
    [
      resource.sourceImage,
      resource.acquisitionReference,
      resource.hostImageId,
      resource.reference,
    ].every((field) => field === undefined || typeof field === "string")
  );
}

function manifestConfigDigest(stdout: string) {
  const manifest: unknown = JSON.parse(stdout);
  return asRecord(asRecord(manifest)?.config)?.digest;
}

export function createK3dImageAdmission(
  { addResource, writeState, markResourceReady }: PreparationJournal,
  { k3dNodeImageCheck, assertK3dImageReference, importImageIntoK3dNodes }: NodeImages,
  fixtureLanes: ReadonlySet<string>,
) {
  async function assertK3dNativeImage(
    cluster: ImageCluster,
    reference: string,
    selection: NativeImageSelection,
    envName: string,
  ) {
    const digest = `sha256:${immutableDigest(reference)}`;
    for (const node of cluster.nodes) {
      const { stdout } = await k3dNodeImageCheck(
        node,
        ["ctr", "-n", "k8s.io", "content", "get", digest],
        "containerd",
      );
      if (
        `sha256:${createHash("sha256").update(stdout).digest("hex")}` !== digest ||
        manifestConfigDigest(stdout) !== selection.configDigest
      ) {
        throw new Error(
          `${envName} imported manifest does not match the selected native config on ${node}.`,
        );
      }
      const result = await k3dNodeImageCheck(node, ["crictl", "inspecti", reference], "CRI");
      const criImage: unknown = JSON.parse(result.stdout);
      const status = asRecord(asRecord(criImage)?.status);
      if (
        status?.id !== selection.configDigest ||
        !Array.isArray(status.repoDigests) ||
        !status.repoDigests.includes(reference)
      ) {
        throw new Error(
          `${envName} imported CRI image does not match the selected native config on ${node}.`,
        );
      }
    }
  }

  async function registerImageInK3d(
    statePath: string,
    state: PreparationState,
    cluster: ImageCluster,
    image: string,
    envName: string,
    nativeSelection?: NativeImageSelection,
  ) {
    const existing = state.resources.find((resource) => {
      const imageResource = asRecord(resource);
      return (
        resource.kind === "k3d-image" &&
        resource.status === "ready" &&
        imageResource?.cluster === cluster.name &&
        (imageResource.sourceImage === image ||
          imageResource.name === image ||
          imageResource.reference === image)
      );
    });
    if (existing) {
      if (!isK3dImageResource(existing) || existing.reference === undefined) {
        throw new Error("Invalid ready k3d image in CI state.");
      }
      if (!nativeSelection && !existing.hostImageId && existing.sourceImage) {
        existing.hostImageId = await ensureDockerSourceImage(state, existing.sourceImage, envName);
        await writeState(statePath, state);
      }
      assertDockerImageId(existing.hostImageId, envName);
      const { reference, hostImageId } = existing;
      await assertK3dImageReference(state.lane, cluster, reference, envName);
      if (nativeSelection) {
        await assertK3dNativeImage(cluster, reference, nativeSelection, envName);
      }
      return Object.assign(existing, { reference, hostImageId });
    }

    const { acquisitionReference, hostImageId } = nativeSelection
      ? await selectNativeSourceImage(image, nativeSelection, envName, "pull-if-missing")
      : {
          acquisitionReference: image,
          hostImageId: await ensureDockerSourceImage(state, image, envName),
        };
    let importReference = image;
    if (!stateOwnsImageTag(state, image)) {
      importReference = localImportTag(cluster, envName);
      const tagResource = addResource(state, "image-tag", { name: importReference });
      await writeState(statePath, state);
      await boundedImageCommand(["tag", acquisitionReference, importReference]);
      await markResourceReady(statePath, state, tagResource);
    }

    const resource = addResource(state, "k3d-image", {
      name: importReference,
      sourceImage: image,
      ...(nativeSelection ? { acquisitionReference, nativeSelection } : {}),
      hostImageId,
      cluster: cluster.name,
      envName,
    });
    await writeState(statePath, state);
    const platform =
      nativeSelection?.platform ??
      (
        await boundedImageCommand([
          "image",
          "inspect",
          "--format",
          "{{.Os}}/{{.Architecture}}",
          importReference,
        ])
      ).stdout.trim();
    if (!platform.startsWith("linux/")) {
      throw new Error(`${envName} must contain a Linux image.`);
    }
    // k3d can exit successfully after containerd rejects missing index content.
    // Export only the platform pulled locally, then verify the imported reference.
    const containerEngine = process.env.OCC_DOCKER_BIN ?? "docker";
    try {
      await importImageIntoK3dNodes(state.lane, cluster, [
        "image",
        "save",
        ...(basename(containerEngine) === "podman" ? [] : ["--platform", platform]),
        importReference,
      ]);
    } catch (error) {
      if (fixtureLanes.has(state.lane) && error instanceof Error) {
        // The fixture lane collects node diagnostics after its storage check has also settled.
        Object.assign(error, {
          k3dImageImportFailure: `${envName} image import into k3d nodes failed: ${error.message.slice(0, 300)}`,
        });
      }
      throw error;
    }

    const listed = await k3dNodeImageCheck(
      `k3d-${cluster.name}-server-0`,
      ["ctr", "-n", "k8s.io", "images", "list"],
      "containerd",
    );
    const line = listed.stdout
      .split(/\r?\n/)
      .find((entry) => entry.split(/\s+/)[0] === importReference);
    const [, mediaType, digest] = line?.split(/\s+/) ?? [];
    if (digest === undefined || !/^sha256:[a-f0-9]{64}$/i.test(digest)) {
      throw new Error(`Unable to find imported OCI manifest digest for ${importReference}.`);
    }
    if (!isImageManifest(mediaType)) {
      throw new Error(`Imported ${importReference} does not identify an image manifest.`);
    }
    // Workloads use the actual imported platform manifest, not a registry index digest.
    // The approved source image remains recorded and was verified before transport.
    const runtimeReference = `${importReference.slice(0, importReference.lastIndexOf(":"))}@${digest}`;
    for (const node of cluster.nodes) {
      await k3dNodeImageCheck(
        node,
        ["ctr", "-n", "k8s.io", "images", "tag", importReference, runtimeReference],
        "containerd",
      );
      // The prepared cluster owns a fixed image set until cleanup. Keep its exact
      // workload alias resident even while no Pod is using it between test cases.
      await k3dNodeImageCheck(
        node,
        [
          "ctr",
          "-n",
          "k8s.io",
          "images",
          "label",
          runtimeReference,
          "io.cri-containerd.pinned=pinned",
        ],
        "containerd",
      );
    }
    await assertK3dImageReference(state.lane, cluster, runtimeReference, envName);
    if (nativeSelection) {
      await assertK3dNativeImage(cluster, runtimeReference, nativeSelection, envName);
    }
    const admitted = Object.assign(resource, { reference: runtimeReference });
    await markResourceReady(statePath, state, admitted);
    return admitted;
  }

  return { registerImageInK3d };
}
