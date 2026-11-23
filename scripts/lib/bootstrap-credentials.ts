import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";

/** Fixed diagnostics deliberately exclude paths, filesystem causes and credential contents. */
export class BootstrapInputError extends Error {}

async function credentialFile(path: string | undefined, setting: string): Promise<string> {
  if (path === undefined || !isAbsolute(path)) {
    throw new BootstrapInputError(`${setting} must name an absolute credential input file.`);
  }
  try {
    // Follow projected Secret symlinks. O_NONBLOCK also prevents a FIFO from blocking startup.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096) {
        throw new Error();
      }
      const buffer = Buffer.alloc(4096);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) {
          break;
        }
        size += bytesRead;
      }
      // Recheck the opened target in case it grew during the bounded read.
      if ((await file.stat()).size > 4096) {
        throw new Error();
      }
      const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(buffer.subarray(0, size))
        .replace(/\r?\n$/, "");
      if (value.length === 0 || /[\r\n\0]/.test(value)) {
        throw new Error();
      }
      return value;
    } finally {
      await file.close();
    }
  } catch {
    throw new BootstrapInputError(
      `${setting} must be readable regular UTF-8 text of at most 4 KiB, with no NUL or embedded line breaks.`,
    );
  }
}

export async function bootstrapCredentials(environment: Readonly<NodeJS.ProcessEnv>) {
  const password = await credentialFile(
    environment.OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE,
    "OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE",
  );
  const serviceKey = await credentialFile(
    environment.OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE,
    "OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE",
  );
  if (password.length < 12 || password.length > 128) {
    throw new BootstrapInputError(
      "Bootstrap administrator password must contain 12–128 characters.",
    );
  }
  if (!/^occ_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(serviceKey)) {
    throw new BootstrapInputError(
      "Bootstrap service key must encode 32 random bytes as unpadded base64url with occ_ prefix.",
    );
  }
  return { password, serviceKey };
}
