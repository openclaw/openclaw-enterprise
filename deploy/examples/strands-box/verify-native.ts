import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  Agent,
  MessageEvent,
  WebSocket,
} from "../../../apps/controller/node_modules/undici/index.js";
import { hostConfig, object, privateDirectory, readConfig } from "./host/launch.ts";
import { INVALID_CAPABILITY, upgradeStatus } from "./host/transport.ts";
import { openOriginalSocket } from "./ingress/generation.ts";

const HELD_CONTENT = Buffer.from("strands-box-held\n");
const DENIAL =
  /permission denied|operation not permitted|no such file or directory|read-only file system/i;
const WRITE_AND_READ =
  'set -C; umask 077; printf "%s\\n" "$2" > "$1" && IFS= read -r value < "$1" && printf "%s\\n" "$value"';

function requireCheck(value: unknown): asserts value {
  if (!value) throw new Error("verification refused");
}

async function privateFile(path: string, limit: number, writable = false) {
  const handle = await open(
    path,
    (writable ? constants.O_RDWR : constants.O_RDONLY) |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    requireCheck(
      before.isFile() &&
        before.uid === BigInt(process.getuid!()) &&
        (before.mode & 0o7777n) === 0o600n &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= BigInt(limit),
    );
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await lstat(path, { bigint: true });
    requireCheck(
      after.dev === before.dev &&
        after.ino === before.ino &&
        after.ctimeNs === before.ctimeNs &&
        BigInt(bytesRead) === before.size,
    );
    return { bytes: buffer.subarray(0, bytesRead), stat: before };
  } finally {
    await handle.close();
  }
}

function waitForSocket<T>(
  socket: WebSocket,
  type: "open" | "message",
  timeoutMs: number,
  accept: (event: Event) => T | undefined,
  send?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(fail, timeoutMs);
    function clear() {
      clearTimeout(timer);
      socket.removeEventListener(type, receive);
      socket.removeEventListener("close", fail);
      socket.removeEventListener("error", fail);
    }
    function fail() {
      clear();
      reject(new Error("native response unavailable"));
    }
    function receive(event: Event) {
      try {
        const value = accept(event);
        if (value !== undefined) {
          clear();
          resolve(value);
        }
      } catch {
        fail();
      }
    }
    socket.addEventListener(type, receive);
    socket.addEventListener("close", fail);
    socket.addEventListener("error", fail);
    try {
      send?.();
    } catch {
      fail();
    }
  });
}

let phase = "configuration";
async function verify() {
  const [configPath, shell, heldPath] = process.argv.slice(2);
  requireCheck(configPath && shell && process.argv.length <= 5 && process.arch === "arm64");
  const config = hostConfig(readConfig(configPath));
  privateDirectory(dirname(config.runtimeDir));
  requireCheck(config.exec.includes(shell));

  const held =
    heldPath === undefined
      ? undefined
      : await (async () => {
          const sibling = privateDirectory(dirname(heldPath));
          const parent = privateDirectory(dirname(config.workspace));
          const smokeHome = join(dirname(config.runtimeDir), basename(config.runtimeDir) + "-home");
          requireCheck(
            (await realpath(heldPath)) === heldPath &&
              sibling !== config.workspace &&
              dirname(sibling) === parent &&
              ![
                config.runtimeDir,
                smokeHome,
                config.agentBuildDir,
                ...config.read,
                ...config.exec,
              ].some(
                (path) =>
                  path === sibling ||
                  path.startsWith(sibling + "/") ||
                  sibling.startsWith(path + "/"),
              ),
          );
          const snapshot = await privateFile(heldPath, HELD_CONTENT.length, true);
          requireCheck(snapshot.bytes.equals(HELD_CONTENT));
          return { path: heldPath, ...snapshot };
        })();

  phase = "owner binding";
  const { bytes: ready } = await privateFile(join(config.runtimeDir, "ready.json"), 2048);
  const owner = await openOriginalSocket(
    config.runtimeDir,
    createHash("sha256").update(ready).digest("hex"),
  );
  let dispatcher: Agent | undefined;
  let socket: WebSocket | undefined;
  try {
    const { bytes: bearer } = await privateFile(join(config.runtimeDir, "capability"), 44);
    const capability = bearer.toString("ascii");
    bearer.fill(0);
    requireCheck(/^[A-Za-z0-9_-]{43}\n$/.test(capability));
    phase = "bearer refusal";
    const target = { path: owner.pinnedPath };
    requireCheck((await owner.valid()) && (await upgradeStatus(target)) === 401);
    requireCheck(
      (await owner.valid()) && (await upgradeStatus(target, INVALID_CAPABILITY)) === 401,
    );

    phase = "authenticated WebSocket";
    requireCheck(await owner.valid());
    dispatcher = new Agent({ connect: { socketPath: owner.pinnedPath } });
    const native = new WebSocket("ws://localhost/", {
      dispatcher,
      headers: { authorization: "Bearer " + capability.trimEnd() },
    });
    socket = native;
    await waitForSocket(native, "open", 5000, () => true);

    let requestId = 0;
    async function rpc(method: string, params: object, timeoutMs = 5000) {
      requireCheck((await owner.valid()) && native.readyState === WebSocket.OPEN);
      const id = ++requestId;
      const reply = await waitForSocket(
        native,
        "message",
        timeoutMs,
        (event) => {
          requireCheck(event instanceof MessageEvent && typeof event.data === "string");
          requireCheck(Buffer.byteLength(event.data) <= 16384);
          const response = object(JSON.parse(event.data));
          return response.id === id ? response : undefined;
        },
        () => native.send(JSON.stringify({ id, method, params })),
      );
      requireCheck(
        (await owner.valid()) && Object.hasOwn(reply, "result") !== Object.hasOwn(reply, "error"),
      );
      return reply;
    }

    phase = "native initialize";
    const hello = object(
      (
        await rpc("initialize", {
          clientInfo: { name: "strands-box-verify-native", version: "1" },
          capabilities: { experimentalApi: true },
        })
      ).result,
    );
    requireCheck(typeof hello.userAgent === "string" && hello.userAgent.includes("codex"));
    native.send(JSON.stringify({ method: "initialized" }));

    phase = "workspace command";
    const name = "strands-box-verify-" + randomBytes(12).toString("hex") + ".txt";
    const marker = randomBytes(24).toString("hex");
    const path = join(config.workspace, name);
    const result = object(
      (
        await rpc(
          "command/exec",
          {
            command: [shell, "-c", WRITE_AND_READ, "strands-box-verify", path, marker],
            cwd: config.workspace,
            sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
            timeoutMs: 10000,
            outputBytesCap: 1024,
          },
          15000,
        )
      ).result,
    );
    requireCheck(result.exitCode === 0 && result.stdout === marker + "\n");

    phase = "native workspace readback";
    const { dataBase64 } = object((await rpc("fs/readFile", { path })).result);
    requireCheck(dataBase64 === Buffer.from(marker + "\n").toString("base64"));

    if (held !== undefined) {
      for (const [method, params] of [
        ["fs/readFile", { path: held.path }],
        [
          "fs/writeFile",
          { path: held.path, dataBase64: Buffer.from("unexpected write\n").toString("base64") },
        ],
      ] as const) {
        phase = "held file " + method;
        const error = object((await rpc(method, params)).error);
        requireCheck(
          error.code === -32603 && typeof error.message === "string" && DENIAL.test(error.message),
        );
      }
      phase = "held file host readback";
      const after = await privateFile(held.path, HELD_CONTENT.length, true);
      requireCheck(
        after.bytes.equals(held.bytes) &&
          after.stat.dev === held.stat.dev &&
          after.stat.ino === held.stat.ino &&
          after.stat.ctimeNs === held.stat.ctimeNs,
      );
    }
    requireCheck(await owner.valid());
    return { name, outside: held === undefined ? "not-requested" : "verified" };
  } finally {
    try {
      socket?.close();
      await dispatcher?.destroy();
    } finally {
      await owner.close();
    }
  }
}

try {
  const { name, outside } = await verify();
  process.stdout.write(
    "strands-box-verify: verified marker=" + name + " outside=" + outside + "\n",
  );
} catch {
  process.stderr.write("strands-box-verify: refused at " + phase + "\n");
  process.exitCode = 1;
}
