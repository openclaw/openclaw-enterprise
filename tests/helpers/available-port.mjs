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
