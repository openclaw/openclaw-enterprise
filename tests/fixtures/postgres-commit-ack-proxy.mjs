import net from "node:net";
import { once } from "node:events";
import pg from "pg";

// A protocol transport fault, not a pg.Client monkeypatch. The server's real
// COMMIT completion is consumed here and never delivered to the application.
export async function commitAckProxy(databaseUrl) {
  const target = new URL(databaseUrl);
  // Resolve query-string and environment precedence with the same installed
  // driver as the caller. URL authority alone is not the effective destination.
  const effective = new pg.Client({ connectionString: databaseUrl });
  const upstreamHost = effective.host.replace(/^\[|\]$/g, "");
  const upstreamPort = effective.port;
  if (!["127.0.0.1", "localhost", "::1"].includes(upstreamHost)) {
    throw new Error("The commit fault requires a disposable loopback PostgreSQL database.");
  }
  // This fixture inspects PostgreSQL frames, so it cannot observe encrypted
  // COMMIT completion. Reject TLS intent rather than silently downgrading it.
  if (effective.ssl) {
    throw new Error("The commit fault requires an explicitly non-TLS PostgreSQL connection.");
  }
  let armed = false;
  let observed = false;
  const sockets = new Set();
  const server = net.createServer((client) => {
    client.setNoDelay(true);
    const upstream = net.connect({
      host: upstreamHost,
      port: upstreamPort,
    });
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    let frontend = Buffer.alloc(0);
    let backend = Buffer.alloc(0);
    let startup = true;
    let dropping = false;
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.on("data", (chunk) => {
      frontend = Buffer.concat([frontend, chunk]);
      while (frontend.length >= (startup ? 4 : 5)) {
        const size = frontend.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (size < 4 || size > 16 * 1024 * 1024) {
          return close();
        }
        if (frontend.length < size) {
          return;
        }
        const frame = frontend.subarray(0, size);
        frontend = frontend.subarray(size);
        if (
          !startup &&
          frame[0] === 81 &&
          frame.subarray(5, -1).toString().trim().toUpperCase() === "COMMIT" &&
          armed
        ) {
          dropping = true;
          armed = false;
        }
        startup = false;
        upstream.write(frame);
      }
    });
    upstream.on("data", (chunk) => {
      backend = Buffer.concat([backend, chunk]);
      while (backend.length >= 5) {
        const size = backend.readInt32BE(1) + 1;
        if (size < 5 || size > 16 * 1024 * 1024) {
          return close();
        }
        if (backend.length < size) {
          return;
        }
        const frame = backend.subarray(0, size);
        backend = backend.subarray(size);
        if (dropping && frame[0] === 67 && frame.subarray(5, -1).toString() === "COMMIT") {
          observed = true;
          return close();
        }
        if (!dropping) {
          client.write(frame);
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const proxyUrl = new URL(target);
  proxyUrl.hostname = "127.0.0.1";
  proxyUrl.port = String(server.address().port);
  proxyUrl.searchParams.delete("host");
  proxyUrl.searchParams.delete("port");
  return {
    url: proxyUrl.toString(),
    arm() {
      if (armed || observed) {
        throw new Error("The single-use fault is already armed or consumed.");
      }
      armed = true;
    },
    get observedCommit() {
      return observed;
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
