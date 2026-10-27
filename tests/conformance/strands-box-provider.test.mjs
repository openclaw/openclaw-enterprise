import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";

test("Strands serving requires a fresh authenticated Codex initialize result", async (t) => {
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const { WebSocketServer } = createRequire(require.resolve("@kubernetes/client-node"))("ws");
  const http = createServer((_request, response) => response.writeHead(503).end());
  const server = new WebSocketServer({ noServer: true });
  const token = "synthetic-readiness-token";
  let behavior = "silent";
  const runtimeFailure = { component: "agent", check: "model-probe", code: "MODEL_PROBE_FAILED" };
  const diagnostics = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
    } else if (behavior === "held" && request.url === "/openclaw/runtime/status") {
      response.writeHead(200).end(JSON.stringify({ runtimeFailure }));
    } else {
      response.writeHead(503).end();
    }
  });
  diagnostics.listen(0, "127.0.0.1");
  await once(diagnostics, "listening");
  t.after(() => diagnostics.close());
  const ids = new Set();
  http.on("upgrade", (request, stream, head) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      stream.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (behavior === "held") {
      stream.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    server.handleUpgrade(request, stream, head, (socket) => {
      socket.once("message", (data) => {
        const request = JSON.parse(data);
        assert.equal(request.method, "initialize");
        assert.ok(!ids.has(request.id));
        ids.add(request.id);
        if (behavior === "silent") {
          return;
        }
        socket.send(
          JSON.stringify({
            id: request.id,
            ...(behavior === "error"
              ? { error: { code: -32603, message: "failed" } }
              : { result: { userAgent: "test-codex/1" } }),
          }),
        );
      });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    server.close();
    http.close();
  });
  const url = `ws://127.0.0.1:${http.address().port}`;
  const status = (transportToken) =>
    StrandsBoxSandboxDriver.prototype.harnessStatus.call(
      {
        harnessEndpoint: async () => ({ url }),
        harnessServiceAddress: async (_context, diagnostic) => {
          assert.equal(diagnostic, true);
          return `127.0.0.1:${diagnostics.address().port}`;
        },
      },
      { transportToken, signal: AbortSignal.timeout(15000) },
    );
  assert.deepEqual(await status(token), { state: "starting" });
  behavior = "held";
  assert.deepEqual(await status(token), { state: "failed", runtimeFailure });
  assert.deepEqual(await status("wrong-tenant"), { state: "starting" });
  behavior = "silent";
  assert.equal(server.clients.size, 0);
  behavior = "error";
  assert.deepEqual(await status(token), { state: "starting" });
  behavior = "answer";
  assert.deepEqual(await status("wrong-tenant"), { state: "starting" });
  assert.deepEqual(await status(token), { state: "serving" });
  assert.equal(ids.size, 3);
});

test("Strands revision containers retain Restricted security and keep readiness authentication outside the workload", async () => {
  const { strandsBoxResources } =
    await import("../../apps/controller/src/drivers/sandbox/strands-box-resources.ts");
  const { createHash } = await import("node:crypto");
  const transportToken = "synthetic-provider-readiness-secret";
  const hash = createHash("sha256").update(transportToken).digest("hex");
  const context = {
    namespace: { id: "ns_fixture", name: "tenant-fixture" },
    revision: { agentId: "agt_fixture", id: "rev_fixture" },
    transportToken,
    requirements: {
      loginMode: "api_key",
      image: "runtime:fixture",
      command: ["native-harness"],
      supervisedCommand: ["native-harness"],
      environment: [{ name: "APP_SERVER_PORT", value: "8787" }],
      files: [],
      credentialAttachments: [],
      labels: {},
      workspaceMounts: [
        {
          claimName: "workspace",
          subPath: "workspace",
          mountPath: "/home/node/workspace",
          readOnly: false,
        },
        {
          claimName: "workspace",
          subPath: "node-state",
          mountPath: "/home/node/.openclaw-node",
          readOnly: false,
        },
        {
          claimName: "reference",
          subPath: "docs",
          mountPath: "/home/node/reference",
          readOnly: true,
        },
      ],
    },
  };
  const options = {
    kubernetes: {
      nodeSelector: { "kubernetes.io/arch": "arm64" },
      seccompProfile: "qualified/box.json",
      controlPlanePeer: { namespace: "control", podLabels: { app: "worker" } },
    },
    policy: { network: { endpoints: [] } },
  };
  const render = (value) =>
    strandsBoxResources(value, options, "revision", {}, "input-hash", hash, undefined, []);
  const resources = render(context);
  const boxConfig = resources.find(({ kind }) => kind === "ConfigMap").data["box.toml"];
  const grants = (mode) => JSON.parse(boxConfig.match(new RegExp(`^${mode} = (.*)$`, "mu"))[1]);
  for (const path of ["/home/node/workspace", "/home/node/.openclaw-node"]) {
    assert.ok(grants("read").includes(path));
    assert.ok(grants("write").includes(path));
  }
  assert.ok(grants("read").includes("/home/node/reference"));
  assert.ok(!grants("write").includes("/home/node/reference"));
  for (const mode of ["read", "write"]) {
    assert.ok(!grants(mode).includes("/home/node"));
  }
  const services = resources.filter(({ kind }) => kind === "Service");
  assert.equal(services.length, 2);
  const endpoint = services.find(({ metadata }) => metadata.name === "revision");
  const diagnostic = services.find(({ metadata }) => metadata.name === "revision-status");
  assert.equal(endpoint.spec.publishNotReadyAddresses ?? false, false);
  assert.deepEqual(diagnostic.spec, { ...endpoint.spec, publishNotReadyAddresses: true });
  const secret = resources.find((resource) => resource.kind === "Secret");
  assert.equal(Buffer.from(secret.data.token, "base64").toString(), transportToken);
  assert.ok(
    resources
      .filter((resource) => resource.kind !== "Secret")
      .every((resource) => !JSON.stringify(resource).includes(transportToken)),
  );
  const pod = resources.find((resource) => resource.kind === "Deployment").spec.template.spec;
  assert.equal(pod.hostUsers, false);
  assert.equal(pod.shareProcessNamespace, false);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.deepEqual(pod.securityContext.seccompProfile, { type: "RuntimeDefault" });
  const supervisor = pod.containers.find((container) => container.name === "agent");
  const workload = pod.containers.find((container) => container.name === "box-workload");
  for (const container of pod.containers) {
    assert.deepEqual(container.securityContext.capabilities, { drop: ["ALL"] });
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext.procMount, undefined);
  }
  assert.ok(supervisor.volumeMounts.some((mount) => mount.name === "probe-auth" && mount.readOnly));
  assert.ok(!workload.volumeMounts.some((mount) => mount.name === "probe-auth"));
  assert.equal(workload.command[0], "/opt/strands-box/strands-box-contain-trampoline");
  assert.equal(workload.command[1], "--receive-container");
  assert.equal(workload.securityContext.seccompProfile.localhostProfile, "qualified/box.json");
  assert.ok(supervisor.readinessProbe.exec.command.includes("/opt/oce/strands-box/readiness.mjs"));
  assert.throws(() => render({ ...context, transportToken: undefined }), {
    code: "SANDBOX_HARNESS_UNSUPPORTED",
  });
  assert.throws(() => render({ ...context, transportToken: "another-revision" }), {
    code: "SANDBOX_HARNESS_UNSUPPORTED",
  });
  assert.throws(
    () =>
      render({
        ...context,
        requirements: { ...context.requirements, supervisedCommand: undefined },
      }),
    { code: "SANDBOX_HARNESS_UNSUPPORTED" },
  );
});

test("Strands adoption refreshes exact endpoint addresses without re-reading enrollment", async (t) => {
  const { createHash } = await import("node:crypto");
  const { lookup } = await import("node:dns/promises");
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const {
    KubernetesObjectApi,
    createConfiguration,
    ServerConfiguration,
  } = require("@kubernetes/client-node");
  const { strandsBoxResources } =
    await import("../../apps/controller/src/drivers/sandbox/strands-box-resources.ts");
  const options = {
    kubernetes: {
      nodeSelector: { "kubernetes.io/arch": "arm64" },
      seccompProfile: "qualified/box.json",
      controlPlanePeer: { namespace: "control", podLabels: { app: "worker" } },
    },
    policy: { network: { endpoints: [{ host: "localhost", ports: [443] }] } },
  };
  const driver = new StrandsBoxSandboxDriver(options, {
    id: "strands-fixture",
    authentication: { mode: "inCluster" },
  });
  const context = {
    namespace: { id: "ns_fixture", name: "tenant-fixture" },
    revision: {
      agentId: "agt_fixture",
      id: "rev_fixture",
      namespaceId: "ns_fixture",
      sandboxDriverId: driver.id,
      harness: { id: "codex", mode: "dedicated" },
    },
    signal: AbortSignal.timeout(10000),
    transportToken: "synthetic-readiness-token",
    requirements: {
      loginMode: "api_key",
      image: "runtime:fixture",
      command: ["native-harness"],
      supervisedCommand: ["native-harness"],
      environment: [{ name: "APP_SERVER_PORT", value: "8787" }],
      files: [],
      credentialAttachments: [],
      labels: {},
      workspaceMounts: [
        {
          claimName: "workspace",
          subPath: "workspace",
          mountPath: "/home/node/workspace",
          readOnly: false,
        },
      ],
    },
  };
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  context.requirements.environment.push({
    name: "APP_TOKEN_SHA",
    value: digest(context.transportToken),
  });
  const labels = {
    "openclaw.dev/strands-box": digest(driver.id).slice(0, 20),
    "openclaw.dev/namespace": context.namespace.id,
    "openclaw.dev/agent": context.revision.agentId,
    "openclaw.dev/revision": context.revision.id,
    "openclaw.dev/workload-role": "agent",
  };
  const ref = driver.harnessResource(context);
  const resources = strandsBoxResources(
    context,
    options,
    ref.resourceName,
    labels,
    digest(JSON.stringify([2, context.requirements, options])),
    digest(context.transportToken),
    undefined,
    [{ cidr: "192.0.2.1/32", port: 443 }],
  );
  for (const resource of resources) {
    resource.metadata = {
      ...resource.metadata,
      uid: `${resource.kind}-uid`,
      resourceVersion: "42",
    };
  }
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const before = structuredClone(policy);
  const requests = [];
  const patches = [];
  let loseDeploymentAfterRead = false;
  const kinds = {
    deployments: "Deployment",
    networkpolicies: "NetworkPolicy",
    services: "Service",
    secrets: "Secret",
    configmaps: "ConfigMap",
  };
  const http = createServer(async (request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.setHeader("content-type", "application/json");
    if (["/api/v1", "/apis/apps/v1", "/apis/networking.k8s.io/v1"].includes(request.url)) {
      response.end(
        JSON.stringify({
          kind: "APIResourceList",
          apiVersion: "v1",
          groupVersion: request.url.replace(/^\/apis?\//u, ""),
          resources: Object.entries(kinds).map(([name, kind]) => ({
            name,
            kind,
            namespaced: true,
            verbs: ["get", "patch"],
          })),
        }),
      );
      return;
    }
    const parts = request.url.split("?")[0].split("/");
    if (request.method === "POST" && parts.at(-1) === "deployments") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      resources.push(JSON.parse(body));
      response.writeHead(201).end(body);
      return;
    }
    const resource = resources.find(
      (item) => item.kind === kinds[parts.at(-2)] && item.metadata.name === parts.at(-1),
    );
    if (!resource) {
      response.writeHead(404).end(JSON.stringify({ kind: "Status", apiVersion: "v1", code: 404 }));
      return;
    }
    if (request.method === "PATCH") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const patch = JSON.parse(body);
      patches.push({ patch, contentType: request.headers["content-type"] });
      // The recording server supplies the external API; production Driver code
      // decides what to patch. Kubernetes resourceVersion enforcement is live-cluster proof.
      resource.spec.egress = patch.spec.egress;
    }
    if (loseDeploymentAfterRead && resource.kind === "Deployment") {
      resources.splice(resources.indexOf(resource), 1);
    }
    response.end(JSON.stringify(resource));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  // No credentials or production client configuration enter this loopback API fixture.
  context.kubernetes = new KubernetesObjectApi(
    createConfiguration({
      baseServer: new ServerConfiguration(`http://127.0.0.1:${http.address().port}`, {}),
    }),
  );
  assert.deepEqual(await driver.provisionHarness(context), ref);
  assert.equal(patches.length, 1);
  assert.match(patches[0].contentType, /application\/merge-patch\+json/u);
  assert.deepEqual(patches[0].patch.metadata, {
    name: ref.resourceName,
    namespace: ref.namespaceName,
    uid: "NetworkPolicy-uid",
    resourceVersion: "42",
  });
  assert.deepEqual(Object.keys(patches[0].patch.spec), ["egress"]);
  assert.deepEqual(policy.spec.ingress, before.spec.ingress);
  assert.deepEqual(policy.spec.egress[0], before.spec.egress[0], "cluster DNS rule is preserved");
  const current = await lookup("localhost", { all: true });
  const expected = [
    ...new Set(current.map((address) => `${address.address}/${address.family === 4 ? 32 : 128}`)),
  ].sort();
  assert.deepEqual(
    policy.spec.egress
      .slice(1)
      .map((rule) => rule.to[0].ipBlock.cidr)
      .sort(),
    expected,
  );
  for (const rule of policy.spec.egress.slice(1)) {
    assert.deepEqual(rule.ports, [{ protocol: "TCP", port: 443 }]);
  }
  assert.ok(!JSON.stringify(policy.spec.egress).includes("192.0.2.1"));
  assert.ok(
    !requests.some((request) => request.path.includes("/secrets/")),
    "adoption cannot require a retired enrollment Secret",
  );
  await driver.provisionHarness(context);
  assert.equal(patches.length, 1, "unchanged answers cause no policy write");
  policy.spec.egress.at(-1).ports[0].endPort = 6500;
  await assert.rejects(driver.provisionHarness(context), /exact approved destination/u);
  assert.equal(patches.length, 1, "a widened rule cannot be carried to a new endpoint");
  delete policy.spec.egress.at(-1).ports[0].endPort;
  const maintenance = { ...context, existingHarnessOnly: true };
  const beforeLoss = requests.length;
  // The API returns the existing Deployment once and deletes it before the next request.
  loseDeploymentAfterRead = true;
  await driver.provisionHarness(maintenance);
  assert.ok(requests.slice(beforeLoss).every(({ method }) => method === "GET"));
  const afterLoss = requests.length;
  await assert.rejects(
    driver.provisionHarness(maintenance),
    /maintenance cannot recreate a missing revision workload/u,
  );
  assert.deepEqual(requests.slice(afterLoss), [
    {
      method: "GET",
      path: `/apis/apps/v1/namespaces/${ref.namespaceName}/deployments/${ref.resourceName}`,
    },
  ]);
  // A normal deployment retains its provisioning authority.
  loseDeploymentAfterRead = false;
  await driver.provisionHarness(context);
  assert.deepEqual(
    requests.filter(({ method }) => method === "POST"),
    [{ method: "POST", path: `/apis/apps/v1/namespaces/${ref.namespaceName}/deployments` }],
  );
});
