import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createProxyServer } from "node:http";
import { createServer as createHttpsServer, request } from "node:https";
import { connect } from "node:net";
import { buffer } from "node:stream/consumers";
import { join } from "node:path";
import { selfSigned } from "./certificates.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

/** The controlled sender terminates TLS for api.github.com but only forwards to its one loopback
 * provider. Every request uses the production authorizer. The caller supplies the Gateway grant. */
export async function stockGhPullPreview(t, { executable, authorize, provider }) {
  const root = await temporaryDirectory(t, "stock-gh-pull-preview-");
  const tls = await selfSigned(root, {
    commonName: "api.github.com",
    subjectAltName: "DNS:api.github.com",
  });
  const requests = [];
  const failures = [];
  const providerUrl = new URL(provider.origin);
  assert.equal(providerUrl.protocol, "https:");
  assert.equal(providerUrl.hostname, "127.0.0.1");

  const api = createHttpsServer(tls, (incoming, outgoing) => {
    void (async () => {
      assert.equal(incoming.url, "/graphql");
      assert.equal(incoming.method, "POST");
      assert.match(incoming.headers.authorization, /^(token|bearer) synthetic-placeholder$/i);
      const body = await buffer(incoming);
      assert.ok(body.byteLength < 65536);
      const headers = Object.entries(incoming.headers)
        .filter(
          ([name]) => !["host", "content-length", "connection", "authorization"].includes(name),
        )
        .map(([name, value]) => ({ name, value }));
      const result = await authorize(body, headers);
      requests.push({ body: JSON.parse(body), decision: result.decision });
      if (!result.value) {
        outgoing.writeHead(403).end();
        return;
      }
      await new Promise((resolve, reject) => {
        const upstream = request(
          providerUrl,
          {
            ca: provider.tls.ca,
            path: "/graphql",
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + result.value,
              "content-length": body.length,
            },
          },
          (response) => {
            outgoing.writeHead(response.statusCode, response.headers);
            response.pipe(outgoing);
            response.once("error", reject);
            response.once("end", resolve);
          },
        );
        upstream.once("error", reject);
        upstream.end(body);
      });
    })().catch((error) => {
      failures.push(error);
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
      }
      outgoing.end();
    });
  });
  const proxy = createProxyServer();
  const sockets = new Set();
  proxy.on("connect", (incoming, socket, head) => {
    if (incoming.url !== "api.github.com:443") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const peer = connect(api.address().port, "127.0.0.1");
    for (const stream of [socket, peer]) {
      sockets.add(stream);
      stream.once("close", () => sockets.delete(stream));
    }
    peer.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) {
        peer.write(head);
      }
      socket.pipe(peer).pipe(socket);
    });
    peer.once("error", () => socket.destroy());
    socket.once("error", () => peer.destroy());
  });
  api.listen(0, "127.0.0.1");
  proxy.listen(0, "127.0.0.1");
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(
      [api, proxy].map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });
  await Promise.all([once(api, "listening"), once(proxy, "listening")]);
  const proxyUrl = "http://127.0.0.1:" + proxy.address().port;
  const env = cleanEnvironment({
    HOME: root,
    GH_CONFIG_DIR: join(root, "gh-config"),
    GH_TOKEN: "synthetic-placeholder",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    SSL_CERT_FILE: tls.certPath,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "",
    TZ: "Etc/UTC",
  });
  const version = await run(executable, ["--version"], { cwd: root, env });
  assert.match(version.stdout, /^gh version 2[.]103[.]2 /);
  return {
    requests,
    async invoke(args, allowFailure = false) {
      const result = await run(executable, args, { cwd: root, env, allowFailure: true });
      assert.deepEqual(failures, []);
      if (!allowFailure) {
        assert.equal(result.code, 0, result.stderr);
      }
      return result;
    },
  };
}
