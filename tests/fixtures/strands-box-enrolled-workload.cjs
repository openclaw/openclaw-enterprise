// Appended to the supplier's generated enrollment helper and invoked by node -e in the test Pod.
// This emulates the app-server capability and control-frame wire, never the sender or an origin.
"use strict";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = async function serveEnrolledWorkload(enrollment, waitForComputeRelease) {
  const crypto = require("node:crypto");
  const http = require("node:http");
  const fs = require("node:fs");
  if (!isPlainObject(enrollment)) {
    throw new Error("expected enrollment");
  }
  await waitForComputeRelease(enrollment);

  const sockets = new Set();
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    const headers = request.headers;
    const capability = /^Bearer (.+)$/.exec(headers.authorization || "")?.[1];
    if (
      !capability ||
      crypto.createHash("sha256").update(capability).digest("hex") !== process.env.APP_TOKEN_SHA
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Accept: " + accept,
        "",
        "",
      ].join("\r\n"),
    );

    // RFC6455 client control frames are final, masked and at most 125 bytes. Buffer splits, echo
    // each authenticated nonce Ping as Pong, and close on anything else. Never process app data.
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 6) {
        const opcode = input[0];
        const length = input[1] & 0x7f;
        if ((opcode !== 0x89 && opcode !== 0x88) || !(input[1] & 0x80) || length > 125) {
          socket.destroy();
          return;
        }
        if (input.length < length + 6) {
          return;
        }
        const payload = Buffer.from(input.subarray(6, 6 + length));
        for (let i = 0; i < length; i++) {
          payload[i] ^= input[2 + (i % 4)];
        }
        input = input.subarray(6 + length);
        socket.write(
          Buffer.concat([Buffer.from([opcode === 0x89 ? 0x8a : 0x88, length]), payload]),
        );
        if (opcode === 0x88) {
          return socket.end();
        }
      }
    });
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  // Fault injection limited to this test capability channel, never the production or origin socket.
  process.on("SIGUSR2", () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  });
  server.listen(18790, () => {
    fs.writeFileSync("/tmp/qualification-app-pid", String(process.pid));
    fs.writeFileSync("/tmp/compute-released", process.env.OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID);
  });
};
