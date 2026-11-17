import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { request } from "node:https";
import { connect, type TLSSocket } from "node:tls";

const host = "127.0.0.1";
const proxyPort = 8443;
const originPort = 8080;
const gate = "/operator/signin-gate";
const ca = readFileSync("/tls/ca.pem");
const key = { "x-api-key": "synthetic-operator-key" };
const tlsOptions = { host, port: proxyPort, ca, rejectUnauthorized: true };

type ReceivedRequest = {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
};

const received: ReceivedRequest[] = [];
const origin = createServer((incoming, outgoing) => {
  let body = "";
  incoming.setEncoding("utf8").on("data", (chunk: string) => {
    body += chunk;
  });
  incoming.on("end", () => {
    received.push({ method: incoming.method, path: incoming.url, headers: incoming.headers, body });
    outgoing.writeHead(201, {
      "content-type": "text/plain",
      "x-origin": "loopback",
      forwarded: "for=origin",
      "x-real-ip": "127.0.0.2",
      "x-forwarded-host": "forged-origin",
      "set-cookie": ["first=1", "second=2"],
    });
    outgoing.end("origin response\n");
  });
});
// Give a mistakenly forwarded CONNECT an observable effect instead of relying
// on the origin's default behavior, which also closes an unhandled tunnel.
origin.on("connect", (incoming, socket) => {
  received.push({
    method: incoming.method,
    path: incoming.url,
    headers: incoming.headers,
    body: "",
  });
  socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
});

function startOrigin(): Promise<void> {
  return new Promise((resolve, reject: (error: Error) => void) => {
    origin.once("error", reject);
    origin.listen(originPort, host, () => {
      origin.off("error", reject);
      resolve();
    });
  });
}

function stopOrigin(): Promise<void> {
  return new Promise((resolve, reject: (error: Error) => void) => {
    origin.close((error) => (error ? reject(error) : resolve()));
    origin.closeAllConnections();
  });
}

type WireResponse = { status: number | undefined; headers: IncomingHttpHeaders; body: string };

function send(
  method: string,
  path: string,
  headers: OutgoingHttpHeaders = {},
  body = "",
): Promise<WireResponse> {
  return new Promise((resolve, reject: (error: Error) => void) => {
    const client = request(
      {
        ...tlsOptions,
        method,
        path,
        agent: false,
        headers: body === "" ? headers : { ...headers, "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8").on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode, headers: response.headers, body: text }),
        );
      },
    );
    client.on("socket", (socket: TLSSocket) => {
      socket.once("secureConnect", () => {
        if (!socket.authorized) {
          client.destroy(new Error("Operator TLS peer was not authorized"));
        }
      });
    });
    client.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Expected an ordinary HTTP response, received an upgrade"));
    });
    client.on("error", reject);
    client.setTimeout(3_000, () => client.destroy(new Error("Operator HTTPS request timed out")));
    client.end(body);
  });
}

async function refused(method: string, path: string, headers: OutgoingHttpHeaders = {}) {
  const before = received.length;
  const response = await send(method, path, headers);
  assert.equal(response.status, 503, `${method} ${path}`);
  assert.equal(response.headers["x-rehearsal-gate"], "closed");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body, "");
  assert.equal(received.length, before, "The closed gate must not contact the origin");
}

async function forwarded(
  method: string,
  path: string,
  {
    headers = {},
    body = "",
    originPath = path,
  }: { headers?: OutgoingHttpHeaders; body?: string; originPath?: string } = {},
) {
  const before = received.length;
  const response = await send(method, path, headers, body);
  assert.equal(response.status, 201, `${method} ${path}`);
  assert.equal(response.headers["x-origin"], "loopback");
  assert.deepEqual(response.headers["set-cookie"], ["first=1", "second=2"]);
  assert.equal(response.body, "origin response\n");
  for (const name of ["forwarded", "x-real-ip", "x-forwarded-host"]) {
    assert.equal(response.headers[name], undefined, `response leaked ${name}`);
  }
  assert.equal(received.length, before + 1);
  const seen = received[before];
  assert.ok(seen);
  assert.equal(seen.method, method);
  assert.equal(seen.path, originPath);
  assert.equal(seen.body, body);
  return seen.headers;
}

function connectResponse(): Promise<string> {
  return new Promise((resolve, reject: (error: Error) => void) => {
    let output = "";
    const socket = connect(tlsOptions, () => {
      socket.write("CONNECT loopback.test:8080 HTTP/1.1\r\nHost: loopback.test:8080\r\n\r\n");
    });
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    socket.once("end", () => resolve(output));
    socket.once("error", reject);
    socket.setTimeout(3_000, () => socket.destroy(new Error("CONNECT refusal timed out")));
  });
}

const generation = readFileSync(`${gate}.generation`, "utf8");
assert.match(generation, /^[0-9a-f-]{36}$/);
assert.equal(statSync(`${gate}.generation`).mode & 0o777, 0o600);
await startOrigin();
try {
  await refused("GET", "/installation", key);
  writeFileSync(gate, "stale-generation", { mode: 0o600 });
  await refused("GET", "/installation", key);

  // Bootstrap reads precede key custody. Its only permitted write is a keyed
  // namespace POST on the exact raw path.
  writeFileSync(`${gate}.bootstrap`, generation, { mode: 0o600 });
  await forwarded("GET", "/installation");
  await forwarded("GET", "/namespaces/tenant_A-1");
  await refused("GET", "/namespaces/tenant_A-1?extra=true", key);
  await refused("GET", "/namespaces/%74enant_A-1", key);
  await refused("GET", "/namespaces/../installation", key);
  await refused("POST", "/namespaces");
  await refused("POST", "/namespaces?extra=true", key);
  const body = '{"name":"tenant_A-1"}';
  const bootstrap = await forwarded("POST", "/namespaces", {
    headers: { ...key, "content-type": "application/json" },
    body,
  });
  assert.equal(bootstrap["x-api-key"], key["x-api-key"]);

  // Retained custody permits keyed reads while ordinary traffic remains closed.
  writeFileSync(`${gate}.bootstrap`, "stale-generation");
  writeFileSync(`${gate}.retained`, "stale-generation", { mode: 0o600 });
  await refused("GET", "/installation", key);
  writeFileSync(`${gate}.retained`, generation);
  await refused("GET", "/installation");
  await forwarded("GET", "/installation", { headers: key });
  await forwarded("GET", "/namespaces/tenant_A-1", { headers: key });
  await refused("POST", "/namespaces", key);

  writeFileSync(gate, generation);
  const headers = await forwarded("GET", "/opaque/%2F?query=%2f", {
    headers: {
      forwarded: "for=client",
      "x-real-ip": "192.0.2.1",
      "x-forwarded-for": "192.0.2.2",
      "x-forwarded-proto": "http",
      "x-observation": "preserved",
    },
  });
  for (const name of ["forwarded", "x-real-ip", "x-forwarded-for", "x-forwarded-proto"]) {
    assert.equal(headers[name], undefined, `origin received ${name}`);
  }
  assert.equal(headers["x-observation"], "preserved");
  await forwarded("GET", "//other.invalid/installation", { originPath: "/" });
  const upgrade = await forwarded("GET", "/upgrade", {
    headers: { connection: "Upgrade", upgrade: "websocket" },
  });
  assert.equal(upgrade.upgrade, "websocket");

  const before = received.length;
  assert.equal(await connectResponse(), "");
  assert.equal(received.length, before, "A CONNECT request must never create an upstream tunnel");

  // Stop the actual target listener. A later connection to the same port
  // must succeed without reopening the gate or restarting the proxy.
  await stopOrigin();
  const failed = await send("GET", "/installation");
  assert.equal(failed.status, 502);
  assert.equal(failed.body, "Bad Gateway\n");
  assert.equal(received.length, before);
  await startOrigin();
  await forwarded("GET", "/installation");
} finally {
  if (origin.listening) {
    await stopOrigin();
  }
}
