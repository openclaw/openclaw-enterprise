import { randomUUID } from "node:crypto";

// Bound both the framing allocation and buffered writes; a slow peer closes its
// channel instead of growing the revision's memory without limit.
export const MAX_FRAME = 96 * 1024;
export const MAX_BUFFER = 1024 * 1024;
export const MAX_CHANNELS = 16;
export const CHUNK = 32 * 1024;

export function channelId() {
  return randomUUID();
}

export function write(stream, data) {
  if (stream.destroyed || stream.writableLength + data.length > MAX_BUFFER) {
    throw new Error("Transport unavailable or congested");
  }
  return stream.write(data);
}

export function framed(reader, writer, receive, failed) {
  let pending = Buffer.alloc(0);
  let stopped = false;
  const drainWaiters = new Set();
  const fail = () => {
    if (!stopped) {
      stopped = true;
      pending = Buffer.alloc(0);
      drainWaiters.clear();
      failed();
    }
  };
  const send = (message) => {
    if (stopped) throw new Error("Transport stopped");
    const frame = Buffer.from(JSON.stringify(message) + "\n");
    if (frame.length > MAX_FRAME) {
      throw new Error("Oversized transport frame");
    }
    return write(writer, frame);
  };
  send.onDrain = (resume) => {
    drainWaiters.add(resume);
    return () => drainWaiters.delete(resume);
  };
  writer.on("drain", () => {
    const ready = [...drainWaiters];
    drainWaiters.clear();
    for (const resume of ready) resume();
  });
  reader.on("data", (chunk) => {
    if (stopped) return;
    try {
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        if (end + 1 > MAX_FRAME) {
          throw new Error("Oversized transport frame");
        }
        const message = JSON.parse(pending.subarray(0, end).toString());
        pending = pending.subarray(end + 1);
        if (
          !message ||
          typeof message !== "object" ||
          typeof message.id !== "string" ||
          !/^[a-f0-9-]{36}$/u.test(message.id) ||
          !["open", "data", "close"].includes(message.type)
        ) {
          throw new Error("Invalid transport frame");
        }
        receive(message);
      }
      if (pending.length > MAX_FRAME) {
        throw new Error("Oversized transport frame");
      }
    } catch {
      fail();
    }
  });
  reader.on("end", fail);
  reader.on("close", fail);
  reader.on("error", fail);
  writer.on("close", fail);
  writer.on("error", fail);
  return send;
}

export function relay(socket, id, send, closed) {
  let cancelDrain;
  socket.on("data", (data) => {
    let offset = 0;
    const pump = () => {
      cancelDrain = undefined;
      if (socket.destroyed) return;
      try {
        while (offset < data.length) {
          const chunk = data.subarray(offset, offset + CHUNK);
          offset += chunk.length;
          if (!send({ id, type: "data", data: chunk.toString("base64") })) {
            // The frame was accepted. Keep only the remainder of this one
            // read and let TCP backpressure bound the upstream producer.
            socket.pause();
            cancelDrain = send.onDrain(pump);
            return;
          }
        }
        socket.resume();
      } catch {
        socket.destroy();
      }
    };
    pump();
  });
  socket.on("error", () => socket.destroy());
  socket.once("close", () => {
    cancelDrain?.();
    closed();
    try {
      send({ id, type: "close" });
    } catch {
      /* The whole Box may already be stopping. */
    }
  });
}

export function deliver(message, socket) {
  if (message.type === "close") {
    socket.destroy();
    return;
  }
  if (message.type !== "data" || typeof message.data !== "string") {
    throw new Error("Unexpected channel message");
  }
  const data = Buffer.from(message.data, "base64");
  if (data.length > CHUNK || data.toString("base64") !== message.data) {
    throw new Error("Invalid channel data");
  }
  try {
    write(socket, data);
  } catch {
    // Valid data for a stalled or disconnected client is a channel failure,
    // not malformed shared framing. Other channels must remain available.
    socket.destroy();
  }
}

export function firstHeader(socket, accept) {
  let bytes = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), 5000);
  const cleanup = () => clearTimeout(timer);
  socket.once("close", cleanup);
  socket.on("error", () => socket.destroy());
  const read = (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    const end = bytes.indexOf("\r\n\r\n");
    if ((end < 0 && bytes.length > 16384) || end > 16384) {
      socket.destroy();
      return;
    }
    if (end < 0) {
      return;
    }
    socket.pause();
    socket.removeListener("data", read);
    cleanup();
    const lines = bytes.subarray(0, end).toString("latin1").split("\r\n");
    try {
      accept(lines, bytes);
    } catch {
      socket.destroy();
    }
  };
  socket.on("data", read);
}
