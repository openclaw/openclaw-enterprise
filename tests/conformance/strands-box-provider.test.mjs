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
  const ids = new Set();
  http.on("upgrade", (request, stream, head) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      stream.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
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
      { harnessEndpoint: async () => ({ url }) },
      { transportToken, signal: AbortSignal.timeout(15000) },
    );
  assert.deepEqual(await status(token), { state: "starting" });
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
