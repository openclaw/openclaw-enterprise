import type { IncomingMessage } from "node:http";

/** Deliver borrowed reply bytes synchronously; callers own status acceptance and parsing. */
export function readPrivateJsonResponse(
  incoming: IncomingMessage,
  receive: (bytes: Buffer | undefined) => void,
  reject: (error: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let finished = false;
  const wipe = () => {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    chunks.length = 0;
  };
  const deliver = (bytes?: Buffer) => {
    finished = true;
    try {
      receive(bytes);
    } finally {
      bytes?.fill(0);
      wipe();
    }
  };
  incoming.on("data", (chunk: Buffer) => {
    if (finished) {
      chunk.fill(0);
      return;
    }
    size += chunk.length;
    if (size > 16_384) {
      chunk.fill(0);
      // Settle the caller itself before teardown or another error in this dispatch.
      try {
        deliver();
      } finally {
        incoming.destroy();
      }
    } else {
      chunks.push(chunk);
    }
  });
  incoming.once("error", (error) => {
    if (finished) {
      return;
    }
    finished = true;
    wipe();
    reject(error);
  });
  incoming.once("end", () => {
    if (finished) {
      return;
    }
    let bytes: Buffer | undefined;
    if (incoming.complete && incoming.headers["content-type"] === "application/json") {
      try {
        bytes = Buffer.concat(chunks);
      } catch {
        // A failed allocation is an invalid reply.
      }
    }
    deliver(bytes);
  });
}
