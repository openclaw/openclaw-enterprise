import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  GITLAB_REPOSITORY_REGISTRY_MAX_BYTES,
  validateGitLabRepositoryRegistry,
} from "./registry.ts";

/** Read the mounted ConfigMap projection without accepting an escaped or replaced target. */
export function readCurrentGitLabRegistry(
  path: string,
  backendId: string,
): ReturnType<typeof validateGitLabRepositoryRegistry> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("authority-unavailable");
  }
  const resolved = realpathSync(path);
  const directory = dirname(path);
  if (!resolved.startsWith(`${directory}/`) || basename(resolved) !== basename(path)) {
    throw new Error("authority-unavailable");
  }
  const descriptor = openSync(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > GITLAB_REPOSITORY_REGISTRY_MAX_BYTES ||
      (uid !== undefined && before.uid !== uid && before.uid !== 0) ||
      (before.mode & 0o022) !== 0
    ) {
      throw new Error("authority-unavailable");
    }
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const read = readSync(descriptor, bytes, position, bytes.length - position, position);
      if (read === 0) {
        break;
      }
      position += read;
    }
    const after = fstatSync(descriptor);
    const named = lstatSync(resolved);
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error("authority-unavailable");
    }
    if (realpathSync(path) !== resolved) {
      throw new Error("authority-unavailable");
    }
    return validateGitLabRepositoryRegistry(JSON.parse(bytes.toString("utf8")), backendId);
  } finally {
    closeSync(descriptor);
  }
}
