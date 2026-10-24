import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type ServerOptions } from "node:https";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import type { TestContext } from "node:test";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { listen, temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";

/** Real Secret Driver against a synthetic TLS Kubernetes API with stable UID and version.
 * This proves the Driver's versioned reads, not Kubernetes deployment or workspace identity. */
export async function protectedModelSecret(
  t: TestContext,
  namespaceId: string,
  tls: ServerOptions,
) {
  const directory = await temporaryDirectory(t, "model-secret-");
  type SecretObject = {
    metadata: { name: string; uid?: string; resourceVersion?: string };
    stringData?: Record<string, string>;
    data?: Record<string, string>;
  };
  const objects = new Map<string, SecretObject>();
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: `oce-${createHash("sha256").update(namespaceId).digest("hex").slice(0, 15)}`,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": namespaceId,
        "openclaw.dev/gateway-namespace": namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": namespaceId },
    },
    status: { phase: "Active" },
  };
  const origin = await listen(
    t,
    createServer(tls, async (req, res) => {
      res.setHeader("content-type", "application/json");
      const url = new URL(req.url!, "https://127.0.0.1");
      if (url.pathname === "/api/v1/namespaces") {
        res.end(JSON.stringify({ apiVersion: "v1", kind: "NamespaceList", items: [namespace] }));
        return;
      }
      if (url.pathname === `/api/v1/namespaces/${namespace.metadata.name}`) {
        res.end(JSON.stringify(namespace));
        return;
      }
      const base = `/api/v1/namespaces/${namespace.metadata.name}/secrets`;
      if (req.method === "POST" && url.pathname === base) {
        const body = (await json(req)) as SecretObject;
        assert.equal(objects.has(body.metadata.name), false);
        const stored = {
          ...body,
          metadata: { ...body.metadata, uid: randomUUID(), resourceVersion: "1" },
          data: Object.fromEntries(
            Object.entries(body.stringData!).map(([key, value]) => [
              key,
              Buffer.from(String(value)).toString("base64"),
            ]),
          ),
        };
        delete stored.stringData;
        objects.set(body.metadata.name, stored);
        res.writeHead(201).end(JSON.stringify(stored));
        return;
      }
      const found = objects.get(url.pathname.slice(base.length + 1));
      if (req.method === "GET" && url.pathname.startsWith(base + "/") && found) {
        res.end(JSON.stringify(found));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ code: 404 }));
    }),
  );
  const path = join(directory, "kubeconfig.json");
  await writeFile(
    path,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "fixture",
          cluster: {
            server: origin,
            "certificate-authority-data": Buffer.from(tls.cert as string).toString("base64"),
          },
        },
      ],
      users: [{ name: "fixture", user: {} }],
      contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
      "current-context": "fixture",
    }),
  );
  return new KubernetesSecretDriver({
    authentication: { mode: "kubeconfig", kubeconfigPath: path, context: "fixture" },
  });
}
