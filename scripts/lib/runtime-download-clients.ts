import { execFile, type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const requiredClients = [
  ["/usr/bin/curl", "/usr/bin/curl"],
  ["/usr/lib/apt/methods/http", "/usr/lib/apt/methods/http"],
  ["/usr/lib/apt/methods/https", "/usr/lib/apt/methods/http"],
  ["/usr/local/bin/node", "/usr/local/bin/node"],
] as const;

interface RuntimeDownloadClient {
  resolvedBinary: string;
  binarySha256: string;
}

// Additional clients must name their native executable directly.
export function parseRuntimeDownloadClientSelection(source: string): Map<string, string> {
  const additional: unknown = JSON.parse(source);
  if (!Array.isArray(additional) || additional.length > 32 - requiredClients.length) {
    throw new Error("Expected at most 28 additional runtime download client paths.");
  }
  const selection = new Map<string, string>(requiredClients);
  for (const path of additional) {
    if (
      typeof path !== "string" ||
      path.length > 512 ||
      !/^(?:\/[a-zA-Z0-9_.+@-]+)+$/u.test(path) ||
      path.split("/").some((part) => part === "." || part === "..") ||
      selection.has(path)
    ) {
      throw new Error("Invalid or duplicate additional runtime download client path.");
    }
    selection.set(path, path);
  }
  return selection;
}

export async function readReleaseDownloadClientSelection(
  revision: string,
  options: Pick<ExecFileOptions, "cwd" | "env" | "signal"> = {},
): Promise<Map<string, string>> {
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("Select an exact runtime release commit.");
  }
  const { stdout } = await execute(
    "git",
    [
      "--no-replace-objects",
      "cat-file",
      "blob",
      `${revision}:deploy/runtime/additional-download-clients.json`,
    ],
    {
      ...options,
      env: { ...(options.env ?? process.env), GIT_NO_LAZY_FETCH: "1" },
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    },
  );
  return parseRuntimeDownloadClientSelection(stdout);
}

const elf64LittleEndian = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
const elfMachine = { x64: 62, arm64: 183 };

// Production inventories the installed filesystem from inside the target image.
export async function readRuntimeDownloadClients(
  selection: ReadonlyMap<string, string>,
  imageRoot = "/",
): Promise<Partial<Record<string, RuntimeDownloadClient>>> {
  const { arch } = process;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported runtime download client architecture: ${arch}`);
  }
  const root = await realpath(imageRoot);
  const clients: Partial<Record<string, RuntimeDownloadClient>> = {};
  for (const [installed, expected] of selection) {
    const target = await realpath(join(root, installed));
    const path = relative(root, target);
    if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
      throw new Error(`Runtime download client resolves outside the image: ${installed}`);
    }
    const resolvedBinary = `/${path}`;
    if (resolvedBinary !== expected) {
      throw new Error(`Runtime download client resolves to an unexpected path: ${installed}`);
    }
    const info = await stat(target);
    if (!info.isFile() || !(info.mode & 0o111)) {
      throw new Error(`Runtime download client must be an executable file: ${installed}`);
    }
    const hash = createHash("sha256");
    let header: Buffer | undefined;
    for await (const bytes of createReadStream(target) as AsyncIterable<Buffer>) {
      header ??= bytes.subarray(0, 20);
      hash.update(bytes);
    }
    // A wrapper script would use its interpreter's identity for network access.
    if (
      header?.length !== 20 ||
      !header.subarray(0, 7).equals(elf64LittleEndian) ||
      ![2, 3].includes(header.readUInt16LE(16)) ||
      header.readUInt16LE(18) !== elfMachine[arch]
    ) {
      throw new Error(`Expected a native ${arch} ELF executable: ${installed}`);
    }
    clients[installed] = { resolvedBinary, binarySha256: hash.digest("hex") };
  }
  return clients;
}
