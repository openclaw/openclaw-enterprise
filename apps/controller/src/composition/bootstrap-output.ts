import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, sep } from "node:path";
import type { ServiceKey } from "../auth/index.ts";

export interface BootstrapServiceKeyOutput {
  readonly data: ServiceKey & { readonly key: string };
  readonly meta: {
    readonly installationId: string;
  };
}

export function bootstrapOutputPath(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must identify an absolute output path.`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must identify an absolute output path.`);
  }
  if (value.endsWith(sep)) {
    throw new Error(`${name} must identify a file, not a directory path.`);
  }
  if (basename(value).length > 255) {
    throw new Error(`${name} must use a basename of at most 255 characters.`);
  }
  return value;
}

async function requirePrivateParent(parent: string): Promise<void> {
  const parentStatus = await lstat(parent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error("Bootstrap output parent must be a real directory.");
  }
  if ((parentStatus.mode & 0o007) !== 0 || !processOwnsParent(parentStatus.uid, parentStatus.gid)) {
    throw new Error("Bootstrap output parent must be private to the runtime identity.");
  }
}

const preflightFailures = {
  BOOTSTRAP_OUTPUT_EXISTS:
    "A bootstrap credential output already exists. Preserve it and reconcile the original installation attempt before retrying.",
  BOOTSTRAP_OUTPUT_UNVERIFIED:
    "Could not establish that the bootstrap credential output is absent in a private directory. Check access and reconcile the original installation attempt.",
} as const;

export class BootstrapOutputPreflightError extends Error {
  readonly code: keyof typeof preflightFailures;
  constructor(code: keyof typeof preflightFailures, options?: ErrorOptions) {
    super(preflightFailures[code], options);
    this.code = code;
  }
}

// A point-in-time check, not a reservation. The writer still checks the parent and creates exclusively.
export async function requireAbsentBootstrapOutput(path: string): Promise<void> {
  try {
    await requirePrivateParent(dirname(path));
  } catch (cause) {
    throw new BootstrapOutputPreflightError("BOOTSTRAP_OUTPUT_UNVERIFIED", { cause });
  }
  try {
    await lstat(path); // A dangling symlink is an occupied destination too.
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new BootstrapOutputPreflightError("BOOTSTRAP_OUTPUT_UNVERIFIED", { cause });
  }
  throw new BootstrapOutputPreflightError("BOOTSTRAP_OUTPUT_EXISTS");
}

export async function writeProtectedBootstrapFile(path: string, contents: string): Promise<void> {
  const parent = dirname(path);
  await requirePrivateParent(parent);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(parent);
}

export async function writeProtectedBootstrapJson(
  path: string,
  payload: BootstrapServiceKeyOutput,
): Promise<void> {
  await writeProtectedBootstrapFile(path, `${JSON.stringify(payload)}\n`);
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function processOwnsParent(uid: number, gid: number): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && (uid === currentUid || uid === 0)) {
    return true;
  }
  if (typeof process.getgroups !== "function") {
    return false;
  }
  return process.getgroups().includes(gid);
}
