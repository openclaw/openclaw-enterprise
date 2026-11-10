import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function assertPrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  let cursor = absolute;
  while (true) {
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("unsafe-client-directory");
    }
    if (cursor === absolute && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
      throw new Error("unsafe-client-directory");
    }
    // A sticky ancestor such as /tmp protects each user's owned child directory.
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      throw new Error("unsafe-client-directory");
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
}

export async function readPrivateFile(path: string, maximumBytes: number): Promise<Buffer> {
  await assertPrivateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    const named = await lstat(path);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size > maximumBytes ||
      before.nlink !== 1 ||
      before.dev !== named.dev ||
      before.ino !== named.ino
    ) {
      throw new Error("unsafe-client-file");
    }
    const bytes = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size <= maximumBytes) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (result.bytesRead === 0) {
        break;
      }
      size += result.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (
      size > maximumBytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev
    ) {
      bytes.fill(0);
      throw new Error("client-file-changed");
    }
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}
