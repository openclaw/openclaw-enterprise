import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  GITHUB_REPOSITORY_REGISTRY_MAX_BYTES,
  validateGitHubRepositoryRegistry,
} from "../../drivers/repo/github/access/registry.ts";
import type { GitHubRepositoryRegistry } from "../../drivers/repo/github/access/registry.ts";
import { readPublicFile } from "./public-file.ts";

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
    const bytes = await readPublicFile(
      handle,
      path,
      GITHUB_REPOSITORY_REGISTRY_MAX_BYTES,
      "invalid-repository-registry",
    );
    return validateGitHubRepositoryRegistry(JSON.parse(bytes.toString("utf8")), expectedBackendId);
  } catch {
    throw new Error("invalid-repository-registry");
  } finally {
    await handle.close();
  }
}
