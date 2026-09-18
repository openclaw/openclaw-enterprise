import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";

const { TLS_CERT_FILE, TLS_KEY_FILE, TARGET_URL } = process.env;
const port = Number.parseInt(process.env.PORT ?? "8443", 10);

if (!TLS_CERT_FILE || !TLS_KEY_FILE || !TARGET_URL || !Number.isSafeInteger(port)) {
  console.error("TLS_CERT_FILE, TLS_KEY_FILE, TARGET_URL, and a valid PORT are required.");
  process.exit(1);
}

const target = new URL(TARGET_URL);
if (target.protocol !== "http:") {
  console.error("TARGET_URL must be an HTTP URL for the private API service.");
  process.exit(1);
}
const upstreamTimeoutMs = 30_000;

function proxyHeaders(headers) {
  const forwarded = /^(?:forwarded|x-real-ip|x-forwarded-.+)$/i;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !forwarded.test(name)));
}

function proxyPath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

createServer(
  { cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) },
  (incoming, outgoing) => {
    const upstream = request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: proxyPath(incoming.url),
        method: incoming.method,
        headers: proxyHeaders(incoming.headers),
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, proxyHeaders(response.headers));
        response.pipe(outgoing);
      },
    );
    upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy());
    upstream.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
      }
      outgoing.end("Bad Gateway\n");
    });
    incoming.pipe(upstream);
  },
).listen(port, "0.0.0.0", () => {
  console.error(`production-tui HTTPS proxy listening on ${port}`);
});
