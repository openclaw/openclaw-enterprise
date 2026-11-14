import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ownershipLabel = "org.openclaw.ci.image-file";

export class ImageFileReadError extends Error {}

export type ImageFileContainerReceipt = {
  name: string;
  // Cleanup reads persisted fields at the point where each one is needed.
  containerId?: unknown;
  ownershipToken?: unknown;
  creationAcknowledged?: unknown;
  removed?: unknown;
};

export type ImageFileResource = {
  name: string;
  containerId?: string;
  ownershipToken?: string | null;
  creationAcknowledged?: boolean;
  removed?: boolean;
};

export type ImageFileCleanup = () => Promise<void>;

type CommandLimits = { signal?: AbortSignal; timeout?: number; maxBuffer?: number };
export type ImageFileTextOptions = CommandLimits & { encoding?: "utf8" };
export type ImageFileArchiveOptions = CommandLimits & { encoding: "buffer"; maxBuffer: number };
type ImageFileTextCommand = (
  executable: "docker",
  args: string[],
  options?: ImageFileTextOptions,
) => Promise<string>;
export type ImageFileArchiveCommand = ImageFileTextCommand &
  ((executable: "docker", args: string[], options: ImageFileArchiveOptions) => Promise<Buffer>);

type ContainerRemoval = {
  command: ImageFileTextCommand;
  resource: ImageFileContainerReceipt;
  final?: boolean;
  persist?: ImageFileCleanup;
};

type ImageFileExtraction = {
  cleanup: Pick<ImageFileCleanup[], "push">;
  image: string;
  platform?: string;
  pullNever?: boolean;
  filename: string;
  destination: string;
  resource?: ImageFileResource;
  persist?: ImageFileCleanup;
} & (
  | { command: ImageFileTextCommand; maxBytes?: undefined }
  | { command: ImageFileArchiveCommand; maxBytes: number }
);

function failureField(error: unknown, field: "code" | "message"): unknown {
  // The command adapter can reject with any value. Use ordinary property
  // access semantics, including inherited fields and the original receiver.
  if (error === null || error === undefined) {
    throw new TypeError(`Cannot read properties of ${error} (reading '${field}')`);
  }
  const target: object = Object(error);
  const value: unknown = Reflect.get(target, field, error);
  return value;
}

function createNeverStarted(error: unknown): boolean {
  const code = failureField(error, "code");
  return code === "ENOENT" || code === "EACCES";
}

// docker cp's stdout is a tar archive. Accept one ordinary file, never paths,
// links, directories or extensions that can reinterpret the selected member.
function singleFile(archive: Buffer, filename: string, maxBytes: number): Buffer {
  assert.ok(Buffer.isBuffer(archive) && archive.length >= 1536);
  const header = archive.subarray(0, 512);
  const field = (start: number, end: number) =>
    header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
  const octal = (start: number, end: number) => {
    const value = field(start, end).trim();
    assert.match(value, /^[0-7]+$/);
    return Number.parseInt(value, 8);
  };
  const checked = Buffer.from(header);
  checked.fill(32, 148, 156);
  assert.equal(
    checked.reduce((sum, byte) => sum + byte, 0),
    octal(148, 156),
  );
  assert.equal(field(0, 100), basename(filename));
  assert.equal(field(345, 500), "");
  assert.ok(header[156] === 0 || header[156] === 48);
  const size = octal(124, 136);
  assert.ok(Number.isSafeInteger(size) && size <= maxBytes);
  const end = 512 + Math.ceil(size / 512) * 512;
  assert.ok(end + 1024 <= archive.length);
  assert.ok(
    archive.subarray(512 + size).every((byte) => byte === 0),
    "Image file archive contains nonzero padding or additional data.",
  );
  return archive.subarray(512, 512 + size);
}

export async function removeImageFileContainer({
  command,
  resource,
  final = true,
  persist = async () => {},
}: ContainerRemoval): Promise<void> {
  if (resource.removed !== true) {
    // A lost create reply still leaves this name owned. Cleanup must outlive
    // cancellation, but shares one finite deadline for lookup and removal.
    const options = {
      signal: AbortSignal.timeout(30_000),
      timeout: 30_000,
    };
    const deadline = Date.now() + options.timeout;
    const run = (args: string[]) => {
      options.signal.throwIfAborted();
      return command("docker", args, { ...options, timeout: Math.max(1, deadline - Date.now()) });
    };
    const listContainers = (filter: string) =>
      run(["ps", "--all", "--quiet", "--no-trunc", "--filter", filter]);
    try {
      if (resource.containerId === undefined) {
        assert.ok(
          typeof resource.ownershipToken === "string" &&
            /^[a-f0-9-]{36}$/.test(resource.ownershipToken),
          "Invalid image extraction ownership token",
        );
      }
      while (true) {
        let container = (await listContainers(`name=^/${resource.name}$`)).trim();
        if (!container && resource.containerId !== undefined) {
          // Docker names can change. The established ID remains our resource.
          assert.ok(
            typeof resource.containerId === "string" && /^[a-f0-9]{64}$/.test(resource.containerId),
            "Invalid image extraction container identity",
          );
          container = (await listContainers(`id=${resource.containerId}`)).trim();
        }
        if (!container && resource.containerId === undefined) {
          container = (
            await listContainers(`label=${ownershipLabel}=${resource.ownershipToken}`)
          ).trim();
        }
        if (container) {
          assert.ok(
            /^[a-f0-9]{64}$/.test(container),
            "Invalid image extraction container inventory",
          );
          if (resource.containerId !== undefined && resource.containerId !== container) {
            throw new Error(`Image extraction container changed identity: ${resource.name}`);
          }
          if (resource.containerId === undefined) {
            const token = (
              await run([
                "container",
                "inspect",
                "--format",
                `{{ index .Config.Labels "${ownershipLabel}" }}`,
                container,
              ])
            ).trim();
            if (token !== resource.ownershipToken) {
              throw new Error(`Image extraction container ownership changed: ${resource.name}`);
            }
            resource.containerId = container;
          }
          await persist();
          await run(["rm", "--volumes", container]);
          resource.removed = true;
          return;
        }
        if (resource.creationAcknowledged === true || resource.containerId !== undefined) {
          resource.removed = true;
          return;
        }
        // An unanswered create can finish after this empty snapshot. Retain
        // ownership for teardown, where bounded reconciliation must settle it.
        if (!final) {
          return;
        }
        await delay(250, undefined, { signal: options.signal });
      }
    } catch (error) {
      if (options.signal.aborted) {
        throw new Error(`Image extraction cleanup is unresolved for container ${resource.name}`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

export async function extractImageFile({
  command,
  cleanup,
  image,
  platform,
  pullNever = false,
  filename,
  destination,
  maxBytes,
  resource = { name: `oce-git-extract-${randomUUID()}` },
  persist = async () => {},
}: ImageFileExtraction): Promise<void> {
  const remove = async (final = false) => {
    await removeImageFileContainer({ command, resource, final, persist });
    await persist();
  };
  cleanup.push(() => remove(true));
  const errors: unknown[] = [];
  let dispatched = false;
  try {
    resource.ownershipToken ??= randomUUID();
    await persist();
    dispatched = true;
    const container = (
      await command("docker", [
        "create",
        "--name",
        resource.name,
        "--label",
        `${ownershipLabel}=${resource.ownershipToken}`,
        ...(platform ? ["--platform", platform] : []),
        ...(pullNever ? ["--pull=never"] : []),
        image,
        "/bin/true",
      ])
    ).trim();
    resource.creationAcknowledged = true;
    assert.ok(/^[a-f0-9]{64}$/.test(container), "Invalid image extraction create response");
    resource.containerId = container;
    await persist();
    try {
      if (maxBytes === undefined) {
        await command("docker", ["cp", `${container}:${filename}`, destination]);
      } else {
        const archive = await command("docker", ["cp", `${container}:${filename}`, "-"], {
          encoding: "buffer",
          maxBuffer: maxBytes + 16 * 1024,
        });
        await writeFile(destination, singleFile(archive, filename, maxBytes), {
          flag: "wx",
          mode: 0o600,
        });
      }
    } catch (error) {
      const message = failureField(error, "message");
      throw new ImageFileReadError(message === undefined ? undefined : `${message}`, {
        cause: error,
      });
    }
  } catch (error) {
    // These spawn errors prove Docker was never started. A generic nonzero
    // exit or transport error cannot establish whether creation completed.
    if (!dispatched || (!resource.creationAcknowledged && createNeverStarted(error))) {
      resource.removed = true;
    }
    errors.push(error);
  }
  try {
    await remove();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Image extraction and container cleanup failed");
  }
}
