import { chmodSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { NetConnectOpts, Server, Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export const PORT = 18790;
export const INVALID_CAPABILITY = "invalid-strands-box-readiness-capability";
export const BOOTSTRAP_MS = 90_000;
/**
 * The stock protected Harness program's enrollment path (core `HARNESS_EGRESS_ENROLLMENT_PATH`):
 * before Codex starts, the program serves its own startup challenge here on `PORT` and waits for
 * Compute's signed release of it, at most 180 s.
 */
export const ENROLLMENT_PATH = "/openclaw/runtime/egress-enrollment";
/** A gated run waits this long for the native listener: the program's 180 s, then bootstrap. */
export const ENROLLMENT_WAIT_MS = 180_000 + BOOTSTRAP_MS;
/** The only two request lines the pre-ready enrollment bridge forwards. */
export const ENROLLMENT_REQUEST_LINES = [
  `GET ${ENROLLMENT_PATH} HTTP/1.1`,
  `POST ${ENROLLMENT_PATH} HTTP/1.1`,
] as const;
const CONNECT_MS = 2_500;
const MAX_CONNECTIONS = 64;

export interface SocketIdentity {
  dev: string;
  ino: string;
}

export function socketIdentity(path: string, uid = process.getuid!()): SocketIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== 0o600n) {
    throw new Error("socket_identity");
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

export function sameSocket(path: string, expected: SocketIdentity): boolean {
  try {
    const actual = socketIdentity(path);
    return actual.dev === expected.dev && actual.ino === expected.ino;
  } catch {
    return false;
  }
}

export function listen(server: Server, path: string): Promise<SocketIdentity> {
  if (Buffer.byteLength(path) > 107) throw new Error("socket_path_length");
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      try {
        chmodSync(path, 0o600);
        resolve(socketIdentity(path));
      } catch (error) {
        server.close();
        reject(error);
      } finally {
        server.off("error", reject);
      }
    });
  });
}

// Start time (field 22) and parent (field 4) in the current PID namespace.
/** The fixed answer of the host's release socket after a verified protected startup release. */
export const RELEASE_LINE = "released\n";

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  startTicks: string;
}

export function processIdentity(pid: number): ProcessIdentity {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(") ");
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const startTicks = fields[19];
  if (
    end < 0 ||
    !stat.startsWith(`${pid} (`) ||
    fields[0] === "Z" ||
    fields[0] === "X" ||
    !Number.isSafeInteger(ppid) ||
    ppid < 0 ||
    startTicks === undefined ||
    !/^\d+$/.test(startTicks)
  ) {
    throw new Error("process_identity");
  }
  return { pid, ppid, startTicks };
}

export function sameProcess(expected: ProcessIdentity): boolean {
  try {
    return processIdentity(expected.pid).startTicks === expected.startTicks;
  } catch {
    return false;
  }
}

export function tcpOwnership(
  owner: ProcessIdentity,
  localPort: number,
  remotePort?: number,
): string | undefined {
  if (!sameProcess(owner)) return undefined;
  const hex = (port: number) => port.toString(16).padStart(4, "0").toUpperCase();
  const local = hex(localPort);
  const remote = remotePort === undefined ? "00000000:0000" : `0100007F:${hex(remotePort)}`;
  const expectedLocal =
    remotePort === undefined ? [`0100007F:${local}`, `00000000:${local}`] : [`0100007F:${local}`];
  const state = remotePort === undefined ? "0A" : "01";
  try {
    const rows = readFileSync(`/proc/${owner.pid}/net/tcp`, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (fields) =>
          expectedLocal.some((value) => value === fields[1]) &&
          fields[2] === remote &&
          fields[3] === state,
      );
    const [row] = rows;
    if (rows.length !== 1 || row === undefined || !/^[1-9]\d*$/.test(row[9] ?? ""))
      return undefined;
    const inode = row[9];
    for (const fd of readdirSync(`/proc/${owner.pid}/fd`)) {
      try {
        if (
          readlinkSync(`/proc/${owner.pid}/fd/${fd}`) === `socket:[${inode}]` &&
          sameProcess(owner)
        )
          return inode;
      } catch {
        /* A concurrent close removes that descriptor. */
      }
    }
  } catch {
    /* Missing or unreadable proc evidence is a refusal. */
  }
  return undefined;
}

export function bridge(
  destination: NetConnectOpts,
  authorize: (upstream: Socket, signal: AbortSignal) => boolean | Promise<boolean>,
): { server: Server; close: () => void } {
  const clients = new Set<Socket>();
  const stopped = new AbortController();
  const server = createServer({ pauseOnConnect: true }, (client) => {
    if (stopped.signal.aborted || clients.size >= MAX_CONNECTIONS) {
      client.destroy();
      return;
    }
    const upstream = createConnection(destination);
    clients.add(client);
    function close(): void {
      client.destroy();
      upstream.destroy();
    }
    client.once("error", close);
    client.once("close", () => {
      clients.delete(client);
      upstream.destroy();
    });
    upstream.once("error", close);
    upstream.once("close", () => {
      // pipe() finishes a complete reply before the corresponding client close.
      if (!client.writableEnded) client.end();
    });
    upstream.setTimeout(CONNECT_MS, close);
    upstream.once("connect", () => {
      upstream.pause();
      void Promise.resolve(authorize(upstream, stopped.signal)).then((permitted) => {
        if (!permitted || stopped.signal.aborted || upstream.destroyed || client.destroyed) {
          close();
          return;
        }
        upstream.setTimeout(0);
        upstream.pipe(client);
        client.pipe(upstream);
      }, close);
    });
  });
  server.on("error", () => stop());
  function stop(): void {
    stopped.abort();
    server.close();
    for (const client of clients) client.destroy();
  }
  return { server, close: stop };
}

/**
 * The pre-ready enrollment bridge: like `bridge`, but a connection reaches `destination` only when
 * its first line is one of the two enrollment request lines; anything else is closed unanswered.
 * The stock program answers each request with `connection: close`, so a connection carries one.
 */
export function enrollmentBridge(
  destination: NetConnectOpts,
  authorize: (upstream: Socket, signal: AbortSignal) => boolean | Promise<boolean>,
): { server: Server; close: () => void } {
  const clients = new Set<Socket>();
  const stopped = new AbortController();
  const server = createServer((client) => {
    if (stopped.signal.aborted || clients.size >= 4) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.once("error", () => client.destroy());
    client.setTimeout(CONNECT_MS, () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n");
      if (end < 0) {
        if (head.length > 128) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const line = head.subarray(0, end).toString("latin1");
      if (!(ENROLLMENT_REQUEST_LINES as readonly string[]).includes(line)) {
        client.destroy();
        return;
      }
      const upstream = createConnection(destination);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.once("close", () => upstream.destroy());
      upstream.once("error", close);
      upstream.once("close", () => {
        if (!client.writableEnded) client.end();
      });
      upstream.setTimeout(CONNECT_MS, close);
      upstream.once("connect", () => {
        upstream.pause();
        void Promise.resolve(authorize(upstream, stopped.signal)).then((permitted) => {
          if (!permitted || stopped.signal.aborted || upstream.destroyed || client.destroyed) {
            close();
            return;
          }
          upstream.setTimeout(0);
          client.setTimeout(0);
          upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
          client.resume();
        }, close);
      });
    };
    client.on("data", onData);
  });
  server.on("error", () => stop());
  function stop(): void {
    stopped.abort();
    server.close();
    for (const client of clients) client.destroy();
  }
  return { server, close: stop };
}

export function upgradeStatus(
  target: NetConnectOpts,
  bearer?: string,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(target);
    let head = "";
    const done = (status?: number) => {
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(CONNECT_MS, () => done());
    socket.once("error", () => done());
    socket.once("end", () => done());
    socket.once("connect", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...(bearer === undefined ? [] : [`Authorization: Bearer ${bearer}`]),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.length > 4096) done();
      else if (head.includes("\r\n\r\n")) {
        const status = /^HTTP\/1\.1 ([0-9]{3}) /.exec(head)?.[1];
        done(status === undefined ? undefined : Number(status));
      }
    });
  });
}

export async function waitFor<T>(
  action: () => T | undefined | Promise<T | undefined>,
  signal: AbortSignal,
  timeout = BOOTSTRAP_MS,
): Promise<T> {
  const end = performance.now() + timeout;
  do {
    signal.throwIfAborted();
    const value = await action();
    if (value !== undefined) return value;
    await delay(40, undefined, { signal });
  } while (performance.now() < end);
  throw new Error("startup_timeout");
}
