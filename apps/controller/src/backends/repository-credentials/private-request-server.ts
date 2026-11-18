import { createServer, type ServerResponse } from "node:http";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Socket } from "node:net";
import { prepareControlSocket } from "./control-socket.ts";
import { inspectRequestHead } from "../../drivers/repo/access/transport/request.ts";

function writeReply(response: ServerResponse, status: 200 | 503, body: Buffer): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(body, () => body.fill(0));
}

/** Only peers sharing the worker's private directory can reach this bounded, single-request socket. */
export async function servePrivateRepositoryRequest(
  controlSocket: string,
  name: "receipt" | "prepared-git-use",
  handle: (request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
) {
  const parent = dirname(resolve(controlSocket));
  const path = join(parent, name + ".sock");
  if (Buffer.byteLength(path) > 103) {
    throw new Error("INVALID_RECEIPT_SOCKET");
  }
  await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
  });
  const directory = await lstat(parent);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700 ||
    (await realpath(parent)) !== parent
  ) {
    throw new Error("INVALID_RECEIPT_SOCKET");
  }
  await prepareControlSocket(path, 1000);
  const sockets = new Set<Socket>();
  const handlers = new Set<Promise<void>>();
  let closePromise: Promise<void> | undefined;
  const server = createServer(
    { maxHeaderSize: 4096, headersTimeout: 2000, requestTimeout: 5000 },
    (request, response) => {
      if (closePromise) {
        response.destroy();
        return;
      }
      response.shouldKeepAlive = false;
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const execute = async () => {
        const inspected = inspectRequestHead(request, {
          authority: "localhost",
          receivedMonoMs: 0,
          headerBytes: 4096,
          headerPairs: 16,
          targetBytes: 128,
        });
        if (
          inspected.kind === "denied" ||
          inspected.authorization !== undefined ||
          inspected.expectContinue ||
          inspected.head.contentEncoding !== "identity" ||
          inspected.head.method !== "POST" ||
          inspected.head.rawTarget !==
            (name === "receipt" ? "/v1/receipt" : "/v1/prepared-git/use") ||
          inspected.head.headers["content-type"] !== "application/json" ||
          inspected.head.framing.kind !== "length" ||
          (inspected.head.framing.bytes ?? 0) > 16384 ||
          request.rawHeaders.some(
            (entry, index) =>
              index % 2 === 0 &&
              !["host", "connection", "content-type", "content-length"].includes(
                entry.toLowerCase(),
              ),
          )
        ) {
          throw new Error("INVALID_RECEIPT_REQUEST");
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16384) {
            throw new Error("INVALID_RECEIPT_REQUEST");
          }
          chunks.push(Buffer.from(chunk));
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        if (
          closePromise ||
          response.destroyed ||
          request.socket.destroyed ||
          abort.signal.aborted
        ) {
          return;
        }
        // Track the operation itself: disconnecting its client need not settle State work.
        let complete!: () => void;
        const completion = new Promise<void>((resolve) => {
          complete = resolve;
        });
        handlers.add(completion);
        try {
          const value = await handle(parsed, abort.signal);
          abort.signal.throwIfAborted();
          const body = Buffer.from(JSON.stringify(value));
          writeReply(response, 200, body);
        } finally {
          handlers.delete(completion);
          complete();
        }
      };
      void execute().catch(() => {
        if (!response.destroyed) {
          const body = Buffer.from('{"error":"unavailable"}');
          writeReply(response, 503, body);
        }
      });
    },
  );
  server.maxRequestsPerSocket = 1;
  server.on("connection", (socket) => {
    if (closePromise || sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("checkContinue", (_request, response) => response.destroy());
  server.on("checkExpectation", (_request, response) => response.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(path, done);
  });
  let identity: Stats | undefined;
  const close = (startupFailure = false): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    let completeTransport!: (error?: unknown) => void;
    const closed = new Promise<unknown>((resolve) => {
      completeTransport = resolve;
    });
    const result = closed.then(async (error) => {
      await Promise.all(handlers);
      if (error && !startupFailure) {
        throw error;
      }
      const current = await lstat(path).catch(() => undefined);
      if (
        identity &&
        current?.isSocket() &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      ) {
        await unlink(path);
      }
    });
    closePromise = result;
    try {
      server.close(completeTransport);
      for (const socket of sockets) {
        socket.destroy();
      }
    } catch (error) {
      completeTransport(error);
    }
    return result;
  };
  try {
    identity = await lstat(path);
    await chmod(path, 0o600);
  } catch (error) {
    await close(true);
    throw error;
  }
  return { close: () => close() };
}
