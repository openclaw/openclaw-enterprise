import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { getCACertificates } from "node:tls";
import { asRecord } from "../../packages/utils/src/objects.ts";

const entered = "channel-probe: entered\n";
const inputReceived = "channel-probe: input received\n";
const requestStarted = "channel-probe: request started\n";
const resultWritten = "\nchannel-probe: result written\n";

const probe = String.raw`
process.stdout.write(${JSON.stringify(entered)});
const http = require('node:http');
const tls = require('node:tls');
const [proxy, target, port, servername, caSize, size, method] = process.argv.slice(1);
const expected = Number(size);
let bytes = 0;
const chunks = [];
const finish = (result) => {
  process.stdout.write(JSON.stringify(result) + ${JSON.stringify(resultWritten)}, () => process.exit(0));
};
const timer = setTimeout(() => finish({ error: 'PROBE_TIMEOUT' }), 12000);
process.stdin.on('data', (chunk) => {
  bytes += chunk.length;
  chunks.push(chunk);
  if (bytes !== expected) return;
  process.stdin.pause();
  process.stdout.write(${JSON.stringify(inputReceived)});
  const input = Buffer.concat(chunks);
  const ca = input.subarray(0, Number(caSize)).toString('utf8');
  const headerJson = input.subarray(Number(caSize)).toString('utf8');
  const endpoint = new URL(proxy);
  const authority = target + ':' + port;
  const request = http.request({ host: endpoint.hostname, port: endpoint.port, method,
    path: method === 'CONNECT' ? authority : 'https://' + authority + '/',
    headers: { ...JSON.parse(headerJson), host: authority } });
  request.on('response', (response) => { response.destroy(); finish({ status: response.statusCode, tlsVerified: false }); });
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
  process.stdout.write(${JSON.stringify(requestStarted)});
});
`;

/** Execute a real CONNECT and verified TLS handshake from the selected Gateway. */
export async function probeChannelConnect(
  namespace: string,
  pod: string,
  proxy: string,
  target: string,
  options: {
    serverName?: string;
    port?: number;
    method?: "CONNECT" | "GET";
    headers?: Readonly<Record<string, string>>;
  } = {},
) {
  assert.ok(process.env.OCC_TEST_KUBERNETES_KUBECONFIG && process.env.OCC_TEST_KUBERNETES_CONTEXT);
  // Public host trust roots belong only to this observation process. Production
  // workload trust and certificate verification are unchanged.
  const ca = Buffer.from(
    [...new Set([...getCACertificates("default"), ...getCACertificates("system")])].join("\n"),
  );
  assert.ok(ca.length > 0 && ca.length < 1_000_000);
  // Keep credential-bearing headers on stdin with the CA, outside the exec arguments.
  const input = Buffer.concat([ca, Buffer.from(JSON.stringify(options.headers ?? {}))]);
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
      String(input.length),
      options.method ?? "CONNECT",
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
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const [code, signal]: unknown[] = await once(child, "close").catch(() => {
      throw new Error(`Gateway CONNECT probe in ${pod} encountered a kubectl process error.`);
    });
    let output = Buffer.concat(chunks).toString("utf8");
    let progress: string | undefined;
    for (const [marker, label] of [
      [entered, "probe started"],
      [inputReceived, "input read"],
      [requestStarted, "request submitted locally"],
    ] as const) {
      if (!output.startsWith(marker)) {
        break;
      }
      progress = label;
      output = output.slice(marker.length);
    }
    const resultObserved =
      progress !== undefined &&
      output.length > resultWritten.length &&
      output.endsWith(resultWritten);
    // Throw at the awaited call site so the stack identifies which real request failed.
    // Report only fixed observations. Exec stderr and result bytes may contain credentials.
    const observations = `${progress ?? "no entry marker"}, ${resultObserved ? "result marker received" : "no result marker"}`;
    assert.equal(
      code,
      0,
      `Gateway CONNECT probe in ${pod} failed (${signal ?? `exit ${code}`}). Probe output showed ${observations}.`,
    );
    const invalidResult = `Gateway CONNECT probe in ${pod} returned an invalid result (${observations}).`;
    assert.ok(bytes <= 4_096 && resultObserved, invalidResult);
    let result;
    try {
      result = asRecord(JSON.parse(output.slice(0, -resultWritten.length)));
    } catch {
      throw new Error(invalidResult);
    }
    assert.ok(result, invalidResult);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
