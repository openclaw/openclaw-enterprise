import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { issueServingCertificate } from "./keycloak-real.mjs";

// Executed in the disposable receiver Pod. The proxy admits only a TLS tunnel to this provider.
// The provider itself accepts both tool names, so a missing denied call is decided upstream.
function serve() {
  const { createHash } = require("node:crypto");
  const fs = require("node:fs");
  const http = require("node:http");
  const https = require("node:https");
  const net = require("node:net");
  const receipts = [];
  http.createServer((_, res) => res.end(JSON.stringify(receipts))).listen(8081, "127.0.0.1");
  const provider = https.createServer(
    {
      key: fs.readFileSync("/tls/tls.key"),
      cert: fs.readFileSync("/tls/tls.crt"),
    },
    async (request, response) => {
      if (request.method !== "POST" || request.url !== "/mcp") {
        response.writeHead(405).end();
        return;
      }
      const authorized =
        createHash("sha256")
          .update(request.headers.authorization ?? "")
          .digest("hex") === process.env.BEARER_DIGEST;
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.method === "tools/call") {
        receipts.push({ id: rpc.id, name: rpc.params.name, authenticated: authorized });
      }
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (rpc.method === "initialize") {
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "probe", version: "1" },
        };
      } else if (rpc.method === "tools/list") {
        result = {
          tools: ["get_allowed", "get_denied"].map((name) => ({
            name,
            description: "Read a test marker",
            inputSchema: { type: "object", properties: {} },
          })),
        };
      } else if (rpc.method === "tools/call") {
        result = { content: [{ type: "text", text: process.env.MARKER }] };
      } else {
        result = {};
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    },
  );
  provider.listen(8443, "127.0.0.1");
  const proxy = http.createServer((_, res) => res.writeHead(405).end());
  proxy.on("connect", (request, downstream, head) => {
    if (request.url !== process.env.PROVIDER_HOST + ":443") {
      downstream.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(8443, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(downstream).pipe(upstream);
    });
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
    downstream.on("close", () => upstream.destroy());
  });
  proxy.listen(8080, "0.0.0.0");
}

export async function startImportedMcpEndpoint(context, kubectl, image) {
  const suffix = randomUUID().slice(0, 8);
  const namespace = "oce-import-mcp-" + suffix;
  // OpenShell checks public DNS before its corporate CONNECT. The IANA example host
  // resolves publicly, while this release's proxy connects only to the in-Pod receiver.
  const host = "example.com";
  const marker = "PROVIDER_RESULT_" + randomUUID();
  const token = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "oce-import-mcp-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { caPem } = await issueServingCertificate(directory, host);
  await kubectl("create", "namespace", namespace);
  context.after(() =>
    kubectl("delete", "namespace", namespace, "--ignore-not-found=true", "--wait=false"),
  );
  await kubectl(
    "create",
    "secret",
    "tls",
    "provider",
    "-n",
    namespace,
    "--cert=" + join(directory, "tls.crt"),
    "--key=" + join(directory, "tls.key"),
  );
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "mcp", namespace, labels: { app: "mcp" } },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      containers: [
        {
          name: "mcp",
          image,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "-e", `(${serve.toString()})();`],
          env: [
            { name: "PROVIDER_HOST", value: host },
            { name: "MARKER", value: marker },
            {
              name: "BEARER_DIGEST",
              value: createHash("sha256")
                .update("Bearer " + token)
                .digest("hex"),
            },
          ],
          volumeMounts: [{ name: "tls", mountPath: "/tls", readOnly: true }],
          readinessProbe: { tcpSocket: { port: 8080 } },
        },
      ],
      volumes: [{ name: "tls", secret: { secretName: "provider" } }],
    },
  };
  const file = join(directory, "pod.json");
  await writeFile(file, JSON.stringify(pod));
  await kubectl("apply", "-f", file);
  await kubectl("expose", "pod", "mcp", "-n", namespace, "--port=8080");
  await kubectl("wait", "-n", namespace, "pod/mcp", "--for=condition=Ready", "--timeout=120s");
  return {
    url: `https://${host}/mcp`,
    token,
    marker,
    upstreamProxy: {
      url: `http://mcp.${namespace}.svc.cluster.local:8080`,
      caPem,
    },
    receipts: async () =>
      JSON.parse(
        await kubectl(
          "exec",
          "-n",
          namespace,
          "mcp",
          "--",
          "node",
          "-e",
          'fetch("http://127.0.0.1:8081").then(r=>r.text()).then(t=>process.stdout.write(t))',
        ),
      ),
  };
}

// A normal Agent exec uses the same issued placeholder as the native transport for both
// requests. Read only the selected endpoint's header if the exec environment omits its slot.
async function probe(url, environment, nonce) {
  let marker = process.env[environment];
  if (!marker) {
    const { readFile } = await import("node:fs/promises");
    const state = process.env.OPENCLAW_NODE_STATE_DIR ?? "/home/node/.openclaw-node";
    const path = process.env.OPENCLAW_CONFIG_PATH ?? state + "/openclaw.json";
    const config = JSON.parse(await readFile(path, "utf8"));
    const endpoint = Object.values(config.nodeHost?.mcp?.servers ?? {}).find(
      (server) => server.enabled && server.url === url,
    );
    const header = endpoint?.headers?.Authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      marker = header.slice("Bearer ".length);
    }
  }
  if (!marker?.startsWith("openshell:resolve:env:") || !marker.endsWith("_" + environment)) {
    throw new Error("The selected native MCP account has no issued placeholder in the worker.");
  }
  async function call(name, id) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        Authorization: "Bearer " + marker,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 403) {
      const refused = await response.json();
      if (refused.error !== "policy_denied") {
        throw new Error("The rejection did not identify an OpenShell policy decision.");
      }
    } else {
      await response.arrayBuffer();
    }
    return response.status;
  }
  const allowed = await call("get_allowed", nonce + "-control");
  const denied = await call("get_denied", nonce + "-excluded");
  if (allowed !== 200 || denied !== 403) {
    throw new Error(
      "Unexpected inspected MCP responses: control=" + allowed + " excluded=" + denied,
    );
  }
  process.stdout.write(nonce + "_MCP_CONTROL_" + allowed + "_EXCLUDED_" + denied);
}

export function importedMcpProbeScript(url, environment, nonce) {
  return `await (${probe.toString()})(${JSON.stringify(url)},${JSON.stringify(environment)},${JSON.stringify(nonce)});\n`;
}
