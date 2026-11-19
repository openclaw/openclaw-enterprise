import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  V1ConfigMap,
  V1Deployment,
  V1Pod,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";

const execute = promisify(execFile);

// The replacement can reveal a regression by counting application events. It never logs payloads.
const listener = `
const { readFileSync } = require("node:fs");
const { createServer } = require("node:https");
const directory = "/run/strands-listener";
for (const port of [18790, 18791]) {
  const event = (kind) => console.log(JSON.stringify({ port, kind }));
  const server = createServer({
    key: readFileSync(directory + "/key.pem"),
    cert: readFileSync(directory + "/peer.pem"),
  }, (_request, response) => { event("request"); response.writeHead(401); response.end(); });
  server.on("connection", () => event("tcp"));
  server.on("secureConnection", () => event("accepted"));
  server.on("tlsClientError", () => event("rejected"));
  server.on("upgrade", (_request, socket) => {
    event("upgrade"); socket.on("data", () => event("frame")); socket.end();
  });
  server.listen(port, "0.0.0.0", () => event("listening"));
}
`;

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(1000);
  }
  assert.fail("Timed out waiting for " + description);
}

test(
  "a replacement Strands Pod receives no credentials from the Gateway or worker",
  { skip: process.env.OCC_TEST_STRANDS_REPLACEMENT !== "1", timeout: 540_000 },
  async (t) => {
    const required = (key: string) => {
      const value = process.env[key];
      assert.ok(value, "Missing " + key);
      return value;
    };
    const context = required("OCC_TEST_KUBERNETES_CONTEXT");
    const config = required("OCC_TEST_KUBERNETES_KUBECONFIG");
    const namespace = required("OCC_TEST_PROVIDER_TENANT");
    const agent = required("OCC_TEST_PROVIDER_AGENT");
    const cli = required("OCC_TEST_OCC_BIN");
    const kube = async (...args: string[]) =>
      (
        await execute("kubectl", [
          "--kubeconfig",
          config,
          "--context",
          context,
          "-n",
          namespace,
          ...args,
        ])
      ).stdout;
    const occ = async (...args: string[]) =>
      JSON.parse((await execute(cli, ["agent", ...args, "-o", "json"])).stdout);
    const loopback = (url: string) =>
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
    assert.ok(context.startsWith("k3d-") && loopback(required("OCC_URL")));
    assert.ok(
      loopback(
        await kube("config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"),
      ),
    );
    const initial = await occ("get", agent);
    assert.equal(initial.id, agent);
    const revision = initial.activeRevisionId;
    assert.ok(typeof revision === "string" && revision.length > 0);
    const selector = "openclaw.dev/agent=" + agent + ",openclaw.dev/revision=" + revision;
    // The stable Gateway Deployment carries the revision label on its Pod template.
    const agentDeployments: V1Deployment[] = JSON.parse(
      await kube("get", "deployment", "-l", "openclaw.dev/agent=" + agent, "-o", "json"),
    ).items;
    const deployments = agentDeployments.filter(
      (d) => d.spec?.template.metadata?.labels?.["openclaw.dev/revision"] === revision,
    );
    const harnesses = deployments.filter((d) =>
      d.spec?.template.spec?.initContainers?.some((c) => c.name === "initialize-listener"),
    );
    assert.equal(harnesses.length, 1);
    const harness = harnesses[0]!;
    const name = harness.metadata?.name;
    const spec = harness.spec?.template.spec;
    assert.ok(name && spec && harness.metadata?.resourceVersion);
    assert.equal(harness.spec?.strategy?.type, "Recreate");
    const gateway = deployments.find(
      (d) => d.spec?.template.metadata?.labels?.["openclaw.dev/workload-role"] === "gateway",
    )?.metadata?.name;
    assert.ok(gateway);
    const getReceipt = async (): Promise<V1ConfigMap> =>
      JSON.parse(await kube("get", "configmap", name + "-listener", "-o", "json"));
    const original = await getReceipt();
    assert.equal(original.immutable, true);
    assert.equal(original.data?.deploymentUid, harness.metadata.uid);
    assert.ok(original.data?.podUid && original.data.certificate);
    const getPod = async () => {
      const pods: V1Pod[] = JSON.parse(
        await kube("get", "pods", "-l", selector, "-o", "json"),
      ).items;
      const current = pods.filter(
        (p) =>
          !p.metadata?.deletionTimestamp &&
          p.spec?.initContainers?.some((c) => c.name === "initialize-listener"),
      );
      assert.equal(current.length, 1);
      return current[0]!;
    };
    assert.equal((await getPod()).metadata?.uid, original.data.podUid);
    const init = spec.initContainers?.find((c) => c.name === "initialize-listener");
    const volume = spec.volumes?.find((v) => v.name === "listener-identity");
    assert.ok(
      init?.image && volume?.emptyDir && init.volumeMounts?.every((m) => m.name === volume.name),
    );
    // Keep the production certificate initializer and service selectors. Strip the original
    // containers, credentials, PVCs and service-account token before exposing either port.
    const replacement = {
      automountServiceAccountToken: false,
      nodeSelector: spec.nodeSelector,
      securityContext: spec.securityContext,
      volumes: [volume],
      initContainers: [init],
      containers: [
        {
          name: "replacement-listener",
          image: init.image,
          imagePullPolicy: init.imagePullPolicy,
          command: ["node", "-e", listener],
          securityContext: init.securityContext,
          volumeMounts: [{ name: volume.name, mountPath: "/run/strands-listener", readOnly: true }],
        },
      ],
    };
    await kube(
      "patch",
      "deployment",
      name,
      "--type=json",
      "-p",
      JSON.stringify([
        { op: "test", path: "/metadata/resourceVersion", value: harness.metadata.resourceVersion },
        { op: "replace", path: "/spec/template/spec", value: replacement },
      ]),
    );
    // Admit a fresh execution normally, even on assertion failure. Never revive the old receipt.
    t.after(async () => {
      assert.equal(
        (await occ("get", agent)).activeRevisionId,
        revision,
        "another owner changed the test Agent",
      );
      const next = await occ("deploy", agent);
      assert.notEqual(next.id, revision);
      await until(
        async () => (await occ("deployment-status", agent, next.id)).status === "succeeded",
        "fresh admission",
      );
    });
    await kube("rollout", "status", "deployment/" + name, "--timeout=120s");
    const pod = await getPod();
    assert.ok(pod.metadata?.name);
    const certificate = pod.status?.initContainerStatuses?.find((c) => c.name === init.name)?.state
      ?.terminated?.message;
    assert.ok(certificate && certificate.includes("BEGIN CERTIFICATE"));
    assert.notEqual(pod.metadata.uid, original.data.podUid);
    assert.notEqual(certificate.trim(), original.data.certificate.trim());
    const run = randomUUID();
    const call = async (method: string, params: object) =>
      JSON.parse(
        await kube(
          "exec",
          "deployment/" + gateway,
          "-c",
          "gateway",
          "--",
          "node",
          "/app/openclaw.mjs",
          "gateway",
          "call",
          method,
          "--json",
          "--timeout",
          "95000",
          "--params",
          JSON.stringify(params),
        ),
      );
    await call("chat.send", {
      sessionKey: "agent:main:replacement-" + run,
      idempotencyKey: run,
      message: "Reply with " + run,
    });
    assert.equal((await call("agent.wait", { runId: run, timeoutMs: 90000 })).status, "error");
    const podName = pod.metadata.name;
    await until(async () => {
      const log = await kube("logs", podName, "-c", "replacement-listener");
      const events = log
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { port: number; kind: string });
      assert.ok(
        events.every((event) => ["listening", "tcp", "rejected"].includes(event.kind)),
        "the replacement accepted traffic beyond the TLS handshake",
      );
      return [18790, 18791].every((port) =>
        events.some((event) => event.port === port && event.kind === "rejected"),
      );
    }, "both Gateway and standard worker to reject the replacement");
    const final = await getReceipt();
    assert.equal(final.metadata?.uid, original.metadata?.uid);
    assert.deepEqual(final.data, original.data);
  },
);
