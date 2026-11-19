import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getCACertificates } from "node:tls";
import { asRecord } from "../../packages/utils/src/objects.ts";

const probe = String.raw`
const http = require('node:http');
const tls = require('node:tls');
const [proxy, target, port, servername, size] = process.argv.slice(1);
const expected = Number(size);
let bytes = 0;
const chunks = [];
const finish = (result) => { process.stdout.write(JSON.stringify(result), () => process.exit(0)); };
const timer = setTimeout(() => finish({ error: 'PROBE_TIMEOUT' }), 12000);
process.stdin.on('data', (chunk) => {
  bytes += chunk.length;
  chunks.push(chunk);
  if (bytes !== expected) return;
  process.stdin.pause();
  const ca = Buffer.concat(chunks).toString('utf8');
  const endpoint = new URL(proxy);
  const request = http.request({ host: endpoint.hostname, port: endpoint.port, method: 'CONNECT', path: target + ':' + port, headers: { host: target + ':' + port } });
  request.on('connect', (response, socket, head) => {
    if (response.statusCode !== 200) { socket.destroy(); finish({ status: response.statusCode, tlsVerified: false }); return; }
    if (head.length) socket.unshift(head);
    const connection = tls.connect({ socket, servername, ca, rejectUnauthorized: true }, () => {
      clearTimeout(timer);
      const tlsVerified = connection.authorized;
      connection.destroy();
      finish({ status: response.statusCode, tlsVerified });
    });
    connection.on('error', (error) => finish({ status: response.statusCode, error: error.code || 'TLS_ERROR' }));
  });
  request.on('error', (error) => finish({ error: error.code || 'CONNECT_ERROR' }));
  request.end();
});
`;

/** Execute a real CONNECT and verified TLS handshake from the selected Gateway. */
export async function probeChannelConnect(
  namespace: string,
  pod: string,
  proxy: string,
  target: string,
  options: { serverName?: string; port?: number } = {},
) {
  assert.ok(process.env.OCC_TEST_KUBERNETES_KUBECONFIG && process.env.OCC_TEST_KUBERNETES_CONTEXT);
  // Public host trust roots belong only to this observation process. Production
  // workload trust and certificate verification are unchanged.
  const ca = Buffer.from(
    [...new Set([...getCACertificates("default"), ...getCACertificates("system")])].join("\n"),
  );
  assert.ok(ca.length > 0 && ca.length < 1_000_000);
  const child = spawn(
    process.env.OCC_KUBECTL_BIN ?? "kubectl",
    [
      "--kubeconfig",
      process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
      "--context",
      process.env.OCC_TEST_KUBERNETES_CONTEXT,
      "exec",
      "-i",
      pod,
      "--namespace",
      namespace,
      "--",
      "node",
      "-e",
      probe,
      proxy,
      target,
      String(options.port ?? 443),
      options.serverName ?? target,
      String(ca.length),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4_096) {
      child.kill("SIGKILL");
    } else {
      chunks.push(chunk);
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(ca);
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("The selected Gateway CONNECT probe failed.")),
      );
    });
    const result = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    assert.ok(result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
