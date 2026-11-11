import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function removeImageFileContainer({ command, resource, final = true }) {
  if (resource.removed !== true) {
    // A lost create reply still leaves this name owned. Cleanup must outlive
    // cancellation, but shares one finite deadline for lookup and removal.
    const options = {
      signal: AbortSignal.timeout(30_000),
      timeout: 30_000,
    };
    const deadline = Date.now() + options.timeout;
    const run = (args) => {
      options.signal.throwIfAborted();
      return command("docker", args, { ...options, timeout: Math.max(1, deadline - Date.now()) });
    };
    try {
      while (true) {
        const container = (
          await run([
            "ps",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            `name=^/${resource.name}$`,
          ])
        ).trim();
        if (container) {
          assert.match(container, /^[a-f0-9]{64}$/);
          if (resource.containerId !== undefined && resource.containerId !== container) {
            throw new Error(`Image extraction container changed identity: ${resource.name}`);
          }
          await run(["rm", "--volumes", container]);
          resource.removed = true;
          return;
        }
        if (resource.creationAcknowledged === true) {
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
  platform = undefined,
  filename,
  destination,
  resource = { name: `oce-git-extract-${randomUUID()}` },
  persist = async () => {},
}) {
  const remove = async (final = false) => {
    await removeImageFileContainer({ command, resource, final });
    await persist();
  };
  cleanup.push(() => remove(true));
  const errors = [];
  try {
    const container = (
      await command("docker", [
        "create",
        "--name",
        resource.name,
        ...(platform ? ["--platform", platform] : []),
        image,
      ])
    ).trim();
    resource.creationAcknowledged = true;
    assert.match(container, /^[a-f0-9]{64}$/);
    resource.containerId = container;
    await persist();
    await command("docker", ["cp", `${container}:${filename}`, destination]);
  } catch (error) {
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
