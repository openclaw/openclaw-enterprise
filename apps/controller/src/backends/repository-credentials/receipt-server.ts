import { createServer } from "node:http";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Socket } from "node:net";
import type { PlatformStateStore } from "@openclaw-enterprise/occ";
import { prepareControlSocket } from "../../drivers/repo/credentials/server.ts";
import { isBoundInput, snapshotSessionInput } from "../../drivers/repo/credentials/sessions.ts";
import { inspectRequestHead } from "../../drivers/repo/credentials/transport/request.ts";
import type { SessionStatus } from "../../drivers/repo/credentials/service-contracts.ts";
import { RepositoryReceiptStore } from "./receipt-store.ts";

const admissionPattern =
  /^[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new Error("INVALID_RECEIPT_REQUEST");
  }
  return value as Record<string, unknown>;
}

function status(value: unknown): SessionStatus {
  const input = object(value, [
    "sessionId",
    "state",
    "deadlineWallMs",
    "binding",
    "activeUses",
    "cleanup",
  ]);
  const binding = object(input.binding, ["providerInstanceId", "repositoryId", "grantId"]);
  const cleanup = object(input.cleanup, [
    "active",
    "pending",
    "revoked",
    "expired",
    "uncertain",
    "auxiliaryPending",
  ]);
  const counter = (entry: unknown): number => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error("INVALID_RECEIPT_REQUEST");
    }
    return entry;
  };
  const identity = (entry: unknown): string => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      Buffer.byteLength(entry) > 512 ||
      [...entry].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    ) {
      throw new Error("INVALID_RECEIPT_REQUEST");
    }
    return entry;
  };
  if (
    typeof input.sessionId !== "string" ||
    !sessionPattern.test(input.sessionId) ||
    !["OPEN", "CLOSED", "DISPOSED"].includes(String(input.state)) ||
    typeof cleanup.auxiliaryPending !== "boolean"
  ) {
    throw new Error("INVALID_RECEIPT_REQUEST");
  }
  return {
    sessionId: input.sessionId,
    state: input.state as SessionStatus["state"],
    deadlineWallMs: counter(input.deadlineWallMs),
    binding: {
      providerInstanceId: identity(binding.providerInstanceId),
      repositoryId: identity(binding.repositoryId),
      grantId: identity(binding.grantId),
    },
    activeUses: counter(input.activeUses),
    cleanup: {
      active: counter(cleanup.active),
      pending: counter(cleanup.pending),
      revoked: counter(cleanup.revoked),
      expired: counter(cleanup.expired),
      uncertain: counter(cleanup.uncertain),
      auxiliaryPending: cleanup.auxiliaryPending,
    },
  };
}

/** Worker-local durable receipt listener. No credentials are accepted or returned. */
export async function startRepositoryReceiptServer(options: {
  readonly controlSocket: string;
  readonly state: PlatformStateStore;
  readonly driverId: string;
  readonly implementation: string;
  readonly backendId: string;
}) {
  const parent = dirname(resolve(options.controlSocket));
  const path = join(parent, "receipt.sock");
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
  const store = new RepositoryReceiptStore(options.state, options);
  const sockets = new Set<Socket>();
  const server = createServer(
    { maxHeaderSize: 4096, headersTimeout: 2000, requestTimeout: 5000 },
    (request, response) => {
      response.shouldKeepAlive = false;
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
          inspected.head.rawTarget !== "/v1/receipt" ||
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
        if (parsed.kind === "status") {
          const input = object(parsed, ["kind", "sessionId"]);
          if (typeof input.sessionId !== "string" || !sessionPattern.test(input.sessionId)) {
            throw new Error("INVALID_RECEIPT_REQUEST");
          }
          const found = await store.status(input.sessionId);
          return found ? { kind: "disposed", status: found } : { kind: "missing" };
        }
        const fields =
          parsed.kind === "bind" || parsed.kind === "dispose"
            ? ["kind", "admissionId", "generation", "input", "status"]
            : ["kind", "admissionId", "generation", "input"];
        const command = object(parsed, fields);
        if (
          !["reserve", "recover", "bind", "dispose", "fence"].includes(String(command.kind)) ||
          typeof command.admissionId !== "string" ||
          !admissionPattern.test(command.admissionId) ||
          typeof command.generation !== "string" ||
          !generationPattern.test(command.generation)
        ) {
          throw new Error("INVALID_RECEIPT_REQUEST");
        }
        const input = snapshotSessionInput(command.input);
        if (!isBoundInput(input)) {
          throw new Error("INVALID_RECEIPT_REQUEST");
        }
        if (command.kind === "reserve" || command.kind === "recover") {
          return store.admission(
            command.admissionId,
            input,
            command.generation,
            command.kind === "recover",
          );
        }
        if (command.kind === "fence") {
          await store.fence(command.admissionId, input, command.generation);
          return { kind: "acknowledged" };
        }
        const observed = status(command.status);
        if (command.kind === "bind") {
          await store.bind(command.admissionId, input, command.generation, observed);
        } else {
          await store.dispose(command.admissionId, input, command.generation, observed);
        }
        return { kind: "acknowledged" };
      };
      void execute().then(
        (result) => {
          const body = Buffer.from(JSON.stringify(result));
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": body.length,
            "cache-control": "no-store",
            connection: "close",
          });
          response.end(body);
        },
        () => {
          if (!response.destroyed) {
            const body = Buffer.from('{"error":"unavailable"}');
            response.writeHead(503, {
              "content-type": "application/json",
              "content-length": body.length,
              "cache-control": "no-store",
              connection: "close",
            });
            response.end(body);
          }
        },
      );
    },
  );
  server.maxRequestsPerSocket = 1;
  server.on("connection", (socket) => {
    if (sockets.size >= 64) {
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
  let identity;
  try {
    identity = await lstat(path);
    await chmod(path, 0o600);
  } catch (error) {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((done) => server.close(() => done()));
    const current = await lstat(path).catch(() => undefined);
    if (
      identity &&
      current?.isSocket() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    ) {
      await unlink(path);
    }
    throw error;
  }
  return {
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      const current = await lstat(path).catch(() => undefined);
      if (current?.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(path);
      }
    },
  };
}
