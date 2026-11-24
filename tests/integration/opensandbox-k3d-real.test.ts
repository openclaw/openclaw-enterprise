import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import test from "node:test";

import type {
  AgentDeploymentStatusResponse,
  AgentReadResponse,
  AgentResponse,
  AgentRevisionResponse,
  ConfigurationResponse,
  NamespaceListResponse,
  SecretResponse,
  WorkspaceFileResponse,
  WorkspaceFileUpdateResponse,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";
import {
  createHarnessConfiguration,
  nativeAdminGatewayAuth,
} from "../helpers/harness-configuration.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import {
  agentName,
  fixtureComputeConfiguration,
  gatewayName,
  harnessWorkspaceClaimName,
  revisionName,
} from "../helpers/kubernetes-compute-real.mjs";
import {
  createRealKubernetesFixture,
  createKubernetesInstallationConfiguration,
  productionGatewayMemoryLimit,
  explicitK3dSelection,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.ts";
import {
  interruptLifecycleResponses,
  replaceListedSandbox,
} from "../helpers/opensandbox-lifecycle-faults.ts";

const selected = process.env.OCC_TEST_OPENSANDBOX_K3D_REAL === "1";
const sandboxResource = "batchsandboxes.sandbox.opensandbox.io";
const packageName = "@openclaw-enterprise/opensandbox-driver";

function required(name: string) {
  const value = process.env[name];
  assert.ok(value, "Missing " + name);
  return value;
}

function row(value: unknown) {
  const record = asRecord(value);
  assert.ok(record, "Expected a Kubernetes object");
  return record;
}

function list(value: unknown) {
  assert.ok(Array.isArray(value), "Expected a Kubernetes list");
  return value.map(row);
}

function metadata(value: unknown) {
  return row(row(value).metadata);
}

function kubeName(value: unknown) {
  const name = metadata(value).name;
  assert.ok(typeof name === "string" && name.length > 0);
  return name;
}

function kubeUid(value: unknown) {
  const uid = metadata(value).uid;
  assert.ok(typeof uid === "string" && uid.length > 0);
  return uid;
}

const initialize = String.raw`
const WebSocket = require("ws");
const url = process.env.APP_SERVER_URL;
const token = process.env.APP_SERVER_TOKEN;
if (!url || !token) throw Error("Missing Gateway transport");
function probe(authorization) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: authorization ? { authorization } : {} });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(Error("Timed out initializing Codex"));
    }, 5000);
    function finish(value) {
      clearTimeout(timer);
      socket.terminate();
      resolve(value);
    }
    socket.on("error", () => {
      clearTimeout(timer);
      reject(Error("Codex transport failed"));
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode);
    });
    socket.on("open", () => socket.send(JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex_app_server_daemon", version: "1.0.0" } },
    })));
    socket.on("message", (data) => {
      const message = JSON.parse(data);
      if (message.id === 1) finish(message.result?.userAgent ? "initialized" : "invalid");
    });
  });
}
(async () => {
  const missing = await probe(undefined);
  const wrong = await probe("Bearer " + require("node:crypto").randomUUID());
  const correct = await probe("Bearer " + token);
  process.stdout.write(JSON.stringify({ missing, wrong, correct }));
})().catch(() => { process.stderr.write("Codex socket proof failed"); process.exitCode = 1; });
`;

test(
  "OpenSandbox operator runs and retires a real dedicated Codex Agent",
  { skip: selected ? false : "Select the OpenSandbox k3d lane.", timeout: 900_000 },
  async (t) => {
    const { context } = boundedTeardown(t, { label: "OpenSandbox integration teardown" });
    const selection = explicitK3dSelection();
    const selectedConfig = await validateExplicitK3dLoopbackContext(selection);
    assert.notEqual(selectedConfig.clusters[0].cluster["insecure-skip-tls-verify"], true);

    const databaseUrl = required("OCC_TEST_DATABASE_URL");
    const database = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
    assert.match(database.pathname, /^\/openclaw_k8s_[a-z0-9_]+$/);
    const runtimeImage = required("OCC_TEST_KUBERNETES_RUNTIME_IMAGE");
    assert.match(runtimeImage, /^\S+@sha256:[a-f0-9]{64}$/u);
    const packageRoot = required("OCC_TEST_OPENSANDBOX_PACKAGE_ROOT");
    const model = required("OCC_TEST_OPENAI_MODEL").replace(/^(?:openai|codex)\//u, "");
    const modelPlaceholder = required("OCC_TEST_OPENSANDBOX_MODEL_PLACEHOLDER");
    assert.match(
      modelPlaceholder,
      /^oce-fixture-[a-f0-9]{64}$/u,
      "Only a generated fixture bearer may enter the Harness",
    );
    const modelEndpoint = new URL(required("OCC_TEST_CODEX_OPENAI_BASE_URL"));
    assert.equal(modelEndpoint.protocol, "https:");
    assert.equal(modelEndpoint.pathname, "/v1");
    assert.equal(
      [
        modelEndpoint.username,
        modelEndpoint.password,
        modelEndpoint.search,
        modelEndpoint.hash,
      ].join(""),
      "",
    );
    const modelCaPath = process.env.OCC_TEST_OPENSANDBOX_MODEL_CA_PATH;
    const modelSenderCaPem = modelCaPath ? await readFile(modelCaPath, "utf8") : undefined;
    const modelPort = Number(modelEndpoint.port || "443");
    assert.equal(isIP(modelEndpoint.hostname), 4);
    const gatewayApiKeyPath = required("OCC_GATEWAY_API_KEY_PATH");
    const gatewayCaPath = required("NODE_EXTRA_CA_CERTS");
    const routing = row(
      JSON.parse(await readFile(required("OCC_TEST_OPENSANDBOX_ROUTING_FILE"), "utf8")),
    );
    const gatewayRouting = row(routing.gatewayRouting);
    const gatewayTrustedProxyCidrs = routing.gatewayTrustedProxyCidrs;
    assert.ok(Array.isArray(gatewayTrustedProxyCidrs) && gatewayTrustedProxyCidrs.length > 0);
    assert.equal(
      gatewayTrustedProxyCidrs.every((cidr) => typeof cidr === "string"),
      true,
    );

    const kube = createRealKubernetesFixture(selection);
    // The fixture requires an installed operator. A missing CRD fails a selected run.
    async function resources(kind: string, namespace: string, ...selectors: string[]) {
      const items = await kube.resources(kind, namespace, ...selectors);
      assert.ok(items, "Kubernetes returned an invalid or incomplete resource list");
      return items;
    }
    const crd = row(await kube.resource("crd", sandboxResource));
    assert.ok(
      list(row(crd.status).conditions).some(
        ({ type, status }) => type === "Established" && status === "True",
      ),
    );

    const [
      { default: pg },
      { PostgresPlatformState },
      { composePostgresDevelopment },
      { loadInstallationConfiguration },
      { createControllerWorker },
      { KubernetesComputeDriver, kubernetesNamespaceName },
    ] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../apps/controller/src/composition/development-postgres.ts"),
      import("../../apps/controller/src/composition/installation-config.ts"),
      import("../../apps/controller/src/worker.ts"),
      import("../../apps/controller/src/drivers/compute/kubernetes/index.ts"),
    ]);
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    context.after(() => pool.end());
    assert.equal(
      await new PostgresPlatformState(pool).loadInstallation(),
      undefined,
      "Use a fresh migrated test database",
    );

    const nonce = randomUUID();
    const credentials = { email: "opensandbox-integration@example.test", password: randomUUID() };
    const authSecret = randomUUID();
    const authBaseURL = "https://console.oce.localhost";
    const bootstrap = await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      ...credentials,
      authSecret,
      authBaseURL,
      agentDomain: "agents.oce.localhost",
      installationName: "OpenSandbox k3d integration",
    });
    const installation = createInstallationDriverConfiguration();
    const authentication = {
      mode: "kubeconfig",
      kubeconfigPath: required("OCC_TEST_KUBERNETES_KUBECONFIG"),
      context: required("OCC_TEST_KUBERNETES_CONTEXT"),
    };
    const nodes = list(row(JSON.parse(await kube.kubectl("get", "nodes", "-o", "json"))).items);
    const [node] = nodes;
    assert.equal(nodes.length, 1, "Select an owned single-node disposable cluster");
    const seccomp = process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE;
    // Use the real runtime's resource budget. The small HTTP fixture cannot size a Gateway.
    const { resources: runtimeResources } = createKubernetesInstallationConfiguration({
      authentication: { ...authentication, mode: "kubeconfig" },
      platformNamespace: String(gatewayRouting.gatewayNamespace),
      gatewayImage: runtimeImage,
      codexImage: runtimeImage,
      cluster: "opensandbox-k3d",
    }).drivers.compute.configuration;
    runtimeResources.gateway.limits.memory = productionGatewayMemoryLimit;
    runtimeResources.namespace.containerDefaults = runtimeResources.agent;
    const quota = {
      pods: "12",
      "requests.cpu": "3",
      "requests.memory": "4Gi",
      "limits.cpu": "16",
      "limits.memory": "16Gi",
    };
    runtimeResources.namespace.quota = quota;
    const compute = row(fixtureComputeConfiguration({}));
    const { gatewayClients: _gatewayClients, ...fixtureNetwork } = row(compute.network);
    const configuration = {
      ...installation,
      drivers: {
        ...installation.drivers,
        configuration: { ...installation.drivers.configuration, configuration: { authentication } },
        secret: { ...installation.drivers.secret, configuration: { authentication } },
        compute: {
          ...installation.drivers.compute,
          configuration: {
            ...compute,
            authentication,
            gatewayRouting,
            network: { ...fixtureNetwork, gatewayTrustedProxyCidrs },
            images: { gateway: runtimeImage, agent: runtimeImage, requireImmutableDigest: true },
            resources: runtimeResources,
            runtime: {
              transportSecretPrefix: "openclaw-agent-transport",
              gatewayStorageClassName: "local-path",
              gatewayNodeSelector: { "kubernetes.io/hostname": kubeName(node) },
              modelProvider: { protocol: "openai-responses", baseUrl: modelEndpoint.href },
              ...(seccomp ? { codexSeccompProfile: seccomp } : {}),
            },
          },
        },
        sandbox: {
          id: "opensandbox",
          package: packageName,
          configuration: {
            ...(seccomp ? { codexSeccompProfile: seccomp } : {}),
            ...(modelSenderCaPem === undefined ? {} : { modelSenderCaPem }),
          },
        },
      },
    };
    async function loadDrivers() {
      const drivers = await loadInstallationConfiguration({
        mode: "development",
        environment: {
          OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
          OCC_GATEWAY_CA_PATH: gatewayCaPath,
        },
        startupConfiguration: { configuration, logging: { level: "info" } },
        packageRoot,
      });
      assert.ok(drivers);
      assert.equal(drivers.sandboxDriver?.implementation, packageName + "@0.1.0");
      return drivers;
    }

    const app = await composePostgresDevelopment(
      {
        mode: "development",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
        gatewayApiKeyPath,
        nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
      },
      await loadDrivers(),
    );
    context.after(() => app.close());
    const session = await signInToControllerApp(app, credentials);
    function request(
      method: "GET" | "POST" | "PUT" | "DELETE",
      url: string,
      payload?: Record<string, unknown>,
    ) {
      return app.inject({
        method,
        url,
        headers: {
          ...authenticatedHeaders(session),
          origin: authBaseURL,
          host: new URL(authBaseURL).host,
        },
        ...(payload === undefined ? {} : { payload }),
      });
    }
    async function admitted<T extends { data: unknown }>(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      status: number,
      payload?: Record<string, unknown>,
    ): Promise<T["data"]> {
      const response = await request(method, path, payload);
      assert.equal(response.statusCode, status, method + " " + path);
      return response.json<T>().data;
    }
    const namespaces = await admitted<NamespaceListResponse>("GET", "/namespaces", 200);
    const tenant = namespaces.find(({ name }) => name === "default");
    assert.ok(tenant, "Fresh bootstrap must create the default Namespace");
    const placement = kubernetesNamespaceName(tenant.id);
    context.after(async () => {
      // The worker shuts down before deleting the uniquely bound Namespace.
      const raw = await kube.kubectl(
        "get",
        "namespace",
        placement,
        "-o",
        "json",
        "--ignore-not-found",
      );
      if (raw.trim() !== "") {
        assert.equal(row(metadata(JSON.parse(raw)).labels)["openclaw.dev/namespace"], tenant.id);
        await kube.kubectl("delete", "namespace", placement, "--wait=true", "--timeout=120s");
      }
    });
    const workerDrivers = await loadDrivers();
    const worker = createControllerWorker({
      drivers: workerDrivers,
      pool: new pg.Pool({ connectionString: databaseUrl, max: 4 }),
      pollIntervalMs: 50,
      leaseDurationMs: 30_000,
      convergenceTimeoutMs: 180_000,
      emit: () => {},
    });
    context.after(() => worker.stop());
    await worker.start();
    const prefix = "/namespaces/" + tenant.id;
    await kube.waitFor("OCE Namespace readiness", async () => {
      const response = await request("GET", prefix);
      assert.equal(response.statusCode, 200);
      return response.json<{ data: { status: string } }>().data.status === "ready";
    });
    const namespace = await kube.resource("namespace", placement);
    assert.equal(
      row(metadata(namespace).labels)["pod-security.kubernetes.io/enforce"],
      "restricted",
    );
    await kube.resource("networkpolicy", "default-deny", placement);

    const values = createHarnessConfiguration("codex", model);
    assert.ok(values.plugins);
    Object.assign(values.plugins.entries.codex.config.appServer, {
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const config = await admitted<ConfigurationResponse>("POST", prefix + "/configurations", 201, {
      kind: "agent",
      values: {
        ...values,
        gateway: { ...values.gateway, auth: nativeAdminGatewayAuth() },
      },
    });
    const secret = await admitted<SecretResponse>("POST", prefix + "/secrets", 201, {
      name: "opensandbox-k3d-model-placeholder",
      value: modelPlaceholder,
    });
    const agent = await admitted<AgentResponse>("POST", prefix + "/agents", 201, {
      name: "opensandbox-" + nonce,
      executionMode: "dedicated",
      configurationId: config.id,
      harnessAuth: {
        method: "api_key",
        source: { kind: "secret", namespaceId: tenant.id, id: secret.id },
      },
    });
    const path = prefix + "/agents/" + agent.id;
    await kube.provisionAgentTransportSecret(bootstrap.directory, placement, agent.id);

    const agentLabel = { "openclaw.dev/agent": agent.id };
    // An operator-owned Sandbox in the same Namespace must survive Agent cleanup.
    const foreignName = "foreign-" + nonce;
    await kube.applyManifest(
      JSON.stringify({
        apiVersion: "sandbox.opensandbox.io/v1alpha1",
        kind: "BatchSandbox",
        metadata: { name: foreignName, namespace: placement },
        spec: {
          replicas: 0,
          template: { spec: { containers: [{ name: "unused", image: runtimeImage }] } },
        },
      }),
    );
    const foreignUid = kubeUid(await kube.resource(sandboxResource, foreignName, placement));
    const agentSelector = "openclaw.dev/agent=" + agent.id;

    const faults = interruptLifecycleResponses(
      t,
      selectedConfig.clusters[0].cluster.server,
      placement,
    );
    const workerCompute = workerDrivers.computeDriver;
    assert.ok(workerCompute instanceof KubernetesComputeDriver);
    const activate = workerCompute.activateRevision.bind(workerCompute);
    let refusedControllerChange = false;
    // Change only the controller between preparation and activation. Pass the real
    // Compute result back to the worker so it must retry after ownership is restored.
    t.mock.method(
      workerCompute,
      "activateRevision",
      async (...args: Parameters<typeof activate>) => {
        const [revision] = args;
        const [pod, ...extra] = await resources(
          "pods",
          placement,
          "-l",
          "openclaw.dev/workload-role=agent,openclaw.dev/revision=" + revision.id,
        );
        assert.ok(pod);
        assert.equal(extra.length, 0);
        assert.ok(
          list(row(row(pod).status).conditions).some(
            ({ type, status }) => type === "Ready" && status === "True",
          ),
        );
        const account = await kube.resource("serviceaccount", agentName(agent.id), placement);
        const original = list(metadata(pod).ownerReferences);
        const foreign = [
          {
            apiVersion: "v1",
            kind: "ServiceAccount",
            name: kubeName(account),
            uid: kubeUid(account),
            controller: true,
          },
        ];
        const change = (before: unknown, after: unknown) =>
          kube.kubectl(
            "patch",
            "pod",
            kubeName(pod),
            "-n",
            placement,
            "--type=json",
            "-p",
            JSON.stringify([
              { op: "test", path: "/metadata/uid", value: kubeUid(pod) },
              { op: "test", path: "/metadata/ownerReferences", value: before },
              { op: "replace", path: "/metadata/ownerReferences", value: after },
            ]),
          );
        await change(original, foreign);
        try {
          await activate(...args);
        } catch (error) {
          refusedControllerChange = asRecord(error)?.code === "SANDBOX_WORKLOAD_IMMUTABLE";
          throw error;
        } finally {
          await change(foreign, original);
        }
      },
      { times: 1 },
    );
    const admitDeployment = () => admitted<AgentRevisionResponse>("POST", path + "/deploy", 202);
    async function observeDeployment(revision: AgentRevisionResponse["data"]) {
      const status = await kube.waitFor(
        "OCE deploy work to reach a terminal result",
        async () => {
          const status = await admitted<AgentDeploymentStatusResponse>(
            "GET",
            path + "/deployments/" + revision.id,
            200,
          );
          return status.status === "succeeded" || status.status === "failed" ? status : false;
        },
        210_000,
      );
      assert.equal(status.status, "succeeded", "OCE deployment result " + status.error?.code);
      const active = await admitted<AgentReadResponse>("GET", path, 200);
      assert.equal(active.activeRevisionId, revision.id);
      const revisionSelector = "openclaw.dev/revision=" + revision.id;
      const [sandbox] = await resources(sandboxResource, placement, "-l", revisionSelector);
      assert.ok(sandbox, "The real operator must receive a revision Sandbox");
      assert.equal((await resources(sandboxResource, placement, "-l", agentSelector)).length, 1);
      assert.equal(row(row(sandbox).spec).replicas, 1);
      assert.equal(Boolean(row(row(sandbox).spec).poolRef), false);
      const [pod, ...duplicates] = await resources(
        "pods",
        placement,
        "-l",
        "openclaw.dev/workload-role=agent," + revisionSelector,
      );
      assert.ok(pod, "The real operator must create the Harness Pod");
      assert.equal(duplicates.length, 0);
      assert.ok(
        list(metadata(pod).ownerReferences).some(
          ({ kind, uid, controller }) =>
            controller === true && kind === "BatchSandbox" && uid === kubeUid(sandbox),
        ),
      );
      assert.equal(row(row(pod).spec).serviceAccountName, agentName(agent.id));
      const binding = row(await kube.resource("configmap", kubeName(sandbox), placement));
      assert.equal(binding.immutable, true);
      assert.equal(row(binding.data).batchUid, kubeUid(sandbox));
      assert.equal(row(binding.data).podUid, kubeUid(pod));
      // The Driver must supply the entire grant. The fixture adds no Harness egress.
      const grant = row(await kube.resource("networkpolicy", kubeName(sandbox), placement));
      assert.ok(
        list(metadata(grant).ownerReferences).some(
          ({ uid, controller }) => controller === true && uid === kubeUid(sandbox),
        ),
      );
      const policy = row(grant.spec);
      const labels = row(row(policy.podSelector).matchLabels);
      assert.equal(labels["openclaw.dev/revision"], revision.id);
      assert.equal(labels["openclaw.dev/opensandbox-pod"], kubeUid(pod));
      assert.ok(
        Object.entries(labels).every(([key, value]) => row(metadata(pod).labels)[key] === value),
      );
      assert.deepEqual(policy.policyTypes, ["Egress"]);
      const egress = list(policy.egress);
      assert.equal(egress.length, 2);
      const modelRule = egress.find((rule) => list(rule.to).some((peer) => peer.ipBlock));
      assert.deepEqual(modelRule, {
        to: [{ ipBlock: { cidr: modelEndpoint.hostname + "/32" } }],
        ports: [{ protocol: "TCP", port: modelPort }],
      });
      assert.deepEqual(
        egress.find((rule) => rule !== modelRule),
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
      );
      const deployments = await resources("deployments", placement);
      assert.ok(deployments.every((deployment) => kubeName(deployment) !== revisionName(revision)));
      return { sandbox, pod };
    }
    function exec(pod: unknown, container: string, script: string) {
      return kube.kubectl(
        "exec",
        kubeName(pod),
        "-n",
        placement,
        "-c",
        container,
        "--",
        "node",
        "-e",
        script,
      );
    }
    const first = await observeDeployment(await admitDeployment());
    assert.equal(
      refusedControllerChange,
      true,
      "Compute must refuse activation of a Ready Pod with another controller",
    );
    t.diagnostic(
      "Compute refused a changed Pod controller. The worker recovered after restoration.",
    );
    assert.equal(faults.seen.createReplyLost, true, "The first real create must lose its reply");
    assert.equal(
      faults.seen.creates,
      1,
      "Readback must recover the original create without replay",
    );
    t.diagnostic("OCC recovered the lost create reply and activated one owned Harness Pod.");
    // The same listener accepts its local control connection. That rules out a
    // dead target as the explanation for the Harness connection's timeout.
    const deniedProbe = "opensandbox-denied-egress";
    const deniedPort = 18080;
    await kube.applyManifest(
      JSON.stringify({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: deniedProbe, namespace: placement, labels: { app: deniedProbe } },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "listener",
              image: runtimeImage,
              imagePullPolicy: "IfNotPresent",
              command: [
                "node",
                "-e",
                "require('node:net').createServer(s=>s.end('READY')).listen(18080,'0.0.0.0')",
              ],
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              readinessProbe: { tcpSocket: { port: deniedPort } },
            },
          ],
        },
      }),
    );
    // Allow inbound Harness traffic at the probe so the refusal proves the
    // Harness's outbound fence, even though the Namespace defaults to deny.
    await kube.applyManifest(
      JSON.stringify({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: deniedProbe, namespace: placement },
        spec: {
          podSelector: { matchLabels: { app: deniedProbe } },
          policyTypes: ["Ingress"],
          ingress: [
            {
              from: [{ podSelector: { matchLabels: agentLabel } }],
              ports: [{ protocol: "TCP", port: deniedPort }],
            },
          ],
        },
      }),
    );
    await kube.kubectl(
      "wait",
      "--for=condition=Ready",
      "pod/" + deniedProbe,
      "-n",
      placement,
      "--timeout=120s",
    );
    const probe = await kube.resource("pod", deniedProbe, placement);
    const podIp = row(row(probe).status).podIP;
    assert.ok(typeof podIp === "string" && isIP(podIp) === 4);
    function connect(ip: string) {
      return (
        "const s=require('node:net').createConnection(" +
        deniedPort +
        "," +
        JSON.stringify(ip) +
        "); s.setTimeout(3000); s.on('data',(d)=>process.stdout.write(d));" +
        "s.on('error',()=>process.stdout.write('BLOCKED')); s.on('timeout',()=>{s.destroy();process.stdout.write('BLOCKED');});"
      );
    }
    assert.equal(await exec(probe, "listener", connect("127.0.0.1")), "READY");
    assert.equal(await exec(first.pod, "agent", connect(podIp)), "BLOCKED");
    await kube.resource("deployment", gatewayName(agent.id), placement);
    const [gatewayPod] = await resources(
      "pods",
      placement,
      "-l",
      "openclaw.dev/workload-role=gateway," + agentSelector,
    );
    assert.ok(gatewayPod);
    assert.notEqual(kubeUid(gatewayPod), kubeUid(first.pod));
    const gatewayEnvs = list(row(list(row(row(gatewayPod).spec).containers)[0]).env);
    assert.ok(gatewayEnvs.every(({ name }) => name !== "OPENAI_API_KEY"));
    const socket = row(JSON.parse(await exec(gatewayPod, "gateway", initialize)));
    assert.ok(
      [401, 403].includes(Number(socket.missing)),
      "Missing transport bearer must be denied",
    );
    assert.ok([401, 403].includes(Number(socket.wrong)), "Wrong transport bearer must be denied");
    assert.equal(socket.correct, "initialized", "The ordinary Agent Service must reach real Codex");

    // OCC's public chat route forwards to the Gateway and waits for the actual Harness reply.
    const chatPath = "/agents/" + agent.id + "/chat";
    const prompt = "OCC-OPENSANDBOX-" + nonce;
    const reply = await request("POST", chatPath, {
      model: "openclaw",
      stream: false,
      messages: [
        { role: "user", content: "Reply with exactly this nonce and no other text: " + prompt },
      ],
    });
    assert.equal(reply.statusCode, 200, "OCC must return a provider-backed Agent reply");
    assert.equal(
      reply.body.includes(modelPlaceholder),
      false,
      "OCC must not return the sender placeholder",
    );
    const [choice] = list(row(reply.json()).choices);
    assert.equal(row(choice?.message).role, "assistant");
    assert.equal(row(choice?.message).content, prompt);
    t.diagnostic(
      "The saved Agent returned the requested nonce through the configured model sender.",
    );

    const claim = harnessWorkspaceClaimName(agent.id);
    const claimUid = kubeUid(await kube.resource("persistentvolumeclaim", claim, placement));
    // File APIs traverse the enrolled Workspace Node and must retain the same data after replacement.
    const markerName = "USER.md";
    const markerPath = path + "/workspace/files/" + markerName;
    const content = "OpenSandbox lifecycle marker " + nonce;
    const written = await admitted<WorkspaceFileUpdateResponse>("PUT", markerPath, 200, {
      content,
    });
    assert.deepEqual(written, { name: markerName, size: Buffer.byteLength(content) });
    async function assertMarker() {
      assert.deepEqual(await admitted<WorkspaceFileResponse>("GET", markerPath, 200), {
        name: markerName,
        content,
      });
    }
    await assertMarker();
    t.diagnostic("The enrolled workspace node wrote and read the marker through OCC.");
    const pod = kubeName(first.pod);
    const podUid = kubeUid(first.pod);
    const finalizer = "openclaw.dev/opensandbox-integration-hold";
    const patchPod = (operations: unknown[]) =>
      kube.kubectl(
        "patch",
        "pod",
        pod,
        "-n",
        placement,
        "--type=json",
        "-p",
        JSON.stringify(operations),
      );
    // Hold only the predecessor Pod's deletion record. Stop must verify absence
    // even after Kubernetes accepted foreground deletion of its BatchSandbox.
    const originalMetadata = metadata(await kube.resource("pod", pod, placement));
    const originalFinalizers = originalMetadata.finalizers ?? [];
    assert.ok(Array.isArray(originalFinalizers) && !originalFinalizers.includes(finalizer));
    async function releasePredecessor() {
      const raw = await kube.kubectl(
        "get",
        "pod",
        pod,
        "-n",
        placement,
        "--ignore-not-found",
        "-o",
        "json",
      );
      if (raw.trim() === "") {
        return;
      }
      const current = metadata(JSON.parse(raw));
      assert.equal(current.uid, podUid);
      if (Array.isArray(current.finalizers) && current.finalizers.includes(finalizer)) {
        const position = "/metadata/finalizers/" + current.finalizers.indexOf(finalizer);
        await patchPod([
          { op: "test", path: "/metadata/uid", value: podUid },
          { op: "test", path: position, value: finalizer },
          { op: "remove", path: position },
        ]);
      }
    }
    context.after(releasePredecessor);
    await patchPod([
      { op: "test", path: "/metadata/uid", value: podUid },
      { op: "test", path: "/metadata/resourceVersion", value: originalMetadata.resourceVersion },
      { op: "add", path: "/metadata/finalizers", value: [...originalFinalizers, finalizer] },
    ]);
    faults.observePredecessor(kubeName(first.sandbox), pod);
    const candidate = await admitDeployment();
    await kube.waitFor(
      "predecessor deletion is unconfirmed after the lost reply",
      async () => {
        if (!faults.seen.deleteReplyLost || faults.seen.predecessorReadbacks === 0) {
          return false;
        }
        const oldPod = await kube.resource("pod", pod, placement);
        assert.equal(kubeUid(oldPod), podUid);
        return typeof metadata(oldPod).deletionTimestamp === "string";
      },
      90_000,
    );
    assert.equal(faults.seen.creates, 1, "The replacement must wait for predecessor removal");
    assert.equal(faults.seen.predecessorPodAbsent, false);
    assert.notEqual(
      (await admitted<AgentReadResponse>("GET", path, 200)).activeRevisionId,
      candidate.id,
    );
    const [oldSandbox, ...others] = await resources(
      sandboxResource,
      placement,
      "-l",
      agentSelector,
    );
    assert.equal(kubeUid(oldSandbox), kubeUid(first.sandbox));
    assert.equal(others.length, 0);
    t.diagnostic("A lost deletion reply left the replacement waiting for the exact predecessor.");
    await releasePredecessor();

    const replacement = await observeDeployment(candidate);
    async function assertRetired(sandbox: unknown) {
      for (const kind of ["networkpolicy", "configmap"]) {
        const remaining = await kube.kubectl(
          "get",
          kind,
          kubeName(sandbox),
          "-n",
          placement,
          "--ignore-not-found",
          "-o",
          "name",
        );
        assert.equal(remaining.trim(), "", kind + " survived its Harness");
      }
    }
    await assertRetired(first.sandbox);
    assert.equal(faults.seen.creates, 2);
    assert.equal(faults.seen.predecessorPodAbsent, true);
    assert.equal(
      faults.seen.prematureCreates,
      0,
      "The successor must follow confirmed Pod removal",
    );
    assert.notEqual(kubeUid(replacement.sandbox), kubeUid(first.sandbox));
    assert.notEqual(kubeUid(replacement.pod), podUid);
    assert.equal(kubeUid(await kube.resource("persistentvolumeclaim", claim, placement)), claimUid);
    await assertMarker();
    t.diagnostic("A new revision reconnected and read the marker on the original workspace claim.");

    const stopped = await admitted<AgentResponse>("POST", path + "/stop", 202);
    assert.equal(stopped.desiredRuntimeState, "stopped");
    const ownedResourcesGone = async () =>
      (await resources(sandboxResource, placement, "-l", agentSelector)).length === 0 &&
      (await resources("pods", placement, "-l", agentSelector)).length === 0;
    await kube.waitFor(
      "stopped Agent and former Harness to be gone",
      async () => {
        const current = await admitted<AgentReadResponse>("GET", path, 200);
        return current.activeRevisionId === undefined && (await ownedResourcesGone());
      },
      180_000,
    );
    assert.equal(kubeUid(await kube.resource("persistentvolumeclaim", claim, placement)), claimUid);
    assert.equal(kubeUid(await kube.resource(sandboxResource, foreignName, placement)), foreignUid);

    await assertRetired(replacement.sandbox);
    // Explicit Stop keeps the workspace available for a subsequent deployment.
    const resumed = await observeDeployment(await admitDeployment());
    assert.notEqual(kubeUid(resumed.pod), kubeUid(replacement.pod));
    assert.equal(kubeUid(await kube.resource("persistentvolumeclaim", claim, placement)), claimUid);
    await assertMarker();
    t.diagnostic("After an explicit Stop, the Agent resumed with the same workspace.");

    await admitted<AgentResponse>("DELETE", path, 202);
    await kube.waitFor(
      "Agent deletion to retire only the Agent's workloads and claim",
      async () => {
        const current = await request("GET", path);
        assert.ok([200, 404].includes(current.statusCode));
        return (
          current.statusCode === 404 &&
          (await ownedResourcesGone()) &&
          (await resources("persistentvolumeclaims", placement)).every(
            (item) => kubeName(item) !== claim,
          )
        );
      },
      180_000,
    );
    await assertRetired(resumed.sandbox);

    // Simulate a crash between create and recording the controller UID.
    // Reuse a retired name with no replicas so neither object can mount the claim.
    const name = kubeName(first.sandbox);
    const labels = row(metadata(first.sandbox).labels);
    await kube.applyManifest(
      JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name,
          namespace: placement,
          labels: {
            "openclaw.dev/opensandbox-driver": labels["openclaw.dev/opensandbox-driver"],
            "openclaw.dev/namespace": tenant.id,
          },
        },
        data: { agentId: agent.id, revisionId: labels["openclaw.dev/revision"] },
      }),
    );
    const reservation = kubeUid(await kube.resource("configmap", name, placement));
    const batch = JSON.stringify({
      apiVersion: "sandbox.opensandbox.io/v1alpha1",
      kind: "BatchSandbox",
      metadata: {
        name,
        namespace: placement,
        labels,
        annotations: { "openclaw.dev/opensandbox-binding": reservation },
      },
      spec: {
        replicas: 0,
        template: { spec: { containers: [{ name: "unused", image: runtimeImage }] } },
      },
    });
    await kube.applyManifest(batch);
    const listedUid = kubeUid(await kube.resource(sandboxResource, name, placement));
    const state = new PostgresPlatformState(pool);
    const saved = await state.read((view) => view.namespaces.findNamespace(tenant.id));
    assert.ok(saved);
    const signal = AbortSignal.timeout(60_000);
    const { kubernetes } = await workerCompute.resolveSandboxNamespaceContext(saved, signal);
    const hooks = workerDrivers.namespaceLifecycleBindings?.find(
      ({ owner }) => owner === workerDrivers.sandboxDriver,
    )?.hooks;
    assert.ok(hooks?.deleteNamespace);
    let replacedUid: string | undefined;
    const swap = replaceListedSandbox(t, kubernetes, name, listedUid, async () => {
      await kube.waitFor(
        "listed BatchSandbox removal",
        async () =>
          (
            await kube.kubectl(
              "get",
              sandboxResource,
              name,
              "-n",
              placement,
              "--ignore-not-found",
              "-o",
              "name",
            )
          ).trim() === "",
        30_000,
      );
      await kube.applyManifest(batch);
      replacedUid = kubeUid(await kube.resource(sandboxResource, name, placement));
    });
    try {
      const cleanup = await hooks.deleteNamespace({ namespace: saved, signal });
      assert.ok(replacedUid);
      assert.notEqual(replacedUid, listedUid);
      assert.equal(cleanup.namespaceDeleted, false);
      assert.equal(kubeUid(await kube.resource(sandboxResource, name, placement)), replacedUid);
      const retained = row(await kube.resource("configmap", name, placement));
      assert.equal(kubeUid(retained), reservation);
      assert.equal(
        row(retained.data).batchUid,
        undefined,
        "Cleanup must refuse before pinning a replacement",
      );
    } finally {
      swap.mock.restore();
    }
    t.diagnostic(
      "Namespace cleanup refused a same-name replacement and left its reservation intact.",
    );
    assert.equal(kubeUid(await kube.resource(sandboxResource, foreignName, placement)), foreignUid);
  },
);
