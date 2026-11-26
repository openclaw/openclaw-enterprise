import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

type FileSource = Readonly<{
  uid: number | undefined;
  privateFile: boolean;
  statName(): Promise<Stats>;
}>;

// Each loader pins the directory, opens the exact file without following links, and
// rechecks that same name. This reader owns the descriptor until close succeeds.
export async function readStableDescriptor(
  handle: FileHandle,
  maximum: number,
  { uid, privateFile, statName }: FileSource,
): Promise<Buffer> {
  let scratch: Buffer | undefined;
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
        (before.mode & (privateFile ? 0o077 : 0o022)) !== 0
      ) {
        throw new Error("invalid-mounted-file");
      }
      scratch = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < scratch.length) {
        const { bytesRead } = await handle.read(scratch, offset, scratch.length - offset, offset);
        if (!bytesRead) {
          break;
        }
        offset += bytesRead;
      }
      const after = await handle.stat();
      const named = await statName();
      if (
        offset !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        named.isSymbolicLink() ||
        named.dev !== before.dev ||
        named.ino !== before.ino
      ) {
        throw new Error("invalid-mounted-file");
      }
      candidate = Buffer.from(scratch.subarray(0, offset));
    } finally {
      scratch?.fill(0);
      await handle.close();
    }
    return candidate;
  } catch (error) {
    candidate?.fill(0);
    throw error;
  }
}
