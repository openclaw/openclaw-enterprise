import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { WebSocket } = createRequire("/app/package.json")("ws");
export function nativeReady(port, token) {
  return new Promise((resolve) => {
    const id = randomUUID();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { authorization: `Bearer ${token}`, "x-oce-readiness": "1" },
      maxPayload: 16384,
      handshakeTimeout: 4000,
    });
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 4500);
    socket.once("open", () =>
      socket.send(
        JSON.stringify({
          id,
          method: "initialize",
          params: { clientInfo: { name: "codex_app_server_daemon", version: "1" } },
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
  });
}
