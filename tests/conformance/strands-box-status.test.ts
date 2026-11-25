import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import assert from "node:assert/strict";
import type { RequestListener } from "node:http";
import { createServer } from "node:https";
import test, { type TestContext } from "node:test";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import { listen } from "../helpers/listen.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
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

function strandsDriver() {
  return new StrandsBoxSandboxDriver(
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
}

function podCertificate(uid: string, hostname: string, statusHostname: string): string {
  return execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${uid}`,
      "-keyout",
      "/dev/null",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      `subjectAltName=DNS:${hostname},DNS:${statusHostname}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
}

test("Box bounds listener startup retries to a missing Pod or an owned initializing Pod", async (t) => {
  const driver = strandsDriver();
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
  const listener = (...states: unknown[]) => {
    const initContainerStatuses = states.map((state) => ({ name: "initialize-listener", state }));
    return [{ ...pod, status: { initContainerStatuses } }];
  };
  const waiting = { waiting: { reason: "ContainerCreating" } };
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
    ["no listener yet", listener(), transient],
    ["listener waiting", listener(waiting), transient],
    ["listener running", listener({ running: {} }), transient],
    ["two Pods", [pod, { metadata: { uid: "other" } }], unavailable],
    ["invalid Pod UID", [{ metadata: { ...pod.metadata, uid: "bad" } }], unavailable],
    ["unowned Pod", [{ metadata: { uid: pod.metadata.uid } }], unavailable],
    ["foreign Deployment", [pod], /does not belong to the prepared Deployment/, foreign],
    ["terminal Pod", [{ ...pod, status: { phase: "Failed" } }], unavailable],
    ["malformed status", [{ ...pod, status: { initContainerStatuses: [null] } }], unavailable],
    ["duplicate listener", listener(completed, waiting), unavailable],
    ["conflicting states", listener({ running: {}, ...completed }), unavailable],
    ["crash loop", listener({ waiting: { reason: "CrashLoopBackOff" } }), unavailable],
    ["unknown state", listener({ unknown: {} }), unavailable],
    ["failed listener", listener({ terminated: { exitCode: 1 } }), unavailable],
    [
      "completed without valid certificate",
      listener(completed),
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

test("Compute observes only the Strands execution identity pinned by endpoint discovery", async (t) => {
  const sandbox = strandsDriver();
  const {
    driver: compute,
    revision,
    namespace: namespaceName,
    core,
  } = providerEndpointFixture({
    sandboxDriver: sandbox,
  });
  const namespace = { ...tenant, name: namespaceName, status: "ready" } as const;
  const { resourceName } = sandbox.harnessResource({ revision, namespace });
  const hostname = `${resourceName}.${namespaceName}.svc`;
  const statusHostname = `${resourceName}-status.${namespaceName}.svc`;
  const labels = {
    "openclaw.dev/strands-box": digest(sandbox.id, 20),
    "openclaw.dev/namespace": namespace.id,
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "agent",
  };
  const deploymentOwner = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    name: resourceName,
    uid: "deployment-a",
    controller: true,
  };
  const replicaSetOwner = {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    name: `${resourceName}-rs`,
    uid: "rs-a",
    controller: true,
  };
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: resourceName, namespace: namespaceName, labels, uid: deploymentOwner.uid },
  };
  const originalUid = "00000000-0000-4000-8000-000000000001";
  const replacementUid = "00000000-0000-4000-8000-000000000002";
  const originalPem = podCertificate(originalUid, hostname, statusHostname);
  const replacementPem = podCertificate(replacementUid, hostname, statusHostname);
  const running = { name: "agent", restartCount: 0, state: { running: {} } };
  const pod = (uid: string, certificate: string) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `${resourceName}-${uid.slice(-1)}`,
      namespace: namespaceName,
      labels,
      uid,
      ownerReferences: [replicaSetOwner],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [running],
      initContainerStatuses: [
        {
          name: "initialize-listener",
          state: { terminated: { exitCode: 0, message: certificate } },
        },
      ],
    },
  });
  type Receipt = KubernetesObject & {
    immutable?: boolean;
    data?: { deploymentUid?: string; podUid?: string; certificate?: string };
  };
  const original = pod(originalUid, originalPem);
  const replacement = pod(replacementUid, replacementPem);
  let pods: Array<KubernetesObject & { status?: unknown }> = [original];
  let deployments = [deployment];
  let receipt: Receipt | undefined;
  let receiptReadsForbidden = false;
  let podReadFailure: Error | undefined;
  let podListContinuation: string | undefined;
  const receipts: Receipt[] = [];
  const absent = () => Object.assign(new Error("not found"), { statusCode: 404 });
  const objects = {
    async list(_version: string, kind: string) {
      if (kind === "Deployment") {
        return { items: structuredClone(deployments) };
      }
      assert.equal(kind, "Pod");
      if (podReadFailure) {
        throw podReadFailure;
      }
      return { metadata: { continue: podListContinuation }, items: structuredClone(pods) };
    },
    async read({ kind, metadata }: KubernetesObject) {
      assert.equal(metadata?.namespace, namespaceName);
      switch (kind) {
        case "Deployment":
          assert.equal(metadata?.name, resourceName);
          return structuredClone(deployments[0]);
        case "ReplicaSet":
          assert.equal(metadata?.name, replicaSetOwner.name);
          return { metadata: { uid: replicaSetOwner.uid, ownerReferences: [deploymentOwner] } };
        case "ConfigMap":
          assert.equal(metadata?.name, `${resourceName}-listener`);
          if (receiptReadsForbidden) {
            throw Object.assign(new Error("forbidden"), { statusCode: 403 });
          }
          if (!receipt) {
            throw absent();
          }
          return structuredClone(receipt);
        case "Service":
          assert.equal(metadata?.name, resourceName);
          return {
            kind,
            metadata: { name: resourceName, labels },
            spec: { ports: [{ port: 18790, targetPort: 18790 }], selector: labels },
          };
        default:
          assert.fail("unexpected read: " + kind);
      }
    },
    async create(resource: Receipt) {
      assert.equal(resource.kind, "ConfigMap");
      assert.equal(resource.metadata?.name, `${resourceName}-listener`);
      receipts.push(structuredClone(resource));
      assert.equal(receipt, undefined);
      receipt = structuredClone(resource);
      return resource;
    },
  };
  Object.setPrototypeOf(objects, KubernetesObjectApi.prototype);
  // Inject only the Kubernetes response boundary. Compute's namespace and revision checks,
  // the Box observer, and endpoint certificate verification all run as shipped.
  Object.defineProperty(compute, "apiClients", { value: Promise.resolve({ core, objects }) });
  Object.defineProperty(sandbox, "observer", { value: Promise.resolve(objects) });
  const signal = new AbortController().signal;
  const observe = () => compute.observeRevision(revision, signal);
  const endpoint = () =>
    sandbox.harnessEndpoint({
      namespace,
      revision,
      kubernetes: objects,
      signal,
      requirements: {
        loginMode: "api_key",
        image: "box:fixture",
        labels,
        command: [],
        retainedDirectories: [],
        environment: [{ name: "APP_SERVER_PORT", value: "18790" }],
        files: [],
        credentialAttachments: [],
        workspaceMounts: [],
      },
    });
  const terminated = { ...running, state: { terminated: { exitCode: 1 } } };
  const restarted = { ...running, restartCount: 1 };
  const waiting = { ...running, state: { waiting: { reason: "ContainerCreating" } } };
  const cannotPin = [
    ["Failed Pod", { phase: "Failed" }],
    ["Succeeded Pod", { phase: "Succeeded" }],
    ["terminated supervisor in Running phase", { containerStatuses: [terminated] }],
    ["restarted supervisor in Running phase", { containerStatuses: [restarted] }],
  ] as const;
  for (const [name, status] of cannotPin) {
    await t.test(`initializer success with ${name} cannot reserve its certificate`, async () => {
      receipt = undefined;
      receipts.length = 0;
      pods = [{ ...original, status: { ...original.status, ...status } }];
      await assert.rejects(endpoint(), { name: "DependencyUnavailableError" });
      assert.deepEqual(receipts, []);
    });
  }
  await t.test(
    "endpoint discovery accepts an owned Pod waiting for its first supervisor",
    async () => {
      receipt = undefined;
      receipts.length = 0;
      pods = [
        {
          ...original,
          status: { ...original.status, phase: "Pending", containerStatuses: [waiting] },
        },
      ];
      const bound = await endpoint();
      assert.equal(bound.tlsPeerCertificate, new X509Certificate(originalPem).toString());
      assert.equal(receipts[0]?.data?.podUid, originalUid);
    },
  );
  await t.test(
    "endpoint discovery pins before readiness and Compute runs only when ready",
    async () => {
      receipt = undefined;
      receipts.length = 0;
      const startup = { ...original.status, phase: "Pending", conditions: [] };
      pods = [{ ...original, status: { ...startup, containerStatuses: undefined } }];
      assert.deepEqual(await observe(), { state: "starting" });
      const bound = await endpoint();
      assert.equal(bound.url, `wss://${hostname}:18790`);
      assert.equal(bound.tlsPeerCertificate, new X509Certificate(originalPem).toString());
      assert.equal(receipts[0]?.immutable, true);
      assert.equal(receipts[0]?.data?.podUid, originalUid);
      assert.equal(receipts[0]?.data?.deploymentUid, deploymentOwner.uid);
      assert.deepEqual(await observe(), { state: "starting" });
      pods = [{ ...original, status: { ...startup, containerStatuses: [waiting] } }];
      assert.deepEqual(await observe(), { state: "starting" });
      pods = [original];
      assert.deepEqual(await observe(), { state: "running" });
    },
  );
  const cannotRun = [
    ["missing supervisor", { containerStatuses: undefined }],
    ["waiting supervisor", { containerStatuses: [waiting] }],
    [
      "conflicting supervisor states",
      { containerStatuses: [{ ...running, state: { ...running.state, ...waiting.state } }] },
    ],
    ["duplicate supervisor statuses", { containerStatuses: [running, running] }],
    [
      "duplicate Ready conditions",
      { conditions: [...original.status.conditions, { type: "Ready", status: "False" }] },
    ],
  ] as const;
  for (const [name, status] of cannotRun) {
    await t.test(`Compute reports unknown with ${name}`, async () => {
      pods = [{ ...original, status: { ...original.status, ...status } }];
      assert.deepEqual(await observe(), { state: "unknown" });
    });
  }
  await t.test("an unavailable read cannot establish loss", async () => {
    pods = [original];
    assert.deepEqual(await observe(), { state: "running" });
    receiptReadsForbidden = true;
    assert.deepEqual(await observe(), { state: "unknown" });
    receiptReadsForbidden = false;
    podReadFailure = Object.assign(new Error("Pod list unavailable"), { statusCode: 503 });
    assert.deepEqual(await observe(), { state: "unknown" });
    podReadFailure = undefined;
    assert.deepEqual(await observe(), { state: "running" });
    assert.equal(
      (await endpoint()).tlsPeerCertificate,
      new X509Certificate(originalPem).toString(),
    );
    assert.equal(receipts.length, 1);
  });
  await t.test("a partial Pod list cannot establish loss", async () => {
    pods = [replacement];
    podListContinuation = "original-may-be-on-the-next-page";
    assert.deepEqual(await observe(), { state: "unknown" });
    podListContinuation = undefined;
  });
  await t.test(
    "a Ready Pod cannot resume the pinned execution after a supervisor restart",
    async () => {
      pods = [{ ...original, status: { ...original.status, containerStatuses: [restarted] } }];
      assert.deepEqual(await observe(), { state: "lost", code: "HARNESS_EXITED" });
    },
  );
  for (const [phase, supervisor] of [
    ["Pending", terminated],
    [
      "Running",
      { ...waiting, restartCount: 1, state: { waiting: { reason: "CrashLoopBackOff" } } },
    ],
  ] as const) {
    await t.test(`a failed supervisor is gone even while the Pod phase is ${phase}`, async () => {
      pods = [
        {
          ...original,
          status: {
            ...original.status,
            phase,
            conditions: [{ type: "Ready", status: "False" }],
            containerStatuses: [supervisor],
          },
        },
      ];
      assert.deepEqual(await observe(), { state: "lost", code: "HARNESS_EXITED" });
    });
  }
  await t.test("a Ready replacement cannot cause running or overwrite the stored pin", async () => {
    pods = [original, replacement];
    assert.deepEqual(await observe(), { state: "unknown" });
    pods = [replacement];
    assert.deepEqual(await observe(), { state: "lost", code: "SANDBOX_MISSING" });
    const bound = await endpoint();
    assert.equal(bound.tlsPeerCertificate, new X509Certificate(originalPem).toString());
    assert.equal(receipts.length, 1);
  });
  await t.test("a new Deployment with the same name is a different execution", async () => {
    pods = [original];
    deployments = [{ ...deployment, metadata: { ...deployment.metadata, uid: "deployment-b" } }];
    assert.deepEqual(await observe(), { state: "lost", code: "SANDBOX_MISSING" });
    await assert.rejects(endpoint(), /receipt ownership changed/);
    assert.equal(receipts.length, 1);
  });
});
