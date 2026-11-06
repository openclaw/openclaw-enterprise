import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { request } from "node:https";
const ownerDirectory = "openclaw-box-owner";
const readOnly = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function unchanged(original: BigIntStats, current: BigIntStats): boolean {
  return (
    original.dev === current.dev &&
    original.ino === current.ino &&
    original.ctimeNs === current.ctimeNs &&
    original.mtimeNs === current.mtimeNs &&
    original.mode === current.mode &&
    original.uid === current.uid &&
    original.nlink === current.nlink &&
    original.size === current.size
  );
}

/** Trust paths selected by the operator, never native endpoint data or CLI arguments. */
export async function withOwnerFiles<T>(
  parent: string,
  ownerUid: bigint,
  use: (files: { binding: Buffer; ca: Buffer; assertCurrent: () => void }) => Promise<T>,
): Promise<T> {
  if (process.platform !== "linux") throw Error("OWNER_DIRECTORY_REFUSED");
  const outer = openSync(parent, readOnly | constants.O_DIRECTORY);
  try {
    const outerStat = fstatSync(outer, { bigint: true });
    if (!outerStat.isDirectory() || outerStat.uid !== ownerUid || (outerStat.mode & 0o7022n) !== 0n)
      throw Error("OWNER_DIRECTORY_REFUSED");
    const directoryPath = `/proc/self/fd/${outer}/${ownerDirectory}`;
    const directory = openSync(directoryPath, readOnly | constants.O_DIRECTORY);
    try {
      const dirStat = fstatSync(directory, { bigint: true });
      if (!dirStat.isDirectory() || dirStat.uid !== ownerUid || (dirStat.mode & 0o7022n) !== 0n)
        throw Error("OWNER_DIRECTORY_REFUSED");
      function capture(name: string, max: number) {
        const path = `/proc/self/fd/${directory}/${name}`;
        const fd = openSync(path, readOnly);
        try {
          const stat = fstatSync(fd, { bigint: true });
          if (
            !stat.isFile() ||
            stat.uid !== ownerUid ||
            stat.nlink !== 1n ||
            (stat.mode & 0o7222n) !== 0n ||
            stat.size < 1n ||
            stat.size > BigInt(max)
          )
            throw Error("OWNER_FILE_REFUSED");
          const bytes = Buffer.alloc(max + 1);
          let size = 0;
          while (size < bytes.length) {
            const count = readSync(fd, bytes, size, bytes.length - size, size);
            if (count === 0) break;
            size += count;
          }
          const assertCurrent = () => {
            if (!unchanged(stat, lstatSync(path, { bigint: true })))
              throw Error("OWNER_FILE_REPLACED");
          };
          if (BigInt(size) !== stat.size || !unchanged(stat, fstatSync(fd, { bigint: true })))
            throw Error("OWNER_FILE_REPLACED");
          assertCurrent();
          return { bytes: bytes.subarray(0, size), assertCurrent };
        } finally {
          closeSync(fd);
        }
      }
      const binding = capture("binding.json", 4096);
      const ca = capture("ca.pem", 32768);
      const assertCurrent = () => {
        const currentParent = lstatSync(parent, { bigint: true });
        if (
          !currentParent.isDirectory() ||
          currentParent.uid !== ownerUid ||
          currentParent.dev !== outerStat.dev ||
          currentParent.ino !== outerStat.ino ||
          currentParent.mode !== outerStat.mode ||
          !unchanged(dirStat, lstatSync(directoryPath, { bigint: true }))
        )
          throw Error("OWNER_DIRECTORY_REPLACED");
        binding.assertCurrent();
        ca.assertCurrent();
      };
      assertCurrent();
      const result = await use({ binding: binding.bytes, ca: ca.bytes, assertCurrent });
      assertCurrent();
      return result;
    } finally {
      closeSync(directory);
    }
  } finally {
    closeSync(outer);
  }
}

async function check(files: { binding: Buffer; ca: Buffer; assertCurrent: () => void }) {
  const raw = files.binding.toString("utf8").trim();
  const binding: unknown = JSON.parse(raw);
  if (
    !binding ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    JSON.stringify(binding) !== raw ||
    Object.keys(binding).length !== 3 ||
    !("url" in binding) ||
    typeof binding.url !== "string" ||
    !("workspaceRoot" in binding) ||
    binding.workspaceRoot !== "/home/node/workspace" ||
    !("generationSha256" in binding) ||
    typeof binding.generationSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.generationSha256)
  )
    throw Error("OWNER_BINDING_REFUSED");
  if (!/^-----BEGIN CERTIFICATE-----\r?\n/.test(files.ca.toString("utf8")))
    throw Error("OWNER_CA_REFUSED");
  const generation = binding.generationSha256;
  const address = new URL(binding.url);
  if (
    address.protocol !== "wss:" ||
    address.pathname !== "/" ||
    address.search ||
    address.hash ||
    address.username ||
    address.password ||
    binding.url !== address.href ||
    process.env.APP_SERVER_URL !== address.href
  )
    throw Error("OWNER_URL_REFUSED");
  const token = process.env.APP_SERVER_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error("OWNER_CAPABILITY_REFUSED");
  const key = randomBytes(16).toString("base64");
  address.protocol = "https:";
  files.assertCurrent();
  await new Promise<void>((resolve, reject) => {
    const q = request(address, {
      ca: files.ca,
      signal: AbortSignal.timeout(5000),
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        Authorization: `Bearer ${token}`,
      },
    });
    q.once("upgrade", (res, socket) => {
      socket.destroy();
      const headers = res.headersDistinct;
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      if (
        res.statusCode === 101 &&
        headers["x-openclaw-box-owner"]?.length === 1 &&
        headers["x-openclaw-box-owner"][0] === generation &&
        headers["sec-websocket-accept"]?.length === 1 &&
        headers["sec-websocket-accept"][0] === accept
      )
        resolve();
      else reject(Error("ORIGINAL_UPGRADE_REFUSED"));
    });
    q.once("response", (res) => {
      res.resume();
      reject(Error("ORIGINAL_UPGRADE_REFUSED"));
    });
    q.once("error", reject);
    q.end();
  });
  return generation;
}
if (import.meta.main) {
  try {
    const generation = await withOwnerFiles("/etc", 0n, check);
    process.stdout.write(
      JSON.stringify({
        stage: "original_box_wss",
        generationSha256: generation,
        verifiedTls: true,
      }) + "\n",
    );
  } catch {
    process.stderr.write("BOX_REPRO_OWNER_CHECK_REFUSED\n");
    process.exitCode = 1;
  }
}
