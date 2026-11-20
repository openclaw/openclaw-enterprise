import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mts";
import { postgresImage } from "../../scripts/ci/fixture-support-images.ts";
import { boundedTeardown } from "./bounded-teardown.ts";
import { installProductionHelmControlPlane } from "./production-helm-real.ts";
import { runFixtureCommand, type FixtureRun } from "./production-rehearsal-custody.ts";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  createRealKubernetesFixture,
  validateExplicitK3dLoopbackContext,
  assertGatewayModelTurn,
  kubernetesHash,
} from "./kubernetes-real.ts";
import { createNativeTopologyConfiguration } from "./topology-launch-configuration.ts";
import { slackApi } from "./slack-web-api.ts";
import { assertSlackChannelDestination, verifySingleSlackDelivery } from "./slack-delivery.ts";
import { gatewaySlackEvidence } from "./slack-native-evidence.ts";
import { probeChannelConnect } from "./channel-egress-probe.ts";
import { productionTuiProxyCommand, productionTuiProxyData } from "./production-tui-proxy.ts";
import { createProductionTuiRequest, ProductionTuiRequestError } from "./production-tui-request.ts";
import { createUpgradeResponseProxy } from "./channel-upgrade-response-proxy.ts";
import { availablePort } from "./available-port.ts";

function object(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  assert.ok(result);
  return result;
}
function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function array(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}

export async function runHelmChannelScenario(t: TestContext, { upgrade }: { upgrade: boolean }) {
  const { context } = boundedTeardown(t, { label: "Helm channel proof cleanup" });
  const selection = {
    kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
  };
  await validateExplicitK3dLoopbackContext(selection);
  assert.ok(selection.kubeconfigPath && selection.kubernetesContext);
  const controller = process.env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE;
  const sourceController = process.env.OCC_TEST_CHANNEL_EGRESS_SOURCE_CONTROLLER_IMAGE;
  const sourceChart = process.env.OCC_TEST_CHANNEL_EGRESS_SOURCE_CHART;
  const nextController = process.env.OCC_TEST_CHANNEL_EGRESS_NEXT_CONTROLLER_IMAGE;
  const migrationMode = process.env.OCC_TEST_CHANNEL_EGRESS_DATABASE_MODE ?? "hook";
  assert.ok(migrationMode === "hook" || migrationMode === "separate");
  if (upgrade) {
    assert.match(sourceController ?? "", /^\S+@sha256:[a-f0-9]{64}$/);
    assert.ok(sourceChart, "select the actual pre-channel-egress chart checkout");
    assert.match(nextController ?? "", /^\S+@sha256:[a-f0-9]{64}$/);
    assert.notEqual(nextController, controller);
  }
  const runtime =
    process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;
  const harness = process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE ?? runtime;
  const profile = process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE;
  for (const image of [controller, runtime, harness]) {
    assert.match(image ?? "", /^\S+@sha256:[a-f0-9]{64}$/);
  }
  assert.ok(controller && runtime && harness && profile && process.env.OPENAI_API_KEY);
  const slack = {
    channelId: process.env.OCC_TEST_SLACK_CHANNEL_ID!,
    appToken: process.env.SLACK_APP_TOKEN!,
    botToken: process.env.SLACK_BOT_TOKEN!,
    senderBotToken: process.env.OCC_TEST_SLACK_SENDER_BOT_TOKEN!,
  };
  for (const value of Object.values(slack)) {
    assert.ok(value);
  }
  const targetIdentity = await slackApi("auth.test", slack.botToken);
  const senderIdentity = await slackApi("auth.test", slack.senderBotToken);
  assert.equal(targetIdentity.team_id, senderIdentity.team_id);
  assert.notEqual(targetIdentity.user_id, senderIdentity.user_id);
  for (const token of [slack.botToken, slack.senderBotToken]) {
    const info = await slackApi("conversations.info", token, { channel: slack.channelId });
    assertSlackChannelDestination(info, slack.channelId);
    assert.equal(object(info.channel).is_member, true);
  }
  const suffix = randomBytes(5).toString("hex");
  const namespace = `oce-channel-helm-${suffix}`;
  const release = `channel-${suffix}`;
  const gatewayClass = `channel-proof-${suffix}`;
  const envoyNamespace = process.env.OCC_TEST_ENVOY_GATEWAY_NAMESPACE ?? "envoy-gateway-system";
  const directory = await mkdtemp(join(tmpdir(), "oce-channel-helm-"));
  const secrets = [
    process.env.OPENAI_API_KEY,
    slack.appToken,
    slack.botToken,
    slack.senderBotToken,
  ];
  const secret = () => {
    const value = randomBytes(32).toString("hex");
    secrets.push(value);
    return value;
  };
  const redact = (value: unknown) =>
    secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), String(value));
  const run: FixtureRun = (command, args, options = {}) =>
    runFixtureCommand(
      command,
      args,
      { ...options, protectedInput: options.input !== undefined },
      redact,
      true,
    );
  const kube = createKubernetesClient({ selection });
  const { kubectl, resource, resources, waitFor } = kube;
  const apply = (value: unknown) =>
    run("kubectl", kube.kubectlArguments(["apply", "-f", "-"]), { input: JSON.stringify(value) });
  const cleanupState: { tenant?: string } = {};
  let gatewayClassCreated = false;
  context.after(() => rm(directory, { recursive: true, force: true }));
  await kubectl("create", "namespace", namespace);
  context.after(async () => {
    for (const name of [release, `${release}-postgres`]) {
      await run("helm", [
        "uninstall",
        name,
        "--ignore-not-found",
        "--namespace",
        namespace,
        "--kubeconfig",
        selection.kubeconfigPath!,
        "--kube-context",
        selection.kubernetesContext!,
      ]);
    }
    if (cleanupState.tenant) {
      await kubectl(
        "delete",
        "namespace",
        cleanupState.tenant,
        "--ignore-not-found=true",
        "--wait=true",
        "--timeout=120s",
      );
    }
    await kubectl(
      "delete",
      "namespace",
      namespace,
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=120s",
    );
    if (gatewayClassCreated) {
      await kubectl(
        "delete",
        "gatewayclass",
        gatewayClass,
        "--ignore-not-found=true",
        "--wait=false",
      );
    }
  });
  await run("kubectl", kube.kubectlArguments(["create", "-f", "-"]), {
    input: JSON.stringify({
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "GatewayClass",
      metadata: { name: gatewayClass },
      spec: { controllerName: "gateway.envoyproxy.io/gatewayclass-controller" },
    }),
  });
  gatewayClassCreated = true;
  await waitFor("the fixture GatewayClass to be accepted", async () => {
    const conditions = asRecord(
      object(await resource("gatewayclass", gatewayClass)).status,
    )?.conditions;
    return (
      Array.isArray(conditions) &&
      conditions.some((value) => {
        const condition = object(value);
        return condition.type === "Accepted" && condition.status === "True";
      })
    );
  });
  const nodes = array(object(JSON.parse(await kubectl("get", "nodes", "-o", "json"))).items);
  const podCidrs = nodes.flatMap((node) => {
    const spec = object(node.spec);
    return Array.isArray(spec.podCIDRs) ? spec.podCIDRs.map(string) : [string(spec.podCIDR)];
  });
  const nodeAddresses = nodes.flatMap((node) =>
    array(object(node.status).addresses)
      .filter((address) => address.type === "InternalIP" || address.type === "ExternalIP")
      .map(
        (address) =>
          `${string(address.address)}/${string(address.address).includes(":") ? 128 : 32}`,
      ),
  );
  const serviceCidrs = array(
    object(JSON.parse(await kubectl("get", "servicecidrs", "-o", "json"))).items,
  ).flatMap((range) => {
    const cidrs = object(range.spec).cidrs;
    assert.ok(Array.isArray(cidrs));
    return cidrs.map(string);
  });
  const gatewayName = `${release}-agent-gateways`;
  const routeHash = createHash("sha256")
    .update(`${namespace}/${gatewayName}`)
    .digest("hex")
    .slice(0, 12);
  const routing = {
    gatewayName,
    gatewayNamespace: namespace,
    envoyNamespace,
    hostname: `occ-gateway-${routeHash}.${envoyNamespace}.svc`,
  };
  const egress = {
    gatewayName: `channel-egress-${suffix}`,
    gatewayNamespace: namespace,
    envoyNamespace,
    serviceName: `channel-egress-${suffix}`,
    listenerPortStart: 10001,
    listenerPortEnd: 10002,
    occListenerPort: 10000,
    inspectionPort: 19004,
    excludedCidrs: [...new Set([...podCidrs, ...nodeAddresses, ...serviceCidrs])],
  };
  const configuration = createKubernetesInstallationConfiguration({
    authentication: { mode: "inCluster" },
    platformNamespace: namespace,
    gatewayImage: runtime,
    codexImage: harness,
    codexSeccompProfile: profile,
    cluster: `channel-proof-${suffix}`,
  });
  const { gatewayClients: _gatewayClients, ...network } =
    configuration.drivers.compute.configuration.network;
  const sourceCidrs = process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS;
  assert.ok(sourceCidrs, "the real API-to-Pod proxy source must be explicitly prepared");
  Object.assign(configuration.drivers.compute.configuration, {
    gatewayRouting: routing,
    network: {
      ...network,
      gatewayTrustedProxyCidrs: podCidrs,
      pluginStatusProxySourceCidrs: sourceCidrs.split(","),
    },
  });
  configuration.drivers.compute.configuration.resources.gateway.limits.memory = "4Gi";
  if (upgrade) {
    Object.assign(configuration.drivers.compute.configuration.runtime, {
      channels: {
        proxyUrl: `http://openclaw-enterprise-slack-proxy.${namespace}.svc:3128`,
        managedProxy: {
          hostname: `openclaw-enterprise-slack-proxy.${namespace}.svc`,
          namespace,
          port: 3128,
          podLabels: {
            "app.kubernetes.io/name": "openclaw-enterprise",
            "app.kubernetes.io/instance": release,
            "app.kubernetes.io/component": "slack-proxy",
          },
        },
      },
    });
  }
  const apiKey = secret();
  await apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "private-gateway-key", namespace },
    stringData: { occ: apiKey },
  });
  const httpsPort = await availablePort();
  const authBaseURL = `https://console.oce.localhost:${httpsPort}`;
  const controlPlane = await installProductionHelmControlPlane({
    selection: {
      kubeconfigPath: selection.kubeconfigPath,
      kubernetesContext: selection.kubernetesContext,
    },
    images: {
      controller: upgrade ? sourceController! : controller,
      postgres: process.env.OCC_TEST_PRODUCTION_POSTGRES_IMAGE ?? postgresImage,
    },
    namespace,
    release,
    directory,
    suffix,
    configuration,
    authBaseURL,
    agentNativeAdminDomain: "agents.oce.localhost",
    installationName: `Channel routing proof ${suffix}`,
    ...(upgrade ? { databaseUpgradeMigration: migrationMode } : {}),
    bootstrapCredentials: "existing",
    apiClients: [{ namespace, podLabels: { app: "channel-proof-operator" } }],
    ...(upgrade
      ? { slackProxy: { enabled: true as const }, chartDirectory: sourceChart }
      : { channelEgress: egress }),
    gatewayRouting: {
      enabled: true,
      gatewayName,
      gatewayClassName: gatewayClass,
      envoyNamespace,
      apiKeySecretName: "private-gateway-key",
    },
    run,
    kubernetes: kube,
    createSecretValue: secret,
    record: () => {},
  });
  assert.ok(controlPlane.serviceKey);
  secrets.push(controlPlane.serviceKey);
  const forwards = createRealKubernetesFixture({
    kubeconfigPath: selection.kubeconfigPath,
    kubernetesContext: selection.kubernetesContext,
    gatewayImage: runtime,
    codexImage: harness,
    databaseUrl: process.env.OCC_TEST_DATABASE_URL,
  });
  // The chart binds OCC to its Pod IP. Use its permitted HTTPS ingress peer,
  // rather than bypassing that boundary with a direct API Pod port-forward.
  const keyPath = join(directory, "operator.key");
  const certPath = join(directory, "operator.crt");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const operatorKey = await readFile(keyPath, "utf8");
  const operatorCert = await readFile(certPath, "utf8");
  secrets.push(operatorKey);
  await apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "operator-tls", namespace },
    stringData: { "tls.key": operatorKey, "tls.crt": operatorCert },
  });
  await apply({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "operator-code", namespace },
    data: await productionTuiProxyData(),
  });
  await apply({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "operator", namespace, labels: { app: "channel-proof-operator" } },
    spec: {
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "operator",
          image: runtime,
          command: productionTuiProxyCommand,
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
          env: [
            { name: "TLS_CERT_FILE", value: "/tls/tls.crt" },
            { name: "TLS_KEY_FILE", value: "/tls/tls.key" },
            {
              name: "TARGET_URL",
              value: `http://openclaw-enterprise-api.${namespace}.svc.cluster.local:8080`,
            },
          ],
          volumeMounts: [
            { name: "code", mountPath: "/code", readOnly: true },
            { name: "tls", mountPath: "/tls", readOnly: true },
          ],
          readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 2 },
        },
      ],
      volumes: [
        { name: "code", configMap: { name: "operator-code" } },
        { name: "tls", secret: { secretName: "operator-tls" } },
      ],
    },
  });
  await kubectl(
    "wait",
    "pod/operator",
    "--namespace",
    namespace,
    "--for=condition=Ready",
    "--timeout=120s",
  );
  const apiForward = await forwards.startPortForwardTarget(
    namespace,
    "pod/operator",
    `${httpsPort}:8443`,
  );
  context.after(() => apiForward.stop());
  const externalRequest = createProductionTuiRequest({
    baseURL: `https://localhost:${httpsPort}`,
    ca: operatorCert,
    serviceKey: () => controlPlane.serviceKey,
    secrets,
  });
  // Pod readiness precedes endpoint and CNI propagation. Retry only this
  // read, through the actual operator ingress, before issuing any mutation.
  await waitFor("the operator's permitted API ingress", async () => {
    try {
      return (
        (await externalRequest("GET", "/healthz", undefined, { authenticated: false })).status ===
        200
      );
    } catch (error) {
      if (
        error instanceof ProductionTuiRequestError &&
        (error.status === 502 || error.status === undefined)
      ) {
        return false;
      }
      throw error;
    }
  });
  const request = async (method: string, path: string, body?: unknown) => {
    try {
      const response = await externalRequest(method, path, body);
      return { status: response.status, body: object(response.body) };
    } catch (error) {
      // Diagnose this real ingress before teardown, without request bodies,
      // authentication headers or Secret resources.
      const probe = await kubectl(
        "exec",
        "operator",
        "--namespace",
        namespace,
        "--",
        "node",
        "-e",
        "const r=require('http').get(process.argv[1],s=>{console.log(JSON.stringify({status:s.statusCode}));s.resume()});r.setTimeout(3000,()=>r.destroy());r.on('error',e=>console.log(JSON.stringify({code:e.code})))",
        `http://openclaw-enterprise-api.${namespace}.svc.cluster.local:8080/healthz`,
      );
      t.diagnostic(`Operator ingress diagnostic: ${probe.trim()}`);
      t.diagnostic(
        JSON.stringify(
          object(await resource("networkpolicy", "openclaw-enterprise-api-ingress", namespace))
            .spec,
        ),
      );
      throw error;
    }
  };
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const result = await request(method, path, body);
    assert.equal(
      result.status,
      expected,
      `${method} ${path}: ${String(asRecord(result.body.error)?.code)}`,
    );
    return object(result.body.data);
  };
  assert.equal((await request("GET", "/installation")).status, 200);
  const space = await api("POST", "/namespaces", { name: `channel-proof-${suffix}` }, 201);
  const namespaceId = string(space.id);
  const tenant = kubernetesNamespaceName(namespaceId);
  cleanupState.tenant = tenant;
  await waitFor("the managed tenant Namespace", async () => {
    const spaces = array(
      object(
        JSON.parse(
          await kubectl(
            "get",
            "namespaces",
            "-l",
            `openclaw.dev/namespace=${namespaceId}`,
            "-o",
            "json",
          ),
        ),
      ).items,
    );
    return spaces.some((space) => object(space.metadata).name === tenant);
  });
  // Use the chart's actual roles and accounts, bound only in this tenant.
  for (const [role, account] of [
    ["worker", "worker"],
    ["configuration", "api"],
    ["api", "api"],
  ]) {
    await apply({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: `proof-${role}`, namespace: tenant },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: `${release}-openclaw-tenant-${role}`,
      },
      subjects: [{ kind: "ServiceAccount", name: `openclaw-enterprise-${account}`, namespace }],
    });
  }
  await waitFor(
    "the API Namespace to become ready",
    async () => (await api("GET", `/namespaces/${namespaceId}`)).status === "ready",
  );
  // OpenShell supervisors in a shared Namespace can have their own direct
  // egress. The managed channel Gateway must deploy without matching that policy.
  await apply({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "proof-supervisor-egress", namespace: tenant },
    spec: {
      podSelector: { matchLabels: { "openshell.ai/boundary-role": "supervisor" } },
      policyTypes: ["Egress"],
      egress: [{}],
    },
  });
  const saveSecret = (name: string, value: string) =>
    api("POST", `/namespaces/${namespaceId}/secrets`, { name, value }, 201);
  const model = await saveSecret("model", process.env.OPENAI_API_KEY);
  const app = await saveSecret("slack-app", slack.appToken);
  const bot = await saveSecret("slack-bot", slack.botToken);
  const values = createNativeTopologyConfiguration(
    "codex",
    process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel,
    { channelId: slack.channelId, allowedUserId: senderIdentity.user_id },
    {
      gatewayAuth: {
        auth: {
          mode: "trusted-proxy",
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
          trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
        allowRealIpFallback: true,
        trustedProxies: podCidrs,
      },
    },
  );
  const saved = await api(
    "POST",
    `/namespaces/${namespaceId}/configurations`,
    {
      kind: "agent",
      values,
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
    201,
  );
  const agent = await api(
    "POST",
    `/namespaces/${namespaceId}/agents`,
    {
      name: `slack-${suffix}`,
      configurationId: saved.id,
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: model.ref },
    },
    201,
  );
  const stoppedAgent = upgrade
    ? await api(
        "POST",
        `/namespaces/${namespaceId}/agents`,
        {
          name: `stay-stopped-${suffix}`,
          configurationId: saved.id,
          executionMode: "dedicated",
          harnessAuth: { method: "api_key", source: model.ref },
        },
        201,
      )
    : undefined;
  let channelFreeAgent: Record<string, unknown> | undefined;
  if (upgrade) {
    const freeValues = { ...structuredClone(values) };
    delete freeValues.channels;
    const freePlugins = object(freeValues.plugins);
    assert.ok(Array.isArray(freePlugins.allow));
    freePlugins.allow = freePlugins.allow.filter((id) => id !== "slack");
    delete object(freePlugins.entries).slack;
    const freeConfiguration = await api(
      "POST",
      `/namespaces/${namespaceId}/configurations`,
      {
        kind: "agent",
        values: freeValues,
      },
      201,
    );
    channelFreeAgent = await api(
      "POST",
      `/namespaces/${namespaceId}/agents`,
      {
        name: `channel-free-${suffix}`,
        configurationId: freeConfiguration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: model.ref },
      },
      201,
    );
    const freePath = `/namespaces/${namespaceId}/agents/${String(channelFreeAgent.id)}`;
    await api("POST", `${freePath}/runtime-credentials`, {});
    const freeRevision = await api("POST", `${freePath}/deploy`, undefined, 202);
    await waitFor(
      "the original channel-free Agent deployment",
      async () => {
        const state = await api("GET", `${freePath}/deployments/${String(freeRevision.id)}`);
        assert.notEqual(state.status, "failed", JSON.stringify(state.error));
        return state.status === "succeeded";
      },
      480_000,
    );
  }
  const workspaceMarker = `One-off workspace continuity ${suffix}\n`;
  const agentId = string(agent.id);
  const agentPath = `/namespaces/${namespaceId}/agents/${agentId}`;
  await api("POST", `${agentPath}/runtime-credentials`, {});
  const verifyDirectory = async () => {
    await waitFor("OCC provider directory access", async () => {
      const result = await request("POST", `/namespaces/${namespaceId}/channel-directory/lookup`, {
        agentId,
        secretId: bot.id,
        kind: "channels",
        ids: [slack.channelId],
      });
      if (result.status === 503) {
        return false;
      }
      assert.equal(result.status, 200);
      const found = object(result.body.data);
      assert.equal(found.workspaceId, targetIdentity.team_id);
      return array(found.candidates).some((candidate) => candidate.id === slack.channelId);
    });
    const users = await api("POST", `/namespaces/${namespaceId}/channel-directory/lookup`, {
      agentId,
      secretId: bot.id,
      kind: "users",
      ids: [senderIdentity.user_id],
    });
    assert.equal(users.workspaceId, targetIdentity.team_id);
    assert.ok(array(users.candidates).some((candidate) => candidate.id === senderIdentity.user_id));
  };
  await verifyDirectory();
  const passwordSource = object(
    await resource("secret", `gateway-password-${kubernetesHash(agentId)}`, tenant),
  );
  const password = Buffer.from(
    string(object(passwordSource.data)["gateway-password"]),
    "base64",
  ).toString("utf8");
  secrets.push(password);
  let gatewayPod: Record<string, unknown> | undefined;
  let upgradeReceipt: Record<string, unknown> | undefined;
  const deliveries: Record<string, unknown>[] = [];
  const verifyDelivery = async () => {
    const delivery = await verifySingleSlackDelivery({
      slack,
      gatewayIdentity: targetIdentity,
      senderIdentity,
      replyMode: "root",
      nativeEvidence: (nonce) =>
        gatewaySlackEvidence(
          (...args) =>
            kubectl(
              "exec",
              string(object(gatewayPod!.metadata).name),
              "-n",
              tenant!,
              "--",
              ...args,
            ),
          nonce,
        ),
    });
    const link = await slackApi("chat.getPermalink", slack.botToken, {
      channel: slack.channelId,
      message_ts: delivery.responseTs,
    });
    deliveries.push({ ...delivery, responsePermalink: link.permalink });
    if (process.env.OCC_TEST_SLACK_EVIDENCE_PATH) {
      await writeFile(
        process.env.OCC_TEST_SLACK_EVIDENCE_PATH,
        JSON.stringify(
          {
            ...delivery,
            responsePermalink: link.permalink,
            workflow: upgrade ? "production-helm-channel-upgrade" : "production-helm",
            deliveries,
            ...(upgradeReceipt ? { upgrade: upgradeReceipt } : {}),
            controller,
            runtime,
            harness,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
  };
  for (let round = 0; round < 2; round++) {
    let revision: Record<string, unknown>;
    if (round === 1 && upgrade) {
      // The running revision retains the original draft. The one-off must adopt
      // this newly saved draft without changing Agent identity or its workspace.
      const updatedValues = structuredClone(values);
      const provider = object(object(object(updatedValues.models).providers).codex);
      const model = array(provider.models)[0]!;
      model.name = `Saved draft model ${suffix}`;
      await api("PATCH", `/namespaces/${namespaceId}/configurations/${String(saved.id)}`, {
        values: updatedValues,
      });
      const before = await api("GET", agentPath);
      const installationFile = join(directory, "upgrade-installation.json");
      const installationIdentity = await api("GET", "/installation");
      await kubectl(
        "annotate",
        "secret/occ-installation-startup",
        "--namespace",
        namespace,
        `openclaw.dev/installation-id=${String(installationIdentity.id)}`,
      );
      const installedSecret = object(
        await resource("secret", "occ-installation-startup", namespace),
      );
      await writeFile(
        installationFile,
        Buffer.from(string(object(installedSecret.data)["installation.yaml"]), "base64"),
        { mode: 0o600 },
      );
      const candidate = join(directory, "channel-candidate");
      await run("scripts/upgrade-channel-egress", [
        "prepare",
        "--namespace",
        namespace,
        "--release",
        release,
        "--values",
        join(directory, "values.json"),
        "--installation",
        installationFile,
        "--out-dir",
        candidate,
        ...egress.excludedCidrs.flatMap((cidr) => ["--excluded-cidr", cidr]),
      ]);
      const targetInstallation = JSON.parse(
        await readFile(join(candidate, "installation.yaml"), "utf8"),
      );
      Object.assign(egress, targetInstallation.drivers.compute.configuration.runtime.channelEgress);
      const occ = join(directory, "occ-upgrade");
      await run("go", ["build", "-trimpath", "-o", occ, "./cmd/occ"]);
      const key = join(directory, "upgrade-key.json");
      await writeFile(key, JSON.stringify({ data: { key: controlPlane.serviceKey } }), {
        mode: 0o600,
      });
      const lost = await createUpgradeResponseProxy({
        upstream: `https://localhost:${httpsPort}`,
        key: operatorKey,
        cert: operatorCert,
        agentPath,
      });
      context.after(() => lost.close());
      const evidence = join(directory, "channel-upgrade");
      const sourceRevision = (await run("git", ["rev-parse", "HEAD"])).trim();
      const arguments_ = [
        "run",
        "--kubeconfig",
        selection.kubeconfigPath!,
        "--context",
        selection.kubernetesContext!,
        "--namespace",
        namespace,
        "--release",
        release,
        "--values",
        join(directory, "values.json"),
        "--installation",
        installationFile,
        "--candidate-values",
        join(candidate, "values.yaml"),
        "--candidate-installation",
        join(candidate, "installation.yaml"),
        "--controller-image",
        controller,
        "--source-revision",
        sourceRevision,
        "--evidence-dir",
        evidence,
        "--occ",
        occ,
      ];
      const environment = {
        ...process.env,
        OCC_URL: lost.url,
        OCC_SERVICE_KEY_FILE: key,
        OCC_CA_BUNDLE: certPath,
        KUBERC: "off",
      };
      // Missing dependencies must refuse before any Stop, even though the
      // reviewed channel transformation itself is valid.
      const unavailableValues = JSON.parse(await readFile(join(candidate, "values.yaml"), "utf8"));
      unavailableValues.channelEgress.gatewayClassName = `missing-${suffix}`;
      const unavailableFile = join(directory, "unavailable-channel-values.json");
      await writeFile(unavailableFile, JSON.stringify(unavailableValues), { mode: 0o600 });
      const unavailableArguments = arguments_.map((value, index) => {
        if (arguments_[index - 1] === "--candidate-values") {
          return unavailableFile;
        }
        if (arguments_[index - 1] === "--evidence-dir") {
          return join(directory, "dependency-refusal");
        }
        return value;
      });
      await assert.rejects(
        run("scripts/upgrade-channel-egress", unavailableArguments, {
          env: environment,
          timeout: 900_000,
        }),
        /Envoy dependencies are not ready/,
      );
      assert.equal(lost.stopRequests(), 0);
      assert.equal((await api("GET", agentPath)).activeRevisionId, before.activeRevisionId);
      assert.equal((await api("GET", agentPath)).desiredRuntimeState, "running");
      const executeUpgrade = async (resume: boolean) => {
        try {
          return await run(
            "scripts/upgrade-channel-egress",
            [
              ...arguments_,
              ...(resume ? ["--resume"] : []),
              ...(resume && migrationMode === "separate" ? ["--migration-history-checked"] : []),
            ],
            {
              env: environment,
              timeout: 900_000,
            },
          );
        } catch (error) {
          t.diagnostic(redact(error instanceof Error ? error.message : error));
          throw error;
        }
      };
      if (migrationMode === "separate") {
        await assert.rejects(executeUpgrade(false), /separate database deployment/i);
        assert.equal(
          lost.deploymentRequests(),
          0,
          "separate-mode handoff must precede all Deploy requests",
        );
        const applied = await run(
          "scripts/upgrade-channel-egress",
          [...arguments_, "--migration-apply-only"],
          { env: environment, timeout: 900_000 },
        );
        assert.match(applied, /Database migration verified and its Jobs and Pods are gone/);
        await assert.rejects(executeUpgrade(true), /incomplete|unknown|failed/i);
      } else {
        await assert.rejects(executeUpgrade(false), /incomplete|unknown|failed/i);
      }
      const accepted = lost.acceptedDeployment();
      assert.ok(
        accepted,
        `the real API must have accepted the deployment before its response was lost: ${JSON.stringify(lost.deploymentResponses())}`,
      );
      assert.equal(lost.deploymentRequests(), 1);
      await assert.rejects(executeUpgrade(true), /incomplete|unknown|failed/i);
      assert.equal(
        lost.deploymentRequests(),
        1,
        "an uncertain accepted deployment must not be resubmitted",
      );
      const journalPath = join(evidence, "channel-agent-operations.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.equal(
        journal.targets.length,
        2,
        "both running Agents have no repository and must still be inventoried",
      );
      const target = journal.targets.find(
        (item: Record<string, unknown>) => item.agentId === agentId,
      );
      assert.ok(target);
      assert.equal(target.originalRevisionId, before.activeRevisionId);
      assert.equal(target.stop, "complete");
      assert.equal(target.deploy, "sending");
      const acceptedStatus = await api("GET", `${agentPath}/deployments/${String(accepted.id)}`);
      assert.equal(acceptedStatus.agentId, agentId);
      target.deploy = "accepted";
      target.deploymentId = accepted.id;
      await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
      await executeUpgrade(true);
      assert.equal(lost.deploymentRequests(), 1);
      revision = accepted;
      const admitted = await api("GET", `${agentPath}/revisions/${String(accepted.id)}`);
      const admittedProvider = object(
        object(object(object(admitted.configuration).models).providers).codex,
      );
      assert.equal(array(admittedProvider.models)[0]!.name, `Saved draft model ${suffix}`);
      assert.equal((await api("GET", agentPath)).id, agentId);
      assert.equal(
        (await api("GET", `${agentPath}/workspace/files/USER.md`)).content,
        workspaceMarker,
      );
      const stillStopped = await api(
        "GET",
        `/namespaces/${namespaceId}/agents/${String(stoppedAgent!.id)}`,
      );
      assert.equal(stillStopped.desiredRuntimeState, "stopped");
      assert.equal(stillStopped.activeRevisionId, undefined);

      // A subsequent ordinary controller image upgrade retains this new revision
      // and must not replay the release-specific Stop/Deploy sequence.
      const ordinaryArguments = [
        "--kubeconfig",
        selection.kubeconfigPath!,
        "--context",
        selection.kubernetesContext!,
        "--namespace",
        namespace,
        "--release",
        release,
        "--values",
        join(directory, "values.json"),
        "--installation",
        installationFile,
        "--controller-image",
        nextController!,
        "--source-revision",
        sourceRevision,
        "--evidence-dir",
        join(directory, "ordinary-upgrade"),
        "--occ",
        occ,
        "--verify-agent",
        agentId,
        "--verify-agent-namespace",
        namespaceId,
      ];
      const ordinary = (resume: boolean) =>
        run(
          "scripts/upgrade-production-images",
          [...ordinaryArguments, ...(resume ? ["--resume", "--migration-history-checked"] : [])],
          { env: environment, timeout: 900_000 },
        );
      if (migrationMode === "separate") {
        await assert.rejects(ordinary(false), /separate database deployment/i);
        const applied = await run(
          "scripts/upgrade-production-images",
          [...ordinaryArguments, "--migration-apply-only"],
          { env: environment, timeout: 900_000 },
        );
        assert.match(applied, /Database migration verified and its Jobs and Pods are gone/);
        await ordinary(true);
      } else {
        await ordinary(false);
      }
      assert.equal(lost.deploymentRequests(), 1);
      assert.equal((await api("GET", agentPath)).activeRevisionId, accepted.id);
      assert.equal(
        lost.allDeploymentRequests(),
        2,
        "only the original running set is deployed, once each",
      );
      await verifyDirectory();
      const completedJournal = JSON.parse(await readFile(journalPath, "utf8"));
      upgradeReceipt = {
        sourceRevision,
        sourceController,
        controller,
        nextController,
        migrationMode,
        targets: completedJournal.targets.map((item: Record<string, unknown>) => ({
          namespaceId: item.namespaceId,
          agentId: item.agentId,
          originalRevisionId: item.originalRevisionId,
          deploymentId: item.deploymentId,
          stop: item.stop,
          deploy: item.deploy,
        })),
        uncertainResponseRefused: true,
        manualRecoveryCompleted: true,
        workspaceRetained: true,
        stoppedAgentPreserved: true,
        currentSavedDraftAdopted: true,
        subsequentUpgradeRetainedRevision: true,
        dependencyRefusedBeforeStop: true,
        providerDirectoryAfterUpgrade: true,
      };
    } else {
      revision = await api("POST", `${agentPath}/deploy`, undefined, 202);
    }
    await waitFor(
      "the Helm worker's admitted revision to activate",
      async () => (await api("GET", agentPath)).activeRevisionId === revision.id,
      480_000,
    );
    // The serving pointer is committed before all activation work finishes.
    // Wait for the public deployment outcome, including workspace-node reload.
    await waitFor(
      "the complete deployment outcome",
      async () => {
        const deployment = await api("GET", `${agentPath}/deployments/${String(revision.id)}`);
        assert.notEqual(deployment.status, "failed", JSON.stringify(deployment.error));
        return deployment.status === "succeeded";
      },
      480_000,
    );
    const pods = await resources(
      "pods",
      tenant,
      "-l",
      `openclaw.dev/agent=${agentId},openclaw.dev/revision=${String(revision.id)}`,
    );
    assert.ok(pods);
    gatewayPod = pods
      .map(object)
      .find(
        (pod) => object(object(pod.metadata).labels)["openclaw.dev/workload-role"] === "gateway",
      );
    const harnessPod = pods
      .map(object)
      .find((pod) => object(object(pod.metadata).labels)["openclaw.dev/workload-role"] === "agent");
    assert.ok(gatewayPod && harnessPod);
    assert.equal(
      object(object(gatewayPod.metadata).labels)["openshell.ai/boundary-role"],
      "channel-gateway",
    );
    const gatewayEnv = array(array(object(gatewayPod.spec).containers)[0]!.env);
    const harnessEnv = array(array(object(harnessPod.spec).containers)[0]!.env);
    assert.ok(!gatewayEnv.some((entry) => entry.name === "OPENAI_API_KEY"));
    assert.ok(
      !harnessEnv.some((entry) =>
        ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "HTTPS_PROXY"].includes(string(entry.name)),
      ),
    );
    const proxy = string(gatewayEnv.find((entry) => entry.name === "HTTPS_PROXY")?.value);
    const gatewayName = string(object(gatewayPod.metadata).name);
    assert.deepEqual(await probeChannelConnect(tenant, gatewayName, proxy, "slack.com"), {
      status: 200,
      tlsVerified: true,
    });
    assert.notEqual(
      (
        await probeChannelConnect(
          tenant,
          string(object(harnessPod.metadata).name),
          proxy,
          "slack.com",
        )
      ).status,
      200,
    );
    assert.notEqual(
      (await probeChannelConnect(tenant, gatewayName, proxy, "127.0.0.1")).status,
      200,
    );
    if (upgrade && round === 1) {
      const free = await api(
        "GET",
        `/namespaces/${namespaceId}/agents/${String(channelFreeAgent!.id)}`,
      );
      const freePods = await resources(
        "pods",
        tenant,
        "-l",
        `openclaw.dev/agent=${String(free.id)},openclaw.dev/revision=${String(free.activeRevisionId)}`,
      );
      assert.ok(freePods);
      const freeGateway = freePods
        .map(object)
        .find(
          (pod) => object(object(pod.metadata).labels)["openclaw.dev/workload-role"] === "gateway",
        );
      assert.ok(freeGateway);
      const freeEnv = array(array(object(freeGateway.spec).containers)[0]!.env);
      assert.ok(
        !freeEnv.some((entry) =>
          ["HTTPS_PROXY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"].includes(string(entry.name)),
        ),
      );
      assert.notEqual(
        (
          await probeChannelConnect(
            tenant,
            string(object(freeGateway.metadata).name),
            proxy,
            "slack.com",
          )
        ).status,
        200,
      );
      assert.ok(upgradeReceipt);
      upgradeReceipt.channelFreeDenied = true;
      upgradeReceipt.privateAddressDenied = true;
    }
    // A real public Slack address is a negative direct-connection case.
    const direct = await kubectl(
      "exec",
      gatewayName,
      "-n",
      tenant,
      "--",
      "node",
      "-e",
      "const s=require('net').connect({host:process.argv[1],port:443,timeout:3000},()=>{console.log('ALLOWED');s.destroy()});s.on('error',()=>console.log('DENIED'));s.on('timeout',()=>{console.log('DENIED');s.destroy()})",
      (await lookup("slack.com", { family: 4 })).address,
    );
    assert.equal(direct.trim(), "DENIED");
    const forward = await forwards.startPortForwardTarget(tenant, `pod/${gatewayName}`, "0:8080");
    try {
      await assertGatewayModelTurn({
        gatewayUrl: forward.url,
        gatewayPassword: password,
        nonce: `HELM-CHANNEL-${round}-${randomUUID()}`,
        secrets,
      });
    } finally {
      await forward.stop();
    }
    if (upgrade && round === 0) {
      await api("PUT", `${agentPath}/workspace/files/USER.md`, { content: workspaceMarker });
      await verifyDelivery();
    }
    t.diagnostic(
      `Helm revision ${round + 1}: dedicated model turn, channel route and network denials passed.`,
    );
  }
  assert.ok(gatewayPod);
  await verifyDelivery();
  if (channelFreeAgent) {
    assert.equal(
      (await request("DELETE", `/namespaces/${namespaceId}/agents/${String(channelFreeAgent.id)}`))
        .status,
      202,
    );
  }
  if (stoppedAgent) {
    assert.equal(
      (await request("DELETE", `/namespaces/${namespaceId}/agents/${String(stoppedAgent.id)}`))
        .status,
      202,
    );
  }
  assert.equal((await request("DELETE", agentPath)).status, 202);
  await waitFor(
    "normal Agent deletion",
    async () => (await request("GET", agentPath)).status === 404,
  );
  const slots = array(
    object(JSON.parse(await kubectl("get", "envoypatchpolicies", "-n", namespace, "-o", "json")))
      .items,
  );
  assert.ok(
    !slots.some((slot) => {
      const value = asRecord(object(slot.metadata).annotations)?.[
        "openclaw.dev/channel-egress-binding"
      ];
      return typeof value === "string" && value !== "idle" && value.includes(agentId);
    }),
  );
  t.diagnostic(
    "Full Helm Slack exchange and native Codex evidence passed; Agent listener retired.",
  );
}
