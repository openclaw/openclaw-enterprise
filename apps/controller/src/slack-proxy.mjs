import { createServer } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 3128;
const CONNECT_TIMEOUT_MS = 10_000;
const SHUTDOWN_DRAIN_MS = 2_000;
const ALLOWED_SUFFIXES = [".slack.com", ".slack-edge.com", ".slack-msgs.com"];
const ALLOWED_HOSTS = new Set(["slack.com", "slack-edge.com", "slack-msgs.com"]);

function parsePort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("OCC_SLACK_PROXY_PORT must be an integer TCP port.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OCC_SLACK_PROXY_PORT must be between 0 and 65535.");
  }
  return port;
}

function parseConnectTarget(target) {
  const match = /^([A-Za-z0-9.-]+):([0-9]+)$/.exec(target ?? "");
  if (match === null) {
    return undefined;
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return { host: match[1].toLowerCase(), port };
}

function isAllowedSlackConnectTarget(target) {
  const parsed = parseConnectTarget(target);
  if (parsed === undefined || parsed.port !== 443) {
    return false;
  }
  return (
    ALLOWED_HOSTS.has(parsed.host) ||
    ALLOWED_SUFFIXES.some((suffix) => parsed.host.endsWith(suffix))
  );
}

function closeOnSocketError(socket) {
  let closing = false;
  socket.on("error", () => {
    if (closing) {
      return;
    }
    closing = true;
    socket.destroy();
  });
}

function reject(socket, statusCode, message) {
  socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
}

function createSlackProxyServer() {
  const server = createServer((request, response) => {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("CONNECT required\n");
  });

  server.on("connect", (request, clientSocket, head) => {
    // Attach this before reject(). A refused CONNECT that resets emits
    // EPIPE or ECONNRESET while the 403 is written; without a listener
    // that error exits the process.
    closeOnSocketError(clientSocket);
    if (!isAllowedSlackConnectTarget(request.url)) {
      reject(clientSocket, 403, "Forbidden");
      return;
    }
    const target = parseConnectTarget(request.url);
    const upstream = net.connect({ host: target.host, port: target.port });
    let connected = false;
    upstream.setTimeout(CONNECT_TIMEOUT_MS);
    upstream.once("connect", () => {
      connected = true;
      upstream.setTimeout(0);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once("timeout", () => upstream.destroy(new Error("upstream connection timeout")));
    upstream.once("error", () => {
      if (connected) {
        clientSocket.destroy();
        return;
      }
      reject(clientSocket, 502, "Bad Gateway");
    });
    upstream.once("close", () => clientSocket.destroy());
    clientSocket.once("close", () => upstream.destroy());
    clientSocket.once("error", () => upstream.destroy());
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = parsePort(process.env.OCC_SLACK_PROXY_PORT);
  const server = createSlackProxyServer();
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // The proxy runs as PID 1 in its Pod, where the kernel drops a SIGTERM that has no
  // handler; the Pod would then wait out its termination grace for SIGKILL. Stop
  // listening at once and give short Web API calls a moment to finish. Tunnels are
  // long-lived Socket Mode connections that never drain, so then close them: Slack
  // clients reconnect through the Service to a ready replacement.
  const shutdown = () => {
    server.close();
    const destroyAll = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
    }, SHUTDOWN_DRAIN_MS);
    destroyAll.unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    const selectedPort = typeof address === "object" && address !== null ? address.port : port;
    process.stderr.write(`Slack proxy listening on ${selectedPort}\n`);
  });
}
