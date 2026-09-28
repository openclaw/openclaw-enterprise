import { readFile, rename, rm, writeFile } from "node:fs/promises";

const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const containerIdPattern = /^[a-f0-9]{64}$/;

export function assertProcessGroupSettled(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === "win32") {
    throw new Error("Docker command process group cannot be observed");
  }
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  throw new Error(`Docker command process group ${pid} is still active`);
}

// DockerComputeDriver uses this Unix socket directly. Remove inherited endpoint
// and TLS overrides so the fixture CLI cannot silently target another engine.
export function localDockerCli(
  execute,
  inheritedEnv = process.env,
  observeGroup = assertProcessGroupSettled,
) {
  const env = { ...inheritedEnv };
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "BUILDX_BUILDER",
  ]) {
    delete env[name];
  }
  const disposition = { started: 0, settled: 0, unknown: 0 };
  const docker = async (...args) => {
    if (disposition.unknown) {
      throw new Error("Refusing Docker commands after an unsettled process group");
    }
    disposition.started += 1;
    let execution;
    try {
      execution = execute("docker", ["--host=unix:///var/run/docker.sock", ...args], {
        env,
        detached: true,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      disposition.unknown += 1;
      throw error;
    }
    let result;
    let commandError;
    let failed = false;
    try {
      result = await execution;
    } catch (error) {
      commandError = error;
      failed = true;
    }
    try {
      await observeGroup(execution.child?.pid);
      disposition.settled += 1;
    } catch (error) {
      disposition.unknown += 1;
      throw new AggregateError(
        failed ? [commandError, error] : [error],
        "Docker command process group did not settle",
        { cause: error },
      );
    }
    if (failed) {
      throw commandError;
    }
    return result;
  };
  docker.disposition = () => ({
    ...disposition,
    escapedDescendants: "not-observed",
  });
  return docker;
}

// This only selects the dedicated workflow route. It is not an attestation of
// engine ownership; that boundary comes from the job and its execution order.
export function isRuntimeImageJob(env) {
  return (
    env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_ENVIRONMENT === "github-hosted" &&
    env.GITHUB_JOB === "runtime-image-fixture" &&
    Boolean(env.OCC_RUNTIME_IMAGE_RECEIPT)
  );
}

// The caller supplies unique tags and build inputs. A failed Docker command can
// have an unknown effect; names or labels alone never authorize cleanup.
export async function withRuntimeImageFixture(docker, directory, run, { receiptPath } = {}) {
  const images = new Map();
  const tags = new Map();
  const containers = new Set();
  const uncertain = [];
  const cleanupErrors = [];
  const history = [];
  let primary;
  let primaryFailed = false;
  let value;
  let pending;

  async function receipt(operation, status, reference) {
    if (!receiptPath) {
      return;
    }
    if (status === "pending") {
      pending = { operation, reference };
    }
    if (status === "acknowledged") {
      pending = undefined;
    }
    history.push({ operation, status, reference });
    const temp = `${receiptPath}.${process.pid}.tmp`;
    await writeFile(
      temp,
      `${JSON.stringify({ operation, status, reference, images: [...images.keys()], tags: [...tags], containers: [...containers], uncertain, pending, history, processes: docker.disposition?.() ?? "not-observed" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temp, receiptPath);
  }

  async function inspect(ref) {
    const parsed = JSON.parse((await docker("image", "inspect", ref)).stdout);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 1 ||
      typeof parsed[0]?.Id !== "string" ||
      !imageIdPattern.test(parsed[0].Id)
    ) {
      throw new Error(`Docker returned invalid image identity for ${ref}`);
    }
    return parsed[0];
  }

  function references(image, id) {
    if (!Object.hasOwn(image, "RepoTags") || !Object.hasOwn(image, "RepoDigests")) {
      throw new Error(`Docker omitted reference information for ${id}`);
    }
    const repoTags = image.RepoTags ?? [];
    const repoDigests = image.RepoDigests ?? [];
    if (
      !Array.isArray(repoTags) ||
      !repoTags.every((tag) => typeof tag === "string") ||
      !Array.isArray(repoDigests) ||
      !repoDigests.every((digest) => typeof digest === "string")
    ) {
      throw new Error(`Docker returned invalid reference information for ${id}`);
    }
    return { repoTags, repoDigests };
  }

  async function ensureUnusedTag(tag) {
    try {
      await docker("image", "inspect", tag);
    } catch (error) {
      if (/No such image/i.test(error?.stderr ?? error?.message ?? "")) {
        return;
      }
      throw error;
    }
    throw new Error(`Refusing to overwrite an existing tag: ${tag}`);
  }

  function requireKnownEffects() {
    if (uncertain.length) {
      throw new Error("Refusing fixture operations after an unknown effect");
    }
  }

  const fixture = {
    async build(tag, iidfile, nonce, baseId) {
      requireKnownEffects();
      await ensureUnusedTag(tag);
      try {
        await receipt("build", "pending", tag);
        await docker(
          "build",
          "--builder",
          "default",
          "--load",
          "--build-arg",
          `FIXTURE_NONCE=${nonce}`,
          "--iidfile",
          iidfile,
          "-t",
          tag,
          directory,
        );
        const id = (await readFile(iidfile, "utf8")).trim();
        if (!imageIdPattern.test(id) || id === baseId || images.has(id)) {
          throw new Error(`Build did not produce a distinct owned image for ${tag}`);
        }
        images.set(id, true);
        tags.set(tag, id);
        await receipt("build", "acknowledged", tag);
        return id;
      } catch (error) {
        uncertain.push(`build outcome for ${tag} is unknown`);
        throw error;
      }
    },
    async buildRuntimeBase(tag, iidfile, dockerfile, context) {
      requireKnownEffects();
      await ensureUnusedTag(tag);
      try {
        await receipt("base-build", "pending", tag);
        await docker(
          "build",
          "--builder",
          "default",
          "--load",
          "--pull=false",
          "-f",
          dockerfile,
          "--iidfile",
          iidfile,
          "-t",
          tag,
          context,
        );
        const id = (await readFile(iidfile, "utf8")).trim();
        if (!imageIdPattern.test(id) || images.has(id)) {
          throw new Error(`Invalid runtime base image ID for ${tag}`);
        }
        images.set(id, true);
        tags.set(tag, id);
        await receipt("base-build", "acknowledged", tag);
        return id;
      } catch (error) {
        uncertain.push(`runtime base build outcome for ${tag} is unknown`);
        throw error;
      }
    },
    async inspectImage(ref) {
      requireKnownEffects();
      return inspect(ref);
    },
    async create(name, args) {
      requireKnownEffects();
      try {
        await receipt("container-create", "pending", name);
        const id = (await docker("create", "--name", name, ...args)).stdout.trim();
        if (!containerIdPattern.test(id)) {
          throw new Error(`Docker returned invalid container identity for ${name}`);
        }
        containers.add(id);
        await receipt("container-create", "acknowledged", id);
        return id;
      } catch (error) {
        uncertain.push(`container creation outcome for ${name} is unknown`);
        throw error;
      }
    },
    async startAttached(id) {
      requireKnownEffects();
      if (!containers.has(id)) {
        throw new Error(`Refusing to start an unowned container ${id}`);
      }
      try {
        await receipt("container-start", "pending", id);
        await docker("start", "--attach", id);
        await receipt("container-start", "acknowledged", id);
      } catch (error) {
        uncertain.push(`container start outcome for ${id} is unknown`);
        throw error;
      }
    },
    async removeContainer(id) {
      requireKnownEffects();
      if (!containers.has(id)) {
        throw new Error(`Refusing to remove an unowned container ${id}`);
      }
      try {
        await receipt("container-remove", "pending", id);
        await docker("rm", "-f", id);
        containers.delete(id);
        await receipt("container-remove", "acknowledged", id);
      } catch (error) {
        containers.delete(id);
        uncertain.push(`container removal outcome for ${id} is unknown`);
        throw error;
      }
    },
    async retag(id, tag) {
      requireKnownEffects();
      if (!images.has(id) || !tags.has(tag)) {
        throw new Error("Refusing to retag an unowned fixture image or tag");
      }
      if ((await inspect(tag)).Id !== tags.get(tag)) {
        throw new Error(`Refusing to retarget changed tag: ${tag}`);
      }
      try {
        await receipt("retag", "pending", tag);
        await docker("tag", id, tag);
        tags.set(tag, id);
        await receipt("retag", "acknowledged", tag);
      } catch (error) {
        uncertain.push(`retag outcome for ${tag} is unknown`);
        throw error;
      }
    },
  };

  try {
    await receipt("fixture", "started");
    value = await run(fixture);
  } catch (error) {
    primary = error;
    primaryFailed = true;
  }

  if (docker.disposition?.().unknown) {
    uncertain.push("Docker command process group did not settle");
  }

  for (const id of uncertain.length ? [] : [...containers]) {
    try {
      await fixture.removeContainer(id);
    } catch (error) {
      cleanupErrors.push(error);
      break;
    }
  }

  // The dedicated hosted job owns the VM and runs this fixture serially. Docker
  // has no compare-and-delete for tags; callers must supply that writer boundary.
  // On any ambiguous effect, do not infer absence or issue further image writes.
  if (uncertain.length === 0 && cleanupErrors.length === 0) {
    try {
      for (const [tag, expected] of tags) {
        if ((await inspect(tag)).Id !== expected) {
          throw new Error(`Tag changed: ${tag}`);
        }
      }
      for (const id of images.keys()) {
        const image = await inspect(id);
        const { repoTags, repoDigests } = references(image, id);
        if (
          image.Id !== id ||
          repoDigests.length ||
          repoTags.some((tag) => tags.get(tag) !== id) ||
          [...tags].some(([tag, target]) => target === id && !repoTags.includes(tag))
        ) {
          throw new Error(`Image ${id} has unowned references`);
        }
      }
      for (const id of [...images.keys()].reverse()) {
        let deleted = false;
        for (const [tag, target] of tags) {
          if (target !== id) {
            continue;
          }
          await receipt("image-tag-remove", "pending", tag);
          const result = await docker("image", "rm", "--no-prune", tag);
          const lines = result.stdout.split(/\r?\n/);
          if (!lines.includes(`Untagged: ${tag}`)) {
            throw new Error(`Tag removal was not acknowledged for ${tag}`);
          }
          tags.delete(tag);
          if (lines.includes(`Deleted: ${id}`)) {
            if ([...tags.values()].includes(id)) {
              throw new Error(`Image ${id} was deleted with recorded tags remaining`);
            }
            images.delete(id);
            deleted = true;
          }
          await receipt("image-tag-remove", "acknowledged", tag);
        }
        if (deleted) {
          continue;
        }
        const image = await inspect(id);
        const { repoTags, repoDigests } = references(image, id);
        if (image.Id !== id || repoTags.length || repoDigests.length) {
          throw new Error(`Image ${id} still has references`);
        }
        await receipt("image-remove", "pending", id);
        const result = await docker("image", "rm", "--no-prune", id);
        if (!result.stdout.split(/\r?\n/).includes(`Deleted: ${id}`)) {
          throw new Error(`Image removal was not acknowledged for ${id}`);
        }
        images.delete(id);
        await receipt("image-remove", "acknowledged", id);
      }
    } catch (error) {
      cleanupErrors.push(error);
      uncertain.push(
        "image cleanup incomplete or outcome unknown; no further image removal attempted",
      );
    }
  }

  if (uncertain.length) {
    cleanupErrors.push(
      new Error(
        `Unresolved fixture resources: ${uncertain.join("; ")}; recorded image IDs: ${[...images.keys()].join(", ") || "none"}; recorded tag names: ${[...tags.keys()].join(", ") || "none"}; directory: ${directory ?? "none"}`,
      ),
    );
  } else if (directory) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await receipt("fixture", uncertain.length || cleanupErrors.length ? "unknown" : "complete");
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      primaryFailed ? [primary, ...cleanupErrors] : cleanupErrors,
      "Runtime image fixture and cleanup failed",
    );
  }
  if (primaryFailed) {
    throw primary;
  }
  return value;
}
