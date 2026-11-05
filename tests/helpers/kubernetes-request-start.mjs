import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { constants as http2Constants, createSecureServer } from "node:http2";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import {
  createKubernetesClientConfiguration,
  withKubernetesRequestGuard,
} from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { selfSigned } from "./certificates.mjs";
import { listen } from "./listen.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";

// Minimal SOCKS5 CONNECT peer: the real SDK owns negotiation and TLS; this
// fixture only forwards bytes to its one permitted loopback API server.
async function socksTunnel(t, targetPort) {
  const connections = new Set();
  const failures = [];
  const server = createTcpServer((socket) => {
    const read = async (length) => {
      while (true) {
        const bytes = socket.read(length);
        if (bytes !== null) {
          return bytes;
        }
        await once(socket, "readable");
      }
    };
    void (async () => {
      const greeting = await read(2);
      assert.equal(greeting[0], 5);
      assert.ok((await read(greeting[1])).includes(0));
      socket.write(Buffer.from([5, 0]));
      const request = await read(4);
      assert.deepEqual([...request], [5, 1, 0, 1]);
      assert.deepEqual([...(await read(4))], [127, 0, 0, 1]);
      assert.equal((await read(2)).readUInt16BE(), targetPort);
      const upstream = connectTcp(targetPort, "127.0.0.1");
      connections.add(upstream);
      upstream.once("close", () => connections.delete(upstream));
      await once(upstream, "connect");
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      socket.pipe(upstream).pipe(socket);
    })().catch((error) => {
      failures.push(error);
      socket.destroy();
    });
  });
  const port = await listen(t, server);
  t.after(() => {
    for (const socket of connections) {
      socket.destroy();
    }
    assert.deepEqual(failures, []);
  });
  return `socks5://127.0.0.1:${port}`;
}

export async function verifyKubernetesRequestStart(t, transport) {
  const directory = await temporaryDirectory(t, "occ-kubernetes-h2-selection-");
  const certificate = await selfSigned(directory, {
    name: "api-server",
    commonName: "api-server",
    subjectAltName: "IP:127.0.0.1",
  });
  const originalRoots = getCACertificates("default");
  setDefaultCACertificates([...originalRoots, certificate.cert]);
  t.after(() => setDefaultCACertificates(originalRoots));
  let current = true;
  let changeSelection = false;
  let refuseNext = false;
  let reads = 0;
  const protocols = [];
  const listener = createSecureServer({
    key: certificate.key,
    cert: certificate.cert,
    allowHTTP1: true,
  });
  listener.on("secureConnection", (socket) => protocols.push(socket.alpnProtocol));
  listener.on("request", (request, response) => {
    reads += 1;
    if (refuseNext) {
      refuseNext = false;
      if (changeSelection) {
        current = false;
      }
      if (request.httpVersionMajor === 2) {
        // This stream replay happens below dispatcher composition.
        request.stream.on("error", () => {});
        request.stream.close(http2Constants.NGHTTP2_REFUSED_STREAM);
      } else {
        response.writeHead(421).end();
      }
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ apiVersion: "v1", kind: "Secret", metadata: { name: "material" } }),
    );
  });
  const port = await listen(t, listener);
  const proxy = transport === "SOCKS" ? await socksTunnel(t, port) : undefined;
  const path = join(directory, "kubeconfig.json");
  await writeFile(
    path,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "target",
          cluster: {
            server: `https://127.0.0.1:${port}`,
            ...(proxy ? { "proxy-url": proxy } : {}),
          },
        },
      ],
      users: [{ name: "controller", user: { token: "fixture-token" } }],
      contexts: [{ name: "target", context: { cluster: "target", user: "controller" } }],
      "current-context": "target",
    }),
  );
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    { mode: "kubeconfig", kubeconfigPath: path, context: "target" },
    (message) => new Error(message),
  );
  const core = new sdk.CoreV1Api(clientConfiguration);
  const read = () =>
    withKubernetesRequestGuard(
      () => {
        if (!current) {
          throw new Error("Credential reader changed");
        }
      },
      () => core.readNamespacedSecret({ namespace: "tenant", name: "material" }),
    );
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await read();
  }
  // An unchanged reader can complete the same transport's refusal retry.
  const controlReads = reads;
  refuseNext = true;
  await read();
  assert.equal(reads, controlReads + 2);
  const before = reads;
  refuseNext = true;
  changeSelection = true;
  const returnedMaterial = await read().then(
    () => true,
    () => false,
  );
  assert.equal(reads, before + 1, "a stale selection must not replay a refused stream");
  assert.equal(returnedMaterial, false);
  if (transport === "system-trust") {
    assert.deepEqual(protocols, ["h2"], "system-trust reads must exercise real HTTP/2 replay");
  } else {
    // The SDK's SOCKS connector currently omits ALPN and uses HTTP/1.1.
    assert.ok(protocols.length <= 2, "SOCKS reads must reuse their connections");
    assert.ok(protocols.every((protocol) => protocol === false));
  }
}
