import { stat, type FileHandle } from "node:fs/promises";

/** Read one bounded snapshot while allowing public projected-file symlinks. */
export async function readPublicFile(
  handle: FileHandle,
  path: string,
  maxBytes: number,
  invalidFileMessage: string,
): Promise<Buffer> {
  const before = await handle.stat();
  if (
    !before.isFile() ||
    before.size < 1 ||
    before.size > maxBytes ||
    (before.mode & 0o022) !== 0
  ) {
    throw new Error(invalidFileMessage);
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
    throw new Error(invalidFileMessage);
  }
  return bytes.subarray(0, length);
}
