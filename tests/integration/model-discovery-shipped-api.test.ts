import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import { AgentModelListResponse } from "../../packages/contracts/src/index.ts";
import type { CatalogReady } from "../fixtures/model-discovery-catalog-proxy.ts";
import type { ControllerReady } from "../fixtures/model-discovery-controller-process.ts";

const root = new URL("../..", import.meta.url);
const proxyScript = new URL("../fixtures/model-discovery-catalog-proxy.ts", import.meta.url);
const controllerScript = new URL(
  "../fixtures/model-discovery-controller-process.ts",
  import.meta.url,
);

type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;
interface ModelsResponse {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

function spawnNode(t: TestContext, script: URL, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [script.pathname, ...args], {
    cwd: root.pathname,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(
    async () => {
      child.kill();
      await closed;
    },
    { timeout: 5000 },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    stderr += `${error.message}\n`;
  });
  return { child, stderr: () => stderr };
}

function isCatalogReady(value: unknown): value is CatalogReady {
  return (
    value !== null &&
    typeof value === "object" &&
    "event" in value &&
    value.event === "catalog.ready" &&
    "port" in value &&
    typeof value.port === "number"
  );
}

function isControllerReady(value: unknown): value is ControllerReady {
  return (
    value !== null &&
    typeof value === "object" &&
    "event" in value &&
    value.event === "controller.ready" &&
    "port" in value &&
    typeof value.port === "number" &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "fetch" in value &&
    value.fetch === "node-undici" &&
    "namespaceId" in value &&
    typeof value.namespaceId === "string" &&
    "cookie" in value &&
    typeof value.cookie === "string"
  );
}

function readyLine<Ready extends CatalogReady | ControllerReady>(
  child: FixtureProcess,
  event: Ready["event"],
  isReady: (value: unknown) => value is Ready,
) {
  const lines = createInterface({ input: child.stdout });
  return new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => {
      lines.close();
    }, 30_000);
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (
        message === null ||
        typeof message !== "object" ||
        !("event" in message) ||
        message.event !== event
      ) {
        return;
      }
      if (isReady(message)) {
        resolve(message);
      } else {
        reject(new Error(`Invalid ${event} message`));
      }
      lines.close();
    });
    lines.once("close", () => {
      clearTimeout(timer);
      reject(new Error(`${event} did not become ready`));
      child.stdout.resume();
    });
  });
}

test("shipped models API lists visible Codex models from a separate catalog process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-model-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const serverKey = join(directory, "server.key");
  const serverCsr = join(directory, "server.csr");
  const serverCert = join(directory, "server.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=oce-local-catalog-ca",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-keyout",
      serverKey,
      "-out",
      serverCsr,
      "-nodes",
      "-subj",
      "/CN=catalog",
      "-addext",
      "subjectAltName=DNS:auth.openai.com,DNS:chatgpt.com",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      serverCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      serverCert,
      "-days",
      "1",
      "-copy_extensions",
      "copy",
    ],
    { stdio: "ignore" },
  );

  const proxy = spawnNode(t, proxyScript, [serverKey, serverCert], process.env);
  const catalog = await readyLine(proxy.child, "catalog.ready", isCatalogReady);

  const catalogProxy = `http://127.0.0.1:${catalog.port}`;
  const noProxy = "localhost,127.0.0.1,[::1]";
  const controller = spawnNode(t, controllerScript, [], {
    ...process.env,
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: catalogProxy,
    https_proxy: catalogProxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_EXTRA_CA_CERTS: caCert,
  });
  const ready = await readyLine(controller.child, "controller.ready", isControllerReady);
  assert.equal(ready.fetch, "node-undici");
  assert.equal(ready.pid, controller.child.pid);
  assert.notEqual(ready.pid, process.pid);

  // IPv4 loopback. Node's fetch can present ::ffff:127.0.0.1, which development
  // admission does not treat as a direct loopback request.
  const response = await new Promise<ModelsResponse>((resolve, reject) => {
    const payload = JSON.stringify({
      provider: "openai",
      authMethod: "codex_pat",
      apiKey: "at-fixture-token",
    });
    const request = http.request(
      {
        host: "127.0.0.1",
        port: ready.port,
        family: 4,
        path: `/namespaces/${ready.namespaceId}/agents/models`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          host: "console.oce.localhost",
          origin: "https://console.oce.localhost",
          cookie: ready.cookie,
        },
      },
      (result) => {
        const chunks: Buffer[] = [];
        result.on("data", (chunk: Buffer) => chunks.push(chunk));
        result.on("error", reject);
        result.on("end", () => {
          resolve({
            status: result.statusCode,
            headers: result.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
  assert.equal(response.status, 200, response.body);
  const body: unknown = JSON.parse(response.body);
  assert.ok(Check(AgentModelListResponse, body), "Controller must return a model-list response");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(body.data, [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
  ]);
  assert.equal(JSON.stringify(body).includes("at-fixture-token"), false);

  const catalogLog = proxy.stderr();
  assert.match(
    catalogLog,
    /"host":"auth.openai.com","path":"\/api\/accounts\/v1\/user-auth-credential\/whoami"/,
  );
  assert.match(catalogLog, /"host":"chatgpt.com","path":"\/backend-api\/codex\/models"/);
  assert.equal(catalogLog.includes("at-fixture-token"), false);

  const transcript = {
    revision: process.env.OCC_PROOF_REVISION ?? "uncommitted",
    node: process.version,
    controllerPid: ready.pid,
    catalogPid: proxy.child.pid,
    fetch: ready.fetch,
    catalog: {
      whoami: { chatgpt_account_id: "verified-account", chatgpt_account_is_fedramp: false },
      models: [
        { slug: "gpt-5.5", visibility: "list", priority: null },
        { slug: "codex-auto-review", visibility: "hide", priority: null },
        { slug: "gpt-5.4", visibility: "list", priority: null },
      ],
    },
    response: {
      status: response.status,
      cacheControl: response.headers["cache-control"],
      data: body.data,
    },
    catalogRequests: catalogLog
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("{")),
  };
  t.diagnostic(JSON.stringify(transcript));
  console.log(JSON.stringify(transcript));
});
