import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withStateLock } from "./state-lock.ts";

type CommandExecutor = (
  command: string,
  args: string[],
  options?: { cwd?: string; maxBuffer?: number; timeoutMs?: number },
) => Promise<{ stdout: string }>;
type DockerEngine = {
  selector: "--context" | "--host";
  value: string;
  endpoint: string;
  id: string;
};
type Custody = {
  version: 1;
  containerName: string;
  directory: string;
  directoryIdentity: { device: string; inode: string };
  image: string;
  nonce: string;
  engine: DockerEngine;
  receiptPath: string;
  cidPath: string;
};
type Receipt = {
  custody: Custody;
  phase: "planned" | "create-intent" | "created" | "remove-intent" | "removed" | "aborted";
  containerId?: string;
  directoryRemoved?: true;
};

const nonceLabel = "org.openclaw.enterprise.ci.otel-attempt";
const fullId = /^[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) {
    throw new Error("Invalid OTel custody identity.");
  }
}

function unknownOutcome(operation: string): never {
  throw new Error(`OTel backend ${operation} outcome is unknown; retain its custody receipt.`);
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeReceipt(receipt: Receipt, initial = false) {
  const path = receipt.custody.receiptPath;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (initial) {
      await link(temporary, path);
    } else {
      await rename(temporary, path);
    }
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

function boundDocker(
  execFile: CommandExecutor,
  docker: string,
  engine: DockerEngine,
): CommandExecutor {
  return (command, args, options) =>
    execFile(
      command,
      // Context names can be retargeted between commands. Pin the resolved
      // endpoint as well as checking the daemon's ID before an effect.
      command === docker ? ["--host", engine.endpoint, ...args] : args,
      options,
    );
}

async function contextEndpoint(execFile: CommandExecutor, docker: string, context: string) {
  const { stdout } = await execFile(docker, [
    "context",
    "inspect",
    context,
    "--format",
    "{{json .Endpoints.docker.Host}}",
  ]);
  const endpoint: unknown = JSON.parse(stdout);
  requiredString(endpoint);
  return endpoint;
}

async function selectDockerEngine(
  execFile: CommandExecutor,
  docker: string,
  env: NodeJS.ProcessEnv,
) {
  const selector = !env.DOCKER_CONTEXT && env.DOCKER_HOST ? "--host" : "--context";
  const value =
    selector === "--host"
      ? env.DOCKER_HOST!
      : (env.DOCKER_CONTEXT ?? (await execFile(docker, ["context", "show"])).stdout.trim());
  requiredString(value);
  const endpoint = selector === "--host" ? value : await contextEndpoint(execFile, docker, value);
  const id = (
    await execFile(docker, ["--host", endpoint, "info", "--format", "{{.ID}}"])
  ).stdout.trim();
  requiredString(id);
  return { selector, value, endpoint, id } satisfies DockerEngine;
}

async function verifyDockerEngine(execFile: CommandExecutor, docker: string, engine: DockerEngine) {
  if (
    engine.selector === "--context" &&
    (await contextEndpoint(execFile, docker, engine.value)) !== engine.endpoint
  ) {
    throw new Error("OTel backend Docker context changed.");
  }
  const { stdout } = await boundDocker(
    execFile,
    docker,
    engine,
  )(docker, ["info", "--format", "{{.ID}}"]);
  if (stdout.trim() !== engine.id) {
    throw new Error("OTel backend Docker engine changed.");
  }
}

async function planCustody(
  containerName: string,
  directory: string,
  image: string,
  engine: DockerEngine,
) {
  const directoryInfo = await lstat(directory, { bigint: true });
  if (!directoryInfo.isDirectory()) {
    throw new Error("Invalid OTel backend directory.");
  }
  const custody: Custody = {
    version: 1,
    containerName,
    directory,
    directoryIdentity: { device: String(directoryInfo.dev), inode: String(directoryInfo.ino) },
    image,
    engine,
    nonce: randomUUID(),
    receiptPath: `${directory}.custody.json`,
    cidPath: join(directory, "container.cid"),
  };
  const marker = await open(join(directory, ".custody-owner"), "wx", 0o600);
  try {
    await marker.writeFile(custody.nonce);
    await marker.sync();
  } finally {
    await marker.close();
  }
  await syncDirectory(directory);
  await writeReceipt({ custody, phase: "planned" }, true);
  return custody;
}

function parseCustody(value: unknown, containerName: string, directory: string): Custody {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.containerName !== containerName ||
    value.directory !== directory ||
    !record(value.directoryIdentity) ||
    typeof value.directoryIdentity.device !== "string" ||
    !/^\d+$/.test(value.directoryIdentity.device) ||
    typeof value.directoryIdentity.inode !== "string" ||
    !/^\d+$/.test(value.directoryIdentity.inode) ||
    value.receiptPath !== `${directory}.custody.json` ||
    value.cidPath !== join(directory, "container.cid") ||
    typeof value.image !== "string" ||
    !/^\S+@sha256:[a-f0-9]{64}$/i.test(value.image) ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.nonce) ||
    !record(value.engine) ||
    (value.engine.selector !== "--context" && value.engine.selector !== "--host")
  ) {
    throw new Error("OTel backend has unsupported or unbound custody state.");
  }
  const { selector, value: selected, endpoint, id } = value.engine;
  requiredString(selected);
  requiredString(endpoint);
  requiredString(id);
  return {
    version: 1,
    containerName,
    directory,
    directoryIdentity: {
      device: value.directoryIdentity.device,
      inode: value.directoryIdentity.inode,
    },
    image: value.image,
    nonce: value.nonce,
    engine: { selector, value: selected, endpoint, id },
    receiptPath: value.receiptPath,
    cidPath: value.cidPath,
  };
}

async function readReceipt(custody: Custody): Promise<Receipt> {
  const value: unknown = JSON.parse(await readFile(custody.receiptPath, "utf8"));
  if (
    !record(value) ||
    JSON.stringify(parseCustody(value.custody, custody.containerName, custody.directory)) !==
      JSON.stringify(parseCustody(custody, custody.containerName, custody.directory)) ||
    !["planned", "create-intent", "created", "remove-intent", "removed", "aborted"].includes(
      String(value.phase),
    ) ||
    (value.directoryRemoved !== undefined && value.directoryRemoved !== true) ||
    (value.containerId !== undefined &&
      (typeof value.containerId !== "string" || !fullId.test(value.containerId)))
  ) {
    throw new Error("Invalid OTel custody receipt.");
  }
  return {
    custody,
    phase: value.phase as Receipt["phase"],
    ...(typeof value.containerId === "string" ? { containerId: value.containerId } : {}),
    ...(value.directoryRemoved === true ? { directoryRemoved: true } : {}),
  };
}

async function readContainerId(custody: Custody) {
  let id: string;
  try {
    id = (await readFile(custody.cidPath, "utf8")).trim();
  } catch (error) {
    if (record(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!fullId.test(id)) {
    throw new Error("Invalid OTel backend container ID receipt.");
  }
  return id;
}

async function containerPresent(run: CommandExecutor, docker: string, id: string) {
  const { stdout } = await run(docker, [
    "container",
    "ls",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `id=${id}`,
  ]);
  const found = stdout.trim();
  if (found === "") {
    return false;
  }
  if (found !== id) {
    throw new Error("Invalid OTel backend container identity response.");
  }
  return true;
}

async function verifyContainer(run: CommandExecutor, docker: string, custody: Custody, id: string) {
  const { stdout } = await run(docker, [
    "container",
    "inspect",
    "--format",
    `[{{json .Id}},{{json .Config.Image}},{{json (index .Config.Labels ${JSON.stringify(nonceLabel)})}}]`,
    id,
  ]);
  const identity: unknown = JSON.parse(stdout);
  if (
    !Array.isArray(identity) ||
    identity.length !== 3 ||
    identity[0] !== id ||
    identity[1] !== custody.image ||
    identity[2] !== custody.nonce
  ) {
    throw new Error("OTel backend container does not match its creation receipt.");
  }
}

async function beginCreate(custody: Custody) {
  const receipt = await readReceipt(custody);
  if (receipt.phase !== "planned" || (await readContainerId(custody)) !== undefined) {
    throw new Error("OTel backend creation already has a custody receipt.");
  }
  await writeReceipt({ custody, phase: "create-intent" });
}

async function finishCreate(
  custody: Custody,
  run: CommandExecutor,
  docker: string,
  stdout: string,
) {
  const containerId = await readContainerId(custody);
  if (!containerId || stdout.trim() !== containerId) {
    unknownOutcome("create");
  }
  await verifyContainer(run, docker, custody, containerId);
  await writeReceipt({ custody, phase: "created", containerId });
  return containerId;
}

async function cleanupDirectory(custody: Custody) {
  const info = await lstat(custody.directory, { bigint: true }).catch((error: unknown) => {
    if (record(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!info) {
    return;
  }
  if (
    !info.isDirectory() ||
    String(info.dev) !== custody.directoryIdentity.device ||
    String(info.ino) !== custody.directoryIdentity.inode ||
    (await readFile(join(custody.directory, ".custody-owner"), "utf8")) !== custody.nonce
  ) {
    throw new Error("OTel backend directory identity changed.");
  }
  await rm(custody.directory, { recursive: true, force: true });
}

async function finishDirectoryCleanup(receipt: Receipt) {
  if (receipt.directoryRemoved) {
    return;
  }
  await cleanupDirectory(receipt.custody);
  await writeReceipt({ ...receipt, directoryRemoved: true });
}

async function cleanupCustody(custody: Custody, execFile: CommandExecutor, docker: string) {
  return withStateLock(custody.receiptPath, async () => {
    let receipt = await readReceipt(custody);
    if (receipt.phase === "planned") {
      receipt = { custody, phase: "aborted" };
      await writeReceipt(receipt);
    }
    if (receipt.phase === "removed" || receipt.phase === "aborted") {
      await finishDirectoryCleanup(receipt);
      return;
    }
    await verifyDockerEngine(execFile, docker, custody.engine);
    const run = boundDocker(execFile, docker, custody.engine);
    const containerId = receipt.containerId ?? (await readContainerId(custody));
    if (!containerId) {
      unknownOutcome("create");
    }
    if (await containerPresent(run, docker, containerId)) {
      if (receipt.phase === "remove-intent") {
        unknownOutcome("remove");
      }
      await verifyContainer(run, docker, custody, containerId);
      await writeReceipt({ custody, phase: "remove-intent", containerId });
      // A failed command may already have removed the object. Reconcile only
      // this ID; a subsequent cleanup never repeats the uncertain remove.
      try {
        await run(docker, ["rm", "--force", containerId]);
      } catch {
        if (await containerPresent(run, docker, containerId)) {
          unknownOutcome("remove");
        }
      }
      if (await containerPresent(run, docker, containerId)) {
        unknownOutcome("remove");
      }
    }
    receipt = { custody, phase: "removed", containerId };
    await writeReceipt(receipt);
    await finishDirectoryCleanup(receipt);
  });
}

export {
  beginCreate,
  boundDocker,
  cleanupCustody,
  finishCreate,
  nonceLabel,
  parseCustody,
  planCustody,
  selectDockerEngine,
  verifyDockerEngine,
  withStateLock,
};
export type { Custody };
