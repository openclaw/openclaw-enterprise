import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isObject } from "./runner-inputs.ts";

export type Case2Directory = {
  path: string;
  entry: string;
  parentFd: number;
  fd: number;
  identity: Stats;
};

const liveCase2Directories = new Set<Case2Directory>();

const firstErrors = ["unobserved", "assertion", "timeout", "abort", "aggregate", "other"] as const;
const teardownPhases = ["unobserved", "entered", "completed", "failed"] as const;

export const case2PhaseEnv = "OCC_TEST_K3D_CASE2_PHASE_FILE";

function sameDirectory(path: string, identity: Stats) {
  try {
    const current = lstatSync(path);
    return (
      current.isDirectory() &&
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      current.uid === identity.uid &&
      (current.mode & 0o777) === 0o700
    );
  } catch {
    return false;
  }
}

export function openK3dCase2Directory(statePath: string | null): Case2Directory | undefined {
  if (process.platform !== "linux" || statePath === null) {
    return undefined;
  }
  let entry: string | undefined;
  let parentFd: number | undefined;
  let fd: number | undefined;
  let identity: Stats | undefined;
  try {
    const parent = realpathSync(dirname(statePath));
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentStatus = fstatSync(parentFd);
    const uid = process.getuid?.();
    // Directory entries must remain under the runner's control through cleanup.
    if (parentStatus.uid !== uid || (parentStatus.mode & 0o022) !== 0) {
      throw new Error("case-2 state parent is not private to the runner");
    }
    entry = mkdtempSync(`/proc/self/fd/${parentFd}/.k3d-case2-`);
    const path = join(parent, basename(entry));
    // Establish ownership from the opened descriptor before checking either name.
    fd = openSync(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.uid !== uid || (opened.mode & 0o777) !== 0o700 || !sameDirectory(entry, opened)) {
      throw new Error("case-2 directory identity changed");
    }
    identity = opened;
    if (!sameDirectory(path, identity)) {
      throw new Error("case-2 directory identity changed");
    }
    const directory = { path, entry, parentFd, fd, identity };
    liveCase2Directories.add(directory);
    return directory;
  } catch {
    if (entry && identity && sameDirectory(entry, identity)) {
      try {
        rmdirSync(entry);
      } catch {
        console.error("[run:k3d-model] case-2 receipt directory could not be removed");
      }
    }
    for (const descriptor of [fd, parentFd]) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
    return undefined;
  }
}

export function removeK3dCase2Directory(directory: Case2Directory): void {
  if (!liveCase2Directories.delete(directory)) {
    return;
  }
  try {
    // Only unlink the two receipt names in the opened directory. Never chase a
    // replacement path or recursively remove child-controlled contents.
    for (const name of ["case-2.json", "case-2.json.tmp"]) {
      try {
        unlinkSync(`/proc/self/fd/${directory.fd}/${name}`);
      } catch (error) {
        if (!isObject(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (!sameDirectory(directory.entry, directory.identity)) {
      throw new Error("case-2 directory identity changed");
    }
    rmdirSync(directory.entry);
  } catch {
    console.error("[run:k3d-model] case-2 receipt directory could not be removed");
  } finally {
    for (const descriptor of [directory.fd, directory.parentFd]) {
      try {
        closeSync(descriptor);
      } catch {
        console.error("[run:k3d-model] case-2 receipt descriptor could not be closed");
      }
    }
  }
}

export function removeLiveK3dCase2Directories(): void {
  for (const directory of liveCase2Directories) {
    removeK3dCase2Directory(directory);
  }
}

export function readK3dCase2Phase(directory: Case2Directory) {
  const limit = 512;
  if (!sameDirectory(directory.path, directory.identity)) {
    return undefined;
  }
  try {
    const fd = openSync(
      `/proc/self/fd/${directory.fd}/case-2.json`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const initial = fstatSync(fd);
      if (!initial.isFile() || initial.nlink !== 1 || initial.size > limit) {
        return undefined;
      }
      const bytes = Buffer.alloc(limit + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, count);
        if (read === 0) {
          break;
        }
        count += read;
      }
      const final = fstatSync(fd);
      if (
        count > limit ||
        count !== initial.size ||
        count !== final.size ||
        final.nlink !== 1 ||
        !sameDirectory(directory.path, directory.identity)
      ) {
        return undefined;
      }
      const row: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
      if (!isObject(row) || Object.keys(row).length !== 7) {
        return undefined;
      }
      const { version, caseId, setupEntered, setupCompleted, bodyEntered, firstError, teardown } =
        row;
      const observedError = firstErrors.find((category) => category === firstError);
      const observedTeardown = teardownPhases.find((phase) => phase === teardown);
      if (
        version !== 1 ||
        caseId !== "dedicated-skill-source-policy" ||
        setupEntered !== true ||
        typeof setupCompleted !== "boolean" ||
        typeof bodyEntered !== "boolean" ||
        (bodyEntered && !setupCompleted) ||
        (setupCompleted && !bodyEntered && firstError !== "unobserved") ||
        observedError === undefined ||
        observedTeardown === undefined
      ) {
        return undefined;
      }
      return {
        version,
        caseId,
        setupEntered,
        setupCompleted,
        bodyEntered,
        firstError: observedError,
        teardown: observedTeardown,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    // A missing or malformed child receipt supplies no phase evidence.
    return undefined;
  }
}
