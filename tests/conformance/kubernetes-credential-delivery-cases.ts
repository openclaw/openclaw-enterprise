import type {
  AgentRevision,
  ComputeRevisionContext,
  HarnessAuthSnapshot,
} from "../../packages/contracts/src/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  KubernetesComputeDriver,
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { withNativeAdminGateway } from "../helpers/harness-configuration.mjs";
import {
  admitRevisionHarness,
  apiKeyAuth,
  authContext,
  digest,
  gatewayRouting,
  options,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  observedResource,
  policyRules,
  renderedPolicies,
  resourceRecord,
  resourceRecords,
} from "../helpers/kubernetes-rendered-resources.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type Deployment = Awaited<
  ReturnType<InstanceType<KubernetesSdk["AppsV1Api"]>["readNamespacedDeployment"]>
>;

export function checkExactAccountTokenEgress() {
  const driver = createKubernetesComputeDriver(
    options({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
  );
  const revision: AgentRevision = {
    ...routedRevision(driver),
    id: "revision-account-token-1",
    namespaceId: tenant.id,
    agentId: "agent-account-token",
    servicePrincipalId: "service-principal-account-token",
    harnessAuth: {
      ...apiKeyAuth,
      method: "api_key",
      source: { ...apiKeyAuth.source, kind: "secret" },
    },
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const digest = (value: string, length: number) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  const policy = driver["agentAuthenticationNetworkPolicy"](revision, {
    name: namespace,
    plane: "execution",
  });

  // Login needs public HTTPS before readiness; candidate transport must remain closed until activation.
  assert.equal(policy.metadata.name, `allow-agent-auth-${digest(revision.agentId, 12)}`);
  assert.equal(
    policy.metadata.annotations?.["openclaw.dev/service-principal-id"],
    revision.servicePrincipalId,
  );
  const spec = policy.spec;
  assert.ok(spec);
  assert.deepEqual(spec.podSelector, {
    matchLabels: {
      "openclaw.dev/workload-role": "agent",
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/network-profile": "broad-egress-v1",
    },
  });
  assert.deepEqual(spec.policyTypes, ["Egress"]);
  assert.equal(spec.ingress, undefined);
  const runtime = driver["agentNetworkPolicies"](revision, {
    name: namespace,
    plane: "execution",
  })[1];
  assert.ok(runtime?.resource.spec);
  assert.deepEqual(spec.egress, runtime.resource.spec.egress);
  assert.deepEqual(spec.egress, [
    {
      ports: [{ protocol: "TCP", port: 443 }],
      to: [
        {
          ipBlock: {
            cidr: "0.0.0.0/0",
            except: [
              "10.0.0.0/8",
              "100.64.0.0/10",
              "172.16.0.0/12",
              "192.168.0.0/16",
              "169.254.0.0/16",
            ],
          },
        },
      ],
    },
  ]);
}

function concreteComputeDriver(driver: Pick<KubernetesComputeDriver, "prepareRevision">) {
  assert.ok(driver instanceof KubernetesComputeDriver);
  return driver;
}

export async function checkCanonicalGatewayChannelSecret() {
  const fixture = workspaceSetupFixture(false);
  const { revision, namespace, objects, records } = fixture;
  const driver = concreteComputeDriver(fixture.driver);
  const target = kubernetesNamespaceName(tenant.id);
  const source = {
    ...driver["manifest"](
      "v1",
      "Secret",
      "channel-source",
      { namespaceId: tenant.id },
      { name: target, plane: "execution" },
    ),
    data: {
      token: Buffer.from("channel-token").toString("base64"),
      unrelated: Buffer.from("not-admitted").toString("base64"),
    },
  };
  source.metadata.uid = "channel-source-uid";
  objects.set(`Secret:${target}:channel-source`, source);
  const projection = {
    name: "SLACK_BOT_TOKEN",
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    secretId: "channel-secret",
    backendRef: {
      name: "channel-source",
      namespaceName: target,
      key: "token",
      uid: source.metadata.uid,
    },
  };
  assert.deepEqual(
    await driver["deliverGatewaySecrets"](
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [projection],
    ),
    [projection],
  );
  assert.equal(records.length, 0, "direct references must not create copies");
  source.metadata.uid = "replaced-secret";
  await assert.rejects(
    driver["deliverGatewaySecrets"](
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [projection],
    ),
    /Gateway credential source is unavailable/,
  );
  await assert.rejects(
    driver["deliverGatewaySecrets"](
      revision,
      { name: namespace, plane: "execution" },
      { name: target, plane: "execution" },
      [
        {
          ...projection,
          backendRef: { ...projection.backendRef, namespaceName: "another-tenant" },
        },
      ],
    ),
    /outside the admitted scope/,
  );
}

export async function checkPodModelCredentialPlacement(embedded: boolean) {
  const { driver, revision, objects } = workspaceSetupFixture(embedded, false);
  await driver.prepareRevision(revision, { ...authContext(revision), secretEnvironment: [] });
  const workloads = [...objects.values()].filter(({ kind }) => kind === "Deployment");
  assert.equal(workloads.length, embedded ? 1 : 2);
  let modelConsumers = 0;
  for (const workload of workloads) {
    const template = (workload.spec as Deployment["spec"])?.template;
    assert.ok(template?.spec);
    for (const container of template.spec.containers) {
      for (const environment of container.env ?? []) {
        const ref = environment.valueFrom?.secretKeyRef;
        if (!ref) {
          continue;
        }
        const secret = objects.get(`Secret:${workload.metadata.namespace}:${ref.name}`);
        assert.ok(secret, `${environment.name} must resolve in the Pod namespace`);
        assert.ok(ref.key && secret.data?.[ref.key]);
        if (environment.name === "OPENAI_API_KEY") {
          const receiver = embedded ? "gateway" : "agent";
          assert.equal(container.name, receiver);
          assert.equal(template.metadata?.labels?.["openclaw.dev/workload-role"], receiver);
          modelConsumers += 1;
        }
      }
    }
  }
  assert.equal(modelConsumers, 1);
}

type CredentialWorkspace = {
  driver: Pick<KubernetesComputeDriver, "prepareRevision" | "stopRevision">;
  revision: AgentRevision;
  namespace: string;
  objects: Map<string, ReturnType<typeof observedResource>>;
  records: ReturnType<typeof observedResource>[];
  context: {
    harnessAuth: unknown;
    workspaceSetup: NonNullable<ComputeRevisionContext["workspaceSetup"]>;
  };
};
type ModelCredentialMethod = Extract<
  ComputeRevisionContext["harnessAuth"],
  {
    source: { kind: "secret" };
  }
>["method"];

function modelAuthBindings(fixture: CredentialWorkspace, method: ModelCredentialMethod) {
  assert.equal(fixture.revision.harnessAuth.method, "api_key");
  const harnessAuth =
    method === "api_key"
      ? { ...fixture.revision.harnessAuth }
      : ({ ...fixture.revision.harnessAuth, method } satisfies HarnessAuthSnapshot);
  const backendRef = asRecord(asRecord(fixture.context.harnessAuth)?.backendRef);
  assert.ok(
    typeof backendRef?.namespaceName === "string" &&
      typeof backendRef.name === "string" &&
      typeof backendRef.key === "string" &&
      typeof backendRef.uid === "string",
    "the fixture must resolve the canonical model credential",
  );
  return {
    harnessAuth,
    resolvedHarnessAuth: {
      ...harnessAuth,
      backendRef: {
        namespaceName: backendRef.namespaceName,
        name: backendRef.name,
        key: backendRef.key,
        uid: backendRef.uid,
      },
    } satisfies ComputeRevisionContext["harnessAuth"],
  };
}

export async function checkDedicatedModelCredentialPreparation(method: ModelCredentialMethod) {
  const fixture: CredentialWorkspace = workspaceSetupFixture(false);
  const { namespace, objects, records } = fixture;
  const driver = concreteComputeDriver(fixture.driver);
  const { harnessAuth, resolvedHarnessAuth } = modelAuthBindings(fixture, method);
  const revision = { ...fixture.revision, compute: { ...fixture.revision.compute }, harnessAuth };
  admitRevisionHarness(driver, revision);

  const modelEnvironment = method === "api_key" ? "OPENAI_API_KEY" : "CODEX_ACCESS_TOKEN";
  const controlNamespace = kubernetesNamespaceName(tenant.id);
  const channelUid = "channel-source-uid";
  objects.set(`Secret:${controlNamespace}:channel-source`, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "channel-source",
      namespace: controlNamespace,
      uid: channelUid,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": tenant.id,
      },
      annotations: { "openclaw.dev/namespace-id": tenant.id },
    },
    data: { value: Buffer.from("fixture-channel-token").toString("base64") },
  });
  const source = { kind: "secret", namespaceId: tenant.id, id: "sec_channel" } as const;
  const preparedRevision: AgentRevision = {
    ...revision,
    secretDriverId: "kubernetes-secret",
    secretBindings: { SLACK_BOT_TOKEN: { source } },
  };
  const preparedContext: ComputeRevisionContext = {
    ...fixture.context,
    harnessAuth: resolvedHarnessAuth,
    secretEnvironment: [
      {
        name: "SLACK_BOT_TOKEN",
        namespaceId: tenant.id,
        agentId: revision.agentId,
        secretId: source.id,
        backendRef: {
          name: "channel-source",
          namespaceName: controlNamespace,
          key: "value",
          uid: channelUid,
        },
      },
    ],
  };
  await driver.prepareRevision(preparedRevision, preparedContext);
  const gatewayNamespace = kubernetesNamespaceName(tenant.id);
  assert.equal(gatewayNamespace, namespace);
  const values = [...objects.values()];
  const gateway = observedResource(
    values.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
    ),
    "Deployment",
  );
  const harness = observedResource(
    values.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("agent-"),
    ),
    "Deployment",
  );
  const template = resourceRecord(
    resourceRecord(gateway.spec, "Gateway Deployment spec").template,
    "Gateway Pod template",
  );
  const gatewayPod = resourceRecord(template.spec, "Gateway Pod spec");
  const volumes = resourceRecords(gatewayPod.volumes, "Gateway volumes");
  const configurationVolume = volumes.find(({ name }) => name === "openclaw-configuration");
  const configurationName = asRecord(configurationVolume?.configMap)?.name;
  assert.equal(typeof configurationName, "string");
  const configuration = observedResource(
    values.find(
      ({ kind, metadata }) => kind === "ConfigMap" && metadata.name === configurationName,
    ),
    "ConfigMap",
  );
  const configurationJson = configuration.data?.["openclaw.json"];
  assert.ok(configurationJson);
  const nativeConfiguration: unknown = JSON.parse(configurationJson);
  const plugins = asRecord(asRecord(nativeConfiguration)?.plugins);
  const codex = asRecord(asRecord(plugins?.entries)?.codex);
  const appServer = asRecord(asRecord(codex?.config)?.appServer);
  const endpoint = driver.getGatewayEndpoint(preparedRevision);
  assert.ok(endpoint);
  assert.deepEqual(appServer?.nativeHookRelay, {
    url: endpoint.replace(/^wss:/, "https:") + "/node/__openclaw__/native-hook",
    credentialDirectory: "/home/node/.oce-native-hooks",
  });
  assert.equal(gateway.metadata.namespace, gatewayNamespace);
  assert.equal(harness.metadata.namespace, namespace);
  assert.equal(gatewayPod.automountServiceAccountToken, false);
  assert.equal(
    volumes.some(({ name }) => name === "openclaw-service-principal"),
    false,
  );
  const [gatewayContainer] = resourceRecords(gatewayPod.containers, "Gateway containers");
  const env = Object.fromEntries(
    resourceRecords(gatewayContainer?.env, "Gateway environment").map((entry) => {
      assert.ok(typeof entry.name === "string", "each environment entry has a name");
      return [entry.name, entry] as const;
    }),
  );
  assert.equal(
    env.APP_SERVER_URL?.value,
    `ws://agent-${digest(revision.agentId)}.${namespace}.svc:18790`,
  );
  assert.equal(env.OPENAI_API_KEY, undefined);
  const copied = observedResource(
    values.find(
      ({ kind, metadata }) =>
        kind === "Secret" &&
        metadata.namespace === gatewayNamespace &&
        metadata.name.startsWith("transport-"),
    ),
    "Secret",
  );
  assert.ok(copied.data);
  assert.deepEqual(Object.keys(copied.data), ["app-server-token"]);
  assert.equal(
    asRecord(asRecord(env.APP_SERVER_TOKEN?.valueFrom)?.secretKeyRef)?.name,
    copied.metadata.name,
  );
  assert.deepEqual(asRecord(env.SLACK_BOT_TOKEN?.valueFrom)?.secretKeyRef, {
    name: "channel-source",
    key: "value",
    optional: false,
  });
  const material = observedResource(
    values.find(
      ({ kind, metadata }) =>
        kind === "Secret" &&
        metadata.namespace === namespace &&
        metadata.name.startsWith("harness-secrets-"),
    ),
    "Secret",
  );
  assert.ok(material.data);
  assert.deepEqual(Object.keys(material.data).sort(), [modelEnvironment, "app-server-token"]);
  assert.equal(JSON.stringify(harness).includes("channel-source"), false);
  assert.equal(JSON.stringify(harness).includes("gateway-password"), false);
  const model = observedResource(objects.get(`Secret:${controlNamespace}:occ-model-key`), "Secret");
  assert.ok(model.data);
  assert.equal(material.data[modelEnvironment], model.data.value);

  // Replacing the canonical Secret invalidates the admitted UID before another Deployment write.
  const writesBefore = records.length;
  model.metadata.uid = "replaced-model-source";
  await assert.rejects(
    driver.prepareRevision(preparedRevision, preparedContext),
    /credential source identity changed/,
  );
  assert.equal(
    records.slice(writesBefore).some(({ kind }) => kind === "Deployment"),
    false,
  );

  const gatewayClaim = observedResource(
    values.find(
      ({ kind, metadata }) =>
        kind === "PersistentVolumeClaim" && metadata.name.startsWith("gateway-state-"),
    ),
    "PersistentVolumeClaim",
  );
  const harnessClaim = observedResource(
    values.find(
      ({ kind, metadata }) =>
        kind === "PersistentVolumeClaim" && metadata.name.startsWith("workspace-"),
    ),
    "PersistentVolumeClaim",
  );
  assert.equal(gatewayClaim.metadata.namespace, gatewayNamespace);
  assert.equal(harnessClaim.metadata.namespace, namespace);
  for (const record of records.filter((item) => item.kind !== "Secret")) {
    assert.equal(JSON.stringify(record).includes("test-transport"), false);
  }

  const policies = renderedPolicies(
    driver["agentNetworkPolicies"](preparedRevision, { name: namespace, plane: "execution" }),
  );
  const egress = policies.find(({ metadata }) => metadata.name.startsWith("allow-gateway-agent-"));
  const ingress = policies.find(({ metadata }) => metadata.name.startsWith("allow-agent-runtime-"));
  assert.ok(egress);
  assert.ok(ingress);
  assert.equal(egress.metadata.namespace, gatewayNamespace);
  assert.equal(ingress.metadata.namespace, namespace);
  const [egressPeer] = resourceRecords(
    policyRules(egress, "egress")[0]?.to,
    "Gateway egress peers",
  );
  const [ingressPeer] = resourceRecords(
    policyRules(ingress, "ingress")[0]?.from,
    "Harness ingress peers",
  );
  assert.deepEqual(asRecord(egressPeer?.namespaceSelector)?.matchLabels, {
    "kubernetes.io/metadata.name": namespace,
  });
  assert.deepEqual(asRecord(ingressPeer?.namespaceSelector)?.matchLabels, {
    "kubernetes.io/metadata.name": gatewayNamespace,
  });
  assert.equal(
    asRecord(asRecord(egressPeer?.podSelector)?.matchLabels)?.["openclaw.dev/revision"],
    revision.id,
  );
  assert.equal(
    asRecord(asRecord(ingressPeer?.podSelector)?.matchLabels)?.["openclaw.dev/agent"],
    revision.agentId,
  );
}

export async function checkStoppedRevisionCredentialCleanup(embedded: boolean) {
  const fixture: CredentialWorkspace = workspaceSetupFixture(embedded, true, undefined, {
    gatewayRouting,
  });
  const { driver, namespace, objects } = fixture;
  const { harnessAuth, resolvedHarnessAuth } = modelAuthBindings(fixture, "api_key");
  const revision = {
    ...fixture.revision,
    harnessAuth,
    configuration: withNativeAdminGateway(
      fixture.revision.configuration,
      "https://agent.example.test",
    ),
  };
  const context: ComputeRevisionContext = {
    ...fixture.context,
    harnessAuth: resolvedHarnessAuth,
    secretEnvironment: [],
  };
  await driver.prepareRevision(revision, context);
  const agentDigest = digest(revision.agentId);
  const revisionDigest = digest(revision.id);
  const credentialCopy = `Secret:harness-secrets-${agentDigest}-${revisionDigest}`;
  const revisionScoped = () =>
    [...objects.values()]
      .filter(
        ({ kind, metadata }) =>
          (kind === "Secret" || kind === "ConfigMap") && metadata.name.endsWith(revisionDigest),
      )
      .map(({ kind, metadata }) => `${kind}:${metadata.name}`)
      .sort();
  assert.ok(
    revisionScoped().includes(credentialCopy),
    "preparation projects the model credential into a per-revision Secret",
  );
  assert.ok(revisionScoped().includes(`ConfigMap:gateway-${agentDigest}-rev-${revisionDigest}`));
  assert.ok(
    revisionScoped().includes(`Secret:browser-delegation-${agentDigest}-${revisionDigest}`),
  );
  await driver.stopRevision(revision);
  // A stopped revision keeps no copy of its credentials; preparing it again re-projects them.
  assert.deepEqual(revisionScoped(), []);
  assert.ok(objects.has(`Namespace::${namespace}`));
  assert.ok(
    [...objects.values()].some(
      ({ kind, metadata }) => kind === "Secret" && metadata.name === "occ-model-key",
    ),
    "the canonical control-plane source is retained",
  );
  await driver.prepareRevision(revision, context);
  assert.ok(revisionScoped().includes(credentialCopy));
}
