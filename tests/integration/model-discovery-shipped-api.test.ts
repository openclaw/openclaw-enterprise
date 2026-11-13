import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import http, { type IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const root = new URL("../..", import.meta.url);
const proxyScript = new URL("../fixtures/model-discovery-catalog-proxy.mjs", import.meta.url);
const controllerScript = new URL(
  "../fixtures/model-discovery-controller-process.mjs",
  import.meta.url,
);

type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;
interface ReadyMessage {
  port: number;
  pid: number;
  fetch: string;
  namespaceId: string;
  cookie: string;
}
interface ModelsResponse {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: { data: { id: string; name: string }[] };
}

function spawnNode(script: URL, args: string[], env: NodeJS.ProcessEnv, label: string) {
  const child = spawn(process.execPath, [script.pathname, ...args], {
    cwd: root.pathname,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      stderr += `${label} exited ${code}\n`;
    }
  });
  return {
    child,
    output: () => ({ stdout, stderr }),
  };
}

function readyLine(child: FixtureProcess, event: string) {
  return new Promise<ReadyMessage>((resolve, reject) => {
    let buffer = "";
    let errors = "";
    const timer = setTimeout(() => {
      reject(new Error(`${event} did not become ready\n${buffer}\n${errors}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((entry) => entry.includes(`"event":"${event}"`));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${event} process exited ${code} before ready\n${buffer}\n${errors}`));
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

  const proxy = spawnNode(proxyScript, [serverKey, serverCert], process.env, "catalog");
  t.after(() => proxy.child.kill());
  const catalog = await readyLine(proxy.child, "catalog.ready");

  const catalogProxy = `http://127.0.0.1:${catalog.port}`;
  const noProxy = "localhost,127.0.0.1,[::1]";
  const controller = spawnNode(
    controllerScript,
    [],
    {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: catalogProxy,
      https_proxy: catalogProxy,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      NODE_EXTRA_CA_CERTS: caCert,
    },
    "controller",
  );
  t.after(() => controller.child.kill());
  const ready = await readyLine(controller.child, "controller.ready");
  assert.equal(ready.fetch, "node-undici");
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
        result.on("data", (chunk) => chunks.push(chunk));
        result.on("end", () => {
          resolve({
            status: result.statusCode,
            headers: result.headers,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
  const body = response.body;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(body.data, [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
  ]);
  assert.equal(JSON.stringify(body).includes("at-fixture-token"), false);

  const catalogLog = proxy.output().stderr;
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
