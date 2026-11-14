import type { PathLike } from "node:fs";
import { lstat } from "node:fs/promises";

export async function privateOwned(path: PathLike, directory = false): Promise<void> {
  const info = await lstat(path);
  if (
    info.uid !== process.geteuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (directory ? !info.isDirectory() : !info.isFile())
  ) {
    throw new Error(`${path} must be private and owned by the current user.`);
  }
}
