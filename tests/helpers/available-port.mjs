import { once } from "node:events";
import { connect, createServer } from "node:net";

// Returns a TCP port that was free on `host` and is released again before returning.
// Bind it promptly: another process can take it in between. Pass the host the real
// listener will bind (for example "0.0.0.0") so the check covers the same interfaces.
// For a port that must refuse connections, use refusingPort(): a released port can be
// taken by any listener that binds port 0, such as a test running in parallel.
export async function availablePort({ host = "127.0.0.1" } = {}) {
  const server = createServer();
  server.listen(0, host);
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

// Holds a free TCP port on `host` for a listener whose port must be known before it can be
// built (for example because the port is part of its configured origin). The reservation
// stays bound with SO_REUSEPORT, so the real listener binds the same port with
// `listen({ ..., reusePort })` while no other socket can take it; call release() once the
// real listener is up. Where the platform has no SO_REUSEPORT for Node (macOS), `reusePort`
// is false and the port is released at once, as availablePort() does. While both sockets
// listen the kernel may hand a connection to either, so release right after the bind.
// Reserve on exactly the host the listener binds: a more specific address (127.0.0.1 next
// to a 0.0.0.0 listener) takes every connection. Pass `port` to hold a port that a listener bound with `reusePort` still holds, so it stays
// held across that listener's restart: reserve, close the listener, bind the new one, release.
export async function reservePort({ host = "127.0.0.1", port: wanted = 0 } = {}) {
  // A connection that still reaches the reservation is reset rather than left hanging.
  const server = createServer((socket) => socket.destroy());
  try {
    server.listen({ port: wanted, host, reusePort: true });
    await once(server, "listening");
  } catch (error) {
    if (error.code !== "ENOTSUP") {
      throw error;
    }
    const port = wanted === 0 ? await availablePort({ host }) : wanted;
    return { port, reusePort: false, release: async () => {} };
  }
  const { port } = server.address();
  let released;
  return {
    port,
    reusePort: true,
    release() {
      released ??= new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return released;
    },
  };
}

// Node arguments that let a child process bind a reservation's port: pass them before the
// child's entrypoint. The child preloads reuse-port-preload.mjs, which adds `reusePort` to
// its own listen() on that port only. Without SO_REUSEPORT the reservation holds nothing,
// so there are no arguments and the child runs unchanged.
export function reservedPortArgs(reservation) {
  if (!reservation.reusePort) {
    return [];
  }
  const preload = new URL("./reuse-port-preload.mjs", import.meta.url);
  preload.searchParams.set("port", String(reservation.port));
  return ["--import", preload.href];
}

// Holds a port on `host` that refuses connections until release(). A connected client
// socket stays bound to it and nothing listens there. On Linux the kernel skips the port
// for every bind to port 0 that could accept on `host` and for every outgoing
// connection's local port, so only an explicit bind to this number could take it.
export async function refusingPort({ host = "127.0.0.1" } = {}) {
  // Every accepted socket is kept: a stray connection can reach the listener first.
  const peers = new Set();
  const server = createServer((socket) => {
    socket.on("error", () => {});
    peers.add(socket);
  });
  server.listen(0, host);
  await once(server, "listening");
  // An explicit local address makes Node bind the client before it connects.
  const holder = connect({ port: server.address().port, host, localAddress: host });
  try {
    await once(holder, "connect");
    // A reset of the held pair must not crash the test file.
    holder.on("error", () => {});
    // Closing the listener before it accepts the held connection would reset it.
    while (![...peers].some((socket) => socket.remotePort === holder.localPort)) {
      await once(server, "connection");
    }
  } catch (error) {
    holder.destroy();
    for (const socket of peers) {
      socket.destroy();
    }
    server.close();
    throw error;
  }
  // Stop listening; the held connection keeps the client's port bound.
  const closed = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  let released;
  return {
    port: holder.localPort,
    release() {
      released ??= (async () => {
        holder.destroy();
        for (const socket of peers) {
          socket.destroy();
        }
        await closed;
      })();
      return released;
    },
  };
}
