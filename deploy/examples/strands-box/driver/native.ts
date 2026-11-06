import { createHash, randomBytes } from "node:crypto";
import { request } from "node:https";
import { posix } from "node:path";
import type { Duplex } from "node:stream";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { record } from "./control.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TIMEOUT = 4_000;
const MAX_BODY = 16_384;
const MAX_WIRE = 32_768;
const MAX_FRAMES = 64;
const STATUS_PATH = "/openclaw/runtime/status";
const OWNER_HEADER = "x-openclaw-box-owner";

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const short = payload.length <= 125;
  const header = Buffer.alloc(short ? 6 : 8);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (short ? payload.length : 126);
  if (!short) header.writeUInt16BE(payload.length, 2);
  const mask = randomBytes(4);
  mask.copy(header, header.length - 4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, masked]);
}

function initialized(socket: Duplex, head: Buffer, signal: AbortSignal): Promise<void> {
  // Use Codex's reserved readiness identity, which leaves the shared originator alone.
  const id = randomBytes(16).toString("hex");
  const command = Buffer.from(
    JSON.stringify({
      id,
      method: "initialize",
      params: { clientInfo: { name: "codex_app_server_daemon", version: "1.0.0" } },
    }),
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const wire = Buffer.alloc(MAX_WIRE);
    let received = 0;
    let consumed = 0;
    let frames = 0;
    let fragments: Buffer[] | undefined;
    let fragmentBytes = 0;
    const fail = () => finish(new Error("Native initialize did not complete."));
    const abort = () => fail();
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.off("data", receive);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      // A reply is complete before the close handshake; bound cleanup independently.
      const close = setTimeout(() => socket.destroy(), 250);
      close.unref();
      socket.once("close", () => clearTimeout(close));
      socket.end(clientFrame(8, Buffer.from([3, 232])));
      resolve();
    }
    function message(bytes: Buffer): void {
      const reply = record(JSON.parse(decoder.decode(bytes)));
      if (!reply || (reply.jsonrpc !== undefined && reply.jsonrpc !== "2.0")) {
        return fail();
      }
      // Bounded server notifications can precede the only request we sent.
      if (
        !Object.hasOwn(reply, "id") &&
        typeof reply.method === "string" &&
        !Object.hasOwn(reply, "result") &&
        !Object.hasOwn(reply, "error")
      ) {
        return;
      }
      const result = record(reply.result);
      const agent = result?.userAgent;
      const home = result?.codexHome;
      // The leading name can be supplied by a previous client. The original
      // endpoint/capability establish identity; these fields establish compatibility.
      if (
        !Object.hasOwn(reply, "id") ||
        reply.id !== id ||
        !Object.hasOwn(reply, "result") ||
        !result ||
        !["userAgent", "codexHome", "platformFamily", "platformOs"].every((key) =>
          Object.hasOwn(result, key),
        ) ||
        Object.hasOwn(reply, "method") ||
        Object.hasOwn(reply, "error") ||
        result.platformFamily !== "unix" ||
        result.platformOs !== "linux" ||
        typeof home !== "string" ||
        home.length > 4096 ||
        !posix.isAbsolute(home) ||
        posix.normalize(home) !== home ||
        /[\u0000-\u001f\u007f]/u.test(home) ||
        typeof agent !== "string" ||
        agent.length > 512 ||
        !/^[^\s/]+\/[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?: |$)/u.test(
          agent,
        ) ||
        /[\u0000-\u001f\u007f]/u.test(agent)
      ) {
        return fail();
      }
      finish();
    }
    function frame(opcode: number, final: boolean, bytes: Buffer): void {
      if (opcode === 8) return fail();
      if (opcode === 9) {
        socket.write(clientFrame(10, bytes));
        return;
      }
      if (opcode === 10) return;
      if (opcode === 1 && !fragments) {
        if (final) return message(bytes);
        fragments = [bytes];
        fragmentBytes = bytes.length;
        return;
      }
      if (opcode !== 0 || !fragments || fragmentBytes + bytes.length > MAX_BODY) return fail();
      fragments.push(bytes);
      fragmentBytes += bytes.length;
      if (final) {
        const complete = Buffer.concat(fragments, fragmentBytes);
        fragments = undefined;
        fragmentBytes = 0;
        message(complete);
      }
    }
    function receive(chunk: Buffer): void {
      if (settled) return;
      if (received + chunk.length > MAX_WIRE) return fail();
      chunk.copy(wire, received);
      received += chunk.length;
      try {
        while (!settled && received - consumed >= 2) {
          const first = wire[consumed]!;
          const second = wire[consumed + 1]!;
          const final = (first & 0x80) !== 0;
          const opcode = first & 0x0f;
          let length = second & 0x7f;
          let offset = 2;
          // This bounded text client negotiates no extensions. Server frames are unmasked.
          if ((first & 0x70) !== 0 || (second & 0x80) !== 0 || length === 127) return fail();
          if (opcode >= 8 && (!final || length > 125)) return fail();
          if (length === 126) {
            if (received - consumed < 4) return;
            length = wire.readUInt16BE(consumed + 2);
            offset = 4;
            if (length < 126 || length > MAX_BODY) return fail();
          }
          const end = consumed + offset + length;
          if (received < end) return;
          if (++frames > MAX_FRAMES) return fail();
          const bytes = wire.subarray(consumed + offset, end);
          consumed = end;
          frame(opcode, final, bytes);
        }
      } catch {
        fail();
      }
    }
    socket.on("error", fail);
    socket.once("close", fail);
    socket.once("end", fail);
    socket.on("data", receive);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    try {
      socket.write(clientFrame(1, command));
      if (head.length > 0) receive(head);
    } catch {
      fail();
    }
  });
}

export async function nativeStatus(
  endpoint: string,
  ca: string,
  token: string,
  signal: AbortSignal,
  generationSha256?: string,
): Promise<
  { state: "starting" } | { state: "serving" } | { state: "failed"; runtimeFailure: unknown }
> {
  signal.throwIfAborted();
  let https: URL;
  try {
    https = new URL(endpoint);
  } catch {
    throw new DependencyUnavailableError("The Strands Box native Harness endpoint is invalid.");
  }
  if (
    https.protocol !== "wss:" ||
    https.href !== endpoint ||
    https.username ||
    https.password ||
    https.pathname !== "/" ||
    https.search ||
    https.hash ||
    token.length > 4096 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(token)
  ) {
    throw new DependencyUnavailableError("The Strands Box native Harness endpoint is invalid.");
  }
  https.protocol = "https:";
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  const options = {
    ca,
    rejectUnauthorized: true,
    maxHeaderSize: 8_192,
    agent: false as const,
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]),
    headers: { authorization: `Bearer ${token}` },
  };
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const pending = request(https, {
        ...options,
        headers: {
          ...options.headers,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": key,
        },
      });
      pending.once("error", reject);
      pending.once("response", (response) => {
        response.destroy();
        resolve(response.statusCode ?? 0);
      });
      pending.once("upgrade", (response, socket, head) => {
        const generation = response.rawHeaders.filter(
          (_value, index, headers) =>
            index % 2 === 1 && headers[index - 1]?.toLowerCase() === OWNER_HEADER,
        );
        if (
          response.statusCode !== 101 ||
          response.headers.upgrade?.toLowerCase() !== "websocket" ||
          !response.headers.connection
            ?.toLowerCase()
            .split(",")
            .some((part) => part.trim() === "upgrade") ||
          response.headers["sec-websocket-accept"] !== expected ||
          response.headers["sec-websocket-extensions"] !== undefined ||
          response.headers["sec-websocket-protocol"] !== undefined ||
          (generationSha256 !== undefined &&
            (generation.length !== 1 || generation[0] !== generationSha256))
        ) {
          socket.destroy();
          reject(new Error("Invalid WebSocket upgrade"));
          return;
        }
        void initialized(socket, head, options.signal).then(() => resolve(101), reject);
      });
      pending.end();
    });
    signal.throwIfAborted();
    if (status === 101) return { state: "serving" };
    if (status !== 503 || generationSha256 !== undefined) return { state: "starting" };
    const failure = await new Promise<unknown>((resolve, reject) => {
      const pending = request(new URL(STATUS_PATH, https), options, (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          resolve(undefined);
          return;
        }
        const body: Buffer[] = [];
        let bytes = 0;
        response.once("error", reject);
        response.once("aborted", () => reject(new Error("Incomplete status")));
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BODY) {
            response.destroy(new Error("Oversize status"));
            return;
          }
          body.push(chunk);
        });
        response.once("end", () => {
          try {
            resolve(
              record(JSON.parse(Buffer.concat(body, bytes).toString("utf8")))?.runtimeFailure,
            );
          } catch {
            reject(new Error("Invalid status"));
          }
        });
      });
      pending.once("error", reject);
      pending.end();
    });
    signal.throwIfAborted();
    return failure === undefined
      ? { state: "starting" }
      : { state: "failed", runtimeFailure: failure };
  } catch {
    signal.throwIfAborted();
    throw new DependencyUnavailableError(
      "The Strands Box native Harness did not confirm readiness.",
    );
  }
}
