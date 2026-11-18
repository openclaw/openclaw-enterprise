import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function readPrivateBootstrapOutput(path: string): Promise<string> {
  // Check and read the same regular file so a path replacement cannot change which file is read.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    assert.ok(metadata.isFile(), "bootstrap output must be a regular file");
    assert.equal(metadata.mode & 0o777, 0o600);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
