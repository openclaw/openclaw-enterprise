import type { Server, Socket } from "node:net";
import type { TestContext } from "node:test";

// Starts a fixture server (net, http, https or tls) on `host` and closes it when the test
// ends: open connections are destroyed first, so a held or keep-alive response cannot
// stall the close. A close error is ignored (the test may have closed the server itself).
// Binds an ephemeral port unless `port` is given; returns the bound port.
export async function listen(
  t: Pick<TestContext, "after">,
  server: Server,
  host = "127.0.0.1",
  { port = 0 }: { port?: number } = {},
): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not bind a TCP port");
  }
  return address.port;
}
