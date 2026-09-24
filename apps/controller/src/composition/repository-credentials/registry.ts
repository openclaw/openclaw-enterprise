import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  GITHUB_REPOSITORY_REGISTRY_MAX_BYTES,
  validateGitHubRepositoryRegistry,
} from "../../drivers/repo/github/credentials/registry.ts";
import type { GitHubRepositoryRegistry } from "../../drivers/repo/github/credentials/registry.ts";

/** ConfigMap projections may use symlinks; one opened regular file supplies the snapshot. */
export async function loadGitHubRepositoryRegistry(
  path: string,
  expectedBackendId: string,
): Promise<GitHubRepositoryRegistry> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("invalid-repository-registry");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > GITHUB_REPOSITORY_REGISTRY_MAX_BYTES ||
      (before.mode & 0o022) !== 0
    ) {
      throw new Error("invalid-repository-registry");
    }
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) {
        break;
      }
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await stat(path);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error("invalid-repository-registry");
    }
    return validateGitHubRepositoryRegistry(
      JSON.parse(bytes.subarray(0, length).toString("utf8")),
      expectedBackendId,
    );
  } catch {
    throw new Error("invalid-repository-registry");
  } finally {
    await handle.close();
  }
}
