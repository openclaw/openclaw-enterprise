import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { X509Certificate } from "node:crypto";
import type { Clock } from "../../drivers/repo/credentials/backend-contracts.ts";
import type { LoadedConfiguration } from "./contracts.ts";
import { record } from "../../drivers/repo/credentials/configuration.ts";
import { createSystemClock } from "../../drivers/repo/credentials/clock.ts";
import { loadConfiguration } from "./config.ts";
import { runService } from "./service.ts";

const inputLimits = {
  "config.json": 262144,
  "private-key.pem": 65536,
  "tls.crt": 131072,
  "tls.key": 65536,
} as const;
const privateNames = [...Object.keys(inputLimits), "registry.json"];
const controlSocket = "/run/openclaw/repository-control/private/control.sock";

interface ProjectedInputs {
  readonly inputsDirectory: string;
  readonly registryFile: string;
  readonly privateDirectory: string;
  readonly controlSocket: string;
  readonly expectedOrigin: string;
  readonly backendId: string;
}

async function realDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path) {
    throw new Error("invalid-projected-inputs");
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("invalid-projected-inputs");
  }
}

async function privateDirectory(path: string): Promise<void> {
  await realDirectory(dirname(path));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  await realDirectory(path);
  const info = await lstat(path);
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new Error("invalid-projected-inputs");
  }
}

async function projectionGeneration(directory: string): Promise<string> {
  await realDirectory(directory);
  const generation = await readlink(join(directory, "..data"));
  if (!generation.startsWith("..") || generation === ".." || basename(generation) !== generation) {
    throw new Error("invalid-projected-inputs");
  }
  const path = join(directory, generation);
  await realDirectory(path);
  const info = await lstat(path);
  if ((info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== process.getuid?.())) {
    throw new Error("invalid-projected-inputs");
  }
  return path;
}

async function readProjected(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer | undefined;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > maximum ||
      (before.mode & 0o022) !== 0 ||
      (before.uid !== 0 && before.uid !== process.getuid?.())
    ) {
      throw new Error("invalid-projected-inputs");
    }
    data = Buffer.alloc(before.size + 1);
    let position = 0;
    while (position < data.length) {
      const result = await handle.read(data, position, data.length - position, position);
      if (!result.bytesRead) {
        break;
      }
      position += result.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(path);
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error("invalid-projected-inputs");
    }
    return Buffer.from(data.subarray(0, position));
  } finally {
    data?.fill(0);
    await handle.close();
  }
}

async function clearPreviousInputs(directory: string): Promise<void> {
  const entries = await readdir(directory);
  const identities = new Map<string, { dev: number; ino: number }>();
  // A restart may replace only this bootstrap's known private regular files.
  // Validate the entire directory before removing any entry; never recurse.
  for (const name of entries) {
    const info = await lstat(join(directory, name));
    if (
      !privateNames.includes(name) ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600
    ) {
      throw new Error("invalid-projected-inputs");
    }
    identities.set(name, info);
  }
  for (const [name, previous] of identities) {
    const path = join(directory, name);
    const current = await lstat(path);
    if (current.dev !== previous.dev || current.ino !== previous.ino) {
      throw new Error("invalid-projected-inputs");
    }
    await unlink(path);
  }
}

async function writePrivate(path: string, value: Buffer): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(value);
  } finally {
    await file.close();
  }
}

function validateProjectedTlsHost(cert: Buffer, origin: string): void {
  const hostname = new URL(origin).hostname;
  const matched = new X509Certificate(cert).checkHost(hostname, {
    subject: "never",
    wildcards: false,
    partialWildcards: false,
    multiLabelWildcards: false,
  });
  if (matched !== hostname) {
    throw new Error("invalid-projected-inputs");
  }
}

/** Kubernetes process composition: snapshot projections before the protected loader. */
export async function prepareProjectedInputs(
  options: ProjectedInputs,
  clock: Clock,
): Promise<LoadedConfiguration> {
  const contents = new Map<string, Buffer>();
  try {
    const generation = await projectionGeneration(options.inputsDirectory);
    for (const [name, maximum] of Object.entries(inputLimits)) {
      contents.set(name, await readProjected(join(generation, name), maximum));
    }
    const registryGeneration = await projectionGeneration(dirname(options.registryFile));
    contents.set(
      "registry.json",
      await readProjected(join(registryGeneration, basename(options.registryFile)), 262144),
    );
    const root = record(JSON.parse(contents.get("config.json")!.toString("utf8")));
    const gateway = record(root.gateway);
    const backend = record(root.backend);
    if (gateway.publicOrigin === undefined) {
      gateway.publicOrigin = options.expectedOrigin;
    }
    if (
      gateway.publicOrigin !== options.expectedOrigin ||
      gateway.listen !== "0.0.0.0:8443" ||
      gateway.controlSocket !== options.controlSocket ||
      backend.kind !== "github-app-registry" ||
      backend.backendId !== options.backendId
    ) {
      throw new Error("invalid-projected-inputs");
    }
    validateProjectedTlsHost(contents.get("tls.crt")!, options.expectedOrigin);
    gateway.tlsCertFile = join(options.privateDirectory, "tls.crt");
    gateway.tlsKeyFile = join(options.privateDirectory, "tls.key");
    backend.privateKeyFile = join(options.privateDirectory, "private-key.pem");
    backend.registryFile = join(options.privateDirectory, "registry.json");
    contents.get("config.json")!.fill(0);
    contents.set("config.json", Buffer.from(JSON.stringify(root)));
    await privateDirectory(options.privateDirectory);
    await privateDirectory(dirname(options.controlSocket));
    await clearPreviousInputs(options.privateDirectory);
    for (const [name, value] of contents) {
      await writePrivate(join(options.privateDirectory, name), value);
    }
    const loaded = await loadConfiguration(join(options.privateDirectory, "config.json"), clock);
    // Leave time to report unresolved cleanup before the worker Pod's fixed
    // 75-second termination deadline forcibly ends the service process.
    if (loaded.config.limits.shutdownGraceMs > 60_000) {
      loaded.close();
      throw new Error("invalid-projected-inputs");
    }
    return loaded;
  } catch {
    throw new Error("invalid-projected-inputs");
  } finally {
    for (const value of contents.values()) {
      value.fill(0);
    }
  }
}

async function main(args: readonly string[]): Promise<void> {
  const check = args.includes("--check-config");
  const values = check ? args.filter((arg) => arg !== "--check-config") : args;
  if (
    args.length !== (check ? 5 : 4) ||
    values.length !== 4 ||
    values[0] !== "--public-origin" ||
    !values[1] ||
    values[2] !== "--backend-id" ||
    !values[3]
  ) {
    throw new Error("invalid-arguments");
  }
  const clock = createSystemClock();
  const loaded = await prepareProjectedInputs(
    {
      inputsDirectory: "/etc/openclaw/repository-inputs",
      registryFile: "/etc/openclaw/repository-registry/registry.json",
      privateDirectory: "/run/openclaw/repository-private/private",
      controlSocket,
      expectedOrigin: values[1],
      backendId: values[3],
    },
    clock,
  );
  if (check) {
    loaded.close();
    process.stdout.write('{"valid":true}\n');
    return;
  }
  await runService(loaded, clock);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).catch(() => {
    process.stderr.write("repository credential service failed\n");
    process.exitCode = 1;
  });
}
