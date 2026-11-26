import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { reservePort, reservedPortArgs } from "../helpers/available-port.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { listen } from "../helpers/listen.ts";
import { stopProcess } from "../helpers/stop-process.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/wait-for.ts";

const execute = promisify(execFile);

type PeerStatusOverrides = Partial<
  Record<
    | "APP_SERVER_TOKEN"
    | "OPENCLAW_AGENT_REVISION_ID"
    | "NODE_EXTRA_CA_CERTS"
    | "OPENCLAW_PEER_PLUGIN_STATUS_URL",
    string
  >
>;

type PeerStatusResult =
  | { ok: true; value: { revisionId: string; successfulPluginIds: readonly string[] } }
  | { ok: false; message: string };

function decodePeerStatusResult(stdout: string): PeerStatusResult {
  const result: unknown = JSON.parse(stdout);
  assert.ok(
    typeof result === "object" && result !== null && "ok" in result,
    "invalid client result",
  );
  if (result.ok === false) {
    assert.ok("message" in result && typeof result.message === "string", "invalid client error");
    return { ok: false, message: result.message };
  }
  assert.equal(result.ok, true, "invalid client result tag");
  assert.ok("value" in result && typeof result.value === "object" && result.value !== null);
  const { value } = result;
  assert.ok("revisionId" in value && typeof value.revisionId === "string");
  assert.ok("successfulPluginIds" in value && Array.isArray(value.successfulPluginIds));
  const successfulPluginIds: readonly unknown[] = value.successfulPluginIds;
  assert.ok(successfulPluginIds.every((pluginId) => typeof pluginId === "string"));
  return { ok: true, value: { revisionId: value.revisionId, successfulPluginIds } };
}

test("real peer-status HTTPS transport authenticates its revision and verifies server trust", async (t) => {
  const directory = await temporaryDirectory(t, "oce-peer-status-");
  const { keyPath: privateKey, certPath: certificate } = await selfSigned(directory);

  // The generated status server binds this port on all interfaces. Hold it there until the
  // server answers on it, so no other socket takes it first.
  const reservation = await reservePort({ host: "0.0.0.0" });
  t.after(reservation.release);
  const { port } = reservation;
  const statusPath = "/openclaw/plugin-runtime/remote-status";
  const statusUrl = `http://127.0.0.1:${port}${statusPath}`;
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
  const child = fork(serverFile, {
    env: environment,
    execArgv: [...process.execArgv, ...reservedPortArgs(reservation)],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => stopProcess(child));
  const [message]: readonly unknown[] = await once(child, "message");
  assert.equal(message, "ready");
  // "ready" follows listen() before the bind completes. A 401 can only come from the status
  // server (the reservation resets connections), so it is bound and the hold can end.
  await waitFor(
    "the status server to answer on its port",
    () =>
      fetch(statusUrl).then(
        async (response) => {
          await response.body?.cancel();
          return response.status === 401 || undefined;
        },
        () => undefined,
      ),
    10_000,
  );
  await reservation.release();

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
          path: statusPath,
          headers: incoming.headers,
        },
        (response) => {
          assert.ok(response.statusCode !== undefined, "peer status response has no HTTP status");
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
  const url = `https://127.0.0.1:${await listen(t, proxy)}/status`;
  const clientFile = join(directory, "client.cjs");
  await writeFile(
    clientFile,
    `${PLUGIN_RUNTIME_HELPERS}\nreadPeerPluginRuntimeStatus().then(value=>console.log(JSON.stringify({ok:true,value}))).catch(error=>console.log(JSON.stringify({ok:false,message:error.message})));`,
  );
  async function read(overrides: PeerStatusOverrides = {}): Promise<PeerStatusResult> {
    const { stdout } = await execute(process.execPath, [clientFile], {
      env: {
        ...environment,
        NODE_EXTRA_CA_CERTS: certificate,
        OPENCLAW_PEER_PLUGIN_STATUS_URL: url,
        ...overrides,
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    return decodePeerStatusResult(stdout);
  }
  const valid = await read();
  if (!valid.ok) {
    assert.fail(valid.message);
  }
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
  const missing = await fetch(statusUrl);
  await missing.body?.cancel();
  assert.equal(missing.status, 401);
});
