import { constants } from "node:fs";
import { access, lstat, open, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

import { readProtectedFile } from "../composition/repository-credentials/protected-file.ts";

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
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer | undefined;
  let candidate: Buffer | undefined;
  try {
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size < 1 ||
        before.size > maximum ||
        (uid !== undefined && before.uid !== uid && before.uid !== 0) ||
        (before.mode & 0o037) !== 0 ||
        ((before.mode & 0o040) !== 0 && !process.getgroups?.().includes(before.gid))
      ) {
        throw new Error("invalid-protected-file");
      }
      data = Buffer.alloc(before.size + 1);
      let position = 0;
      while (position < data.length) {
        const result = await handle.read(data, position, data.length - position, position);
        if (!result.bytesRead) {
          break;
        }
        position += result.bytesRead;
      }
      const after = await handle.stat();
      const named = await lstat(path);
      if (
        position !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        named.isSymbolicLink() ||
        named.dev !== before.dev ||
        named.ino !== before.ino
      ) {
        throw new Error("invalid-protected-file");
      }
      candidate = Buffer.from(data.subarray(0, position));
    } finally {
      data?.fill(0);
      await handle.close();
    }
    // The caller owns this copy only after descriptor cleanup succeeds.
    return candidate;
  } catch (error) {
    candidate?.fill(0);
    throw error;
  }
}
