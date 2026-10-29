// Starts a fixture server (net, http, https or tls) on `host` and closes it when the test
// ends: open connections are destroyed first, so a held or keep-alive response cannot
// stall the close. A close error is ignored (the test may have closed the server itself).
// Binds an ephemeral port unless `port` is given; returns the bound port.
export async function listen(t, server, host = "127.0.0.1", { port = 0 } = {}) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
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
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return server.address().port;
}
