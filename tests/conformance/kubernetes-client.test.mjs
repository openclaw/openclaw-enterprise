import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createSecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";

function selfSignedCertificate(directory, name, subjectAltName) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  return { keyPath, certPath };
}

// A TLS API server that offers HTTP/2 first, like kube-apiserver, requires a
// client certificate, and records every connection it accepts.
async function apiServer(directory, clientCertificates) {
  const server = selfSignedCertificate(directory, "api-server", "IP:127.0.0.1");
  const connections = [];
  const open = new Set();
  const sockets = new Set();
  const listener = createSecureServer({
    key: readFileSync(server.keyPath),
    cert: readFileSync(server.certPath),
    ca: clientCertificates.map((path) => readFileSync(path)),
    requestCert: true,
    rejectUnauthorized: true,
    allowHTTP1: true,
  });
  listener.on("secureConnection", (socket) => {
    const connection = {
      protocol: socket.alpnProtocol,
      client: socket.getPeerCertificate().subject?.CN,
    };
    connections.push(connection);
    open.add(connection);
    socket.on("close", () => open.delete(connection));
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  listener.on("request", (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ kind: "NamespaceList", apiVersion: "v1", items: [] }));
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return {
    caPath: server.certPath,
    url: `https://127.0.0.1:${listener.address().port}`,
    connections,
    open,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

async function writeKubeconfig(directory, server, client) {
  const kubeconfigPath = join(directory, "kubeconfig");
  await writeFile(
    kubeconfigPath,
    [
      "apiVersion: v1",
      "kind: Config",
      `clusters: [{name: target, cluster: {server: "${server.url}", certificate-authority: "${server.caPath}"}}]`,
      `users: [{name: operator, user: {client-certificate: "${client.certPath}", client-key: "${client.keyPath}"}}]`,
      "contexts: [{name: target, context: {cluster: target, user: operator}}]",
      "current-context: target",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { mode: "kubeconfig", kubeconfigPath, context: "target" };
}

async function waitFor(condition, message) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Kubernetes API requests reuse keep-alive HTTP/1.1 connections and reconnect when the client certificate rotates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = selfSignedCertificate(directory, "operator-1", "DNS:operator");
  const second = selfSignedCertificate(directory, "operator-2", "DNS:operator");
  const server = await apiServer(directory, [first.certPath, second.certPath]);
  t.after(() => server.close());
  const active = {
    certPath: join(directory, "operator.crt"),
    keyPath: join(directory, "operator.key"),
  };
  await copyFile(first.certPath, active.certPath);
  await copyFile(first.keyPath, active.keyPath);
  const authentication = await writeKubeconfig(directory, server, active);
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    authentication,
    (message) => new Error(message),
  );
  const core = new sdk.CoreV1Api(clientConfiguration);

  // undici returns a socket to its pool just after the response resolves, so
  // back-to-back requests may alternate between two keep-alive connections.
  // Before the fix, every request opened its own HTTP/2 connection.
  for (let request = 0; request < 20; request += 1) {
    await core.listNamespace();
  }
  const firstConnections = server.connections.length;
  assert.ok(firstConnections <= 2, `20 requests opened ${firstConnections} connections`);
  for (const connection of server.connections) {
    assert.deepEqual(connection, { protocol: "http/1.1", client: "operator-1" });
  }

  // The kubeconfig names certificate files, which the client rereads on every
  // request: a rotated pair gets new connections and the old ones close.
  await copyFile(second.certPath, active.certPath);
  await copyFile(second.keyPath, active.keyPath);
  for (let request = 0; request < 20; request += 1) {
    await core.listNamespace();
  }
  const rotated = server.connections.slice(firstConnections);
  assert.ok(rotated.length >= 1 && rotated.length <= 2, `rotation opened ${rotated.length}`);
  for (const connection of rotated) {
    assert.deepEqual(connection, { protocol: "http/1.1", client: "operator-2" });
  }
  await waitFor(
    () => [...server.open].every((connection) => connection.client === "operator-2"),
    "the connections for the old certificate must close",
  );
});
