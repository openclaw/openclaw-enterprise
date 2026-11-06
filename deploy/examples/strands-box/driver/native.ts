import { createHash, randomBytes } from "node:crypto";
import { request } from "node:https";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { record } from "./control.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TIMEOUT = 4_000;
const STATUS_PATH = "/openclaw/runtime/status";

export async function nativeStatus(
  endpoint: string,
  ca: string,
  token: string,
  signal: AbortSignal,
): Promise<
  { state: "starting" } | { state: "serving" } | { state: "failed"; runtimeFailure: unknown }
> {
  const https = new URL(endpoint);
  https.protocol = "https:";
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  const options = {
    ca,
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
      pending.once("upgrade", (response, socket) => {
        if (
          response.statusCode !== 101 ||
          response.headers.upgrade?.toLowerCase() !== "websocket" ||
          response.headers["sec-websocket-accept"] !== expected
        ) {
          socket.destroy();
          reject(new Error("Invalid WebSocket upgrade"));
          return;
        }
        // Send an RFC 6455 masked, empty normal Close frame, then discard this disposable probe.
        socket.once("error", () => socket.destroy());
        socket.end(Buffer.concat([Buffer.from([0x88, 0x80]), randomBytes(4)]));
        resolve(101);
      });
      pending.end();
    });
    signal.throwIfAborted();
    if (status === 101) return { state: "serving" };
    if (status !== 503) return { state: "starting" };
    const failure = await new Promise<unknown>((resolve, reject) => {
      const pending = request(new URL(STATUS_PATH, https), options, (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          resolve(undefined);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.once("error", reject);
        response.on("data", (chunk: string) => {
          body += chunk;
          if (Buffer.byteLength(body) > 16_384) response.destroy(new Error("Oversize status"));
        });
        response.once("end", () => {
          try {
            resolve(record(JSON.parse(body))?.runtimeFailure);
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
