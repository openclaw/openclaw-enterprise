import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { dirname, join } from "node:path";
import { json } from "node:stream/consumers";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createExternalProtectedDriver,
  loadDriverPackage,
} from "../../apps/controller/src/composition/driver-packages.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type {
  AgentRevision,
  HarnessWorkloadRequirements,
  Namespace,
  SandboxHarnessContext,
} from "../../packages/contracts/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { listen } from "../helpers/listen.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const driverSource = join(root, "deploy/examples/strands-box/driver");
const packageName = "@openclaw-enterprise/example-strands-box-driver";
const id = "strands-box-demo";
const implementation = `${packageName}@0.1.0`;
const endpoint = {
  url: "wss://box-harness.pilot.svc.cluster.local:8443/",
  workspaceRoot: "/home/node/workspace",
};
const modelBaseUrl = "https://model.pilot.svc.cluster.local/v1";
const controlledMarker = "openclaw-strands-controlled-inference-v1";
const key = "OPENAI_API_KEY";
const token = "synthetic-transport-capability";
const namespace: Namespace = {
  id: "ns_pilot",
  name: "pilot",
  status: "ready",
  createdAt: new Date(0).toISOString(),
};
const revision: AgentRevision = {
  id: "rev_pilot",
  namespaceId: namespace.id,
  agentId: "agt_pilot",
  revision: 1,
  backendId: null,
  configurationId: "cfg_pilot",
  configurationKind: "agent",
  configurationGeneration: 1,
  configuration: {},
  gatewayManagedMode: false,
  harness: { id: "codex", mode: "dedicated", version: "1" },
  compute: { id: "compute-kubernetes", implementation: "kubernetes" },
  sandboxDriverId: id,
  executionAdmission: { version: 2, mode: "unprotected" },
  harnessAuth: { method: "runtime" },
  servicePrincipalId: "sp_pilot",
  createdAt: namespace.createdAt,
};

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

interface ObjectHeader {
  readonly kind: string;
  readonly metadata: { readonly name: string; readonly namespace: string };
}

function objectApi() {
  const objects = new Map<string, unknown>();
  const reads: string[] = [];
  const actions: string[] = [];
  let beforeRead: ((resource: ObjectHeader) => void) | undefined;
  let relayPods: readonly unknown[] = [];
  let endpointSlices: readonly unknown[] = [];
  const resourceKey = (resource: ObjectHeader) => `${resource.kind}/${resource.metadata.name}`;
  const notFound = () => Object.assign(new Error("Fixture object absent"), { statusCode: 404 });
  return {
    actions,
    reads,
    setBeforeRead(hook: (resource: ObjectHeader) => void) {
      beforeRead = hook;
    },
    setRelayPods(pods: readonly unknown[]) {
      relayPods = pods;
    },
    setEndpointSlices(slices: readonly unknown[]) {
      endpointSlices = slices;
    },
    get(resource: string): ObjectHeader & Record<string, unknown> {
      const value = object(structuredClone(objects.get(resource)));
      const meta = object(value.metadata);
      assert.ok(typeof value.kind === "string");
      assert.ok(typeof meta.name === "string");
      assert.ok(typeof meta.namespace === "string");
      return {
        ...value,
        kind: value.kind,
        metadata: { ...meta, name: meta.name, namespace: meta.namespace },
      };
    },
    stage(resource: ObjectHeader) {
      objects.set(resourceKey(resource), resource);
    },
    api: {
      async read(resource: ObjectHeader) {
        const name = resourceKey(resource);
        reads.push(name);
        beforeRead?.(resource);
        const observed = objects.get(name);
        if (!observed) {
          throw notFound();
        }
        return structuredClone(observed);
      },
      async create(resource: ObjectHeader) {
        const name = resourceKey(resource);
        actions.push(`create:${name}`);
        if (objects.has(name)) {
          throw Object.assign(new Error("Fixture conflict"), { statusCode: 409 });
        }
        const created = {
          ...resource,
          metadata: { ...resource.metadata, uid: randomUUID(), resourceVersion: "1" },
        };
        objects.set(name, created);
        return structuredClone(created);
      },
      async list(version: string, kind: string, scope: string, ...options: unknown[]) {
        assert.equal(scope, namespace.name);
        if (kind === "EndpointSlice") {
          assert.equal(version, "discovery.k8s.io/v1");
          assert.equal(options.at(-1), "kubernetes.io/service-name=box-harness");
          return { items: endpointSlices };
        }
        assert.equal(version, "v1");
        assert.equal(kind, "Pod");
        assert.ok(
          [
            "app.kubernetes.io/name=box-harness-relay,box.openclaw.dev/installation=pilot",
            "app.kubernetes.io/name=box-harness-relay,box.openclaw.dev/installation=pilot,openclaw.dev/namespace=ns_pilot",
          ].includes(String(options.at(-1))),
        );
        return { items: relayPods };
      },
      async delete(resource: ObjectHeader, ...options: unknown[]) {
        const name = resourceKey(resource);
        actions.push(`delete:${name}`);
        const observed = objects.get(name);
        if (!observed) {
          throw notFound();
        }
        const actual = object(object(observed).metadata);
        assert.deepEqual(object(options.at(-1)).preconditions, {
          uid: actual.uid,
          resourceVersion: actual.resourceVersion,
        });
        objects.delete(name);
      },
    },
  };
}

async function fixture(t: TestContext) {
  const directory = await temporaryDirectory(t, "strands-driver-");
  const packageRoot = join(directory, "controller");
  const scope = join(packageRoot, "node_modules/@openclaw-enterprise");
  const installed = join(scope, "example-strands-box-driver");
  const socket = join(directory, "control.sock");
  await mkdir(installed, { recursive: true });
  await cp(join(driverSource, "package.json"), join(installed, "package.json"));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ dependencies: { [packageName]: "0.1.0" } }),
  );
  for (const peer of ["occ", "utils", "contracts"]) {
    await symlink(join(root, "packages", peer), join(scope, peer), "dir");
  }
  execFileSync(process.execPath, [join(driverSource, "build.ts"), join(installed, "dist")], {
    cwd: root,
  });
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=Strands Box conformance CA",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "ca.key"),
      "-out",
      join(directory, "ca.pem"),
    ],
    { stdio: "ignore" },
  );
  const ca = await readFile(join(directory, "ca.pem"), "utf8");
  const configuration = {
    namespace: namespace.name,
    controlSocket: socket,
    nativeEndpoint: endpoint.url,
    nativeCaBundle: ca,
    workspaceRoot: endpoint.workspaceRoot,
    controlledInference: { modelBaseUrl },
    relay: {
      image: `registry.example/relay@sha256:${"f".repeat(64)}`,
      hostAddress: "10.0.0.7",
      installation: "pilot",
      workerPeer: { namespace: "control", podLabels: { app: "worker" } },
    },
  };
  const loaded = await loadDriverPackage({ package: packageName }, "sandbox", packageRoot, false);
  assert.ok(loaded);
  assert.equal(loaded.implementation, implementation);
  assert.deepEqual(loaded.module.validateConfiguration?.(configuration), []);
  const selection = { id, implementation, configuration, definition: loaded.module };
  const base = createInstallationDriverConfiguration();
  const stock = base.drivers.compute.configuration;
  const installationPath = join(packageRoot, "installation.yaml");
  await writeFile(
    installationPath,
    JSON.stringify({
      ...base,
      drivers: {
        ...base.drivers,
        sandbox: { id, package: packageName, configuration },
        compute: {
          ...base.drivers.compute,
          configuration: {
            ...stock,
            servicePrincipalCredentials: { mode: "disabled" },
            network: {
              ...stock.network,
              providerHarness: {
                namespace: namespace.name,
                address: "10.1.1.1",
                port: 8443,
                podLabels: {
                  "app.kubernetes.io/name": "box-harness-relay",
                  "box.openclaw.dev/installation": "pilot",
                },
              },
            },
            runtime: {
              ...stock.runtime,
              modelProvider: { protocol: "openai-responses", baseUrl: modelBaseUrl },
            },
          },
        },
      },
    }),
  );
  const composition = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: installationPath },
    packageRoot,
  });
  const driver = composition?.sandboxDriver;
  assert.ok(driver);
  assert.equal(driver.implementation, implementation);
  assert.equal(composition.protectedDriver, undefined);
  assert.equal(composition.computeDriver.id, "compute-kubernetes");
  assert.equal(driver.validateWorkspaceSetup, undefined);
  const requests: { method: string; body: Record<string, unknown> | undefined }[] = [];
  let execution: Record<string, unknown> | undefined;
  let pending: Record<string, unknown> | undefined;
  let approved = true;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const method = request.method ?? "";
      assert.equal(request.url, method === "POST" ? "/v1/admission" : "/v1/execution");
      const body =
        chunks.length === 0
          ? undefined
          : object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requests.push({ method, body });
      const json = (status: number, value?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(value === undefined ? "" : JSON.stringify(value));
      };
      if (method === "GET") {
        json(execution ? 200 : 404, execution);
      } else if (method === "POST" && body) {
        assert.deepEqual(Object.keys(body).sort(), ["owner", "requirements", "requirementsDigest"]);
        if (pending && body.requirementsDigest !== pending.requirementsDigest) {
          json(409);
          return;
        }
        pending = body;
        json(200, {
          state: approved ? "approved" : "held",
          owner: body.owner,
          requirementsDigest: body.requirementsDigest,
        });
      } else if (method === "PUT" && body) {
        assert.equal(execution, undefined, "fixture host permits one execution only");
        assert.ok(approved && pending);
        assert.deepEqual(body.owner, pending.owner);
        assert.equal(body.requirementsDigest, pending.requirementsDigest);
        assert.deepEqual(body.requirements, pending.requirements);
        execution = {
          owner: body.owner,
          requirementsDigest: body.requirementsDigest,
          executionId: "execution-fixture",
          state: "running",
          endpoint,
        };
        json(202, execution);
      } else if (method === "DELETE" && body && execution) {
        assert.deepEqual(body, {
          owner: execution.owner,
          executionId: execution.executionId,
          requirementsDigest: execution.requirementsDigest,
        });
        execution = undefined;
        json(204);
      } else {
        json(409);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await chmod(socket, 0o600);
  const kube = objectApi();
  const setupCode = `oc-pair://${Buffer.from(
    JSON.stringify({
      url: "wss://gateway.pilot.svc.cluster.local/",
      bootstrapToken: "synthetic-pairing-capability",
      expiresAtMs: Date.now() + 60_000,
    }),
  ).toString("base64url")}`;
  const secret = (name: string, data: Record<string, string>) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace: namespace.name,
      labels: {
        "openclaw.dev/namespace": namespace.id,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
      },
    },
    data: Object.fromEntries(
      Object.entries(data).map(([entry, value]) => [entry, Buffer.from(value).toString("base64")]),
    ),
  });
  kube.stage(secret("node-setup", { setupCode }));
  const stageModel = (value: string) => kube.stage(secret("admitted-harness", { [key]: value }));
  stageModel(controlledMarker);
  const requirements: HarnessWorkloadRequirements = {
    image: `registry.example/runtime@sha256:${"e".repeat(64)}`,
    command: ["/usr/bin/tini", "-s", "-e", "143", "--", "node", "-e", "stock fixture command"],
    workspaceMounts: [
      {
        claimName: "workspace",
        subPath: "workspace",
        mountPath: endpoint.workspaceRoot,
        readOnly: false,
      },
    ],
    environment: [
      { name: "APP_TOKEN_SHA", value: createHash("sha256").update(token).digest("hex") },
      { name: key, valueFrom: { secretKeyRef: { name: "admitted-harness", key } } },
      {
        name: "OPENCLAW_NODE_SETUP_CODE",
        valueFrom: { secretKeyRef: { name: "node-setup", key: "setupCode" } },
      },
    ],
    files: [
      {
        name: "runtime.json",
        environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
        content: JSON.stringify({ modelEndpoint: { baseUrl: modelBaseUrl } }),
      },
    ],
    credentialAttachments: [],
    loginMode: "api_key",
    labels: {
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/workload-role": "agent",
      "openclaw.dev/network-profile": "provider-fenced-v1",
    },
  };
  const context: SandboxHarnessContext = {
    namespace,
    revision,
    requirements,
    kubernetes: kube.api,
    signal: new AbortController().signal,
  };
  return {
    ca,
    context,
    driver,
    kube,
    loaded,
    selection,
    requests,
    setupCode,
    stageModel,
    certKey: join(directory, "ca.key"),
    nativeModule: pathToFileURL(join(installed, "dist/native.js")).href,
    holdApproval() {
      approved = false;
    },
    approve() {
      assert.ok(pending);
      approved = true;
    },
    replaceExecution() {
      execution = { ...execution, executionId: "replacement" };
    },
    startForeignExecution() {
      execution = {
        owner: {
          driverId: id,
          implementation,
          namespaceId: namespace.id,
          namespaceName: namespace.name,
          agentId: "agt_other",
          revisionId: "rev_other",
        },
        executionId: "foreign-execution",
        requirementsDigest: "a".repeat(64),
        state: "running",
        endpoint,
      };
    },
  };
}

function servingRelay(kube: ReturnType<typeof objectApi>, name: string) {
  const deployment = kube.get(`Deployment/${name}`);
  const deploymentMeta = object(deployment.metadata);
  const template = object(object(deployment.spec).template);
  const templateMeta = object(template.metadata);
  const labels = { ...object(templateMeta.labels), "pod-template-hash": "fixturehash" };
  const ownerReference = (apiVersion: string, kind: string, name: string, uid: unknown) => ({
    apiVersion,
    kind,
    name,
    uid,
    controller: true,
  });
  const metadata = (name: string, uid: string) => ({
    name,
    namespace: namespace.name,
    uid,
    resourceVersion: "1",
  });
  const replicaSet = {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: {
      ...metadata(`${name}-fixturehash`, "relay-replicaset-uid"),
      labels,
      ownerReferences: [ownerReference("apps/v1", "Deployment", name, deploymentMeta.uid)],
    },
    spec: { template: { ...template, metadata: { ...templateMeta, labels } } },
  };
  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata("box-harness", "relay-service-uid"),
    spec: {
      type: "ClusterIP",
      clusterIP: "10.1.1.1",
      clusterIPs: ["10.1.1.1"],
      selector: {
        "app.kubernetes.io/name": "box-harness-relay",
        "box.openclaw.dev/installation": "pilot",
      },
      ports: [{ name: "native-wss", protocol: "TCP", port: 8443, targetPort: 8443 }],
    },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...metadata(`${name}-fixturehash-pod`, "relay-pod-uid"),
      labels,
      annotations: templateMeta.annotations,
      ownerReferences: [
        ownerReference("apps/v1", "ReplicaSet", replicaSet.metadata.name, replicaSet.metadata.uid),
      ],
    },
    spec: { ...object(template.spec), nodeName: "fixture-node" },
    status: {
      phase: "Running",
      podIP: "10.2.3.4",
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
  const slice = {
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: {
      ...metadata("box-harness-fixture", "relay-slice-uid"),
      labels: { "kubernetes.io/service-name": service.metadata.name },
      ownerReferences: [
        ownerReference("v1", "Service", service.metadata.name, service.metadata.uid),
      ],
    },
    addressType: "IPv4",
    ports: [{ name: "native-wss", protocol: "TCP", port: 8443 }],
    endpoints: [
      {
        addresses: [pod.status.podIP],
        conditions: { ready: true, serving: true, terminating: false },
        targetRef: {
          kind: "Pod",
          name: pod.metadata.name,
          namespace: namespace.name,
          uid: pod.metadata.uid,
        },
      },
    ],
  };
  kube.stage({
    ...deployment,
    metadata: { ...deployment.metadata, generation: 1 },
    status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1 },
  } as ObjectHeader);
  kube.stage(replicaSet);
  kube.stage(service);
  kube.setRelayPods([pod]);
  kube.setEndpointSlices([slice]);
  return { deployment, replicaSet, pod, service, slice };
}

test(
  "the installed Strands Box package preserves the admitted workload and binds the current relay",
  { timeout: 30_000 },
  async (t) => {
    const x = await fixture(t);
    assert.ok(x.driver.provisionHarness && x.driver.harnessEndpoint && x.driver.harnessStatus);
    const ref = await x.driver.provisionHarness(x.context);
    assert.equal(ref.revisionId, revision.id);
    assert.deepEqual(
      x.requests.map(({ method }) => method),
      ["GET", "POST", "GET", "PUT", "GET"],
    );
    const put = x.requests.find(({ method }) => method === "PUT")?.body;
    assert.ok(put);
    assert.deepEqual(put.requirements, x.context.requirements);
    const keys = new Set<string>();
    JSON.stringify(x.context.requirements, (property, value: unknown) => {
      keys.add(property);
      return value;
    });
    const sorted = JSON.stringify(x.context.requirements, Array.from(keys).sort());
    assert.equal(put.requirementsDigest, createHash("sha256").update(sorted).digest("hex"));
    assert.deepEqual(put.owner, {
      driverId: id,
      implementation,
      namespaceId: namespace.id,
      namespaceName: namespace.name,
      agentId: revision.agentId,
      revisionId: revision.id,
    });
    assert.equal(put.workspaceNodeSetupCode, x.setupCode);
    assert.equal(put.controlledInference, true);
    assert.ok(!JSON.stringify(put).includes(controlledMarker));
    assert.ok(!JSON.stringify(put).includes(token));
    assert.deepEqual(
      x.kube.actions.map((action) => action.split("/")[0]),
      ["create:NetworkPolicy", "create:ConfigMap", "create:Deployment"],
    );
    const activation = {
      ...x.context,
      requirements: {
        ...x.context.requirements,
        environment: x.context.requirements.environment.slice(0, 1),
      },
    };
    servingRelay(x.kube, ref.resourceName);
    assert.deepEqual(await x.driver.harnessEndpoint(activation), {
      ...endpoint,
      tls: { caBundle: x.ca },
    });
    const beforeRefusal = x.requests.length;
    await assert.rejects(
      x.driver.harnessStatus({ ...x.context, transportToken: "different-capability" }),
      /does not match/,
    );
    assert.equal(
      x.requests.length,
      beforeRefusal,
      "a copied or wrong capability never reaches the endpoint",
    );
    await x.driver.provisionHarness(x.context);
    assert.equal(x.requests.filter(({ method }) => method === "PUT").length, 1);
    assert.equal(x.kube.reads.filter((read) => read === "Secret/node-setup").length, 1);
    x.replaceExecution();
    await assert.rejects(
      x.driver.harnessEndpoint(x.context),
      /relay does not name the current execution/,
    );
  },
);

async function routeReadbackClient(t: TestContext, x: Awaited<ReturnType<typeof fixture>>) {
  const groups = {
    "/api/v1": { services: "Service", configmaps: "ConfigMap", pods: "Pod", secrets: "Secret" },
    "/apis/apps/v1": { deployments: "Deployment", replicasets: "ReplicaSet" },
    "/apis/networking.k8s.io/v1": { networkpolicies: "NetworkPolicy" },
    "/apis/discovery.k8s.io/v1": { endpointslices: "EndpointSlice" },
  };
  const server = createHttpsServer(
    { key: await readFile(x.certKey), cert: x.ca },
    async (request, response) => {
      const respond = (status: number, payload: unknown) =>
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(payload));
      if (
        (request.method !== "GET" && request.method !== "POST") ||
        request.headers.authorization !== "Bearer fixture-kubernetes-worker"
      ) {
        respond(403, { kind: "Status", status: "Failure", reason: "Forbidden" });
        return;
      }
      const url = new URL(request.url!, "https://127.0.0.1/");
      for (const [group, kinds] of Object.entries(groups)) {
        if (url.pathname === group) {
          respond(200, {
            apiVersion: "v1",
            kind: "APIResourceList",
            groupVersion: group.replace(/^\/apis?\//, ""),
            resources: Object.entries(kinds).map(([name, kind]) => ({
              name,
              kind,
              namespaced: true,
              singularName: kind.toLowerCase(),
              verbs: ["get", "list"],
            })),
          });
          return;
        }
        const prefix = `${group}/namespaces/${namespace.name}/`;
        if (!url.pathname.startsWith(prefix)) {
          continue;
        }
        const [resource, name] = url.pathname.slice(prefix.length).split("/");
        const kind = Object.entries(kinds).find(([key]) => key === resource)?.[1];
        if (!kind) {
          break;
        }
        const apiVersion = group.replace(/^\/apis?\//, "");
        try {
          if (request.method === "POST") {
            assert.equal(name, undefined);
            const body = (await json(request)) as ObjectHeader;
            assert.equal(body.kind, kind);
            respond(201, await x.kube.api.create(body));
          } else if (name) {
            const result = await x.kube.api.read({
              kind,
              metadata: { name, namespace: namespace.name },
            });
            respond(200, result);
          } else {
            const selector = url.searchParams.get("labelSelector");
            const result = await x.kube.api.list(apiVersion, kind, namespace.name, selector);
            respond(200, {
              apiVersion,
              kind: `${kind}List`,
              items: result.items.map((value) => {
                const { apiVersion: _apiVersion, kind: _kind, ...item } = object(value);
                return item;
              }),
            });
          }
        } catch (error) {
          const status = object(error).statusCode === 403 ? 403 : 404;
          respond(status, {
            kind: "Status",
            status: "Failure",
            reason: status === 403 ? "Forbidden" : "NotFound",
          });
        }
        return;
      }
      respond(404, { kind: "Status", status: "Failure", reason: "NotFound" });
    },
  );
  const port: number = await listen(t, server);
  const kubeconfigPath = join(dirname(x.certKey), "relay-kubeconfig.json");
  await writeFile(
    kubeconfigPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      "current-context": "fixture",
      clusters: [
        {
          name: "fixture",
          cluster: {
            server: `https://127.0.0.1:${port}`,
            "certificate-authority-data": Buffer.from(x.ca).toString("base64"),
          },
        },
      ],
      contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
      users: [{ name: "fixture", user: { token: "fixture-kubernetes-worker" } }],
    }),
    { mode: 0o600 },
  );
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    { mode: "kubeconfig", kubeconfigPath, context: "fixture" },
    (message) => new Error(message),
  );
  return new sdk.KubernetesObjectApi(clientConfiguration);
}

test(
  "a running Box cannot serve through a modified relay template or a foreign Service-selected Pod",
  { timeout: 30_000 },
  async (t) => {
    const x = await fixture(t);
    assert.ok(x.driver.provisionHarness && x.driver.harnessEndpoint);
    const context = { ...x.context, kubernetes: await routeReadbackClient(t, x) };
    const { resourceName } = await x.driver.provisionHarness(context);
    const observed = servingRelay(x.kube, resourceName);
    const postedPolicy = x.kube.get(`NetworkPolicy/${resourceName}`);
    const ingress = object(postedPolicy.spec).ingress;
    assert.ok(Array.isArray(ingress) && ingress.length === 1);
    const ingressRule = object(ingress[0]);
    assert.equal(Object.hasOwn(ingressRule, "_from"), false);
    assert.deepEqual(ingressRule.from, [
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace.name } },
        podSelector: {
          matchLabels: {
            "openclaw.dev/namespace": namespace.id,
            "openclaw.dev/agent": revision.agentId,
            "openclaw.dev/revision": revision.id,
            "openclaw.dev/workload-role": "gateway",
          },
        },
      },
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "control" } },
        podSelector: { matchLabels: { app: "worker" } },
      },
    ]);
    const original = x.kube.get(`Deployment/${resourceName}`);
    assert.equal((await x.driver.harnessEndpoint(context)).url, endpoint.url);
    x.kube.setBeforeRead(({ kind }) => {
      if (kind === "ReplicaSet") {
        throw Object.assign(new Error("Fixture denies ReplicaSet get"), { statusCode: 403 });
      }
    });
    await assert.rejects(
      x.driver.harnessEndpoint(context),
      /did not confirm the exact Strands Box object/,
    );
    x.kube.setBeforeRead(() => {});
    const drifted = structuredClone(original);
    const spec = object(object(object(drifted).spec).template).spec;
    const containers = object(spec).containers;
    assert.ok(Array.isArray(containers));
    const env = object(containers[0]).env;
    assert.ok(Array.isArray(env));
    const upstream = env.find(
      (value: unknown) => object(value).name === "BOX_RELAY_UPSTREAM_ADDRESS",
    );
    assert.ok(upstream);
    object(upstream).value = "10.0.0.99";
    x.kube.stage(drifted);
    await assert.rejects(x.driver.harnessEndpoint(context), /network route has changed/);
    x.kube.stage(original);
    assert.equal((await x.driver.harnessEndpoint(context)).url, endpoint.url);
    x.kube.setRelayPods([
      observed.pod,
      {
        ...observed.pod,
        metadata: {
          ...observed.pod.metadata,
          name: "foreign-pod",
          uid: "foreign-pod-uid",
          labels: observed.service.spec.selector,
          ownerReferences: [],
        },
      },
    ]);
    await assert.rejects(x.driver.harnessEndpoint(context), /network route has changed/);
    x.kube.setRelayPods([observed.pod]);
    x.kube.setEndpointSlices([
      {
        ...observed.slice,
        endpoints: observed.slice.endpoints.map((selected) => ({
          ...selected,
          targetRef: { ...selected.targetRef, uid: "foreign-pod-uid" },
        })),
      },
    ]);
    await assert.rejects(x.driver.harnessEndpoint(context), /network route has changed/);
  },
);

test(
  "controlled inference refuses arbitrary Secret material before starting the Box",
  { timeout: 30_000 },
  async (t) => {
    const x = await fixture(t);
    assert.ok(x.driver.provisionHarness);
    x.stageModel("synthetic-unapproved-material");
    await assert.rejects(x.driver.provisionHarness(x.context), /exact non-authorizing marker/);
    assert.deepEqual(
      x.requests.map(({ method }) => method),
      ["GET", "POST"],
    );
    assert.ok(!x.kube.reads.includes("Secret/node-setup"));
    assert.deepEqual(x.kube.actions, []);
    assert.throws(
      () => createExternalProtectedDriver(x.loaded.module, x.selection),
      /one Driver registration/,
    );
  },
);

test(
  "an intervening owner change prevents one-shot setup delivery and relay creation",
  { timeout: 30_000 },
  async (t) => {
    const x = await fixture(t);
    assert.ok(x.driver.provisionHarness);
    x.kube.setBeforeRead((resource) => {
      if (resource.kind === "Secret" && resource.metadata.name === "node-setup") {
        x.startForeignExecution();
      }
    });
    await assert.rejects(x.driver.provisionHarness(x.context), /different admitted inputs/);
    assert.deepEqual(
      x.requests.map(({ method }) => method),
      ["GET", "POST", "GET"],
    );
    assert.deepEqual(x.kube.actions, []);
  },
);

test(
  "the held Worker payload can only launch after approval of its unchanged digest",
  { timeout: 30_000 },
  async (t) => {
    const x = await fixture(t);
    assert.ok(x.driver.provisionHarness);
    x.holdApproval();
    await assert.rejects(x.driver.provisionHarness(x.context), {
      name: "TransientDependencyError",
      message: /waiting for operator approval/,
    });
    assert.deepEqual(
      x.requests.map(({ method }) => method),
      ["GET", "POST"],
    );
    assert.deepEqual(x.kube.reads, []);
    assert.deepEqual(x.kube.actions, []);
    x.approve();
    const drifted = {
      ...x.context,
      requirements: {
        ...x.context.requirements,
        command: [...x.context.requirements.command, "drift"],
      },
    };
    await assert.rejects(
      x.driver.provisionHarness(drifted),
      /did not confirm the exact pending workload/,
    );
    assert.deepEqual(x.kube.reads, []);
    assert.deepEqual(x.kube.actions, []);
    await x.driver.provisionHarness(x.context);
    assert.equal(x.requests.filter(({ method }) => method === "PUT").length, 1);
    assert.equal(x.kube.reads.filter((read) => read === "Secret/node-setup").length, 1);
  },
);

test(
  "cleanup removes the exact relay before retiring its Box and observes absence",
  { timeout: 30_000 },
  async (t) => {
    const x = await fixture(t);
    assert.ok(x.driver.provisionHarness);
    await x.driver.provisionHarness(x.context);
    x.kube.setRelayPods([{ metadata: { name: "still-terminating" } }]);
    await assert.rejects(x.driver.cleanup(x.context), /relay Pods are still present/);
    assert.equal(x.requests.filter(({ method }) => method === "DELETE").length, 0);
    x.kube.setRelayPods([]);
    await x.driver.cleanup(x.context);
    assert.deepEqual(
      x.requests.slice(-3).map(({ method }) => method),
      ["GET", "DELETE", "GET"],
    );
    assert.deepEqual(
      x.kube.actions.slice(-3).map((action) => action.split("/")[0]),
      ["delete:Deployment", "delete:ConfigMap", "delete:NetworkPolicy"],
    );
  },
);

test(
  "readiness requires a valid authenticated WebSocket upgrade over the pinned CA",
  { timeout: 30_000 },
  async (t) => {
    const x = await fixture(t);
    const module: unknown = await import(x.nativeModule);
    const exported = object(module).nativeStatus;
    assert.equal(typeof exported, "function");
    const probe = exported as (
      url: string,
      ca: string,
      token: string,
      signal: AbortSignal,
    ) => Promise<unknown>;
    const server = createHttpsServer({ key: await readFile(x.certKey), cert: x.ca });
    const observations: boolean[] = [];
    server.on("upgrade", (request, socket) => {
      const authorized = request.headers.authorization === `Bearer ${token}`;
      observations.push(authorized);
      if (!authorized) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const challenge = request.headers["sec-websocket-key"];
      assert.equal(typeof challenge, "string");
      const accept = createHash("sha1")
        .update(challenge + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.once("data", () => socket.end());
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `wss://127.0.0.1:${address.port}/`;
    assert.deepEqual(await probe(url, x.ca, "wrong-token", x.context.signal), {
      state: "starting",
    });
    assert.deepEqual(await probe(url, x.ca, token, x.context.signal), { state: "serving" });
    assert.deepEqual(observations, [false, true]);
  },
);
