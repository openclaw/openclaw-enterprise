import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// This probe runs in the trusted supervisor; the workload never mounts its token.
const { WebSocket } = createRequire("/app/package.json")("ws");
const token = readFileSync(process.argv[2], "utf8");
const port = Number(process.argv[3]);
if (!token || token.length > 65536 || !Number.isInteger(port) || port < 1 || port > 65535) {
  process.exit(1);
}
const id = randomUUID();
const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { authorization: `Bearer ${token}` },
  maxPayload: 16384,
  handshakeTimeout: 4000,
});
let finished = false;
const finish = (ready) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  socket.terminate();
  process.exitCode = ready ? 0 : 1;
};
const timer = setTimeout(() => finish(false), 4500);
socket.once("open", () =>
  socket.send(
    JSON.stringify({
      id,
      method: "initialize",
      params: { clientInfo: { name: "oce_box_readiness", version: "1" } },
    }),
  ),
);
socket.on("message", (data, binary) => {
  if (binary) return finish(false);
  try {
    const message = JSON.parse(data.toString("utf8"));
    if (message.id === id)
      finish(
        !message.error &&
          typeof message.result?.userAgent === "string" &&
          message.result.userAgent.length > 0,
      );
  } catch {
    finish(false);
  }
});
socket.once("error", () => finish(false));
socket.once("close", () => finish(false));
