import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { createServer } from "node:https";

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

// Only this owned fixture mounts /operator. A restarted proxy always starts closed.
const gate = "/operator/signin-gate";
const generation = randomUUID();
const guarded = process.env.OCC_SIGNIN_PROXY === "1";
if (guarded) {
  writeFileSync(gate + ".generation", generation, { mode: 0o600 });
}
function admitted(suffix = "") {
  try {
    return readFileSync(gate + suffix, "utf8") === generation;
  } catch {
    return false;
  }
}

function proxyHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = /^(?:forwarded|x-real-ip|x-forwarded-.+)$/i;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !forwarded.test(name)));
}

function proxyPath(url: IncomingMessage["url"]): string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

createServer(
  { cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) },
  (incoming, outgoing) => {
    // Bootstrap reads also establish custody while traffic is closed. Match the raw path
    // exactly so URL normalization cannot turn a permitted request into an auth request.
    const { method, url, headers } = incoming;
    const retainedRead =
      method === "GET" &&
      (url === "/installation" || /^\/namespaces\/[A-Za-z0-9_-]+$/.test(url ?? ""));
    const bootstrap =
      guarded &&
      admitted(".bootstrap") &&
      (retainedRead || (method === "POST" && url === "/namespaces" && headers["x-api-key"]));
    const retained = guarded && retainedRead && headers["x-api-key"] && admitted(".retained");
    if (guarded && !bootstrap && !retained && !admitted()) {
      outgoing.writeHead(503, { "x-rehearsal-gate": "closed", "cache-control": "no-store" });
      outgoing.end();
      return;
    }
    const upstream = request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: proxyPath(url),
        method,
        headers: proxyHeaders(headers),
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
