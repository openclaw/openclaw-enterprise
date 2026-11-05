import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";

type ProtectedFileRead = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false };

// Success transfers the returned bytes to the caller for disposal. Failure
// carries no filesystem details or partially read material.
export async function readProtectedFile(
  path: string,
  maximum: number,
  privateFile = true,
): Promise<ProtectedFileRead> {
  try {
    return { ok: true, bytes: await readProtectedBytes(path, maximum, privateFile) };
  } catch {
    return { ok: false };
  }
}

async function readProtectedBytes(
  path: string,
  maximum: number,
  privateFile: boolean,
): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("invalid-protected-file");
  }
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
  // Validate from the root so each trusted prefix protects the next component
  // against replacement by another user. Root-owned sticky ancestors permit
  // private directories beneath /tmp; the immediate parent must stay unwritable.
  for (const ancestor of ancestors.reverse()) {
    const stat = await lstat(ancestor);
    const rootStickyAncestor =
      ancestor !== immediateParent && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (uid !== undefined && stat.uid !== uid && stat.uid !== 0) ||
      ((stat.mode & 0o022) !== 0 && !rootStickyAncestor)
    ) {
      throw new Error("invalid-protected-file");
    }
  }
  return readBoundedFile(
    path,
    maximum,
    (stat) =>
      (uid === undefined || stat.uid === uid || stat.uid === 0) &&
      (stat.mode & (privateFile ? 0o077 : 0o022)) === 0,
  );
}

// The caller must validate the path and its ancestors before supplying the file's owner and mode check.
export async function readBoundedFile(
  path: string,
  maximum: number,
  acceptsMetadata: (stat: Stats) => boolean,
): Promise<Buffer> {
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
        !acceptsMetadata(before)
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
