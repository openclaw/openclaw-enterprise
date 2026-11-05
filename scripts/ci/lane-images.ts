// Images the QA matrix builds through the development launcher. Blacksmith runners
// share one Docker image store, and a job commits its image set at the end when it
// differs from the snapshot the job started from. Only one commit from a snapshot
// wins, so every QA job that left images behind competed with the warm job that
// keeps main's runtime image (finding 1345). Preparation records the starting
// inventory; cleanup removes the tags this job added under these names and points
// the launcher tags it rebuilt back at their starting images. Any other image,
// including main's kept runtime tags and the base images other jobs reuse, is
// only reported.
export const laneImagesResourceKind = "lane-images";

type ImageInventory = Record<string, string>;

interface ImageCommands {
  execFile: (command: string, args: string[]) => Promise<{ stdout: string }>;
  docker: string;
}

interface LaneImagesResource {
  name: string;
  images: unknown;
}

const ownedReferencePatterns = [
  // Compose names a QA installation's images <cluster>-<service>.
  /^occ-dev-qa-[a-z0-9][a-z0-9-]*:[\w][\w.-]*$/,
  // Launcher staging tags carry the QA cluster name.
  /^openclaw-development\/[a-z0-9][a-z0-9-]*:occ-dev-qa-[a-z0-9-]+$/,
  // The hybrid controller and repository service tags carry the QA run suffix.
  /^openclaw-qa\/controller:[a-z0-9-]+$/,
  /^oce-qa-repository:[a-z0-9-]+$/,
  // Fixed tags the launcher rebuilds on every Kubernetes installation.
  /^openclaw-enterprise-(?:runtime|controller|repository-credentials):kubernetes-quickstart$/,
];

const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const maxInventoryEntries = 10_000;

function shortName(reference: string) {
  return reference.replace(/^docker\.io\/(?:library\/)?/, "");
}

export function ownedLaneImage(reference: string) {
  const name = shortName(reference);
  return ownedReferencePatterns.some((pattern) => pattern.test(name));
}

// Tagged and digest-pinned images by reference. Untagged images are left out: the
// runner removes them before it compares the store with its snapshot.
export async function imageInventory({ execFile, docker }: ImageCommands): Promise<ImageInventory> {
  const { stdout } = await execFile(docker, [
    "image",
    "ls",
    "--digests",
    "--no-trunc",
    "--format",
    "{{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.ID}}",
  ]);
  const images: ImageInventory = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const [repository, tag, digest, id] = line.split("\t");
    if (id === undefined || !imageIdPattern.test(id)) {
      throw new Error(`Unexpected image inventory line: ${line.slice(0, 200)}`);
    }
    if (!repository || repository === "<none>") {
      continue;
    }
    if (tag && tag !== "<none>") {
      images[`${repository}:${tag}`] = id;
    } else if (digest && digest !== "<none>") {
      images[`${repository}@${digest}`] = id;
    }
  }
  if (Object.keys(images).length > maxInventoryEntries) {
    throw new Error("The image inventory is too large to record.");
  }
  return images;
}

export function assertLaneImagesResource(resource: {
  images: unknown;
}): asserts resource is { images: ImageInventory } {
  const images = resource.images;
  if (images === null || typeof images !== "object" || Array.isArray(images)) {
    throw new Error("Lane image baseline must be an object.");
  }
  const entries: [string, unknown][] = Object.entries(images);
  if (entries.length > maxInventoryEntries) {
    throw new Error("Lane image baseline is too large.");
  }
  for (const [reference, id] of entries) {
    if (
      reference.length === 0 ||
      reference.length > 512 ||
      typeof id !== "string" ||
      !imageIdPattern.test(id)
    ) {
      throw new Error(`Invalid lane image baseline entry: ${reference.slice(0, 200)}`);
    }
  }
}

function firstLine(error: unknown) {
  const message =
    error !== null && typeof error === "object" && "message" in error ? error.message : undefined;
  return (String(message ?? error).split(/\r?\n/)[0] ?? "").slice(0, 300);
}

// Returns the job's image set to its recorded start for the owned names. Engine
// failures are reported, not thrown: a leftover image costs a store commit, not a
// result.
export async function restoreLaneImages(
  resource: LaneImagesResource,
  { execFile, docker, log = console.log }: ImageCommands & { log?: (message: string) => void },
) {
  assertLaneImagesResource(resource);
  const baseline = resource.images;
  let current;
  try {
    current = await imageInventory({ execFile, docker });
  } catch (error) {
    log(`::warning::Lane image cleanup skipped: ${firstLine(error)}`);
    return { skipped: true };
  }
  const restored: string[] = [];
  const removed: string[] = [];
  const warnings: string[] = [];
  for (const [reference, id] of Object.entries(baseline)) {
    // Owned names are tags; a digest reference cannot be re-tagged.
    if (!ownedLaneImage(reference) || reference.includes("@") || current[reference] === id) {
      continue;
    }
    // A rebuild moved this tag. Its starting image stays in the store, untagged,
    // until the runner prunes untagged images, so the tag can return to it.
    try {
      await execFile(docker, ["tag", id, reference]);
      restored.push(reference);
    } catch (error) {
      warnings.push(`restore ${reference}: ${firstLine(error)}`);
    }
  }
  for (const reference of Object.keys(current)) {
    if (!ownedLaneImage(reference) || Object.hasOwn(baseline, reference)) {
      continue;
    }
    try {
      await execFile(docker, ["image", "rm", reference]);
      removed.push(reference);
    } catch (error) {
      warnings.push(`remove ${reference}: ${firstLine(error)}`);
    }
  }
  // What changed since preparation recorded the start, so a job that still commits
  // names why. Images pulled before preparation (setup actions) are not in this view.
  let final: ImageInventory | null = null;
  try {
    final = await imageInventory({ execFile, docker });
  } catch (error) {
    warnings.push(`final inventory: ${firstLine(error)}`);
  }
  const added =
    final === null
      ? null
      : Object.keys(final).filter((reference) => !Object.hasOwn(baseline, reference));
  const changed =
    final === null
      ? null
      : Object.keys(final).filter(
          (reference) =>
            Object.hasOwn(baseline, reference) && baseline[reference] !== final[reference],
        );
  const missing =
    final === null
      ? null
      : Object.keys(baseline).filter((reference) => !Object.hasOwn(final, reference));
  for (const warning of warnings) {
    log(`::warning::Lane image cleanup: ${warning}`);
  }
  log(
    JSON.stringify({
      stage: "lane-images",
      lane: resource.name,
      restored,
      removed,
      added,
      changed,
      missing,
    }),
  );
  return { restored, removed, added, changed, missing, warnings };
}
