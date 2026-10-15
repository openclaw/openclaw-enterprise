import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseProductionChart, renderProductionChart } from "./production-chart.mjs";

/** Install the chart reader in this journey's disposable namespace. Replace only GitHub. */
export async function installPublicGithubReadFixture({
  namespace,
  controllerImage,
  kubectl,
  applyManifest,
  observeRequests = false,
}) {
  const name = "openclaw-enterprise-public-github-read";
  // Let this cluster reserve a Service IP. Apply the chart over the same Service
  // so no other fixture can acquire the IP between allocation and Agent admission.
  const allocated = JSON.parse(
    await kubectl(
      "create",
      "service",
      "clusterip",
      name,
      "--namespace",
      namespace,
      "--tcp=8080:8080",
      "-o",
      "json",
    ),
  );
  const address = allocated.spec.clusterIP;
  const { stdout } = await renderProductionChart(
    {
      "images.controller": controllerImage,
      "publicGithubRead.enabled": true,
      "publicGithubRead.clusterIP": address,
      "publicGithubRead.upstreamCidrs[0]": "192.0.2.1/32",
    },
    { namespace },
  );
  const items = (await parseProductionChart(stdout)).filter((item) => item.metadata.name === name);
  const pod = items.find(({ kind }) => kind === "Deployment").spec.template;
  const service = items.find(({ kind }) => kind === "Service");
  assert.equal(service.spec.clusterIP, address);
  assert.equal(service.spec.type, "ClusterIP");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  const marker = "public-pull-" + randomUUID();
  // Only this test Pod substitutes a loopback HTTP provider for github.com TLS.
  // The reader, Helm Service/NetworkPolicy, worker, Agent, native network proxy
  // and managed skill discovery are real. The marker is absent from the prompt.
  const provider = [
    'import assert from "node:assert/strict";',
    'import http from "node:http";',
    'import https from "node:https";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const server = http.createServer((req, res) => {",
    observeRequests
      ? "  assert.match(req.url, /^\\/repos\\/example\\/public-project\\/pulls\\/(?:27|28|29|30)$/);"
      : '  assert.equal(req.url, "/repos/example/public-project/pulls/27");',
    "  assert.equal(req.headers.authorization ?? req.headers.cookie, undefined);",
    ...(observeRequests
      ? ['  console.log(JSON.stringify({event: "provider", path: req.url}));']
      : []),
    '  res.setHeader("content-type", "application/vnd.github+json");',
    "  res.end(JSON.stringify({number: 27, title: " + JSON.stringify(marker) + "}));",
    "});",
    'await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));',
    "https.get = (target, { headers, signal }, callback) => {",
    '  const url = new URL(target); assert.equal(url.origin, "https://api.github.com");',
    '  return http.get({host: "127.0.0.1", port: server.address().port, path: url.pathname + url.search, headers, signal}, callback);',
    "};",
    ...(observeRequests
      ? [
          "const createServer = http.createServer;",
          "let nextConnection = 0;",
          "http.createServer = (options, handler) => {",
          "  const reader = createServer(options, (req, res) => {",
          '  if (req.url !== "/healthz") console.log(JSON.stringify({event: "reader", path: req.url, connection: req.socket.oceConnection}));',
          "  handler(req, res);",
          "  });",
          "  reader.on('connection', socket => {",
          "    const connection = ++nextConnection; socket.oceConnection = connection;",
          "    console.log(JSON.stringify({event: 'connection', connection}));",
          "    socket.on('close', () => console.log(JSON.stringify({event: 'closed', connection})));",
          "  });",
          "  return reader;",
          "};",
        ]
      : []),
    "syncBuiltinESMExports();",
  ].join("\n");
  pod.spec.containers[0].args.unshift(
    "--import",
    "data:text/javascript," + encodeURIComponent(provider),
  );
  for (const item of items) {
    item.metadata.namespace = namespace;
  }
  await applyManifest(JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  await kubectl(
    "rollout",
    "status",
    "deployment/" + name,
    "--namespace",
    namespace,
    "--timeout=120s",
  );
  return { peer: { namespace, podLabels: service.spec.selector, address }, marker };
}
