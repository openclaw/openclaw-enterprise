import { readFile, rename, rm, writeFile } from "node:fs/promises";

type CommandResult = { stdout: string };
type CommandExecution<R> = Promise<R> & { child?: { pid?: number | undefined } };
type Execute<R> = (
  command: string,
  args: (string | undefined)[],
  options: { env: NodeJS.ProcessEnv; detached: boolean; maxBuffer: number },
) => CommandExecution<R>;
type Disposition = {
  started: number;
  settled: number;
  unknown: number;
  escapedDescendants: string;
};
type Docker = ((...args: (string | undefined)[]) => Promise<CommandResult>) & {
  disposition?: () => Disposition;
};
type ReceiptEntry = { operation: string; status: string; reference?: string | undefined };

function property(value: unknown, key: string): unknown {
  const boxed: unknown = Object.prototype.valueOf.call(value);
  if ((typeof boxed === "object" && boxed !== null) || typeof boxed === "function") {
    return Reflect.get(boxed, key, value);
  }
  throw new TypeError("Cannot access property");
}

function optionalProperty(value: unknown, key: string): unknown {
  return value == null ? undefined : property(value, key);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const containerIdPattern = /^[a-f0-9]{64}$/;

export function assertProcessGroupSettled(pid: number | undefined) {
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    process.platform === "win32"
  ) {
    throw new Error("Docker command process group cannot be observed");
  }
  try {
    process.kill(-pid, 0);
  } catch (error) {
    const boxed: unknown = Object.prototype.valueOf.call(error);
    if ((typeof boxed === "object" && boxed !== null) || typeof boxed === "function") {
      const code: unknown = Reflect.get(boxed, "code", error);
      if (code === "ESRCH") {
        return;
      }
    }
    throw error;
  }
  throw new Error(`Docker command process group ${pid} is still active`);
}

// DockerComputeDriver uses this Unix socket directly. Remove inherited endpoint
// and TLS overrides so the fixture CLI cannot silently target another engine.
export function localDockerCli<R>(
  execute: Execute<R>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  observeGroup: (pid: number | undefined) => void | Promise<void> = assertProcessGroupSettled,
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
  const docker = async (...args: (string | undefined)[]) => {
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
    let outcome: { failed: false; result: Awaited<R> } | { failed: true; error: unknown };
    try {
      outcome = { failed: false, result: await execution };
    } catch (error) {
      outcome = { failed: true, error };
    }
    try {
      await observeGroup(execution.child?.pid);
      disposition.settled += 1;
    } catch (error) {
      disposition.unknown += 1;
      throw new AggregateError(
        outcome.failed ? [outcome.error, error] : [error],
        "Docker command process group did not settle",
        { cause: error },
      );
    }
    if (outcome.failed) {
      throw outcome.error;
    }
    return outcome.result;
  };
  docker.disposition = () => ({
    ...disposition,
    escapedDescendants: "not-observed",
  });
  return docker;
}

// This only selects the dedicated workflow route. It is not an attestation of
// engine ownership; that boundary comes from the job and its execution order.
export function isRuntimeImageJob(env: NodeJS.ProcessEnv) {
  return (
    env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_ENVIRONMENT === "github-hosted" &&
    env.GITHUB_JOB === "runtime-image-fixture" &&
    Boolean(env.OCC_RUNTIME_IMAGE_RECEIPT)
  );
}

// The caller supplies unique tags and build inputs. A failed Docker command can
// have an unknown effect; names or labels alone never authorize cleanup.
type RuntimeImageFixture = {
  build(tag: string, iidfile: string, nonce: string, baseId: string): Promise<string>;
  buildRuntimeBase(
    tag: string,
    iidfile: string,
    dockerfile: string,
    context: string,
  ): Promise<string>;
  inspectImage(ref: string): Promise<unknown>;
  create(name: string, args: string[]): Promise<string>;
  startAttached(id: string): Promise<void>;
  removeContainer(id: string): Promise<void>;
  retag(id: string, tag: string): Promise<void>;
};

export async function withRuntimeImageFixture<T>(
  docker: Docker,
  directory: string | undefined,
  run: (fixture: RuntimeImageFixture) => T | Promise<T>,
  { receiptPath }: { receiptPath?: string | undefined } = {},
) {
  const images = new Map<string, boolean>();
  const tags = new Map<string, string>();
  const containers = new Set<string>();
  const uncertain: string[] = [];
  const cleanupErrors: unknown[] = [];
  const history: ReceiptEntry[] = [];
  let outcome: { failed: false; value: Awaited<T> } | { failed: true; error: unknown };
  let pending: { operation: string; reference?: string | undefined } | undefined;

  async function receipt(operation: string, status: string, reference?: string) {
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

  async function inspect(ref: string): Promise<unknown> {
    const parsed: unknown = JSON.parse((await docker("image", "inspect", ref)).stdout);
    if (
      !isUnknownArray(parsed) ||
      parsed.length !== 1 ||
      typeof optionalProperty(parsed[0], "Id") !== "string" ||
      !Reflect.apply(RegExp.prototype.test, imageIdPattern, [property(parsed[0], "Id")])
    ) {
      throw new Error(`Docker returned invalid image identity for ${ref}`);
    }
    return parsed[0];
  }

  function references(image: unknown, id: string) {
    if (
      !Object.hasOwn(Object.prototype.valueOf.call(image), "RepoTags") ||
      !Object.hasOwn(Object.prototype.valueOf.call(image), "RepoDigests")
    ) {
      throw new Error(`Docker omitted reference information for ${id}`);
    }
    const repoTags = property(image, "RepoTags") ?? [];
    const repoDigests = property(image, "RepoDigests") ?? [];
    if (
      !Array.isArray(repoTags) ||
      !repoTags.every((tag) => typeof tag === "string") ||
      !Array.isArray(repoDigests) ||
      !repoDigests.every((digest) => typeof digest === "string")
    ) {
      throw new Error(`Docker returned invalid reference information for ${id}`);
    }
    // Docker's containerd image store lists `<repository>@<image ID>` for each
    // repository the image is tagged in; those entries follow the tags. Any other
    // digest records a pull or push, which this fixture never makes. Inspect cannot
    // tell such an entry from a record pulled by that exact digest, which would
    // need this run's own nonce-unique image pulled back under an owned repository.
    const derived = new Set(repoTags.map((tag) => `${tag.slice(0, tag.lastIndexOf(":"))}@${id}`));
    return { repoTags, foreignDigests: repoDigests.filter((digest) => !derived.has(digest)) };
  }

  async function ensureUnusedTag(tag: string) {
    try {
      await docker("image", "inspect", tag);
    } catch (error) {
      const stderr: unknown =
        error == null ? undefined : Reflect.get(Object(error), "stderr", error);
      const message: unknown =
        stderr == null && error != null ? Reflect.get(Object(error), "message", error) : undefined;
      const detail = stderr ?? message ?? "";
      if (Reflect.apply(RegExp.prototype.test, /No such image/i, [detail])) {
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
    async build(tag: string, iidfile: string, nonce: string, baseId: string) {
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
    async buildRuntimeBase(tag: string, iidfile: string, dockerfile: string, context: string) {
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
    async inspectImage(ref: string) {
      requireKnownEffects();
      return inspect(ref);
    },
    async create(name: string, args: string[]) {
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
    async startAttached(id: string) {
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
    async removeContainer(id: string) {
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
    async retag(id: string, tag: string) {
      requireKnownEffects();
      if (!images.has(id) || !tags.has(tag)) {
        throw new Error("Refusing to retag an unowned fixture image or tag");
      }
      if (property(await inspect(tag), "Id") !== tags.get(tag)) {
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
    outcome = { failed: false, value: await run(fixture) };
  } catch (error) {
    outcome = { failed: true, error };
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
        if (property(await inspect(tag), "Id") !== expected) {
          throw new Error(`Tag changed: ${tag}`);
        }
      }
      for (const id of images.keys()) {
        const image = await inspect(id);
        const { repoTags, foreignDigests } = references(image, id);
        if (
          property(image, "Id") !== id ||
          foreignDigests.length ||
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
        const { repoTags, foreignDigests } = references(image, id);
        if (property(image, "Id") !== id || repoTags.length || foreignDigests.length) {
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
      outcome.failed ? [outcome.error, ...cleanupErrors] : cleanupErrors,
      "Runtime image fixture and cleanup failed",
    );
  }
  if (outcome.failed) {
    throw outcome.error;
  }
  return outcome.value;
}
