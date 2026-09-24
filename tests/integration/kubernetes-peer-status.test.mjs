import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const execute = promisify(execFile);

test("real peer-status HTTPS transport authenticates its revision and verifies server trust", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-peer-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificate = join(directory, "certificate.pem");
  const privateKey = join(directory, "key.pem");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    privateKey,
    "-out",
    certificate,
  ]);

  const reservation = netServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const environment = {
    PATH: process.env.PATH,
    OPENCLAW_PLUGIN_STATUS_PORT: String(port),
    OPENCLAW_PLUGIN_STATUS_CONTAINER: "agent",
    OPENCLAW_AGENT_REVISION_ID: "revision-one",
    OPENCLAW_POD_UID: "pod-one",
    OPENCLAW_REMOTE_PLUGIN_STATUS: "true",
    APP_SERVER_TOKEN: "test-only-transport-secret",
  };
  const serverFile = join(directory, "server.cjs");
  await writeFile(
    serverFile,
    `${PLUGIN_RUNTIME_HELPERS}\nstartPluginRuntimeStatusServer();\npublishPluginRuntimeStatus({phase:"ready",successfulPluginIds:["plugin-one"],failures:[]});\nprocess.send("ready");`,
  );
  const child = fork(serverFile, { env: environment, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => child.kill("SIGTERM"));
  await once(child, "message");

  // TLS termination forwards the untouched Authorization header to the actual
  // generated Harness status server. No fixture implements its authentication.
  const proxy = httpsServer(
    { key: await readFile(privateKey), cert: await readFile(certificate) },
    (incoming, outgoing) => {
      if (incoming.url === "/redirect") {
        outgoing.writeHead(302, { location: "/status" });
        outgoing.end();
        return;
      }
      const upstream = request(
        {
          host: "127.0.0.1",
          port,
          path: "/openclaw/plugin-runtime/remote-status",
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    },
  );
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const url = `https://127.0.0.1:${proxy.address().port}/status`;
  const clientFile = join(directory, "client.cjs");
  await writeFile(
    clientFile,
    `${PLUGIN_RUNTIME_HELPERS}\nreadPeerPluginRuntimeStatus().then(value=>console.log(JSON.stringify({ok:true,value}))).catch(error=>console.log(JSON.stringify({ok:false,message:error.message})));`,
  );
  async function read(overrides = {}) {
    const { stdout } = await execute(process.execPath, [clientFile], {
      env: {
        ...environment,
        NODE_EXTRA_CA_CERTS: certificate,
        OPENCLAW_PEER_PLUGIN_STATUS_URL: url,
        ...overrides,
      },
      timeout: 15_000,
    });
    return JSON.parse(stdout);
  }
  const valid = await read();
  assert.equal(valid.ok, true);
  assert.equal(valid.value.revisionId, "revision-one");
  assert.deepEqual(valid.value.successfulPluginIds, ["plugin-one"]);
  assert.equal((await read({ APP_SERVER_TOKEN: "another-agent-token" })).ok, false);
  assert.equal((await read({ OPENCLAW_AGENT_REVISION_ID: "revision-two" })).ok, false);
  assert.equal((await read({ NODE_EXTRA_CA_CERTS: "" })).ok, false);
  assert.equal(
    (await read({ OPENCLAW_PEER_PLUGIN_STATUS_URL: url.replace("/status", "/redirect") })).ok,
    false,
  );
  assert.equal(
    (await read({ OPENCLAW_PEER_PLUGIN_STATUS_URL: url.replace("https:", "http:") })).ok,
    false,
  );
  const missing = await fetch(`http://127.0.0.1:${port}/openclaw/plugin-runtime/remote-status`);
  assert.equal(missing.status, 401);
});
