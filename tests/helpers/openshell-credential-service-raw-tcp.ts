import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import type { TestContext } from "node:test";

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return (
      first === 10 ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168)
    );
  }
  return isIP(address) === 6 && /^(?:fc|fd)[0-9a-f]{2}:/i.test(address);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const rawProbe = `
  const net = require("node:net");
  const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
  const refused = new Set(["EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]);
  let observed = false;
  socket.once("connect", () => { observed = true; socket.write("NATIVE RAW TCP PROBE\\r\\n"); });
  socket.once("error", (error) => { observed = refused.has(error.code); });
  socket.setTimeout(5000, () => { observed = true; socket.destroy(); });
  socket.once("end", () => { observed = true; socket.destroy(); });
  socket.once("close", () => { process.exitCode = observed ? 0 : 1; });
`;

/** Bracket a direct literal-IP socket with credential-free native HTTP controls to the same listener. */
export async function startNativeTcpProbe(
  t: Pick<TestContext, "after">,
  { host, address, port }: { host: string; address: string; port: number },
) {
  assert.ok(privateAddress(address), "Use an explicit private literal listener IP.");
  assert.ok(
    isIP(host) === 0 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        host,
      ),
    "Use the exact admitted DNS hostname for the listener.",
  );
  assert.ok(
    Number.isSafeInteger(port) && port > 0 && port <= 65535,
    "Use an explicit listener port.",
  );
  const nonce = `NATIVE-TCP-${randomUUID()}`;
  const path = `/native-tcp/${randomUUID()}`;
  let connections = 0;
  let controls = 0;
  let credentialHeaders = 0;
  const server = createServer((request, response) => {
    const sensitive = ["authorization", "proxy-authorization", "cookie"].some(
      (name) => request.headers[name] !== undefined,
    );
    if (sensitive) {
      credentialHeaders += 1;
    }
    if (request.method !== "GET" || request.url !== path || sensitive) {
      response.writeHead(400).end();
      return;
    }
    controls += 1;
    response
      .writeHead(200, { "content-length": Buffer.byteLength(nonce), connection: "close" })
      .end(nonce);
  });
  server.on("connection", () => {
    connections += 1;
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  return {
    async verify(runInHarness: (script: string) => Promise<void>): Promise<void> {
      const before = { connections, controls, credentialHeaders };
      const curl = `/usr/bin/curl -q --noproxy '*' --silent --show-error --fail --max-time 8 --http1.1 --header 'Connection: close' ${quote(`http://${host}:${port}${path}`)}`;
      await runInHarness(
        [
          `test "$(${curl})" = ${quote(nonce)}`,
          `node -e ${quote(rawProbe)} ${quote(address)} ${port}`,
          `test "$(${curl})" = ${quote(nonce)}`,
        ].join(" && "),
      );
      assert.equal(
        controls - before.controls,
        2,
        "Both approved Harness controls reached the listener.",
      );
      assert.equal(
        connections - before.connections,
        2,
        "The raw bypass opened no listener connection.",
      );
      assert.equal(
        credentialHeaders,
        before.credentialHeaders,
        "The listener received no credential headers.",
      );
    },
  };
}
