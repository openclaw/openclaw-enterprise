import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
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
  return value;
}

export async function writeProtectedBootstrapFile(path: string, contents: string): Promise<void> {
  const parent = dirname(path);
  const parentStatus = await lstat(parent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error("Bootstrap output parent must be a real directory.");
  }
  if ((parentStatus.mode & 0o007) !== 0 || !processOwnsParent(parentStatus.uid, parentStatus.gid)) {
    throw new Error("Bootstrap output parent must be private to the runtime identity.");
  }

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
