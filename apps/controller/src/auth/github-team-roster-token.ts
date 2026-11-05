import { constants } from "node:fs";
import { access, lstat, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

import {
  readBoundedFile,
  readProtectedFile,
} from "../composition/repository-credentials/protected-file.ts";

/** Accept a private regular file or the single key exposed by a rotating Kubernetes Secret. */
export async function readGitHubRosterTokenFile(path: string, maximum: number): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path).startsWith(".")) {
    throw new Error("invalid-protected-file");
  }
  if (!(await lstat(path)).isSymbolicLink()) {
    const protectedFile = await readProtectedFile(path, maximum);
    if (!protectedFile.ok) {
      throw new Error("invalid-protected-file");
    }
    return protectedFile.bytes;
  }
  const directory = dirname(path);
  const data = join(directory, "..data");
  const generation = await readlink(data);
  if (
    !generation.startsWith("..") ||
    generation === ".." ||
    generation !== basename(generation) ||
    (await readlink(path)) !== `..data/${basename(path)}`
  ) {
    throw new Error("invalid-secret-projection");
  }
  const bytes = await readGenerationKey(
    join(directory, generation, basename(path)),
    maximum,
    directory,
  );
  try {
    if (
      (await readlink(data)) !== generation ||
      (await readlink(path)) !== `..data/${basename(path)}`
    ) {
      throw new Error("changed-secret-projection");
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

async function onReadOnlyMount(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EROFS";
  }
}

async function readGenerationKey(
  path: string,
  maximum: number,
  projectionDirectory: string,
): Promise<Buffer> {
  const uid = process.getuid?.();
  const immediateParent = dirname(path);
  const ancestors: string[] = [];
  let parent = immediateParent;
  for (;;) {
    ancestors.push(parent);
    if (parent === parse(parent).root) {
      break;
    }
    parent = dirname(parent);
  }
  // A Secret mount can report writable tmpfs permission bits even though kubelet
  // mounts it read-only in the worker. Only accept this exception on the mount
  // itself, with EROFS as evidence. The generation must still be a trusted directory.
  for (const ancestor of ancestors.reverse()) {
    const stat = await lstat(ancestor);
    const rootStickyAncestor =
      ancestor !== immediateParent && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (uid !== undefined && stat.uid !== uid && stat.uid !== 0) ||
      ((stat.mode & 0o022) !== 0 &&
        !(rootStickyAncestor && ancestor !== projectionDirectory) &&
        !(ancestor === projectionDirectory && (await onReadOnlyMount(ancestor))))
    ) {
      throw new Error("invalid-protected-file");
    }
  }
  return readBoundedFile(
    path,
    maximum,
    (stat) =>
      (uid === undefined || stat.uid === uid || stat.uid === 0) &&
      (stat.mode & 0o037) === 0 &&
      ((stat.mode & 0o040) === 0 || process.getgroups?.().includes(stat.gid) === true),
  );
}
