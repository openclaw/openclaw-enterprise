import { X509Certificate } from "node:crypto";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import assert from "node:assert/strict";
import type { RequestListener } from "node:http";
import { createServer } from "node:https";
import test, { type TestContext } from "node:test";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import { listen } from "../helpers/listen.ts";
import {
  KubernetesObjectApi,
  type KubernetesObject,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import {
  digest,
  gatewayRouting,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

type DriverStatus = typeof StrandsBoxSandboxDriver.prototype.harnessStatus;
type DriverContext = Parameters<DriverStatus>[0];
type StatusContext = Pick<DriverContext, "signal" | "transportToken"> & {
  revision: Pick<DriverContext["revision"], "id">;
};
type StatusDiscovery = {
  harnessServiceAddress: () => Promise<string>;
  listenerCertificate: () => Promise<X509Certificate>;
};

// Substitute revision Service discovery only. Both status reads use real loopback sockets.
const harnessStatus = StrandsBoxSandboxDriver.prototype.harnessStatus as (
  this: StatusDiscovery,
  context: StatusContext,
) => ReturnType<DriverStatus>;

async function check(
  t: TestContext,
  diagnostic: RequestListener,
  signal = new AbortController().signal,
) {
  const tls = await harnessTlsFixture(t);
  const server = createServer(tls, diagnostic);
  server.on("upgrade", (_request, socket) => socket.destroy());
  const port = await listen(t, server);
  const address = `localhost:${port}`;
  return harnessStatus.call(
    {
      harnessServiceAddress: async () => address,
      listenerCertificate: async () => new X509Certificate(tls.cert),
    },
    { signal, revision: { id: "rev_fixture" }, transportToken: "fixture" },
  );
}

test("Box reports an unreachable dependency when neither status read gets a response", async (t) => {
  await assert.rejects(
    check(t, (req) => req.socket.destroy()),
    {
      code: "SANDBOX_GATEWAY_UNAVAILABLE",
      reason: "unreachable",
    },
  );
});

test("Box preserves the caller's cancellation during its diagnostic read", async (t) => {
  const abort = new AbortController();
  const cause = new Error("cancelled revision");
  await assert.rejects(
    check(t, () => abort.abort(cause), abort.signal),
    (err) => err === cause,
  );
});

test("Box preserves startup and held failure responses from the Harness", async (t) => {
  const runtimeFailure = { code: "fixture-startup-failure" };
  for (const payload of [
    { state: "starting" },
    { state: "serving" },
    { state: "failed", runtimeFailure },
  ]) {
    const status = await check(t, (req, res) => {
      assert.equal(req.url, "/revisions/rev_fixture/readiness");
      assert.equal(req.headers.authorization, "Bearer fixture");
      res.end(JSON.stringify(payload));
    });
    assert.deepEqual(status, payload);
  }
});

test("a replacement at the same readiness endpoint receives no bearer or request", async (t) => {
  const original = await harnessTlsFixture(t);
  const replacement = await harnessTlsFixture(t);
  let requests = 0;
  let connections = 0;
  const server = createServer(replacement, (_req, res) => {
    requests++;
    res.end("{}");
  });
  server.on("connection", () => {
    connections++;
  });
  server.on("tlsClientError", (_, socket) => socket.destroy());
  const port = await listen(t, server);
  await assert.rejects(
    harnessStatus.call(
      {
        harnessServiceAddress: async () => `localhost:${port}`,
        listenerCertificate: async () => new X509Certificate(original.cert),
      },
      {
        signal: new AbortController().signal,
        revision: { id: "rev_fixture" },
        transportToken: "revision-test",
      },
    ),
    { code: "SANDBOX_GATEWAY_UNAVAILABLE" },
  );
  assert.equal(connections, 1);
  assert.equal(requests, 0);
});

test("Box bounds listener startup retries to a missing Pod or an owned initializing Pod", async (t) => {
  const driver = new StrandsBoxSandboxDriver(
    {
      kubernetes: {
        seccompProfile: "strands.json",
        nodeSelector: { "kubernetes.io/arch": "arm64" },
        controlPlanePeer: { namespace: "controller", podLabels: { app: "controller" } },
      },
      policy: { network: { endpoints: [] } },
    },
    {
      id: "strands",
      authentication: { mode: "inCluster" },
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      routing: gatewayRouting,
    },
  );
  const revision = routedRevision(
    { id: "kubernetes", implementation: "kubernetes" },
    { sandboxDriverId: driver.id },
  );
  const namespace = { ...tenant, name: "execution", status: "ready" } as const;
  const { resourceName } = driver.harnessResource({ revision, namespace });
  const labels = {
    "openclaw.dev/strands-box": digest(driver.id, 20),
    "openclaw.dev/namespace": namespace.id,
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
  };
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    controller: true,
    name: resourceName,
    uid: "deployment",
  };
  const rs = { ...deployment, kind: "ReplicaSet", name: "execution-rs", uid: "rs" };
  const pod = { metadata: { uid: "00000000-0000-4000-8000-000000000001", ownerReferences: [rs] } };
  const withStatus = (...initContainerStatuses: unknown[]) => ({
    ...pod,
    status: { initContainerStatuses },
  });
  const listener = (state: unknown) => ({ name: "initialize-listener", state });
  const waiting = listener({ waiting: { reason: "ContainerCreating" } });
  const transient = {
    name: "TransientDependencyError",
    code: "SANDBOX_GATEWAY_UNAVAILABLE",
    reason: "unavailable",
  };
  const unavailable = { name: "DependencyUnavailableError" };
  const completed = { terminated: { exitCode: 0, message: "invalid PEM" } };
  const foreign = { ...deployment, uid: "other-deployment" };
  const cases: Array<[string, unknown[], object, typeof deployment?]> = [
    ["no Pod", [], transient],
    ["no Pod status", [pod], transient],
    ["no listener yet", [withStatus()], transient],
    ["listener waiting", [withStatus(waiting)], transient],
    ["listener running", [withStatus(listener({ running: {} }))], transient],
    ["two Pods", [pod, { metadata: { uid: "other" } }], unavailable],
    ["invalid Pod UID", [{ metadata: { ...pod.metadata, uid: "bad" } }], unavailable],
    ["unowned Pod", [{ metadata: { uid: pod.metadata.uid } }], unavailable],
    ["foreign Deployment", [pod], /does not belong to the prepared Deployment/, foreign],
    ["terminal Pod", [{ ...pod, status: { phase: "Failed" } }], unavailable],
    ["malformed status", [withStatus(null)], unavailable],
    ["duplicate listener", [withStatus(listener(completed), waiting)], unavailable],
    ["conflicting states", [withStatus(listener({ running: {}, ...completed }))], unavailable],
    [
      "crash loop",
      [withStatus(listener({ waiting: { reason: "CrashLoopBackOff" } }))],
      unavailable,
    ],
    ["failed listener", [withStatus(listener({ terminated: { exitCode: 1 } }))], unavailable],
    [
      "completed without valid certificate",
      [withStatus(listener(completed))],
      /Invalid Strands execution certificate evidence/,
    ],
  ];
  for (const [name, items, expected, owner = deployment] of cases) {
    await t.test(name, async () => {
      // Drive discovery through the public status read, stopping before any transport.
      const kubernetes = {
        list: async () => ({ items }),
        create: async () => assert.fail("unverified listener must not create a receipt"),
        async read({ kind }: KubernetesObject) {
          switch (kind) {
            case "Deployment":
              return { metadata: { name: resourceName, uid: deployment.uid, labels } };
            case "ReplicaSet":
              return { metadata: { uid: rs.uid, ownerReferences: [owner] } };
            case "ConfigMap":
              throw Object.assign(new Error("no receipt yet"), { statusCode: 404 });
            default:
              assert.fail("unexpected read: " + kind);
          }
        },
      };
      Object.setPrototypeOf(kubernetes, KubernetesObjectApi.prototype);
      await assert.rejects(
        driver.harnessStatus({
          namespace,
          revision,
          kubernetes,
          signal: new AbortController().signal,
          transportToken: "fixture",
          requirements: {
            loginMode: "api_key",
            image: "box:fixture",
            labels,
            command: [],
            retainedDirectories: [],
            environment: [],
            files: [],
            credentialAttachments: [],
            workspaceMounts: [],
          },
        }),
        expected,
      );
    });
  }
});
