import { open } from "node:fs/promises";

const MAX_CONFIGURATION_BYTES = 1024 * 1024;

/** Read one bounded regular file, following Kubernetes ConfigMap projection symlinks. */
export async function readProxyConfiguration(path) {
  const file = await open(path, "r");
  try {
    const information = await file.stat();
    if (!information.isFile() || information.size > MAX_CONFIGURATION_BYTES) {
      throw new Error("Outbound proxy configuration file is invalid.");
    }
    // Check and read the same opened file. A growing file cannot make this read
    // allocate or consume more than the limit plus its overflow sentinel byte.
    const bytes = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > MAX_CONFIGURATION_BYTES) {
      throw new Error("Outbound proxy configuration file exceeds its bound.");
    }
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally {
    await file.close();
  }
}
