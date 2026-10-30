import net from "node:net";

await Promise.all(
  (process.env.BOUND_LOGIN_HEALTH_PORTS?.split(",").map(Number) ?? [39081, 39082, 39083]).map(
    (port) =>
      new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.setTimeout(2000, () => socket.destroy(new Error("Timeout")));
        socket.on("error", reject);
      }),
  ),
);
