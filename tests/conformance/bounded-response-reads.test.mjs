import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { RepositoryReceiptClient } from "../../apps/controller/src/drivers/repo/credentials/receipt-client.ts";
import { callControl } from "../../apps/controller/src/drivers/repo/github/credentials/client/operator.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

// Each upstream here sends more than its reader's limit and then holds the response
// open. A reader that buffers to the end, or stops reading without settling, shows up
// as a call that is still pending (or only times out) after the deadline below.
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { fetch: undiciFetch } = controllerRequire("undici");
const sdk = controllerRequire("@kubernetes/client-node");

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "occ-bounded-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Sends `bytes` of body after a 200 and never ends the response. */
async function holdingServer(t, listenOn, bytes, contentType) {
  const server = createServer((request, response) => {
    request.resume();
    response.on("error", () => {});
    response.writeHead(200, { "content-type": contentType });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent < bytes && !response.destroyed) {
        sent += chunk.length;
        if (!response.write(chunk)) {
          response.once("drain", pump);
          return;
        }
      }
    };
    pump();
  });
  await new Promise((resolve) =>
    typeof listenOn === "number"
      ? server.listen(listenOn, "127.0.0.1", resolve)
      : server.listen(listenOn, resolve),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return server;
}

/** Settles within `ms`, or reports that it is still pending. */
function settled(promise, ms) {
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    delay(ms, undefined, { ref: false }).then(() => ({ pending: true })),
  ]);
}

test("an oversized receipt reply rejects instead of hanging (finding 1328)", async (t) => {
  const dir = await scratch(t);
  await holdingServer(t, join(dir, "receipt.sock"), 32 * 1024, "application/json");
  const client = new RepositoryReceiptClient(join(dir, "control.sock"), "generation-1");
  const outcome = await settled(client.status("session-1"), 3_000);
  assert.equal(outcome.pending, undefined, "the receipt call settles");
  assert.equal(outcome.error?.message, "RECEIPT_UNAVAILABLE");
});

test("an oversized control reply rejects instead of hanging (finding 1328)", async (t) => {
  const dir = await scratch(t);
  const socket = join(dir, "control.sock");
  await holdingServer(t, socket, 32 * 1024, "application/json");
  const outcome = await settled(
    callControl(socket, { method: "GET", path: "/v1/sessions/abc" }),
    3_000,
  );
  assert.equal(outcome.pending, undefined, "the control call settles");
  assert.match(outcome.error?.message ?? "", /^control-request-failed admission=/);
});

test("SSH executor drops output past its limit while the child ignores SIGTERM (finding 1330)", async (t) => {
  const dir = await scratch(t);
  // The stand-in floods stdout and ignores SIGTERM, so it runs until the executor's
  // SIGKILL a second later. getBuiltinModule-free: it may load as ESM under this repo.
  const ssh = join(dir, "ssh");
  await writeFile(
    ssh,
    `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nprocess.stdin.resume();\nconst chunk = "x".repeat(1024 * 1024);\nconst pump = () => { while (process.stdout.write(chunk)) {} process.stdout.once("drain", pump); };\npump();\n`,
  );
  await chmod(ssh, 0o755);
  const executor = new URL(
    "../../apps/controller/src/drivers/compute/ssh/executor.ts",
    import.meta.url,
  );
  // A 64 MiB heap: a second of unbounded appending exhausts it and crashes the process.
  const program = `
const { SystemSshCommandExecutor } = await import(${JSON.stringify(executor.href)});
const outcome = await new SystemSshCommandExecutor()
  .execute({
    address: "127.0.0.1", port: 22, user: "fixture", nodePath: "node",
    identityFile: "/dev/null", knownHostsFile: "/dev/null", connectTimeoutSeconds: 1,
    helper: "", operation: "{}", timeoutMs: 10000,
  })
  .then(() => "resolved", (error) => error.message);
process.stdout.write(outcome);
`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "-e", program],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 20_000 },
  );
  assert.equal(stdout, "SSH helper output exceeded its limit.");
});

test("Slack stops reading a response past its size limit (finding 1329)", async (t) => {
  // Over the 8,000,000-byte read limit; well under the request's eight-second timeout.
  const server = await holdingServer(t, 0, 16 * 1024 * 1024, "application/json");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const driver = new SlackChannelDriver((url, options) =>
    undiciFetch(new URL(new URL(url).pathname, origin), options),
  );
  const started = performance.now();
  const outcome = await settled(
    driver.lookupDirectory({ token: "xoxb-fixture", kind: "users" }),
    5_000,
  );
  assert.equal(outcome.pending, undefined, "the lookup settles");
  assert.equal(outcome.error?.reason, "invalid_response");
  assert.ok(performance.now() - started < 4_000, "rejected at the limit, not the timeout");
});

function statusReadback(port) {
  const driver = new KubernetesComputeDriver(
    conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["10.42.0.0/16"] }),
  );
  const kubeConfig = new sdk.KubeConfig();
  kubeConfig.loadFromOptions({
    // Plain HTTP needs skipTLSVerify in client-node; production requires verified HTTPS.
    clusters: [{ name: "loopback", server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
    users: [{ name: "fixture", token: "fixture" }],
    contexts: [{ name: "loopback", cluster: "loopback", user: "fixture" }],
    currentContext: "loopback",
  });
  // The production client's cancellation middleware (drivers/kubernetes/client.ts).
  const cancellation = {
    pre(request) {
      const signal = currentComputeAbortSignal();
      if (signal !== undefined) {
        request.setSignal(signal);
      }
      return new sdk.Observable(Promise.resolve(request));
    },
    post(response) {
      return new sdk.Observable(Promise.resolve(response));
    },
  };
  const core = new sdk.CoreV1Api(
    sdk.createConfiguration({
      baseServer: new sdk.ServerConfiguration(`http://127.0.0.1:${port}`, {}),
      authMethods: { default: kubeConfig },
      middleware: [cancellation],
    }),
  );
  driver.apiClients = Promise.resolve({ core });
  driver.revisionPods = async () => [
    {
      metadata: { name: "agent-pod", uid: "agent-uid" },
      status: { phase: "Running", podIP: "10.42.0.7" },
    },
  ];
  return driver.privateStatusReadback(
    { harness: { mode: "shared" } },
    { name: "tenant", plane: "control" },
    "agent",
    "/openclaw/runtime/status",
  );
}

test("runtime status readback stops reading past its size limit (finding 1327)", async (t) => {
  const server = await holdingServer(t, 0, 1024 * 1024, "text/plain");
  const started = performance.now();
  const outcome = await settled(statusReadback(server.address().port), 8_000);
  assert.equal(outcome.pending, undefined, "the readback settles");
  assert.equal(outcome.error?.message, "Runtime status returned oversized data.");
  assert.ok(performance.now() - started < 5_000, "rejected at the limit, not the deadline");
});

test("runtime status readback still parses an in-limit status", async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ revisionId: "revision-1", container: "agent" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.deepEqual(await statusReadback(server.address().port), {
    status: { revisionId: "revision-1", container: "agent" },
    podUid: "agent-uid",
    containerId: undefined,
  });
});
