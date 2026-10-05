import { once } from "node:events";
import { createServer } from "node:net";

// Returns a TCP port that was free on `host` and is released again before returning.
// Bind it promptly: another process can take it in between. Pass the host the real
// listener will bind (for example "0.0.0.0") so the check covers the same interfaces.
// A just-released port also serves as a loopback port that refuses connections.
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
export async function reservePort({ host = "127.0.0.1" } = {}) {
  // A connection that still reaches the reservation is reset rather than left hanging.
  const server = createServer((socket) => socket.destroy());
  try {
    server.listen({ port: 0, host, reusePort: true });
    await once(server, "listening");
  } catch (error) {
    if (error.code !== "ENOTSUP") {
      throw error;
    }
    return { port: await availablePort({ host }), reusePort: false, release: async () => {} };
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
